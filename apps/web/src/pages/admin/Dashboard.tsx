import { useQuery } from '@tanstack/react-query';
import { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ErrorBox, Spinner } from '../../components/ui';
import { get } from '../../lib/api';
import { Currency, money } from '../../lib/format';

const longDay = (d: string) =>
  new Intl.DateTimeFormat('es-VE', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${d}T12:00:00Z`));

function Glyph({ d, className = 'h-5 w-5' }: { d: string; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
      <path d={d} />
    </svg>
  );
}
const G = {
  users: 'M9 11.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7ZM2.5 20c.8-3.5 3.4-5.5 6.5-5.5s5.7 2 6.5 5.5M16 4.5a3.5 3.5 0 0 1 0 7M18 14.8c1.8.7 3 2.5 3.5 5.2',
  ticket: 'M3 8V6a1 1 0 0 1 1-1h16a1 1 0 0 1 1 1v2a2 2 0 0 0 0 4v2a2 2 0 0 0 0 4v0a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-2a2 2 0 0 0 0-4V8Zm11-3v14',
  in: 'M12 3v12M7 10l5 5 5-5M4 21h16',
  out: 'M12 21V9M7 14l5-5 5 5M4 3h16',
  check: 'M4 12.5 9 17.5 20 6.5',
  flag: 'M5 21V4M5 4h11l-2 4 2 4H5',
  shield: 'M12 3 4 6v6c0 4.5 3.4 8.2 8 9 4.6-.8 8-4.5 8-9V6l-8-3Zm-3.5 9 2.5 2.5 4.5-5',
  scale: 'M12 4v16M5 20h14M4 9l3-5 3 5a3 3 0 0 1-6 0Zm10 0 3-5 3 5a3 3 0 0 1-6 0ZM7 4h10',
  arrow: 'M5 12h14M13 6l6 6-6 6',
  chart: 'M3 3v18h18M7 15l4-5 3 3 5-7',
  risk: 'M12 3 2.5 20h19L12 3ZM12 10v4M12 17h.01',
  draws: 'M3 6a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v13a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6Zm0 4h18M8 2v4M16 2v4',
};

export function DashboardPage() {
  const dash = useQuery({ queryKey: ['admin', 'dashboard'], queryFn: () => get('/admin/dashboard'), refetchInterval: 60_000 });
  const recon = useQuery({ queryKey: ['admin', 'reconcile'], queryFn: () => get('/admin/ledger/reconcile'), refetchInterval: 60_000 });
  const chain = useQuery({ queryKey: ['admin', 'audit-verify'], queryFn: () => get('/admin/audit/verify'), refetchInterval: 60_000 });

  if (dash.error) return <ErrorBox error={dash.error} />;
  if (dash.isLoading) return <Spinner />;
  const { counts, byCurrency, byGame, day } = dash.data;
  const pending = counts.pending_deposits + counts.pending_withdrawals + counts.pending_results;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">Resumen de operación</h1>
          <p className="mt-0.5 text-sm text-slate-500 first-letter:uppercase">{longDay(day)}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <QuickLink to="/admin/sorteos" icon={G.draws} label="Sorteos" />
          <QuickLink to="/admin/riesgo" icon={G.risk} label="Riesgo" />
          <QuickLink to="/admin/mercado" icon={G.chart} label="Mercado" />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi icon={G.users} tint="bg-blue-50 text-blue-700" label="Jugadores registrados" value={counts.players.toLocaleString('es-VE')} sub={`+${counts.new_players} hoy`} />
        <Kpi icon={G.ticket} tint="bg-violet-50 text-violet-700" label="Tickets vendidos hoy" value={counts.tickets_today.toLocaleString('es-VE')} sub="sin contar simulación" />
        <Integrity
          ok={recon.data?.ok}
          loading={!recon.data}
          icon={G.scale}
          label="Ledger contable"
          okText="Cuadrado"
          badText="Descuadrado"
          sub="débitos = créditos"
        />
        <Integrity
          ok={chain.data?.ok}
          loading={!chain.data}
          icon={G.shield}
          label="Cadena de auditoría"
          okText="Íntegra"
          badText={chain.data ? `Rota en #${chain.data.brokenAtId}` : ''}
          sub="registros encadenados"
        />
      </div>

      <section className="card overflow-hidden">
        <div className="flex items-center justify-between border-b border-slate-100 px-5 py-3.5">
          <div>
            <h2 className="text-sm font-semibold text-slate-900">Pendientes</h2>
            <p className="text-xs text-slate-500">{pending ? `${pending} tarea(s) esperan revisión` : 'Todo al día'}</p>
          </div>
          {pending === 0 && <span className="badge bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200">Sin pendientes</span>}
        </div>
        <div className="grid divide-y divide-slate-100 sm:grid-cols-3 sm:divide-x sm:divide-y-0">
          <Pending to="/admin/pagos" icon={G.in} label="Depósitos por revisar" value={counts.pending_deposits} />
          <Pending to="/admin/pagos" icon={G.out} label="Retiros por pagar" value={counts.pending_withdrawals} />
          <Pending to="/admin/sorteos" icon={G.flag} label="Resultados por confirmar" value={counts.pending_results} />
        </div>
      </section>

      <section className="card overflow-hidden">
        <div className="border-b border-slate-100 px-5 py-3.5">
          <h2 className="text-sm font-semibold text-slate-900">Juegos de hoy</h2>
        </div>
        <div className="grid divide-y divide-slate-100 lg:grid-cols-2 lg:divide-x lg:divide-y-0">
          {(byGame ?? []).map((g: any) => {
            const ves = g.money?.VES ?? { sales: '0', payouts: '0' };
            const usdt = g.money?.USDT ?? { sales: '0', payouts: '0' };
            const ggr = BigInt(ves.sales) - BigInt(ves.payouts);
            return (
              <div key={g.id} className="px-5 py-4">
                <div className="flex items-center justify-between gap-2">
                  <div>
                    <div className="text-sm font-semibold text-slate-900">{g.name}</div>
                    <div className="text-[11px] text-slate-500">{g.code}</div>
                  </div>
                  {g.pending_results > 0 ? (
                    <Link to="/admin/sorteos" className="badge bg-amber-50 text-amber-800 ring-1 ring-amber-200">{g.pending_results} por confirmar</Link>
                  ) : (
                    <span className="badge bg-slate-100 text-slate-600">
                      {g.next_draw_at ? `próximo ${new Date(g.next_draw_at).toLocaleTimeString('es-VE', { timeZone: 'America/Caracas', hour: 'numeric', minute: '2-digit' })}` : 'sin sorteos'}
                    </span>
                  )}
                </div>
                <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-4">
                  <div><dt className="text-[11px] text-slate-500">Ventas Bs.</dt><dd className="font-semibold tabular-nums">{money(ves.sales, 'VES')}</dd></div>
                  <div><dt className="text-[11px] text-slate-500">Ganancia Bs.</dt><dd className={`font-semibold tabular-nums ${ggr < 0n ? 'text-red-600' : ''}`}>{money(ggr, 'VES')}</dd></div>
                  <div><dt className="text-[11px] text-slate-500">Ventas USDT</dt><dd className="font-semibold tabular-nums">{money(usdt.sales, 'USDT')}</dd></div>
                  <div><dt className="text-[11px] text-slate-500">Tickets · sorteos</dt><dd className="font-semibold tabular-nums">{g.tickets_today} · {g.settled_today}/{g.draws_today}</dd></div>
                </dl>
              </div>
            );
          })}
        </div>
      </section>

      <div className="grid gap-4 lg:grid-cols-2">
        {byCurrency.map((r: any) => {
          const cur = r.currency as Currency;
          const ggrToday = BigInt(r.sales) - BigInt(r.payouts);
          const margin = BigInt(r.sales) > 0n ? Number(ggrToday) / Number(BigInt(r.sales)) : null;
          return (
            <section key={cur} className="card overflow-hidden">
              <div className="flex items-center justify-between border-b border-slate-100 px-5 py-3.5">
                <h2 className="text-sm font-semibold text-slate-900">Lotería · todos los juegos</h2>
                <span className="badge bg-slate-100 font-semibold text-slate-700">{cur === 'VES' ? 'Bolívares' : 'USDT'}</span>
              </div>
              <div className="px-5 pt-4">
                <p className="text-xs font-medium text-slate-500">Ganancia de hoy (ventas − premios)</p>
                <div className="mt-1 flex flex-wrap items-baseline gap-x-3">
                  <span className={`text-3xl font-bold tracking-tight tabular-nums ${ggrToday < 0n ? 'text-red-600' : 'text-slate-900'}`}>{money(ggrToday, cur)}</span>
                  {margin !== null && (
                    <span className={`badge ${margin >= 0 ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-700'}`}>
                      margen {(margin * 100).toLocaleString('es-VE', { maximumFractionDigits: 1 })} %
                    </span>
                  )}
                </div>
              </div>
              <dl className="mt-4 grid grid-cols-2 border-t border-slate-100 sm:grid-cols-3">
                <Stat label="Ventas hoy" value={money(r.sales, cur)} />
                <Stat label="Premios hoy" value={money(r.payouts, cur)} />
                <Stat label="Apuestas en juego" value={money(r.bets_in_play, cur)} />
                <Stat label="Ganancia acumulada" value={money(r.ggr_all_time, cur)} />
                <Stat label="Saldos de jugadores" value={money(r.player_liability, cur)} />
              </dl>
            </section>
          );
        })}
      </div>
    </div>
  );
}

