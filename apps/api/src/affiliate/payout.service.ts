import { Injectable } from '@nestjs/common';
import {
  CurrencyCode,
  formatFxRate,
  fxChangeBps,
  isValidDocument,
  isVeMobile,
  maskDocument,
  maskPhone,
  MAX_FAMILY_PAYOUT_ACCOUNTS,
  MAX_PAYOUT_ACCOUNTS,
  normalizeVePhone,
  parseAmount,
  parseFxRate,
  PayoutRelationship,
  usdtToVesCents,
} from '@loteria/domain';
import { createHash, randomInt } from 'crypto';
import { AuditService } from '../audit/audit.service';
import { Db, DbService } from '../common/db.service';
import { BusinessError } from '../common/errors';
import { publish } from '../common/realtime';
import { localDate } from '../common/time';
import { config } from '../config';
import { assertWithinKycLimit } from '../kyc/kyc-limits';
import { LedgerService } from '../wallet/ledger.service';
import { AffiliateService } from './affiliate.service';
import { SmsService } from './sms.service';

const SMS_TTL_MS = 5 * 60_000;
const SMS_MAX_PER_HOUR = 5;
const SMS_MIN_INTERVAL_MS = 60_000;
const FX_JUMP_BPS = 1000; // 10 %

export interface PayoutInput {
  alias: string;
  holderKind: 'SELF' | 'FAMILY';
  relationship?: PayoutRelationship;
  holderName?: string;
  documentType?: 'V' | 'E';
  documentNumber?: string;
  bankCode: string;
  phone: string;
  isDefault?: boolean;
}

/** Datos ya validados y normalizados que se guardan al confirmar el SMS. */
interface PayoutPayload {
  alias: string;
  holderKind: 'SELF' | 'FAMILY';
  relationship: PayoutRelationship | null;
  holderName: string;
  documentType: 'V' | 'E';
  documentNumber: string;
  bankCode: string;
  phone: string;
  isDefault: boolean;
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/**
 * Fase 3 del Programa de Agencias: Directorio de Pago Móvil con confirmación por SMS,
 * tasa BCV del día y retiros SIEMPRE en bolívares por Pago Móvil.
 */
@Injectable()
export class PayoutService {
  constructor(
    private readonly db: DbService,
    private readonly ledger: LedgerService,
    private readonly audit: AuditService,
    private readonly affiliate: AffiliateService,
    private readonly sms: SmsService,
  ) {}

  // ───────────────────────── Catálogos ─────────────────────────

  banks() {
    return this.db.query(`SELECT code, name FROM affiliate.bank WHERE active ORDER BY code`);
  }

  /** Tasa USDT→VES del día (America/Caracas), o null si el administrador no la ha cargado. */
  async todayRate(c: Db = this.db.pool) {
    const row = (
      await c.query(
        `SELECT id, rate_e4::text, source, valid_date::text, created_at FROM affiliate.fx_rate
          WHERE valid_date = $1::date ORDER BY created_at DESC LIMIT 1`,
        [localDate()],
      )
    ).rows[0];
    return row ? { id: row.id as string, rateE4: BigInt(row.rate_e4), source: row.source as string, date: row.valid_date as string, createdAt: row.created_at } : null;
  }

  async todayRatePublic() {
    const r = await this.todayRate();
    return r ? { rate: formatFxRate(r.rateE4), rateE4: r.rateE4.toString(), source: r.source, date: r.date } : null;
  }

  // ───────────────────────── Directorio ─────────────────────────

