import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Empty, ErrorBox, PageTitle, Spinner, StatusBadge } from '../../components/ui';
import { get, post } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { dateTime, money } from '../../lib/format';

export function PlayersPage() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const [q, setQ] = useState('');
  const [term, setTerm] = useState('');
  const players = useQuery({ queryKey: ['admin', 'players', term], queryFn: () => get<any[]>(`/admin/players?q=${encodeURIComponent(term)}`) });
  const setStatus = useMutation({
    mutationFn: ({ id, status, reason }: { id: string; status: string; reason: string }) => post(`/admin/players/${id}/status`, { status, reason }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin', 'players'] }),
  });

  return (
    <div className="space-y-4">
      <PageTitle
        actions={
          <form
            onSubmit={(e) => {
              e.preventDefault();
              setTerm(q);
            }}
            className="flex gap-2"
          >
            <input className="input w-64" placeholder="Correo, cédula, teléfono o nombre" value={q} onChange={(e) => setQ(e.target.value)} />
            <button className="btn-primary">Buscar</button>
          </form>
        }
      >
        Jugadores
      </PageTitle>
      <ErrorBox error={setStatus.error} />
      <div className="card overflow-x-auto">
        {players.isLoading ? (
          <Spinner />
        ) : !players.data?.length ? (
          <Empty>Sin resultados.</Empty>
        ) : (
          <table className="table-base">
            <thead>
              <tr>
                <th>Jugador</th>
                <th>Documento</th>
                <th>Teléfono</th>
                <th className="text-right">Saldo</th>
                <th>Estado</th>
                <th>Registro</th>
                {user?.role === 'ADMIN' && <th />}
              </tr>
            </thead>
            <tbody>
              {players.data.map((p) => {
                const excluded = p.self_excluded_until && new Date(p.self_excluded_until) > new Date();
                return (
                  <tr key={p.id}>
                    <td>
                      <div className="font-medium">
                        {p.first_name} {p.last_name}
                      </div>
                      <div className="text-xs text-black/50">{p.email}</div>
                    </td>
                    <td>
                      {p.document_number ? `${p.document_type}-${p.document_number}` : "Registro lite"}
                    </td>
                    <td>+{p.phone}</td>
                    <td className="text-right text-xs tabular-nums">
                      <div>{money(p.cash?.VES ?? '0', 'VES')}</div>
                      <div>{money(p.cash?.USDT ?? '0', 'USDT')}</div>
                    </td>
                    <td>
                      <StatusBadge status={p.status} />
                      {excluded && <div className="mt-1 text-[11px] text-amber-700">Autoexcluido hasta {dateTime(p.self_excluded_until)}</div>}
                    </td>
                    <td className="text-black/60">{dateTime(p.created_at)}</td>
                    {user?.role === 'ADMIN' && (
                      <td>
                        <button
                          className={p.status === 'BLOCKED' ? 'btn-ghost px-3 py-1.5' : 'btn-danger px-3 py-1.5'}
                          onClick={() => {
                            const reason = prompt(p.status === 'BLOCKED' ? 'Motivo del desbloqueo' : 'Motivo del bloqueo');
                            if (reason && reason.length >= 3) setStatus.mutate({ id: p.id, status: p.status === 'BLOCKED' ? 'ACTIVE' : 'BLOCKED', reason });
                          }}
                        >
                          {p.status === 'BLOCKED' ? 'Desbloquear' : 'Bloquear'}
                        </button>
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
