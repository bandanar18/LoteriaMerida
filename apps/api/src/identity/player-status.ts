import { Db } from '../common/db.service';
import { BusinessError } from '../common/errors';

/** Verifica que el jugador pueda jugar o depositar (bloqueo y autoexclusión, Doc. Maestro §6.4). */
export async function assertPlayerCanPlay(db: Db, playerId: string): Promise<void> {
  const res = await db.query(
    `SELECT kind, status, self_excluded_until > now() AS excluded, self_excluded_until
       FROM identity.app_user WHERE id = $1`,
    [playerId],
  );
  const u = res.rows[0];
  if (!u || u.kind !== 'PLAYER') throw new BusinessError('INVALID_STATE', 'Solo los jugadores pueden realizar esta operación');
  if (u.status === 'BLOCKED') throw new BusinessError('ACCOUNT_BLOCKED', 'Cuenta bloqueada');
  if (u.excluded) {
    throw new BusinessError('SELF_EXCLUDED', 'Tu cuenta está en autoexclusión', { until: u.self_excluded_until });
  }
}
