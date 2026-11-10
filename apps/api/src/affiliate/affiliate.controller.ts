import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { DbService } from '../common/db.service';
import { AuthUser, ClientIp, CurrentUser, Public, Roles } from '../identity/auth.guard';
import { AffiliateService } from './affiliate.service';
import {
  ActivateAgentDto,
  AgentStatusDto,
  AgentWithdrawDto,
  PayoutChallengeDto,
  PayoutConfirmDto,
  PayoutPatchDto,
  SetFxRateDto,
  SetRateDto,
  TransferToPlayerDto,
} from './affiliate.dto';
import { AgentService } from './agent.service';
import { PayoutService } from './payout.service';

/** Público: validar un código de afiliado (pantalla de registro y ruta /r/:code). */
@Controller('affiliate')
export class AffiliatePublicController {
  constructor(
    private readonly db: DbService,
    private readonly affiliate: AffiliateService,
    private readonly payouts: PayoutService,
  ) {}

  @Public()
  @Get('banks')
  banks() {
    return this.payouts.banks();
  }

  @Public()
  @Get('fx/today')
  fxToday() {
    return this.payouts.todayRatePublic();
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Get('codes/:code')
  lookup(@Param('code') code: string) {
    return this.affiliate.lookupCode(this.db.pool, code);
  }
}

/** Wallet de la agencia. Cualquier jugador puede activar su agencia. */
@Roles('PLAYER')
@Controller('agent')
export class AgentController {
  constructor(
    private readonly agents: AgentService,
    private readonly payouts: PayoutService,
  ) {}

  @Post()
  activate(@CurrentUser() user: AuthUser, @Body() dto: ActivateAgentDto, @ClientIp() ip: string) {
    return this.agents.activate(user.id, dto.displayName, ip);
  }

  @Get('me')
  me(@CurrentUser() user: AuthUser) {
    return this.agents.me(user.id);
  }

  @Get('summary')
  summary(@CurrentUser() user: AuthUser) {
    return this.agents.summary(user.id);
  }

  @Get('commissions')
  commissions(@CurrentUser() user: AuthUser, @Query('limit') limit?: string, @Query('cursor') cursor?: string) {
    return this.agents.commissions(user.id, Number(limit) || 30, cursor);
  }

  @Get('referrals')
  referrals(@CurrentUser() user: AuthUser) {
    return this.agents.referrals(user.id);
  }

  @Get('movements')
  movements(@CurrentUser() user: AuthUser, @Query('limit') limit?: string) {
    return this.agents.movements(user.id, Number(limit) || 50);
  }

  @HttpCode(200)
  @Post('code/rotate')
  rotate(@CurrentUser() user: AuthUser, @ClientIp() ip: string) {
    return this.agents.rotateCode(user.id, ip);
  }

  @HttpCode(200)
  @Post('transfer-to-player')
  transfer(@CurrentUser() user: AuthUser, @Body() dto: TransferToPlayerDto, @ClientIp() ip: string) {
    return this.agents.transferToPlayer(user.id, dto.currency, dto.amount, dto.idempotencyKey, ip);
  }

  // ── Directorio de Pago Móvil (confirmación por SMS) ──

  @Get('payout-accounts')
  payoutAccounts(@CurrentUser() user: AuthUser) {
    return this.payouts.listAccounts(user.id);
  }

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @HttpCode(200)
  @Post('payout-accounts/challenge')
  payoutChallenge(@CurrentUser() user: AuthUser, @Body() dto: PayoutChallengeDto, @ClientIp() ip: string) {
    const { id, ...input } = dto;
    return this.payouts.challenge(user.id, input, id, ip);
  }

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('payout-accounts/confirm')
  payoutConfirm(@CurrentUser() user: AuthUser, @Body() dto: PayoutConfirmDto, @ClientIp() ip: string) {
    return this.payouts.confirm(user.id, dto.challengeId, dto.code, ip);
  }

  @Patch('payout-accounts/:id')
  payoutPatch(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: PayoutPatchDto) {
    return this.payouts.patch(user.id, id, dto.alias, dto.isDefault);
  }

  @Delete('payout-accounts/:id')
  payoutDelete(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @ClientIp() ip: string) {
    return this.payouts.remove(user.id, id, ip);
  }

  // ── Retiros: siempre en Bs por Pago Móvil ──

  @Get('withdrawals/quote')
  quote(@Query('sourceCurrency') sourceCurrency: string, @Query('amount') amount: string) {
    return this.payouts.quote(sourceCurrency === 'USDT' ? 'USDT' : 'VES', amount ?? '');
  }

  @Post('withdrawals')
  withdraw(@CurrentUser() user: AuthUser, @Body() dto: AgentWithdrawDto, @ClientIp() ip: string) {
    return this.payouts.withdraw(user.id, dto.sourceCurrency, dto.amount, dto.payoutAccountId, dto.idempotencyKey, ip);
  }

  @Get('withdrawals')
  withdrawals(@CurrentUser() user: AuthUser) {
    return this.payouts.myWithdrawals(user.id);
  }
}

/** Backoffice de agencias. Lectura: auditor y cumplimiento; cambios: solo ADMIN. */
@Roles('AUDITOR', 'COMPLIANCE')
@Controller('admin/agents')
export class AgentAdminController {
  constructor(
    private readonly agents: AgentService,
    private readonly payouts: PayoutService,
  ) {}

  @Get('fx-rates')
  fxRates() {
    return this.payouts.rateHistory();
  }

  @Roles('ADMIN')
  @Post('fx-rates')
  setFxRate(@Body() dto: SetFxRateDto, @CurrentUser() user: AuthUser, @ClientIp() ip: string) {
    return this.payouts.setRate(dto.rate, dto.confirmLargeChange === true, user.id, ip);
  }

  @Get()
  list(@Query('status') status?: string, @Query('q') q?: string) {
    return this.agents.adminList(status, q);
  }

  @Get('rates')
  rates() {
    return this.agents.rates();
  }

  @Get('report')
  report(@Query('from') from?: string, @Query('to') to?: string) {
    return this.agents.report(from, to);
  }

  @Get(':id')
  detail(@Param('id', ParseUUIDPipe) id: string) {
    return this.agents.adminDetail(id);
  }

  @Roles('ADMIN')
  @HttpCode(200)
  @Post(':id/suspend')
  suspend(@Param('id', ParseUUIDPipe) id: string, @Body() dto: AgentStatusDto, @CurrentUser() user: AuthUser, @ClientIp() ip: string) {
    return this.agents.setStatus(id, 'SUSPENDED', dto.reason, user.id, ip);
  }

  @Roles('ADMIN')
  @HttpCode(200)
  @Post(':id/reactivate')
  reactivate(@Param('id', ParseUUIDPipe) id: string, @Body() dto: AgentStatusDto, @CurrentUser() user: AuthUser, @ClientIp() ip: string) {
    return this.agents.setStatus(id, 'ACTIVE', dto.reason, user.id, ip);
  }

  @Roles('ADMIN')
  @Post('rates')
  setRate(@Body() dto: SetRateDto, @CurrentUser() user: AuthUser, @ClientIp() ip: string) {
    return this.agents.setRate(dto.gameId ?? null, dto.rateBps, dto.reason, user.id, ip);
  }
}
