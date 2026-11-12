import { IsDateString, IsEmail, IsIn, IsOptional, IsString, Length, Matches, MaxLength, Equals } from 'class-validator';

export class RegisterDto {
  @IsString() @Length(1, 60) firstName: string;
  @IsString() @Length(1, 60) lastName: string;
  @IsIn(['V', 'E', 'P']) documentType: 'V' | 'E' | 'P';
  @IsString() @Length(6, 20) documentNumber: string;
  @IsDateString({ strict: true }) birthDate: string;
  @IsString() @Length(7, 20) phone: string;
  @IsEmail() @MaxLength(120) email: string;
  @IsString()
  @Length(10, 128)
  @Matches(/(?=.*[a-zA-Z])(?=.*\d)/, { message: 'La contraseña debe tener letras y números' })
  password: string;
  @IsOptional() @IsString() @MaxLength(60) state?: string;
  @IsOptional() @IsString() @MaxLength(60) city?: string;
  @IsIn(['VES', 'USDT']) currency: 'VES' | 'USDT';
  /** Acepta que es una aplicación DEMO, sin valor real y sin comercialización. */
  @Equals(true, { message: 'Debes aceptar que es una aplicación DEMO sin valor real y que no se permite su comercialización' })
  acceptDemoTerms: boolean;
  /** Código de agencia (opcional). Un código inválido no impide el registro. */
  @IsOptional() @IsString() @MaxLength(20) referralCode?: string;
}

/**
 * Registro lite (DEMO): quien llega por el QR de una agencia arma su jugada y luego se registra
 * solo con nombre, correo, teléfono y contraseña. Documento y nacimiento se completan antes de retirar.
 */
export class LiteRegisterDto {
  /** Nombre y apellido en un solo campo. */
  @IsString() @Length(2, 120) fullName: string;
  @IsString() @Length(7, 20) phone: string;
  @IsEmail() @MaxLength(120) email: string;
  @IsString()
  @Length(10, 128)
  @Matches(/(?=.*[a-zA-Z])(?=.*\d)/, { message: 'La contraseña debe tener letras y números' })
  password: string;
  @IsOptional() @IsIn(['VES', 'USDT']) currency?: 'VES' | 'USDT';
  /** Declara ser mayor de edad y acepta que es una aplicación DEMO sin valor real. */
  @Equals(true, { message: 'Debes declarar que eres mayor de edad y aceptar que es una aplicación DEMO' })
  acceptTerms: boolean;
  @IsOptional() @IsString() @MaxLength(20) referralCode?: string;
}

export class LoginDto {
  @IsEmail() email: string;
  @IsString() @Length(1, 128) password: string;
}

export class SelfExclusionDto {
  @IsIn([1, 7, 30, 180, 365]) days: number;
}
