/**
 * Reglas puras del sportsbook (Doc. Maestro §7). Cuotas decimales como enteros escalados ×10000
 * ("2.10" → 21000n) y líneas ×100 ("-1.5" → -150): nada de punto flotante en cuotas ni pagos.
 */

export const ODDS_SCALE = 10_000n;
export const MIN_ODDS = 10_100n; // 1.01
export const MAX_ODDS = 10_000_000n; // 1000.00
export const MAX_PARLAY_LEGS = 10;

export type SportCode = 'FOOTBALL' | 'BASEBALL' | 'BASKETBALL' | 'ICE_HOCKEY' | 'AMERICAN_FOOTBALL';
export type SelectionResult = 'WIN' | 'LOSE' | 'VOID';
export type SlipStatus = 'OPEN' | 'WON' | 'LOST' | 'VOID';
export type OddsPolicy = 'ACCEPT_ANY' | 'ACCEPT_HIGHER' | 'NONE';

/** "2.1" / "2,10" → 21000n. Hasta 4 decimales, rango 1.01–1000. */
export function parseOdds(input: string): bigint {
  const s = input.trim().replace(',', '.');
  if (!/^\d{1,4}(\.\d{1,4})?$/.test(s)) throw new Error(`Cuota inválida: "${input}"`);
  const [int, frac = ''] = s.split('.');
  const v = BigInt(int) * ODDS_SCALE + BigInt(frac.padEnd(4, '0'));
  if (v < MIN_ODDS || v > MAX_ODDS) throw new Error(`Cuota fuera de rango (1.01–1000): "${input}"`);
  return v;
}

/** 21000n → "2.10" (mínimo 2 decimales, hasta 4 si hacen falta). */
export function formatOdds(odds: bigint): string {
  const int = odds / ODDS_SCALE;
  const frac = (odds % ODDS_SCALE).toString().padStart(4, '0').replace(/0{1,2}$/, '');
  return `${int}.${frac.length < 2 ? frac.padEnd(2, '0') : frac}`;
}

/** Cuota americana → decimal escalada: +150 → 2.50, −200 → 1.50 (redondeo hacia abajo). */
export function americanToOdds(american: number): bigint {
  if (!Number.isInteger(american) || Math.abs(american) < 100) throw new Error('Cuota americana inválida');
  const a = BigInt(Math.abs(american));
  return american > 0 ? ODDS_SCALE + (a * ODDS_SCALE) / 100n : ODDS_SCALE + (100n * ODDS_SCALE) / a;
}

/** Margen (overround) del mercado en puntos básicos: Σ(1/cuota) − 1. 1X2 2.10/3.30/3.60 → ≈ 570 (5,7 %). */
export function marketMarginBps(odds: bigint[]): number {
  // Σ(1/cuota) en bps con 4 decimales extra de precisión, redondeado al bp más cercano.
  const precise = odds.reduce((acc, o) => acc + (ODDS_SCALE * ODDS_SCALE * 10_000n) / o, 0n);
  const impliedBps = (precise + ODDS_SCALE / 2n) / ODDS_SCALE;
  return Number(impliedBps - 10_000n);
}

/** "-1.5" → -150. Solo líneas enteras o de medio punto (las de cuarto son fase posterior). */
export function parseLine(input: string): number {
  const s = input.trim().replace(',', '.');
  if (!/^[+-]?\d{1,3}(\.(0|00|5|50))?$/.test(s)) throw new Error(`Línea inválida (use enteros o .5): "${input}"`);
  const neg = s.startsWith('-');
  const [int, frac = ''] = s.replace(/^[+-]/, '').split('.');
  const v = Number(int) * 100 + (frac.startsWith('5') ? 50 : 0);
  return neg ? -v : v;
}

export function formatLine(lineX100: number): string {
  const abs = Math.abs(lineX100);
  const s = `${Math.floor(abs / 100)}${abs % 100 ? '.5' : ''}`;
  return lineX100 < 0 ? `-${s}` : s;
}

// ───────────── Plantillas de mercado ─────────────

