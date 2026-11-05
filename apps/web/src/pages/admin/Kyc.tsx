import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Empty, ErrorBox, Modal, PageTitle, Spinner, StatusBadge } from '../../components/ui';
import { get, getBlob, post } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { dateTime } from '../../lib/format';

const DOC_LABEL: Record<string, string> = {
  ID_FRONT: 'Documento (frente)',
  ID_BACK: 'Documento (reverso)',
  SELFIE: 'Selfie con documento',
  PROOF_OF_ADDRESS: 'Comprobante de domicilio',
  SOURCE_OF_FUNDS: 'Origen de fondos',
};

const STATUS_LABEL: Record<string, string> = { PENDING: 'En revisión', APPROVED: 'Aprobada', REJECTED: 'Rechazada' };

/** Cola de verificación de identidad (Doc. Maestro §16.3). */
export function KycPage() {
  const [status, setStatus] = useState('PENDING');
  const list = useQuery({ queryKey: ['admin', 'kyc', status], queryFn: () => get<any[]>(`/admin/kyc/requests${status ? `?status=${status}` : ''}`) });
  const [openId, setOpenId] = useState<string | null>(null);
  const open = list.data?.find((r) => r.id === openId);

  return (
    <div>
      <PageTitle
        actions={
          <div className="flex rounded-xl bg-black/5 p-1 text-sm">
            {['PENDING', 'APPROVED', 'REJECTED', ''].map((s) => (
              <button key={s} onClick={() => setStatus(s)} className={`rounded-lg px-3 py-1 ${status === s ? 'bg-white font-semibold shadow-sm' : 'text-black/60'}`}>
                {STATUS_LABEL[s] ?? 'Todas'}
              </button>
            ))}
          </div>
        }
      >
        Verificación KYC
      </PageTitle>
      <div className="card overflow-x-auto">
        {list.isLoading ? (
          <Spinner />
        ) : !list.data?.length ? (
          <Empty>No hay solicitudes en esta vista.</Empty>
        ) : (
          <table className="table-base">
            <thead>
              <tr>
                <th>Enviada</th>
                <th>Jugador</th>
                <th>Documento</th>
                <th>Nivel</th>
                <th>Archivos</th>
                <th>Estado</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {list.data.map((r) => (
                <tr key={r.id}>
                  <td className="whitespace-nowrap">{dateTime(r.submitted_at)}</td>
                  <td>
                    <div className="font-medium">
                      {r.first_name} {r.last_name}
                    </div>
                    <div className="text-xs text-black/50">{r.email}</div>
                  </td>
                  <td className="whitespace-nowrap">
                    {r.document_type}-{r.document_number}
                  </td>
                  <td className="whitespace-nowrap">
                    {r.from_level} → {r.target_level}
                  </td>
                  <td>{r.documents.length}</td>
                  <td>
                    <StatusBadge status={r.status} label={STATUS_LABEL[r.status]} />
                  </td>
                  <td>
                    <button className="btn-ghost px-3 py-1.5" onClick={() => setOpenId(r.id)}>
                      {r.status === 'PENDING' ? 'Revisar' : 'Ver'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <Modal open={!!open} onClose={() => setOpenId(null)} title="Solicitud de verificación">
        {open && <ReviewPanel request={open} onDone={() => setOpenId(null)} />}
      </Modal>
    </div>
  );
}

function ReviewPanel({ request: r, onDone }: { request: any; onDone: () => void }) {
  const qc = useQueryClient();
  const { user } = useAuth();
  const [reason, setReason] = useState('');
  const canReview = user?.role === 'COMPLIANCE' || user?.role === 'ADMIN';
  const review = useMutation({
    mutationFn: (decision: 'APPROVE' | 'REJECT') => post(`/admin/kyc/requests/${r.id}/review`, { decision, reason: reason.trim() || undefined }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin', 'kyc'] });
      onDone();
    },
  });
  const age = r.birth_date ? Math.floor((Date.now() - new Date(r.birth_date).getTime()) / (365.25 * 86_400_000)) : null;

  return (
    <div className="space-y-4 text-sm">
      <div className="grid grid-cols-2 gap-2 rounded-xl bg-black/[0.03] p-3">
        <Field label="Nombre" value={`${r.first_name} ${r.last_name}`} />
        <Field label="Documento declarado" value={`${r.document_type}-${r.document_number}`} />
        <Field label="Nacimiento" value={r.birth_date ? `${r.birth_date.slice(0, 10)} (${age} años)` : '—'} />
        <Field label="Teléfono" value={r.phone ? `+${r.phone}` : '—'} />
        <Field label="Ubicación" value={[r.city, r.state].filter(Boolean).join(', ') || '—'} />
        <Field label="Nivel" value={`${r.current_level} → solicita ${r.target_level}`} />
      </div>
      {r.note && (
        <div>
          <div className="label">Nota del jugador</div>
          <p className="rounded-xl bg-black/[0.03] p-3">{r.note}</p>
        </div>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        {r.documents.map((d: any) => (
          <DocumentPreview key={d.id} doc={d} />
        ))}
      </div>
      <p className="text-xs text-black/40">
        Compara nombre, número y foto del documento con los datos declarados y con la selfie. Cada vista de un documento queda registrada en auditoría.
      </p>

      {r.status === 'PENDING' ? (
        canReview ? (
          <div className="space-y-2 border-t border-black/5 pt-3">
            <label className="label" htmlFor="kyc-reason">
              Motivo (obligatorio para rechazar; el jugador lo verá)
            </label>
            <input id="kyc-reason" className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Ej.: la selfie no muestra el documento" />
            <ErrorBox error={review.error} />
            <div className="flex gap-2">
              <button className="btn-primary flex-1" disabled={review.isPending} onClick={() => review.mutate('APPROVE')}>
                Aprobar nivel {r.target_level}
              </button>
              <button className="btn-danger flex-1" disabled={review.isPending || reason.trim().length < 3} onClick={() => review.mutate('REJECT')}>
                Rechazar
              </button>
            </div>
          </div>
        ) : (
          <p className="text-xs text-black/50">Solo el oficial de cumplimiento puede aprobar o rechazar.</p>
        )
      ) : (
        <div className="rounded-xl bg-black/[0.03] p-3">
          <StatusBadge status={r.status} label={STATUS_LABEL[r.status]} /> por {r.reviewed_by_email} el {dateTime(r.reviewed_at)}
          {r.reject_reason && <div className="mt-1 text-red-700">Motivo: {r.reject_reason}</div>}
        </div>
      )}
    </div>
  );
}

/** Los documentos se piden con el token (no son URLs públicas) y se muestran como blob local. */
function DocumentPreview({ doc }: { doc: any }) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    let revoke: string | null = null;
    getBlob(`/admin/kyc/documents/${doc.id}/file`)
      .then((b) => {
        revoke = URL.createObjectURL(b);
        setUrl(revoke);
      })
      .catch(setError);
    return () => {
      if (revoke) URL.revokeObjectURL(revoke);
    };
  }, [doc.id]);
  return (
    <figure className="overflow-hidden rounded-xl ring-1 ring-black/10">
      <div className="flex h-44 items-center justify-center bg-black/5">
        {error ? (
          <ErrorBox error={error} />
        ) : !url ? (
          <span className="text-xs text-black/40">Descifrando…</span>
        ) : doc.mime === 'application/pdf' ? (
          <a href={url} target="_blank" rel="noreferrer" className="btn-ghost">
            📄 Abrir PDF
          </a>
        ) : (
          <a href={url} target="_blank" rel="noreferrer" className="h-full w-full">
            <img src={url} alt={DOC_LABEL[doc.type]} className="h-full w-full object-contain" />
          </a>
        )}
      </div>
      <figcaption className="flex justify-between px-3 py-2 text-xs">
        <span className="font-medium">{DOC_LABEL[doc.type]}</span>
        <span className="text-black/40" title={`SHA-256 ${doc.sha256}`}>
          {(doc.size / 1024).toFixed(0)} KB
        </span>
      </figcaption>
    </figure>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs text-black/50">{label}</div>
      <div className="font-medium">{value}</div>
    </div>
  );
}
