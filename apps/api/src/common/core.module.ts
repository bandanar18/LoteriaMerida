import { Global, Module } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { RngService } from '../rng/rng.service';
import { LedgerService } from '../wallet/ledger.service';
import { DbService } from './db.service';

@Global()
@Module({
  providers: [DbService, LedgerService, AuditService, RngService],
  exports: [DbService, LedgerService, AuditService, RngService],
})
export class CoreModule {}
