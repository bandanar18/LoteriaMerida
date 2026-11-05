import { Injectable } from '@nestjs/common';
import { createHash } from 'crypto';
import { Db } from '../common/db.service';
import { stableStringify, toPlain } from '../common/json';

export interface AuditInput {
  actorType: 'PLAYER' | 'STAFF' | 'SYSTEM';
  actorId?: string | null;
  action: string;
  entity: string;
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
  ip?: string | null;
}

const GENESIS = '0'.repeat(64);
const AUDIT_LOCK_KEY = 4_242_001;

function hashRecord(prevHash: string, r: Record<string, unknown>): string {
  return createHash('sha256').update(prevHash).update(stableStringify(r)).digest('hex');
}

/** Log de auditoría append-only con hash encadenado (REG-02). */
@Injectable()
export class AuditService {
  async log(db: Db, input: AuditInput): Promise<void> {
    // Serializa escritores para que la cadena sea lineal.
    await db.query('SELECT pg_advisory_xact_lock($1)', [AUDIT_LOCK_KEY]);
    const last = await db.query(`SELECT hash FROM audit.audit_log ORDER BY id DESC LIMIT 1`);
    const prevHash: string = last.rows[0]?.hash ?? GENESIS;
    const record = {
      actorType: input.actorType,
      actorId: input.actorId ?? null,
      action: input.action,
      entity: input.entity,
      entityId: input.entityId ?? null,
      before: input.before === undefined ? null : toPlain(input.before),
      after: input.after === undefined ? null : toPlain(input.after),
      ip: input.ip ?? null,
      at: new Date().toISOString(),
    };
    await db.query(
      `INSERT INTO audit.audit_log (actor_type, actor_id, action, entity, entity_id, before, after, ip, at, prev_hash, hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        record.actorType,
        record.actorId,
        record.action,
        record.entity,
        record.entityId,
        record.before === null ? null : JSON.stringify(record.before),
        record.after === null ? null : JSON.stringify(record.after),
        record.ip,
        record.at,
        prevHash,
        hashRecord(prevHash, record),
      ],
    );
  }

  /** Recalcula toda la cadena y reporta el primer eslabón roto. */
  async verify(db: Db): Promise<{ ok: boolean; checked: number; brokenAtId?: string }> {
    const rows = await db.query(`SELECT * FROM audit.audit_log ORDER BY id`);
    let prev = GENESIS;
    for (const r of rows.rows) {
      const record = {
        actorType: r.actor_type,
        actorId: r.actor_id,
        action: r.action,
        entity: r.entity,
        entityId: r.entity_id,
        before: r.before,
        after: r.after,
        ip: r.ip,
        at: new Date(r.at).toISOString(),
      };
      if (r.prev_hash !== prev || hashRecord(prev, record) !== r.hash) {
        return { ok: false, checked: rows.rows.length, brokenAtId: String(r.id) };
      }
      prev = r.hash;
    }
    return { ok: true, checked: rows.rows.length };
  }
}
