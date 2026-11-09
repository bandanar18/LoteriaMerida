import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { longDate } from '../../components/ResultsBoard';
import { Empty, ErrorBox, Notice, PageTitle, Spinner, StatusBadge } from '../../components/ui';
import { get } from '../../lib/api';
import { Currency, DRAW_STATUS_LABEL, hour, money, toMinor, todayCaracas } from '../../lib/format';
import { symbolWords, useGames } from '../../lib/queries';

interface RiskDraw {
  id: string;
  draw_at: string;
  status: string;
  is_extraordinary: boolean;
  sold: string;
  expected_ggr: string;
  worst_case: string;
  best_case: string;
  loss_probability: number;
  max_cap_use: number;
  top: { number: string; name: string; emoji: string; sold: string; payout: string }[];
  result: { number: string; name: string; emoji: string } | null;
  paid: string | null;
  ggr: string | null;
}

interface RiskDay {
  game: { id: string; code: string; name: string; symbols: number; factor_x100: string; cap: string; player_cap: string | null };
  date: string;
  model: { rtp: number; house_edge: number };
  summary: {
    sold: string;
    realized_ggr: string;
    expected_ggr: string;
    projected_ggr: string;
    projected_low: string;
    projected_high: string;
    worst_case: string;
    loss_probability: number;
    draws: number;
    settled: number;
    hot: number;
  };
  draws: RiskDraw[];
}

interface HistoryRow {
  date: string;
  sold: string;
  paid: string;
  ggr: string;
  expected_ggr: string;
  settled_draws: number;
}

const pct = (x: number, digits = 1) => `${(x * 100).toLocaleString('es-VE', { maximumFractionDigits: digits, minimumFractionDigits: digits })} %`;
const signed = (v: string | bigint, c: Currency) => {
  const b = BigInt(v);
  return `${b > 0n ? '+' : ''}${money(b, c)}`;
};
const tone = (v: string | bigint) => (BigInt(v) < 0n ? 'text-red-700' : 'text-selva-800');

/**
 * Riesgo y rentabilidad: control previo del negocio con el modelo 1/N.
 * No anticipa ni influye en resultados: muestra cuánto se puede ganar o perder según lo vendido.
 */
