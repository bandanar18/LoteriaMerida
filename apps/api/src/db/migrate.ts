import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { Client } from 'pg';
import { config } from '../config';

/** Ejecuta en orden los archivos migrations/NNN_*.sql que aún no se aplicaron. */
async function main() {
  const client = new Client({ connectionString: config.databaseUrl });
  await client.connect();
  try {
    await client.query(`CREATE TABLE IF NOT EXISTS public.schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
    const applied = new Set((await client.query(`SELECT name FROM public.schema_migrations`)).rows.map((r) => r.name));
    const dir = join(__dirname, '..', '..', 'migrations');
    const files = readdirSync(dir).filter((f) => /^\d+_.*\.sql$/.test(f)).sort();
    for (const file of files) {
      if (applied.has(file)) continue;
      console.log(`→ aplicando ${file}`);
      await client.query('BEGIN');
      try {
        await client.query(readFileSync(join(dir, file), 'utf8'));
        await client.query(`INSERT INTO public.schema_migrations (name) VALUES ($1)`, [file]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    }
    console.log('Migraciones al día.');
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
