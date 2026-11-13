import { CONDOR_SYMBOLS, CUATRIFECTA_NUMBERS, DUPLETA_SYMBOLS, KINO_NUMBERS, MERIDA_ANIMALS, PARAMO_FRUITS, TERMINAL_NUMBERS, TRIPLE_NUMBERS, parseAmount } from '@loteria/domain';
import * as argon2 from 'argon2';
import { Pool } from 'pg';
import { AuditService } from '../audit/audit.service';
import { config } from '../config';
import { LedgerService } from '../wallet/ledger.service';
import { grantSignupBonus } from '../identity/signup-bonus';
import { seedSports } from './seed-sports';

/**
 * Datos iniciales para desarrollo local (idempotente).
 * Las credenciales de prueba se leen de apps/api/.env (ver .env.example).
 */
type Limits = Record<'VES' | 'USDT', { min: string; max: string; ticket: string; liability: string; perDraw?: string }>;
type SeedModality = {
  code: 'EXACT' | 'COMBINADA' | 'MULTIPLE' | 'TERMINAL' | 'LAST_DIGIT' | 'FULL' | 'KINO5' | 'KINO6' | 'KINO7' | 'APPROX' | 'SUPER' | 'DUAL' | 'NUMBER' | 'COLOR' | 'PAIR' | 'MATCH5' | 'MATCH4' | 'MATCH3' | 'REVERSED' | 'PARITY' | 'BOX' | 'MATCH5S' | 'MATCH4S' | 'MATCH3S';
  name: string;
  min: number;
  max: number | null;
  factorX100: number;
  status: 'ACTIVE' | 'PENDING_APPROVAL';
  description: string;
};

const DEMO_LIMITS: Limits = {
  VES: { min: '1', max: '2000', ticket: '10000', liability: '600000' },
  USDT: { min: '0.10', max: '50', ticket: '250', liability: '15000' },
};

/** MER-05 §4: solo el exacto está activo; las otras esperan condición de premio y tabla actuarial aprobadas. */
const MERIDA_MODALITIES: SeedModality[] = [
  { code: 'EXACT', name: 'Animal exacto', min: 1, max: 1, factorX100: 5000, status: 'ACTIVE', description: 'Un animal y su número. Si sale, cobras 50× lo apostado.' },
  { code: 'COMBINADA', name: 'Combinada', min: 2, max: 4, factorX100: 5000, status: 'PENDING_APPROVAL', description: 'De 2 a 4 animales. Condición de premio por formalizar.' },
  { code: 'MULTIPLE', name: 'Múltiple', min: 5, max: null, factorX100: 2000, status: 'PENDING_APPROVAL', description: 'Cinco o más animales. Condición de premio por formalizar.' },
];

/** MER-03 §4 (FUR): fruta exacta activa; Combinada y Triple frutal esperan su condición de premio aprobada. */
const PARAMO_MODALITIES: SeedModality[] = [
  { code: 'EXACT', name: 'Fruta exacta', min: 1, max: 1, factorX100: 4000, status: 'ACTIVE', description: 'Una fruta y su número. Si sale, cobras 40× lo apostado.' },
  { code: 'COMBINADA', name: 'Combinada', min: 2, max: 2, factorX100: 7000, status: 'PENDING_APPROVAL', description: 'Dos frutas en cualquier orden (70× propuesto). Condición de premio por formalizar.' },
  { code: 'MULTIPLE', name: 'Triple frutal', min: 3, max: 3, factorX100: 100000, status: 'PENDING_APPROVAL', description: 'Tres frutas exactas en el mismo orden (1.000× propuesto). Condición de premio por formalizar.' },
];

/** MER-01 Cuadro III: las tres condiciones están definidas → las tres activas. RTP 60 % en cada una. */
const TRIPLE_MODALITIES: SeedModality[] = [
  { code: 'EXACT', name: 'Triple exacto', min: 1, max: 1, factorX100: 60000, status: 'ACTIVE', description: 'Tres cifras exactas en el mismo orden. Si sale, cobras 600× lo apostado.' },
  { code: 'TERMINAL', name: 'Terminal', min: 1, max: 1, factorX100: 6000, status: 'ACTIVE', description: 'Las dos últimas cifras del triple, en el mismo orden. Cobras 60× lo apostado.' },
  { code: 'LAST_DIGIT', name: 'Última cifra', min: 1, max: 1, factorX100: 600, status: 'ACTIVE', description: 'La última cifra del triple. Cobras 6× lo apostado.' },
  // Las 3: el número participa en las tres y cobra solo el premio mayor. 200× / 20× / 2× sobre lo pagado = jugar un tercio en cada una sin sumar premios (RTP 56 %).
  { code: 'FULL', name: 'Las 3', min: 1, max: 1, factorX100: 20000, status: 'ACTIVE', description: 'Tu número participa en triple, terminal y última cifra. Cobras solo el premio mayor: 200× si sale exacto, 20× si coinciden las 2 últimas, 2× si coincide la última.' },
];

