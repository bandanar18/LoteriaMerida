import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import {
  applyFill,
  Bracket,
  bracketFor,
  ContractSpec,
  fee as feeOf,
  formatFx,
  FUNDING_INTEREST_E8,
  fundingPayment,
  FxSide,
  initialMargin,
  isLiquidatable,
  limitMarketable,
  limitTriggered,
  liquidationPrice,
  maintenanceMargin,
  MarginMode,
  maxNotional,
  notional,
  OrderSide,
  parseFx,
  PositionState,
  stopTriggered,
  tpslTriggered,
  unrealizedPnl,
} from '@loteria/domain';
import { PoolClient } from 'pg';
import { DbService } from '../common/db.service';
import { BusinessError } from '../common/errors';
import { publish } from '../common/realtime';
import { assertPlayerCanPlay } from '../identity/player-status';
import { LedgerService } from '../wallet/ledger.service';
import { FeedService } from './feed.service';

const CUR = 'USDT' as const;
const usdt = (micro: bigint) => formatFx(micro, 6, 6);

export interface ContractRow {
  symbol: string;
  base: string;
  name: string;
  spec: ContractSpec;
  defaultLeverage: number;
  maxNetExposure: bigint;
  status: 'ACTIVE' | 'CLOSE_ONLY' | 'PAUSED';
  statusReason: string | null;
}

export interface PlaceOrderInput {
  symbol: string;
  side: OrderSide;
  type: 'MARKET' | 'LIMIT' | 'STOP_MARKET';
  qty: string;
  price?: string;
  stopPrice?: string;
  timeInForce?: 'GTC' | 'IOC' | 'FOK';
  reduceOnly?: boolean;
  postOnly?: boolean;
}

type Liquidity = 'MAKER' | 'TAKER';

/**
 * Cumbre Futuros (MER-06): órdenes, posiciones, motor de llenado/liquidación y funding.
 * La plataforma es la contraparte: cada llenado mueve dinero entre la billetera de futuros del jugador,
 * su margen bloqueado y las cuentas de la casa (comisiones y PnL), siempre con el ledger de doble partida.
 */
@Injectable()
export class FuturesService implements OnModuleInit {
  private readonly log = new Logger('Futures');
  private contracts = new Map<string, ContractRow>();
  private contractsAt = 0;

  constructor(
    private readonly db: DbService,
    private readonly ledger: LedgerService,
    private readonly feed: FeedService,
  ) {}

  onModuleInit() {
    this.feed.onTick((symbol) => this.runEngine(symbol));
  }

  // ───────────── Contratos ─────────────

  async loadContracts(force = false): Promise<Map<string, ContractRow>> {
    if (!force && Date.now() - this.contractsAt < 5_000) return this.contracts;
    const rows = await this.db.query(`SELECT * FROM futures.contract ORDER BY sort`);
    const map = new Map<string, ContractRow>();
    for (const r of rows) {
      map.set(r.symbol, {
        symbol: r.symbol,
        base: r.base,
        name: r.name,
        defaultLeverage: r.default_leverage,
        maxNetExposure: BigInt(r.max_net_exposure),
        status: r.status,
        statusReason: r.status_reason,
        spec: {
          symbol: r.symbol,
          qtyStep: parseFx(r.qty_step),
          priceTick: parseFx(r.price_tick),
          minNotional: BigInt(r.min_notional),
          maxLeverage: r.max_leverage,
          takerPpm: BigInt(r.taker_ppm),
          makerPpm: BigInt(r.maker_ppm),
          liquidationPpm: BigInt(r.liquidation_ppm),
          brackets: (r.brackets as any[]).map(
            (b): Bracket => ({ floor: BigInt(b.floor), cap: BigInt(b.cap), maxLeverage: b.maxLeverage, mmrPpm: BigInt(b.mmrPpm), cum: BigInt(b.cum) }),
          ),
        },
      });
    }
    this.contracts = map;
    this.contractsAt = Date.now();
    return map;
  }

  async contract(symbol: string): Promise<ContractRow> {
    const c = (await this.loadContracts()).get(symbol);
    if (!c) throw new BusinessError('NOT_FOUND', 'Contrato no encontrado');
    return c;
  }

  /** ¿Se pueden abrir posiciones? Pausado o feed caído → no; «solo cerrar» → no. */
  private canOpen(c: ContractRow) {
    return c.status === 'ACTIVE' && !!this.feed.mark(c.symbol);
  }

  private async tradingEnabled(c: PoolClient) {
    const { rows: [settings] } = await c.query('SELECT trading_enabled FROM futures.settings WHERE id FOR SHARE');
    return settings?.trading_enabled === true;
  }

  // ───────────── Cuentas del jugador ─────────────

  private wallet(c: PoolClient | DbService['pool'], playerId: string) {
    return this.ledger.playerAccount(c as any, playerId, 'PLAYER_FUTURES', CUR);
  }

  private async balanceOf(c: PoolClient, accountId: string): Promise<bigint> {
    const r = await c.query(`SELECT balance FROM wallet.account WHERE id = $1`, [accountId]);
    return BigInt(r.rows[0]?.balance ?? 0);
  }

  private async assertCanTrade(c: PoolClient, playerId: string) {
    await assertPlayerCanPlay(c, playerId);
    const u = (await c.query(`SELECT kyc_level FROM identity.app_user WHERE id = $1`, [playerId])).rows[0];
    if (!u || u.kyc_level < 2) throw new BusinessError('KYC_REQUIRED', 'Para operar futuros necesitas verificación de identidad nivel 2');
    const s = (await c.query(`SELECT risk_accepted_at FROM futures.player_settings WHERE player_id = $1`, [playerId])).rows[0];
    if (!s) throw new BusinessError('RISK_NOT_ACCEPTED', 'Primero acepta el aviso de riesgo de futuros');
  }

  /** Pérdida realizada de hoy (hora de Caracas): PnL de cierres + comisiones + funding pagado. */
  private async todayLoss(c: PoolClient | DbService['pool'], playerId: string): Promise<bigint> {
    const r = await (c as any).query(
      `SELECT coalesce((SELECT sum(f.realized_pnl - f.fee) FROM futures.fill f
                         WHERE f.player_id = $1 AND (f.created_at AT TIME ZONE 'America/Caracas')::date = (now() AT TIME ZONE 'America/Caracas')::date), 0)
            - coalesce((SELECT sum(p.amount) FROM futures.funding_payment p
                         WHERE p.player_id = $1 AND (p.created_at AT TIME ZONE 'America/Caracas')::date = (now() AT TIME ZONE 'America/Caracas')::date), 0) AS net`,
      [playerId],
    );
    const net = BigInt(r.rows[0].net);
    return net < 0n ? -net : 0n;
  }

  // ───────────── Órdenes ─────────────

