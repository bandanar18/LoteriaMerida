import { parseAmount } from '@loteria/domain';
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
  /** Deportes en pausa: por ahora solo se trabaja con animalitos. Con false el API no expone /sports ni /admin/sports. */
  sportsEnabled: (process.env.SPORTS_ENABLED ?? 'false') === 'true',
  /**
   * Cuotas reales de The Odds API (plan gratis: 500 créditos al mes; cada liga consume mercados × regiones).
   * Sin ODDS_API_KEY el conector queda apagado y el trader sigue cargando eventos a mano.
   */
  oddsFeed: {
    apiKey: process.env.ODDS_API_KEY ?? '',
    regions: process.env.ODDS_API_REGIONS ?? 'eu',
    /** Cada cuántos minutos sincroniza solo. Cada ronda gasta como máximo `creditsPerSync`: 16 × 30 rondas ≈ 480 créditos/mes. */
    intervalMinutes: Math.max(30, Number(process.env.ODDS_API_INTERVAL_MINUTES ?? 1440)),
    /** Créditos máximos por ronda. Las ligas que no alcanzan esperan su turno (se rota por antigüedad). */
    creditsPerSync: Math.max(2, Number(process.env.ODDS_API_CREDITS_PER_SYNC ?? 16)),
    horizonDays: Math.max(1, Number(process.env.ODDS_API_HORIZON_DAYS ?? 7)),
    /** Con menos créditos que esto, el conector deja de consultar hasta el próximo ciclo mensual. */
    minRemaining: Number(process.env.ODDS_API_MIN_REMAINING ?? 20),
    /** Lista opcional (claves de The Odds API separadas por coma) que reemplaza a las ligas por defecto. */
    leagues: (process.env.ODDS_API_LEAGUES ?? '').split(',').map((s) => s.trim()).filter(Boolean),
  },
  licenseLabel: process.env.LICENSE_LABEL ?? '',
  /** Bono de bienvenida por registro (DEMO), en unidades mínimas: 10.000 Bs y 10 USDT por defecto. */
  signupBonus: {
    VES: parseAmount(process.env.SIGNUP_BONUS_VES ?? '10000', 'VES'),
    USDT: parseAmount(process.env.SIGNUP_BONUS_USDT ?? '10', 'USDT'),
  },
  /**
   * SMS de confirmación (Directorio de Pago Móvil). Con false (DEMO) el código NO se envía: se devuelve
   * al cliente para mostrarlo en pantalla. En producción con dinero real debe estar en true (ver main.ts).
   */
  smsEnabled: (process.env.SMS_ENABLED ?? 'false') === 'true',
  /** Retiro mínimo de agencia por Pago Móvil, en Bs (unidades mínimas). */
  agentMinWithdrawalVes: parseAmount(process.env.AGENT_MIN_WITHDRAWAL_VES ?? '100', 'VES'),
  kyc: {
    storageDir: resolve(__dirname, '..', process.env.KYC_STORAGE_DIR ?? 'storage/kyc'),
    /** 32 bytes en hex (64 caracteres) para AES-256-GCM. */
    encryptionKey: kycKey(required('KYC_ENCRYPTION_KEY')),
  },
  /**
   * Simulador para jugadores (recarga de saldo de prueba y sorteo privado al instante), solo en juegos demo.
   * Apagado por defecto en producción.
   */
  /**
   * K6 de Agencias: exigir un depósito aprobado del referido para comisionar. En la DEMO (modo simulación)
   * viene apagado, así las jugadas con el bono de bienvenida generan comisión. AFFILIATE_REQUIRE_DEPOSIT lo fija.
   */
  affiliateRequireDeposit:
    (process.env.AFFILIATE_REQUIRE_DEPOSIT ?? ((process.env.SIMULATION_MODE ?? (process.env.NODE_ENV === 'production' ? 'false' : 'true')) === 'true' ? 'false' : 'true')) === 'true',
  simulationMode: (process.env.SIMULATION_MODE ?? (process.env.NODE_ENV === 'production' ? 'false' : 'true')) === 'true',
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
