import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { BetSlipView } from '../components/BetSlipView';
import { Empty, ErrorBox, Modal, Notice, Spinner } from '../components/ui';
import { ApiError, get, post } from '../lib/api';
import { useAuth } from '../lib/auth';
import { Currency, dateTime, hour, money, toMinor, todayCaracas } from '../lib/format';
import { LiveDot } from '../lib/realtime';
import {
  Catalog,
  combined,
  EVENT_STATUS_LABEL,
  Market,
  marketName,
  payout,
  Selection,
  showOdds,
  SPORT_ICON,
  SportEvent,
  toOdds,
  useCatalog,
  useSportEvents,
} from '../lib/sports';

interface Leg {
  selectionId: string;
  eventId: string;
  event: string;
  market: string;
  name: string;
  odds: string; // la cuota que el jugador está viendo
  changedFrom?: string;
  suspended?: boolean;
  live?: boolean;
}

type Policy = 'ACCEPT_HIGHER' | 'ACCEPT_ANY' | 'NONE';

export function SportsPage() {
  const catalog = useCatalog();
  const [sport, setSport] = useState<string | undefined>();
  const [view, setView] = useState<'offer' | 'results'>('offer');
  const events = useSportEvents(sport);
  const [legs, setLegs] = useState<Leg[]>([]);
  const [slipOpen, setSlipOpen] = useState(false);

  // Mantener el cupón al día con las cuotas y estados que llegan en tiempo real.
  useEffect(() => {
    if (!events.data) return;
    const index = new Map<string, { sel: Selection; market: Market; ev: SportEvent }>();
    for (const ev of events.data) for (const m of ev.markets) for (const s of m.selections) index.set(s.id, { sel: s, market: m, ev });
    setLegs((cur) =>
      cur.map((l) => {
        const hit = index.get(l.selectionId);
        if (!hit) return { ...l, suspended: true };
        const suspended = hit.market.status !== 'OPEN';
        const changed = hit.sel.odds !== l.odds;
        return changed || suspended !== !!l.suspended || (hit.ev.status === 'LIVE') !== !!l.live
          ? { ...l, odds: hit.sel.odds, changedFrom: changed ? l.odds : l.changedFrom, suspended, live: hit.ev.status === 'LIVE' }
          : l;
      }),
    );
  }, [events.data]);

  function toggle(ev: SportEvent, m: Market, s: Selection) {
    setLegs((cur) => {
      if (cur.some((l) => l.selectionId === s.id)) return cur.filter((l) => l.selectionId !== s.id);
      // Una selección por partido: elegir otra del mismo evento la reemplaza (sin bet builder).
      const leg: Leg = {
        selectionId: s.id,
        eventId: ev.id,
        event: `${ev.home} vs ${ev.away}`,
        market: marketName(catalog.data, m),
        name: s.name,
        odds: s.odds,
        live: ev.status === 'LIVE',
      };
      return [...cur.filter((l) => l.eventId !== ev.id), leg];
    });
  }

  const live = events.data?.filter((e) => e.status === 'LIVE') ?? [];
  const upcoming = events.data?.filter((e) => e.status !== 'LIVE') ?? [];

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
      <div className="min-w-0 space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          {[{ code: undefined, name: 'Todos' }, ...(catalog.data?.sports ?? [])].map((s) => (
            <button
              key={s.code ?? 'ALL'}
              onClick={() => setSport(s.code)}
              className={`btn shrink-0 ${sport === s.code ? 'bg-selva-800 text-white' : 'bg-white text-selva-900 ring-1 ring-black/10'}`}
            >
              {s.code && SPORT_ICON[s.code]} {s.name}
            </button>
          ))}
          <div className="ml-auto flex items-center gap-3">
            <LiveDot />
            <div className="flex rounded-xl bg-black/5 p-1 text-sm">
              {(['offer', 'results'] as const).map((v) => (
                <button key={v} onClick={() => setView(v)} className={`rounded-lg px-3 py-1 ${view === v ? 'bg-white font-semibold shadow-sm' : 'text-black/60'}`}>
                  {v === 'offer' ? 'Apostar' : 'Resultados'}
                </button>
              ))}
            </div>
          </div>
        </div>

        {view === 'results' ? (
          <SportsResults sport={sport} catalog={catalog.data} />
        ) : events.isLoading || catalog.isLoading ? (
          <Spinner />
        ) : !events.data?.length ? (
          <Empty>No hay partidos en oferta ahora mismo.</Empty>
        ) : (
          <>
            {live.length > 0 && (
              <section className="space-y-2">
                <h2 className="flex items-center gap-2 text-sm font-semibold text-red-700">
                  <span className="h-2 w-2 animate-pulse rounded-full bg-red-600" /> En vivo
                </h2>
                {live.map((ev) => (
                  <EventCard key={ev.id} ev={ev} catalog={catalog.data!} picked={legs} onPick={toggle} />
                ))}
              </section>
            )}
            <section className="space-y-2">
              {live.length > 0 && <h2 className="text-sm font-semibold text-black/60">Próximos</h2>}
              {upcoming.map((ev) => (
                <EventCard key={ev.id} ev={ev} catalog={catalog.data!} picked={legs} onPick={toggle} />
              ))}
            </section>
          </>
        )}
      </div>

      <aside className="hidden lg:block">
        <div className="sticky top-20">
          <SlipPanel legs={legs} setLegs={setLegs} catalog={catalog.data} />
        </div>
      </aside>

      {legs.length > 0 && (
        <button
          className="btn-gold fixed inset-x-4 bottom-20 z-30 shadow-lg lg:hidden"
          onClick={() => setSlipOpen(true)}
        >
          Ver cupón · {legs.length} {legs.length === 1 ? 'selección' : 'selecciones'} · cuota {showOdds(combined(legs.map((l) => l.odds)))}
        </button>
      )}
      <Modal open={slipOpen} onClose={() => setSlipOpen(false)} title="Cupón">
        <SlipPanel legs={legs} setLegs={setLegs} catalog={catalog.data} bare onPlaced={() => setSlipOpen(false)} />
      </Modal>
    </div>
  );
}

