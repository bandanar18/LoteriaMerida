import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ErrorBox, Modal, Notice, Spinner } from '../components/ui';
import { post } from '../lib/api';
import { Currency, money } from '../lib/format';
import { Draw, Game, useBalances, useGames, useSimulationStatus } from '../lib/queries';
import { GameBoard } from './Play';
import { NumberBalls, SymbolArt, symbolName } from '../components/SymbolArt';
import { playedLabel } from '../lib/queries';

const TOPUPS: Record<Currency, string[]> = { VES: ['100', '500', '1000', '5000'], USDT: ['5', '25', '100'] };

interface RunResult {
  drawId: string;
  result: { id: string; number: string; name: string; emoji: string; numbers?: number[] | null };
  won: boolean;
  staked: Record<string, string>;
  won_amount: Record<string, string>;
  plays: { id: string; ticket_code: string; currency: Currency; number: string; name: string; emoji: string; modality: string; modality_name: string; selection?: number[] | null; amount: string; win: string; status: string }[];
  serverSeed: string;
  seedHash: string;
}

/**
 * Simulador: recarga saldo de prueba, juega en un sorteo privado y lo sortea al instante.
 * El animal ganador sale del mismo RNG provably fair que los sorteos reales; no depende de lo apostado.
 */
export function SimulatorPage() {
  const status = useSimulationStatus();
  const games = useGames();
  const demoGames = (games.data ?? []).filter((g) => g.is_demo);
  const [gameId, setGameId] = useState<string>();
  const game = demoGames.find((g) => g.id === gameId) ?? demoGames[0];

  if (status.isLoading || games.isLoading) return <Spinner />;
  if (!status.data?.enabled) return <Notice>El simulador no está disponible en este entorno.</Notice>;
  if (!game) return <Notice>No hay juegos en modo demo para simular.</Notice>;

  return (
    <div className="space-y-3">
      <div className="rounded-2xl bg-gradient-to-r from-violet-700 to-fuchsia-600 px-4 py-3 text-white">
        <div className="text-lg font-extrabold">🎮 Simulador</div>
        <p className="text-xs text-white/85">
          Recarga saldo de prueba, arma tu ticket y toca <b>Sortear</b> para ver al instante si ganaste. El resultado sale al azar, igual que en un
          sorteo real.
        </p>
      </div>
      {demoGames.length > 1 && (
        <div className="no-scrollbar -mx-4 flex snap-x gap-2 overflow-x-auto px-4">
          {demoGames.map((g) => (
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
      <Topup />
      <SimGame key={game.id} game={game} />
    </div>
  );
}

function Topup() {
  const qc = useQueryClient();
  const balances = useBalances(true);
  const [currency, setCurrency] = useState<Currency>('VES');
  const [done, setDone] = useState<string | null>(null);
  const topup = useMutation({
    mutationFn: (amount: string) => post('/simulation/topup', { currency, amount }, { 'idempotency-key': crypto.randomUUID() }),
    onSuccess: (r: any) => {
      setDone(`+${money(r.amount, currency)} de prueba`);
      qc.invalidateQueries({ queryKey: ['balances'] });
    },
  });
  const cash = balances.data?.find((b) => b.currency === currency)?.cash ?? '0';

  return (
    <section className="card p-4">
      <div className="flex items-center justify-between gap-2">
        <div>
          <div className="text-xs text-black/50">Tu saldo</div>
          <div className="text-2xl font-extrabold tabular-nums text-selva-900">{money(cash, currency)}</div>
        </div>
        <div className="flex rounded-xl bg-black/5 p-1">
          {(['VES', 'USDT'] as Currency[]).map((c) => (
            <button
              key={c}
              onClick={() => setCurrency(c)}
              className={`rounded-lg px-3 py-1.5 text-sm font-semibold ${currency === c ? 'bg-white shadow-sm' : 'text-black/60'}`}
            >
              {c === 'VES' ? 'Bs.' : 'USDT'}
            </button>
          ))}
        </div>
      </div>
      <div className="mt-3 text-sm font-semibold text-selva-900">Recargar saldo de prueba</div>
      <div className={`mt-2 grid gap-1.5 ${TOPUPS[currency].length === 4 ? 'grid-cols-4' : 'grid-cols-3'}`}>
        {TOPUPS[currency].map((a) => (
          <button
            key={a}
            disabled={topup.isPending}
            onClick={() => {
              setDone(null);
              topup.mutate(a);
            }}
            className="rounded-xl bg-white py-2.5 text-sm font-semibold tabular-nums ring-1 ring-black/10 active:scale-95 disabled:opacity-50"
          >
            +{a}
          </button>
        ))}
      </div>
      {done && <p className="mt-2 text-xs font-medium text-selva-700">✔ {done}</p>}
      <ErrorBox error={topup.error} />
    </section>
  );
}

function SimGame({ game }: { game: Game }) {
  const qc = useQueryClient();
  const drawQ = useQuery({
    queryKey: ['sim-draw', game.id],
    queryFn: () => post<Draw>(`/simulation/games/${game.id}/draw`),
    staleTime: Infinity,
  });
  const [bought, setBought] = useState(0);
  const [lastTicket, setLastTicket] = useState<string | null>(null);
  const [rolling, setRolling] = useState(false);
  const [result, setResult] = useState<RunResult | null>(null);

  const run = useMutation({
    mutationFn: async (drawId: string) => {
      setRolling(true);
      // Pausa mínima para que se vea el sorteo; el resultado ya lo decide el servidor.
      const [r] = await Promise.all([post<RunResult>(`/simulation/draws/${drawId}/run`), new Promise((res) => setTimeout(res, 1800))]);
      return r;
    },
    onSuccess: (r) => {
      setResult(r);
      setBought(0);
      setLastTicket(null);
      qc.invalidateQueries({ queryKey: ['balances'] });
      qc.invalidateQueries({ queryKey: ['tickets'] });
    },
    onSettled: () => setRolling(false),
  });

  function playAgain() {
    setResult(null);
    run.reset();
    qc.invalidateQueries({ queryKey: ['sim-draw', game.id] });
  }

  if (drawQ.isLoading) return <Spinner />;
  if (drawQ.error || !drawQ.data) return <ErrorBox error={drawQ.error} />;
  const draw: Draw = { ...drawQ.data, sim: true };

  return (
    <>
      <GameBoard
        key={draw.id}
        game={game}
        sim={{
          draw,
          onBought: (t) => {
            setBought((n) => n + t.plays.length);
            setLastTicket(t.code);
          },
          action:
            bought > 0 ? (
              <div>
                {lastTicket && (
                  <p className="mb-1 truncate text-center text-[11px] text-black/50">
                    Ticket {lastTicket} · {bought} jugada(s) en juego
                  </p>
                )}
                <button
                  className="w-full rounded-2xl bg-gradient-to-r from-violet-700 to-fuchsia-600 py-3.5 text-base font-extrabold text-white shadow-lg active:scale-[0.98] disabled:opacity-60"
                  disabled={run.isPending}
                  onClick={() => run.mutate(draw.id)}
                >
                  🎲 Sortear y ver si gané
                </button>
                <ErrorBox error={run.error} />
              </div>
            ) : undefined,
        }}
      />

      <Modal open={rolling || !!result} onClose={() => (rolling ? undefined : playAgain())} title={rolling ? 'Sorteando…' : 'Resultado'}>
        {rolling ? <Rolling symbols={game.symbols.map((s) => s.emoji || s.number)} /> : result && <ResultView r={result} onAgain={playAgain} />}
      </Modal>
    </>
  );
}

function Rolling({ symbols }: { symbols: string[] }) {
  const [i, setI] = useState(0);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => {
    timer.current = window.setInterval(() => setI((x) => (x + 1) % symbols.length), 90);
    return () => window.clearInterval(timer.current);
  }, [symbols.length]);
  return (
    <div className="flex flex-col items-center py-8">
      <div className="text-7xl">{symbols[i]}</div>
      <p className="mt-4 text-sm text-black/50">Girando la tómbola…</p>
    </div>
  );
}

function ResultView({ r, onAgain }: { r: RunResult; onAgain: () => void }) {
  const currencies = Object.keys(r.staked) as Currency[];
  return (
    <div className="space-y-4">
      <div className="text-center">
        <div className="text-xs font-semibold tracking-wide text-black/50 uppercase">Salió</div>
        <div className="text-7xl">{r.result.numbers ? <NumberBalls numbers={r.result.numbers} size="md" /> : <SymbolArt emoji={r.result.emoji} number={r.result.number} />}</div>
        <div className="text-xl font-extrabold text-selva-900">
          {r.result.numbers ? 'Números extraídos' : <>{r.result.number} {symbolName(r.result.number, r.result.name)}</>}
        </div>
      </div>
      <div className={`rounded-2xl p-4 text-center ${r.won ? 'bg-emerald-50 text-emerald-800' : 'bg-black/[0.04] text-black/70'}`}>
        {r.won ? (
          <>
            <div className="text-2xl font-extrabold">🎉 ¡Ganaste!</div>
            {currencies.map((c) => (
              <div key={c} className="text-lg font-bold tabular-nums">
                +{money(r.won_amount[c], c)}
              </div>
            ))}
          </>
        ) : (
          <>
            <div className="text-xl font-extrabold">No ganaste esta vez</div>
            <div className="text-sm">
              Jugaste {currencies.map((c) => money(r.staked[c], c)).join(' + ')}
            </div>
          </>
        )}
      </div>
      <ul className="divide-y divide-black/5 text-sm">
        {r.plays.map((p) => (
          <li key={p.id} className="flex items-center gap-2 py-2">
            {p.selection ? <NumberBalls numbers={p.selection} hits={r.result.numbers} /> : <SymbolArt className="text-2xl" emoji={p.emoji} number={playedLabel(p.modality, p.number)} />}
            <span className="min-w-0 flex-1 truncate">
              {p.emoji ? <>{p.number} {p.name}</> : <>{p.modality_name} {playedLabel(p.modality, p.number)}</>}
            </span>
            <span className="tabular-nums text-black/50">{money(p.amount, p.currency)}</span>
            <span className={`w-24 text-right font-semibold tabular-nums ${p.status === 'WON' ? 'text-emerald-700' : 'text-black/35'}`}>
              {p.status === 'WON' ? `+${money(p.win, p.currency)}` : 'Perdió'}
            </span>
          </li>
        ))}
      </ul>
      <details className="text-[11px] text-black/45">
        <summary className="cursor-pointer">Verificar sorteo</summary>
        <div className="mt-1 break-all font-mono">
          Compromiso (antes de jugar): {r.seedHash}
          <br />
          Semilla revelada: {r.serverSeed}
        </div>
      </details>
      <div className="grid gap-2">
        <button className="btn-gold w-full py-3 text-base" onClick={onAgain}>
          Jugar el siguiente sorteo
        </button>
        <Link to="/tickets" className="btn-ghost w-full">
          Ver mis jugadas
        </Link>
      </div>
    </div>
  );
}
