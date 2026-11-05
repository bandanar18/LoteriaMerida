import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { aggregateTicketStatus, assertTransition, CurrencyCode, DrawStatus, parseScaled100, PlayStatus, settlePlay } from '@loteria/domain';
import { AuditService } from '../audit/audit.service';
import { Db, DbService } from '../common/db.service';
import { BusinessError, pgErrorCode } from '../common/errors';
import { publish } from '../common/realtime';
import { config } from '../config';
import { RngService } from '../rng/rng.service';
import { LedgerService } from '../wallet/ledger.service';

const SCHEDULER_LOCK_KEY = 4_242_100;

type Actor = { id: string; ip?: string };

/**
 * Ciclo de vida de sorteos (Doc. Maestro §9.4–9.5):
 * SCHEDULED → OPEN → CLOSED → (RESULT_PENDING) → RESULT_CONFIRMED → SETTLED, o CANCELLED.
 * Todos los tiempos se evalúan con el reloj de la base de datos (servidor), nunca del cliente.
 */
@Injectable()
export class DrawLifecycleService {
  private readonly log = new Logger('DrawLifecycle');
  private running = false;

  constructor(
    private readonly db: DbService,
    private readonly ledger: LedgerService,
    private readonly audit: AuditService,
    private readonly rng: RngService,
  ) {}

  @Interval(10_000)
  async tick() {
    if (!config.lotteryScheduler || this.running) return;
    this.running = true;
    const lockClient = await this.db.pool.connect();
    try {
      // Una sola instancia ejecuta el ciclo a la vez (si hay varias réplicas del API).
      const got = (await lockClient.query('SELECT pg_try_advisory_lock($1) AS ok', [SCHEDULER_LOCK_KEY])).rows[0].ok;
      if (!got) return;
      try {
        await this.runCycle();
      } finally {
        await lockClient.query('SELECT pg_advisory_unlock($1)', [SCHEDULER_LOCK_KEY]);
      }
    } catch (err) {
      this.log.error(`Error en ciclo de sorteos: ${(err as Error).message}`, (err as Error).stack);
    } finally {
      lockClient.release();
      this.running = false;
    }
  }

  async runCycle() {
    await this.generateDraws();
    const opened = await this.db.query(
      `UPDATE lottery.draw SET status = 'OPEN' WHERE status = 'SCHEDULED' AND sales_open_at <= now() AND close_at > now()
       RETURNING id, game_id`,
    );
    for (const d of opened) await this.notifyDraw(this.db.pool, d.id, d.game_id, 'OPEN');
    const closed = await this.db.query(
      `UPDATE lottery.draw d SET status = 'CLOSED' FROM lottery.game g
        WHERE g.id = d.game_id AND d.status IN ('SCHEDULED', 'OPEN') AND d.close_at <= now()
        RETURNING d.id, d.game_id, g.result_source`,
    );
    for (const d of closed) {
      await this.db.tx(async (c) => {
        await this.audit.log(c, { actorType: 'SYSTEM', action: 'DRAW_CLOSED', entity: 'lottery.draw', entityId: d.id });
        await this.notifyDraw(c, d.id, d.game_id, 'CLOSED');
        if (d.result_source === 'MANUAL') await publish(c, 'staff', 'queue', { kind: 'results' });
      });
    }
    const dueRng = await this.db.query(
      `SELECT d.id FROM lottery.draw d JOIN lottery.game g ON g.id = d.game_id
        WHERE g.result_source = 'INTERNAL_RNG' AND d.status = 'CLOSED' AND d.draw_at <= now() ORDER BY d.draw_at`,
    );
    for (const d of dueRng) await this.resolveWithRng(d.id);
    const toSettle = await this.db.query(`SELECT id FROM lottery.draw WHERE status = 'RESULT_CONFIRMED' ORDER BY draw_at`);
    for (const d of toSettle) await this.settleDraw(d.id);
  }