function EventCard({ ev, catalog, picked, onPick }: { ev: SportEvent; catalog: Catalog; picked: Leg[]; onPick: (ev: SportEvent, m: Market, s: Selection) => void }) {
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? ev.markets : ev.markets.slice(0, 1);
  const isToday = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Caracas' }).format(new Date(ev.starts_at)) === todayCaracas();
  return (
    <article className={`card p-4 ${ev.status === 'LIVE' ? 'ring-1 ring-red-200' : ''}`}>
      <header className="mb-3 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-xs text-black/50">
            {SPORT_ICON[ev.sport]} {ev.competition}
          </div>
          <div className="truncate font-semibold">
            {ev.home} <span className="font-normal text-black/40">vs</span> {ev.away}
          </div>
        </div>
        <div className="shrink-0 text-right">
          {ev.status === 'LIVE' ? (
            <>
              <span className="badge bg-red-600 text-white">{EVENT_STATUS_LABEL.LIVE}</span>
              <div className="mt-1 text-lg font-bold tabular-nums">
                {ev.home_score} - {ev.away_score}
              </div>
            </>
          ) : (
            <div className="text-sm">
              <div className="font-semibold">{hour(ev.starts_at)}</div>
              <div className="text-xs text-black/50">{isToday ? 'Hoy' : dateTime(ev.starts_at).split(',')[0]}</div>
            </div>
          )}
        </div>
      </header>
      <div className="space-y-3">
        {shown.map((m) => (
          <div key={m.id}>
            <div className="mb-1 flex items-center gap-2 text-xs font-medium text-black/50">
              {marketName(catalog, m)}
              {m.status === 'SUSPENDED' && <span className="badge bg-amber-100 text-amber-800">🔒 Suspendido</span>}
            </div>
            <div className={`grid gap-2 ${m.selections.length === 3 ? 'grid-cols-3' : 'grid-cols-2'}`}>
              {m.selections.map((s) => (
                <OddsButton
                  key={s.id}
                  selection={s}
                  disabled={m.status !== 'OPEN'}
                  active={picked.some((l) => l.selectionId === s.id)}
                  onClick={() => onPick(ev, m, s)}
                />
              ))}
            </div>
          </div>
        ))}
      </div>
      {ev.markets.length > 1 && (
        <button className="mt-3 text-sm font-semibold text-selva-700" onClick={() => setExpanded((x) => !x)}>
          {expanded ? 'Ver menos' : `+${ev.markets.length - 1} mercados`}
        </button>
      )}
    </article>
  );
}

