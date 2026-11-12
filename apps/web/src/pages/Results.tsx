import { useQuery } from '@tanstack/react-query';
import { ReactNode, useState } from 'react';
import { DayGrid, LatestAndNext, longDate, shiftDate, useRecentDraws } from '../components/ResultsBoard';
import { Empty, ErrorBox, Modal, PageTitle, Spinner } from '../components/ui';
import { get } from '../lib/api';
import { todayCaracas } from '../lib/format';
import { Draw, symbolWords, useDraws, useGames } from '../lib/queries';

export function ResultsPage() {
  const games = useGames();
  const [gameId, setGameId] = useState<string>();
  const [verifyId, setVerifyId] = useState<string | null>(null);
  const game = games.data?.find((g) => g.id === gameId) ?? games.data?.[0];
  const recent = useRecentDraws(game);
  // Mañana: solo los sorteos extraordinarios ya programados (los del calendario se ven en Jugar).
  const tomorrowExtra = recent.tomorrowDraws.data?.filter((d) => d.is_extraordinary) ?? [];
  const [otherDate, setOtherDate] = useState(() => shiftDate(todayCaracas(), -2));
  const other = useDraws(game?.id, otherDate);

  if (games.isLoading) return <Spinner />;
  if (!game) return <Empty>No hay juegos disponibles.</Empty>;

  return (
    <div className="space-y-4">
      <PageTitle>Resultados</PageTitle>
      {games.data!.length > 1 && (
        <div className="no-scrollbar -mx-4 flex snap-x gap-2 overflow-x-auto px-4">
          {games.data!.map((g) => (
            <button
              key={g.id}
              onClick={() => setGameId(g.id)}
              className={`btn shrink-0 snap-start ${g.id === game.id ? 'bg-selva-800 text-white' : 'bg-white text-selva-900 ring-1 ring-black/10'}`}
            >
              {g.name}
            </button>
          ))}
        </div>
      )}

      <LatestAndNext latest={recent.latest} next={recent.next} now={recent.now} />

      <Day title="Hoy" date={recent.today} draws={recent.todayDraws.data} loading={recent.todayDraws.isLoading} latestId={recent.latest?.id} nextId={recent.next?.id} onVerify={setVerifyId} />
      {tomorrowExtra.length > 0 && (
        <Day title="Mañana" date={recent.tomorrow} draws={tomorrowExtra} nextId={recent.next?.id} onVerify={setVerifyId} />
      )}
      <Day title="Ayer" date={recent.yesterday} draws={recent.yesterdayDraws.data} loading={recent.yesterdayDraws.isLoading} latestId={recent.latest?.id} onVerify={setVerifyId} />

      <section>
        <div className="mb-2 flex items-center justify-between gap-2">
          <h2 className="font-semibold text-(--ink)">Otra fecha</h2>
          <div className="flex items-center gap-1">
            <button className="btn-ghost px-3" aria-label="Día anterior" onClick={() => setOtherDate(shiftDate(otherDate, -1))}>
              ‹
            </button>
            <input
              type="date"
              className="input w-auto"
              value={otherDate}
              max={todayCaracas()}
              onChange={(e) => e.target.value && setOtherDate(e.target.value)}
              aria-label="Fecha"
            />
            <button
              className="btn-ghost px-3"
              aria-label="Día siguiente"
              disabled={otherDate >= todayCaracas()}
              onClick={() => setOtherDate(shiftDate(otherDate, 1))}
            >
              ›
            </button>
          </div>
        </div>
        <p className="mb-2 text-xs text-(--muted) first-letter:uppercase">{longDate(otherDate)}</p>
        {other.isLoading ? <Spinner /> : !other.data?.length ? <Empty>No hay sorteos para esta fecha.</Empty> : <DayGrid draws={other.data} onVerify={setVerifyId} />}
      </section>

      <p className="text-xs text-(--muted)">
        Toca un resultado para verificarlo. Los resultados anteriores no influyen en los sorteos futuros:{' '}
        {game.board === 'COLOR' ? (
          <>cada número con su color tiene siempre 1 en 400 de probabilidad; un número, 1 en 100; un color, 1 en 4.</>
        ) : (
          <>
            {symbolWords(game).every} tiene siempre {game.draw_count > 1 ? game.draw_count : 1} en {game.symbol_count ?? game.symbols.length} de probabilidad
            {game.draw_count > 1 ? ` (salen ${game.draw_count} por sorteo)` : ''}.
          </>
        )}
      </p>
      <Modal open={!!verifyId} onClose={() => setVerifyId(null)} title="Verificación del sorteo">
        {verifyId && <Verify drawId={verifyId} />}
      </Modal>
    </div>
  );
}

function Day(props: {
  title: ReactNode;
  date: string;
  draws?: Draw[];
  loading?: boolean;
  latestId?: string;
  nextId?: string;
  onVerify: (id: string) => void;
}) {
  const draws = props.draws ?? [];
  const done = draws.filter((d) => d.result_number || d.preliminary_number).length;
  return (
    <section>
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <h2 className="font-semibold text-(--ink)">
          {props.title} <span className="text-sm font-normal text-(--muted)">· {longDate(props.date)}</span>
        </h2>
        {draws.length > 0 && (
          <span className="shrink-0 text-xs text-(--muted) tabular-nums">
            {done}/{draws.length} sorteos
          </span>
        )}
      </div>
      {props.loading ? (
        <Spinner />
      ) : draws.length === 0 ? (
        <Empty>No hay sorteos para esta fecha.</Empty>
      ) : (
        <DayGrid draws={draws} latestId={props.latestId} nextId={props.nextId} onVerify={props.onVerify} />
      )}
    </section>
  );
}

function Verify({ drawId }: { drawId: string }) {
  const v = useQuery({
    queryKey: ['verify', drawId],
    queryFn: () => get(`/lottery/draws/${drawId}/verify`),
    refetchInterval: (q) => q.state.data?.revealed ? false : 15_000,
  });
  if (v.error) return <ErrorBox error={v.error} />;
  if (!v.data) return <Spinner />;
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
              <p className="text-xs text-black/50">Resultado oficial confirmado con doble verificación.</p>
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
