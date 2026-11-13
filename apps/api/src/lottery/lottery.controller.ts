import { Body, Controller, Get, Headers, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { BusinessError } from '../common/errors';
import { AuthUser, ClientIp, CurrentUser, Public, Roles } from '../identity/auth.guard';
import { BuyTicketDto, DrawsQueryDto } from './lottery.dto';
import { LotteryService } from './lottery.service';

@Controller('lottery')
export class LotteryController {
  constructor(private readonly lottery: LotteryService) {}

  @Public()
  @Get('games')
  games() {
    return this.lottery.listGames();
  }

  @Public()
  @Get('games/:id/symbols')
  symbols(@Param('id', ParseUUIDPipe) id: string) {
    return this.lottery.gameSymbols(id);
  }

  @Public()
  @Get('games/:id/draws')
  draws(@Param('id', ParseUUIDPipe) id: string, @Query() q: DrawsQueryDto) {
    return this.lottery.listDraws(id, q.date, q.to);
  }

  @Public()
  @Get('draws/:id/availability')
  availability(@Param('id', ParseUUIDPipe) id: string, @Query('currency') currency?: string) {
    if (currency !== 'VES' && currency !== 'USDT') throw new BusinessError('INVALID_INPUT', 'Moneda inválida');
    return this.lottery.drawAvailability(id, currency);
  }

  @Public()
  @Get('draws/:id/verify')
  verify(@Param('id', ParseUUIDPipe) id: string) {
    return this.lottery.verifyDraw(id);
  }

  @Roles('PLAYER')
  @Post('tickets')
  buy(
    @CurrentUser() user: AuthUser,
    @Body() dto: BuyTicketDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @ClientIp() ip: string,
  ) {
    if (!idempotencyKey || !/^[\w-]{8,100}$/.test(idempotencyKey)) {
      throw new BusinessError('INVALID_INPUT', 'Falta el encabezado Idempotency-Key');
    }
    return this.lottery.buyTicket(user.id, dto, idempotencyKey, ip);
  }

  @Roles('PLAYER')
  @Get('tickets')
  myTickets(@CurrentUser() user: AuthUser) {
    return this.lottery.myTickets(user.id);
  }

  @Roles('PLAYER')
  @Get('tickets/:code')
  ticket(@CurrentUser() user: AuthUser, @Param('code') code: string) {
    return this.lottery.ticketByCode(code, { playerId: user.id });
  }

  @Roles('PLAYER')
  @HttpCode(200)
  @Post('tickets/:id/cancel')
  cancel(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @ClientIp() ip: string) {
    return this.lottery.cancelTicket(user.id, id, ip);
  }
}