  async listAccounts(userId: string) {
    const agent = await this.affiliate.requireAgent(this.db.pool, userId);
    const rows = await this.db.query(
      `SELECT p.id, p.alias, p.holder_kind, p.holder_name, p.relationship, p.bank_code, b.name AS bank_name, p.phone,
              p.document_type, p.document_number, p.is_default, p.status, p.invalid_reason, p.created_at,
              EXISTS (SELECT 1 FROM payments.withdrawal w WHERE w.payout_account_id = p.id AND w.status = 'REQUESTED') AS in_use
         FROM affiliate.payout_account p JOIN affiliate.bank b ON b.code = p.bank_code
        WHERE p.agent_id = $1 AND p.deleted_at IS NULL
        ORDER BY p.is_default DESC, p.created_at`,
      [agent.id],
    );
    return rows.map((r) => ({
      id: r.id,
      alias: r.alias,
      holderKind: r.holder_kind,
      holderName: r.holder_name,
      relationship: r.relationship,
      bankCode: r.bank_code,
      bankName: r.bank_name,
      phoneMasked: maskPhone(r.phone),
      documentMasked: maskDocument(r.document_type, r.document_number),
      isDefault: r.is_default,
      status: r.status,
      invalidReason: r.invalid_reason,
      inUse: r.in_use,
      createdAt: r.created_at,
    }));
  }

  /** Valida y normaliza los datos de una cuenta (reglas P1, P2, P9 y titularidad). */
  private async validatePayout(c: Db, agent: { id: string; user_id: string }, input: PayoutInput, editingId?: string): Promise<PayoutPayload> {
    const u = (
      await c.query(`SELECT first_name, last_name, document_type, document_number FROM identity.app_user WHERE id = $1`, [agent.user_id])
    ).rows[0];
    const phone = normalizeVePhone(input.phone);
    if (!phone || !isVeMobile(phone)) throw new BusinessError('INVALID_INPUT', 'El teléfono debe ser un celular venezolano (0412, 0414, 0416, 0422, 0424 o 0426)');
    const bank = (await c.query(`SELECT code FROM affiliate.bank WHERE code = $1 AND active`, [input.bankCode])).rows[0];
    if (!bank) throw new BusinessError('INVALID_INPUT', 'Banco no disponible');

    let payload: PayoutPayload;
    if (input.holderKind === 'SELF') {
      if (u.document_type !== 'V' && u.document_type !== 'E') {
        throw new BusinessError('PAYOUT_HOLDER_MISMATCH', 'Tu documento es pasaporte: agrega el Pago Móvil de un familiar con cédula');
      }
      payload = {
        alias: input.alias.trim(),
        holderKind: 'SELF',
        relationship: null,
        holderName: `${u.first_name} ${u.last_name}`.trim(),
        documentType: u.document_type,
        documentNumber: u.document_number,
        bankCode: input.bankCode,
        phone,
        isDefault: !!input.isDefault,
      };
    } else {
      const docNumber = (input.documentNumber ?? '').replace(/[.\s-]/g, '');
      if (!input.relationship) throw new BusinessError('INVALID_INPUT', 'Indica el parentesco');
      if (!input.holderName || input.holderName.trim().length < 3) throw new BusinessError('INVALID_INPUT', 'Escribe el nombre y apellido del titular');
      if (!input.documentType || !isValidDocument(input.documentType, docNumber)) throw new BusinessError('INVALID_INPUT', 'Cédula del titular inválida');
      if (input.documentType === u.document_type && docNumber === u.document_number) {
        throw new BusinessError('PAYOUT_HOLDER_MISMATCH', 'Esa es tu propia cédula: elige «Mía» en lugar de «Familiar»');
      }
      // P9: la cédula de un familiar no puede ser la de un referido de la misma agencia.
      const isReferral = await c.query(
        `SELECT 1 FROM affiliate.referral r JOIN identity.app_user p ON p.id = r.player_id
          WHERE r.agent_id = $1 AND p.document_type = $2 AND p.document_number = $3`,
        [agent.id, input.documentType, docNumber],
      );
      if (isReferral.rows[0]) throw new BusinessError('PAYOUT_HOLDER_IS_REFERRAL', 'No puedes cobrar en el Pago Móvil de una persona que invitaste');
      payload = {
        alias: input.alias.trim(),
        holderKind: 'FAMILY',
        relationship: input.relationship,
        holderName: input.holderName.trim(),
        documentType: input.documentType,
        documentNumber: docNumber,
        bankCode: input.bankCode,
        phone,
        isDefault: !!input.isDefault,
      };
    }

    const existing = (
      await c.query(
        `SELECT id, holder_kind, lower(alias) AS alias, bank_code, phone FROM affiliate.payout_account
          WHERE agent_id = $1 AND deleted_at IS NULL AND id IS DISTINCT FROM $2`,
        [agent.id, editingId ?? null],
      )
    ).rows;
    if (existing.length >= MAX_PAYOUT_ACCOUNTS) throw new BusinessError('PAYOUT_ACCOUNT_LIMIT', `Puedes guardar hasta ${MAX_PAYOUT_ACCOUNTS} Pago Móvil`);
    if (payload.holderKind === 'FAMILY' && existing.filter((e) => e.holder_kind === 'FAMILY').length >= MAX_FAMILY_PAYOUT_ACCOUNTS) {
      throw new BusinessError('PAYOUT_FAMILY_LIMIT', `Puedes guardar hasta ${MAX_FAMILY_PAYOUT_ACCOUNTS} Pago Móvil de familiares`);
    }
    if (existing.some((e) => e.bank_code === payload.bankCode && e.phone === payload.phone)) {
      throw new BusinessError('PAYOUT_ACCOUNT_DUPLICATE', 'Ya tienes ese Pago Móvil guardado');
    }
    if (existing.some((e) => e.alias === payload.alias.toLowerCase())) {
      throw new BusinessError('PAYOUT_ACCOUNT_DUPLICATE', 'Ya usaste ese nombre corto');
    }
    return payload;
  }

