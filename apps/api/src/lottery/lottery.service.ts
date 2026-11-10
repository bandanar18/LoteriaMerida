import { Injectable } from '@nestjs/common';
import {
  fairSample,
  kinoSize,
  normalizeKinoSelection,
  TriplePayouts,
  TerminalPayouts,
  playedKey,
  applyMultiplier,
  checkModality,
  CurrencyCode,
  encodeTicketCode,
  formatAmount,
  ModalityCode,
  ModalityRule,
  parseAmount,
  PlayValidationError,
  potentialWin,
  hashSeed,
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
  (d.auto_rng OR g.result_source = 'INTERNAL_RNG') AS is_automatic,
  CASE WHEN d.status IN ('RESULT_CONFIRMED', 'SETTLED', 'CANCELLED') THEN d.server_seed END AS server_seed,
  CASE WHEN d.status IN ('RESULT_CONFIRMED', 'SETTLED') THEN d.result_symbol_id END AS result_symbol_id,
  CASE WHEN d.status IN ('RESULT_CONFIRMED', 'SETTLED') THEN d.result_evidence END AS result_evidence,
  CASE WHEN d.status IN ('RESULT_CONFIRMED', 'SETTLED') THEN rs.number END AS result_number,
  CASE WHEN d.status IN ('RESULT_CONFIRMED', 'SETTLED') THEN rs.name END AS result_name,
  CASE WHEN d.status IN ('RESULT_CONFIRMED', 'SETTLED') THEN rs.emoji END AS result_emoji,
  CASE WHEN d.status IN ('RESULT_CONFIRMED', 'SETTLED') THEN d.result_numbers END AS result_numbers,
  CASE WHEN pre.id IS NOT NULL THEN d.proposed_numbers END AS preliminary_numbers,
  -- Resultado preliminar (MER-05 §3): visible solo si el juego lo publica y aún no hay acta confirmada.
  pre.number AS preliminary_number, pre.name AS preliminary_name, pre.emoji AS preliminary_emoji,
  (SELECT i.public_notice FROM lottery.draw_incident i
    WHERE i.draw_id = d.id AND i.public_notice IS NOT NULL ORDER BY i.occurred_at DESC LIMIT 1) AS incident_notice`;

/** Une el animal propuesto solo cuando corresponde publicarlo como preliminar. Requiere alias d (draw). */
export const PRELIMINARY_JOIN = `
  LEFT JOIN lottery.symbol pre ON pre.id = d.proposed_symbol_id AND d.status = 'RESULT_PENDING'
   AND (SELECT pg.publish_preliminary FROM lottery.game pg WHERE pg.id = d.game_id)`;

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

  async listGames(includeInactive = false) {
    const games = await this.db.query(
      `SELECT id, code, name, result_source, payout_multiplier::text, close_minutes_before, cancel_window_minutes,
              timezone, license_ref, rules_version, is_demo, requires_record, publish_preliminary, prize_expiry_days, board, draw_count, status
         FROM lottery.game WHERE ($1::boolean OR status = 'ACTIVE') ORDER BY display_order, name`,
      [includeInactive],
    );
    for (const g of games) {
      g.modalities = await this.db.query(
        `SELECT id, code, name, min_selections, max_selections, factor_x100::text, status, description
           FROM lottery.modality WHERE game_id = $1 AND status <> 'INACTIVE' ORDER BY sort`,
        [g.id],
      );
      g.symbols = await this.db.query(`SELECT id, number, name, emoji, sort FROM lottery.symbol WHERE game_id = $1 ORDER BY sort`, [g.id]);
      g.limits = await this.db.query(
        `SELECT currency, min_play::text, max_play::text, max_ticket::text, max_liability_per_symbol::text, max_player_per_draw::text
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

  /**
   * Animales agotados en un sorteo: su cupo restante (tope de pago ÷ factor − vendido) no alcanza la jugada mínima.
   * Solo se publica el estado, no los montos vendidos.
   */
  async drawAvailability(drawId: string, currency: CurrencyCode) {
    const g = await this.db.one(
      `SELECT g.board, l.min_play::text, l.max_liability_per_symbol::text AS cap, m.factor_x100::text AS factor
         FROM lottery.draw d JOIN lottery.game g ON g.id = d.game_id
         JOIN lottery.game_limit l ON l.game_id = g.id AND l.currency = $2
         LEFT JOIN lottery.modality m ON m.game_id = g.id AND m.code = 'EXACT'
        WHERE d.id = $1`,
      [drawId, currency],
    );
    if (g?.board === 'KINO') return { drawId, currency, soldOut: [] };
    if (g?.board === 'DIGITS3' || g?.board === 'DIGITS2') {
      const width = g.board === 'DIGITS2' ? 2 : 3;
      const tp = await this.triplePayouts(this.db.pool, drawId, currency, g.board);
      const room = BigInt(g.cap) - potentialWin(BigInt(g.min_play), BigInt(g.factor));
      const full: string[] = [];
      for (let i = 0; i < 10 ** width; i++) {
        const n = String(i).padStart(width, '0');
        if (tp.payout(n) > room) full.push(n);
      }
      if (!full.length) return { drawId, currency, soldOut: [] };
      const ids = await this.db.query(
        `SELECT s.id FROM lottery.symbol s JOIN lottery.draw d ON d.game_id = s.game_id WHERE d.id = $1 AND s.number = ANY($2::text[])`,
        [drawId, full],
      );
      return { drawId, currency, soldOut: ids.map((r) => r.id) };
    }
    const rows = await this.db.query(
      `SELECT s.id AS symbol_id
         FROM lottery.draw d
         JOIN lottery.game_limit l ON l.game_id = d.game_id AND l.currency = $2
         JOIN lottery.modality m ON m.game_id = d.game_id AND m.code = 'EXACT'
         JOIN lottery.exposure x ON x.draw_id = d.id AND x.currency = l.currency
         JOIN lottery.symbol s ON s.id = x.symbol_id
        WHERE d.id = $1 AND l.max_liability_per_symbol * 100 / m.factor_x100 - x.total_amount < l.min_play`,
      [drawId, currency],
    );
    return { drawId, currency, soldOut: rows.map((r) => r.symbol_id) };
  }

  /** Premios potenciales abiertos de un sorteo de tres cifras, agregados por modalidad y valor jugado. */
  private async triplePayouts(c: Db, drawId: string, currency: string, board = 'DIGITS3') {
    const rows = (
      await c.query(
        `SELECT m.code, s.number, sum(p.potential_win)::text AS w
           FROM lottery.play p JOIN lottery.ticket t ON t.id = p.ticket_id
           JOIN lottery.modality m ON m.id = p.modality_id JOIN lottery.symbol s ON s.id = p.symbol_id
          WHERE p.draw_id = $1 AND t.currency = $2 AND p.status = 'OPEN'
          GROUP BY m.code, s.number`,
        [drawId, currency],
      )
    ).rows as { code: ModalityCode; number: string; w: string }[];
    // Terminal Nevado: directo paga con su número y aproximación con los vecinos.
    const tp = board === 'DIGITS2' ? new TerminalPayouts() : new TriplePayouts();
    for (const r of rows) tp.add(r.code, r.number, BigInt(r.w));
    return tp;
  }

  /**
   * Triple Andino: una jugada de terminal toca 10 resultados y una de última cifra 100. El tope de pago es por resultado:
   * para cada número posible, Σ premios de triple + terminal + última cifra que pagaría ≤ tope. Un candado por sorteo y moneda
   * serializa las ventas de ese sorteo.
   */
  private async checkTripleCap(
    c: any,
    plays: { drawId: string; symbolId: string; amount: bigint; factor: bigint; modalityCode: ModalityCode; modalityName: string }[],
    currency: string,
    cap: bigint,
    symbolNumber: Map<string, string>,
    board = 'DIGITS3',
  ) {
    for (const drawId of [...new Set(plays.map((p) => p.drawId))].sort()) {
      await c.query(`SELECT pg_advisory_xact_lock(hashtext('lottery-triple-cap:' || $1 || ':' || $2))`, [drawId, currency]);
      const tp = await this.triplePayouts(c, drawId, currency, board);
      for (const p of plays.filter((x) => x.drawId === drawId)) {
        const number = symbolNumber.get(p.symbolId)!;
        const results = board === 'DIGITS2' ? TerminalPayouts.affected(p.modalityCode, number) : TriplePayouts.affected(p.modalityCode, number);
        const worstBefore = results.reduce((m, r) => (tp.payout(r) > m ? tp.payout(r) : m), 0n);
        const win = potentialWin(p.amount, p.factor);
        if (worstBefore + win > cap) {
          const room = cap > worstBefore ? ((cap - worstBefore) * 100n) / p.factor : 0n;
          throw new BusinessError(
            'LIMIT_EXCEEDED',
            `Cupo agotado para ${p.modalityName} ${playedKey(p.modalityCode, number)} en este sorteo. Disponible: ${formatAmount(room, currency as CurrencyCode)} ${currency}`,
            { symbolId: p.symbolId, drawId, modality: p.modalityCode, available: room.toString() },
          );
        }
        tp.add(p.modalityCode, number, win);
      }
    }
  }

  /**
   * Kino: tope de pago por combinación jugada (misma modalidad y mismos números) en el sorteo.
   * En una extracción de 7 caben como mucho 21 combinaciones de 5, 7 de 6 y 1 de 7, así el peor resultado queda acotado.
   */
  private async checkKinoCap(
    c: any,
    plays: { drawId: string; amount: bigint; factor: bigint; modalityId: string; modalityName: string; selection?: number[] }[],
    currency: string,
    cap: bigint,
  ) {
    for (const drawId of [...new Set(plays.map((p) => p.drawId))].sort()) {
      await c.query(`SELECT pg_advisory_xact_lock(hashtext('lottery-kino-cap:' || $1 || ':' || $2))`, [drawId, currency]);
      for (const p of plays.filter((x) => x.drawId === drawId)) {
        const sel = `{${p.selection!.join(',')}}`;
        const { rows: [r] } = await c.query(
          `SELECT coalesce(sum(p.potential_win), 0)::text AS w FROM lottery.play p JOIN lottery.ticket t ON t.id = p.ticket_id
            WHERE p.draw_id = $1 AND t.currency = $2 AND p.status = 'OPEN' AND p.modality_id = $3 AND p.selection = $4::smallint[]`,
          [drawId, currency, p.modalityId, sel],
        );
        const win = potentialWin(p.amount, p.factor);
        if (BigInt(r.w) + win > cap) {
          const room = cap > BigInt(r.w) ? ((cap - BigInt(r.w)) * 100n) / p.factor : 0n;
          throw new BusinessError(
            'LIMIT_EXCEEDED',
            `Cupo agotado para ${p.modalityName} ${p.selection!.map((n) => String(n).padStart(2, '0')).join('-')} en este sorteo. Disponible: ${formatAmount(room, currency as CurrencyCode)} ${currency}`,
            { drawId, available: room.toString() },
          );
        }
      }
    }
  }

  async listDraws(gameId: string, date?: string) {
    const day = date ?? localDate();
    return this.db.query(
      `SELECT ${PUBLIC_DRAW_COLUMNS}, now() AS server_now
         FROM lottery.draw d
         JOIN lottery.game g ON g.id = d.game_id
         LEFT JOIN lottery.symbol rs ON rs.id = d.result_symbol_id
         ${PRELIMINARY_JOIN}
        WHERE d.game_id = $1 AND (d.draw_at AT TIME ZONE g.timezone)::date = $2::date AND d.sim_player_id IS NULL AND d.archived_at IS NULL
        ORDER BY d.draw_at`,
      [gameId, day],
    );
  }

  /** Verificación provably fair de un sorteo (Doc. Maestro §11.2). */
  async verifyDraw(drawId: string) {
    const d = await this.db.one(
      `SELECT ${PUBLIC_DRAW_COLUMNS}, g.result_source, g.name AS game_name, g.board, g.draw_count
         FROM lottery.draw d JOIN lottery.game g ON g.id = d.game_id
         LEFT JOIN lottery.symbol rs ON rs.id = d.result_symbol_id
         ${PRELIMINARY_JOIN}
        WHERE d.id = $1`,
      [drawId],
    );
    if (!d) throw new BusinessError('NOT_FOUND', 'Sorteo no encontrado');
    if (!d.server_seed) {
      return {
        draw: d,
        revealed: false,
        message: 'La semilla se revela cuando el sorteo tiene resultado.',
      };
    }
    const all = await this.db.query(`SELECT id, number, name, emoji FROM lottery.symbol WHERE game_id = $1 ORDER BY sort`, [d.game_id]);
    // N = cantidad de animales que había cuando se sorteó (queda en rng_call); el catálogo solo crece al final,
    // así un sorteo de cuando eran 37 se verifica con los 37 primeros aunque hoy sean 70.
    const rng = await this.db.one(
      `SELECT range_n FROM rng.rng_call WHERE consumer = 'lottery.draw' AND ref_id = $1 ORDER BY created_at LIMIT 1`,
      [d.id],
    );
    const n = rng?.range_n ?? all.length;
    const symbols = all.slice(0, n);
    if (d.board === 'KINO') {
      const numbers = fairSample(d.server_seed, d.id, n, d.draw_count).map((i) => Number(symbols[i].number));
      const official: number[] | null = d.result_numbers;
      return {
        draw: d,
        revealed: true,
        algorithm: `bola i = HMAC-SHA256(server_seed, "<draw_id>#<i>:<contador>") → uint32 con muestreo por rechazo, entre los ${n} números que quedan (sin reposición)`,
        symbols: n,
        hashMatches: hashSeed(d.server_seed) === d.seed_hash,
        computedNumbers: numbers,
        resultMatches: rng ? !!official && official.length === numbers.length && official.every((x, i) => x === numbers[i]) : null,
      };
    }
    const v = verifyDraw(d.server_seed, d.seed_hash, d.id, n);
    const computed = symbols[v.index];
    return {
      draw: d,
      revealed: true,
      algorithm: `índice = HMAC-SHA256(server_seed, "<draw_id>:<contador>") → uint32 con muestreo por rechazo, mód. ${n} animales ordenados`,
      symbols: n,
      hashMatches: v.hashMatches,
      computedSymbol: computed,
      // Si el resultado salió del RNG (juego RNG, sorteo automático o simulación) debe coincidir con el cálculo.
      resultMatches: rng || d.result_source === 'INTERNAL_RNG' ? computed?.id === d.result_symbol_id : null,
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
      `SELECT g.id, g.code, g.name, g.license_ref, g.rules_version, g.is_demo, g.board, g.draw_count,
              l.min_play, l.max_play, l.max_ticket, l.max_liability_per_symbol, l.max_player_per_draw
         FROM lottery.game g JOIN lottery.game_limit l ON l.game_id = g.id AND l.currency = $2
        WHERE g.id = $1 AND g.status = 'ACTIVE' FOR SHARE OF g`,
      [dto.gameId, currency],
    );
    const game = gameRes.rows[0];
    if (!game) throw new BusinessError('INVALID_INPUT', `Juego no disponible en ${currency}`);
    const cap = BigInt(game.max_liability_per_symbol);

    // Modalidad de cada jugada (MER-05 §4): solo se venden las activas. Cada jugada lleva un animal.
    const modalities = new Map<
      string,
      {
        id: string;
        code: ModalityCode;
        name: string;
        factor: bigint;
        rule: ModalityRule;
      }
    >(
      (
        await c.query(
          `SELECT id, code, name, min_selections, max_selections, factor_x100, status FROM lottery.modality WHERE game_id = $1`,
          [dto.gameId],
        )
      ).rows.map((m) => [
        m.code,
        {
          id: m.id,
          code: m.code,
          name: m.name,
          factor: BigInt(m.factor_x100),
          rule: {
            code: m.code,
            status: m.status,
            minSelections: m.min_selections,
            maxSelections: m.max_selections,
          },
        },
      ]),
    );

    // Kino: el símbolo de la jugada es el número menor de la selección.
    const kino = game.board === 'KINO';
    const kinoSymbol = kino
      ? new Map<number, string>(
          (await c.query(`SELECT id, number FROM lottery.symbol WHERE game_id = $1`, [dto.gameId])).rows.map((s) => [Number(s.number), s.id]),
        )
      : null;
    let plays;
    try {
      plays = dto.plays.map((p) => {
        const code = (p.modality ?? 'EXACT') as ModalityCode;
        const m = modalities.get(code);
        if (!m) throw new BusinessError('INVALID_INPUT', `Modalidad ${code} no existe en este juego`);
        let selection: number[] | undefined;
        let symbolId = p.symbolId;
        if (kino) {
          if (kinoSize(code) === null) throw new BusinessError('INVALID_INPUT', `La modalidad ${m.name} no es de Kino`);
          const norm = normalizeKinoSelection(code, p.numbers ?? []);
          if (!norm.ok) throw new BusinessError('INVALID_INPUT', norm.error);
          selection = norm.selection;
          symbolId = kinoSymbol!.get(selection[0]);
        } else if (!symbolId || p.numbers) {
          throw new BusinessError('INVALID_INPUT', 'Cada jugada lleva un símbolo');
        }
        const err = checkModality(m.rule, selection?.length ?? 1);
        if (err?.code === 'MODALITY_NOT_ACTIVE') {
          throw new BusinessError('MODALITY_NOT_ACTIVE', `La modalidad ${m.name} está pendiente de aprobación y no se puede jugar`, {
            modality: code,
          });
        }
        if (err) throw new BusinessError('INVALID_INPUT', `La modalidad ${m.name} requiere otra cantidad de animales`);
        return {
          drawId: p.drawId,
          symbolId: symbolId!,
          selection,
          amount: parseAmount(p.amount, currency),
          modalityId: m.id,
          modalityCode: m.code,
          modalityName: m.name,
          factor: m.factor,
        };
      });
    } catch (e) {
      if (e instanceof BusinessError) throw e;
      throw new BusinessError('INVALID_INPUT', (e as Error).message);
    }
    const limitError = validatePlays(plays, {
      minPlay: BigInt(game.min_play),
      maxPlay: BigInt(game.max_play),
      maxTicket: BigInt(game.max_ticket),
    });
    if (limitError) {
      throw new BusinessError(
        limitError.code === 'DUPLICATE_PLAY' || limitError.code === 'EMPTY_TICKET' ? 'INVALID_INPUT' : 'LIMIT_EXCEEDED',
        playErrorMessage(limitError),
        {
          ...limitError,
        },
      );
    }

    // Sorteos: deben estar abiertos según el reloj del servidor. FOR SHARE bloquea el cierre concurrente.
    const drawIds = [...new Set(plays.map((p) => p.drawId))].sort();
    const draws = await c.query(
      `SELECT id, status, close_at > now() AS selling, sim_player_id FROM lottery.draw
        WHERE id = ANY($1::uuid[]) AND game_id = $2 ORDER BY id FOR SHARE`,
      [drawIds, dto.gameId],
    );
    if (draws.rows.length !== drawIds.length) throw new BusinessError('INVALID_INPUT', 'Sorteo inexistente para este juego');
    const closed = draws.rows.find((d) => d.status !== 'OPEN' || !d.selling);
    if (closed) throw new BusinessError('DRAW_CLOSED', 'Uno de los sorteos ya cerró la venta', { drawId: closed.id });
    // Simulación: un sorteo privado solo lo juega su dueño, y un ticket no mezcla simulación con sorteos reales.
    const simDraws = draws.rows.filter((d) => d.sim_player_id !== null);
    if (simDraws.some((d) => d.sim_player_id !== playerId)) throw new BusinessError('INVALID_INPUT', 'Sorteo inexistente para este juego');
    if (simDraws.length > 0 && simDraws.length !== draws.rows.length) {
      throw new BusinessError('INVALID_INPUT', 'Un ticket no puede mezclar sorteos de simulación con sorteos reales');
    }
    const isSimulation = simDraws.length > 0;

    // Tope por jugador y sorteo (MER-05 v1.1): suma de lo que ya tiene abierto + lo nuevo.
    // El candado por jugador serializa compras concurrentes del mismo jugador.
    const perDrawCap = game.max_player_per_draw === null ? null : BigInt(game.max_player_per_draw);
    if (perDrawCap !== null) {
      await c.query(`SELECT pg_advisory_xact_lock(hashtext('lottery-player:' || $1))`, [playerId]);
      const already = new Map<string, bigint>(
        (
          await c.query(
            `SELECT p.draw_id, sum(p.amount)::text AS staked
             FROM lottery.play p JOIN lottery.ticket t ON t.id = p.ticket_id
            WHERE t.player_id = $1 AND t.currency = $2 AND p.draw_id = ANY($3::uuid[]) AND p.status = 'OPEN'
            GROUP BY p.draw_id`,
            [playerId, currency, drawIds],
          )
        ).rows.map((r) => [r.draw_id, BigInt(r.staked)]),
      );
      for (const drawId of drawIds) {
        const adding = plays.filter((p) => p.drawId === drawId).reduce((a, p) => a + p.amount, 0n);
        const prev = already.get(drawId) ?? 0n;
        if (prev + adding > perDrawCap) {
          const left = perDrawCap > prev ? perDrawCap - prev : 0n;
          throw new BusinessError(
            'LIMIT_EXCEEDED',
            `Superas el máximo por jugador en este sorteo (${formatAmount(perDrawCap, currency)} ${currency}). Te queda: ${formatAmount(left, currency)} ${currency}`,
            { drawId, available: left.toString() },
          );
        }
      }
    }

    const symbolIds = [...new Set(plays.map((p) => p.symbolId))];
    const symbols = await c.query(`SELECT id, number, name FROM lottery.symbol WHERE game_id = $1 AND id = ANY($2::uuid[])`, [
      dto.gameId,
      symbolIds,
    ]);
    if (symbols.rows.length !== symbolIds.length) throw new BusinessError('INVALID_INPUT', 'Selección inválida para este juego');
    const symbolName = new Map<string, string>(symbols.rows.map((s) => [s.id, s.name]));
    const symbolNumber = new Map<string, string>(symbols.rows.map((s) => [s.id, s.number]));

    if (game.board === 'DIGITS3' || game.board === 'DIGITS2') {
      await this.checkTripleCap(c, plays, currency, cap, symbolNumber, game.board);
    } else if (kino) {
      await this.checkKinoCap(c, plays, currency, cap);
    } else {

    // Cupo por animal y sorteo (Doc. Maestro §9.7). Orden estable para evitar deadlocks.
    const sorted = [...plays].sort((a, b) => (a.drawId + a.symbolId).localeCompare(b.drawId + b.symbolId));
    // Con una sola modalidad activa por animal, pasivo = Σ apostado × factor de esa modalidad.
    for (const p of sorted) {
      const multiplier = p.factor;
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
        const cur = await c.query(`SELECT total_amount FROM lottery.exposure WHERE draw_id = $1 AND symbol_id = $2 AND currency = $3`, [
          p.drawId,
          p.symbolId,
          currency,
        ]);
        const staked = BigInt(cur.rows[0]?.total_amount ?? 0);
        const available = (cap * 100n) / multiplier - staked;
        throw new BusinessError(
          'LIMIT_EXCEEDED',
          `Cupo agotado para ${symbolName.get(p.symbolId)} en este sorteo. Disponible: ${formatAmount(available > 0n ? available : 0n, currency)} ${currency}`,
          {
            symbolId: p.symbolId,
            drawId: p.drawId,
            available: (available > 0n ? available : 0n).toString(),
          },
        );
      }
    }
    }

    const total = ticketTotal(plays);
    const maxWin = plays.reduce((acc, p) => acc + potentialWin(p.amount, p.factor), 0n);
    // Juegos sin autorización: el código lo marca como demostración (MER-05 §8).
    const code = (game.is_demo ? `DEMO-${String(game.code).replace(/[^A-Z0-9]/g, '')}-` : '') + encodeTicketCode(randomBytes(10));
    const verifyCode = randomInt(0, 1_000_000).toString().padStart(6, '0');

    const ticketRes = await c.query(
      `INSERT INTO lottery.ticket (code, verify_code, player_id, game_id, channel, currency, total, potential_win, idempotency_key, rules_version, is_simulation)
       VALUES ($1, $2, $3, $4, 'WEB', $5, $6, $7, $8, $9, $10) RETURNING id`,
      [code, verifyCode, playerId, dto.gameId, currency, total.toString(), maxWin.toString(), idempotencyKey, game.rules_version, isSimulation],
    );
    const ticketId: string = ticketRes.rows[0].id;
    // El factor queda congelado en la jugada: un cambio posterior de tabla no altera tickets vendidos.
    await c.query(
      `INSERT INTO lottery.play (ticket_id, draw_id, symbol_id, amount, potential_win, modality_id, factor_x100, selection)
       SELECT $1, d, s, a, w, m, f, nullif(sel, '')::smallint[]
         FROM unnest($2::uuid[], $3::uuid[], $4::bigint[], $5::bigint[], $6::uuid[], $7::bigint[], $8::text[]) AS t(d, s, a, w, m, f, sel)`,
      [
        ticketId,
        plays.map((p) => p.drawId),
        plays.map((p) => p.symbolId),
        plays.map((p) => p.amount.toString()),
        plays.map((p) => potentialWin(p.amount, p.factor).toString()),
        plays.map((p) => p.modalityId),
        plays.map((p) => p.factor.toString()),
        plays.map((p) => (p.selection ? `{${p.selection.join(',')}}` : '')),
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
        {
          accountId: await this.ledger.playerCash(c, playerId, currency),
          direction: 'D',
          amount: total,
        },
        {
          accountId: await this.ledger.house(c, 'BETS_IN_PLAY', 'LOTTERY', currency),
          direction: 'C',
          amount: total,
        },
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
    await publish(c, `player:${playerId}`, 'ticket', {
      id: ticketId,
      status: 'OPEN',
    });
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
          {
            accountId: await this.ledger.house(c, 'BETS_IN_PLAY', 'LOTTERY', t.currency),
            direction: 'D',
            amount: total,
          },
          {
            accountId: await this.ledger.playerCash(c, playerId, t.currency),
            direction: 'C',
            amount: total,
          },
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
      await publish(c, `player:${playerId}`, 'ticket', {
        id: ticketId,
        status: 'CANCELLED',
      });
      await publish(c, 'staff', 'exposure', {
        drawIds: draws.rows.map((d) => d.id),
      });
      return this.ticketDetail(c, ticketId);
    });
  }

  async myTickets(playerId: string, limit = 30) {
    const ids = await this.db.query(`SELECT id FROM lottery.ticket WHERE player_id = $1 ORDER BY sold_at DESC LIMIT $2`, [playerId, limit]);
    return Promise.all(ids.map((r) => this.ticketDetail(this.db.pool, r.id)));
  }

  async ticketByCode(code: string, opts: { playerId?: string }) {
    const t = await this.db.one(`SELECT id FROM lottery.ticket WHERE code = $1 AND ($2::uuid IS NULL OR player_id = $2)`, [
      code.toUpperCase(),
      opts.playerId ?? null,
    ]);
    if (!t) throw new BusinessError('NOT_FOUND', 'Ticket no encontrado');
    return this.ticketDetail(this.db.pool, t.id);
  }

  async ticketDetail(db: Db, ticketId: string) {
    const t = (
      await db.query(
        `SELECT t.id, t.code, t.verify_code, t.player_id, t.game_id, g.name AS game_name, g.code AS game_code, g.is_demo,
                t.rules_version, t.is_simulation, g.license_ref, t.channel,
                t.currency, t.total::text, t.potential_win::text, t.total_win::text, t.status, t.sold_at,
                t.cancelled_at, t.cancel_reason,
                t.status = 'OPEN' AND now() <= t.sold_at + make_interval(mins => g.cancel_window_minutes) AS cancellable
           FROM lottery.ticket t JOIN lottery.game g ON g.id = t.game_id WHERE t.id = $1`,
        [ticketId],
      )
    ).rows[0];
    t.plays = (
      await db.query(
        `SELECT p.id, p.draw_id, d.draw_at, d.status AS draw_status, p.symbol_id, s.number, s.name, s.emoji, p.selection,
                CASE WHEN d.status IN ('RESULT_CONFIRMED', 'SETTLED') THEN d.result_numbers END AS result_numbers,
                p.amount::text, p.potential_win::text, p.status, p.win::text,
                m.code AS modality, m.name AS modality_name, p.factor_x100::text
           FROM lottery.play p
           JOIN lottery.modality m ON m.id = p.modality_id
           JOIN lottery.draw d ON d.id = p.draw_id
           JOIN lottery.symbol s ON s.id = p.symbol_id
          WHERE p.ticket_id = $1 ORDER BY d.draw_at, s.sort`,
        [ticketId],
      )
    ).rows;
    return t;
  }
}
