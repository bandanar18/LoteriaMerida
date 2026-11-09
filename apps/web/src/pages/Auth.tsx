import { FormEvent, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { ErrorBox } from '../components/ui';
import { useAuth } from '../lib/auth';

declare const __DEV_LOGINS__: { label: string; email: string; password: string }[];
/** Inyectado por vite.config.ts solo en `vite dev` (vacío en producción). */
const DEV_LOGINS = import.meta.env.DEV ? __DEV_LOGINS__ : [];

export function LoginPage() {
  const { login } = useAuth();
  const nav = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const user = await login(email, password);
      const from = (location.state as { from?: string } | null)?.from;
      nav(from ?? (user.kind === 'STAFF' ? '/admin' : '/'), { replace: true });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-sm">
      <form onSubmit={submit} className="card space-y-4 p-6">
        <h1 className="text-xl font-bold text-selva-900">Entrar</h1>
        <div>
          <label className="label" htmlFor="email">Correo</label>
          <input id="email" className="input" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </div>
        <div>
          <label className="label" htmlFor="password">Contraseña</label>
          <input id="password" className="input" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        </div>
        <ErrorBox error={error} />
        <button className="btn-primary w-full" disabled={busy}>
          {busy ? 'Entrando…' : 'Entrar'}
        </button>
        {DEV_LOGINS.length > 0 && (
          <div className="rounded-xl border border-dashed border-oro-400 bg-oro-400/10 p-3">
            <p className="mb-2 text-xs font-semibold text-black/60">Solo en desarrollo · usuarios de prueba</p>
            <div className="grid grid-cols-2 gap-2">
              {DEV_LOGINS.map((l) => (
                <button
                  key={l.label}
                  type="button"
                  className="btn bg-white text-selva-900 ring-1 ring-black/10"
                  onClick={() => {
                    setEmail(l.email);
                    setPassword(l.password);
                    setError(null);
                  }}
                >
                  {l.label === 'Administrador' ? '🛠️' : '🎮'} {l.label}
                </button>
              ))}
            </div>
          </div>
        )}
        <p className="text-center text-sm text-black/60">
          ¿No tienes cuenta?{' '}
          <Link to="/registro" className="font-semibold text-selva-700">
            Regístrate
          </Link>
        </p>
      </form>
    </div>
  );
}

const STATES = [
  'Amazonas', 'Anzoátegui', 'Apure', 'Aragua', 'Barinas', 'Bolívar', 'Carabobo', 'Cojedes', 'Delta Amacuro',
  'Distrito Capital', 'Falcón', 'Guárico', 'La Guaira', 'Lara', 'Mérida', 'Miranda', 'Monagas', 'Nueva Esparta',
  'Portuguesa', 'Sucre', 'Táchira', 'Trujillo', 'Yaracuy', 'Zulia',
];

export function RegisterPage() {
  const { register } = useAuth();
  const nav = useNavigate();
  const [form, setForm] = useState({
    firstName: '',
    lastName: '',
    documentType: 'V',
    documentNumber: '',
    birthDate: '',
    phone: '',
    email: '',
    password: '',
    state: 'Distrito Capital',
    city: '',
    currency: 'VES',
  });
  const [accept, setAccept] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { city, ...rest } = form;
      await register(city ? form : rest);
      nav('/billetera', { replace: true });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-lg">
      <form onSubmit={submit} className="card space-y-4 p-6">
        <div>
          <h1 className="text-xl font-bold text-selva-900">Crear cuenta</h1>
          <p className="text-sm text-black/50">Debes ser mayor de 18 años. Una cuenta por persona.</p>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label">Nombre</label>
            <input className="input" required value={form.firstName} onChange={set('firstName')} />
          </div>
          <div>
            <label className="label">Apellido</label>
            <input className="input" required value={form.lastName} onChange={set('lastName')} />
          </div>
        </div>
        <div className="grid grid-cols-[90px_1fr] gap-3">
          <div>
            <label className="label">Documento</label>
            <select className="input" value={form.documentType} onChange={set('documentType')}>
              <option value="V">V</option>
              <option value="E">E</option>
              <option value="P">Pasaporte</option>
            </select>
          </div>
          <div>
            <label className="label">Número</label>
            <input className="input" required inputMode={form.documentType === 'P' ? 'text' : 'numeric'} value={form.documentNumber} onChange={set('documentNumber')} />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label">Fecha de nacimiento</label>
            <input className="input" type="date" required value={form.birthDate} onChange={set('birthDate')} />
          </div>
          <div>
            <label className="label">Teléfono</label>
            <input className="input" type="tel" placeholder="0414-1234567" required value={form.phone} onChange={set('phone')} />
          </div>
        </div>
        <div>
          <label className="label">Correo</label>
          <input className="input" type="email" autoComplete="email" required value={form.email} onChange={set('email')} />
        </div>
        <div>
          <label className="label">Contraseña (mín. 10, letras y números)</label>
          <input className="input" type="password" autoComplete="new-password" required minLength={10} value={form.password} onChange={set('password')} />
        </div>
        <div className="grid grid-cols-3 gap-3">
          <div className="col-span-2">
            <label className="label">Estado</label>
            <select className="input" value={form.state} onChange={set('state')}>
              {STATES.map((s) => (
                <option key={s}>{s}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="label">Moneda</label>
            <select className="input" value={form.currency} onChange={set('currency')}>
              <option value="VES">Bolívares</option>
              <option value="USDT">USDT</option>
            </select>
          </div>
        </div>
        <label className="flex items-start gap-2 text-sm text-black/70">
          <input type="checkbox" className="mt-1" checked={accept} onChange={(e) => setAccept(e.target.checked)} />
          Declaro ser mayor de edad y acepto los términos y la política de juego responsable.
        </label>
        <ErrorBox error={error} />
        <button className="btn-primary w-full" disabled={busy || !accept}>
          {busy ? 'Creando cuenta…' : 'Crear cuenta'}
        </button>
      </form>
    </div>
  );
}
