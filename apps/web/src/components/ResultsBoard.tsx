import { Link } from 'react-router-dom';
import { countdown, hour, todayCaracas, useNow } from '../lib/format';
import { Draw, Game, useDraws } from '../lib/queries';
import { SymbolArt, symbolName } from './SymbolArt';

/** "2026-11-09" ± n días (fechas de calendario de Caracas, sin hora). */
export function shiftDate(date: string, days: number) {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** "lunes, 9 de noviembre" */
export function longDate(date: string) {
  return new Intl.DateTimeFormat('es-VE', { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long' }).format(new Date(`${date}T12:00:00Z`));
}

/** Resultado visible de un sorteo: oficial o, si el juego lo publica, preliminar. */
export function shownResult(d: Draw) {
  if (d.result_number) return { number: d.result_number, name: d.result_name!, emoji: d.result_emoji, numbers: d.result_numbers ?? null, star: d.result_star ?? null, official: true };
  if (d.preliminary_number)
    return { number: d.preliminary_number, name: d.preliminary_name!, emoji: d.preliminary_emoji, numbers: d.preliminary_numbers ?? null, star: null, official: false };
  return null;
}

const lastWithResult = (rows: Draw[] | undefined) => [...(rows ?? [])].reverse().find((d) => shownResult(d));

export function useUpcomingDraws(gameId: string | undefined) {
  const today = todayCaracas();
  const tomorrow = shiftDate(today, 1);
  const todayDraws = useDraws(gameId, today);
  const tomorrowDraws = useDraws(gameId, tomorrow);
  return { today, tomorrow, todayDraws, tomorrowDraws };
}

/** Último resultado publicado y próximo sorteo del calendario. */
export function useRecentDraws(game: Game | undefined) {
  const upcoming = useUpcomingDraws(game?.id);
  const { today, todayDraws, tomorrowDraws } = upcoming;
  const yesterday = shiftDate(today, -1);
  const yesterdayDraws = useDraws(game?.id, yesterday);
  const now = useNow(1000);
  const latest = lastWithResult(todayDraws.data) ?? lastWithResult(yesterdayDraws.data);
  const next = [...(todayDraws.data ?? []), ...(tomorrowDraws.data ?? [])].find(
    (d) => ['SCHEDULED', 'OPEN', 'CLOSED'].includes(d.status) && new Date(d.draw_at).getTime() > now,
  );
  return { ...upcoming, yesterday, yesterdayDraws, latest, next, now };
}

/** Tarjetas «Último sorteo» y «Próximo sorteo». */
export function LatestAndNext({ latest, next, now }: { latest?: Draw; next?: Draw; now: number }) {
  const r = latest && shownResult(latest);
  const closesIn = next?.status === 'OPEN' && countdown(next.close_at, now);
  return (
    <div className="grid grid-cols-2 gap-2 sm:gap-3">
      <div className="card flex flex-col justify-between bg-gradient-to-br from-selva-800 to-selva-600 p-3 text-white sm:p-4">
        <div className="text-[10px] font-bold tracking-wider text-white/70 uppercase">Último sorteo</div>
        {r && latest ? (
          <div className="mt-1 flex items-center gap-2">
            <SymbolArt className="text-4xl leading-none sm:text-5xl" emoji={r.emoji} number={r.number} numbers={r.numbers} star={r.star} />
            <div className="min-w-0">
              {r.emoji && <div className="text-2xl leading-none font-extrabold text-oro-300 tabular-nums">{r.number}</div>}
              <div className="truncate text-sm font-semibold">{symbolName(r.number, r.name) || (r.emoji ? r.number : '')}</div>
              <div className="text-[11px] text-white/70">
                {hour(latest.draw_at)}
                {!r.official && ' · preliminar'}
              </div>
            </div>
          </div>
        ) : (
          <div className="mt-2 text-sm text-white/70">Aún sin resultados</div>
        )}
      </div>
      <div className="card flex flex-col justify-between bg-oro-300/90 p-3 text-selva-950 sm:p-4">
        <div className="text-[10px] font-bold tracking-wider text-selva-900/60 uppercase">Próximo sorteo</div>
        {next ? (
          <>
            <div className="mt-1 text-2xl font-extrabold sm:text-3xl">{hour(next.draw_at)}</div>
            <div className="text-[11px] text-selva-900/70 tabular-nums">
              {todayCaracas(new Date(next.draw_at)) !== todayCaracas() && 'Mañana · '}
              {closesIn ? `cierra la venta en ${closesIn}` : `faltan ${countdown(next.draw_at, now) ?? '—'}`}
            </div>
          </>
        ) : (
          <div className="mt-2 text-sm text-selva-900/70">Horario por publicar</div>
        )}
      </div>
    </div>
  );
}

/** Cuadrícula de un día: una casilla por sorteo, con el animal que salió o su estado. */
export function DayGrid({ draws, latestId, nextId, onVerify }: { draws: Draw[]; latestId?: string; nextId?: string; onVerify?: (id: string) => void }) {
  return (
    <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 lg:grid-cols-6">
      {draws.map((d) => {
        const r = shownResult(d);
        const isLatest = d.id === latestId;
        const isNext = d.id === nextId;
        return (
          <button
            key={d.id}
            type="button"
            disabled={!onVerify}
            onClick={() => onVerify?.(d.id)}
            className={`relative flex min-h-[7.5rem] flex-col items-center rounded-2xl px-1 pt-2 pb-2 text-center ring-1 transition enabled:active:scale-[0.97] ${
              isLatest ? 'bg-gradient-to-b from-[#0f3d2a] to-[#0a2a1c] text-white ring-2 ring-lima-500' : r ? 'bg-white ring-black/10' : 'bg-white/85 ring-black/5'
            }`}
            aria-label={`${hour(d.draw_at)}:${r ? `${r.number} ${symbolName(r.number, r.name)}` : statusText(d)}`}
          >
            <div className="text-xs font-bold text-selva-900 tabular-nums">
              {hour(d.draw_at)}
              {d.is_extraordinary && ' ⭐'}
            </div>
            {isLatest && <span className="absolute -top-2 right-1 rounded-full bg-oro-500 px-1.5 text-[9px] font-extrabold text-selva-950">ÚLTIMO</span>}
            {r ? (
              <>
                <div className={`mt-1 text-4xl leading-none ${r.official ? '' : 'opacity-70'}`}><SymbolArt emoji={r.emoji} number={r.number} numbers={r.numbers} star={r.star} /></div>
                {r.emoji && <div className="mt-1 text-lg leading-none font-extrabold text-selva-900 tabular-nums">{r.number}</div>}
                <div className="line-clamp-1 w-full text-[11px] text-black/60">{symbolName(r.number, r.name)}</div>
                {!r.official && <div className="mt-0.5 text-[9px] font-semibold text-orange-700">preliminar</div>}
              </>
            ) : (
              <div className="flex flex-1 flex-col items-center justify-center">
                <div className={`text-2xl ${d.status === 'CANCELLED' ? '' : 'opacity-30'}`}>{d.status === 'CANCELLED' ? '🚫' : '···'}</div>
                <div className={`text-[11px] ${isNext ? 'font-semibold text-selva-700' : 'text-black/45'}`}>{isNext ? 'Próximo' : statusText(d)}</div>
              </div>
            )}
            {d.incident_notice && <div className="mt-0.5 text-[9px] text-amber-700">⚠ aviso</div>}
          </button>
        );
      })}
    </div>
  );
}

function statusText(d: Draw) {
  switch (d.status) {
    case 'OPEN':
      return 'En venta';
    case 'CANCELLED':
      return 'Anulado';
    case 'CLOSED':
    case 'RESULT_PENDING':
      return 'Por publicar';
    default:
      return 'En espera';
  }
}

/** Franja compacta para la pantalla de juego: últimos resultados de hoy y ayer, el más reciente primero. */
export function RecentStrip({ game }: { game: Game }) {
  const { todayDraws, yesterdayDraws, latest } = useRecentDraws(game);
  const withResult = [...(yesterdayDraws.data ?? []), ...(todayDraws.data ?? [])].filter((d) => shownResult(d)).reverse().slice(0, 14);
  if (withResult.length === 0) return null;
  const today = todayCaracas();
  return (
    <section className="card p-4 sm:p-5">
      <div className="mb-3 flex items-center justify-between px-1">
        <h2 className="title-display text-2xl text-selva-900 sm:text-[1.7rem]">Últimos resultados</h2>
        <Link to="/resultados" className="rounded-lg px-2 py-1 text-sm font-semibold text-lima-600 hover:bg-lima-500/10">
          Ver todos →
        </Link>
      </div>
      <div className="no-scrollbar -mx-4 -my-1 flex gap-2 overflow-x-auto px-4 py-1 sm:-mx-5 sm:gap-2.5 sm:px-5">
        {withResult.map((d) => {
          const r = shownResult(d)!;
          const isToday = todayCaracas(new Date(d.draw_at)) === today;
          const last = d.id === latest?.id;
          return (
            <div
              key={d.id}
              className={`relative flex ${r.numbers ? 'w-[8.5rem] px-1.5' : 'w-[5.5rem]'} shrink-0 flex-col items-center rounded-2xl py-2.5 ring-1 ${
                last ? 'bg-gradient-to-b from-[#0f3d2a] to-[#0a2a1c] text-white ring-2 ring-lima-500' : 'bg-selva-900/[0.03] ring-black/5'
              }`}
            >
              <div className={`text-xs font-semibold tabular-nums ${last ? 'text-lima-400' : 'text-black/50'}`}>{hour(d.draw_at).replace(':00', '')}</div>
              <div className="my-0.5 text-[2.1rem] leading-tight"><SymbolArt emoji={r.emoji} number={r.number} numbers={r.numbers} star={r.star} /></div>
              {r.emoji && <div className={`text-base font-extrabold tabular-nums ${last ? 'text-oro-300' : 'text-selva-900'}`}>{r.number}</div>}
              <div className={`text-[11px] ${last ? 'text-white/60' : 'text-black/40'}`}>{isToday ? 'hoy' : 'ayer'}</div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
