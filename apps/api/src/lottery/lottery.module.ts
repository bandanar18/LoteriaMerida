import { GameConfigService } from './game-config.service';
import { AnalyticsService } from './analytics.service';
import { Module } from '@nestjs/common';
import { KycStorageService } from '../kyc/kyc-storage.service';
import { DrawLifecycleService } from './draw-lifecycle.service';
import { LotteryAdminController } from './lottery-admin.controller';
import { LotteryController } from './lottery.controller';
import { LotteryService } from './lottery.service';
import { SimulationController } from './simulation.controller';
import { SimulationService } from './simulation.service';
import { RiskService } from './risk.service';

@Module({
  controllers: [LotteryController, LotteryAdminController, SimulationController],
  providers: [LotteryService, DrawLifecycleService, KycStorageService, SimulationService, RiskService, AnalyticsService, GameConfigService],
})
export class LotteryModule {}
