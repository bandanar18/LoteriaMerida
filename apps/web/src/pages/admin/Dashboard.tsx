import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { PageTitle, Spinner } from '../../components/ui';
import { get } from '../../lib/api';
import { Currency, money } from '../../lib/format';

export function DashboardPage() {
  const dash = useQuery({ queryKey: ['admin', 'dashboard'], queryFn: () => get('/admin/dashboard'), refetchInterval: 60_000 });
  const recon = useQuery({ queryKey: ['admin', 'reconcile'], queryFn: () => get('/admin/ledger/reconcile'), refetchInterval: 60_000 });
  const chain = useQuery({ queryKey: ['admin', 'audit-verify'], queryFn: () => get('/admin/audit/verify'), refetchInterval: 60_000 });

  if (dash.isLoading) return <Spinner />;
  const { counts, byCurrency, day } = dash.data;

  return (
    <div className="space-y-4">
      <PageTitle>Dashboard · {day}</PageTitle>

      <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <Kpi label="Jugadores" value={counts.players} sub={`+${counts.new_players} hoy`} />
        <Kpi label="Tickets hoy" value={counts.tickets_today} />
        <Kpi label="Depósitos por revisar" value={counts.pending_deposits} to="/admin/pagos" alert={counts.pending_deposits > 0} />
        <Kpi label="Retiros por pagar" value={counts.pending_withdrawals} to="/admin/pagos" alert={counts.pending_withdrawals > 0} />
        <Kpi label="Resultados por confirmar" value={counts.pending_results} to="/admin/sorteos" alert={counts.pending_results > 0} />
        <div className="card p-4">
          <div className="text-xs text-black/50">Integridad</div>
          <div className={`mt-1 text-sm font-semibold ${recon.data?.ok ? 'text-emerald-700' : 'text-red-700'}`}>
            {recon.data ? (recon.data.ok ? '✔ Ledger cuadrado' : '✘ Ledger descuadrado') : '…'}
          </div>
          <div className={`text-sm font-semibold ${chain.data?.ok ? 'text-emerald-700' : 'text-red-700'}`}>
            {chain.data ? (chain.data.ok ? '✔ Auditoría íntegra' : `✘ Cadena rota en #${chain.data.brokenAtId}`) : '…'}
          </div>
        </div>
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        {byCurrency.map((r: any) => {
          const cur = r.currency as Currency;
          const ggrToday = BigInt(r.sales) - BigInt(r.payouts);
          return (
            <div key={cur} className="card p-4">
              <h2 className="mb-3 font-semibold">Animalitos · {cur}</h2>
              <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-3">
                <Stat label="Ventas hoy" value={money(r.sales, cur)} />
                <Stat label="Premios hoy" value={money(r.payouts, cur)} />
                <Stat label="GGR hoy (aprox.)" value={money(ggrToday, cur)} tone={ggrToday >= 0n ? 'good' : 'bad'} />
                <Stat label="Apuestas en juego" value={money(r.bets_in_play, cur)} />
                <Stat label="GGR acumulado" value={money(r.ggr_all_time, cur)} />
                <Stat label="Saldos de jugadores" value={money(r.player_liability, cur)} />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Kpi({ label, value, sub, to, alert }: { label: string; value: number; sub?: string; to?: string; alert?: boolean }) {
  const body = (
    <div className={`card h-full p-4 ${alert ? 'ring-2 ring-oro-400' : ''}`}>
      <div className="text-xs text-black/50">{label}</div>
      <div className="mt-1 text-2xl font-bold tabular-nums">{value}</div>
      {sub && <div className="text-xs text-black/40">{sub}</div>}
    </div>
  );
  return to ? <Link to={to}>{body}</Link> : body;
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: 'good' | 'bad' }) {
  return (
    <div>
      <div className="text-xs text-black/50">{label}</div>
      <div className={`font-semibold tabular-nums ${tone === 'good' ? 'text-emerald-700' : tone === 'bad' ? 'text-red-700' : ''}`}>{value}</div>
    </div>
  );
}
