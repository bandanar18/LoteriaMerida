import { Module } from '@nestjs/common';
import { DrawLifecycleService } from './draw-lifecycle.service';
import { LotteryAdminController } from './lottery-admin.controller';
import { LotteryController } from './lottery.controller';
import { LotteryService } from './lottery.service';

@Module({
  controllers: [LotteryController, LotteryAdminController],
  providers: [LotteryService, DrawLifecycleService],
})
export class LotteryModule {}
