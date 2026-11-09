import { Module } from '@nestjs/common';
import { FeedService } from './feed.service';
import { FuturesAdminController } from './futures-admin.controller';
import { FuturesController } from './futures.controller';
import { FuturesService } from './futures.service';

/** MER-06 «Cumbre Futuros»: perpetuos BTC/ETH/SOL con margen en USDT (docs/Cumbre_Futuros_MER-06.md). */
@Module({
  controllers: [FuturesController, FuturesAdminController],
  providers: [FeedService, FuturesService],
})
export class FuturesModule {}