function QuickLink({ to, icon, label }: { to: string; icon: string; label: string }) {
  return (
    <Link to={to} className="flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-700 shadow-sm hover:border-slate-300 hover:bg-slate-50">
      <Glyph d={icon} className="h-4 w-4 text-slate-400" />
      {label}
    </Link>
  );
}

function Kpi({ icon, tint, label, value, sub }: { icon: string; tint: string; label: string; value: ReactNode; sub?: string }) {
  return (
    <div className="card p-4 sm:p-5">
      <div className="flex items-start justify-between gap-2">
        <p className="text-xs font-medium text-slate-500">{label}</p>
        <span className={`grid h-8 w-8 shrink-0 place-items-center rounded-lg ${tint}`}>
          <Glyph d={icon} className="h-4 w-4" />
        </span>
      </div>
      <p className="mt-2 text-2xl font-bold tracking-tight tabular-nums text-slate-900">{value}</p>
      {sub && <p className="mt-0.5 text-xs text-slate-400">{sub}</p>}
    </div>
  );
}

function Integrity(p: { ok?: boolean; loading: boolean; icon: string; label: string; okText: string; badText: string; sub: string }) {
  const tone = p.loading ? 'bg-slate-100 text-slate-500' : p.ok ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-700';
  return (
    <div className="card p-4 sm:p-5">
      <div className="flex items-start justify-between gap-2">
        <p className="text-xs font-medium text-slate-500">{p.label}</p>
        <span className={`grid h-8 w-8 shrink-0 place-items-center rounded-lg ${tone}`}>
          <Glyph d={p.icon} className="h-4 w-4" />
        </span>
      </div>
      <p className={`mt-2 flex items-center gap-1.5 text-lg font-bold ${p.loading ? 'text-slate-400' : p.ok ? 'text-emerald-700' : 'text-red-700'}`}>
        {!p.loading && <Glyph d={p.ok ? G.check : 'M6 6l12 12M18 6 6 18'} className="h-4 w-4" />}
        {p.loading ? 'Verificando…' : p.ok ? p.okText : p.badText}
      </p>
      <p className="mt-0.5 text-xs text-slate-400">{p.sub}</p>
    </div>
  );
}

