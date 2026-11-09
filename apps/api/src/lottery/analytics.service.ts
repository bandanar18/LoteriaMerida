import { Injectable } from '@nestjs/common';
import { fairIndex, kinoWinProbability } from '@loteria/domain';
import { createHash, randomInt } from 'crypto';
import { DbService } from '../common/db.service';
import { BusinessError } from '../common/errors';
import { localDate, OPERATING_TZ } from '../common/time';
import { config } from '../config';

const DEMO_BAND_SEED = createHash('sha256').update('market-band-demo-v1').digest('hex');
const BAND_SIZE = 10;
const NEXT_BAND_DRAW = `
  SELECT d.id, d.draw_at, least(d.close_at, now()) AS cutoff, b.symbol_ids
    FROM lottery.draw d
    JOIN lottery.game g ON g.id = d.game_id
    LEFT JOIN lottery.market_band b ON b.draw_id = d.id
   WHERE g.id = $1 AND g.status = 'ACTIVE'
     AND d.sim_player_id IS NULL AND d.draw_at > now() AND d.status IN ('SCHEDULED', 'OPEN', 'CLOSED')
   ORDER BY d.draw_at LIMIT 1`;

export interface TicketsQuery {
  gameId?: string;
  currency?: string;
  from?: string;
  to?: string;
  status?: string;
  q?: string;
  drawId?: string;
  includeSim?: boolean;
  page?: number;
  size?: number;
}

/**
 * Analítica histórica del backoffice («Mercado»): lo que YA pasó.
 *
 * - Frecuencia de cada animal en los sorteos liquidados del período, frente a lo esperado con 1/N.
 *   Es una auditoría del azar (prueba χ²), no un pronóstico: cada sorteo es independiente.
 * - Ganancia (GGR = vendido − pagado) y margen real de cada sorteo, por día (velas de la ganancia acumulada) y por hora.
 * - Libro de tickets con filtros.
 * Excluye sorteos privados del simulador y tickets de simulación.
 */
@Injectable()
export class AnalyticsService {
  constructor(private readonly db: DbService) {}

  /**
   * Último sorteo resuelto con OTRA cantidad de animales (p. ej. 37 antes de ampliar a 70). La frecuencia, la prueba χ²
   * y la banda solo cuentan sorteos posteriores: mezclar catálogos distintos falsearía lo esperado (1/N).
   */
  private async eraStart(gameId: string, n: number): Promise<string | null> {
    const r = await this.db.one(
      `SELECT max(d.draw_at) AS at FROM lottery.draw d
         JOIN rng.rng_call c ON c.consumer = 'lottery.draw' AND c.ref_id = d.id::text
        WHERE d.game_id = $1 AND d.archived_at IS NULL AND c.range_n <> $2`,
      [gameId, n],
    );
    return r?.at ?? null;
  }

