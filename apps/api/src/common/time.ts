export const OPERATING_TZ = 'America/Caracas';

/** Fecha local (YYYY-MM-DD) en la zona operativa. */
export function localDate(date = new Date(), timeZone = OPERATING_TZ): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}
