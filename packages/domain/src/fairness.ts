import { createHash, createHmac, randomBytes } from 'crypto';

/**
 * Provably fair (Doc. Maestro §11.2).
 * Antes del sorteo se publica sha256(serverSeed). El resultado se obtiene de
 * HMAC-SHA256(serverSeed, mensaje) con muestreo por rechazo (sin sesgo de módulo).
 * Tras el sorteo se revela serverSeed y cualquiera puede verificar.
 */

export function newServerSeed(): string {
  return randomBytes(32).toString('hex');
}

export function hashSeed(serverSeedHex: string): string {
  return createHash('sha256').update(Buffer.from(serverSeedHex, 'hex')).digest('hex');
}

/** Índice uniforme en [0, n) derivado de (seed, message). Determinista. */
export function fairIndex(serverSeedHex: string, message: string, n: number): number {
  if (!Number.isInteger(n) || n < 1 || n > 2 ** 32) throw new Error('n fuera de rango');
  const key = Buffer.from(serverSeedHex, 'hex');
  const space = 2 ** 32;
  const limit = space - (space % n); // valores ≥ limit se descartan
  for (let counter = 0; counter < 1000; counter++) {
    const digest = createHmac('sha256', key).update(`${message}:${counter}`).digest();
    for (let off = 0; off + 4 <= digest.length; off += 4) {
      const x = digest.readUInt32BE(off);
      if (x < limit) return x % n;
    }
  }
  throw new Error('No se pudo derivar un índice (probabilidad despreciable)');
}

export interface DrawVerification {
  seedHash: string;
  hashMatches: boolean;
  index: number;
}

export function verifyDraw(serverSeedHex: string, publishedHash: string, message: string, n: number): DrawVerification {
  const seedHash = hashSeed(serverSeedHex);
  return { seedHash, hashMatches: seedHash === publishedHash, index: fairIndex(serverSeedHex, message, n) };
}

/**
 * k valores distintos de [0, n) en orden de extracción (sin reposición), derivados de (seed, message).
 * Bola i: índice uniforme entre los que quedan, con HMAC-SHA256(seed, "<message>#<i>:<contador>").
 */
export function fairSample(serverSeedHex: string, message: string, n: number, k: number): number[] {
  if (!Number.isInteger(k) || k < 1 || k > n) throw new Error('k fuera de rango');
  const pool = Array.from({ length: n }, (_, i) => i);
  const out: number[] = [];
  for (let i = 0; i < k; i++) out.push(pool.splice(fairIndex(serverSeedHex, `${message}#${i}`, pool.length), 1)[0]);
  return out;
}
