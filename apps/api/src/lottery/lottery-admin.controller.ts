import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { DbService } from '../common/db.service';
import { localDate } from '../common/time';
import { AuthUser, ClientIp, CurrentUser, Roles } from '../identity/auth.guard';
import { DrawLifecycleService } from './draw-lifecycle.service';
import { CancelDrawDto, DrawsQueryDto, ExtraordinaryDrawDto, ProposeResultDto } from './lottery.dto';
import { LotteryService } from './lottery.service';

@Roles('LOTTERY_OPERATOR', 'AUDITOR')
@Controller('admin/lottery')
export class LotteryAdminController {
  constructor(
    private readonly db: DbService,
    private readonly lifecycle: DrawLifecycleService,
    private readonly lottery: LotteryService,
  ) {}

  @Get('games/:id/draws')
  draws(@Param('id', ParseUUIDPipe) gameId: string, @Query() q: DrawsQueryDto) {
    return this.db.query(
      `SELECT d.id, d.draw_at, d.close_at, d.status, d.is_extraordinary, d.seed_hash, d.result_evidence,
              d.proposed_at, pu.email AS proposed_by_email, ps.number AS proposed_number, ps.name AS proposed_name,
              rs.number AS result_number, rs.name AS result_name, rs.emoji AS result_emoji,
              d.confirmed_at, cu.email AS confirmed_by_email, d.cancelled_reason,
              coalesce(agg.plays, 0) AS plays,
              coalesce(agg.sold, '{}'::jsonb) AS sold_by_currency,
              coalesce(agg.paid, '{}'::jsonb) AS paid_by_currency
         FROM lottery.draw d
         JOIN lottery.game g ON g.id = d.game_id
         LEFT JOIN lottery.symbol ps ON ps.id = d.proposed_symbol_id
         LEFT JOIN lottery.symbol rs ON rs.id = d.result_symbol_id
         LEFT JOIN identity.app_user pu ON pu.id = d.proposed_by
         LEFT JOIN identity.app_user cu ON cu.id = d.confirmed_by
         LEFT JOIN LATERAL (
           SELECT sum(n)::int AS plays,
                  jsonb_object_agg(currency, sold::text) AS sold,
                  jsonb_object_agg(currency, paid::text) AS paid
             FROM (SELECT t.currency, count(*) AS n,
                          sum(p.amount) FILTER (WHERE p.status <> 'VOID') AS sold,
                          sum(p.win) AS paid
                     FROM lottery.play p JOIN lottery.ticket t ON t.id = p.ticket_id
                    WHERE p.draw_id = d.id GROUP BY t.currency) x
         ) agg ON true
        WHERE d.game_id = $1 AND (d.draw_at AT TIME ZONE g.timezone)::date = $2::date
        ORDER BY d.draw_at`,
      [gameId, q.date ?? localDate()],
    );
  }

  /** Panel de riesgo: ventas y pasivo potencial por animal (Doc. Maestro §9.7). */
  @Get('draws/:id/exposure')
  async exposure(@Param('id', ParseUUIDPipe) drawId: string) {
    const draw = await this.db.one(
      `SELECT d.id, d.status, d.draw_at, g.payout_multiplier::text AS multiplier, g.id AS game_id
         FROM lottery.draw d JOIN lottery.game g ON g.id = d.game_id WHERE d.id = $1`,
      [drawId],
    );
    const rows = await this.db.query(
      `SELECT s.id AS symbol_id, s.number, s.name, s.emoji, l.currency,
              coalesce(x.total_amount, 0)::text AS staked,
              (coalesce(x.total_amount, 0) * (g.payout_multiplier * 100)::bigint / 100)::text AS liability,
              l.max_liability_per_symbol::text AS cap
         FROM lottery.symbol s
         JOIN lottery.game g ON g.id = s.game_id
         JOIN lottery.game_limit l ON l.game_id = g.id
         LEFT JOIN lottery.exposure x ON x.draw_id = $1 AND x.symbol_id = s.id AND x.currency = l.currency
        WHERE s.game_id = $2
        ORDER BY l.currency, coalesce(x.total_amount, 0) DESC, s.sort`,
      [drawId, draw?.game_id],
    );
    return { draw, rows };
  }

  @Roles('LOTTERY_OPERATOR')
  @HttpCode(200)
  @Post('draws/:id/propose-result')
  propose(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ProposeResultDto, @CurrentUser() u: AuthUser, @ClientIp() ip: string) {
    return this.lifecycle.proposeResult(id, dto.symbolId, dto.evidence, { id: u.id, ip });
  }

  @Roles('LOTTERY_OPERATOR')
  @HttpCode(200)
  @Post('draws/:id/confirm-result')
  confirm(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: AuthUser, @ClientIp() ip: string) {
    return this.lifecycle.confirmResult(id, { id: u.id, ip });
  }

  @Roles('LOTTERY_OPERATOR')
  @HttpCode(200)
  @Post('draws/:id/reject-result')
  reject(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: AuthUser, @ClientIp() ip: string) {
    return this.lifecycle.rejectResult(id, { id: u.id, ip });
  }

  @Roles('LOTTERY_OPERATOR')
  @HttpCode(200)
  @Post('draws/:id/cancel')
  cancel(@Param('id', ParseUUIDPipe) id: string, @Body() dto: CancelDrawDto, @CurrentUser() u: AuthUser, @ClientIp() ip: string) {
    return this.lifecycle.cancelDraw(id, dto.reason, { id: u.id, ip });
  }

  @Roles('LOTTERY_OPERATOR')
  @Post('games/:id/extraordinary-draw')
  extraordinary(
    @Param('id', ParseUUIDPipe) gameId: string,
    @Body() dto: ExtraordinaryDrawDto,
    @CurrentUser() u: AuthUser,
    @ClientIp() ip: string,
  ) {
    return this.lifecycle.createExtraordinaryDraw(gameId, dto.minutesFromNow, { id: u.id, ip });
  }

  @Get('tickets/:code')
  ticket(@Param('code') code: string) {
    return this.lottery.ticketByCode(code, {});
  }
}
