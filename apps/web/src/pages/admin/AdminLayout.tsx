import { Link, NavLink, Outlet } from 'react-router-dom';
import { useAuth } from '../../lib/auth';
import { LiveDot } from '../../lib/realtime';

// Mismos roles que exige el API en cada sección (ADMIN ve todo).
const NAV: { to: string; label: string; end?: boolean; roles?: string[] }[] = [
  { to: '/admin', label: 'Dashboard', end: true },
  { to: '/admin/sorteos', label: 'Sorteos', roles: ['LOTTERY_OPERATOR', 'AUDITOR'] },
  { to: '/admin/deportes', label: 'Deportes', roles: ['SPORTS_TRADER', 'AUDITOR'] },
  { to: '/admin/pagos', label: 'Pagos', roles: ['CASHIER', 'AUDITOR'] },
  { to: '/admin/kyc', label: 'KYC', roles: ['COMPLIANCE', 'AUDITOR'] },
  { to: '/admin/jugadores', label: 'Jugadores' },
  { to: '/admin/auditoria', label: 'Auditoría', roles: ['AUDITOR'] },
];

const ROLE_LABEL: Record<string, string> = {
  ADMIN: 'Administrador',
  CASHIER: 'Cajero',
  LOTTERY_OPERATOR: 'Operador de sorteos',
  AUDITOR: 'Auditor',
  COMPLIANCE: 'Cumplimiento',
  SPORTS_TRADER: 'Trader deportivo',
};

export function AdminLayout() {
  const { user, logout } = useAuth();
  return (
    <div className="min-h-screen bg-[#eef1ee]">
      <header className="bg-selva-950 text-white">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-3 px-4 py-3">
          <Link to="/admin" className="font-extrabold">
            🦁 Tepuy <span className="text-oro-400">Backoffice</span>
          </Link>
          <nav className="flex flex-wrap gap-1">
            {NAV.filter((n) => !n.roles || user?.role === 'ADMIN' || n.roles.includes(user?.role ?? '')).map((n) => (
              <NavLink
                key={n.to}
                to={n.to}
                end={n.end}
                className={({ isActive }) => `rounded-lg px-3 py-1.5 text-sm ${isActive ? 'bg-white/15 font-semibold' : 'text-white/70 hover:bg-white/10'}`}
              >
                {n.label}
              </NavLink>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-3 text-sm">
            <LiveDot dark />
            <span className="text-white/60">{ROLE_LABEL[user?.role ?? ''] ?? user?.role}</span>
            <Link to="/" className="text-white/70 hover:text-white">
              Ver sitio
            </Link>
            <button onClick={logout} className="text-white/70 hover:text-white">
              Salir
            </button>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-7xl px-4 py-5">
        <Outlet />
      </main>
    </div>
  );
}