  /** Crea los sorteos de hoy y mañana a partir del calendario (idempotente). */
  async generateDraws() {
    const candidates = await this.db.query(
      `SELECT g.id AS game_id, g.close_minutes_before,
              ((day.d + s.draw_time) AT TIME ZONE g.timezone) AS draw_at,
              (day.d::timestamp AT TIME ZONE g.timezone) AS sales_open_at
         FROM lottery.game g
         JOIN lottery.schedule s ON s.game_id = g.id AND s.active
         CROSS JOIN LATERAL (SELECT ((now() AT TIME ZONE g.timezone)::date + k) AS d FROM generate_series(0, 1) k) day
        WHERE g.status = 'ACTIVE'
          AND extract(dow FROM day.d) = s.weekday
          AND ((day.d + s.draw_time) AT TIME ZONE g.timezone) - make_interval(mins => g.close_minutes_before) > now()
          AND NOT EXISTS (SELECT 1 FROM lottery.draw x
                           WHERE x.game_id = g.id AND x.draw_at = ((day.d + s.draw_time) AT TIME ZONE g.timezone))`,
    );
    for (const c of candidates) {
      const { serverSeed, seedHash } = this.rng.newCommitment();
      await this.db.query(
        `INSERT INTO lottery.draw (game_id, draw_at, sales_open_at, close_at, seed_hash, server_seed)
         VALUES ($1, $2, $3, $2::timestamptz - make_interval(mins => $4), $5, $6)
         ON CONFLICT (game_id, draw_at) DO NOTHING`,
        [c.game_id, c.draw_at, c.sales_open_at, c.close_minutes_before, seedHash, serverSeed],
      );
    }
    if (candidates.length) this.log.log(`Sorteos generados: ${candidates.length}`);
  }

  async createExtraordinaryDraw(gameId: string, minutesFromNow: number, actor: Actor) {
    try {
      return await this.createExtraordinaryDrawTx(gameId, minutesFromNow, actor);
    } catch (err) {
      if (pgErrorCode(err) === '23505') throw new BusinessError('CONFLICT', 'Ya existe un sorteo de este juego a esa hora');
      throw err;
    }
  }

  private async createExtraordinaryDrawTx(gameId: string, minutesFromNow: number, actor: Actor) {
    return this.db.tx(async (c) => {
      const g = (await c.query(`SELECT * FROM lottery.game WHERE id = $1 AND status = 'ACTIVE'`, [gameId])).rows[0];
      if (!g) throw new BusinessError('NOT_FOUND', 'Juego no encontrado');
      if (minutesFromNow <= g.close_minutes_before) {
        throw new BusinessError('INVALID_INPUT', `Debe ser mayor que el cierre de venta (${g.close_minutes_before} min)`);
      }
      const { serverSeed, seedHash } = this.rng.newCommitment();
      const res = await c.query(
        `INSERT INTO lottery.draw (game_id, draw_at, sales_open_at, close_at, status, is_extraordinary, seed_hash, server_seed)
         VALUES ($1, date_trunc('minute', now()) + make_interval(mins => $2), now(),
                 date_trunc('minute', now()) + make_interval(mins => $2 - $3), 'OPEN', true, $4, $5)
         RETURNING id, draw_at, close_at`,
        [gameId, minutesFromNow, g.close_minutes_before, seedHash, serverSeed],
      );
      await this.audit.log(c, {
        actorType: 'STAFF',
        actorId: actor.id,
        action: 'DRAW_CREATED_EXTRAORDINARY',
        entity: 'lottery.draw',
        entityId: res.rows[0].id,
        after: res.rows[0],
        ip: actor.ip,
      });
      await this.notifyDraw(c, res.rows[0].id, gameId, 'OPEN');
      return res.rows[0];
    });
  }

  /** Aviso público de cambio de estado de un sorteo (sala lobby). */
  private notifyDraw(c: Db, drawId: string, gameId: string, status: DrawStatus) {
    return publish(c, 'lobby', 'draw', { id: drawId, gameId, status });
  }