  async overview(gameId: string, currency: string, days: number, endDate?: string) {
    const game = await this.db.one(
      `SELECT g.id, g.code, g.name, g.timezone, g.board, g.draw_count,
              (SELECT m.factor_x100 FROM lottery.modality m WHERE m.game_id = g.id AND m.code IN ('EXACT', 'KINO5') ORDER BY m.code = 'EXACT' DESC LIMIT 1)::text AS factor_x100
         FROM lottery.game g WHERE g.id = $1`,
      [gameId],
    );
    if (!game) throw new BusinessError('NOT_FOUND', 'Juego no encontrado');
    const end = endDate ?? localDate(new Date(), game.timezone);
    const span = Math.min(Math.max(days, 1), 90);

    const symbols = await this.db.query(`SELECT id, number, name, emoji FROM lottery.symbol WHERE game_id = $1 ORDER BY sort`, [gameId]);
    const n = symbols.length;

    const dayList = (
      await this.db.query(`SELECT (($1::date - k))::text AS d FROM generate_series($2::int - 1, 0, -1) k`, [end, span])
    ).map((r) => r.d as string);

    const draws = await this.db.query(
      `SELECT d.id, d.draw_at, (d.draw_at AT TIME ZONE g.timezone)::date::text AS day, d.result_numbers,
              extract(hour FROM d.draw_at AT TIME ZONE g.timezone)::int AS hour,
              d.result_symbol_id AS symbol_id,
              coalesce(sum(x.amount) FILTER (WHERE x.status <> 'VOID'), 0)::text AS sold,
              coalesce(sum(x.win), 0)::text AS paid,
              count(x.id)::int AS plays,
              count(DISTINCT x.ticket_id)::int AS tickets,
              count(DISTINCT x.player_id)::int AS players,
              count(x.id) FILTER (WHERE x.status = 'WON')::int AS winners
         FROM lottery.draw d
         JOIN lottery.game g ON g.id = d.game_id
         LEFT JOIN (SELECT p.id, p.draw_id, p.ticket_id, p.amount, p.win, p.status, t.player_id
                      FROM lottery.play p JOIN lottery.ticket t ON t.id = p.ticket_id
                     WHERE t.currency = $2 AND NOT t.is_simulation) x ON x.draw_id = d.id
        WHERE d.game_id = $1 AND d.sim_player_id IS NULL AND d.archived_at IS NULL AND d.status = 'SETTLED' AND d.result_symbol_id IS NOT NULL
          AND (d.draw_at AT TIME ZONE g.timezone)::date BETWEEN $3::date AND $4::date
        GROUP BY d.id, g.timezone, d.result_numbers
        ORDER BY d.draw_at`,
      [gameId, currency, dayList[0], end],
    );

    // ── Sorteos ──
    const symbolById = new Map(symbols.map((s) => [s.id, s]));
    let cum = 0n;
    const drawRows = draws.map((d) => {
      const sold = BigInt(d.sold);
      const paid = BigInt(d.paid);
      const ggr = sold - paid;
      cum += ggr;
      const s = symbolById.get(d.symbol_id);
      return {
        id: d.id,
        draw_at: d.draw_at,
        day: d.day,
        hour: d.hour,
        result: d.result_numbers
          ? { number: d.result_numbers.map((x: number) => String(x).padStart(2, '0')).join(' '), name: '', emoji: null }
          : s
            ? { number: s.number, name: s.name, emoji: s.emoji }
            : null,
        sold: sold.toString(),
        paid: paid.toString(),
        ggr: ggr.toString(),
        margin: sold > 0n ? Number(ggr) / Number(sold) : null,
        cum_ggr: cum.toString(),
        plays: d.plays,
        tickets: d.tickets,
        players: d.players,
        winners: d.winners,
      };
    });

    // ── Velas diarias de la ganancia acumulada (abre, máx., mín., cierra) + volumen ──
    let level = 0n;
    const candles = dayList.map((day) => {
      const ds = drawRows.filter((r) => r.day === day);
      const open = level;
      let high = level;
      let low = level;
      let sold = 0n;
      let paid = 0n;
      for (const r of ds) {
        level += BigInt(r.ggr);
        if (level > high) high = level;
        if (level < low) low = level;
        sold += BigInt(r.sold);
        paid += BigInt(r.paid);
      }
      const ggr = sold - paid;
      return {
        day,
        open: open.toString(),
        high: high.toString(),
        low: low.toString(),
        close: level.toString(),
        sold: sold.toString(),
        paid: paid.toString(),
        ggr: ggr.toString(),
        margin: sold > 0n ? Number(ggr) / Number(sold) : null,
        draws: ds.length,
      };
    });

    // ── Por hora del sorteo ──
    const hours = [...new Set(drawRows.map((r) => r.hour))].sort((a, b) => a - b).map((h) => {
      const ds = drawRows.filter((r) => r.hour === h);
      const sold = ds.reduce((a, r) => a + BigInt(r.sold), 0n);
      const paid = ds.reduce((a, r) => a + BigInt(r.paid), 0n);
      return {
        hour: h,
        draws: ds.length,
        sold: sold.toString(),
        paid: paid.toString(),
        ggr: (sold - paid).toString(),
        margin: sold > 0n ? Number(sold - paid) / Number(sold) : null,
        house_wins: ds.filter((r) => BigInt(r.ggr) > 0n).length,
      };
    });

    // ── Frecuencia por animal (solo sorteos con el catálogo actual) ──
    const era = await this.eraStart(gameId, n);
    const eraMs = era ? new Date(era).getTime() : -Infinity;
    const freqIdx = drawRows.map((r, i) => i).filter((i) => new Date(drawRows[i].draw_at).getTime() > eraMs);
    const total = freqIdx.length;
    // Kino: en cada sorteo salen 7 de 40, así que cada número sale con probabilidad 7/40.
    const kino = game.board === 'KINO';
    const p = n > 0 ? (kino ? game.draw_count : 1) / n : 0;
    const expected = total * p;
    const sd = Math.sqrt(total * p * (1 - p));
    const animals = symbols.map((s) => {
      // Posiciones dentro de la serie de la era actual (0..total-1).
      const hitsIdx: number[] = [];
      freqIdx.forEach((i, k) => {
        if (kino ? (draws[i].result_numbers ?? []).includes(Number(s.number)) : draws[i].symbol_id === s.id) hitsIdx.push(k);
      });
      const hitRows = hitsIdx.map((k) => drawRows[freqIdx[k]]);
      const sold = hitRows.reduce((a, r) => a + BigInt(r.sold), 0n);
      const paid = hitRows.reduce((a, r) => a + BigInt(r.paid), 0n);
      // Mayor racha sin salir dentro del período (en sorteos).
      let maxGap = 0;
      let prev = -1;
      for (const i of hitsIdx) {
        maxGap = Math.max(maxGap, i - prev - 1);
        prev = i;
      }
      maxGap = Math.max(maxGap, total - prev - 1);
      return {
        id: s.id,
        number: s.number,
        name: s.name,
        emoji: s.emoji,
        hits: hitsIdx.length,
        share: total > 0 ? hitsIdx.length / total : 0,
        z: sd > 0 ? (hitsIdx.length - expected) / sd : 0,
        since: hitsIdx.length ? total - 1 - hitsIdx[hitsIdx.length - 1] : null,
        last_at: hitRows.length ? hitRows[hitRows.length - 1].draw_at : null,
        max_gap: maxGap,
        daily: dayList.map((day) => hitRows.filter((r) => r.day === day).length),
        // Lo que dejó la casa en los sorteos donde salió este animal.
        sold: sold.toString(),
        paid: paid.toString(),
        ggr: (sold - paid).toString(),
      };
    });
    const chi2 = expected > 0 ? animals.reduce((a, x) => a + (x.hits - expected) ** 2 / expected, 0) : 0;
    const df = Math.max(n - 1, 1);

    // ── Resumen ──
    const sold = drawRows.reduce((a, r) => a + BigInt(r.sold), 0n);
    const paid = drawRows.reduce((a, r) => a + BigInt(r.paid), 0n);
    const withSales = drawRows.filter((r) => r.sold !== '0');
    const byMargin = [...withSales].sort((a, b) => Number(BigInt(b.ggr) - BigInt(a.ggr)));
    const extra = await this.db.one(
      `SELECT count(DISTINCT t.id)::int AS tickets, count(DISTINCT t.player_id)::int AS players
         FROM lottery.ticket t WHERE t.id IN (SELECT p.ticket_id FROM lottery.play p WHERE p.draw_id = ANY($1::uuid[]))
          AND t.currency = $2 AND NOT t.is_simulation`,
      [drawRows.map((r) => r.id), currency],
    );
    const houseEdge = n > 0 ? 1 - (Number(game.factor_x100) / 100) * (kino ? kinoWinProbability(5) : 1 / n) : 0;

    return {
      game: { id: game.id, code: game.code, name: game.name, symbols: n, factor_x100: game.factor_x100 },
      currency,
      from: dayList[0],
      to: end,
      days: span,
      summary: {
        sold: sold.toString(),
        paid: paid.toString(),
        ggr: (sold - paid).toString(),
        margin: sold > 0n ? Number(sold - paid) / Number(sold) : null,
        expected_margin: houseEdge,
        draws: total,
        draws_with_sales: withSales.length,
        house_wins: withSales.filter((r) => BigInt(r.ggr) > 0n).length,
        tickets: extra?.tickets ?? 0,
        players: extra?.players ?? 0,
        best: byMargin[0] ?? null,
        worst: byMargin[byMargin.length - 1] ?? null,
      },
      fairness: { draws: total, since: era, expected_per_animal: expected, chi2, df, p_value: chiSquarePValue(chi2, df) },
      draws: drawRows,
      candles,
      hours,
      animals,
    };
  }