  /** Paso 1: valida los datos y envía el código SMS al teléfono registrado de la agencia (P3/P4). */
  async challenge(userId: string, input: PayoutInput, editingId: string | undefined, ip: string) {
    return this.db.tx(async (c) => {
      const agent = await this.affiliate.requireAgent(c, userId, { active: true });
      await c.query(`SELECT id FROM affiliate.agent WHERE id = $1 FOR UPDATE`, [agent.id]);
      if (editingId) await this.assertEditable(c, agent.id, editingId);
      const payload = await this.validatePayout(c, agent, input, editingId);

      const recent = (
        await c.query(
          `SELECT count(*)::int AS hour, max(created_at) AS last FROM affiliate.sms_challenge
            WHERE user_id = $1 AND created_at > now() - interval '1 hour'`,
          [userId],
        )
      ).rows[0];
      if (recent.hour >= SMS_MAX_PER_HOUR) throw new BusinessError('SMS_RATE_LIMITED', 'Pediste demasiados códigos. Intenta en una hora.');
      if (recent.last && Date.now() - new Date(recent.last).getTime() < SMS_MIN_INTERVAL_MS) {
        throw new BusinessError('SMS_RATE_LIMITED', 'Espera un minuto antes de pedir otro código.');
      }

      const phone = (await c.query(`SELECT phone FROM identity.app_user WHERE id = $1`, [userId])).rows[0].phone as string;
      const code = randomInt(0, 1_000_000).toString().padStart(6, '0');
      const row = (
        await c.query(
          `INSERT INTO affiliate.sms_challenge (user_id, purpose, target_id, payload, code_hash, phone, delivery, expires_at)
           VALUES ($1, $2, $3, $4, 'pending', $5, $6, now() + make_interval(secs => $7)) RETURNING id, expires_at`,
          [userId, editingId ? 'PAYOUT_ACCOUNT_EDIT' : 'PAYOUT_ACCOUNT_ADD', editingId ?? null, JSON.stringify(payload), phone, this.sms.delivery, SMS_TTL_MS / 1000],
        )
      ).rows[0];
      await c.query(`UPDATE affiliate.sms_challenge SET code_hash = $2 WHERE id = $1`, [row.id, sha256(`${row.id}:${code}`)]);
      const delivery = await this.sms.send(phone, `FortunaBet: tu código para ${editingId ? 'editar' : 'agregar'} un Pago Móvil es ${code}. No lo compartas.`);
      await this.audit.log(c, {
        actorType: 'PLAYER',
        actorId: userId,
        action: 'PAYOUT_SMS_SENT',
        entity: 'affiliate.sms_challenge',
        entityId: row.id,
        after: { purpose: editingId ? 'EDIT' : 'ADD', delivery, bank: payload.bankCode, phone: maskPhone(payload.phone) },
        ip,
      });
      return {
        challengeId: row.id as string,
        expiresAt: row.expires_at,
        maskedPhone: maskPhone(phone),
        delivery,
        // Solo en DEMO (sin proveedor de SMS): el código se muestra en pantalla.
        ...(delivery === 'DEMO_SCREEN' ? { demoCode: code } : {}),
      };
    });
  }

