import { Injectable } from '@nestjs/common';
import { CurrencyCode, parseAmount } from '@loteria/domain';
import { AuditService } from '../audit/audit.service';
import { Db, DbService } from '../common/db.service';
import { BusinessError, pgErrorCode } from '../common/errors';
import { publish } from '../common/realtime';
import { assertPlayerCanPlay } from '../identity/player-status';
import { assertWithinKycLimit } from '../kyc/kyc-limits';
import { LedgerService } from '../wallet/ledger.service';
import { CreateDepositDto, CreateWithdrawalDto } from './payments.dto';

const METHOD_CURRENCY: Record<CreateDepositDto['method'], CurrencyCode> = {
  PAGO_MOVIL: 'VES',
  TRANSFER: 'VES',
  USDT: 'USDT',
};

type Actor = { id: string; ip?: string };

/**
 * Pagos con conciliación manual (Doc. Maestro §12). En el MVP un cajero verifica la referencia
 * contra el estado de cuenta / blockchain y aprueba; la integración bancaria automática es fase posterior.
 */
@Injectable()
export class PaymentsService {
  constructor(
    private readonly db: DbService,
    private readonly ledger: LedgerService,
    private readonly audit: AuditService,
  ) {}

  private amount(raw: string, currency: CurrencyCode) {
    try {
      const v = parseAmount(raw, currency);
      if (v <= 0n) throw new Error('El monto debe ser mayor que cero');
      return v;
    } catch (e) {
      throw new BusinessError('INVALID_INPUT', (e as Error).message);
    }
  }

  // ───────────── Depósitos ─────────────

  async createDeposit(playerId: string, dto: CreateDepositDto, ip: string) {
    const currency = METHOD_CURRENCY[dto.method];
    const amount = this.amount(dto.amount, currency);
    try {
      return await this.db.tx(async (c) => {
        await assertPlayerCanPlay(c, playerId);
        await assertWithinKycLimit(c, playerId, 'DEPOSIT', currency, amount);
        const res = await c.query(
          `INSERT INTO payments.deposit (player_id, method, currency, amount, bank, reference, payer_phone, payer_document)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           RETURNING id, method, currency, amount::text, bank, reference, status, created_at`,
          [playerId, dto.method, currency, amount.toString(), dto.bank.trim(), dto.reference.trim().toUpperCase(), dto.payerPhone ?? null, dto.payerDocument ?? null],
        );
        await this.audit.log(c, {
          actorType: 'PLAYER',
          actorId: playerId,
          action: 'DEPOSIT_REPORTED',
          entity: 'payments.deposit',
          entityId: res.rows[0].id,
          after: res.rows[0],
          ip,
        });
        await publish(c, 'staff', 'queue', { kind: 'deposits' });
        return res.rows[0];
      });
    } catch (err) {
      if (pgErrorCode(err) === '23505') {
        throw new BusinessError('DUPLICATE_REFERENCE', 'Esa referencia ya fue reportada');
      }
      throw err;
    }
  }

  myDeposits(playerId: string) {
    return this.db.query(
      `SELECT id, method, currency, amount::text, bank, reference, status, reject_reason, created_at, reviewed_at
         FROM payments.deposit WHERE player_id = $1 ORDER BY created_at DESC LIMIT 50`,
      [playerId],
    );
  }

