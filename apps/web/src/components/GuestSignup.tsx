import { FormEvent, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { Currency, money } from '../lib/format';
import { usePlatform } from '../lib/queries';
import { clearReferral } from '../lib/referral';
import { useStoredReferral } from '../pages/Auth';
import { ErrorBox } from './ui';

/**
 * Modo invitado (DEMO · Agencias Virtuales): quien llega por el QR de una agencia ve su saldo de bienvenida,
 * arma la jugada sin cuenta y al comprar se registra con el registro lite. El saldo se acredita de verdad
 * (por el ledger) recién al registrarse; antes es solo lo que va a recibir.
 */
export function useGuestBalance() {
  const platform = usePlatform();
  const b = platform.data?.signupBonus;
  return b ? { VES: BigInt(b.VES), USDT: BigInt(b.USDT) } : null;
}

export function GuestWelcome() {
  const balance = useGuestBalance();
  const { agentName } = useStoredReferral();
  if (!balance) return null;
  return (
    <div className="card overflow-hidden">
      <div className="bg-gradient-to-r from-oro-400 to-amber-400 px-4 py-3 text-selva-950">
        {agentName && <p className="text-xs font-bold uppercase tracking-wide">Te invitó: {agentName}</p>}
        <p className="text-lg font-extrabold leading-tight">🎁 Tienes {money(balance.VES, 'VES')} y {money(balance.USDT, 'USDT')} para jugar</p>
        <p className="text-xs font-medium text-selva-950/75">Arma tu jugada; al comprar solo te pedimos 4 datos. Saldo DEMO, sin valor real.</p>
      </div>
    </div>
  );
}

/** Registro lite: nombre, correo, teléfono y contraseña. Al terminar, `onDone` compra el ticket armado. */
export function LiteSignupForm({ currency, onDone }: { currency: Currency; onDone: () => void }) {
  const { registerLite } = useAuth();
  const { code, agentName } = useStoredReferral();
  const [form, setForm] = useState({ fullName: '', email: '', phone: '', password: '' });
  const [accept, setAccept] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await registerLite({ ...form, currency, acceptTerms: true, ...(code ? { referralCode: code } : {}) });
      clearReferral();
      onDone();
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      <p className="text-sm text-black/60">
        Último paso para jugar{agentName ? <> · te invitó <b>{agentName}</b></> : null}. Tu saldo de bienvenida se acredita al crear la cuenta.
      </p>
      <div>
        <label className="label" htmlFor="lite-name">Nombre y apellido</label>
        <input id="lite-name" className="input" autoComplete="name" required minLength={3} value={form.fullName} onChange={set('fullName')} />
      </div>
      <div>
        <label className="label" htmlFor="lite-email">Correo</label>
        <input id="lite-email" className="input" type="email" autoComplete="email" required value={form.email} onChange={set('email')} />
      </div>
      <div>
        <label className="label" htmlFor="lite-phone">Teléfono</label>
        <input id="lite-phone" className="input" type="tel" autoComplete="tel" placeholder="0414-1234567" required value={form.phone} onChange={set('phone')} />
      </div>
      <div>
        <label className="label" htmlFor="lite-pass">Contraseña (mín. 10, letras y números)</label>
        <input id="lite-pass" className="input" type="password" autoComplete="new-password" required minLength={10} value={form.password} onChange={set('password')} />
      </div>
      <label className="flex items-start gap-2 text-sm text-black/70">
        <input type="checkbox" className="mt-1" checked={accept} onChange={(e) => setAccept(e.target.checked)} />
        <span>
          Soy <b>mayor de 18 años</b> y entiendo que es una <b>aplicación DEMO</b>: saldos y premios sin valor real.
        </span>
      </label>
      <ErrorBox error={error} />
      <button className="btn-gold w-full py-3 text-base" disabled={busy || !accept}>
        {busy ? 'Creando cuenta y jugando…' : 'Crear cuenta y jugar'}
      </button>
      <p className="text-center text-sm text-black/60">
        ¿Ya tienes cuenta?{' '}
        <Link to="/login" className="font-semibold text-selva-700">
          Entra
        </Link>
      </p>
    </form>
  );
}