  async placeOrder(playerId: string, input: PlaceOrderInput, idempotencyKey: string) {
    const c0 = await this.contract(input.symbol);
    const result = await this.db.tx(async (c) => {
      const existing = await c.query(`SELECT id FROM futures.order WHERE player_id = $1 AND idempotency_key = $2`, [playerId, idempotencyKey]);
      if (existing.rows[0]) return { orderId: existing.rows[0].id as string, duplicate: true };
      if (!(await this.tradingEnabled(c))) {
        throw new BusinessError('NOT_FOUND', 'Futuros no está disponible');
      }
      await this.assertCanTrade(c, playerId);
      // Un jugador a la vez (evita carreras entre sus propias órdenes).
      await c.query(`SELECT pg_advisory_xact_lock(hashtext('futures-player:' || $1))`, [playerId]);

      const spec = c0.spec;
      let qty: bigint;
      let price: bigint | null = null;
      let stop: bigint | null = null;
      try {
        qty = parseFx(input.qty);
        if (input.price) price = parseFx(input.price);
        if (input.stopPrice) stop = parseFx(input.stopPrice);
      } catch {
        throw new BusinessError('INVALID_INPUT', 'Cantidad o precio inválido');
      }
      if (qty <= 0n || qty % spec.qtyStep !== 0n) throw new BusinessError('INVALID_INPUT', `La cantidad debe ser múltiplo de ${formatFx(spec.qtyStep)}`);
      if (input.type === 'LIMIT' && (!price || price <= 0n || price % spec.priceTick !== 0n)) {
        throw new BusinessError('INVALID_INPUT', `El precio límite debe ser múltiplo de ${formatFx(spec.priceTick)}`);
      }
      if (input.type === 'STOP_MARKET' && (!stop || stop <= 0n || stop % spec.priceTick !== 0n)) {
        throw new BusinessError('INVALID_INPUT', `El precio de activación debe ser múltiplo de ${formatFx(spec.priceTick)}`);
      }
      if (input.postOnly && input.type !== 'LIMIT') throw new BusinessError('INVALID_INPUT', 'Post-only solo aplica a órdenes límite');

      const mark = this.feed.mark(c0.symbol);
      if (!mark && input.type === 'MARKET') throw new BusinessError('MARKET_CLOSED', 'No hay precio de referencia válido en este momento. Intenta en unos segundos.');
      if (c0.status === 'PAUSED') throw new BusinessError('MARKET_CLOSED', `${c0.symbol} está en pausa: ${c0.statusReason ?? 'revisión de la operadora'}`);

      const prefs = await this.prefs(c, playerId, c0);
      const pos = await this.openPosition(c, playerId, c0.symbol, false);
      const reducing = !!pos && (pos.side === 'LONG') !== (input.side === 'BUY');
      if (input.reduceOnly && !reducing) throw new BusinessError('INVALID_INPUT', 'Solo reducir: no hay una posición contraria que reducir');
      const opens = !input.reduceOnly && (!pos || !reducing || qty > BigInt(parseFx(pos.qty)));
      if (opens && !this.canOpen(c0)) {
        throw new BusinessError('MARKET_CLOSED', `${c0.symbol} está en «solo cerrar»: no se pueden abrir posiciones ahora`);
      }
      if (pos && pos.margin_mode !== prefs.marginMode) {
        throw new BusinessError('INVALID_STATE', 'Tienes una posición abierta en otro modo de margen. Ciérrala para cambiar de modo.');
      }
      const refPrice = input.type === 'LIMIT' ? price! : input.type === 'STOP_MARKET' ? stop! : mark!.price;
      if (notional(qty, refPrice) < spec.minNotional) throw new BusinessError('INVALID_INPUT', `El valor mínimo de una orden es ${usdt(spec.minNotional)} USDT`);
      if (opens) await this.checkOpening(c, playerId, c0, prefs, pos, input.side, qty, refPrice);

      // Validaciones de disparo.
      if (input.type === 'STOP_MARKET' && mark && stopTriggered(input.side, stop!, mark.price)) {
        throw new BusinessError('INVALID_INPUT', 'El precio de activación ya se cruzó: usa una orden a mercado');
      }
      const marketable = input.type === 'LIMIT' && mark ? limitMarketable(input.side, price!, mark.price) : false;
      if (input.type === 'LIMIT' && input.postOnly && marketable) {
        throw new BusinessError('POST_ONLY_REJECTED', 'Post-only: la orden se llenaría al instante y se canceló');
      }
      const settings = (await c.query(`SELECT rules_version FROM futures.settings`)).rows[0];
      const { rows: [order] } = await c.query(
        `INSERT INTO futures.order (player_id, symbol, side, type, qty, price, stop_price, time_in_force, reduce_only, post_only,
                                    leverage, margin_mode, idempotency_key, rules_version)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING *`,
        [
          playerId, c0.symbol, input.side, input.type, formatFx(qty), price === null ? null : formatFx(price), stop === null ? null : formatFx(stop),
          input.timeInForce ?? 'GTC', !!input.reduceOnly, !!input.postOnly, prefs.leverage, prefs.marginMode, idempotencyKey, settings.rules_version,
        ],
      );

      if (input.type === 'MARKET' || marketable) {
        await this.executeFill(c, order, mark!.price, 'TAKER', mark!.tickId);
      } else if (input.type === 'LIMIT' && (input.timeInForce === 'IOC' || input.timeInForce === 'FOK')) {
        await c.query(`UPDATE futures.order SET status = 'EXPIRED', reject_reason = $2, updated_at = now() WHERE id = $1`, [
          order.id,
          'IOC/FOK: no se podía llenar al instante',
        ]);
      }
      return { orderId: order.id as string, duplicate: false };
    });
    return this.orderView(result.orderId);
  }

  /** Margen disponible, apalancamiento por tramo, tope de nocional, exposición de la casa y límite diario. */
  private async checkOpening(
    c: PoolClient,
    playerId: string,
    k: ContractRow,
    prefs: { leverage: number; marginMode: MarginMode },
    pos: any,
    side: OrderSide,
    qty: bigint,
    price: bigint,
  ) {
    const spec = k.spec;
    const posQty = pos ? parseFx(pos.qty) : 0n;
    const sameSide = pos && (pos.side === 'LONG') === (side === 'BUY');
    const openQty = sameSide || !pos ? qty : qty - posQty;
    const resulting = (sameSide ? posQty : 0n) + openQty;
    const resultingNotional = notional(resulting, price);
    if (resultingNotional > maxNotional(spec)) {
      throw new BusinessError('LIMIT_EXCEEDED', `La posición superaría el máximo de ${usdt(maxNotional(spec))} USDT en ${k.symbol}`);
    }
    const b = bracketFor(spec, resultingNotional);
    if (prefs.leverage > b.maxLeverage) {
      throw new BusinessError('LIMIT_EXCEEDED', `Con ${usdt(resultingNotional)} USDT de posición el apalancamiento máximo es ${b.maxLeverage}×. Baja el apalancamiento.`);
    }
    const im = initialMargin(notional(openQty, price), prefs.leverage);
    const fee = feeOf(notional(qty, price), spec.takerPpm);
    const avail = await this.available(c, playerId);
    if (im + fee > avail) {
      throw new BusinessError('INSUFFICIENT_FUNDS', `Margen insuficiente: necesitas ${usdt(im + fee)} USDT y tienes ${usdt(avail)} USDT disponibles`, {
        required: (im + fee).toString(),
        available: avail.toString(),
      });
    }
    // Exposición neta de la casa (manual §9): no se aceptan órdenes que la lleven más allá del límite.
    const net = await this.netExposure(c, k.symbol, price);
    const delta = notional(openQty, price) * (side === 'BUY' ? 1n : -1n);
    const after = net + delta;
    const abs = (x: bigint) => (x < 0n ? -x : x);
    if (abs(after) > k.maxNetExposure && abs(after) > abs(net)) {
      throw new BusinessError('LIMIT_EXCEEDED', `${k.symbol}: la casa alcanzó su exposición máxima en ese lado. Solo se aceptan órdenes del lado contrario por ahora.`);
    }
    // Límite personal de pérdida diaria (juego responsable).
    const s = (await c.query(`SELECT daily_loss_limit, max_leverage FROM futures.player_settings WHERE player_id = $1`, [playerId])).rows[0];
    if (s?.max_leverage && prefs.leverage > s.max_leverage) {
      throw new BusinessError('LIMIT_EXCEEDED', `Tu límite personal de apalancamiento es ${s.max_leverage}×`);
    }
    if (s?.daily_loss_limit && (await this.todayLoss(c, playerId)) >= BigInt(s.daily_loss_limit)) {
      throw new BusinessError('LIMIT_EXCEEDED', 'Alcanzaste tu límite personal de pérdida diaria. Mañana podrás abrir posiciones de nuevo.');
    }
  }

