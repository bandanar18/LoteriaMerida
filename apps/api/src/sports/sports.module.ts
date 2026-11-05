import { Module } from '@nestjs/common';
import { SportsAdminController, SportsController } from './sports.controller';
import { SportsTradingService } from './sports-trading.service';
import { SportsService } from './sports.service';

@Module({
  controllers: [SportsController, SportsAdminController],
  providers: [SportsService, SportsTradingService],
})
export class SportsModule {}
