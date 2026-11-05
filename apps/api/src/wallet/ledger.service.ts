import { Injectable } from '@nestjs/common';
import { CurrencyCode } from '@loteria/domain';
import { Db } from '../common/db.service';
import { BusinessError, pgErrorCode } from '../common/errors';
import { publish } from '../common/realtime';

export type AccountType = 'PLAYER_CASH' | 'PLAYER_LOCKED' | 'BETS_IN_PLAY' | 'HOUSE_GGR' | 'PAYMENT_CLEARING';
export type RefProduct = 'LOTTERY' | 'SPORTS' | 'PAYMENT' | 'ADJUST';

export interface AccountSpec {
  ownerType: 'PLAYER' | 'HOUSE';
  ownerId?: string;
  accountType: AccountType;
  product?: string;
  currency: CurrencyCode;
}

export interface EntryInput {
  accountId: string;
  direction: 'D' | 'C';
  amount: bigint;
}

export interface PostInput {
  type: string;
  refProduct: RefProduct;
  refId: string;
  idempotencyKey: string;
  createdBy?: string | null;
  metadata?: Record<string, unknown>;
  entries: EntryInput[];
}

/**
 * Ledger de doble partida (Doc. Maestro §5). Único punto que modifica saldos.
 * Todas las funciones reciben el cliente de una transacción abierta (DbService.tx).
 */
@Injectable()
export class LedgerService {
  async account(db: Db, spec: AccountSpec): Promise<string> {
    const params = [spec.ownerType, spec.ownerId ?? null, spec.accountType, spec.product ?? '', spec.currency];
    const found = await db.query(
      `SELECT id FROM wallet.account
        WHERE owner_type = $1 AND owner_id IS NOT DISTINCT FROM $2 AND account_type = $3 AND product = $4 AND currency = $5`,
      params,
    );
    if (found.rows[0]) return found.rows[0].id;
    const created = await db.query(
      `INSERT INTO wallet.account (owner_type, owner_id, account_type, product, currency)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT DO NOTHING RETURNING id`,
      params,
    );
    if (created.rows[0]) return created.rows[0].id;
    return this.account(db, spec); // carrera: otra transacción la creó
  }

  playerCash(db: Db, playerId: string, currency: CurrencyCode) {
    return this.account(db, { ownerType: 'PLAYER', ownerId: playerId, accountType: 'PLAYER_CASH', currency });
  }

  playerLocked(db: Db, playerId: string, currency: CurrencyCode) {
    return this.account(db, { ownerType: 'PLAYER', ownerId: playerId, accountType: 'PLAYER_LOCKED', currency });
  }

  house(db: Db, accountType: Exclude<AccountType, 'PLAYER_CASH' | 'PLAYER_LOCKED'>, product: string, currency: CurrencyCode) {
    return this.account(db, { ownerType: 'HOUSE', accountType, product, currency });
  }

  /**
   * Registra una transacción contable. Idempotente por idempotencyKey: si ya existe,
   * devuelve la existente sin volver a mover saldos.
   */
  async post(db: Db, input: PostInput): Promise<{ transactionId: string; duplicate: boolean }> {
    const debits = input.entries.filter((e) => e.direction === 'D').reduce((a, e) => a + e.amount, 0n);
    const credits = input.entries.filter((e) => e.direction === 'C').reduce((a, e) => a + e.amount, 0n);
    if (input.entries.length < 2 || debits !== credits) {
      throw new Error(`Transacción descuadrada (${input.type}): D=${debits} C=${credits}`);
    }
    if (input.entries.some((e) => e.amount <= 0n)) throw new Error('Asiento con monto no positivo');

    const inserted = await db.query(
      `INSERT INTO wallet.ledger_transaction (type, ref_product, ref_id, idempotency_key, metadata, created_by)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (idempotency_key) DO NOTHING RETURNING id`,
      [input.type, input.refProduct, input.refId, input.idempotencyKey, input.metadata ?? null, input.createdBy ?? null],
    );
    if (!inserted.rows[0]) {
      const existing = await db.query(`SELECT id FROM wallet.ledger_transaction WHERE idempotency_key = $1`, [
        input.idempotencyKey,
      ]);
      return { transactionId: existing.rows[0].id, duplicate: true };
    }
    const transactionId: string = inserted.rows[0].id;

    // Bloqueo en orden estable para evitar deadlocks entre transacciones concurrentes.
    const accountIds = [...new Set(input.entries.map((e) => e.accountId))].sort();
    const locked = await db.query(
      `SELECT id, owner_type, owner_id, currency FROM wallet.account WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE`,
      [accountIds],
    );

    for (const entry of input.entries) {
      const delta = entry.direction === 'C' ? entry.amount : -entry.amount;
      let balanceAfter: string;
      try {
        const upd = await db.query(
          `UPDATE wallet.account SET balance = balance + $2, version = version + 1 WHERE id = $1 RETURNING balance`,
          [entry.accountId, delta.toString()],
        );
        balanceAfter = upd.rows[0].balance;
      } catch (err) {
        if (pgErrorCode(err) === '23514') throw new BusinessError('INSUFFICIENT_FUNDS', 'Saldo insuficiente');
        throw err;
      }
      await db.query(
        `INSERT INTO wallet.ledger_entry (transaction_id, account_id, direction, amount, balance_after)
         VALUES ($1, $2, $3, $4, $5)`,
        [transactionId, entry.accountId, entry.direction, entry.amount.toString(), balanceAfter],
      );
    }
    // Aviso de saldo a cada jugador afectado (se entrega al COMMIT).
    const players = new Set(locked.rows.filter((a) => a.owner_type === 'PLAYER').map((a) => a.owner_id as string));
    for (const playerId of players) {
      await publish(db, `player:${playerId}`, 'balance', { currency: locked.rows[0].currency, type: input.type });
    }
    return { transactionId, duplicate: false };
  }

  /** Reconciliación: saldo cacheado vs. suma de asientos, y transacciones descuadradas. */
  async reconcile(db: Db) {
    const mismatched = await db.query(
      `SELECT a.id, a.owner_type, a.owner_id, a.account_type, a.currency, a.balance,
              coalesce(sum(CASE e.direction WHEN 'C' THEN e.amount ELSE -e.amount END), 0) AS computed
         FROM wallet.account a LEFT JOIN wallet.ledger_entry e ON e.account_id = a.id
        GROUP BY a.id HAVING a.balance <> coalesce(sum(CASE e.direction WHEN 'C' THEN e.amount ELSE -e.amount END), 0)`,
    );
    const unbalanced = await db.query(
      `SELECT transaction_id FROM wallet.ledger_entry GROUP BY transaction_id
       HAVING sum(CASE direction WHEN 'D' THEN amount ELSE 0 END) <> sum(CASE direction WHEN 'C' THEN amount ELSE 0 END)`,
    );
    const totals = await db.query(
      `SELECT a.currency, sum(a.balance) AS net FROM wallet.account a GROUP BY a.currency ORDER BY a.currency`,
    );
    return {
      ok: mismatched.rows.length === 0 && unbalanced.rows.length === 0 && totals.rows.every((t) => t.net === '0'),
      mismatchedAccounts: mismatched.rows,
      unbalancedTransactions: unbalanced.rows.map((r) => r.transaction_id),
      netByCurrency: totals.rows, // por doble partida, Σ saldos de todas las cuentas debe ser 0
    };
  }
}
