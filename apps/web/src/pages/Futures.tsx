import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ReactNode, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ErrorBox, Modal, Notice, Spinner } from '../components/ui';
import { del, get, post, put } from '../lib/api';
import { useAuth } from '../lib/auth';
import { dateTime, hour } from '../lib/format';

/**
 * Cumbre Futuros (MER-06): perpetuos BTC/ETH/SOL con margen en USDT.
 * Mismo flujo que un exchange: contrato → gráfico → orden (con margen, comisión y liquidación a la vista) → posiciones.
 */

interface Bracket {
  floor: string;
  cap: string;
  max_leverage: number;
  mmr: number;
  cum: string;
}
interface Contract {
  symbol: string;
  base: string;
  name: string;
  status: 'ACTIVE' | 'CLOSE_ONLY' | 'PAUSED';
  status_reason: string | null;
  feed_ok: boolean;
  sources: Record<string, string>;
  index_price: string | null;
  mark_price: string | null;
  change_24h: number | null;
  high_24h: string | null;
  low_24h: string | null;
  funding_rate: string;
  next_funding_time: string;
  qty_step: string;
  price_tick: string;
  min_notional: string;
  max_leverage: number;
  default_leverage: number;
  taker_fee: number;
  maker_fee: number;
  liquidation_fee: number;
  brackets: Bracket[];
}
interface Position {
  id: string;
  symbol: string;
  side: 'LONG' | 'SHORT';
  qty: string;
  entry_price: string;
  mark_price: string;
  liquidation_price: string | null;
  margin: string;
  initial_margin: string;
  maintenance_margin: string;
  margin_ratio: number;
  notional: string;
  leverage: number;
  margin_mode: 'ISOLATED' | 'CROSS';
  unrealized_pnl: string;
  roe: number;
  tp_price: string | null;
  sl_price: string | null;
  realized_pnl: string;
  fees_paid: string;
  funding_paid: string;
  status: string;
  opened_at: string;
  closed_at: string | null;
  close_price: string | null;
}
interface Account {
  wallet: string;
  margin: string;
  available: string;
  unrealized_pnl: string;
  equity: string;
  cash_usdt: string;
  kyc_level: number;
  risk_accepted: boolean;
  settings: { max_leverage: number | null; daily_loss_limit: string | null; daily_transfer_limit: string | null } | null;
  today_loss: string;
  prefs: { symbol: string; leverage: number; margin_mode: 'ISOLATED' | 'CROSS' }[];
  positions: Position[];
}

const ICON: Record<string, string> = { BTC: '₿', ETH: 'Ξ', SOL: '◎' };
const dec = (step: string) => (step.includes('.') ? step.split('.')[1].replace(/0+$/, '').length : 0);
const nf = (v: number | string | null | undefined, d = 2) =>
  v === null || v === undefined || v === '' || Number.isNaN(Number(v))
    ? '—'
    : Number(v).toLocaleString('es-VE', { minimumFractionDigits: d, maximumFractionDigits: d });
const usd = (v: number | string | null | undefined) => `${nf(v, 2)} USDT`;
const signCls = (v: number) => (v > 0 ? 'text-emerald-600' : v < 0 ? 'text-rose-600' : 'text-black/60');
const signed = (v: number, d = 2) => (Math.abs(v) < 0.5 * 10 ** -d ? nf(0, d) : `${v > 0 ? '+' : ''}${nf(v, d)}`);
const floorStep = (v: number, step: string) => {
  const s = Number(step);
  const d = dec(step);
  return (Math.floor(v / s + 1e-9) * s).toFixed(d);
};
const roundTick = (v: number, tick: string) => (Math.round(v / Number(tick)) * Number(tick)).toFixed(dec(tick));

