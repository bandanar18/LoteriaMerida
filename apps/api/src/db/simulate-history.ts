import { Pool } from 'pg';
import { AuditService } from '../audit/audit.service';
import { config } from '../config';
import { RngService } from '../rng/rng.service';

/**
 * Historial simulado para desarrollo: crea los sorteos que faltan de los últimos N días (y las horas ya pasadas de hoy)
 * según el calendario de cada juego, y les pone resultado con el mismo RNG provably fair de los sorteos reales.
 *
 * - Solo crea sorteos sin jugadas; no toca sorteos existentes con jugadas ni sorteos de simulación.
 * - Los marca en result_evidence como "Historial simulado (desarrollo)" y deja registro en auditoría.
 * - Se niega a correr si SIMULATION_MODE está apagado (producción).
 *
 * Uso: npm run simulate:history -w @loteria/api -- [días=2]
 */
async function main() {
  if (!config.simulationMode) throw new Error('SIMULATION_MODE está apagado: no se genera historial simulado.');
  const days = Math.min(Math.max(Number(process.argv[2] ?? 2), 1), 30);
  const pool = new Pool({ connectionString: config.databaseUrl });
  const rng = new RngService();
  const audit = new AuditService();
  const client = await pool.connect();
  let created = 0;
  let resolved = 0;
  try {
    await client.query('BEGIN');
    const games = (await client.query(`SELECT id, code, timezone, close_minutes_before FROM lottery.game WHERE status = 'ACTIVE' ORDER BY display_order`)).rows;
    for (const g of games) {
      const symbols = (await client.query(`SELECT id, number, name FROM lottery.symbol WHERE game_id = $1 ORDER BY sort`, [g.id])).rows;

      // 1) Sorteos faltantes de días anteriores y de horas ya pasadas de hoy.
      const slots = (
        await client.query(
          `SELECT ((day.d + s.draw_time) AT TIME ZONE $2) AS draw_at, (day.d::timestamp AT TIME ZONE $2) AS sales_open_at
             FROM generate_series(1, $3::int) k
             CROSS JOIN LATERAL (SELECT ((now() AT TIME ZONE $2)::date - k + 1) AS d) day
             JOIN lottery.schedule s ON s.game_id = $1 AND s.active AND s.weekday = extract(dow FROM day.d)
            WHERE ((day.d + s.draw_time) AT TIME ZONE $2) < now()
              AND NOT EXISTS (SELECT 1 FROM lottery.draw x WHERE x.game_id = $1 AND x.draw_at = ((day.d + s.draw_time) AT TIME ZONE $2))
            ORDER BY 1`,
          [g.id, g.timezone, days + 1],
        )
      ).rows;
      for (const s of slots) {
        const { serverSeed, seedHash } = rng.newCommitment();
        const d = (
          await client.query(
            `INSERT INTO lottery.draw (game_id, draw_at, sales_open_at, close_at, status, seed_hash, server_seed)
             VALUES ($1, $2, $3, $2::timestamptz - make_interval(mins => $4), 'CLOSED', $5, $6) RETURNING id`,
            [g.id, s.draw_at, s.sales_open_at, g.close_minutes_before, seedHash, serverSeed],
          )
        ).rows[0];
        await resolve(d.id, serverSeed);
        created++;
      }

      // 2) Sorteos ya vencidos de esos días que quedaron sin resultado y sin jugadas (p. ej. resultado manual nunca cargado).
      const stale = (
        await client.query(
          `SELECT d.id, d.server_seed FROM lottery.draw d
            WHERE d.game_id = $1 AND d.sim_player_id IS NULL AND d.draw_at < now()
              AND d.draw_at >= ((now() AT TIME ZONE $2)::date - $3::int)::timestamp AT TIME ZONE $2
              AND d.status IN ('SCHEDULED', 'OPEN', 'CLOSED')
              AND NOT EXISTS (SELECT 1 FROM lottery.play p WHERE p.draw_id = d.id)`,
          [g.id, g.timezone, days],
        )
      ).rows;
      for (const d of stale) {
        await resolve(d.id, d.server_seed);
        resolved++;
      }

      async function resolve(drawId: string, serverSeed: string) {
        const idx = await rng.fromCommitment(client, { consumer: 'lottery.draw', refId: drawId, serverSeed, n: symbols.length });
        const w = symbols[idx];
        await client.query(
          `UPDATE lottery.draw SET status = 'SETTLED', result_symbol_id = $2, confirmed_at = draw_at, settled_at = draw_at,
                  close_at = least(close_at, draw_at), result_evidence = 'Historial simulado (desarrollo) · RNG provably fair'
            WHERE id = $1`,
          [drawId, w.id],
        );
        await audit.log(client, {
          actorType: 'SYSTEM',
          action: 'DRAW_RESULT_SIMULATED_HISTORY',
          entity: 'lottery.draw',
          entityId: drawId,
          after: { game: g.code, symbol: `${w.number} ${w.name}`, index: idx },
        });
      }
    }
    await client.query('COMMIT');
    console.log(`Historial simulado: ${created} sorteos creados y ${resolved} sorteos vencidos resueltos (últimos ${days} día(s) + hoy).`);
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
