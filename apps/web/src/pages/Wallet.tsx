import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FormEvent, useState } from 'react';
import { ErrorBox, Notice, PageTitle, StatusBadge } from '../components/ui';
import { get, post } from '../lib/api';
import { Currency, dateTime, money, normalizeAmount } from '../lib/format';
import { useBalances } from '../lib/queries';
import { DemoNotice } from '../components/Demo';
import { useLocation } from 'react-router-dom';

const TX_LABEL: Record<string, string> = {
  DEPOSIT: 'Depósito',
  BET_PLACED: 'Compra de ticket',
  BET_CANCELLED: 'Ticket anulado',
  BET_WON: 'Premio',
  BET_LOST: 'Jugada no ganadora',
  BET_VOID: 'Jugada reembolsada',
  WITHDRAWAL_REQUESTED: 'Retiro solicitado',
  WITHDRAWAL_PAID: 'Retiro pagado',
  WITHDRAWAL_REJECTED: 'Retiro rechazado',
};

const STATUS_LABEL: Record<string, string> = {
  PENDING: 'En revisión',
  APPROVED: 'Acreditado',
  REJECTED: 'Rechazado',
  REQUESTED: 'En proceso',
  PAID: 'Pagado',
};

export function WalletPage() {
  const balances = useBalances(true);
  const [tab, setTab] = useState<'deposit' | 'withdraw' | 'history'>('deposit');
  const welcome = !!(useLocation().state as { welcome?: boolean } | null)?.welcome;

  return (
    <div className="space-y-4">
      <PageTitle>Billetera</PageTitle>
      {welcome && (
        <div className="rounded-2xl bg-gradient-to-r from-selva-700 to-selva-600 px-4 py-3 text-white">
          <div className="text-lg font-extrabold">🎁 ¡Bienvenido a Fortuna.Bet!</div>
          <p className="text-sm text-white/85">
            Te acreditamos tu bono de bienvenida DEMO: <b>Bs. 10.000</b> y <b>10 USDT</b> de saldo de prueba. No tiene valor real y no se puede cobrar.
          </p>
        </div>
      )}
      <DemoNotice />
      <div className="grid gap-3 sm:grid-cols-2">
        {balances.data?.map((b) => (
          <div key={b.currency} className="card bg-gradient-to-br from-selva-800 to-selva-700 p-5 text-white">
            <div className="text-xs text-white/60">{b.currency === 'VES' ? 'Bolívares' : 'Tether (USDT)'}</div>
            <div className="mt-1 text-3xl font-bold tabular-nums">{money(b.cash, b.currency)}</div>
            {BigInt(b.locked) > 0n && <div className="mt-1 text-xs text-oro-300">En retiro: {money(b.locked, b.currency)}</div>}
          </div>
        ))}
      </div>
      <div className="flex gap-1 rounded-xl bg-black/5 p-1 [.player-dark_&]:bg-white/10">
        {(
          [
            ['deposit', 'Depositar'],
            ['withdraw', 'Retirar'],
            ['history', 'Movimientos'],
          ] as const
        ).map(([k, label]) => (
          <button key={k} onClick={() => setTab(k)} className={`flex-1 rounded-lg py-2 text-sm font-semibold ${tab === k ? 'bg-white text-selva-900 shadow-sm' : 'text-(--muted)'}`}>
            {label}
          </button>
        ))}
      </div>
      {tab === 'deposit' && <DepositTab />}
      {tab === 'withdraw' && <WithdrawTab />}
      {tab === 'history' && <HistoryTab />}
    </div>
  );
}

