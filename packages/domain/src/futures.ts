/**
 * Cumbre Futuros (MER-06): contratos perpetuos lineales con margen en USDT (docs/Cumbre_Futuros_MER-06.md).
 *
 * Aritmética exacta con enteros:
 *   - cantidades y precios: escala 1e8 (`Fx`, bigint);
 *   - dinero: micro-USDT (1e6), igual que wallet.currency USDT;
 *   - tasas: partes por millón (ppm; 0,05 % = 500 ppm); funding: escala 1e8.
 */

export type FxSide = 'LONG' | 'SHORT';
export type OrderSide = 'BUY' | 'SELL';
export type MarginMode = 'ISOLATED' | 'CROSS';

export const FX = 100_000_000n; // escala de precio y cantidad
const MONEY_FROM_FX2 = 10_000_000_000n; // q(1e8)·p(1e8) = 1e16 → micro-USDT (1e6)
export const PPM = 1_000_000n;

export interface Bracket {
  /** Nocional desde (micro-USDT). */
  floor: bigint;
  /** Nocional hasta, inclusive (micro-USDT). */
  cap: bigint;
  maxLeverage: number;
  /** Tasa de mantenimiento en ppm (0,40 % = 4000). */
  mmrPpm: bigint;
  /** Monto de mantenimiento del tramo (micro-USDT). */
  cum: bigint;
}

export interface ContractSpec {
  symbol: string;
  qtyStep: bigint; // Fx
  priceTick: bigint; // Fx
  minNotional: bigint; // micro-USDT
  maxLeverage: number;
  brackets: Bracket[];
  takerPpm: bigint;
  makerPpm: bigint;
  liquidationPpm: bigint;
}

// ───────────── Decimales ─────────────

/** "74812.5" → 7481250000000n (escala 1e8). Rechaza más decimales que la escala. */
export function parseFx(value: string | number, scale = 8): bigint {
  const s = typeof value === 'number' ? value.toFixed(scale) : value.trim();
  const m = /^(-)?(\d+)(?:\.(\d+))?$/.exec(s);
  if (!m) throw new Error(`Número inválido: ${value}`);
  const frac = (m[3] ?? '').padEnd(scale, '0');
  if (frac.length > scale) {
    // redondeo al más cercano en la última cifra permitida
    const kept = BigInt(m[2] + frac.slice(0, scale));
    const up = Number(frac[scale]) >= 5 ? 1n : 0n;
    return (m[1] ? -1n : 1n) * (kept + up);
  }
  return (m[1] ? -1n : 1n) * BigInt(m[2] + frac);
}

/** 7481250000000n → "74812.5" (sin ceros sobrantes; `decimals` fija los decimales mostrados). */
export function formatFx(v: bigint, decimals?: number, scale = 8): string {
  const neg = v < 0n;
  const a = neg ? -v : v;
  const base = 10n ** BigInt(scale);
  const int = a / base;
  let frac = (a % base).toString().padStart(scale, '0');
  if (decimals !== undefined) frac = frac.slice(0, decimals);
  else frac = frac.replace(/0+$/, '');
  return `${neg ? '-' : ''}${int}${frac ? `.${frac}` : ''}`;
}

/** División entera con redondeo al más cercano (mitades hacia arriba en valor absoluto). */
export function divRound(a: bigint, b: bigint): bigint {
  const neg = a < 0n !== b < 0n;
  const x = a < 0n ? -a : a;
  const y = b < 0n ? -b : b;
  const q = (x * 2n + y) / (2n * y);
  return neg ? -q : q;
}

const divCeil = (a: bigint, b: bigint) => (a + b - 1n) / b;

/** Ajusta al múltiplo del paso hacia abajo. */
export function floorToStep(v: bigint, step: bigint): bigint {
  return (v / step) * step;
}

// ───────────── Cálculos de margen ─────────────

/** Nocional en micro-USDT de q (Fx) al precio p (Fx). */
export function notional(q: bigint, p: bigint): bigint {
  return divRound(q * p, MONEY_FROM_FX2);
}

/** Comisión en micro-USDT. */
export function fee(notionalMicro: bigint, ratePpm: bigint): bigint {
  return divRound(notionalMicro * ratePpm, PPM);
}

/** Tramo que corresponde a un nocional (el último si lo supera). */
export function bracketFor(c: Pick<ContractSpec, 'brackets'>, notionalMicro: bigint): Bracket {
  return c.brackets.find((b) => notionalMicro <= b.cap) ?? c.brackets[c.brackets.length - 1];
}

/** Nocional máximo permitido (techo del último tramo). */
export function maxNotional(c: Pick<ContractSpec, 'brackets'>): bigint {
  return c.brackets[c.brackets.length - 1].cap;
}

/** Margen inicial: nocional ÷ apalancamiento (redondeado hacia arriba). */
export function initialMargin(notionalMicro: bigint, leverage: number): bigint {
  return divCeil(notionalMicro, BigInt(leverage));
}

