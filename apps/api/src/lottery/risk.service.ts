import { Injectable } from '@nestjs/common';
import { kinoSubsetsPerDraw, kinoWinProbability, ModalityCode, TerminalPayouts, TriplePayouts } from '@loteria/domain';
import { DbService } from '../common/db.service';
import { BusinessError } from '../common/errors';
import { localDate } from '../common/time';

/**
 * Tablero de riesgo y rentabilidad (control previo del NEGOCIO, no del resultado).
 *
 * Modelo: cada sorteo tiene N animales equiprobables (1/N), independiente de lo vendido.
 * Para un sorteo con ventas `sold` y pago posible `payout_s` si sale el animal s:
 *   - pago esperado        E = Σ payout_s / N
 *   - ganancia esperada    sold − E
 *   - peor caso            sold − max(payout_s)
 *   - P(pérdida) exacta    #{s : payout_s > sold} / N
 *   - varianza             Σ payout_s² / N − E²
 * Para el día se suman los sorteos (independientes): los ya liquidados aportan su resultado real y los pendientes
 * su media y varianza; P(pérdida del día) se aproxima con una normal.
 * Montos en unidades mínimas (BIGINT); la varianza y las probabilidades se calculan en coma flotante (solo informativas).
 */
type PlayAgg = { number: string; name: string; emoji: string | null; code: ModalityCode; sold: string; payout: string };

/** Pago total por cada resultado posible con premio > 0 (los resultados sin jugadas pagan 0). */
export function resultPayouts(ps: PlayAgg[], board: string) {
  const out = new Map<string, { number: string; name: string; emoji: string | null; sold: bigint; payout: bigint }>();
  if (board === 'DIGITS3' || board === 'DIGITS2') {
    const width = board === 'DIGITS2' ? 2 : 3;
    const tp = board === 'DIGITS2' ? new TerminalPayouts() : new TriplePayouts();
    const stake = new Map<string, bigint>();
    for (const p of ps) {
      tp.add(p.code, p.number, BigInt(p.payout));
      stake.set(p.number, (stake.get(p.number) ?? 0n) + BigInt(p.sold));
    }
    for (let i = 0; i < 10 ** width; i++) {
      const r = String(i).padStart(width, '0');
      const payout = tp.payout(r);
      if (payout > 0n) out.set(r, { number: r, name: r, emoji: null, sold: stake.get(r) ?? 0n, payout });
    }
    return [...out.values()];
  }
  for (const p of ps) {
    const cur = out.get(p.number) ?? { number: p.number, name: p.name, emoji: p.emoji, sold: 0n, payout: 0n };
    cur.sold += BigInt(p.sold);
    cur.payout += BigInt(p.payout);
    out.set(p.number, cur);
  }
  return [...out.values()];
}

@Injectable()
export class RiskService {
  constructor(private readonly db: DbService) {}

