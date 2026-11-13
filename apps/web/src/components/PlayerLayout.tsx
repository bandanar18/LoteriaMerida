import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { money } from '../lib/format';
import { useBalances, usePlatform } from '../lib/queries';
import { LiveDot } from '../lib/realtime';
import { DemoBanner, DemoNotice } from './Demo';
import { HomeExtras } from './HomeExtras';
import { HomeHero } from './HomeHero';

/** Barra inferior en el celular: lo del jugador (la casa de apuestas va en el menú de arriba). */
const NAV = [
  { to: '/', label: 'Jugar', icon: '🎲', end: true },
  { to: '/futuros', label: 'Futuros', icon: '📈' },
  { to: '/tickets', label: 'Jugadas', icon: '🎟️' },
  { to: '/resultados', label: 'Resultados', icon: '📋' },
  { to: '/billetera', label: 'Billetera', icon: '💰' },
  { to: '/cuenta', label: 'Cuenta', icon: '👤' },
];

/**
 * Menú de la casa de apuestas. Las secciones disponibles tienen una ruta propia.
 */
type SiteItem = { label: string; to?: string; end?: boolean; anchor?: string };
const SITE: SiteItem[] = [
  { label: 'Inicio', to: '/', end: true },
  { label: 'Deportes', to: '/deportes' },
  { label: 'Casino', to: '/casino' },
  { label: 'Lotería', to: '/', anchor: 'juegos' },
  { label: 'Hipismo' },
  { label: 'Promociones' },
  { label: 'Resultados', to: '/resultados' },
];

export function Logo({ compact = false }: { compact?: boolean }) {
  return (
    <Link to="/" className="group flex shrink-0 flex-col leading-none whitespace-nowrap" aria-label="Fortuna.Bet, inicio">
      <span className="flex flex-nowrap items-end">
        <span className="font-display text-[1.4rem] font-black tracking-tight text-white italic drop-shadow-[0_2px_0_rgba(0,0,0,.35)] sm:text-[2rem]">
          F
          <span className="relative mx-[1px] inline-block translate-y-[1px] text-[0.95em] not-italic" aria-hidden="true">
            🍀
          </span>
          RTUNA
        </span>
        {/* Fortuna.Bet: el punto dorado separa la marca. */}
        <span className="mx-[2px] mb-[0.3rem] inline-block h-[0.45rem] w-[0.45rem] rounded-full bg-oro-400 shadow-[0_0_6px_rgba(244,201,79,.7)] sm:mb-[0.4rem] sm:h-2 sm:w-2" aria-hidden="true" />
        <span className="font-script translate-y-1 text-[1.15rem] text-oro-400 drop-shadow-[0_2px_0_rgba(0,0,0,.4)] sm:text-[1.7rem]">Bet</span>
      </span>
      {!compact && (
        <span className="mt-1 hidden text-[9px] font-semibold tracking-[0.14em] text-white/80 uppercase sm:block">La suerte también juega aquí</span>
      )}
    </Link>
  );
}

function SiteNav({ className = '' }: { className?: string }) {
  const navigate = useNavigate();
  const goTo = (anchor: string) => {
    navigate('/');
    // Espera a que la portada esté en pantalla y baja a los juegos.
    setTimeout(() => document.getElementById(anchor)?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 60);
  };
  const base = 'relative whitespace-nowrap px-1 py-2 text-[15px] font-semibold transition-colors';
  const line = 'after:absolute after:inset-x-1 after:-bottom-0.5 after:h-[3px] after:rounded-full after:bg-lima-500';
  return (
    <nav aria-label="Secciones" className={className}>
      {SITE.map((item) =>
        item.anchor ? (
          <button key={item.label} type="button" onClick={() => goTo(item.anchor!)} className={`${base} text-white/85 hover:text-white`}>
            {item.label}
          </button>
        ) : item.to ? (
          <NavLink
            key={item.label}
            to={item.to}
            end={item.end}
            className={({ isActive }) => `${base} ${isActive ? `text-lima-400 ${line}` : 'text-white/85 hover:text-white'}`}
          >
            {item.label}
          </NavLink>
        ) : (
          // Sin producto todavía: visible, sin enlace.
          <span key={item.label} className={`${base} cursor-default text-white/85`} title="Próximamente">
            {item.label}
          </span>
        ),
      )}
    </nav>
  );
}

const SearchIcon = () => (
  <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true">
    <circle cx="10.5" cy="10.5" r="6.5" />
    <path d="m15.5 15.5 5 5" />
  </svg>
);
const UserIcon = () => (
  <svg viewBox="0 0 24 24" className="h-5 w-5" fill="currentColor" aria-hidden="true">
    <circle cx="12" cy="8" r="4.2" />
    <path d="M3.5 21c.6-4.4 4-7 8.5-7s7.9 2.6 8.5 7z" />
  </svg>
);

