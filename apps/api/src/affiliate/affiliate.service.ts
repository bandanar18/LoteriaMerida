import { Injectable } from '@nestjs/common';
import {
  AFFILIATE_ALPHABET,
  AFFILIATE_BODY_LENGTH,
  buildAffiliateCode,
  commissionFor,
  CurrencyCode,
  formatAffiliateCode,
  normalizeAffiliateCode,
} from '@loteria/domain';
import { randomInt } from 'crypto';
import { AuditService } from '../audit/audit.service';
import { Db } from '../common/db.service';
import { BusinessError } from '../common/errors';
import { publish } from '../common/realtime';
import { config } from '../config';
import { LedgerService } from '../wallet/ledger.service';

export const AGENT_TERMS_VERSION = 'AGENCIAS-1.0';

export interface ReferralIdentity {
  /** null en el registro lite (documento pendiente). */
  documentType: string | null;
  documentNumber: string | null;
  phone: string;
}

export interface TicketForCommission {
  ticketId: string;
  playerId: string;
  gameId: string;
  currency: CurrencyCode;
  isSimulation: boolean;
}

interface PendingRow {
  id: string;
  agent_id: string;
  agent_user_id: string;
  currency: CurrencyCode;
  amount: string;
}

/**
 * Programa de Agencias Virtuales (WalletLoteria/DOCUMENTO_MAESTRO_WALLET.md).
 * Las funciones que reciben `c` se ejecutan dentro de la transacción del llamador:
 * la comisión se guarda junto con la jugada o no se guarda.
 */
@Injectable()
export class AffiliateService {
  constructor(
    private readonly ledger: LedgerService,
    private readonly audit: AuditService,
  ) {}

  // ───────────────────────── Códigos ─────────────────────────

  /** Genera un código libre con el CSPRNG del servidor (regla C2). */
  async newCode(c: Db): Promise<string> {
    for (let attempt = 0; attempt < 10; attempt++) {
      const code = buildAffiliateCode(Array.from({ length: AFFILIATE_BODY_LENGTH }, () => randomInt(0, AFFILIATE_ALPHABET.length)));
      const taken = await c.query(`SELECT 1 FROM affiliate.code WHERE code = $1`, [code]);
      if (!taken.rows[0]) return code;
    }
    throw new Error('No se pudo generar un código de afiliado libre');
  }

  /** Valida un código para mostrar «Te invitó: …». Solo revela el nombre comercial. */
  async lookupCode(c: Db, raw: string): Promise<{ valid: true; code: string; agentName: string } | { valid: false }> {
    const code = normalizeAffiliateCode(raw);
    if (!code) return { valid: false };
    const row = (
      await c.query(
        `SELECT a.display_name FROM affiliate.code k JOIN affiliate.agent a ON a.id = k.agent_id
          WHERE k.code = $1 AND k.active AND a.status = 'ACTIVE'`,
        [code],
      )
    ).rows[0];
    return row ? { valid: true, code: formatAffiliateCode(code), agentName: row.display_name } : { valid: false };
  }

  // ───────────────────────── Referidos ─────────────────────────

