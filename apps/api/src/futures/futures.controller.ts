import { Body, Controller, Delete, Get, Headers, HttpCode, Param, ParseUUIDPipe, Post, Put, Query, UseGuards } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { Type } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, Matches, Max, Min } from 'class-validator';
import { DbService } from '../common/db.service';
import { BusinessError } from '../common/errors';
import { AuthUser, CurrentUser, Public, Roles } from '../identity/auth.guard';
import { FuturesAvailabilityGuard } from './futures-availability.guard';
import { FuturesService } from './futures.service';

const DEC = /^\d{1,12}(\.\d{1,8})?$/;
const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'];

export class FuturesOrderDto {
  @IsIn(SYMBOLS) symbol: string;
  @IsIn(['BUY', 'SELL']) side: 'BUY' | 'SELL';
  @IsIn(['MARKET', 'LIMIT', 'STOP_MARKET']) type: 'MARKET' | 'LIMIT' | 'STOP_MARKET';
  @Matches(DEC, { message: 'Cantidad inválida' }) qty: string;
  @IsOptional() @Matches(DEC, { message: 'Precio inválido' }) price?: string;
  @IsOptional() @Matches(DEC, { message: 'Precio de activación inválido' }) stopPrice?: string;
  @IsOptional() @IsIn(['GTC', 'IOC', 'FOK']) timeInForce?: 'GTC' | 'IOC' | 'FOK';
  @IsOptional() @IsBoolean() reduceOnly?: boolean;
  @IsOptional() @IsBoolean() postOnly?: boolean;
}

export class FuturesPrefsDto {
  @Type(() => Number) @IsInt() @Min(1) @Max(125) leverage: number;
  @IsIn(['ISOLATED', 'CROSS']) marginMode: 'ISOLATED' | 'CROSS';
}

export class FuturesTransferDto {
  @IsIn(['IN', 'OUT']) direction: 'IN' | 'OUT';
  @Matches(/^\d{1,12}(\.\d{1,6})?$/, { message: 'Monto inválido' }) amount: string;
}

export class FuturesCloseDto {
  @IsOptional() @Matches(DEC, { message: 'Cantidad inválida' }) qty?: string;
}

export class FuturesTpSlDto {
  @IsOptional() @IsString() tp?: string | null;
  @IsOptional() @IsString() sl?: string | null;
}

export class FuturesMarginDto {
  @IsIn(['ADD', 'REMOVE']) action: 'ADD' | 'REMOVE';
  @Matches(/^\d{1,12}(\.\d{1,6})?$/, { message: 'Monto inválido' }) amount: string;
}

export class FuturesSettingsDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(125) maxLeverage?: number | null;
  @IsOptional() @IsString() dailyLossLimit?: string | null;
  @IsOptional() @IsString() dailyTransferLimit?: string | null;
}

@Controller('futures')
@UseGuards(FuturesAvailabilityGuard)
export class FuturesController {
  constructor(
    private readonly futures: FuturesService,
    private readonly db: DbService,
  ) {}

  /** Contratos con precio índice/marca, variación 24 h, funding y estado. */
  @Public()
  @SkipThrottle()
  @Get('contracts')
  contracts() {
    return this.futures.contractsView();
  }

  @Public()
  @SkipThrottle()
  @Get('candles')
  candles(@Query('symbol') symbol: string, @Query('interval') interval = '1m', @Query('limit') limit = '120') {
    if (!SYMBOLS.includes(symbol)) throw new BusinessError('INVALID_INPUT', 'Contrato inválido');
    return this.futures.candles(symbol, interval, Number(limit) || 120);
  }

  @Roles('PLAYER')
  @SkipThrottle()
  @Get('account')
  account(@CurrentUser() u: AuthUser) {
    return this.futures.account(u.id);
  }

