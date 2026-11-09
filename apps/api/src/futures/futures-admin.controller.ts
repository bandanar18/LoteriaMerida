import { Body, Controller, Get, HttpCode, Param, Post, Put, Query } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsInt, IsNumber, IsString, Length, Max, Min, ValidateNested } from 'class-validator';
import { formatFx, parseFx } from '@loteria/domain';
import { AuditService } from '../audit/audit.service';
import { DbService } from '../common/db.service';
import { BusinessError } from '../common/errors';
import { AuthUser, ClientIp, CurrentUser, Roles } from '../identity/auth.guard';
import { FeedService } from './feed.service';
import { FuturesService } from './futures.service';

const usdt = (micro: bigint | string) => formatFx(BigInt(micro), 6, 6);

class BracketDto {
  @IsNumber() cap: number; // USDT
  @IsInt() @Min(1) @Max(125) maxLeverage: number;
  @IsNumber() @Min(0.01) @Max(50) mmr: number; // %
}

export class ContractConfigDto {
  @IsInt() @Min(1) @Max(125) maxLeverage: number;
  @IsInt() @Min(1) @Max(125) defaultLeverage: number;
  @IsNumber() @Min(0) @Max(1) takerFee: number; // %
  @IsNumber() @Min(0) @Max(1) makerFee: number; // %
  @IsNumber() @Min(0) @Max(5) liquidationFee: number; // %
  @IsNumber() @Min(1000) maxNetExposure: number; // USDT
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(10) @ValidateNested({ each: true }) @Type(() => BracketDto) brackets: BracketDto[];
}

export class ReasonDto {
  @IsString() @Length(3, 300) reason: string;
}

export class FuturesSettingsAdminDto {
  @IsNumber() @Min(1000) houseCapital: number; // USDT
  @IsNumber() @Min(0.1) @Max(100) dailyLossLimit: number; // %
}

/** Backoffice de Cumbre Futuros: salud del feed, exposición, resultado de la casa, liquidaciones y configuración. */
@Roles('LOTTERY_OPERATOR', 'AUDITOR')
@Controller('admin/futures')
export class FuturesAdminController {
  constructor(
    private readonly db: DbService,
    private readonly futures: FuturesService,
    private readonly feed: FeedService,
    private readonly audit: AuditService,
  ) {}

  @SkipThrottle()
  @Get('overview')
  async overview() {
    const contracts = await this.futures.loadContracts(true);
    const rows = [];
    for (const k of contracts.values()) {
      const f = this.feed.get(k.symbol);
      const oi = await this.db.one(
        `SELECT coalesce(sum(qty) FILTER (WHERE side = 'LONG'), 0)::text AS long_q, coalesce(sum(qty) FILTER (WHERE side = 'SHORT'), 0)::text AS short_q,
                count(*)::int AS positions, count(DISTINCT player_id)::int AS players
           FROM futures.position WHERE symbol = $1 AND status = 'OPEN'`,
        [k.symbol],
      );
      const mark = f?.index ?? null;
      const longN = mark ? (parseFx(oi!.long_q) * mark) / 10_000_000_000n : 0n;
      const shortN = mark ? (parseFx(oi!.short_q) * mark) / 10_000_000_000n : 0n;
      const net = longN - shortN;
      const abs = net < 0n ? -net : net;
      rows.push({
        symbol: k.symbol,
        status: k.status,
        status_reason: k.statusReason,
        feed_ok: !!f?.ok,
        index_price: mark ? formatFx(mark) : null,
        last_tick_ago_s: f?.at ? Math.round((Date.now() - f.at) / 1000) : null,
        sources: f?.sources ?? {},
        funding_rate: f?.fundingE8 !== null && f?.fundingE8 !== undefined ? formatFx(f.fundingE8) : null,
        funding_sources: f?.fundingSources ?? {},
        long_notional: usdt(longN),
        short_notional: usdt(shortN),
        // La casa tiene la posición contraria a la neta de los jugadores.
        house_net: usdt(-net),
        exposure_use: Number((abs * 10000n) / k.maxNetExposure) / 100,
        max_net_exposure: usdt(k.maxNetExposure),
        positions: oi!.positions,
        players: oi!.players,
        config: {
          max_leverage: k.spec.maxLeverage,
          default_leverage: k.defaultLeverage,
          taker_fee: Number(k.spec.takerPpm) / 10_000,
          maker_fee: Number(k.spec.makerPpm) / 10_000,
          liquidation_fee: Number(k.spec.liquidationPpm) / 10_000,
          brackets: k.spec.brackets.map((b) => ({ cap: Number(b.cap) / 1e6, max_leverage: b.maxLeverage, mmr: Number(b.mmrPpm) / 10_000, cum: usdt(b.cum) })),
        },
      });
    }
    const result = await this.futures.houseResultToday();
    const s = await this.db.one(`SELECT house_capital::text, daily_loss_limit_ppm, rules_version, is_demo FROM futures.settings`);
    const volume = await this.db.one(
      `SELECT coalesce(sum(notional), 0)::text AS v, count(*)::int AS n, count(DISTINCT player_id)::int AS players FROM futures.fill
        WHERE (created_at AT TIME ZONE 'America/Caracas')::date = (now() AT TIME ZONE 'America/Caracas')::date`,
    );
    const liqs = await this.db.one(
      `SELECT count(*)::int AS n FROM futures.liquidation WHERE (created_at AT TIME ZONE 'America/Caracas')::date = (now() AT TIME ZONE 'America/Caracas')::date`,
    );
    const limit = (BigInt(s!.house_capital) * BigInt(s!.daily_loss_limit_ppm)) / 1_000_000n;
    return {
      contracts: rows,
      today: {
        volume: usdt(volume!.v),
        fills: volume!.n,
        traders: volume!.players,
        liquidations: liqs!.n,
        fees: usdt(result.fees),
        liquidation_fees: usdt(result.liquidationFees),
        funding: usdt(result.funding),
        pnl_vs_players: usdt(result.pnl),
        absorbed: usdt(result.absorbed),
        total: usdt(result.total),
        loss_limit: usdt(limit),
        loss_limit_use: result.total < 0n && limit > 0n ? Number((-result.total * 10000n) / limit) / 100 : 0,
      },
      settings: {
        house_capital: usdt(s!.house_capital),
        daily_loss_limit: s!.daily_loss_limit_ppm / 10_000,
        rules_version: s!.rules_version,
        is_demo: s!.is_demo,
      },
    };
  }