  async approveDeposit(depositId: string, actor: Actor) {
    return this.db.tx(async (c) => {
      const d = (await c.query(`SELECT * FROM payments.deposit WHERE id = $1 FOR UPDATE`, [depositId])).rows[0];
      if (!d) throw new BusinessError('NOT_FOUND', 'Depósito no encontrado');
      if (d.status !== 'PENDING') throw new BusinessError('INVALID_STATE', `El depósito ya está ${d.status}`);
      const amount = BigInt(d.amount);
      const tx = await this.ledger.post(c, {
        type: 'DEPOSIT',
        refProduct: 'PAYMENT',
        refId: d.id,
        idempotencyKey: `payment:deposit:${d.id}`,
        createdBy: actor.id,
        metadata: { method: d.method, bank: d.bank, reference: d.reference },
        entries: [
          { accountId: await this.ledger.house(c, 'PAYMENT_CLEARING', d.method, d.currency), direction: 'D', amount },
          { accountId: await this.ledger.playerCash(c, d.player_id, d.currency), direction: 'C', amount },
        ],
      });
      await c.query(
        `UPDATE payments.deposit SET status = 'APPROVED', reviewed_by = $2, reviewed_at = now(), ledger_tx_id = $3 WHERE id = $1`,
        [d.id, actor.id, tx.transactionId],
      );
      await this.audit.log(c, {
        actorType: 'STAFF',
        actorId: actor.id,
        action: 'DEPOSIT_APPROVED',
        entity: 'payments.deposit',
        entityId: d.id,
        before: { status: d.status },
        after: { status: 'APPROVED', amount: d.amount, currency: d.currency },
        ip: actor.ip,
      });
      await this.notify(c, d.player_id, 'deposit', d.id, 'APPROVED');
      return { status: 'APPROVED' };
    });
  }

  async rejectDeposit(depositId: string, reason: string, actor: Actor) {
    return this.db.tx(async (c) => {
      const d = (await c.query(`SELECT * FROM payments.deposit WHERE id = $1 FOR UPDATE`, [depositId])).rows[0];
      if (!d) throw new BusinessError('NOT_FOUND', 'Depósito no encontrado');
      if (d.status !== 'PENDING') throw new BusinessError('INVALID_STATE', `El depósito ya está ${d.status}`);
      await c.query(
        `UPDATE payments.deposit SET status = 'REJECTED', reviewed_by = $2, reviewed_at = now(), reject_reason = $3 WHERE id = $1`,
        [d.id, actor.id, reason],
      );
      await this.audit.log(c, {
        actorType: 'STAFF',
        actorId: actor.id,
        action: 'DEPOSIT_REJECTED',
        entity: 'payments.deposit',
        entityId: d.id,
        after: { reason },
        ip: actor.ip,
      });
      await this.notify(c, d.player_id, 'deposit', d.id, 'REJECTED');
      return { status: 'REJECTED' };
    });
  }

  // ───────────── Retiros ─────────────

