import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Fragment, ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ErrorBox, Modal, Spinner } from '../../components/ui';
import { ApiError, get, post, put } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { Currency, CURRENCY, dateTime, hour, money, TICKET_STATUS_LABEL, todayCaracas, useNow } from '../../lib/format';
import { playedLabel, symbolWords, useGames, useGameSymbols, useSimulationStatus } from '../../lib/queries';
import { symbolName } from '../../components/SymbolArt';

type Words = ReturnType<typeof symbolWords>;

// ───────────── Tipos del API ─────────────

interface Sym {
  number: string;
  name: string;
  emoji: string;
}
interface DrawRow {
  id: string;
  draw_at: string;
  day: string;
  hour: number;
  result: Sym | null;
  sold: string;
  paid: string;
  ggr: string;
  margin: number | null;
  cum_ggr: string;
  plays: number;
  tickets: number;
  players: number;
  winners: number;
}
interface Candle {
  day: string;
  open: string;
  high: string;
  low: string;
  close: string;
  sold: string;
  paid: string;
  ggr: string;
  margin: number | null;
  draws: number;
}
interface HourRow {
  hour: number;
  draws: number;
  sold: string;
  paid: string;
  ggr: string;
  margin: number | null;
  house_wins: number;
}
interface Animal extends Sym {
  id: string;
  hits: number;
  share: number;
  z: number;
  since: number | null;
  last_at: string | null;
  max_gap: number;
  daily: number[];
  sold: string;
  paid: string;
  ggr: string;
}
interface Overview {
  game: { id: string; code: string; name: string; symbols: number; factor_x100: string };
  from: string;
  to: string;
  days: number;
  summary: {
    sold: string;
    paid: string;
    ggr: string;
    margin: number | null;
    expected_margin: number;
    draws: number;
    draws_with_sales: number;
    house_wins: number;
    tickets: number;
    players: number;
    best: DrawRow | null;
    worst: DrawRow | null;
  };
  fairness: { draws: number; expected_per_animal: number; chi2: number; df: number; p_value: number };
  draws: DrawRow[];
  candles: Candle[];
  hours: HourRow[];
  animals: Animal[];
}
interface TicketPlay {
  draw_at: string;
  number: string;
  name: string;
  emoji: string;
  modality: string;
  modality_name: string;
  selection?: number[] | null;
  amount: string;
  potential_win: string;
  win: string;
  status: string;
  result_number: string | null;
  result_emoji: string | null;
}
interface TicketRow {
  id: string;
  code: string;
  sold_at: string;
  currency: Currency;
  total: string;
  potential_win: string;
  total_win: string;
  status: string;
  channel: string;
  is_simulation: boolean;
  game_code: string;
  player_email: string;
  player_name: string;
  plays: TicketPlay[] | null;
}
interface TicketBook {
  page: number;
  size: number;
  total: number;
  totals: Record<string, { sold: string; won: string; count: number }>;
  rows: TicketRow[];
}

// ───────────── Formato ─────────────

const UP = '#22c55e';
const DOWN = '#f43f5e';
const ACCENT = '#38bdf8';
const GRID = 'rgba(148,163,184,0.12)';
const AXIS = 'rgba(148,163,184,0.75)';

const pct = (x: number | null | undefined, d = 1) =>
  x === null || x === undefined ? '—' : `${(x * 100).toLocaleString('es-VE', { maximumFractionDigits: d, minimumFractionDigits: d })} %`;
const toUnits = (minor: string | bigint, c: Currency) => Number(BigInt(minor)) / 10 ** CURRENCY[c].minor;
/** Monto corto para ejes: «12,5 mil», «1,2 M». */
function short(minor: string | bigint | number, c: Currency) {
  const v = typeof minor === 'number' ? minor : toUnits(minor, c);
  const a = Math.abs(v);
  const s = a >= 1e6 ? `${(v / 1e6).toLocaleString('es-VE', { maximumFractionDigits: 1 })} M` : a >= 1e3 ? `${(v / 1e3).toLocaleString('es-VE', { maximumFractionDigits: 1 })} mil` : v.toLocaleString('es-VE', { maximumFractionDigits: 0 });
  return c === 'VES' ? `Bs ${s}` : `${s} USDT`;
}
const signed = (v: string, c: Currency) => `${BigInt(v) > 0n ? '+' : ''}${money(v, c)}`;
const upDown = (v: string | number | null | undefined) => (v === null || v === undefined ? 'text-slate-300' : Number(v) < 0 ? 'text-rose-400' : Number(v) > 0 ? 'text-emerald-400' : 'text-slate-300');
const dayLabel = (d: string) => new Intl.DateTimeFormat('es-VE', { day: '2-digit', month: 'short', timeZone: 'UTC' }).format(new Date(`${d}T12:00:00Z`));
const hourLabel = (h: number) => `${((h + 11) % 12) + 1}${h < 12 ? 'am' : 'pm'}`;

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([e]) => setW(Math.floor(e.contentRect.width)));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

/** Ticks "bonitos" para un eje lineal. */
function ticks(min: number, max: number, count = 4) {
  if (min === max) return [min];
  const step0 = (max - min) / count;
  const mag = 10 ** Math.floor(Math.log10(step0));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= step0) ?? step0;
  const out: number[] = [];
  for (let v = Math.ceil(min / step) * step; v <= max + 1e-9; v += step) out.push(Math.round(v * 1e6) / 1e6);
  return out;
}

// ───────────── Página ─────────────

const PERIODS = [7, 14, 30, 90];

/**
 * Mercado de cada juego (Animalitos, Frutas): banda de referencia, resultados históricos, rentabilidad y tickets.
 */
