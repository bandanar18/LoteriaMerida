/**
 * Programa de Agencias Virtuales (WalletLoteria/DOCUMENTO_MAESTRO_WALLET.md §4).
 * Reglas puras: código de afiliado, cálculo de comisión y validación de tasa contra el margen.
 */

/** Alfabeto Crockford Base32: sin I, L, O, U para evitar confusiones al dictar o escribir. */
export const AFFILIATE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const AFFILIATE_PREFIX = 'FB';
export const AFFILIATE_BODY_LENGTH = 6;

/** Tasa de comisión por defecto: 3 % = 300 puntos básicos. */
export const DEFAULT_COMMISSION_BPS = 300;
export const MAX_COMMISSION_BPS = 2000;

/**
 * Construye un código a partir de índices aleatorios (0..31) generados por el CSPRNG del servidor.
 * Se recibe la aleatoriedad como argumento para que la función sea pura y testeable.
 */
export function buildAffiliateCode(randomIndexes: number[]): string {
  if (randomIndexes.length !== AFFILIATE_BODY_LENGTH) throw new Error('Cantidad de índices inválida');
  const body = randomIndexes
    .map((i) => {
      if (!Number.isInteger(i) || i < 0 || i >= AFFILIATE_ALPHABET.length) throw new Error('Índice fuera de rango');
      return AFFILIATE_ALPHABET[i];
    })
    .join('');
  return AFFILIATE_PREFIX + body;
}

/**
 * Normaliza lo que escribe o escanea el usuario: sin guiones/espacios, mayúsculas, O→0, I/L→1.
 * Devuelve el código canónico ('FB7K3Q9X') o null si no tiene el formato.
 */
export function normalizeAffiliateCode(input: string | null | undefined): string | null {
  if (!input) return null;
  let s = input.toUpperCase().replace(/[\s\-_.]/g, '');
  if (!s.startsWith(AFFILIATE_PREFIX)) return null;
  const body = s
    .slice(AFFILIATE_PREFIX.length)
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
  s = AFFILIATE_PREFIX + body;
  const re = new RegExp(`^${AFFILIATE_PREFIX}[${AFFILIATE_ALPHABET}]{${AFFILIATE_BODY_LENGTH}}$`);
  return re.test(s) ? s : null;
}

/** 'FB7K3Q9X' → 'FB-7K3Q9X' para mostrar. */
export function formatAffiliateCode(code: string): string {
  return `${code.slice(0, AFFILIATE_PREFIX.length)}-${code.slice(AFFILIATE_PREFIX.length)}`;
}

export interface CommissionResult {
  amount: bigint;
  capped: boolean;
}

/**
 * Comisión de una jugada: floor(base × bps / 10000) en unidades mínimas, con tope opcional por jugada.
 * Devuelve amount = 0n si no corresponde comisión (la jugada no se registra).
 */
export function commissionFor(base: bigint, rateBps: number, capPerPlay?: bigint | null): CommissionResult {
  if (base <= 0n) throw new Error('Monto base no positivo');
  if (!Number.isInteger(rateBps) || rateBps < 0 || rateBps > MAX_COMMISSION_BPS) throw new Error('Tasa inválida');
  const raw = (base * BigInt(rateBps)) / 10000n;
  if (capPerPlay != null && capPerPlay >= 0n && raw > capPerPlay) return { amount: capPerPlay, capped: true };
  return { amount: raw, capped: false };
}

/**
 * Regla K11: la comisión debe ser menor que el margen de la casa.
 * RTP de una modalidad de un solo resultado = factor / universo (p. ej. 50× sobre 70 animales = 71,4 %).
 * Margen en bps = 10000 − RTP×10000. La tasa es válida si rateBps < margen.
 */
export function houseMarginBps(factorX100: bigint, outcomes: number, winningOutcomes = 1): number {
  return houseMarginBpsTiers([[factorX100, winningOutcomes]], outcomes);
}

/** Igual que houseMarginBps, con varios premios: [[factor×100, cuántos resultados lo pagan], …]. RTP redondeado hacia arriba. */
export function houseMarginBpsTiers(tiers: Array<[bigint, number]>, outcomes: number): number {
  if (outcomes <= 0 || tiers.some(([, n]) => n < 0)) throw new Error('Universo inválido');
  // RTP×10000 = Σ factor/100 × n/outcomes × 10000 = Σ factorX100 × n × 100 / outcomes
  const num = tiers.reduce((acc, [f, n]) => acc + f * BigInt(n) * 100n, 0n);
  const d = BigInt(outcomes);
  const rtpBps = (num + d - 1n) / d;
  return Number(10000n - rtpBps);
}

