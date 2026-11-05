import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Empty, ErrorBox, Modal, Notice, PageTitle, Spinner, StatusBadge } from '../../components/ui';
import { get, post } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { dateTime, money } from '../../lib/format';
import { Catalog, EVENT_STATUS_LABEL, Market, marketName, MarketTemplate, showOdds, SPORT_ICON, SportEvent, toOdds, useCatalog } from '../../lib/sports';

const MARKET_STATUS_LABEL: Record<string, string> = {
  OPEN: 'Abierto',
  SUSPENDED: 'Suspendido',
  CLOSED: 'Cerrado',
  SETTLED: 'Liquidado',
  VOIDED: 'Anulado',
};

/** Margen del mercado en % (Σ 1/cuota − 1), calculado con enteros. */
function marginPct(odds: string[]): string {
  if (odds.some((o) => !/^\d{1,4}(\.\d{1,4})?$/.test(o))) return '—';
  const S = 10_000n;
  const bps = odds.reduce((acc, o) => acc + (S * S * 10_000n) / toOdds(o), 0n) / S - 10_000n;
  return `${(Number(bps) / 100).toFixed(1)} %`;
}

/** Trading manual del sportsbook (Doc. Maestro §16.5). */
export function SportsTradingPage() {
  const catalog = useCatalog();
  const events = useQuery({ queryKey: ['admin', 'sports', 'events'], queryFn: () => get<SportEvent[]>('/admin/sports/events'), refetchInterval: 60_000 });
  const [creating, setCreating] = useState(false);
  const { user } = useAuth();
  const canTrade = user?.role === 'SPORTS_TRADER' || user?.role === 'ADMIN';

  return (
    <div className="space-y-4">
      <PageTitle actions={canTrade && <button className="btn-primary" onClick={() => setCreating(true)}>+ Nuevo evento</button>}>Deportes · trading</PageTitle>
      {!canTrade && <Notice>Vista de solo lectura: las acciones requieren rol de trader.</Notice>}
      {events.isLoading || catalog.isLoading ? (
        <Spinner />
      ) : !events.data?.length ? (
        <Empty>No hay eventos. Crea el primero.</Empty>
      ) : (
        events.data.map((ev) => <EventPanel key={ev.id} ev={ev} catalog={catalog.data!} canTrade={canTrade} />)
      )}
      <Modal open={creating} onClose={() => setCreating(false)} title="Nuevo evento">
        {catalog.data && <CreateEvent catalog={catalog.data} onDone={() => setCreating(false)} />}
      </Modal>
    </div>
  );
}

function useAction(onSuccess?: () => void) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ path, body }: { path: string; body?: unknown }) => post(path, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin', 'sports'] });
      onSuccess?.();
    },
  });
}

