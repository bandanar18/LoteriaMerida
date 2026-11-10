import { Pool } from 'pg';
import { AuditService } from '../audit/audit.service';
import { config } from '../config';
import { RngService } from '../rng/rng.service';

/**
 * Historial de muestra para la DEMO: crea los sorteos que faltan de los últimos días (incluido hoy, solo horas ya pasadas)
 * y les pone resultado con el mismo RNG provably fair de los sorteos reales (semilla comprometida, verificable en Resultados).
 *
 * - Horas: por defecto las del calendario de cada juego; con --desde/--hasta, cada hora en punto de ese rango (hora local).
 * - Sorteos vencidos SIN jugadas que quedaron sin resultado: se resuelven aquí mismo.
 * - Sorteos vencidos CON jugadas que esperan resultado: se pasan a resultado automático y el ciclo del API los sortea y
 *   liquida sus tickets (necesita el API encendido). Nunca se toca un sorteo con resultado ya propuesto o confirmado.
 * - Marca los creados en result_evidence como "Historial de muestra (DEMO)" y deja registro en auditoría.
 * - Se niega a correr si SIMULATION_MODE está apagado (producción).
 *
 * Uso: npm run simulate:history -w @loteria/api -- [días=2] [--desde 8 --hasta 20]
 *      (días = días anteriores a hoy; hoy siempre se incluye)
 */