export interface MarketTemplate {
  code: string;
  sport: SportCode;
  name: string;
  /** 'TOTAL': línea de totales (>0). 'HANDICAP': hándicap aplicado al local. */
  line?: 'TOTAL' | 'HANDICAP';
  selections: { code: string; name: string }[];
  rule: string;
}

export const MARKET_TEMPLATES: MarketTemplate[] = [
  {
    code: 'MATCH_RESULT',
    sport: 'FOOTBALL',
    name: 'Resultado final (1X2)',
    selections: [{ code: '1', name: '{home}' }, { code: 'X', name: 'Empate' }, { code: '2', name: '{away}' }],
    rule: '90 minutos + tiempo añadido, sin prórroga ni penales.',
  },
  {
    code: 'DOUBLE_CHANCE',
    sport: 'FOOTBALL',
    name: 'Doble oportunidad',
    selections: [{ code: '1X', name: '{home} o empate' }, { code: '12', name: '{home} o {away}' }, { code: 'X2', name: 'Empate o {away}' }],
    rule: '90 minutos + tiempo añadido.',
  },
  {
    code: 'DRAW_NO_BET',
    sport: 'FOOTBALL',
    name: 'Empate no válido',
    selections: [{ code: '1', name: '{home}' }, { code: '2', name: '{away}' }],
    rule: 'Si hay empate se devuelve el monto.',
  },
  {
    code: 'TOTAL_GOALS',
    sport: 'FOOTBALL',
    name: 'Total de goles',
    line: 'TOTAL',
    selections: [{ code: 'OVER', name: 'Más de {line}' }, { code: 'UNDER', name: 'Menos de {line}' }],
    rule: '90 minutos + tiempo añadido. Línea entera exacta = devolución.',
  },
  {
    code: 'BTTS',
    sport: 'FOOTBALL',
    name: 'Ambos marcan',
    selections: [{ code: 'YES', name: 'Sí' }, { code: 'NO', name: 'No' }],
    rule: '90 minutos + tiempo añadido.',
  },
  {
    code: 'MONEYLINE',
    sport: 'BASEBALL',
    name: 'Ganador (moneyline)',
    selections: [{ code: '1', name: '{home}' }, { code: '2', name: '{away}' }],
    rule: 'Incluye entradas extra. Juego oficial: 5 entradas (4.5 si gana el local).',
  },
  {
    code: 'RUN_LINE',
    sport: 'BASEBALL',
    name: 'Run line',
    line: 'HANDICAP',
    selections: [{ code: '1', name: '{home} {line}' }, { code: '2', name: '{away} {-line}' }],
    rule: 'Incluye extras. Requiere 9 entradas (8.5 si gana el local); si no, se anula.',
  },
  {
    code: 'TOTAL_RUNS',
    sport: 'BASEBALL',
    name: 'Total de carreras',
    line: 'TOTAL',
    selections: [{ code: 'OVER', name: 'Más de {line}' }, { code: 'UNDER', name: 'Menos de {line}' }],
    rule: 'Incluye extras. Requiere 9 entradas (8.5 si gana el local); si no, se anula.',
  },
  // Deportes de EE. UU. y básquet: siempre hay ganador (prórroga incluida), sin empate.
  {
    code: 'BASKETBALL_MONEYLINE',
    sport: 'BASKETBALL',
    name: 'Ganador del partido',
    selections: [{ code: '1', name: '{home}' }, { code: '2', name: '{away}' }],
    rule: 'Incluye prórroga.',
  },
  {
    code: 'BASKETBALL_TOTAL',
    sport: 'BASKETBALL',
    name: 'Total de puntos',
    line: 'TOTAL',
    selections: [{ code: 'OVER', name: 'Más de {line}' }, { code: 'UNDER', name: 'Menos de {line}' }],
    rule: 'Incluye prórroga. Línea entera exacta = devolución.',
  },
  {
    code: 'HOCKEY_MONEYLINE',
    sport: 'ICE_HOCKEY',
    name: 'Ganador del partido',
    selections: [{ code: '1', name: '{home}' }, { code: '2', name: '{away}' }],
    rule: 'Incluye tiempo extra y penales.',
  },
  {
    code: 'HOCKEY_TOTAL',
    sport: 'ICE_HOCKEY',
    name: 'Total de goles',
    line: 'TOTAL',
    selections: [{ code: 'OVER', name: 'Más de {line}' }, { code: 'UNDER', name: 'Menos de {line}' }],
    rule: 'Marcador oficial incluyendo tiempo extra y penales. Línea entera exacta = devolución.',
  },
  {
    code: 'GRIDIRON_MONEYLINE',
    sport: 'AMERICAN_FOOTBALL',
    name: 'Ganador del partido',
    selections: [{ code: '1', name: '{home}' }, { code: '2', name: '{away}' }],
    rule: 'Incluye tiempo extra. Si termina empatado se devuelve el monto.',
  },
  {
    code: 'GRIDIRON_TOTAL',
    sport: 'AMERICAN_FOOTBALL',
    name: 'Total de puntos',
    line: 'TOTAL',
    selections: [{ code: 'OVER', name: 'Más de {line}' }, { code: 'UNDER', name: 'Menos de {line}' }],
    rule: 'Incluye tiempo extra. Línea entera exacta = devolución.',
  },
];

