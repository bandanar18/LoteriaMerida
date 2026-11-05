import { CurrencyCode, formatAmount } from '@loteria/domain';
import { Db } from '../common/db.service';
import { BusinessError } from '../common/errors';

/**
 * Límite diario por nivel KYC (Doc. Maestro §6.2 y §12.3). Bloquea la fila del jugador para que
 * dos solicitudes simultáneas no puedan pasar ambas el límite. Cuenta lo pendiente y lo aprobado del día (Caracas).
 */
export async function assertWithinKycLimit(db: Db, playerId: string, kind: 'DEPOSIT' | 'WITHDRAWAL', currency: CurrencyCode, amount: bigint) {
  const u = (await db.query(`SELECT kyc_level FROM identity.app_user WHERE id = $1 FOR UPDATE`, [playerId])).rows[0];
  const limit = (
    await db.query(`SELECT max_deposit_daily, max_withdrawal_daily FROM identity.kyc_level_limit WHERE level = $1 AND currency = $2`, [
      u.kyc_level,
      currency,
    ])
  ).rows[0];
  const max = BigInt(kind === 'DEPOSIT' ? (limit?.max_deposit_daily ?? 0) : (limit?.max_withdrawal_daily ?? 0));
  if (max === 0n) {
    throw new BusinessError(
      'KYC_REQUIRED',
      kind === 'WITHDRAWAL' ? 'Para retirar debes verificar tu identidad (nivel 2)' : 'Tu nivel de verificación no permite depositar',
      { level: u.kyc_level },
    );
  }
  const used = BigInt(
    (
      await db.query(
        kind === 'DEPOSIT'
          ? `SELECT coalesce(sum(amount), 0)::text AS s FROM payments.deposit
              WHERE player_id = $1 AND currency = $2 AND status IN ('PENDING', 'APPROVED')
                AND (created_at AT TIME ZONE 'America/Caracas')::date = (now() AT TIME ZONE 'America/Caracas')::date`
          : `SELECT coalesce(sum(amount), 0)::text AS s FROM payments.withdrawal
              WHERE player_id = $1 AND currency = $2 AND status IN ('REQUESTED', 'PAID')
                AND (created_at AT TIME ZONE 'America/Caracas')::date = (now() AT TIME ZONE 'America/Caracas')::date`,
        [playerId, currency],
      )
    ).rows[0].s,
  );
  if (used + amount > max) {
    const available = max > used ? max - used : 0n;
    throw new BusinessError(
      'LIMIT_EXCEEDED',
      `Superas el límite diario de ${kind === 'DEPOSIT' ? 'depósitos' : 'retiros'} de tu nivel ${u.kyc_level}. ` +
        `Disponible hoy: ${formatAmount(available, currency)} ${currency}. Sube de nivel en Mi cuenta para ampliarlo.`,
      { level: u.kyc_level, available: available.toString() },
    );
  }
}