function DepositTab() {
  const qc = useQueryClient();
  const methods = useQuery({ queryKey: ['methods'], queryFn: () => get<any[]>('/payments/methods'), staleTime: Infinity });
  const deposits = useQuery({ queryKey: ['deposits'], queryFn: () => get<any[]>('/payments/deposits'), refetchInterval: 60_000 });
  const [method, setMethod] = useState('PAGO_MOVIL');
  const [form, setForm] = useState({ amount: '', bank: '', reference: '', payerPhone: '' });
  const m = methods.data?.find((x) => x.code === method);
  const create = useMutation({
    mutationFn: () =>
      post('/payments/deposits', {
        method,
        amount: normalizeAmount(form.amount),
        bank: method === 'USDT' ? m?.payTo.network : form.bank,
        reference: form.reference.trim(),
        ...(method !== 'USDT' && form.payerPhone ? { payerPhone: form.payerPhone } : {}),
      }),
    onSuccess: () => {
      setForm({ amount: '', bank: '', reference: '', payerPhone: '' });
      qc.invalidateQueries({ queryKey: ['deposits'] });
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    create.mutate();
  };

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <form onSubmit={submit} className="card space-y-3 p-4">
        <div className="flex gap-2">
          {methods.data?.map((x) => (
            <button
              type="button"
              key={x.code}
              onClick={() => setMethod(x.code)}
              className={`btn flex-1 px-2 text-xs ${method === x.code ? 'bg-selva-700 text-white' : 'bg-black/5'}`}
            >
              {x.label}
            </button>
          ))}
        </div>
        {m && (
          <div className="rounded-xl bg-oro-300/30 p-3 text-sm">
            <div className="mb-1 font-semibold">1. Paga a estos datos</div>
            {method === 'USDT' ? (
              <>
                <div>Red: {m.payTo.network}</div>
                <div className="font-mono text-xs break-all">{m.payTo.address}</div>
              </>
            ) : (
              <>
                <div>Banco: {m.payTo.bank}</div>
                <div>Teléfono: {m.payTo.phone}</div>
                <div>RIF/CI: {m.payTo.document}</div>
              </>
            )}
          </div>
        )}
        <div className="text-sm font-semibold">2. Reporta tu pago</div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label">Monto ({m?.currency})</label>
            <input className="input" inputMode="decimal" required value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} />
          </div>
          {method !== 'USDT' && (
            <div>
              <label className="label">Banco de origen</label>
              <input className="input" required placeholder="0102, Mercantil…" value={form.bank} onChange={(e) => setForm({ ...form, bank: e.target.value })} />
            </div>
          )}
        </div>
        <div>
          <label className="label">{method === 'USDT' ? 'Hash de la transacción' : 'Número de referencia'}</label>
          <input className="input font-mono" required value={form.reference} onChange={(e) => setForm({ ...form, reference: e.target.value })} />
        </div>
        {method !== 'USDT' && (
          <div>
            <label className="label">Teléfono de origen (opcional)</label>
            <input className="input" type="tel" value={form.payerPhone} onChange={(e) => setForm({ ...form, payerPhone: e.target.value })} />
          </div>
        )}
        <ErrorBox error={create.error} />
        {create.isSuccess && <Notice tone="success">Pago reportado. Lo acreditaremos al verificarlo.</Notice>}
        <button className="btn-primary w-full" disabled={create.isPending}>
          Reportar pago
        </button>
      </form>
      <div className="card p-4">
        <h3 className="mb-2 font-semibold">Mis depósitos</h3>
        <PaymentList rows={deposits.data} render={(d) => `${d.method === 'USDT' ? 'USDT' : d.bank} · ref ${d.reference}`} />
      </div>
    </div>
  );
}

