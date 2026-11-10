import 'reflect-metadata';
import { randomInt, randomUUID } from 'crypto';
import { parseAmount } from '@loteria/domain';
import { AffiliateService } from '../affiliate/affiliate.service';
import { AuditService } from '../audit/audit.service';
import { DbService } from '../common/db.service';
import { config } from '../config';
import { KycStorageService } from '../kyc/kyc-storage.service';
import { DrawLifecycleService } from '../lottery/draw-lifecycle.service';
import { LotteryService } from '../lottery/lottery.service';
import { RngService } from '../rng/rng.service';
import { LedgerService } from '../wallet/ledger.service';

/**
 * Mercado simulado para desarrollo: llena días anteriores con sorteos que SÍ tuvieron ventas, para ver el tablero
 * «Mercado» del backoffice con datos.
 *
 * Por cada hora del calendario (días que aún no tienen sorteo):
 *   1. abre el sorteo, 2. jugadores demo compran tickets con el flujo real (ledger, topes, factor congelado),
 *   3. lo lleva a su hora real, 4. sortea con el RNG provably fair (semilla comprometida ANTES de las ventas;
 *   el resultado no depende de lo vendido) y 5. liquida con la lógica real de pagos.
 *
 * - Jugadores demo `mercado.NN@demo.test` sin contraseña utilizable, con saldo de prueba vía ledger.
 * - Todo queda marcado como «Historial simulado (desarrollo)» y en auditoría.
 * - Se niega a correr si SIMULATION_MODE está apagado (producción).
 *
 * Uso: npm run simulate:market -w @loteria/api -- [días=14] [código=MER-05] [desdeHaceDías=3]
 */
const PLAYERS = 24;
const AMOUNTS = [5, 5, 10, 10, 10, 20, 20, 50, 50, 100, 200];