function EventPanel({ ev, catalog, canTrade }: { ev: SportEvent; catalog: Catalog; canTrade: boolean }) {
  const { user } = useAuth();
  const action = useAction();
  const [score, setScore] = useState({ home: ev.home_score ?? 0, away: ev.away_score ?? 0 });
  const [resultOpen, setResultOpen] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  useEffect(() => setScore({ home: ev.home_score ?? 0, away: ev.away_score ?? 0 }), [ev.home_score, ev.away_score]);

  const base = `/admin/sports/events/${ev.id}`;
  const active = ev.status === 'NOT_STARTED' || ev.status === 'LIVE';
  const started = new Date(ev.starts_at).getTime() <= Date.now();
  const canPropose = (ev.status === 'LIVE' || (ev.status === 'NOT_STARTED' && started) || (ev.status === 'FINISHED' && ev.result_status === 'NONE'));
  const openBets = ev.markets.reduce((acc, m) => acc + m.selections.reduce((a, s) => a + (s.bets ?? 0), 0), 0);

  return (
    <section className={`card p-4 ${ev.result_status === 'PROPOSED' ? 'ring-2 ring-orange-300' : ev.status === 'LIVE' ? 'ring-1 ring-red-200' : ''}`}>
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-xs text-black/50">
            {SPORT_ICON[ev.sport]} {ev.competition} · {dateTime(ev.starts_at)} · {openBets} {openBets === 1 ? 'apuesta' : 'apuestas'}
          </div>
          <h2 className="text-lg font-semibold">
            {ev.home} <span className="font-normal text-black/40">vs</span> {ev.away}
            {ev.home_score !== null && (
              <span className="ml-2 tabular-nums">
                {ev.home_score} - {ev.away_score}
              </span>
            )}
          </h2>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge status={ev.status} label={EVENT_STATUS_LABEL[ev.status]} />
          {ev.result_status !== 'NONE' && <StatusBadge status={ev.result_status === 'PROPOSED' ? 'PROPOSED' : 'SETTLED'} label={ev.result_status === 'PROPOSED' ? 'Resultado por confirmar' : 'Liquidado'} />}
        </div>
      </header>

      {canTrade && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {ev.status === 'NOT_STARTED' && (
            <button className="btn-ghost" onClick={() => action.mutate({ path: `${base}/live` })}>
              ▶ Iniciar en vivo
            </button>
          )}
          {ev.status === 'LIVE' && (
            <div className="flex items-center gap-1 rounded-xl bg-black/5 p-1">
              <ScoreInput label={ev.home} value={score.home} onChange={(home) => setScore((s) => ({ ...s, home }))} />
              <span className="text-black/40">-</span>
              <ScoreInput label={ev.away} value={score.away} onChange={(away) => setScore((s) => ({ ...s, away }))} />
              <button className="btn-primary px-3 py-1.5" onClick={() => action.mutate({ path: `${base}/score`, body: score })}>
                Actualizar
              </button>
            </div>
          )}
          {active && (
            <>
              <button className="btn-ghost" onClick={() => action.mutate({ path: `${base}/markets-status`, body: { status: 'SUSPENDED' } })}>
                🔒 Suspender todo
              </button>
              <button className="btn-ghost" onClick={() => action.mutate({ path: `${base}/markets-status`, body: { status: 'OPEN' } })}>
                🔓 Abrir todo
              </button>
              <button className="btn-ghost" onClick={() => setAddOpen(true)}>
                + Mercado
              </button>
            </>
          )}
          {canPropose && (
            <button className="btn-gold" onClick={() => setResultOpen(true)}>
              Cargar resultado final
            </button>
          )}
          {ev.status !== 'CANCELLED' && ev.result_status !== 'CONFIRMED' && (
            <button className="ml-auto text-sm text-red-600 hover:underline" onClick={() => setCancelOpen(true)}>
              Cancelar evento
            </button>
          )}
        </div>
      )}

      {ev.result_status === 'PROPOSED' && (
        <div className="mt-3 rounded-xl bg-orange-50 p-3 text-sm ring-1 ring-orange-200">
          <div>
            Resultado propuesto:{' '}
            <b className="tabular-nums">
              {ev.proposed_home} - {ev.proposed_away}
            </b>{' '}
            por {ev.proposed_by_email} · Evidencia: {ev.proposed_evidence}
          </div>
          {canTrade && (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <button className="btn-primary" disabled={ev.proposed_by === user?.id} onClick={() => action.mutate({ path: `${base}/confirm-result` })}>
                Confirmar y liquidar
              </button>
              <button className="btn-ghost" onClick={() => action.mutate({ path: `${base}/reject-result` })}>
                Rechazar
              </button>
              {ev.proposed_by === user?.id && <span className="text-xs text-black/50">Debe confirmarlo otro usuario (4 ojos).</span>}
            </div>
          )}
        </div>
      )}
      <div className="mt-2">
        <ErrorBox error={action.error} />
      </div>

      <div className="mt-3 space-y-2">
        {ev.markets.map((m) => (
          <MarketRow key={m.id} m={m} catalog={catalog} canTrade={canTrade} />
        ))}
      </div>

      <Modal open={resultOpen} onClose={() => setResultOpen(false)} title={`Resultado final · ${ev.home} vs ${ev.away}`}>
        <ProposeResult ev={ev} onDone={() => setResultOpen(false)} />
      </Modal>
      <Modal open={cancelOpen} onClose={() => setCancelOpen(false)} title="Cancelar evento">
        <ReasonForm
          text="Se anulan todos los mercados sin liquidar y se devuelve el monto de esas selecciones."
          button="Cancelar evento"
          path={`${base}/cancel`}
          onDone={() => setCancelOpen(false)}
        />
      </Modal>
      <Modal open={addOpen} onClose={() => setAddOpen(false)} title="Agregar mercado">
        <AddMarket ev={ev} catalog={catalog} onDone={() => setAddOpen(false)} />
      </Modal>
    </section>
  );
}

function ScoreInput({ label, value, onChange }: { label: string; value: number; onChange: (v: number) => void }) {
  return (
    <input
      aria-label={`Marcador ${label}`}
      type="number"
      min={0}
      className="w-14 rounded-lg bg-white px-2 py-1 text-center font-bold tabular-nums ring-1 ring-black/10"
      value={value}
      onChange={(e) => onChange(Math.max(0, Number(e.target.value) || 0))}
    />
  );
}

