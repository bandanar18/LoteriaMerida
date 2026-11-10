import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AdminController } from './admin/admin.controller';
import { AffiliateModule } from './affiliate/affiliate.module';
import { CoreModule } from './common/core.module';
import { config } from './config';
import { AuthController } from './identity/auth.controller';
import { AuthGuard } from './identity/auth.guard';
import { AuthService } from './identity/auth.service';
import { KycStorageService } from './kyc/kyc-storage.service';
import { KycController } from './kyc/kyc.controller';
import { KycService } from './kyc/kyc.service';
import { FuturesModule } from './futures/futures.module';
import { LotteryModule } from './lottery/lottery.module';
import { RealtimeGateway } from './realtime/realtime.gateway';
import { SportsModule } from './sports/sports.module';
import { PaymentsAdminController, PaymentsController } from './payments/payments.controller';
import { PaymentsService } from './payments/payments.service';
import { WalletController } from './wallet/wallet.controller';

@Module({
  imports: [
    CoreModule,
    AffiliateModule,
    JwtModule.register({ global: true, secret: config.jwtSecret }),
    ScheduleModule.forRoot(),
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 120 }]),
    LotteryModule,
    FuturesModule,
    // Deportes en pausa (SPORTS_ENABLED=false): el código y los datos se conservan para reactivarlo.
    ...(config.sportsEnabled ? [SportsModule] : []),
  ],
  controllers: [AuthController, WalletController, PaymentsController, PaymentsAdminController, AdminController, KycController],
  providers: [
    AuthService,
    PaymentsService,
    KycService,
    KycStorageService,
    RealtimeGateway,
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
})
export class AppModule {}