/** MER-02 Cuadro III: las tres condiciones están definidas. Factores del manual (Anexo B.2 pide evaluarlos: retorno 3,2 % / 0,9 % / 0,1 %). */
const KINO_MODALITIES: SeedModality[] = [
  { code: 'KINO5', name: 'Kino 5', min: 5, max: 5, factorX100: 100000, status: 'ACTIVE', description: 'Elige 5 números del 01 al 40. Si los 5 están entre los 7 extraídos, cobras 1.000× lo apostado.' },
  { code: 'KINO6', name: 'Kino 6', min: 6, max: 6, factorX100: 500000, status: 'ACTIVE', description: 'Elige 6 números del 01 al 40. Si los 6 están entre los 7 extraídos, cobras 5.000× lo apostado.' },
  { code: 'KINO7', name: 'Kino 7', min: 7, max: 7, factorX100: 2000000, status: 'ACTIVE', description: 'Elige 7 números del 01 al 40. Si salen los 7, cobras 20.000× lo apostado.' },
];

/** MER-04 Cuadro III. Súper terminal queda pendiente: el manual (Anexo B.1) no define su condición. */
const TERMINAL_MODALITIES: SeedModality[] = [
  { code: 'EXACT', name: 'Terminal directo', min: 1, max: 1, factorX100: 10000, status: 'ACTIVE', description: 'Dos cifras exactas, en el mismo orden. Si sale tu número, cobras 100× lo apostado.' },
  { code: 'APPROX', name: 'Aproximación', min: 1, max: 1, factorX100: 2000, status: 'ACTIVE', description: 'Ganas 20× si el número ganador es el inmediatamente anterior o posterior al tuyo (juegas 17: gana si sale 16 o 18). 00 y 99 no son vecinos.' },
  // Las 2: el número juega directo y aproximación y cobra uno solo. 50× / 10× sobre lo pagado = la mitad en cada una (RTP 70 %).
  { code: 'DUAL', name: 'Las 2', min: 1, max: 1, factorX100: 5000, status: 'ACTIVE', description: 'Tu número juega en directo y en aproximación; cobras un solo premio: 50× si sale tu número, 10× si sale el anterior o el siguiente.' },
  { code: 'SUPER', name: 'Súper terminal', min: 1, max: 1, factorX100: 25000, status: 'PENDING_APPROVAL', description: 'Condición de premio todavía no definida (manual MER-04, Anexo B.1). 250× propuesto.' },
];

// Manual MER-09 «Cóndor Dorado», cláusula décima octava: factores brutos ilustrativos 500× / 50× / 5×.
// Ojo: con 400 resultados, número + color y solo color devuelven 125 % de lo apostado (la casa pierde en promedio).
const CONDOR_MODALITIES: SeedModality[] = [
  { code: 'EXACT', name: 'Número + color', min: 1, max: 1, factorX100: 50000, status: 'ACTIVE', description: 'Eliges un número del 00 al 99 y un color. Si salen los dos, cobras 500× lo apostado.' },
  { code: 'NUMBER', name: 'Solo número', min: 1, max: 1, factorX100: 5000, status: 'ACTIVE', description: 'Eliges un número del 00 al 99, sin importar el color. Si sale, cobras 50× lo apostado.' },
  { code: 'COLOR', name: 'Solo color', min: 1, max: 1, factorX100: 500, status: 'ACTIVE', description: 'Eliges un color: rojo, azul, verde o amarillo. Si sale, cobras 5× lo apostado.' },
];

// Manual MER-06 «Centena Andina», cláusula décima octava: 200× / 40× / 20×. Las condiciones de Aproximación y Par andino
// vienen de la infografía (FUR); el manual las da «por precisar» (Anexo B.1) y pide no activarlas hasta definirlas.
const CENTENA_MODALITIES: SeedModality[] = [
  { code: 'EXACT', name: 'Centena exacta', min: 1, max: 1, factorX100: 20000, status: 'ACTIVE', description: 'Aciertas las tres cifras en el mismo orden (009 gana solo si sale 009). Cobras 200× lo apostado.' },
  { code: 'TERMINAL', name: 'Aproximación', min: 1, max: 1, factorX100: 4000, status: 'ACTIVE', description: 'Aciertas las dos últimas cifras en el mismo orden (09 gana si sale 009, 109, 209…). Cobras 40× lo apostado.' },
  { code: 'PAIR', name: 'Par andino', min: 1, max: 1, factorX100: 2000, status: 'ACTIVE', description: 'Aciertas las dos últimas cifras en cualquier orden (90 gana si termina en 90 o en 09). Cobras 20× lo apostado.' },
];