export function PlayerLayout() {
  const { user, logout } = useAuth();
  const isPlayer = user?.kind === 'PLAYER';
  const balances = useBalances(isPlayer);
  const platform = usePlatform();
  const { pathname } = useLocation();
  const hideFutures = platform.data?.futuresEnabled !== true;
  const nav = hideFutures ? NAV.filter((item) => item.to !== '/futuros') : NAV;
  const home = pathname === '/';

  return (
    <div className="player-dark flex min-h-dvh flex-col pb-[calc(3.5rem+env(safe-area-inset-bottom))] md:pb-0">
      <header className="sticky top-0 z-40 bg-gradient-to-b from-[#0a2a1c] to-[#0c3322] text-white shadow-[0_2px_12px_rgba(0,0,0,.35)]">
        <div className="flex w-full items-center gap-3 px-4 sm:px-6 lg:px-10 2xl:px-14 py-2 sm:py-2.5 lg:gap-6">
          <Logo />
          <SiteNav className="ml-2 hidden min-w-0 flex-1 items-center justify-center gap-4 xl:flex 2xl:ml-4 2xl:gap-7" />
          <div className="ml-auto flex shrink-0 items-center gap-2 xl:ml-0">
            <span className="hidden cursor-default p-1.5 text-white/90 sm:block" title="Buscar · próximamente" aria-hidden="true">
              <SearchIcon />
            </span>
            <span className="hidden sm:block">
              <LiveDot dark />
            </span>
            {isPlayer && balances.data && (
              <Link to="/billetera" className="flex flex-col items-end rounded-lg bg-white/10 px-3 py-1 text-right leading-tight ring-1 ring-white/15 hover:bg-white/15">
                {balances.data.map((b) => (
                  <span key={b.currency} className="text-xs font-semibold tabular-nums">
                    {money(b.cash, b.currency)}
                  </span>
                ))}
              </Link>
            )}
            {isPlayer && (
              <span className="hidden items-center gap-1 md:flex">
                {nav
                  .filter((n) => !['/', '/resultados', '/billetera'].includes(n.to))
                  .map((n) => (
                    <NavLink
                      key={n.to}
                      to={n.to}
                      className={({ isActive }) => `rounded-lg px-2.5 py-1.5 text-sm ${isActive ? 'bg-white/15 font-semibold' : 'text-white/80 hover:bg-white/10'}`}
                    >
                      {n.label}
                    </NavLink>
                  ))}
              </span>
            )}
            {user?.kind === 'STAFF' && (
              <Link to="/admin" className="btn-gold px-3 py-1.5">
                Backoffice
              </Link>
            )}
            {user ? (
              <button className="rounded-lg px-2 py-1.5 text-sm text-white/80 hover:bg-white/10" onClick={logout}>
                Salir
              </button>
            ) : (
              <>
                <Link
                  to="/login"
                  className="flex items-center gap-2 rounded-xl px-3 py-2 text-sm font-semibold whitespace-nowrap ring-1 ring-white/70 hover:bg-white/10 sm:px-5 sm:py-2.5"
                >
                  <UserIcon />
                  <span className="hidden sm:inline">Iniciar sesión</span>
                  <span className="sm:hidden">Entrar</span>
                </Link>
                <Link
                  to="/registro"
                  className="flex items-center gap-2 rounded-xl whitespace-nowrap bg-gradient-to-b from-lima-400 to-lima-600 px-3 py-2 text-sm font-bold text-selva-950 shadow-[0_0_18px_rgba(111,209,42,.45)] hover:brightness-105 sm:px-5 sm:py-2.5"
                >
                  <span className="hidden sm:inline">
                    <UserIcon />
                  </span>
                  Registrarse
                </Link>
              </>
            )}
          </div>
        </div>
        <SiteNav className="no-scrollbar flex gap-5 overflow-x-auto border-t border-white/10 px-4 sm:px-6 lg:px-10 xl:hidden" />
        <DemoBanner />
      </header>

      {home && <HomeHero signedIn={!!user} />}

      <main className={`mx-auto w-full flex-1 ${home ? 'px-4 sm:px-6 lg:px-10 2xl:px-14 py-7 lg:py-9' : 'max-w-6xl px-4 py-5'}`}>
        <Outlet />
      </main>

      {home && <HomeExtras />}

      <SiteFooter license={platform.data?.licenseLabel} />

      <nav className={`fixed inset-x-0 bottom-0 z-40 grid ${hideFutures ? 'grid-cols-5' : 'grid-cols-6'} border-t border-white/10 bg-[#0a2219]/95 pb-[env(safe-area-inset-bottom)] backdrop-blur md:hidden`}>
        {nav.map((n) => (
          <NavLink
            key={n.to}
            to={n.to}
            end={n.end}
            className={({ isActive }) => `flex h-14 flex-col items-center justify-center gap-0.5 text-[10px] leading-tight ${isActive ? 'font-semibold text-lima-400' : 'text-white/55'}`}
          >
            <span className="text-lg leading-none">{n.icon}</span>
            {n.label}
          </NavLink>
        ))}
      </nav>
    </div>
  );
}

