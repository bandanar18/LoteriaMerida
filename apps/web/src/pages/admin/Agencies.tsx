import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FormEvent, useState } from 'react';
import { ErrorBox, Empty, Notice, PageTitle, Spinner, StatusBadge } from '../../components/ui';
import { ApiError, get, post } from '../../lib/api';
import { dateTime, money } from '../../lib/format';

/**
 * Programa de Agencias Virtuales (backoffice): tasa BCV del día para los retiros en Bs,
 * agencias (suspender / reactivar) y tasas de comisión por juego con su margen mínimo.
 */
export function AgenciesPage() {
  return (
    <div className="space-y-6">
      <PageTitle>Agencias Virtuales</PageTitle>
      <FxRateCard />
      <AgentsTable />
      <RatesTable />
    </div>
  );
}

function FxRateCard() {
  const qc = useQueryClient();
  const today = useQuery({ queryKey: ['admin', 'fx', 'today'], queryFn: () => get<{ rate: string; date: string } | null>('/affiliate/fx/today') });
  const history = useQuery({ queryKey: ['admin', 'fx', 'history'], queryFn: () => get<any[]>('/admin/agents/fx-rates') });
  const [rate, setRate] = useState('');
  const save = useMutation({
    mutationFn: (body: { rate: string; confirmLargeChange?: boolean }) => post('/admin/agents/fx-rates', body),
    onSuccess: () => {
      setRate('');
      void qc.invalidateQueries({ queryKey: ['admin', 'fx'] });
    },
    onError: (err, vars) => {
      // Salto de más de 10 %: pedir confirmación explícita y reintentar.
      if (err instanceof ApiError && err.code === 'FX_RATE_JUMP' && !vars.confirmLargeChange && confirm(`${err.message}\n\n¿Guardar la tasa ${vars.rate}?`)) {
        save.mutate({ ...vars, confirmLargeChange: true });
      }
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (rate.trim()) save.mutate({ rate: rate.trim() });
  };

  return (
    <section className="card space-y-3 p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-lg font-bold text-slate-900">Tasa BCV del día (USDT → Bs)</h2>
        {today.data ? (
          <p className="text-sm text-slate-600">
            Vigente hoy: <b className="tabular-nums">{today.data.rate} Bs/USDT</b>
          </p>
        ) : (
          <span className="rounded-full bg-red-50 px-3 py-1 text-xs font-semibold text-red-700">Sin tasa hoy: las agencias no pueden retirar desde USDT</span>
        )}
      </div>
      <p className="text-sm text-slate-600">Los retiros de las agencias se pagan siempre en bolívares. Si retiran desde su saldo en USDT, se usa esta tasa y queda fija en el retiro.</p>
      <form onSubmit={submit} className="flex flex-wrap gap-2">
        <input className="input w-48" inputMode="decimal" placeholder="Ej.: 45,2000" value={rate} onChange={(e) => setRate(e.target.value)} aria-label="Tasa BCV" />
        <button className="btn-primary" disabled={save.isPending || !rate.trim()}>
          Guardar tasa de hoy
        </button>
      </form>
      {!(save.error instanceof ApiError && save.error.code === 'FX_RATE_JUMP') && <ErrorBox error={save.error} />}
      {!!history.data?.length && (
        <details className="text-sm">
          <summary className="cursor-pointer font-semibold text-slate-700">Historial</summary>
          <table className="table-base mt-2">
            <thead>
              <tr>
                <th>Día</th>
                <th className="text-right">Tasa</th>
                <th>Cargada por</th>
                <th>Hora</th>
              </tr>
            </thead>
            <tbody>
              {history.data.map((h) => (
                <tr key={h.id}>
                  <td>{h.valid_date}</td>
                  <td className="text-right tabular-nums">{h.rate}</td>
                  <td className="text-black/60">{h.created_by}</td>
                  <td className="text-black/60">{dateTime(h.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}
    </section>
  );
}

function AgentsTable() {
  const qc = useQueryClient();
  const [q, setQ] = useState('');
  const list = useQuery({ queryKey: ['admin', 'agents', q], queryFn: () => get<any[]>(`/admin/agents${q ? `?q=${encodeURIComponent(q)}` : ''}`) });
  const act = useMutation({
    mutationFn: ({ id, action, reason }: { id: string; action: 'suspend' | 'reactivate'; reason: string }) => post(`/admin/agents/${id}/${action}`, { reason }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin', 'agents'] }),
  });
  const run = (id: string, action: 'suspend' | 'reactivate') => {
    const reason = prompt(action === 'suspend' ? 'Motivo de la suspensión' : 'Motivo de la reactivación');
    if (reason && reason.trim().length >= 5) act.mutate({ id, action, reason: reason.trim() });
  };

  return (
    <section className="card p-5">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-bold text-slate-900">Agencias</h2>
        <input className="input w-64" placeholder="Buscar por nombre, correo o código" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <ErrorBox error={act.error} />
      {list.isLoading ? (
        <Spinner />
      ) : !list.data?.length ? (
        <Empty>No hay agencias.</Empty>
      ) : (
        <div className="overflow-x-auto">
          <table className="table-base">
            <thead>
              <tr>
                <th>Agencia</th>
                <th>Código</th>
                <th className="text-right">Referidos</th>
                <th className="text-right">Comisión del mes</th>
                <th>Estado</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {list.data.map((a) => (
                <tr key={a.id}>
                  <td>
                    <div className="font-medium">{a.display_name}</div>
                    <div className="text-xs text-black/50">
                      {a.first_name} {a.last_name} · {a.email}
                    </div>
                  </td>
                  <td className="font-mono text-xs">{a.code ? `${a.code.slice(0, 2)}-${a.code.slice(2)}` : '—'}</td>
                  <td className="text-right tabular-nums">{a.referrals}</td>
                  <td className="text-right tabular-nums">
                    {Object.entries(a.commission_month ?? {}).length
                      ? Object.entries(a.commission_month).map(([cur, v]) => <div key={cur}>{money(v as string, cur as 'VES' | 'USDT')}</div>)
                      : '—'}
                  </td>
                  <td>
                    <StatusBadge status={a.status} label={a.status === 'ACTIVE' ? 'Activa' : a.status === 'SUSPENDED' ? 'Suspendida' : 'Cerrada'} />
                  </td>
                  <td className="whitespace-nowrap">
                    {a.status === 'ACTIVE' && (
                      <button className="btn-ghost px-3 py-1.5" disabled={act.isPending} onClick={() => run(a.id, 'suspend')}>
                        Suspender
                      </button>
                    )}
                    {a.status === 'SUSPENDED' && (
                      <button className="btn-primary px-3 py-1.5" disabled={act.isPending} onClick={() => run(a.id, 'reactivate')}>
                        Reactivar
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function RatesTable() {
  const rates = useQuery({ queryKey: ['admin', 'agent-rates'], queryFn: () => get<{ productRateBps: number; games: any[] }>('/admin/agents/rates') });
  if (rates.isLoading) return <Spinner />;
  if (!rates.data) return null;
  return (
    <section className="card p-5">
      <h2 className="text-lg font-bold text-slate-900">Comisión por juego</h2>
      <p className="mb-3 text-sm text-slate-600">
        General: <b>{(rates.data.productRateBps / 100).toFixed(2)} %</b> de lo apostado. La comisión debe ser menor que el margen de la casa en cada modalidad.
      </p>
      <table className="table-base">
        <thead>
          <tr>
            <th>Juego</th>
            <th className="text-right">Comisión</th>
            <th className="text-right">Margen mínimo</th>
          </tr>
        </thead>
        <tbody>
          {rates.data.games.map((g) => (
            <tr key={g.gameId}>
              <td>
                {g.name} <span className="text-xs text-black/40">{g.code}</span>
              </td>
              <td className="text-right tabular-nums">{(g.rateBps / 100).toFixed(2)} %</td>
              <td className={`text-right tabular-nums ${g.minMarginBps !== null && g.minMarginBps <= g.rateBps ? 'font-bold text-red-600' : ''}`}>
                {g.minMarginBps === null ? '—' : `${(g.minMarginBps / 100).toFixed(2)} %`}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="mt-3">
        <Notice tone="warn">Terminal Nevado está en 0 %: su modalidad «Terminal directo» paga 100× sobre 100 números (margen 0 %).</Notice>
      </div>
    </section>
  );
}