  async nextBand(gameId: string, simulated = false) {
    return this.computeBand(gameId, simulated, simulated);
  }

  async updateBand(gameId: string, drawId: string, candidateIds: string[] | null, actorId: string) {
    return this.db.tx(async (c) => {
      const { rows: [next] } = await c.query(`${NEXT_BAND_DRAW} FOR UPDATE OF d`, [gameId]);
      if (next?.id !== drawId) throw new BusinessError('CONFLICT', 'El próximo sorteo cambió. Abre de nuevo el editor de la banda.');

      if (candidateIds === null) {
        await c.query('DELETE FROM lottery.market_band WHERE draw_id = $1', [drawId]);
        return { customized: false };
      }

      const { rowCount } = await c.query('SELECT id FROM lottery.symbol WHERE game_id = $1 AND id = ANY($2::uuid[])', [gameId, candidateIds]);
      if (candidateIds.length !== BAND_SIZE || rowCount !== BAND_SIZE) {
        throw new BusinessError('INVALID_INPUT', 'Elige 10 animales distintos del catálogo de este juego');
      }
      await c.query(
        `INSERT INTO lottery.market_band (draw_id, symbol_ids, updated_by) VALUES ($1, $2, $3)
         ON CONFLICT (draw_id) DO UPDATE SET symbol_ids = EXCLUDED.symbol_ids, updated_by = EXCLUDED.updated_by, updated_at = now()`,
        [drawId, candidateIds, actorId],
      );
      return { customized: true };
    });
  }

