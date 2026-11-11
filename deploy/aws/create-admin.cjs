// Run as the application user. The password is read from stdin and never logged.
const { readFileSync } = require('node:fs');
const argon2 = require('argon2');
const { Pool } = require('pg');
const { AuditService } = require('../../apps/api/dist/audit/audit.service');

require('dotenv').config({ path: '/etc/loteria.env' });

async function main() {
  const email = process.argv[2]?.trim().toLowerCase();
  const password = readFileSync(0, 'utf8');
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('A valid email is required');
  if (password.length < 10 || password.length > 128 || !/[a-zA-Z]/.test(password) || !/\d/.test(password)) {
    throw new Error('Password must contain 10-128 characters, letters and numbers');
  }
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  try {
    const hash = await argon2.hash(password, { type: argon2.argon2id });
    await client.query('BEGIN');
    const existing = await client.query('SELECT id FROM identity.app_user WHERE lower(email) = $1', [email]);
    if (existing.rowCount) throw new Error('Account already exists; no changes made');
    const result = await client.query(
      `INSERT INTO identity.app_user (kind, role, email, first_name, last_name, password_hash)
       VALUES ('STAFF', 'ADMIN', $1, 'Administrador', 'Principal', $2) RETURNING id`,
      [email, hash],
    );
    await new AuditService().log(client, {
      actorType: 'SYSTEM', action: 'ADMIN_CREATED', entity: 'app_user', entityId: result.rows[0].id,
      after: { email, kind: 'STAFF', role: 'ADMIN' },
    });
    await client.query('COMMIT');
    console.log('Administrator created:', email);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