  /**
   * Vincula un jugador recién registrado a la agencia del código (reglas A3–A6).
   * Nunca hace fallar el registro: si el código no sirve, devuelve null y lo anota en auditoría.
   */
  async attachReferral(c: Db, playerId: string, rawCode: string | undefined | null, who: ReferralIdentity, ip?: string) {
    if (!rawCode || !rawCode.trim()) return null;
    const code = normalizeAffiliateCode(rawCode);
    const agent = code
      ? (
          await c.query(
            `SELECT a.id, a.display_name, a.user_id, u.document_type, u.document_number, u.phone
               FROM affiliate.code k JOIN affiliate.agent a ON a.id = k.agent_id
               JOIN identity.app_user u ON u.id = a.user_id
              WHERE k.code = $1 AND k.active AND a.status = 'ACTIVE'`,
            [code],
          )
        ).rows[0]
      : undefined;

    let rejected: string | null = null;
    if (!agent) rejected = 'CODE_INVALID';
    else if (
      agent.user_id === playerId ||
      (!!who.documentNumber && agent.document_type === who.documentType && agent.document_number === who.documentNumber) ||
      agent.phone === who.phone
    ) {
      rejected = 'SELF_REFERRAL';
    }
    if (rejected) {
      await this.audit.log(c, {
        actorType: 'SYSTEM',
        action: 'REFERRAL_REJECTED',
        entity: 'app_user',
        entityId: playerId,
        after: { code: rawCode.slice(0, 20), reason: rejected },
        ip,
      });
      return null;
    }

    await c.query(`INSERT INTO affiliate.referral (player_id, agent_id, code, source) VALUES ($1, $2, $3, 'SIGNUP')`, [
      playerId,
      agent.id,
      code,
    ]);
    await this.audit.log(c, {
      actorType: 'SYSTEM',
      action: 'REFERRAL_ATTACHED',
      entity: 'affiliate.referral',
      entityId: playerId,
      after: { agentId: agent.id, code },
      ip,
    });
    await publish(c, `player:${agent.user_id}`, 'referral', {});
    return { agentName: agent.display_name as string };
  }

  // ───────────────────────── Comisiones ─────────────────────────

  /** Tasa vigente: la del juego si existe, si no la del producto (K1). */
  async currentRate(c: Db, product: 'LOTTERY' | 'SPORTS', gameId: string | null): Promise<number> {
    const row = (
      await c.query(
        `SELECT rate_bps FROM affiliate.rate
          WHERE product = $1 AND (game_id = $2 OR game_id IS NULL) AND valid_from <= now()
          ORDER BY (game_id IS NULL), valid_from DESC, created_at DESC LIMIT 1`,
        [product, gameId],
      )
    ).rows[0];
    return row ? Number(row.rate_bps) : 0;
  }

