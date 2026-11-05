import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Empty, ErrorBox, PageTitle, Spinner, StatusBadge } from '../../components/ui';
import { get, post } from '../../lib/api';
import { Currency, dateTime, money } from '../../lib/format';

export function PaymentsPage() {
  const [tab, setTab] = useState<'deposits' | 'withdrawals'>('deposits');
  const [status, setStatus] = useState<string>('pending');
  const qc = useQueryClient();
  const statusParam = status === 'pending' ? (tab === 'deposits' ? 'PENDING' : 'REQUESTED') : '';
  const list = useQuery({
    queryKey: ['admin', tab, statusParam],
    refetchInterval: 60_000,
    queryFn: () => get<any[]>(`/admin/payments/${tab}${statusParam ? `?status=${statusParam}` : ''}`),
  });
  const act = useMutation({
    mutationFn: ({ path, body }: { path: string; body?: unknown }) => post(`/admin/payments/${path}`, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin'] }),
  });

  function reject(path: string) {
    const reason = prompt('Motivo del rechazo');
    if (reason && reason.length >= 3) act.mutate({ path, body: { reason } });
  }

  return (
    <div className="space-y-4">
      <PageTitle
        actions={
          <div className="flex gap-2">
            <div className="flex rounded-xl bg-black/5 p-1">
              {(
                [
                  ['deposits', 'Depósitos'],
                  ['withdrawals', 'Retiros'],
                ] as const
              ).map(([k, l]) => (
                <button key={k} onClick={() => setTab(k)} className={`rounded-lg px-3 py-1.5 text-sm font-semibold ${tab === k ? 'bg-white shadow-sm' : 'text-black/60'}`}>
                  {l}
                </button>
              ))}
            </div>
            <select className="input w-auto" value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="pending">Pendientes</option>
              <option value="all">Todos</option>
            </select>
          </div>
        }
      >
        Pagos
      </PageTitle>
      <ErrorBox error={act.error} />
      <div className="card overflow-x-auto">
        {list.isLoading ? (
          <Spinner />
        ) : !list.data?.length ? (
          <Empty>No hay {tab === 'deposits' ? 'depósitos' : 'retiros'} {status === 'pending' ? 'pendientes' : ''}.</Empty>
        ) : (
          <table className="table-base">
            <thead>
              <tr>
                <th>Fecha</th>
                <th>Jugador</th>
                <th>Método</th>
                <th>{tab === 'deposits' ? 'Origen / referencia' : 'Destino'}</th>
                <th className="text-right">Monto</th>
                <th>Estado</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {list.data.map((r) => (
                <tr key={r.id}>
                  <td className="whitespace-nowrap text-black/60">{dateTime(r.created_at)}</td>
                  <td>
                    <div className="font-medium">{r.player_name}</div>
                    <div className="text-xs text-black/50">
                      {r.player_document} · {r.email}
                    </div>
                  </td>
                  <td>{r.method}</td>
                  <td className="font-mono text-xs">
                    {tab === 'deposits' ? (
                      <>
                        {r.bank}
                        <br />
                        {r.reference}
                        {r.payer_phone && <div className="text-black/50">tel. {r.payer_phone}</div>}
                      </>
                    ) : (
                      <>
                        {r.destination.bank}
                        <br />
                        {r.destination.account}
                        {r.paid_reference && <div className="text-black/50">pagado ref. {r.paid_reference}</div>}
                      </>
                    )}
                  </td>
                  <td className="text-right font-semibold tabular-nums">{money(r.amount, r.currency as Currency)}</td>
                  <td>
                    <StatusBadge status={r.status} />
                    {r.reviewed_by_email && <div className="mt-1 text-[11px] text-black/40">{r.reviewed_by_email}</div>}
                    {r.reject_reason && <div className="text-[11px] text-red-600">{r.reject_reason}</div>}
                  </td>
                  <td className="whitespace-nowrap">
                    {tab === 'deposits' && r.status === 'PENDING' && (
                      <div className="flex gap-1">
                        <button className="btn-primary px-3 py-1.5" disabled={act.isPending} onClick={() => act.mutate({ path: `deposits/${r.id}/approve` })}>
                          Acreditar
                        </button>
                        <button className="btn-ghost px-3 py-1.5" disabled={act.isPending} onClick={() => reject(`deposits/${r.id}/reject`)}>
                          Rechazar
                        </button>
                      </div>
                    )}
                    {tab === 'withdrawals' && r.status === 'REQUESTED' && (
                      <div className="flex gap-1">
                        <button
                          className="btn-primary px-3 py-1.5"
                          disabled={act.isPending}
                          onClick={() => {
                            const paidReference = prompt('Referencia del pago realizado');
                            if (paidReference && paidReference.length >= 4) act.mutate({ path: `withdrawals/${r.id}/pay`, body: { paidReference } });
                          }}
                        >
                          Marcar pagado
                        </button>
                        <button className="btn-ghost px-3 py-1.5" disabled={act.isPending} onClick={() => reject(`withdrawals/${r.id}/reject`)}>
                          Rechazar
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <p className="text-xs text-black/40">
        Verifica cada referencia contra el estado de cuenta bancario o el explorador de la red antes de acreditar. La acreditación es idempotente y la
        misma referencia no puede reportarse dos veces.
      </p>
    </div>
  );
}
