import { Injectable } from '@nestjs/common';
import {
  applyMultiplier,
  CurrencyCode,
  encodeTicketCode,
  formatAmount,
  parseAmount,
  parseScaled100,
  PlayValidationError,
  potentialWin,
  ticketTotal,
  validatePlays,
  verifyDraw,
} from '@loteria/domain';
import { randomBytes, randomInt } from 'crypto';
import { AuditService } from '../audit/audit.service';
import { Db, DbService } from '../common/db.service';
import { BusinessError, pgErrorCode } from '../common/errors';
import { publish } from '../common/realtime';
import { localDate } from '../common/time';
import { assertPlayerCanPlay } from '../identity/player-status';
import { LedgerService } from '../wallet/ledger.service';
import { BuyTicketDto } from './lottery.dto';

/** Columnas públicas de un sorteo: la semilla y el resultado solo se revelan cuando ya no hay ventas. */
export const PUBLIC_DRAW_COLUMNS = `
  d.id, d.game_id, d.draw_at, d.close_at, d.status, d.is_extraordinary, d.seed_hash,
  CASE WHEN d.status IN ('RESULT_CONFIRMED', 'SETTLED', 'CANCELLED') THEN d.server_seed END AS server_seed,
  CASE WHEN d.status IN ('RESULT_CONFIRMED', 'SETTLED') THEN d.result_symbol_id END AS result_symbol_id,
  CASE WHEN d.status IN ('RESULT_CONFIRMED', 'SETTLED') THEN d.result_evidence END AS result_evidence,
  CASE WHEN d.status IN ('RESULT_CONFIRMED', 'SETTLED') THEN rs.number END AS result_number,
  CASE WHEN d.status IN ('RESULT_CONFIRMED', 'SETTLED') THEN rs.name END AS result_name,
  CASE WHEN d.status IN ('RESULT_CONFIRMED', 'SETTLED') THEN rs.emoji END AS result_emoji`;

function playErrorMessage(e: PlayValidationError): string {
  switch (e.code) {
    case 'EMPTY_TICKET':
      return 'El ticket no tiene jugadas';
    case 'TOO_MANY_PLAYS':
      return `Máximo ${e.max} jugadas por ticket`;
    case 'DUPLICATE_PLAY':
      return 'Hay jugadas repetidas (mismo sorteo y animal)';
    case 'PLAY_BELOW_MIN':
      return `La jugada #${e.index + 1} está por debajo del mínimo`;
    case 'PLAY_ABOVE_MAX':
      return `La jugada #${e.index + 1} supera el máximo por jugada`;
    case 'TICKET_ABOVE_MAX':
      return 'El ticket supera el monto máximo permitido';
  }
}

@Injectable()
export class LotteryService {
  constructor(
    private readonly db: DbService,
    private readonly ledger: LedgerService,
    private readonly audit: AuditService,
  ) {}

  // ───────────── Lectura pública ─────────────

  async listGames() {
    const games = await this.db.query(
      `SELECT id, code, name, result_source, payout_multiplier::text, close_minutes_before, cancel_window_minutes,
              timezone, license_ref
         FROM lottery.game WHERE status = 'ACTIVE' ORDER BY name`,
    );
    for (const g of games) {
      g.symbols = await this.db.query(
        `SELECT id, number, name, emoji, sort FROM lottery.symbol WHERE game_id = $1 ORDER BY sort`,
        [g.id],
      );
      g.limits = await this.db.query(
        `SELECT currency, min_play::text, max_play::text, max_ticket::text, max_liability_per_symbol::text
           FROM lottery.game_limit WHERE game_id = $1 ORDER BY currency`,
        [g.id],
      );
      g.schedule = await this.db.query(
        `SELECT DISTINCT to_char(draw_time, 'HH24:MI') AS time FROM lottery.schedule
          WHERE game_id = $1 AND active ORDER BY 1`,
        [g.id],
      );
    }
    return games;
  }

