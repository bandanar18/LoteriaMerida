import { IsIn, IsOptional, IsString, Length, Matches } from 'class-validator';

export class CreateDepositDto {
  @IsIn(['PAGO_MOVIL', 'TRANSFER', 'USDT']) method: 'PAGO_MOVIL' | 'TRANSFER' | 'USDT';
  @Matches(/^\d{1,15}([.,]\d{1,6})?$/, { message: 'Monto inválido' }) amount: string;
  /** Banco origen (VES) o red (USDT). */
  @IsString() @Length(2, 60) bank: string;
  /** Referencia bancaria o hash de la transacción cripto. */
  @IsString() @Matches(/^[A-Za-z0-9]{4,100}$/, { message: 'Referencia inválida' }) reference: string;
  @IsOptional() @IsString() @Length(7, 20) payerPhone?: string;
  @IsOptional() @IsString() @Length(6, 20) payerDocument?: string;
}

export class CreateWithdrawalDto {
  @IsIn(['PAGO_MOVIL', 'TRANSFER', 'USDT']) method: 'PAGO_MOVIL' | 'TRANSFER' | 'USDT';
  @Matches(/^\d{1,15}([.,]\d{1,6})?$/, { message: 'Monto inválido' }) amount: string;
  /** Banco destino (VES) o red (USDT). */
  @IsString() @Length(2, 60) bank: string;
  /** Teléfono de Pago Móvil, número de cuenta o dirección de billetera. */
  @IsString() @Length(6, 100) account: string;
}

export class RejectDto {
  @IsString() @Length(3, 300) reason: string;
}

export class PayWithdrawalDto {
  @IsString() @Length(4, 100) paidReference: string;
}

export class StatusQueryDto {
  @IsOptional() @IsIn(['PENDING', 'APPROVED', 'REJECTED', 'REQUESTED', 'PAID']) status?: string;
}