export function MarketPage() {
  const games = useGames();
  const { user } = useAuth();
  const [currency, setCurrency] = useState<Currency>('VES');
  const [days, setDays] = useState(14);
  const [drawFilter, setDrawFilter] = useState<DrawRow | null>(null);
  const ticketsRef = useRef<HTMLDivElement>(null);
  const [gameId, setGameId] = useState<string>();
  const game = games.data?.find((g) => g.id === gameId) ?? games.data?.find((g) => g.code === 'MER-05') ?? games.data?.[0];
  const words = symbolWords(game);
  const symbols = useGameSymbols(game);

  const ov = useQuery({
    queryKey: ['admin', 'analytics', game?.id, currency, days],
    enabled: !!game,
    refetchInterval: 60_000,
    placeholderData: keepPreviousData,
    queryFn: () => get<Overview>(`/admin/lottery/games/${game!.id}/analytics?currency=${currency}&days=${days}`),
  });
  const o = ov.data;

  const pickDraw = (d: DrawRow) => {
    setDrawFilter(d);
    setTimeout(() => ticketsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);
  };

  return (
    <div className="-mx-4 -my-5 min-h-[calc(100vh-4rem)] bg-[#0a0e13] px-3 py-4 text-slate-200 sm:px-5 lg:-mx-8 lg:-my-6 lg:px-8 lg:py-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-extrabold tracking-tight text-white">
            Mercado <span className="text-sm font-medium text-slate-400">· {game?.name}</span>
          </h1>
          <p className="text-xs text-slate-400">Historial de resultados, ganancia por sorteo y todos los tickets jugados.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {(games.data?.length ?? 0) > 1 && game && (
            <Seg
              options={games.data!.map((g) => [g.id, g.name])}
              value={game.id}
              onChange={(id) => {
                setGameId(id);
                setDrawFilter(null);
              }}
            />
          )}
          <Seg options={(['VES', 'USDT'] as Currency[]).map((c) => [c, c === 'VES' ? 'Bs.' : 'USDT'])} value={currency} onChange={(c) => setCurrency(c as Currency)} />
          <Seg options={PERIODS.map((p) => [String(p), `${p}D`])} value={String(days)} onChange={(p) => setDays(Number(p))} />
        </div>
      </div>

      {user?.role === 'ADMIN' && game && game.board !== 'KINO' && (
        <div className="mt-3">
          <NextBandPanel key={game.id} gameId={game.id} demo={game.is_demo} catalog={symbols} words={words} />
        </div>
      )}
      {games.error || ov.error ? (
        <div className="mt-4">
          <ErrorBox error={games.error ?? ov.error} />
        </div>
      ) : games.data && !game ? (
        <p className="mt-4 text-sm text-slate-400">No hay juegos disponibles.</p>
      ) : !o ? (
        <div className="mt-10">
          <Spinner />
        </div>
      ) : (
        <div className={`mt-3 space-y-3 ${ov.isFetching ? 'opacity-90' : ''}`}>
          <Ticker draws={o.draws} onPick={pickDraw} />
          <Kpis o={o} currency={currency} />
          <div className="grid gap-3 xl:grid-cols-3">
            <Panel title="Ganancia acumulada" sub={`${dayLabel(o.from)} – ${dayLabel(o.to)} · velas diarias · volumen = vendido`} className="xl:col-span-2">
              <CandleChart candles={o.candles} currency={currency} />
            </Panel>
            <Panel title="Por hora del sorteo" sub="margen real acumulado de cada hora">
              <HourBars hours={o.hours} currency={currency} expected={o.summary.expected_margin} />
            </Panel>
          </div>
          <Panel title="Margen de ganancia por sorteo" sub={`(vendido − pagado) ÷ vendido · línea punteada = margen esperado ${pct(o.summary.expected_margin)}`}>
            <MarginBars draws={o.draws} currency={currency} expected={o.summary.expected_margin} onPick={pickDraw} />
          </Panel>
          <div className="grid gap-3 xl:grid-cols-5">
            <Panel title={`Tendencia por ${words.one}`} sub={`veces que salió en ${o.fairness.draws} sorteos liquidados`} className="xl:col-span-3">
              <AnimalTable o={o} currency={currency} words={words} />
            </Panel>
            <div className="space-y-3 xl:col-span-2">
              <Fairness o={o} />
              <Panel title="Sorteos" sub="toca uno para ver sus tickets">
                <DrawBook draws={o.draws} currency={currency} onPick={pickDraw} selected={drawFilter?.id} />
              </Panel>
            </div>
          </div>
          <div ref={ticketsRef} className="scroll-mt-3">
            <TicketsBlotter
              gameId={o.game.id}
              currency={currency}
              from={o.from}
              to={o.to}
              draw={drawFilter}
              clearDraw={() => setDrawFilter(null)}
            />
          </div>
        </div>
      )}
    </div>
  );
}

// ───────────── Banda del próximo sorteo ─────────────

type BandCandidate = Sym & { id: string };

interface NextBand {
  next: { id: string; draw_at: string } | null;
  candidates: BandCandidate[];
  customized: boolean;
  size: number;
  symbols: number;
  chance: number;
  window: number;
  used: number;
  simulated: boolean;
  history_size: number;
  backtest: { tested: number; hits: number; hit_rate: number | null };
}

type BandEdit = {
  draw: NonNullable<NextBand['next']>;
  candidateIds: string[];
  customized: boolean;
};