  async quickBandTest(gameId: string, input: { drawId: string; simulated: boolean; candidateIds: string[] }) {
    const band = await this.computeBand(gameId, input.simulated, true);
    if (band.next?.id !== input.drawId ||
        band.candidates.length !== input.candidateIds.length ||
        !band.candidates.every((s, i) => s.id === input.candidateIds[i])) {
      throw new BusinessError('CONFLICT', 'La banda cambió. Revisa la banda actualizada y repite la prueba.');
    }
    const winner = band.candidates[randomInt(band.candidates.length)];
    return { band, winner };
  }

  /** Banda única por frecuencia reciente, con evaluación retrospectiva al cierre de cada sorteo. */
  private async computeBand(gameId: string, simulated: boolean, demoOnly: boolean) {
    const symbols = await this.db.query<{ id: string; number: string; name: string; emoji: string; is_demo: boolean }>(
      `SELECT s.id, s.number, s.name, s.emoji, g.is_demo FROM lottery.symbol s JOIN lottery.game g ON g.id = s.game_id
        WHERE g.id = $1 AND g.status = 'ACTIVE' ORDER BY s.sort, s.id`,
      [gameId],
    );
    const n = symbols.length;
    if (!n) throw new BusinessError('NOT_FOUND', 'Juego no encontrado');
    if (n < 5) throw new BusinessError('INVALID_STATE', 'Se necesitan al menos 5 animales para la banda');
    if ((await this.db.one(`SELECT board FROM lottery.game WHERE id = $1`, [gameId]))?.board === 'KINO') {
      throw new BusinessError('INVALID_STATE', 'La banda no aplica a Kino: cada sorteo saca 7 números');
    }
    if (demoOnly && (!config.simulationMode || !symbols[0].is_demo)) {
      throw new BusinessError('INVALID_STATE', 'Las pruebas de la banda están disponibles en modo demostración');
    }
    const size = Math.min(BAND_SIZE, n);
    const window = 36;
    const next = await this.db.one<{ id: string; draw_at: Date; cutoff: Date; symbol_ids: string[] | null }>(NEXT_BAND_DRAW, [gameId]);
    const history = simulated
      ? await this.simulatedBandHistory(gameId, next?.cutoff ?? null, symbols)
      : await this.bandHistory(gameId, n);

    const index = new Map(symbols.map((s, i) => [s.id, i]));
    const draws = history.flatMap((d) => {
      const result = index.get(d.result_symbol_id);
      return result === undefined ? [] : [{ ...d, result }];
    });
    const pick = (drawId: string, past: typeof draws) => {
      const counts = symbols.map(() => 0);
      for (const d of past) counts[d.result]++;
      // El ID público del sorteo da un orden reproducible para resolver empates.
      const offset = createHash('sha256').update(drawId).digest().readUInt32BE(0) % n;
      return counts.map((_, i) => (offset + i) % n).sort((a, b) => counts[b] - counts[a]).slice(0, size);
    };

    let tested = 0;
    let hits = 0;
    for (const [i, draw] of draws.entries()) {
      const past = draws.slice(0, i).filter((d) => d.settled_at <= draw.close_at).slice(-window);
      if (past.length < window) continue;
      tested++;
      if (pick(draw.id, past).includes(draw.result)) hits++;
    }

    const past = next ? draws.filter((d) => d.draw_at < next.draw_at && d.settled_at <= next.cutoff).slice(-window) : [];
    const saved = next?.symbol_ids?.map((id) => index.get(id)).filter((i) => i !== undefined);
    const customized = saved?.length === BAND_SIZE;
    const selection = customized ? saved : next ? pick(next.id, past) : [];
    return {
      next: next ? { id: next.id, draw_at: next.draw_at } : null,
      candidates: selection.map((i) => {
        const { id, number, name, emoji } = symbols[i];
        return { id, number, name, emoji };
      }),
      customized,
      size,
      symbols: n,
      chance: size / n,
      window,
      used: past.length,
      simulated,
      history_size: draws.length,
      backtest: { tested, hits, hit_rate: tested ? hits / tested : null },
    };
  }

