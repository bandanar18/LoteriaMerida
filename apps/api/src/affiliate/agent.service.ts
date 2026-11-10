import { Injectable } from '@nestjs/common';
import { CurrencyCode, formatAffiliateCode, maskPlayerName, modalityMarginBps, parseAmount } from '@loteria/domain';
import { AuditService } from '../audit/audit.service';
import { DbService } from '../common/db.service';
import { BusinessError } from '../common/errors';
import { assertPlayerCanPlay } from '../identity/player-status';
import { LedgerService } from '../wallet/ledger.service';
import { AffiliateService, AGENT_TERMS_VERSION } from './affiliate.service';

const CODE_ROTATION_DAYS = 30;
const TODAY_START = `(date_trunc('day', now() AT TIME ZONE 'America/Caracas') AT TIME ZONE 'America/Caracas')`;
const MONTH_START = `(date_trunc('month', now() AT TIME ZONE 'America/Caracas') AT TIME ZONE 'America/Caracas')`;

/** Casos de uso de la Wallet (agencia) y del backoffice de agencias. */
@Injectable()
export class AgentService {
  constructor(
    private readonly db: DbService,
    private readonly ledger: LedgerService,
    private readonly audit: AuditService,
    private readonly affiliate: AffiliateService,
  ) {}

  // ───────────────────────── Agencia ─────────────────────────

  async activate(userId: string, displayName: string, ip: string) {
    return this.db.tx(async (c) => {
      await assertPlayerCanPlay(c, userId); // R1: jugador activo y no autoexcluido
      await c.query(`SELECT id FROM identity.app_user WHERE id = $1 FOR UPDATE`, [userId]);
      if (await this.affiliate.agentByUser(c, userId)) throw new BusinessError('AGENT_ALREADY_EXISTS', 'Ya tienes una agencia');
      const agent = (
        await c.query(
          `INSERT INTO affiliate.agent (user_id, display_name, terms_version, terms_accepted_at)
           VALUES ($1, $2, $3, now()) RETURNING id`,
          [userId, displayName.trim(), AGENT_TERMS_VERSION],
        )
      ).rows[0];
      const code = await this.affiliate.newCode(c);
      await c.query(`INSERT INTO affiliate.code (code, agent_id) VALUES ($1, $2)`, [code, agent.id]);
      await this.audit.log(c, {
        actorType: 'PLAYER',
        actorId: userId,
        action: 'AGENT_ACTIVATED',
        entity: 'affiliate.agent',
        entityId: agent.id,
        after: { displayName: displayName.trim(), code, termsVersion: AGENT_TERMS_VERSION },
        ip,
      });
      return this.profile(c, userId);
    });
  }

  async me(userId: string) {
    return this.profile(this.db.pool, userId);
  }

  private async profile(c: Pick<DbService['pool'], 'query'>, userId: string) {
    const agent = await this.affiliate.requireAgent(c, userId);
    const kyc = (await c.query(`SELECT kyc_level FROM identity.app_user WHERE id = $1`, [userId])).rows[0];
    return {
      id: agent.id,
      displayName: agent.display_name,
      status: agent.status,
      code: agent.code ? formatAffiliateCode(agent.code) : null,
      linkPath: agent.code ? `/r/${agent.code}` : null,
      kycLevel: kyc?.kyc_level ?? 0,
      termsVersion: AGENT_TERMS_VERSION,
      createdAt: agent.created_at,
    };
  }

  async summary(userId: string) {
    const c = this.db.pool;
    const agent = await this.affiliate.requireAgent(c, userId);
    const balances = await this.affiliate.balances(c, userId);
    const today = (
      await c.query(
        `SELECT currency, count(*)::int AS plays, coalesce(sum(amount), 0)::text AS commission
           FROM affiliate.commission WHERE agent_id = $1 AND status <> 'REVERSED' AND created_at >= ${TODAY_START}
          GROUP BY currency ORDER BY currency`,
        [agent.id],
      )
    ).rows;
    const referrals = (
      await c.query(
        `SELECT (SELECT count(*)::int FROM affiliate.referral WHERE agent_id = $1) AS total,
                (SELECT count(DISTINCT player_id)::int FROM affiliate.commission
                  WHERE agent_id = $1 AND created_at >= ${TODAY_START}) AS active_today`,
        [agent.id],
      )
    ).rows[0];
    return { status: agent.status, balances, today, referrals: { total: referrals.total, activeToday: referrals.active_today } };
  }