  async day(gameId: string, currency: string, date?: string) {
    const day = date ?? localDate();
    const game = await this.db.one(
      `SELECT g.id, g.code, g.name, g.timezone, g.board, (SELECT count(*)::int FROM lottery.symbol s WHERE s.game_id = g.id) AS n,
              (SELECT m.factor_x100 FROM lottery.modality m WHERE m.game_id = g.id AND m.code IN ('EXACT', 'KINO5') ORDER BY m.code = 'EXACT' DESC LIMIT 1)::text AS factor_x100,
              l.max_liability_per_symbol::text AS cap, l.max_player_per_draw::text AS player_cap
         FROM lottery.game g JOIN lottery.game_limit l ON l.game_id = g.id AND l.currency = $2 WHERE g.id = $1`,
      [gameId, currency],
    );
    if (!game) throw new BusinessError('NOT_FOUND', 'Juego o moneda no encontrados');
    const n: number = game.n;
    const cap = BigInt(game.cap);

    const draws = await this.db.query(
      `SELECT d.id, d.draw_at, d.close_at, d.status, d.is_extraordinary, d.result_numbers,
              rs.number AS result_number, rs.name AS result_name, rs.emoji AS result_emoji
         FROM lottery.draw d JOIN lottery.game g ON g.id = d.game_id
         LEFT JOIN lottery.symbol rs ON rs.id = d.result_symbol_id AND d.status IN ('RESULT_CONFIRMED', 'SETTLED')
        WHERE d.game_id = $1 AND d.sim_player_id IS NULL AND d.archived_at IS NULL AND (d.draw_at AT TIME ZONE g.timezone)::date = $2::date
        ORDER BY d.draw_at`,
      [gameId, day],
    );
    const plays = await this.db.query(
      `SELECT p.draw_id, p.symbol_id, s.number, s.name, s.emoji, m.code, m.name AS modality_name, p.selection,
              sum(p.amount)::text AS sold, sum(p.potential_win)::text AS payout, sum(p.win)::text AS paid, count(*)::int AS plays
         FROM lottery.play p JOIN lottery.ticket t ON t.id = p.ticket_id JOIN lottery.symbol s ON s.id = p.symbol_id
         JOIN lottery.modality m ON m.id = p.modality_id
        WHERE p.draw_id = ANY($1::uuid[]) AND t.currency = $2 AND p.status <> 'VOID' AND NOT t.is_simulation
        GROUP BY p.draw_id, p.symbol_id, s.number, s.name, s.emoji, m.code, m.name, p.selection`,
      [draws.map((d) => d.id), currency],
    );

    let dayMean = 0;
    let dayVar = 0;
    let soldDay = 0n;
    let realizedGgr = 0n;
    let expectedGgrDay = 0;
    let worstDay = 0n;
    const rows = draws.map((d) => {
      const ps = plays.filter((p) => p.draw_id === d.id);
      const sold: bigint = ps.reduce((a: bigint, p: any) => a + BigInt(p.sold), 0n);
      // Pago posible por resultado. Animalitos/Frutas: lo jugado a ese símbolo. Triple: triple + terminal + última cifra.
      let maxPay: bigint;
      let bestPay: bigint;
      let expectedPayout: number;
      let variance: number;
      let lossProbability: number;
      let top: { number: string; name: string; emoji: string | null; sold: bigint; payout: bigint }[];
      if (game.board === 'KINO') {
        // Kino: cada combinación gana con probabilidad C(40−k, 7−k)/C(40, 7). El peor caso es una cota: en 7 extraídos caben
        // a lo sumo C(7, k) combinaciones de k, así que se suman las C(7, k) más cargadas de cada tamaño.
        const lines = ps.map((p: any) => ({
          k: p.selection.length as number,
          number: p.selection.map((x: number) => String(x).padStart(2, '0')).join('-'),
          name: p.modality_name as string,
          emoji: null,
          sold: BigInt(p.sold),
          payout: BigInt(p.payout),
        }));
        expectedPayout = lines.reduce((a, l) => a + Number(l.payout) * kinoWinProbability(l.k), 0);
        variance = lines.reduce((a, l) => a + Number(l.payout) ** 2 * kinoWinProbability(l.k) * (1 - kinoWinProbability(l.k)), 0);
        lossProbability = Math.min(1, lines.filter((l) => l.payout > sold).reduce((a, l) => a + kinoWinProbability(l.k), 0));
        maxPay = [5, 6, 7].reduce(
          (acc, k) => acc + lines.filter((l) => l.k === k).map((l) => l.payout).sort((a, b) => Number(b - a)).slice(0, kinoSubsetsPerDraw(k)).reduce((a, x) => a + x, 0n),
          0n,
        );
        bestPay = 0n;
        top = [...lines].sort((a, b) => Number(b.payout - a.payout)).slice(0, 3);
      } else {
        // Pago posible por resultado. Animalitos/Frutas: lo jugado a ese símbolo. Triple: triple + terminal + última cifra.
        const byResult = resultPayouts(ps, game.board);
        const payouts = byResult.map((r) => r.payout);
        const sumPay = payouts.reduce((a, x) => a + x, 0n);
        maxPay = payouts.reduce((a, x) => (x > a ? x : a), 0n);
        bestPay = payouts.length === n ? payouts.reduce((a, x) => (x < a ? x : a)) : 0n;
        expectedPayout = Number(sumPay) / n;
        variance = payouts.reduce((a, x) => a + Number(x) ** 2, 0) / n - expectedPayout ** 2;
        lossProbability = payouts.filter((x) => x > sold).length / n;
        top = [...byResult].sort((a, b) => Number(b.payout - a.payout)).slice(0, 3);
      }
      const settled = d.status === 'SETTLED';
      const cancelled = d.status === 'CANCELLED';
      const paid: bigint = ps.reduce((a: bigint, p: any) => a + BigInt(p.paid), 0n);
      const ggr = sold - paid;
      const expectedGgr = Number(sold) - expectedPayout;

      if (!cancelled) {
        soldDay += sold;
        expectedGgrDay += expectedGgr;
        if (settled) {
          realizedGgr += ggr;
          dayMean += Number(ggr);
          worstDay += ggr;
        } else {
          dayMean += expectedGgr;
          dayVar += Math.max(variance, 0);
          worstDay += sold - maxPay;
        }
      }
      return {
        id: d.id,
        draw_at: d.draw_at,
        close_at: d.close_at,
        status: d.status,
        is_extraordinary: d.is_extraordinary,
        sold: sold.toString(),
        expected_ggr: Math.round(expectedGgr).toString(),
        worst_case: (sold - maxPay).toString(),
        // Mejor caso: sale un animal sin jugadas (si queda alguno) o el de menor pago.
        best_case: (sold - bestPay).toString(),
        loss_probability: lossProbability,
        max_cap_use: cap > 0n ? Number((maxPay * 1000n) / cap) / 10 : 0,
        top: top.map((p) => ({ number: p.number, name: p.name, emoji: p.emoji, sold: p.sold.toString(), payout: p.payout.toString() })),
        result: d.result_numbers
          ? { number: d.result_numbers.map((x: number) => String(x).padStart(2, '0')).join(' '), name: '', emoji: null }
          : d.result_number
            ? { number: d.result_number, name: d.result_name, emoji: d.result_emoji }
            : null,
        paid: settled ? paid.toString() : null,
        ggr: settled ? ggr.toString() : null,
      };
    });

    const sd = Math.sqrt(dayVar);
    const dayLossProbability = sd === 0 ? (dayMean < 0 ? 1 : 0) : normalCdf(-dayMean / sd);
    return {
      game: {
        id: game.id,
        code: game.code,
        name: game.name,
        symbols: n,
        factor_x100: game.factor_x100,
        cap: game.cap,
        player_cap: game.player_cap,
      },
      currency,
      date: day,
      model: {
        // Kino: retorno de Kino 5 (la modalidad más jugable).
        rtp: (Number(game.factor_x100) / 100) * (game.board === 'KINO' ? kinoWinProbability(5) : 1 / n),
        house_edge: 1 - (Number(game.factor_x100) / 100) * (game.board === 'KINO' ? kinoWinProbability(5) : 1 / n),
      },
      summary: {
        sold: soldDay.toString(),
        realized_ggr: realizedGgr.toString(),
        expected_ggr: Math.round(expectedGgrDay).toString(),
        projected_ggr: Math.round(dayMean).toString(),
        projected_low: Math.round(dayMean - 1.645 * sd).toString(),
        projected_high: Math.round(dayMean + 1.645 * sd).toString(),
        worst_case: worstDay.toString(),
        loss_probability: dayLossProbability,
        draws: rows.length,
        settled: rows.filter((r) => r.status === 'SETTLED').length,
        hot: rows.filter((r) => r.max_cap_use >= 80 && !['SETTLED', 'CANCELLED'].includes(r.status)).length,
      },
      draws: rows,
    };
  }