  private async lockDraw(c: Db, drawId: string) {
    const d = (
      await c.query(
        `SELECT d.*, g.result_source, g.payout_multiplier::text AS multiplier, d.draw_at <= now() AS due
           FROM lottery.draw d JOIN lottery.game g ON g.id = d.game_id WHERE d.id = $1 FOR UPDATE OF d`,
        [drawId],
      )
    ).rows[0];
    if (!d) throw new BusinessError('NOT_FOUND', 'Sorteo no encontrado');
    return d;
  }

  private transition(from: DrawStatus, to: DrawStatus) {
    try {
      assertTransition(from, to);
    } catch (e) {
      throw new BusinessError('INVALID_STATE', (e as Error).message);
    }
  }

  /** Resultado por RNG con semilla comprometida antes de la venta (provably fair). */
  async resolveWithRng(drawId: string) {
    await this.db.tx(async (c) => {
      const d = await this.lockDraw(c, drawId);
      if (d.status !== 'CLOSED' || d.result_source !== 'INTERNAL_RNG' || !d.due) return;
      const symbols = (await c.query(`SELECT id, number, name FROM lottery.symbol WHERE game_id = $1 ORDER BY sort`, [d.game_id]))
        .rows;
      const idx = await this.rng.fromCommitment(c, {
        consumer: 'lottery.draw',
        refId: d.id,
        serverSeed: d.server_seed,
        n: symbols.length,
      });
      const winner = symbols[idx];
      await c.query(
        `UPDATE lottery.draw SET status = 'RESULT_CONFIRMED', result_symbol_id = $2, confirmed_at = now(),
                result_evidence = 'RNG provably fair (HMAC-SHA256 sobre semilla comprometida)'
          WHERE id = $1`,
        [drawId, winner.id],
      );
      await this.audit.log(c, {
        actorType: 'SYSTEM',
        action: 'DRAW_RESULT_RNG',
        entity: 'lottery.draw',
        entityId: drawId,
        after: { symbol: `${winner.number} ${winner.name}`, index: idx, seedHash: d.seed_hash },
      });
      await this.notifyDraw(c, drawId, d.game_id, 'RESULT_CONFIRMED');
      this.log.log(`Sorteo ${drawId}: salió ${winner.number} ${winner.name}`);
    });
  }

  /** Paso 1 de 2 (4 ojos): un operador propone el resultado oficial con evidencia. */
  async proposeResult(drawId: string, symbolId: string, evidence: string, actor: Actor) {
    return this.db.tx(async (c) => {
      const d = await this.lockDraw(c, drawId);
      if (d.result_source === 'INTERNAL_RNG') throw new BusinessError('INVALID_STATE', 'Este juego se sortea por RNG');
      if (!d.due) throw new BusinessError('INVALID_STATE', 'El sorteo aún no se ha realizado');
      this.transition(d.status, 'RESULT_PENDING');
      const s = (await c.query(`SELECT id, number, name FROM lottery.symbol WHERE id = $1 AND game_id = $2`, [symbolId, d.game_id]))
        .rows[0];
      if (!s) throw new BusinessError('INVALID_INPUT', 'Animal inválido');
      await c.query(
        `UPDATE lottery.draw SET status = 'RESULT_PENDING', proposed_symbol_id = $2, proposed_by = $3, proposed_at = now(),
                result_evidence = $4 WHERE id = $1`,
        [drawId, symbolId, actor.id, evidence],
      );
      await this.audit.log(c, {
        actorType: 'STAFF',
        actorId: actor.id,
        action: 'DRAW_RESULT_PROPOSED',
        entity: 'lottery.draw',
        entityId: drawId,
        after: { symbol: `${s.number} ${s.name}`, evidence },
        ip: actor.ip,
      });
      await this.notifyDraw(c, drawId, d.game_id, 'RESULT_PENDING');
      await publish(c, 'staff', 'queue', { kind: 'results' });
      return { status: 'RESULT_PENDING' };
    });
  }