  /** Historial de comisiones (paginado por cursor = created_at|id de la última fila). */
  async commissions(userId: string, limit = 30, cursor?: string) {
    const c = this.db.pool;
    const agent = await this.affiliate.requireAgent(c, userId);
    const n = Math.min(Math.max(limit || 30, 1), 100);
    const [cAt, cId] = cursor ? cursor.split('|') : [null, null];
    const rows = (
      await c.query(
        `SELECT c.id, c.created_at, c.status, c.currency, c.base_amount::text, c.amount::text, c.rate_bps, c.capped,
                g.name AS game, u.first_name, u.last_name
           FROM affiliate.commission c
           JOIN identity.app_user u ON u.id = c.player_id
           LEFT JOIN lottery.game g ON g.id = c.game_id
          WHERE c.agent_id = $1 AND ($2::timestamptz IS NULL OR (c.created_at, c.id) < ($2::timestamptz, $3::uuid))
          ORDER BY c.created_at DESC, c.id DESC LIMIT $4`,
        [agent.id, cAt, cId, n],
      )
    ).rows;
    const items = rows.map(({ first_name, last_name, ...r }) => ({ ...r, player: maskPlayerName(first_name, last_name) }));
    const last = rows[rows.length - 1];
    return { items, nextCursor: rows.length === n ? `${new Date(last.created_at).toISOString()}|${last.id}` : null };
  }

  /** Referidos con lo que generaron en el mes. Solo alias enmascarado (privacidad). */
  async referrals(userId: string) {
    const c = this.db.pool;
    const agent = await this.affiliate.requireAgent(c, userId);
    const rows = (
      await c.query(
        `SELECT r.player_id, r.created_at, u.first_name, u.last_name,
                coalesce(m.plays, 0)::int AS plays_month,
                coalesce(m.by_currency, '{}'::jsonb) AS commission_month
           FROM affiliate.referral r
           JOIN identity.app_user u ON u.id = r.player_id
           LEFT JOIN LATERAL (
             SELECT sum(cnt)::int AS plays, jsonb_object_agg(currency, total::text) AS by_currency FROM (
               SELECT currency, count(*) AS cnt, sum(amount) AS total FROM affiliate.commission
                WHERE agent_id = r.agent_id AND player_id = r.player_id AND status <> 'REVERSED' AND created_at >= ${MONTH_START}
                GROUP BY currency) x
           ) m ON true
          WHERE r.agent_id = $1
          ORDER BY coalesce(m.plays, 0) DESC, r.created_at DESC LIMIT 500`,
        [agent.id],
      )
    ).rows;
    return rows.map((r, i) => ({
      key: i + 1, // nunca se expone el id del jugador
      name: maskPlayerName(r.first_name, r.last_name),
      since: r.created_at,
      playsMonth: r.plays_month,
      commissionMonth: r.commission_month,
    }));
  }

  /** Movimientos de las cuentas de la agencia (vista del ledger). */
  async movements(userId: string, limit = 50) {
    const n = Math.min(Math.max(limit || 50, 1), 200);
    return this.db.query(
      `SELECT e.id::text, t.type, a.account_type, a.currency, e.direction, e.amount::text, e.balance_after::text, e.created_at
         FROM wallet.ledger_entry e
         JOIN wallet.account a ON a.id = e.account_id
         JOIN wallet.ledger_transaction t ON t.id = e.transaction_id
        WHERE a.owner_type = 'PLAYER' AND a.owner_id = $1 AND a.account_type IN ('AGENT_PENDING', 'AGENT_CASH', 'AGENT_LOCKED')
        ORDER BY e.id DESC LIMIT $2`,
      [userId, n],
    );
  }

  /** Regenerar código (C5): el anterior deja de servir para registros nuevos. Máx. 1 vez cada 30 días. */
  async rotateCode(userId: string, ip: string) {
    return this.db.tx(async (c) => {
      const agent = await this.affiliate.requireAgent(c, userId, { active: true });
      await c.query(`SELECT id FROM affiliate.agent WHERE id = $1 FOR UPDATE`, [agent.id]);
      const recent = (
        await c.query(
          `SELECT created_at FROM affiliate.code WHERE agent_id = $1 ORDER BY created_at DESC LIMIT 1`,
          [agent.id],
        )
      ).rows[0];
      if (recent && Date.now() - new Date(recent.created_at).getTime() < CODE_ROTATION_DAYS * 86_400_000) {
        throw new BusinessError('CODE_ROTATION_TOO_SOON', `Solo puedes cambiar tu código una vez cada ${CODE_ROTATION_DAYS} días`);
      }
      await c.query(`UPDATE affiliate.code SET active = false, retired_at = now() WHERE agent_id = $1 AND active`, [agent.id]);
      const code = await this.affiliate.newCode(c);
      await c.query(`INSERT INTO affiliate.code (code, agent_id) VALUES ($1, $2)`, [code, agent.id]);
      await this.audit.log(c, {
        actorType: 'PLAYER',
        actorId: userId,
        action: 'AGENT_CODE_ROTATED',
        entity: 'affiliate.agent',
        entityId: agent.id,
        before: { code: agent.code },
        after: { code },
        ip,
      });
      return this.profile(c, userId);
    });
  }