  /** Exposición neta de los jugadores (Σ long − Σ short) a precio marca; la casa tiene la contraria. */
  private async netExposure(c: PoolClient | DbService['pool'], symbol: string, price: bigint): Promise<bigint> {
    const r = await (c as any).query(
      `SELECT coalesce(sum(CASE WHEN side = 'LONG' THEN qty ELSE -qty END), 0)::text AS q FROM futures.position WHERE symbol = $1 AND status = 'OPEN'`,
      [symbol],
    );
    return notional(parseFx(r.rows[0].q), price);
  }

  /** Disponible = billetera de futuros + pérdidas no realizadas de posiciones cruzadas (las ganancias no cuentan). */
  async available(c: PoolClient, playerId: string): Promise<bigint> {
    const bal = await this.balanceOf(c, await this.wallet(c, playerId));
    let crossLoss = 0n;
    const cross = await c.query(`SELECT * FROM futures.position WHERE player_id = $1 AND status = 'OPEN' AND margin_mode = 'CROSS'`, [playerId]);
    for (const p of cross.rows) {
      const m = this.feed.mark(p.symbol);
      if (!m) continue;
      const u = unrealizedPnl(p.side, parseFx(p.qty), parseFx(p.entry_price), m.price);
      if (u < 0n) crossLoss += u;
    }
    const a = bal + crossLoss;
    return a > 0n ? a : 0n;
  }

  private async prefs(c: PoolClient, playerId: string, k: ContractRow) {
    const r = (await c.query(`SELECT leverage, margin_mode FROM futures.player_contract WHERE player_id = $1 AND symbol = $2`, [playerId, k.symbol])).rows[0];
    return { leverage: Math.min(r?.leverage ?? k.defaultLeverage, k.spec.maxLeverage), marginMode: (r?.margin_mode ?? 'ISOLATED') as MarginMode };
  }

  async setPrefs(playerId: string, symbol: string, leverage: number, marginMode: MarginMode) {
    const k = await this.contract(symbol);
    if (!Number.isInteger(leverage) || leverage < 1 || leverage > k.spec.maxLeverage) {
      throw new BusinessError('INVALID_INPUT', `El apalancamiento en ${symbol} va de 1× a ${k.spec.maxLeverage}×`);
    }
    return this.db.tx(async (c) => {
      const pos = await this.openPosition(c, playerId, symbol, false);
      const open = await c.query(`SELECT 1 FROM futures.order WHERE player_id = $1 AND symbol = $2 AND status = 'NEW' LIMIT 1`, [playerId, symbol]);
      if (pos || open.rows[0]) {
        const cur = await this.prefs(c, playerId, k);
        if (cur.marginMode !== marginMode) throw new BusinessError('INVALID_STATE', 'No puedes cambiar el modo de margen con posiciones u órdenes abiertas');
        if (pos && leverage < cur.leverage) {
          // Bajar el apalancamiento con posición abierta exige más margen: se simplifica pidiendo cerrar primero.
          throw new BusinessError('INVALID_STATE', 'Para bajar el apalancamiento cierra la posición o añade margen manualmente');
        }
      }
      await c.query(
        `INSERT INTO futures.player_contract (player_id, symbol, leverage, margin_mode) VALUES ($1, $2, $3, $4)
         ON CONFLICT (player_id, symbol) DO UPDATE SET leverage = EXCLUDED.leverage, margin_mode = EXCLUDED.margin_mode`,
        [playerId, symbol, leverage, marginMode],
      );
      return { symbol, leverage, marginMode };
    });
  }

  async cancelOrder(playerId: string, orderId: string) {
    const r = await this.db.query(
      `UPDATE futures.order SET status = 'CANCELLED', updated_at = now() WHERE id = $1 AND player_id = $2 AND status = 'NEW' RETURNING id`,
      [orderId, playerId],
    );
    if (!r.length) throw new BusinessError('NOT_FOUND', 'La orden no existe o ya no está abierta');
    return this.orderView(orderId);
  }

  private async openPosition(c: PoolClient, playerId: string, symbol: string, lock = true) {
    return (
      await c.query(
        `SELECT * FROM futures.position WHERE player_id = $1 AND symbol = $2 AND status = 'OPEN' ${lock ? 'FOR UPDATE' : ''}`,
        [playerId, symbol],
      )
    ).rows[0] as any;
  }

  // ───────────── Llenado ─────────────