// Manual MER-10 «Andes 5 Estrella», cláusula décima octava: 5.000× / 1.000× / 50×. Cada modalidad es una línea aparte y pide
// aciertos EXACTOS (Cuadro III). Sobre C(40,5) = 658.008 combinaciones devuelven 0,8 %, 26,6 % y 45,2 % de lo apostado.
const ANDES5_MODALITIES: SeedModality[] = [
  { code: 'MATCH5', name: '5 números exactos', min: 5, max: 5, factorX100: 500000, status: 'ACTIVE', description: 'Eliges 5 números del 01 al 40; se extraen 5. Si salen tus cinco, en cualquier orden, cobras 5.000× lo apostado.' },
  { code: 'MATCH4', name: '4 aciertos', min: 5, max: 5, factorX100: 100000, status: 'ACTIVE', description: 'Eliges 5 números; ganas si salen exactamente 4 de ellos. Cobras 1.000× lo apostado.' },
  { code: 'MATCH3', name: '3 aciertos', min: 5, max: 5, factorX100: 5000, status: 'ACTIVE', description: 'Eliges 5 números; ganas si salen exactamente 3 de ellos. Cobras 50× lo apostado.' },
  { code: 'MATCH5S', name: '5 exactos + estrella', min: 5, max: 5, factorX100: 2500000, status: 'ACTIVE', description: 'Tus cinco números y tu estrella. Cobras 25.000× lo apostado.' },
  { code: 'MATCH4S', name: '4 aciertos + estrella', min: 5, max: 5, factorX100: 500000, status: 'ACTIVE', description: 'Exactamente 4 de tus números y tu estrella. Cobras 5.000× lo apostado.' },
  { code: 'MATCH3S', name: '3 aciertos + estrella', min: 5, max: 5, factorX100: 25000, status: 'ACTIVE', description: 'Exactamente 3 de tus números y tu estrella. Cobras 250× lo apostado.' },
];

// Manual MER-08 «Cuatrifecta de Cumbres», cláusula décima octava: 2.000× / 300× / 100×.
// Terminal 4 cifras es indistinguible de la exacta (Anexo B.1) y la aproximación no tiene definidos los extremos (B.2): pendientes.
const CUATRIFECTA_MODALITIES: SeedModality[] = [
  { code: 'EXACT', name: 'Cuatrifecta exacta', min: 1, max: 1, factorX100: 200000, status: 'ACTIVE', description: 'Aciertas las cuatro cifras en el mismo orden (1234 gana solo si sale 1234). Cobras 2.000× lo apostado.' },
  // Terminal 4 cifras: para distinguirla de la exacta (Anexo B.1) se define como las 4 cifras en cualquier orden.
  { code: 'BOX', name: 'Terminal 4 cifras', min: 1, max: 1, factorX100: 30000, status: 'ACTIVE', description: 'Aciertas tus cuatro cifras en cualquier orden (1234 gana si sale 4321, 2143…). Cobras 300× lo apostado.' },
  { code: 'APPROX', name: 'Aproximación', min: 1, max: 1, factorX100: 10000, status: 'ACTIVE', description: 'Ganas si sale el número inmediatamente anterior o posterior al tuyo (juegas 1234: gana con 1233 o 1235; 0000 y 9999 tienen un solo vecino). Cobras 100× lo apostado.' },
];

// Manual MER-07 «Dupleta de Montaña», cláusula décima octava: 150× / 75× / 20×. Sobre 9.900 parejas, exacta e invertida
// devuelven 1,5 % y 0,8 %. Doble paridad queda pendiente: el manual no define cómo se apuesta (Anexo B.2) y a 20× sobre un
// evento de ~25 % devolvería ~495 % de lo apostado.
const DUPLETA_MODALITIES: SeedModality[] = [
  { code: 'EXACT', name: 'Dupleta exacta', min: 1, max: 1, factorX100: 15000, status: 'ACTIVE', description: 'Dos números distintos del 00 al 99, en el orden en que salen (25-52 gana solo si sale primero 25 y luego 52). Cobras 150× lo apostado.' },
  { code: 'REVERSED', name: 'Dupleta invertida', min: 1, max: 1, factorX100: 7500, status: 'ACTIVE', description: 'Tus dos números salen en orden contrario (juegas 25-52: gana si sale 52-25). Cobras 75× lo apostado.' },
  // Doble paridad: se apuesta a «ambos pares» o «ambos impares» (~25 % cada una); a 3× devuelve 74 % (a 20× devolvía ~495 %).
  { code: 'PARITY', name: 'Doble paridad', min: 1, max: 1, factorX100: 300, status: 'ACTIVE', description: 'Apuestas a que los dos números salen pares, o a que salen impares. Si aciertas, cobras 3× lo apostado.' },
];

