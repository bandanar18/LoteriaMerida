import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api, get } from '../lib/api';
import { Currency, dateTime, money } from '../lib/format';
import { ErrorBox, Notice, Spinner, StatusBadge } from './ui';

type DocType = 'ID_FRONT' | 'ID_BACK' | 'SELFIE' | 'PROOF_OF_ADDRESS' | 'SOURCE_OF_FUNDS';

const DOCS: Record<2 | 3, { type: DocType; label: string; hint: string; optional?: boolean; selfie?: boolean }[]> = {
  2: [
    { type: 'ID_FRONT', label: 'Cédula o pasaporte (frente)', hint: 'Foto nítida, sin reflejos, con los 4 bordes visibles.' },
    { type: 'ID_BACK', label: 'Cédula (reverso)', hint: 'Opcional para pasaporte.', optional: true },
    { type: 'SELFIE', label: 'Selfie sosteniendo tu documento', hint: 'Tu cara y el documento deben verse claramente.', selfie: true },
  ],
  3: [
    { type: 'PROOF_OF_ADDRESS', label: 'Comprobante de domicilio', hint: 'Recibo de servicio o constancia de residencia (máx. 3 meses).' },
    { type: 'SOURCE_OF_FUNDS', label: 'Origen de fondos', hint: 'Constancia de trabajo, recibo de pago o estado de cuenta.' },
  ],
};

const LEVEL_TEXT: Record<number, string> = {
  1: 'Datos personales y documento declarado',
  2: 'Identidad verificada con documento y selfie',
  3: 'Domicilio y origen de fondos verificados',
};

const MAX_BYTES = 5 * 1024 * 1024;