  /**
   * Genera las comisiones «por liberar» de un ticket recién vendido (K1–K10).
   * Se llama justo después del asiento BET_PLACED, en la misma transacción.
   */
  async accrueForTicket(c: Db, t: TicketForCommission): Promise<void> {
    if (t.isSimulation) return; // K6: tickets de simulación no generan comisión
    const ref = (
      await c.query(
        `SELECT r.agent_id, a.user_id AS agent_user_id, a.status
           FROM affiliate.referral r JOIN affiliate.agent a ON a.id = r.agent_id
          WHERE r.player_id = $1 FOR SHARE OF a`,
        [t.playerId],
      )
    ).rows[0];
    if (!ref || ref.status !== 'ACTIVE' || ref.agent_user_id === t.playerId) return;

    // K6: el referido debe tener al menos un depósito aprobado (protege contra cuentas creadas solo por el bono).
    // En la DEMO (AFFILIATE_REQUIRE_DEPOSIT=false) las jugadas con el bono de bienvenida también comisionan.
    if (config.affiliateRequireDeposit) {
      const deposited = await c.query(`SELECT 1 FROM payments.deposit WHERE player_id = $1 AND status = 'APPROVED' LIMIT 1`, [t.playerId]);
      if (!deposited.rows[0]) return;
    }

    const rateBps = await this.currentRate(c, 'LOTTERY', t.gameId);
    if (rateBps <= 0) return;

    const cap = (await c.query(`SELECT max_per_play, max_daily FROM affiliate.cap WHERE currency = $1`, [t.currency])).rows[0];
    const capPerPlay = cap?.max_per_play == null ? null : BigInt(cap.max_per_play);
    let dailyLeft: bigint | null = null;
    if (cap?.max_daily != null) {
      const used = (
        await c.query(
          `SELECT coalesce(sum(amount), 0)::text AS s FROM affiliate.commission
            WHERE agent_id = $1 AND currency = $2 AND status <> 'REVERSED'
              AND created_at >= (date_trunc('day', now() AT TIME ZONE 'America/Caracas') AT TIME ZONE 'America/Caracas')`,
          [ref.agent_id, t.currency],
        )
      ).rows[0].s;
      dailyLeft = BigInt(cap.max_daily) - BigInt(used);
    }

    const plays = (
      await c.query(`SELECT id, draw_id, amount FROM lottery.play WHERE ticket_id = $1 ORDER BY id`, [t.ticketId])
    ).rows;
    const rows: { playId: string; drawId: string; base: bigint; amount: bigint; capped: boolean }[] = [];
    for (const p of plays) {
      const base = BigInt(p.amount);
      let { amount, capped } = commissionFor(base, rateBps, capPerPlay);
      if (dailyLeft !== null) {
        if (dailyLeft <= 0n) break;
        if (amount > dailyLeft) {
          amount = dailyLeft;
          capped = true;
        }
        dailyLeft -= amount;
      }
      if (amount > 0n) rows.push({ playId: p.id, drawId: p.draw_id, base, amount, capped });
    }
    if (!rows.length) return;

    const total = rows.reduce((a, r) => a + r.amount, 0n);
    const tx = await this.ledger.post(c, {
      type: 'COMMISSION_ACCRUED',
      refProduct: 'AFFILIATE',
      refId: t.ticketId,
      idempotencyKey: `affiliate:accrue:${t.ticketId}`,
      metadata: { agentId: ref.agent_id, playerId: t.playerId, rateBps, plays: rows.length },
      entries: [
        { accountId: await this.ledger.house(c, 'HOUSE_COMMISSIONS', 'LOTTERY', t.currency), direction: 'D', amount: total },
        {
          accountId: await this.ledger.playerAccount(c, ref.agent_user_id, 'AGENT_PENDING', t.currency),
          direction: 'C',
          amount: total,
        },
      ],
    });
    if (tx.duplicate) return;

    await c.query(
      `INSERT INTO affiliate.commission
         (agent_id, player_id, product, play_id, ticket_id, draw_id, game_id, currency, base_amount, rate_bps, amount, capped, accrual_tx_id)
       SELECT $1, $2, 'LOTTERY', p, $3, d, $4, $5, b, $6, a, cp, $7
         FROM unnest($8::uuid[], $9::uuid[], $10::bigint[], $11::bigint[], $12::boolean[]) AS x(p, d, b, a, cp)`,
      [
        ref.agent_id,
        t.playerId,
        t.ticketId,
        t.gameId,
        t.currency,
        rateBps,
        tx.transactionId,
        rows.map((r) => r.playId),
        rows.map((r) => r.drawId),
        rows.map((r) => r.base.toString()),
        rows.map((r) => r.amount.toString()),
        rows.map((r) => r.capped),
      ],
    );
    await publish(c, `player:${ref.agent_user_id}`, 'commission', { status: 'PENDING', currency: t.currency });
  }

  /** Reversa las comisiones por liberar de un ticket anulado por el jugador (K9). */
  async reverseForTicket(c: Db, ticketId: string): Promise<void> {
    const rows = await this.lockPending(c, `c.ticket_id = $1`, [ticketId]);
    await this.finalize(c, rows, 'REVERSED', `ticket:${ticketId}`, { ticketId });
  }

  /** Reversa la comisión de una jugada anulada por anulación del sorteo (K9). */
  async reverseForPlay(c: Db, playId: string): Promise<void> {
    const rows = await this.lockPending(c, `c.play_id = $1`, [playId]);
    await this.finalize(c, rows, 'REVERSED', `play:${playId}`, { playId });
  }

  /** Libera las comisiones de un sorteo recién liquidado (K8). */
  async releaseForDraw(c: Db, drawId: string): Promise<void> {
    const rows = await this.lockPending(
      c,
      `c.draw_id = $1 AND EXISTS (SELECT 1 FROM lottery.play p WHERE p.id = c.play_id AND p.status IN ('WON', 'LOST'))`,
      [drawId],
    );
    await this.finalize(c, rows, 'RELEASED', `draw:${drawId}`, { drawId });
  }