  /** «Pasar a mi saldo de juego»: AGENT_CASH → PLAYER_CASH del mismo usuario, misma moneda, inmediato. */
  async transferToPlayer(userId: string, currency: CurrencyCode, rawAmount: string, idempotencyKey: string, ip: string) {
    let amount: bigint;
    try {
      amount = parseAmount(rawAmount, currency);
    } catch {
      throw new BusinessError('INVALID_INPUT', 'Monto inválido');
    }
    if (amount <= 0n) throw new BusinessError('INVALID_INPUT', 'El monto debe ser mayor que cero');
    return this.db.tx(async (c) => {
      const agent = await this.affiliate.requireAgent(c, userId, { active: true });
      const tx = await this.ledger.post(c, {
        type: 'AGENT_TO_PLAYER',
        refProduct: 'AFFILIATE',
        refId: agent.id,
        idempotencyKey: `affiliate:transfer:${userId}:${idempotencyKey}`,
        createdBy: userId,
        metadata: { currency },
        entries: [
          { accountId: await this.ledger.playerAccount(c, userId, 'AGENT_CASH', currency), direction: 'D', amount },
          { accountId: await this.ledger.playerCash(c, userId, currency), direction: 'C', amount },
        ],
      });
      if (!tx.duplicate) {
        await this.audit.log(c, {
          actorType: 'PLAYER',
          actorId: userId,
          action: 'AGENT_TRANSFER_TO_PLAYER',
          entity: 'affiliate.agent',
          entityId: agent.id,
          after: { currency, amount },
          ip,
        });
      }
      return { transactionId: tx.transactionId, duplicate: tx.duplicate, balances: await this.affiliate.balances(c, userId) };
    });
  }

  // ───────────────────────── Backoffice ─────────────────────────

  async adminList(status?: string, q?: string) {
    return this.db.query(
      `SELECT a.id, a.display_name, a.status, a.created_at, k.code, u.email, u.first_name, u.last_name,
              (SELECT count(*)::int FROM affiliate.referral r WHERE r.agent_id = a.id) AS referrals,
              (SELECT coalesce(jsonb_object_agg(currency, total::text), '{}'::jsonb) FROM (
                 SELECT currency, sum(amount) AS total FROM affiliate.commission
                  WHERE agent_id = a.id AND status <> 'REVERSED' AND created_at >= ${MONTH_START} GROUP BY currency) x
              ) AS commission_month
         FROM affiliate.agent a
         JOIN identity.app_user u ON u.id = a.user_id
         LEFT JOIN affiliate.code k ON k.agent_id = a.id AND k.active
        WHERE ($1::text IS NULL OR a.status = $1)
          AND ($2::text IS NULL OR a.display_name ILIKE '%' || $2 || '%' OR u.email ILIKE '%' || $2 || '%' OR k.code = upper(replace($2, '-', '')))
        ORDER BY a.created_at DESC LIMIT 200`,
      [status ?? null, q?.trim() || null],
    );
  }

  async adminDetail(agentId: string) {
    const agent = (
      await this.db.query(
        `SELECT a.*, u.email, u.first_name, u.last_name, u.document_type, u.document_number, u.phone
           FROM affiliate.agent a JOIN identity.app_user u ON u.id = a.user_id WHERE a.id = $1`,
        [agentId],
      )
    )[0];
    if (!agent) throw new BusinessError('AGENT_NOT_FOUND', 'Agencia no encontrada');
    const [codes, referrals, totals, balances] = await Promise.all([
      this.db.query(`SELECT code, active, created_at, retired_at FROM affiliate.code WHERE agent_id = $1 ORDER BY created_at DESC`, [agentId]),
      this.db.query(
        `SELECT r.player_id, r.created_at, r.source, u.first_name, u.last_name, u.email FROM affiliate.referral r
           JOIN identity.app_user u ON u.id = r.player_id WHERE r.agent_id = $1 ORDER BY r.created_at DESC LIMIT 500`,
        [agentId],
      ),
      this.db.query(
        `SELECT currency, status, count(*)::int AS n, sum(amount)::text AS total FROM affiliate.commission
          WHERE agent_id = $1 GROUP BY currency, status ORDER BY currency, status`,
        [agentId],
      ),
      this.affiliate.balances(this.db.pool, agent.user_id),
    ]);
    return { agent, codes, referrals, totals, balances };
  }

