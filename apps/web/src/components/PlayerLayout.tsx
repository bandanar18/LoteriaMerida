import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { money } from '../lib/format';
import { useBalances, usePlatform } from '../lib/queries';
import { LiveDot } from '../lib/realtime';
import { DemoBanner, DemoNotice } from './Demo';
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
 * Menú de la casa de apuestas. Por ahora solo hay lotería: las secciones sin producto se muestran,
 * pero no llevan a ningún lado.
 */
type SiteItem = { label: string; to?: string; end?: boolean; anchor?: string };
const SITE: SiteItem[] = [
  { label: 'Inicio', to: '/', end: true },
  { label: 'Deportes' },
  { label: 'Casino' },
  { label: 'Lotería', to: '/', anchor: 'juegos' },
  { label: 'Hipismo' },
  { label: 'Promociones' },
  { label: 'Resultados', to: '/resultados' },
];

export function Logo({ compact = false }: { compact?: boolean }) {
  return (
    <Link to="/" className="group flex shrink-0 flex-col leading-none" aria-label="FortunaBet, inicio">
      <span className="flex items-end">
        <span className="font-display text-[1.65rem] font-black tracking-tight text-white italic drop-shadow-[0_2px_0_rgba(0,0,0,.35)] sm:text-[2rem]">
          F
          <span className="relative mx-[1px] inline-block translate-y-[1px] text-[0.95em] not-italic" aria-hidden="true">
            🍀
          </span>
          RTUNA
        </span>
        <span className="font-script -ml-1 translate-y-1 text-[1.35rem] text-oro-400 drop-shadow-[0_2px_0_rgba(0,0,0,.4)] sm:text-[1.7rem]">Bet</span>
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
            <LiveDot dark />
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

      <footer className="border-t border-white/10 bg-black/30 py-6 text-center text-xs text-white/55">
        <DemoNotice className="mx-auto mb-3 max-w-2xl text-left" />
        <p>{platform.data?.licenseLabel}</p>
        <p className="mt-1">Solo mayores de 18 años · Juega con responsabilidad · Horario: America/Caracas</p>
      </footer>

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