  /** Últimos N días: vendido, pagado y margen real frente al esperado por el modelo. */
  async history(gameId: string, currency: string, days = 7) {
    const rows = await this.db.query(
      `WITH g AS (SELECT id, timezone FROM lottery.game WHERE id = $1),
            days AS (SELECT ((now() AT TIME ZONE g.timezone)::date - k) AS day FROM g, generate_series(0, $3::int - 1) k)
       SELECT days.day::text AS date,
              coalesce(sum(p.amount) FILTER (WHERE d.status = 'SETTLED'), 0)::text AS sold,
              coalesce(sum(p.win) FILTER (WHERE d.status = 'SETTLED'), 0)::text AS paid,
              round(coalesce(sum(p.amount * (1 - p.factor_x100 / 100.0 * (SELECT CASE mo.code WHEN 'TERMINAL' THEN 0.01 WHEN 'LAST_DIGIT' THEN 0.1 WHEN 'FULL' THEN 0.0028 WHEN 'APPROX' THEN 0.0198 WHEN 'DUAL' THEN 0.01396 WHEN 'KINO5' THEN 595.0 / 18643560 WHEN 'KINO6' THEN 34.0 / 18643560 WHEN 'KINO7' THEN 1.0 / 18643560
                  ELSE 1.0 / (SELECT count(*) FROM lottery.symbol sy WHERE sy.game_id = g.id) END FROM lottery.modality mo WHERE mo.id = p.modality_id)))
                FILTER (WHERE d.status = 'SETTLED'), 0))::bigint::text AS expected_ggr,
              count(DISTINCT d.id) FILTER (WHERE d.status = 'SETTLED')::int AS settled_draws
         FROM days CROSS JOIN g
         LEFT JOIN lottery.draw d ON d.game_id = g.id AND d.sim_player_id IS NULL AND d.archived_at IS NULL AND (d.draw_at AT TIME ZONE g.timezone)::date = days.day
         LEFT JOIN lottery.play p ON p.draw_id = d.id AND p.status <> 'VOID'
                                 AND EXISTS (SELECT 1 FROM lottery.ticket t WHERE t.id = p.ticket_id AND t.currency = $2 AND NOT t.is_simulation)
        GROUP BY days.day ORDER BY days.day`,
      [gameId, currency, Math.min(Math.max(days, 1), 31)],
    );
    return rows.map((r) => ({ ...r, ggr: (BigInt(r.sold) - BigInt(r.paid)).toString() }));
  }
}

/** Φ(x) normal estándar (Abramowitz–Stegun 7.1.26, error < 1.5e-7). */
function normalCdf(x: number) {
  const t = 1 / (1 + 0.3275911 * (Math.abs(x) / Math.SQRT2));
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(x * x) / 2);
  return x >= 0 ? (1 + y) / 2 : (1 - y) / 2;
}