function countdownTo(iso: string, now: number) {
  const s = Math.max(0, Math.floor((new Date(iso).getTime() - now) / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
}

/** Precio de liquidación estimado (aislado), igual que el servidor: long (Q·E − M − cum)/(Q(1 − MMR)); short (Q·E + M + cum)/(Q(1 + MMR)). */
function estimateLiq(c: Contract, side: 'LONG' | 'SHORT', q: number, e: number, m: number) {
  if (!q || !e) return null;
  const n = q * e;
  const b = c.brackets.find((x) => n <= Number(x.cap)) ?? c.brackets[c.brackets.length - 1];
  const mmr = b.mmr / 100;
  const cum = Number(b.cum);
  const p = side === 'LONG' ? (q * e - m - cum) / (q * (1 - mmr)) : (q * e + m + cum) / (q * (1 + mmr));
  return p > 0 ? p : null;
}

export function FuturesPage() {
  const { user } = useAuth();
  const isPlayer = user?.kind === 'PLAYER';
  const qc = useQueryClient();
  const [symbol, setSymbol] = useState('BTCUSDT');
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const contracts = useQuery({ queryKey: ['futures', 'contracts'], queryFn: () => get<Contract[]>('/futures/contracts'), refetchInterval: 2000 });
  const account = useQuery({
    queryKey: ['futures', 'account'],
    enabled: isPlayer,
    queryFn: () => get<Account>('/futures/account'),
    refetchInterval: 2000,
  });
  const c = contracts.data?.find((x) => x.symbol === symbol);
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['futures'] });
    qc.invalidateQueries({ queryKey: ['balances'] });
  };

  const [modal, setModal] = useState<null | 'transfer' | 'leverage' | 'risk' | 'limits'>(null);

  if (contracts.isLoading) return <Spinner />;
  if (contracts.error) return <ErrorBox error={contracts.error} />;
  if (!c) return <Notice>No hay contratos disponibles.</Notice>;

  const a = account.data;
  const pref = a?.prefs.find((p) => p.symbol === symbol) ?? { symbol, leverage: c.default_leverage, margin_mode: 'ISOLATED' as const };
  const pd = dec(c.price_tick);

  return (
    <div className="space-y-3 pb-4">
      <div className="rounded-2xl bg-gradient-to-r from-slate-900 to-slate-700 px-4 py-3 text-white">
        <div className="flex items-center justify-between gap-2">
          <div>
            <div className="text-lg font-extrabold">📈 Cumbre Futuros</div>
            <p className="text-xs text-white/70">Perpetuos con margen en USDT · MER-06</p>
          </div>
          {a && (
            <button className="rounded-xl bg-white/10 px-3 py-1.5 text-right text-xs leading-tight hover:bg-white/15" onClick={() => setModal('transfer')}>
              <div className="text-white/60">Futuros</div>
              <div className="font-bold tabular-nums">{usd(a.equity)}</div>
            </button>
          )}
        </div>
        <div className="mt-2 rounded-lg bg-amber-300/90 px-2 py-1 text-center text-[11px] font-bold text-amber-950">
          DEMO - SIN VALOR · Producto derivado en propuesta, sin autorización del regulador
        </div>
      </div>

      {/* Contratos */}
      <div className="no-scrollbar -mx-4 flex gap-2 overflow-x-auto px-4">
        {contracts.data!.map((k) => (
          <button
            key={k.symbol}
            onClick={() => setSymbol(k.symbol)}
            className={`min-w-[7.5rem] shrink-0 rounded-xl px-3 py-2 text-left ring-1 ${k.symbol === symbol ? 'bg-slate-900 text-white ring-slate-900' : 'bg-white ring-black/10'}`}
          >
            <div className="flex items-center gap-1 text-sm font-bold">
              <span>{ICON[k.base]}</span>
              {k.symbol}
            </div>
            <div className="text-sm tabular-nums">{nf(k.mark_price, dec(k.price_tick))}</div>
            <div className={`text-[11px] tabular-nums ${k.symbol === symbol ? '' : signCls(k.change_24h ?? 0)}`}>
              {k.change_24h === null ? '—' : `${signed(k.change_24h)} %`}
            </div>
          </button>
        ))}
      </div>

      <section className="card p-3 sm:p-4">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <div>
            <div className="text-xs text-black/50">Precio marca · {c.name}</div>
            <div className={`text-2xl font-extrabold tabular-nums ${signCls(c.change_24h ?? 0)}`}>{nf(c.mark_price, pd)}</div>
          </div>
          <dl className="grid grid-cols-3 gap-x-3 text-[11px] leading-tight">
            <div>
              <dt className="text-black/45">Funding / próximo</dt>
              <dd className={`font-semibold tabular-nums ${signCls(Number(c.funding_rate))}`}>
                {nf(Number(c.funding_rate) * 100, 4)} % · {countdownTo(c.next_funding_time, now)}
              </dd>
            </div>
            <div>
              <dt className="text-black/45">Máx. 24 h</dt>
              <dd className="font-semibold tabular-nums">{nf(c.high_24h, pd)}</dd>
            </div>
            <div>
              <dt className="text-black/45">Mín. 24 h</dt>
              <dd className="font-semibold tabular-nums">{nf(c.low_24h, pd)}</dd>
            </div>
          </dl>
        </div>
        {(!c.feed_ok || c.status !== 'ACTIVE') && (
          <div className="mt-2">
            <Notice tone="warn">
              {c.status === 'PAUSED'
                ? `Contrato en pausa: ${c.status_reason ?? 'revisión'}.`
                : c.status === 'CLOSE_ONLY'
                  ? `Solo cerrar: ${c.status_reason ?? 'no se aceptan posiciones nuevas'}.`
                  : 'Sin precio de referencia válido: solo cerrar y liquidaciones en pausa hasta que vuelva el feed.'}
            </Notice>
          </div>
        )}
        <PriceChart symbol={symbol} decimals={pd} />
        <details className="mt-1 text-[11px] text-black/45">
          <summary className="cursor-pointer">Índice: mediana de {Object.keys(c.sources).length} exchanges</summary>
          <div className="mt-1 flex flex-wrap gap-x-3">
            {Object.entries(c.sources).map(([k, v]) => (
              <span key={k} className="tabular-nums">
                {k}: {nf(v, pd)}
              </span>
            ))}
          </div>
        </details>
      </section>

      {!user ? (
        <Notice>
          <Link to="/login" className="font-semibold underline">
            Entra
          </Link>{' '}
          para operar futuros.
        </Notice>
      ) : !isPlayer ? (
        <Notice>Las cuentas de staff no pueden operar. Usa el backoffice para ver la exposición.</Notice>
      ) : !a ? (
        <Spinner />
      ) : a.kyc_level < 2 ? (
        <Notice tone="warn">
          Para operar futuros necesitas verificación de identidad nivel 2.{' '}
          <Link to="/cuenta" className="font-semibold underline">
            Verificar ahora
          </Link>
        </Notice>
      ) : !a.risk_accepted ? (
        <section className="card space-y-3 p-4">
          <h2 className="font-semibold">Antes de operar</h2>
          <p className="text-sm text-black/60">Los futuros con apalancamiento pueden hacerte perder todo el margen en minutos. Lee el aviso y responde dos preguntas.</p>
          <button className="btn-primary w-full" onClick={() => setModal('risk')}>
            Leer el aviso de riesgo
          </button>
        </section>
      ) : (
        <>
          <AccountBar a={a} onTransfer={() => setModal('transfer')} onLimits={() => setModal('limits')} />
          <OrderForm c={c} a={a} pref={pref} onLeverage={() => setModal('leverage')} onDone={refresh} />
          <Activity a={a} contracts={contracts.data!} onChange={refresh} />
        </>
      )}

      <Modal open={modal === 'transfer'} onClose={() => setModal(null)} title="Transferir USDT">
        {a && <TransferForm a={a} onDone={() => (setModal(null), refresh())} />}
      </Modal>
      <Modal open={modal === 'leverage'} onClose={() => setModal(null)} title={`Apalancamiento · ${c.symbol}`}>
        <LeverageForm c={c} pref={pref} onDone={() => (setModal(null), refresh())} />
      </Modal>
      <Modal open={modal === 'risk'} onClose={() => setModal(null)} title="Aviso de riesgo de futuros">
        <RiskForm onDone={() => (setModal(null), refresh())} />
      </Modal>
      <Modal open={modal === 'limits'} onClose={() => setModal(null)} title="Mis límites de futuros">
        {a && <LimitsForm a={a} onDone={() => (setModal(null), refresh())} />}
      </Modal>
    </div>
  );
}

// ───────────── Gráfico ─────────────