/** Margen de mantenimiento: nocional a precio marca × MMR − cum (nunca negativo). */
export function maintenanceMargin(c: Pick<ContractSpec, 'brackets'>, notionalAtMark: bigint): bigint {
  const b = bracketFor(c, notionalAtMark);
  const mm = fee(notionalAtMark, b.mmrPpm) - b.cum;
  return mm > 0n ? mm : 0n;
}

/** PnL no realizado en micro-USDT. */
export function unrealizedPnl(side: FxSide, q: bigint, entry: bigint, mark: bigint): bigint {
  const diff = side === 'LONG' ? mark - entry : entry - mark;
  return divRound(q * diff, MONEY_FROM_FX2);
}

/**
 * Precio de liquidación (Fx) en margen aislado, con el tramo del nocional actual:
 *   long  = (Q·E − M − cum) ÷ (Q · (1 − MMR))
 *   short = (Q·E + M + cum) ÷ (Q · (1 + MMR))
 * Devuelve 0 si la posición no se puede liquidar (margen ≥ nocional en un long).
 */
export function liquidationPrice(
  c: Pick<ContractSpec, 'brackets'>,
  side: FxSide,
  q: bigint,
  entry: bigint,
  margin: bigint,
): bigint {
  if (q <= 0n) return 0n;
  const b = bracketFor(c, notional(q, entry));
  // En micro-USDT·1e8 para no perder precisión: Q·E/1e10 es micro-USDT; se trabaja con Q·E directamente.
  const qe = q * entry; // escala 1e16
  const m = (margin + b.cum) * MONEY_FROM_FX2; // micro → escala 1e16
  const sign = side === 'LONG' ? -1n : 1n;
  const num = qe + sign * m; // 1e16
  // q·(1 − MMR) para long, q·(1 + MMR) para short, en escala Fx·ppm.
  const factor = side === 'LONG' ? PPM - b.mmrPpm : PPM + b.mmrPpm;
  if (num <= 0n) return 0n;
  // num(1e16) / (q(1e8) · factor/1e6) = precio en escala 1e8
  return divRound(num * PPM, q * factor);
}

/** Precio de quiebra: margen = 0. */
export function bankruptcyPrice(side: FxSide, q: bigint, entry: bigint, margin: bigint): bigint {
  const delta = divRound(margin * MONEY_FROM_FX2, q); // micro·1e10 / Fx = Fx
  return side === 'LONG' ? (entry > delta ? entry - delta : 0n) : entry + delta;
}

/** ¿Hay que liquidar? Patrimonio de la posición ≤ mantenimiento. */
export function isLiquidatable(c: Pick<ContractSpec, 'brackets'>, side: FxSide, q: bigint, entry: bigint, margin: bigint, mark: bigint): boolean {
  const equity = margin + unrealizedPnl(side, q, entry, mark);
  return equity <= maintenanceMargin(c, notional(q, mark));
}

// ───────────── Llenados ─────────────

export interface PositionState {
  side: FxSide;
  qty: bigint;
  entry: bigint;
  margin: bigint;
  leverage: number;
}

export interface FillResult {
  /** Posición después del llenado (null si quedó cerrada). */
  position: PositionState | null;
  /** Cantidad que cerró la posición anterior. */
  closedQty: bigint;
  /** PnL realizado del tramo cerrado (micro-USDT). */
  realizedPnl: bigint;
  /** Margen liberado de la parte cerrada. */
  releasedMargin: bigint;
  /** Cantidad que abrió o aumentó posición. */
  openedQty: bigint;
  /** Margen inicial nuevo que hay que bloquear. */
  addedMargin: bigint;
}

/**
 * Aplica un llenado en modo unidireccional (una posición por contrato):
 * mismo lado → aumenta (precio promedio); lado contrario → reduce, cierra o invierte.
 */
export function applyFill(pos: PositionState | null, side: OrderSide, q: bigint, price: bigint, leverage: number): FillResult {
  const fillSide: FxSide = side === 'BUY' ? 'LONG' : 'SHORT';
  if (!pos || pos.qty === 0n) {
    const m = initialMargin(notional(q, price), leverage);
    return {
      position: { side: fillSide, qty: q, entry: price, margin: m, leverage },
      closedQty: 0n,
      realizedPnl: 0n,
      releasedMargin: 0n,
      openedQty: q,
      addedMargin: m,
    };
  }
  if (pos.side === fillSide) {
    const m = initialMargin(notional(q, price), pos.leverage);
    const qty = pos.qty + q;
    const entry = divRound(pos.qty * pos.entry + q * price, qty);
    return {
      position: { ...pos, qty, entry, margin: pos.margin + m },
      closedQty: 0n,
      realizedPnl: 0n,
      releasedMargin: 0n,
      openedQty: q,
      addedMargin: m,
    };
  }
  const closedQty = q < pos.qty ? q : pos.qty;
  const realizedPnl = unrealizedPnl(pos.side, closedQty, pos.entry, price);
  const releasedMargin = closedQty === pos.qty ? pos.margin : divRound(pos.margin * closedQty, pos.qty);
  const rest = pos.qty - closedQty;
  if (q <= pos.qty) {
    return {
      position: rest > 0n ? { ...pos, qty: rest, margin: pos.margin - releasedMargin } : null,
      closedQty,
      realizedPnl,
      releasedMargin,
      openedQty: 0n,
      addedMargin: 0n,
    };
  }
  // Invierte: cierra todo y abre el resto del lado contrario.
  const openQ = q - pos.qty;
  const m = initialMargin(notional(openQ, price), leverage);
  return {
    position: { side: fillSide, qty: openQ, entry: price, margin: m, leverage },
    closedQty,
    realizedPnl,
    releasedMargin,
    openedQty: openQ,
    addedMargin: m,
  };
}

