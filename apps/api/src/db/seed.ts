import { DEFAULT_ANIMALS, parseAmount } from '@loteria/domain';
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
const GAMES = [
  {
    code: 'TEPUY',
    name: 'Animalitos Tepuy',
    resultSource: 'INTERNAL_RNG',
    hours: [8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19],
    license: 'Sorteo propio con RNG provably fair (demo)',
  },
  {
    code: 'SABANA',
    name: 'Animalitos La Sabana',
    resultSource: 'MANUAL',
    hours: [9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19],
    license: 'Resultado cargado manualmente con doble verificación (demo)',
  },
];

const LIMITS = {
  VES: { min: '1', max: '2000', ticket: '10000', liability: '600000' },
  USDT: { min: '0.10', max: '50', ticket: '250', liability: '15000' },
} as const;

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
        `INSERT INTO lottery.game (code, name, result_source, payout_multiplier, close_minutes_before, license_ref)
         VALUES ($1, $2, $3, 30.00, 5, $4)
         ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
        [g.code, g.name, g.resultSource, g.license],
      );
      const gameId = res.rows[0].id;
      for (const [i, a] of DEFAULT_ANIMALS.entries()) {
        await client.query(
          `INSERT INTO lottery.symbol (game_id, number, name, emoji, sort) VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (game_id, number) DO NOTHING`,
          [gameId, a.number, a.name, a.emoji, i],
        );
      }
      for (let weekday = 0; weekday < 7; weekday++) {
        for (const h of g.hours) {
          await client.query(
            `INSERT INTO lottery.schedule (game_id, weekday, draw_time) VALUES ($1, $2, make_time($3, 0, 0))
             ON CONFLICT DO NOTHING`,
            [gameId, weekday, h],
          );
        }
      }
      for (const [currency, l] of Object.entries(LIMITS)) {
        const cur = currency as keyof typeof LIMITS;
        await client.query(
          `INSERT INTO lottery.game_limit (game_id, currency, min_play, max_play, max_ticket, max_liability_per_symbol)
           VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING`,
          [gameId, cur, parseAmount(l.min, cur), parseAmount(l.max, cur), parseAmount(l.ticket, cur), parseAmount(l.liability, cur)]
            .map(String),
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

    await seedSports(client);

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
