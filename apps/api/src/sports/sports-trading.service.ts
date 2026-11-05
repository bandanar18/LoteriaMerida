import { Injectable } from '@nestjs/common';
import {
  CurrencyCode,
  formatOdds,
  marketMarginBps,
  marketTemplate,
  parseLine,
  parseOdds,
  Score,
  SelectionResult,
  selectionName,
  settleSelection,
  settleSlip,
  validateMarketLine,
} from '@loteria/domain';
import { AuditService } from '../audit/audit.service';
import { Db, DbService } from '../common/db.service';
import { BusinessError, pgErrorCode } from '../common/errors';
import { publish } from '../common/realtime';
import { LedgerService } from '../wallet/ledger.service';
import { CreateEventDto, MarketInputDto } from './sports.dto';
import { eventsSql } from './sports.queries';

type Actor = { id: string; ip?: string };

/**
 * Trading manual del sportsbook (Doc. Maestro §7.9 y §16.5): el trader publica eventos, mercados y cuotas,
 * suspende, lleva el marcador en vivo y carga el resultado con 4 ojos. La liquidación es automática al confirmar.
 */
@Injectable()
export class SportsTradingService {
  constructor(
    private readonly db: DbService,
    private readonly ledger: LedgerService,
    private readonly audit: AuditService,
  ) {}

  events() {
    return this.db.query(
      eventsSql({
        where: `e.status IN ('NOT_STARTED', 'LIVE') OR (e.status = 'FINISHED' AND e.result_status <> 'CONFIRMED')
                OR e.starts_at > now() - interval '2 days'`,
        marketFilter: 'true',
        admin: true,
        order: `e.status = 'FINISHED' AND e.result_status = 'PROPOSED' DESC, e.status = 'LIVE' DESC, e.status IN ('NOT_STARTED', 'LIVE') DESC, e.starts_at`,
      }),
    );
  }

  async bets(eventId?: string) {
    return this.db.query(
      `SELECT b.id, b.code, b.type, b.currency, b.stake::text, b.total_odds::text, b.potential_payout::text, b.payout::text,
              b.status, b.live, b.placed_at, u.email,
              (SELECT jsonb_agg(jsonb_build_object('selection', s.name, 'odds', l.odds_taken::text, 'result', l.result,
                                                   'event', h.name || ' vs ' || a.name) ORDER BY l.id)
                 FROM sports.bet_leg l JOIN sports.selection s ON s.id = l.selection_id JOIN sports.event e ON e.id = l.event_id
                 JOIN sports.participant h ON h.id = e.home_id JOIN sports.participant a ON a.id = e.away_id
                WHERE l.slip_id = b.id) AS legs
         FROM sports.bet_slip b JOIN identity.app_user u ON u.id = b.player_id
        WHERE $1::uuid IS NULL OR EXISTS (SELECT 1 FROM sports.bet_leg l WHERE l.slip_id = b.id AND l.event_id = $1)
        ORDER BY b.placed_at DESC LIMIT 100`,
      [eventId ?? null],
    );
  }

  // ───────────── Eventos y mercados ─────────────

