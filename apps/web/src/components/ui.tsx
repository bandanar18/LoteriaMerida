import { ReactNode, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { ApiError } from '../lib/api';

export function ErrorBox({ error }: { error: unknown }) {
  if (!error) return null;
  const msg = error instanceof ApiError ? error.message : error instanceof Error ? error.message : 'Error inesperado';
  // Errores ligados al nivel KYC: llevar al jugador a verificarse.
  const kyc = error instanceof ApiError && (error.code === 'KYC_REQUIRED' || (error.details as { level?: number })?.level !== undefined);
  return (
    <div className="rounded-xl bg-red-50 px-3 py-2 text-sm text-red-700 ring-1 ring-red-200">
      {msg}
      {kyc && (
        <Link to="/cuenta" className="ml-1 font-semibold underline">
          Verificar mi identidad →
        </Link>
      )}
    </div>
  );
}

export function Notice({ children, tone = 'info' }: { children: ReactNode; tone?: 'info' | 'success' | 'warn' }) {
  const cls = {
    info: 'bg-sky-50 text-sky-800 ring-sky-200',
    success: 'bg-emerald-50 text-emerald-800 ring-emerald-200',
    warn: 'bg-amber-50 text-amber-800 ring-amber-200',
  }[tone];
  return <div className={`rounded-xl px-3 py-2 text-sm ring-1 ${cls}`}>{children}</div>;
}

const STATUS_TONE: Record<string, string> = {
  OPEN: 'bg-emerald-100 text-emerald-800',
  WON: 'bg-oro-300 text-selva-950',
  LOST: 'bg-black/5 text-black/60',
  VOID: 'bg-black/5 text-black/60',
  CANCELLED: 'bg-black/5 text-black/60',
  SCHEDULED: 'bg-sky-100 text-sky-800',
  CLOSED: 'bg-amber-100 text-amber-800',
  RESULT_PENDING: 'bg-orange-100 text-orange-800',
  RESULT_CONFIRMED: 'bg-violet-100 text-violet-800',
  SETTLED: 'bg-selva-700 text-white',
  PENDING: 'bg-amber-100 text-amber-800',
  REQUESTED: 'bg-amber-100 text-amber-800',
  APPROVED: 'bg-emerald-100 text-emerald-800',
  PAID: 'bg-emerald-100 text-emerald-800',
  REJECTED: 'bg-red-100 text-red-700',
  ACTIVE: 'bg-emerald-100 text-emerald-800',
  BLOCKED: 'bg-red-100 text-red-700',
  NOT_STARTED: 'bg-sky-100 text-sky-800',
  LIVE: 'bg-red-600 text-white',
  FINISHED: 'bg-black/5 text-black/60',
  SUSPENDED: 'bg-amber-100 text-amber-800',
  VOIDED: 'bg-black/5 text-black/60',
  PROPOSED: 'bg-orange-100 text-orange-800',
};

export function StatusBadge({ status, label }: { status: string; label?: string }) {
  return <span className={`badge ${STATUS_TONE[status] ?? 'bg-black/5'}`}>{label ?? status}</span>;
}

export function Modal({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: string; children: ReactNode }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-4" onClick={onClose}>
      <div
        className="max-h-[90dvh] w-full overflow-y-auto overscroll-contain rounded-t-3xl bg-white p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] shadow-xl sm:max-w-lg sm:rounded-3xl"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label={title}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="min-w-0 truncate text-lg font-semibold">{title}</h2>
          <button className="btn-ghost px-3 py-1.5" onClick={onClose} aria-label="Cerrar">
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="py-10 text-center text-sm text-black/50">{children}</div>;
}

export function Spinner() {
  return <div className="py-10 text-center text-sm text-black/40">Cargando…</div>;
}

export function PageTitle({ children, actions }: { children: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
      <h1 className="text-xl font-bold text-selva-900">{children}</h1>
      {actions}
    </div>
  );
}
