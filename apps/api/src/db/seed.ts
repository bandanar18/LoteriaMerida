import { KINO_NUMBERS, MERIDA_ANIMALS, PARAMO_FRUITS, TERMINAL_NUMBERS, TRIPLE_NUMBERS, parseAmount } from '@loteria/domain';
import * as argon2 from 'argon2';
import { Pool } from 'pg';
import { AuditService } from '../audit/audit.service';
import { config } from '../config';
import { LedgerService } from '../wallet/ledger.service';
import { seedSports } from './seed-sports';

/**
 * Datos iniciales para desarrollo local (idempotente).
 * Las credenciales de prueba se leen de apps/api/.env (ver .env.example).
 */
type Limits = Record<'VES' | 'USDT', { min: string; max: string; ticket: string; liability: string; perDraw?: string }>;
type SeedModality = {
  code: 'EXACT' | 'COMBINADA' | 'MULTIPLE' | 'TERMINAL' | 'LAST_DIGIT' | 'FULL' | 'KINO5' | 'KINO6' | 'KINO7' | 'APPROX' | 'SUPER' | 'DUAL';
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
];

async function main() {
  const pool = new Pool({ connectionString: config.databaseUrl });
  const ledger = new LedgerService();
  const audit = new AuditService();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`INSERT INTO wallet.currency (code, minor_unit, is_crypto) VALUES ('VES', 2, false), ('USDT', 6, true)
                        ON CONFLICT DO NOTHING`);

    for (const g of GAMES) {
      const res = await client.query(
        `INSERT INTO lottery.game (code, name, result_source, payout_multiplier, close_minutes_before, license_ref, rules_version,
                                   is_demo, requires_record, publish_preliminary, prize_expiry_days, display_order, board, draw_count)
         VALUES ($1, $2, $3, $9, 5, $4, $5, $6, $6, $6, $7, $8, $10, $11)
         ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, license_ref = EXCLUDED.license_ref,
           rules_version = EXCLUDED.rules_version, is_demo = EXCLUDED.is_demo, requires_record = EXCLUDED.requires_record,
           publish_preliminary = EXCLUDED.publish_preliminary, prize_expiry_days = EXCLUDED.prize_expiry_days,
           display_order = EXCLUDED.display_order, board = EXCLUDED.board, draw_count = EXCLUDED.draw_count
         RETURNING id`,
        [g.code, g.name, g.resultSource, g.license, g.rulesVersion, g.merida, g.prizeExpiryDays, g.displayOrder, g.payoutMultiplier, 'board' in g ? g.board : 'SYMBOLS', 'drawCount' in g ? g.drawCount : 1],
      );
      const gameId = res.rows[0].id;
      for (const [i, a] of g.animals.entries()) {
        await client.query(
          `INSERT INTO lottery.symbol (game_id, number, name, emoji, sort) VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (game_id, number) DO NOTHING`,
          [gameId, a.number, a.name, a.emoji, i],
        );
      }
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