function NextBandPanel({ gameId, demo, catalog, words }: { gameId: string; demo: boolean; catalog: BandCandidate[]; words: Words }) {
  const now = useNow();
  const [edit, setEdit] = useState<BandEdit | null>(null);
  const [params, setParams] = useSearchParams();
  const simulation = useSimulationStatus();
  const canSimulate = demo && simulation.data?.enabled === true;
  const simulated = canSimulate && params.get('historial') === 'simulado';
  const q = useQuery({
    queryKey: ['admin', 'next-band', gameId, simulated],
    refetchInterval: 15_000,
    queryFn: () => get<NextBand>(`/admin/lottery/games/${gameId}/next-band${simulated ? '?simulated=true' : ''}`),
  });
  const quickTest = useMutation({
    mutationFn: (body: { drawId: string; simulated: boolean; candidateIds: string[] }) =>
      post<{ band: NextBand; winner: BandCandidate }>(`/admin/lottery/games/${gameId}/next-band/quick-test`, body),
    onError: (error) => {
      if (error instanceof ApiError && error.code === 'CONFLICT') void q.refetch();
    },
  });
  const winner = quickTest.data?.winner;
  const band = quickTest.data?.band ?? q.data;
  const next = band?.next && (winner || new Date(band.next.draw_at).getTime() > now) ? band.next : null;
  return (
    <Panel
      title={winner ? 'Resultado del sorteo rápido de prueba' : 'Banda del próximo sorteo'}
      sub={next ? `Banda de las ${dateTime(next.draw_at)} · hora de Caracas` : undefined}
      actions={
        <div className="flex flex-wrap items-center justify-end gap-2">
          <span className="rounded-md bg-sky-400/10 px-2 py-1 text-[11px] font-medium text-sky-300">Solo administradores</span>
          {band && next && !winner && band.candidates.length === 10 && !q.error && (
            <button
              type="button"
              className="rounded-md border border-sky-400/30 px-2 py-1 text-[11px] font-medium text-sky-300 hover:bg-sky-400/10 disabled:opacity-50"
              disabled={quickTest.isPending}
              onClick={() => {
                quickTest.reset();
                setEdit({ draw: next, candidateIds: band.candidates.map((s) => s.id), customized: band.customized });
              }}
            >
              Editar banda
            </button>
          )}
          {canSimulate && (
            <button
              type="button"
              className="rounded-md border border-amber-400/30 px-2 py-1 text-[11px] font-medium text-amber-200 hover:bg-amber-400/10 disabled:opacity-50"
              disabled={quickTest.isPending}
              onClick={() => {
                quickTest.reset();
                setParams((current) => {
                  const updated = new URLSearchParams(current);
                  if (simulated) updated.delete('historial');
                  else updated.set('historial', 'simulado');
                  return updated;
                });
              }}
            >
              {simulated ? 'Volver al historial real' : 'Simular 100 sorteos'}
            </button>
          )}
        </div>
      }
    >
      {q.error && !winner ? (
        <ErrorBox error={q.error} />
      ) : !band ? (
        <Spinner />
      ) : (
        <>
          {band.simulated && (
            <p className="mb-3 rounded-md bg-amber-400/10 px-2 py-1.5 text-xs font-medium text-amber-200">
              Datos de prueba · {band.history_size} sorteos simulados
            </p>
          )}
          {next ? (
            <ol className="grid grid-cols-2 gap-2 sm:grid-cols-5 xl:grid-cols-10" aria-label={`${words.many} de la banda`}>
              {band.candidates.map((s) => (
                <li
                  key={s.id}
                  className={`rounded-lg border px-1.5 py-2 text-center ${s.id === winner?.id ? 'border-emerald-400 bg-emerald-400/15' : 'border-white/10 bg-white/[0.04]'}`}
                >
                  <span className="text-2xl leading-none" aria-hidden="true">{s.emoji}</span>
                  <span className="mt-1 block text-sm font-bold tabular-nums text-white">{s.number}</span>
                  <span className="block text-xs leading-tight text-slate-300">{symbolName(s.number, s.name)}</span>
                </li>
              ))}
            </ol>
          ) : (
            <p className="text-sm text-slate-400">No hay un próximo sorteo disponible.</p>
          )}
          {winner ? (
            <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-lg bg-emerald-400/10 p-2.5">
              <p role="status" className="text-sm font-semibold text-emerald-300">
                Ganador de prueba · {winner.emoji} {winner.number} {symbolName(winner.number, winner.name)}
              </p>
              <button type="button" className="text-xs font-medium text-slate-300 hover:text-white" onClick={() => quickTest.reset()}>
                Volver a la banda actual
              </button>
            </div>
          ) : canSimulate && next ? (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <button
                type="button"
                className="rounded-md bg-sky-400 px-3 py-1.5 text-xs font-semibold text-slate-950 hover:bg-sky-300 disabled:opacity-50"
                disabled={quickTest.isPending}
                onClick={() => quickTest.mutate({ drawId: next.id, simulated: band.simulated, candidateIds: band.candidates.map((s) => s.id) })}
              >
                {quickTest.isPending ? 'Sorteando…' : 'Ejecutar sorteo rápido de prueba'}
              </button>
              <span className="text-xs text-slate-400">Prueba privada entre {words.many} de esta banda.</span>
            </div>
          ) : null}
          <ErrorBox error={quickTest.error} />
          <dl className="mt-3 grid gap-2 text-xs text-slate-400 sm:grid-cols-2">
            <div>
              <dt>Cobertura teórica con resultados equiprobables</dt>
              <dd className="font-semibold text-white">{pct(band.chance, 2)} · {band.size} de {band.symbols} {words.many}</dd>
            </div>
            <div>
              <dt>
                {band.customized
                  ? 'Acierto histórico de la selección automática'
                  : band.simulated ? 'Acierto en sorteos simulados' : 'Acierto en la prueba retrospectiva'}
              </dt>
              <dd className="font-semibold text-white">
                {band.backtest.tested
                  ? `${pct(band.backtest.hit_rate, 2)} · ${band.backtest.hits} de ${band.backtest.tested} sorteos`
                  : 'Historial insuficiente'}
              </dd>
            </div>
          </dl>
          {next && (
            <p className="mt-3 text-xs leading-relaxed text-slate-400">
              {band.customized ? 'Banda editada por un administrador para este sorteo.' : band.used
                ? `Selección por frecuencia reciente · ${band.used} de ${band.window} sorteos ${band.simulated ? 'simulados' : 'liquidados'} disponibles antes del cierre.`
                : 'Selección de referencia basada en el identificador del sorteo. Aún no hay resultados comparables.'}{' '}
              {winner ? 'Resultado de una prueba privada.' : 'El ganador oficial se conoce al publicarse el resultado.'}
            </p>
          )}
        </>
      )}
      {edit && <BandEditor gameId={gameId} catalog={catalog} edit={edit} words={words} onClose={() => setEdit(null)} />}
    </Panel>
  );
}

function BandEditor({ gameId, catalog, edit, words, onClose }: { gameId: string; catalog: BandCandidate[]; edit: BandEdit; words: Words; onClose: () => void }) {
  const [candidateIds, setCandidateIds] = useState(edit.candidateIds);
  const qc = useQueryClient();
  const refresh = () => qc.invalidateQueries({ queryKey: ['admin', 'next-band', gameId] });
  const save = useMutation({
    mutationFn: (ids: string[] | null) => put(`/admin/lottery/games/${gameId}/next-band`, { drawId: edit.draw.id, candidateIds: ids }),
    onSuccess: async () => {
      await refresh();
      onClose();
    },
    onError: (error) => {
      if (error instanceof ApiError && error.code === 'CONFLICT') void refresh();
    },
  });
  const selected = new Set(candidateIds);
  return (
    <div className="text-slate-900">
      <Modal open onClose={() => { if (!save.isPending) onClose(); }} title="Editar banda">
        <p className="mb-4 text-sm text-slate-600">Elige 10 {words.many} distint{words.one === 'fruta' ? 'as' : 'os'} para el sorteo del {dateTime(edit.draw.draw_at)}.</p>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate(candidateIds);
          }}
        >
          <div className="grid grid-cols-2 gap-2 sm:gap-3">
            {candidateIds.map((id, i) => (
              <label key={i} className="min-w-0 text-xs font-medium text-slate-600">
                <span className="first-letter:uppercase">{words.one}</span> {i + 1}
                <select
                  className="input mt-1 w-full text-sm"
                  value={id}
                  disabled={save.isPending}
                  onChange={(e) => setCandidateIds(candidateIds.map((current, j) => j === i ? e.target.value : current))}
                >
                  {catalog.filter((s) => s.id === id || !selected.has(s.id)).map((s) => (
                    <option key={s.id} value={s.id}>{s.emoji} {s.number} {symbolName(s.number, s.name)}</option>
                  ))}
                </select>
              </label>
            ))}
          </div>
          <ErrorBox error={save.error} />
          <div className="flex flex-wrap items-center justify-end gap-2">
            {edit.customized && (
              <button type="button" className="btn-ghost text-sm" disabled={save.isPending} onClick={() => save.mutate(null)}>
                Restaurar selección automática
              </button>
            )}
            <button type="submit" className="btn-primary" disabled={save.isPending}>
              {save.isPending ? 'Guardando…' : 'Guardar banda'}
            </button>
          </div>
        </form>
      </Modal>
    </div>
  );
}

// ───────────── Piezas ─────────────

