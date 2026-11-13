import { ReactNode, useEffect, useState } from 'react';
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from '../../lib/auth';
import { usePlatform } from '../../lib/queries';
import { LiveDot } from '../../lib/realtime';
import { DemoBanner } from '../../components/Demo';

// ───────────── Íconos (trazo 1.75, 20×20) ─────────────

const ICONS: Record<string, ReactNode> = {
  dashboard: (
    <>
      <rect x="3" y="3" width="7" height="9" rx="1.5" />
      <rect x="14" y="3" width="7" height="5" rx="1.5" />
      <rect x="14" y="12" width="7" height="9" rx="1.5" />
      <rect x="3" y="16" width="7" height="5" rx="1.5" />
    </>
  ),
  draws: (
    <>
      <rect x="3" y="4" width="18" height="17" rx="2" />
      <path d="M8 2v4M16 2v4M3 10h18M8 14h.01M12 14h.01M16 14h.01M8 18h.01M12 18h.01" />
    </>
  ),
  risk: (
    <>
      <path d="M12 3 2.5 20h19L12 3Z" />
      <path d="M12 10v4M12 17h.01" />
    </>
  ),
  market: (
    <>
      <path d="M3 3v18h18" />
      <path d="M7 15l4-5 3 3 5-7" />
    </>
  ),
  sports: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="m12 7 4 3-1.5 4.5h-5L8 10l4-3ZM12 3v4M21 10l-5 0M3 10h5M7 20l2.5-5.5M17 20l-2.5-5.5" />
    </>
  ),
  payments: (
    <>
      <rect x="2" y="5" width="20" height="14" rx="2" />
      <path d="M2 10h20M6 15h4" />
    </>
  ),
  kyc: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <circle cx="9" cy="11" r="2.5" />
      <path d="M5.5 17c.7-1.8 2-2.7 3.5-2.7s2.8.9 3.5 2.7M15 9h3M15 13h3" />
    </>
  ),
  players: (
    <>
      <circle cx="9" cy="8" r="3.5" />
      <path d="M2.5 20c.8-3.5 3.4-5.5 6.5-5.5s5.7 2 6.5 5.5M16 4.5a3.5 3.5 0 0 1 0 7M18 14.8c1.8.7 3 2.5 3.5 5.2" />
    </>
  ),
  audit: (
    <>
      <path d="M12 3 4 6v6c0 4.5 3.4 8.2 8 9 4.6-.8 8-4.5 8-9V6l-8-3Z" />
      <path d="m8.5 12 2.5 2.5 4.5-5" />
    </>
  ),
  site: (
    <>
      <path d="M14 4h6v6M20 4l-9 9" />
      <path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />
    </>
  ),
  logout: (
    <>
      <path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3" />
      <path d="M10 17l-5-5 5-5M5 12h11" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2v3M12 19v3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M2 12h3M19 12h3M4.9 19.1 7 17M17 7l2.1-2.1" />
    </>
  ),
  menu: <path d="M4 7h16M4 12h16M4 17h16" />,
  close: <path d="M6 6l12 12M18 6 6 18" />,
  collapse: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M9 4v16M15 10l-2 2 2 2" />
    </>
  ),
};

function Icon({ name, className = 'h-5 w-5' }: { name: string; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
      {ICONS[name]}
    </svg>
  );
}

// ───────────── Navegación (mismos roles que exige el API; ADMIN ve todo) ─────────────

interface NavItem {
  to: string;
  label: string;
  icon: string;
  end?: boolean;
  roles?: string[];
}
const NAV: { title: string; items: NavItem[] }[] = [
  {
    title: 'General',
    items: [{ to: '/admin', label: 'Dashboard', icon: 'dashboard', end: true }],
  },
  {
    title: 'Lotería',
    items: [
      { to: '/admin/sorteos', label: 'Sorteos', icon: 'draws', roles: ['LOTTERY_OPERATOR', 'AUDITOR'] },
      { to: '/admin/riesgo', label: 'Riesgo', icon: 'risk', roles: ['LOTTERY_OPERATOR', 'AUDITOR'] },
      { to: '/admin/mercado', label: 'Mercado', icon: 'market', roles: ['LOTTERY_OPERATOR', 'AUDITOR'] },
      { to: '/admin/configuracion', label: 'Configuración', icon: 'settings', roles: ['LOTTERY_OPERATOR', 'AUDITOR'] },
    ],
  },
  {
    title: 'Futuros',
    items: [{ to: '/admin/futuros', label: 'Cumbre Futuros', icon: 'market', roles: ['LOTTERY_OPERATOR', 'AUDITOR'] }],
  },
  {
    title: 'Finanzas',
    items: [
      { to: '/admin/pagos', label: 'Pagos', icon: 'payments', roles: ['CASHIER', 'AUDITOR'] },
      { to: '/admin/agencias', label: 'Agencias', icon: 'players', roles: ['AUDITOR', 'COMPLIANCE'] },
    ],
  },
  {
    title: 'Cumplimiento',
    items: [
      { to: '/admin/kyc', label: 'Verificación KYC', icon: 'kyc', roles: ['COMPLIANCE', 'AUDITOR'] },
      { to: '/admin/jugadores', label: 'Jugadores', icon: 'players' },
      { to: '/admin/auditoria', label: 'Auditoría', icon: 'audit', roles: ['AUDITOR'] },
    ],
  },
];

