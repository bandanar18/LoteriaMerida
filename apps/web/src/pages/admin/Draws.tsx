import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ErrorBox, Modal, Notice, PageTitle, Spinner, StatusBadge } from '../../components/ui';
import { get, post } from '../../lib/api';
import { Currency, dateTime, DRAW_STATUS_LABEL, hour, money, todayCaracas } from '../../lib/format';
import { Game, useGames } from '../../lib/queries';

export function DrawsPage() {
  const games = useGames();
  const [gameId, setGameId] = useState<string>();
  const [date, setDate] = useState(todayCaracas());
  const [selected, setSelected] = useState<string | null>(null);
  const [extraOpen, setExtraOpen] = useState(false);
  const game = games.data?.find((g) => g.id === gameId) ?? games.data?.[0];
  const draws = useQuery({
    queryKey: ['admin', 'draws', game?.id, date],
    enabled: !!game,
    refetchInterval: 60_000,
    queryFn: () => get<any[]>(`/admin/lottery/games/${game!.id}/draws?date=${date}`),
  });
  const current = draws.data?.find((d) => d.id === selected);

  return (
    <div className="space-y-4">
      <PageTitle
        actions={
          <div className="flex flex-wrap gap-2">
            <select className="input w-auto" value={game?.id} onChange={(e) => setGameId(e.target.value)}>
              {games.data?.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name} ({g.result_source === 'INTERNAL_RNG' ? 'RNG' : 'manual'})
                </option>
              ))}
            </select>
            <input type="date" className="input w-auto" value={date} onChange={(e) => setDate(e.target.value)} />
            <button className="btn-gold" onClick={() => setExtraOpen(true)}>
              + Sorteo extraordinario
            </button>
          </div>
        }
      >
        Sorteos
      </PageTitle>

      <div className="grid gap-4 xl:grid-cols-[1fr_420px]">
        <div className="card overflow-x-auto">
          {draws.isLoading ? (
            <Spinner />
          ) : (
            <table className="table-base">
              <thead>
                <tr>
                  <th>Hora</th>
                  <th>Estado</th>
                  <th>Resultado</th>
                  <th className="text-right">Jugadas</th>
                  <th className="text-right">Ventas</th>
                  <th className="text-right">Premios</th>
                </tr>
              </thead>
              <tbody>
                {draws.data?.map((d) => (
                  <tr key={d.id} onClick={() => setSelected(d.id)} className={`cursor-pointer hover:bg-black/[0.02] ${selected === d.id ? 'bg-oro-300/30' : ''}`}>
                    <td className="font-semibold whitespace-nowrap">
                      {hour(d.draw_at)} {d.is_extraordinary && '⭐'}
                      <div className="text-[11px] font-normal text-black/40">cierre {hour(d.close_at)}</div>
                    </td>
                    <td>
                      <StatusBadge status={d.status} label={DRAW_STATUS_LABEL[d.status]} />
                    </td>
                    <td>
                      {d.result_number ? `${d.result_emoji} ${d.result_number} ${d.result_name}` : d.proposed_number ? `Propuesto: ${d.proposed_number} ${d.proposed_name}` : '—'}
                    </td>
                    <td className="text-right tabular-nums">{d.plays}</td>
                    <td className="text-right text-xs tabular-nums">
                      {Object.entries(d.sold_by_currency).map(([c, v]) => (
                        <div key={c}>{money(v as string, c as Currency)}</div>
                      ))}
                    </td>
                    <td className="text-right text-xs tabular-nums">
                      {Object.entries(d.paid_by_currency).map(([c, v]) => (
                        <div key={c}>{money(v as string, c as Currency)}</div>
                      ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <div>{current && game ? <DrawPanel key={current.id} draw={current} game={game} /> : <Notice>Selecciona un sorteo para ver su exposición y acciones.</Notice>}</div>
      </div>

      {game && <ExtraordinaryModal open={extraOpen} onClose={() => setExtraOpen(false)} game={game} />}
    </div>
  );
}

function DrawPanel({ draw, game }: { draw: any; game: Game }) {
  const qc = useQueryClient();
  const [currency, setCurrency] = useState<Currency>('VES');
  const [symbolId, setSymbolId] = useState('');
  const [evidence, setEvidence] = useState('');
  const [cancelReason, setCancelReason] = useState('');
  const exposure = useQuery({
    queryKey: ['admin', 'exposure', draw.id],
    refetchInterval: 60_000,
    queryFn: () => get(`/admin/lottery/draws/${draw.id}/exposure`),
  });
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['admin', 'draws'] });
    qc.invalidateQueries({ queryKey: ['admin', 'exposure', draw.id] });
  };
  const action = useMutation({
    mutationFn: ({ path, body }: { path: string; body?: unknown }) => post(`/admin/lottery/draws/${draw.id}/${path}`, body),
    onSuccess: refresh,
  });

  const rows = (exposure.data?.rows ?? []).filter((r: any) => r.currency === currency);
  const worst = rows.reduce((m: bigint, r: any) => (BigInt(r.liability) > m ? BigInt(r.liability) : m), 0n);
  const totalStaked = rows.reduce((a: bigint, r: any) => a + BigInt(r.staked), 0n);
  const isManual = game.result_source !== 'INTERNAL_RNG';
  const due = new Date(draw.draw_at).getTime() <= Date.now();
  const canCancel = !['SETTLED', 'CANCELLED', 'RESULT_CONFIRMED'].includes(draw.status);

  return (
    <div className="card space-y-4 p-4">
      <div className="flex items-start justify-between">
        <div>
          <h2 className="font-semibold">Sorteo {hour(draw.draw_at)}</h2>
          <div className="text-xs text-black/50">{dateTime(draw.draw_at)}</div>
        </div>
        <StatusBadge status={draw.status} label={DRAW_STATUS_LABEL[draw.status]} />
      </div>
      <div className="font-mono text-[10px] break-all text-black/40">Compromiso: {draw.seed_hash}</div>

      {isManual && draw.status === 'CLOSED' && due && (
        <div className="space-y-2 rounded-xl bg-black/[0.03] p-3">
          <div className="text-sm font-semibold">Cargar resultado oficial (paso 1 de 2)</div>
          <select className="input" value={symbolId} onChange={(e) => setSymbolId(e.target.value)}>
            <option value="">Selecciona el animal…</option>
            {game.symbols.map((s) => (
              <option key={s.id} value={s.id}>
                {s.number} {s.name}
              </option>
            ))}
          </select>
          <input className="input" placeholder="Evidencia (URL del resultado oficial, nº de acta…)" value={evidence} onChange={(e) => setEvidence(e.target.value)} />
          <button className="btn-primary w-full" disabled={!symbolId || evidence.length < 3 || action.isPending} onClick={() => action.mutate({ path: 'propose-result', body: { symbolId, evidence } })}>
            Proponer resultado
          </button>
        </div>
      )}
      {isManual && draw.status === 'CLOSED' && !due && <Notice>Venta cerrada. Podrás cargar el resultado a partir de las {hour(draw.draw_at)}.</Notice>}

      {draw.status === 'RESULT_PENDING' && (
        <div className="space-y-2 rounded-xl bg-orange-50 p-3 text-sm">
          <div className="font-semibold">Confirmar resultado (paso 2 de 2)</div>
          <div>
            Propuesto: <b>{draw.proposed_number} {draw.proposed_name}</b> por {draw.proposed_by_email}
          </div>
          <div className="text-xs text-black/60">Evidencia: {draw.result_evidence}</div>
          <div className="flex gap-2">
            <button className="btn-primary flex-1" disabled={action.isPending} onClick={() => action.mutate({ path: 'confirm-result' })}>
              Confirmar y liquidar
            </button>
            <button className="btn-ghost" disabled={action.isPending} onClick={() => action.mutate({ path: 'reject-result' })}>
              Rechazar
            </button>
          </div>
          <p className="text-xs text-black/50">Debe confirmarlo un usuario distinto a quien lo propuso.</p>
        </div>
      )}

      <ErrorBox error={action.error} />

      <div>
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-sm font-semibold">Exposición por animal</h3>
          <div className="flex rounded-lg bg-black/5 p-0.5 text-xs">
            {(['VES', 'USDT'] as Currency[]).map((c) => (
              <button key={c} onClick={() => setCurrency(c)} className={`rounded-md px-2 py-1 ${currency === c ? 'bg-white shadow-sm' : ''}`}>
                {c}
              </button>
            ))}
          </div>
        </div>
        <div className="mb-2 grid grid-cols-2 gap-2 text-xs">
          <div className="rounded-lg bg-black/[0.03] p-2">
            Vendido: <b>{money(totalStaked, currency)}</b>
          </div>
          <div className="rounded-lg bg-black/[0.03] p-2">
            Peor caso: <b className="text-red-700">{money(worst, currency)}</b>
          </div>
        </div>
        <ul className="max-h-80 space-y-1 overflow-y-auto">
          {rows
            .filter((r: any) => BigInt(r.staked) > 0n)
            .map((r: any) => {
              const pct = Number((BigInt(r.liability) * 1000n) / BigInt(r.cap)) / 10;
              return (
                <li key={r.symbol_id} className="text-xs">
                  <div className="flex justify-between">
                    <span>
                      {r.emoji} {r.number} {r.name}
                    </span>
                    <span className="tabular-nums">
                      {money(r.staked, currency)} → {money(r.liability, currency)}
                    </span>
                  </div>
                  <div className="h-1.5 rounded-full bg-black/5">
                    <div className={`h-1.5 rounded-full ${pct > 80 ? 'bg-red-500' : pct > 50 ? 'bg-oro-500' : 'bg-selva-600'}`} style={{ width: `${Math.min(pct, 100)}%` }} />
                  </div>
                </li>
              );
            })}
          {rows.every((r: any) => BigInt(r.staked) === 0n) && <li className="py-4 text-center text-xs text-black/40">Sin ventas en {currency}.</li>}
        </ul>
        <p className="mt-1 text-[11px] text-black/40">Barra = pasivo potencial vs. cupo por animal ({money(rows[0]?.cap ?? '0', currency)}).</p>
      </div>

      {canCancel && (
        <div className="space-y-2 border-t border-black/5 pt-3">
          <input className="input" placeholder="Motivo de anulación" value={cancelReason} onChange={(e) => setCancelReason(e.target.value)} />
          <button
            className="btn-danger w-full"
            disabled={cancelReason.length < 3 || action.isPending}
            onClick={() => confirm('¿Anular el sorteo y reembolsar todas las jugadas?') && action.mutate({ path: 'cancel', body: { reason: cancelReason } })}
          >
            Anular sorteo y reembolsar
          </button>
        </div>
      )}
    </div>
  );
}

function ExtraordinaryModal({ open, onClose, game }: { open: boolean; onClose: () => void; game: Game }) {
  const qc = useQueryClient();
  const [minutes, setMinutes] = useState(game.close_minutes_before + 5);
  const create = useMutation({
    mutationFn: () => post(`/admin/lottery/games/${game.id}/extraordinary-draw`, { minutesFromNow: minutes }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin', 'draws'] });
      qc.invalidateQueries({ queryKey: ['draws'] });
      onClose();
    },
  });
  return (
    <Modal open={open} onClose={onClose} title={`Sorteo extraordinario · ${game.name}`}>
      <div className="space-y-3">
        <p className="text-sm text-black/60">Se abre la venta de inmediato. La venta cierra {game.close_minutes_before} minutos antes del sorteo.</p>
        <div>
          <label className="label">Minutos hasta el sorteo</label>
          <input className="input" type="number" min={game.close_minutes_before + 1} value={minutes} onChange={(e) => setMinutes(Number(e.target.value))} />
        </div>
        <ErrorBox error={create.error} />
        <button className="btn-primary w-full" disabled={create.isPending} onClick={() => create.mutate()}>
          Crear sorteo
        </button>
      </div>
    </Modal>
  );
}