// ───────────── Disparos ─────────────

/** Límite: compra si el índice baja hasta el precio; vende si sube hasta él. */
export function limitTriggered(side: OrderSide, limit: bigint, index: bigint): boolean {
  return side === 'BUY' ? index <= limit : index >= limit;
}

/** ¿Una orden límite se llenaría al instante (taker)? */
export function limitMarketable(side: OrderSide, limit: bigint, index: bigint): boolean {
  return limitTriggered(side, limit, index);
}

/** Stop a mercado: compra si la marca sube hasta el stop; vende si baja. */
export function stopTriggered(side: OrderSide, stop: bigint, mark: bigint): boolean {
  return side === 'BUY' ? mark >= stop : mark <= stop;
}

/** TP/SL de una posición (disparo por precio marca). */
export function tpslTriggered(side: FxSide, mark: bigint, tp: bigint | null, sl: bigint | null): 'TP' | 'SL' | null {
  if (side === 'LONG') {
    if (tp !== null && mark >= tp) return 'TP';
    if (sl !== null && mark <= sl) return 'SL';
  } else {
    if (tp !== null && mark <= tp) return 'TP';
    if (sl !== null && mark >= sl) return 'SL';
  }
  return null;
}

// ───────────── Funding ─────────────

export const FUNDING_INTEREST_E8 = 10_000n; // 0,01 % por periodo de 8 h (escala 1e8)
export const FUNDING_CLAMP_E8 = 50_000n; // ±0,05 %
export const FUNDING_CAP_E8 = 300_000n; // ±0,30 % por periodo (propuesta)

/** Tasa = prima + clamp(interés − prima, ±0,05 %), con tope ±0,30 %. Escala 1e8. */
export function fundingRate(premiumE8: bigint, interestE8 = FUNDING_INTEREST_E8): bigint {
  let adj = interestE8 - premiumE8;
  if (adj > FUNDING_CLAMP_E8) adj = FUNDING_CLAMP_E8;
  if (adj < -FUNDING_CLAMP_E8) adj = -FUNDING_CLAMP_E8;
  let r = premiumE8 + adj;
  if (r > FUNDING_CAP_E8) r = FUNDING_CAP_E8;
  if (r < -FUNDING_CAP_E8) r = -FUNDING_CAP_E8;
  return r;
}

/** Acota una tasa ya calculada por el mercado al tope de la plataforma. */
export function capFundingRate(rateE8: bigint): bigint {
  return rateE8 > FUNDING_CAP_E8 ? FUNDING_CAP_E8 : rateE8 < -FUNDING_CAP_E8 ? -FUNDING_CAP_E8 : rateE8;
}

/**
 * Pago de funding de una posición (micro-USDT): positivo = el jugador PAGA; negativo = el jugador COBRA.
 * Tasa positiva → pagan los longs.
 */
export function fundingPayment(side: FxSide, notionalAtMark: bigint, rateE8: bigint): bigint {
  const amount = divRound(notionalAtMark * rateE8, FX);
  return side === 'LONG' ? amount : -amount;
}

/** Próximo instante de funding (00:00, 08:00, 16:00 UTC) después de `now`. */
export function nextFundingTime(now: Date): Date {
  const t = new Date(now);
  t.setUTCMinutes(0, 0, 0);
  const h = t.getUTCHours();
  const next = (Math.floor(h / 8) + 1) * 8;
  t.setUTCHours(next);
  return t;
}

/** Mediana de una lista de precios (Fx). */
export function medianFx(values: bigint[]): bigint {
  const v = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const n = v.length;
  if (!n) throw new Error('Sin valores');
  return n % 2 ? v[(n - 1) / 2] : (v[n / 2 - 1] + v[n / 2]) / 2n;
}

/** Descarta fuentes que se alejan más de `maxDevPpm` de la mediana de las demás. */
export function filterOutliers(values: bigint[], maxDevPpm = 20_000n): bigint[] {
  return values.filter((x, i) => {
    const others = values.filter((_, j) => j !== i);
    if (!others.length) return true;
    const med = medianFx(others);
    const dev = x > med ? x - med : med - x;
    return dev * PPM <= med * maxDevPpm;
  });
}
