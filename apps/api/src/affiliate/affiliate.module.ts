import { Global, Module } from '@nestjs/common';
import { AffiliatePublicController, AgentAdminController, AgentController } from './affiliate.controller';
import { AffiliateService } from './affiliate.service';
import { AgentService } from './agent.service';
import { PayoutService } from './payout.service';
import { SmsService } from './sms.service';

/** Programa de Agencias Virtuales. Global: identity y lottery llaman a AffiliateService dentro de sus transacciones. */
@Global()
@Module({
  controllers: [AffiliatePublicController, AgentController, AgentAdminController],
  providers: [AffiliateService, AgentService, PayoutService, SmsService],
  exports: [AffiliateService],
})
export class AffiliateModule {}