/** Botón de cuota: marca ▲/▼ unos segundos cuando la cuota cambia en vivo. */
function OddsButton({ selection, active, disabled, onClick }: { selection: Selection; active: boolean; disabled: boolean; onClick: () => void }) {
  const prev = useRef(selection.odds);
  const [dir, setDir] = useState<'up' | 'down' | null>(null);
  useEffect(() => {
    if (prev.current === selection.odds) return;
    setDir(toOdds(selection.odds) > toOdds(prev.current) ? 'up' : 'down');
    prev.current = selection.odds;
    const t = setTimeout(() => setDir(null), 4000);
    return () => clearTimeout(t);
  }, [selection.odds]);
  return (
    <button
      disabled={disabled}
      onClick={onClick}
      aria-pressed={active}
      className={`flex min-h-12 flex-col items-center justify-center rounded-xl px-2 py-1.5 text-center ring-1 transition disabled:cursor-not-allowed disabled:opacity-40 ${
        active ? 'bg-selva-700 text-white ring-selva-700' : 'bg-white ring-black/10 hover:ring-selva-600'
      } ${dir === 'up' ? 'animate-pulse ring-2 ring-emerald-500' : dir === 'down' ? 'animate-pulse ring-2 ring-red-500' : ''}`}
    >
      <span className={`line-clamp-1 text-[11px] ${active ? 'text-white/80' : 'text-black/50'}`}>{selection.name}</span>
      <span className="font-bold tabular-nums">
        {disabled ? '🔒' : showOdds(selection.odds)}
        {dir && <span className={`ml-0.5 text-xs ${dir === 'up' ? 'text-emerald-600' : 'text-red-600'}`}>{dir === 'up' ? '▲' : '▼'}</span>}
      </span>
    </button>
  );
}