  /**
   * Llena una orden completa al precio dado. Mueve el ledger en una sola transacción:
   * comisión → casa; margen inicial nuevo → bloqueado; margen liberado ± PnL realizado ↔ billetera / casa.
   * Protección de saldo negativo: la pérdida nunca supera lo que el jugador tiene; el faltante lo absorbe la casa.
   */
  private async executeFill(
    c: PoolClient,
    order: any,
    price: bigint,
    liquidity: Liquidity,
    tickId: number | null,
    opts: { feePpm?: bigint } = {},
  ): Promise<{ realizedPnl: bigint; fee: bigint; positionId: string | null; closedPosition?: any; returned: bigint; absorbed: bigint }> {
    const k = await this.contract(order.symbol);
    const spec = k.spec;
    const playerId: string = order.player_id;
    const pos = await this.openPosition(c, playerId, order.symbol, true);
    let qty = parseFx(order.qty);
    const side: OrderSide = order.side;
    if (order.reduce_only) {
      if (!pos || (pos.side === 'LONG') === (side === 'BUY')) {
        await c.query(`UPDATE futures.order SET status = 'CANCELLED', reject_reason = $2, updated_at = now() WHERE id = $1`, [order.id, 'Ya no hay posición que reducir']);
        return { realizedPnl: 0n, fee: 0n, positionId: null, returned: 0n, absorbed: 0n };
      }
      const pq = parseFx(pos.qty);
      if (qty > pq) qty = pq;
    }
    const state: PositionState | null = pos
      ? { side: pos.side, qty: parseFx(pos.qty), entry: parseFx(pos.entry_price), margin: BigInt(pos.margin), leverage: pos.leverage }
      : null;
    const r = applyFill(state, side, qty, price, order.leverage);
    const n = notional(qty, price);
    let fee = feeOf(n, opts.feePpm ?? (liquidity === 'MAKER' ? spec.makerPpm : spec.takerPpm));

    const walletId = await this.wallet(c, playerId);
    const marginId = await this.ledger.playerAccount(c, playerId, 'FUTURES_MARGIN', CUR);
    const feesId = await this.ledger.house(c, 'HOUSE_FUTURES_FEES', 'FUTURES', CUR);
    const pnlId = await this.ledger.house(c, 'HOUSE_FUTURES_PNL', 'FUTURES', CUR);
    const walletBal = await this.balanceOf(c, walletId);
    const cross = (pos?.margin_mode ?? order.margin_mode) === 'CROSS';

    // Cierre: margen liberado m y PnL R.
    const m = r.releasedMargin;
    const R = r.realizedPnl;
    let toWallet = 0n; // margen devuelto + ganancia
    let houseGets = 0n; // pérdida que cobra la casa
    let housePays = 0n; // ganancia que paga la casa
    let fromWallet = 0n; // pérdida en cruzado que excede el margen (sale de la billetera)
    let absorbed = 0n;
    if (r.closedQty > 0n) {
      if (R >= 0n) {
        housePays = R;
        toWallet = m + R;
      } else {
        const loss = -R;
        if (loss <= m) {
          houseGets = loss;
          toWallet = m - loss;
        } else {
          houseGets = m;
          const extra = loss - m;
          if (cross) {
            fromWallet = extra < walletBal ? extra : walletBal;
            absorbed = extra - fromWallet;
          } else absorbed = extra;
        }
      }
    }
    // La comisión sale de lo que el jugador tiene después del cierre; nunca queda en negativo.
    const capacity = walletBal - fromWallet + toWallet - r.addedMargin;
    if (r.addedMargin > 0n && walletBal - fromWallet + toWallet < r.addedMargin + fee) {
      await c.query(`UPDATE futures.order SET status = 'REJECTED', reject_reason = $2, updated_at = now() WHERE id = $1`, [
        order.id,
        'Margen insuficiente al momento de llenar',
      ]);
      return { realizedPnl: 0n, fee: 0n, positionId: pos?.id ?? null, returned: 0n, absorbed: 0n };
    }
    if (fee > capacity) fee = capacity > 0n ? capacity : 0n;
    // Liquidación: la tarifa sale solo de lo que queda del margen de la posición (manual §8.3).
    if (opts.feePpm !== undefined && fee > toWallet) fee = toWallet;

    const entries: { accountId: string; direction: 'D' | 'C'; amount: bigint }[] = [];
    const push = (accountId: string, direction: 'D' | 'C', amount: bigint) => {
      if (amount > 0n) entries.push({ accountId, direction, amount });
    };
    // Margen liberado sale de la cuenta de margen.
    push(marginId, 'D', m);
    push(walletId, 'C', toWallet);
    push(pnlId, 'C', houseGets);
    push(pnlId, 'D', housePays);
    push(walletId, 'D', fromWallet);
    push(pnlId, 'C', fromWallet);
    // Margen nuevo y comisión.
    push(walletId, 'D', r.addedMargin);
    push(marginId, 'C', r.addedMargin);
    push(walletId, 'D', fee);
    push(feesId, 'C', fee);
    let ledgerTx: string | null = null;
    if (entries.length >= 2) {
      ledgerTx = (
        await this.ledger.post(c, {
          type: order.type === 'LIQUIDATION' ? 'FUTURES_LIQUIDATION' : 'FUTURES_FILL',
          refProduct: 'FUTURES',
          refId: order.id,
          idempotencyKey: `futures:fill:${order.id}`,
          createdBy: playerId,
          metadata: { symbol: order.symbol, side, qty: formatFx(qty), price: formatFx(price), liquidity },
          entries,
        })
      ).transactionId;
    }

    // Posición.
    let positionId: string | null = pos?.id ?? null;
    const settings = (await c.query(`SELECT rules_version FROM futures.settings`)).rows[0];
    const closesAll = pos && r.closedQty > 0n && (!r.position || r.position.side !== pos.side);
    // Si la orden cierra e invierte, toda la comisión queda en la posición cerrada.
    if (pos && r.closedQty > 0n) {
      if (closesAll) {
        await c.query(
          `UPDATE futures.position SET qty = 0, margin = 0, status = $2, closed_at = now(), close_price = $3, close_tick_id = $4,
                  realized_pnl = realized_pnl + $5, fees_paid = fees_paid + $6 WHERE id = $1`,
          [pos.id, order.type === 'LIQUIDATION' ? 'LIQUIDATED' : 'CLOSED', formatFx(price), tickId, R.toString(), fee.toString()],
        );
      } else {
        await c.query(
          `UPDATE futures.position SET qty = $2, margin = $3, realized_pnl = realized_pnl + $4, fees_paid = fees_paid + $5 WHERE id = $1`,
          [pos.id, formatFx(r.position!.qty), r.position!.margin.toString(), R.toString(), fee.toString()],
        );
      }
    }
    if (r.position && (!pos || closesAll)) {
      const { rows: [np] } = await c.query(
        `INSERT INTO futures.position (player_id, symbol, side, qty, entry_price, margin, leverage, margin_mode, rules_version, fees_paid)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
        [playerId, order.symbol, r.position.side, formatFx(r.position.qty), formatFx(r.position.entry), r.position.margin.toString(), r.position.leverage,
          order.margin_mode, settings.rules_version, (closesAll ? 0n : fee).toString()],
      );
      positionId = np.id;
    } else if (pos && r.position && r.closedQty === 0n) {
      await c.query(`UPDATE futures.position SET qty = $2, entry_price = $3, margin = $4, fees_paid = fees_paid + $5 WHERE id = $1`, [
        pos.id,
        formatFx(r.position.qty),
        formatFx(r.position.entry),
        r.position.margin.toString(),
        fee.toString(),
      ]);
    }

    await c.query(
      `INSERT INTO futures.fill (order_id, position_id, player_id, symbol, side, qty, price, notional, fee, liquidity, realized_pnl, price_tick_id, ledger_tx_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [order.id, pos?.id ?? positionId, playerId, order.symbol, side, formatFx(qty), formatFx(price), n.toString(), fee.toString(), liquidity, R.toString(), tickId, ledgerTx],
    );
    await c.query(`UPDATE futures.order SET status = 'FILLED', qty = $2, updated_at = now() WHERE id = $1`, [order.id, formatFx(qty)]);
    await publish(c, `player:${playerId}`, 'futures', { symbol: order.symbol, orderId: order.id });
    return { realizedPnl: R, fee, positionId, closedPosition: closesAll ? pos : undefined, returned: toWallet, absorbed };
  }

  // ───────────── Posiciones ─────────────

  /** Cierra a mercado toda la posición o parte (orden solo-reducir). */
  async closePosition(playerId: string, positionId: string, qty?: string) {
    const p = await this.db.one(`SELECT * FROM futures.position WHERE id = $1 AND player_id = $2 AND status = 'OPEN'`, [positionId, playerId]);
    if (!p) throw new BusinessError('NOT_FOUND', 'Posición no encontrada');
    return this.placeOrder(
      playerId,
      { symbol: p.symbol, side: p.side === 'LONG' ? 'SELL' : 'BUY', type: 'MARKET', qty: qty ?? formatFx(parseFx(p.qty)), reduceOnly: true },
      `close:${positionId}:${Date.now()}`,
    );
  }

  async setTpSl(playerId: string, positionId: string, tp: string | null, sl: string | null) {
    const p = await this.db.one(`SELECT * FROM futures.position WHERE id = $1 AND player_id = $2 AND status = 'OPEN'`, [positionId, playerId]);
    if (!p) throw new BusinessError('NOT_FOUND', 'Posición no encontrada');
    const k = await this.contract(p.symbol);
    const mark = this.feed.mark(p.symbol);
    const parse = (v: string | null) => {
      if (v === null || v === '') return null;
      const x = parseFx(v);
      if (x <= 0n || x % k.spec.priceTick !== 0n) throw new BusinessError('INVALID_INPUT', `El precio debe ser múltiplo de ${formatFx(k.spec.priceTick)}`);
      return x;
    };
    const tpx = parse(tp);
    const slx = parse(sl);
    if (mark && tpslTriggered(p.side, mark.price, tpx, slx)) {
      throw new BusinessError('INVALID_INPUT', 'Ese TP/SL ya se cumpliría con el precio actual');
    }
    await this.db.query(`UPDATE futures.position SET tp_price = $2, sl_price = $3 WHERE id = $1`, [positionId, tpx === null ? null : formatFx(tpx), slx === null ? null : formatFx(slx)]);
    return { ok: true };
  }

  /** Margen aislado: añadir desde la billetera o quitar (sin bajar del margen inicial ni acercarse a la liquidación). */
  async adjustMargin(playerId: string, positionId: string, amount: string, action: 'ADD' | 'REMOVE') {
    let a: bigint;
    try {
      a = parseFx(amount, 6);
    } catch {
      throw new BusinessError('INVALID_INPUT', 'Monto inválido');
    }
    if (a <= 0n) throw new BusinessError('INVALID_INPUT', 'Monto inválido');
    return this.db.tx(async (c) => {
      const p = (await c.query(`SELECT * FROM futures.position WHERE id = $1 AND player_id = $2 AND status = 'OPEN' FOR UPDATE`, [positionId, playerId])).rows[0];
      if (!p) throw new BusinessError('NOT_FOUND', 'Posición no encontrada');
      if (p.margin_mode !== 'ISOLATED') throw new BusinessError('INVALID_STATE', 'Solo las posiciones aisladas tienen margen propio');
      const k = await this.contract(p.symbol);
      const walletId = await this.wallet(c, playerId);
      const marginId = await this.ledger.playerAccount(c, playerId, 'FUTURES_MARGIN', CUR);
      const margin = BigInt(p.margin);
      if (action === 'REMOVE') {
        const mark = this.feed.mark(p.symbol);
        if (!mark) throw new BusinessError('MARKET_CLOSED', 'Sin precio válido: no se puede quitar margen ahora');
        const q = parseFx(p.qty);
        const entry = parseFx(p.entry_price);
        const im = initialMargin(notional(q, entry), p.leverage);
        const left = margin - a;
        const u = unrealizedPnl(p.side, q, entry, mark.price);
        if (left < im || left + (u < 0n ? u : 0n) < im) {
          throw new BusinessError('LIMIT_EXCEEDED', `Puedes quitar como máximo ${usdt(margin - im + (u < 0n ? u : 0n) > 0n ? margin - im + (u < 0n ? u : 0n) : 0n)} USDT`);
        }
        await this.ledger.post(c, {
          type: 'FUTURES_MARGIN_REMOVE', refProduct: 'FUTURES', refId: positionId, idempotencyKey: `futures:margin:${positionId}:${Date.now()}`, createdBy: playerId,
          entries: [{ accountId: marginId, direction: 'D', amount: a }, { accountId: walletId, direction: 'C', amount: a }],
        });
        await c.query(`UPDATE futures.position SET margin = margin - $2 WHERE id = $1`, [positionId, a.toString()]);
      } else {
        await this.ledger.post(c, {
          type: 'FUTURES_MARGIN_ADD', refProduct: 'FUTURES', refId: positionId, idempotencyKey: `futures:margin:${positionId}:${Date.now()}`, createdBy: playerId,
          entries: [{ accountId: walletId, direction: 'D', amount: a }, { accountId: marginId, direction: 'C', amount: a }],
        });
        await c.query(`UPDATE futures.position SET margin = margin + $2 WHERE id = $1`, [positionId, a.toString()]);
      }
      void k;
      return { ok: true };
    });
  }

  // ───────────── Billetera ─────────────

  /** Transferencia entre la billetera principal (USDT) y la de futuros. */
  async transfer(playerId: string, direction: 'IN' | 'OUT', amount: string) {
    let a: bigint;
    try {
      a = parseFx(amount, 6);
    } catch {
      throw new BusinessError('INVALID_INPUT', 'Monto inválido');
    }
    if (a <= 0n) throw new BusinessError('INVALID_INPUT', 'Monto inválido');
    return this.db.tx(async (c) => {
      if (!(await this.tradingEnabled(c))) {
        throw new BusinessError('NOT_FOUND', 'Futuros no está disponible');
      }
      await assertPlayerCanPlay(c, playerId);
      await c.query(`SELECT pg_advisory_xact_lock(hashtext('futures-player:' || $1))`, [playerId]);
      const cash = await this.ledger.playerCash(c, playerId, CUR);
      const fut = await this.wallet(c, playerId);
      if (direction === 'IN') {
        const s = (await c.query(`SELECT daily_transfer_limit FROM futures.player_settings WHERE player_id = $1`, [playerId])).rows[0];
        if (s?.daily_transfer_limit) {
          const today = await c.query(
            `SELECT coalesce(sum(e.amount), 0)::text AS t FROM wallet.ledger_entry e JOIN wallet.ledger_transaction t ON t.id = e.transaction_id
              WHERE e.account_id = $1 AND e.direction = 'C' AND t.type = 'FUTURES_TRANSFER_IN'
                AND (t.created_at AT TIME ZONE 'America/Caracas')::date = (now() AT TIME ZONE 'America/Caracas')::date`,
            [fut],
          );
          if (BigInt(today.rows[0].t) + a > BigInt(s.daily_transfer_limit)) {
            throw new BusinessError('LIMIT_EXCEEDED', 'Superas tu límite personal de transferencias diarias a futuros');
          }
        }
      } else {
        const avail = await this.available(c, playerId);
        if (a > avail) throw new BusinessError('INSUFFICIENT_FUNDS', `Solo puedes transferir lo disponible: ${usdt(avail)} USDT`);
      }
      await this.ledger.post(c, {
        type: direction === 'IN' ? 'FUTURES_TRANSFER_IN' : 'FUTURES_TRANSFER_OUT',
        refProduct: 'FUTURES',
        refId: playerId,
        idempotencyKey: `futures:transfer:${playerId}:${Date.now()}:${Math.random()}`,
        createdBy: playerId,
        entries:
          direction === 'IN'
            ? [{ accountId: cash, direction: 'D', amount: a }, { accountId: fut, direction: 'C', amount: a }]
            : [{ accountId: fut, direction: 'D', amount: a }, { accountId: cash, direction: 'C', amount: a }],
      });
      return { ok: true };
    });
  }

  async acceptRisk(playerId: string) {
    await this.db.query(
      `INSERT INTO futures.player_settings (player_id, risk_accepted_at) VALUES ($1, now())
       ON CONFLICT (player_id) DO UPDATE SET risk_accepted_at = now(), updated_at = now()`,
      [playerId],
    );
    return { ok: true };
  }

  async updateSettings(playerId: string, s: { maxLeverage?: number | null; dailyLossLimit?: string | null; dailyTransferLimit?: string | null }) {
    const money = (v?: string | null) => (v === undefined ? undefined : v === null || v === '' ? null : parseFx(v, 6).toString());
    const cur = await this.db.one(`SELECT * FROM futures.player_settings WHERE player_id = $1`, [playerId]);
    if (!cur) throw new BusinessError('RISK_NOT_ACCEPTED', 'Primero acepta el aviso de riesgo de futuros');
    // Un límite personal se puede bajar al instante; subirlo o quitarlo solo es posible una vez al día como protección.
    await this.db.query(
      `UPDATE futures.player_settings SET max_leverage = $2, daily_loss_limit = $3, daily_transfer_limit = $4, updated_at = now() WHERE player_id = $1`,
      [
        playerId,
        s.maxLeverage === undefined ? cur.max_leverage : s.maxLeverage,
        money(s.dailyLossLimit) === undefined ? cur.daily_loss_limit : money(s.dailyLossLimit),
        money(s.dailyTransferLimit) === undefined ? cur.daily_transfer_limit : money(s.dailyTransferLimit),
      ],
    );
    return { ok: true };
  }

  // ───────────── Motor (después de cada tick) ─────────────

  private engineBusy = new Set<string>();

  async runEngine(symbol: string) {
    if (this.engineBusy.has(symbol)) return;
    this.engineBusy.add(symbol);
    try {
      // El interruptor espera a que termine el ciclo en curso, incluido el funding.
      await this.db.tx(async (c) => {
        if (!(await this.tradingEnabled(c))) return;
        const mark = this.feed.mark(symbol);
        if (!mark) return;
        await this.liquidations(symbol, mark.price, mark.tickId);
        await this.triggerTpSl(symbol, mark.price, mark.tickId);
        await this.triggerOrders(symbol, mark.price, mark.tickId);
        await this.funding(symbol, mark.price);
        await this.houseLossGuard();
      });
    } finally {
      this.engineBusy.delete(symbol);
    }
  }

  private async liquidations(symbol: string, mark: bigint, tickId: number) {
    const k = await this.contract(symbol);
    const isolated = await this.db.query(`SELECT * FROM futures.position WHERE symbol = $1 AND status = 'OPEN' AND margin_mode = 'ISOLATED'`, [symbol]);
    for (const p of isolated) {
      if (isLiquidatable(k.spec, p.side, parseFx(p.qty), parseFx(p.entry_price), BigInt(p.margin), mark)) {
        await this.liquidate(p.id, mark, tickId).catch((e) => this.log.error(`Liquidación ${p.id}: ${e.message}`));
      }
    }
    // Cruzado: patrimonio total (billetera + márgenes + PnL) ≤ Σ mantenimiento → se liquidan todas sus cruzadas.
    const players = await this.db.query(`SELECT DISTINCT player_id FROM futures.position WHERE symbol = $1 AND status = 'OPEN' AND margin_mode = 'CROSS'`, [symbol]);
    for (const { player_id } of players) {
      const all = await this.db.query(`SELECT * FROM futures.position WHERE player_id = $1 AND status = 'OPEN' AND margin_mode = 'CROSS'`, [player_id]);
      let equity = 0n;
      let mm = 0n;
      let complete = true;
      for (const p of all) {
        const m = this.feed.mark(p.symbol);
        if (!m) {
          complete = false;
          break;
        }
        const kk = await this.contract(p.symbol);
        const q = parseFx(p.qty);
        equity += BigInt(p.margin) + unrealizedPnl(p.side, q, parseFx(p.entry_price), m.price);
        mm += maintenanceMargin(kk.spec, notional(q, m.price));
      }
      if (!complete) continue;
      const bal = BigInt((await this.db.one(`SELECT coalesce(balance, 0)::text AS b FROM wallet.account WHERE owner_type = 'PLAYER' AND owner_id = $1 AND account_type = 'PLAYER_FUTURES' AND currency = 'USDT'`, [player_id]))?.b ?? '0');
      if (bal + equity <= mm) {
        for (const p of all) {
          const m = this.feed.mark(p.symbol)!;
          await this.liquidate(p.id, m.price, m.tickId).catch((e) => this.log.error(`Liquidación cruzada ${p.id}: ${e.message}`));
        }
      }
    }
  }

  /** Cierra toda la posición al precio marca con tarifa de liquidación (manual §8.3). */
  async liquidate(positionId: string, mark: bigint, tickId: number) {
    await this.db.tx(async (c) => {
      const p = (await c.query(`SELECT * FROM futures.position WHERE id = $1 AND status = 'OPEN' FOR UPDATE`, [positionId])).rows[0];
      if (!p) return;
      const k = await this.contract(p.symbol);
      const q = parseFx(p.qty);
      const entry = parseFx(p.entry_price);
      if (p.margin_mode === 'ISOLATED' && !isLiquidatable(k.spec, p.side, q, entry, BigInt(p.margin), mark)) return;
      const settings = (await c.query(`SELECT rules_version FROM futures.settings`)).rows[0];
      const { rows: [order] } = await c.query(
        `INSERT INTO futures.order (player_id, symbol, side, type, qty, reduce_only, leverage, margin_mode, idempotency_key, rules_version)
         VALUES ($1, $2, $3, 'LIQUIDATION', $4, true, $5, $6, $7, $8) RETURNING *`,
        [p.player_id, p.symbol, p.side === 'LONG' ? 'SELL' : 'BUY', p.qty, p.leverage, p.margin_mode, `liq:${positionId}`, settings.rules_version],
      );
      const r = await this.executeFill(c, order, mark, 'TAKER', tickId, { feePpm: k.spec.liquidationPpm });
      const margin = BigInt(p.margin);
      const loss = r.realizedPnl < 0n ? (-r.realizedPnl < margin ? -r.realizedPnl : margin) : 0n;
      await c.query(
        `INSERT INTO futures.liquidation (position_id, player_id, symbol, side, qty, entry_price, mark_price, margin, loss, fee, returned, absorbed, price_tick_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
        [positionId, p.player_id, p.symbol, p.side, p.qty, p.entry_price, formatFx(mark), margin.toString(), loss.toString(), r.fee.toString(),
          (r.returned - r.fee > 0n ? r.returned - r.fee : 0n).toString(), r.absorbed.toString(), tickId],
      );
      await c.query(`UPDATE futures.order SET status = 'CANCELLED', reject_reason = 'Posición liquidada', updated_at = now()
                      WHERE player_id = $1 AND symbol = $2 AND status = 'NEW' AND reduce_only`, [p.player_id, p.symbol]);
      this.log.warn(`Liquidada ${p.symbol} ${p.side} ${p.qty} de ${p.player_id} a ${formatFx(mark)}`);
    });
  }

  private async triggerTpSl(symbol: string, mark: bigint, tickId: number) {
    const rows = await this.db.query(
      `SELECT * FROM futures.position WHERE symbol = $1 AND status = 'OPEN' AND (tp_price IS NOT NULL OR sl_price IS NOT NULL)`,
      [symbol],
    );
    for (const p of rows) {
      const hit = tpslTriggered(p.side, mark, p.tp_price ? parseFx(p.tp_price) : null, p.sl_price ? parseFx(p.sl_price) : null);
      if (!hit) continue;
      await this.db
        .tx(async (c) => {
          const cur = (await c.query(`SELECT * FROM futures.position WHERE id = $1 AND status = 'OPEN' FOR UPDATE`, [p.id])).rows[0];
          if (!cur) return;
          const settings = (await c.query(`SELECT rules_version FROM futures.settings`)).rows[0];
          const { rows: [order] } = await c.query(
            `INSERT INTO futures.order (player_id, symbol, side, type, qty, stop_price, reduce_only, leverage, margin_mode, idempotency_key, rules_version)
             VALUES ($1, $2, $3, $4, $5, $6, true, $7, $8, $9, $10) RETURNING *`,
            [cur.player_id, cur.symbol, cur.side === 'LONG' ? 'SELL' : 'BUY', hit === 'TP' ? 'TAKE_PROFIT' : 'STOP_LOSS', cur.qty,
              hit === 'TP' ? cur.tp_price : cur.sl_price, cur.leverage, cur.margin_mode, `${hit.toLowerCase()}:${cur.id}`, settings.rules_version],
          );
          await this.executeFill(c, order, mark, 'TAKER', tickId);
        })
        .catch((e) => this.log.error(`TP/SL ${p.id}: ${e.message}`));
    }
  }

  private async triggerOrders(symbol: string, mark: bigint, tickId: number) {
    const k = await this.contract(symbol);
    const orders = await this.db.query(`SELECT * FROM futures.order WHERE symbol = $1 AND status = 'NEW' ORDER BY created_at`, [symbol]);
    for (const o of orders) {
      const isLimit = o.type === 'LIMIT';
      const hit = isLimit ? limitTriggered(o.side, parseFx(o.price), mark) : stopTriggered(o.side, parseFx(o.stop_price), mark);
      if (!hit) continue;
      await this.db
        .tx(async (c) => {
          const cur = (await c.query(`SELECT * FROM futures.order WHERE id = $1 AND status = 'NEW' FOR UPDATE`, [o.id])).rows[0];
          if (!cur) return;
          await c.query(`SELECT pg_advisory_xact_lock(hashtext('futures-player:' || $1))`, [cur.player_id]);
          // Abrir requiere contrato activo; reducir siempre se permite.
          const pos = await this.openPosition(c, cur.player_id, cur.symbol, false);
          const reducing = !!pos && (pos.side === 'LONG') !== (cur.side === 'BUY');
          if (!reducing && !this.canOpen(k)) return;
          // Límite: se llena a su precio y es maker. Stop: a mercado (taker) al precio marca.
          await this.executeFill(c, cur, isLimit ? parseFx(cur.price) : mark, isLimit ? 'MAKER' : 'TAKER', tickId);
        })
        .catch(async (e) => {
          await this.db.query(`UPDATE futures.order SET status = 'REJECTED', reject_reason = $2, updated_at = now() WHERE id = $1 AND status = 'NEW'`, [
            o.id,
            String(e.message).slice(0, 200),
          ]);
        });
    }
  }

  /** Funding a las 00:00, 08:00 y 16:00 UTC: cada posición abierta antes del corte paga o cobra nocional × tasa (manual §8.2). */
  private async funding(symbol: string, mark: bigint) {
    const now = Date.now();
    const period = 8 * 3600_000;
    const boundary = new Date(Math.floor(now / period) * period);
    if (now - boundary.getTime() > 3600_000) return; // solo dentro de la hora siguiente al corte
    const f = this.feed.get(symbol);
    const rate = f?.fundingE8 ?? FUNDING_INTEREST_E8;
    const inserted = await this.db.query(
      `INSERT INTO futures.funding_rate (symbol, funding_time, rate, mark_price, sources) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (symbol, funding_time) DO NOTHING RETURNING id`,
      [symbol, boundary, formatFx(rate), formatFx(mark), f?.fundingSources ?? {}],
    );
    if (!inserted.length) return; // ya aplicado
    const positions = await this.db.query(`SELECT * FROM futures.position WHERE symbol = $1 AND status = 'OPEN' AND opened_at < $2`, [symbol, boundary]);
    for (const p of positions) {
      await this.db
        .tx(async (c) => {
          const cur = (await c.query(`SELECT * FROM futures.position WHERE id = $1 AND status = 'OPEN' FOR UPDATE`, [p.id])).rows[0];
          if (!cur) return;
          const n = notional(parseFx(cur.qty), mark);
          let amount = fundingPayment(cur.side as FxSide, n, rate);
          if (amount === 0n) return;
          const walletId = await this.wallet(c, cur.player_id);
          const marginId = await this.ledger.playerAccount(c, cur.player_id, 'FUTURES_MARGIN', CUR);
          const pnlId = await this.ledger.house(c, 'HOUSE_FUTURES_PNL', 'FUTURES', CUR);
          // Aislado: sale del (o entra al) margen de la posición. Cruzado: de la billetera de futuros.
          const isolated = cur.margin_mode === 'ISOLATED';
          const source = isolated ? marginId : walletId;
          if (amount > 0n) {
            const have = isolated ? BigInt(cur.margin) : await this.balanceOf(c, walletId);
            if (amount > have) amount = have; // protección de saldo negativo
            if (amount <= 0n) return;
          }
          const entries =
            amount > 0n
              ? [{ accountId: source, direction: 'D' as const, amount }, { accountId: pnlId, direction: 'C' as const, amount }]
              : [{ accountId: pnlId, direction: 'D' as const, amount: -amount }, { accountId: source, direction: 'C' as const, amount: -amount }];
          const tx = await this.ledger.post(c, {
            type: 'FUTURES_FUNDING', refProduct: 'FUTURES', refId: cur.id, idempotencyKey: `futures:funding:${cur.id}:${boundary.toISOString()}`, entries,
          });
          if (isolated) await c.query(`UPDATE futures.position SET margin = margin - $2 WHERE id = $1`, [cur.id, amount.toString()]);
          await c.query(`UPDATE futures.position SET funding_paid = funding_paid + $2 WHERE id = $1`, [cur.id, amount.toString()]);
          await c.query(
            `INSERT INTO futures.funding_payment (position_id, player_id, symbol, funding_time, rate, notional, amount, ledger_tx_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT DO NOTHING`,
            [cur.id, cur.player_id, symbol, boundary, formatFx(rate), n.toString(), amount.toString(), tx.transactionId],
          );
        })
        .catch((e) => this.log.error(`Funding ${p.id}: ${e.message}`));
    }
    await this.db.query(`UPDATE futures.funding_rate SET applied_at = now() WHERE symbol = $1 AND funding_time = $2`, [symbol, boundary]);
  }

  private lossCheckAt = 0;

  /** Pérdida diaria máxima de la casa (manual §9): si se supera, todos los contratos pasan a «solo cerrar». */
  private async houseLossGuard() {
    if (Date.now() - this.lossCheckAt < 30_000) return;
    this.lossCheckAt = Date.now();
    const r = await this.houseResultToday();
    const s = await this.db.one(`SELECT house_capital::text, daily_loss_limit_ppm FROM futures.settings`);
    const limit = (BigInt(s!.house_capital) * BigInt(s!.daily_loss_limit_ppm)) / 1_000_000n;
    if (r.total < -limit) {
      const changed = await this.db.query(
        `UPDATE futures.contract SET status = 'CLOSE_ONLY', status_reason = 'Pérdida diaria máxima de la casa alcanzada' WHERE status = 'ACTIVE' RETURNING symbol`,
      );
      if (changed.length) {
        await this.db.query(`INSERT INTO futures.incident (kind, description) VALUES ('LOSS_LIMIT', $1)`, [
          `Resultado del día ${usdt(r.total)} USDT supera la pérdida máxima de ${usdt(limit)} USDT. Solo cerrar.`,
        ]);
        await this.loadContracts(true);
      }
    }
  }

  /** Resultado de la casa hoy (hora de Caracas): comisiones + liquidaciones + funding neto + PnL contra jugadores. */
  async houseResultToday() {
    const r = await this.db.one(
      `WITH day AS (SELECT (now() AT TIME ZONE 'America/Caracas')::date AS d)
       SELECT coalesce((SELECT sum(f.fee) FROM futures.fill f JOIN futures.order o ON o.id = f.order_id, day
                         WHERE o.type <> 'LIQUIDATION' AND (f.created_at AT TIME ZONE 'America/Caracas')::date = day.d), 0)::text AS fees,
              coalesce((SELECT sum(f.fee) FROM futures.fill f JOIN futures.order o ON o.id = f.order_id, day
                         WHERE o.type = 'LIQUIDATION' AND (f.created_at AT TIME ZONE 'America/Caracas')::date = day.d), 0)::text AS liquidation_fees,
              coalesce((SELECT sum(p.amount) FROM futures.funding_payment p, day WHERE (p.created_at AT TIME ZONE 'America/Caracas')::date = day.d), 0)::text AS funding,
              coalesce((SELECT -sum(f.realized_pnl) FROM futures.fill f, day WHERE (f.created_at AT TIME ZONE 'America/Caracas')::date = day.d), 0)::text AS pnl,
              coalesce((SELECT sum(l.absorbed) FROM futures.liquidation l, day WHERE (l.created_at AT TIME ZONE 'America/Caracas')::date = day.d), 0)::text AS absorbed`,
    );
    const fees = BigInt(r!.fees);
    const liq = BigInt(r!.liquidation_fees);
    const funding = BigInt(r!.funding);
    // El PnL de los jugadores contra la casa, sin contar el faltante que ya no se cobró (protección de saldo negativo).
    const pnl = BigInt(r!.pnl) - BigInt(r!.absorbed);
    return { fees, liquidationFees: liq, funding, pnl, absorbed: BigInt(r!.absorbed), total: fees + liq + funding + pnl };
  }

  // ───────────── Vistas ─────────────

  async orderView(orderId: string) {
    return this.db.one(`SELECT * FROM futures.order WHERE id = $1`, [orderId]);
  }

  /** Posición con precio marca, PnL, ROE, liquidación y uso del margen. */
  async positionView(p: any) {
    const k = await this.contract(p.symbol);
    const m = this.feed.mark(p.symbol) ?? (this.feed.get(p.symbol)?.index ? { price: this.feed.get(p.symbol)!.index!, tickId: 0 } : null);
    const q = parseFx(p.qty);
    const entry = parseFx(p.entry_price);
    const margin = BigInt(p.margin);
    const mark = m?.price ?? entry;
    const u = unrealizedPnl(p.side, q, entry, mark);
    const n = notional(q, mark);
    const mm = maintenanceMargin(k.spec, n);
    const im = initialMargin(notional(q, entry), p.leverage);
    // Cruzado: el precio de liquidación usa también el saldo libre de la billetera (suponiendo que lo demás no se mueve).
    let liqMargin = margin;
    if (p.margin_mode === 'CROSS') {
      const bal = await this.db.one(`SELECT coalesce(balance, 0)::text AS b FROM wallet.account WHERE owner_type = 'PLAYER' AND owner_id = $1 AND account_type = 'PLAYER_FUTURES' AND currency = 'USDT'`, [p.player_id]);
      liqMargin += BigInt(bal?.b ?? '0');
    }
    const liq = liquidationPrice(k.spec, p.side, q, entry, liqMargin);
    return {
      id: p.id,
      symbol: p.symbol,
      side: p.side,
      qty: formatFx(q),
      entry_price: formatFx(entry),
      mark_price: formatFx(mark),
      liquidation_price: liq > 0n ? formatFx(liq) : null,
      margin: usdt(margin),
      initial_margin: usdt(im),
      maintenance_margin: usdt(mm),
      margin_ratio: margin + u > 0n ? Number((mm * 10000n) / (margin + (p.margin_mode === 'CROSS' ? liqMargin - margin : 0n) + u)) / 100 : 100,
      notional: usdt(n),
      leverage: p.leverage,
      margin_mode: p.margin_mode,
      unrealized_pnl: usdt(u),
      roe: im > 0n ? Number((u * 10000n) / im) / 100 : 0,
      tp_price: p.tp_price ? formatFx(parseFx(p.tp_price)) : null,
      sl_price: p.sl_price ? formatFx(parseFx(p.sl_price)) : null,
      realized_pnl: usdt(BigInt(p.realized_pnl)),
      fees_paid: usdt(BigInt(p.fees_paid)),
      funding_paid: usdt(BigInt(p.funding_paid)),
      status: p.status,
      opened_at: p.opened_at,
      closed_at: p.closed_at,
      close_price: p.close_price ? formatFx(parseFx(p.close_price)) : null,
    };
  }

  async account(playerId: string) {
    const [wallet, margin, cash, settings, prefs] = await Promise.all([
      this.db.one(`SELECT coalesce(balance, 0)::text AS b FROM wallet.account WHERE owner_type = 'PLAYER' AND owner_id = $1 AND account_type = 'PLAYER_FUTURES' AND currency = 'USDT'`, [playerId]),
      this.db.one(`SELECT coalesce(balance, 0)::text AS b FROM wallet.account WHERE owner_type = 'PLAYER' AND owner_id = $1 AND account_type = 'FUTURES_MARGIN' AND currency = 'USDT'`, [playerId]),
      this.db.one(`SELECT coalesce(balance, 0)::text AS b FROM wallet.account WHERE owner_type = 'PLAYER' AND owner_id = $1 AND account_type = 'PLAYER_CASH' AND currency = 'USDT'`, [playerId]),
      this.db.one(`SELECT risk_accepted_at, max_leverage, daily_loss_limit::text, daily_transfer_limit::text FROM futures.player_settings WHERE player_id = $1`, [playerId]),
      this.db.query(`SELECT symbol, leverage, margin_mode FROM futures.player_contract WHERE player_id = $1`, [playerId]),
    ]);
    const kyc = await this.db.one(`SELECT kyc_level FROM identity.app_user WHERE id = $1`, [playerId]);
    const positions = await this.db.query(`SELECT * FROM futures.position WHERE player_id = $1 AND status = 'OPEN' ORDER BY opened_at`, [playerId]);
    const views = await Promise.all(positions.map((p) => this.positionView(p)));
    const upnl = views.reduce((a, v) => a + parseFx(v.unrealized_pnl, 6), 0n);
    const avail = await this.db.tx((c) => this.available(c, playerId));
    const contracts = await this.loadContracts();
    return {
      wallet: usdt(BigInt(wallet?.b ?? '0')),
      margin: usdt(BigInt(margin?.b ?? '0')),
      available: usdt(avail),
      unrealized_pnl: usdt(upnl),
      equity: usdt(BigInt(wallet?.b ?? '0') + BigInt(margin?.b ?? '0') + upnl),
      cash_usdt: usdt(BigInt(cash?.b ?? '0')),
      kyc_level: kyc?.kyc_level ?? 0,
      risk_accepted: !!settings?.risk_accepted_at,
      settings: settings
        ? {
            max_leverage: settings.max_leverage,
            daily_loss_limit: settings.daily_loss_limit ? usdt(BigInt(settings.daily_loss_limit)) : null,
            daily_transfer_limit: settings.daily_transfer_limit ? usdt(BigInt(settings.daily_transfer_limit)) : null,
          }
        : null,
      today_loss: usdt(await this.todayLoss(this.db.pool, playerId)),
      prefs: [...contracts.values()].map((k) => {
        const p = prefs.find((x) => x.symbol === k.symbol);
        return { symbol: k.symbol, leverage: Math.min(p?.leverage ?? k.defaultLeverage, k.spec.maxLeverage), margin_mode: p?.margin_mode ?? 'ISOLATED' };
      }),
      positions: views,
    };
  }

  /** Contratos con precio, variación 24 h, funding y estado (público). */
  async contractsView() {
    const contracts = await this.loadContracts();
    const out = [];
    for (const k of contracts.values()) {
      const f = this.feed.get(k.symbol);
      const ago = await this.db.one(
        `SELECT index_price::text FROM futures.price_tick WHERE symbol = $1 AND created_at >= now() - interval '24 hours' ORDER BY created_at LIMIT 1`,
        [k.symbol],
      );
      const hl = await this.db.one(
        `SELECT max(index_price)::text AS hi, min(index_price)::text AS lo FROM futures.price_tick WHERE symbol = $1 AND created_at >= now() - interval '24 hours'`,
        [k.symbol],
      );
      const idx = f?.index ?? null;
      const open = ago ? parseFx(ago.index_price) : null;
      const next = new Date(Math.floor(Date.now() / (8 * 3600_000)) * 8 * 3600_000 + 8 * 3600_000);
      out.push({
        symbol: k.symbol,
        base: k.base,
        name: k.name,
        status: k.status,
        status_reason: k.statusReason,
        feed_ok: !!f?.ok,
        sources: f?.sources ?? {},
        index_price: idx ? formatFx(idx) : null,
        mark_price: idx ? formatFx(idx) : null,
        change_24h: idx && open ? Number(((idx - open) * 1_000_000n) / open) / 10_000 : null,
        high_24h: hl?.hi ? formatFx(parseFx(hl.hi)) : null,
        low_24h: hl?.lo ? formatFx(parseFx(hl.lo)) : null,
        funding_rate: formatFx(f?.fundingE8 ?? FUNDING_INTEREST_E8),
        next_funding_time: next.toISOString(),
        qty_step: formatFx(k.spec.qtyStep),
        price_tick: formatFx(k.spec.priceTick),
        min_notional: usdt(k.spec.minNotional),
        max_leverage: k.spec.maxLeverage,
        default_leverage: k.defaultLeverage,
        taker_fee: Number(k.spec.takerPpm) / 10_000,
        maker_fee: Number(k.spec.makerPpm) / 10_000,
        liquidation_fee: Number(k.spec.liquidationPpm) / 10_000,
        brackets: k.spec.brackets.map((b) => ({ floor: usdt(b.floor), cap: usdt(b.cap), max_leverage: b.maxLeverage, mmr: Number(b.mmrPpm) / 10_000, cum: usdt(b.cum) })),
      });
    }
    return out;
  }

  /** Velas del índice (OHLC) a partir de los ticks guardados. */
  async candles(symbol: string, interval: string, limit: number) {
    const sizes: Record<string, string> = { '1m': '1 minute', '5m': '5 minutes', '15m': '15 minutes', '1h': '1 hour', '4h': '4 hours', '1d': '1 day' };
    const size = sizes[interval];
    if (!size) throw new BusinessError('INVALID_INPUT', 'Intervalo inválido');
    return this.db.query(
      `SELECT bucket AS t,
              (array_agg(index_price ORDER BY created_at))[1]::text AS o,
              max(index_price)::text AS h, min(index_price)::text AS l,
              (array_agg(index_price ORDER BY created_at DESC))[1]::text AS c
         FROM (SELECT date_bin($2::interval, created_at, '2000-01-01') AS bucket, index_price, created_at
                 FROM futures.price_tick WHERE symbol = $1 AND created_at >= now() - $2::interval * $3) x
        GROUP BY bucket ORDER BY bucket`,
      [symbol, size, Math.min(Math.max(limit, 10), 500)],
    );
  }
}