export function RiskPage() {
  const games = useGames();
  const [gameId, setGameId] = useState<string>();
  const [currency, setCurrency] = useState<Currency>('VES');
  const [date, setDate] = useState(todayCaracas());
  const game = games.data?.find((g) => g.id === gameId) ?? games.data?.[0];
  const w = symbolWords(game);
  const risk = useQuery({
    queryKey: ['admin', 'risk', game?.id, currency, date],
    enabled: !!game,
    refetchInterval: 30_000,
    queryFn: () => get<RiskDay>(`/admin/lottery/games/${game!.id}/risk?currency=${currency}&date=${date}`),
  });
  const history = useQuery({
    queryKey: ['admin', 'risk-history', game?.id, currency],
    enabled: !!game,
    refetchInterval: 120_000,
    queryFn: () => get<HistoryRow[]>(`/admin/lottery/games/${game!.id}/risk/history?currency=${currency}`),
  });

  if (games.isLoading) return <Spinner />;
  if (!game) return <Empty>No hay juegos.</Empty>;
  const r = risk.data;

  return (
    <div className="space-y-4">
      <PageTitle>Riesgo y rentabilidad</PageTitle>

      <div className="flex flex-wrap items-center gap-2">
        <div className={`no-scrollbar -mx-4 flex max-w-full gap-2 overflow-x-auto px-4 sm:mx-0 sm:px-0 ${games.data!.length < 2 ? 'hidden' : ''}`}>
          {games.data!.map((g) => (
            <button
              key={g.id}
              onClick={() => setGameId(g.id)}
              className={`btn shrink-0 ${g.id === game.id ? 'bg-selva-800 text-white' : 'bg-white text-selva-900 ring-1 ring-black/10'}`}
            >
              {g.name}
            </button>
          ))}
        </div>
        <div className="flex rounded-xl bg-black/5 p-1">
          {(['VES', 'USDT'] as Currency[]).map((c) => (
            <button key={c} onClick={() => setCurrency(c)} className={`rounded-lg px-3 py-1.5 text-sm font-semibold ${currency === c ? 'bg-white shadow-sm' : 'text-black/60'}`}>
              {c === 'VES' ? 'Bs.' : 'USDT'}
            </button>
          ))}
        </div>
        <input type="date" className="input w-auto" value={date} max={todayCaracas()} onChange={(e) => e.target.value && setDate(e.target.value)} aria-label="Fecha" />
      </div>

      {risk.error ? (
        <ErrorBox error={risk.error} />
      ) : risk.isLoading || !r ? (
        <Spinner />
      ) : (
        <>
          <p className="text-xs text-black/55">
            <b className="first-letter:uppercase">{longDate(r.date)}</b> · Modelo: {w.every} tiene 1 en {r.game.symbols} en cada sorteo, sin importar lo vendido.
            Pago {Number(r.game.factor_x100) / 100}× → retorno al público {pct(r.model.rtp)}, margen esperado <b>{pct(r.model.house_edge)}</b>. Este tablero
            mide el riesgo de lo vendido; no anticipa resultados.
          </p>

          <div className="grid grid-cols-2 gap-2 sm:gap-3 lg:grid-cols-5">
            <Tile label="Vendido" value={money(r.summary.sold, currency)} sub={`${r.summary.draws} sorteos`} />
            <Tile
              label="Ganancia proyectada del día"
              value={signed(r.summary.projected_ggr, currency)}
              valueClass={tone(r.summary.projected_ggr)}
              sub={`90 %: ${signed(r.summary.projected_low, currency)} a ${signed(r.summary.projected_high, currency)}`}
            />
            <Tile
              label="Probabilidad de cerrar el día en pérdida"
              value={pct(r.summary.loss_probability)}
              valueClass={r.summary.loss_probability >= 0.25 ? 'text-red-700' : 'text-selva-800'}
              sub="con lo vendido hasta ahora"
            />
            <Tile label="Peor caso del día" value={signed(r.summary.worst_case, currency)} valueClass={tone(r.summary.worst_case)} sub="si en cada sorteo pendiente sale la jugada más cargada" />
            <Tile
              label="Ganancia real (liquidados)"
              value={signed(r.summary.realized_ggr, currency)}
              valueClass={tone(r.summary.realized_ggr)}
              sub={`${r.summary.settled} de ${r.summary.draws} sorteos`}
            />
          </div>

          {r.summary.hot > 0 && (
            <Notice tone="warn">
              ⚠ {r.summary.hot} sorteo(s) con algún/a {w.one} sobre el 80 % del tope de pago. Al llegar al 100 % deja de venderse.
            </Notice>
          )}

          <section>
            <h2 className="mb-2 font-semibold text-selva-900">Sorteo por sorteo</h2>
            {r.draws.length === 0 ? (
              <Empty>No hay sorteos ese día.</Empty>
            ) : (
              <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
                {r.draws.map((d) => (
                  <DrawRisk key={d.id} d={d} currency={currency} cap={r.game.cap} one={w.one} />
                ))}
              </div>
            )}
          </section>

          <CapHelper currency={currency} cap={r.game.cap} draws={r.draws} one={w.one} />
        </>
      )}

      <History rows={history.data} currency={currency} loading={history.isLoading} edge={r?.model.house_edge} />
    </div>
  );
}

function Tile({ label, value, sub, valueClass = 'text-selva-900' }: { label: string; value: string; sub?: string; valueClass?: string }) {
  return (
    <div className="card p-3 sm:p-4">
      <div className="text-[11px] leading-tight text-black/55">{label}</div>
      <div className={`mt-1 text-lg font-extrabold tabular-nums sm:text-xl ${valueClass}`}>{value}</div>
      {sub && <div className="mt-0.5 text-[11px] leading-tight text-black/45">{sub}</div>}
    </div>
  );
}

