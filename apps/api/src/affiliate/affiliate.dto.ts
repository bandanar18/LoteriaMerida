import { Equals, IsBoolean, IsIn, IsInt, IsOptional, IsString, IsUUID, Length, Matches, Max, Min } from 'class-validator';

export class ActivateAgentDto {
  @IsString() @Length(3, 40) displayName: string;
  /** Acepta los Términos del Programa de Agencias (versión vigente). */
  @Equals(true, { message: 'Debes aceptar los Términos del Programa de Agencias' }) acceptTerms: boolean;
}

export class TransferToPlayerDto {
  @IsIn(['VES', 'USDT']) currency: 'VES' | 'USDT';
  @Matches(/^\d{1,15}([.,]\d{1,6})?$/, { message: 'Monto inválido' }) amount: string;
  @IsString() @Length(8, 80) idempotencyKey: string;
}

export class AgentStatusDto {
  @IsString() @Length(5, 300) reason: string;
}

export class SetRateDto {
  @IsOptional() @IsUUID() gameId?: string;
  @IsInt() @Min(0) @Max(2000) rateBps: number;
  @IsString() @Length(5, 300) reason: string;
}

// ───────────── Fase 3: Directorio de Pago Móvil, retiros en Bs y tasa BCV ─────────────

const RELATIONSHIPS = ['PADRE_MADRE', 'HIJO', 'HERMANO', 'CONYUGE', 'ABUELO', 'NIETO', 'TIO', 'SOBRINO', 'PRIMO', 'SUEGRO', 'CUNADO'] as const;

export class PayoutChallengeDto {
  /** Si viene, es una edición de esa cuenta. */
  @IsOptional() @IsUUID() id?: string;
  @IsString() @Length(1, 30) alias: string;
  @IsIn(['SELF', 'FAMILY']) holderKind: 'SELF' | 'FAMILY';
  @IsOptional() @IsIn(RELATIONSHIPS) relationship?: (typeof RELATIONSHIPS)[number];
  @IsOptional() @IsString() @Length(3, 80) holderName?: string;
  @IsOptional() @IsIn(['V', 'E']) documentType?: 'V' | 'E';
  @IsOptional() @IsString() @Length(6, 12) documentNumber?: string;
  @Matches(/^\d{4}$/, { message: 'Banco inválido' }) bankCode: string;
  @IsString() @Length(7, 20) phone: string;
  @IsOptional() @IsBoolean() isDefault?: boolean;
}

export class PayoutConfirmDto {
  @IsUUID() challengeId: string;
  @Matches(/^\d{6}$/, { message: 'El código tiene 6 dígitos' }) code: string;
}

export class PayoutPatchDto {
  @IsOptional() @IsString() @Length(1, 30) alias?: string;
  @IsOptional() @IsBoolean() isDefault?: boolean;
}

export class AgentWithdrawDto {
  @IsIn(['VES', 'USDT']) sourceCurrency: 'VES' | 'USDT';
  @Matches(/^\d{1,15}([.,]\d{1,6})?$/, { message: 'Monto inválido' }) amount: string;
  @IsUUID() payoutAccountId: string;
  @IsString() @Length(8, 80) idempotencyKey: string;
}

export class SetFxRateDto {
  @Matches(/^\d{1,9}([.,]\d{1,4})?$/, { message: 'Tasa inválida (hasta 4 decimales)' }) rate: string;
  @IsOptional() @IsBoolean() confirmLargeChange?: boolean;
}
