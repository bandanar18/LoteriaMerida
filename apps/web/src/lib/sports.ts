import { useQuery } from '@tanstack/react-query';
import { get } from './api';
import { Currency, syncServerClock } from './format';

export type SportCode = 'FOOTBALL' | 'BASEBALL' | 'BASKETBALL' | 'ICE_HOCKEY' | 'AMERICAN_FOOTBALL';

export interface Selection {
  id: string;
  code: string;
  name: string;
  odds: string;
  result: 'WIN' | 'LOSE' | 'VOID' | null;
  exposure?: Record<string, { liability: string; stake: string }>;
  bets?: number;
}

export interface Market {
  id: string;
  type: string;
  line: string | null;
  status: 'OPEN' | 'SUSPENDED' | 'CLOSED' | 'SETTLED' | 'VOIDED';
  void_reason: string | null;
  selections: Selection[];
}

export interface SportEvent {
  id: string;
  starts_at: string;
  status: 'NOT_STARTED' | 'LIVE' | 'FINISHED' | 'CANCELLED';
  home_score: number | null;
  away_score: number | null;
  result_status: 'NONE' | 'PROPOSED' | 'CONFIRMED';
  cancelled_reason: string | null;
  competition_id: string;
  competition: string;
  country: string;
  sport: SportCode;
  home: string;
  away: string;
  markets: Market[];
  server_now: string;
  proposed_home?: number;
  proposed_away?: number;
  proposed_evidence?: string;
  proposed_by?: string;
  proposed_by_email?: string;
}

export interface MarketTemplate {
  code: string;
  sport: SportCode;
  name: string;
  line?: 'TOTAL' | 'HANDICAP';
  selections: { code: string; name: string }[];
  rule: string;
}

export interface Catalog {
  sports: { code: string; name: string }[];
  competitions: { id: string; sport_code: string; name: string; country: string }[];
  limits: { currency: Currency; min_stake: string; max_stake: string; max_payout: string; max_total_odds: string }[];
  markets: MarketTemplate[];
  liveBetDelayMs: number;
}

export const SPORT_ICON: Record<string, string> = { FOOTBALL: '⚽', BASEBALL: '⚾', BASKETBALL: '🏀', ICE_HOCKEY: '🏒', AMERICAN_FOOTBALL: '🏈' };

export const EVENT_STATUS_LABEL: Record<string, string> = {
  NOT_STARTED: 'Por comenzar',
  LIVE: 'En vivo',
  FINISHED: 'Finalizado',
  CANCELLED: 'Cancelado',
};

export const SLIP_STATUS_LABEL: Record<string, string> = { OPEN: 'En juego', WON: 'Ganada', LOST: 'Perdida', VOID: 'Anulada' };

export const useCatalog = () => useQuery({ queryKey: ['sports', 'catalog'], staleTime: Infinity, queryFn: () => get<Catalog>('/sports/catalog') });

export const useSportEvents = (sport?: string) =>
  useQuery({
    queryKey: ['sports', 'events', sport ?? 'ALL'],
    refetchInterval: 60_000,
    queryFn: async () => {
      const rows = await get<SportEvent[]>(`/sports/events${sport ? `?sport=${sport}` : ''}`);
      syncServerClock(rows[0]?.server_now);
      return rows;
    },
  });

export function marketName(catalog: Catalog | undefined, m: Pick<Market, 'type' | 'line'>) {
  const t = catalog?.markets.find((x) => x.code === m.type);
  const base = t?.name ?? m.type;
  if (!m.line || t?.line !== 'TOTAL') return base;
  return `${base} ${formatLine(m.line)}`;
}

export function formatLine(line: string) {
  return String(Number(line)); // "2.50" → "2.5" (solo presentación)
}

// ───────────── Cuotas sin flotantes (escala ×10000, igual que el servidor) ─────────────

const SCALE = 10_000n;

export function toOdds(s: string): bigint {
  const [int, frac = ''] = s.split('.');
  return BigInt(int) * SCALE + BigInt(frac.padEnd(4, '0').slice(0, 4));
}

export function showOdds(s: string | bigint): string {
  const v = typeof s === 'bigint' ? s : toOdds(s);
  const int = v / SCALE;
  const frac = (v % SCALE).toString().padStart(4, '0').replace(/0{1,2}$/, '');
  return `${int}.${frac.length < 2 ? frac.padEnd(2, '0') : frac}`;
}

export function combined(odds: string[]): bigint {
  return odds.reduce((acc, o) => (acc * toOdds(o)) / SCALE, SCALE);
}

export function payout(stakeMinor: bigint, odds: string[]): bigint {
  return odds.reduce((acc, o) => acc * toOdds(o), stakeMinor) / SCALE ** BigInt(odds.length);
}
