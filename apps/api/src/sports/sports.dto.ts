import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsDateString,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

const AMOUNT = /^\d{1,15}([.,]\d{1,6})?$/;
const ODDS = /^\d{1,4}([.,]\d{1,4})?$/;

export class BetLegDto {
  @IsUUID() selectionId: string;
  /** Cuota que vio el jugador al armar el cupón. */
  @Matches(ODDS, { message: 'Cuota inválida' }) odds: string;
}

export class PlaceBetDto {
  @IsIn(['SINGLE', 'PARLAY']) type: 'SINGLE' | 'PARLAY';
  @IsIn(['VES', 'USDT']) currency: 'VES' | 'USDT';
  @Matches(AMOUNT, { message: 'Monto inválido' }) stake: string;
  @IsIn(['ACCEPT_ANY', 'ACCEPT_HIGHER', 'NONE']) oddsPolicy: 'ACCEPT_ANY' | 'ACCEPT_HIGHER' | 'NONE';
  @ValidateNested({ each: true }) @Type(() => BetLegDto) @ArrayMinSize(1) @ArrayMaxSize(10) legs: BetLegDto[];
}

export class SportQueryDto {
  @IsOptional() @IsIn(['FOOTBALL', 'BASEBALL', 'BASKETBALL', 'ICE_HOCKEY', 'AMERICAN_FOOTBALL']) sport?: 'FOOTBALL' | 'BASEBALL' | 'BASKETBALL' | 'ICE_HOCKEY' | 'AMERICAN_FOOTBALL';
}

export class MarketInputDto {
  @IsString() @Length(2, 40) type: string;
  @IsOptional() @Matches(/^[+-]?\d{1,3}([.,]\d{1,2})?$/, { message: 'Línea inválida' }) line?: string;
  /** Cuota por código de selección: { "1": "2.10", "X": "3.30", "2": "3.60" } */
  @IsObject() odds: Record<string, string>;
}

export class CreateEventDto {
  @IsUUID() competitionId: string;
  @IsString() @Length(2, 80) home: string;
  @IsString() @Length(2, 80) away: string;
  @IsDateString() startsAt: string;
  @IsOptional() @ValidateNested({ each: true }) @Type(() => MarketInputDto) @ArrayMaxSize(20) markets?: MarketInputDto[];
}

export class UpdateOddsDto {
  /** Cuota nueva por id de selección. */
  @IsObject() odds: Record<string, string>;
}

export class MarketStatusDto {
  @IsIn(['OPEN', 'SUSPENDED']) status: 'OPEN' | 'SUSPENDED';
}

export class ScoreDto {
  @Type(() => Number) @IsInt() @Min(0) @Max(200) home: number;
  @Type(() => Number) @IsInt() @Min(0) @Max(200) away: number;
}

export class ProposeSportsResultDto extends ScoreDto {
  @IsString() @Length(3, 300) evidence: string;
}

export class ReasonDto {
  @IsString() @Length(3, 300) reason: string;
}