  async createEvent(dto: CreateEventDto, actor: Actor) {
    if (dto.home.trim().toLowerCase() === dto.away.trim().toLowerCase()) throw new BusinessError('INVALID_INPUT', 'Local y visitante deben ser distintos');
    return this.db.tx(async (c) => {
      const comp = (await c.query(`SELECT id, sport_code FROM sports.competition WHERE id = $1`, [dto.competitionId])).rows[0];
      if (!comp) throw new BusinessError('NOT_FOUND', 'Competición no encontrada');
      const startsAt = new Date(dto.startsAt);
      if (startsAt.getTime() < Date.now() + 60_000) throw new BusinessError('INVALID_INPUT', 'El evento debe empezar en el futuro');
      const [homeId, awayId] = [await this.participant(c, comp.sport_code, dto.home), await this.participant(c, comp.sport_code, dto.away)];
      const ev = (
        await c.query(
          `INSERT INTO sports.event (competition_id, home_id, away_id, starts_at, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
          [comp.id, homeId, awayId, startsAt.toISOString(), actor.id],
        )
      ).rows[0];
      await this.audit.log(c, {
        actorType: 'STAFF',
        actorId: actor.id,
        action: 'SPORTS_EVENT_CREATED',
        entity: 'sports.event',
        entityId: ev.id,
        after: { competitionId: comp.id, home: dto.home, away: dto.away, startsAt: startsAt.toISOString() },
        ip: actor.ip,
      });
      for (const m of dto.markets ?? []) await this.addMarketTx(c, ev.id, m, actor);
      await publish(c, 'lobby', 'sports', { eventId: ev.id });
      return { id: ev.id };
    });
  }

  addMarket(eventId: string, dto: MarketInputDto, actor: Actor) {
    return this.db.tx(async (c) => {
      const market = await this.addMarketTx(c, eventId, dto, actor);
      await publish(c, 'lobby', 'sports', { eventId });
      return market;
    });
  }

  private async participant(c: Db, sport: string, name: string): Promise<string> {
    const res = await c.query(
      `INSERT INTO sports.participant (sport_code, name) VALUES ($1, $2)
       ON CONFLICT (sport_code, name) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
      [sport, name.trim()],
    );
    return res.rows[0].id;
  }

  private async addMarketTx(c: Db, eventId: string, dto: MarketInputDto, actor: Actor) {
    const ev = (await this.lockEvent(c, eventId));
    if (!['NOT_STARTED', 'LIVE'].includes(ev.status)) throw new BusinessError('INVALID_STATE', 'El evento ya no admite mercados');
    const t = marketTemplate(dto.type);
    if (!t || t.sport !== ev.sport) throw new BusinessError('INVALID_INPUT', `Mercado no disponible para este deporte: ${dto.type}`);
    let line: number | null = null;
    try {
      line = dto.line !== undefined && dto.line !== '' ? parseLine(dto.line) : null;
    } catch (e) {
      throw new BusinessError('INVALID_INPUT', (e as Error).message);
    }
    const lineErr = validateMarketLine(t, line);
    if (lineErr) throw new BusinessError('INVALID_INPUT', lineErr);
    const odds = t.selections.map((s) => {
      const raw = dto.odds?.[s.code];
      if (!raw) throw new BusinessError('INVALID_INPUT', `Falta la cuota de "${selectionName(s.name, { ...ev, line })}"`);
      try {
        return parseOdds(raw);
      } catch (e) {
        throw new BusinessError('INVALID_INPUT', (e as Error).message);
      }
    });

    let market;
    try {
      market = (
        await c.query(`INSERT INTO sports.market (event_id, type_code, line) VALUES ($1, $2, $3) RETURNING id`, [
          eventId,
          t.code,
          line === null ? null : (line / 100).toFixed(2),
        ])
      ).rows[0];
    } catch (err) {
      if (pgErrorCode(err) === '23505') throw new BusinessError('CONFLICT', 'Ese mercado (con esa línea) ya existe en el evento');
      throw err;
    }
    for (const [i, s] of t.selections.entries()) {
      const sel = (
        await c.query(
          `INSERT INTO sports.selection (market_id, code, name, odds, sort) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
          [market.id, s.code, selectionName(s.name, { home: ev.home, away: ev.away, line }), formatOdds(odds[i]), i],
        )
      ).rows[0];
      await c.query(`INSERT INTO sports.odds_history (selection_id, odds, changed_by) VALUES ($1, $2, $3)`, [sel.id, formatOdds(odds[i]), actor.id]);
    }
    await this.audit.log(c, {
      actorType: 'STAFF',
      actorId: actor.id,
      action: 'SPORTS_MARKET_CREATED',
      entity: 'sports.market',
      entityId: market.id,
      after: { eventId, type: t.code, line, odds: odds.map(formatOdds), marginBps: marketMarginBps(odds) },
      ip: actor.ip,
    });
    return { id: market.id, marginBps: marketMarginBps(odds) };
  }

  async updateOdds(marketId: string, odds: Record<string, string>, actor: Actor) {
    return this.db.tx(async (c) => {
      const m = await this.lockMarket(c, marketId);
      if (!['OPEN', 'SUSPENDED'].includes(m.status)) throw new BusinessError('INVALID_STATE', 'El mercado ya cerró');
      const sels = (await c.query(`SELECT id, name, odds::text FROM sports.selection WHERE market_id = $1 ORDER BY sort FOR UPDATE`, [marketId])).rows;
      const changes: { selectionId: string; from: string; to: string }[] = [];
      for (const [selectionId, raw] of Object.entries(odds)) {
        const s = sels.find((x) => x.id === selectionId);
        if (!s) throw new BusinessError('INVALID_INPUT', 'Selección de otro mercado');
        let v: bigint;
        try {
          v = parseOdds(raw);
        } catch (e) {
          throw new BusinessError('INVALID_INPUT', `${s.name}: ${(e as Error).message}`);
        }
        if (v === parseOdds(s.odds)) continue;
        await c.query(`UPDATE sports.selection SET odds = $2 WHERE id = $1`, [selectionId, formatOdds(v)]);
        await c.query(`INSERT INTO sports.odds_history (selection_id, odds, changed_by) VALUES ($1, $2, $3)`, [selectionId, formatOdds(v), actor.id]);
        changes.push({ selectionId, from: formatOdds(parseOdds(s.odds)), to: formatOdds(v) });
        s.odds = formatOdds(v);
      }
      if (!changes.length) return { changed: 0 };
      const margin = marketMarginBps(sels.map((s) => parseOdds(s.odds)));
      await this.audit.log(c, {
        actorType: 'STAFF',
        actorId: actor.id,
        action: 'SPORTS_ODDS_CHANGED',
        entity: 'sports.market',
        entityId: marketId,
        after: { changes, marginBps: margin },
        ip: actor.ip,
      });
      await publish(c, 'lobby', 'odds', { eventId: m.event_id, marketId, changes: changes.map(({ selectionId, to }) => ({ selectionId, odds: to })) });
      return { changed: changes.length, marginBps: margin };
    });
  }

  async setMarketStatus(marketId: string, status: 'OPEN' | 'SUSPENDED', actor: Actor) {
    return this.db.tx(async (c) => {
      const m = await this.lockMarket(c, marketId);
      if (!['OPEN', 'SUSPENDED'].includes(m.status)) throw new BusinessError('INVALID_STATE', 'El mercado ya cerró');
      if (status === 'OPEN' && !['NOT_STARTED', 'LIVE'].includes(m.event_status)) throw new BusinessError('INVALID_STATE', 'El evento ya terminó');
      if (m.status === status) return { status };
      await c.query(`UPDATE sports.market SET status = $2 WHERE id = $1`, [marketId, status]);
      await this.audit.log(c, {
        actorType: 'STAFF',
        actorId: actor.id,
        action: status === 'OPEN' ? 'SPORTS_MARKET_OPENED' : 'SPORTS_MARKET_SUSPENDED',
        entity: 'sports.market',
        entityId: marketId,
        ip: actor.ip,
      });
      await publish(c, 'lobby', 'sports', { eventId: m.event_id });
      return { status };
    });
  }

  /** Suspender/abrir todos los mercados de un evento (p. ej. ante un gol o jugada peligrosa). */
  async setEventMarketsStatus(eventId: string, status: 'OPEN' | 'SUSPENDED', actor: Actor) {
    return this.db.tx(async (c) => {
      const ev = await this.lockEvent(c, eventId);
      if (!['NOT_STARTED', 'LIVE'].includes(ev.status)) throw new BusinessError('INVALID_STATE', 'El evento ya terminó');
      const res = await c.query(
        `UPDATE sports.market SET status = $2 WHERE event_id = $1 AND status IN ('OPEN', 'SUSPENDED') AND status <> $2 RETURNING id`,
        [eventId, status],
      );
      await this.audit.log(c, {
        actorType: 'STAFF',
        actorId: actor.id,
        action: status === 'OPEN' ? 'SPORTS_EVENT_MARKETS_OPENED' : 'SPORTS_EVENT_MARKETS_SUSPENDED',
        entity: 'sports.event',
        entityId: eventId,
        after: { markets: res.rows.length },
        ip: actor.ip,
      });
      await publish(c, 'lobby', 'sports', { eventId });
      return { status, markets: res.rows.length };
    });
  }

  async startLive(eventId: string, actor: Actor) {
    return this.db.tx(async (c) => {
      const ev = await this.lockEvent(c, eventId);
      if (ev.status !== 'NOT_STARTED') throw new BusinessError('INVALID_STATE', 'El evento no está por comenzar');
      await c.query(`UPDATE sports.event SET status = 'LIVE', home_score = 0, away_score = 0 WHERE id = $1`, [eventId]);
      await this.audit.log(c, { actorType: 'STAFF', actorId: actor.id, action: 'SPORTS_EVENT_LIVE', entity: 'sports.event', entityId: eventId, ip: actor.ip });
      await publish(c, 'lobby', 'sports', { eventId });
      return { status: 'LIVE' };
    });
  }

  async updateScore(eventId: string, score: Score, actor: Actor) {
    return this.db.tx(async (c) => {
      const ev = await this.lockEvent(c, eventId);
      if (ev.status !== 'LIVE') throw new BusinessError('INVALID_STATE', 'El marcador solo se actualiza en vivo');
      await c.query(`UPDATE sports.event SET home_score = $2, away_score = $3 WHERE id = $1`, [eventId, score.home, score.away]);
      await this.audit.log(c, {
        actorType: 'STAFF',
        actorId: actor.id,
        action: 'SPORTS_SCORE_UPDATED',
        entity: 'sports.event',
        entityId: eventId,
        before: { home: ev.home_score, away: ev.away_score },
        after: score,
        ip: actor.ip,
      });
      await publish(c, 'lobby', 'sports', { eventId });
      return score;
    });
  }

  // ───────────── Resultado (4 ojos) y liquidación ─────────────

  /** Paso 1: se cierra la venta y se propone el marcador final con evidencia. */
  async proposeResult(eventId: string, score: Score, evidence: string, actor: Actor) {
    return this.db.tx(async (c) => {
      const ev = await this.lockEvent(c, eventId);
      const startedPrematch = ev.status === 'NOT_STARTED' && ev.started;
      const reproposal = ev.status === 'FINISHED' && ev.result_status === 'NONE';
      if (!(ev.status === 'LIVE' || startedPrematch || reproposal)) {
        throw new BusinessError('INVALID_STATE', ev.status === 'NOT_STARTED' ? 'El evento aún no ha comenzado' : 'El evento no admite resultado');
      }
      await c.query(
        `UPDATE sports.event SET status = 'FINISHED', result_status = 'PROPOSED', proposed_home = $2, proposed_away = $3,
                proposed_evidence = $4, proposed_by = $5, proposed_at = now() WHERE id = $1`,
        [eventId, score.home, score.away, evidence, actor.id],
      );
      await c.query(`UPDATE sports.market SET status = 'CLOSED' WHERE event_id = $1 AND status IN ('OPEN', 'SUSPENDED')`, [eventId]);
      await this.audit.log(c, {
        actorType: 'STAFF',
        actorId: actor.id,
        action: 'SPORTS_RESULT_PROPOSED',
        entity: 'sports.event',
        entityId: eventId,
        after: { ...score, evidence },
        ip: actor.ip,
      });
      await publish(c, 'lobby', 'sports', { eventId });
      await publish(c, 'staff', 'queue', { kind: 'sports-results' });
      return { resultStatus: 'PROPOSED' };
    });
  }

  /** Paso 2: otro usuario confirma y se liquidan todos los mercados cerrados del evento. */
  async confirmResult(eventId: string, actor: Actor) {
    return this.db.tx(async (c) => {
      const ev = await this.lockEvent(c, eventId);
      if (ev.result_status !== 'PROPOSED') throw new BusinessError('INVALID_STATE', 'No hay resultado propuesto');
      if (ev.proposed_by === actor.id) {
        throw new BusinessError('FOUR_EYES_REQUIRED', 'El resultado debe confirmarlo un usuario distinto a quien lo cargó');
      }
      const score = { home: ev.proposed_home as number, away: ev.proposed_away as number };
      await c.query(
        `UPDATE sports.event SET result_status = 'CONFIRMED', home_score = $2, away_score = $3, confirmed_by = $4, confirmed_at = now()
          WHERE id = $1`,
        [eventId, score.home, score.away, actor.id],
      );
      const markets = (await c.query(`SELECT id FROM sports.market WHERE event_id = $1 AND status = 'CLOSED' ORDER BY id FOR UPDATE`, [eventId])).rows;
      let slips = 0;
      for (const m of markets) slips += await this.settleMarket(c, m.id, score);
      await this.audit.log(c, {
        actorType: 'STAFF',
        actorId: actor.id,
        action: 'SPORTS_RESULT_CONFIRMED',
        entity: 'sports.event',
        entityId: eventId,
        after: { ...score, proposedBy: ev.proposed_by, markets: markets.length, slipsSettled: slips },
        ip: actor.ip,
      });
      await publish(c, 'lobby', 'sports', { eventId });
      await publish(c, 'staff', 'queue', { kind: 'sports-results' });
      return { resultStatus: 'CONFIRMED', markets: markets.length, slipsSettled: slips };
    });
  }

  async rejectResult(eventId: string, actor: Actor) {
    return this.db.tx(async (c) => {
      const ev = await this.lockEvent(c, eventId);
      if (ev.result_status !== 'PROPOSED') throw new BusinessError('INVALID_STATE', 'No hay resultado propuesto');
      await c.query(
        `UPDATE sports.event SET result_status = 'NONE', proposed_home = NULL, proposed_away = NULL, proposed_evidence = NULL,
                proposed_by = NULL, proposed_at = NULL WHERE id = $1`,
        [eventId],
      );
      await this.audit.log(c, {
        actorType: 'STAFF',
        actorId: actor.id,
        action: 'SPORTS_RESULT_REJECTED',
        entity: 'sports.event',
        entityId: eventId,
        before: { home: ev.proposed_home, away: ev.proposed_away, proposedBy: ev.proposed_by },
        ip: actor.ip,
      });
      await publish(c, 'staff', 'queue', { kind: 'sports-results' });
      return { resultStatus: 'NONE' };
    });
  }

  /** Anula un mercado (regla de liga, error palpable, juego no oficial): todas sus selecciones a VOID. */
  async voidMarket(marketId: string, reason: string, actor: Actor) {
    return this.db.tx(async (c) => {
      const m = await this.lockMarket(c, marketId);
      if (['SETTLED', 'VOIDED'].includes(m.status)) throw new BusinessError('INVALID_STATE', `El mercado ya está ${m.status}`);
      const slips = await this.voidMarketTx(c, marketId, reason);
      await this.audit.log(c, {
        actorType: 'STAFF',
        actorId: actor.id,
        action: 'SPORTS_MARKET_VOIDED',
        entity: 'sports.market',
        entityId: marketId,
        before: { status: m.status },
        after: { reason, slipsAffected: slips },
        ip: actor.ip,
      });
      await publish(c, 'lobby', 'sports', { eventId: m.event_id });
      return { status: 'VOIDED', slipsAffected: slips };
    });
  }

  async cancelEvent(eventId: string, reason: string, actor: Actor) {
    return this.db.tx(async (c) => {
      const ev = await this.lockEvent(c, eventId);
      if (ev.status === 'CANCELLED' || ev.result_status === 'CONFIRMED') throw new BusinessError('INVALID_STATE', 'El evento ya está cerrado');
      const markets = (
        await c.query(`SELECT id FROM sports.market WHERE event_id = $1 AND status NOT IN ('SETTLED', 'VOIDED') ORDER BY id FOR UPDATE`, [eventId])
      ).rows;
      let slips = 0;
      for (const m of markets) slips += await this.voidMarketTx(c, m.id, reason);
      await c.query(`UPDATE sports.event SET status = 'CANCELLED', cancelled_reason = $2, result_status = 'NONE' WHERE id = $1`, [eventId, reason]);
      await this.audit.log(c, {
        actorType: 'STAFF',
        actorId: actor.id,
        action: 'SPORTS_EVENT_CANCELLED',
        entity: 'sports.event',
        entityId: eventId,
        before: { status: ev.status },
        after: { reason, markets: markets.length, slipsAffected: slips },
        ip: actor.ip,
      });
      await publish(c, 'lobby', 'sports', { eventId });
      return { status: 'CANCELLED', slipsAffected: slips };
    });
  }

  private async voidMarketTx(c: Db, marketId: string, reason: string) {
    await c.query(`UPDATE sports.market SET status = 'VOIDED', void_reason = $2, settled_at = now() WHERE id = $1`, [marketId, reason]);
    await c.query(`UPDATE sports.selection SET result = 'VOID' WHERE market_id = $1`, [marketId]);
    return this.settleLegs(c, marketId);
  }

  private async settleMarket(c: Db, marketId: string, score: Score): Promise<number> {
    const m = (await c.query(`SELECT type_code, line::text FROM sports.market WHERE id = $1`, [marketId])).rows[0];
    const line = m.line === null ? null : parseLine(m.line);
    const sels = (await c.query(`SELECT id, code FROM sports.selection WHERE market_id = $1`, [marketId])).rows;
    for (const s of sels) {
      const result: SelectionResult = settleSelection(m.type_code, line, s.code, score);
      await c.query(`UPDATE sports.selection SET result = $2 WHERE id = $1`, [s.id, result]);
    }
    await c.query(`UPDATE sports.market SET status = 'SETTLED', settled_at = now() WHERE id = $1`, [marketId]);
    return this.settleLegs(c, marketId);
  }

  /** Copia el resultado de las selecciones a las patas abiertas y re-evalúa sus cupones. */
  private async settleLegs(c: Db, marketId: string): Promise<number> {
    const legs = await c.query(
      `UPDATE sports.bet_leg l SET result = s.result, settled_at = now()
         FROM sports.selection s WHERE s.id = l.selection_id AND l.market_id = $1 AND l.result IS NULL
       RETURNING l.slip_id`,
      [marketId],
    );
    const slipIds = [...new Set(legs.rows.map((r) => r.slip_id as string))].sort();
    let settled = 0;
    for (const id of slipIds) if (await this.refreshSlip(c, id)) settled++;
    return settled;
  }

  private async refreshSlip(c: Db, slipId: string): Promise<boolean> {
    const slip = (await c.query(`SELECT * FROM sports.bet_slip WHERE id = $1 FOR UPDATE`, [slipId])).rows[0];
    if (slip.status !== 'OPEN') return false;
    const legs = (await c.query(`SELECT selection_id, odds_taken::text, result FROM sports.bet_leg WHERE slip_id = $1`, [slipId])).rows;
    const stake = BigInt(slip.stake);
    const { status, payout } = settleSlip(stake, legs.map((l) => ({ odds: parseOdds(l.odds_taken), result: l.result })));
    if (status === 'OPEN') return false;

    const currency = slip.currency as CurrencyCode;
    const inPlay = await this.ledger.house(c, 'BETS_IN_PLAY', 'SPORTS', currency);
    const cash = await this.ledger.playerCash(c, slip.player_id, currency);
    const ggr = await this.ledger.house(c, 'HOUSE_GGR', 'SPORTS', currency);
    const entries =
      status === 'LOST'
        ? [
            { accountId: inPlay, direction: 'D' as const, amount: stake },
            { accountId: ggr, direction: 'C' as const, amount: stake },
          ]
        : [
            { accountId: inPlay, direction: 'D' as const, amount: stake },
            ...(payout > stake ? [{ accountId: ggr, direction: 'D' as const, amount: payout - stake }] : []),
            { accountId: cash, direction: 'C' as const, amount: payout },
          ];
    await this.ledger.post(c, {
      type: status === 'WON' ? 'BET_WON' : status === 'LOST' ? 'BET_LOST' : 'BET_VOID',
      refProduct: 'SPORTS',
      refId: slipId,
      idempotencyKey: `sports:slip-settle:${slipId}`,
      metadata: { code: slip.code },
      entries,
    });
    await c.query(`UPDATE sports.bet_slip SET status = $2, payout = $3, settled_at = now() WHERE id = $1`, [slipId, status, payout.toString()]);
    // Libera el pasivo reservado en cada selección del cupón.
    for (const l of legs) {
      await c.query(
        `UPDATE sports.exposure SET liability = liability - $3, stake = stake - $4 WHERE selection_id = $1 AND currency = $2`,
        [l.selection_id, currency, slip.potential_payout, slip.stake],
      );
    }
    await publish(c, `player:${slip.player_id}`, 'bet', { id: slipId, status });
    return true;
  }

  private async lockEvent(c: Db, eventId: string) {
    const ev = (
      await c.query(
        `SELECT e.*, e.starts_at <= now() AS started, c.sport_code AS sport, h.name AS home, a.name AS away
           FROM sports.event e
           JOIN sports.competition c ON c.id = e.competition_id
           JOIN sports.participant h ON h.id = e.home_id
           JOIN sports.participant a ON a.id = e.away_id
          WHERE e.id = $1 FOR UPDATE OF e`,
        [eventId],
      )
    ).rows[0];
    if (!ev) throw new BusinessError('NOT_FOUND', 'Evento no encontrado');
    return ev;
  }

  private async lockMarket(c: Db, marketId: string) {
    const m = (
      await c.query(
        `SELECT m.*, e.status AS event_status FROM sports.market m JOIN sports.event e ON e.id = m.event_id
          WHERE m.id = $1 FOR UPDATE OF m`,
        [marketId],
      )
    ).rows[0];
    if (!m) throw new BusinessError('NOT_FOUND', 'Mercado no encontrado');
    return m;
  }
}
