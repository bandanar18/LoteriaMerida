import { Injectable, Logger } from '@nestjs/common';
import { config } from '../config';
import { BusinessError } from '../common/errors';

export type SmsDelivery = 'SMS' | 'DEMO_SCREEN';

/**
 * Envío de SMS de confirmación (regla P3/P4 del documento maestro).
 * - SMS_ENABLED=false (DEMO): no envía nada; quien llama devuelve el código al cliente para mostrarlo en pantalla.
 * - SMS_ENABLED=true: aquí se conecta el proveedor real (pendiente de elegir, ver §18 del documento).
 */
@Injectable()
export class SmsService {
  private readonly log = new Logger('SMS');

  get delivery(): SmsDelivery {
    return config.smsEnabled ? 'SMS' : 'DEMO_SCREEN';
  }

  async send(phone: string, text: string): Promise<SmsDelivery> {
    if (!config.smsEnabled) {
      this.log.log(`DEMO: SMS no enviado a ${phone.slice(0, 5)}***${phone.slice(-2)}`);
      return 'DEMO_SCREEN';
    }
    // Proveedor real aún no elegido: fallar de forma explícita en vez de fingir que se envió.
    void text;
    throw new BusinessError('SMS_UNAVAILABLE', 'El envío de SMS no está disponible. Intenta más tarde.');
  }
}