  async setStatus(agentId: string, status: 'ACTIVE' | 'SUSPENDED', reason: string, actorId: string, ip: string) {
    return this.db.tx(async (c) => {
      const before = (await c.query(`SELECT status FROM affiliate.agent WHERE id = $1 FOR UPDATE`, [agentId])).rows[0];
      if (!before) throw new BusinessError('AGENT_NOT_FOUND', 'Agencia no encontrada');
      if (before.status === 'CLOSED') throw new BusinessError('INVALID_STATE', 'La agencia está cerrada');
      await c.query(`UPDATE affiliate.agent SET status = $2, suspended_reason = $3 WHERE id = $1`, [
        agentId,
        status,
        status === 'SUSPENDED' ? reason : null,
      ]);
      await this.audit.log(c, {
        actorType: 'STAFF',
        actorId,
        action: status === 'SUSPENDED' ? 'AGENT_SUSPENDED' : 'AGENT_REACTIVATED',
        entity: 'affiliate.agent',
        entityId: agentId,
        before: { status: before.status },
        after: { status, reason },
        ip,
      });
      return { id: agentId, status };
    });
  }

  /** Tasa vigente por juego y su margen mínimo (K11). */
  async rates() {
    const games = await this.db.query(`SELECT id, code, name FROM lottery.game WHERE status = 'ACTIVE' ORDER BY display_order, code`);
    const product = await this.affiliate.currentRate(this.db.pool, 'LOTTERY', null);
    const out = [];
    for (const g of games) {
      const rate = await this.affiliate.currentRate(this.db.pool, 'LOTTERY', g.id);
      out.push({ gameId: g.id, code: g.code, name: g.name, rateBps: rate, minMarginBps: await this.minMargin(this.db.pool, g.id) });
    }
    return { productRateBps: product, games: out };
  }

  async setRate(gameId: string | null, rateBps: number, reason: string, actorId: string, ip: string) {
    return this.db.tx(async (c) => {
      // K11: la comisión debe quedar por debajo del margen de cada modalidad activa de los juegos afectados.
      const affected: { id: string; code: string }[] = gameId
        ? (await c.query(`SELECT id, code FROM lottery.game WHERE id = $1`, [gameId])).rows
        : (
            await c.query(
              `SELECT g.id, g.code FROM lottery.game g WHERE g.status = 'ACTIVE'
                 AND NOT EXISTS (SELECT 1 FROM affiliate.rate r WHERE r.product = 'LOTTERY' AND r.game_id = g.id)`,
            )
          ).rows;
      if (gameId && !affected.length) throw new BusinessError('NOT_FOUND', 'Juego no encontrado');
      if (rateBps > 0) {
        for (const g of affected) {
          const margin = await this.minMargin(c, g.id);
          if (margin !== null && rateBps >= margin) {
            throw new BusinessError('RATE_UNSAFE', `La tasa supera el margen de la casa en ${g.code} (${(margin / 100).toFixed(2)} %)`, {
              game: g.code,
              marginBps: margin,
            });
          }
        }
      }
      const row = (
        await c.query(
          `INSERT INTO affiliate.rate (product, game_id, rate_bps, reason, created_by) VALUES ('LOTTERY', $1, $2, $3, $4) RETURNING id`,
          [gameId, rateBps, reason, actorId],
        )
      ).rows[0];
      await this.audit.log(c, {
        actorType: 'STAFF',
        actorId,
        action: 'AFFILIATE_RATE_SET',
        entity: 'affiliate.rate',
        entityId: row.id,
        after: { gameId, rateBps, reason },
        ip,
      });
      return { id: row.id, gameId, rateBps };
    });
  }

  private async minMargin(c: Pick<DbService['pool'], 'query'>, gameId: string): Promise<number | null> {
    const mods = (
      await c.query(
        `SELECT g.board, m.code, m.factor_x100, (SELECT count(*)::int FROM lottery.symbol s WHERE s.game_id = g.id) AS symbols
           FROM lottery.modality m JOIN lottery.game g ON g.id = m.game_id
          WHERE m.game_id = $1 AND m.status = 'ACTIVE'`,
        [gameId],
      )
    ).rows;
    const margins = mods
      .map((m) => modalityMarginBps(m.board, m.code, BigInt(m.factor_x100), m.symbols))
      .filter((x): x is number => x !== null);
    return margins.length ? Math.min(...margins) : null;
  }

  async report(from?: string, to?: string) {
    return this.db.query(
      `SELECT a.display_name, g.code AS game, c.currency, c.status, count(*)::int AS plays,
              sum(c.base_amount)::text AS staked, sum(c.amount)::text AS commission
         FROM affiliate.commission c
         JOIN affiliate.agent a ON a.id = c.agent_id
         LEFT JOIN lottery.game g ON g.id = c.game_id
        WHERE c.created_at >= coalesce($1::date, '-infinity'::date) AND c.created_at < coalesce($2::date + 1, 'infinity'::date)
        GROUP BY a.display_name, g.code, c.currency, c.status
        ORDER BY a.display_name, g.code, c.currency, c.status`,
      [from ?? null, to ?? null],
    );
  }
}
