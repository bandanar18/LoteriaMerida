import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import appArt from '../assets/home-app.png';

/** Íconos de línea (blanco sobre círculo de color). */
const I = {
  store: (
    <svg viewBox="0 0 24 24" className="h-8 w-8" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" aria-hidden="true">
      <path d="M3.5 9.5 5 4.5h14l1.5 5" />
      <path d="M3.5 9.5a2.8 2.8 0 0 0 5.67 0 2.8 2.8 0 0 0 5.66 0 2.8 2.8 0 0 0 5.67 0" />
      <path d="M5 11.5v8h14v-8M9.5 19.5v-5h5v5" />
    </svg>
  ),
  monitor: (
    <svg viewBox="0 0 24 24" className="h-8 w-8" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="4" width="18" height="12" rx="1.8" />
      <path d="M9 20h6M12 16v4" strokeLinecap="round" />
    </svg>
  ),
  wallet: (
    <svg viewBox="0 0 24 24" className="h-8 w-8" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 7.5V18a1.5 1.5 0 0 0 1.5 1.5h13A1.5 1.5 0 0 0 20 18v-9a1.5 1.5 0 0 0-1.5-1.5H5.5A1.5 1.5 0 0 1 4 6v0a1.5 1.5 0 0 1 1.5-1.5H17" />
      <rect x="14.5" y="11" width="5.5" height="4" rx="1.2" />
    </svg>
  ),
  crown: (
    <svg viewBox="0 0 24 24" className="h-7 w-7" fill="currentColor" aria-hidden="true">
      <path d="M3 8.5 7.5 12 12 5l4.5 7L21 8.5 19 18H5z" />
      <rect x="5" y="19" width="14" height="1.8" rx=".9" />
    </svg>
  ),
  shield: (
    <svg viewBox="0 0 24 24" className="h-7 w-7" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 2.8 4.5 5.6v5.9c0 4.6 3.1 8.4 7.5 9.7 4.4-1.3 7.5-5.1 7.5-9.7V5.6z" />
      <path d="m8.6 12 2.4 2.4 4.6-4.8" strokeLinecap="round" />
    </svg>
  ),
  coins: (
    <svg viewBox="0 0 24 24" className="h-7 w-7" fill="none" stroke="currentColor" strokeWidth="1.9" aria-hidden="true">
      <ellipse cx="9" cy="7" rx="5.5" ry="2.5" />
      <path d="M3.5 7v4c0 1.4 2.5 2.5 5.5 2.5s5.5-1.1 5.5-2.5V7" />
      <path d="M9.5 16.5c.9.3 2 .5 3.2.5 3 0 5.5-1.1 5.5-2.5v-4c0-1-1.2-1.8-3-2.2" />
      <path d="M18.2 14.5v4c0 1.4-2.5 2.5-5.5 2.5-1.6 0-3-.3-4-.8" />
    </svg>
  ),
  check: (
    <svg viewBox="0 0 24 24" className="h-7 w-7" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="m8 12.3 2.7 2.7L16.2 9.4" />
    </svg>
  ),
};

function Channel({ icon, color, title, children }: { icon: ReactNode; color: string; title: string; children: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-3xl bg-white/[0.06] px-5 py-8 text-center ring-1 ring-white/10 backdrop-blur-sm xl:py-10">
      <span className={`flex h-20 w-20 items-center justify-center rounded-full text-white shadow-[0_8px_20px_rgba(0,0,0,.4)] ring-4 ring-white/10 xl:h-24 xl:w-24 [&>svg]:h-10 [&>svg]:w-10 xl:[&>svg]:h-12 xl:[&>svg]:w-12 ${color}`}>{icon}</span>
      <h3 className="title-display mt-5 text-[1.7rem] text-white xl:text-[2.1rem]">{title}</h3>
      <p className="mt-2 text-base leading-snug text-white/70 xl:text-lg">{children}</p>
    </div>
  );
}

/**
 * Parte final del inicio: «Juega donde quieras» con los canales y la franja de garantías.
 * DEMO: no hay app publicada ni centros físicos todavía, así que se anuncian como próximamente.
 */