async function main() {
  if (!config.simulationMode) throw new Error('SIMULATION_MODE está apagado: no se genera mercado simulado.');
  const days = Math.min(Math.max(Number(process.argv[2] ?? 14), 1), 60);
  const code = process.argv[3] ?? 'MER-05';
  const offset = Math.max(Number(process.argv[4] ?? 3), 1);

  const db = new DbService();
  const ledger = new LedgerService();
  const audit = new AuditService();
  const rng = new RngService();
  const affiliate = new AffiliateService(ledger, audit);
  const lottery = new LotteryService(db, ledger, audit, affiliate);
  const lifecycle = new DrawLifecycleService(db, ledger, audit, rng, new KycStorageService(), affiliate);

  try {
    const game = await db.one(`SELECT id, code, timezone, close_minutes_before FROM lottery.game WHERE code = $1`, [code]);
    if (!game) throw new Error(`No existe el juego ${code}`);
    const symbols = await db.query(`SELECT id FROM lottery.symbol WHERE game_id = $1 ORDER BY sort`, [game.id]);

    // Jugadores demo con saldo de prueba.
    const players: string[] = [];
    for (let i = 1; i <= PLAYERS; i++) {
      const nn = String(i).padStart(2, '0');
      const id = await db.tx(async (c) => {
        const found = (await c.query(`SELECT id FROM identity.app_user WHERE lower(email) = $1`, [`mercado.${nn}@demo.test`])).rows[0];
        if (found) return found.id as string;
        const u = (
          await c.query(
            `INSERT INTO identity.app_user (kind, role, email, phone, document_type, document_number, first_name, last_name,
                                            birth_date, state, city, password_hash, currency_default, kyc_level)
             VALUES ('PLAYER', 'PLAYER', $1, $2, 'V', $3, 'Demo', $4, '1990-01-01', 'Mérida', 'Mérida', '!sin-acceso', 'VES', 2)
             RETURNING id`,
            [`mercado.${nn}@demo.test`, `58424000${String(1000 + i)}`, String(20000000 + i), `Mercado ${nn}`],
          )
        ).rows[0];
        await audit.log(c, { actorType: 'SYSTEM', action: 'SIM_MARKET_PLAYER_CREATED', entity: 'app_user', entityId: u.id });
        return u.id as string;
      });
      await db.tx(async (c) => {
        const amount = parseAmount('400000', 'VES');
        await ledger.post(c, {
          type: 'SIM_TOPUP',
          refProduct: 'ADJUST',
          refId: id,
          idempotencyKey: `sim:market:topup:${id}:${randomUUID()}`,
          metadata: { simulation: true, market: true },
          entries: [
            { accountId: await ledger.house(c, 'PAYMENT_CLEARING', 'SIMULATION', 'VES'), direction: 'D', amount },
            { accountId: await ledger.playerCash(c, id, 'VES'), direction: 'C', amount },
          ],
        });
      });
      players.push(id);
    }

    // Horas del calendario de días anteriores que todavía no tienen sorteo.
    const slots = await db.query(
      `SELECT ((day.d + s.draw_time) AT TIME ZONE $2) AS draw_at
         FROM generate_series($3::int, $3::int + $4::int - 1) k
         CROSS JOIN LATERAL (SELECT ((now() AT TIME ZONE $2)::date - k) AS d) day
         JOIN lottery.schedule s ON s.game_id = $1 AND s.active AND s.weekday = extract(dow FROM day.d)
        WHERE NOT EXISTS (SELECT 1 FROM lottery.draw x WHERE x.game_id = $1 AND x.draw_at = ((day.d + s.draw_time) AT TIME ZONE $2))
        ORDER BY 1`,
      [game.id, game.timezone, offset, days],
    );

    let tickets = 0;
    for (const [i, slot] of slots.entries()) {
      const { serverSeed, seedHash } = rng.newCommitment();
      const draw = (
        await db.query(
          `INSERT INTO lottery.draw (game_id, draw_at, sales_open_at, close_at, status, seed_hash, server_seed)
           VALUES ($1, now() + interval '2 hours', now(), now() + interval '1 hour', 'OPEN', $2, $3) RETURNING id`,
          [game.id, seedHash, serverSeed],
        )
      )[0];

      // Volumen variable por hora (más en la tarde) y por día.
      const hour = new Date(slot.draw_at).getUTCHours();
      const n = randomInt(8, 22) + (hour >= 20 ? 10 : 0);
      for (let t = 0; t < n; t++) {
        const picks = new Set<number>();
        const k = [1, 1, 1, 2, 2, 3, 4][randomInt(0, 7)];
        while (picks.size < k) picks.add(randomInt(0, symbols.length));
        try {
          await lottery.buyTicket(
            players[randomInt(0, players.length)],
            {
              gameId: game.id,
              currency: 'VES',
              plays: [...picks].map((p) => ({ drawId: draw.id, symbolId: symbols[p].id, amount: String(AMOUNTS[randomInt(0, AMOUNTS.length)]) })),
            },
            randomUUID(),
            '127.0.0.1',
          );
          tickets++;
        } catch {
          // Tope alcanzado: se ignora ese ticket, igual que en la vida real.
        }
      }

      // Llevar el sorteo a su hora real, con las ventas repartidas en la hora previa al cierre.
      await db.tx(async (c) => {
        await c.query(
          `UPDATE lottery.draw SET draw_at = $2, close_at = $2::timestamptz - make_interval(mins => $3),
                  sales_open_at = $2::timestamptz - interval '1 day', status = 'CLOSED' WHERE id = $1`,
          [draw.id, slot.draw_at, game.close_minutes_before],
        );
        await c.query(
          `UPDATE lottery.ticket t SET sold_at = $2::timestamptz - make_interval(mins => $3) - random() * interval '55 minutes'
            WHERE t.id IN (SELECT ticket_id FROM lottery.play WHERE draw_id = $1)`,
          [draw.id, slot.draw_at, game.close_minutes_before],
        );
        const idx = await rng.fromCommitment(c, { consumer: 'lottery.draw', refId: draw.id, serverSeed, n: symbols.length });
        await c.query(
          `UPDATE lottery.draw SET status = 'RESULT_CONFIRMED', result_symbol_id = $2, confirmed_at = draw_at,
                  result_evidence = 'Historial simulado (desarrollo) · RNG provably fair' WHERE id = $1`,
          [draw.id, symbols[idx].id],
        );
        await audit.log(c, { actorType: 'SYSTEM', action: 'DRAW_RESULT_SIMULATED_HISTORY', entity: 'lottery.draw', entityId: draw.id, after: { market: true, index: idx } });
      });
      await lifecycle.settleDraw(draw.id);
      await db.query(`UPDATE lottery.draw SET settled_at = draw_at WHERE id = $1`, [draw.id]);
      await db.query(`UPDATE lottery.play SET settled_at = (SELECT draw_at FROM lottery.draw WHERE id = $1) WHERE draw_id = $1`, [draw.id]);
      if ((i + 1) % 12 === 0) console.log(`  ${i + 1}/${slots.length} sorteos…`);
    }
    console.log(`Mercado simulado (${code}): ${slots.length} sorteos con ${tickets} tickets, de hace ${offset + days - 1} a hace ${offset} día(s).`);
  } finally {
    await db.pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
