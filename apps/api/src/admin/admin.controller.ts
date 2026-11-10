import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { IsIn, IsOptional, IsString, Length } from 'class-validator';
import { AuditService } from '../audit/audit.service';
import { AvailabilityDto } from '../common/availability.dto';
import { DbService } from '../common/db.service';
import { BusinessError } from '../common/errors';
import { publish } from '../common/realtime';
import { localDate } from '../common/time';
import { AuthUser, ClientIp, CurrentUser, Roles } from '../identity/auth.guard';
import { LedgerService } from '../wallet/ledger.service';

class PlayerStatusDto {
  @IsIn(['ACTIVE', 'BLOCKED']) status: 'ACTIVE' | 'BLOCKED';
  @IsString() @Length(3, 300) reason: string;
}

class SearchDto {
  @IsOptional() @IsString() q?: string;
}

@Roles('AUDITOR', 'CASHIER', 'LOTTERY_OPERATOR', 'COMPLIANCE', 'SPORTS_TRADER')
@Controller('admin')
export class AdminController {
  constructor(
    private readonly db: DbService,
    private readonly ledger: LedgerService,
    private readonly audit: AuditService,
  ) {}

  @Roles('ADMIN')
  @Put('futures/availability')
  async setFuturesAvailability(@Body() dto: AvailabilityDto, @CurrentUser() u: AuthUser, @ClientIp() ip: string) {
    return this.db.tx(async (c) => {
      const { rows: [settings] } = await c.query('SELECT trading_enabled FROM futures.settings WHERE id FOR UPDATE');
      if (!settings) throw new BusinessError('NOT_FOUND', 'Configuración de Futuros no encontrada');
      if (settings.trading_enabled === dto.enabled) return { enabled: dto.enabled };

      await c.query('UPDATE futures.settings SET trading_enabled = $1 WHERE id', [dto.enabled]);
      await this.audit.log(c, {
        actorType: 'STAFF', actorId: u.id, action: 'FUTURES_AVAILABILITY_UPDATED', entity: 'futures.settings',
        before: { enabled: settings.trading_enabled }, after: { enabled: dto.enabled }, ip,
      });
      await publish(c, 'lobby', 'futures-availability');
      return { enabled: dto.enabled };
    });
  }

  /** KPIs del día (zona America/Caracas): ventas, premios, GGR, pendientes. */
  @Get('dashboard')
  async dashboard() {
    const day = localDate();
    const byCurrency = await this.db.query(
      `SELECT c.code AS currency,
              coalesce((SELECT sum(t.total) FROM lottery.ticket t
                         WHERE t.currency = c.code AND t.status <> 'CANCELLED' AND NOT t.is_simulation
                           AND (t.sold_at AT TIME ZONE 'America/Caracas')::date = $1::date), 0)::text AS sales,
              coalesce((SELECT sum(p.win) FROM lottery.play p JOIN lottery.ticket t ON t.id = p.ticket_id
                         WHERE t.currency = c.code AND p.status = 'WON' AND NOT t.is_simulation
                           AND (p.settled_at AT TIME ZONE 'America/Caracas')::date = $1::date), 0)::text AS payouts,
              coalesce((SELECT sum(b.stake) FROM sports.bet_slip b
                         WHERE b.currency = c.code AND (b.placed_at AT TIME ZONE 'America/Caracas')::date = $1::date), 0)::text AS sports_sales,
              coalesce((SELECT sum(b.payout) FROM sports.bet_slip b WHERE b.currency = c.code AND b.status IN ('WON', 'VOID')
                           AND (b.settled_at AT TIME ZONE 'America/Caracas')::date = $1::date), 0)::text AS sports_payouts,
              coalesce((SELECT sum(a.balance) FROM wallet.account a WHERE a.account_type = 'BETS_IN_PLAY' AND a.currency = c.code), 0)::text AS bets_in_play,
              coalesce((SELECT sum(a.balance) FROM wallet.account a WHERE a.account_type = 'HOUSE_GGR' AND a.currency = c.code), 0)::text AS ggr_all_time,
              coalesce((SELECT sum(a.balance) FROM wallet.account a WHERE a.owner_type = 'PLAYER' AND a.currency = c.code), 0)::text AS player_liability
         FROM wallet.currency c ORDER BY c.code`,
      [day],
    );
    const counts = await this.db.one(
      `SELECT (SELECT count(*) FROM identity.app_user WHERE kind = 'PLAYER')::int AS players,
              (SELECT count(*) FROM identity.app_user WHERE kind = 'PLAYER'
                 AND (created_at AT TIME ZONE 'America/Caracas')::date = $1::date)::int AS new_players,
              (SELECT count(*) FROM payments.deposit WHERE status = 'PENDING')::int AS pending_deposits,
              (SELECT count(*) FROM payments.withdrawal WHERE status = 'REQUESTED')::int AS pending_withdrawals,
              (SELECT count(*) FROM lottery.draw WHERE status = 'RESULT_PENDING')::int AS pending_results,
              (SELECT count(*) FROM lottery.ticket WHERE NOT is_simulation AND (sold_at AT TIME ZONE 'America/Caracas')::date = $1::date)::int AS tickets_today,
              (SELECT count(*) FROM identity.kyc_request WHERE status = 'PENDING')::int AS pending_kyc,
              (SELECT count(*) FROM sports.event WHERE result_status = 'PROPOSED')::int AS pending_sports_results,
              (SELECT count(*) FROM sports.event WHERE status = 'LIVE')::int AS live_events,
              (SELECT count(*) FROM sports.bet_slip WHERE (placed_at AT TIME ZONE 'America/Caracas')::date = $1::date)::int AS bets_today`,
      [day],
    );
    // Desglose del día por juego (Animalitos, Frutas…): ventas y premios por moneda, tickets y sorteos.
    const byGame = await this.db.query(
      `SELECT g.id, g.code, g.name,
              (SELECT coalesce(jsonb_object_agg(x.currency, jsonb_build_object('sales', x.sales::text, 'payouts', x.payouts::text)), '{}'::jsonb)
                 FROM (SELECT c.code AS currency,
                              coalesce((SELECT sum(t.total) FROM lottery.ticket t
                                         WHERE t.game_id = g.id AND t.currency = c.code AND t.status <> 'CANCELLED' AND NOT t.is_simulation
                                           AND (t.sold_at AT TIME ZONE g.timezone)::date = $1::date), 0) AS sales,
                              coalesce((SELECT sum(p.win) FROM lottery.play p JOIN lottery.ticket t ON t.id = p.ticket_id
                                         WHERE t.game_id = g.id AND t.currency = c.code AND p.status = 'WON' AND NOT t.is_simulation
                                           AND (p.settled_at AT TIME ZONE g.timezone)::date = $1::date), 0) AS payouts
                         FROM wallet.currency c) x) AS money,
              (SELECT count(*) FROM lottery.ticket t WHERE t.game_id = g.id AND NOT t.is_simulation
                  AND (t.sold_at AT TIME ZONE g.timezone)::date = $1::date)::int AS tickets_today,
              (SELECT count(*) FROM lottery.draw d WHERE d.game_id = g.id AND d.sim_player_id IS NULL
                  AND d.status <> 'CANCELLED' AND (d.draw_at AT TIME ZONE g.timezone)::date = $1::date)::int AS draws_today,
              (SELECT count(*) FROM lottery.draw d WHERE d.game_id = g.id AND d.sim_player_id IS NULL AND d.status = 'SETTLED'
                  AND (d.draw_at AT TIME ZONE g.timezone)::date = $1::date)::int AS settled_today,
              (SELECT count(*) FROM lottery.draw d WHERE d.game_id = g.id AND d.status = 'RESULT_PENDING')::int AS pending_results,
              (SELECT min(d.draw_at) FROM lottery.draw d WHERE d.game_id = g.id AND d.sim_player_id IS NULL
                  AND d.status IN ('SCHEDULED', 'OPEN') AND d.draw_at > now()) AS next_draw_at
         FROM lottery.game g WHERE g.status = 'ACTIVE' ORDER BY g.display_order, g.code`,
      [day],
    );
    return { day, byCurrency, byGame, counts };
  }

