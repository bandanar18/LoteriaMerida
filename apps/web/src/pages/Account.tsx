import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { KycCard } from '../components/KycCard';
import { ErrorBox, Notice, PageTitle, Spinner } from '../components/ui';
import { get, post } from '../lib/api';
import { dateTime } from '../lib/format';

const OPTIONS = [
  { days: 1, label: '24 horas' },
  { days: 7, label: '7 días' },
  { days: 30, label: '30 días' },
  { days: 180, label: '6 meses' },
  { days: 365, label: '1 año' },
];

export function AccountPage() {
  const qc = useQueryClient();
  const me = useQuery({ queryKey: ['me'], queryFn: () => get('/me') });
  const [days, setDays] = useState(1);
  const [confirm, setConfirm] = useState(false);
  const exclude = useMutation({
    mutationFn: () => post('/me/self-exclusion', { days }),
    onSuccess: () => {
      setConfirm(false);
      qc.invalidateQueries({ queryKey: ['me'] });
    },
  });

  if (me.isLoading) return <Spinner />;
  const u = me.data;
  const excluded = u.self_excluded_until && new Date(u.self_excluded_until) > new Date();

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <PageTitle>Mi cuenta</PageTitle>
      <div className="card grid grid-cols-2 gap-3 p-4 text-sm">
        <Info label="Nombre" value={`${u.first_name} ${u.last_name}`} />
        <Info label="Documento" value={u.document_number ? `${u.document_type}-${u.document_number}` : "Pendiente (se pide antes de retirar)"} />
        <Info label="Correo" value={u.email} />
        <Info label="Teléfono" value={`+${u.phone}`} />
        <Info label="Ubicación" value={[u.city, u.state].filter(Boolean).join(', ') || '—'} />
        <Info label="Nivel de verificación" value={`KYC ${u.kyc_level}`} />
      </div>

      <KycCard />

      <div className="card space-y-3 p-4">
        <h2 className="font-semibold">Juego responsable</h2>
        {excluded ? (
          <Notice tone="warn">Tu cuenta está en pausa hasta el {dateTime(u.self_excluded_until)}. No puedes comprar tickets ni depositar.</Notice>
        ) : (
          <>
            <p className="text-sm text-black/60">
              Si necesitas un descanso, puedes pausar tu cuenta. Durante la pausa no podrás jugar ni depositar, pero sí retirar tu saldo. La pausa no se
              puede revertir antes de tiempo.
            </p>
            <div className="flex flex-wrap gap-2">
              {OPTIONS.map((o) => (
                <button key={o.days} onClick={() => setDays(o.days)} className={`btn ${days === o.days ? 'bg-selva-700 text-white' : 'bg-black/5'}`}>
                  {o.label}
                </button>
              ))}
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={confirm} onChange={(e) => setConfirm(e.target.checked)} />
              Entiendo que no podré jugar durante este periodo.
            </label>
            <ErrorBox error={exclude.error} />
            <button className="btn-danger" disabled={!confirm || exclude.isPending} onClick={() => exclude.mutate()}>
              Pausar mi cuenta
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="label">{label}</div>
      <div className="font-medium">{value}</div>
    </div>
  );
}
