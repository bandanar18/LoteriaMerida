import { CanActivate, createParamDecorator, ExecutionContext, Injectable, SetMetadata, UnauthorizedException, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import type { Request } from 'express';

export type Role = 'PLAYER' | 'ADMIN' | 'CASHIER' | 'LOTTERY_OPERATOR' | 'AUDITOR' | 'COMPLIANCE' | 'SPORTS_TRADER';

export interface AuthUser {
  id: string;
  role: Role;
  kind: 'PLAYER' | 'STAFF';
}

const IS_PUBLIC = 'isPublic';
const ROLES = 'roles';

/** Endpoint accesible sin sesión. */
export const Public = () => SetMetadata(IS_PUBLIC, true);
/** Restringe a ciertos roles (ADMIN siempre pasa). */
export const Roles = (...roles: Role[]) => SetMetadata(ROLES, roles);

export const CurrentUser = createParamDecorator((_: unknown, ctx: ExecutionContext): AuthUser => {
  return ctx.switchToHttp().getRequest().user;
});

export const ClientIp = createParamDecorator((_: unknown, ctx: ExecutionContext): string => {
  const req: Request = ctx.switchToHttp().getRequest();
  return req.ip ?? '';
});

/** Guard global: valida el JWT de acceso y los roles requeridos. */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const targets = [ctx.getHandler(), ctx.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) return true;

    const req = ctx.switchToHttp().getRequest<Request & { user?: AuthUser }>();
    const header = req.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) throw new UnauthorizedException({ code: 'UNAUTHENTICATED', message: 'Sesión requerida' });
    try {
      const payload = await this.jwt.verifyAsync<{ sub: string; role: Role; kind: AuthUser['kind'] }>(token);
      req.user = { id: payload.sub, role: payload.role, kind: payload.kind };
    } catch {
      throw new UnauthorizedException({ code: 'UNAUTHENTICATED', message: 'Sesión expirada o inválida' });
    }

    const roles = this.reflector.getAllAndOverride<Role[] | undefined>(ROLES, targets);
    if (roles && req.user.role !== 'ADMIN' && !roles.includes(req.user.role)) {
      throw new ForbiddenException({ code: 'FORBIDDEN', message: 'No tienes permiso para esta acción' });
    }
    return true;
  }
}