function MarketRow({ m, catalog, canTrade }: { m: Market; catalog: Catalog; canTrade: boolean }) {
  const [odds, setOdds] = useState<Record<string, string>>({});
  const [voidOpen, setVoidOpen] = useState(false);
  const action = useAction(() => setOdds({}));
  const editable = canTrade && (m.status === 'OPEN' || m.status === 'SUSPENDED');
  const current = m.selections.map((s) => odds[s.id] ?? showOdds(s.odds));
  const dirty = Object.entries(odds).some(([id, v]) => showOdds(m.selections.find((s) => s.id === id)!.odds) !== v);

  return (
    <div className="rounded-xl p-3 ring-1 ring-black/10">
      <div className="mb-2 flex flex-wrap items-center gap-2 text-sm">
        <span className="font-semibold">{marketName(catalog, m)}</span>
        {m.line && catalog.markets.find((t) => t.code === m.type)?.line === 'HANDICAP' && <span className="text-black/50">({m.line})</span>}
        <StatusBadge status={m.status} label={MARKET_STATUS_LABEL[m.status]} />
        <span className="text-xs text-black/50">Margen {marginPct(current)}</span>
        {m.void_reason && <span className="text-xs text-black/50">· {m.void_reason}</span>}
        {editable && (
          <div className="ml-auto flex gap-1">
            <button
              className="btn-ghost px-2.5 py-1 text-xs"
              onClick={() => action.mutate({ path: `/admin/sports/markets/${m.id}/status`, body: { status: m.status === 'OPEN' ? 'SUSPENDED' : 'OPEN' } })}
            >
              {m.status === 'OPEN' ? '🔒 Suspender' : '🔓 Abrir'}
            </button>
            {(m.status === 'OPEN' || m.status === 'SUSPENDED' || m.status === 'CLOSED') && (
              <button className="btn-ghost px-2.5 py-1 text-xs text-red-600" onClick={() => setVoidOpen(true)}>
                Anular
              </button>
            )}
          </div>
        )}
      </div>
      <div className={`grid gap-2 ${m.selections.length === 3 ? 'sm:grid-cols-3' : 'sm:grid-cols-2'}`}>
        {m.selections.map((s, i) => (
          <div key={s.id} className={`rounded-lg p-2 ${s.result === 'WIN' ? 'bg-emerald-50' : 'bg-black/[0.03]'}`}>
            <div className="flex items-center justify-between gap-2">
              <span className="truncate text-sm">{s.name}</span>
              {editable ? (
                <input
                  aria-label={`Cuota ${s.name}`}
                  className="w-20 rounded-lg bg-white px-2 py-1 text-right font-bold tabular-nums ring-1 ring-black/10"
                  inputMode="decimal"
                  value={current[i]}
                  onChange={(e) => setOdds((o) => ({ ...o, [s.id]: e.target.value.replace(',', '.') }))}
                />
              ) : (
                <span className="font-bold tabular-nums">{showOdds(s.odds)}</span>
              )}
            </div>
            <div className="mt-1 flex justify-between text-xs text-black/50">
              <span>{s.bets ?? 0} {s.bets === 1 ? 'apuesta' : 'apuestas'}</span>
              <span className="tabular-nums">
                Riesgo {money(s.exposure?.VES?.liability ?? '0', 'VES')}
                {s.exposure?.USDT && ` · ${money(s.exposure.USDT.liability, 'USDT')}`}
              </span>
            </div>
            {s.result && <div className="mt-1 text-xs font-semibold">{{ WIN: '✔ Ganadora', LOSE: 'Perdedora', VOID: 'Devolución' }[s.result]}</div>}
          </div>
        ))}
      </div>
      {dirty && (
        <div className="mt-2 flex items-center gap-2">
          <button className="btn-primary px-3 py-1.5" disabled={action.isPending} onClick={() => action.mutate({ path: `/admin/sports/markets/${m.id}/odds`, body: { odds } })}>
            Publicar cuotas
          </button>
          <button className="btn-ghost px-3 py-1.5" onClick={() => setOdds({})}>
            Descartar
          </button>
        </div>
      )}
      <ErrorBox error={action.error} />
      <Modal open={voidOpen} onClose={() => setVoidOpen(false)} title={`Anular ${marketName(catalog, m)}`}>
        <ReasonForm
          text="Todas las selecciones pasan a devolución (cuota 1.00 en combinadas)."
          button="Anular mercado"
          path={`/admin/sports/markets/${m.id}/void`}
          onDone={() => setVoidOpen(false)}
        />
      </Modal>
    </div>
  );
}