  async listDraws(gameId: string, date?: string) {
    const day = date ?? localDate();
    return this.db.query(
      `SELECT ${PUBLIC_DRAW_COLUMNS}, now() AS server_now
         FROM lottery.draw d
         JOIN lottery.game g ON g.id = d.game_id
         LEFT JOIN lottery.symbol rs ON rs.id = d.result_symbol_id
        WHERE d.game_id = $1 AND (d.draw_at AT TIME ZONE g.timezone)::date = $2::date
        ORDER BY d.draw_at`,
      [gameId, day],
    );
  }

  /** Verificación provably fair de un sorteo (Doc. Maestro §11.2). */
  async verifyDraw(drawId: string) {
    const d = await this.db.one(
      `SELECT ${PUBLIC_DRAW_COLUMNS}, g.result_source, g.name AS game_name
         FROM lottery.draw d JOIN lottery.game g ON g.id = d.game_id
         LEFT JOIN lottery.symbol rs ON rs.id = d.result_symbol_id
        WHERE d.id = $1`,
      [drawId],
    );
    if (!d) throw new BusinessError('NOT_FOUND', 'Sorteo no encontrado');
    if (!d.server_seed) {
      return { draw: d, revealed: false, message: 'La semilla se revela cuando el sorteo tiene resultado.' };
    }
    const symbols = await this.db.query(`SELECT id, number, name, emoji FROM lottery.symbol WHERE game_id = $1 ORDER BY sort`, [
      d.game_id,
    ]);
    const v = verifyDraw(d.server_seed, d.seed_hash, d.id, symbols.length);
    const computed = symbols[v.index];
    return {
      draw: d,
      revealed: true,
      algorithm: 'índice = HMAC-SHA256(server_seed, "<draw_id>:<contador>") → uint32 con muestreo por rechazo, mód. N símbolos ordenados',
      hashMatches: v.hashMatches,
      computedSymbol: computed,
      resultMatches: d.result_source === 'INTERNAL_RNG' ? computed?.id === d.result_symbol_id : null,
    };
  }

  // ───────────── Tickets ─────────────

  async buyTicket(playerId: string, dto: BuyTicketDto, idempotencyKey: string, ip: string) {
    try {
      return await this.db.tx((c) => this.buyTicketTx(c, playerId, dto, idempotencyKey, ip));
    } catch (err) {
      // Doble envío concurrente con la misma Idempotency-Key: devolver el ticket ya creado.
      if (pgErrorCode(err) === '23505' && String((err as { constraint?: string }).constraint).includes('idempotency')) {
        const t = await this.db.one(`SELECT id FROM lottery.ticket WHERE player_id = $1 AND idempotency_key = $2`, [
          playerId,
          idempotencyKey,
        ]);
        if (t) return this.ticketDetail(this.db.pool, t.id);
      }
      throw err;
    }
  }

