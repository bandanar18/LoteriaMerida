import { Injectable } from '@nestjs/common';
import { fairIndex, fairSample, hashSeed, newServerSeed } from '@loteria/domain';
import { randomInt } from 'crypto';
import { Db } from '../common/db.service';

/**
 * Servicio RNG (Doc. Maestro §11). Única fuente de aleatoriedad de resultados.
 * CSPRNG del sistema operativo; cada llamada queda registrada en rng.rng_call.
 */
@Injectable()
export class RngService {
  /** Nueva semilla secreta + su compromiso público (provably fair). */
  newCommitment(): { serverSeed: string; seedHash: string } {
    const serverSeed = newServerSeed();
    return { serverSeed, seedHash: hashSeed(serverSeed) };
  }

  /** Índice uniforme en [0, n) derivado de una semilla comprometida. */
  async fromCommitment(db: Db, args: { consumer: string; refId: string; serverSeed: string; n: number }): Promise<number> {
    const result = fairIndex(args.serverSeed, args.refId, args.n);
    await db.query(
      `INSERT INTO rng.rng_call (consumer, ref_id, method, range_n, result, seed_hash) VALUES ($1, $2, $3, $4, $5, $6)`,
      [args.consumer, args.refId, 'HMAC_SHA256_COMMITTED_SEED', args.n, result, hashSeed(args.serverSeed)],
    );
    return result;
  }

  /** k índices distintos de [0, n) en orden de extracción, derivados de una semilla comprometida (Kino). */
  async sampleFromCommitment(db: Db, args: { consumer: string; refId: string; serverSeed: string; n: number; k: number }): Promise<number[]> {
    const result = fairSample(args.serverSeed, args.refId, args.n, args.k);
    await db.query(
      `INSERT INTO rng.rng_call (consumer, ref_id, method, range_n, result, seed_hash) VALUES ($1, $2, $3, $4, $5, $6)`,
      [args.consumer, args.refId, `HMAC_SHA256_COMMITTED_SEED_SAMPLE_${args.k}`, args.n, result[0], hashSeed(args.serverSeed)],
    );
    return result;
  }

  /** Entero uniforme en [0, n) directo del CSPRNG (sin compromiso previo). */
  async randomIndex(db: Db, args: { consumer: string; refId: string; n: number }): Promise<number> {
    const result = randomInt(0, args.n);
    await db.query(
      `INSERT INTO rng.rng_call (consumer, ref_id, method, range_n, result) VALUES ($1, $2, $3, $4, $5)`,
      [args.consumer, args.refId, 'CSPRNG_RANDOM_INT', args.n, result],
    );
    return result;
  }
}