/**
 * Margen de la casa (bps) de una modalidad de lotería, según el tablero del juego.
 * `universe` = cantidad de símbolos (solo para SYMBOLS). Devuelve null si la modalidad no tiene una
 * condición de premio definida (Combinada, Múltiple, Súper terminal).
 * Los vecinos de Aproximación se cuentan como 2 aunque 00 y 99 tengan uno solo (estimación conservadora).
 */
export function modalityMarginBps(board: string, code: string, factorX100: bigint, universe: number): number | null {
  if (board === 'SYMBOLS' && code === 'EXACT') return houseMarginBpsTiers([[factorX100, 1]], universe);
  if (board === 'DIGITS2') {
    if (code === 'EXACT') return houseMarginBpsTiers([[factorX100, 1]], 100);
    if (code === 'APPROX') return houseMarginBpsTiers([[factorX100, 2]], 100);
    if (code === 'DUAL') return houseMarginBpsTiers([[factorX100, 1], [factorX100 / 5n, 2]], 100);
  }
  if (board === 'DUO') {
    // Dupleta de Montaña: 9.900 parejas ordenadas; exacta e invertida pagan con una sola.
    if (code === 'EXACT' || code === 'REVERSED') return houseMarginBpsTiers([[factorX100, 1]], 9900);
    // Doble paridad: 50·49 = 2.450 parejas de cada paridad.
    if (code === 'PARITY') return houseMarginBpsTiers([[factorX100, 2450]], 9900);
  }
  if (board === 'DIGITS4') {
    // Cuatrifecta de Cumbres: 10.000 resultados. Aproximación paga con el anterior y el siguiente (2, salvo en 0000 y 9999).
    if (code === 'EXACT') return houseMarginBpsTiers([[factorX100, 1]], 10000);
    if (code === 'APPROX') return houseMarginBpsTiers([[factorX100, 2]], 10000);
    // En desorden: hasta 24 órdenes (cifras distintas), el caso más caro.
    if (code === 'BOX') return houseMarginBpsTiers([[factorX100, 24]], 10000);
  }
  if (board === 'COLOR') {
    // Cóndor Dorado: 400 resultados; número + color paga con 1, solo número con 4, solo color con 100.
    if (code === 'EXACT') return houseMarginBpsTiers([[factorX100, 1]], 400);
    if (code === 'NUMBER') return houseMarginBpsTiers([[factorX100, 4]], 400);
    if (code === 'COLOR') return houseMarginBpsTiers([[factorX100, 100]], 400);
  }
  if (board === 'DIGITS3') {
    if (code === 'EXACT') return houseMarginBpsTiers([[factorX100, 1]], 1000);
    if (code === 'TERMINAL') return houseMarginBpsTiers([[factorX100, 10]], 1000);
    if (code === 'LAST_DIGIT') return houseMarginBpsTiers([[factorX100, 100]], 1000);
    // Par andino: hasta 20 resultados (10 con cada orden); se toma el caso de cifras distintas, el más caro.
    if (code === 'PAIR') return houseMarginBpsTiers([[factorX100, 20]], 1000);
    if (code === 'FULL') return houseMarginBpsTiers([[factorX100, 1], [factorX100 / 10n, 9], [factorX100 / 100n, 90]], 1000);
  }
  if (board === 'KINO' && /^MATCH[345]S?$/.test(code)) {
    // Andes 5 Estrella: 5 elegidos, 5 extraídos de 40; exactamente h aciertos. P = C(5,h)·C(35,5−h)/C(40,5).
    const h = Number(code.slice(5, 6));
    const star = code.endsWith('S') ? 5n : 1n; // la estrella acierta 1 de cada 5
    const c = (n: number, r: number) => {
      let x = 1n;
      for (let i = 0; i < r; i++) x = (x * BigInt(n - i)) / BigInt(i + 1);
      return x;
    };
    const wins = c(5, h) * c(35, 5 - h);
    const total = c(40, 5) * star;
    return Number(10000n - (factorX100 * wins * 100n + total - 1n) / total);
  }
  if (board === 'KINO') {
    const k = Number(code.replace('KINO', ''));
    if (!Number.isInteger(k) || k < 1 || k > 7) return null;
    // P(ganar) = C(40−k, 7−k) / C(40, 7)
    const choose = (n: number, r: number) => {
      let x = 1n;
      for (let i = 0; i < r; i++) x = (x * BigInt(n - i)) / BigInt(i + 1);
      return x;
    };
    const wins = choose(40 - k, 7 - k);
    const total = choose(40, 7);
    const rtpBps = (factorX100 * wins * 100n + total - 1n) / total;
    return Number(10000n - rtpBps);
  }
  return null;
}