function WithdrawTab() {
  const qc = useQueryClient();
  const withdrawals = useQuery({ queryKey: ['withdrawals'], queryFn: () => get<any[]>('/payments/withdrawals'), refetchInterval: 60_000 });
  const [form, setForm] = useState({ method: 'PAGO_MOVIL', amount: '', bank: '', account: '' });
  const create = useMutation({
    mutationFn: () =>
      post('/payments/withdrawals', {
        ...form,
        amount: normalizeAmount(form.amount),
        bank: form.method === 'USDT' ? 'TRC-20' : form.bank,
      }),
    onSuccess: () => {
      setForm({ ...form, amount: '' });
      qc.invalidateQueries({ queryKey: ['withdrawals'] });
      qc.invalidateQueries({ queryKey: ['balances'] });
    },
  });

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate();
        }}
        className="card space-y-3 p-4"
      >
        <div>
          <label className="label">Método</label>
          <select className="input" value={form.method} onChange={(e) => setForm({ ...form, method: e.target.value })}>
            <option value="PAGO_MOVIL">Pago Móvil (Bs.)</option>
            <option value="TRANSFER">Transferencia (Bs.)</option>
            <option value="USDT">USDT TRC-20</option>
          </select>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label">Monto</label>
            <input className="input" inputMode="decimal" required value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} />
          </div>
          {form.method !== 'USDT' && (
            <div>
              <label className="label">Banco destino</label>
              <input className="input" required value={form.bank} onChange={(e) => setForm({ ...form, bank: e.target.value })} />
            </div>
          )}
        </div>
        <div>
          <label className="label">{form.method === 'USDT' ? 'Dirección de billetera' : form.method === 'PAGO_MOVIL' ? 'Teléfono Pago Móvil' : 'Número de cuenta'}</label>
          <input className="input font-mono" required value={form.account} onChange={(e) => setForm({ ...form, account: e.target.value })} />
        </div>
        <Notice>Los retiros se pagan solo a cuentas a tu nombre. El monto queda bloqueado hasta que se procese.</Notice>
        <ErrorBox error={create.error} />
        {create.isSuccess && <Notice tone="success">Retiro solicitado.</Notice>}
        <button className="btn-primary w-full" disabled={create.isPending}>
          Solicitar retiro
        </button>
      </form>
      <div className="card p-4">
        <h3 className="mb-2 font-semibold">Mis retiros</h3>
        <PaymentList rows={withdrawals.data} render={(w) => `${w.destination.bank} · ${w.destination.account}`} />
      </div>
    </div>
  );
}

function PaymentList({ rows, render }: { rows?: any[]; render: (r: any) => string }) {
  if (!rows?.length) return <p className="py-6 text-center text-sm text-black/40">Sin registros.</p>;
  return (
    <ul className="divide-y divide-black/5 text-sm">
      {rows.map((r) => (
        <li key={r.id} className="flex items-center justify-between gap-2 py-2">
          <div>
            <div className="font-semibold tabular-nums">{money(r.amount, r.currency as Currency)}</div>
            <div className="text-xs text-black/50">
              {render(r)} · {dateTime(r.created_at)}
            </div>
            {r.reject_reason && <div className="text-xs text-red-600">{r.reject_reason}</div>}
          </div>
          <StatusBadge status={r.status} label={STATUS_LABEL[r.status]} />
        </li>
      ))}
    </ul>
  );
}

function HistoryTab() {
  const tx = useQuery({ queryKey: ['transactions'], queryFn: () => get<any[]>('/me/transactions?limit=100') });
  if (!tx.data?.length) return <p className="py-6 text-center text-sm text-black/40">Sin movimientos.</p>;
  return (
    <div className="card overflow-x-auto">
      <table className="table-base">
        <thead>
          <tr>
            <th>Fecha</th>
            <th>Concepto</th>
            <th className="text-right">Monto</th>
            <th className="text-right">Saldo</th>
          </tr>
        </thead>
        <tbody>
          {tx.data.map((e) => (
            <tr key={e.id}>
              <td className="whitespace-nowrap text-black/60">{dateTime(e.created_at)}</td>
              <td>
                {TX_LABEL[e.type] ?? e.type}
                {e.account_type === 'PLAYER_LOCKED' && <span className="ml-1 text-xs text-black/40">(bloqueado)</span>}
              </td>
              <td className={`text-right tabular-nums ${e.direction === 'C' ? 'text-emerald-700' : 'text-black/70'}`}>
                {e.direction === 'C' ? '+' : '−'}
                {money(e.amount, e.currency)}
              </td>
              <td className="text-right text-black/60 tabular-nums">{money(e.balance_after, e.currency)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
