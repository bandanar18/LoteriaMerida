import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { TicketView } from '../components/TicketView';
import { Empty, Modal, PageTitle, Spinner, StatusBadge } from '../components/ui';
import { get } from '../lib/api';
import { Currency, dateTime, money, TICKET_STATUS_LABEL } from '../lib/format';
import { NumberBalls, StarBadge, SymbolArt } from '../components/SymbolArt';
import { playedLabel } from '../lib/queries';

export function TicketsPage() {
  return (
    <div>
      <PageTitle>Mis jugadas</PageTitle>
      <LotteryTickets />
    </div>
  );
}

function LotteryTickets() {
  const tickets = useQuery({ queryKey: ['tickets'], queryFn: () => get<any[]>('/lottery/tickets'), refetchInterval: 60_000 });
  const [open, setOpen] = useState<any>(null);
  if (tickets.isLoading) return <Spinner />;
  if (!tickets.data?.length) {
    return (
      <Empty>
        Aún no tienes tickets. <Link to="/" className="font-semibold text-selva-700">¡Juega ahora!</Link>
      </Empty>
    );
  }
  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {tickets.data.map((t) => (
          <button key={t.id} onClick={() => setOpen(t)} className="card p-4 text-left transition hover:ring-selva-600">
            <div className="flex items-start justify-between">
              <div>
                <div className="font-mono font-bold tracking-wider">{t.code}</div>
                <div className="text-xs text-black/50">
                  {t.game_name} · {dateTime(t.sold_at)}
                </div>
              </div>
              <StatusBadge status={t.status} label={TICKET_STATUS_LABEL[t.status]} />
            </div>
            <div className="mt-2 flex flex-wrap gap-1 text-xl">
              {t.plays.slice(0, 10).map((p: any) => (
                <span key={p.id} title={p.emoji ? `${p.number} ${p.name}` : `${p.modality_name} ${playedLabel(p.modality, p.number)}`} className={p.status === 'WON' ? 'rounded bg-oro-300' : ''}>
                  {p.selection ? (
                    <span className="inline-flex items-center gap-1">
                      <NumberBalls numbers={p.selection} />
                      {p.star && <StarBadge n={p.star} />}
                    </span>
                  ) : <SymbolArt emoji={p.emoji} number={playedLabel(p.modality, p.number)} />}
                </span>
              ))}
              {t.plays.length > 10 && <span className="text-sm text-black/40">+{t.plays.length - 10}</span>}
            </div>
            <div className="mt-2 flex justify-between text-sm">
              <span className="text-black/60">{money(t.total, t.currency as Currency)}</span>
              {t.status === 'WON' && <span className="font-bold text-selva-700">+{money(t.total_win, t.currency as Currency)}</span>}
            </div>
          </button>
        ))}
      </div>
      <Modal open={!!open} onClose={() => setOpen(null)} title="Detalle del ticket">
        {open && <TicketView ticket={open} onChange={setOpen} />}
      </Modal>
    </>
  );
}