  /** Paso 2 de 2: otro usuario confirma; luego se liquida. */
  async confirmResult(drawId: string, actor: Actor) {
    await this.db.tx(async (c) => {
      const d = await this.lockDraw(c, drawId);
      this.transition(d.status, 'RESULT_CONFIRMED');
      if (d.proposed_by === actor.id) {
        throw new BusinessError('FOUR_EYES_REQUIRED', 'El resultado debe confirmarlo un usuario distinto a quien lo cargó');
      }
      await c.query(
        `UPDATE lottery.draw SET status = 'RESULT_CONFIRMED', result_symbol_id = proposed_symbol_id,
                confirmed_by = $2, confirmed_at = now() WHERE id = $1`,
        [drawId, actor.id],
      );
      await this.audit.log(c, {
        actorType: 'STAFF',
        actorId: actor.id,
        action: 'DRAW_RESULT_CONFIRMED',
        entity: 'lottery.draw',
        entityId: drawId,
        after: { symbolId: d.proposed_symbol_id, proposedBy: d.proposed_by },
        ip: actor.ip,
      });
      await this.notifyDraw(c, drawId, d.game_id, 'RESULT_CONFIRMED');
      await publish(c, 'staff', 'queue', { kind: 'results' });
    });
    return this.settleDraw(drawId);
  }

  async rejectResult(drawId: string, actor: Actor) {
    return this.db.tx(async (c) => {
      const d = await this.lockDraw(c, drawId);
      this.transition(d.status, 'CLOSED');
      await c.query(
        `UPDATE lottery.draw SET status = 'CLOSED', proposed_symbol_id = NULL, proposed_by = NULL, proposed_at = NULL,
                result_evidence = NULL WHERE id = $1`,
        [drawId],
      );
      await this.audit.log(c, {
        actorType: 'STAFF',
        actorId: actor.id,
        action: 'DRAW_RESULT_REJECTED',
        entity: 'lottery.draw',
        entityId: drawId,
        before: { symbolId: d.proposed_symbol_id, proposedBy: d.proposed_by },
        ip: actor.ip,
      });
      await this.notifyDraw(c, drawId, d.game_id, 'CLOSED');
      await publish(c, 'staff', 'queue', { kind: 'results' });
      return { status: 'CLOSED' };
    });
  }

  /** Liquida todas las jugadas abiertas del sorteo contra el resultado confirmado. */
  async settleDraw(drawId: string) {
    return this.db.tx(async (c) => {
      const d = await this.lockDraw(c, drawId);
      if (d.status !== 'RESULT_CONFIRMED') return { settled: 0 };
      const multiplier = parseScaled100(d.multiplier);
      const plays = (
        await c.query(
          `SELECT p.id, p.ticket_id, p.symbol_id, p.amount, t.player_id, t.currency
             FROM lottery.play p JOIN lottery.ticket t ON t.id = p.ticket_id
            WHERE p.draw_id = $1 AND p.status = 'OPEN' ORDER BY p.id FOR UPDATE OF p`,
          [drawId],
        )
      ).rows;

      let staked = 0n;
      let paid = 0n;
      let winners = 0;
      for (const p of plays) {
        const amount = BigInt(p.amount);
        const currency = p.currency as CurrencyCode;
        const { won, win } = settlePlay({ symbolId: p.symbol_id, amount }, d.result_symbol_id, multiplier);
        const inPlay = await this.ledger.house(c, 'BETS_IN_PLAY', 'LOTTERY', currency);
        const ggr = await this.ledger.house(c, 'HOUSE_GGR', 'LOTTERY', currency);
        const entries = won
          ? [
              { accountId: inPlay, direction: 'D' as const, amount },
              ...(win > amount ? [{ accountId: ggr, direction: 'D' as const, amount: win - amount }] : []),
              { accountId: await this.ledger.playerCash(c, p.player_id, currency), direction: 'C' as const, amount: win },
            ]
          : [
              { accountId: inPlay, direction: 'D' as const, amount },
              { accountId: ggr, direction: 'C' as const, amount },
            ];
        await this.ledger.post(c, {
          type: won ? 'BET_WON' : 'BET_LOST',
          refProduct: 'LOTTERY',
          refId: p.id,
          idempotencyKey: `lottery:play-settle:${p.id}`,
          metadata: { drawId, ticketId: p.ticket_id },
          entries,
        });
        await c.query(`UPDATE lottery.play SET status = $2, win = $3, settled_at = now() WHERE id = $1`, [
          p.id,
          won ? 'WON' : 'LOST',
          win.toString(),
        ]);
        staked += amount;
        paid += win;
        if (won) winners++;
      }

      await this.refreshTickets(c, [...new Set(plays.map((p) => p.ticket_id as string))]);
      await c.query(`UPDATE lottery.draw SET status = 'SETTLED', settled_at = now() WHERE id = $1`, [drawId]);
      await this.audit.log(c, {
        actorType: 'SYSTEM',
        action: 'DRAW_SETTLED',
        entity: 'lottery.draw',
        entityId: drawId,
        after: { plays: plays.length, winners, staked, paid },
      });
      await this.notifyDraw(c, drawId, d.game_id, 'SETTLED');
      return { settled: plays.length, winners };
    });
  }

