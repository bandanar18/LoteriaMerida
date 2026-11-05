import { applyMultiplier } from './money';

/** Tabla por defecto de 38 animales (Doc. Maestro §9.2). Es dato de seed: en BD vive en lottery_symbol. */
export const DEFAULT_ANIMALS: ReadonlyArray<{ number: string; name: string; emoji: string }> = [
  { number: '0', name: 'Delfín', emoji: '🐬' },
  { number: '00', name: 'Ballena', emoji: '🐋' },
  { number: '1', name: 'Carnero', emoji: '🐏' },
  { number: '2', name: 'Toro', emoji: '🐂' },
  { number: '3', name: 'Ciempiés', emoji: '🐛' },
  { number: '4', name: 'Alacrán', emoji: '🦂' },
  { number: '5', name: 'León', emoji: '🦁' },
  { number: '6', name: 'Rana', emoji: '🐸' },
  { number: '7', name: 'Perico', emoji: '🦜' },
  { number: '8', name: 'Ratón', emoji: '🐭' },
  { number: '9', name: 'Águila', emoji: '🦅' },
  { number: '10', name: 'Tigre', emoji: '🐅' },
  { number: '11', name: 'Gato', emoji: '🐈' },
  { number: '12', name: 'Caballo', emoji: '🐎' },
  { number: '13', name: 'Mono', emoji: '🐒' },
  { number: '14', name: 'Paloma', emoji: '🕊️' },
  { number: '15', name: 'Zorro', emoji: '🦊' },
  { number: '16', name: 'Oso', emoji: '🐻' },
  { number: '17', name: 'Pavo', emoji: '🦃' },
  { number: '18', name: 'Burro', emoji: '🫏' },
  { number: '19', name: 'Chivo', emoji: '🐐' },
  { number: '20', name: 'Cochino', emoji: '🐖' },
  { number: '21', name: 'Gallo', emoji: '🐓' },
  { number: '22', name: 'Camello', emoji: '🐫' },
  { number: '23', name: 'Cebra', emoji: '🦓' },
  { number: '24', name: 'Iguana', emoji: '🦎' },
  { number: '25', name: 'Gallina', emoji: '🐔' },
  { number: '26', name: 'Vaca', emoji: '🐄' },
  { number: '27', name: 'Perro', emoji: '🐕' },
  { number: '28', name: 'Zamuro', emoji: '🐦‍⬛' },
  { number: '29', name: 'Elefante', emoji: '🐘' },
  { number: '30', name: 'Caimán', emoji: '🐊' },
  { number: '31', name: 'Lapa', emoji: '🐹' },
  { number: '32', name: 'Ardilla', emoji: '🐿️' },
  { number: '33', name: 'Pescado', emoji: '🐟' },
  { number: '34', name: 'Venado', emoji: '🦌' },
  { number: '35', name: 'Jirafa', emoji: '🦒' },
  { number: '36', name: 'Culebra', emoji: '🐍' },
];

/** Ciclo de vida del sorteo (Doc. Maestro §9.5). */
export type DrawStatus =
  | 'SCHEDULED'
  | 'OPEN'
  | 'CLOSED'
  | 'RESULT_PENDING'
  | 'RESULT_CONFIRMED'
  | 'SETTLED'
  | 'CANCELLED';

const DRAW_TRANSITIONS: Record<DrawStatus, DrawStatus[]> = {
  SCHEDULED: ['OPEN', 'CANCELLED'],
  OPEN: ['CLOSED', 'CANCELLED'],
  CLOSED: ['RESULT_PENDING', 'RESULT_CONFIRMED', 'CANCELLED'],
  RESULT_PENDING: ['RESULT_CONFIRMED', 'CLOSED', 'CANCELLED'],
  RESULT_CONFIRMED: ['SETTLED'],
  SETTLED: [],
  CANCELLED: [],
};

export function canTransition(from: DrawStatus, to: DrawStatus): boolean {
  return DRAW_TRANSITIONS[from].includes(to);
}