export function marketTemplate(code: string): MarketTemplate | undefined {
  return MARKET_TEMPLATES.find((t) => t.code === code);
}

export function selectionName(template: string, ctx: { home: string; away: string; line?: number | null }): string {
  const line = ctx.line ?? 0;
  const signed = (v: number) => (v > 0 ? `+${formatLine(v)}` : formatLine(v));
  return template
    .replace('{home}', ctx.home)
    .replace('{away}', ctx.away)
    .replace('{-line}', signed(-line))
    .replace('{line}', template.includes('{home} {line}') ? signed(line) : formatLine(line));
}

/** Valida la línea de un mercado según su plantilla. Devuelve un mensaje de error o null. */
export function validateMarketLine(t: MarketTemplate, line: number | null): string | null {
  if (!t.line) return line === null ? null : 'Este mercado no lleva línea';
  if (line === null) return 'Este mercado requiere línea';
  if (t.line === 'TOTAL' && line <= 0) return 'La línea de totales debe ser positiva';
  if (t.line === 'HANDICAP' && line === 0) return 'El hándicap no puede ser 0';
  return null;
}

// ───────────── Liquidación ─────────────

export interface Score {
  home: number;
  away: number;
}

/** Resultado de una selección con el marcador final. Líneas enteras exactas → VOID (push). */
export function settleSelection(marketCode: string, lineX100: number | null, selectionCode: string, score: Score): SelectionResult {
  const { home, away } = score;
  const cmp = (a: number, b: number): SelectionResult => (a > b ? 'WIN' : a < b ? 'LOSE' : 'VOID');
  const line = lineX100 ?? 0;
  switch (marketCode) {
    case 'MATCH_RESULT': {
      const outcome = home > away ? '1' : home < away ? '2' : 'X';
      return outcome === selectionCode ? 'WIN' : 'LOSE';
    }
    case 'DOUBLE_CHANCE': {
      const outcome = home > away ? '1' : home < away ? '2' : 'X';
      return selectionCode.includes(outcome) ? 'WIN' : 'LOSE';
    }
    case 'DRAW_NO_BET':
    case 'MONEYLINE':
    case 'BASKETBALL_MONEYLINE':
    case 'HOCKEY_MONEYLINE':
    case 'GRIDIRON_MONEYLINE':
      if (home === away) return 'VOID';
      return (home > away ? '1' : '2') === selectionCode ? 'WIN' : 'LOSE';
    case 'TOTAL_GOALS':
    case 'TOTAL_RUNS':
    case 'BASKETBALL_TOTAL':
    case 'HOCKEY_TOTAL':
    case 'GRIDIRON_TOTAL': {
      const total = (home + away) * 100;
      return selectionCode === 'OVER' ? cmp(total, line) : cmp(line, total);
    }
    case 'BTTS': {
      const both = home > 0 && away > 0;
      return (selectionCode === 'YES') === both ? 'WIN' : 'LOSE';
    }
    case 'RUN_LINE': {
      // El hándicap se aplica al local; el visitante recibe el opuesto.
      const homeAdj = home * 100 + line;
      return selectionCode === '1' ? cmp(homeAdj, away * 100) : cmp(away * 100, homeAdj);
    }
    default:
      throw new Error(`Mercado sin regla de liquidación: ${marketCode}`);
  }
}