function PriceChart({ symbol, decimals }: { symbol: string; decimals: number }) {
  const [interval, setIntervalName] = useState('1m');
  const q = useQuery({
    queryKey: ['futures', 'candles', symbol, interval],
    queryFn: () => get<{ t: string; o: string; h: string; l: string; c: string }[]>(`/futures/candles?symbol=${symbol}&interval=${interval}&limit=90`),
    refetchInterval: 5000,
    placeholderData: keepPreviousData,
  });
  const data = (q.data ?? []).map((d) => ({ t: d.t, o: +d.o, h: +d.h, l: +d.l, c: +d.c }));
  const W = 600;
  const H = 180;
  const pad = { l: 4, r: 56, t: 8, b: 16 };
  const hi = Math.max(...data.map((d) => d.h), 0);
  const lo = Math.min(...data.map((d) => d.l), Infinity);
  const span = hi - lo || hi * 0.001 || 1;
  const y = (v: number) => pad.t + ((hi - v) / span) * (H - pad.t - pad.b);
  const cw = data.length ? (W - pad.l - pad.r) / Math.max(data.length, 30) : 0;
  const last = data[data.length - 1];
  return (
    <div className="mt-2">
      <div className="mb-1 flex gap-1">
        {['1m', '5m', '15m', '1h', '4h', '1d'].map((i) => (
          <button key={i} onClick={() => setIntervalName(i)} className={`rounded-md px-2 py-0.5 text-[11px] font-semibold ${i === interval ? 'bg-slate-900 text-white' : 'text-black/50'}`}>
            {i}
          </button>
        ))}
      </div>
      {data.length < 2 ? (
        <div className="flex h-[180px] items-center justify-center rounded-xl bg-slate-50 text-xs text-black/40">Acumulando precios…</div>
      ) : (
        <svg viewBox={`0 0 ${W} ${H}`} className="h-[180px] w-full rounded-xl bg-slate-50" role="img" aria-label={`Gráfico de ${symbol}`}>
          {[0.25, 0.5, 0.75].map((f) => (
            <line key={f} x1={pad.l} x2={W - pad.r} y1={pad.t + f * (H - pad.t - pad.b)} y2={pad.t + f * (H - pad.t - pad.b)} stroke="#e2e8f0" />
          ))}
          {data.map((d, i) => {
            const x = pad.l + i * cw + cw / 2;
            const up = d.c >= d.o;
            const col = up ? '#059669' : '#e11d48';
            return (
              <g key={d.t}>
                <line x1={x} x2={x} y1={y(d.h)} y2={y(d.l)} stroke={col} strokeWidth={1} />
                <rect x={x - cw * 0.35} width={Math.max(cw * 0.7, 1)} y={y(Math.max(d.o, d.c))} height={Math.max(Math.abs(y(d.o) - y(d.c)), 1)} fill={col} rx={0.5} />
              </g>
            );
          })}
          {last && (
            <>
              <line x1={pad.l} x2={W - pad.r} y1={y(last.c)} y2={y(last.c)} stroke="#0f172a" strokeDasharray="3 3" strokeWidth={0.7} />
              <rect x={W - pad.r + 2} y={y(last.c) - 8} width={pad.r - 4} height={16} rx={3} fill="#0f172a" />
              <text x={W - pad.r / 2} y={y(last.c) + 4} textAnchor="middle" fontSize={10} fill="#fff" className="tabular-nums">
                {nf(last.c, decimals)}
              </text>
            </>
          )}
          <text x={W - pad.r + 2} y={pad.t + 8} fontSize={9} fill="#64748b">
            {nf(hi, decimals)}
          </text>
          <text x={W - pad.r + 2} y={H - pad.b} fontSize={9} fill="#64748b">
            {nf(lo, decimals)}
          </text>
        </svg>
      )}
    </div>
  );
}

// ───────────── Cuenta ─────────────

function AccountBar({ a, onTransfer, onLimits }: { a: Account; onTransfer: () => void; onLimits: () => void }) {
  return (
    <section className="card p-3">
      <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-xs sm:grid-cols-4">
        <div>
          <dt className="text-black/45">Patrimonio</dt>
          <dd className="text-base font-bold tabular-nums">{usd(a.equity)}</dd>
        </div>
        <div>
          <dt className="text-black/45">Disponible</dt>
          <dd className="text-base font-bold tabular-nums">{usd(a.available)}</dd>
        </div>
        <div>
          <dt className="text-black/45">Margen en uso</dt>
          <dd className="font-semibold tabular-nums">{usd(a.margin)}</dd>
        </div>
        <div>
          <dt className="text-black/45">PnL no realizado</dt>
          <dd className={`font-semibold tabular-nums ${signCls(Number(a.unrealized_pnl))}`}>{signed(Number(a.unrealized_pnl))} USDT</dd>
        </div>
      </dl>
      <div className="mt-2 grid grid-cols-2 gap-2">
        <button className="btn-ghost py-2 text-sm" onClick={onTransfer}>
          ⇄ Transferir
        </button>
        <button className="btn-ghost py-2 text-sm" onClick={onLimits}>
          Mis límites
        </button>
      </div>
    </section>
  );
}

// ───────────── Orden ─────────────

