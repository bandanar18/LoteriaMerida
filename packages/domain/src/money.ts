/**
 * Dinero siempre en unidades mínimas (bigint). Nunca punto flotante (Doc. Maestro §0, regla 1).
 */

export type CurrencyCode = 'VES' | 'USDT';

export const CURRENCIES: Record<CurrencyCode, { minorUnit: number; symbol: string; isCrypto: boolean }> = {
  VES: { minorUnit: 2, symbol: 'Bs.', isCrypto: false },
  USDT: { minorUnit: 6, symbol: 'USDT', isCrypto: true },
};

export function isCurrency(code: string): code is CurrencyCode {
  return code in CURRENCIES;
}

/** Convierte "12.50" → 1250n (VES). Rechaza más decimales de los permitidos, signos y notación científica. */
export function parseAmount(input: string, currency: CurrencyCode): bigint {
  const { minorUnit } = CURRENCIES[currency];
  const s = input.trim().replace(',', '.');
  const re = new RegExp(`^\\d{1,15}(\\.\\d{1,${minorUnit}})?$`);
  if (!re.test(s)) throw new Error(`Monto inválido para ${currency}: "${input}"`);
  const [int, frac = ''] = s.split('.');
  return BigInt(int) * 10n ** BigInt(minorUnit) + BigInt(frac.padEnd(minorUnit, '0') || '0');
}

/** 1250n → "12.50" */
export function formatAmount(amount: bigint, currency: CurrencyCode): string {
  const { minorUnit } = CURRENCIES[currency];
  const neg = amount < 0n;
  const abs = neg ? -amount : amount;
  const base = 10n ** BigInt(minorUnit);
  const int = abs / base;
  const frac = (abs % base).toString().padStart(minorUnit, '0');
  return `${neg ? '-' : ''}${int}.${frac}`;
}

/** Multiplicadores y cuotas como enteros escalados ×100 ("30.00" → 3000). */
export function parseScaled100(value: string): bigint {
  const s = value.trim();
  if (!/^\d{1,8}(\.\d{1,2})?$/.test(s)) throw new Error(`Valor escalado inválido: "${value}"`);
  const [int, frac = ''] = s.split('.');
  return BigInt(int) * 100n + BigInt(frac.padEnd(2, '0'));
}

/** amount × multiplicador, redondeando hacia abajo a la unidad mínima. */
export function applyMultiplier(amount: bigint, multiplierX100: bigint): bigint {
  return (amount * multiplierX100) / 100n;
}
