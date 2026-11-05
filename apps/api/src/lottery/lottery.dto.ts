import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { MAX_PLAYS_PER_TICKET } from '@loteria/domain';

export class PlayDto {
  @IsUUID() drawId: string;
  @IsUUID() symbolId: string;
  @Matches(/^\d{1,15}([.,]\d{1,6})?$/, { message: 'Monto inválido' }) amount: string;
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
  @IsUUID() symbolId: string;
  @IsString() @Length(3, 500) evidence: string;
}

export class CancelDrawDto {
  @IsString() @Length(3, 300) reason: string;
}

export class ExtraordinaryDrawDto {
  @Type(() => Number) @IsInt() @Min(2) @Max(24 * 60) minutesFromNow: number;
}

export class DrawsQueryDto {
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/) date?: string;
}