function DrawRisk({ d, currency, cap, one }: { d: RiskDraw; currency: Currency; cap: string; one: string }) {
  const settled = d.status === 'SETTLED';
  const noSales = d.sold === '0';
  const use = Math.min(d.max_cap_use, 100);
  return (
    <div className={`card p-3 ${d.max_cap_use >= 80 && !settled ? 'ring-2 ring-oro-400' : ''}`}>
      <div className="flex items-center justify-between gap-2">
        <div className="font-bold text-selva-900 tabular-nums">
          {hour(d.draw_at)} {d.is_extraordinary && '⭐'}
        </div>
        <StatusBadge status={d.status} label={DRAW_STATUS_LABEL[d.status]} />
      </div>

      {noSales ? (
        <p className="mt-2 text-xs text-black/45">Sin ventas en {currency}.</p>
      ) : (
        <>
          <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
            <dt className="text-black/50">Vendido</dt>
            <dd className="text-right font-semibold tabular-nums">{money(d.sold, currency)}</dd>
            {settled ? (
              <>
                <dt className="text-black/50">Pagado</dt>
                <dd className="text-right tabular-nums">{money(d.paid, currency)}</dd>
                <dt className="text-black/50">Ganancia real</dt>
                <dd className={`text-right font-bold tabular-nums ${tone(d.ggr!)}`}>{signed(d.ggr!, currency)}</dd>
              </>
            ) : (
              <>
                <dt className="text-black/50">Ganancia esperada</dt>
                <dd className={`text-right font-semibold tabular-nums ${tone(d.expected_ggr)}`}>{signed(d.expected_ggr, currency)}</dd>
                <dt className="text-black/50">Peor caso</dt>
                <dd className={`text-right tabular-nums ${tone(d.worst_case)}`}>{signed(d.worst_case, currency)}</dd>
                <dt className="text-black/50">Prob. de pérdida</dt>
                <dd className="text-right tabular-nums">{pct(d.loss_probability)}</dd>
              </>
            )}
          </dl>
          {!settled && (
            <div className="mt-2" title={`La jugada más cargada usa ${pct(use / 100)} del tope de pago (${money(cap, currency)})`}>
              <div className="flex justify-between text-[10px] text-black/45">
                <span>Uso del tope por {one}</span>
                <span className="tabular-nums">{pct(use / 100)}</span>
              </div>
              <div className="mt-0.5 h-1.5 rounded-full bg-black/5">
                <div className={`h-1.5 rounded-full ${use >= 80 ? 'bg-red-500' : 'bg-selva-600'}`} style={{ width: `${Math.max(use, 1)}%` }} />
              </div>
            </div>
          )}
          {!settled && d.top.length > 0 && (
            <div className="mt-2 border-t border-black/5 pt-2">
              <div className="mb-1 text-[10px] font-semibold tracking-wide text-black/45 uppercase">Más cargados (pago si sale)</div>
              <ul className="space-y-0.5 text-xs">
                {d.top.map((t) => (
                  <li key={t.number} className="flex items-center gap-1.5">
                    <span>{t.emoji}</span>
                    <span className="min-w-0 flex-1 truncate">
                      {t.number} {t.name}
                    </span>
                    <span className="tabular-nums text-black/55">{money(t.payout, currency)}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
      {d.result && (
        <div className="mt-2 flex items-center gap-1.5 border-t border-black/5 pt-2 text-xs text-black/60">
          Salió <span className="text-base">{d.result.emoji}</span>
          <b>
            {d.result.number} {d.result.name}
          </b>
        </div>
      )}
    </div>
  );
}

/** Tope sugerido: para no perder más de X en un sorteo, el pago máximo por animal ≈ X + lo que suele venderse por sorteo. */
function CapHelper({ currency, cap, draws, one }: { currency: Currency; cap: string; draws: RiskDraw[]; one: string }) {
  const [maxLoss, setMaxLoss] = useState('');
  const withSales = draws.filter((d) => d.sold !== '0' && d.status !== 'CANCELLED');
  const avgSold = withSales.length ? withSales.reduce((a, d) => a + BigInt(d.sold), 0n) / BigInt(withSales.length) : 0n;
  const loss = toMinor(maxLoss, currency);
  return (
    <section className="card p-4">
      <h2 className="font-semibold text-selva-900">¿Cuánto quieres arriesgar por sorteo?</h2>
      <p className="mt-1 text-xs text-black/55">
        Tope actual de pago por {one}: <b>{money(cap, currency)}</b>. En un sorteo sale un solo resultado, así que la pérdida máxima es ese tope menos lo vendido.
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <input
          className="input w-40 text-right tabular-nums"
          inputMode="decimal"
          placeholder="Pérdida máxima"
          value={maxLoss}
          onChange={(e) => setMaxLoss(e.target.value)}
          aria-label="Pérdida máxima aceptada por sorteo"
        />
        <span className="text-sm text-black/60">{currency}</span>
      </div>
      {loss !== null && loss > 0n && (
        <p className="mt-2 text-sm">
          Tope sugerido por {one}: <b className="tabular-nums">{money(loss + avgSold, currency)}</b>
          <span className="text-black/50"> (= pérdida máxima + venta promedio por sorteo hoy, {money(avgSold, currency)}).</span>
        </p>
      )}
    </section>
  );
}

function History({ rows, currency, loading, edge }: { rows?: HistoryRow[]; currency: Currency; loading: boolean; edge?: number }) {
  if (loading) return <Spinner />;
  const data = (rows ?? []).filter((r) => r.sold !== '0');
  return (
    <section className="card p-4">
      <h2 className="font-semibold text-selva-900">Margen real frente al esperado · últimos 14 días</h2>
      <p className="mt-1 text-xs text-black/55">
        Solo sorteos liquidados. Con pocos sorteos el margen real varía mucho; con volumen se acerca al esperado{edge !== undefined ? ` (${pct(edge)})` : ''}. La barra
        es el margen real del día y la línea vertical, el esperado.
      </p>
      {data.length === 0 ? (
        <p className="mt-3 text-sm text-black/45">Aún no hay sorteos liquidados con ventas en {currency}.</p>
      ) : (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[34rem] text-sm">
            <thead>
              <tr className="text-left text-xs text-black/50">
                <th className="py-1 font-medium">Día</th>
                <th className="py-1 text-right font-medium">Vendido</th>
                <th className="py-1 text-right font-medium">Pagado</th>
                <th className="py-1 text-right font-medium">Ganancia</th>
                <th className="w-40 py-1 pl-3 font-medium">Margen</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-black/5">
              {data.map((r) => {
                const sold = Number(r.sold);
                const real = sold ? Number(r.ggr) / sold : 0;
                const expected = sold ? Number(r.expected_ggr) / sold : 0;
                const scale = (v: number) => `${Math.min(Math.max(v, 0), 1) * 100}%`;
                return (
                  <tr key={r.date} title={`Margen real ${pct(real)} · esperado ${pct(expected)} · ${r.settled_draws} sorteos`}>
                    <td className="py-1.5 tabular-nums">{r.date.slice(5).split('-').reverse().join('/')}</td>
                    <td className="py-1.5 text-right tabular-nums">{money(r.sold, currency)}</td>
                    <td className="py-1.5 text-right tabular-nums">{money(r.paid, currency)}</td>
                    <td className={`py-1.5 text-right font-semibold tabular-nums ${tone(r.ggr)}`}>{signed(r.ggr, currency)}</td>
                    <td className="py-1.5 pl-3">
                      <div className="flex items-center gap-2">
                        <div className="relative h-2 flex-1 rounded-full bg-black/5">
                          <div className={`h-2 rounded-full ${real < 0 ? 'bg-red-500' : 'bg-selva-600'}`} style={{ width: real < 0 ? '4px' : scale(real) }} />
                          <div className="absolute -top-1 h-4 w-0.5 bg-black/60" style={{ left: scale(expected) }} />
                        </div>
                        <span className={`w-14 text-right text-xs tabular-nums ${real < 0 ? 'text-red-700' : 'text-black/60'}`}>{pct(real, 0)}</span>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