async function main() {
  if (!config.simulationMode) throw new Error('SIMULATION_MODE está apagado: no se genera historial simulado.');
  const args = process.argv.slice(2);
  const flag = (name: string) => {
    const i = args.indexOf(name);
    return i >= 0 ? Number(args[i + 1]) : null;
  };
  const days = Math.min(Math.max(Number(args.find((a) => /^\d+$/.test(a) && !isFlagValue(a)) ?? 2), 0), 30);
  function isFlagValue(a: string) {
    const i = args.indexOf(a);
    return i > 0 && args[i - 1].startsWith('--');
  }
  const from = flag('--desde');
  const to = flag('--hasta');
  const hourly = from !== null && to !== null;
  if (hourly && !(from >= 0 && to <= 23 && from <= to)) throw new Error('Usa --desde y --hasta entre 0 y 23 (desde ≤ hasta).');

  const pool = new Pool({ connectionString: config.databaseUrl });
  const rng = new RngService();
  const audit = new AuditService();
  const client = await pool.connect();
  let created = 0;
  let resolved = 0;
  let handedOver = 0;
  try {
    await client.query('BEGIN');
    const games = (
      await client.query(`SELECT id, code, timezone, close_minutes_before, board, draw_count FROM lottery.game WHERE status = 'ACTIVE' ORDER BY display_order`)
    ).rows;
    for (const g of games) {
      const symbols = (await client.query(`SELECT id, number, name FROM lottery.symbol WHERE game_id = $1 ORDER BY sort`, [g.id])).rows;
      const dayStart = `((now() AT TIME ZONE $2)::date - $3::int)::timestamp AT TIME ZONE $2`;

      // 1) Sorteos faltantes: horas del rango pedido (o del calendario) ya pasadas.
      const slots = (
        await client.query(
          hourly
            ? `SELECT ((day.d + make_interval(hours => h)) AT TIME ZONE $2) AS draw_at, (day.d::timestamp AT TIME ZONE $2) AS sales_open_at
                 FROM generate_series(0, $3::int) k
                 CROSS JOIN LATERAL (SELECT ((now() AT TIME ZONE $2)::date - k) AS d) day
                 CROSS JOIN generate_series($4::int, $5::int) h
                WHERE ((day.d + make_interval(hours => h)) AT TIME ZONE $2) < now()
                  AND NOT EXISTS (SELECT 1 FROM lottery.draw x WHERE x.game_id = $1 AND x.draw_at = ((day.d + make_interval(hours => h)) AT TIME ZONE $2))
                ORDER BY 1`
            : `SELECT ((day.d + s.draw_time) AT TIME ZONE $2) AS draw_at, (day.d::timestamp AT TIME ZONE $2) AS sales_open_at
                 FROM generate_series(0, $3::int) k
                 CROSS JOIN LATERAL (SELECT ((now() AT TIME ZONE $2)::date - k) AS d) day
                 JOIN lottery.schedule s ON s.game_id = $1 AND s.active AND s.weekday = extract(dow FROM day.d)
                WHERE ((day.d + s.draw_time) AT TIME ZONE $2) < now()
                  AND NOT EXISTS (SELECT 1 FROM lottery.draw x WHERE x.game_id = $1 AND x.draw_at = ((day.d + s.draw_time) AT TIME ZONE $2))
                ORDER BY 1`,
          hourly ? [g.id, g.timezone, days, from, to] : [g.id, g.timezone, days],
        )
      ).rows;
      for (const s of slots) {
        const { serverSeed, seedHash } = rng.newCommitment();
        const d = (
          await client.query(
            `INSERT INTO lottery.draw (game_id, draw_at, sales_open_at, close_at, status, seed_hash, server_seed, auto_rng)
             VALUES ($1, $2, $3, $2::timestamptz - make_interval(mins => $4), 'CLOSED', $5, $6, true) RETURNING id`,
            [g.id, s.draw_at, s.sales_open_at, g.close_minutes_before, seedHash, serverSeed],
          )
        ).rows[0];
        await resolve(d.id, serverSeed);
        created++;
      }

      // 2) Vencidos sin resultado y sin jugadas (p. ej. resultado manual nunca cargado): se resuelven aquí.
      const stale = (
        await client.query(
          `SELECT d.id, d.server_seed FROM lottery.draw d
            WHERE d.game_id = $1 AND d.sim_player_id IS NULL AND d.draw_at < now() AND d.draw_at >= ${dayStart}
              AND d.status IN ('SCHEDULED', 'OPEN', 'CLOSED')
              AND NOT EXISTS (SELECT 1 FROM lottery.play p WHERE p.draw_id = d.id)`,
          [g.id, g.timezone, days],
        )
      ).rows;
      for (const d of stale) {
        await resolve(d.id, d.server_seed);
        resolved++;
      }

      // 3) Vencidos con jugadas que esperan resultado: los sortea y liquida el ciclo del API con el RNG comprometido.
      const { rowCount } = await client.query(
        `UPDATE lottery.draw d SET auto_rng = true
          WHERE d.game_id = $1 AND d.sim_player_id IS NULL AND d.draw_at < now() AND d.draw_at >= ${dayStart}
            AND d.status = 'CLOSED' AND NOT d.auto_rng`,
        [g.id, g.timezone, days],
      );
      handedOver += rowCount ?? 0;

      async function resolve(drawId: string, serverSeed: string) {
        let symbolId: string;
        let numbers: number[] | null = null;
        let label: string;
        if (g.board === 'KINO') {
          // Kino: 7 números distintos en orden de extracción, como en el sorteo real.
          const idxs = await rng.sampleFromCommitment(client, {
            consumer: 'lottery.draw', refId: drawId, serverSeed, n: symbols.length, k: g.draw_count,
          });
          numbers = idxs.map((i) => Number(symbols[i].number));
          symbolId = symbols[idxs[0]].id;
          label = numbers.map((x) => String(x).padStart(2, '0')).join('-');
        } else {
          const idx = await rng.fromCommitment(client, { consumer: 'lottery.draw', refId: drawId, serverSeed, n: symbols.length });
          symbolId = symbols[idx].id;
          label = `${symbols[idx].number} ${symbols[idx].name}`;
        }
        await client.query(
          `UPDATE lottery.draw SET status = 'SETTLED', result_symbol_id = $2, result_numbers = $3::smallint[], auto_rng = true,
                  confirmed_at = draw_at, settled_at = draw_at, close_at = least(close_at, draw_at),
                  result_evidence = 'Historial de muestra (DEMO) · RNG provably fair'
            WHERE id = $1`,
          [drawId, symbolId, numbers ? `{${numbers.join(',')}}` : null],
        );
        await audit.log(client, {
          actorType: 'SYSTEM',
          action: 'DRAW_RESULT_SIMULATED_HISTORY',
          entity: 'lottery.draw',
          entityId: drawId,
          after: { game: g.code, result: label },
        });
      }
    }
    await client.query('COMMIT');
    console.log(
      `Historial de muestra: ${created} sorteos creados y ${resolved} vencidos resueltos; ` +
        `${handedOver} con tickets pasan a resultado automático (los sortea y liquida el API). ` +
        `Rango: hoy y ${days} día(s) antes${hourly ? `, de ${from}:00 a ${to}:00 cada hora` : ', según el calendario'}.`,
    );
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