  private async bandHistory(gameId: string, n: number) {
    return this.db.query<{ id: string; draw_at: Date; close_at: Date; settled_at: Date; result_symbol_id: string }>(
      `SELECT * FROM (
         SELECT d.id, d.draw_at, d.close_at, d.settled_at, d.result_symbol_id
           FROM lottery.draw d
          WHERE d.game_id = $1 AND d.sim_player_id IS NULL AND d.archived_at IS NULL AND d.status = 'SETTLED'
            AND d.result_symbol_id IS NOT NULL AND d.settled_at <= now()
            AND coalesce(d.result_evidence, '') NOT LIKE 'Historial simulado (desarrollo)%'
            AND d.draw_at > coalesce(greatest($2::timestamptz,
                (SELECT applied_at FROM public.schema_migrations WHERE name = '008_merida_70.sql')), '-infinity'::timestamptz)
          ORDER BY d.draw_at DESC LIMIT 600
       ) x ORDER BY draw_at`,
      [gameId, await this.eraStart(gameId, n)],
    );
  }

  /** Genera una muestra reproducible sobre el calendario del juego, sin escribir en el historial. */
  private async simulatedBandHistory(gameId: string, cutoff: Date | null, symbols: { id: string }[]) {
    const slots = await this.db.query<{ draw_at: Date; close_at: Date }>(
      `SELECT slot.draw_at, slot.draw_at - make_interval(mins => g.close_minutes_before) AS close_at
         FROM lottery.game g
         JOIN lottery.schedule s ON s.game_id = g.id AND s.active
         CROSS JOIN generate_series(0, 700) AS day(offset_days)
         CROSS JOIN LATERAL (
           SELECT (coalesce($2::timestamptz, now()) AT TIME ZONE g.timezone)::date - day.offset_days AS local_day
         ) calendar
         CROSS JOIN LATERAL (SELECT (calendar.local_day + s.draw_time) AT TIME ZONE g.timezone AS draw_at) slot
        WHERE g.id = $1 AND s.weekday = extract(dow FROM calendar.local_day)
          AND slot.draw_at <= coalesce($2::timestamptz, now())
        ORDER BY slot.draw_at DESC LIMIT 100`,
      [gameId, cutoff],
    );
    if (slots.length !== 100) throw new BusinessError('INVALID_STATE', 'Activa el calendario para generar los 100 sorteos de prueba');
    return slots.reverse().map((slot) => {
      const id = `demo:${slot.draw_at.toISOString()}`;
      const result = symbols[fairIndex(DEMO_BAND_SEED, id, symbols.length)];
      return { ...slot, id, settled_at: slot.draw_at, result_symbol_id: result.id };
    });
  }

