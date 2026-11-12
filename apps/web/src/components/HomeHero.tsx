import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import heroArt from '../assets/home-hero.jpg';

/** Íconos de confianza bajo el llamado a registrarse. */
const FEATURES: { label: string; icon: ReactNode }[] = [
  {
    label: 'Seguro y confiable',
    icon: (
      <svg viewBox="0 0 24 24" className="h-8 w-8" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" aria-hidden="true">
        <path d="M12 2.8 4.5 5.6v5.9c0 4.6 3.1 8.4 7.5 9.7 4.4-1.3 7.5-5.1 7.5-9.7V5.6z" />
        <path d="m8.6 12 2.4 2.4 4.6-4.8" strokeLinecap="round" />
      </svg>
    ),
  },
  {
    label: 'Resultados verificables',
    icon: (
      <svg viewBox="0 0 24 24" className="h-8 w-8" fill="currentColor" aria-hidden="true">
        <path d="M13.5 2 5 13.5h6L9.8 22 19 10.2h-6.2z" />
      </svg>
    ),
  },
  {
    label: 'Disponible en web y móvil',
    icon: (
      <svg viewBox="0 0 24 24" className="h-8 w-8" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
        <rect x="6.5" y="2.5" width="11" height="19" rx="2.2" />
        <path d="M10.5 18.5h3" strokeLinecap="round" />
      </svg>
    ),
  },
  {
    label: 'Juego responsable',
    icon: (
      <svg viewBox="0 0 24 24" className="h-8 w-8" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
        <path d="M4.5 13v-1.5a7.5 7.5 0 0 1 15 0V13" />
        <rect x="3" y="12.5" width="4" height="6" rx="1.5" />
        <rect x="17" y="12.5" width="4" height="6" rx="1.5" />
        <path d="M19 18.5c0 1.6-2 2.5-5 2.5" />
      </svg>
    ),
  },
];

/**
 * Portada de la casa de apuestas (parte superior del inicio). Debajo sigue la pantalla de juegos de siempre.
 * Solo hay lotería por ahora: el resto de secciones se nombra pero no se enlaza.
 */
export function HomeHero({ signedIn }: { signedIn: boolean }) {
  const toGames = () => document.getElementById('juegos')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  const cta = 'inline-flex items-center gap-3 rounded-xl bg-gradient-to-b from-lima-400 to-lima-600 px-6 py-3.5 font-display text-xl font-extrabold tracking-wide text-selva-950 uppercase italic shadow-[0_0_24px_rgba(111,209,42,.5)] transition hover:brightness-105 active:scale-[0.98] sm:text-2xl';
  const arrow = (
    <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 12h15M13 6l6 6-6 6" />
    </svg>
  );

  return (
    <section aria-label="Portada" className="relative isolate overflow-hidden bg-[#0b2a1d] text-white">
      {/* Ilustración: a la derecha en escritorio, de fondo atenuado en el celular. */}
      <img
        src={heroArt}
        alt="Fútbol, casino, lotería e hipismo en los Andes merideños"
        className="absolute inset-0 -z-20 h-full w-full object-cover object-[70%_center] md:left-auto md:w-[64%] md:object-center"
      />
      <div className="absolute inset-0 -z-10 bg-gradient-to-t from-[#0b2a1d] via-[#0b2a1d]/80 to-[#0b2a1d]/30 md:bg-gradient-to-r md:from-[#0b2a1d] md:via-[#0b2a1d]/95 md:via-38% md:to-transparent md:to-60%" />

      <div className="flex w-full flex-col px-4 sm:px-6 lg:px-10 2xl:px-14 pt-40 pb-7 sm:pt-56 md:min-h-[30rem] md:justify-center md:py-12 lg:min-h-[34rem]">
        <div className="max-w-xl">
          <h1 className="font-display text-[2.75rem] leading-[0.92] font-black tracking-tight uppercase italic drop-shadow-[0_3px_6px_rgba(0,0,0,.55)] sm:text-6xl lg:text-7xl">
            Tu pasión
            <br />
            también es
            <br />
            <span className="bg-gradient-to-b from-lima-400 to-lima-500 bg-clip-text text-transparent drop-shadow-none">nuestra suerte</span>
          </h1>
          <p className="mt-4 max-w-md text-base leading-snug text-white/90 drop-shadow sm:text-lg">
            Deportes, Casino, Lotería, <span className="font-semibold text-oro-400">Hipismo y más.</span> Todo en un solo lugar, con los
            juegos de Mérida y resultados que puedes verificar.
          </p>
          <div className="mt-6">
            {signedIn ? (
              <button type="button" onClick={toGames} className={cta}>
                ¡Juega ahora! {arrow}
              </button>
            ) : (
              <Link to="/registro" className={cta}>
                ¡Regístrate ahora! {arrow}
              </Link>
            )}
          </div>
          <ul className="mt-7 grid max-w-lg grid-cols-4 gap-2 text-center text-[11px] leading-tight text-white/90 sm:text-xs">
            {FEATURES.map((f) => (
              <li key={f.label} className="flex flex-col items-center gap-1.5">
                {f.icon}
                {f.label}
              </li>
            ))}
          </ul>
        </div>
      </div>

      {/* Alineada con el ancho del contenido (como el encabezado), para que nunca quede cortada en pantallas anchas. */}
      <div className="pointer-events-none absolute inset-x-0 bottom-5 hidden px-4 sm:px-6 lg:px-10 2xl:px-14 text-right md:block lg:bottom-7">
        <div className="inline-block -rotate-2 rounded-xl border-2 border-oro-400 bg-gradient-to-b from-red-600 to-red-800 px-5 py-2 font-display text-2xl leading-none font-black text-white uppercase italic shadow-lg lg:text-3xl">
          Los juegos de Mérida
        </div>
        <div className="mt-1.5 font-display text-lg font-extrabold text-lima-400 uppercase italic drop-shadow-[0_2px_3px_rgba(0,0,0,.7)] lg:text-xl">
          ¡Tu suerte nace en los Andes!
        </div>
      </div>
    </section>
  );
}