/** Redes sociales: íconos sin enlace hasta que existan las cuentas. */
const SOCIAL: { label: string; path: string }[] = [
  { label: 'Instagram', path: 'M7.5 3h9A4.5 4.5 0 0 1 21 7.5v9a4.5 4.5 0 0 1-4.5 4.5h-9A4.5 4.5 0 0 1 3 16.5v-9A4.5 4.5 0 0 1 7.5 3Zm4.5 5a4 4 0 1 0 0 8 4 4 0 0 0 0-8Zm5-1.5a1 1 0 1 0 0 2 1 1 0 0 0 0-2Z' },
  { label: 'Facebook', path: 'M13.5 21v-7.5h2.6l.4-3h-3V8.6c0-.9.3-1.5 1.6-1.5h1.6V4.4a21 21 0 0 0-2.4-.1c-2.4 0-4 1.5-4 4.1v2.1H7.7v3h2.6V21Z' },
  { label: 'X', path: 'M4 4h4.6l3.6 5 4.2-5H19l-5.6 6.5L20 20h-4.6l-3.9-5.4L6.8 20H4.3l6-7Z' },
  { label: 'YouTube', path: 'M21.6 7.2a2.6 2.6 0 0 0-1.8-1.8C18.2 5 12 5 12 5s-6.2 0-7.8.4A2.6 2.6 0 0 0 2.4 7.2 27 27 0 0 0 2 12a27 27 0 0 0 .4 4.8 2.6 2.6 0 0 0 1.8 1.8C5.8 19 12 19 12 19s6.2 0 7.8-.4a2.6 2.6 0 0 0 1.8-1.8A27 27 0 0 0 22 12a27 27 0 0 0-.4-4.8ZM10 15V9l5.2 3Z' },
];

/** Enlaces legales e informativos: sin páginas todavía se muestran sin enlace. */
const FOOTER_LINKS: { label: string; to?: string }[] = [
  { label: 'Nosotros' },
  { label: 'Términos y Condiciones' },
  { label: 'Juego Responsable', to: '/cuenta' },
  { label: 'Política de Privacidad' },
  { label: 'Preguntas Frecuentes', to: '/preguntas-frecuentes' },
  { label: 'Contacto' },
];

function SiteFooter({ license }: { license?: string }) {
  return (
    <footer className="relative overflow-hidden border-t border-white/10 bg-gradient-to-b from-[#0b2419] to-[#06140e] text-white">
      <div className="flex flex-col items-center gap-8 px-4 py-10 text-center sm:px-6 lg:px-10 lg:py-12 xl:flex-row xl:justify-between xl:gap-12 xl:text-left 2xl:px-14">
        <div className="flex flex-col items-center gap-6 sm:flex-row sm:gap-10">
          <div className="origin-center scale-150 sm:origin-left 2xl:scale-[1.75]">
            <Logo />
          </div>
          <span className="hidden h-20 w-px bg-white/20 sm:ml-16 sm:block 2xl:ml-24" aria-hidden="true" />
          <span className="font-script text-3xl leading-tight whitespace-nowrap text-white/90 sm:text-4xl">
            Nuestra tierra
            <br />
            también juega
          </span>
        </div>
        <nav aria-label="Información" className="grid grid-cols-2 gap-x-8 gap-y-3 text-base text-white/85 sm:grid-cols-3 xl:text-lg">
          {FOOTER_LINKS.map((l) =>
            l.to ? (
              <Link key={l.label} to={l.to} className="hover:text-lima-400">
                {l.label}
              </Link>
            ) : (
              <span key={l.label} className="cursor-default" title="Próximamente">
                {l.label}
              </span>
            ),
          )}
        </nav>
        <ul className="flex items-center gap-6" aria-label="Redes sociales (próximamente)">
          {SOCIAL.map((x) => (
            <li key={x.label} title={`${x.label} · próximamente`}>
              <svg viewBox="0 0 24 24" className="h-9 w-9 fill-white/90" role="img" aria-label={x.label}>
                <path d={x.path} fillRule="evenodd" />
              </svg>
            </li>
          ))}
        </ul>
      </div>
      <div className="border-t border-white/10 px-4 py-5 text-center text-xs text-white/55 sm:px-6 lg:px-10">
        <DemoNotice className="mx-auto mb-3 max-w-3xl text-left" />
        <p>{license}</p>
        <p className="mt-1">Solo mayores de 18 años · Juega con responsabilidad · Horario: America/Caracas</p>
      </div>
      {/* Tricolor de Venezuela en el borde inferior. */}
      <div className="h-1.5 bg-gradient-to-r from-[#fcd116] via-[#0033a0] to-[#ce1126]" aria-hidden="true" />
    </footer>
  );
}
