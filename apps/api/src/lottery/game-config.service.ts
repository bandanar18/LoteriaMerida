import { Injectable } from '@nestjs/common';
import { CurrencyCode, formatAmount, parseAmount } from '@loteria/domain';
import { AuditService } from '../audit/audit.service';
import { DbService } from '../common/db.service';
import { BusinessError } from '../common/errors';
import { publish } from '../common/realtime';
import { DrawLifecycleService } from './draw-lifecycle.service';
import { MAX_DAILY_SCHEDULE_SLOTS } from './lottery.dto';

type Actor = { id: string; ip?: string };

export interface LimitsInput {
  currency: CurrencyCode;
  minPlay: string;
  maxPlay: string;
  maxTicket: string;
  maxLiabilityPerSymbol: string;
  maxPlayerPerDraw?: string | null;
}

/**
 * Configuración de juegos desde el backoffice: montos de apuesta por moneda y calendario de sorteos.
 * Todo cambio queda en auditoría con el antes y el después.
 */
@Injectable()
export class GameConfigService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly lifecycle: DrawLifecycleService,
  ) {}

  async setAvailability(gameId: string, enabled: boolean, actor: Actor) {
    const status = enabled ? 'ACTIVE' : 'INACTIVE';
    return this.db.tx(async (c) => {
      const { rows: [game] } = await c.query('SELECT status FROM lottery.game WHERE id = $1 FOR UPDATE', [gameId]);
      if (!game) throw new BusinessError('NOT_FOUND', 'Juego no encontrado');
      if (game.status === status) return { status };

      await c.query('UPDATE lottery.game SET status = $2 WHERE id = $1', [gameId, status]);
      if (enabled) await this.lifecycle.generateDraws(gameId, c);
      await this.audit.log(c, {
        actorType: 'STAFF', actorId: actor.id, action: 'GAME_AVAILABILITY_UPDATED', entity: 'lottery.game', entityId: gameId,
        before: { status: game.status }, after: { status }, ip: actor.ip,
      });
      await publish(c, 'lobby', 'game-availability', { gameId });
      return { status };
    });
  }

  async get(gameId: string) {
    const game = await this.db.one(
      `SELECT id, code, name, timezone, close_minutes_before, result_source, requires_record FROM lottery.game WHERE id = $1`,
      [gameId],
    );
    if (!game) throw new BusinessError('NOT_FOUND', 'Juego no encontrado');
    const limits = await this.db.query(
      `SELECT currency, min_play::text, max_play::text, max_ticket::text, max_liability_per_symbol::text, max_player_per_draw::text
         FROM lottery.game_limit WHERE game_id = $1 ORDER BY currency DESC`,
      [gameId],
    );
    const schedule = await this.db.query(
      `SELECT weekday, to_char(draw_time, 'HH24:MI') AS time FROM lottery.schedule
        WHERE game_id = $1 AND active ORDER BY draw_time, weekday`,
      [gameId],
    );
    return { game, limits, schedule };
  }

  async updateLimits(gameId: string, input: LimitsInput, actor: Actor) {
    const cur = input.currency;
    const amount = (label: string, v: string) => {
      try {
        const x = parseAmount(v, cur);
        if (x <= 0n) throw new Error();
        return x;
      } catch {
        throw new BusinessError('INVALID_INPUT', `${label}: monto inválido`);
      }
    };
    const min = amount('Apuesta mínima', input.minPlay);
    const max = amount('Apuesta máxima por jugada', input.maxPlay);
    const ticket = amount('Máximo por ticket', input.maxTicket);
    const cap = amount('Tope de pago por animal', input.maxLiabilityPerSymbol);
    const perPlayer = input.maxPlayerPerDraw ? amount('Máximo por jugador y sorteo', input.maxPlayerPerDraw) : null;
    const f = (x: bigint) => formatAmount(x, cur);
    if (min > max) throw new BusinessError('INVALID_INPUT', `La apuesta mínima (${f(min)}) no puede ser mayor que la máxima (${f(max)})`);
    if (max > ticket) throw new BusinessError('INVALID_INPUT', `El máximo por ticket (${f(ticket)}) debe ser al menos la apuesta máxima (${f(max)})`);
    if (perPlayer !== null && perPlayer < min) {
      throw new BusinessError('INVALID_INPUT', `El máximo por jugador y sorteo (${f(perPlayer)}) debe ser al menos la apuesta mínima`);
    }

    return this.db.tx(async (c) => {
      const before = (
        await c.query(
          `SELECT min_play::text, max_play::text, max_ticket::text, max_liability_per_symbol::text, max_player_per_draw::text
             FROM lottery.game_limit WHERE game_id = $1 AND currency = $2 FOR UPDATE`,
          [gameId, cur],
        )
      ).rows[0];
      if (!before) throw new BusinessError('NOT_FOUND', 'Juego o moneda no encontrados');
      // El tope de pago debe permitir al menos una jugada mínima con el factor vigente.
      const factor = (await c.query(`SELECT factor_x100 FROM lottery.modality WHERE game_id = $1 AND code = 'EXACT'`, [gameId])).rows[0];
      if (factor && cap < (min * BigInt(factor.factor_x100)) / 100n) {
        throw new BusinessError('INVALID_INPUT', `El tope de pago por animal (${f(cap)}) no alcanza ni para una jugada mínima`);
      }
      const after = (
        await c.query(
          `UPDATE lottery.game_limit SET min_play = $3, max_play = $4, max_ticket = $5, max_liability_per_symbol = $6, max_player_per_draw = $7
            WHERE game_id = $1 AND currency = $2
            RETURNING min_play::text, max_play::text, max_ticket::text, max_liability_per_symbol::text, max_player_per_draw::text`,
          [gameId, cur, min.toString(), max.toString(), ticket.toString(), cap.toString(), perPlayer?.toString() ?? null],
        )
      ).rows[0];
      await this.audit.log(c, {
        actorType: 'STAFF',
        actorId: actor.id,
        action: 'GAME_LIMITS_UPDATED',
        entity: 'lottery.game_limit',
        entityId: gameId,
        before: { currency: cur, ...before },
        after: { currency: cur, ...after },
        ip: actor.ip,
      });
      return { currency: cur, ...after };
    });
  }

  /**
   * Reemplaza el calendario: `slots` son las horas activas por día de la semana (0 = domingo).
   * Los sorteos futuros que ya no estén en el calendario y no tengan jugadas se eliminan; los que tienen jugadas se mantienen
   * (se pueden anular con reembolso desde Sorteos). Luego se generan los sorteos nuevos de hoy y mañana.
   */
  async updateSchedule(gameId: string, slots: { weekday: number; time: string }[], closeMinutesBefore: number, actor: Actor) {
    const uniq = new Map<string, { weekday: number; time: string }>();
    for (const s of slots) uniq.set(`${s.weekday}-${s.time}`, s);
    const perDay = new Map<number, number>();
    for (const s of uniq.values()) perDay.set(s.weekday, (perDay.get(s.weekday) ?? 0) + 1);
    if ([...perDay.values()].some((n) => n > MAX_DAILY_SCHEDULE_SLOTS)) {
      throw new BusinessError('INVALID_INPUT', `Máximo ${MAX_DAILY_SCHEDULE_SLOTS} sorteos por día`);
    }
    const desired = [...uniq.values()];

    const result = await this.db.tx(async (c) => {
      const g = (await c.query(`SELECT id, timezone, close_minutes_before FROM lottery.game WHERE id = $1 FOR UPDATE`, [gameId])).rows[0];
      if (!g) throw new BusinessError('NOT_FOUND', 'Juego no encontrado');
      const before = (
        await c.query(
          `SELECT weekday, to_char(draw_time, 'HH24:MI') AS time FROM lottery.schedule WHERE game_id = $1 AND active ORDER BY weekday, draw_time`,
          [gameId],
        )
      ).rows;

      await c.query(`UPDATE lottery.schedule SET active = false WHERE game_id = $1 AND active`, [gameId]);
      await c.query(
        `INSERT INTO lottery.schedule (game_id, weekday, draw_time, active)
         SELECT $1, slot.weekday, slot.draw_time, true
           FROM unnest($2::smallint[], $3::time[]) AS slot(weekday, draw_time)
         ON CONFLICT (game_id, weekday, draw_time) DO UPDATE SET active = true`,
        [gameId, desired.map((s) => s.weekday), desired.map((s) => s.time)],
      );
      if (closeMinutesBefore !== g.close_minutes_before) {
        await c.query(`UPDATE lottery.game SET close_minutes_before = $2 WHERE id = $1`, [gameId, closeMinutesBefore]);
        // Sorteos futuros aún sin cerrar: nuevo cierre de venta.
        await c.query(
          `UPDATE lottery.draw
              SET close_at = draw_at - make_interval(mins => $2),
                  sales_open_at = CASE WHEN status = 'SCHEDULED' AND NOT is_extraordinary
                    THEN least(sales_open_at, draw_at - make_interval(mins => $2) - interval '1 minute')
                    ELSE sales_open_at END
            WHERE game_id = $1 AND sim_player_id IS NULL AND status IN ('SCHEDULED', 'OPEN') AND draw_at > now()
              AND (draw_at - make_interval(mins => $2) >= sales_open_at OR (status = 'SCHEDULED' AND NOT is_extraordinary))`,
          [gameId, closeMinutesBefore],
        );
      }

      // Sorteos futuros del calendario que ya no corresponden.
      const orphan = (
        await c.query(
          `SELECT d.id, d.draw_at
             FROM lottery.draw d
            WHERE d.game_id = $1 AND d.sim_player_id IS NULL AND NOT d.is_extraordinary
              AND d.status IN ('SCHEDULED', 'OPEN') AND d.draw_at > now()
              AND NOT EXISTS (SELECT 1 FROM lottery.schedule s
                               WHERE s.game_id = d.game_id AND s.active
                                 AND s.weekday = extract(dow FROM d.draw_at AT TIME ZONE $2)
                                 AND s.draw_time = (d.draw_at AT TIME ZONE $2)::time)
            ORDER BY d.id FOR UPDATE OF d`,
          [gameId, g.timezone],
        )
      ).rows;
      const { rows: played } = await c.query(`SELECT DISTINCT draw_id FROM lottery.play WHERE draw_id = ANY($1::uuid[])`, [orphan.map((d) => d.id)]);
      const withPlays = new Set(played.map((p) => p.draw_id));
      const removable = orphan.filter((d) => !withPlays.has(d.id)).map((d) => d.id);
      if (removable.length) await c.query(`DELETE FROM lottery.draw WHERE id = ANY($1::uuid[])`, [removable]);
      const kept = orphan.filter((d) => withPlays.has(d.id)).map((d) => d.draw_at);

      await this.lifecycle.generateDraws(gameId, c);
      await this.audit.log(c, {
        actorType: 'STAFF',
        actorId: actor.id,
        action: 'GAME_SCHEDULE_UPDATED',
        entity: 'lottery.game',
        entityId: gameId,
        before: { close_minutes_before: g.close_minutes_before, slots: before },
        after: { close_minutes_before: closeMinutesBefore, slots: desired, removed_draws: removable.length, kept_with_plays: kept.length },
        ip: actor.ip,
      });
      return { removed: removable.length, keptWithPlays: kept };
    });
    return { ...result, ...(await this.get(gameId)) };
  }

  /**
   * Resumen de un rango (hora local del juego) antes de resetear o restaurar.
   * Solo los sorteos terminados (liquidados o anulados) se pueden archivar; los demás se cuentan como omitidos.
   */
  async historyPreview(gameId: string | null, from: string, to: string) {
    this.checkRange(from, to);
    const r = await this.db.one(
      `SELECT count(*) FILTER (WHERE d.archived_at IS NULL AND d.status IN ('SETTLED', 'CANCELLED'))::int AS resettable,
              count(*) FILTER (WHERE d.archived_at IS NULL AND d.status = 'SETTLED')::int AS settled,
              count(*) FILTER (WHERE d.archived_at IS NULL AND d.status = 'CANCELLED')::int AS cancelled,
              count(*) FILTER (WHERE d.archived_at IS NULL AND d.status NOT IN ('SETTLED', 'CANCELLED'))::int AS skipped,
              count(*) FILTER (WHERE d.archived_at IS NOT NULL)::int AS archived,
              (SELECT count(DISTINCT p.ticket_id)::int FROM lottery.play p
                WHERE p.draw_id = ANY(array_agg(d.id) FILTER (WHERE d.archived_at IS NULL AND d.status IN ('SETTLED', 'CANCELLED')))) AS tickets,
              count(DISTINCT d.game_id) FILTER (WHERE d.archived_at IS NULL AND d.status IN ('SETTLED', 'CANCELLED'))::int AS games,
              min(d.draw_at) FILTER (WHERE d.archived_at IS NULL AND d.status IN ('SETTLED', 'CANCELLED')) AS first_at,
              max(d.draw_at) FILTER (WHERE d.archived_at IS NULL AND d.status IN ('SETTLED', 'CANCELLED')) AS last_at
         FROM lottery.draw d JOIN lottery.game g ON g.id = d.game_id
        WHERE ${RANGE}`,
      [gameId, from, to],
    );
    return { from, to, ...r };
  }

  /** Archiva los sorteos terminados del rango. No toca tickets, ledger, RNG, actas ni auditoría. */
  async resetHistory(gameId: string | null, from: string, to: string, actor: Actor) {
    this.checkRange(from, to);
    return this.db.tx(async (c) => {
      const { rows } = await c.query(
        `UPDATE lottery.draw d SET archived_at = now(), archived_by = $4
           FROM lottery.game g
          WHERE g.id = d.game_id AND ${RANGE} AND d.archived_at IS NULL AND d.status IN ('SETTLED', 'CANCELLED')
          RETURNING d.id`,
        [gameId, from, to, actor.id],
      );
      if (!rows.length) throw new BusinessError('INVALID_STATE', 'No hay sorteos terminados para resetear en ese rango');
      const { rows: [skip] } = await c.query(
        `SELECT count(*)::int AS n FROM lottery.draw d JOIN lottery.game g ON g.id = d.game_id
          WHERE ${RANGE} AND d.archived_at IS NULL AND d.status NOT IN ('SETTLED', 'CANCELLED')`,
        [gameId, from, to],
      );
      await this.audit.log(c, {
        actorType: 'STAFF',
        actorId: actor.id,
        action: 'DRAW_HISTORY_RESET',
        entity: 'lottery.draw',
        entityId: gameId ?? 'TODOS',
        after: { from, to, allGames: gameId === null, draws: rows.length, skipped: skip.n },
        ip: actor.ip,
      });
      return { reset: rows.length, skipped: skip.n };
    });
  }

  /** Deshace un reseteo: vuelve a mostrar los sorteos archivados del rango. */
  async restoreHistory(gameId: string | null, from: string, to: string, actor: Actor) {
    this.checkRange(from, to);
    return this.db.tx(async (c) => {
      const { rows } = await c.query(
        `UPDATE lottery.draw d SET archived_at = NULL, archived_by = NULL
           FROM lottery.game g
          WHERE g.id = d.game_id AND ${RANGE} AND d.archived_at IS NOT NULL
          RETURNING d.id`,
        [gameId, from, to],
      );
      if (!rows.length) throw new BusinessError('INVALID_STATE', 'No hay sorteos reseteados en ese rango');
      await this.audit.log(c, {
        actorType: 'STAFF',
        actorId: actor.id,
        action: 'DRAW_HISTORY_RESTORED',
        entity: 'lottery.draw',
        entityId: gameId ?? 'TODOS',
        after: { from, to, allGames: gameId === null, draws: rows.length },
        ip: actor.ip,
      });
      return { restored: rows.length };
    });
  }

  private checkRange(from: string, to: string) {
    if (from > to) throw new BusinessError('INVALID_INPUT', 'La fecha inicial debe ser anterior a la final');
  }
}

/** Rango inclusivo en hora local del juego ($2 y $3 = 'YYYY-MM-DDTHH:MM'); sin juego ($1 nulo) = todos los juegos activos. Excluye sorteos privados del simulador. */
const RANGE = `(($1::uuid IS NULL AND g.status = 'ACTIVE') OR d.game_id = $1) AND d.sim_player_id IS NULL
  AND d.draw_at >= ($2::timestamp AT TIME ZONE g.timezone)
  AND d.draw_at < ($3::timestamp AT TIME ZONE g.timezone) + interval '1 minute'`;
