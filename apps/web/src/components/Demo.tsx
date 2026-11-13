/**
 * Avisos de aplicación DEMO. Fortuna.Bet es una demostración: los saldos, bonos, premios y precios no tienen valor real,
 * no hay pagos reales y no se permite su comercialización. Se muestra en todas las pantallas para evitar malentendidos.
 */

export const DEMO_SHORT = 'APLICACIÓN DEMO · Sin valor real · Prohibida su comercialización';

export const DEMO_TEXT =
  'Fortuna.Bet es una aplicación de demostración. Los saldos, bonos, apuestas, premios y operaciones no tienen valor real, ' +
  'no se aceptan ni se pagan montos reales y no está autorizada por ningún ente regulador. ' +
  'Se prohíbe su comercialización, reventa o uso con fines comerciales.';

/** Franja fija bajo el encabezado, visible en todas las pantallas (jugador y backoffice). */
export function DemoBanner({ dark = false }: { dark?: boolean }) {
  return (
    <div
      role="note"
      aria-label="Aviso de aplicación demo"
      className={`px-3 py-1 text-center text-[11px] leading-tight font-bold tracking-wide sm:text-xs ${
        dark ? 'bg-amber-400 text-amber-950' : 'bg-amber-300 text-amber-950'
      }`}
    >
      ⚠️ {DEMO_SHORT}
    </div>
  );
}

/** Recuadro con el aviso completo (entrar, registro, billetera, pie de página). */
export function DemoNotice({ className = '' }: { className?: string }) {
  return (
    <div role="note" className={`rounded-xl bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-900 ring-1 ring-amber-200 ${className}`}>
      <b>Aplicación DEMO.</b> {DEMO_TEXT}
    </div>
  );
}
