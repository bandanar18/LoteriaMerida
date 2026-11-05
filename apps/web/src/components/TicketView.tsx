import { useMutation, useQueryClient } from '@tanstack/react-query';
import { post } from '../lib/api';
import { Currency, dateTime, DRAW_STATUS_LABEL, hour, money, TICKET_STATUS_LABEL } from '../lib/format';
import { ErrorBox, StatusBadge } from './ui';

export function TicketView({ ticket, onChange }: { ticket: any; onChange?: (t: any) => void }) {
  const qc = useQueryClient();
  const cur = ticket.currency as Currency;
  const cancel = useMutation({
    mutationFn: () => post(`/lottery/tickets/${ticket.id}/cancel`),
    onSuccess: (t) => {
      qc.invalidateQueries({ queryKey: ['balances'] });
      qc.invalidateQueries({ queryKey: ['tickets'] });
      onChange?.(t);
    },
  });

  return (
    <div className="space-y-3">
      <div className="rounded-2xl border-2 border-dashed border-selva-700/30 bg-selva-900/[0.02] p-4">
        <div className="flex items-start justify-between gap-2">
          <div>
            <div className="text-xs text-black/50">{ticket.game_name}</div>
            <div className="font-mono text-lg font-bold tracking-widest">{ticket.code}</div>
            <div className="text-xs text-black/50">
              Verificación: <span className="font-mono">{ticket.verify_code}</span> · {dateTime(ticket.sold_at)}
            </div>
          </div>
          <StatusBadge status={ticket.status} label={TICKET_STATUS_LABEL[ticket.status]} />
        </div>
        <ul className="mt-3 divide-y divide-black/5 text-sm">
          {ticket.plays.map((p: any) => (
            <li key={p.id} className="flex items-center gap-2 py-1.5">
              <span className="text-lg">{p.emoji}</span>
              <div className="flex-1">
                <span className="font-medium">
                  {p.number} {p.name}
                </span>
                <span className="ml-2 text-xs text-black/50">
                  {hour(p.draw_at)} · {DRAW_STATUS_LABEL[p.draw_status]}
                </span>
              </div>
              <span className="tabular-nums">{money(p.amount, cur)}</span>
              {p.status === 'WON' && <span className="badge bg-oro-300 text-selva-950">+{money(p.win, cur)}</span>}
              {p.status === 'LOST' && <span className="badge bg-black/5 text-black/50">✗</span>}
              {p.status === 'VOID' && <span className="badge bg-black/5 text-black/50">anulada</span>}
            </li>
          ))}
        </ul>
        <div className="mt-2 flex justify-between border-t border-black/10 pt-2 text-sm">
          <span>Total</span>
          <span className="font-bold tabular-nums">{money(ticket.total, cur)}</span>
        </div>
        {ticket.status === 'WON' ? (
          <div className="flex justify-between text-sm font-bold text-selva-700">
            <span>Premio acreditado</span>
            <span className="tabular-nums">{money(ticket.total_win, cur)}</span>
          </div>
        ) : (
          <div className="flex justify-between text-sm text-black/60">
            <span>Premio máximo</span>
            <span className="tabular-nums">{money(ticket.potential_win, cur)}</span>
          </div>
        )}
        {ticket.license_ref && <p className="mt-2 text-[11px] text-black/40">{ticket.license_ref}</p>}
      </div>
      <ErrorBox error={cancel.error} />
      {ticket.cancellable && (
        <button className="btn-ghost w-full" disabled={cancel.isPending} onClick={() => cancel.mutate()}>
          Anular ticket (reembolso inmediato)
        </button>
      )}
    </div>
  );
}
