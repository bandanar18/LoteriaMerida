import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ReactNode, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ErrorBox, Notice, PageTitle, Spinner } from '../../components/ui';
import { get, post, put } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { Currency, CURRENCY, dateTime, hour, money } from '../../lib/format';
import { useGames, useSimulationStatus } from '../../lib/queries';

interface LimitRow {
  currency: Currency;
  min_play: string;
  max_play: string;
  max_ticket: string;
  max_liability_per_symbol: string;
  max_player_per_draw: string | null;
}
interface GameConfig {
  game: { id: string; code: string; name: string; timezone: string; close_minutes_before: number; result_source: string; requires_record: boolean };
  limits: LimitRow[];
  schedule: { weekday: number; time: string }[];
}

const DAYS = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0];

/** Unidades mínimas → "5000" / "12.5" para editar (sin separador de miles). */
function plain(minor: string | null, c: Currency) {
  if (minor === null) return '';
  const d = CURRENCY[c].minor;
  const v = BigInt(minor);
  const int = v / 10n ** BigInt(d);
  const frac = (v % 10n ** BigInt(d)).toString().padStart(d, '0').replace(/0+$/, '');
  return frac ? `${int}.${frac}` : `${int}`;
}
const time12 = (t: string) => {
  const [h, m] = t.split(':').map(Number);
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'a. m.' : 'p. m.'}`;
};

/**
 * Configuración de juegos: sorteo automático, montos de apuesta y horarios.
 * Leer: operador y auditor. Cambiar: operador de sorteos (y administrador). Todo queda en auditoría.
 */
export function SettingsPage() {
  const games = useGames();
  const { user } = useAuth();
  const canEdit = user?.role === 'ADMIN' || user?.role === 'LOTTERY_OPERATOR';
  const [gameId, setGameId] = useState<string>();
  const game = games.data?.find((g) => g.id === gameId) ?? games.data?.find((g) => g.code === 'MER-05') ?? games.data?.[0];
  const cfg = useQuery({
    queryKey: ['admin', 'game-config', game?.id],
    enabled: !!game,
    queryFn: () => get<GameConfig>(`/admin/lottery/games/${game!.id}/config`),
  });

  if (games.isLoading) return <Spinner />;
  return (
    <div className="space-y-5">
      <PageTitle>Configuración de juegos</PageTitle>
      <div className={`no-scrollbar -mx-4 flex gap-2 overflow-x-auto px-4 sm:mx-0 sm:px-0 ${(games.data?.length ?? 0) < 2 ? 'hidden' : ''}`}>
        {games.data?.map((g) => (
          <button
            key={g.id}
            onClick={() => setGameId(g.id)}
            className={`btn shrink-0 ${g.id === game?.id ? 'bg-selva-800 text-white' : 'bg-white text-slate-700 ring-1 ring-black/10'}`}
          >
            {g.name}
          </button>
        ))}
      </div>
      {!canEdit && <Notice>Puedes ver la configuración; solo el operador de sorteos o el administrador pueden cambiarla.</Notice>}
      {cfg.error ? (
        <ErrorBox error={cfg.error} />
      ) : !cfg.data ? (
        <Spinner />
      ) : (
        <div className="grid gap-5 xl:grid-cols-2">
          <div className="space-y-5">
            <AutoDraw cfg={cfg.data} canEdit={canEdit} canTest={user?.role === 'ADMIN' && game?.is_demo === true} />
            <Limits key={`l-${cfg.data.game.id}`} cfg={cfg.data} canEdit={canEdit} />
          </div>
          <Schedule key={`s-${cfg.data.game.id}`} cfg={cfg.data} canEdit={canEdit} />
          {user?.role === 'ADMIN' && (
            <div className="xl:col-span-2">
              <HistoryReset key={`h-${cfg.data.game.id}`} cfg={cfg.data} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Card({ title, sub, children }: { title: string; sub: string; children: ReactNode }) {
  return (
    <section className="card overflow-hidden">
      <div className="border-b border-slate-100 px-5 py-4">
        <h2 className="text-[15px] font-semibold text-slate-900">{title}</h2>
        <p className="mt-0.5 text-xs text-slate-500">{sub}</p>
      </div>
      <div className="p-5">{children}</div>
    </section>
  );
}

// ───────────── Sorteo automático ─────────────

function AutoDraw({ cfg, canEdit, canTest }: { cfg: GameConfig; canEdit: boolean; canTest: boolean }) {
  const qc = useQueryClient();
  const close = cfg.game.close_minutes_before;
  const testing = useSimulationStatus().data?.enabled ?? false;
  const minAllowed = close + 1;
  const [minutes, setMinutes] = useState(close + 5);
  const [done, setDone] = useState<{ draw_at: string; close_at: string } | null>(null);
  useEffect(() => setMinutes(close + 5), [close]);
  const create = useMutation({
    mutationFn: () => post<{ draw_at: string; close_at: string }>(`/admin/lottery/games/${cfg.game.id}/extraordinary-draw`, { minutesFromNow: minutes, auto: true }),
    onSuccess: (d) => {
      setDone(d);
      qc.invalidateQueries({ queryKey: ['admin', 'draws'] });
      qc.invalidateQueries({ queryKey: ['draws'] });
    },
  });
  const at = new Date(Date.now() + minutes * 60_000);
  return (
    <Card title="Sorteo automático" sub="Crea un sorteo extra cuando quieras. El resultado lo pone solo el generador aleatorio verificable a la hora indicada.">
      <div className="space-y-4">
        <div>
          <label className="label">¿En cuántos minutos se sortea?</label>
          <div className="flex flex-wrap items-center gap-2">
            <input
              className="input w-28"
              type="number"
              min={minAllowed}
              max={1440}
              value={minutes}
              onChange={(e) => setMinutes(Number(e.target.value))}
              disabled={!canEdit}
            />
            {[close + 5, 15, 30, 60].filter((v, i, a) => a.indexOf(v) === i && v > close).map((v) => (
              <button key={v} type="button" className="btn-ghost px-3 py-1.5 text-xs" disabled={!canEdit} onClick={() => setMinutes(v)}>
                {v} min
              </button>
            ))}
          </div>
          <p className="mt-1.5 text-xs text-slate-500">
            Venta abierta desde ya · cierra {close} min antes · se sortea a las{' '}
            <b>{hour(at.toISOString())}</b> aprox.
          </p>
        </div>
        <ErrorBox error={create.error} />
        {done && (
          <Notice tone="success">
            Sorteo automático creado para el <b>{dateTime(done.draw_at)}</b> (venta hasta {dateTime(done.close_at)}).{' '}
            <Link to="/resultados" className="font-semibold underline">Ver en Resultados</Link>
          </Notice>
        )}
        <button className="btn-primary w-full" disabled={!canEdit || create.isPending || minutes < minAllowed} onClick={() => create.mutate()}>
          {create.isPending ? 'Creando…' : 'Programar sorteo automático'}
        </button>
        {canTest && testing && (
          <Link to="/admin/mercado?historial=simulado" className="btn w-full bg-amber-100 text-amber-900 ring-1 ring-amber-300 hover:bg-amber-200">
            ⚡ Sorteo rápido de prueba en Mercado
          </Link>
        )}
        <p className="text-[11px] leading-relaxed text-slate-400">
          Nadie elige el resultado: se compromete la semilla al crear el sorteo y el resultado sale del RNG a la hora del sorteo. Los jugadores pueden verificarlo.
        </p>
      </div>
    </Card>
  );
}

// ───────────── Montos de apuesta ─────────────

const LIMIT_FIELDS: { key: keyof LimitRow; label: string; hint: string; optional?: boolean }[] = [
  { key: 'min_play', label: 'Apuesta mínima', hint: 'por jugada (por animal o fruta)' },
  { key: 'max_play', label: 'Apuesta máxima', hint: 'por jugada (por animal o fruta)' },
  { key: 'max_ticket', label: 'Máximo por ticket', hint: 'suma de todas las jugadas del ticket' },
  { key: 'max_player_per_draw', label: 'Máximo por jugador y sorteo', hint: 'vacío = sin límite', optional: true },
  { key: 'max_liability_per_symbol', label: 'Tope de pago por animal / fruta', hint: 'premio máximo que la casa paga por cada animal o fruta en un sorteo' },
];

function Limits({ cfg, canEdit }: { cfg: GameConfig; canEdit: boolean }) {
  const qc = useQueryClient();
  const [currency, setCurrency] = useState<Currency>(cfg.limits[0]?.currency ?? 'VES');
  const row = cfg.limits.find((l) => l.currency === currency);
  const initial = useMemo(
    () => Object.fromEntries(LIMIT_FIELDS.map((f) => [f.key, row ? plain(row[f.key] as string | null, currency) : ''])) as Record<string, string>,
    [row, currency],
  );
  const [form, setForm] = useState(initial);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    setForm(initial);
    setSaved(false);
  }, [initial]);
  const dirty = LIMIT_FIELDS.some((f) => (form[f.key] ?? '') !== (initial[f.key] ?? ''));
  const save = useMutation({
    mutationFn: () =>
      put(`/admin/lottery/games/${cfg.game.id}/limits`, {
        currency,
        minPlay: form.min_play,
        maxPlay: form.max_play,
        maxTicket: form.max_ticket,
        maxLiabilityPerSymbol: form.max_liability_per_symbol,
        maxPlayerPerDraw: form.max_player_per_draw?.trim() ? form.max_player_per_draw : null,
      }),
    onSuccess: () => {
      setSaved(true);
      qc.invalidateQueries({ queryKey: ['admin', 'game-config', cfg.game.id] });
      qc.invalidateQueries({ queryKey: ['games'] });
    },
  });
  const sym = CURRENCY[currency].symbol;
  return (
    <Card title="Montos de apuesta" sub="Lo que el jugador puede apostar. Los cambios aplican a las jugadas nuevas; los tickets ya vendidos no cambian.">
      <div className="mb-4 flex rounded-lg bg-slate-100 p-1 text-sm">
        {cfg.limits.map((l) => (
          <button
            key={l.currency}
            onClick={() => setCurrency(l.currency)}
            className={`flex-1 rounded-md px-3 py-1.5 font-semibold ${currency === l.currency ? 'bg-white shadow-sm' : 'text-slate-500'}`}
          >
            {l.currency === 'VES' ? 'Bolívares' : 'USDT'}
          </button>
        ))}
      </div>
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          setSaved(false);
          save.mutate();
        }}
      >
        <div className="grid gap-3 sm:grid-cols-2">
          {LIMIT_FIELDS.map((f) => (
            <div key={f.key} className={f.key === 'max_liability_per_symbol' ? 'sm:col-span-2' : ''}>
              <label className="label">{f.label}</label>
              <div className="relative">
                <input
                  className="input pr-14"
                  inputMode="decimal"
                  value={form[f.key] ?? ''}
                  placeholder={f.optional ? 'sin límite' : ''}
                  required={!f.optional}
                  disabled={!canEdit}
                  onChange={(e) => setForm({ ...form, [f.key]: e.target.value.replace(',', '.') })}
                />
                <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-xs text-slate-400">{sym}</span>
              </div>
              <p className="mt-0.5 text-[11px] text-slate-400">
                {f.hint}
                {row && row[f.key] !== null && ` · actual ${money(row[f.key] as string, currency)}`}
              </p>
            </div>
          ))}
        </div>
        <ErrorBox error={save.error} />
        {saved && !dirty && <Notice tone="success">Montos guardados. Ya aplican a las jugadas nuevas.</Notice>}
        <div className="flex gap-2">
          <button className="btn-primary flex-1" disabled={!canEdit || !dirty || save.isPending}>
            {save.isPending ? 'Guardando…' : 'Guardar montos'}
          </button>
          {dirty && (
            <button type="button" className="btn-ghost" onClick={() => setForm(initial)}>
              Deshacer
            </button>
          )}
        </div>
      </form>
    </Card>
  );
}

// ───────────── Horarios ─────────────

function Schedule({ cfg, canEdit }: { cfg: GameConfig; canEdit: boolean }) {
  const qc = useQueryClient();
  const initial = useMemo(() => {
    const m = new Map<string, Set<number>>();
    for (const s of cfg.schedule) {
      if (!m.has(s.time)) m.set(s.time, new Set());
      m.get(s.time)!.add(s.weekday);
    }
    return m;
  }, [cfg.schedule]);
  const [rows, setRows] = useState<Map<string, Set<number>>>(() => new Map([...initial].map(([t, d]) => [t, new Set(d)])));
  const [close, setClose] = useState(cfg.game.close_minutes_before);
  const [newTime, setNewTime] = useState('');
  const [result, setResult] = useState<{ removed: number; keptWithPlays: string[] } | null>(null);

  const key = (m: Map<string, Set<number>>) =>
    [...m]
      .filter(([, d]) => d.size)
      .map(([t, d]) => `${t}:${[...d].sort().join('')}`)
      .sort()
      .join('|');
  const dirty = key(rows) !== key(initial) || close !== cfg.game.close_minutes_before;
  const times = [...rows.keys()].sort();
  const total = [...rows.values()].reduce((a, d) => a + d.size, 0);

  const toggle = (t: string, d: number) => {
    const next = new Map(rows);
    const s = new Set(next.get(t));
    if (s.has(d)) s.delete(d);
    else s.add(d);
    next.set(t, s);
    setRows(next);
  };
  const setAll = (t: string, on: boolean) => setRows(new Map(rows).set(t, new Set(on ? DAY_ORDER : [])));
  const remove = (t: string) => {
    const next = new Map(rows);
    next.delete(t);
    setRows(next);
  };
  const add = () => {
    if (!/^\d{2}:\d{2}$/.test(newTime) || rows.has(newTime)) return;
    setRows(new Map(rows).set(newTime, new Set(DAY_ORDER)));
    setNewTime('');
  };

  const save = useMutation({
    mutationFn: () =>
      put<{ removed: number; keptWithPlays: string[] }>(`/admin/lottery/games/${cfg.game.id}/schedule`, {
        closeMinutesBefore: close,
        slots: [...rows].flatMap(([time, days]) => [...days].map((weekday) => ({ weekday, time }))),
      }),
    onSuccess: (r) => {
      setResult(r);
      qc.invalidateQueries({ queryKey: ['admin', 'game-config', cfg.game.id] });
      qc.invalidateQueries({ queryKey: ['admin', 'draws'] });
      qc.invalidateQueries({ queryKey: ['draws'] });
      qc.invalidateQueries({ queryKey: ['games'] });
    },
  });

  return (
    <Card title="Horarios de sorteos" sub="Horas fijas de cada día. Al guardar se crean los sorteos nuevos de hoy y mañana, y se quitan los que ya no estén en el horario.">
      <div className="mb-4 flex flex-wrap items-end gap-4">
        <div>
          <label className="label">Cierre de venta</label>
          <div className="flex items-center gap-2">
            <input className="input w-24" type="number" min={1} max={120} value={close} disabled={!canEdit} onChange={(e) => setClose(Number(e.target.value))} />
            <span className="text-sm text-slate-500">min antes de cada sorteo</span>
          </div>
        </div>
        <div className="ml-auto text-right text-xs text-slate-500">
          <b className="text-lg text-slate-900">{times.length}</b> horas · {total} sorteos por semana
        </div>
      </div>

      <div className="-mx-5 overflow-x-auto px-5">
        <table className="w-full min-w-[520px] text-sm">
          <thead>
            <tr className="text-[11px] uppercase tracking-wide text-slate-400">
              <th className="py-2 pr-2 text-left font-medium">Hora</th>
              {DAY_ORDER.map((d) => (
                <th key={d} className="px-0.5 py-2 text-center font-medium">
                  {DAYS[d]}
                </th>
              ))}
              <th />
            </tr>
          </thead>
          <tbody>
            {times.map((t) => {
              const days = rows.get(t)!;
              return (
                <tr key={t} className={`border-t border-slate-100 ${days.size ? '' : 'opacity-50'}`}>
                  <td className="whitespace-nowrap py-1.5 pr-2 font-semibold tabular-nums text-slate-800">{time12(t)}</td>
                  {DAY_ORDER.map((d) => (
                    <td key={d} className="px-0.5 py-1.5 text-center">
                      <button
                        type="button"
                        disabled={!canEdit}
                        onClick={() => toggle(t, d)}
                        aria-label={`${DAYS[d]} ${t}`}
                        aria-pressed={days.has(d)}
                        className={`h-7 w-9 rounded-md text-xs font-semibold transition ${days.has(d) ? 'bg-selva-700 text-white' : 'bg-slate-100 text-slate-400 hover:bg-slate-200'}`}
                      >
                        {days.has(d) ? '✓' : ''}
                      </button>
                    </td>
                  ))}
                  <td className="whitespace-nowrap py-1.5 pl-2 text-right">
                    {canEdit && (
                      <>
                        <button type="button" className="rounded px-1.5 py-1 text-[11px] text-slate-500 hover:bg-slate-100" onClick={() => setAll(t, days.size < 7)}>
                          {days.size < 7 ? 'Todos' : 'Ninguno'}
                        </button>
                        <button type="button" className="rounded px-1.5 py-1 text-[11px] text-red-600 hover:bg-red-50" onClick={() => remove(t)} aria-label={`Quitar ${t}`}>
                          Quitar
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {canEdit && (
        <div className="mt-3 flex items-center gap-2">
          <input className="input w-36" type="time" value={newTime} onChange={(e) => setNewTime(e.target.value)} aria-label="Nueva hora" />
          <button type="button" className="btn-ghost" disabled={!newTime || rows.has(newTime)} onClick={add}>
            + Agregar hora
          </button>
          {newTime && rows.has(newTime) && <span className="text-xs text-slate-500">Esa hora ya existe</span>}
        </div>
      )}

      <div className="mt-4 space-y-3">
        <ErrorBox error={save.error} />
        {result && !dirty && (
          <Notice tone={result.keptWithPlays.length ? 'warn' : 'success'}>
            Horario guardado.
            {result.removed > 0 && ` Se quitaron ${result.removed} sorteo(s) futuros sin jugadas.`}
            {result.keptWithPlays.length > 0 &&
              ` Se mantienen ${result.keptWithPlays.length} sorteo(s) que ya tienen jugadas (${result.keptWithPlays.map((d) => dateTime(d)).join(', ')}); puedes anularlos con reembolso desde Sorteos.`}
          </Notice>
        )}
        <div className="flex gap-2">
          <button
            className="btn-primary flex-1"
            disabled={!canEdit || !dirty || save.isPending || total === 0}
            onClick={() => {
              setResult(null);
              save.mutate();
            }}
          >
            {save.isPending ? 'Guardando…' : 'Guardar horario'}
          </button>
          {dirty && (
            <button
              type="button"
              className="btn-ghost"
              onClick={() => {
                setRows(new Map([...initial].map(([t, d]) => [t, new Set(d)])));
                setClose(cfg.game.close_minutes_before);
              }}
            >
              Deshacer
            </button>
          )}
        </div>
        {total === 0 && <p className="text-xs text-red-600">El juego necesita al menos un sorteo por semana.</p>}
      </div>
    </Card>
  );
}

// ───────────── Reseteo del historial ─────────────

type HistoryPreview = {
  from: string;
  to: string;
  resettable: number;
  settled: number;
  cancelled: number;
  skipped: number;
  archived: number;
  tickets: number;
  first_at: string | null;
  last_at: string | null;
  games?: number;
};

/** 'YYYY-MM-DDTHH:MM' en la zona del juego, desplazado `days` días. */
function localStamp(tz: string, days = 0, time?: string) {
  const d = new Date(Date.now() + days * 86_400_000);
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(d)
      .map((x) => [x.type, x.value]),
  );
  return `${p.year}-${p.month}-${p.day}T${time ?? `${p.hour}:${p.minute}`}`;
}

const CONFIRM_WORD = 'RESETEAR';

function HistoryReset({ cfg }: { cfg: GameConfig }) {
  const qc = useQueryClient();
  const tz = cfg.game.timezone;
  const [from, setFrom] = useState(() => localStamp(tz, 0, '00:00'));
  const [to, setTo] = useState(() => localStamp(tz));
  const [confirm, setConfirm] = useState('');
  const [done, setDone] = useState<string | null>(null);
  // Alcance: todos los juegos a la vez o solo el juego elegido arriba.
  const [all, setAll] = useState(true);
  const valid = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(from) && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(to) && from <= to;
  const base = all ? `/admin/lottery/history` : `/admin/lottery/games/${cfg.game.id}/history`;
  const preview = useQuery({
    queryKey: ['admin', 'history-preview', all ? 'all' : cfg.game.id, from, to],
    enabled: valid,
    queryFn: () => get<HistoryPreview>(`${base}/preview?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`),
  });
  const refresh = () => {
    setConfirm('');
    qc.invalidateQueries({ queryKey: ['admin'] });
    qc.invalidateQueries({ queryKey: ['draws'] });
  };
  const reset = useMutation({
    mutationFn: () => post<{ reset: number; skipped: number }>(`${base}/reset`, { from, to }),
    onSuccess: (r) => {
      setDone(`Se resetearon ${r.reset} sorteos${r.skipped ? ` (${r.skipped} sin terminar se dejaron como están)` : ''}.`);
      refresh();
    },
  });
  const restore = useMutation({
    mutationFn: () => post<{ restored: number }>(`${base}/restore`, { from, to }),
    onSuccess: (r) => {
      setDone(`Se restauraron ${r.restored} sorteos.`);
      refresh();
    },
  });
  const presets: { label: string; from: () => string; to: () => string }[] = [
    { label: 'Hoy', from: () => localStamp(tz, 0, '00:00'), to: () => localStamp(tz) },
    { label: 'Ayer', from: () => localStamp(tz, -1, '00:00'), to: () => localStamp(tz, -1, '23:59') },
    { label: 'Últimos 7 días', from: () => localStamp(tz, -6, '00:00'), to: () => localStamp(tz) },
    { label: 'Todo', from: () => '2000-01-01T00:00', to: () => localStamp(tz) },
  ];
  const p = preview.data;
  const busy = reset.isPending || restore.isPending;
  return (
    <Card
      title="Resetear historial de sorteos"
      sub="Saca del Mercado, la banda, las frecuencias, el riesgo y los resultados los sorteos terminados de un rango de fecha y hora."
    >
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-1 rounded-xl bg-slate-100 p-1" role="tablist" aria-label="Juegos a resetear">
          {[
            [true, 'Todos los juegos'],
            [false, cfg.game.name],
          ].map(([v, label]) => (
            <button
              key={String(v)}
              type="button"
              role="tab"
              aria-selected={all === v}
              onClick={() => {
                setAll(v as boolean);
                setDone(null);
                setConfirm('');
              }}
              className={`truncate rounded-lg px-2 py-2 text-sm font-semibold ${all === v ? 'bg-white shadow-sm text-slate-900' : 'text-slate-500'}`}
            >
              {label as string}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap gap-2">
          {presets.map((x) => (
            <button
              key={x.label}
              type="button"
              className="btn-ghost px-3 py-1.5 text-xs"
              onClick={() => {
                setFrom(x.from());
                setTo(x.to());
                setDone(null);
              }}
            >
              {x.label}
            </button>
          ))}
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className="label" htmlFor="hr-from">Desde</label>
            <input id="hr-from" className="input" type="datetime-local" value={from} onChange={(e) => { setFrom(e.target.value); setDone(null); }} />
          </div>
          <div>
            <label className="label" htmlFor="hr-to">Hasta (incluida)</label>
            <input id="hr-to" className="input" type="datetime-local" value={to} onChange={(e) => { setTo(e.target.value); setDone(null); }} />
          </div>
        </div>
        <p className="-mt-2 text-xs text-slate-500">Hora de {tz.replace('America/', '')}, según la hora de cada sorteo.</p>
        {!valid && <Notice tone="warn">La fecha inicial debe ser anterior a la final.</Notice>}
        <ErrorBox error={preview.error} />
        {valid && p && (
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {[
              ['Se resetean', p.resettable, `${p.settled} liquidados · ${p.cancelled} anulados${all && p.games ? ` · ${p.games} juego${p.games === 1 ? '' : 's'}` : ''}`],
              ['Tickets afectados', p.tickets, 'salen del libro del Mercado'],
              ['Sin terminar', p.skipped, 'no se tocan'],
              ['Ya reseteados', p.archived, 'se pueden restaurar'],
            ].map(([k, v, h]) => (
              <div key={k as string} className="rounded-xl bg-slate-50 px-3 py-2 ring-1 ring-slate-200">
                <div className="text-[11px] text-slate-500">{k}</div>
                <div className="text-lg font-semibold tabular-nums text-slate-900">{v}</div>
                <div className="text-[11px] leading-tight text-slate-400">{h}</div>
              </div>
            ))}
          </div>
        )}
        {p && p.resettable > 0 && p.first_at && p.last_at && (
          <p className="text-xs text-slate-500">
            Del sorteo de <b>{dateTime(p.first_at)}</b> al de <b>{dateTime(p.last_at)}</b>.
          </p>
        )}
        <Notice>
          No se borra dinero ni registros: tickets, saldos, ledger, actas y auditoría quedan igual, y el reseteo queda en Auditoría con tu usuario.
        </Notice>
        <div>
          <label className="label" htmlFor="hr-confirm">Escribe {CONFIRM_WORD} para confirmar</label>
          <input
            id="hr-confirm"
            className="input font-mono uppercase"
            value={confirm}
            autoComplete="off"
            onChange={(e) => setConfirm(e.target.value.toUpperCase())}
            placeholder={CONFIRM_WORD}
          />
        </div>
        <ErrorBox error={reset.error ?? restore.error} />
        {done && <Notice tone="success">{done}</Notice>}
        <div className="grid gap-2 sm:grid-cols-2">
          <button
            className="btn-danger w-full"
            disabled={busy || !valid || !p?.resettable || confirm !== CONFIRM_WORD}
            onClick={() => reset.mutate()}
          >
            {reset.isPending ? 'Reseteando…' : `Resetear ${p?.resettable ?? 0} sorteos${all ? ' de todos los juegos' : ''}`}
          </button>
          <button className="btn-ghost w-full" disabled={busy || !valid || !p?.archived} onClick={() => restore.mutate()}>
            {restore.isPending ? 'Restaurando…' : `Restaurar ${p?.archived ?? 0} sorteos`}
          </button>
        </div>
      </div>
    </Card>
  );
}