  private async buyTicketTx(c: Db, playerId: string, dto: BuyTicketDto, idempotencyKey: string, ip: string) {
    await assertPlayerCanPlay(c, playerId);

    const existing = await c.query(`SELECT id FROM lottery.ticket WHERE player_id = $1 AND idempotency_key = $2`, [
      playerId,
      idempotencyKey,
    ]);
    if (existing.rows[0]) return this.ticketDetail(c, existing.rows[0].id);

    const currency = dto.currency as CurrencyCode;
    const gameRes = await c.query(
      `SELECT g.id, g.name, g.payout_multiplier::text AS multiplier, g.license_ref,
              l.min_play, l.max_play, l.max_ticket, l.max_liability_per_symbol
         FROM lottery.game g JOIN lottery.game_limit l ON l.game_id = g.id AND l.currency = $2
        WHERE g.id = $1 AND g.status = 'ACTIVE'`,
      [dto.gameId, currency],
    );
    const game = gameRes.rows[0];
    if (!game) throw new BusinessError('INVALID_INPUT', `Juego no disponible en ${currency}`);
    const multiplier = parseScaled100(game.multiplier);
    const cap = BigInt(game.max_liability_per_symbol);

    let plays;
    try {
      plays = dto.plays.map((p) => ({ drawId: p.drawId, symbolId: p.symbolId, amount: parseAmount(p.amount, currency) }));
    } catch (e) {
      throw new BusinessError('INVALID_INPUT', (e as Error).message);
    }
    const limitError = validatePlays(plays, {
      minPlay: BigInt(game.min_play),
      maxPlay: BigInt(game.max_play),
      maxTicket: BigInt(game.max_ticket),
    });
    if (limitError) {
      throw new BusinessError(limitError.code === 'DUPLICATE_PLAY' || limitError.code === 'EMPTY_TICKET' ? 'INVALID_INPUT' : 'LIMIT_EXCEEDED', playErrorMessage(limitError), {
        ...limitError,
      });
    }

    // Sorteos: deben estar abiertos según el reloj del servidor. FOR SHARE bloquea el cierre concurrente.
    const drawIds = [...new Set(plays.map((p) => p.drawId))].sort();
    const draws = await c.query(
      `SELECT id, status, close_at > now() AS selling FROM lottery.draw
        WHERE id = ANY($1::uuid[]) AND game_id = $2 ORDER BY id FOR SHARE`,
      [drawIds, dto.gameId],
    );
    if (draws.rows.length !== drawIds.length) throw new BusinessError('INVALID_INPUT', 'Sorteo inexistente para este juego');
    const closed = draws.rows.find((d) => d.status !== 'OPEN' || !d.selling);
    if (closed) throw new BusinessError('DRAW_CLOSED', 'Uno de los sorteos ya cerró la venta', { drawId: closed.id });

    const symbolIds = [...new Set(plays.map((p) => p.symbolId))];
    const symbols = await c.query(`SELECT id, name FROM lottery.symbol WHERE game_id = $1 AND id = ANY($2::uuid[])`, [
      dto.gameId,
      symbolIds,
    ]);
    if (symbols.rows.length !== symbolIds.length) throw new BusinessError('INVALID_INPUT', 'Animal inválido para este juego');
    const symbolName = new Map<string, string>(symbols.rows.map((s) => [s.id, s.name]));

    // Cupo por animal y sorteo (Doc. Maestro §9.7). Orden estable para evitar deadlocks.
    const sorted = [...plays].sort((a, b) => (a.drawId + a.symbolId).localeCompare(b.drawId + b.symbolId));
    for (const p of sorted) {
      const fits = applyMultiplier(p.amount, multiplier) <= cap;
      const res = fits
        ? await c.query(
            `INSERT INTO lottery.exposure AS x (draw_id, symbol_id, currency, total_amount) VALUES ($1, $2, $3, $4)
             ON CONFLICT (draw_id, symbol_id, currency)
             DO UPDATE SET total_amount = x.total_amount + EXCLUDED.total_amount
             WHERE (x.total_amount + EXCLUDED.total_amount) * $5 / 100 <= $6
             RETURNING total_amount`,
            [p.drawId, p.symbolId, currency, p.amount.toString(), multiplier.toString(), cap.toString()],
          )
        : { rows: [] };
      if (!res.rows[0]) {
        const cur = await c.query(
          `SELECT total_amount FROM lottery.exposure WHERE draw_id = $1 AND symbol_id = $2 AND currency = $3`,
          [p.drawId, p.symbolId, currency],
        );
        const staked = BigInt(cur.rows[0]?.total_amount ?? 0);
        const available = (cap * 100n) / multiplier - staked;
        throw new BusinessError(
          'LIMIT_EXCEEDED',
          `Cupo agotado para ${symbolName.get(p.symbolId)} en este sorteo. Disponible: ${formatAmount(available > 0n ? available : 0n, currency)} ${currency}`,
          { symbolId: p.symbolId, drawId: p.drawId, available: (available > 0n ? available : 0n).toString() },
        );
      }
    }

    const total = ticketTotal(plays);
    const maxWin = plays.reduce((acc, p) => acc + potentialWin(p.amount, multiplier), 0n);
    const code = encodeTicketCode(randomBytes(10));
    const verifyCode = randomInt(0, 1_000_000).toString().padStart(6, '0');

    const ticketRes = await c.query(
      `INSERT INTO lottery.ticket (code, verify_code, player_id, game_id, channel, currency, total, potential_win, idempotency_key)
       VALUES ($1, $2, $3, $4, 'WEB', $5, $6, $7, $8) RETURNING id`,
      [code, verifyCode, playerId, dto.gameId, currency, total.toString(), maxWin.toString(), idempotencyKey],
    );
    const ticketId: string = ticketRes.rows[0].id;
    await c.query(
      `INSERT INTO lottery.play (ticket_id, draw_id, symbol_id, amount, potential_win)
       SELECT $1, d, s, a, w FROM unnest($2::uuid[], $3::uuid[], $4::bigint[], $5::bigint[]) AS t(d, s, a, w)`,
      [
        ticketId,
        plays.map((p) => p.drawId),
        plays.map((p) => p.symbolId),
        plays.map((p) => p.amount.toString()),
        plays.map((p) => potentialWin(p.amount, multiplier).toString()),
      ],
    );

    // Dinero: PLAYER_CASH → BETS_IN_PLAY (Doc. Maestro §5.3)
    await this.ledger.post(c, {
      type: 'BET_PLACED',
      refProduct: 'LOTTERY',
      refId: ticketId,
      idempotencyKey: `lottery:ticket:${ticketId}`,
      createdBy: playerId,
      entries: [
        { accountId: await this.ledger.playerCash(c, playerId, currency), direction: 'D', amount: total },
        { accountId: await this.ledger.house(c, 'BETS_IN_PLAY', 'LOTTERY', currency), direction: 'C', amount: total },
      ],
    });

    await this.audit.log(c, {
      actorType: 'PLAYER',
      actorId: playerId,
      action: 'TICKET_SOLD',
      entity: 'lottery.ticket',
      entityId: ticketId,
      after: { code, currency, total, plays: plays.length },
      ip,
    });
    await publish(c, `player:${playerId}`, 'ticket', { id: ticketId, status: 'OPEN' });
    await publish(c, 'staff', 'exposure', { drawIds });
    return this.ticketDetail(c, ticketId);
  }