  async createWithdrawal(playerId: string, dto: CreateWithdrawalDto, ip: string) {
    const currency = METHOD_CURRENCY[dto.method];
    const amount = this.amount(dto.amount, currency);
    return this.db.tx(async (c) => {
      const u = (await c.query(`SELECT status FROM identity.app_user WHERE id = $1`, [playerId])).rows[0];
      if (u?.status === 'BLOCKED') throw new BusinessError('ACCOUNT_BLOCKED', 'Cuenta bloqueada');
      await assertWithinKycLimit(c, playerId, 'WITHDRAWAL', currency, amount);
      const res = await c.query(
        `INSERT INTO payments.withdrawal (player_id, method, currency, amount, destination)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [playerId, dto.method, currency, amount.toString(), JSON.stringify({ bank: dto.bank, account: dto.account })],
      );
      const id: string = res.rows[0].id;
      // Fondos a PLAYER_LOCKED mientras se revisa (Doc. Maestro §5.3).
      const tx = await this.ledger.post(c, {
        type: 'WITHDRAWAL_REQUESTED',
        refProduct: 'PAYMENT',
        refId: id,
        idempotencyKey: `payment:withdrawal-request:${id}`,
        createdBy: playerId,
        entries: [
          { accountId: await this.ledger.playerCash(c, playerId, currency), direction: 'D', amount },
          { accountId: await this.ledger.playerLocked(c, playerId, currency), direction: 'C', amount },
        ],
      });
      await c.query(`UPDATE payments.withdrawal SET request_ledger_tx_id = $2 WHERE id = $1`, [id, tx.transactionId]);
      await this.audit.log(c, {
        actorType: 'PLAYER',
        actorId: playerId,
        action: 'WITHDRAWAL_REQUESTED',
        entity: 'payments.withdrawal',
        entityId: id,
        after: { amount, currency, method: dto.method },
        ip,
      });
      await publish(c, 'staff', 'queue', { kind: 'withdrawals' });
      return { id, status: 'REQUESTED' };
    });
  }

  myWithdrawals(playerId: string) {
    return this.db.query(
      `SELECT id, method, currency, amount::text, destination, status, reject_reason, paid_reference, created_at, reviewed_at
         FROM payments.withdrawal WHERE player_id = $1 ORDER BY created_at DESC LIMIT 50`,
      [playerId],
    );
  }

  async payWithdrawal(id: string, paidReference: string, actor: Actor) {
    return this.finishWithdrawal(id, actor, { paid: true, paidReference });
  }

  async rejectWithdrawal(id: string, reason: string, actor: Actor) {
    return this.finishWithdrawal(id, actor, { paid: false, reason });
  }

  private async finishWithdrawal(id: string, actor: Actor, outcome: { paid: true; paidReference: string } | { paid: false; reason: string }) {
    return this.db.tx(async (c) => {
      const w = (await c.query(`SELECT * FROM payments.withdrawal WHERE id = $1 FOR UPDATE`, [id])).rows[0];
      if (!w) throw new BusinessError('NOT_FOUND', 'Retiro no encontrado');
      if (w.status !== 'REQUESTED') throw new BusinessError('INVALID_STATE', `El retiro ya está ${w.status}`);
      const amount = BigInt(w.amount);
      const locked = await this.ledger.playerLocked(c, w.player_id, w.currency);
      const tx = await this.ledger.post(c, {
        type: outcome.paid ? 'WITHDRAWAL_PAID' : 'WITHDRAWAL_REJECTED',
        refProduct: 'PAYMENT',
        refId: w.id,
        idempotencyKey: `payment:withdrawal-final:${w.id}`,
        createdBy: actor.id,
        entries: outcome.paid
          ? [
              { accountId: locked, direction: 'D', amount },
              { accountId: await this.ledger.house(c, 'PAYMENT_CLEARING', w.method, w.currency), direction: 'C', amount },
            ]
          : [
              { accountId: locked, direction: 'D', amount },
              { accountId: await this.ledger.playerCash(c, w.player_id, w.currency), direction: 'C', amount },
            ],
      });
      await c.query(
        `UPDATE payments.withdrawal SET status = $2, reviewed_by = $3, reviewed_at = now(), final_ledger_tx_id = $4,
                paid_reference = $5, reject_reason = $6 WHERE id = $1`,
        [
          w.id,
          outcome.paid ? 'PAID' : 'REJECTED',
          actor.id,
          tx.transactionId,
          outcome.paid ? outcome.paidReference : null,
          outcome.paid ? null : outcome.reason,
        ],
      );
      await this.audit.log(c, {
        actorType: 'STAFF',
        actorId: actor.id,
        action: outcome.paid ? 'WITHDRAWAL_PAID' : 'WITHDRAWAL_REJECTED',
        entity: 'payments.withdrawal',
        entityId: w.id,
        after: outcome,
        ip: actor.ip,
      });
      await this.notify(c, w.player_id, 'withdrawal', w.id, outcome.paid ? 'PAID' : 'REJECTED');
      return { status: outcome.paid ? 'PAID' : 'REJECTED' };
    });
  }

  private async notify(c: Db, playerId: string, event: 'deposit' | 'withdrawal', id: string, status: string) {
    await publish(c, `player:${playerId}`, event, { id, status });
    await publish(c, 'staff', 'queue', { kind: event === 'deposit' ? 'deposits' : 'withdrawals' });
  }
}