function OrderForm({ c, a, pref, onLeverage, onDone }: { c: Contract; a: Account; pref: Account['prefs'][number]; onLeverage: () => void; onDone: () => void }) {
  const [side, setSide] = useState<'BUY' | 'SELL'>('BUY');
  const [type, setType] = useState<'MARKET' | 'LIMIT' | 'STOP_MARKET'>('MARKET');
  const [unit, setUnit] = useState<'USDT' | 'BASE'>('USDT');
  const [amount, setAmount] = useState('');
  const [price, setPrice] = useState('');
  const [stop, setStop] = useState('');
  const [tif, setTif] = useState<'GTC' | 'IOC' | 'FOK'>('GTC');
  const [reduceOnly, setReduceOnly] = useState(false);
  const [postOnly, setPostOnly] = useState(false);
  const [tpsl, setTpsl] = useState(false);
  const [tp, setTp] = useState('');
  const [sl, setSl] = useState('');
  const [confirm, setConfirm] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => {
    setPrice('');
    setStop('');
    setAmount('');
    setMsg(null);
  }, [c.symbol]);

  const mark = Number(c.mark_price ?? 0);
  const ref = type === 'LIMIT' ? Number(price) || mark : type === 'STOP_MARKET' ? Number(stop) || mark : mark;
  const lev = pref.leverage;
  const qty = useMemo(() => {
    const v = Number(amount.replace(',', '.'));
    if (!v || !ref) return '0';
    return floorStep(unit === 'USDT' ? v / ref : v, c.qty_step);
  }, [amount, unit, ref, c.qty_step]);
  const q = Number(qty);
  const notional = q * ref;
  const margin = notional / lev;
  const feeRate = type === 'LIMIT' && postOnly ? c.maker_fee : c.taker_fee;
  const fee = (notional * feeRate) / 100;
  const pSide = side === 'BUY' ? 'LONG' : 'SHORT';
  const liq = estimateLiq(c, pSide, q, ref, margin);
  const maxNotional = (Number(a.available) * lev) / (1 + (lev * c.taker_fee) / 100);
  const pct = (p: number) => {
    const n = maxNotional * p;
    setAmount(unit === 'USDT' ? (Math.floor(n * 100) / 100).toFixed(2) : floorStep(n / (ref || 1), c.qty_step));
  };
  const issues: string[] = [];
  const minStepUsdt = Number(c.qty_step) * (ref || 0);
  if (Number(amount.replace(',', '.')) > 0 && !q) issues.push(`Mínimo ${c.qty_step} ${c.base} (≈ ${usd(minStepUsdt)}) por orden`);
  if (q > 0 && notional < Number(c.min_notional)) issues.push(`Mínimo ${nf(c.min_notional)} USDT por orden`);
  if (type === 'LIMIT' && !Number(price)) issues.push('Escribe el precio límite');
  if (type === 'STOP_MARKET' && !Number(stop)) issues.push('Escribe el precio de activación');
  if (!reduceOnly && margin + fee > Number(a.available) + 1e-9) issues.push(`Margen insuficiente (necesitas ${usd(margin + fee)})`);

  const order = useMutation({
    mutationFn: async () => {
      const body: Record<string, unknown> = { symbol: c.symbol, side, type, qty, reduceOnly };
      if (type === 'LIMIT') Object.assign(body, { price: roundTick(Number(price), c.price_tick), timeInForce: tif, postOnly });
      if (type === 'STOP_MARKET') body.stopPrice = roundTick(Number(stop), c.price_tick);
      const o = await post<any>('/futures/orders', body, { 'idempotency-key': crypto.randomUUID() });
      if (o.status === 'FILLED' && tpsl && (tp || sl)) {
        const acc = await get<Account>('/futures/account');
        const p = acc.positions.find((x) => x.symbol === c.symbol);
        if (p) await put(`/futures/positions/${p.id}/tpsl`, { tp: tp ? roundTick(Number(tp), c.price_tick) : null, sl: sl ? roundTick(Number(sl), c.price_tick) : null });
      }
      return o;
    },
    onSuccess: (o) => {
      setConfirm(false);
      setAmount('');
      setMsg(
        o.status === 'FILLED'
          ? `${side === 'BUY' ? 'Long' : 'Short'} ${Number(o.qty)} ${c.base} ejecutado.`
          : o.status === 'NEW'
            ? 'Orden abierta: se ejecutará cuando el precio la alcance.'
            : o.status === 'EXPIRED'
              ? 'La orden IOC/FOK no se pudo llenar al instante y expiró.'
              : `Orden ${o.status}: ${o.reject_reason ?? ''}`,
      );
      onDone();
    },
  });

  const pd = dec(c.price_tick);
  return (
    <section className="card space-y-3 p-3 sm:p-4">
      <div className="flex items-center gap-2">
        <button className="rounded-lg bg-black/5 px-2.5 py-1.5 text-xs font-semibold" onClick={onLeverage}>
          {pref.margin_mode === 'ISOLATED' ? 'Aislado' : 'Cruzado'}
        </button>
        <button className="rounded-lg bg-black/5 px-2.5 py-1.5 text-xs font-semibold tabular-nums" onClick={onLeverage}>
          {lev}×
        </button>
        <div className="ml-auto flex rounded-lg bg-black/5 p-0.5 text-xs">
          {(
            [
              ['MARKET', 'Mercado'],
              ['LIMIT', 'Límite'],
              ['STOP_MARKET', 'Stop'],
            ] as const
          ).map(([k, l]) => (
            <button key={k} onClick={() => setType(k)} className={`rounded-md px-2.5 py-1 font-semibold ${type === k ? 'bg-white shadow-sm' : 'text-black/55'}`}>
              {l}
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-1 rounded-xl bg-black/5 p-1">
        <button onClick={() => setSide('BUY')} className={`rounded-lg py-2 text-sm font-bold ${side === 'BUY' ? 'bg-emerald-600 text-white' : 'text-black/55'}`}>
          Comprar / Long
        </button>
        <button onClick={() => setSide('SELL')} className={`rounded-lg py-2 text-sm font-bold ${side === 'SELL' ? 'bg-rose-600 text-white' : 'text-black/55'}`}>
          Vender / Short
        </button>
      </div>

      {type === 'LIMIT' && (
        <Field label="Precio límite (USDT)">
          <input className="input tabular-nums" inputMode="decimal" value={price} placeholder={nf(mark, pd)} onChange={(e) => setPrice(e.target.value)} />
        </Field>
      )}
      {type === 'STOP_MARKET' && (
        <Field label={`Activar cuando el precio marca ${side === 'BUY' ? 'suba a' : 'baje a'} (USDT)`}>
          <input className="input tabular-nums" inputMode="decimal" value={stop} placeholder={nf(mark, pd)} onChange={(e) => setStop(e.target.value)} />
        </Field>
      )}
      <Field
        label={
          <span className="flex items-center justify-between">
            <span>Tamaño</span>
            <span className="flex rounded-md bg-black/5 p-0.5 text-[11px]">
              {(['USDT', 'BASE'] as const).map((u) => (
                <button key={u} onClick={() => (setUnit(u), setAmount(''))} className={`rounded px-2 ${unit === u ? 'bg-white font-semibold shadow-sm' : 'text-black/50'}`}>
                  {u === 'USDT' ? 'USDT' : c.base}
                </button>
              ))}
            </span>
          </span>
        }
      >
        <input
          className="input tabular-nums"
          inputMode="decimal"
          value={amount}
          placeholder={unit === 'USDT' ? 'Valor de la posición en USDT' : `Cantidad en ${c.base}`}
          onChange={(e) => setAmount(e.target.value)}
        />
      </Field>
      <div className="grid grid-cols-4 gap-1.5">
        {[0.25, 0.5, 0.75, 1].map((p) => (
          <button key={p} className="rounded-lg bg-black/5 py-1.5 text-xs font-semibold" onClick={() => pct(p)}>
            {p * 100} %
          </button>
        ))}
      </div>

      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
        <label className="flex items-center gap-1.5">
          <input type="checkbox" checked={reduceOnly} onChange={(e) => setReduceOnly(e.target.checked)} /> Solo reducir
        </label>
        {type !== 'STOP_MARKET' && !reduceOnly && (
          <label className="flex items-center gap-1.5">
            <input type="checkbox" checked={tpsl} onChange={(e) => setTpsl(e.target.checked)} /> TP/SL
          </label>
        )}
        {type === 'LIMIT' && (
          <>
            <label className="flex items-center gap-1.5">
              <input type="checkbox" checked={postOnly} onChange={(e) => setPostOnly(e.target.checked)} /> Post-only
            </label>
            <select className="rounded-md bg-black/5 px-1.5 py-0.5" value={tif} onChange={(e) => setTif(e.target.value as any)} aria-label="Vigencia">
              <option value="GTC">GTC</option>
              <option value="IOC">IOC</option>
              <option value="FOK">FOK</option>
            </select>
          </>
        )}
      </div>
      {tpsl && !reduceOnly && type !== 'STOP_MARKET' && (
        <div className="grid grid-cols-2 gap-2">
          <Field label="Take profit (marca)">
            <input className="input tabular-nums" inputMode="decimal" value={tp} onChange={(e) => setTp(e.target.value)} placeholder={nf(mark * (side === 'BUY' ? 1.05 : 0.95), pd)} />
          </Field>
          <Field label="Stop loss (marca)">
            <input className="input tabular-nums" inputMode="decimal" value={sl} onChange={(e) => setSl(e.target.value)} placeholder={nf(mark * (side === 'BUY' ? 0.97 : 1.03), pd)} />
          </Field>
        </div>
      )}

      <dl className="grid grid-cols-2 gap-x-3 gap-y-1 rounded-xl bg-slate-50 p-2.5 text-xs">
        <dt className="text-black/50">Cantidad</dt>
        <dd className="text-right font-semibold tabular-nums">
          {q ? qty : '—'} {c.base}
        </dd>
        <dt className="text-black/50">Valor (nocional)</dt>
        <dd className="text-right font-semibold tabular-nums">{q ? usd(notional) : '—'}</dd>
        <dt className="text-black/50">Margen ({lev}×)</dt>
        <dd className="text-right font-semibold tabular-nums">{q && !reduceOnly ? usd(margin) : '—'}</dd>
        <dt className="text-black/50">Comisión estimada ({nf(feeRate, 2)} %)</dt>
        <dd className="text-right font-semibold tabular-nums">{q ? usd(fee) : '—'}</dd>
        <dt className="text-black/50">Precio de liquidación est.</dt>
        <dd className="text-right font-bold text-rose-600 tabular-nums">{q && !reduceOnly && liq ? nf(liq, pd) : '—'}</dd>
      </dl>
      {issues.length > 0 && Number(amount.replace(',', '.')) > 0 && <p className="text-xs text-rose-700">{issues[0]}</p>}
      {msg && <Notice tone="success">{msg}</Notice>}
      <ErrorBox error={order.error} />
      <button
        className={`w-full rounded-xl py-3 text-base font-bold text-white disabled:opacity-40 ${side === 'BUY' ? 'bg-emerald-600' : 'bg-rose-600'}`}
        disabled={!q || issues.length > 0 || order.isPending}
        onClick={() => setConfirm(true)}
      >
        {side === 'BUY' ? 'Comprar / Long' : 'Vender / Short'} {q ? `${qty} ${c.base}` : ''}
      </button>

      <Modal open={confirm} onClose={() => setConfirm(false)} title="Confirmar orden">
        <div className="space-y-3 text-sm">
          <p>
            <b className={side === 'BUY' ? 'text-emerald-700' : 'text-rose-700'}>{side === 'BUY' ? 'Long' : 'Short'}</b> {qty} {c.base} ·{' '}
            {type === 'MARKET' ? 'a mercado' : type === 'LIMIT' ? `límite ${price}` : `stop ${stop}`} · {lev}× {pref.margin_mode === 'ISOLATED' ? 'aislado' : 'cruzado'}
          </p>
          <dl className="grid grid-cols-2 gap-y-1 text-xs">
            <dt className="text-black/50">Margen</dt>
            <dd className="text-right tabular-nums">{reduceOnly ? '—' : usd(margin)}</dd>
            <dt className="text-black/50">Comisión</dt>
            <dd className="text-right tabular-nums">{usd(fee)}</dd>
            <dt className="text-black/50">Liquidación estimada</dt>
            <dd className="text-right font-bold text-rose-600 tabular-nums">{!reduceOnly && liq ? nf(liq, pd) : '—'}</dd>
          </dl>
          {!reduceOnly && liq && (
            <Notice tone="warn">
              Si el precio marca llega a {nf(liq, pd)} ({nf(((liq - ref) / ref) * 100, 2)} %), pierdes el margen de esta posición.
            </Notice>
          )}
          <button
            className={`w-full rounded-xl py-3 font-bold text-white ${side === 'BUY' ? 'bg-emerald-600' : 'bg-rose-600'}`}
            disabled={order.isPending}
            onClick={() => order.mutate()}
          >
            {order.isPending ? 'Enviando…' : 'Confirmar'}
          </button>
        </div>
      </Modal>
    </section>
  );
}

function Field({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div>
      <div className="label">{label}</div>
      {children}
    </div>
  );
}

// ───────────── Posiciones, órdenes e historial ─────────────

function Activity({ a, contracts, onChange }: { a: Account; contracts: Contract[]; onChange: () => void }) {
  const [tab, setTab] = useState<'pos' | 'orders' | 'history' | 'fills' | 'funding'>('pos');
  const orders = useQuery({ queryKey: ['futures', 'orders', 'open'], queryFn: () => get<any[]>('/futures/orders?status=open'), refetchInterval: 3000 });
  const tabs = [
    ['pos', `Posiciones (${a.positions.length})`],
    ['orders', `Órdenes (${orders.data?.length ?? 0})`],
    ['history', 'Cerradas'],
    ['fills', 'Operaciones'],
    ['funding', 'Funding'],
  ] as const;
  return (
    <section className="card overflow-hidden">
      <div className="no-scrollbar flex gap-1 overflow-x-auto border-b border-black/5 px-2 pt-2">
        {tabs.map(([k, l]) => (
          <button key={k} onClick={() => setTab(k)} className={`shrink-0 rounded-t-lg px-3 py-2 text-xs font-semibold ${tab === k ? 'border-b-2 border-slate-900 text-slate-900' : 'text-black/45'}`}>
            {l}
          </button>
        ))}
      </div>
      <div className="p-3">
        {tab === 'pos' && <Positions a={a} contracts={contracts} onChange={onChange} />}
        {tab === 'orders' && <OpenOrders rows={orders.data} onChange={onChange} />}
        {tab === 'history' && <ClosedPositions />}
        {tab === 'fills' && <Fills />}
        {tab === 'funding' && <FundingList />}
      </div>
    </section>
  );
}

function Positions({ a, contracts, onChange }: { a: Account; contracts: Contract[]; onChange: () => void }) {
  const [edit, setEdit] = useState<{ p: Position; kind: 'tpsl' | 'margin' | 'close' } | null>(null);
  if (!a.positions.length) return <p className="py-6 text-center text-sm text-black/40">Sin posiciones abiertas.</p>;
  return (
    <div className="space-y-2">
      {a.positions.map((p) => {
        const c = contracts.find((k) => k.symbol === p.symbol)!;
        const pd = dec(c.price_tick);
        const pnl = Number(p.unrealized_pnl);
        const risk = p.margin_ratio;
        return (
          <div key={p.id} className="rounded-xl ring-1 ring-black/10">
            <div className="flex items-center justify-between gap-2 border-b border-black/5 px-3 py-2">
              <div className="flex items-center gap-1.5 text-sm font-bold">
                <span className={`rounded px-1.5 py-0.5 text-[10px] text-white ${p.side === 'LONG' ? 'bg-emerald-600' : 'bg-rose-600'}`}>{p.side === 'LONG' ? 'Long' : 'Short'}</span>
                {p.symbol}
                <span className="text-xs font-medium text-black/45">
                  {p.margin_mode === 'ISOLATED' ? 'Aislado' : 'Cruzado'} {p.leverage}×
                </span>
              </div>
              <div className={`text-right text-sm font-bold tabular-nums ${signCls(pnl)}`}>
                {signed(pnl)} USDT
                <div className="text-[11px] font-semibold">{signed(p.roe)} %</div>
              </div>
            </div>
            <dl className="grid grid-cols-3 gap-x-2 gap-y-1 px-3 py-2 text-[11px]">
              <Cell k="Tamaño" v={`${p.qty} ${c.base}`} />
              <Cell k="Entrada" v={nf(p.entry_price, pd)} />
              <Cell k="Marca" v={nf(p.mark_price, pd)} />
              <Cell k="Liquidación" v={p.liquidation_price ? nf(p.liquidation_price, pd) : '—'} cls="text-rose-600" />
              <Cell k="Margen" v={nf(p.margin)} />
              <Cell k="Uso del margen" v={`${nf(risk, 1)} %`} cls={risk >= 80 ? 'text-rose-600' : risk >= 50 ? 'text-amber-600' : ''} />
              {(p.tp_price || p.sl_price) && <Cell k="TP / SL" v={`${p.tp_price ? nf(p.tp_price, pd) : '—'} / ${p.sl_price ? nf(p.sl_price, pd) : '—'}`} />}
            </dl>
            {risk >= 80 && <p className="px-3 pb-2 text-[11px] font-semibold text-rose-700">⚠ Cerca de la liquidación: añade margen o reduce la posición.</p>}
            <div className="grid grid-cols-3 gap-1.5 px-3 pb-3">
              <button className="btn-ghost py-1.5 text-xs" onClick={() => setEdit({ p, kind: 'tpsl' })}>
                TP/SL
              </button>
              <button className="btn-ghost py-1.5 text-xs disabled:opacity-40" disabled={p.margin_mode !== 'ISOLATED'} onClick={() => setEdit({ p, kind: 'margin' })}>
                Margen
              </button>
              <button className="rounded-xl bg-slate-900 py-1.5 text-xs font-semibold text-white" onClick={() => setEdit({ p, kind: 'close' })}>
                Cerrar
              </button>
            </div>
          </div>
        );
      })}
      <Modal open={!!edit} onClose={() => setEdit(null)} title={edit ? `${edit.kind === 'tpsl' ? 'TP/SL' : edit.kind === 'margin' ? 'Margen' : 'Cerrar'} · ${edit.p.symbol}` : ''}>
        {edit?.kind === 'tpsl' && <TpSlForm p={edit.p} c={contracts.find((k) => k.symbol === edit.p.symbol)!} onDone={() => (setEdit(null), onChange())} />}
        {edit?.kind === 'margin' && <MarginForm p={edit.p} onDone={() => (setEdit(null), onChange())} />}
        {edit?.kind === 'close' && <CloseForm p={edit.p} c={contracts.find((k) => k.symbol === edit.p.symbol)!} onDone={() => (setEdit(null), onChange())} />}
      </Modal>
    </div>
  );
}

function Cell({ k, v, cls = '' }: { k: string; v: string; cls?: string }) {
  return (
    <div>
      <dt className="text-black/45">{k}</dt>
      <dd className={`font-semibold tabular-nums ${cls}`}>{v}</dd>
    </div>
  );
}

function CloseForm({ p, c, onDone }: { p: Position; c: Contract; onDone: () => void }) {
  const [part, setPart] = useState(1);
  const qty = part === 1 ? p.qty : floorStep(Number(p.qty) * part, c.qty_step);
  const m = useMutation({ mutationFn: () => post(`/futures/positions/${p.id}/close`, { qty }), onSuccess: onDone });
  return (
    <div className="space-y-3 text-sm">
      <div className="grid grid-cols-4 gap-1.5">
        {[0.25, 0.5, 0.75, 1].map((x) => (
          <button key={x} onClick={() => setPart(x)} className={`rounded-lg py-2 text-xs font-semibold ${part === x ? 'bg-slate-900 text-white' : 'bg-black/5'}`}>
            {x * 100} %
          </button>
        ))}
      </div>
      <p>
        Cerrar {qty} {c.base} a mercado (precio marca {nf(p.mark_price, dec(c.price_tick))}). PnL estimado:{' '}
        <b className={signCls(Number(p.unrealized_pnl))}>{signed(Number(p.unrealized_pnl) * (Number(qty) / Number(p.qty)))} USDT</b> antes de la comisión.
      </p>
      <ErrorBox error={m.error} />
      <button className="w-full rounded-xl bg-slate-900 py-3 font-bold text-white disabled:opacity-40" disabled={!Number(qty) || m.isPending} onClick={() => m.mutate()}>
        {m.isPending ? 'Cerrando…' : `Cerrar ${qty} ${c.base}`}
      </button>
    </div>
  );
}

function TpSlForm({ p, c, onDone }: { p: Position; c: Contract; onDone: () => void }) {
  const [tp, setTp] = useState(p.tp_price ?? '');
  const [sl, setSl] = useState(p.sl_price ?? '');
  const m = useMutation({
    mutationFn: () => put(`/futures/positions/${p.id}/tpsl`, { tp: tp ? roundTick(Number(tp), c.price_tick) : null, sl: sl ? roundTick(Number(sl), c.price_tick) : null }),
    onSuccess: onDone,
  });
  const pd = dec(c.price_tick);
  const e = Number(p.entry_price);
  const q = Number(p.qty);
  const pnlAt = (x: number) => (p.side === 'LONG' ? x - e : e - x) * q;
  return (
    <div className="space-y-3 text-sm">
      <p className="text-xs text-black/55">Se activan con el precio marca y cierran toda la posición a mercado. Déjalos vacíos para quitarlos.</p>
      <Field label={`Take profit ${tp ? `· PnL ${signed(pnlAt(Number(tp)))} USDT` : ''}`}>
        <input className="input tabular-nums" inputMode="decimal" value={tp} onChange={(x) => setTp(x.target.value)} placeholder={nf(e * (p.side === 'LONG' ? 1.05 : 0.95), pd)} />
      </Field>
      <Field label={`Stop loss ${sl ? `· PnL ${signed(pnlAt(Number(sl)))} USDT` : ''}`}>
        <input className="input tabular-nums" inputMode="decimal" value={sl} onChange={(x) => setSl(x.target.value)} placeholder={nf(e * (p.side === 'LONG' ? 0.97 : 1.03), pd)} />
      </Field>
      <ErrorBox error={m.error} />
      <button className="btn-primary w-full" disabled={m.isPending} onClick={() => m.mutate()}>
        Guardar
      </button>
    </div>
  );
}

function MarginForm({ p, onDone }: { p: Position; onDone: () => void }) {
  const [action, setAction] = useState<'ADD' | 'REMOVE'>('ADD');
  const [amount, setAmount] = useState('');
  const m = useMutation({ mutationFn: () => post(`/futures/positions/${p.id}/margin`, { action, amount: Number(amount).toFixed(6) }), onSuccess: onDone });
  return (
    <div className="space-y-3 text-sm">
      <div className="grid grid-cols-2 gap-1 rounded-xl bg-black/5 p-1">
        {(['ADD', 'REMOVE'] as const).map((x) => (
          <button key={x} onClick={() => setAction(x)} className={`rounded-lg py-2 text-xs font-semibold ${action === x ? 'bg-white shadow-sm' : 'text-black/55'}`}>
            {x === 'ADD' ? 'Añadir' : 'Quitar'}
          </button>
        ))}
      </div>
      <p className="text-xs text-black/55">
        Margen actual {usd(p.margin)} · mínimo {usd(p.initial_margin)}. Más margen aleja la liquidación ({nf(p.liquidation_price ?? 0, 2)}).
      </p>
      <input className="input tabular-nums" inputMode="decimal" placeholder="Monto en USDT" value={amount} onChange={(e) => setAmount(e.target.value)} />
      <ErrorBox error={m.error} />
      <button className="btn-primary w-full" disabled={!Number(amount) || m.isPending} onClick={() => m.mutate()}>
        {action === 'ADD' ? 'Añadir margen' : 'Quitar margen'}
      </button>
    </div>
  );
}

function OpenOrders({ rows, onChange }: { rows?: any[]; onChange: () => void }) {
  const qc = useQueryClient();
  const cancel = useMutation({
    mutationFn: (id: string) => del(`/futures/orders/${id}`),
    onSuccess: () => (qc.invalidateQueries({ queryKey: ['futures', 'orders'] }), onChange()),
  });
  if (!rows) return <Spinner />;
  if (!rows.length) return <p className="py-6 text-center text-sm text-black/40">Sin órdenes abiertas.</p>;
  return (
    <ul className="divide-y divide-black/5 text-xs">
      {rows.map((o) => (
        <li key={o.id} className="flex items-center gap-2 py-2">
          <span className={`font-bold ${o.side === 'BUY' ? 'text-emerald-600' : 'text-rose-600'}`}>{o.side === 'BUY' ? 'Compra' : 'Venta'}</span>
          <div className="min-w-0 flex-1">
            <div className="font-semibold">
              {o.symbol} · {o.type === 'LIMIT' ? `Límite ${Number(o.price)}` : `Stop ${Number(o.stop_price)}`}
            </div>
            <div className="text-black/45">
              {Number(o.qty)} · {o.time_in_force}
              {o.reduce_only && ' · solo reducir'}
              {o.post_only && ' · post-only'} · {hour(o.created_at)}
            </div>
          </div>
          <button className="rounded-lg bg-black/5 px-2.5 py-1.5 font-semibold" disabled={cancel.isPending} onClick={() => cancel.mutate(o.id)}>
            Cancelar
          </button>
        </li>
      ))}
    </ul>
  );
}

function ClosedPositions() {
  const q = useQuery({ queryKey: ['futures', 'history'], queryFn: () => get<Position[]>('/futures/positions/history') });
  if (!q.data) return <Spinner />;
  if (!q.data.length) return <p className="py-6 text-center text-sm text-black/40">Aún no cerraste posiciones.</p>;
  return (
    <ul className="divide-y divide-black/5 text-xs">
      {q.data.map((p) => {
        const net = Number(p.realized_pnl) - Number(p.fees_paid) - Number(p.funding_paid);
        return (
          <li key={p.id} className="flex items-center gap-2 py-2">
            <span className={`rounded px-1.5 py-0.5 text-[10px] text-white ${p.side === 'LONG' ? 'bg-emerald-600' : 'bg-rose-600'}`}>{p.side === 'LONG' ? 'L' : 'S'}</span>
            <div className="min-w-0 flex-1">
              <div className="font-semibold">
                {p.symbol} · {p.status === 'LIQUIDATED' ? <span className="text-rose-600">Liquidada</span> : 'Cerrada'}
              </div>
              <div className="text-black/45">
                {nf(p.entry_price)} → {nf(p.close_price)} · {p.closed_at ? dateTime(p.closed_at) : ''}
              </div>
            </div>
            <div className={`text-right font-bold tabular-nums ${signCls(net)}`}>
              {signed(net)}
              <div className="text-[10px] font-normal text-black/40">neto USDT</div>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function Fills() {
  const q = useQuery({ queryKey: ['futures', 'fills'], queryFn: () => get<any[]>('/futures/fills') });
  if (!q.data) return <Spinner />;
  if (!q.data.length) return <p className="py-6 text-center text-sm text-black/40">Sin operaciones.</p>;
  const TYPE: Record<string, string> = { MARKET: 'Mercado', LIMIT: 'Límite', STOP_MARKET: 'Stop', TAKE_PROFIT: 'TP', STOP_LOSS: 'SL', LIQUIDATION: 'Liquidación' };
  return (
    <ul className="divide-y divide-black/5 text-xs">
      {q.data.map((f) => (
        <li key={f.id} className="flex items-center gap-2 py-2">
          <span className={`font-bold ${f.side === 'BUY' ? 'text-emerald-600' : 'text-rose-600'}`}>{f.side === 'BUY' ? 'C' : 'V'}</span>
          <div className="min-w-0 flex-1">
            <div className="font-semibold">
              {f.symbol} · {Number(f.qty)} @ {nf(f.price)} <span className="font-normal text-black/45">· {TYPE[f.type] ?? f.type} · {f.liquidity === 'MAKER' ? 'maker' : 'taker'}</span>
            </div>
            <div className="text-black/45">
              {dateTime(f.created_at)} · comisión {nf(Number(f.fee) / 1e6, 4)}
            </div>
          </div>
          {Number(f.realized_pnl) !== 0 && <span className={`font-semibold tabular-nums ${signCls(Number(f.realized_pnl))}`}>{signed(Number(f.realized_pnl) / 1e6)}</span>}
        </li>
      ))}
    </ul>
  );
}

function FundingList() {
  const q = useQuery({ queryKey: ['futures', 'funding'], queryFn: () => get<any[]>('/futures/funding') });
  if (!q.data) return <Spinner />;
  if (!q.data.length) return <p className="py-6 text-center text-sm text-black/40">Sin pagos de funding. Se cobran o pagan a las 20:00, 04:00 y 12:00 (hora de Venezuela) si tienes posición abierta.</p>;
  return (
    <ul className="divide-y divide-black/5 text-xs">
      {q.data.map((f) => (
        <li key={f.id} className="flex items-center justify-between py-2">
          <div>
            <div className="font-semibold">{f.symbol}</div>
            <div className="text-black/45">
              {dateTime(f.funding_time)} · tasa {nf(Number(f.rate) * 100, 4)} %
            </div>
          </div>
          <span className={`font-semibold tabular-nums ${signCls(-Number(f.amount))}`}>{signed(-Number(f.amount) / 1e6, 4)} USDT</span>
        </li>
      ))}
    </ul>
  );
}

// ───────────── Ventanas ─────────────

function TransferForm({ a, onDone }: { a: Account; onDone: () => void }) {
  const [dir, setDir] = useState<'IN' | 'OUT'>('IN');
  const [amount, setAmount] = useState('');
  const max = dir === 'IN' ? Number(a.cash_usdt) : Number(a.available);
  const m = useMutation({ mutationFn: () => post('/futures/transfer', { direction: dir, amount: Number(amount).toFixed(6) }), onSuccess: onDone });
  return (
    <div className="space-y-3 text-sm">
      <div className="grid grid-cols-2 gap-1 rounded-xl bg-black/5 p-1">
        {(['IN', 'OUT'] as const).map((d) => (
          <button key={d} onClick={() => (setDir(d), setAmount(''))} className={`rounded-lg py-2 text-xs font-semibold ${dir === d ? 'bg-white shadow-sm' : 'text-black/55'}`}>
            {d === 'IN' ? 'Billetera → Futuros' : 'Futuros → Billetera'}
          </button>
        ))}
      </div>
      <div className="flex gap-2">
        <input className="input flex-1 tabular-nums" inputMode="decimal" placeholder="Monto en USDT" value={amount} onChange={(e) => setAmount(e.target.value)} />
        <button className="btn-ghost px-3 text-xs" onClick={() => setAmount((Math.floor(max * 1e6) / 1e6).toString())}>
          Máx.
        </button>
      </div>
      <p className="text-xs text-black/50">Disponible: {usd(max)}</p>
      <ErrorBox error={m.error} />
      <button className="btn-primary w-full" disabled={!Number(amount) || Number(amount) > max + 1e-9 || m.isPending} onClick={() => m.mutate()}>
        Transferir
      </button>
    </div>
  );
}

function LeverageForm({ c, pref, onDone }: { c: Contract; pref: Account['prefs'][number]; onDone: () => void }) {
  const [lev, setLev] = useState(pref.leverage);
  const [mode, setMode] = useState(pref.margin_mode);
  const m = useMutation({ mutationFn: () => put(`/futures/prefs/${c.symbol}`, { leverage: lev, marginMode: mode }), onSuccess: onDone });
  const maxPos = [...c.brackets].reverse().find((x) => x.max_leverage >= lev)?.cap;
  return (
    <div className="space-y-4 text-sm">
      <div className="grid grid-cols-2 gap-1 rounded-xl bg-black/5 p-1">
        {(['ISOLATED', 'CROSS'] as const).map((x) => (
          <button key={x} onClick={() => setMode(x)} className={`rounded-lg py-2 text-xs font-semibold ${mode === x ? 'bg-white shadow-sm' : 'text-black/55'}`}>
            {x === 'ISOLATED' ? 'Aislado' : 'Cruzado'}
          </button>
        ))}
      </div>
      <p className="text-xs text-black/55">
        {mode === 'ISOLATED'
          ? 'Aislado: cada posición usa solo su margen; como máximo pierdes ese margen.'
          : 'Cruzado: todas las posiciones cruzadas comparten tu saldo de futuros; una pérdida grande puede consumir todo el saldo.'}
      </p>
      <div>
        <div className="mb-1 flex items-baseline justify-between">
          <span className="label">Apalancamiento</span>
          <span className="text-2xl font-extrabold tabular-nums">{lev}×</span>
        </div>
        <input type="range" min={1} max={c.max_leverage} value={lev} onChange={(e) => setLev(Number(e.target.value))} className="w-full" aria-label="Apalancamiento" />
        <div className="mt-1 flex flex-wrap gap-1.5">
          {[1, 2, 5, 10, 20, 25, 50].filter((x) => x <= c.max_leverage).map((x) => (
            <button key={x} onClick={() => setLev(x)} className={`rounded-md px-2 py-1 text-xs font-semibold ${lev === x ? 'bg-slate-900 text-white' : 'bg-black/5'}`}>
              {x}×
            </button>
          ))}
        </div>
      </div>
      <p className="text-xs text-black/55">
        Con {lev}× la posición máxima es de {maxPos ? usd(maxPos) : '—'}. Un movimiento de ~{nf(100 / lev, 1)} % en contra liquida la posición.
      </p>
      {lev >= 20 && <Notice tone="warn">Apalancamiento alto: un movimiento pequeño del precio puede liquidar tu posición.</Notice>}
      <ErrorBox error={m.error} />
      <button className="btn-primary w-full" disabled={m.isPending} onClick={() => m.mutate()}>
        Guardar
      </button>
    </div>
  );
}

function RiskForm({ onDone }: { onDone: () => void }) {
  const [q1, setQ1] = useState('');
  const [q2, setQ2] = useState('');
  const ok = q1 === 'b' && q2 === 'a';
  const m = useMutation({ mutationFn: () => post('/futures/risk/accept'), onSuccess: onDone });
  const Q = ({ v, set, opts }: { v: string; set: (x: string) => void; opts: [string, string][] }) => (
    <div className="space-y-1">
      {opts.map(([k, l]) => (
        <label key={k} className={`flex items-start gap-2 rounded-lg p-2 ring-1 ${v === k ? 'bg-slate-50 ring-slate-400' : 'ring-black/10'}`}>
          <input type="radio" checked={v === k} onChange={() => set(k)} className="mt-0.5" /> <span>{l}</span>
        </label>
      ))}
    </div>
  );
  return (
    <div className="space-y-3 text-sm">
      <ul className="list-disc space-y-1 pl-5 text-xs text-black/70">
        <li>Los futuros son un producto derivado con apalancamiento. Puedes perder todo el margen de una posición en minutos.</li>
        <li>La plataforma es la contraparte de tus operaciones. Los precios vienen de exchanges externos; nadie de la operadora puede cambiarlos.</li>
        <li>Si el precio marca llega a tu precio de liquidación, la posición se cierra y se cobra una tarifa del 0,5 %. Nunca quedarás debiendo.</li>
        <li>Cada 8 horas se paga o cobra funding mientras tengas posición abierta.</li>
        <li>Es una demostración sin valor: el producto no tiene autorización del regulador.</li>
      </ul>
      <p className="font-semibold">1. Abres un long con 20×. Si el precio baja cerca de 5 %, ¿qué pasa?</p>
      <Q v={q1} set={setQ1} opts={[['a', 'Nada, solo pierdo 5 %'], ['b', 'La posición se liquida y pierdo el margen'], ['c', 'La plataforma espera a que el precio se recupere']]} />
      <p className="font-semibold">2. ¿De dónde sale el precio que liquida mi posición?</p>
      <Q v={q2} set={setQ2} opts={[['a', 'De la mediana de varios exchanges externos'], ['b', 'Lo fija la operadora'], ['c', 'Del último jugador que operó']]} />
      {(q1 && q2 && !ok) && <Notice tone="warn">Revisa tus respuestas.</Notice>}
      <ErrorBox error={m.error} />
      <button className="btn-primary w-full" disabled={!ok || m.isPending} onClick={() => m.mutate()}>
        Entiendo los riesgos
      </button>
    </div>
  );
}

function LimitsForm({ a, onDone }: { a: Account; onDone: () => void }) {
  const [lev, setLev] = useState(a.settings?.max_leverage?.toString() ?? '');
  const [loss, setLoss] = useState(a.settings?.daily_loss_limit ? String(Number(a.settings.daily_loss_limit)) : '');
  const [transfer, setTransfer] = useState(a.settings?.daily_transfer_limit ? String(Number(a.settings.daily_transfer_limit)) : '');
  const m = useMutation({
    mutationFn: () =>
      put('/futures/settings', {
        maxLeverage: lev ? Number(lev) : null,
        dailyLossLimit: loss ? Number(loss).toFixed(6) : null,
        dailyTransferLimit: transfer ? Number(transfer).toFixed(6) : null,
      }),
    onSuccess: onDone,
  });
  return (
    <div className="space-y-3 text-sm">
      <p className="text-xs text-black/55">Pon tus propios topes. Pérdida de hoy: {usd(a.today_loss)}. Vacío = sin límite personal.</p>
      <Field label="Apalancamiento máximo personal">
        <input className="input" inputMode="numeric" value={lev} onChange={(e) => setLev(e.target.value.replace(/\D/g, ''))} placeholder="Ej. 5" />
      </Field>
      <Field label="Pérdida máxima por día (USDT)">
        <input className="input" inputMode="decimal" value={loss} onChange={(e) => setLoss(e.target.value)} placeholder="Ej. 20" />
      </Field>
      <Field label="Transferencias máximas a futuros por día (USDT)">
        <input className="input" inputMode="decimal" value={transfer} onChange={(e) => setTransfer(e.target.value)} placeholder="Ej. 50" />
      </Field>
      <ErrorBox error={m.error} />
      <button className="btn-primary w-full" disabled={m.isPending} onClick={() => m.mutate()}>
        Guardar límites
      </button>
    </div>
  );
}