  @Roles('PLAYER')
  @SkipThrottle()
  @Get('orders')
  orders(@CurrentUser() u: AuthUser, @Query('status') status = 'open') {
    return this.db.query(
      `SELECT id, symbol, side, type, qty::text, price::text, stop_price::text, time_in_force, reduce_only, post_only, leverage, margin_mode,
              status, reject_reason, created_at, updated_at
         FROM futures.order WHERE player_id = $1 AND ($2 = 'all' OR status = 'NEW') ORDER BY created_at DESC LIMIT 100`,
      [u.id, status],
    );
  }

  @Roles('PLAYER')
  @SkipThrottle()
  @Get('fills')
  fills(@CurrentUser() u: AuthUser) {
    return this.db.query(
      `SELECT f.id::text, f.symbol, f.side, f.qty::text, f.price::text, f.notional::text, f.fee::text, f.liquidity, f.realized_pnl::text,
              o.type, f.created_at
         FROM futures.fill f JOIN futures.order o ON o.id = f.order_id WHERE f.player_id = $1 ORDER BY f.id DESC LIMIT 100`,
      [u.id],
    );
  }

  @Roles('PLAYER')
  @SkipThrottle()
  @Get('funding')
  funding(@CurrentUser() u: AuthUser) {
    return this.db.query(
      `SELECT id::text, symbol, funding_time, rate::text, notional::text, amount::text FROM futures.funding_payment
        WHERE player_id = $1 ORDER BY funding_time DESC LIMIT 100`,
      [u.id],
    );
  }

  @Roles('PLAYER')
  @SkipThrottle()
  @Get('positions/history')
  async history(@CurrentUser() u: AuthUser) {
    const rows = await this.db.query(`SELECT * FROM futures.position WHERE player_id = $1 AND status <> 'OPEN' ORDER BY closed_at DESC LIMIT 50`, [u.id]);
    return Promise.all(rows.map((p) => this.futures.positionView(p)));
  }

  @Roles('PLAYER')
  @Post('orders')
  placeOrder(@CurrentUser() u: AuthUser, @Body() dto: FuturesOrderDto, @Headers('idempotency-key') key?: string) {
    if (!key || key.length < 8 || key.length > 100) throw new BusinessError('INVALID_INPUT', 'Falta la cabecera Idempotency-Key');
    return this.futures.placeOrder(u.id, dto, key);
  }

  @Roles('PLAYER')
  @Delete('orders/:id')
  cancel(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.futures.cancelOrder(u.id, id);
  }

  @Roles('PLAYER')
  @HttpCode(200)
  @Post('positions/:id/close')
  close(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: FuturesCloseDto) {
    return this.futures.closePosition(u.id, id, dto.qty);
  }

  @Roles('PLAYER')
  @Put('positions/:id/tpsl')
  tpsl(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: FuturesTpSlDto) {
    return this.futures.setTpSl(u.id, id, dto.tp ?? null, dto.sl ?? null);
  }

  @Roles('PLAYER')
  @HttpCode(200)
  @Post('positions/:id/margin')
  margin(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: FuturesMarginDto) {
    return this.futures.adjustMargin(u.id, id, dto.amount, dto.action);
  }

  @Roles('PLAYER')
  @Put('prefs/:symbol')
  prefs(@CurrentUser() u: AuthUser, @Param('symbol') symbol: string, @Body() dto: FuturesPrefsDto) {
    if (!SYMBOLS.includes(symbol)) throw new BusinessError('INVALID_INPUT', 'Contrato inválido');
    return this.futures.setPrefs(u.id, symbol, dto.leverage, dto.marginMode);
  }

  @Roles('PLAYER')
  @HttpCode(200)
  @Post('transfer')
  transfer(@CurrentUser() u: AuthUser, @Body() dto: FuturesTransferDto) {
    return this.futures.transfer(u.id, dto.direction, dto.amount);
  }

  @Roles('PLAYER')
  @HttpCode(200)
  @Post('risk/accept')
  accept(@CurrentUser() u: AuthUser) {
    return this.futures.acceptRisk(u.id);
  }

  @Roles('PLAYER')
  @Put('settings')
  settings(@CurrentUser() u: AuthUser, @Body() dto: FuturesSettingsDto) {
    return this.futures.updateSettings(u.id, dto);
  }
}