  /** Paso 2: comprueba el código y guarda la cuenta con los datos validados en el paso 1. */
  async confirm(userId: string, challengeId: string, code: string, ip: string) {
    // El intento fallido se guarda aunque la respuesta sea error (transacción propia).
    const ch = await this.db.tx(async (c) => {
      const row = (await c.query(`SELECT * FROM affiliate.sms_challenge WHERE id = $1 AND user_id = $2 FOR UPDATE`, [challengeId, userId])).rows[0];
      if (!row || row.consumed_at) throw new BusinessError('SMS_CODE_EXPIRED', 'El código ya no es válido. Pide uno nuevo.');
      if (new Date(row.expires_at) < new Date()) throw new BusinessError('SMS_CODE_EXPIRED', 'El código venció. Pide uno nuevo.');
      if (row.attempts >= 3) throw new BusinessError('SMS_TOO_MANY_ATTEMPTS', 'Demasiados intentos. Pide un código nuevo.');
      if (sha256(`${row.id}:${code.trim()}`) !== row.code_hash) {
        await c.query(`UPDATE affiliate.sms_challenge SET attempts = attempts + 1 WHERE id = $1`, [row.id]);
        return { ok: false as const, left: 2 - row.attempts };
      }
      return { ok: true as const, row };
    });
    if (!ch.ok) {
      throw new BusinessError(
        ch.left > 0 ? 'SMS_CODE_INVALID' : 'SMS_TOO_MANY_ATTEMPTS',
        ch.left > 0 ? `Código incorrecto. Te quedan ${ch.left} intento(s).` : 'Demasiados intentos. Pide un código nuevo.',
      );
    }

    return this.db.tx(async (c) => {
      const row = (await c.query(`SELECT * FROM affiliate.sms_challenge WHERE id = $1 FOR UPDATE`, [challengeId])).rows[0];
      if (row.consumed_at) throw new BusinessError('SMS_CODE_EXPIRED', 'El código ya se usó.');
      const agent = await this.affiliate.requireAgent(c, userId, { active: true });
      await c.query(`SELECT id FROM affiliate.agent WHERE id = $1 FOR UPDATE`, [agent.id]);
      const p = row.payload as PayoutPayload;
      const editingId: string | null = row.target_id;
      if (editingId) await this.assertEditable(c, agent.id, editingId);
      // Revalidar: el directorio pudo cambiar entre el paso 1 y el 2.
      await this.validatePayout(c, agent, { ...p, relationship: p.relationship ?? undefined }, editingId ?? undefined);
      const first = (await c.query(`SELECT count(*)::int AS n FROM affiliate.payout_account WHERE agent_id = $1 AND deleted_at IS NULL`, [agent.id])).rows[0].n === 0;
      const makeDefault = p.isDefault || first;
      if (makeDefault) await c.query(`UPDATE affiliate.payout_account SET is_default = false WHERE agent_id = $1 AND is_default`, [agent.id]);

      let id: string;
      if (editingId) {
        await c.query(
          `UPDATE affiliate.payout_account SET alias = $2, holder_kind = $3, holder_name = $4, relationship = $5, bank_code = $6, phone = $7,
                  document_type = $8, document_number = $9, is_default = $10 OR is_default, status = 'ACTIVE', invalid_reason = NULL, updated_at = now()
            WHERE id = $1`,
          [editingId, p.alias, p.holderKind, p.holderName, p.relationship, p.bankCode, p.phone, p.documentType, p.documentNumber, makeDefault],
        );
        id = editingId;
      } else {
        id = (
          await c.query(
            `INSERT INTO affiliate.payout_account
               (agent_id, alias, holder_kind, holder_name, relationship, bank_code, phone, document_type, document_number, is_default)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
            [agent.id, p.alias, p.holderKind, p.holderName, p.relationship, p.bankCode, p.phone, p.documentType, p.documentNumber, makeDefault],
          )
        ).rows[0].id;
      }
      await c.query(`UPDATE affiliate.sms_challenge SET consumed_at = now() WHERE id = $1`, [challengeId]);
      await this.audit.log(c, {
        actorType: 'PLAYER',
        actorId: userId,
        action: editingId ? 'PAYOUT_ACCOUNT_UPDATED' : 'PAYOUT_ACCOUNT_ADDED',
        entity: 'affiliate.payout_account',
        entityId: id,
        after: { alias: p.alias, holderKind: p.holderKind, relationship: p.relationship, bank: p.bankCode, phone: maskPhone(p.phone), document: maskDocument(p.documentType, p.documentNumber) },
        ip,
      });
      // P5: aviso en la Wallet (el correo se enviará cuando la plataforma tenga envío de correo).
      await publish(c, `player:${userId}`, 'payout-account', { id, action: editingId ? 'UPDATED' : 'ADDED' });
      return { id };
    });
  }

  /** Cambios sin SMS: nombre corto y predeterminada. */
  async patch(userId: string, id: string, alias: string | undefined, isDefault: boolean | undefined) {
    return this.db.tx(async (c) => {
      const agent = await this.affiliate.requireAgent(c, userId, { active: true });
      const acc = (await c.query(`SELECT id FROM affiliate.payout_account WHERE id = $1 AND agent_id = $2 AND deleted_at IS NULL FOR UPDATE`, [id, agent.id])).rows[0];
      if (!acc) throw new BusinessError('NOT_FOUND', 'Pago Móvil no encontrado');
      if (alias !== undefined) {
        const dup = await c.query(
          `SELECT 1 FROM affiliate.payout_account WHERE agent_id = $1 AND deleted_at IS NULL AND id <> $2 AND lower(alias) = lower($3)`,
          [agent.id, id, alias.trim()],
        );
        if (dup.rows[0]) throw new BusinessError('PAYOUT_ACCOUNT_DUPLICATE', 'Ya usaste ese nombre corto');
        await c.query(`UPDATE affiliate.payout_account SET alias = $2, updated_at = now() WHERE id = $1`, [id, alias.trim()]);
      }
      if (isDefault) {
        await c.query(`UPDATE affiliate.payout_account SET is_default = false WHERE agent_id = $1 AND is_default`, [agent.id]);
        await c.query(`UPDATE affiliate.payout_account SET is_default = true WHERE id = $1`, [id]);
      }
      return { id };
    });
  }

  /** Borrado lógico (P6); no se permite con un retiro en trámite (P7). */
  async remove(userId: string, id: string, ip: string) {
    return this.db.tx(async (c) => {
      const agent = await this.affiliate.requireAgent(c, userId);
      await this.assertEditable(c, agent.id, id);
      const acc = (
        await c.query(`UPDATE affiliate.payout_account SET deleted_at = now(), is_default = false WHERE id = $1 RETURNING bank_code, phone, is_default`, [id])
      ).rows[0];
      // Si era la predeterminada, pasa a serlo la más antigua que quede.
      await c.query(
        `UPDATE affiliate.payout_account SET is_default = true
          WHERE id = (SELECT id FROM affiliate.payout_account WHERE agent_id = $1 AND deleted_at IS NULL ORDER BY created_at LIMIT 1)
            AND NOT EXISTS (SELECT 1 FROM affiliate.payout_account WHERE agent_id = $1 AND deleted_at IS NULL AND is_default)`,
        [agent.id],
      );
      await this.audit.log(c, {
        actorType: 'PLAYER',
        actorId: userId,
        action: 'PAYOUT_ACCOUNT_DELETED',
        entity: 'affiliate.payout_account',
        entityId: id,
        before: { bank: acc.bank_code, phone: maskPhone(acc.phone) },
        ip,
      });
      await publish(c, `player:${userId}`, 'payout-account', { id, action: 'DELETED' });
      return { id, deleted: true };
    });
  }

  private async assertEditable(c: Db, agentId: string, id: string) {
    const acc = (await c.query(`SELECT id FROM affiliate.payout_account WHERE id = $1 AND agent_id = $2 AND deleted_at IS NULL FOR UPDATE`, [id, agentId])).rows[0];
    if (!acc) throw new BusinessError('NOT_FOUND', 'Pago Móvil no encontrado');
    const busy = await c.query(`SELECT 1 FROM payments.withdrawal WHERE payout_account_id = $1 AND status = 'REQUESTED'`, [id]);
    if (busy.rows[0]) throw new BusinessError('PAYOUT_ACCOUNT_IN_USE', 'Tienes un retiro en trámite a este Pago Móvil. Espera a que se pague.');
  }

  // ───────────────────────── Retiros en Bs ─────────────────────────

  private parseSource(sourceCurrency: CurrencyCode, raw: string) {
    try {
      const v = parseAmount(raw, sourceCurrency);
      if (v <= 0n) throw new Error();
      return v;
    } catch {
      throw new BusinessError('INVALID_INPUT', 'Monto inválido');
    }
  }

  /** Vista previa: cuánto recibe en Bs (W1). */
  async quote(sourceCurrency: CurrencyCode, rawAmount: string) {
    const sourceAmount = this.parseSource(sourceCurrency, rawAmount);
    if (sourceCurrency === 'VES') {
      return { sourceCurrency, sourceAmount: sourceAmount.toString(), payoutVes: sourceAmount.toString(), rate: null, rateDate: null, minVes: config.agentMinWithdrawalVes.toString() };
    }
    const rate = await this.todayRate();
    if (!rate) throw new BusinessError('FX_RATE_UNAVAILABLE', 'La tasa de hoy aún no está disponible. Puedes retirar desde tu saldo en Bs o intentarlo más tarde.');
    return {
      sourceCurrency,
      sourceAmount: sourceAmount.toString(),
      payoutVes: usdtToVesCents(sourceAmount, rate.rateE4).toString(),
      rate: formatFxRate(rate.rateE4),
      rateDate: rate.date,
      minVes: config.agentMinWithdrawalVes.toString(),
    };
  }

  /** Retiro de agencia: SIEMPRE en Bs por Pago Móvil, a una cuenta del directorio (W1–W6). */
  async withdraw(userId: string, sourceCurrency: CurrencyCode, rawAmount: string, payoutAccountId: string, idempotencyKey: string, ip: string) {
    const sourceAmount = this.parseSource(sourceCurrency, rawAmount);
    return this.db.tx(async (c) => {
      const agent = await this.affiliate.requireAgent(c, userId, { active: true });
      // Idempotencia: misma clave → mismo retiro. El candado serializa dos solicitudes simultáneas con la misma clave.
      await c.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`affiliate:withdraw:${userId}:${idempotencyKey}`]);
      const prev = (
        await c.query(`SELECT w.id, w.status FROM payments.withdrawal w JOIN wallet.ledger_transaction t ON t.id = w.request_ledger_tx_id WHERE t.idempotency_key = $1`, [
          `affiliate:withdraw:${userId}:${idempotencyKey}`,
        ])
      ).rows[0];
      if (prev) return { id: prev.id, status: prev.status, duplicate: true };

      const acc = (
        await c.query(
          `SELECT p.*, b.name AS bank_name FROM affiliate.payout_account p JOIN affiliate.bank b ON b.code = p.bank_code
            WHERE p.id = $1 AND p.agent_id = $2 AND p.deleted_at IS NULL FOR SHARE OF p`,
          [payoutAccountId, agent.id],
        )
      ).rows[0];
      if (!acc) throw new BusinessError('PAYOUT_ACCOUNT_REQUIRED', 'Elige un Pago Móvil de tu lista');
      if (acc.status !== 'ACTIVE') throw new BusinessError('PAYOUT_ACCOUNT_INVALID', 'Ese Pago Móvil tiene datos incorrectos. Corrígelo antes de retirar.');

      let payoutVes = sourceAmount;
      let rate: Awaited<ReturnType<PayoutService['todayRate']>> = null;
      if (sourceCurrency === 'USDT') {
        rate = await this.todayRate(c);
        if (!rate) throw new BusinessError('FX_RATE_UNAVAILABLE', 'La tasa de hoy aún no está disponible. Puedes retirar desde tu saldo en Bs o intentarlo más tarde.');
        payoutVes = usdtToVesCents(sourceAmount, rate.rateE4);
      }
      if (payoutVes < config.agentMinWithdrawalVes) {
        throw new BusinessError('MIN_AMOUNT', `El retiro mínimo es de Bs ${(Number(config.agentMinWithdrawalVes) / 100).toFixed(2).replace('.', ',')}`, {
          minVes: config.agentMinWithdrawalVes.toString(),
        });
      }
      // W6: límites diarios de KYC en Bs (exige verificación nivel 2).
      await assertWithinKycLimit(c, userId, 'WITHDRAWAL', 'VES', payoutVes);

      const destination = {
        kind: 'PAGO_MOVIL',
        bank: `${acc.bank_code} - ${acc.bank_name}`,
        phone: acc.phone,
        document: `${acc.document_type}-${acc.document_number}`,
        holderName: acc.holder_name,
        holderKind: acc.holder_kind,
        relationship: acc.relationship,
        alias: acc.alias,
      };
      const id: string = (
        await c.query(
          `INSERT INTO payments.withdrawal
             (player_id, method, currency, amount, destination, source, payout_account_id, source_currency, source_amount, fx_rate_id)
           VALUES ($1, 'PAGO_MOVIL', 'VES', $2, $3, 'AGENT', $4, $5, $6, $7) RETURNING id`,
          [userId, payoutVes.toString(), JSON.stringify(destination), acc.id, sourceCurrency, sourceAmount.toString(), rate?.id ?? null],
        )
      ).rows[0].id;

      const lockedVes = await this.ledger.playerAccount(c, userId, 'AGENT_LOCKED', 'VES');
      let requestTx: string;
      if (sourceCurrency === 'VES') {
        requestTx = (
          await this.ledger.post(c, {
            type: 'AGENT_WITHDRAWAL_REQUESTED',
            refProduct: 'AFFILIATE',
            refId: id,
            idempotencyKey: `affiliate:withdraw:${userId}:${idempotencyKey}`,
            createdBy: userId,
            entries: [
              { accountId: await this.ledger.playerAccount(c, userId, 'AGENT_CASH', 'VES'), direction: 'D', amount: sourceAmount },
              { accountId: lockedVes, direction: 'C', amount: sourceAmount },
            ],
          })
        ).transactionId;
      } else {
        // Dos asientos (el ledger no mezcla monedas en una transacción contable), en la misma transacción SQL.
        await this.ledger.post(c, {
          type: 'AGENT_FX_SELL',
          refProduct: 'AFFILIATE',
          refId: id,
          idempotencyKey: `affiliate:withdraw-fx-sell:${id}`,
          createdBy: userId,
          metadata: { rate: formatFxRate(rate!.rateE4), fxRateId: rate!.id },
          entries: [
            { accountId: await this.ledger.playerAccount(c, userId, 'AGENT_CASH', 'USDT'), direction: 'D', amount: sourceAmount },
            { accountId: await this.ledger.house(c, 'HOUSE_FX', '', 'USDT'), direction: 'C', amount: sourceAmount },
          ],
        });
        requestTx = (
          await this.ledger.post(c, {
            type: 'AGENT_FX_BUY',
            refProduct: 'AFFILIATE',
            refId: id,
            idempotencyKey: `affiliate:withdraw:${userId}:${idempotencyKey}`,
            createdBy: userId,
            metadata: { rate: formatFxRate(rate!.rateE4), fxRateId: rate!.id },
            entries: [
              { accountId: await this.ledger.house(c, 'HOUSE_FX', '', 'VES'), direction: 'D', amount: payoutVes },
              { accountId: lockedVes, direction: 'C', amount: payoutVes },
            ],
          })
        ).transactionId;
      }
      await c.query(`UPDATE payments.withdrawal SET request_ledger_tx_id = $2 WHERE id = $1`, [id, requestTx]);
      await this.audit.log(c, {
        actorType: 'PLAYER',
        actorId: userId,
        action: 'AGENT_WITHDRAWAL_REQUESTED',
        entity: 'payments.withdrawal',
        entityId: id,
        after: { sourceCurrency, sourceAmount, payoutVes, rate: rate ? formatFxRate(rate.rateE4) : null, payoutAccountId: acc.id },
        ip,
      });
      await publish(c, 'staff', 'queue', { kind: 'withdrawals' });
      return { id, status: 'REQUESTED', payoutVes: payoutVes.toString(), duplicate: false };
    });
  }

  async myWithdrawals(userId: string) {
    const rows = await this.db.query(
      `SELECT w.id, w.amount::text AS payout_ves, w.source_currency, w.source_amount::text, w.status, w.reject_reason, w.paid_reference,
              w.destination, w.created_at, w.reviewed_at, f.rate_e4::text
         FROM payments.withdrawal w LEFT JOIN affiliate.fx_rate f ON f.id = w.fx_rate_id
        WHERE w.player_id = $1 AND w.source = 'AGENT' ORDER BY w.created_at DESC LIMIT 100`,
      [userId],
    );
    return rows.map(({ destination: d, rate_e4, ...r }) => ({
      ...r,
      rate: rate_e4 ? formatFxRate(BigInt(rate_e4)) : null,
      payoutTo: { alias: d.alias, bank: d.bank, phoneMasked: maskPhone(d.phone), holderName: d.holderName, holderKind: d.holderKind },
    }));
  }

  // ───────────────────────── Backoffice: tasa BCV ─────────────────────────

  async setRate(rawRate: string, confirmLargeChange: boolean, actorId: string, ip: string) {
    let rateE4: bigint;
    try {
      rateE4 = parseFxRate(rawRate);
    } catch {
      throw new BusinessError('INVALID_INPUT', 'Tasa inválida (usa hasta 4 decimales, p. ej. 45,2000)');
    }
    return this.db.tx(async (c) => {
      const prev = (await c.query(`SELECT rate_e4::text FROM affiliate.fx_rate ORDER BY valid_date DESC, created_at DESC LIMIT 1`)).rows[0];
      if (prev && !confirmLargeChange) {
        const change = fxChangeBps(BigInt(prev.rate_e4), rateE4);
        if (change > FX_JUMP_BPS) {
          throw new BusinessError('FX_RATE_JUMP', `La tasa cambia ${(change / 100).toFixed(1)} % respecto a la anterior. Confírmalo para guardarla.`, {
            previous: formatFxRate(BigInt(prev.rate_e4)),
            changeBps: change,
          });
        }
      }
      const row = (
        await c.query(`INSERT INTO affiliate.fx_rate (rate_e4, valid_date, created_by) VALUES ($1, $2::date, $3) RETURNING id, valid_date::text`, [
          rateE4.toString(),
          localDate(),
          actorId,
        ])
      ).rows[0];
      await this.audit.log(c, {
        actorType: 'STAFF',
        actorId,
        action: 'FX_RATE_SET',
        entity: 'affiliate.fx_rate',
        entityId: row.id,
        before: prev ? { rate: formatFxRate(BigInt(prev.rate_e4)) } : undefined,
        after: { rate: formatFxRate(rateE4), date: row.valid_date },
        ip,
      });
      return { id: row.id, rate: formatFxRate(rateE4), date: row.valid_date };
    });
  }

  async rateHistory() {
    const rows = await this.db.query(
      `SELECT f.id, f.rate_e4::text, f.source, f.valid_date::text, f.created_at, u.email AS created_by
         FROM affiliate.fx_rate f JOIN identity.app_user u ON u.id = f.created_by
        ORDER BY f.valid_date DESC, f.created_at DESC LIMIT 30`,
    );
    return rows.map(({ rate_e4, ...r }) => ({ ...r, rate: formatFxRate(BigInt(rate_e4)) }));
  }
}
