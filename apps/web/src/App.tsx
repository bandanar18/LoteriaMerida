import { ReactNode } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { PlayerLayout } from './components/PlayerLayout';
import { Spinner } from './components/ui';
import { useAuth } from './lib/auth';
import { AccountPage } from './pages/Account';
import { AdminLayout } from './pages/admin/AdminLayout';
import { AuditPage } from './pages/admin/Audit';
import { DashboardPage } from './pages/admin/Dashboard';
import { DrawsPage } from './pages/admin/Draws';
import { KycPage } from './pages/admin/Kyc';
import { PaymentsPage } from './pages/admin/Payments';
import { SportsTradingPage } from './pages/admin/Sports';
import { SportsPage } from './pages/Sports';
import { PlayersPage } from './pages/admin/Players';
import { LoginPage, RegisterPage } from './pages/Auth';
import { PlayPage } from './pages/Play';
import { ResultsPage } from './pages/Results';
import { TicketsPage } from './pages/Tickets';
import { WalletPage } from './pages/Wallet';

function Require({ kind, children }: { kind: 'PLAYER' | 'STAFF'; children: ReactNode }) {
  const { user, ready } = useAuth();
  const location = useLocation();
  if (!ready) return <Spinner />;
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  if (user.kind !== kind) return <Navigate to={user.kind === 'STAFF' ? '/admin' : '/'} replace />;
  return <>{children}</>;
}

export function App() {
  const { ready } = useAuth();
  if (!ready) return <Spinner />;
  return (
    <Routes>
      <Route element={<PlayerLayout />}>
        <Route index element={<PlayPage />} />
        <Route path="deportes" element={<SportsPage />} />
        <Route path="resultados" element={<ResultsPage />} />
        <Route path="login" element={<LoginPage />} />
        <Route path="registro" element={<RegisterPage />} />
        <Route path="tickets" element={<Require kind="PLAYER"><TicketsPage /></Require>} />
        <Route path="billetera" element={<Require kind="PLAYER"><WalletPage /></Require>} />
        <Route path="cuenta" element={<Require kind="PLAYER"><AccountPage /></Require>} />
      </Route>
      <Route path="admin" element={<Require kind="STAFF"><AdminLayout /></Require>}>
        <Route index element={<DashboardPage />} />
        <Route path="sorteos" element={<DrawsPage />} />
        <Route path="pagos" element={<PaymentsPage />} />
        <Route path="kyc" element={<KycPage />} />
        <Route path="deportes" element={<SportsTradingPage />} />
        <Route path="jugadores" element={<PlayersPage />} />
        <Route path="auditoria" element={<AuditPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
