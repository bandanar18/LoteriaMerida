/**
 * Código de agencia (Programa de Agencias Virtuales): se guarda 30 días en el navegador al abrir
 * /r/<código> (el QR de la Wallet) y se usa al registrarse. Si el almacenamiento falla, solo se pierde la comodidad.
 */
const KEY = 'fb.referral';
const TTL_MS = 30 * 86_400_000;

export function storeReferral(code: string) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ code: code.slice(0, 20), until: Date.now() + TTL_MS }));
  } catch {
    /* sin almacenamiento */
  }
}

export function readReferral(): string {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return '';
    const { code, until } = JSON.parse(raw);
    if (typeof code !== 'string' || Date.now() > until) {
      localStorage.removeItem(KEY);
      return '';
    }
    return code;
  } catch {
    return '';
  }
}

export function clearReferral() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* sin almacenamiento */
  }
}
