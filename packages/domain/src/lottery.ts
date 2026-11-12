import { applyMultiplier } from './money';
import { fairIndex } from './fairness';

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
  modalityId?: string;
  /** Kino: números elegidos (ordenados). */
  selection?: number[];
  /** Andes 5 Estrella: estrella elegida (1–5) en las modalidades con estrella. */
  star?: number | null;
}

export type PlayValidationError =
  | { code: 'EMPTY_TICKET' }
  | { code: 'TOO_MANY_PLAYS'; max: number }
  | { code: 'DUPLICATE_PLAY'; drawId: string; symbolId: string }
  | { code: 'PLAY_BELOW_MIN'; index: number }
  | { code: 'PLAY_ABOVE_MAX'; index: number }
  | { code: 'TICKET_ABOVE_MAX' };

export const MAX_PLAYS_PER_TICKET = 70; // v2.0: alcanza para el tablero completo de 70 animales

/** Valida montos y estructura de un ticket. No valida estado del sorteo ni cupos (eso requiere BD). */
export function validatePlays(plays: PlayInput[], limits: PlayLimits): PlayValidationError | null {
  if (plays.length === 0) return { code: 'EMPTY_TICKET' };
  if (plays.length > MAX_PLAYS_PER_TICKET) return { code: 'TOO_MANY_PLAYS', max: MAX_PLAYS_PER_TICKET };
  const seen = new Set<string>();
  let total = 0n;
  for (let i = 0; i < plays.length; i++) {
    const p = plays[i];
    // Triple: el mismo número puede jugarse en varias modalidades del mismo sorteo (triple, terminal, última cifra).
    const key = `${p.drawId}|${p.symbolId}|${p.modalityId ?? ""}|${p.selection?.join(",") ?? ""}|${p.star ?? ""}`;
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

/**
 * Catálogo de trabajo de Animalitos de Mérida (MER-05): 00–36, 37 códigos, sin «0».
 * Solo 00, 07, 17, 24 y 36 vienen de la FUR; el resto es propuesta pendiente de aprobación
 * (docs/Animalitos_de_Merida_MER-05.md §2).
 */
export const MERIDA_ANIMALS: ReadonlyArray<{ number: string; name: string; emoji: string }> = [
  { number: '00', name: 'Oso Frontino', emoji: '🐻' },
  { number: '01', name: 'Paují', emoji: '🦃' },
  { number: '02', name: 'Toro', emoji: '🐂' },
  { number: '03', name: 'Trucha', emoji: '🐟' },
  { number: '04', name: 'Puma', emoji: '🐾' },
  { number: '05', name: 'Águila', emoji: '🪽' },
  { number: '06', name: 'Rana', emoji: '🐸' },
  { number: '07', name: 'Venado', emoji: '🦌' },
  { number: '08', name: 'Ratón', emoji: '🐭' },
  { number: '09', name: 'Gallito de las Rocas', emoji: '🐤' },
  { number: '10', name: 'Jaguar', emoji: '🐆' },
  { number: '11', name: 'Gato', emoji: '🐈' },
  { number: '12', name: 'Caballo', emoji: '🐎' },
  { number: '13', name: 'Mono Araña', emoji: '🐒' },
  { number: '14', name: 'Paloma', emoji: '🕊️' },
  { number: '15', name: 'Zorro', emoji: '🦊' },
  { number: '16', name: 'Lapa', emoji: '🐹' },
  { number: '17', name: 'Colibrí', emoji: '🐦' },
  { number: '18', name: 'Burro', emoji: '🫏' },
  { number: '19', name: 'Chivo', emoji: '🐐' },
  { number: '20', name: 'Cochino', emoji: '🐖' },
  { number: '21', name: 'Gallo', emoji: '🐓' },
  { number: '22', name: 'Danta', emoji: '🦛' },
  { number: '23', name: 'Cachicamo', emoji: '🦔' },
  { number: '24', name: 'Cunaguaro', emoji: '🐈‍⬛' },
  { number: '25', name: 'Gallina', emoji: '🐔' },
  { number: '26', name: 'Vaca', emoji: '🐄' },
  { number: '27', name: 'Perro', emoji: '🐕' },
  { number: '28', name: 'Zamuro', emoji: '🐦‍⬛' },
  { number: '29', name: 'Búho', emoji: '🦉' },
  { number: '30', name: 'Caimán', emoji: '🐊' },
  { number: '31', name: 'Morrocoy', emoji: '🐢' },
  { number: '32', name: 'Ardilla', emoji: '🐿️' },
  { number: '33', name: 'Guacamaya', emoji: '🦜' },
  { number: '34', name: 'Chigüire', emoji: '🦫' },
  { number: '35', name: 'Tucán', emoji: '🪶' },
  { number: '36', name: 'Cóndor', emoji: '🦅' },
  // v2.0: ampliación a 70 animales (00–69).
  { number: '37', name: 'Delfín', emoji: '🐬' },
  { number: '38', name: 'Ballena', emoji: '🐋' },
  { number: '39', name: 'Tiburón', emoji: '🦈' },
  { number: '40', name: 'Pulpo', emoji: '🐙' },
  { number: '41', name: 'Cangrejo', emoji: '🦀' },
  { number: '42', name: 'Camarón', emoji: '🦐' },
  { number: '43', name: 'Pato', emoji: '🦆' },
  { number: '44', name: 'Pavo Real', emoji: '🦚' },
  { number: '45', name: 'Flamenco', emoji: '🦩' },
  { number: '46', name: 'Garza', emoji: '🪿' },
  { number: '47', name: 'Murciélago', emoji: '🦇' },
  { number: '48', name: 'Abeja', emoji: '🐝' },
  { number: '49', name: 'Mariposa', emoji: '🦋' },
  { number: '50', name: 'Araña', emoji: '🕷️' },
  { number: '51', name: 'Escorpión', emoji: '🦂' },
  { number: '52', name: 'Caracol', emoji: '🐌' },
  { number: '53', name: 'Culebra', emoji: '🐍' },
  { number: '54', name: 'Iguana', emoji: '🦎' },
  { number: '55', name: 'Oveja', emoji: '🐑' },
  { number: '56', name: 'Conejo', emoji: '🐇' },
  { number: '57', name: 'León', emoji: '🦁' },
  { number: '58', name: 'Tigre', emoji: '🐅' },
  { number: '59', name: 'Elefante', emoji: '🐘' },
  { number: '60', name: 'Jirafa', emoji: '🦒' },
  { number: '61', name: 'Cebra', emoji: '🦓' },
  { number: '62', name: 'Rinoceronte', emoji: '🦏' },
  { number: '63', name: 'Camello', emoji: '🐫' },
  { number: '64', name: 'Gorila', emoji: '🦍' },
  { number: '65', name: 'Canguro', emoji: '🦘' },
  { number: '66', name: 'Pingüino', emoji: '🐧' },
  { number: '67', name: 'Oso Panda', emoji: '🐼' },
  { number: '68', name: 'Koala', emoji: '🐨' },
  { number: '69', name: 'Mapache', emoji: '🦝' },
];

/** Modalidades de juego (MER-05 §4). Solo las ACTIVE se venden. */
export type ModalityCode =
  | 'EXACT'
  | 'COMBINADA'
  | 'MULTIPLE'
  | 'TERMINAL'
  | 'LAST_DIGIT'
  | 'FULL'
  | 'KINO5'
  | 'KINO6'
  | 'KINO7'
  | 'APPROX'
  | 'SUPER'
  | 'DUAL'
  | 'NUMBER'
  | 'COLOR'
  | 'PAIR'
  | 'MATCH5'
  | 'MATCH4'
  | 'MATCH3'
  | 'REVERSED'
  | 'PARITY'
  | 'BOX'
  | 'MATCH5S'
  | 'MATCH4S'
  | 'MATCH3S';
export type ModalityStatus = 'ACTIVE' | 'PENDING_APPROVAL' | 'INACTIVE';

export interface ModalityRule {
  code: ModalityCode;
  status: ModalityStatus;
  minSelections: number;
  maxSelections: number | null;
}

export type ModalityError =
  | { code: 'MODALITY_NOT_ACTIVE'; modality: ModalityCode }
  | { code: 'BAD_SELECTION_COUNT'; min: number; max: number | null };

/** ¿Se puede vender esta modalidad con tantos animales por jugada? */
export function checkModality(rule: ModalityRule, selections: number): ModalityError | null {
  if (rule.status !== 'ACTIVE') return { code: 'MODALITY_NOT_ACTIVE', modality: rule.code };
  if (selections < rule.minSelections || (rule.maxSelections !== null && selections > rule.maxSelections)) {
    return { code: 'BAD_SELECTION_COUNT', min: rule.minSelections, max: rule.maxSelections };
  }
  return null;
}

/**
 * Retorno teórico al jugador en puntos básicos (10000 = 100 %) para un premio de factor×
 * con probabilidad num/den. Entero, sin flotantes. Exacto 30× con 1/37 → 8108 (81,08 %).
 */
export function rtpBps(factorX100: bigint, probNum: bigint, probDen: bigint): bigint {
  return (factorX100 * probNum * 100n) / probDen;
}

/**
 * Frutas del Páramo (MER-03): 70 frutas que se dan en Venezuela, 00–69.
 * Las seis de la ficha FUR van primero (Mora, Durazno, Uva, Fresa, Manzana, Pera). Hay menos emojis de frutas
 * que frutas: algunas comparten dibujo y se distinguen por número y nombre.
 */
export const PARAMO_FRUITS: ReadonlyArray<{ number: string; name: string; emoji: string }> = [
  { number: '00', name: 'Mora', emoji: '🫐' },
  { number: '01', name: 'Durazno', emoji: '🍑' },
  { number: '02', name: 'Uva', emoji: '🍇' },
  { number: '03', name: 'Fresa', emoji: '🍓' },
  { number: '04', name: 'Manzana', emoji: '🍎' },
  { number: '05', name: 'Pera', emoji: '🍐' },
  { number: '06', name: 'Mango', emoji: '🥭' },
  { number: '07', name: 'Cambur', emoji: '🍌' },
  { number: '08', name: 'Piña', emoji: '🍍' },
  { number: '09', name: 'Patilla', emoji: '🍉' },
  { number: '10', name: 'Melón', emoji: '🍈' },
  { number: '11', name: 'Naranja', emoji: '🍊' },
  { number: '12', name: 'Limón', emoji: '🍋' },
  { number: '13', name: 'Aguacate', emoji: '🥑' },
  { number: '14', name: 'Coco', emoji: '🥥' },
  { number: '15', name: 'Lechosa', emoji: '🍈' },
  { number: '16', name: 'Guayaba', emoji: '🍏' },
  { number: '17', name: 'Parchita', emoji: '🟡' },
  { number: '18', name: 'Guanábana', emoji: '🍏' },
  { number: '19', name: 'Tamarindo', emoji: '🫘' },
  { number: '20', name: 'Mamón', emoji: '🫒' },
  { number: '21', name: 'Níspero', emoji: '🥔' },
  { number: '22', name: 'Ciruela', emoji: '🍒' },
  { number: '23', name: 'Tomate de árbol', emoji: '🍅' },
  { number: '24', name: 'Granada', emoji: '🔴' },
  { number: '25', name: 'Higo', emoji: '🟣' },
  { number: '26', name: 'Mandarina', emoji: '🍊' },
  { number: '27', name: 'Toronja', emoji: '🍊' },
  { number: '28', name: 'Lima', emoji: '🍋' },
  { number: '29', name: 'Uchuva', emoji: '🟠' },
  { number: '30', name: 'Curuba', emoji: '🍌' },
  { number: '31', name: 'Granadilla', emoji: '🟠' },
  { number: '32', name: 'Tuna', emoji: '🌵' },
  { number: '33', name: 'Pitahaya', emoji: '🐉' },
  { number: '34', name: 'Cacao', emoji: '🍫' },
  { number: '35', name: 'Merey', emoji: '🥜' },
  { number: '36', name: 'Caimito', emoji: '🟣' },
  { number: '37', name: 'Zapote', emoji: '🥭' },
  { number: '38', name: 'Mamey', emoji: '🥭' },
  { number: '39', name: 'Chirimoya', emoji: '💚' },
  { number: '40', name: 'Anón', emoji: '💚' },
  { number: '41', name: 'Pomarrosa', emoji: '🌸' },
  { number: '42', name: 'Jobo', emoji: '🟡' },
  { number: '43', name: 'Ponsigué', emoji: '🔴' },
  { number: '44', name: 'Icaco', emoji: '🫒' },
  { number: '45', name: 'Uva de playa', emoji: '🍇' },
  { number: '46', name: 'Semeruco', emoji: '🍒' },
  { number: '47', name: 'Carambola', emoji: '⭐' },
  { number: '48', name: 'Pan de año', emoji: '🍞' },
  { number: '49', name: 'Yaca', emoji: '🍈' },
  { number: '50', name: 'Moriche', emoji: '🌴' },
  { number: '51', name: 'Pijiguao', emoji: '🌴' },
  { number: '52', name: 'Copoazú', emoji: '🥥' },
  { number: '53', name: 'Camu camu', emoji: '🍒' },
  { number: '54', name: 'Arazá', emoji: '🍋' },
  { number: '55', name: 'Guama', emoji: '🫛' },
  { number: '56', name: 'Membrillo', emoji: '🍐' },
  { number: '57', name: 'Mortiño', emoji: '🫐' },
  { number: '58', name: 'Badea', emoji: '🍈' },
  { number: '59', name: 'Coroba', emoji: '🌰' },
  { number: '60', name: 'Cotoperí', emoji: '🫒' },
  { number: '61', name: 'Pomagás', emoji: '🍎' },
  { number: '62', name: 'Grosella', emoji: '🟢' },
  { number: '63', name: 'Lulo', emoji: '🍊' },
  { number: '64', name: 'Uva caimarona', emoji: '🍇' },
  { number: '65', name: 'Seje', emoji: '🌴' },
  { number: '66', name: 'Manaca', emoji: '🫐' },
  { number: '67', name: 'Pitanga', emoji: '🍅' },
  { number: '68', name: 'Manteco', emoji: '🟡' },
  { number: '69', name: 'Corozo', emoji: '🟤' },
];

// ───────────── Triple Andino (MER-01): números 000–999 ─────────────

/** Catálogo 000–999: el «símbolo» es el número de tres cifras. */
export const TRIPLE_NUMBERS: ReadonlyArray<{ number: string; name: string; emoji: string }> = Array.from({ length: 1000 }, (_, i) => {
  const n = String(i).padStart(3, '0');
  return { number: n, name: n, emoji: '' };
});

/** Cifras finales que compara cada modalidad: triple exacto 3, terminal 2, última cifra 1. Las demás comparan el símbolo entero. */
export function matchDigits(code: ModalityCode): number | null {
  return code === 'TERMINAL' || code === 'PAIR' ? 2 : code === 'LAST_DIGIT' || code === 'FULL' ? 1 : null;
}

/**
 * «Las 3» (FULL): una jugada participa en triple, terminal y última cifra y cobra SOLO el premio mayor que acierte.
 * Su factor es el del triple; terminal y última cifra pagan 1/10 y 1/100 de él (misma proporción 600 : 60 : 6 del manual).
 */
export function prizeFactor(code: ModalityCode, played: string, result: string, factorX100: bigint): bigint {
  // Cóndor Dorado: solo número o solo color.
  if (code === 'NUMBER' || code === 'COLOR') return playMatches(code, played, result) ? factorX100 : 0n;
  // Terminal Nevado: aproximación gana si el resultado es el número anterior o el siguiente (sin dar la vuelta 99→00).
  if (code === 'APPROX') return Math.abs(Number(played) - Number(result)) === 1 ? factorX100 : 0n;
  // «Las 2» (DUAL): un número juega directo y aproximación; cobra uno solo. El vecino paga 1/5 del directo (proporción 100 : 20 del manual).
  if (code === 'DUAL') return played === result ? factorX100 : Math.abs(Number(played) - Number(result)) === 1 ? factorX100 / 5n : 0n;
  if (code !== 'FULL') return playMatches(code, played, result) ? factorX100 : 0n;
  if (played === result) return factorX100;
  if (played.slice(-2) === result.slice(-2)) return factorX100 / 10n;
  if (played.slice(-1) === result.slice(-1)) return factorX100 / 100n;
  return 0n;
}

/** ¿Gana la jugada? Animalitos/Frutas: mismo símbolo. Triple: coinciden las últimas 1, 2 o 3 cifras según la modalidad. */
export function playMatches(code: ModalityCode, played: string, result: string): boolean {
  if (code === 'NUMBER') return condorParts(played).number === condorParts(result).number;
  if (code === 'COLOR') return condorParts(played).color === condorParts(result).color;
  // Dupleta de Montaña: la invertida gana si sale la pareja al revés; doble paridad, si los dos salen de la paridad apostada.
  if (code === 'REVERSED') return reversePair(played) === result;
  if (code === 'PARITY') return pairParity(result) === pairParity(played);
  // Cuatrifecta «Terminal 4 cifras»: las mismas cuatro cifras, en cualquier orden.
  if (code === 'BOX') return sortDigits(played) === sortDigits(result);
  // Centena Andina «Par andino»: las dos últimas cifras en cualquier orden (90 gana con …90 y con …09).
  if (code === 'PAIR') return pairKeys(played).includes(result.slice(-2));
  const k = matchDigits(code);
  return k === null ? played === result : played.slice(-k) === result.slice(-k);
}

/** Lo que se jugó, tal como lo ve el jugador: «718», terminal «18», última cifra «8». */
export function playedKey(code: ModalityCode, played: string): string {
  if (code === 'FULL') return played;
  if (code === 'NUMBER') return condorParts(played).number;
  if (code === 'PARITY') return pairParity(played) === 'EVEN' ? 'Ambos pares' : 'Ambos impares';
  if (code === 'COLOR') return condorColor(condorParts(played).color)?.name ?? played;
  // Cóndor Dorado número + color: «67 Rojo».
  const condor = condorColor(condorParts(played).color);
  if (condor && /^\d{2}-/.test(played)) return `${condorParts(played).number} ${condor.name}`;
  const k = matchDigits(code);
  return k === null ? played : played.slice(-k);
}

/**
 * Pasivo por resultado en un juego de tres cifras: Σ premios que se pagarían si sale cada número.
 * `lines` son premios potenciales agregados por modalidad y valor jugado (triple «718», terminal «18», cifra «8»).
 */
export class TriplePayouts {
  private exact = new Map<string, bigint>();
  private terminal = new Map<string, bigint>();
  private last = new Map<string, bigint>();

  add(code: ModalityCode, played: string, payout: bigint) {
    if (code === 'FULL') {
      // Paga solo el mayor: exacto P, terminal P/10, última cifra P/100. Repartido en capas para que la suma por resultado dé eso.
      const t = payout / 10n;
      const l = payout / 100n;
      this.exact.set(played, (this.exact.get(played) ?? 0n) + payout - t);
      this.terminal.set(played.slice(-2), (this.terminal.get(played.slice(-2)) ?? 0n) + t - l);
      this.last.set(played.slice(-1), (this.last.get(played.slice(-1)) ?? 0n) + l);
      return this;
    }
    if (code === 'PAIR') {
      for (const tail of pairKeys(played)) this.terminal.set(tail, (this.terminal.get(tail) ?? 0n) + payout);
      return this;
    }
    const k = matchDigits(code);
    const [map, key] = k === 2 ? [this.terminal, played.slice(-2)] : k === 1 ? [this.last, played.slice(-1)] : [this.exact, played];
    map.set(key, (map.get(key) ?? 0n) + payout);
    return this;
  }

  /** Premios totales si el resultado es `result` (000–999). */
  payout(result: string): bigint {
    return (this.exact.get(result) ?? 0n) + (this.terminal.get(result.slice(-2)) ?? 0n) + (this.last.get(result.slice(-1)) ?? 0n);
  }

  /** Resultados que tocaría una jugada (1, 10 o 100 números). */
  static affected(code: ModalityCode, played: string): string[] {
    if (code === 'PAIR') return pairKeys(played).flatMap((tail) => TriplePayouts.affected('TERMINAL', tail));
    const k = matchDigits(code) ?? 3;
    const tail = played.slice(-k);
    const span = 10 ** (3 - k);
    return Array.from({ length: span }, (_, i) => (span === 1 ? '' : String(i).padStart(3 - k, '0')) + tail);
  }

  /** Peor resultado para la casa entre los 1.000 posibles. */
  worst(): { result: string; payout: bigint } {
    let best = { result: '000', payout: -1n };
    for (let i = 0; i < 1000; i++) {
      const r = String(i).padStart(3, '0');
      const p = this.payout(r);
      if (p > best.payout) best = { result: r, payout: p };
    }
    return best;
  }
}

// ───────────── Cuatrifecta de Cumbres (MER-08): números 0000–9999 ─────────────

/** Catálogo 0000–9999. */
export const CUATRIFECTA_NUMBERS: ReadonlyArray<{ number: string; name: string; emoji: string }> = Array.from({ length: 10000 }, (_, i) => {
  const n = String(i).padStart(4, '0');
  return { number: n, name: n, emoji: '' };
});

// ───────────── Kino Teleférico (MER-02): elige 5, 6 o 7 números del 01 al 40; se extraen 7 ─────────────

export const KINO_UNIVERSE = 40;
export const KINO_DRAWN = 7;

/** Catálogo 01–40. */
export const KINO_NUMBERS: ReadonlyArray<{ number: string; name: string; emoji: string }> = Array.from({ length: KINO_UNIVERSE }, (_, i) => {
  const n = String(i + 1).padStart(2, '0');
  return { number: n, name: n, emoji: '' };
});

/** Cuántos números lleva cada modalidad Kino (null si no es Kino). */
export function kinoSize(code: ModalityCode): number | null {
  if (/^MATCH[345]S?$/.test(code)) return 5; // Andes 5 Estrella: siempre se eligen 5 (con o sin estrella)
  return code === 'KINO5' ? 5 : code === 'KINO6' ? 6 : code === 'KINO7' ? 7 : null;
}

/** Andes 5 Estrella: cuántos aciertos EXACTOS pide la modalidad (5, 4 o 3). null en Kino, donde deben salir todos. */
export function pickHits(code: ModalityCode): number | null {
  const m = /^MATCH([345])S?$/.exec(code);
  return m ? Number(m[1]) : null;
}

/** Andes 5 Estrella: estrellas posibles (1 a 5). El manual no fija el rango; se toma el de sus ejemplos. */
export const ANDES_STAR_MAX = 5;

/** ¿La modalidad lleva estrella? (5, 4 o 3 aciertos + estrella). */
export function hasStar(code: ModalityCode): boolean {
  return /^MATCH[345]S$/.test(code);
}

/**
 * ¿Gana la selección? Kino: salen todos los elegidos. Andes 5 Estrella: coinciden exactamente k de los 5 y, en las
 * modalidades con estrella, además la estrella elegida es la que salió.
 */
export function pickWins(code: ModalityCode, selection: number[], drawn: number[], star?: number | null, drawnStar?: number | null): boolean {
  const k = pickHits(code);
  if (k === null) return kinoWins(selection, drawn);
  if (hasStar(code) && (star == null || star !== drawnStar)) return false;
  const set = new Set(drawn);
  return selection.filter((x) => set.has(x)).length === k;
}

/** Selección válida: k números distintos entre 1 y 40. Devuelve la selección ordenada o un error legible. */
export function normalizeKinoSelection(code: ModalityCode, numbers: number[]): { ok: true; selection: number[] } | { ok: false; error: string } {
  const k = kinoSize(code);
  if (k === null) return { ok: false, error: 'La modalidad no es Kino' };
  if (!Array.isArray(numbers) || numbers.length !== k) return { ok: false, error: `Esta jugada lleva exactamente ${k} números` };
  if (numbers.some((x) => !Number.isInteger(x) || x < 1 || x > KINO_UNIVERSE)) return { ok: false, error: `Los números van del 01 al ${KINO_UNIVERSE}` };
  const selection = [...numbers].sort((a, b) => a - b);
  if (selection.some((x, i) => i > 0 && x === selection[i - 1])) return { ok: false, error: 'No se pueden repetir números' };
  return { ok: true, selection };
}

/** Gana si TODOS los números elegidos están entre los 7 extraídos (para Kino 5 sobran 2). */
export function kinoWins(selection: number[], drawn: number[]): boolean {
  const set = new Set(drawn);
  return selection.every((x) => set.has(x));
}

function choose(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  let r = 1;
  for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i;
  return Math.round(r);
}

/** Probabilidad de acertar una selección de k números: C(40−k, 7−k) / C(40, 7). */
export function kinoWinProbability(k: number, n = KINO_UNIVERSE, drawn = KINO_DRAWN): number {
  return choose(n - k, drawn - k) / choose(n, drawn);
}

/** Cuántas selecciones de k caben en una extracción de 7: C(7, k). Acota el peor resultado posible. */
export function kinoSubsetsPerDraw(k: number, drawn = KINO_DRAWN): number {
  return choose(drawn, k);
}

// ───────────── Terminal Nevado (MER-04): números 00–99 ─────────────

/** Catálogo 00–99. */
export const TERMINAL_NUMBERS: ReadonlyArray<{ number: string; name: string; emoji: string }> = Array.from({ length: 100 }, (_, i) => {
  const n = String(i).padStart(2, '0');
  return { number: n, name: n, emoji: '' };
});

/** Pasivo por resultado en un juego de dos cifras: directo paga si sale el número; aproximación si sale el vecino. */
export class TerminalPayouts {
  private byResult = new Map<string, bigint>();

  /**
   * Resultados con los que paga una jugada (sin circularidad: 00 solo tiene al 01 y 99 solo al 98). El ancho sale del número
   * jugado: sirve para Terminal Nevado (00–99) y Cuatrifecta de Cumbres (0000–9999).
   */
  static affected(code: ModalityCode, played: string): string[] {
    if (code === 'DUAL') return [played, ...TerminalPayouts.affected('APPROX', played)];
    if (code === 'BOX') return digitPermutations(played);
    if (code !== 'APPROX') return [played];
    const width = played.length;
    const n = Number(played);
    return [n - 1, n + 1].filter((x) => x >= 0 && x < 10 ** width).map((x) => String(x).padStart(width, '0'));
  }

  add(code: ModalityCode, played: string, payout: bigint) {
    if (code === 'DUAL') {
      // Directo paga P; cada vecino, P/5.
      this.add('EXACT', played, payout);
      this.add('APPROX', played, payout / 5n);
      return this;
    }
    for (const r of TerminalPayouts.affected(code, played)) this.byResult.set(r, (this.byResult.get(r) ?? 0n) + payout);
    return this;
  }

  payout(result: string): bigint {
    return this.byResult.get(result) ?? 0n;
  }
}

// ───────────── Cóndor Dorado (MER-09): número 00–99 × color (rojo, azul, verde, amarillo) ─────────────

export const CONDOR_COLORS = [
  { code: 'ROJO', name: 'Rojo', emoji: '🔴' },
  { code: 'AZUL', name: 'Azul', emoji: '🔵' },
  { code: 'VERDE', name: 'Verde', emoji: '🟢' },
  { code: 'AMARILLO', name: 'Amarillo', emoji: '🟡' },
] as const;
export type CondorColor = (typeof CONDOR_COLORS)[number]['code'];

export const condorColor = (code: string) => CONDOR_COLORS.find((c) => c.code === code);

/** «67-ROJO» → { number: '67', color: 'ROJO' }. */
export function condorParts(symbol: string): { number: string; color: string } {
  const [number = '', color = ''] = symbol.split('-');
  return { number, color };
}

/**
 * Catálogo de 400 resultados: cada símbolo es un número y un color («67-ROJO»). El RNG elige uno de los 400 con la misma
 * probabilidad, así número (1/100) y color (1/4) salen independientes.
 */
export const CONDOR_SYMBOLS: ReadonlyArray<{ number: string; name: string; emoji: string }> = Array.from({ length: 400 }, (_, i) => {
  const n = String(Math.floor(i / 4)).padStart(2, '0');
  const c = CONDOR_COLORS[i % 4];
  return { number: `${n}-${c.code}`, name: `${n} ${c.name}`, emoji: '' };
});

/**
 * Pasivo por resultado en Cóndor Dorado: número + color paga con 1 resultado, solo número con 4 (sus cuatro colores)
 * y solo color con 100 (todos los números de ese color).
 */
export class ColorPayouts {
  private byResult = new Map<string, bigint>();

  static affected(code: ModalityCode, played: string): string[] {
    const { number, color } = condorParts(played);
    if (code === 'NUMBER') return CONDOR_COLORS.map((c) => `${number}-${c.code}`);
    if (code === 'COLOR') return Array.from({ length: 100 }, (_, i) => `${String(i).padStart(2, '0')}-${color}`);
    return [played];
  }

  add(code: ModalityCode, played: string, payout: bigint) {
    for (const r of ColorPayouts.affected(code, played)) this.byResult.set(r, (this.byResult.get(r) ?? 0n) + payout);
    return this;
  }

  payout(result: string): bigint {
    return this.byResult.get(result) ?? 0n;
  }
}

// ───────────── Juegos con tope de pago por resultado (Triple, Terminal, Cóndor) ─────────────

/** Tableros donde una jugada puede pagar con varios resultados: el tope se controla resultado por resultado. */
export function isResultBoard(board: string): board is 'DIGITS3' | 'DIGITS2' | 'DIGITS4' | 'COLOR' | 'DUO' {
  return board === 'DIGITS3' || board === 'DIGITS2' || board === 'DIGITS4' || board === 'COLOR' || board === 'DUO';
}

/** Acumulador de premios por resultado del tablero. */
export function newResultPayouts(board: string): { add(code: ModalityCode, played: string, payout: bigint): unknown; payout(result: string): bigint } {
  if (board === 'DUO') return new DupletaPayouts();
  return board === 'COLOR' ? new ColorPayouts() : board === 'DIGITS2' || board === 'DIGITS4' ? new TerminalPayouts() : new TriplePayouts();
}

/** Resultados con los que pagaría una jugada. */
export function affectedResults(board: string, code: ModalityCode, played: string): string[] {
  if (board === 'DUO') return DupletaPayouts.affected(code, played);
  return board === 'COLOR' ? ColorPayouts.affected(code, played) : board === 'DIGITS2' || board === 'DIGITS4' ? TerminalPayouts.affected(code, played) : TriplePayouts.affected(code, played);
}

/** Todos los resultados posibles del tablero, en orden. */
export function allResults(board: string): string[] {
  if (board === 'COLOR') return CONDOR_SYMBOLS.map((s) => s.number);
  if (board === 'DUO') return DUPLETA_SYMBOLS.map((s) => s.number);
  const width = board === 'DIGITS2' ? 2 : board === 'DIGITS4' ? 4 : 3;
  return Array.from({ length: 10 ** width }, (_, i) => String(i).padStart(width, '0'));
}

/** Finales de dos cifras con los que gana un «Par andino»: «90» → [«90», «09»]; un par doble («77») tiene uno solo. */
export function pairKeys(played: string): string[] {
  const t = played.slice(-2);
  const r = t[1] + t[0];
  return r === t ? [t] : [t, r];
}

/**
 * Probabilidad de ganar una jugada de números 01–n cuando se extraen `drawn` (hipergeométrica).
 * Kino k: salen los k elegidos. Andes 5 Estrella: exactamente h aciertos entre los 5 elegidos.
 */
export function pickWinProbability(code: ModalityCode, drawn: number, n = KINO_UNIVERSE): number {
  const k = kinoSize(code);
  if (k === null) return 0;
  const h = pickHits(code) ?? k;
  const star = hasStar(code) ? 1 / ANDES_STAR_MAX : 1;
  return ((choose(k, h) * choose(n - k, drawn - h)) / choose(n, drawn)) * star;
}

/** Cuántas selecciones distintas pueden ganar a la vez en un sorteo (acota el peor resultado). */
export function pickMaxWinners(code: ModalityCode, drawn: number, n = KINO_UNIVERSE): number {
  const k = kinoSize(code);
  if (k === null) return 0;
  const h = pickHits(code) ?? k;
  return choose(drawn, h) * choose(n - drawn, k - h);
}

// ───────────── Dupleta de Montaña (MER-07): pareja ordenada de dos números distintos del 00 al 99 ─────────────

/** Catálogo de 9.900 resultados: «25-52» (primero 25, luego 52). No hay parejas repetidas (manual MER-07, Anexo B.1). */
export const DUPLETA_SYMBOLS: ReadonlyArray<{ number: string; name: string; emoji: string }> = (() => {
  const out: { number: string; name: string; emoji: string }[] = [];
  for (let a = 0; a < 100; a++) {
    for (let b = 0; b < 100; b++) {
      if (a === b) continue;
      const n = `${String(a).padStart(2, '0')}-${String(b).padStart(2, '0')}`;
      out.push({ number: n, name: n, emoji: '' });
    }
  }
  return out;
})();

/** «25-52» → «52-25». */
export function reversePair(played: string): string {
  const [a, b] = played.split('-');
  return `${b}-${a}`;
}

/** Pasivo por resultado en Dupleta: la exacta paga con su pareja y la invertida con la pareja al revés. */
export class DupletaPayouts {
  private byResult = new Map<string, bigint>();

  static affected(code: ModalityCode, played: string): string[] {
    if (code === 'PARITY') return DUPLETA_SYMBOLS.filter((s) => pairParity(s.number) === pairParity(played)).map((s) => s.number);
    return code === 'REVERSED' ? [reversePair(played)] : [played];
  }

  add(code: ModalityCode, played: string, payout: bigint) {
    for (const r of DupletaPayouts.affected(code, played)) this.byResult.set(r, (this.byResult.get(r) ?? 0n) + payout);
    return this;
  }

  payout(result: string): bigint {
    return this.byResult.get(result) ?? 0n;
  }
}

// ───────────── Ayudas de las modalidades completadas ─────────────

/** Cifras ordenadas: «2581» → «1258». Dos números son el mismo «en desorden» si coinciden. */
export function sortDigits(n: string): string {
  return n.split('').sort().join('');
}

/** Todos los órdenes distintos de las cifras de un número («1123» → 12 números). */
export function digitPermutations(n: string): string[] {
  const out = new Set<string>();
  const walk = (rest: string, acc: string) => {
    if (!rest) return void out.add(acc);
    for (let i = 0; i < rest.length; i++) walk(rest.slice(0, i) + rest.slice(i + 1), acc + rest[i]);
  };
  walk(n, '');
  return [...out].sort();
}

/** Paridad de una dupleta: «EVEN» si ambos números son pares, «ODD» si ambos impares, «MIXED» si no. */
export function pairParity(pair: string): 'EVEN' | 'ODD' | 'MIXED' {
  const [a, b] = pair.split('-').map(Number);
  if (a % 2 === 0 && b % 2 === 0) return 'EVEN';
  if (a % 2 === 1 && b % 2 === 1) return 'ODD';
  return 'MIXED';
}

/** Dupleta que representa cada apuesta de paridad (el símbolo de la jugada): ambos pares «00-02», ambos impares «01-03». */
export const PARITY_SYMBOL = { EVEN: '00-02', ODD: '01-03' } as const;

/** Estrella del sorteo de Andes 5 Estrella: HMAC de la misma semilla con otro mensaje, 1 a ANDES_STAR_MAX. Verificable. */
export function drawStar(serverSeedHex: string, drawId: string, max = ANDES_STAR_MAX): number {
  return fairIndex(serverSeedHex, `${drawId}#estrella`, max) + 1;
}
