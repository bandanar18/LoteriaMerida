import { Controller, Get, Query } from '@nestjs/common';
import { DbService } from '../common/db.service';
import { AuthUser, CurrentUser, Roles } from '../identity/auth.guard';

@Roles('PLAYER')
@Controller('me')
export class WalletController {
  constructor(private readonly db: DbService) {}

  @Get('balances')
  async balances(@CurrentUser() user: AuthUser) {
    const rows = await this.db.query(
      `SELECT c.code AS currency, c.minor_unit,
              coalesce(sum(a.balance) FILTER (WHERE a.account_type = 'PLAYER_CASH'), 0)::text AS cash,
              coalesce(sum(a.balance) FILTER (WHERE a.account_type = 'PLAYER_LOCKED'), 0)::text AS locked
         FROM wallet.currency c
         LEFT JOIN wallet.account a ON a.currency = c.code AND a.owner_type = 'PLAYER' AND a.owner_id = $1
        GROUP BY c.code, c.minor_unit ORDER BY c.code`,
      [user.id],
    );
    return rows;
  }

  /** Movimientos de las cuentas del jugador (vista del ledger). */
  @Get('transactions')
  async transactions(@CurrentUser() user: AuthUser, @Query('limit') limit?: string) {
    const n = Math.min(Math.max(Number(limit) || 50, 1), 200);
    return this.db.query(
      `SELECT e.id::text, t.type, t.ref_product, t.ref_id, a.account_type, a.currency, e.direction,
              e.amount::text, e.balance_after::text, e.created_at
         FROM wallet.ledger_entry e
         JOIN wallet.account a ON a.id = e.account_id
         JOIN wallet.ledger_transaction t ON t.id = e.transaction_id
        WHERE a.owner_type = 'PLAYER' AND a.owner_id = $1
        ORDER BY e.id DESC LIMIT $2`,
      [user.id, n],
    );
  }
}
