import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { BetSlipView } from '../components/BetSlipView';
import { TicketView } from '../components/TicketView';
import { Empty, Modal, PageTitle, Spinner, StatusBadge } from '../components/ui';
import { get } from '../lib/api';
import { Currency, dateTime, money, TICKET_STATUS_LABEL } from '../lib/format';
import { showOdds, SLIP_STATUS_LABEL, SPORT_ICON, useCatalog } from '../lib/sports';

export function TicketsPage() {
  const [tab, setTab] = useState<'lottery' | 'sports'>('lottery');
  return (
    <div>
      <PageTitle
        actions={
          <div className="flex rounded-xl bg-black/5 p-1 text-sm">
            {(['lottery', 'sports'] as const).map((t) => (
              <button key={t} onClick={() => setTab(t)} className={`rounded-lg px-3 py-1 ${tab === t ? 'bg-white font-semibold shadow-sm' : 'text-black/60'}`}>
                {t === 'lottery' ? '🦁 Animalitos' : '⚽ Deportes'}
              </button>
            ))}
          </div>
        }
      >
        Mis jugadas
      </PageTitle>
      {tab === 'lottery' ? <LotteryTickets /> : <SportsBets />}
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
                <span key={p.id} title={`${p.number} ${p.name}`} className={p.status === 'WON' ? 'rounded bg-oro-300' : ''}>
                  {p.emoji}
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

function SportsBets() {
  const catalog = useCatalog();
  const bets = useQuery({ queryKey: ['sports', 'bets'], queryFn: () => get<any[]>('/sports/bets'), refetchInterval: 60_000 });
  const [openId, setOpenId] = useState<string | null>(null);
  const open = bets.data?.find((b) => b.id === openId);
  if (bets.isLoading) return <Spinner />;
  if (!bets.data?.length) {
    return (
      <Empty>
        Aún no tienes apuestas deportivas. <Link to="/deportes" className="font-semibold text-selva-700">Ver partidos</Link>
      </Empty>
    );
  }
  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {bets.data.map((b) => {
          const cur = b.currency as Currency;
          return (
            <button key={b.id} onClick={() => setOpenId(b.id)} className="card p-4 text-left transition hover:ring-selva-600">
              <div className="flex items-start justify-between">
                <div>
                  <div className="font-mono font-bold tracking-wider">{b.code}</div>
                  <div className="text-xs text-black/50">
                    {b.type === 'PARLAY' ? `Combinada ×${b.legs.length}` : 'Simple'} · {dateTime(b.placed_at)}
                  </div>
                </div>
                <StatusBadge status={b.status} label={SLIP_STATUS_LABEL[b.status]} />
              </div>
              <ul className="mt-2 space-y-0.5 text-sm">
                {b.legs.slice(0, 3).map((l: any) => (
                  <li key={l.id} className="flex justify-between gap-2">
                    <span className="truncate">
                      {SPORT_ICON[l.sport]} {l.selection}
                    </span>
                    <span className={`tabular-nums ${l.result === 'WIN' ? 'text-emerald-700' : l.result === 'LOSE' ? 'text-red-700 line-through' : l.result === 'VOID' ? 'text-black/40' : ''}`}
                      title={l.result === 'VOID' ? 'Anulada: cuenta como 1.00' : undefined}
                    >
                      {showOdds(l.odds_taken)}
                    </span>
                  </li>
                ))}
                {b.legs.length > 3 && <li className="text-xs text-black/40">+{b.legs.length - 3} más</li>}
              </ul>
              <div className="mt-2 flex justify-between text-sm">
                <span className="text-black/60">{money(b.stake, cur)}</span>
                {b.status === 'OPEN' ? (
                  <span className="text-black/60">Paga {money(b.potential_payout, cur)}</span>
                ) : (
                  b.status !== 'LOST' && <span className="font-bold text-selva-700">+{money(b.payout, cur)}</span>
                )}
              </div>
            </button>
          );
        })}
      </div>
      <Modal open={!!open} onClose={() => setOpenId(null)} title="Detalle de la apuesta">
        {open && <BetSlipView slip={open} catalog={catalog.data} />}
      </Modal>
    </>
  );
}