function ProposeResult({ ev, onDone }: { ev: SportEvent; onDone: () => void }) {
  const [home, setHome] = useState(ev.home_score ?? 0);
  const [away, setAway] = useState(ev.away_score ?? 0);
  const [evidence, setEvidence] = useState('');
  const action = useAction(onDone);
  return (
    <div className="space-y-3 text-sm">
      <p className="text-black/60">
        Se cierra la venta de todos los mercados. Otro usuario debe confirmar el marcador antes de liquidar. {ev.sport === 'FOOTBALL' ? 'Marcador a 90 minutos + añadido.' : 'Marcador final incluyendo entradas extra.'}
      </p>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="label" htmlFor="res-home">
            {ev.home}
          </label>
          <input id="res-home" type="number" min={0} className="input text-center text-lg font-bold" value={home} onChange={(e) => setHome(Number(e.target.value))} />
        </div>
        <div>
          <label className="label" htmlFor="res-away">
            {ev.away}
          </label>
          <input id="res-away" type="number" min={0} className="input text-center text-lg font-bold" value={away} onChange={(e) => setAway(Number(e.target.value))} />
        </div>
      </div>
      <div>
        <label className="label" htmlFor="res-evidence">
          Evidencia (acta, enlace oficial, transmisión)
        </label>
        <input id="res-evidence" className="input" value={evidence} onChange={(e) => setEvidence(e.target.value)} />
      </div>
      <ErrorBox error={action.error} />
      <button
        className="btn-gold w-full"
        disabled={evidence.trim().length < 3 || action.isPending}
        onClick={() => action.mutate({ path: `/admin/sports/events/${ev.id}/propose-result`, body: { home, away, evidence: evidence.trim() } })}
      >
        Proponer {home} - {away}
      </button>
    </div>
  );
}

function ReasonForm({ text, button, path, onDone }: { text: string; button: string; path: string; onDone: () => void }) {
  const [reason, setReason] = useState('');
  const action = useAction(onDone);
  return (
    <div className="space-y-3 text-sm">
      <p className="text-black/60">{text}</p>
      <input className="input" placeholder="Motivo" aria-label="Motivo" value={reason} onChange={(e) => setReason(e.target.value)} />
      <ErrorBox error={action.error} />
      <button className="btn-danger w-full" disabled={reason.trim().length < 3 || action.isPending} onClick={() => action.mutate({ path, body: { reason: reason.trim() } })}>
        {button}
      </button>
    </div>
  );
}

// ───────────── Alta de eventos y mercados ─────────────

interface MarketDraft {
  type: string;
  line: string;
  odds: Record<string, string>;
}

function MarketEditor({ template, draft, onChange, home, away }: { template: MarketTemplate; draft: MarketDraft; onChange: (d: MarketDraft) => void; home: string; away: string }) {
  const label = (n: string) =>
    n
      .replace('{home}', home || 'Local')
      .replace('{away}', away || 'Visitante')
      .replace('{-line}', draft.line ? (draft.line.startsWith('-') ? `+${draft.line.slice(1)}` : `-${draft.line.replace('+', '')}`) : '')
      .replace('{line}', draft.line);
  return (
    <div className="space-y-2 rounded-xl bg-black/[0.03] p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-semibold">{template.name}</span>
        {template.line && (
          <input
            aria-label="Línea"
            className="w-24 rounded-lg bg-white px-2 py-1 text-sm ring-1 ring-black/10"
            placeholder={template.line === 'TOTAL' ? '2.5' : '-1.5'}
            value={draft.line}
            onChange={(e) => onChange({ ...draft, line: e.target.value.replace(',', '.') })}
          />
        )}
      </div>
      <div className={`grid gap-2 ${template.selections.length === 3 ? 'grid-cols-3' : 'grid-cols-2'}`}>
        {template.selections.map((s) => (
          <label key={s.code} className="text-xs">
            <span className="mb-1 block truncate text-black/60">{label(s.name)}</span>
            <input
              className="w-full rounded-lg bg-white px-2 py-1.5 text-right font-bold tabular-nums ring-1 ring-black/10"
              inputMode="decimal"
              placeholder="1.90"
              value={draft.odds[s.code] ?? ''}
              onChange={(e) => onChange({ ...draft, odds: { ...draft.odds, [s.code]: e.target.value.replace(',', '.') } })}
            />
          </label>
        ))}
      </div>
      <div className="text-xs text-black/50">
        Margen {marginPct(template.selections.map((s) => draft.odds[s.code] ?? ''))} · {template.rule}
      </div>
    </div>
  );
}

