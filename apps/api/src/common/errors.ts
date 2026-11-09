import { HttpException, HttpStatus } from '@nestjs/common';

/** Códigos de negocio estables (Doc. Maestro §18.1). */
export type BusinessCode =
  | 'INSUFFICIENT_FUNDS'
  | 'LIMIT_EXCEEDED'
  | 'DRAW_CLOSED'
  | 'SELF_EXCLUDED'
  | 'ACCOUNT_BLOCKED'
  | 'INVALID_INPUT'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'UNDERAGE'
  | 'INVALID_CREDENTIALS'
  | 'INVALID_STATE'
  | 'FOUR_EYES_REQUIRED'
  | 'CANCEL_WINDOW_EXPIRED'
  | 'DUPLICATE_REFERENCE'
  | 'KYC_REQUIRED'
  | 'ODDS_CHANGED'
  | 'MARKET_SUSPENDED'
  | 'MODALITY_NOT_ACTIVE'
  | 'RECORD_REQUIRED'
  | 'RISK_NOT_ACCEPTED'
  | 'MARKET_CLOSED'
  | 'POST_ONLY_REJECTED';

const STATUS: Partial<Record<BusinessCode, HttpStatus>> = {
  KYC_REQUIRED: HttpStatus.FORBIDDEN,
  RISK_NOT_ACCEPTED: HttpStatus.FORBIDDEN,
  NOT_FOUND: HttpStatus.NOT_FOUND,
  INVALID_CREDENTIALS: HttpStatus.UNAUTHORIZED,
  ACCOUNT_BLOCKED: HttpStatus.FORBIDDEN,
  SELF_EXCLUDED: HttpStatus.FORBIDDEN,
  CONFLICT: HttpStatus.CONFLICT,
  DUPLICATE_REFERENCE: HttpStatus.CONFLICT,
};

export class BusinessError extends HttpException {
  constructor(
    readonly code: BusinessCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super({ code, message, details }, STATUS[code] ?? HttpStatus.UNPROCESSABLE_ENTITY);
  }
}

/** Errores de constraint de Postgres que tienen significado de negocio. */
export function pgErrorCode(err: unknown): string | undefined {
  return typeof err === 'object' && err !== null && 'code' in err ? String((err as { code: unknown }).code) : undefined;
}