export function HomeExtras() {
  return (
    <section aria-label="Juega donde quieras" className="mt-4 border-t border-white/10">
      <div className="relative overflow-hidden">
        {/* Fondo: degradado verde con un brillo, sin foto (todo el sitio es verde). */}
        <div className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(900px_400px_at_75%_20%,rgba(111,209,42,.12),transparent_60%),linear-gradient(180deg,#0c2a1d,#081c13)]" />
        <div className="grid items-center gap-10 px-4 py-12 sm:px-6 lg:py-16 min-[1700px]:grid-cols-[minmax(0,1.1fr)_minmax(0,1.5fr)] lg:px-10 2xl:px-14">
          <div className="flex flex-col items-center justify-center gap-8 sm:flex-row sm:items-center">
            <img
              src={appArt}
              alt="La app de Fortuna.Bet en dos teléfonos"
              className="w-64 shrink-0 rounded-3xl object-cover shadow-[0_18px_40px_rgba(0,0,0,.5)] ring-1 ring-white/15 sm:w-72 2xl:w-80"
              loading="lazy"
            />
            <div className="text-center sm:text-left">
              <h2 className="title-display flex items-center justify-center gap-4 text-4xl text-white sm:justify-start sm:text-5xl 2xl:text-6xl">
                <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full bg-gradient-to-b from-lima-400 to-lima-600 text-selva-950 2xl:h-16 2xl:w-16" aria-hidden="true">
                  <svg viewBox="0 0 24 24" className="h-8 w-8" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
                    <rect x="7" y="2.5" width="10" height="19" rx="2.2" />
                    <path d="M11 18.5h2" />
                  </svg>
                </span>
                Juega donde quieras
              </h2>
              <p className="mt-3 max-w-md text-lg leading-snug text-white/80 2xl:text-xl">Desde nuestros centros de apuesta, agencias autorizadas o en línea.</p>
              <div className="mt-6 flex flex-col items-center gap-3 sm:items-start">
                <span className="btn-lime cursor-default px-8 py-4 text-lg opacity-90" title="La app aún no está publicada">
                  📲 App móvil · Próximamente
                </span>
                <span className="max-w-md text-sm text-white/55">Mientras tanto, juega desde el navegador de tu teléfono: la web está hecha para el celular.</span>
              </div>
            </div>
          </div>
          <div className="grid gap-4 sm:grid-cols-3 sm:gap-5">
            <Channel icon={I.store} color="bg-gradient-to-b from-green-500 to-green-700" title="Centros de apuesta">
              Próximamente en el Estado Mérida
            </Channel>
            <Channel icon={I.monitor} color="bg-gradient-to-b from-red-500 to-red-700" title="Agencias online">
              Genera ingresos con tu enlace de referido
            </Channel>
            <Channel icon={I.wallet} color="bg-gradient-to-b from-blue-500 to-blue-700" title="Billetera virtual">
              Saldo en Bs. y USDT, siempre a la vista
            </Channel>
          </div>
        </div>
      </div>

      {/* Franja de garantías. */}
      <ul className="grid gap-6 border-y border-white/10 bg-black/20 px-4 py-8 sm:grid-cols-2 sm:px-6 lg:grid-cols-4 lg:px-10 lg:py-10 2xl:px-14">
        {[
          [I.crown, 'Juego responsable', '+18 | Juega con moderación', '/cuenta'],
          [I.shield, 'Seguridad y confianza', 'Cuentas y movimientos protegidos', null],
          [I.check, 'Resultados verificables', 'Cada sorteo se puede comprobar', '/resultados'],
          [I.coins, 'Bolívares y USDT', 'Juega en la moneda que prefieras', '/billetera'],
        ].map(([icon, title, text, to]) => {
          const body = (
            <>
              <span className="flex h-16 w-16 shrink-0 items-center justify-center rounded-full bg-gradient-to-b from-[#1b7a58] to-[#0f3d2a] text-white ring-1 ring-white/15 xl:h-[4.5rem] xl:w-[4.5rem] [&>svg]:h-9 [&>svg]:w-9">{icon}</span>
              <span>
                <span className="title-display block text-[1.35rem] text-white 2xl:text-[1.7rem]">{title as string}</span>
                <span className="block text-base text-white/65">{text as string}</span>
              </span>
            </>
          );
          return (
            <li key={title as string}>
              {to ? (
                <Link to={to as string} className="flex items-center gap-4 rounded-xl p-1 transition hover:bg-white/5">
                  {body}
                </Link>
              ) : (
                <div className="flex items-center gap-4 p-1">{body}</div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