function SlipPanel({
  legs,
  setLegs,
  catalog,
  bare,
  onPlaced,
}: {
  legs: Leg[];
  setLegs: (fn: (l: Leg[]) => Leg[]) => void;
  catalog?: Catalog;
  bare?: boolean;
  onPlaced?: () => void;
}) {
  const { user } = useAuth();
  const [currency, setCurrency] = useState<Currency>('VES');
  const [stake, setStake] = useState('100');
  const [policy, setPolicy] = useState<Policy>('ACCEPT_HIGHER');
  const [receipt, setReceipt] = useState<any>(null);
  const [oddsNotice, setOddsNotice] = useState(false);
  // Misma clave mientras el cupón no cambie: reintentos por red lenta no duplican la apuesta.
  const signature = legs.map((l) => l.selectionId).join() + `|${stake}|${currency}`;
  const idemKey = useMemo(() => crypto.randomUUID(), [signature]);

  const limits = catalog?.limits.find((l) => l.currency === currency);
  const stakeMinor = toMinor(stake, currency);
  const odds = legs.map((l) => l.odds);
  const total = legs.length ? combined(odds) : 0n;
  const potential = stakeMinor && legs.length ? payout(stakeMinor, odds) : 0n;
  const anyLive = legs.some((l) => l.live);
  const blocked = legs.some((l) => l.suspended);

  const stakeError = !limits
    ? null
    : stakeMinor === null
      ? 'Monto inválido'
      : stakeMinor < BigInt(limits.min_stake)
        ? `Mínimo ${money(limits.min_stake, currency)}`
        : stakeMinor > BigInt(limits.max_stake)
          ? `Máximo ${money(limits.max_stake, currency)}`
          : potential > BigInt(limits.max_payout)
            ? `Pago máximo por cupón: ${money(limits.max_payout, currency)}`
            : null;

  const place = useMutation({
    mutationFn: () =>
      post(
        '/sports/bets',
        {
          type: legs.length > 1 ? 'PARLAY' : 'SINGLE',
          currency,
          stake: stake.trim().replace(',', '.'),
          oddsPolicy: policy,
          legs: legs.map((l) => ({ selectionId: l.selectionId, odds: showOdds(l.odds) })),
        },
        { 'idempotency-key': idemKey },
      ),
    onSuccess: (slip) => {
      setReceipt(slip);
      setLegs(() => []);
      setOddsNotice(false);
      onPlaced?.();
    },
    onError: (err) => {
      // Cuotas movidas: actualizar el cupón y pedir confirmación de nuevo.
      if (err instanceof ApiError && err.code === 'ODDS_CHANGED') {
        const changes = (err.details as { changes: { selectionId: string; odds: string }[] }).changes;
        setLegs((cur) =>
          cur.map((l) => {
            const c = changes.find((x) => x.selectionId === l.selectionId);
            return c ? { ...l, changedFrom: l.odds, odds: c.odds } : l;
          }),
        );
        setOddsNotice(true);
      }
    },
  });

  const body = (
    <div className="space-y-3">
      {!legs.length ? (
        <p className="py-6 text-center text-sm text-black/50">Toca una cuota para agregarla al cupón.</p>
      ) : (
        <>
          <div className="flex items-center justify-between text-xs font-semibold text-black/50">
            <span>{legs.length > 1 ? `Combinada (${legs.length})` : 'Simple'}</span>
            <button className="text-red-600" onClick={() => setLegs(() => [])}>
              Vaciar
            </button>
          </div>
          <ul className="space-y-2">
            {legs.map((l) => (
              <li key={l.selectionId} className={`rounded-xl p-2.5 text-sm ring-1 ${l.suspended ? 'bg-amber-50 ring-amber-200' : 'ring-black/10'}`}>
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="font-semibold">{l.name}</div>
                    <div className="truncate text-xs text-black/50">
                      {l.market} · {l.event} {l.live && <span className="font-semibold text-red-600">· EN VIVO</span>}
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="font-bold tabular-nums">{l.suspended ? '🔒' : showOdds(l.odds)}</div>
                    {l.changedFrom && l.changedFrom !== l.odds && <div className="text-xs text-black/40 line-through">{showOdds(l.changedFrom)}</div>}
                  </div>
                  <button aria-label="Quitar" className="text-black/30 hover:text-red-600" onClick={() => setLegs((cur) => cur.filter((x) => x.selectionId !== l.selectionId))}>
                    ✕
                  </button>
                </div>
              </li>
            ))}
          </ul>

          <div className="grid grid-cols-[1fr_auto] gap-2">
            <div>
              <label className="label" htmlFor="stake">
                Monto
              </label>
              <input id="stake" className="input tabular-nums" inputMode="decimal" value={stake} onChange={(e) => setStake(e.target.value)} />
            </div>
            <div>
              <label className="label" htmlFor="slip-currency">
                Moneda
              </label>
              <select id="slip-currency" className="input" value={currency} onChange={(e) => setCurrency(e.target.value as Currency)}>
                <option value="VES">Bs.</option>
                <option value="USDT">USDT</option>
              </select>
            </div>
          </div>
          <div>
            <label className="label" htmlFor="policy">
              Si la cuota cambia
            </label>
            <select id="policy" className="input" value={policy} onChange={(e) => setPolicy(e.target.value as Policy)}>
              <option value="ACCEPT_HIGHER">Aceptar solo si sube</option>
              <option value="ACCEPT_ANY">Aceptar cualquier cambio</option>
              <option value="NONE">Preguntarme siempre</option>
            </select>
          </div>

          <div className="rounded-xl bg-black/[0.03] p-3 text-sm">
            <div className="flex justify-between">
              <span className="text-black/60">Cuota total</span>
              <span className="font-semibold tabular-nums">{showOdds(total)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-black/60">Pago potencial</span>
              <span className="font-bold tabular-nums text-selva-700">{money(potential, currency)}</span>
            </div>
          </div>

          {oddsNotice && <Notice tone="warn">Las cuotas cambiaron. Revisa el cupón y confirma de nuevo.</Notice>}
          {blocked && <Notice tone="warn">Hay selecciones suspendidas. Quítalas o espera a que reabran.</Notice>}
          {anyLive && place.isPending && <Notice>Validando apuesta en vivo ({(catalog?.liveBetDelayMs ?? 0) / 1000} s)…</Notice>}
          {stakeError && <p className="text-xs text-red-600">{stakeError}</p>}
          {!(place.error instanceof ApiError && place.error.code === 'ODDS_CHANGED') && <ErrorBox error={place.error} />}

          {user?.kind === 'PLAYER' ? (
            <button className="btn-primary w-full" disabled={!!stakeError || blocked || place.isPending} onClick={() => place.mutate()}>
              {place.isPending ? 'Enviando…' : `Apostar ${stakeMinor ? money(stakeMinor, currency) : ''}`}
            </button>
          ) : (
            <Link to="/login" className="btn-gold w-full">
              Entra para apostar
            </Link>
          )}
        </>
      )}
      <Modal open={!!receipt} onClose={() => setReceipt(null)} title="¡Apuesta aceptada!">
        {receipt && <BetSlipView slip={receipt} catalog={catalog} />}
      </Modal>
    </div>
  );

  if (bare) return body;
  return (
    <div className="card p-4">
      <h2 className="mb-3 font-semibold">Cupón</h2>
      {body}
    </div>
  );
}

function SportsResults({ sport, catalog }: { sport?: string; catalog?: Catalog }) {
  const results = useQuery({ queryKey: ['sports', 'results', sport ?? 'ALL'], queryFn: () => get<SportEvent[]>(`/sports/results${sport ? `?sport=${sport}` : ''}`) });
  if (results.isLoading) return <Spinner />;
  if (!results.data?.length) return <Empty>Aún no hay resultados en los últimos 7 días.</Empty>;
  return (
    <div className="space-y-2">
      {results.data.map((ev) => (
        <div key={ev.id} className="card p-4">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-xs text-black/50">
                {SPORT_ICON[ev.sport]} {ev.competition} · {dateTime(ev.starts_at)}
              </div>
              <div className="truncate font-semibold">
                {ev.home} vs {ev.away}
              </div>
            </div>
            {ev.status === 'CANCELLED' ? (
              <span className="badge bg-black/5 text-black/60">Cancelado</span>
            ) : (
              <div className="text-xl font-bold tabular-nums">
                {ev.home_score} - {ev.away_score}
              </div>
            )}
          </div>
          <div className="mt-2 flex flex-wrap gap-1.5 text-xs">
            {ev.markets.map((m) => {
              const won = m.selections.filter((s) => s.result === 'WIN').map((s) => s.name);
              return (
                <span key={m.id} className="rounded-lg bg-black/[0.04] px-2 py-1">
                  {marketName(catalog, m)}:{' '}
                  <b>{m.status === 'VOIDED' ? 'Anulado' : won.length ? won.join(', ') : m.selections.some((s) => s.result === 'VOID') ? 'Devolución' : '—'}</b>
                </span>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
