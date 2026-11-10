import { CanActivate, Injectable } from '@nestjs/common';
import { DbService } from '../common/db.service';
import { BusinessError } from '../common/errors';

@Injectable()
export class FuturesAvailabilityGuard implements CanActivate {
  constructor(private readonly db: DbService) {}

  async canActivate() {
    const settings = await this.db.one<{ trading_enabled: boolean }>('SELECT trading_enabled FROM futures.settings WHERE id');
    if (!settings?.trading_enabled) throw new BusinessError('NOT_FOUND', 'Futuros no está disponible');
    return true;
  }
}