const GAMES = [
  {
    // Ficha MER-05 (docs/Animalitos_de_Merida_MER-05.md). Es una propuesta sin autorización → modo demo.
    code: 'MER-05',
    name: 'Animalitos de Mérida',
    resultSource: 'MANUAL',
    // v1.1: 12 sorteos diarios, uno por hora de 09:00 a 20:00.
    times: ['09:00', '10:00', '11:00', '12:00', '13:00', '14:00', '15:00', '16:00', '17:00', '18:00', '19:00', '20:00'],
    payoutMultiplier: '50.00',
    license: 'Propuesta conceptual MER-05 · sin autorización oficial',
    animals: MERIDA_ANIMALS,
    modalities: MERIDA_MODALITIES,
    limits: { VES: { ...DEMO_LIMITS.VES, min: '5', perDraw: '5000' }, USDT: { ...DEMO_LIMITS.USDT, perDraw: '125' } } as Limits,
    // v2.0: un solo juego, 70 animales (00–69), exacto 50× (RTP 71,4 %).
    rulesVersion: 'MER-05 v2.0-borrador',
    merida: true,
    prizeExpiryDays: 3 as number | null,
    displayOrder: 1,
  },
  {
    // Ficha FUR MER-03 «Frutas del Páramo»: segundo juego, mismo principio que Animalitos. Propuesta sin autorización → demo.
    code: 'MER-03',
    name: 'Frutas del Páramo',
    resultSource: 'MANUAL',
    // Tres sorteos diarios (hora de Venezuela).
    times: ['09:30', '13:30', '18:30'],
    payoutMultiplier: '40.00',
    license: 'Propuesta conceptual MER-03 · sin autorización oficial',
    animals: PARAMO_FRUITS,
    modalities: PARAMO_MODALITIES,
    limits: { VES: { ...DEMO_LIMITS.VES, min: '5', perDraw: '5000' }, USDT: { ...DEMO_LIMITS.USDT, perDraw: '125' } } as Limits,
    // 70 frutas (00–69), fruta exacta 40× (RTP 57,1 %).
    rulesVersion: 'MER-03 v1.0-borrador',
    merida: true,
    prizeExpiryDays: 3 as number | null,
    displayOrder: 2,
  },
  {
    // Manual MER-01 «Triple Andino» (propuesta 1.0, 29-10-2026). Sin autorización → demo.
    code: 'MER-01',
    name: 'Triple Andino',
    resultSource: 'MANUAL',
    // Cláusula novena: 09:00, 13:00, 17:00 y 21:00 (hora de Venezuela), cierre 5 min antes.
    times: ['09:00', '13:00', '17:00', '21:00'],
    payoutMultiplier: '600.00',
    license: 'Propuesta conceptual MER-01 · sin autorización oficial',
    animals: TRIPLE_NUMBERS,
    modalities: TRIPLE_MODALITIES,
    // Bs. 5 mínimo (ejemplos del manual). Tope de pago por resultado = 500 × 600.
    limits: {
      VES: { min: '5', max: '500', ticket: '10000', liability: '300000', perDraw: '5000' },
      USDT: { min: '0.10', max: '12.50', ticket: '250', liability: '7500', perDraw: '125' },
    } as Limits,
    rulesVersion: 'MER-01 v1.0-borrador',
    merida: true,
    prizeExpiryDays: 3 as number | null,
    displayOrder: 3,
    board: 'DIGITS3',
  },
  {
    // Manual MER-02 «Kino Teleférico» (propuesta 1.0, 29-10-2026). Sin autorización → demo.
    code: 'MER-02',
    name: 'Kino Teleférico',
    resultSource: 'MANUAL',
    // Cláusula novena: 10:00, 14:00 y 18:00 (hora de Venezuela), cierre 5 min antes.
    times: ['10:00', '14:00', '18:00'],
    payoutMultiplier: '1000.00',
    license: 'Propuesta conceptual MER-02 · sin autorización oficial',
    animals: KINO_NUMBERS,
    modalities: KINO_MODALITIES,
    // Tope por combinación jugada = Bs. 50 × 20.000 (Kino 7).
    limits: {
      VES: { min: '5', max: '50', ticket: '10000', liability: '1000000', perDraw: '5000' },
      USDT: { min: '0.10', max: '1.25', ticket: '250', liability: '25000', perDraw: '125' },
    } as Limits,
    rulesVersion: 'MER-02 v1.0-borrador',
    merida: true,
    prizeExpiryDays: 3 as number | null,
    displayOrder: 4,
    board: 'KINO',
    drawCount: 7,
  },
  {
    // Manual MER-04 «Terminal Nevado» (propuesta 1.0, 29-10-2026). Sin autorización → demo.
    code: 'MER-04',
    name: 'Terminal Nevado',
    resultSource: 'MANUAL',
    // Cláusula novena: 09:00, 12:00, 15:00, 18:00 y 21:00 (hora de Venezuela), cierre 5 min antes.
    times: ['09:00', '12:00', '15:00', '18:00', '21:00'],
    payoutMultiplier: '100.00',
    license: 'Propuesta conceptual MER-04 · sin autorización oficial',
    animals: TERMINAL_NUMBERS,
    modalities: TERMINAL_MODALITIES,
    // Tope de pago por resultado = Bs. 500 × 100 (directo) + vecinos.
    limits: {
      VES: { min: '5', max: '500', ticket: '10000', liability: '60000', perDraw: '5000' },
      USDT: { min: '0.10', max: '12.50', ticket: '250', liability: '1500', perDraw: '125' },
    } as Limits,
    rulesVersion: 'MER-04 v1.0-borrador',
    merida: true,
    prizeExpiryDays: 3 as number | null,
    displayOrder: 5,
    board: 'DIGITS2',
  },
  {
    // Manual MER-09 «Cóndor Dorado» (propuesta 1.0, 29-10-2026). Sin autorización → demo.
    code: 'MER-09',
    name: 'Cóndor Dorado',
    resultSource: 'MANUAL',
    // Cláusula novena: 10:00, 14:00 y 18:00 (hora de Venezuela), cierre 5 min antes.
    times: ['10:00', '14:00', '18:00'],
    payoutMultiplier: '500.00',
    license: 'Propuesta conceptual MER-09 · sin autorización oficial',
    animals: CONDOR_SYMBOLS,
    modalities: CONDOR_MODALITIES,
    // Tope de pago por resultado: Bs. 200 × 500 (número + color) más lo que sume solo número y solo color.
    limits: {
      VES: { min: '5', max: '200', ticket: '10000', liability: '120000', perDraw: '5000' },
      USDT: { min: '0.10', max: '5', ticket: '250', liability: '3000', perDraw: '125' },
    } as Limits,
    rulesVersion: 'MER-09 v1.0-borrador',
    merida: true,
    prizeExpiryDays: 3 as number | null,
    displayOrder: 6,
    board: 'COLOR',
  },
  {
    // Manual MER-06 «Centena Andina» (propuesta 1.0, 29-10-2026). Sin autorización → demo.
    code: 'MER-06',
    name: 'Centena Andina',
    resultSource: 'MANUAL',
    // Cláusula novena: 09:00, 14:00 y 21:00 (hora de Venezuela), cierre 5 min antes.
    times: ['09:00', '14:00', '21:00'],
    payoutMultiplier: '200.00',
    license: 'Propuesta conceptual MER-06 · sin autorización oficial',
    animals: TRIPLE_NUMBERS,
    modalities: CENTENA_MODALITIES,
    // Tope de pago por resultado: Bs. 500 × 200 (centena exacta) más aproximación y par andino.
    limits: {
      VES: { min: '5', max: '500', ticket: '10000', liability: '120000', perDraw: '5000' },
      USDT: { min: '0.10', max: '12.50', ticket: '250', liability: '3000', perDraw: '125' },
    } as Limits,
    rulesVersion: 'MER-06 v1.0-borrador',
    merida: true,
    prizeExpiryDays: 3 as number | null,
    displayOrder: 7,
    board: 'DIGITS3',
  },
  {
    // Manual MER-10 «Andes 5 Estrella» (propuesta 1.0, 29-10-2026). Sin autorización → demo.
    code: 'MER-10',
    name: 'Andes 5 Estrella',
    resultSource: 'MANUAL',
    // Cláusula novena: 10:00, 14:00 y 20:00 (hora de Venezuela), cierre 5 min antes.
    times: ['10:00', '14:00', '20:00'],
    payoutMultiplier: '5000.00',
    license: 'Propuesta conceptual MER-10 · sin autorización oficial',
    animals: KINO_NUMBERS,
    modalities: ANDES5_MODALITIES,
    // Tope de pago por combinación jugada: Bs. 50 × 5.000.
    limits: {
      VES: { min: '5', max: '50', ticket: '10000', liability: '250000', perDraw: '5000' },
      USDT: { min: '0.10', max: '1.25', ticket: '250', liability: '6250', perDraw: '125' },
    } as Limits,
    rulesVersion: 'MER-10 v1.0-borrador',
    merida: true,
    prizeExpiryDays: 3 as number | null,
    displayOrder: 8,
    board: 'KINO',
    drawCount: 5,
    starMax: 5,
  },
  {
    // Manual MER-08 «Cuatrifecta de Cumbres» (propuesta 1.0, 29-10-2026). Sin autorización → demo.
    code: 'MER-08',
    name: 'Cuatrifecta de Cumbres',
    resultSource: 'MANUAL',
    // Cláusula novena: 09:30, 13:30 y 18:30 (hora de Venezuela), cierre 5 min antes.
    times: ['09:30', '13:30', '18:30'],
    payoutMultiplier: '2000.00',
    license: 'Propuesta conceptual MER-08 · sin autorización oficial',
    animals: CUATRIFECTA_NUMBERS,
    modalities: CUATRIFECTA_MODALITIES,
    // Tope de pago por resultado: Bs. 100 × 2.000 (cuatrifecta exacta) más aproximación.
    limits: {
      VES: { min: '5', max: '100', ticket: '10000', liability: '250000', perDraw: '5000' },
      USDT: { min: '0.10', max: '2.50', ticket: '250', liability: '6250', perDraw: '125' },
    } as Limits,
    rulesVersion: 'MER-08 v1.0-borrador',
    merida: true,
    prizeExpiryDays: 3 as number | null,
    displayOrder: 9,
    board: 'DIGITS4',
  },
  {
    // Manual MER-07 «Dupleta de Montaña» (propuesta 1.0, 29-10-2026). Sin autorización → demo.
    code: 'MER-07',
    name: 'Dupleta de Montaña',
    resultSource: 'MANUAL',
    // Cláusula novena: 09:00, 12:00, 16:00 y 20:00 (hora de Venezuela), cierre 5 min antes.
    times: ['09:00', '12:00', '16:00', '20:00'],
    payoutMultiplier: '150.00',
    license: 'Propuesta conceptual MER-07 · sin autorización oficial',
    animals: DUPLETA_SYMBOLS,
    modalities: DUPLETA_MODALITIES,
    // Tope de pago por resultado: Bs. 500 × 150 (exacta) más la invertida que pague con esa misma pareja.
    limits: {
      VES: { min: '5', max: '500', ticket: '10000', liability: '120000', perDraw: '5000' },
      USDT: { min: '0.10', max: '12.50', ticket: '250', liability: '3000', perDraw: '125' },
    } as Limits,
    rulesVersion: 'MER-07 v1.0-borrador',
    merida: true,
    prizeExpiryDays: 3 as number | null,
    displayOrder: 10,
    board: 'DUO',
  },
];