export function assertTransition(from: DrawStatus, to: DrawStatus): void {
  if (!canTransition(from, to)) throw new Error(`Transición de sorteo inválida: ${from} → ${to}`);
}

export interface PlayLimits {
  minPlay: bigint;
  maxPlay: bigint;
  maxTicket: bigint;
}

export interface PlayInput {
  drawId: string;
  symbolId: string;
  amount: bigint;
}

export type PlayValidationError =
  | { code: 'EMPTY_TICKET' }
  | { code: 'TOO_MANY_PLAYS'; max: number }
  | { code: 'DUPLICATE_PLAY'; drawId: string; symbolId: string }
  | { code: 'PLAY_BELOW_MIN'; index: number }
  | { code: 'PLAY_ABOVE_MAX'; index: number }
  | { code: 'TICKET_ABOVE_MAX' };

export const MAX_PLAYS_PER_TICKET = 50;

/** Valida montos y estructura de un ticket. No valida estado del sorteo ni cupos (eso requiere BD). */
export function validatePlays(plays: PlayInput[], limits: PlayLimits): PlayValidationError | null {
  if (plays.length === 0) return { code: 'EMPTY_TICKET' };
  if (plays.length > MAX_PLAYS_PER_TICKET) return { code: 'TOO_MANY_PLAYS', max: MAX_PLAYS_PER_TICKET };
  const seen = new Set<string>();
  let total = 0n;
  for (let i = 0; i < plays.length; i++) {
    const p = plays[i];
    const key = `${p.drawId}|${p.symbolId}`;
    if (seen.has(key)) return { code: 'DUPLICATE_PLAY', drawId: p.drawId, symbolId: p.symbolId };
    seen.add(key);
    if (p.amount < limits.minPlay) return { code: 'PLAY_BELOW_MIN', index: i };
    if (p.amount > limits.maxPlay) return { code: 'PLAY_ABOVE_MAX', index: i };
    total += p.amount;
  }
  if (total > limits.maxTicket) return { code: 'TICKET_ABOVE_MAX' };
  return null;
}

export function ticketTotal(plays: Pick<PlayInput, 'amount'>[]): bigint {
  return plays.reduce((acc, p) => acc + p.amount, 0n);
}

export function potentialWin(amount: bigint, multiplierX100: bigint): bigint {
  return applyMultiplier(amount, multiplierX100);
}

/**
 * Cupo por animal (Doc. Maestro §9.7): el pasivo potencial de un animal en un sorteo
 * es multiplicador × Σ apuestas a ese animal; no puede superar maxLiability.
 */
export function fitsExposure(currentStaked: bigint, additional: bigint, multiplierX100: bigint, maxLiability: bigint): boolean {
  return applyMultiplier(currentStaked + additional, multiplierX100) <= maxLiability;
}

/** Resultado de una jugada liquidada. */
export function settlePlay(play: { symbolId: string; amount: bigint }, winningSymbolId: string, multiplierX100: bigint) {
  const won = play.symbolId === winningSymbolId;
  return { won, win: won ? applyMultiplier(play.amount, multiplierX100) : 0n };
}

/** Estado agregado de un ticket a partir de sus jugadas. */
export type PlayStatus = 'OPEN' | 'WON' | 'LOST' | 'VOID';
export type TicketStatus = 'OPEN' | 'WON' | 'LOST' | 'VOID' | 'CANCELLED';

export function aggregateTicketStatus(plays: PlayStatus[]): TicketStatus {
  if (plays.some((s) => s === 'OPEN')) return 'OPEN';
  if (plays.some((s) => s === 'WON')) return 'WON';
  if (plays.every((s) => s === 'VOID')) return 'VOID';
  return 'LOST';
}

/** Código de ticket legible (sin caracteres ambiguos) a partir de bytes aleatorios. */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export function encodeTicketCode(bytes: Uint8Array, length = 10): string {
  let out = '';
  for (let i = 0; i < length; i++) out += CODE_ALPHABET[bytes[i] % 32]; // 256 % 32 === 0 → sin sesgo
  return out;
}
