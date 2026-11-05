import { useQuery } from '@tanstack/react-query';
import { Notice, PageTitle, Spinner } from '../../components/ui';
import { get } from '../../lib/api';
import { dateTime } from '../../lib/format';

export function AuditPage() {
  const log = useQuery({ queryKey: ['admin', 'audit'], queryFn: () => get<any[]>('/admin/audit?limit=200'), refetchInterval: 60_000 });
  const chain = useQuery({ queryKey: ['admin', 'audit-verify'], queryFn: () => get('/admin/audit/verify') });

  return (
    <div className="space-y-4">
      <PageTitle>Auditoría</PageTitle>
      {chain.data &&
        (chain.data.ok ? (
          <Notice tone="success">Cadena de hashes íntegra: {chain.data.checked} registros verificados.</Notice>
        ) : (
          <Notice tone="warn">¡Cadena rota en el registro #{chain.data.brokenAtId}!</Notice>
        ))}
      <div className="card overflow-x-auto">
        {log.isLoading ? (
          <Spinner />
        ) : (
          <table className="table-base">
            <thead>
              <tr>
                <th>#</th>
                <th>Fecha</th>
                <th>Actor</th>
                <th>Acción</th>
                <th>Entidad</th>
                <th>Detalle</th>
                <th>Hash</th>
              </tr>
            </thead>
            <tbody>
              {log.data?.map((a) => (
                <tr key={a.id}>
                  <td className="text-black/40">{a.id}</td>
                  <td className="whitespace-nowrap text-black/60">{dateTime(a.at)}</td>
                  <td className="text-xs">
                    <div className="font-medium">{a.actor_type}</div>
                    <div className="text-black/50">{a.actor_email ?? ''}</div>
                  </td>
                  <td className="font-mono text-xs font-semibold">{a.action}</td>
                  <td className="text-xs">
                    {a.entity}
                    <div className="font-mono text-[10px] text-black/40">{a.entity_id?.slice(0, 8)}</div>
                  </td>
                  <td className="max-w-xs font-mono text-[10px] break-all text-black/60">{a.after ? JSON.stringify(a.after) : ''}</td>
                  <td className="font-mono text-[10px] text-black/40">{a.hash.slice(0, 12)}…</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