const ROLE_LABEL: Record<string, string> = {
  ADMIN: 'Administrador',
  CASHIER: 'Cajero',
  LOTTERY_OPERATOR: 'Operador de sorteos',
  AUDITOR: 'Auditor',
  COMPLIANCE: 'Cumplimiento',
  SPORTS_TRADER: 'Trader deportivo',
};

const COLLAPSE_KEY = 'admin.sidebar.collapsed';
const readCollapsed = () => {
  try {
    return localStorage.getItem(COLLAPSE_KEY) === '1';
  } catch {
    return false;
  }
};

function useClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(t);
  }, []);
  return new Intl.DateTimeFormat('es-VE', {
    timeZone: 'America/Caracas',
    weekday: 'short',
    day: '2-digit',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
  }).format(now);
}

export function AdminLayout() {
  const { user, logout } = useAuth();
  const showFutures = usePlatform().data?.futuresEnabled === true;
  const location = useLocation();
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const [drawer, setDrawer] = useState(false);
  const clock = useClock();

  const role = user?.role ?? '';
  const groups = NAV.map((g) => ({
    ...g,
    items: g.items.filter((n) =>
      (showFutures || n.to !== '/admin/futuros') && (!n.roles || role === 'ADMIN' || n.roles.includes(role)),
    ),
  })).filter((g) => g.items.length);
  const all = groups.flatMap((g) => g.items.map((i) => ({ ...i, group: g.title })));
  const current =
    all.find((i) => (i.end ? location.pathname === i.to : location.pathname.startsWith(i.to))) ?? all.find((i) => i.to === '/admin');

  useEffect(() => setDrawer(false), [location.pathname]);
  useEffect(() => {
    try {
      localStorage.setItem(COLLAPSE_KEY, collapsed ? '1' : '0');
    } catch {
      /* sin almacenamiento: no pasa nada */
    }
  }, [collapsed]);

  const sidebar = (mini: boolean) => (
    <div className="flex h-full flex-col bg-[#0b1220] text-slate-300">
      <div className={`flex h-16 shrink-0 items-center gap-3 border-b border-white/[0.06] ${mini ? 'justify-center px-2' : 'px-5'}`}>
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-gradient-to-br from-amber-300 to-amber-500 text-lg shadow-inner">🍀</span>
        {!mini && (
          <div className="leading-tight">
            <p className="text-sm font-bold tracking-tight text-white">Fortuna.Bet</p>
            <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-slate-500">Backoffice</p>
          </div>
        )}
      </div>

      <nav className="flex-1 space-y-5 overflow-y-auto px-3 py-5" aria-label="Secciones del backoffice">
        {groups.map((g) => (
          <div key={g.title}>
            {mini ? (
              <div className="mx-auto mb-2 h-px w-6 bg-white/10" />
            ) : (
              <p className="mb-1.5 px-3 text-[10.5px] font-semibold uppercase tracking-[0.12em] text-slate-500">{g.title}</p>
            )}
            <ul className="space-y-0.5">
              {g.items.map((n) => (
                <li key={n.to}>
                  <NavLink
                    to={n.to}
                    end={n.end}
                    title={mini ? n.label : undefined}
                    className={({ isActive }) =>
                      `group relative flex items-center gap-3 rounded-lg py-2 text-sm transition ${mini ? 'justify-center px-2' : 'px-3'} ${
                        isActive ? 'bg-white/[0.08] font-semibold text-white' : 'text-slate-400 hover:bg-white/[0.04] hover:text-slate-100'
                      }`
                    }
                  >
                    {({ isActive }) => (
                      <>
                        {isActive && <span className="absolute inset-y-1.5 left-0 w-[3px] rounded-r bg-sky-400" />}
                        <Icon name={n.icon} className={`h-[18px] w-[18px] shrink-0 ${isActive ? 'text-sky-300' : 'text-slate-500 group-hover:text-slate-300'}`} />
                        {!mini && <span className="truncate">{n.label}</span>}
                      </>
                    )}
                  </NavLink>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </nav>

      <div className="shrink-0 border-t border-white/[0.06] p-3">
        <div className={`flex items-center gap-3 rounded-lg p-2 ${mini ? 'justify-center' : ''}`}>
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-slate-700 text-xs font-bold text-white ring-2 ring-white/10">
            {(ROLE_LABEL[role] ?? role).slice(0, 2).toUpperCase()}
          </span>
          {!mini && (
            <div className="min-w-0 flex-1 leading-tight">
              <p className="truncate text-sm font-semibold text-white">{ROLE_LABEL[role] ?? role}</p>
              <p className="text-[11px] text-slate-500">Sesión de personal</p>
            </div>
          )}
          {!mini && (
            <button onClick={logout} className="rounded-md p-1.5 text-slate-400 hover:bg-white/10 hover:text-white" title="Salir" aria-label="Salir">
              <Icon name="logout" className="h-[18px] w-[18px]" />
            </button>
          )}
        </div>
        {mini && (
          <button onClick={logout} className="mx-auto mt-1 flex rounded-md p-2 text-slate-400 hover:bg-white/10 hover:text-white" title="Salir" aria-label="Salir">
            <Icon name="logout" className="h-[18px] w-[18px]" />
          </button>
        )}
      </div>
    </div>
  );

  return (
    <div className="admin-theme min-h-screen bg-[#f4f6f9] text-slate-900">
      {/* Barra lateral fija (escritorio) */}
      <aside className={`fixed inset-y-0 left-0 z-30 hidden transition-[width] duration-200 lg:block ${collapsed ? 'w-[72px]' : 'w-64'}`}>{sidebar(collapsed)}</aside>

      {/* Cajón (teléfono y tableta) */}
      <div className={`fixed inset-0 z-40 lg:hidden ${drawer ? '' : 'pointer-events-none'}`} aria-hidden={!drawer}>
        <div className={`absolute inset-0 bg-slate-950/60 backdrop-blur-[2px] transition-opacity ${drawer ? 'opacity-100' : 'opacity-0'}`} onClick={() => setDrawer(false)} />
        <aside className={`absolute inset-y-0 left-0 w-72 max-w-[85vw] shadow-2xl transition-transform duration-200 ${drawer ? 'translate-x-0' : '-translate-x-full'}`}>
          {sidebar(false)}
          <button onClick={() => setDrawer(false)} className="absolute right-3 top-4 rounded-md p-1.5 text-slate-400 hover:bg-white/10 hover:text-white" aria-label="Cerrar menú">
            <Icon name="close" />
          </button>
        </aside>
      </div>

      <div className={`transition-[padding] duration-200 ${collapsed ? 'lg:pl-[72px]' : 'lg:pl-64'}`}>
        <div className="sticky top-0 z-20">
        <DemoBanner dark />
        <header className="flex h-16 items-center gap-3 border-b border-slate-200 bg-white/85 px-4 backdrop-blur lg:px-8">
          <button onClick={() => setDrawer(true)} className="-ml-1 rounded-md p-2 text-slate-600 hover:bg-slate-100 lg:hidden" aria-label="Abrir menú">
            <Icon name="menu" />
          </button>
          <button
            onClick={() => setCollapsed(!collapsed)}
            className="-ml-2 hidden rounded-md p-2 text-slate-500 hover:bg-slate-100 hover:text-slate-800 lg:block"
            aria-label={collapsed ? 'Expandir menú' : 'Contraer menú'}
            title={collapsed ? 'Expandir menú' : 'Contraer menú'}
          >
            <Icon name="collapse" className={`h-5 w-5 transition-transform ${collapsed ? 'rotate-180' : ''}`} />
          </button>
          <div className="min-w-0 leading-tight">
            <p className="hidden text-[11px] font-medium uppercase tracking-[0.12em] text-slate-400 sm:block">{current?.group ?? 'Backoffice'}</p>
            <p className="truncate text-[15px] font-semibold text-slate-900">{current?.label ?? 'Backoffice'}</p>
          </div>
          <div className="ml-auto flex items-center gap-2 sm:gap-4">
            <span className="hidden text-xs capitalize tabular-nums text-slate-500 md:inline">{clock} · Caracas</span>
            <span className="hidden h-5 w-px bg-slate-200 md:block" />
            <LiveDot />
            <Link
              to="/"
              className="flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-700 shadow-sm hover:bg-slate-50"
            >
              <Icon name="site" className="h-4 w-4" />
              <span className="hidden sm:inline">Ver sitio</span>
            </Link>
          </div>
        </header>
        </div>
        <main className="mx-auto max-w-[1400px] px-4 py-5 lg:px-8 lg:py-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