/** Jugadores de prueba DEMO. Datos ficticios; la contraseña común viene de SEED_TEST_PLAYERS_PASSWORD (.env). */
const TEST_PLAYERS = [
  { email: 'prueba1@fortunabet.test', first: 'Ana', last: 'Pérez', doc: '20111111', phone: '584140000011', birth: '1992-03-14', state: 'Mérida', city: 'Mérida', currency: 'VES', kyc: 2 },
  { email: 'prueba2@fortunabet.test', first: 'Luis', last: 'Rondón', doc: '20222222', phone: '584140000012', birth: '1988-07-02', state: 'Táchira', city: 'San Cristóbal', currency: 'USDT', kyc: 2 },
  { email: 'prueba3@fortunabet.test', first: 'María', last: 'Gil', doc: '20333333', phone: '584140000013', birth: '1995-11-21', state: 'Zulia', city: 'Maracaibo', currency: 'VES', kyc: 2 },
  { email: 'prueba4@fortunabet.test', first: 'Carlos', last: 'Mora', doc: '20444444', phone: '584140000014', birth: '1990-01-30', state: 'Lara', city: 'Barquisimeto', currency: 'VES', kyc: 1 },
  { email: 'prueba5@fortunabet.test', first: 'Sofía', last: 'Díaz', doc: '20555555', phone: '584140000015', birth: '1999-05-09', state: 'Distrito Capital', city: 'Caracas', currency: 'USDT', kyc: 1 },
];