function Pending({ to, icon, label, value }: { to: string; icon: string; label: string; value: number }) {
  const hot = value > 0;
  return (
    <Link to={to} className="group flex items-center gap-3 px-5 py-4 hover:bg-slate-50">
      <span className={`grid h-10 w-10 shrink-0 place-items-center rounded-full ${hot ? 'bg-amber-50 text-amber-700 ring-1 ring-amber-200' : 'bg-slate-100 text-slate-400'}`}>
        <Glyph d={icon} className="h-[18px] w-[18px]" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-xs text-slate-500">{label}</p>
        <p className={`text-xl font-bold tabular-nums ${hot ? 'text-slate-900' : 'text-slate-400'}`}>{value}</p>
      </div>
      <Glyph d={G.arrow} className="h-4 w-4 text-slate-300 transition group-hover:translate-x-0.5 group-hover:text-slate-500" />
    </Link>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="border-b border-r border-slate-100 px-5 py-3 [&:nth-child(2n)]:border-r-0 sm:[&:nth-child(2n)]:border-r sm:[&:nth-child(3n)]:border-r-0">
      <dt className="text-xs text-slate-500">{label}</dt>
      <dd className="mt-0.5 text-sm font-semibold tabular-nums text-slate-900">{value}</dd>
    </div>
  );
}
