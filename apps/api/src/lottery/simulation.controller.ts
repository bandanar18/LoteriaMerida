import { Body, Controller, Get, Headers, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { IsIn, Matches } from 'class-validator';
import { BusinessError } from '../common/errors';
import { AuthUser, CurrentUser, Public, Roles } from '../identity/auth.guard';
import { SimulationService } from './simulation.service';

export class SimTopupDto {
  @IsIn(['VES', 'USDT']) currency: 'VES' | 'USDT';
  @Matches(/^\d{1,15}([.,]\d{1,6})?$/, { message: 'Monto inválido' }) amount: string;
}

@Controller('simulation')
export class SimulationController {
  constructor(private readonly sim: SimulationService) {}

  @Public()
  @Get('status')
  status() {
    return this.sim.status();
  }

  @Roles('PLAYER')
  @Post('topup')
  topup(@CurrentUser() user: AuthUser, @Body() dto: SimTopupDto, @Headers('idempotency-key') key: string | undefined) {
    if (!key || !/^[\w-]{8,100}$/.test(key)) throw new BusinessError('INVALID_INPUT', 'Falta el encabezado Idempotency-Key');
    return this.sim.topup(user.id, dto.currency, dto.amount, key);
  }

  @Roles('PLAYER')
  @HttpCode(200)
  @Post('games/:id/draw')
  draw(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) gameId: string) {
    return this.sim.currentDraw(user.id, gameId);
  }

  @Roles('PLAYER')
  @HttpCode(200)
  @Post('draws/:id/run')
  run(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) drawId: string) {
    return this.sim.run(user.id, drawId);
  }
}
