import { useEffect, useState } from 'react';

export type Currency = 'VES' | 'USDT';

export const CURRENCY: Record<Currency, { minor: number; symbol: string; display: number }> = {
  VES: { minor: 2, symbol: 'Bs.', display: 2 },
  USDT: { minor: 6, symbol: 'USDT', display: 2 },
};

/** Montos llegan del API como string en unidades mínimas; se formatean sin pasar por float. */
export function money(minorUnits: string | bigint | null | undefined, currency: Currency, opts: { full?: boolean } = {}): string {
  const v = BigInt(minorUnits ?? 0);
  const { minor, symbol, display } = CURRENCY[currency];
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const base = 10n ** BigInt(minor);
  const int = (abs / base).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  let frac = (abs % base).toString().padStart(minor, '0');
  if (!opts.full) frac = frac.slice(0, display);
  const amount = `${neg ? '-' : ''}${int},${frac}`;
  return currency === 'VES' ? `${symbol} ${amount}` : `${amount} ${symbol}`;
}

/** "12,50" o "12.50" → unidades mínimas como bigint (o null si es inválido). Sin separador de miles. */
export function toMinor(input: string, currency: Currency): bigint | null {
  const s = normalizeAmount(input);
  const { minor } = CURRENCY[currency];
  if (!new RegExp(`^\\d{1,15}(\\.\\d{1,${minor}})?$`).test(s)) return null;
  const [int, frac = ''] = s.split('.');
  return BigInt(int) * 10n ** BigInt(minor) + BigInt(frac.padEnd(minor, '0') || '0');
}

/** Para enviar al API: "12.50" con punto decimal. */
export function normalizeAmount(input: string): string {
  return input.trim().replace(',', '.');
}

const TZ = 'America/Caracas';

export function hour(iso: string) {
  return new Intl.DateTimeFormat('es-VE', { timeZone: TZ, hour: 'numeric', minute: '2-digit', hour12: true }).format(new Date(iso));
}

export function dateTime(iso: string) {
  return new Intl.DateTimeFormat('es-VE', {
    timeZone: TZ,
    day: '2-digit',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(new Date(iso));
}

export function todayCaracas(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(date);
}

/** Reloj sincronizado con el servidor (el cierre de venta lo decide el servidor, esto solo es visual). */
let serverOffsetMs = 0;
export function syncServerClock(serverNowIso: string | undefined) {
  if (serverNowIso) serverOffsetMs = new Date(serverNowIso).getTime() - Date.now();
}
export const serverNow = () => Date.now() + serverOffsetMs;

export function useNow(intervalMs = 1000) {
  const [now, setNow] = useState(serverNow());
  useEffect(() => {
    const id = setInterval(() => setNow(serverNow()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

export function countdown(targetIso: string, now: number) {
  const ms = new Date(targetIso).getTime() - now;
  if (ms <= 0) return null;
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0 ? `${h}h ${m.toString().padStart(2, '0')}m` : `${m}:${sec.toString().padStart(2, '0')}`;
}

export const DRAW_STATUS_LABEL: Record<string, string> = {
  SCHEDULED: 'Programado',
  OPEN: 'En venta',
  CLOSED: 'Cerrado',
  RESULT_PENDING: 'Resultado por confirmar',
  RESULT_CONFIRMED: 'Resultado confirmado',
  SETTLED: 'Liquidado',
  CANCELLED: 'Anulado',
};

export const TICKET_STATUS_LABEL: Record<string, string> = {
  OPEN: 'En juego',
  WON: 'Ganador',
  LOST: 'No ganó',
  VOID: 'Anulado',
  CANCELLED: 'Anulado',
};
