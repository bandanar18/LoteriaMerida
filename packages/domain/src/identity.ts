export const MIN_AGE = 18;

/** birthDate en formato YYYY-MM-DD; today en la zona operativa (America/Caracas) como YYYY-MM-DD. */
export function ageOn(birthDate: string, today: string): number {
  const [by, bm, bd] = birthDate.split('-').map(Number);
  const [ty, tm, td] = today.split('-').map(Number);
  let age = ty - by;
  if (tm < bm || (tm === bm && td < bd)) age--;
  return age;
}

export function isAdult(birthDate: string, today: string, minAge = MIN_AGE): boolean {
  return ageOn(birthDate, today) >= minAge;
}

/** Cédula venezolana: V o E + 6 a 9 dígitos. Pasaporte: 6–20 alfanuméricos. */
export function isValidDocument(type: 'V' | 'E' | 'P', number: string): boolean {
  if (type === 'P') return /^[A-Z0-9]{6,20}$/i.test(number);
  return /^\d{6,9}$/.test(number);
}

/** Teléfono venezolano en formato 58XXXXXXXXXX (operadoras 412/414/416/424/426 y fijos). */
export function normalizeVePhone(raw: string): string | null {
  const digits = raw.replace(/\D/g, '');
  const local = digits.startsWith('58') ? digits.slice(2) : digits.startsWith('0') ? digits.slice(1) : digits;
  return /^[24]\d{9}$/.test(local) ? `58${local}` : null;
}
