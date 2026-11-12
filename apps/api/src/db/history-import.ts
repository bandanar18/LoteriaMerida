import { existsSync, readFileSync } from 'fs';
import { Pool } from 'pg';
import { config } from '../config';
import { HISTORY_FILE } from './history-export';

/**
 * Carga en la base local el historial de sorteos guardado en el repositorio (apps/api/data/historial-sorteos.json).
 * Idempotente: no toca sorteos que ya existan (mismo id o mismo juego y hora). Los juegos se buscan por código y el
 * resultado por número; el id del sorteo se conserva para que la verificación provably fair coincida.
 *
 * Uso: npm run historial:importar -w @loteria/api
 */
async function main() {
  if (!existsSync(HISTORY_FILE)) {
    console.log('No hay historial guardado en el repositorio (apps/api/data/historial-sorteos.json).');
    return;
  }
  const { draws } = JSON.parse(readFileSync(HISTORY_FILE, 'utf8')) as { draws: Record<string, unknown>[] };
  const pool = new Pool({ connectionString: config.databaseUrl });
  try {
    const { rowCount } = await pool.query(
      `INSERT INTO lottery.draw (id, game_id, draw_at, sales_open_at, close_at, status, is_extraordinary, auto_rng, seed_hash, server_seed,
                                 result_symbol_id, result_numbers, result_star, result_evidence, cancelled_reason, confirmed_at, settled_at)
       SELECT h.id, g.id, h.draw_at, h.sales_open_at, h.close_at, h.status, h.is_extraordinary, h.auto_rng, h.seed_hash, h.server_seed,
              s.id, h.result_numbers, h.result_star, h.result_evidence, h.cancelled_reason, h.confirmed_at, h.settled_at
         FROM jsonb_to_recordset($1::jsonb) AS h(
                id uuid, game text, draw_at timestamptz, sales_open_at timestamptz, close_at timestamptz, status text,
                is_extraordinary boolean, auto_rng boolean, seed_hash text, server_seed text, result text, result_numbers smallint[], result_star smallint,
                result_evidence text, cancelled_reason text, confirmed_at timestamptz, settled_at timestamptz)
         JOIN lottery.game g ON g.code = h.game
         LEFT JOIN lottery.symbol s ON s.game_id = g.id AND s.number = h.result
        WHERE h.status = 'CANCELLED' OR s.id IS NOT NULL
       ON CONFLICT DO NOTHING`,
      [JSON.stringify(draws)],
    );
    console.log(`Historial del repositorio: ${rowCount ?? 0} sorteos nuevos cargados (${draws.length} en el archivo; los que ya existían no se tocan).`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
