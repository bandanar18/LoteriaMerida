import { Currency, dateTime, money } from '../lib/format';
import { Catalog, marketName, showOdds, SLIP_STATUS_LABEL, SPORT_ICON } from '../lib/sports';
import { StatusBadge } from './ui';

const LEG_RESULT: Record<string, { label: string; cls: string }> = {
  WIN: { label: 'Ganó', cls: 'text-emerald-700' },
  LOSE: { label: 'Perdió', cls: 'text-red-700' },
  VOID: { label: 'Anulada (1.00)', cls: 'text-black/50' },
};

/** Comprobante de un cupón deportivo. */
export function BetSlipView({ slip, catalog }: { slip: any; catalog?: Catalog }) {
  const cur = slip.currency as Currency;
  return (
    <div className="space-y-3 text-sm">
      <div className="flex items-start justify-between">
        <div>
          <div className="font-mono text-lg font-bold tracking-wider">{slip.code}</div>
          <div className="text-xs text-black/50">
            {slip.type === 'PARLAY' ? `Combinada de ${slip.legs.length}` : 'Simple'} · {dateTime(slip.placed_at)}
            {slip.live && ' · en vivo'}
          </div>
        </div>
        <StatusBadge status={slip.status} label={SLIP_STATUS_LABEL[slip.status]} />
      </div>
      <ul className="divide-y divide-black/5 rounded-xl ring-1 ring-black/10">
        {slip.legs.map((l: any) => (
          <li key={l.id} className="flex items-start justify-between gap-3 p-3">
            <div className="min-w-0">
              <div className="font-semibold">{l.selection}</div>
              <div className="text-xs text-black/50">
                {marketName(catalog, { type: l.type_code, line: l.line })} · {SPORT_ICON[l.sport]} {l.home} vs {l.away}
              </div>
              {l.home_score !== null && (
                <div className="text-xs text-black/50">
                  Marcador: {l.home_score} - {l.away_score}
                </div>
              )}
            </div>
            <div className="shrink-0 text-right">
              <div className="font-bold tabular-nums">{showOdds(l.odds_taken)}</div>
              {l.result && <div className={`text-xs font-semibold ${LEG_RESULT[l.result].cls}`}>{LEG_RESULT[l.result].label}</div>}
            </div>
          </li>
        ))}
      </ul>
      <div className="grid grid-cols-3 gap-2 rounded-xl bg-black/[0.03] p-3">
        <div>
          <div className="text-xs text-black/50">Monto</div>
          <div className="font-semibold tabular-nums">{money(slip.stake, cur)}</div>
        </div>
        <div>
          <div className="text-xs text-black/50">Cuota</div>
          <div className="font-semibold tabular-nums">{showOdds(slip.total_odds)}</div>
        </div>
        <div>
          <div className="text-xs text-black/50">{slip.status === 'OPEN' ? 'Pago potencial' : 'Pagado'}</div>
          <div className="font-bold tabular-nums text-selva-700">{money(slip.status === 'OPEN' ? slip.potential_payout : slip.payout, cur)}</div>
        </div>
      </div>
    </div>
  );
}
