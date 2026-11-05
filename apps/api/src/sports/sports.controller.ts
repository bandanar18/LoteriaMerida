import { Body, Controller, Get, Headers, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { BusinessError } from '../common/errors';
import { AuthUser, ClientIp, CurrentUser, Public, Roles } from '../identity/auth.guard';
import {
  CreateEventDto,
  MarketInputDto,
  MarketStatusDto,
  PlaceBetDto,
  ProposeSportsResultDto,
  ReasonDto,
  ScoreDto,
  SportQueryDto,
  UpdateOddsDto,
} from './sports.dto';
import { SportsTradingService } from './sports-trading.service';
import { SportsService } from './sports.service';

@Controller('sports')
export class SportsController {
  constructor(private readonly sports: SportsService) {}

  @Public()
  @Get('catalog')
  catalog() {
    return this.sports.catalog();
  }

  @Public()
  @Get('events')
  events(@Query() q: SportQueryDto) {
    return this.sports.events(q.sport);
  }

  @Public()
  @Get('results')
  results(@Query() q: SportQueryDto) {
    return this.sports.results(q.sport);
  }

  @Roles('PLAYER')
  @Post('bets')
  place(@CurrentUser() u: AuthUser, @Body() dto: PlaceBetDto, @Headers('idempotency-key') key: string | undefined, @ClientIp() ip: string) {
    if (!key || !/^[A-Za-z0-9-]{8,80}$/.test(key)) throw new BusinessError('INVALID_INPUT', 'Falta el encabezado Idempotency-Key');
    return this.sports.placeBet(u.id, dto, key, ip);
  }

  @Roles('PLAYER')
  @Get('bets')
  myBets(@CurrentUser() u: AuthUser) {
    return this.sports.myBets(u.id);
  }
}

@Roles('SPORTS_TRADER', 'AUDITOR')
@Controller('admin/sports')
export class SportsAdminController {
  constructor(private readonly trading: SportsTradingService) {}

  @Get('events')
  events() {
    return this.trading.events();
  }

  @Get('bets')
  bets(@Query('eventId') eventId?: string) {
    return this.trading.bets(eventId && /^[0-9a-f-]{36}$/.test(eventId) ? eventId : undefined);
  }

  @Roles('SPORTS_TRADER')
  @Post('events')
  create(@Body() dto: CreateEventDto, @CurrentUser() u: AuthUser, @ClientIp() ip: string) {
    return this.trading.createEvent(dto, { id: u.id, ip });
  }

  @Roles('SPORTS_TRADER')
  @Post('events/:id/markets')
  addMarket(@Param('id', ParseUUIDPipe) id: string, @Body() dto: MarketInputDto, @CurrentUser() u: AuthUser, @ClientIp() ip: string) {
    return this.trading.addMarket(id, dto, { id: u.id, ip });
  }

  @Roles('SPORTS_TRADER')
  @HttpCode(200)
  @Post('markets/:id/odds')
  odds(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateOddsDto, @CurrentUser() u: AuthUser, @ClientIp() ip: string) {
    return this.trading.updateOdds(id, dto.odds, { id: u.id, ip });
  }

  @Roles('SPORTS_TRADER')
  @HttpCode(200)
  @Post('markets/:id/status')
  marketStatus(@Param('id', ParseUUIDPipe) id: string, @Body() dto: MarketStatusDto, @CurrentUser() u: AuthUser, @ClientIp() ip: string) {
    return this.trading.setMarketStatus(id, dto.status, { id: u.id, ip });
  }

  @Roles('SPORTS_TRADER')
  @HttpCode(200)
  @Post('markets/:id/void')
  voidMarket(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ReasonDto, @CurrentUser() u: AuthUser, @ClientIp() ip: string) {
    return this.trading.voidMarket(id, dto.reason, { id: u.id, ip });
  }

  @Roles('SPORTS_TRADER')
  @HttpCode(200)
  @Post('events/:id/markets-status')
  eventMarkets(@Param('id', ParseUUIDPipe) id: string, @Body() dto: MarketStatusDto, @CurrentUser() u: AuthUser, @ClientIp() ip: string) {
    return this.trading.setEventMarketsStatus(id, dto.status, { id: u.id, ip });
  }

  @Roles('SPORTS_TRADER')
  @HttpCode(200)
  @Post('events/:id/live')
  live(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: AuthUser, @ClientIp() ip: string) {
    return this.trading.startLive(id, { id: u.id, ip });
  }

  @Roles('SPORTS_TRADER')
  @HttpCode(200)
  @Post('events/:id/score')
  score(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ScoreDto, @CurrentUser() u: AuthUser, @ClientIp() ip: string) {
    return this.trading.updateScore(id, { home: dto.home, away: dto.away }, { id: u.id, ip });
  }

  @Roles('SPORTS_TRADER')
  @HttpCode(200)
  @Post('events/:id/propose-result')
  propose(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ProposeSportsResultDto, @CurrentUser() u: AuthUser, @ClientIp() ip: string) {
    return this.trading.proposeResult(id, { home: dto.home, away: dto.away }, dto.evidence, { id: u.id, ip });
  }

  @Roles('SPORTS_TRADER')
  @HttpCode(200)
  @Post('events/:id/confirm-result')
  confirm(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: AuthUser, @ClientIp() ip: string) {
    return this.trading.confirmResult(id, { id: u.id, ip });
  }

  @Roles('SPORTS_TRADER')
  @HttpCode(200)
  @Post('events/:id/reject-result')
  reject(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: AuthUser, @ClientIp() ip: string) {
    return this.trading.rejectResult(id, { id: u.id, ip });
  }

  @Roles('SPORTS_TRADER')
  @HttpCode(200)
  @Post('events/:id/cancel')
  cancel(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ReasonDto, @CurrentUser() u: AuthUser, @ClientIp() ip: string) {
    return this.trading.cancelEvent(id, dto.reason, { id: u.id, ip });
  }
}