  /** Anulación por el jugador: solo dentro de la ventana y antes del cierre de todos sus sorteos (§9.6). */
  async cancelTicket(playerId: string, ticketId: string, ip: string) {
    return this.db.tx(async (c) => {
      const t = (
        await c.query(
          `SELECT t.*, now() <= t.sold_at + make_interval(mins => g.cancel_window_minutes) AS in_window
             FROM lottery.ticket t JOIN lottery.game g ON g.id = t.game_id
            WHERE t.id = $1 AND t.player_id = $2 FOR UPDATE OF t`,
          [ticketId, playerId],
        )
      ).rows[0];
      if (!t) throw new BusinessError('NOT_FOUND', 'Ticket no encontrado');
      if (t.status !== 'OPEN') throw new BusinessError('INVALID_STATE', 'El ticket ya no se puede anular');
      if (!t.in_window) throw new BusinessError('CANCEL_WINDOW_EXPIRED', 'Pasó el tiempo permitido para anular');

      const draws = await c.query(
        `SELECT d.id, d.status, d.close_at > now() AS selling FROM lottery.draw d
          WHERE d.id IN (SELECT draw_id FROM lottery.play WHERE ticket_id = $1) ORDER BY d.id FOR SHARE`,
        [ticketId],
      );
      if (draws.rows.some((d) => d.status !== 'OPEN' || !d.selling)) {
        throw new BusinessError('DRAW_CLOSED', 'Un sorteo del ticket ya cerró; no se puede anular');
      }

      const plays = await c.query(`UPDATE lottery.play SET status = 'VOID', settled_at = now() WHERE ticket_id = $1 RETURNING *`, [
        ticketId,
      ]);
      for (const p of plays.rows) {
        await c.query(
          `UPDATE lottery.exposure SET total_amount = total_amount - $4 WHERE draw_id = $1 AND symbol_id = $2 AND currency = $3`,
          [p.draw_id, p.symbol_id, t.currency, p.amount],
        );
      }
      await c.query(`UPDATE lottery.ticket SET status = 'CANCELLED', cancelled_at = now(), cancel_reason = $2 WHERE id = $1`, [
        ticketId,
        'Anulado por el jugador',
      ]);
      const total = BigInt(t.total);
      await this.ledger.post(c, {
        type: 'BET_CANCELLED',
        refProduct: 'LOTTERY',
        refId: ticketId,
        idempotencyKey: `lottery:ticket-cancel:${ticketId}`,
        createdBy: playerId,
        entries: [
          { accountId: await this.ledger.house(c, 'BETS_IN_PLAY', 'LOTTERY', t.currency), direction: 'D', amount: total },
          { accountId: await this.ledger.playerCash(c, playerId, t.currency), direction: 'C', amount: total },
        ],
      });
      await this.audit.log(c, {
        actorType: 'PLAYER',
        actorId: playerId,
        action: 'TICKET_CANCELLED',
        entity: 'lottery.ticket',
        entityId: ticketId,
        before: { status: 'OPEN' },
        after: { status: 'CANCELLED' },
        ip,
      });
      await publish(c, `player:${playerId}`, 'ticket', { id: ticketId, status: 'CANCELLED' });
      await publish(c, 'staff', 'exposure', { drawIds: draws.rows.map((d) => d.id) });
      return this.ticketDetail(c, ticketId);
    });
  }

