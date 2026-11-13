import { ReactNode } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { PlayerLayout } from './components/PlayerLayout';
import { Spinner } from './components/ui';
import { useAuth } from './lib/auth';
import { usePlatform } from './lib/queries';
import { AccountPage } from './pages/Account';
import { AdminLayout } from './pages/admin/AdminLayout';
import { AuditPage } from './pages/admin/Audit';
import { DashboardPage } from './pages/admin/Dashboard';
import { DrawsPage } from './pages/admin/Draws';
import { KycPage } from './pages/admin/Kyc';
import { PaymentsPage } from './pages/admin/Payments';
import { AgenciesPage } from './pages/admin/Agencies';
import { PlayersPage } from './pages/admin/Players';
import { RiskPage } from './pages/admin/Risk';
import { MarketPage } from './pages/admin/Market';
import { SettingsPage } from './pages/admin/Settings';
import { LoginPage, ReferralLanding, RegisterPage } from './pages/Auth';
import { FaqPage } from './pages/Faq';
import { CasinoPage } from './pages/Casino';
import { PlayPage } from './pages/Play';
import { ResultsPage } from './pages/Results';
import { SportsPage } from './pages/Sports';
import { SportsTradingPage } from './pages/admin/Sports';
import { SimulatorPage } from './pages/Simulator';
import { TicketsPage } from './pages/Tickets';
import { WalletPage } from './pages/Wallet';
import { FuturesPage } from './pages/Futures';
import { FuturesAdminPage } from './pages/admin/Futures';

function Require({ kind, children }: { kind: 'PLAYER' | 'STAFF'; children: ReactNode }) {
  const { user, ready } = useAuth();
  const location = useLocation();
  if (!ready) return <Spinner />;
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  if (user.kind !== kind) return <Navigate to={user.kind === 'STAFF' ? '/admin' : '/'} replace />;
  return <>{children}</>;
}

function SportsRoute({ children, fallback }: { children: ReactNode; fallback: string }) {
  const platform = usePlatform();
  if (platform.isPending) return <Spinner />;
  return platform.data?.sportsEnabled ? children : <Navigate to={fallback} replace />;
}

function FuturesRoute({ children, fallback }: { children: ReactNode; fallback: string }) {
  const platform = usePlatform();
  if (platform.isPending) return <Spinner />;
  return platform.data?.futuresEnabled ? children : <Navigate to={fallback} replace />;
}

export function App() {
  const { ready } = useAuth();
  if (!ready) return <Spinner />;
  return (
    <Routes>
      <Route element={<PlayerLayout />}>
        <Route index element={<PlayPage />} />
        <Route path="resultados" element={<ResultsPage />} />
        <Route path="deportes" element={<SportsRoute fallback="/"><SportsPage /></SportsRoute>} />
        <Route path="casino" element={<CasinoPage />} />
        <Route path="casino/:gameId" element={<CasinoPage />} />
        <Route path="futuros" element={<FuturesRoute fallback="/"><FuturesPage /></FuturesRoute>} />
        <Route path="preguntas-frecuentes" element={<FaqPage />} />
        <Route path="login" element={<LoginPage />} />
        <Route path="registro" element={<RegisterPage />} />
        <Route path="r/:code" element={<ReferralLanding />} />
        <Route path="tickets" element={<Require kind="PLAYER"><TicketsPage /></Require>} />
        <Route path="simulador" element={<Require kind="PLAYER"><SimulatorPage /></Require>} />
        <Route path="billetera" element={<Require kind="PLAYER"><WalletPage /></Require>} />
        <Route path="cuenta" element={<Require kind="PLAYER"><AccountPage /></Require>} />
      </Route>
      <Route path="admin" element={<Require kind="STAFF"><AdminLayout /></Require>}>
        <Route index element={<DashboardPage />} />
        <Route path="sorteos" element={<DrawsPage />} />
        <Route path="riesgo" element={<RiskPage />} />
        <Route path="mercado" element={<MarketPage />} />
        <Route path="configuracion" element={<SettingsPage />} />
        <Route path="futuros" element={<FuturesRoute fallback="/admin"><FuturesAdminPage /></FuturesRoute>} />
        <Route path="deportes" element={<SportsRoute fallback="/admin"><SportsTradingPage /></SportsRoute>} />
        <Route path="pagos" element={<PaymentsPage />} />
        <Route path="agencias" element={<AgenciesPage />} />
        <Route path="kyc" element={<KycPage />} />
        <Route path="jugadores" element={<PlayersPage />} />
        <Route path="auditoria" element={<AuditPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
