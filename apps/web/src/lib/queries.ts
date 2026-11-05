import { useQuery } from '@tanstack/react-query';
import { get } from './api';
import { Currency, syncServerClock } from './format';

export interface Symbol {
  id: string;
  number: string;
  name: string;
  emoji: string;
  sort: number;
}

export interface Game {
  id: string;
  code: string;
  name: string;
  result_source: 'INTERNAL_RNG' | 'MANUAL' | 'OFFICIAL_FEED';
  payout_multiplier: string;
  close_minutes_before: number;
  cancel_window_minutes: number;
  license_ref: string;
  symbols: Symbol[];
  limits: { currency: Currency; min_play: string; max_play: string; max_ticket: string; max_liability_per_symbol: string }[];
  schedule: { time: string }[];
}

export interface Draw {
  id: string;
  game_id: string;
  draw_at: string;
  close_at: string;
  status: string;
  is_extraordinary: boolean;
  seed_hash: string;
  server_seed: string | null;
  result_symbol_id: string | null;
  result_number: string | null;
  result_name: string | null;
  result_emoji: string | null;
  server_now: string;
}

export interface Balance {
  currency: Currency;
  cash: string;
  locked: string;
}

export const useGames = () => useQuery({ queryKey: ['games'], queryFn: () => get<Game[]>('/lottery/games'), staleTime: 300_000 });

export const useDraws = (gameId: string | undefined, date?: string) =>
  useQuery({
    queryKey: ['draws', gameId, date],
    enabled: !!gameId,
    refetchInterval: 60_000,
    queryFn: async () => {
      const rows = await get<Draw[]>(`/lottery/games/${gameId}/draws${date ? `?date=${date}` : ''}`);
      syncServerClock(rows[0]?.server_now);
      return rows;
    },
  });

export const useBalances = (enabled: boolean) =>
  useQuery({ queryKey: ['balances'], enabled, refetchInterval: 60_000, queryFn: () => get<Balance[]>('/me/balances') });

export const usePlatform = () =>
  useQuery({ queryKey: ['platform'], staleTime: Infinity, queryFn: () => get<{ licenseLabel: string }>('/platform') });