function CreateEvent({ catalog, onDone }: { catalog: Catalog; onDone: () => void }) {
  const [competitionId, setCompetitionId] = useState(catalog.competitions[0]?.id ?? '');
  const [home, setHome] = useState('');
  const [away, setAway] = useState('');
  const [startsAt, setStartsAt] = useState('');
  const [drafts, setDrafts] = useState<Record<string, MarketDraft>>({});
  const comp = catalog.competitions.find((c) => c.id === competitionId);
  const templates = catalog.markets.filter((t) => t.sport === comp?.sport_code);
  const action = useAction(onDone);

  useEffect(() => setDrafts({}), [comp?.sport_code]);

  const submit = () =>
    action.mutate({
      path: '/admin/sports/events',
      body: {
        competitionId,
        home: home.trim(),
        away: away.trim(),
        // La hora se introduce en hora de Caracas (UTC−4, sin horario de verano).
        startsAt: `${startsAt}:00-04:00`,
        markets: Object.values(drafts).map((d) => ({ type: d.type, ...(d.line ? { line: d.line } : {}), odds: d.odds })),
      },
    });

  return (
    <div className="space-y-3 text-sm">
      <div>
        <label className="label" htmlFor="ev-comp">
          Competición
        </label>
        <select id="ev-comp" className="input" value={competitionId} onChange={(e) => setCompetitionId(e.target.value)}>
          {catalog.sports.map((s) => (
            <optgroup key={s.code} label={`${SPORT_ICON[s.code]} ${s.name}`}>
              {catalog.competitions
                .filter((c) => c.sport_code === s.code)
                .map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
            </optgroup>
          ))}
        </select>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="label" htmlFor="ev-home">
            Local
          </label>
          <input id="ev-home" className="input" value={home} onChange={(e) => setHome(e.target.value)} />
        </div>
        <div>
          <label className="label" htmlFor="ev-away">
            Visitante
          </label>
          <input id="ev-away" className="input" value={away} onChange={(e) => setAway(e.target.value)} />
        </div>
      </div>
      <div>
        <label className="label" htmlFor="ev-start">
          Inicio (hora de Caracas)
        </label>
        <input id="ev-start" type="datetime-local" className="input" value={startsAt} onChange={(e) => setStartsAt(e.target.value)} />
      </div>
      <div>
        <div className="label">Mercados</div>
        <div className="mb-2 flex flex-wrap gap-1.5">
          {templates.map((t) => {
            const on = !!drafts[t.code];
            return (
              <button
                key={t.code}
                type="button"
                className={`badge cursor-pointer py-1 ${on ? 'bg-selva-700 text-white' : 'bg-black/5'}`}
                onClick={() =>
                  setDrafts((d) => {
                    const next = { ...d };
                    if (on) delete next[t.code];
                    else next[t.code] = { type: t.code, line: '', odds: {} };
                    return next;
                  })
                }
              >
                {on ? '✓ ' : '+ '}
                {t.name}
              </button>
            );
          })}
        </div>
        <div className="space-y-2">
          {templates
            .filter((t) => drafts[t.code])
            .map((t) => (
              <MarketEditor key={t.code} template={t} draft={drafts[t.code]} home={home} away={away} onChange={(d) => setDrafts((x) => ({ ...x, [t.code]: d }))} />
            ))}
        </div>
      </div>
      <ErrorBox error={action.error} />
      <button className="btn-primary w-full" disabled={!home.trim() || !away.trim() || !startsAt || action.isPending} onClick={submit}>
        Publicar evento
      </button>
    </div>
  );
}

function AddMarket({ ev, catalog, onDone }: { ev: SportEvent; catalog: Catalog; onDone: () => void }) {
  const templates = catalog.markets.filter((t) => t.sport === ev.sport);
  const [type, setType] = useState(templates[0]?.code ?? '');
  const [draft, setDraft] = useState<MarketDraft>({ type, line: '', odds: {} });
  const template = templates.find((t) => t.code === type)!;
  const action = useAction(onDone);
  useEffect(() => setDraft({ type, line: '', odds: {} }), [type]);
  return (
    <div className="space-y-3 text-sm">
      <select aria-label="Tipo de mercado" className="input" value={type} onChange={(e) => setType(e.target.value)}>
        {templates.map((t) => (
          <option key={t.code} value={t.code}>
            {t.name}
          </option>
        ))}
      </select>
      {template && <MarketEditor template={template} draft={draft} onChange={setDraft} home={ev.home} away={ev.away} />}
      <ErrorBox error={action.error} />
      <button
        className="btn-primary w-full"
        disabled={action.isPending}
        onClick={() => action.mutate({ path: `/admin/sports/events/${ev.id}/markets`, body: { type, ...(draft.line ? { line: draft.line } : {}), odds: draft.odds } })}
      >
        Publicar mercado
      </button>
    </div>
  );
}