async function main() {
  const missingGamesOnly = process.argv.includes('--missing-games-only');
  let addedGames = 0;
  const pool = new Pool({ connectionString: config.databaseUrl });
  const ledger = new LedgerService();
  const audit = new AuditService();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`INSERT INTO wallet.currency (code, minor_unit, is_crypto) VALUES ('VES', 2, false), ('USDT', 6, true)
                        ON CONFLICT DO NOTHING`);

    for (const g of GAMES) {
      if (missingGamesOnly && (await client.query('SELECT 1 FROM lottery.game WHERE code = $1', [g.code])).rowCount) continue;
      const res = await client.query(
        `INSERT INTO lottery.game (code, name, result_source, payout_multiplier, close_minutes_before, license_ref, rules_version,
                                   is_demo, requires_record, publish_preliminary, prize_expiry_days, display_order, board, draw_count, auto_rng, star_max)
         -- auto_rng solo al crear: en la DEMO los sorteos programados publican su resultado solos; luego lo decide Configuración.
         VALUES ($1, $2, $3, $9, 5, $4, $5, $6, $6, $6, $7, $8, $10, $11, true, $12)
         ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, license_ref = EXCLUDED.license_ref,
           rules_version = EXCLUDED.rules_version, is_demo = EXCLUDED.is_demo, requires_record = EXCLUDED.requires_record,
           publish_preliminary = EXCLUDED.publish_preliminary, prize_expiry_days = EXCLUDED.prize_expiry_days,
           display_order = EXCLUDED.display_order, board = EXCLUDED.board, draw_count = EXCLUDED.draw_count
         RETURNING id`,
        [g.code, g.name, g.resultSource, g.license, g.rulesVersion, g.merida, g.prizeExpiryDays, g.displayOrder, g.payoutMultiplier, 'board' in g ? g.board : 'SYMBOLS', 'drawCount' in g ? g.drawCount : 1, 'starMax' in g ? g.starMax : null],
      );
      const gameId = res.rows[0].id;
      addedGames++;
      // En un solo INSERT (Cuatrifecta trae 10.000 símbolos).
      await client.query(
        `INSERT INTO lottery.symbol (game_id, number, name, emoji, sort)
         SELECT $1, s.number, s.name, s.emoji, s.sort - 1
           FROM unnest($2::text[], $3::text[], $4::text[]) WITH ORDINALITY AS s(number, name, emoji, sort)
         ON CONFLICT (game_id, number) DO NOTHING`,
        [gameId, g.animals.map((a) => a.number), g.animals.map((a) => a.name), g.animals.map((a) => a.emoji)],
      );
      for (const [i, m] of g.modalities.entries()) {
        await client.query(
          `INSERT INTO lottery.modality (game_id, code, name, min_selections, max_selections, factor_x100, status, description, sort)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT (game_id, code) DO NOTHING`,
          [gameId, m.code, m.name, m.min, m.max, m.factorX100, m.status, m.description, i],
        );
      }
      for (let weekday = 0; weekday < 7; weekday++) {
        for (const t of g.times) {
          await client.query(
            `INSERT INTO lottery.schedule (game_id, weekday, draw_time) VALUES ($1, $2, $3::time)
             ON CONFLICT DO NOTHING`,
            [gameId, weekday, t],
          );
        }
      }
      for (const [currency, l] of Object.entries(g.limits)) {
        const cur = currency as keyof Limits;
        await client.query(
          `INSERT INTO lottery.game_limit (game_id, currency, min_play, max_play, max_ticket, max_liability_per_symbol, max_player_per_draw)
           VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT DO NOTHING`,
          [gameId, cur, parseAmount(l.min, cur), parseAmount(l.max, cur), parseAmount(l.ticket, cur), parseAmount(l.liability, cur), l.perDraw ? parseAmount(l.perDraw, cur) : null]
            .map((v) => (v === null ? null : String(v))),
        );
      }
    }

    if (missingGamesOnly) {
      await client.query('COMMIT');
      console.log(`Juegos nuevos cargados: ${addedGames}. Configuracion existente y usuarios conservados.`);
      return;
    }

    const staff = [
      { email: process.env.SEED_ADMIN_EMAIL, password: process.env.SEED_ADMIN_PASSWORD, role: 'ADMIN', first: 'Admin', last: 'Principal' },
      { email: process.env.SEED_SUPERVISOR_EMAIL, password: process.env.SEED_SUPERVISOR_PASSWORD, role: 'LOTTERY_OPERATOR', first: 'Supervisor', last: 'Sorteos' },
      { email: process.env.SEED_COMPLIANCE_EMAIL, password: process.env.SEED_COMPLIANCE_PASSWORD, role: 'COMPLIANCE', first: 'Oficial', last: 'Cumplimiento' },
      { email: process.env.SEED_TRADER_EMAIL, password: process.env.SEED_TRADER_PASSWORD, role: 'SPORTS_TRADER', first: 'Trader', last: 'Deportes' },
    ];
    for (const s of staff) {
      if (!s.email || !s.password) continue;
      await client.query(
        `INSERT INTO identity.app_user (kind, role, email, first_name, last_name, password_hash)
         VALUES ('STAFF', $1, $2, $3, $4, $5) ON CONFLICT DO NOTHING`,
        [s.role, s.email, s.first, s.last, await argon2.hash(s.password, { type: argon2.argon2id })],
      );
    }

    const playerEmail = process.env.SEED_PLAYER_EMAIL;
    const playerPassword = process.env.SEED_PLAYER_PASSWORD;
    if (playerEmail && playerPassword) {
      const p = await client.query(
        `INSERT INTO identity.app_user (kind, role, email, phone, document_type, document_number, first_name, last_name,
                                        birth_date, state, city, password_hash, currency_default)
         VALUES ('PLAYER', 'PLAYER', $1, '584140000001', 'V', '10000001', 'Jugador', 'Demo', '1990-05-20',
                 'Distrito Capital', 'Caracas', $2, 'VES')
         ON CONFLICT DO NOTHING RETURNING id`,
        [playerEmail, await argon2.hash(playerPassword, { type: argon2.argon2id })],
      );
      if (p.rows[0]) {
        const playerId = p.rows[0].id;
        // Saldo inicial de prueba como un depósito aprobado, pasando por el ledger.
        for (const [currency, amount] of [['VES', '5000'], ['USDT', '100']] as const) {
          const v = parseAmount(amount, currency);
          const dep = await client.query(
            `INSERT INTO payments.deposit (player_id, method, currency, amount, bank, reference, status, reviewed_at)
             VALUES ($1, $2, $3, $4, 'SEED', $5, 'APPROVED', now()) RETURNING id`,
            [playerId, currency === 'VES' ? 'PAGO_MOVIL' : 'USDT', currency, v.toString(), `SEED${currency}${playerId.slice(0, 8)}`],
          );
          const tx = await ledger.post(client, {
            type: 'DEPOSIT',
            refProduct: 'PAYMENT',
            refId: dep.rows[0].id,
            idempotencyKey: `payment:deposit:${dep.rows[0].id}`,
            entries: [
              { accountId: await ledger.house(client, 'PAYMENT_CLEARING', currency === 'VES' ? 'PAGO_MOVIL' : 'USDT', currency), direction: 'D', amount: v },
              { accountId: await ledger.playerCash(client, playerId, currency), direction: 'C', amount: v },
            ],
          });
          await client.query(`UPDATE payments.deposit SET ledger_tx_id = $2 WHERE id = $1`, [dep.rows[0].id, tx.transactionId]);
        }
        await audit.log(client, { actorType: 'SYSTEM', action: 'SEED_PLAYER_CREATED', entity: 'app_user', entityId: playerId });
      }
      // El jugador demo viene verificado (nivel 2) para poder retirar; los nuevos registros empiezan en nivel 1.
      const upgraded = await client.query(
        `UPDATE identity.app_user SET kyc_level = 2 WHERE lower(email) = lower($1) AND kyc_level < 2 RETURNING id`,
        [playerEmail],
      );
      if (upgraded.rows[0]) {
        await audit.log(client, {
          actorType: 'SYSTEM',
          action: 'KYC_LEVEL_CHANGED',
          entity: 'app_user',
          entityId: upgraded.rows[0].id,
          after: { level: 2, reason: 'Jugador demo del seed' },
        });
      }
    }

    // 5 jugadores de prueba (DEMO): se crean como un registro normal, con el bono de bienvenida por el ledger.
    // Los tres primeros vienen verificados (nivel 2: pueden retirar y operar futuros); los dos últimos en nivel 1.
    const testPassword = process.env.SEED_TEST_PLAYERS_PASSWORD;
    if (testPassword) {
      const hash = await argon2.hash(testPassword, { type: argon2.argon2id });
      for (const t of TEST_PLAYERS) {
        const r = await client.query(
          `INSERT INTO identity.app_user (kind, role, email, phone, document_type, document_number, first_name, last_name,
                                          birth_date, state, city, password_hash, currency_default, kyc_level, demo_terms_accepted_at)
           VALUES ('PLAYER', 'PLAYER', $1, $2, 'V', $3, $4, $5, $6, $7, $8, $9, $10, $11, now())
           ON CONFLICT DO NOTHING RETURNING id`,
          [t.email, t.phone, t.doc, t.first, t.last, t.birth, t.state, t.city, hash, t.currency, t.kyc],
        );
        if (!r.rows[0]) continue;
        await ledger.playerCash(client, r.rows[0].id, 'VES');
        await ledger.playerCash(client, r.rows[0].id, 'USDT');
        await grantSignupBonus(client, ledger, audit, r.rows[0].id);
        await audit.log(client, { actorType: 'SYSTEM', action: 'SEED_TEST_PLAYER_CREATED', entity: 'app_user', entityId: r.rows[0].id, after: { email: t.email, kyc: t.kyc } });
      }
    }

    if (config.sportsEnabled) await seedSports(client);

    await client.query('COMMIT');
    console.log('Seed completado.');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