  async myTickets(playerId: string, limit = 30) {
    const ids = await this.db.query(`SELECT id FROM lottery.ticket WHERE player_id = $1 ORDER BY sold_at DESC LIMIT $2`, [
      playerId,
      limit,
    ]);
    return Promise.all(ids.map((r) => this.ticketDetail(this.db.pool, r.id)));
  }

  async ticketByCode(code: string, opts: { playerId?: string }) {
    const t = await this.db.one(
      `SELECT id FROM lottery.ticket WHERE code = $1 AND ($2::uuid IS NULL OR player_id = $2)`,
      [code.toUpperCase(), opts.playerId ?? null],
    );
    if (!t) throw new BusinessError('NOT_FOUND', 'Ticket no encontrado');
    return this.ticketDetail(this.db.pool, t.id);
  }

  async ticketDetail(db: Db, ticketId: string) {
    const t = (
      await db.query(
        `SELECT t.id, t.code, t.verify_code, t.player_id, t.game_id, g.name AS game_name, g.license_ref, t.channel,
                t.currency, t.total::text, t.potential_win::text, t.total_win::text, t.status, t.sold_at,
                t.cancelled_at, t.cancel_reason,
                t.status = 'OPEN' AND now() <= t.sold_at + make_interval(mins => g.cancel_window_minutes) AS cancellable
           FROM lottery.ticket t JOIN lottery.game g ON g.id = t.game_id WHERE t.id = $1`,
        [ticketId],
      )
    ).rows[0];
    t.plays = (
      await db.query(
        `SELECT p.id, p.draw_id, d.draw_at, d.status AS draw_status, p.symbol_id, s.number, s.name, s.emoji,
                p.amount::text, p.potential_win::text, p.status, p.win::text
           FROM lottery.play p
           JOIN lottery.draw d ON d.id = p.draw_id
           JOIN lottery.symbol s ON s.id = p.symbol_id
          WHERE p.ticket_id = $1 ORDER BY d.draw_at, s.sort`,
        [ticketId],
      )
    ).rows;
    return t;
  }
}