/** Verificación de identidad por niveles (Doc. Maestro §6.2): estado, límites y envío de documentos. */
export function KycCard() {
  const qc = useQueryClient();
  const kyc = useQuery({ queryKey: ['kyc'], queryFn: () => get('/me/kyc') });
  const [files, setFiles] = useState<Partial<Record<DocType, File>>>({});
  const [note, setNote] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);

  const level: number = kyc.data?.level ?? 1;
  const target = (level < 2 ? 2 : 3) as 2 | 3;
  const pending = kyc.data?.requests.find((r: any) => r.status === 'PENDING');
  const lastRejected = kyc.data?.requests[0]?.status === 'REJECTED' ? kyc.data.requests[0] : null;

  const submit = useMutation({
    mutationFn: () => {
      const form = new FormData();
      form.set('targetLevel', String(target));
      if (note.trim()) form.set('note', note.trim());
      for (const [type, file] of Object.entries(files)) if (file) form.set(type, file);
      return api('POST', '/me/kyc/requests', { body: form });
    },
    onSuccess: () => {
      setFiles({});
      setNote('');
      qc.invalidateQueries({ queryKey: ['kyc'] });
    },
  });

  if (kyc.isLoading) return <Spinner />;
  const limitsFor = (lvl: number) => kyc.data.limits.filter((l: any) => l.level === lvl);
  const missing = DOCS[target].filter((d) => !d.optional && !files[d.type]);

  const pick = (type: DocType, file: File | undefined) => {
    setLocalError(null);
    if (file && file.size > MAX_BYTES) return setLocalError('Cada archivo puede pesar máximo 5 MB');
    if (file && !['image/jpeg', 'image/png', 'application/pdf'].includes(file.type)) return setLocalError('Solo se aceptan JPG, PNG o PDF');
    setFiles((f) => ({ ...f, [type]: file }));
  };

  return (
    <div className="card space-y-4 p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="font-semibold">Verificación de identidad</h2>
          <p className="text-sm text-black/60">
            Nivel {level}: {LEVEL_TEXT[level] ?? 'Sin verificar'}
          </p>
        </div>
        <div className="flex gap-1" aria-label={`Nivel ${level} de 3`}>
          {[1, 2, 3].map((n) => (
            <span key={n} className={`h-2 w-8 rounded-full ${n <= level ? 'bg-selva-600' : 'bg-black/10'}`} />
          ))}
        </div>
      </div>

      <div className="grid gap-2 sm:grid-cols-2">
        {kyc.data.usedToday.map((u: any) => {
          const lim = limitsFor(level).find((l: any) => l.currency === u.currency);
          const cur = u.currency as Currency;
          return (
            <div key={cur} className="rounded-xl bg-black/[0.03] p-3 text-sm">
              <div className="mb-1 text-xs font-medium text-black/50">Límites diarios · {cur}</div>
              <LimitRow label="Depósitos" used={u.deposits} max={lim?.max_deposit_daily} cur={cur} />
              <LimitRow label="Retiros" used={u.withdrawals} max={lim?.max_withdrawal_daily} cur={cur} />
            </div>
          );
        })}
      </div>

      {pending ? (
        <Notice>
          Tu solicitud de nivel {pending.target_level} está en revisión desde el {dateTime(pending.submitted_at)}. Te avisaremos aquí apenas
          cumplimiento la revise.
        </Notice>
      ) : level >= 3 ? (
        <Notice tone="success">Tu cuenta tiene el nivel máximo de verificación.</Notice>
      ) : (
        <div className="space-y-3 border-t border-black/5 pt-3">
          <div>
            <h3 className="text-sm font-semibold">Subir a nivel {target}</h3>
            <p className="text-xs text-black/50">
              Con el nivel {target}:{' '}
              {limitsFor(target)
                .map((l: any) => `depósitos hasta ${money(l.max_deposit_daily, l.currency)}/día y retiros hasta ${money(l.max_withdrawal_daily, l.currency)}/día`)
                .join(' · ')}
            </p>
          </div>
          {lastRejected && (
            <Notice tone="warn">
              Tu solicitud anterior fue rechazada: <b>{lastRejected.reject_reason}</b>. Corrige y vuelve a enviar.
            </Notice>
          )}
          {DOCS[target].map((d) => (
            <FileField key={d.type} {...d} file={files[d.type]} onPick={(f) => pick(d.type, f)} />
          ))}
          {target === 3 && (
            <div>
              <label className="label" htmlFor="kyc-note">
                Describe tu actividad u origen de los fondos (opcional)
              </label>
              <textarea id="kyc-note" className="input" rows={2} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />
            </div>
          )}
          <p className="text-xs text-black/40">Los documentos se guardan cifrados y solo los ve el equipo de cumplimiento.</p>
          <ErrorBox error={localError ? new Error(localError) : submit.error} />
          <button className="btn-primary w-full sm:w-auto" disabled={missing.length > 0 || submit.isPending} onClick={() => submit.mutate()}>
            {submit.isPending ? 'Enviando…' : missing.length ? `Falta: ${missing[0].label}` : 'Enviar a revisión'}
          </button>
        </div>
      )}

      {kyc.data.requests.length > 0 && (
        <details className="text-sm">
          <summary className="cursor-pointer text-black/50">Historial de solicitudes</summary>
          <ul className="mt-2 space-y-1">
            {kyc.data.requests.map((r: any) => (
              <li key={r.id} className="flex flex-wrap items-center gap-2">
                <StatusBadge status={r.status} label={{ PENDING: 'En revisión', APPROVED: 'Aprobada', REJECTED: 'Rechazada' }[r.status as string]} />
                <span>Nivel {r.target_level}</span>
                <span className="text-black/40">{dateTime(r.submitted_at)}</span>
                {r.reject_reason && <span className="text-red-700">· {r.reject_reason}</span>}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

function LimitRow({ label, used, max, cur }: { label: string; used: string; max?: string; cur: Currency }) {
  const m = BigInt(max ?? 0);
  if (m === 0n) {
    return (
      <div className="flex justify-between">
        <span>{label}</span>
        <span className="text-black/40">Requiere nivel 2</span>
      </div>
    );
  }
  const pct = Number((BigInt(used) * 100n) / m);
  return (
    <div className="py-0.5">
      <div className="flex justify-between">
        <span>{label}</span>
        <span className="tabular-nums text-black/60">
          {money(used, cur)} / {money(max, cur)}
        </span>
      </div>
      <div className="mt-1 h-1.5 rounded-full bg-black/10">
        <div className={`h-1.5 rounded-full ${pct >= 90 ? 'bg-red-500' : 'bg-selva-600'}`} style={{ width: `${Math.min(pct, 100)}%` }} />
      </div>
    </div>
  );
}

function FileField(props: { type: DocType; label: string; hint: string; optional?: boolean; selfie?: boolean; file?: File; onPick: (f?: File) => void }) {
  const [preview, setPreview] = useState<string | null>(null);
  useEffect(() => {
    if (!props.file || !props.file.type.startsWith('image/')) return setPreview(null);
    const url = URL.createObjectURL(props.file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [props.file]);
  const id = `kyc-${props.type}`;
  return (
    <div className="flex items-center gap-3 rounded-xl ring-1 ring-black/10 p-3">
      <div className="flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-black/5 text-2xl">
        {preview ? <img src={preview} alt="" className="h-full w-full object-cover" /> : props.file ? '📄' : props.selfie ? '🤳' : '🪪'}
      </div>
      <div className="min-w-0 flex-1">
        <label htmlFor={id} className="block text-sm font-medium">
          {props.label} {props.optional && <span className="font-normal text-black/40">(opcional)</span>}
        </label>
        <p className="truncate text-xs text-black/50">{props.file ? props.file.name : props.hint}</p>
      </div>
      <label htmlFor={id} className="btn-ghost shrink-0 cursor-pointer px-3 py-1.5">
        {props.file ? 'Cambiar' : props.selfie ? 'Tomar foto' : 'Elegir'}
      </label>
      <input
        id={id}
        type="file"
        className="sr-only"
        accept={props.selfie ? 'image/jpeg,image/png' : 'image/jpeg,image/png,application/pdf'}
        {...(props.selfie ? { capture: 'user' as const } : {})}
        onChange={(e) => props.onPick(e.target.files?.[0])}
      />
    </div>
  );
}
