import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Empty, Modal, PageTitle, Spinner, StatusBadge } from '../components/ui';
import { get } from '../lib/api';
import { DRAW_STATUS_LABEL, hour, todayCaracas } from '../lib/format';
import { useDraws, useGames } from '../lib/queries';

export function ResultsPage() {
  const games = useGames();
  const [gameId, setGameId] = useState<string>();
  const [date, setDate] = useState(todayCaracas());
  const [verifyId, setVerifyId] = useState<string | null>(null);
  const game = games.data?.find((g) => g.id === gameId) ?? games.data?.[0];
  const draws = useDraws(game?.id, date);

  return (
    <div>
      <PageTitle
        actions={
          <div className="flex gap-2">
            <select className="input w-auto" value={game?.id} onChange={(e) => setGameId(e.target.value)}>
              {games.data?.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
            </select>
            <input type="date" className="input w-auto" value={date} max={todayCaracas()} onChange={(e) => setDate(e.target.value)} />
          </div>
        }
      >
        Resultados
      </PageTitle>
      {draws.isLoading ? (
        <Spinner />
      ) : !draws.data?.length ? (
        <Empty>No hay sorteos para esta fecha.</Empty>
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {draws.data.map((d) => (
            <div key={d.id} className="card flex flex-col items-center p-4 text-center">
              <div className="text-sm font-bold text-selva-900">
                {hour(d.draw_at)} {d.is_extraordinary && '⭐'}
              </div>
              {d.result_number ? (
                <>
                  <div className="my-2 text-5xl">{d.result_emoji}</div>
                  <div className="font-bold">
                    {d.result_number} · {d.result_name}
                  </div>
                </>
              ) : (
                <div className="my-4">
                  <StatusBadge status={d.status} label={DRAW_STATUS_LABEL[d.status]} />
                </div>
              )}
              <button className="mt-2 text-xs text-selva-700 underline-offset-2 hover:underline" onClick={() => setVerifyId(d.id)}>
                {d.server_seed ? 'Verificar resultado' : 'Ver compromiso'}
              </button>
            </div>
          ))}
        </div>
      )}
      <p className="mt-6 text-xs text-black/40">
        Las estadísticas y resultados anteriores no influyen en los sorteos futuros: cada animal tiene siempre 1 en 38 de probabilidad.
      </p>
      <Modal open={!!verifyId} onClose={() => setVerifyId(null)} title="Verificación del sorteo">
        {verifyId && <Verify drawId={verifyId} />}
      </Modal>
    </div>
  );
}

function Verify({ drawId }: { drawId: string }) {
  const v = useQuery({ queryKey: ['verify', drawId], queryFn: () => get(`/lottery/draws/${drawId}/verify`) });
  if (v.isLoading) return <Spinner />;
  const d = v.data.draw;
  return (
    <div className="space-y-3 text-sm">
      <p className="text-black/60">
        Antes de abrir la venta publicamos el <b>hash SHA-256</b> de una semilla secreta. Cuando hay resultado revelamos la semilla para que
        puedas comprobar que no fue cambiada.
      </p>
      <Field label="Compromiso publicado (sha256 de la semilla)" value={d.seed_hash} />
      {v.data.revealed ? (
        <>
          <Field label="Semilla revelada" value={d.server_seed} />
          <Field label="Mensaje (id del sorteo)" value={d.id} />
          <div className="rounded-xl bg-black/[0.03] p-3 text-xs text-black/60">{v.data.algorithm}</div>
          <div className="space-y-1">
            <Check ok={v.data.hashMatches} label="sha256(semilla) coincide con el compromiso" />
            {v.data.resultMatches !== null ? (
              <Check
                ok={v.data.resultMatches}
                label={`El cálculo da ${v.data.computedSymbol?.number} ${v.data.computedSymbol?.name}, igual al resultado publicado`}
              />
            ) : (
              <p className="text-xs text-black/50">Juego de resultado oficial (carga manual con doble verificación): {d.result_evidence}</p>
            )}
          </div>
        </>
      ) : (
        <p className="text-black/50">{v.data.message}</p>
      )}
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="label">{label}</div>
      <div className="rounded-lg bg-black/[0.03] px-2 py-1.5 font-mono text-[11px] break-all">{value}</div>
    </div>
  );
}

function Check({ ok, label }: { ok: boolean; label: string }) {
  return <div className={ok ? 'text-emerald-700' : 'text-red-700'}>{ok ? '✔' : '✘'} {label}</div>;
}
