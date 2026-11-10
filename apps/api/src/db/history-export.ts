import { mkdirSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { Pool } from 'pg';
import { config } from '../config';

/**
 * Exporta al repositorio el historial de sorteos terminados (con resultado o anulados) para que cualquier
 * instalación muestre los mismos resultados: apps/api/data/historial-sorteos.json.
 *
 * - Solo sorteos ya realizados (liquidados o anulados), no archivados y que no sean del simulador.
 * - Se identifican por el código del juego y el número del resultado (los UUID de juegos y símbolos cambian entre
 *   instalaciones); el id del sorteo se conserva porque forma parte de la verificación provably fair.
 * - Incluye la semilla, que ya es pública para sorteos realizados. Nunca exporta sorteos futuros (su semilla es secreta).
 * - No exporta usuarios, tickets, saldos ni documentos.
 *
 * Uso: npm run historial:exportar -w @loteria/api
 */
export const HISTORY_FILE = join(__dirname, '..', '..', 'data', 'historial-sorteos.json');

async function main() {
  const pool = new Pool({ connectionString: config.databaseUrl });
  try {
    const { rows } = await pool.query(
      `SELECT d.id, g.code AS game, d.draw_at, d.sales_open_at, d.close_at, d.status, d.is_extraordinary, d.auto_rng,
              d.seed_hash, d.server_seed, s.number AS result, d.result_numbers, d.result_evidence, d.cancelled_reason,
              d.confirmed_at, d.settled_at
         FROM lottery.draw d
         JOIN lottery.game g ON g.id = d.game_id
         LEFT JOIN lottery.symbol s ON s.id = d.result_symbol_id
        WHERE g.status = 'ACTIVE' AND d.status IN ('SETTLED', 'CANCELLED') AND d.draw_at < now() AND d.archived_at IS NULL AND d.sim_player_id IS NULL
        ORDER BY g.code, d.draw_at`,
    );
    mkdirSync(dirname(HISTORY_FILE), { recursive: true });
    const draws = rows.map((r) => ({
      ...r,
      draw_at: r.draw_at.toISOString(),
      sales_open_at: r.sales_open_at.toISOString(),
      close_at: r.close_at.toISOString(),
      confirmed_at: r.confirmed_at?.toISOString() ?? null,
      settled_at: r.settled_at?.toISOString() ?? null,
    }));
    writeFileSync(HISTORY_FILE, `${JSON.stringify({ exportedAt: new Date().toISOString(), draws }, null, 1)}\n`, 'utf8');
    const games = new Set(draws.map((d) => d.game)).size;
    console.log(`Historial exportado: ${draws.length} sorteos de ${games} juegos → apps/api/data/historial-sorteos.json`);
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
