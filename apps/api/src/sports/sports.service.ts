import { Injectable } from '@nestjs/common';
import {
  combinedOdds,
  CurrencyCode,
  encodeTicketCode,
  formatAmount,
  formatOdds,
  MARKET_TEMPLATES,
  oddsAccepted,
  parseAmount,
  parseOdds,
  slipPayout,
  SlipValidationError,
  validateSlip,
} from '@loteria/domain';
import { randomBytes } from 'crypto';
import { AuditService } from '../audit/audit.service';
import { Db, DbService } from '../common/db.service';
import { BusinessError, pgErrorCode } from '../common/errors';
import { publish } from '../common/realtime';
import { config } from '../config';
import { assertPlayerCanPlay } from '../identity/player-status';
import { LedgerService } from '../wallet/ledger.service';
import { PlaceBetDto } from './sports.dto';
import { eventsSql } from './sports.queries';

function slipErrorMessage(e: SlipValidationError, currency: CurrencyCode, limits: Record<string, string>): string {
  switch (e.code) {
    case 'EMPTY_SLIP':
      return 'El cupón está vacío';
    case 'SINGLE_NEEDS_ONE_LEG':
      return 'Una apuesta simple lleva una sola selección';
    case 'PARLAY_LEGS':
      return `Una combinada lleva entre ${e.min} y ${e.max} selecciones`;
    case 'SAME_EVENT':
      return 'No se pueden combinar dos selecciones del mismo partido';
    case 'STAKE_BELOW_MIN':
      return `El monto mínimo es ${formatAmount(BigInt(limits.min_stake), currency)} ${currency}`;
    case 'STAKE_ABOVE_MAX':
      return `El monto máximo es ${formatAmount(BigInt(limits.max_stake), currency)} ${currency}`;
    case 'ODDS_ABOVE_MAX':
      return `La cuota total supera el máximo permitido (${limits.max_total_odds})`;
    case 'PAYOUT_ABOVE_MAX':
      return `El pago potencial supera el máximo por cupón (${formatAmount(BigInt(limits.max_payout), currency)} ${currency})`;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Sportsbook del jugador (Doc. Maestro §7): catálogo, cupón y liquidación visible. */
@Injectable()
export class SportsService {
  constructor(
    private readonly db: DbService,
    private readonly ledger: LedgerService,
    private readonly audit: AuditService,
  ) {}

  async catalog() {
    const [sports, competitions, limits] = await Promise.all([
      this.db.query(`SELECT code, name FROM sports.sport ORDER BY code DESC`),
      this.db.query(`SELECT id, sport_code, name, country FROM sports.competition ORDER BY sort, name`),
      this.db.query(
        `SELECT currency, min_stake::text, max_stake::text, max_payout::text, max_total_odds::text FROM sports.bet_limit ORDER BY currency`,
      ),
    ]);
    return { sports, competitions, limits, markets: MARKET_TEMPLATES, liveBetDelayMs: config.liveBetDelayMs };
  }

  /** Eventos en oferta: en vivo y pre-partido aún no comenzados. */
  events(sport?: string) {
    return this.db.query(
      eventsSql({
        where: `(e.status = 'LIVE' OR (e.status = 'NOT_STARTED' AND e.starts_at > now())) AND ($1::text IS NULL OR c.sport_code = $1)`,
        marketFilter: `m.status IN ('OPEN', 'SUSPENDED')`,
      }),
      [sport ?? null],
    );
  }

  results(sport?: string) {
    return this.db.query(
      eventsSql({
        where: `((e.status = 'FINISHED' AND e.result_status = 'CONFIRMED') OR e.status = 'CANCELLED')
                AND e.starts_at > now() - interval '7 days' AND ($1::text IS NULL OR c.sport_code = $1)`,
        marketFilter: `true`,
        order: 'e.starts_at DESC',
        limit: 100,
      }),
      [sport ?? null],
    );
  }

  // ───────────── Cupón ─────────────

  async placeBet(playerId: string, dto: PlaceBetDto, idempotencyKey: string, ip: string) {
    const prior = await this.db.one(`SELECT id FROM sports.bet_slip WHERE player_id = $1 AND idempotency_key = $2`, [playerId, idempotencyKey]);
    if (prior) return this.slipDetail(this.db.pool, prior.id);

    // En vivo: retardo antes de aceptar y luego se re-validan estado y cuotas dentro de la transacción (§7.7).
    const live = await this.db.one(
      `SELECT bool_or(e.status = 'LIVE') AS live FROM sports.selection s
         JOIN sports.market m ON m.id = s.market_id JOIN sports.event e ON e.id = m.event_id
        WHERE s.id = ANY($1::uuid[])`,
      [dto.legs.map((l) => l.selectionId)],
    );
    if (live?.live) await sleep(config.liveBetDelayMs);

    try {
      return await this.db.tx((c) => this.placeBetTx(c, playerId, dto, idempotencyKey, ip, !!live?.live));
    } catch (err) {
      if (pgErrorCode(err) === '23505' && String((err as { constraint?: string }).constraint).includes('idempotency')) {
        const s = await this.db.one(`SELECT id FROM sports.bet_slip WHERE player_id = $1 AND idempotency_key = $2`, [playerId, idempotencyKey]);
        if (s) return this.slipDetail(this.db.pool, s.id);
      }
      throw err;
    }
  }

  private async placeBetTx(c: Db, playerId: string, dto: PlaceBetDto, idempotencyKey: string, ip: string, live: boolean) {
    await assertPlayerCanPlay(c, playerId);
    const existing = await c.query(`SELECT id FROM sports.bet_slip WHERE player_id = $1 AND idempotency_key = $2`, [playerId, idempotencyKey]);
    if (existing.rows[0]) return this.slipDetail(c, existing.rows[0].id);

    const currency = dto.currency as CurrencyCode;
    const limits = (await c.query(`SELECT * FROM sports.bet_limit WHERE currency = $1`, [currency])).rows[0];
    if (!limits) throw new BusinessError('INVALID_INPUT', `Apuestas no disponibles en ${currency}`);

    let stake: bigint;
    let seen: Map<string, bigint>;
    try {
      stake = parseAmount(dto.stake, currency);
      seen = new Map(dto.legs.map((l) => [l.selectionId, parseOdds(l.odds)]));
    } catch (e) {
      throw new BusinessError('INVALID_INPUT', (e as Error).message);
    }
    if (seen.size !== dto.legs.length) throw new BusinessError('INVALID_INPUT', 'Hay selecciones repetidas');

    // FOR SHARE: el trader no puede cambiar cuotas ni estados mientras se acepta esta apuesta.
    const rows = (
      await c.query(
        `SELECT s.id, s.odds::text AS odds, s.name, m.id AS market_id, m.status AS market_status, m.type_code,
                e.id AS event_id, e.status AS event_status, e.starts_at > now() AS prematch_open,
                h.name AS home, a.name AS away
           FROM sports.selection s
           JOIN sports.market m ON m.id = s.market_id
           JOIN sports.event e ON e.id = m.event_id
           JOIN sports.participant h ON h.id = e.home_id
           JOIN sports.participant a ON a.id = e.away_id
          WHERE s.id = ANY($1::uuid[]) ORDER BY s.id FOR SHARE OF s, m, e`,
        [[...seen.keys()]],
      )
    ).rows;
    if (rows.length !== seen.size) throw new BusinessError('INVALID_INPUT', 'Selección inexistente');

    for (const r of rows) {
      const label = `${r.home} vs ${r.away}`;
      if (r.event_status === 'NOT_STARTED' && !r.prematch_open) {
        throw new BusinessError('MARKET_SUSPENDED', `${label} ya comenzó; espera la apertura en vivo`, { selectionId: r.id });
      }
      if (!['NOT_STARTED', 'LIVE'].includes(r.event_status) || r.market_status !== 'OPEN') {
        throw new BusinessError('MARKET_SUSPENDED', `Mercado suspendido: ${label} · ${r.name}`, { selectionId: r.id });
      }
    }
    const changes = rows
      .filter((r) => !oddsAccepted(dto.oddsPolicy, seen.get(r.id)!, parseOdds(r.odds)))
      .map((r) => ({ selectionId: r.id, odds: formatOdds(parseOdds(r.odds)) }));
    if (changes.length) {
      throw new BusinessError('ODDS_CHANGED', 'Cambiaron las cuotas. Revisa el cupón y confirma de nuevo.', { changes });
    }

    const legs = rows.map((r) => ({ ...r, eventId: r.event_id as string, odds: parseOdds(r.odds) }));
    const err = validateSlip(dto.type, legs, stake, {
      minStake: BigInt(limits.min_stake),
      maxStake: BigInt(limits.max_stake),
      maxPayout: BigInt(limits.max_payout),
      maxTotalOdds: parseOdds(limits.max_total_odds),
    });
    if (err) {
      const code = ['EMPTY_SLIP', 'SINGLE_NEEDS_ONE_LEG', 'PARLAY_LEGS', 'SAME_EVENT'].includes(err.code) ? 'INVALID_INPUT' : 'LIMIT_EXCEEDED';
      throw new BusinessError(code, slipErrorMessage(err, currency, limits), { ...err });
    }
    const totalOdds = combinedOdds(legs.map((l) => l.odds));
    const potential = slipPayout(stake, legs.map((l) => l.odds));

    // Pasivo por selección (§14): Σ pago potencial de cupones abiertos que la incluyen.
    const cap = BigInt(limits.max_selection_liability);
    for (const l of legs) {
      const res = await c.query(
        `INSERT INTO sports.exposure AS x (selection_id, currency, liability, stake) VALUES ($1, $2, $3, $4)
         ON CONFLICT (selection_id, currency)
         DO UPDATE SET liability = x.liability + EXCLUDED.liability, stake = x.stake + EXCLUDED.stake
         WHERE x.liability + EXCLUDED.liability <= $5
         RETURNING liability`,
        [l.id, currency, potential.toString(), stake.toString(), cap.toString()],
      );
      if (!res.rows[0] || potential > cap) {
        throw new BusinessError('LIMIT_EXCEEDED', `Se alcanzó el límite de riesgo en ${l.name} (${l.home} vs ${l.away}). Prueba con un monto menor.`, {
          selectionId: l.id,
        });
      }
    }

    const code = encodeTicketCode(randomBytes(10));
    const slip = (
      await c.query(
        `INSERT INTO sports.bet_slip (code, player_id, type, currency, stake, total_odds, potential_payout, odds_policy, live, idempotency_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
        [code, playerId, dto.type, currency, stake.toString(), formatOdds(totalOdds), potential.toString(), dto.oddsPolicy, live, idempotencyKey],
      )
    ).rows[0];
    for (const l of legs) {
      await c.query(
        `INSERT INTO sports.bet_leg (slip_id, selection_id, market_id, event_id, odds_taken) VALUES ($1, $2, $3, $4, $5)`,
        [slip.id, l.id, l.market_id, l.event_id, formatOdds(l.odds)],
      );
    }
    await this.ledger.post(c, {
      type: 'BET_PLACED',
      refProduct: 'SPORTS',
      refId: slip.id,
      idempotencyKey: `sports:slip:${slip.id}`,
      createdBy: playerId,
      entries: [
        { accountId: await this.ledger.playerCash(c, playerId, currency), direction: 'D', amount: stake },
        { accountId: await this.ledger.house(c, 'BETS_IN_PLAY', 'SPORTS', currency), direction: 'C', amount: stake },
      ],
    });
    await this.audit.log(c, {
      actorType: 'PLAYER',
      actorId: playerId,
      action: 'BET_PLACED',
      entity: 'sports.bet_slip',
      entityId: slip.id,
      after: { code, type: dto.type, currency, stake, totalOdds: formatOdds(totalOdds), potential, live, legs: legs.map((l) => ({ selectionId: l.id, odds: formatOdds(l.odds) })) },
      ip,
    });
    await publish(c, `player:${playerId}`, 'bet', { id: slip.id, status: 'OPEN' });
    await publish(c, 'staff', 'sports-exposure', { eventIds: [...new Set(legs.map((l) => l.event_id))] });
    return this.slipDetail(c, slip.id);
  }

  async myBets(playerId: string, limit = 50) {
    const ids = await this.db.query(`SELECT id FROM sports.bet_slip WHERE player_id = $1 ORDER BY placed_at DESC LIMIT $2`, [playerId, limit]);
    return Promise.all(ids.map((r) => this.slipDetail(this.db.pool, r.id)));
  }

  async slipDetail(db: Db, slipId: string) {
    const slip = (
      await db.query(
        `SELECT id, code, player_id, type, currency, stake::text, total_odds::text, potential_payout::text, payout::text,
                status, odds_policy, live, placed_at, settled_at
           FROM sports.bet_slip WHERE id = $1`,
        [slipId],
      )
    ).rows[0];
    slip.legs = (
      await db.query(
        `SELECT l.id, l.selection_id, l.odds_taken::text, l.result, s.name AS selection, s.code, m.type_code, m.line::text,
                m.status AS market_status, e.id AS event_id, e.starts_at, e.status AS event_status, e.home_score, e.away_score,
                h.name AS home, a.name AS away, c.name AS competition, c.sport_code AS sport
           FROM sports.bet_leg l
           JOIN sports.selection s ON s.id = l.selection_id
           JOIN sports.market m ON m.id = l.market_id
           JOIN sports.event e ON e.id = l.event_id
           JOIN sports.competition c ON c.id = e.competition_id
           JOIN sports.participant h ON h.id = e.home_id
           JOIN sports.participant a ON a.id = e.away_id
          WHERE l.slip_id = $1 ORDER BY e.starts_at`,
        [slipId],
      )
    ).rows;
    return slip;
  }
}