export function isCommissionRateSafe(rateBps: number, marginBps: number): boolean {
  return rateBps < marginBps;
}

/** «Ana Pérez» → «Ana P.» (lo único que la agencia ve de sus referidos). */
export function maskPlayerName(firstName: string, lastName: string): string {
  const first = firstName.trim().split(/\s+/)[0] ?? '';
  const initial = lastName.trim().charAt(0).toUpperCase();
  return initial ? `${first} ${initial}.` : first;
}

// ───────────── Fase 3: retiros en Bs por Pago Móvil (§4.5 y §5 del documento maestro) ─────────────

/** Parentescos permitidos para un Pago Móvil de familiar (P1). */
export const PAYOUT_RELATIONSHIPS = {
  PADRE_MADRE: 'Padre / Madre',
  HIJO: 'Hijo / Hija',
  HERMANO: 'Hermano / Hermana',
  CONYUGE: 'Cónyuge / Pareja',
  ABUELO: 'Abuelo / Abuela',
  NIETO: 'Nieto / Nieta',
  TIO: 'Tío / Tía',
  SOBRINO: 'Sobrino / Sobrina',
  PRIMO: 'Primo / Prima',
  SUEGRO: 'Suegro / Suegra',
  CUNADO: 'Cuñado / Cuñada',
} as const;
export type PayoutRelationship = keyof typeof PAYOUT_RELATIONSHIPS;

export const MAX_PAYOUT_ACCOUNTS = 5;
export const MAX_FAMILY_PAYOUT_ACCOUNTS = 3;

/** Celular venezolano apto para Pago Móvil, ya normalizado como 58XXXXXXXXXX (412, 414, 416, 422, 424, 426). */
export function isVeMobile(normalized: string): boolean {
  return /^58(412|414|416|422|424|426)\d{7}$/.test(normalized);
}

/** 584141234567 → 0414-***-4567 */
export function maskPhone(normalized: string): string {
  const local = normalized.startsWith('58') ? `0${normalized.slice(2)}` : normalized;
  return `${local.slice(0, 4)}-***-${local.slice(-4)}`;
}

/** V + 20111111 → V-20.***.111 */
export function maskDocument(type: string, number: string): string {
  return `${type}-${number.slice(0, 2)}.***.${number.slice(-3)}`;
}

/** Tasa Bs por 1 USDT con hasta 4 decimales: "45,20" → 452000n (×10⁴). */
export function parseFxRate(input: string): bigint {
  const s = input.trim().replace(',', '.');
  if (!/^\d{1,9}(\.\d{1,4})?$/.test(s)) throw new Error(`Tasa inválida: "${input}"`);
  const [int, frac = ''] = s.split('.');
  const v = BigInt(int) * 10000n + BigInt(frac.padEnd(4, '0'));
  if (v <= 0n) throw new Error('La tasa debe ser mayor que cero');
  return v;
}

/** 452000n → "45,2000" */
export function formatFxRate(rateE4: bigint): string {
  return `${rateE4 / 10000n},${(rateE4 % 10000n).toString().padStart(4, '0')}`;
}

/**
 * Conversión USDT → Bs para pagar un retiro (W4): micro-USDT × tasa(×10⁴) / 10⁸ = céntimos de Bs,
 * redondeando hacia abajo (la fracción no se cobra a la agencia: se descuenta exactamente el USDT pedido).
 */
export function usdtToVesCents(usdtMicro: bigint, rateE4: bigint): bigint {
  if (usdtMicro <= 0n || rateE4 <= 0n) throw new Error('Monto o tasa no positivos');
  return (usdtMicro * rateE4) / 100_000_000n;
}

/** Variación relativa entre dos tasas en puntos básicos (para la alerta de > 10 %). */
export function fxChangeBps(previousE4: bigint, nextE4: bigint): number {
  const diff = nextE4 > previousE4 ? nextE4 - previousE4 : previousE4 - nextE4;
  return Number((diff * 10000n) / previousE4);
}
