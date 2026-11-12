import { Body, Controller, Get, HttpCode, Post, Req, Res } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { DbService } from '../common/db.service';
import { config } from '../config';
import { LiteRegisterDto, LoginDto, RegisterDto, SelfExclusionDto } from './auth.dto';
import { AuthUser, ClientIp, CurrentUser, Public, Roles } from './auth.guard';
import { AuthService } from './auth.service';

const REFRESH_COOKIE = 'rt';

function setRefreshCookie(res: Response, token: string) {
  res.cookie(REFRESH_COOKIE, token, {
    httpOnly: true,
    sameSite: 'strict',
    secure: process.env.NODE_ENV === 'production',
    path: '/api/v1/auth',
    maxAge: config.refreshTokenTtlDays * 86_400_000,
  });
}

function meta(req: Request) {
  return { ip: req.ip, userAgent: req.headers['user-agent'] };
}

@Controller()
export class AuthController {
  constructor(private readonly auth: AuthService, private readonly db: DbService) {}

  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('auth/register')
  async register(@Body() dto: RegisterDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const { refreshToken, ...rest } = await this.auth.register(dto, meta(req));
    setRefreshCookie(res, refreshToken);
    return rest;
  }

  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('auth/register-lite')
  async registerLite(@Body() dto: LiteRegisterDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const { refreshToken, ...rest } = await this.auth.registerLite(dto, meta(req));
    setRefreshCookie(res, refreshToken);
    return rest;
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @HttpCode(200)
  @Post('auth/login')
  async login(@Body() dto: LoginDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const { refreshToken, ...rest } = await this.auth.login(dto.email, dto.password, meta(req));
    setRefreshCookie(res, refreshToken);
    return rest;
  }

  @Public()
  @HttpCode(200)
  @Post('auth/refresh')
  async refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const { refreshToken, ...rest } = await this.auth.refresh(req.cookies?.[REFRESH_COOKIE], meta(req));
    setRefreshCookie(res, refreshToken);
    return rest;
  }

  @Public()
  @HttpCode(204)
  @Post('auth/logout')
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    await this.auth.logout(req.cookies?.[REFRESH_COOKIE]);
    res.clearCookie(REFRESH_COOKIE, { path: '/api/v1/auth' });
  }

  @Get('me')
  me(@CurrentUser() user: AuthUser) {
    return this.auth.me(user.id);
  }

  @Roles('PLAYER')
  @HttpCode(200)
  @Post('me/self-exclusion')
  selfExclude(@CurrentUser() user: AuthUser, @Body() dto: SelfExclusionDto, @ClientIp() ip: string) {
    return this.auth.selfExclude(user.id, dto.days, ip);
  }

  @Public()
  @Get('platform')
  async platform() {
    const settings = await this.db.one<{ trading_enabled: boolean }>('SELECT trading_enabled FROM futures.settings WHERE id');
    return {
      licenseLabel: config.licenseLabel,
      timezone: 'America/Caracas',
      futuresEnabled: settings?.trading_enabled === true,
      // Bono de bienvenida DEMO (unidades mínimas): el invitado lo ve como saldo antes de registrarse.
      signupBonus: { VES: config.signupBonus.VES.toString(), USDT: config.signupBonus.USDT.toString() },
    };
  }
}
