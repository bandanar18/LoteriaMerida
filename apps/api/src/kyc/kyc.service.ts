import { Injectable } from '@nestjs/common';
import { KYC_MAX_FILE_BYTES, KYC_DOCUMENT_LABELS, KycDocumentType, sniffMime, validateKycRequest } from '@loteria/domain';
import { AuditService } from '../audit/audit.service';
import { DbService } from '../common/db.service';
import { BusinessError, pgErrorCode } from '../common/errors';
import { publish } from '../common/realtime';
import { KycStorageService, StoredFile } from './kyc-storage.service';

type Actor = { id: string; ip?: string };

export interface UploadedDoc {
  type: string;
  buffer: Buffer;
  size: number;
}

const DOC_TYPES = Object.keys(KYC_DOCUMENT_LABELS) as KycDocumentType[];

/** Verificación de identidad por niveles (Doc. Maestro §6.2). Revisión manual por el oficial de cumplimiento. */
@Injectable()
export class KycService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly storage: KycStorageService,
  ) {}

  async status(userId: string) {
    const user = await this.db.one(`SELECT kyc_level FROM identity.app_user WHERE id = $1`, [userId]);
    const limits = await this.db.query(
      `SELECT level, currency, max_deposit_daily::text, max_withdrawal_daily::text
         FROM identity.kyc_level_limit ORDER BY level, currency`,
    );
    const usedToday = await this.db.query(
      `SELECT c.code AS currency,
              (SELECT coalesce(sum(amount), 0) FROM payments.deposit d WHERE d.player_id = $1 AND d.currency = c.code
                  AND d.status IN ('PENDING', 'APPROVED') AND (d.created_at AT TIME ZONE 'America/Caracas')::date = (now() AT TIME ZONE 'America/Caracas')::date)::text AS deposits,
              (SELECT coalesce(sum(amount), 0) FROM payments.withdrawal w WHERE w.player_id = $1 AND w.currency = c.code
                  AND w.status IN ('REQUESTED', 'PAID') AND (w.created_at AT TIME ZONE 'America/Caracas')::date = (now() AT TIME ZONE 'America/Caracas')::date)::text AS withdrawals
         FROM wallet.currency c ORDER BY c.code`,
      [userId],
    );
    const requests = await this.db.query(
      `SELECT r.id, r.from_level, r.target_level, r.status, r.note, r.submitted_at, r.reviewed_at, r.reject_reason,
              (SELECT coalesce(jsonb_agg(d.type ORDER BY d.type), '[]') FROM identity.kyc_document d WHERE d.request_id = r.id) AS documents
         FROM identity.kyc_request r WHERE r.user_id = $1 ORDER BY r.submitted_at DESC LIMIT 10`,
      [userId],
    );
    return { level: user?.kyc_level ?? 0, limits, usedToday, requests };
  }

  async submit(userId: string, targetLevel: number, note: string | undefined, files: UploadedDoc[], ip: string) {
    const types: KycDocumentType[] = [];
    for (const f of files) {
      if (!DOC_TYPES.includes(f.type as KycDocumentType)) throw new BusinessError('INVALID_INPUT', `Tipo de documento desconocido: ${f.type}`);
      if (types.includes(f.type as KycDocumentType)) throw new BusinessError('INVALID_INPUT', `Documento repetido: ${f.type}`);
      if (f.size > KYC_MAX_FILE_BYTES) throw new BusinessError('INVALID_INPUT', `${KYC_DOCUMENT_LABELS[f.type as KycDocumentType]}: máximo 5 MB`);
      types.push(f.type as KycDocumentType);
    }
    const mimes = files.map((f) => sniffMime(f.buffer));
    const bad = mimes.findIndex((m) => !m);
    if (bad >= 0) throw new BusinessError('INVALID_INPUT', `${KYC_DOCUMENT_LABELS[types[bad]]}: solo JPG, PNG o PDF`);

    const current = await this.db.one(`SELECT kind, kyc_level FROM identity.app_user WHERE id = $1`, [userId]);
    if (current?.kind !== 'PLAYER') throw new BusinessError('INVALID_STATE', 'Solo los jugadores verifican identidad');
    const err = validateKycRequest(current.kyc_level, targetLevel, types);
    if (err) throw new BusinessError('INVALID_INPUT', err);

    // Se cifra y guarda antes de la transacción; si esta falla, se borran los archivos.
    const stored: StoredFile[] = [];
    try {
      for (const f of files) stored.push(await this.storage.save(f.buffer));
      return await this.db.tx(async (c) => {
        const u = (await c.query(`SELECT kyc_level FROM identity.app_user WHERE id = $1 FOR UPDATE`, [userId])).rows[0];
        const raced = validateKycRequest(u.kyc_level, targetLevel, types);
        if (raced) throw new BusinessError('INVALID_STATE', raced);
        const req = (
          await c.query(
            `INSERT INTO identity.kyc_request (user_id, from_level, target_level, note) VALUES ($1, $2, $3, $4)
             RETURNING id, from_level, target_level, status, submitted_at`,
            [userId, u.kyc_level, targetLevel, note?.trim() || null],
          )
        ).rows[0];
        for (const [i, f] of files.entries()) {
          await c.query(
            `INSERT INTO identity.kyc_document (request_id, user_id, type, mime, size_bytes, sha256, storage_key, enc_iv, enc_tag)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
            [req.id, userId, f.type, mimes[i], f.size, stored[i].sha256, stored[i].storageKey, stored[i].iv, stored[i].tag],
          );
        }
        await this.audit.log(c, {
          actorType: 'PLAYER',
          actorId: userId,
          action: 'KYC_SUBMITTED',
          entity: 'identity.kyc_request',
          entityId: req.id,
          after: { targetLevel, documents: types, sha256: stored.map((s) => s.sha256) },
          ip,
        });
        await publish(c, 'staff', 'queue', { kind: 'kyc' });
        await publish(c, `player:${userId}`, 'kyc', { status: 'PENDING' });
        return req;
      });
    } catch (e) {
      await Promise.all(stored.map((s) => this.storage.discard(s.storageKey)));
      if (pgErrorCode(e) === '23505') throw new BusinessError('CONFLICT', 'Ya tienes una solicitud de verificación en revisión');
      throw e;
    }
  }

  listRequests(status?: string) {
    return this.db.query(
      `SELECT r.id, r.user_id, r.from_level, r.target_level, r.status, r.note, r.submitted_at, r.reviewed_at, r.reject_reason,
              u.email, u.first_name, u.last_name, u.document_type, u.document_number, u.birth_date, u.phone, u.state, u.city,
              u.kyc_level AS current_level, rv.email AS reviewed_by_email,
              (SELECT coalesce(jsonb_agg(jsonb_build_object('id', d.id, 'type', d.type, 'mime', d.mime, 'size', d.size_bytes, 'sha256', d.sha256)
                                ORDER BY d.type), '[]')
                 FROM identity.kyc_document d WHERE d.request_id = r.id) AS documents
         FROM identity.kyc_request r
         JOIN identity.app_user u ON u.id = r.user_id
         LEFT JOIN identity.app_user rv ON rv.id = r.reviewed_by
        WHERE ($1::text IS NULL OR r.status = $1)
        ORDER BY r.status = 'PENDING' DESC, r.submitted_at ${status === 'PENDING' ? 'ASC' : 'DESC'} LIMIT 200`,
      [status ?? null],
    );
  }

  async review(requestId: string, decision: 'APPROVE' | 'REJECT', reason: string | undefined, actor: Actor) {
    if (decision === 'REJECT' && !reason?.trim()) throw new BusinessError('INVALID_INPUT', 'Indica el motivo del rechazo');
    return this.db.tx(async (c) => {
      const r = (await c.query(`SELECT * FROM identity.kyc_request WHERE id = $1 FOR UPDATE`, [requestId])).rows[0];
      if (!r) throw new BusinessError('NOT_FOUND', 'Solicitud no encontrada');
      if (r.status !== 'PENDING') throw new BusinessError('INVALID_STATE', `La solicitud ya está ${r.status}`);
      const status = decision === 'APPROVE' ? 'APPROVED' : 'REJECTED';
      await c.query(
        `UPDATE identity.kyc_request SET status = $2, reviewed_by = $3, reviewed_at = now(), reject_reason = $4 WHERE id = $1`,
        [requestId, status, actor.id, decision === 'REJECT' ? reason!.trim() : null],
      );
      let level: number | null = null;
      if (decision === 'APPROVE') {
        const before = (await c.query(`SELECT kyc_level FROM identity.app_user WHERE id = $1 FOR UPDATE`, [r.user_id])).rows[0].kyc_level;
        level = Math.max(before, r.target_level);
        await c.query(`UPDATE identity.app_user SET kyc_level = $2 WHERE id = $1`, [r.user_id, level]);
        await this.audit.log(c, {
          actorType: 'STAFF',
          actorId: actor.id,
          action: 'KYC_LEVEL_CHANGED',
          entity: 'app_user',
          entityId: r.user_id,
          before: { level: before },
          after: { level, requestId },
          ip: actor.ip,
        });
      }
      await this.audit.log(c, {
        actorType: 'STAFF',
        actorId: actor.id,
        action: decision === 'APPROVE' ? 'KYC_APPROVED' : 'KYC_REJECTED',
        entity: 'identity.kyc_request',
        entityId: requestId,
        after: { status, reason: reason ?? null },
        ip: actor.ip,
      });
      await publish(c, `player:${r.user_id}`, 'kyc', { status, level });
      await publish(c, 'staff', 'queue', { kind: 'kyc' });
      return { status, level };
    });
  }

  /** Descarga descifrada para el revisor; cada acceso queda en auditoría (dato sensible). */
  async document(documentId: string, actor: Actor) {
    const d = await this.db.one(`SELECT * FROM identity.kyc_document WHERE id = $1`, [documentId]);
    if (!d) throw new BusinessError('NOT_FOUND', 'Documento no encontrado');
    const content = await this.storage.load({ storageKey: d.storage_key, iv: d.enc_iv, tag: d.enc_tag, sha256: d.sha256 });
    await this.db.tx((c) =>
      this.audit.log(c, {
        actorType: 'STAFF',
        actorId: actor.id,
        action: 'KYC_DOCUMENT_VIEWED',
        entity: 'identity.kyc_document',
        entityId: documentId,
        after: { type: d.type, userId: d.user_id },
        ip: actor.ip,
      }),
    );
    return { mime: d.mime as string, content };
  }
}
