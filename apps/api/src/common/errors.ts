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
  | 'POST_ONLY_REJECTED'
  | 'AGENT_NOT_FOUND'
  | 'AGENT_SUSPENDED'
  | 'AGENT_ALREADY_EXISTS'
  | 'CODE_ROTATION_TOO_SOON'
  | 'RATE_UNSAFE'
  | 'FX_RATE_UNAVAILABLE'
  | 'FX_RATE_JUMP'
  | 'MIN_AMOUNT'
  | 'PAYOUT_ACCOUNT_REQUIRED'
  | 'PAYOUT_ACCOUNT_INVALID'
  | 'PAYOUT_ACCOUNT_LIMIT'
  | 'PAYOUT_FAMILY_LIMIT'
  | 'PAYOUT_ACCOUNT_DUPLICATE'
  | 'PAYOUT_HOLDER_MISMATCH'
  | 'PAYOUT_HOLDER_IS_REFERRAL'
  | 'PAYOUT_ACCOUNT_IN_USE'
  | 'SMS_CODE_INVALID'
  | 'SMS_CODE_EXPIRED'
  | 'SMS_TOO_MANY_ATTEMPTS'
  | 'SMS_RATE_LIMITED'
  | 'SMS_UNAVAILABLE';

const STATUS: Partial<Record<BusinessCode, HttpStatus>> = {
  KYC_REQUIRED: HttpStatus.FORBIDDEN,
  RISK_NOT_ACCEPTED: HttpStatus.FORBIDDEN,
  NOT_FOUND: HttpStatus.NOT_FOUND,
  AGENT_NOT_FOUND: HttpStatus.NOT_FOUND,
  AGENT_SUSPENDED: HttpStatus.FORBIDDEN,
  AGENT_ALREADY_EXISTS: HttpStatus.CONFLICT,
  PAYOUT_ACCOUNT_DUPLICATE: HttpStatus.CONFLICT,
  SMS_RATE_LIMITED: HttpStatus.TOO_MANY_REQUESTS,
  SMS_TOO_MANY_ATTEMPTS: HttpStatus.TOO_MANY_REQUESTS,
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
