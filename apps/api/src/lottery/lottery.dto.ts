import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { MAX_PLAYS_PER_TICKET, ModalityCode } from '@loteria/domain';

export class PlayDto {
  @IsUUID() drawId: string;
  // Kino: no lleva símbolo, lleva los números elegidos.
  @ValidateIf((p) => !p.numbers) @IsUUID() symbolId?: string;
  @IsOptional() @IsArray() @ArrayMinSize(1) @ArrayMaxSize(20) @IsInt({ each: true }) @Min(1, { each: true }) @Max(99, { each: true }) numbers?: number[];
  @Matches(/^\d{1,15}([.,]\d{1,6})?$/, { message: 'Monto inválido' }) amount: string;
  /** Andes 5 Estrella: estrella elegida en las modalidades con estrella. */
  @IsOptional() @IsInt() @Min(1) @Max(9) star?: number;
  @IsOptional() @IsIn(['EXACT', 'COMBINADA', 'MULTIPLE', 'TERMINAL', 'LAST_DIGIT', 'FULL', 'KINO5', 'KINO6', 'KINO7', 'APPROX', 'SUPER', 'DUAL', 'NUMBER', 'COLOR', 'PAIR', 'MATCH5', 'MATCH4', 'MATCH3', 'REVERSED', 'PARITY', 'BOX', 'MATCH5S', 'MATCH4S', 'MATCH3S']) modality?: ModalityCode;
}

export class BuyTicketDto {
  @IsUUID() gameId: string;
  @IsIn(['VES', 'USDT']) currency: 'VES' | 'USDT';
  @ValidateNested({ each: true })
  @Type(() => PlayDto)
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_PLAYS_PER_TICKET)
  plays: PlayDto[];
}

export class ProposeResultDto {
  @ValidateIf((d) => !d.numbers) @IsUUID() symbolId?: string;
  // Kino: los números extraídos, en orden de extracción.
  @IsOptional() @IsArray() @ArrayMinSize(1) @ArrayMaxSize(20) @IsInt({ each: true }) @Min(1, { each: true }) @Max(99, { each: true }) numbers?: number[];
  @IsString() @Length(3, 500) evidence: string;
  /** Andes 5 Estrella: estrella extraída. */
  @IsOptional() @IsInt() @Min(1) @Max(9) star?: number;
}

export class CancelDrawDto {
  @IsString() @Length(3, 300) reason: string;
}

export class ExtraordinaryDrawDto {
  @Type(() => Number) @IsInt() @Min(1) @Max(24 * 60) minutesFromNow: number;
  /** Resultado automático por RNG a la hora del sorteo (sin carga manual). */
  @IsOptional() @IsBoolean() auto?: boolean;
}

export class AutoResultsDto {
  @IsBoolean() enabled: boolean;
  /** También los sorteos ya cerrados que siguen esperando resultado. */
  @IsOptional() @IsBoolean() includeClosed?: boolean;
}

export class BandTestDto {
  @IsUUID() drawId: string;
  @IsBoolean() simulated: boolean;
  @IsArray() @ArrayMinSize(5) @ArrayMaxSize(10) @IsUUID(undefined, { each: true }) candidateIds: string[];
}

export class UpdateBandDto {
  @IsUUID() drawId: string;

  @ValidateIf((_, ids) => ids !== null)
  @IsArray()
  @ArrayMinSize(10)
  @ArrayMaxSize(10)
  @ArrayUnique()
  @IsUUID(undefined, { each: true })
  candidateIds: string[] | null;
}

export class DrawsQueryDto {
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/) date?: string;
}

/** Acta del sorteo (MER-05 §7). El archivo (PDF/JPG/PNG) es opcional y llega como multipart. */
export class DrawRecordDto {
  @IsString() @Length(1, 60) recordNumber: string;
  @IsString() @Length(3, 120) executor: string;
  @IsString() @Length(3, 120) inspector: string;
  @IsOptional() @IsString() @Length(0, 1000) notes?: string;
}

export class DrawIncidentDto {
  @IsIn(['HUMAN', 'MECHANICAL', 'IT', 'COMMUNICATIONS', 'OTHER']) kind: string;
  @IsString() @Length(3, 1000) description: string;
  @IsString() @Length(3, 120) responsible: string;
  @IsOptional() @IsString() @Length(3, 300) publicNotice?: string;
}

export class ResolveIncidentDto {
  @IsString() @Length(3, 1000) resolution: string;
}

export class RiskQueryDto {
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/) date?: string;
  @IsOptional() @IsIn(['VES', 'USDT']) currency?: 'VES' | 'USDT';
}

export class AnalyticsQueryDto {
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/) date?: string;
  @IsOptional() @IsIn(['VES', 'USDT']) currency?: 'VES' | 'USDT';
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(90) days?: number;
}

export class TicketsQueryDto {
  @IsOptional() @IsUUID() gameId?: string;
  @IsOptional() @IsIn(['VES', 'USDT']) currency?: 'VES' | 'USDT';
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/) from?: string;
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/) to?: string;
  @IsOptional() @IsIn(['OPEN', 'WON', 'LOST', 'VOID', 'CANCELLED']) status?: string;
  @IsOptional() @IsString() @Length(1, 80) q?: string;
  @IsOptional() @IsUUID() drawId?: string;
  @IsOptional() @IsIn(['true', 'false']) includeSim?: 'true' | 'false';
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(10000) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(10) @Max(200) size?: number;
}

const AMOUNT = /^\d{1,15}([.,]\d{1,6})?$/;

export class GameLimitsDto {
  @IsIn(['VES', 'USDT']) currency: 'VES' | 'USDT';
  @Matches(AMOUNT, { message: 'Apuesta mínima inválida' }) minPlay: string;
  @Matches(AMOUNT, { message: 'Apuesta máxima inválida' }) maxPlay: string;
  @Matches(AMOUNT, { message: 'Máximo por ticket inválido' }) maxTicket: string;
  @Matches(AMOUNT, { message: 'Tope de pago inválido' }) maxLiabilityPerSymbol: string;
  @IsOptional() @Matches(AMOUNT, { message: 'Máximo por jugador inválido' }) maxPlayerPerDraw?: string | null;
}

export class ScheduleSlotDto {
  @Type(() => Number) @IsInt() @Min(0) @Max(6) weekday: number;
  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/, { message: 'Hora inválida (HH:MM)' }) time: string;
}

/** Rango de fecha y hora local del juego para resetear o restaurar el historial. */
export class HistoryRangeDto {
  @Matches(/^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d$/, { message: 'Fecha inicial inválida' }) from: string;
  @Matches(/^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d$/, { message: 'Fecha final inválida' }) to: string;
}

export const MAX_DAILY_SCHEDULE_SLOTS = 24 * 60 / 5;

export class GameScheduleDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ScheduleSlotDto)
  @ArrayMinSize(1, { message: 'El juego necesita al menos un sorteo por semana' })
  @ArrayMaxSize(7 * MAX_DAILY_SCHEDULE_SLOTS)
  slots: ScheduleSlotDto[];
  @Type(() => Number) @IsInt() @Min(1) @Max(120) closeMinutesBefore: number;
}