function Seg({ options, value, onChange }: { options: string[][]; value: string; onChange: (v: string) => void }) {
  return (
    <div className="flex rounded-lg bg-white/5 p-0.5 ring-1 ring-white/10">
      {options.map(([v, label]) => (
        <button
          key={v}
          onClick={() => onChange(v)}
          className={`rounded-md px-2.5 py-1 text-xs font-semibold tabular-nums ${value === v ? 'bg-sky-500/20 text-sky-300' : 'text-slate-400 hover:text-white'}`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

function Panel({ title, sub, children, className = '', actions }: { title: string; sub?: string; children: ReactNode; className?: string; actions?: ReactNode }) {
  return (
    <section className={`min-w-0 rounded-xl border border-white/[0.07] bg-[#0f151c] p-3 ${className}`}>
      <div className="mb-2 flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 className="text-sm font-bold text-white">{title}</h2>
          {sub && <p className="text-[11px] text-slate-500">{sub}</p>}
        </div>
        {actions}
      </div>
      {children}
    </section>
  );
}

function Ticker({ draws, onPick }: { draws: DrawRow[]; onPick: (d: DrawRow) => void }) {
  const last = [...draws].reverse().slice(0, 30);
  if (!last.length) return null;
  return (
    <div className="no-scrollbar -mx-3 flex gap-1.5 overflow-x-auto px-3 sm:mx-0 sm:px-0">
      {last.map((d) => (
        <button
          key={d.id}
          onClick={() => onPick(d)}
          className="flex shrink-0 items-center gap-2 rounded-lg border border-white/[0.07] bg-[#0f151c] px-2.5 py-1.5 text-left hover:border-sky-400/40"
        >
          <span className="text-xl leading-none">{d.result?.emoji}</span>
          <span className="leading-tight">
            <span className="block text-[11px] text-slate-400">
              {dayLabel(d.day)} · {hour(d.draw_at)}
            </span>
            <span className="block text-xs font-semibold tabular-nums text-white">
              {d.result?.number} {symbolName(d.result?.number ?? '', d.result?.name)}
            </span>
          </span>
          <span className={`text-xs font-bold tabular-nums ${upDown(d.margin)}`}>{d.margin === null ? 'sin ventas' : `${d.margin > 0 ? '▲' : '▼'} ${pct(d.margin, 0)}`}</span>
        </button>
      ))}
    </div>
  );
}

function Kpi({ label, value, sub, tone = 'text-white' }: { label: string; value: ReactNode; sub?: ReactNode; tone?: string }) {
  return (
    <div className="min-w-0 rounded-xl border border-white/[0.07] bg-[#0f151c] p-3">
      <p className="truncate text-[11px] uppercase tracking-wide text-slate-500">{label}</p>
      <p className={`mt-0.5 truncate text-lg font-extrabold tabular-nums ${tone}`}>{value}</p>
      {sub && <p className="mt-0.5 text-[11px] text-slate-400">{sub}</p>}
    </div>
  );
}

function Kpis({ o, currency }: { o: Overview; currency: Currency }) {
  const s = o.summary;
  const diff = s.margin === null ? null : s.margin - s.expected_margin;
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-6">
      <Kpi label="Ganancia (GGR)" value={signed(s.ggr, currency)} tone={upDown(s.ggr)} sub={`${o.days} días · ${s.draws_with_sales} sorteos con ventas`} />
      <Kpi
        label="Margen real"
        value={pct(s.margin)}
        tone={upDown(s.margin)}
        sub={
          diff === null ? (
            'sin ventas'
          ) : (
            <>
              esperado {pct(s.expected_margin)} · <span className={upDown(diff)}>{diff >= 0 ? '+' : ''}{pct(diff)}</span>
            </>
          )
        }
      />
      <Kpi label="Vendido" value={money(s.sold, currency)} sub={`pagado ${money(s.paid, currency)}`} />
      <Kpi
        label="Sorteos ganados por la casa"
        value={s.draws_with_sales ? pct(s.house_wins / s.draws_with_sales, 0) : '—'}
        sub={`${s.house_wins} de ${s.draws_with_sales}`}
      />
      <Kpi label="Tickets" value={s.tickets.toLocaleString('es-VE')} sub={`${s.players} jugadores · prom. ${s.tickets ? money(BigInt(s.sold) / BigInt(s.tickets), currency) : '—'}`} />
      <Kpi
        label="Mejor / peor sorteo"
        value={
          <span className="block text-sm leading-tight">
            <span className="block truncate text-emerald-400">{s.best ? signed(s.best.ggr, currency) : '—'}</span>
            <span className="block truncate text-rose-400">{s.worst ? signed(s.worst.ggr, currency) : '—'}</span>
          </span>
        }
        sub={s.worst ? `peor: ${dayLabel(s.worst.day)} ${hour(s.worst.draw_at)} ${s.worst.result?.emoji ?? ''}` : undefined}
      />
    </div>
  );
}

/** Tooltip flotante dentro de un contenedor relativo. */
function Tip({ x, y, w, children }: { x: number; y: number; w: number; children: ReactNode }) {
  const left = Math.min(Math.max(x + 12, 4), Math.max(w - 214, 4));
  return (
    <div className="pointer-events-none absolute z-10 w-52 rounded-lg border border-white/10 bg-[#111a23]/95 p-2 text-[11px] shadow-xl" style={{ left, top: Math.max(y - 10, 0) }}>
      {children}
    </div>
  );
}
const TipRow = ({ k, v, tone }: { k: string; v: ReactNode; tone?: string }) => (
  <div className="flex justify-between gap-2 tabular-nums">
    <span className="text-slate-400">{k}</span>
    <span className={tone ?? 'text-white'}>{v}</span>
  </div>
);

function CandleChart({ candles, currency }: { candles: Candle[]; currency: Currency }) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const H = 260;
  const VOL = 56;
  const padL = 64;
  const padR = 8;
  const top = 8;
  const priceH = H - VOL - 30;
  const n = candles.length;
  const vals = candles.flatMap((c) => [toUnits(c.high, currency), toUnits(c.low, currency)]);
  let lo = Math.min(0, ...vals);
  let hi = Math.max(0, ...vals);
  if (hi === lo) hi = lo + 1;
  const padV = (hi - lo) * 0.06;
  lo -= padV;
  hi += padV;
  const plotW = Math.max(w - padL - padR, 10);
  const slot = plotW / Math.max(n, 1);
  const bw = Math.max(Math.min(slot * 0.62, 18), 2);
  const y = (v: number) => top + ((hi - v) / (hi - lo)) * priceH;
  const xC = (i: number) => padL + slot * i + slot / 2;
  const maxVol = Math.max(...candles.map((c) => toUnits(c.sold, currency)), 1);
  const volTop = top + priceH + 10;
  const tk = ticks(lo, hi, 4);
  const h = hover !== null ? candles[hover] : null;

  return (
    <div ref={ref} className="relative" onMouseLeave={() => setHover(null)}>
      {w > 0 && (
        <svg width={w} height={H} role="img" aria-label="Velas diarias de la ganancia acumulada">
          {tk.map((t) => (
            <g key={t}>
              <line x1={padL} x2={w - padR} y1={y(t)} y2={y(t)} stroke={t === 0 ? 'rgba(148,163,184,0.35)' : GRID} strokeDasharray={t === 0 ? '4 3' : undefined} />
              <text x={padL - 6} y={y(t) + 3} textAnchor="end" fontSize="10" fill={AXIS}>
                {short(t, currency)}
              </text>
            </g>
          ))}
          {candles.map((c, i) => {
            const o = toUnits(c.open, currency);
            const cl = toUnits(c.close, currency);
            const col = cl > o ? UP : cl < o ? DOWN : AXIS;
            const yT = y(Math.max(o, cl));
            const yB = y(Math.min(o, cl));
            const vol = toUnits(c.sold, currency);
            const vh = (vol / maxVol) * (VOL - 4);
            return (
              <g key={c.day}>
                <line x1={xC(i)} x2={xC(i)} y1={y(toUnits(c.high, currency))} y2={y(toUnits(c.low, currency))} stroke={col} strokeWidth={1.5} />
                <rect x={xC(i) - bw / 2} y={yT} width={bw} height={Math.max(yB - yT, 1.5)} fill={col} rx={1.5} />
                <rect x={xC(i) - bw / 2} y={volTop + VOL - vh} width={bw} height={vh} fill={col} opacity={0.35} rx={1.5} />
                {i % Math.max(1, Math.ceil(n / Math.max(Math.floor(plotW / 46), 2))) === 0 && (
                  <text x={xC(i)} y={H - 4} textAnchor="middle" fontSize="10" fill={AXIS}>
                    {dayLabel(c.day)}
                  </text>
                )}
              </g>
            );
          })}
          <text x={padL - 6} y={volTop + 10} textAnchor="end" fontSize="10" fill={AXIS}>
            vol.
          </text>
          {hover !== null && <line x1={xC(hover)} x2={xC(hover)} y1={top} y2={volTop + VOL} stroke="rgba(148,163,184,0.4)" strokeDasharray="3 3" />}
          <rect
            x={padL}
            y={0}
            width={plotW}
            height={H}
            fill="transparent"
            onMouseMove={(e) => {
              const r = (e.currentTarget as SVGRectElement).getBoundingClientRect();
              setHover(Math.min(Math.max(Math.floor((e.clientX - r.left) / slot), 0), n - 1));
            }}
          />
        </svg>
      )}
      {h && hover !== null && (
        <Tip x={xC(hover)} y={30} w={w}>
          <p className="mb-1 font-semibold text-white">{dayLabel(h.day)} · {h.draws} sorteos</p>
          <TipRow k="Ganancia del día" v={signed(h.ggr, currency)} tone={upDown(h.ggr)} />
          <TipRow k="Margen" v={pct(h.margin)} tone={upDown(h.margin)} />
          <TipRow k="Vendido" v={money(h.sold, currency)} />
          <TipRow k="Pagado" v={money(h.paid, currency)} />
          <div className="my-1 border-t border-white/10" />
          <TipRow k="Acumulado abre" v={short(h.open, currency)} />
          <TipRow k="Máx. / mín." v={`${short(h.high, currency)} / ${short(h.low, currency)}`} />
          <TipRow k="Acumulado cierra" v={short(h.close, currency)} tone={upDown(h.close)} />
        </Tip>
      )}
    </div>
  );
}

function MarginBars({ draws, currency, expected, onPick }: { draws: DrawRow[]; currency: Currency; expected: number; onPick: (d: DrawRow) => void }) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const ds = draws.filter((d) => d.margin !== null);
  const H = 200;
  const padL = 44;
  const top = 8;
  const plotH = H - 26;
  const MIN = -3; // −300 %: los sorteos con pérdida mayor se recortan y se marcan.
  const lo = Math.max(Math.min(...ds.map((d) => d.margin!), -0.5), MIN);
  const hi = 1;
  const y = (v: number) => top + ((hi - Math.max(v, lo)) / (hi - lo)) * plotH;
  const plotW = Math.max(w - padL - 6, 10);
  const slot = plotW / Math.max(ds.length, 1);
  const bw = Math.max(slot - (slot > 4 ? 2 : 0.5), 0.8);
  const tk = ticks(lo, hi, 4);
  const h = hover !== null ? ds[hover] : null;
  if (!ds.length) return <p className="py-8 text-center text-sm text-slate-500">Sin sorteos con ventas en el período.</p>;
  let lastDay = '';

  return (
    <div ref={ref} className="relative" onMouseLeave={() => setHover(null)}>
      {w > 0 && (
        <svg width={w} height={H} role="img" aria-label="Margen de ganancia por sorteo">
          {tk.map((t) => (
            <g key={t}>
              <line x1={padL} x2={w - 6} y1={y(t)} y2={y(t)} stroke={t === 0 ? 'rgba(148,163,184,0.4)' : GRID} />
              <text x={padL - 6} y={y(t) + 3} textAnchor="end" fontSize="10" fill={AXIS}>
                {Math.round(t * 100)}%
              </text>
            </g>
          ))}
          {ds.map((d, i) => {
            const m = d.margin!;
            const x = padL + slot * i + (slot - bw) / 2;
            const y0 = y(0);
            const y1 = y(m);
            const showDay = d.day !== lastDay;
            lastDay = d.day;
            return (
              <g key={d.id} opacity={hover === null || hover === i ? 1 : 0.55}>
                {showDay && i > 0 && <line x1={x - 1} x2={x - 1} y1={top} y2={top + plotH} stroke={GRID} />}
                <rect x={x} y={Math.min(y0, y1)} width={bw} height={Math.max(Math.abs(y1 - y0), 1)} fill={m >= 0 ? UP : DOWN} rx={bw > 4 ? 1.5 : 0} />
                {m < lo && <path d={`M${x + bw / 2 - 3} ${y1 + 1} l3 4 l3 -4z`} fill="#fff" />}
                {showDay && (ds.length < 60 || i % Math.ceil(ds.length / 8) < 1) && (
                  <text x={x} y={H - 4} fontSize="10" fill={AXIS}>
                    {dayLabel(d.day)}
                  </text>
                )}
              </g>
            );
          })}
          <line x1={padL} x2={w - 6} y1={y(expected)} y2={y(expected)} stroke={ACCENT} strokeDasharray="5 4" strokeWidth={1.5} />
          <rect
            x={padL}
            y={0}
            width={plotW}
            height={H}
            fill="transparent"
            className="cursor-pointer"
            onMouseMove={(e) => {
              const r = (e.currentTarget as SVGRectElement).getBoundingClientRect();
              setHover(Math.min(Math.max(Math.floor((e.clientX - r.left) / slot), 0), ds.length - 1));
            }}
            onClick={() => hover !== null && onPick(ds[hover])}
          />
        </svg>
      )}
      {h && hover !== null && (
        <Tip x={padL + slot * hover} y={20} w={w}>
          <p className="mb-1 font-semibold text-white">
            {dayLabel(h.day)} · {hour(h.draw_at)} · {h.result?.emoji} {h.result?.number} {symbolName(h.result?.number ?? '', h.result?.name)}
          </p>
          <TipRow k="Margen" v={pct(h.margin)} tone={upDown(h.margin)} />
          <TipRow k="Ganancia" v={signed(h.ggr, currency)} tone={upDown(h.ggr)} />
          <TipRow k="Vendido" v={money(h.sold, currency)} />
          <TipRow k="Pagado" v={money(h.paid, currency)} />
          <TipRow k="Tickets · ganadores" v={`${h.tickets} · ${h.winners}`} />
          <p className="mt-1 text-[10px] text-slate-500">Clic para ver sus tickets</p>
        </Tip>
      )}
    </div>
  );
}

function HourBars({ hours, currency, expected }: { hours: HourRow[]; currency: Currency; expected: number }) {
  if (!hours.length) return <p className="py-8 text-center text-sm text-slate-500">Sin datos.</p>;
  const maxAbs = Math.max(...hours.map((h) => Math.abs(h.margin ?? 0)), expected, 0.5);
  return (
    <div className="space-y-1">
      {hours.map((h) => {
        const m = h.margin ?? 0;
        const wPct = (Math.min(Math.abs(m), maxAbs) / maxAbs) * 50;
        return (
          <div key={h.hour} className="grid grid-cols-[3rem_1fr_4.5rem] items-center gap-2 text-xs tabular-nums" title={`${h.draws} sorteos · vendido ${money(h.sold, currency)} · ganancia ${signed(h.ggr, currency)}`}>
            <span className="text-slate-400">{hourLabel(h.hour)}</span>
            <div className="relative h-4 rounded bg-white/[0.03]">
              <div className="absolute inset-y-0 left-1/2 w-px bg-white/20" />
              <div className="absolute inset-y-0 w-px bg-sky-400/70" style={{ left: `${50 + (expected / maxAbs) * 50}%` }} />
              <div
                className="absolute inset-y-0.5 rounded"
                style={{ left: m >= 0 ? '50%' : `${50 - wPct}%`, width: `${wPct}%`, background: m >= 0 ? UP : DOWN }}
              />
            </div>
            <span className={`text-right font-semibold ${upDown(h.margin)}`}>{pct(h.margin, 0)}</span>
          </div>
        );
      })}
      <p className="pt-1 text-[10px] text-slate-500">
        Línea azul = margen esperado. Las diferencias entre horas son variación del azar, no un patrón: el resultado es 1 en N en todas.
      </p>
    </div>
  );
}

function Spark({ data }: { data: number[] }) {
  const W = 84;
  const H = 18;
  const max = Math.max(...data, 1);
  const bw = W / data.length;
  return (
    <svg width={W} height={H} aria-hidden>
      {data.map((v, i) => (
        <rect key={i} x={i * bw + 0.3} y={H - (v / max) * H} width={Math.max(bw - 0.6, 0.6)} height={v ? (v / max) * H : 1} fill={v ? ACCENT : 'rgba(148,163,184,0.18)'} />
      ))}
    </svg>
  );
}

type SortKey = 'number' | 'hits' | 'since' | 'ggr';

function AnimalTable({ o, currency, words }: { o: Overview; currency: Currency; words: Words }) {
  const [sort, setSort] = useState<SortKey>('hits');
  const [desc, setDesc] = useState(true);
  const rows = useMemo(() => {
    const val = (a: Animal) => (sort === 'number' ? Number(a.number) : sort === 'hits' ? a.hits : sort === 'since' ? (a.since ?? 1e9) : Number(BigInt(a.ggr)));
    return [...o.animals].sort((a, b) => (val(a) - val(b)) * (desc ? -1 : 1));
  }, [o.animals, sort, desc]);
  const maxZ = Math.max(3, ...o.animals.map((a) => Math.abs(a.z)));
  const exp = 1 / o.game.symbols;
  const th = (k: SortKey, label: string, cls = '') => (
    <th className={`cursor-pointer select-none px-2 py-1.5 font-medium hover:text-white ${cls}`} onClick={() => (sort === k ? setDesc(!desc) : (setSort(k), setDesc(k !== 'number')))}>
      {label}
      {sort === k ? (desc ? ' ↓' : ' ↑') : ''}
    </th>
  );
  return (
    <div className="-mx-3 overflow-x-auto px-3">
      <table className="w-full min-w-[640px] text-xs tabular-nums">
        <thead className="text-left text-[11px] text-slate-500">
          <tr>
            {th('number', words.one[0].toUpperCase() + words.one.slice(1))}
            {th('hits', 'Salidas', 'text-right')}
            <th className="px-2 py-1.5 text-right font-medium">% (esp. {pct(exp, 2)})</th>
            <th className="px-2 py-1.5 font-medium">Desvío vs. azar</th>
            <th className="px-2 py-1.5 font-medium">Por día</th>
            {th('since', 'Última vez', 'text-right')}
            {th('ggr', 'Ganancia cuando salió', 'text-right')}
          </tr>
        </thead>
        <tbody>
          {rows.map((a) => {
            const zw = (Math.min(Math.abs(a.z), maxZ) / maxZ) * 50;
            return (
              <tr key={a.id} className="border-t border-white/[0.05] hover:bg-white/[0.03]">
                <td className="whitespace-nowrap px-2 py-1.5">
                  <span className="mr-1.5 text-base">{a.emoji}</span>
                  <span className="text-slate-400">{a.number}</span> <span className="text-white">{symbolName(a.number, a.name)}</span>
                </td>
                <td className="px-2 py-1.5 text-right font-semibold text-white">{a.hits}</td>
                <td className="px-2 py-1.5 text-right text-slate-300">{pct(a.share, 2)}</td>
                <td className="px-2 py-1.5">
                  <div className="relative h-3 w-28 rounded bg-white/[0.03]" title={`z = ${a.z.toFixed(2)}`}>
                    <div className="absolute inset-y-0 left-1/2 w-px bg-white/25" />
                    <div className="absolute inset-y-0.5 rounded" style={{ left: a.z >= 0 ? '50%' : `${50 - zw}%`, width: `${zw}%`, background: a.z >= 0 ? '#a78bfa' : '#94a3b8' }} />
                  </div>
                </td>
                <td className="px-2 py-1.5">
                  <Spark data={a.daily} />
                </td>
                <td className="whitespace-nowrap px-2 py-1.5 text-right text-slate-300">{a.since === null ? 'no salió' : a.since === 0 ? 'último' : `hace ${a.since} sorteos`}</td>
                <td className={`whitespace-nowrap px-2 py-1.5 text-right font-semibold ${upDown(a.ggr)}`}>{a.hits ? signed(a.ggr, currency) : '—'}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="mt-2 text-[10px] text-slate-500">
        Morado = salió más de lo esperado; gris = menos. Es historial: cada sorteo es independiente, y que {words.one === 'fruta' ? 'una fruta' : `un ${words.one}`} lleve muchos sorteos sin salir no
        cambia su probabilidad (sigue siendo 1 en {o.game.symbols}).
      </p>
    </div>
  );
}

function Fairness({ o }: { o: Overview }) {
  const f = o.fairness;
  const ok = f.p_value >= 0.01;
  return (
    <Panel title="Auditoría del azar" sub="prueba χ² de uniformidad sobre los resultados del período">
      {f.draws < o.game.symbols * 3 ? (
        <p className="text-xs text-slate-400">Hacen falta al menos {o.game.symbols * 3} sorteos para que la prueba sea útil (hay {f.draws}).</p>
      ) : (
        <div className="flex items-center gap-3">
          <span className={`grid h-11 w-11 shrink-0 place-items-center rounded-full text-lg ${ok ? 'bg-emerald-500/15 text-emerald-400' : 'bg-amber-500/15 text-amber-300'}`}>
            {ok ? '✓' : '!'}
          </span>
          <div className="text-xs">
            <p className="font-semibold text-white">{ok ? 'Consistente con un sorteo al azar' : 'Desvío fuera de lo normal: revisar el RNG y las actas'}</p>
            <p className="tabular-nums text-slate-400">
              χ² = {f.chi2.toFixed(1)} · gl = {f.df} · p = {f.p_value.toFixed(3)} · esperado {f.expected_per_animal.toLocaleString('es-VE', { maximumFractionDigits: 1 })} salidas por animal
            </p>
          </div>
        </div>
      )}
    </Panel>
  );
}

function DrawBook({ draws, currency, onPick, selected }: { draws: DrawRow[]; currency: Currency; onPick: (d: DrawRow) => void; selected?: string }) {
  const rows = [...draws].reverse();
  return (
    <div className="-mx-3 max-h-[420px] overflow-auto px-3">
      <table className="w-full text-xs tabular-nums">
        <thead className="sticky top-0 bg-[#0f151c] text-left text-[11px] text-slate-500">
          <tr>
            <th className="py-1.5 pr-2 font-medium">Sorteo</th>
            <th className="py-1.5 pr-2 font-medium">Salió</th>
            <th className="py-1.5 pr-2 text-right font-medium">Vendido</th>
            <th className="py-1.5 text-right font-medium">Ganancia</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((d) => (
            <tr
              key={d.id}
              onClick={() => onPick(d)}
              className={`cursor-pointer border-t border-white/[0.05] hover:bg-white/[0.04] ${selected === d.id ? 'bg-sky-500/10' : ''}`}
            >
              <td className="whitespace-nowrap py-1.5 pr-2 text-slate-400">
                {dayLabel(d.day)} {hour(d.draw_at)}
              </td>
              <td className="whitespace-nowrap py-1.5 pr-2 text-white">
                {d.result?.emoji} {d.result?.number}
              </td>
              <td className="py-1.5 pr-2 text-right text-slate-300">{d.sold === '0' ? '—' : short(d.sold, currency)}</td>
              <td className={`whitespace-nowrap py-1.5 text-right font-semibold ${upDown(d.ggr)}`}>
                {d.sold === '0' ? '—' : `${short(d.ggr, currency)} · ${pct(d.margin, 0)}`}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const STATUS_TONE: Record<string, string> = {
  OPEN: 'bg-sky-500/15 text-sky-300',
  WON: 'bg-emerald-500/15 text-emerald-300',
  LOST: 'bg-white/5 text-slate-400',
  VOID: 'bg-amber-500/15 text-amber-300',
  CANCELLED: 'bg-amber-500/15 text-amber-300',
};

function TicketsBlotter({
  gameId,
  currency,
  from: defFrom,
  to: defTo,
  draw,
  clearDraw,
}: {
  gameId: string;
  currency: Currency;
  from: string;
  to: string;
  draw: DrawRow | null;
  clearDraw: () => void;
}) {
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  const [status, setStatus] = useState('');
  const [from, setFrom] = useState(defFrom);
  const [to, setTo] = useState(defTo);
  const [includeSim, setIncludeSim] = useState(false);
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => {
    setFrom(defFrom);
    setTo(defTo);
  }, [defFrom, defTo]);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 300);
    return () => clearTimeout(t);
  }, [q]);
  useEffect(() => setPage(1), [debounced, status, from, to, includeSim, draw?.id, gameId, currency]);

  const params = new URLSearchParams({ gameId, currency, page: String(page), size: '50' });
  if (draw) params.set('drawId', draw.id);
  else {
    params.set('from', from);
    params.set('to', to);
  }
  if (debounced) params.set('q', debounced);
  if (status) params.set('status', status);
  if (includeSim) params.set('includeSim', 'true');
  const book = useQuery({
    queryKey: ['admin', 'ticket-book', params.toString()],
    placeholderData: keepPreviousData,
    queryFn: () => get<TicketBook>(`/admin/lottery/tickets?${params}`),
  });
  const b = book.data;
  const pages = b ? Math.max(Math.ceil(b.total / b.size), 1) : 1;
  const tot = b?.totals[currency];

  const exportCsv = () => {
    if (!b) return;
    const lines = [['ticket', 'vendido', 'jugador', 'moneda', 'monto', 'premio', 'estado', 'jugadas'].join(';')];
    for (const t of b.rows) {
      const plays = (t.plays ?? []).map((p) => `${hour(p.draw_at)} ${p.number} ${p.name} ${money(p.amount, t.currency)}`).join(' | ');
      lines.push([t.code, t.sold_at, t.player_email, t.currency, money(t.total, t.currency), money(t.total_win, t.currency), TICKET_STATUS_LABEL[t.status] ?? t.status, plays].map((v) => `"${String(v).replace(/"/g, '""')}"`).join(';'));
    }
    const url = URL.createObjectURL(new Blob(['﻿' + lines.join('\n')], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `tickets-${draw ? draw.day + '-' + draw.hour + 'h' : `${from}_${to}`}-p${page}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const field = 'rounded-lg border border-white/10 bg-white/5 px-2 py-1.5 text-sm text-white placeholder:text-slate-500';
  return (
    <Panel
      title="Libro de tickets"
      sub={b ? `${b.total.toLocaleString('es-VE')} tickets${tot ? ` · vendido ${money(tot.sold, currency)} · premios ${money(tot.won, currency)}` : ''}` : 'cargando…'}
      actions={
        <button onClick={exportCsv} className="rounded-lg border border-white/10 px-2.5 py-1 text-xs text-slate-300 hover:bg-white/5">
          Exportar página (CSV)
        </button>
      }
    >
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <input className={`${field} w-full sm:w-64`} placeholder="Buscar ticket, correo o nombre" value={q} onChange={(e) => setQ(e.target.value)} />
        <select className={field} value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Estado">
          <option value="" className="bg-slate-900">Todos los estados</option>
          {['OPEN', 'WON', 'LOST', 'VOID'].map((s) => (
            <option key={s} value={s} className="bg-slate-900">
              {TICKET_STATUS_LABEL[s]}
            </option>
          ))}
        </select>
        {draw ? (
          <span className="flex items-center gap-2 rounded-lg bg-sky-500/15 px-2.5 py-1.5 text-xs text-sky-200">
            Sorteo {dayLabel(draw.day)} {hour(draw.draw_at)} · salió {draw.result?.emoji} {draw.result?.number} {symbolName(draw.result?.number ?? '', draw.result?.name)}
            <button onClick={clearDraw} className="font-bold text-sky-100 hover:text-white" aria-label="Quitar filtro de sorteo">
              ✕
            </button>
          </span>
        ) : (
          <>
            <input type="date" className={field} value={from} max={to} onChange={(e) => e.target.value && setFrom(e.target.value)} aria-label="Desde" />
            <input type="date" className={field} value={to} min={from} max={todayCaracas()} onChange={(e) => e.target.value && setTo(e.target.value)} aria-label="Hasta" />
          </>
        )}
        <label className="flex items-center gap-1.5 text-xs text-slate-400">
          <input type="checkbox" checked={includeSim} onChange={(e) => setIncludeSim(e.target.checked)} /> Incluir simulación
        </label>
      </div>

      {book.error ? (
        <ErrorBox error={book.error} />
      ) : !b ? (
        <Spinner />
      ) : !b.rows.length ? (
        <p className="py-8 text-center text-sm text-slate-500">No hay tickets con esos filtros.</p>
      ) : (
        <div className={`-mx-3 overflow-x-auto px-3 ${book.isFetching ? 'opacity-70' : ''}`}>
          <table className="w-full min-w-[720px] text-xs tabular-nums">
            <thead className="text-left text-[11px] text-slate-500">
              <tr>
                <th className="px-2 py-1.5 font-medium">Ticket</th>
                <th className="px-2 py-1.5 font-medium">Vendido</th>
                <th className="px-2 py-1.5 font-medium">Jugador</th>
                <th className="px-2 py-1.5 font-medium">Jugadas</th>
                <th className="px-2 py-1.5 text-right font-medium">Monto</th>
                <th className="px-2 py-1.5 text-right font-medium">Premio</th>
                <th className="px-2 py-1.5 font-medium">Estado</th>
              </tr>
            </thead>
            <tbody>
              {b.rows.map((t) => (
                <Fragment key={t.id}>
                  <tr onClick={() => setOpen(open === t.id ? null : t.id)} className="cursor-pointer border-t border-white/[0.05] hover:bg-white/[0.03]">
                    <td className="whitespace-nowrap px-2 py-1.5 font-mono text-[11px] text-slate-300">
                      {open === t.id ? '▾' : '▸'} {t.code}
                      {t.is_simulation && <span className="ml-1 rounded bg-violet-500/20 px-1 text-[10px] text-violet-300">SIM</span>}
                    </td>
                    <td className="whitespace-nowrap px-2 py-1.5 text-slate-400">{dateTime(t.sold_at)}</td>
                    <td className="max-w-[12rem] truncate px-2 py-1.5 text-slate-300" title={t.player_email}>
                      {t.player_email}
                    </td>
                    <td className="whitespace-nowrap px-2 py-1.5">
                      {(t.plays ?? []).slice(0, 5).map((p, i) => (
                        <span key={i} title={p.emoji ? `${p.number} ${p.name}` : `${p.modality_name} ${playedLabel(p.modality, p.number)}`} className={p.status === 'WON' ? 'rounded bg-emerald-500/20' : ''}>
                          {p.emoji || <span className="mx-0.5 rounded bg-white/10 px-1 text-[11px] font-bold">{p.selection ? p.selection.map((n) => String(n).padStart(2, '0')).join('-') : playedLabel(p.modality, p.number)}</span>}
                        </span>
                      ))}
                      {(t.plays?.length ?? 0) > 5 && <span className="text-slate-500"> +{t.plays!.length - 5}</span>}
                    </td>
                    <td className="px-2 py-1.5 text-right text-white">{money(t.total, t.currency)}</td>
                    <td className={`px-2 py-1.5 text-right ${t.total_win !== '0' ? 'font-semibold text-emerald-400' : 'text-slate-500'}`}>
                      {t.total_win !== '0' ? money(t.total_win, t.currency) : '—'}
                    </td>
                    <td className="px-2 py-1.5">
                      <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${STATUS_TONE[t.status] ?? ''}`}>{TICKET_STATUS_LABEL[t.status] ?? t.status}</span>
                    </td>
                  </tr>
                  {open === t.id && (
                    <tr className="bg-white/[0.02]">
                      <td colSpan={7} className="px-2 py-2">
                        <p className="mb-1.5 text-[11px] text-slate-400">
                          {t.player_name} · {t.game_code} · canal {t.channel} · premio posible {money(t.potential_win, t.currency)}
                        </p>
                        <div className="grid gap-1 sm:grid-cols-2 lg:grid-cols-3">
                          {(t.plays ?? []).map((p, i) => (
                            <div key={i} className={`flex items-center justify-between gap-2 rounded-lg px-2 py-1 ${p.status === 'WON' ? 'bg-emerald-500/10' : 'bg-white/[0.03]'}`}>
                              <span className="truncate">
                                <span className="text-slate-400">{hour(p.draw_at)}</span> {p.emoji ? <>{p.emoji} {p.number} {p.name}</> : <>{p.modality_name} {p.selection ? p.selection.map((n) => String(n).padStart(2, '0')).join('-') : playedLabel(p.modality, p.number)}</>}
                              </span>
                              <span className="whitespace-nowrap text-right">
                                {money(p.amount, t.currency)}
                                <span className="text-slate-500"> → </span>
                                {p.result_number ? (
                                  <span className={p.status === 'WON' ? 'font-semibold text-emerald-400' : 'text-slate-400'}>
                                    {p.status === 'WON' ? money(p.win, t.currency) : `salió ${p.result_emoji} ${p.result_number}`}
                                  </span>
                                ) : (
                                  <span className="text-sky-300">{p.status === 'VOID' ? 'anulada' : 'en juego'}</span>
                                )}
                              </span>
                            </div>
                          ))}
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {b && b.total > b.size && (
        <div className="mt-2 flex items-center justify-between text-xs text-slate-400">
          <span className="tabular-nums">
            Página {page} de {pages}
          </span>
          <div className="flex gap-1">
            <button disabled={page <= 1} onClick={() => setPage(1)} className="rounded border border-white/10 px-2 py-1 disabled:opacity-30">
              «
            </button>
            <button disabled={page <= 1} onClick={() => setPage(page - 1)} className="rounded border border-white/10 px-2 py-1 disabled:opacity-30">
              ‹ Anterior
            </button>
            <button disabled={page >= pages} onClick={() => setPage(page + 1)} className="rounded border border-white/10 px-2 py-1 disabled:opacity-30">
              Siguiente ›
            </button>
          </div>
        </div>
      )}
    </Panel>
  );
}