// ───────────── Cupón ─────────────

export interface SlipLeg {
  eventId: string;
  odds: bigint;
}

export type SlipValidationError =
  | { code: 'EMPTY_SLIP' }
  | { code: 'SINGLE_NEEDS_ONE_LEG' }
  | { code: 'PARLAY_LEGS'; min: number; max: number }
  | { code: 'SAME_EVENT' }
  | { code: 'STAKE_BELOW_MIN' }
  | { code: 'STAKE_ABOVE_MAX' }
  | { code: 'ODDS_ABOVE_MAX' }
  | { code: 'PAYOUT_ABOVE_MAX' };

/** Cuota total de una combinada (producto), redondeada hacia abajo a 4 decimales. */
export function combinedOdds(odds: bigint[]): bigint {
  return odds.reduce((acc, o) => (acc * o) / ODDS_SCALE, ODDS_SCALE);
}

/** Pago = stake × Π cuotas, calculado exacto y redondeado hacia abajo una sola vez al final. */
export function slipPayout(stake: bigint, odds: bigint[]): bigint {
  const num = odds.reduce((acc, o) => acc * o, stake);
  return num / ODDS_SCALE ** BigInt(odds.length);
}

export function validateSlip(
  type: 'SINGLE' | 'PARLAY',
  legs: SlipLeg[],
  stake: bigint,
  limits: { minStake: bigint; maxStake: bigint; maxPayout: bigint; maxTotalOdds: bigint },
): SlipValidationError | null {
  if (legs.length === 0) return { code: 'EMPTY_SLIP' };
  if (type === 'SINGLE' && legs.length !== 1) return { code: 'SINGLE_NEEDS_ONE_LEG' };
  if (type === 'PARLAY' && (legs.length < 2 || legs.length > MAX_PARLAY_LEGS)) {
    return { code: 'PARLAY_LEGS', min: 2, max: MAX_PARLAY_LEGS };
  }
  // Sin modelo de correlación: prohibido combinar selecciones del mismo evento (§7.6).
  if (new Set(legs.map((l) => l.eventId)).size !== legs.length) return { code: 'SAME_EVENT' };
  if (stake < limits.minStake) return { code: 'STAKE_BELOW_MIN' };
  if (stake > limits.maxStake) return { code: 'STAKE_ABOVE_MAX' };
  const odds = legs.map((l) => l.odds);
  if (combinedOdds(odds) > limits.maxTotalOdds) return { code: 'ODDS_ABOVE_MAX' };
  if (slipPayout(stake, odds) > limits.maxPayout) return { code: 'PAYOUT_ABOVE_MAX' };
  return null;
}

/** Política de cambio de cuota entre lo que vio el jugador y la cuota vigente (§7.7). */
export function oddsAccepted(policy: OddsPolicy, seen: bigint, current: bigint): boolean {
  if (seen === current || policy === 'ACCEPT_ANY') return true;
  return policy === 'ACCEPT_HIGHER' && current > seen;
}

/**
 * Estado de un cupón a partir de sus selecciones. Una pierde → LOST de inmediato.
 * VOID cuenta como cuota 1.00; si todas son VOID se devuelve el stake.
 */
export function settleSlip(stake: bigint, legs: { odds: bigint; result: SelectionResult | null }[]): { status: SlipStatus; payout: bigint } {
  if (legs.some((l) => l.result === 'LOSE')) return { status: 'LOST', payout: 0n };
  if (legs.some((l) => l.result === null)) return { status: 'OPEN', payout: 0n };
  const winning = legs.filter((l) => l.result === 'WIN').map((l) => l.odds);
  if (winning.length === 0) return { status: 'VOID', payout: stake };
  return { status: 'WON', payout: slipPayout(stake, winning) };
}
