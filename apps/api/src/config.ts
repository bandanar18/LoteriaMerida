import { config as loadEnv } from 'dotenv';
import { resolve } from 'path';

loadEnv({ path: resolve(__dirname, '..', '.env') });

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Falta la variable de entorno ${name} (ver apps/api/.env.example)`);
  return v;
}

function kycKey(hex: string): Buffer {
  if (!/^[0-9a-f]{64}$/i.test(hex)) throw new Error('KYC_ENCRYPTION_KEY debe tener 64 caracteres hexadecimales (32 bytes)');
  return Buffer.from(hex, 'hex');
}

export const config = {
  port: Number(process.env.PORT ?? 3000),
  databaseUrl: required('DATABASE_URL'),
  jwtSecret: required('JWT_SECRET'),
  accessTokenTtlSeconds: Number(process.env.ACCESS_TOKEN_TTL_SECONDS ?? 900),
  refreshTokenTtlDays: Number(process.env.REFRESH_TOKEN_TTL_DAYS ?? 7),
  lotteryScheduler: (process.env.LOTTERY_SCHEDULER ?? 'true') === 'true',
  licenseLabel: process.env.LICENSE_LABEL ?? '',
  kyc: {
    storageDir: resolve(__dirname, '..', process.env.KYC_STORAGE_DIR ?? 'storage/kyc'),
    /** 32 bytes en hex (64 caracteres) para AES-256-GCM. */
    encryptionKey: kycKey(required('KYC_ENCRYPTION_KEY')),
  },
  /** Retardo de aceptación de apuestas en vivo (Doc. Maestro §7.7). */
  liveBetDelayMs: Number(process.env.LIVE_BET_DELAY_MS ?? 5000),
  payment: {
    pagoMovil: {
      bank: process.env.PAY_PAGO_MOVIL_BANK ?? '',
      phone: process.env.PAY_PAGO_MOVIL_PHONE ?? '',
      document: process.env.PAY_PAGO_MOVIL_DOC ?? '',
    },
    usdt: {
      network: process.env.PAY_USDT_NETWORK ?? 'TRC-20',
      address: process.env.PAY_USDT_ADDRESS ?? '',
    },
  },
};