  /** Anula un sorteo y devuelve todas sus jugadas abiertas. */
  async cancelDraw(drawId: string, reason: string, actor: Actor) {
    return this.db.tx(async (c) => {
      const d = await this.lockDraw(c, drawId);
      this.transition(d.status, 'CANCELLED');
      const plays = (
        await c.query(
          `SELECT p.id, p.ticket_id, p.amount, t.player_id, t.currency
             FROM lottery.play p JOIN lottery.ticket t ON t.id = p.ticket_id
            WHERE p.draw_id = $1 AND p.status = 'OPEN' ORDER BY p.id FOR UPDATE OF p`,
          [drawId],
        )
      ).rows;
      for (const p of plays) {
        const amount = BigInt(p.amount);
        await this.ledger.post(c, {
          type: 'BET_VOID',
          refProduct: 'LOTTERY',
          refId: p.id,
          idempotencyKey: `lottery:play-void:${p.id}`,
          createdBy: actor.id,
          metadata: { drawId, reason },
          entries: [
            { accountId: await this.ledger.house(c, 'BETS_IN_PLAY', 'LOTTERY', p.currency), direction: 'D', amount },
            { accountId: await this.ledger.playerCash(c, p.player_id, p.currency), direction: 'C', amount },
          ],
        });
        await c.query(`UPDATE lottery.play SET status = 'VOID', settled_at = now() WHERE id = $1`, [p.id]);
      }
      await this.refreshTickets(c, [...new Set(plays.map((p) => p.ticket_id as string))]);
      await c.query(`UPDATE lottery.draw SET status = 'CANCELLED', cancelled_reason = $2 WHERE id = $1`, [drawId, reason]);
      await this.audit.log(c, {
        actorType: 'STAFF',
        actorId: actor.id,
        action: 'DRAW_CANCELLED',
        entity: 'lottery.draw',
        entityId: drawId,
        before: { status: d.status },
        after: { status: 'CANCELLED', reason, refundedPlays: plays.length },
        ip: actor.ip,
      });
      await this.notifyDraw(c, drawId, d.game_id, 'CANCELLED');
      return { status: 'CANCELLED', refundedPlays: plays.length };
    });
  }

  private async refreshTickets(c: Db, ticketIds: string[]) {
    for (const id of ticketIds) {
      const rows = (await c.query(`SELECT status, win FROM lottery.play WHERE ticket_id = $1`, [id])).rows;
      const status = aggregateTicketStatus(rows.map((r) => r.status as PlayStatus));
      const totalWin = rows.reduce((acc, r) => acc + BigInt(r.win), 0n);
      const upd = await c.query(
        `UPDATE lottery.ticket SET status = $2, total_win = $3 WHERE id = $1 AND status = 'OPEN' RETURNING player_id`,
        [id, status, totalWin.toString()],
      );
      // Las jugadas de otros sorteos del ticket también cambian de estado: siempre avisar.
      const playerId = upd.rows[0]?.player_id ?? (await c.query(`SELECT player_id FROM lottery.ticket WHERE id = $1`, [id])).rows[0].player_id;
      await publish(c, `player:${playerId}`, 'ticket', { id, status });
    }
  }
}
