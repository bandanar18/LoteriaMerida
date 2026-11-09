/// <reference types="multer" />
import { Body, Controller, Get, Header, HttpCode, Param, ParseBoolPipe, ParseUUIDPipe, Post, Put, Query, Res, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { KYC_MAX_FILE_BYTES } from '@loteria/domain';
import type { Response } from 'express';
import { DbService } from '../common/db.service';
import { localDate } from '../common/time';
import { AuthUser, ClientIp, CurrentUser, Roles } from '../identity/auth.guard';
import { DrawLifecycleService } from './draw-lifecycle.service';
import {
  AnalyticsQueryDto,
  BandTestDto,
  CancelDrawDto,
  DrawIncidentDto,
  DrawRecordDto,
  DrawsQueryDto,
  ExtraordinaryDrawDto,
  GameLimitsDto,
  GameScheduleDto,
  HistoryRangeDto,
  ProposeResultDto,
  ResolveIncidentDto,
  RiskQueryDto,
  TicketsQueryDto,
  UpdateBandDto,
} from './lottery.dto';
import { AnalyticsService } from './analytics.service';
import { GameConfigService } from './game-config.service';
import { LotteryService } from './lottery.service';
import { resultPayouts, RiskService } from './risk.service';

const recordUpload = FileInterceptor('file', { limits: { fileSize: KYC_MAX_FILE_BYTES, files: 1, fields: 6 } });

@Roles('LOTTERY_OPERATOR', 'AUDITOR')
@Controller('admin/lottery')
export class LotteryAdminController {
  constructor(
    private readonly db: DbService,
    private readonly lifecycle: DrawLifecycleService,
    private readonly lottery: LotteryService,
    private readonly risk: RiskService,
    private readonly analytics: AnalyticsService,
    private readonly gameConfig: GameConfigService,
  ) {}

  /** Configuración del juego: montos por moneda y calendario de sorteos. */
  @Get('games/:id/config')
  config(@Param('id', ParseUUIDPipe) gameId: string) {
    return this.gameConfig.get(gameId);
  }

  @Roles('LOTTERY_OPERATOR')
  @Put('games/:id/limits')
  updateLimits(@Param('id', ParseUUIDPipe) gameId: string, @Body() dto: GameLimitsDto, @CurrentUser() u: AuthUser, @ClientIp() ip: string) {
    return this.gameConfig.updateLimits(gameId, dto, { id: u.id, ip });
  }

  @Roles('LOTTERY_OPERATOR')
  @Put('games/:id/schedule')
  updateSchedule(@Param('id', ParseUUIDPipe) gameId: string, @Body() dto: GameScheduleDto, @CurrentUser() u: AuthUser, @ClientIp() ip: string) {
    return this.gameConfig.updateSchedule(gameId, dto.slots, dto.closeMinutesBefore, { id: u.id, ip });
  }

  /** Reseteo del historial por rango: primero el resumen, luego archivar o restaurar. Solo administradores. */
  @Roles('ADMIN')
  @Get('games/:id/history/preview')
  historyPreview(@Param('id', ParseUUIDPipe) gameId: string, @Query() q: HistoryRangeDto) {
    return this.gameConfig.historyPreview(gameId, q.from, q.to);
  }

  @Roles('ADMIN')
  @Post('games/:id/history/reset')
  @HttpCode(200)
  resetHistory(@Param('id', ParseUUIDPipe) gameId: string, @Body() dto: HistoryRangeDto, @CurrentUser() u: AuthUser, @ClientIp() ip: string) {
    return this.gameConfig.resetHistory(gameId, dto.from, dto.to, { id: u.id, ip });
  }

  @Roles('ADMIN')
  @Post('games/:id/history/restore')
  @HttpCode(200)
  restoreHistory(@Param('id', ParseUUIDPipe) gameId: string, @Body() dto: HistoryRangeDto, @CurrentUser() u: AuthUser, @ClientIp() ip: string) {
    return this.gameConfig.restoreHistory(gameId, dto.from, dto.to, { id: u.id, ip });
  }

  /** Reseteo del historial de TODOS los juegos en el mismo rango (misma regla: solo sorteos terminados, se puede restaurar). */
  @Roles('ADMIN')
  @Get('history/preview')
  historyPreviewAll(@Query() q: HistoryRangeDto) {
    return this.gameConfig.historyPreview(null, q.from, q.to);
  }

  @Roles('ADMIN')
  @Post('history/reset')
  @HttpCode(200)
  resetHistoryAll(@Body() dto: HistoryRangeDto, @CurrentUser() u: AuthUser, @ClientIp() ip: string) {
    return this.gameConfig.resetHistory(null, dto.from, dto.to, { id: u.id, ip });
  }

  @Roles('ADMIN')
  @Post('history/restore')
  @HttpCode(200)
  restoreHistoryAll(@Body() dto: HistoryRangeDto, @CurrentUser() u: AuthUser, @ClientIp() ip: string) {
    return this.gameConfig.restoreHistory(null, dto.from, dto.to, { id: u.id, ip });
  }

  /** Mercado: frecuencia histórica por animal, ganancia y margen por sorteo (solo datos pasados). */
  @Get('games/:id/analytics')
  analyticsOverview(@Param('id', ParseUUIDPipe) gameId: string, @Query() q: AnalyticsQueryDto) {
    return this.analytics.overview(gameId, q.currency ?? 'VES', q.days ?? 14, q.date);
  }

  @Roles('ADMIN')
  @Get('games/:id/next-band')
  @Header('Cache-Control', 'private, no-store')
  nextBand(@Param('id', ParseUUIDPipe) gameId: string, @Query('simulated', new ParseBoolPipe({ optional: true })) simulated = false) {
    return this.analytics.nextBand(gameId, simulated);
  }

  @Roles('ADMIN')
  @Put('games/:id/next-band')
  @Header('Cache-Control', 'private, no-store')
  updateBand(@Param('id', ParseUUIDPipe) gameId: string, @Body() dto: UpdateBandDto, @CurrentUser() u: AuthUser) {
    return this.analytics.updateBand(gameId, dto.drawId, dto.candidateIds, u.id);
  }

  @Roles('ADMIN')
  @Post('games/:id/next-band/quick-test')
  @HttpCode(200)
  @Header('Cache-Control', 'private, no-store')
  quickBandTest(@Param('id', ParseUUIDPipe) gameId: string, @Body() dto: BandTestDto) {
    return this.analytics.quickBandTest(gameId, dto);
  }

  /** Libro de todos los tickets jugados, con filtros y paginación. */
  @Get('tickets')
  ticketBook(@Query() q: TicketsQueryDto) {
    return this.analytics.tickets({ ...q, includeSim: q.includeSim === 'true' });
  }

  /** Tablero de riesgo y rentabilidad del día (modelo 1/N; no anticipa resultados). */
  @Get('games/:id/risk')
  riskDay(@Param('id', ParseUUIDPipe) gameId: string, @Query() q: RiskQueryDto) {
    return this.risk.day(gameId, q.currency ?? 'VES', q.date);
  }

  @Get('games/:id/risk/history')
  riskHistory(@Param('id', ParseUUIDPipe) gameId: string, @Query() q: RiskQueryDto) {
    return this.risk.history(gameId, q.currency ?? 'VES', 14);
  }

  @Get('games/:id/draws')
  async draws(@Param('id', ParseUUIDPipe) gameId: string, @Query() q: DrawsQueryDto) {
    const rows = await this.db.query(
      `SELECT d.id, d.draw_at, d.close_at, d.status, d.is_extraordinary, d.auto_rng, d.seed_hash, d.result_evidence,
              d.result_numbers, d.proposed_numbers,
              d.proposed_at, pu.email AS proposed_by_email, ps.number AS proposed_number, ps.name AS proposed_name,
              rs.number AS result_number, rs.name AS result_name, rs.emoji AS result_emoji,
              d.confirmed_at, cu.email AS confirmed_by_email, d.cancelled_reason,
              g.requires_record,
              EXISTS (SELECT 1 FROM lottery.draw_record r WHERE r.draw_id = d.id) AS has_record,
              (SELECT count(*)::int FROM lottery.draw_incident i WHERE i.draw_id = d.id AND i.resolved_at IS NULL) AS open_incidents,
              -- Mayor uso del tope de pago por animal (0–100), con el factor del exacto vigente.
              (SELECT coalesce(max(x.total_amount * m.factor_x100 / 100 * 100 / l.max_liability_per_symbol), 0)::int
                 FROM lottery.exposure x
                 JOIN lottery.game_limit l ON l.game_id = d.game_id AND l.currency = x.currency
                 JOIN lottery.modality m ON m.game_id = d.game_id AND m.code = 'EXACT'
                WHERE x.draw_id = d.id) AS max_risk_pct,
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
        WHERE d.game_id = $1 AND (d.draw_at AT TIME ZONE g.timezone)::date = $2::date AND d.sim_player_id IS NULL AND d.archived_at IS NULL
        ORDER BY d.draw_at`,
      [gameId, q.date ?? localDate()],
    );
    // Triple: el uso del tope es el del resultado más cargado (triple + terminal + última cifra), no el de un número suelto.
    const g = await this.db.one(`SELECT board FROM lottery.game WHERE id = $1`, [gameId]);
    if (g?.board === 'KINO') {
      // Kino: uso del tope = combinación más cargada.
      for (const d of rows) {
        const r = await this.db.one(
          `SELECT coalesce(max(x.w * 100 / l.max_liability_per_symbol), 0)::int AS pct FROM (
             SELECT t.currency, sum(p.potential_win) AS w FROM lottery.play p JOIN lottery.ticket t ON t.id = p.ticket_id
              WHERE p.draw_id = $1 AND p.status <> 'VOID' GROUP BY t.currency, p.modality_id, p.selection) x
             JOIN lottery.game_limit l ON l.game_id = $2 AND l.currency = x.currency`,
          [d.id, gameId],
        );
        d.max_risk_pct = r?.pct ?? 0;
      }
    }
    if (g?.board === 'DIGITS3' || g?.board === 'DIGITS2') {
      const limits = await this.db.query(`SELECT currency, max_liability_per_symbol::text AS cap FROM lottery.game_limit WHERE game_id = $1`, [gameId]);
      for (const d of rows) {
        let use = 0;
        for (const l of limits) {
          const ps = await this.db.query(
            `SELECT s.number, s.name, s.emoji, m.code, sum(p.amount)::text AS sold, sum(p.potential_win)::text AS payout
               FROM lottery.play p JOIN lottery.ticket t ON t.id = p.ticket_id JOIN lottery.symbol s ON s.id = p.symbol_id
               JOIN lottery.modality m ON m.id = p.modality_id
              WHERE p.draw_id = $1 AND t.currency = $2 AND p.status <> 'VOID' GROUP BY s.number, s.name, s.emoji, m.code`,
            [d.id, l.currency],
          );
          const worst = resultPayouts(ps, g.board).reduce((m, r) => (r.payout > m ? r.payout : m), 0n);
          use = Math.max(use, Number((worst * 100n) / BigInt(l.cap)));
        }
        d.max_risk_pct = use;
      }
    }
    return rows;
  }

  /** Panel de riesgo: ventas y pasivo potencial por animal (Doc. Maestro §9.7). */
  @Get('draws/:id/exposure')
  async exposure(@Param('id', ParseUUIDPipe) drawId: string) {
    const draw = await this.db.one(
      `SELECT d.id, d.status, d.draw_at, g.id AS game_id, g.board
         FROM lottery.draw d JOIN lottery.game g ON g.id = d.game_id WHERE d.id = $1`,
      [drawId],
    );
    if (draw?.board === 'KINO') {
      // Kino: las 100 combinaciones más cargadas por moneda.
      const rows = await this.db.query(
        `SELECT min(p.symbol_id::text)::uuid AS symbol_id, array_to_string(ARRAY(SELECT lpad(x::text, 2, '0') FROM unnest(p.selection) x), '-') AS number,
                m.name, NULL AS emoji, t.currency, sum(p.amount)::text AS staked, sum(p.potential_win)::text AS liability,
                l.max_liability_per_symbol::text AS cap
           FROM lottery.play p JOIN lottery.ticket t ON t.id = p.ticket_id JOIN lottery.modality m ON m.id = p.modality_id
           JOIN lottery.game_limit l ON l.game_id = $2 AND l.currency = t.currency
          WHERE p.draw_id = $1 AND p.status = 'OPEN'
          GROUP BY p.selection, m.name, t.currency, l.max_liability_per_symbol
          ORDER BY t.currency, sum(p.potential_win) DESC LIMIT 200`,
        [drawId, draw.game_id],
      );
      return { draw, rows };
    }
    if (draw?.board === 'DIGITS3' || draw?.board === 'DIGITS2') {
      // Triple: pasivo por resultado (triple + terminal + última cifra). Se listan los 100 números más cargados por moneda.
      const limits = await this.db.query(`SELECT currency, max_liability_per_symbol::text AS cap FROM lottery.game_limit WHERE game_id = $1`, [draw.game_id]);
      const rows = [];
      for (const l of limits) {
        const ps = await this.db.query(
          `SELECT s.number, s.name, s.emoji, m.code, sum(p.amount)::text AS sold, sum(p.potential_win)::text AS payout
             FROM lottery.play p JOIN lottery.ticket t ON t.id = p.ticket_id JOIN lottery.symbol s ON s.id = p.symbol_id
             JOIN lottery.modality m ON m.id = p.modality_id
            WHERE p.draw_id = $1 AND t.currency = $2 AND p.status = 'OPEN' GROUP BY s.number, s.name, s.emoji, m.code`,
          [drawId, l.currency],
        );
        const ids = new Map((await this.db.query(`SELECT id, number FROM lottery.symbol WHERE game_id = $1`, [draw.game_id])).map((s) => [s.number, s.id]));
        for (const r of resultPayouts(ps, draw.board).sort((a, b) => Number(b.payout - a.payout)).slice(0, 100)) {
          rows.push({ symbol_id: ids.get(r.number), number: r.number, name: r.name, emoji: null, currency: l.currency,
            staked: r.sold.toString(), liability: r.payout.toString(), cap: l.cap });
        }
      }
      return { draw, rows };
    }
    // Pasivo con el factor del animal exacto (única modalidad activa).
    const rows = await this.db.query(
      `SELECT s.id AS symbol_id, s.number, s.name, s.emoji, l.currency,
              coalesce(x.total_amount, 0)::text AS staked,
              (coalesce(x.total_amount, 0) * m.factor_x100 / 100)::text AS liability,
              l.max_liability_per_symbol::text AS cap
         FROM lottery.symbol s
         JOIN lottery.game g ON g.id = s.game_id
         JOIN lottery.modality m ON m.game_id = g.id AND m.code = 'EXACT'
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
    return this.lifecycle.proposeResult(id, dto.symbolId, dto.evidence, { id: u.id, ip }, dto.numbers);
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
    return this.lifecycle.createExtraordinaryDraw(gameId, dto.minutesFromNow, { id: u.id, ip }, dto.auto ?? false);
  }

  /** Acta e incidencias de un sorteo. */
  @Get('draws/:id/certification')
  async certification(@Param('id', ParseUUIDPipe) drawId: string) {
    const record = await this.db.one(
      `SELECT r.record_number, r.executor, r.inspector, r.notes, r.file_mime, r.file_sha256, r.created_at, u.email AS created_by_email
         FROM lottery.draw_record r JOIN identity.app_user u ON u.id = r.created_by WHERE r.draw_id = $1`,
      [drawId],
    );
    const incidents = await this.db.query(
      `SELECT i.id, i.kind, i.description, i.responsible, i.occurred_at, i.public_notice, i.resolution, i.resolved_at
         FROM lottery.draw_incident i WHERE i.draw_id = $1 ORDER BY i.occurred_at DESC`,
      [drawId],
    );
    return { record, incidents };
  }

  @Roles('LOTTERY_OPERATOR')
  @Post('draws/:id/record')
  @UseInterceptors(recordUpload)
  addRecord(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: DrawRecordDto,
    @UploadedFile() file: Express.Multer.File | undefined,
    @CurrentUser() u: AuthUser,
    @ClientIp() ip: string,
  ) {
    return this.lifecycle.addRecord(id, dto, file && { buffer: file.buffer, size: file.size }, { id: u.id, ip });
  }

  @Get('draws/:id/record/file')
  async recordFile(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: AuthUser, @ClientIp() ip: string, @Res() res: Response) {
    const { mime, content } = await this.lifecycle.recordFile(id, { id: u.id, ip });
    res.set({
      'content-type': mime,
      'cache-control': 'no-store',
      'content-disposition': 'inline',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; sandbox",
    });
    res.send(content);
  }

  @Roles('LOTTERY_OPERATOR')
  @Post('draws/:id/incidents')
  addIncident(@Param('id', ParseUUIDPipe) id: string, @Body() dto: DrawIncidentDto, @CurrentUser() u: AuthUser, @ClientIp() ip: string) {
    return this.lifecycle.addIncident(id, dto, { id: u.id, ip });
  }

  @Roles('LOTTERY_OPERATOR')
  @HttpCode(200)
  @Post('incidents/:id/resolve')
  resolveIncident(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ResolveIncidentDto, @CurrentUser() u: AuthUser, @ClientIp() ip: string) {
    return this.lifecycle.resolveIncident(id, dto.resolution, { id: u.id, ip });
  }

  @Get('tickets/:code')
  ticket(@Param('code') code: string) {
    return this.lottery.ticketByCode(code, {});
  }
}
