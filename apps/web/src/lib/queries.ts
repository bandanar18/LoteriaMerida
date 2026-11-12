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

export interface Modality {
  id: string;
  code: 'EXACT' | 'COMBINADA' | 'MULTIPLE' | 'TERMINAL' | 'LAST_DIGIT' | 'FULL' | 'KINO5' | 'KINO6' | 'KINO7' | 'APPROX' | 'SUPER' | 'DUAL' | 'NUMBER' | 'COLOR' | 'PAIR' | 'MATCH5' | 'MATCH4' | 'MATCH3' | 'REVERSED' | 'PARITY';
  name: string;
  min_selections: number;
  max_selections: number | null;
  factor_x100: string;
  status: 'ACTIVE' | 'PENDING_APPROVAL';
  description: string;
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
  rules_version: string;
  is_demo: boolean;
  requires_record: boolean;
  publish_preliminary: boolean;
  prize_expiry_days: number | null;
  board: 'SYMBOLS' | 'DIGITS3' | 'KINO' | 'DIGITS2' | 'COLOR' | 'DIGITS4' | 'DUO';
  draw_count: number;
  modalities: Modality[];
  symbols: Symbol[];
  /** Total del catálogo: si es mayor que symbols.length, el catálogo se pide aparte (useGameSymbols). */
  symbol_count: number;
  limits: { currency: Currency; min_play: string; max_play: string; max_ticket: string; max_liability_per_symbol: string; max_player_per_draw: string | null }[];
  schedule: { time: string }[];
}

export interface Draw {
  id: string;
  game_id: string;
  draw_at: string;
  close_at: string;
  status: string;
  is_extraordinary: boolean;
  is_automatic: boolean;
  seed_hash: string;
  server_seed: string | null;
  result_symbol_id: string | null;
  result_number: string | null;
  result_name: string | null;
  result_emoji: string | null;
  preliminary_number: string | null;
  preliminary_name: string | null;
  preliminary_emoji: string | null;
  /** Kino: los 7 números extraídos (oficial) o propuestos (preliminar). */
  result_numbers?: number[] | null;
  preliminary_numbers?: number[] | null;
  incident_notice: string | null;
  server_now: string;
  /** Sorteo privado del simulador. */
  sim?: boolean;
}

export interface Balance {
  currency: Currency;
  cash: string;
  locked: string;
}

export type AdminGame = Game & { status: 'ACTIVE' | 'INACTIVE' };

export const useGames = () => useQuery({
  queryKey: ['games'], queryFn: () => get<Game[]>('/lottery/games'), staleTime: 60_000, refetchInterval: 60_000,
});

/** Catálogo del juego: el que vino en la lista o, en tableros grandes (Cuatrifecta), el que se pide al abrirlo. */
export function useGameSymbols(game: Pick<Game, 'id' | 'symbols' | 'symbol_count'> | undefined): Symbol[] {
  const lazy = !!game && game.symbols.length < (game.symbol_count ?? 0);
  const q = useQuery({
    queryKey: ['game-symbols', game?.id],
    enabled: lazy,
    staleTime: Infinity,
    queryFn: () => get<Symbol[]>(`/lottery/games/${game!.id}/symbols`),
  });
  return lazy ? (q.data ?? []) : (game?.symbols ?? []);
}

export const useAdminGames = () => useQuery({
  queryKey: ['admin', 'games'], queryFn: () => get<AdminGame[]>('/admin/lottery/games'), refetchInterval: 60_000,
});

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

export const useSimulationStatus = () =>
  useQuery({ queryKey: ['simulation-status'], staleTime: 300_000, queryFn: () => get<{ enabled: boolean; maxTopup: Record<Currency, string> }>('/simulation/status') });

export const usePlatform = () =>
  useQuery({
    queryKey: ['platform'], staleTime: 60_000, refetchInterval: 60_000,
    queryFn: () => get<{ licenseLabel: string; futuresEnabled: boolean; signupBonus?: { VES: string; USDT: string } }>('/platform'),
  });

/** Cómo se llaman los símbolos de cada juego: animales (MER-05) o frutas (MER-03). */
export function symbolWords(game: Pick<Game, 'code'> | undefined) {
  if (game?.code === 'MER-09')
    return { one: 'número', many: 'números', pick: 'tu número y color', every: 'cada jugada', none: 'Ningún número coincide', exact: 'Número + color' };
  if (game?.code === 'MER-07')
    return { one: 'dupleta', many: 'dupletas', pick: 'tu dupleta', every: 'cada dupleta', none: 'Ninguna dupleta coincide', exact: 'Dupleta exacta' };
  if (game?.code === 'MER-08')
    return { one: 'número', many: 'números', pick: 'tu número', every: 'cada número', none: 'Ningún número coincide', exact: 'Cuatrifecta exacta' };
  if (game?.code === 'MER-10')
    return { one: 'número', many: 'números', pick: 'tus 5 números', every: 'cada jugada', none: 'Ningún número coincide', exact: '5 números exactos' };
  if (game?.code === 'MER-06')
    return { one: 'centena', many: 'centenas', pick: 'tu centena', every: 'cada centena', none: 'Ninguna centena coincide', exact: 'Centena exacta' };
  if (game?.code === 'MER-04')
    return { one: 'número', many: 'números', pick: 'tu número', every: 'cada número', none: 'Ningún número coincide', exact: 'Terminal directo' };
  if (game?.code === 'MER-02')
    return { one: 'número', many: 'números', pick: 'tus números', every: 'cada número', none: 'Ningún número coincide', exact: 'Kino 5' };
  if (game?.code === 'MER-01')
    return { one: 'número', many: 'números', pick: 'tu número', every: 'cada número', none: 'Ningún número coincide', exact: 'Triple exacto' };
  return game?.code === 'MER-03'
    ? { one: 'fruta', many: 'frutas', pick: 'tus frutas', every: 'cada fruta', none: 'Ninguna fruta coincide', exact: 'Fruta exacta' }
    : { one: 'animal', many: 'animales', pick: 'tus animalitos', every: 'cada animal', none: 'Ningún animal coincide', exact: 'Animal exacto' };
}

/** Cifras finales que compara la modalidad (Triple Andino): terminal 2, última cifra 1; el resto, el número completo. */
export function matchDigits(code?: string) {
  return code === 'TERMINAL' || code === 'PAIR' ? 2 : code === 'LAST_DIGIT' ? 1 : 3;
}

/** Lo jugado tal como lo ve el jugador: «718», terminal «18», última cifra «8». */
export function playedLabel(code: string | undefined, number: string) {
  // Cóndor Dorado («67-ROJO»): solo número «67», solo color «ROJO».
  if (code === 'NUMBER') return number.split('-')[0];
  if (code === 'COLOR') return number.split('-')[1] ?? number;
  return code === 'TERMINAL' || code === 'LAST_DIGIT' || code === 'PAIR' ? number.slice(-matchDigits(code)) : number;
}

/** Kino: cuántos números lleva la modalidad (5, 6 o 7). */
export function kinoSize(code?: string) {
  if (code === 'MATCH5' || code === 'MATCH4' || code === 'MATCH3') return 5;
  return code === 'KINO5' ? 5 : code === 'KINO6' ? 6 : code === 'KINO7' ? 7 : 0;
}

/** Andes 5 Estrella: aciertos exactos que pide la modalidad (0 en Kino, donde deben salir todos). */
export function pickHits(code?: string) {
  return code === 'MATCH5' ? 5 : code === 'MATCH4' ? 4 : code === 'MATCH3' ? 3 : 0;
}
