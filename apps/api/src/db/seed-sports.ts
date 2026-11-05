import { formatOdds, marketTemplate, parseLine, parseOdds, selectionName } from '@loteria/domain';
import { PoolClient } from 'pg';

/** Ligas foco para Venezuela (Doc. Maestro §7.3) y algunos partidos de ejemplo con cuotas del trader. */
const COMPETITIONS = [
  { sport: 'BASEBALL', name: 'LVBP', country: 'Venezuela', sort: 1 },
  { sport: 'BASEBALL', name: 'MLB', country: 'Estados Unidos', sort: 2 },
  { sport: 'BASEBALL', name: 'Serie del Caribe', country: 'Caribe', sort: 3 },
  { sport: 'FOOTBALL', name: 'Liga FUTVE', country: 'Venezuela', sort: 1 },
  { sport: 'FOOTBALL', name: 'Copa Libertadores', country: 'Sudamérica', sort: 2 },
  { sport: 'FOOTBALL', name: 'Eliminatorias CONMEBOL', country: 'Sudamérica', sort: 3 },
] as const;

type Sample = {
  competition: string;
  home: string;
  away: string;
  hoursFromNow: number;
  markets: { type: string; line?: string; odds: Record<string, string> }[];
};

const SAMPLES: Sample[] = [
  {
    competition: 'LVBP',
    home: 'Leones del Caracas',
    away: 'Navegantes del Magallanes',
    hoursFromNow: 6,
    markets: [
      { type: 'MONEYLINE', odds: { '1': '1.85', '2': '1.95' } },
      { type: 'RUN_LINE', line: '-1.5', odds: { '1': '2.40', '2': '1.55' } },
      { type: 'TOTAL_RUNS', line: '8.5', odds: { OVER: '1.90', UNDER: '1.90' } },
    ],
  },
  {
    competition: 'LVBP',
    home: 'Tigres de Aragua',
    away: 'Cardenales de Lara',
    hoursFromNow: 30,
    markets: [
      { type: 'MONEYLINE', odds: { '1': '2.05', '2': '1.75' } },
      { type: 'TOTAL_RUNS', line: '7.5', odds: { OVER: '1.85', UNDER: '1.95' } },
    ],
  },
  {
    competition: 'Liga FUTVE',
    home: 'Caracas FC',
    away: 'Deportivo Táchira',
    hoursFromNow: 8,
    markets: [
      { type: 'MATCH_RESULT', odds: { '1': '2.30', X: '3.10', '2': '3.05' } },
      { type: 'DOUBLE_CHANCE', odds: { '1X': '1.33', '12': '1.32', X2: '1.55' } },
      { type: 'TOTAL_GOALS', line: '2.5', odds: { OVER: '2.05', UNDER: '1.75' } },
      { type: 'BTTS', odds: { YES: '1.95', NO: '1.80' } },
    ],
  },
  {
    competition: 'Liga FUTVE',
    home: 'Monagas SC',
    away: 'Carabobo FC',
    hoursFromNow: 52,
    markets: [
      { type: 'MATCH_RESULT', odds: { '1': '2.10', X: '3.20', '2': '3.50' } },
      { type: 'DRAW_NO_BET', odds: { '1': '1.50', '2': '2.45' } },
    ],
  },
];

export async function seedSports(client: PoolClient) {
  const comps = new Map<string, { id: string; sport: string }>();
  for (const c of COMPETITIONS) {
    const res = await client.query(
      `INSERT INTO sports.competition (sport_code, name, country, sort) VALUES ($1, $2, $3, $4)
       ON CONFLICT (sport_code, name) DO UPDATE SET country = EXCLUDED.country RETURNING id`,
      [c.sport, c.name, c.country, c.sort],
    );
    comps.set(c.name, { id: res.rows[0].id, sport: c.sport });
  }

  // Partidos de ejemplo solo si aún no hay eventos (el seed es idempotente).
  const { rows } = await client.query(`SELECT count(*)::int AS n FROM sports.event`);
  if (rows[0].n > 0) return;
  for (const s of SAMPLES) {
    const comp = comps.get(s.competition)!;
    const ids: string[] = [];
    for (const name of [s.home, s.away]) {
      const p = await client.query(
        `INSERT INTO sports.participant (sport_code, name) VALUES ($1, $2)
         ON CONFLICT (sport_code, name) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
        [comp.sport, name],
      );
      ids.push(p.rows[0].id);
    }
    const ev = await client.query(
      `INSERT INTO sports.event (competition_id, home_id, away_id, starts_at)
       VALUES ($1, $2, $3, date_trunc('hour', now()) + make_interval(hours => $4)) RETURNING id`,
      [comp.id, ids[0], ids[1], s.hoursFromNow],
    );
    for (const m of s.markets) {
      const t = marketTemplate(m.type)!;
      const line = m.line ? parseLine(m.line) : null;
      const market = await client.query(`INSERT INTO sports.market (event_id, type_code, line) VALUES ($1, $2, $3) RETURNING id`, [
        ev.rows[0].id,
        t.code,
        line === null ? null : (line / 100).toFixed(2),
      ]);
      for (const [i, sel] of t.selections.entries()) {
        const odds = formatOdds(parseOdds(m.odds[sel.code]));
        const r = await client.query(
          `INSERT INTO sports.selection (market_id, code, name, odds, sort) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
          [market.rows[0].id, sel.code, selectionName(sel.name, { home: s.home, away: s.away, line }), odds, i],
        );
        await client.query(`INSERT INTO sports.odds_history (selection_id, odds) VALUES ($1, $2)`, [r.rows[0].id, odds]);
      }
    }
  }
}