  private async lockPending(c: Db, where: string, params: unknown[]): Promise<PendingRow[]> {
    return (
      await c.query(
        `SELECT c.id, c.agent_id, a.user_id AS agent_user_id, c.currency, c.amount
           FROM affiliate.commission c JOIN affiliate.agent a ON a.id = c.agent_id
          WHERE c.status = 'PENDING' AND ${where}
          ORDER BY c.id FOR UPDATE OF c`,
        params,
      )
    ).rows;
  }

  /** Un asiento por agencia y moneda; marca las filas como RELEASED o REVERSED. */
  private async finalize(c: Db, rows: PendingRow[], status: 'RELEASED' | 'REVERSED', scope: string, metadata: Record<string, unknown>) {
    const groups = new Map<string, PendingRow[]>();
    for (const r of rows) {
      const k = `${r.agent_id}:${r.currency}`;
      groups.set(k, [...(groups.get(k) ?? []), r]);
    }
    for (const [key, list] of groups) {
      const { agent_user_id: userId, currency } = list[0];
      const amount = list.reduce((a, r) => a + BigInt(r.amount), 0n);
      const pending = await this.ledger.playerAccount(c, userId, 'AGENT_PENDING', currency);
      const counter =
        status === 'RELEASED'
          ? await this.ledger.playerAccount(c, userId, 'AGENT_CASH', currency)
          : await this.ledger.house(c, 'HOUSE_COMMISSIONS', 'LOTTERY', currency);
      const tx = await this.ledger.post(c, {
        type: status === 'RELEASED' ? 'COMMISSION_RELEASED' : 'COMMISSION_REVERSED',
        refProduct: 'AFFILIATE',
        refId: scope,
        idempotencyKey: `affiliate:${status === 'RELEASED' ? 'release' : 'reverse'}:${scope}:${key}`,
        metadata: { ...metadata, commissions: list.length },
        entries: [
          { accountId: pending, direction: 'D', amount },
          { accountId: counter, direction: 'C', amount },
        ],
      });
      await c.query(
        `UPDATE affiliate.commission SET status = $2, final_tx_id = $3, finalized_at = now() WHERE id = ANY($1::uuid[])`,
        [list.map((r) => r.id), status, tx.transactionId],
      );
      await publish(c, `player:${userId}`, 'commission', { status, currency });
    }
  }

  // ───────────────────────── Agencia ─────────────────────────

  async agentByUser(c: Db, userId: string) {
    return (
      await c.query(
        `SELECT a.*, k.code FROM affiliate.agent a
           LEFT JOIN affiliate.code k ON k.agent_id = a.id AND k.active
          WHERE a.user_id = $1`,
        [userId],
      )
    ).rows[0] as
      | { id: string; user_id: string; display_name: string; status: string; code: string | null; created_at: string; suspended_reason: string | null }
      | undefined;
  }

  async requireAgent(c: Db, userId: string, opts: { active?: boolean } = {}) {
    const agent = await this.agentByUser(c, userId);
    if (!agent) throw new BusinessError('AGENT_NOT_FOUND', 'Aún no tienes una agencia. Actívala para empezar.');
    if (opts.active && agent.status !== 'ACTIVE') {
      throw new BusinessError('AGENT_SUSPENDED', 'Tu agencia está en revisión. Escríbenos a soporte.');
    }
    return agent;
  }

  /** Resumen por moneda de la pantalla de inicio de la Wallet. */
  async balances(c: Db, userId: string) {
    return (
      await c.query(
        `SELECT cur.code AS currency,
                coalesce(sum(a.balance) FILTER (WHERE a.account_type = 'AGENT_CASH'), 0)::text AS available,
                coalesce(sum(a.balance) FILTER (WHERE a.account_type = 'AGENT_PENDING'), 0)::text AS pending,
                coalesce(sum(a.balance) FILTER (WHERE a.account_type = 'AGENT_LOCKED'), 0)::text AS locked
           FROM wallet.currency cur
           LEFT JOIN wallet.account a ON a.currency = cur.code AND a.owner_type = 'PLAYER' AND a.owner_id = $1
          GROUP BY cur.code ORDER BY cur.code`,
        [userId],
      )
    ).rows;
  }
}