  /** Libro de tickets: todos los tickets con sus jugadas, filtrable y paginado. */
  async tickets(q: TicketsQuery) {
    const size = Math.min(Math.max(q.size ?? 50, 10), 200);
    const page = Math.max(q.page ?? 1, 1);
    const where: string[] = [];
    const args: unknown[] = [];
    const arg = (v: unknown) => {
      args.push(v);
      return `$${args.length}`;
    };
    if (q.gameId) where.push(`t.game_id = ${arg(q.gameId)}`);
    if (q.currency) where.push(`t.currency = ${arg(q.currency)}`);
    if (q.from) where.push(`(t.sold_at AT TIME ZONE coalesce(g.timezone, '${OPERATING_TZ}'))::date >= ${arg(q.from)}::date`);
    if (q.to) where.push(`(t.sold_at AT TIME ZONE coalesce(g.timezone, '${OPERATING_TZ}'))::date <= ${arg(q.to)}::date`);
    if (q.status) where.push(`t.status = ${arg(q.status)}`);
    if (!q.includeSim) where.push(`NOT t.is_simulation`);
    // Tickets de sorteos reseteados (archivados) quedan fuera del libro del Mercado.
    where.push(`NOT EXISTS (SELECT 1 FROM lottery.play pa JOIN lottery.draw da ON da.id = pa.draw_id WHERE pa.ticket_id = t.id AND da.archived_at IS NOT NULL)`);
    if (q.drawId) where.push(`EXISTS (SELECT 1 FROM lottery.play px WHERE px.ticket_id = t.id AND px.draw_id = ${arg(q.drawId)})`);
    if (q.q) {
      const like = arg(`%${q.q.trim().replace(/[\\%_]/g, (c) => '\\' + c)}%`);
      where.push(`(t.code ILIKE ${like} OR u.email ILIKE ${like} OR (u.first_name || ' ' || u.last_name) ILIKE ${like})`);
    }
    const sqlWhere = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const totals = await this.db.one(
      `SELECT coalesce(jsonb_object_agg(cur, jsonb_build_object('sold', sold, 'won', won, 'count', n)), '{}'::jsonb) AS by_currency
         FROM (SELECT t.currency AS cur, coalesce(sum(t.total) FILTER (WHERE t.status NOT IN ('VOID', 'CANCELLED')), 0)::text AS sold,
                      sum(t.total_win)::text AS won, count(*)::int AS n
                 FROM lottery.ticket t JOIN lottery.game g ON g.id = t.game_id JOIN identity.app_user u ON u.id = t.player_id
                 ${sqlWhere} GROUP BY t.currency) x`,
      args,
    );
    const count = await this.db.one(
      `SELECT count(*)::int AS n FROM lottery.ticket t JOIN lottery.game g ON g.id = t.game_id JOIN identity.app_user u ON u.id = t.player_id ${sqlWhere}`,
      args,
    );

    const rows = await this.db.query(
      `SELECT t.id, t.code, t.sold_at, t.currency, t.total::text, t.potential_win::text, t.total_win::text, t.status, t.channel,
              t.is_simulation, g.code AS game_code, u.email AS player_email, u.first_name || ' ' || u.last_name AS player_name,
              (SELECT jsonb_agg(jsonb_build_object(
                        'draw_at', d.draw_at, 'number', s.number, 'name', s.name, 'emoji', s.emoji, 'modality', mo.code, 'modality_name', mo.name, 'selection', p.selection,
                        'amount', p.amount::text, 'potential_win', p.potential_win::text, 'win', p.win::text, 'status', p.status,
                        'result_number', rs.number, 'result_emoji', rs.emoji) ORDER BY d.draw_at, s.sort)
                 FROM lottery.play p JOIN lottery.draw d ON d.id = p.draw_id JOIN lottery.symbol s ON s.id = p.symbol_id
                 JOIN lottery.modality mo ON mo.id = p.modality_id
                 LEFT JOIN lottery.symbol rs ON rs.id = d.result_symbol_id AND d.status IN ('RESULT_CONFIRMED', 'SETTLED')
                WHERE p.ticket_id = t.id) AS plays
         FROM lottery.ticket t JOIN lottery.game g ON g.id = t.game_id JOIN identity.app_user u ON u.id = t.player_id
         ${sqlWhere}
        ORDER BY t.sold_at DESC, t.id
        LIMIT ${size} OFFSET ${(page - 1) * size}`,
      args,
    );
    return { page, size, total: count?.n ?? 0, totals: totals?.by_currency ?? {}, rows };
  }
}

/** P(χ² ≥ x) con df grados de libertad (aproximación de Wilson–Hilferty; suficiente para df ≥ 10). */
function chiSquarePValue(x: number, df: number) {
  if (x <= 0) return 1;
  const z = (Math.cbrt(x / df) - (1 - 2 / (9 * df))) / Math.sqrt(2 / (9 * df));
  return 1 - normalCdf(z);
}

function normalCdf(x: number) {
  const t = 1 / (1 + 0.3275911 * (Math.abs(x) / Math.SQRT2));
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(x * x) / 2);
  return x >= 0 ? (1 + y) / 2 : (1 - y) / 2;
}
