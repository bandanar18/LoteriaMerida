import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ErrorBox, Modal, Notice, PageTitle, Spinner, StatusBadge } from '../../components/ui';
import { get, getBlob, post } from '../../lib/api';
import { Currency, dateTime, DRAW_STATUS_LABEL, hour, money, todayCaracas } from '../../lib/format';
import { Game, symbolWords, useAdminGames, useGameSymbols } from '../../lib/queries';
import { NumberBalls } from '../../components/SymbolArt';

export function DrawsPage() {
  const games = useAdminGames();
  const [gameId, setGameId] = useState<string>();
  const [date, setDate] = useState(todayCaracas());
  const [selected, setSelected] = useState<string | null>(null);
  const [extraOpen, setExtraOpen] = useState(false);
  const game = games.data?.find((g) => g.id === gameId) ?? games.data?.find((g) => g.status === 'ACTIVE') ?? games.data?.[0];
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
          <div className="grid w-full grid-cols-2 gap-2 sm:flex sm:w-auto sm:flex-wrap">
            <select
              className={`input col-span-2 sm:w-auto ${(games.data?.length ?? 0) < 2 ? 'hidden' : ''}`}
              value={game?.id}
              onChange={(e) => setGameId(e.target.value)}
            >
              {games.data?.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name} ({g.result_source === 'INTERNAL_RNG' ? 'RNG' : 'manual'}){g.status === 'INACTIVE' ? ' · Deshabilitado' : ''}
                </option>
              ))}
            </select>
            <input type="date" className="input sm:w-auto" value={date} onChange={(e) => setDate(e.target.value)} />
            <button className="btn-gold" disabled={game?.status !== 'ACTIVE'} onClick={() => setExtraOpen(true)}>
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
                      {hour(d.draw_at)} {d.is_extraordinary && '⭐'} {d.auto_rng && <span className="badge bg-sky-100 text-sky-800">auto</span>}
                      <div className="text-[11px] font-normal text-black/40">cierre {hour(d.close_at)}</div>
                    </td>
                    <td>
                      <StatusBadge status={d.status} label={DRAW_STATUS_LABEL[d.status]} />
                      {d.requires_record && <div className="mt-1 text-[11px] text-black/50">{d.has_record ? '✔ acta' : 'sin acta'}</div>}
                      {d.open_incidents > 0 && <div className="text-[11px] text-amber-700">⚠ {d.open_incidents} incidencia(s)</div>}
                      {d.max_risk_pct >= 80 && <div className="text-[11px] font-medium text-red-700">▲ Riesgo {d.max_risk_pct}% del tope</div>}
                    </td>
                    <td>
                      {d.result_numbers ? (
                        <NumberBalls numbers={d.result_numbers} />
                      ) : d.proposed_numbers ? (
                        <>Propuesto: <NumberBalls numbers={d.proposed_numbers} /></>
                      ) : d.result_number ? (
                        `${d.result_emoji ?? ''} ${d.result_number} ${d.result_name !== d.result_number ? d.result_name : ''}`
                      ) : d.proposed_number ? (
                        `Propuesto: ${d.proposed_number} ${d.proposed_name !== d.proposed_number ? d.proposed_name : ''}`
                      ) : (
                        '—'
                      )}
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
  const w = symbolWords(game);
  const symbols = useGameSymbols(game);
  const qc = useQueryClient();
  const [currency, setCurrency] = useState<Currency>('VES');
  const [symbolId, setSymbolId] = useState('');
  // Kino: los números extraídos en orden, escritos separados por espacio o coma.
  const isKino = game.board === 'KINO';
  const [kinoText, setKinoText] = useState('');
  const kinoNumbers = kinoText.split(/[^0-9]+/).filter(Boolean).map(Number);
  const kinoOk =
    kinoNumbers.length === game.draw_count && new Set(kinoNumbers).size === kinoNumbers.length && kinoNumbers.every((n) => n >= 1 && n <= game.symbol_count);
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
  const net: bigint = (totalStaked as bigint) - (worst as bigint);
  const hot = rows.filter((r: any) => BigInt(r.liability) * 100n >= BigInt(r.cap) * 80n);
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
          {isKino ? (
            <>
              <input
                className="input font-mono"
                inputMode="numeric"
                placeholder={`Los ${game.draw_count} números en orden de extracción (ej. 02 07 13 22 24 28 35)`}
                value={kinoText}
                onChange={(e) => setKinoText(e.target.value)}
              />
              {kinoNumbers.length > 0 && (
                <div className="flex items-center gap-2 text-xs">
                  <NumberBalls numbers={kinoNumbers} />
                  <span className={kinoOk ? 'text-emerald-700' : 'text-black/50'}>
                    {kinoOk ? 'Listo' : `${kinoNumbers.length} de ${game.draw_count}, distintos, del 01 al ${game.symbol_count}`}
                  </span>
                </div>
              )}
            </>
          ) : (
          <select className="input" value={symbolId} onChange={(e) => setSymbolId(e.target.value)}>
            <option value="">Selecciona {w.one === 'fruta' ? 'la fruta' : w.one === 'número' ? 'el número' : 'el animal'}…</option>
            {symbols.map((s) => (
              <option key={s.id} value={s.id}>
                {s.number} {s.name !== s.number ? s.name : ''}
              </option>
            ))}
          </select>
          )}
          <input className="input" placeholder="Evidencia (URL del resultado oficial, nº de acta…)" value={evidence} onChange={(e) => setEvidence(e.target.value)} />
          <button className="btn-primary w-full" disabled={(isKino ? !kinoOk : !symbolId) || evidence.length < 3 || action.isPending}
            onClick={() => action.mutate({ path: 'propose-result', body: isKino ? { numbers: kinoNumbers, evidence } : { symbolId, evidence } })}>
            Proponer resultado
          </button>
        </div>
      )}
      {isManual && draw.status === 'CLOSED' && !due && <Notice>Venta cerrada. Podrás cargar el resultado a partir de las {hour(draw.draw_at)}.</Notice>}

      {draw.status === 'RESULT_PENDING' && (
        <div className="space-y-2 rounded-xl bg-orange-50 p-3 text-sm">
          <div className="font-semibold">Confirmar resultado (paso 2 de 2)</div>
          <div>
            Propuesto:{' '}
            <b>{draw.proposed_numbers ? <NumberBalls numbers={draw.proposed_numbers} /> : <>{draw.proposed_number} {draw.proposed_name !== draw.proposed_number ? draw.proposed_name : ''}</>}</b>{' '}
            por {draw.proposed_by_email}
          </div>
          <div className="text-xs text-black/60">Evidencia: {draw.result_evidence}</div>
          {draw.requires_record && !draw.has_record && <Notice tone="warn">Falta el acta: regístrala abajo para poder confirmar.</Notice>}
          <div className="flex gap-2">
            <button
              className="btn-primary flex-1"
              disabled={action.isPending || (draw.requires_record && !draw.has_record)}
              onClick={() => action.mutate({ path: 'confirm-result' })}
            >
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

      <Certification draw={draw} onChange={refresh} />

      <div>
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-sm font-semibold">Exposición por {w.one}</h3>
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
        {hot.length > 0 && (
          <Notice tone="warn">
            {hot.length} {w.one}(s) sobre el 80 % del tope: {hot.map((r: any) => `${r.number} ${r.name}`).join(", ")}. Al llegar al tope se dejan de vender.
          </Notice>
        )}
        <div className="mb-2 text-xs text-black/60">
          Resultado neto si sale {w.one === 'fruta' ? 'la peor fruta' : w.one === 'número' ? 'el peor número' : 'el peor animal'}: <b className={net < 0n ? "text-red-700" : "text-selva-700"}>{money(net, currency)}</b>
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
        <p className="mt-1 text-[11px] text-black/40">Barra = pasivo potencial vs. cupo por {w.one} ({money(rows[0]?.cap ?? '0', currency)}).</p>
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
  const [auto, setAuto] = useState(true);
  const create = useMutation({
    mutationFn: () => post(`/admin/lottery/games/${game.id}/extraordinary-draw`, { minutesFromNow: minutes, auto }),
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
        <label className="flex items-start gap-2 rounded-xl bg-black/[0.03] p-3 text-sm">
          <input type="checkbox" className="mt-0.5" checked={auto} onChange={(e) => setAuto(e.target.checked)} />
          <span>
            <b>Resultado automático</b>
            <span className="block text-xs text-black/55">
              El generador aleatorio verificable pone el resultado a la hora del sorteo. Si lo desmarcas, se carga a mano con acta.
            </span>
          </span>
        </label>
        <ErrorBox error={create.error} />
        <button className="btn-primary w-full" disabled={create.isPending} onClick={() => create.mutate()}>
          Crear sorteo
        </button>
      </div>
    </Modal>
  );
}

const INCIDENT_KIND: Record<string, string> = {
  HUMAN: 'Humana',
  MECHANICAL: 'Mecánica',
  IT: 'Informática',
  COMMUNICATIONS: 'Comunicaciones',
  CANCELLATION: 'Anulación',
  OTHER: 'Otra',
};

/** Acta (MER-05 §7) e incidencias (§9) del sorteo. */
function Certification({ draw, onChange }: { draw: any; onChange: () => void }) {
  const qc = useQueryClient();
  const cert = useQuery({ queryKey: ['admin', 'cert', draw.id], queryFn: () => get<any>(`/admin/lottery/draws/${draw.id}/certification`) });
  const [rec, setRec] = useState({ recordNumber: '', executor: '', inspector: '', notes: '' });
  const [file, setFile] = useState<File | null>(null);
  const [inc, setInc] = useState({ kind: 'IT', description: '', responsible: '', publicNotice: '' });
  const [incOpen, setIncOpen] = useState(false);
  const [resolving, setResolving] = useState<{ id: string; text: string } | null>(null);
  const done = () => {
    qc.invalidateQueries({ queryKey: ['admin', 'cert', draw.id] });
    onChange();
  };
  const saveRecord = useMutation({
    mutationFn: () => {
      const fd = new FormData();
      Object.entries(rec).forEach(([k, v]) => v && fd.append(k, v));
      if (file) fd.append('file', file);
      return post(`/admin/lottery/draws/${draw.id}/record`, fd);
    },
    onSuccess: done,
  });
  const saveIncident = useMutation({
    mutationFn: () => post(`/admin/lottery/draws/${draw.id}/incidents`, { ...inc, publicNotice: inc.publicNotice || undefined }),
    onSuccess: () => {
      setInc({ kind: 'IT', description: '', responsible: '', publicNotice: '' });
      setIncOpen(false);
      done();
    },
  });
  const resolve = useMutation({
    mutationFn: ({ id, resolution }: { id: string; resolution: string }) => post(`/admin/lottery/incidents/${id}/resolve`, { resolution }),
    onSuccess: () => {
      setResolving(null);
      done();
    },
  });
  async function openFile() {
    const blob = await getBlob(`/admin/lottery/draws/${draw.id}/record/file`);
    window.open(URL.createObjectURL(blob), '_blank', 'noopener');
  }

  const record = cert.data?.record;
  const canRecord = ['CLOSED', 'RESULT_PENDING'].includes(draw.status) && new Date(draw.draw_at).getTime() <= Date.now();

  return (
    <div className="space-y-3">
      {(draw.requires_record || record) && (
        <div className="rounded-xl bg-black/[0.03] p-3 text-sm">
          <div className="mb-2 font-semibold">Acta del sorteo</div>
          {record ? (
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
              <dt className="text-black/50">Nº de acta</dt>
              <dd className="font-medium">{record.record_number}</dd>
              <dt className="text-black/50">Ejecutor</dt>
              <dd>{record.executor}</dd>
              <dt className="text-black/50">Fiscal</dt>
              <dd>{record.inspector}</dd>
              {record.notes && (
                <>
                  <dt className="text-black/50">Notas</dt>
                  <dd>{record.notes}</dd>
                </>
              )}
              <dt className="text-black/50">Registró</dt>
              <dd className="break-all">
                {record.created_by_email} · {dateTime(record.created_at)}
              </dd>
              {record.file_sha256 && (
                <>
                  <dt className="text-black/50">Archivo</dt>
                  <dd>
                    <button className="font-semibold text-selva-700 underline" onClick={openFile}>
                      Ver acta
                    </button>{' '}
                    <span className="font-mono text-[10px] break-all text-black/40">sha256 {record.file_sha256.slice(0, 16)}…</span>
                  </dd>
                </>
              )}
            </dl>
          ) : canRecord ? (
            <div className="space-y-2">
              <input className="input" placeholder="Nº de acta" value={rec.recordNumber} onChange={(e) => setRec({ ...rec, recordNumber: e.target.value })} />
              <div className="grid gap-2 sm:grid-cols-2">
                <input className="input" placeholder="Ejecutor del sorteo" value={rec.executor} onChange={(e) => setRec({ ...rec, executor: e.target.value })} />
                <input className="input" placeholder="Fiscal / fedatario" value={rec.inspector} onChange={(e) => setRec({ ...rec, inspector: e.target.value })} />
              </div>
              <input className="input" placeholder="Notas (opcional)" value={rec.notes} onChange={(e) => setRec({ ...rec, notes: e.target.value })} />
              <label className="block text-xs text-black/60">
                Archivo del acta (PDF, JPG o PNG · máx. 5 MB, opcional)
                <input
                  type="file"
                  accept="application/pdf,image/jpeg,image/png"
                  className="mt-1 block w-full text-xs"
                  onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                />
              </label>
              <ErrorBox error={saveRecord.error} />
              <button
                className="btn-primary w-full"
                disabled={!rec.recordNumber || rec.executor.length < 3 || rec.inspector.length < 3 || saveRecord.isPending}
                onClick={() => saveRecord.mutate()}
              >
                Registrar acta
              </button>
            </div>
          ) : (
            <p className="text-xs text-black/50">El acta se registra cuando el sorteo ya se realizó y antes de confirmar el resultado.</p>
          )}
        </div>
      )}

      <div className="rounded-xl bg-black/[0.03] p-3 text-sm">
        <div className="mb-2 flex items-center justify-between">
          <span className="font-semibold">Incidencias</span>
          {!incOpen && (
            <button className="text-xs font-semibold text-selva-700" onClick={() => setIncOpen(true)}>
              + Registrar
            </button>
          )}
        </div>
        {incOpen && (
          <div className="mb-3 space-y-2">
            <select className="input" value={inc.kind} onChange={(e) => setInc({ ...inc, kind: e.target.value })}>
              {Object.entries(INCIDENT_KIND)
                .filter(([k]) => k !== 'CANCELLATION')
                .map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
            </select>
            <textarea className="input" rows={2} placeholder="Qué ocurrió" value={inc.description} onChange={(e) => setInc({ ...inc, description: e.target.value })} />
            <input className="input" placeholder="Responsable" value={inc.responsible} onChange={(e) => setInc({ ...inc, responsible: e.target.value })} />
            <input
              className="input"
              placeholder="Aviso al público (opcional, se muestra en Resultados)"
              value={inc.publicNotice}
              onChange={(e) => setInc({ ...inc, publicNotice: e.target.value })}
            />
            <ErrorBox error={saveIncident.error} />
            <div className="flex gap-2">
              <button
                className="btn-primary flex-1"
                disabled={inc.description.length < 3 || inc.responsible.length < 3 || saveIncident.isPending}
                onClick={() => saveIncident.mutate()}
              >
                Guardar
              </button>
              <button className="btn-ghost" onClick={() => setIncOpen(false)}>
                Cancelar
              </button>
            </div>
          </div>
        )}
        {cert.data?.incidents?.length ? (
          <ul className="space-y-2">
            {cert.data.incidents.map((i: any) => (
              <li key={i.id} className="rounded-lg bg-white p-2 text-xs ring-1 ring-black/5">
                <div className="flex justify-between gap-2">
                  <b>{INCIDENT_KIND[i.kind] ?? i.kind}</b>
                  <span className="text-black/40">{dateTime(i.occurred_at)}</span>
                </div>
                <p className="mt-0.5">{i.description}</p>
                <p className="text-black/50">Responsable: {i.responsible}</p>
                {i.public_notice && <p className="text-amber-700">Aviso: {i.public_notice}</p>}
                {i.resolved_at ? (
                  <p className="text-emerald-700">✔ {i.resolution}</p>
                ) : resolving?.id === i.id ? (
                  <div className="mt-1 flex gap-1">
                    <input
                      className="input py-1.5"
                      placeholder="Cómo se resolvió"
                      value={resolving!.text}
                      onChange={(e) => setResolving({ id: i.id, text: e.target.value })}
                    />
                    <button
                      className="btn-primary px-3 py-1.5"
                      disabled={resolving!.text.trim().length < 3 || resolve.isPending}
                      onClick={() => resolve.mutate({ id: i.id, resolution: resolving!.text.trim() })}
                    >
                      OK
                    </button>
                  </div>
                ) : (
                  <button className="mt-1 font-semibold text-selva-700" onClick={() => setResolving({ id: i.id, text: '' })}>
                    Marcar resuelta
                  </button>
                )}
              </li>
            ))}
          </ul>
        ) : (
          !incOpen && <p className="text-xs text-black/40">Sin incidencias.</p>
        )}
        <ErrorBox error={resolve.error} />
      </div>
    </div>
  );
}