  @SkipThrottle()
  @Get('positions')
  async positions() {
    const rows = await this.db.query(
      `SELECT p.*, u.email FROM futures.position p JOIN identity.app_user u ON u.id = p.player_id WHERE p.status = 'OPEN' ORDER BY p.opened_at DESC LIMIT 200`,
    );
    return Promise.all(rows.map(async (p) => ({ ...(await this.futures.positionView(p)), email: p.email })));
  }

  @SkipThrottle()
  @Get('liquidations')
  liquidations(@Query('limit') limit = '100') {
    return this.db.query(
      `SELECT l.id::text, l.symbol, l.side, l.qty::text, l.entry_price::text, l.mark_price::text, l.margin::text, l.loss::text, l.fee::text,
              l.returned::text, l.absorbed::text, l.price_tick_id::text, t.sources AS tick_sources, t.index_price::text AS tick_index, l.created_at, u.email
         FROM futures.liquidation l JOIN identity.app_user u ON u.id = l.player_id LEFT JOIN futures.price_tick t ON t.id = l.price_tick_id
        ORDER BY l.id DESC LIMIT $1`,
      [Math.min(Number(limit) || 100, 500)],
    );
  }

  @SkipThrottle()
  @Get('fills')
  fills() {
    return this.db.query(
      `SELECT f.id::text, f.symbol, f.side, f.qty::text, f.price::text, f.notional::text, f.fee::text, f.liquidity, f.realized_pnl::text,
              o.type, f.price_tick_id::text, f.created_at, u.email
         FROM futures.fill f JOIN futures.order o ON o.id = f.order_id JOIN identity.app_user u ON u.id = f.player_id
        ORDER BY f.id DESC LIMIT 200`,
    );
  }

  @SkipThrottle()
  @Get('incidents')
  incidents() {
    return this.db.query(
      `SELECT i.id::text, i.symbol, i.kind, i.description, i.created_at, u.email FROM futures.incident i
         LEFT JOIN identity.app_user u ON u.id = i.created_by ORDER BY i.id DESC LIMIT 100`,
    );
  }

