import { CurrencyCode } from '@loteria/domain';
import { AuditService } from '../audit/audit.service';
import { Db } from '../common/db.service';
import { config } from '../config';
import { LedgerService } from '../wallet/ledger.service';

/**
 * Bono de bienvenida (DEMO): saldo de prueba al registrarse, por moneda.
 * Sale de HOUSE_PROMOTIONS hacia el saldo del jugador por el ledger. Idempotente por jugador y moneda:
 * aunque se llame dos veces, el bono se entrega una sola vez.
 */
export async function grantSignupBonus(db: Db, ledger: LedgerService, audit: AuditService, playerId: string) {
  const granted: Record<string, string> = {};
  for (const [currency, amount] of Object.entries(config.signupBonus) as [CurrencyCode, bigint][]) {
    if (amount <= 0n) continue;
    const tx = await ledger.post(db, {
      type: 'SIGNUP_BONUS',
      refProduct: 'ADJUST',
      refId: playerId,
      idempotencyKey: `promo:signup:${playerId}:${currency}`,
      metadata: { reason: 'Bono de bienvenida (DEMO, sin valor real)' },
      entries: [
        { accountId: await ledger.house(db, 'HOUSE_PROMOTIONS', 'SIGNUP', currency), direction: 'D', amount },
        { accountId: await ledger.playerCash(db, playerId, currency), direction: 'C', amount },
      ],
    });
    if (!tx.duplicate) granted[currency] = amount.toString();
  }
  if (Object.keys(granted).length) {
    await audit.log(db, { actorType: 'SYSTEM', action: 'SIGNUP_BONUS_GRANTED', entity: 'app_user', entityId: playerId, after: granted });
  }
  return granted;
}
