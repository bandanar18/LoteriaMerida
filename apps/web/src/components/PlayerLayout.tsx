import { Link, NavLink, Outlet } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { money } from '../lib/format';
import { useBalances, usePlatform } from '../lib/queries';
import { LiveDot } from '../lib/realtime';

const NAV = [
  { to: '/', label: 'Jugar', icon: '🎲', end: true },
  { to: '/futuros', label: 'Futuros', icon: '📈' },
  { to: '/tickets', label: 'Jugadas', icon: '🎟️' },
  { to: '/resultados', label: 'Resultados', icon: '📋' },
  { to: '/billetera', label: 'Billetera', icon: '💰' },
  { to: '/cuenta', label: 'Cuenta', icon: '👤' },
];

export function PlayerLayout() {
  const { user, logout } = useAuth();
  const isPlayer = user?.kind === 'PLAYER';
  const balances = useBalances(isPlayer);
  const platform = usePlatform();

  return (
    <div className="flex min-h-dvh flex-col pb-[calc(3.5rem+env(safe-area-inset-bottom))] md:pb-0">
      <header className="sticky top-0 z-40 bg-selva-800 text-white shadow">
        <div className="mx-auto flex max-w-6xl items-center gap-2 px-4 py-2.5 sm:gap-3 sm:py-3">
          <Link to="/" className="flex shrink-0 items-center gap-2 text-lg font-extrabold tracking-tight">
            <span className="text-2xl">🦁</span>
            <span className="hidden min-[400px]:inline">
              Tepuy<span className="text-oro-400">Apuestas</span>
            </span>
          </Link>
          <nav className="ml-6 hidden gap-1 md:flex">
            {NAV.map((n) => (
              <NavLink
                key={n.to}
                to={n.to}
                end={n.end}
                className={({ isActive }) => `rounded-lg px-3 py-1.5 text-sm ${isActive ? 'bg-white/15 font-semibold' : 'text-white/80 hover:bg-white/10'}`}
              >
                {n.label}
              </NavLink>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-2">
            <LiveDot dark />
            {isPlayer && balances.data && (
              <Link to="/billetera" className="flex flex-col items-end rounded-lg bg-white/10 px-3 py-1 text-right leading-tight hover:bg-white/15">
                {balances.data.map((b) => (
                  <span key={b.currency} className="text-xs font-semibold tabular-nums">
                    {money(b.cash, b.currency)}
                  </span>
                ))}
              </Link>
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
                <Link to="/login" className="rounded-lg px-3 py-1.5 text-sm hover:bg-white/10">
                  Entrar
                </Link>
                <Link to="/registro" className="btn-gold px-3 py-1.5">
                  Registrarse
                </Link>
              </>
            )}
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-5">
        <Outlet />
      </main>

      <footer className="border-t border-black/5 bg-white/60 py-4 text-center text-xs text-black/50">
        <p>{platform.data?.licenseLabel}</p>
        <p className="mt-1">Solo mayores de 18 años · Juega con responsabilidad · Horario: America/Caracas</p>
      </footer>

      <nav className="fixed inset-x-0 bottom-0 z-40 grid grid-cols-6 border-t border-black/10 bg-white pb-[env(safe-area-inset-bottom)] md:hidden">
        {NAV.map((n) => (
          <NavLink
            key={n.to}
            to={n.to}
            end={n.end}
            className={({ isActive }) => `flex h-14 flex-col items-center justify-center gap-0.5 text-[10px] leading-tight ${isActive ? 'font-semibold text-selva-700' : 'text-black/50'}`}
          >
            <span className="text-lg leading-none">{n.icon}</span>
            {n.label}
          </NavLink>
        ))}
      </nav>
    </div>
  );
}