  /** Configuración de un contrato (manual §14): apalancamiento, comisiones, tramos y exposición máxima. Solo administradores. */
  @Roles('ADMIN')
  @Put('contracts/:symbol')
  async updateContract(@Param('symbol') symbol: string, @Body() dto: ContractConfigDto, @CurrentUser() u: AuthUser, @ClientIp() ip: string) {
    const k = await this.futures.contract(symbol);
    if (dto.defaultLeverage > dto.maxLeverage) throw new BusinessError('INVALID_INPUT', 'El apalancamiento por defecto no puede superar al máximo');
    const caps = dto.brackets.map((b) => parseFx(String(b.cap), 6));
    if (caps.some((c, i) => c <= 0n || (i > 0 && c <= caps[i - 1]))) throw new BusinessError('INVALID_INPUT', 'Los topes de los tramos deben ser crecientes');
    if (dto.brackets.some((b, i) => i > 0 && (b.maxLeverage > dto.brackets[i - 1].maxLeverage || b.mmr < dto.brackets[i - 1].mmr))) {
      throw new BusinessError('INVALID_INPUT', 'Cada tramo debe tener igual o menos apalancamiento y igual o más mantenimiento que el anterior');
    }
    if (dto.brackets[0].maxLeverage < dto.maxLeverage) throw new BusinessError('INVALID_INPUT', 'El primer tramo debe permitir el apalancamiento máximo');
    // cum_n = cum_{n−1} + piso_n × (MMR_n − MMR_{n−1}), con MMR en ppm.
    let cum = 0n;
    const brackets = dto.brackets.map((b, i) => {
      const mmrPpm = BigInt(Math.round(b.mmr * 10_000));
      const floor = i === 0 ? 0n : caps[i - 1];
      if (i > 0) cum += (floor * (mmrPpm - BigInt(Math.round(dto.brackets[i - 1].mmr * 10_000)))) / 1_000_000n;
      return { floor: floor.toString(), cap: caps[i].toString(), maxLeverage: b.maxLeverage, mmrPpm: Number(mmrPpm), cum: cum.toString() };
    });
    const before = await this.db.one(`SELECT * FROM futures.contract WHERE symbol = $1`, [symbol]);
    await this.db.tx(async (c) => {
      await c.query(
        `UPDATE futures.contract SET max_leverage = $2, default_leverage = $3, taker_ppm = $4, maker_ppm = $5, liquidation_ppm = $6,
                max_net_exposure = $7, brackets = $8 WHERE symbol = $1`,
        [symbol, dto.maxLeverage, dto.defaultLeverage, Math.round(dto.takerFee * 10_000), Math.round(dto.makerFee * 10_000),
          Math.round(dto.liquidationFee * 10_000), parseFx(String(dto.maxNetExposure), 6).toString(), JSON.stringify(brackets)],
      );
      await this.audit.log(c, {
        actorType: 'STAFF', actorId: u.id, action: 'FUTURES_CONTRACT_UPDATED', entity: 'futures.contract', entityId: symbol,
        before: { max_leverage: before.max_leverage, taker_ppm: before.taker_ppm, maker_ppm: before.maker_ppm, liquidation_ppm: before.liquidation_ppm, brackets: before.brackets, max_net_exposure: before.max_net_exposure },
        after: { ...dto, brackets }, ip,
      });
    });
    void k;
    await this.futures.loadContracts(true);
    return { ok: true };
  }

  /** Pausa (solo cerrar) o reanuda un contrato, con incidencia obligatoria. */
  @Roles('ADMIN')
  @HttpCode(200)
  @Post('contracts/:symbol/status')
  async setStatus(@Param('symbol') symbol: string, @Body() dto: ReasonDto & { status: string }, @CurrentUser() u: AuthUser, @ClientIp() ip: string) {
    await this.futures.contract(symbol);
    const status = (dto as any).status;
    if (!['ACTIVE', 'CLOSE_ONLY', 'PAUSED'].includes(status)) throw new BusinessError('INVALID_INPUT', 'Estado inválido');
    if (!dto.reason || dto.reason.length < 3) throw new BusinessError('INVALID_INPUT', 'Escribe el motivo');
    await this.db.tx(async (c) => {
      await c.query(`UPDATE futures.contract SET status = $2, status_reason = $3 WHERE symbol = $1`, [symbol, status, status === 'ACTIVE' ? null : dto.reason]);
      await c.query(`INSERT INTO futures.incident (symbol, kind, description, created_by) VALUES ($1, $2, $3, $4)`, [
        symbol, status === 'ACTIVE' ? 'RESUMED' : 'MANUAL_PAUSE', `${status}: ${dto.reason}`, u.id,
      ]);
      await this.audit.log(c, { actorType: 'STAFF', actorId: u.id, action: 'FUTURES_CONTRACT_STATUS', entity: 'futures.contract', entityId: symbol, after: { status, reason: dto.reason }, ip });
    });
    await this.futures.loadContracts(true);
    return { ok: true };
  }

  @Roles('ADMIN')
  @Put('settings')
  async updateSettings(@Body() dto: FuturesSettingsAdminDto, @CurrentUser() u: AuthUser, @ClientIp() ip: string) {
    await this.db.tx(async (c) => {
      await c.query(`UPDATE futures.settings SET house_capital = $1, daily_loss_limit_ppm = $2`, [
        parseFx(String(dto.houseCapital), 6).toString(),
        Math.round(dto.dailyLossLimit * 10_000),
      ]);
      await this.audit.log(c, { actorType: 'STAFF', actorId: u.id, action: 'FUTURES_SETTINGS_UPDATED', entity: 'futures.settings', after: dto, ip });
    });
    return { ok: true };
  }
}