  @Get('players')
  players(@Query() q: SearchDto) {
    const term = q.q?.trim() ? `%${q.q.trim().toLowerCase()}%` : null;
    return this.db.query(
      `SELECT u.id, u.email, u.phone, u.document_type, u.document_number, u.first_name, u.last_name, u.status,
              u.self_excluded_until, u.kyc_level, u.created_at,
              (SELECT jsonb_object_agg(a.currency, a.balance::text) FROM wallet.account a
                WHERE a.owner_id = u.id AND a.account_type = 'PLAYER_CASH') AS cash
         FROM identity.app_user u
        WHERE u.kind = 'PLAYER'
          AND ($1::text IS NULL OR lower(u.email) LIKE $1 OR u.document_number LIKE $1 OR u.phone LIKE $1
               OR lower(u.first_name || ' ' || u.last_name) LIKE $1)
        ORDER BY u.created_at DESC LIMIT 100`,
      [term],
    );
  }

  @Roles('ADMIN')
  @HttpCode(200)
  @Post('players/:id/status')
  async setPlayerStatus(@Param('id', ParseUUIDPipe) id: string, @Body() dto: PlayerStatusDto, @CurrentUser() u: AuthUser, @ClientIp() ip: string) {
    return this.db.tx(async (c) => {
      const before = (await c.query(`SELECT status FROM identity.app_user WHERE id = $1 AND kind = 'PLAYER' FOR UPDATE`, [id])).rows[0];
      if (!before) throw new BusinessError('NOT_FOUND', 'Jugador no encontrado');
      await c.query(`UPDATE identity.app_user SET status = $2 WHERE id = $1`, [id, dto.status]);
      if (dto.status === 'BLOCKED') {
        await c.query(`UPDATE identity.refresh_token SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, [id]);
      }
      await this.audit.log(c, {
        actorType: 'STAFF',
        actorId: u.id,
        action: 'PLAYER_STATUS_CHANGED',
        entity: 'app_user',
        entityId: id,
        before,
        after: { status: dto.status, reason: dto.reason },
        ip,
      });
      return { status: dto.status };
    });
  }

  @Roles('AUDITOR')
  @Get('audit')
  auditLog(@Query('limit') limit?: string) {
    const n = Math.min(Math.max(Number(limit) || 100, 1), 500);
    return this.db.query(
      `SELECT a.id::text, a.actor_type, a.actor_id, u.email AS actor_email, a.action, a.entity, a.entity_id,
              a.before, a.after, a.ip, a.at, a.hash
         FROM audit.audit_log a LEFT JOIN identity.app_user u ON u.id = a.actor_id
        ORDER BY a.id DESC LIMIT $1`,
      [n],
    );
  }

  @Roles('AUDITOR')
  @Get('audit/verify')
  verifyAudit() {
    return this.audit.verify(this.db.pool);
  }

  @Roles('AUDITOR')
  @Get('ledger/reconcile')
  reconcile() {
    return this.ledger.reconcile(this.db.pool);
  }
}
