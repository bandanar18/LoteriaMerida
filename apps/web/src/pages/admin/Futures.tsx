import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ErrorBox, Modal, Notice, PageTitle, Spinner } from '../../components/ui';
import { get, post, put } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { dateTime } from '../../lib/format';

/** Backoffice de Cumbre Futuros: feed, exposición de la casa, resultado del día, posiciones, liquidaciones y configuración. */

const nf = (v: number | string | null | undefined, d = 2) =>
  v === null || v === undefined || v === '' ? '—' : Number(v).toLocaleString('es-VE', { minimumFractionDigits: d, maximumFractionDigits: d });
const usd = (v: number | string | null | undefined) => `${nf(v)} USDT`;
const tone = (v: number) => (v > 0 ? 'text-emerald-600' : v < 0 ? 'text-rose-600' : 'text-slate-600');
const STATUS: Record<string, [string, string]> = {
  ACTIVE: ['Activo', 'bg-emerald-50 text-emerald-700 ring-emerald-200'],
  CLOSE_ONLY: ['Solo cerrar', 'bg-amber-50 text-amber-800 ring-amber-200'],
  PAUSED: ['En pausa', 'bg-rose-50 text-rose-700 ring-rose-200'],
};

export function FuturesAdminPage() {
  const { user } = useAuth();
  const isAdmin = user?.role === 'ADMIN';
  const ov = useQuery({ queryKey: ['admin', 'futures', 'overview'], queryFn: () => get<any>('/admin/futures/overview'), refetchInterval: 3000 });
  const [tab, setTab] = useState<'positions' | 'liquidations' | 'fills' | 'incidents'>('positions');
  const [edit, setEdit] = useState<any>(null);
  const [status, setStatus] = useState<{ symbol: string; status: string } | null>(null);
  const [settings, setSettings] = useState(false);

  if (ov.isLoading) return <Spinner />;
  if (ov.error) return <ErrorBox error={ov.error} />;
  const o = ov.data;
  const t = o.today;
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <PageTitle>Cumbre Futuros</PageTitle>
          <p className="text-sm text-slate-500">
            Perpetuos BTC · ETH · SOL con margen en USDT · {o.settings.rules_version}
            {o.settings.is_demo && <span className="ml-2 badge bg-amber-100 text-amber-900">DEMO</span>}
          </p>
        </div>
        {isAdmin && (
          <button className="btn-ghost" onClick={() => setSettings(true)}>
            Capital y pérdida máxima
          </button>
        )}
      </div>

      <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi label="Resultado de la casa hoy" value={usd(t.total)} cls={tone(Number(t.total))} sub="comisiones + liquidaciones + funding − PnL de jugadores" />
        <Kpi label="Comisiones" value={usd(t.fees)} sub={`${t.fills} operaciones · ${t.traders} jugadores`} />
        <Kpi label="Volumen (nocional)" value={usd(t.volume)} sub={`liquidaciones: ${t.liquidations} · ${usd(t.liquidation_fees)}`} />
        <Kpi
          label="PnL contra jugadores"
          value={usd(t.pnl_vs_players)}
          cls={tone(Number(t.pnl_vs_players))}
          sub={`funding neto ${usd(t.funding)}${Number(t.absorbed) ? ` · absorbido ${usd(t.absorbed)}` : ''}`}
        />
      </section>
      <div className="card p-4">
        <div className="flex items-center justify-between text-xs text-slate-500">
          <span>Pérdida máxima diaria de la casa ({o.settings.daily_loss_limit} % de {usd(o.settings.house_capital)})</span>
          <span className="font-semibold">
            {nf(t.loss_limit_use, 1)} % de {usd(t.loss_limit)}
          </span>
        </div>
        <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-slate-100">
          <div className={`h-full ${t.loss_limit_use >= 80 ? 'bg-rose-500' : 'bg-sky-500'}`} style={{ width: `${Math.min(t.loss_limit_use, 100)}%` }} />
        </div>
      </div>

      <section className="grid gap-4 xl:grid-cols-3">
        {o.contracts.map((c: any) => {
          const [label, cls] = STATUS[c.status];
          return (
            <div key={c.symbol} className="card overflow-hidden">
              <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
                <div>
                  <div className="font-semibold text-slate-900">{c.symbol}</div>
                  <div className="text-xs text-slate-500 tabular-nums">índice {nf(c.index_price, 2)}</div>
                </div>
                <div className="flex flex-col items-end gap-1">
                  <span className={`badge ring-1 ${cls}`}>{label}</span>
                  <span className={`text-[11px] font-semibold ${c.feed_ok ? 'text-emerald-600' : 'text-rose-600'}`}>
                    {c.feed_ok ? `● feed ok · hace ${c.last_tick_ago_s ?? '—'} s` : '● feed caído'}
                  </span>
                </div>
              </div>
              {c.status_reason && <p className="border-b border-slate-100 bg-amber-50 px-4 py-2 text-xs text-amber-900">{c.status_reason}</p>}
              <dl className="grid grid-cols-2 gap-x-3 gap-y-2 px-4 py-3 text-xs">
                <Row k="Long abierto" v={usd(c.long_notional)} />
                <Row k="Short abierto" v={usd(c.short_notional)} />
                <Row k="Posición neta de la casa" v={usd(c.house_net)} cls={tone(Number(c.house_net))} />
                <Row k="Posiciones · jugadores" v={`${c.positions} · ${c.players}`} />
                <Row k="Funding (mercado)" v={c.funding_rate ? `${nf(Number(c.funding_rate) * 100, 4)} %` : '—'} />
                <Row k="Apalancamiento máx." v={`${c.config.max_leverage}×`} />
              </dl>
              <div className="px-4 pb-3">
                <div className="flex justify-between text-[11px] text-slate-500">
                  <span>Exposición neta</span>
                  <span>
                    {nf(c.exposure_use, 1)} % de {usd(c.max_net_exposure)}
                  </span>
                </div>
                <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-slate-100">
                  <div className={`h-full ${c.exposure_use >= 80 ? 'bg-rose-500' : c.exposure_use >= 50 ? 'bg-amber-500' : 'bg-sky-500'}`} style={{ width: `${Math.min(c.exposure_use, 100)}%` }} />
                </div>
                <details className="mt-2 text-[11px] text-slate-500">
                  <summary className="cursor-pointer">Fuentes del índice ({Object.keys(c.sources).length})</summary>
                  <div className="mt-1 grid grid-cols-2 gap-x-2">
                    {Object.entries(c.sources).map(([k, v]) => (
                      <span key={k} className="tabular-nums">
                        {k}: {nf(v as string, 2)}
                      </span>
                    ))}
                  </div>
                </details>
              </div>
              {isAdmin && (
                <div className="grid grid-cols-3 gap-1.5 border-t border-slate-100 p-3">
                  <button className="btn-ghost px-2 py-1.5 text-xs" onClick={() => setEdit(c)}>
                    Configurar
                  </button>
                  {c.status === 'ACTIVE' ? (
                    <>
                      <button className="btn-ghost px-2 py-1.5 text-xs" onClick={() => setStatus({ symbol: c.symbol, status: 'CLOSE_ONLY' })}>
                        Solo cerrar
                      </button>
                      <button className="btn-danger px-2 py-1.5 text-xs" onClick={() => setStatus({ symbol: c.symbol, status: 'PAUSED' })}>
                        Pausar
                      </button>
                    </>
                  ) : (
                    <button className="btn-primary col-span-2 px-2 py-1.5 text-xs" onClick={() => setStatus({ symbol: c.symbol, status: 'ACTIVE' })}>
                      Reanudar
                    </button>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </section>

      <section className="card overflow-hidden">
        <div className="flex gap-1 overflow-x-auto border-b border-slate-100 px-3 pt-2">
          {(
            [
              ['positions', 'Posiciones abiertas'],
              ['liquidations', 'Liquidaciones'],
              ['fills', 'Operaciones'],
              ['incidents', 'Incidencias'],
            ] as const
          ).map(([k, l]) => (
            <button key={k} onClick={() => setTab(k)} className={`shrink-0 px-3 py-2 text-sm font-medium ${tab === k ? 'border-b-2 border-sky-600 text-slate-900' : 'text-slate-500'}`}>
              {l}
            </button>
          ))}
        </div>
        <div className="overflow-x-auto">
          {tab === 'positions' && <PositionsTable />}
          {tab === 'liquidations' && <LiquidationsTable />}
          {tab === 'fills' && <FillsTable />}
          {tab === 'incidents' && <IncidentsTable />}
        </div>
      </section>

      <Modal open={!!edit} onClose={() => setEdit(null)} title={`Configurar ${edit?.symbol ?? ''}`}>
        {edit && <ContractForm c={edit} onDone={() => setEdit(null)} />}
      </Modal>
      <Modal open={!!status} onClose={() => setStatus(null)} title={status ? `${STATUS[status.status][0]} · ${status.symbol}` : ''}>
        {status && <StatusForm s={status} onDone={() => setStatus(null)} />}
      </Modal>
      <Modal open={settings} onClose={() => setSettings(false)} title="Capital y pérdida máxima de la casa">
        <SettingsForm s={o.settings} onDone={() => setSettings(false)} />
      </Modal>
    </div>
  );
}

function Kpi({ label, value, sub, cls = 'text-slate-900' }: { label: string; value: string; sub?: string; cls?: string }) {
  return (
    <div className="card p-4">
      <div className="text-xs font-medium text-slate-500">{label}</div>
      <div className={`mt-1 text-xl font-bold tabular-nums ${cls}`}>{value}</div>
      {sub && <div className="mt-0.5 text-[11px] text-slate-400">{sub}</div>}
    </div>
  );
}

function Row({ k, v, cls = 'text-slate-900' }: { k: string; v: string; cls?: string }) {
  return (
    <div>
      <dt className="text-slate-500">{k}</dt>
      <dd className={`font-semibold tabular-nums ${cls}`}>{v}</dd>
    </div>
  );
}

function PositionsTable() {
  const q = useQuery({ queryKey: ['admin', 'futures', 'positions'], queryFn: () => get<any[]>('/admin/futures/positions'), refetchInterval: 3000 });
  if (!q.data) return <Spinner />;
  if (!q.data.length) return <p className="p-6 text-center text-sm text-slate-400">No hay posiciones abiertas.</p>;
  return (
    <table className="w-full text-xs">
      <thead className="bg-slate-50 text-left text-slate-500">
        <tr>
          {['Jugador', 'Contrato', 'Lado', 'Tamaño', 'Entrada', 'Marca', 'Liquidación', 'Margen', 'Uso', 'PnL'].map((h) => (
            <th key={h} className="px-3 py-2 font-medium">
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody className="divide-y divide-slate-100">
        {q.data.map((p) => (
          <tr key={p.id}>
            <td className="px-3 py-2">{p.email}</td>
            <td className="px-3 py-2 font-semibold">{p.symbol}</td>
            <td className={`px-3 py-2 font-semibold ${p.side === 'LONG' ? 'text-emerald-600' : 'text-rose-600'}`}>
              {p.side === 'LONG' ? 'Long' : 'Short'} {p.leverage}× {p.margin_mode === 'ISOLATED' ? 'A' : 'C'}
            </td>
            <td className="px-3 py-2 tabular-nums">{Number(p.qty)}</td>
            <td className="px-3 py-2 tabular-nums">{nf(p.entry_price)}</td>
            <td className="px-3 py-2 tabular-nums">{nf(p.mark_price)}</td>
            <td className="px-3 py-2 tabular-nums text-rose-600">{nf(p.liquidation_price)}</td>
            <td className="px-3 py-2 tabular-nums">{nf(p.margin)}</td>
            <td className={`px-3 py-2 tabular-nums ${p.margin_ratio >= 80 ? 'font-bold text-rose-600' : ''}`}>{nf(p.margin_ratio, 1)} %</td>
            <td className={`px-3 py-2 font-semibold tabular-nums ${tone(Number(p.unrealized_pnl))}`}>{nf(p.unrealized_pnl)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function LiquidationsTable() {
  const q = useQuery({ queryKey: ['admin', 'futures', 'liquidations'], queryFn: () => get<any[]>('/admin/futures/liquidations') });
  if (!q.data) return <Spinner />;
  if (!q.data.length) return <p className="p-6 text-center text-sm text-slate-400">Sin liquidaciones.</p>;
  return (
    <table className="w-full text-xs">
      <thead className="bg-slate-50 text-left text-slate-500">
        <tr>
          {['Fecha', 'Jugador', 'Contrato', 'Entrada → marca', 'Margen', 'Pérdida', 'Tarifa', 'Devuelto', 'Absorbido', 'Tick (verificación)'].map((h) => (
            <th key={h} className="px-3 py-2 font-medium">
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody className="divide-y divide-slate-100">
        {q.data.map((l) => (
          <tr key={l.id}>
            <td className="px-3 py-2">{dateTime(l.created_at)}</td>
            <td className="px-3 py-2">{l.email}</td>
            <td className="px-3 py-2 font-semibold">
              {l.symbol} {l.side === 'LONG' ? 'L' : 'S'} {Number(l.qty)}
            </td>
            <td className="px-3 py-2 tabular-nums">
              {nf(l.entry_price)} → {nf(l.mark_price)}
            </td>
            <td className="px-3 py-2 tabular-nums">{nf(Number(l.margin) / 1e6)}</td>
            <td className="px-3 py-2 tabular-nums">{nf(Number(l.loss) / 1e6)}</td>
            <td className="px-3 py-2 tabular-nums">{nf(Number(l.fee) / 1e6)}</td>
            <td className="px-3 py-2 tabular-nums">{nf(Number(l.returned) / 1e6)}</td>
            <td className="px-3 py-2 tabular-nums">{nf(Number(l.absorbed) / 1e6)}</td>
            <td className="px-3 py-2 text-[10px] text-slate-500" title={JSON.stringify(l.tick_sources)}>
              #{l.price_tick_id} · índice {nf(l.tick_index)} · {Object.keys(l.tick_sources ?? {}).length} fuentes
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function FillsTable() {
  const q = useQuery({ queryKey: ['admin', 'futures', 'fills'], queryFn: () => get<any[]>('/admin/futures/fills'), refetchInterval: 5000 });
  if (!q.data) return <Spinner />;
  if (!q.data.length) return <p className="p-6 text-center text-sm text-slate-400">Sin operaciones.</p>;
  return (
    <table className="w-full text-xs">
      <thead className="bg-slate-50 text-left text-slate-500">
        <tr>
          {['Fecha', 'Jugador', 'Contrato', 'Tipo', 'Cantidad', 'Precio', 'Nocional', 'Comisión', 'PnL realizado', 'Tick'].map((h) => (
            <th key={h} className="px-3 py-2 font-medium">
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody className="divide-y divide-slate-100">
        {q.data.map((f) => (
          <tr key={f.id}>
            <td className="px-3 py-2">{dateTime(f.created_at)}</td>
            <td className="px-3 py-2">{f.email}</td>
            <td className={`px-3 py-2 font-semibold ${f.side === 'BUY' ? 'text-emerald-600' : 'text-rose-600'}`}>
              {f.symbol} {f.side === 'BUY' ? 'compra' : 'venta'}
            </td>
            <td className="px-3 py-2">
              {f.type} · {f.liquidity.toLowerCase()}
            </td>
            <td className="px-3 py-2 tabular-nums">{Number(f.qty)}</td>
            <td className="px-3 py-2 tabular-nums">{nf(f.price)}</td>
            <td className="px-3 py-2 tabular-nums">{nf(Number(f.notional) / 1e6)}</td>
            <td className="px-3 py-2 tabular-nums">{nf(Number(f.fee) / 1e6, 4)}</td>
            <td className={`px-3 py-2 tabular-nums ${tone(Number(f.realized_pnl))}`}>{nf(Number(f.realized_pnl) / 1e6, 4)}</td>
            <td className="px-3 py-2 text-slate-400">#{f.price_tick_id ?? '—'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function IncidentsTable() {
  const q = useQuery({ queryKey: ['admin', 'futures', 'incidents'], queryFn: () => get<any[]>('/admin/futures/incidents') });
  if (!q.data) return <Spinner />;
  if (!q.data.length) return <p className="p-6 text-center text-sm text-slate-400">Sin incidencias.</p>;
  return (
    <ul className="divide-y divide-slate-100 text-xs">
      {q.data.map((i) => (
        <li key={i.id} className="flex gap-3 px-4 py-2">
          <span className="w-36 shrink-0 text-slate-500">{dateTime(i.created_at)}</span>
          <span className="w-24 shrink-0 font-semibold">{i.kind}</span>
          <span className="flex-1">
            {i.symbol && <b>{i.symbol} · </b>}
            {i.description}
            {i.email && <span className="text-slate-400"> · {i.email}</span>}
          </span>
        </li>
      ))}
    </ul>
  );
}

function ContractForm({ c, onDone }: { c: any; onDone: () => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState({
    maxLeverage: c.config.max_leverage,
    defaultLeverage: c.config.default_leverage,
    takerFee: c.config.taker_fee,
    makerFee: c.config.maker_fee,
    liquidationFee: c.config.liquidation_fee,
    maxNetExposure: Number(c.max_net_exposure),
    brackets: c.config.brackets.map((b: any) => ({ cap: b.cap, maxLeverage: b.max_leverage, mmr: b.mmr })),
  });
  const m = useMutation({
    mutationFn: () => put(`/admin/futures/contracts/${c.symbol}`, f),
    onSuccess: () => (qc.invalidateQueries({ queryKey: ['admin', 'futures'] }), onDone()),
  });
  const num = (k: keyof typeof f) => (
    <input className="input tabular-nums" inputMode="decimal" value={String(f[k])} onChange={(e) => setF({ ...f, [k]: Number(e.target.value) })} />
  );
  return (
    <div className="space-y-3 text-sm">
      <div className="grid grid-cols-2 gap-2">
        <label>
          <span className="label">Apalancamiento máximo</span>
          {num('maxLeverage')}
        </label>
        <label>
          <span className="label">Por defecto</span>
          {num('defaultLeverage')}
        </label>
        <label>
          <span className="label">Comisión taker (%)</span>
          {num('takerFee')}
        </label>
        <label>
          <span className="label">Comisión maker (%)</span>
          {num('makerFee')}
        </label>
        <label>
          <span className="label">Tarifa de liquidación (%)</span>
          {num('liquidationFee')}
        </label>
        <label>
          <span className="label">Exposición neta máx. (USDT)</span>
          {num('maxNetExposure')}
        </label>
      </div>
      <div>
        <div className="label">Tramos (nocional hasta · apalancamiento · mantenimiento %)</div>
        {f.brackets.map((b: any, i: number) => (
          <div key={i} className="mb-1.5 grid grid-cols-3 gap-1.5">
            {(['cap', 'maxLeverage', 'mmr'] as const).map((k) => (
              <input
                key={k}
                className="input tabular-nums"
                inputMode="decimal"
                value={String(b[k])}
                aria-label={`Tramo ${i + 1} ${k}`}
                onChange={(e) => setF({ ...f, brackets: f.brackets.map((x: any, j: number) => (j === i ? { ...x, [k]: Number(e.target.value) } : x)) })}
              />
            ))}
          </div>
        ))}
        <p className="text-[11px] text-slate-500">El monto de mantenimiento (cum) se recalcula solo para que el mantenimiento sea continuo entre tramos.</p>
      </div>
      <Notice tone="warn">Los cambios aplican a órdenes nuevas y al cálculo de liquidación de las posiciones abiertas. Quedan en auditoría.</Notice>
      <ErrorBox error={m.error} />
      <button className="btn-primary w-full" disabled={m.isPending} onClick={() => m.mutate()}>
        Guardar configuración
      </button>
    </div>
  );
}

function StatusForm({ s, onDone }: { s: { symbol: string; status: string }; onDone: () => void }) {
  const qc = useQueryClient();
  const [reason, setReason] = useState('');
  const m = useMutation({
    mutationFn: () => post(`/admin/futures/contracts/${s.symbol}/status`, { status: s.status, reason }),
    onSuccess: () => (qc.invalidateQueries({ queryKey: ['admin', 'futures'] }), onDone()),
  });
  return (
    <div className="space-y-3 text-sm">
      <p className="text-slate-600">
        {s.status === 'PAUSED'
          ? 'Pausa total: no se aceptan órdenes nuevas. Las liquidaciones siguen funcionando si hay feed.'
          : s.status === 'CLOSE_ONLY'
            ? 'Solo cerrar: los jugadores pueden reducir o cerrar posiciones, pero no abrir nuevas.'
            : 'Reanudar: vuelve a aceptar posiciones nuevas.'}
      </p>
      <input className="input" placeholder="Motivo (queda como incidencia)" value={reason} onChange={(e) => setReason(e.target.value)} />
      <ErrorBox error={m.error} />
      <button className="btn-primary w-full" disabled={reason.length < 3 || m.isPending} onClick={() => m.mutate()}>
        Confirmar
      </button>
    </div>
  );
}

function SettingsForm({ s, onDone }: { s: any; onDone: () => void }) {
  const qc = useQueryClient();
  const [capital, setCapital] = useState(Number(s.house_capital));
  const [limit, setLimit] = useState(Number(s.daily_loss_limit));
  const m = useMutation({
    mutationFn: () => put('/admin/futures/settings', { houseCapital: capital, dailyLossLimit: limit }),
    onSuccess: () => (qc.invalidateQueries({ queryKey: ['admin', 'futures'] }), onDone()),
  });
  return (
    <div className="space-y-3 text-sm">
      <label className="block">
        <span className="label">Capital asignado a futuros (USDT)</span>
        <input className="input tabular-nums" inputMode="decimal" value={capital} onChange={(e) => setCapital(Number(e.target.value))} />
      </label>
      <label className="block">
        <span className="label">Pérdida máxima diaria (% del capital)</span>
        <input className="input tabular-nums" inputMode="decimal" value={limit} onChange={(e) => setLimit(Number(e.target.value))} />
      </label>
      <p className="text-xs text-slate-500">Si la casa pierde más que esto en el día, todos los contratos pasan a «solo cerrar» automáticamente.</p>
      <ErrorBox error={m.error} />
      <button className="btn-primary w-full" disabled={m.isPending} onClick={() => m.mutate()}>
        Guardar
      </button>
    </div>
  );
}
