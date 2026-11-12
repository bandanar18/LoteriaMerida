import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { aggregateTicketStatus, applyMultiplier, assertTransition, CurrencyCode, DrawStatus, KYC_MAX_FILE_BYTES, pickWins, prizeFactor, PlayStatus, sniffMime } from '@loteria/domain';
import { AuditService } from '../audit/audit.service';
import { Db, DbService } from '../common/db.service';
import { BusinessError, pgErrorCode } from '../common/errors';
import { publish } from '../common/realtime';
import { config } from '../config';
import { KycStorageService } from '../kyc/kyc-storage.service';
import { RngService } from '../rng/rng.service';
import { AffiliateService } from '../affiliate/affiliate.service';
import { LedgerService } from '../wallet/ledger.service';
import { DrawIncidentDto, DrawRecordDto } from './lottery.dto';

const SCHEDULER_LOCK_KEY = 4_242_100;

type Actor = { id: string; ip?: string };

/**
 * Ciclo de vida de sorteos (Doc. Maestro §9.4–9.5):
 * SCHEDULED → OPEN → CLOSED → (RESULT_PENDING) → RESULT_CONFIRMED → SETTLED, o CANCELLED.
 * Todos los tiempos se evalúan con el reloj de la base de datos (servidor), nunca del cliente.
 */
@Injectable()
export class DrawLifecycleService {
  private readonly log = new Logger('DrawLifecycle');
  private running = false;

  constructor(
    private readonly db: DbService,
    private readonly ledger: LedgerService,
    private readonly audit: AuditService,
    private readonly rng: RngService,
    private readonly storage: KycStorageService,
    private readonly affiliate: AffiliateService,
  ) {}

  @Interval(10_000)
  async tick() {
    if (!config.lotteryScheduler || this.running) return;
    this.running = true;
    const lockClient = await this.db.pool.connect();
    try {
      // Una sola instancia ejecuta el ciclo a la vez (si hay varias réplicas del API).
      const got = (await lockClient.query('SELECT pg_try_advisory_lock($1) AS ok', [SCHEDULER_LOCK_KEY])).rows[0].ok;
      if (!got) return;
      try {
        await this.runCycle();
      } finally {
        await lockClient.query('SELECT pg_advisory_unlock($1)', [SCHEDULER_LOCK_KEY]);
      }
    } catch (err) {
      this.log.error(`Error en ciclo de sorteos: ${(err as Error).message}`, (err as Error).stack);
    } finally {
      lockClient.release();
      this.running = false;
    }
  }

  async runCycle() {
    await this.generateDraws();
    const opened = await this.db.query(
      `UPDATE lottery.draw SET status = 'OPEN' WHERE status = 'SCHEDULED' AND sales_open_at <= now() AND close_at > now()
       RETURNING id, game_id`,
    );
    for (const d of opened) await this.notifyDraw(this.db.pool, d.id, d.game_id, 'OPEN');
    const closed = await this.db.query(
      `UPDATE lottery.draw d SET status = 'CLOSED' FROM lottery.game g
        WHERE g.id = d.game_id AND d.status IN ('SCHEDULED', 'OPEN') AND d.close_at <= now() AND d.sim_player_id IS NULL
        RETURNING d.id, d.game_id, g.result_source`,
    );
    for (const d of closed) {
      await this.db.tx(async (c) => {
        await this.audit.log(c, { actorType: 'SYSTEM', action: 'DRAW_CLOSED', entity: 'lottery.draw', entityId: d.id });
        await this.notifyDraw(c, d.id, d.game_id, 'CLOSED');
        if (d.result_source === 'MANUAL') await publish(c, 'staff', 'queue', { kind: 'results' });
      });
    }
    const dueRng = await this.db.query(
      `SELECT d.id FROM lottery.draw d JOIN lottery.game g ON g.id = d.game_id
        WHERE (g.result_source = 'INTERNAL_RNG' OR d.auto_rng) AND d.status = 'CLOSED' AND d.draw_at <= now() ORDER BY d.draw_at`,
    );
    for (const d of dueRng) await this.resolveWithRng(d.id);
    const toSettle = await this.db.query(`SELECT id FROM lottery.draw WHERE status = 'RESULT_CONFIRMED' ORDER BY draw_at`);
    for (const d of toSettle) await this.settleDraw(d.id);
  }

  /** Crea los sorteos de hoy y mañana a partir del calendario (idempotente). */
  async generateDraws(gameId: string | null = null, transaction?: Db) {
    const generate = async (db: Db) => {
      // La configuración bloquea la misma fila antes de reemplazar el calendario.
      await db.query(
        `SELECT id FROM lottery.game WHERE status = 'ACTIVE' AND ($1::uuid IS NULL OR id = $1) ORDER BY id FOR SHARE`,
        [gameId],
      );
      const { rows: candidates } = await db.query(
        `SELECT g.id AS game_id, times.draw_at, closing.close_at, g.auto_rng,
                least(day.d::timestamp AT TIME ZONE g.timezone, closing.close_at - interval '1 minute') AS sales_open_at
           FROM lottery.game g
           JOIN lottery.schedule s ON s.game_id = g.id AND s.active
           CROSS JOIN LATERAL (SELECT ((now() AT TIME ZONE g.timezone)::date + k) AS d FROM generate_series(0, 1) k) day
           CROSS JOIN LATERAL (SELECT (day.d + s.draw_time) AT TIME ZONE g.timezone AS draw_at) times
           CROSS JOIN LATERAL (SELECT times.draw_at - make_interval(mins => g.close_minutes_before) AS close_at) closing
          WHERE g.status = 'ACTIVE' AND ($1::uuid IS NULL OR g.id = $1)
            AND extract(dow FROM day.d) = s.weekday AND closing.close_at > now()
            AND NOT EXISTS (SELECT 1 FROM lottery.draw x WHERE x.game_id = g.id AND x.draw_at = times.draw_at)`,
        [gameId],
      );
      if (!candidates.length) return 0;
      const draws = candidates.map((draw) => {
        const { serverSeed, seedHash } = this.rng.newCommitment();
        return { ...draw, seed_hash: seedHash, server_seed: serverSeed };
      });
      const { rowCount } = await db.query(
        `INSERT INTO lottery.draw (game_id, draw_at, sales_open_at, close_at, seed_hash, server_seed, auto_rng)
         SELECT game_id, draw_at, sales_open_at, close_at, seed_hash, server_seed, auto_rng
           FROM jsonb_to_recordset($1::jsonb) AS d(
             game_id uuid, draw_at timestamptz, sales_open_at timestamptz, close_at timestamptz, seed_hash text, server_seed text,
             auto_rng boolean
           )
         ON CONFLICT (game_id, draw_at) DO NOTHING`,
        [JSON.stringify(draws)],
      );
      return rowCount ?? 0;
    };
    const count = transaction ? await generate(transaction) : await this.db.tx(generate);
    if (count) this.log.log(`Sorteos generados: ${count}`);
  }

  async createExtraordinaryDraw(gameId: string, minutesFromNow: number, actor: Actor, auto = false) {
    try {
      return await this.createExtraordinaryDrawTx(gameId, minutesFromNow, actor, auto);
    } catch (err) {
      if (pgErrorCode(err) === '23505') throw new BusinessError('CONFLICT', 'Ya existe un sorteo de este juego a esa hora');
      throw err;
    }
  }

  private async createExtraordinaryDrawTx(gameId: string, minutesFromNow: number, actor: Actor, auto: boolean) {
    return this.db.tx(async (c) => {
      const g = (await c.query(`SELECT * FROM lottery.game WHERE id = $1 AND status = 'ACTIVE' FOR SHARE`, [gameId])).rows[0];
      if (!g) throw new BusinessError('NOT_FOUND', 'Juego no encontrado');
      if (minutesFromNow <= g.close_minutes_before) {
        if (auto && config.simulationMode && g.is_demo) {
          throw new BusinessError('INVALID_INPUT', 'Usa el sorteo rápido de prueba en Mercado');
        }
        throw new BusinessError('INVALID_INPUT', `Debe ser mayor que el cierre de venta (${g.close_minutes_before} min)`);
      }
      const { serverSeed, seedHash } = this.rng.newCommitment();
      const res = await c.query(
        `INSERT INTO lottery.draw (game_id, draw_at, sales_open_at, close_at, status, is_extraordinary, seed_hash, server_seed, auto_rng)
         VALUES ($1, date_trunc('minute', now()) + make_interval(mins => $2), now(),
                 date_trunc('minute', now()) + make_interval(mins => $2 - $3), 'OPEN', true, $4, $5, $6)
         RETURNING id, draw_at, close_at, auto_rng`,
        [gameId, minutesFromNow, g.close_minutes_before, seedHash, serverSeed, auto],
      );
      await this.audit.log(c, {
        actorType: 'STAFF',
        actorId: actor.id,
        action: auto ? 'DRAW_CREATED_AUTO' : 'DRAW_CREATED_EXTRAORDINARY',
        entity: 'lottery.draw',
        entityId: res.rows[0].id,
        after: res.rows[0],
        ip: actor.ip,
      });
      await this.notifyDraw(c, res.rows[0].id, gameId, 'OPEN');
      return res.rows[0];
    });
  }

  /** Aviso público de cambio de estado de un sorteo (sala lobby). */
  private notifyDraw(c: Db, drawId: string, gameId: string, status: DrawStatus) {
    return publish(c, 'lobby', 'draw', { id: drawId, gameId, status });
  }

  private async lockDraw(c: Db, drawId: string) {
    const d = (
      await c.query(
        `SELECT d.*, g.result_source, g.requires_record, g.board, g.draw_count, d.draw_at <= now() AS due,
                EXISTS (SELECT 1 FROM lottery.draw_record r WHERE r.draw_id = d.id) AS has_record
           FROM lottery.draw d JOIN lottery.game g ON g.id = d.game_id WHERE d.id = $1 FOR UPDATE OF d`,
        [drawId],
      )
    ).rows[0];
    if (!d) throw new BusinessError('NOT_FOUND', 'Sorteo no encontrado');
    return d;
  }

  private transition(from: DrawStatus, to: DrawStatus) {
    try {
      assertTransition(from, to);
    } catch (e) {
      throw new BusinessError('INVALID_STATE', (e as Error).message);
    }
  }

  /** Resultado por RNG con semilla comprometida antes de la venta (provably fair). */
  async resolveWithRng(drawId: string) {
    await this.db.tx(async (c) => {
      const d = await this.lockDraw(c, drawId);
      if (d.status !== 'CLOSED' || (d.result_source !== 'INTERNAL_RNG' && !d.auto_rng) || !d.due) return;
      const symbols = (await c.query(`SELECT id, number, name FROM lottery.symbol WHERE game_id = $1 ORDER BY sort`, [d.game_id]))
        .rows;
      if (d.board === 'KINO') {
        // Kino: 7 números distintos en orden de extracción.
        const idxs = await this.rng.sampleFromCommitment(c, { consumer: 'lottery.draw', refId: d.id, serverSeed: d.server_seed, n: symbols.length, k: d.draw_count });
        const numbers = idxs.map((i) => Number(symbols[i].number));
        await c.query(
          `UPDATE lottery.draw SET status = 'RESULT_CONFIRMED', result_symbol_id = $2, result_numbers = $3::smallint[], confirmed_at = now(),
                  result_evidence = $4 WHERE id = $1`,
          [drawId, symbols[idxs[0]].id, `{${numbers.join(',')}}`, 'Sorteo automático · RNG provably fair (HMAC-SHA256, extracción sin reposición)'],
        );
        await this.audit.log(c, {
          actorType: 'SYSTEM',
          action: 'DRAW_RESULT_RNG',
          entity: 'lottery.draw',
          entityId: drawId,
          after: { numbers, seedHash: d.seed_hash },
        });
        this.log.log(`Sorteo ${drawId}: salieron ${numbers.map((x) => String(x).padStart(2, '0')).join('-')}`);
        return;
      }
      const idx = await this.rng.fromCommitment(c, {
        consumer: 'lottery.draw',
        refId: d.id,
        serverSeed: d.server_seed,
        n: symbols.length,
      });
      const winner = symbols[idx];
      await c.query(
        `UPDATE lottery.draw SET status = 'RESULT_CONFIRMED', result_symbol_id = $2, confirmed_at = now(),
                result_evidence = $3
          WHERE id = $1`,
        [
          drawId,
          winner.id,
          d.auto_rng
            ? 'Sorteo automático · RNG provably fair (HMAC-SHA256 sobre semilla comprometida)'
            : 'RNG provably fair (HMAC-SHA256 sobre semilla comprometida)',
        ],
      );
      await this.audit.log(c, {
        actorType: 'SYSTEM',
        action: 'DRAW_RESULT_RNG',
        entity: 'lottery.draw',
        entityId: drawId,
        after: { symbol: `${winner.number} ${winner.name}`, index: idx, seedHash: d.seed_hash },
      });
      await this.notifyDraw(c, drawId, d.game_id, 'RESULT_CONFIRMED');
      this.log.log(`Sorteo ${drawId}: salió ${winner.number} ${winner.name}`);
    });
  }

  /** Paso 1 de 2 (4 ojos): un operador propone el resultado oficial con evidencia. */
  async proposeResult(drawId: string, symbolId: string | undefined, evidence: string, actor: Actor, numbers?: number[]) {
    return this.db.tx(async (c) => {
      const d = await this.lockDraw(c, drawId);
      if (d.result_source === 'INTERNAL_RNG' || d.auto_rng) throw new BusinessError('INVALID_STATE', 'Este sorteo se sortea por RNG');
      if (!d.due) throw new BusinessError('INVALID_STATE', 'El sorteo aún no se ha realizado');
      this.transition(d.status, 'RESULT_PENDING');
      let s: { id: string; number: string; name: string } | undefined;
      let kinoNumbers: number[] | null = null;
      if (d.board === 'KINO') {
        // Kino: los números extraídos, en orden de extracción; la primera bola queda como símbolo del resultado.
        const k = d.draw_count;
        if (!numbers || numbers.length !== k || new Set(numbers).size !== k) {
          throw new BusinessError('INVALID_INPUT', `Carga los ${k} números extraídos, sin repetir`);
        }
        const first = String(numbers[0]).padStart(2, '0');
        s = (await c.query(`SELECT id, number, name FROM lottery.symbol WHERE game_id = $1 AND number = $2`, [d.game_id, first])).rows[0];
        const valid = (await c.query(`SELECT count(*)::int AS n FROM lottery.symbol WHERE game_id = $1 AND number = ANY($2::text[])`, [
          d.game_id,
          numbers.map((x) => String(x).padStart(2, '0')),
        ])).rows[0].n;
        if (!s || valid !== k) throw new BusinessError('INVALID_INPUT', 'Hay números fuera del 01 al 40');
        kinoNumbers = numbers;
      } else {
        s = (await c.query(`SELECT id, number, name FROM lottery.symbol WHERE id = $1 AND game_id = $2`, [symbolId, d.game_id])).rows[0];
        if (!s) throw new BusinessError('INVALID_INPUT', 'Resultado inválido para este juego');
      }
      await c.query(
        `UPDATE lottery.draw SET status = 'RESULT_PENDING', proposed_symbol_id = $2, proposed_by = $3, proposed_at = now(),
                result_evidence = $4, proposed_numbers = $5::smallint[] WHERE id = $1`,
        [drawId, s.id, actor.id, evidence, kinoNumbers ? `{${kinoNumbers.join(',')}}` : null],
      );
      await this.audit.log(c, {
        actorType: 'STAFF',
        actorId: actor.id,
        action: 'DRAW_RESULT_PROPOSED',
        entity: 'lottery.draw',
        entityId: drawId,
        after: kinoNumbers ? { numbers: kinoNumbers, evidence } : { symbol: `${s.number} ${s.name}`, evidence },
        ip: actor.ip,
      });
      await this.notifyDraw(c, drawId, d.game_id, 'RESULT_PENDING');
      await publish(c, 'staff', 'queue', { kind: 'results' });
      return { status: 'RESULT_PENDING' };
    });
  }

  /** Paso 2 de 2: otro usuario confirma; luego se liquida. */
  async confirmResult(drawId: string, actor: Actor) {
    await this.db.tx(async (c) => {
      const d = await this.lockDraw(c, drawId);
      this.transition(d.status, 'RESULT_CONFIRMED');
      if (d.proposed_by === actor.id) {
        throw new BusinessError('FOUR_EYES_REQUIRED', 'El resultado debe confirmarlo un usuario distinto a quien lo cargó');
      }
      // MER-05 §7: el resultado solo es oficial con acta validada.
      if (d.requires_record && !d.has_record) {
        throw new BusinessError('RECORD_REQUIRED', 'Registra el acta del sorteo antes de confirmar el resultado oficial');
      }
      await c.query(
        `UPDATE lottery.draw SET status = 'RESULT_CONFIRMED', result_symbol_id = proposed_symbol_id, result_numbers = proposed_numbers,
                confirmed_by = $2, confirmed_at = now() WHERE id = $1`,
        [drawId, actor.id],
      );
      await this.audit.log(c, {
        actorType: 'STAFF',
        actorId: actor.id,
        action: 'DRAW_RESULT_CONFIRMED',
        entity: 'lottery.draw',
        entityId: drawId,
        after: { symbolId: d.proposed_symbol_id, proposedBy: d.proposed_by },
        ip: actor.ip,
      });
      await this.notifyDraw(c, drawId, d.game_id, 'RESULT_CONFIRMED');
      await publish(c, 'staff', 'queue', { kind: 'results' });
    });
    return this.settleDraw(drawId);
  }

  async rejectResult(drawId: string, actor: Actor) {
    return this.db.tx(async (c) => {
      const d = await this.lockDraw(c, drawId);
      this.transition(d.status, 'CLOSED');
      await c.query(
        `UPDATE lottery.draw SET status = 'CLOSED', proposed_symbol_id = NULL, proposed_numbers = NULL, proposed_by = NULL, proposed_at = NULL,
                result_evidence = NULL WHERE id = $1`,
        [drawId],
      );
      await this.audit.log(c, {
        actorType: 'STAFF',
        actorId: actor.id,
        action: 'DRAW_RESULT_REJECTED',
        entity: 'lottery.draw',
        entityId: drawId,
        before: { symbolId: d.proposed_symbol_id, proposedBy: d.proposed_by },
        ip: actor.ip,
      });
      await this.notifyDraw(c, drawId, d.game_id, 'CLOSED');
      await publish(c, 'staff', 'queue', { kind: 'results' });
      return { status: 'CLOSED' };
    });
  }

  /** Liquida todas las jugadas abiertas del sorteo contra el resultado confirmado. */
  async settleDraw(drawId: string) {
    return this.db.tx(async (c) => {
      const d = await this.lockDraw(c, drawId);
      if (d.status !== 'RESULT_CONFIRMED') return { settled: 0 };
      const plays = (
        await c.query(
          `SELECT p.id, p.ticket_id, p.symbol_id, p.amount, p.factor_x100, t.player_id, t.currency, m.code AS modality, s.number, p.selection
             FROM lottery.play p JOIN lottery.ticket t ON t.id = p.ticket_id
             JOIN lottery.modality m ON m.id = p.modality_id JOIN lottery.symbol s ON s.id = p.symbol_id
            WHERE p.draw_id = $1 AND p.status = 'OPEN' ORDER BY p.id FOR UPDATE OF p`,
          [drawId],
        )
      ).rows;

      const resultNumber: string = (await c.query(`SELECT number FROM lottery.symbol WHERE id = $1`, [d.result_symbol_id])).rows[0].number;
      let staked = 0n;
      let paid = 0n;
      let winners = 0;
      for (const p of plays) {
        const amount = BigInt(p.amount);
        const currency = p.currency as CurrencyCode;
        // Factor congelado en la jugada al momento de la venta.
        // Animalitos/Frutas: mismo símbolo. Triple: coinciden 3, 2 o 1 cifras finales según la modalidad.
        // Kino: gana si todos sus números están entre los extraídos.
        const f = p.selection
          ? pickWins(p.modality, p.selection, d.result_numbers ?? []) ? BigInt(p.factor_x100) : 0n
          : prizeFactor(p.modality, p.number, resultNumber, BigInt(p.factor_x100));
        const won = f > 0n;
        const win = won ? applyMultiplier(amount, f) : 0n;
        const inPlay = await this.ledger.house(c, 'BETS_IN_PLAY', 'LOTTERY', currency);
        const ggr = await this.ledger.house(c, 'HOUSE_GGR', 'LOTTERY', currency);
        const entries = won
          ? [
              { accountId: inPlay, direction: 'D' as const, amount },
              ...(win > amount ? [{ accountId: ggr, direction: 'D' as const, amount: win - amount }] : []),
              { accountId: await this.ledger.playerCash(c, p.player_id, currency), direction: 'C' as const, amount: win },
            ]
          : [
              { accountId: inPlay, direction: 'D' as const, amount },
              { accountId: ggr, direction: 'C' as const, amount },
            ];
        await this.ledger.post(c, {
          type: won ? 'BET_WON' : 'BET_LOST',
          refProduct: 'LOTTERY',
          refId: p.id,
          idempotencyKey: `lottery:play-settle:${p.id}`,
          metadata: { drawId, ticketId: p.ticket_id },
          entries,
        });
        await c.query(`UPDATE lottery.play SET status = $2, win = $3, settled_at = now() WHERE id = $1`, [
          p.id,
          won ? 'WON' : 'LOST',
          win.toString(),
        ]);
        staked += amount;
        paid += win;
        if (won) winners++;
      }

      await this.refreshTickets(c, [...new Set(plays.map((p) => p.ticket_id as string))]);
      await this.affiliate.releaseForDraw(c, drawId);
      await c.query(`UPDATE lottery.draw SET status = 'SETTLED', settled_at = now() WHERE id = $1`, [drawId]);
      await this.audit.log(c, {
        actorType: 'SYSTEM',
        action: 'DRAW_SETTLED',
        entity: 'lottery.draw',
        entityId: drawId,
        after: { plays: plays.length, winners, staked, paid },
      });
      await this.notifyDraw(c, drawId, d.game_id, 'SETTLED');
      return { settled: plays.length, winners };
    });
  }

  /** Anula un sorteo y devuelve todas sus jugadas abiertas. */
  async cancelDraw(drawId: string, reason: string, actor: Actor) {
    return this.db.tx(async (c) => {
      const d = await this.lockDraw(c, drawId);
      this.transition(d.status, 'CANCELLED');
      const plays = (
        await c.query(
          `SELECT p.id, p.ticket_id, p.amount, t.player_id, t.currency
             FROM lottery.play p JOIN lottery.ticket t ON t.id = p.ticket_id
            WHERE p.draw_id = $1 AND p.status = 'OPEN' ORDER BY p.id FOR UPDATE OF p`,
          [drawId],
        )
      ).rows;
      for (const p of plays) {
        const amount = BigInt(p.amount);
        await this.ledger.post(c, {
          type: 'BET_VOID',
          refProduct: 'LOTTERY',
          refId: p.id,
          idempotencyKey: `lottery:play-void:${p.id}`,
          createdBy: actor.id,
          metadata: { drawId, reason },
          entries: [
            { accountId: await this.ledger.house(c, 'BETS_IN_PLAY', 'LOTTERY', p.currency), direction: 'D', amount },
            { accountId: await this.ledger.playerCash(c, p.player_id, p.currency), direction: 'C', amount },
          ],
        });
        await c.query(`UPDATE lottery.play SET status = 'VOID', settled_at = now() WHERE id = $1`, [p.id]);
        await this.affiliate.reverseForPlay(c, p.id);
      }
      await this.refreshTickets(c, [...new Set(plays.map((p) => p.ticket_id as string))]);
      await c.query(`UPDATE lottery.draw SET status = 'CANCELLED', cancelled_reason = $2 WHERE id = $1`, [drawId, reason]);
      // MER-05 cláusula 23ª: causa, responsable, hora y comunicado público.
      await c.query(
        `INSERT INTO lottery.draw_incident (draw_id, kind, description, responsible, public_notice, created_by)
         SELECT $1, 'CANCELLATION', $2, coalesce(nullif(trim(first_name || ' ' || last_name), ''), email), $3, id
           FROM identity.app_user WHERE id = $4`,
        [drawId, reason, `Sorteo anulado: ${reason}. Las jugadas fueron reembolsadas.`, actor.id],
      );
      await this.audit.log(c, {
        actorType: 'STAFF',
        actorId: actor.id,
        action: 'DRAW_CANCELLED',
        entity: 'lottery.draw',
        entityId: drawId,
        before: { status: d.status },
        after: { status: 'CANCELLED', reason, refundedPlays: plays.length },
        ip: actor.ip,
      });
      await this.notifyDraw(c, drawId, d.game_id, 'CANCELLED');
      return { status: 'CANCELLED', refundedPlays: plays.length };
    });
  }

  // ───────────── Acta e incidencias (MER-05 §7 y §9) ─────────────

  /** Registra el acta del sorteo (una sola vez, inmutable). El archivo se guarda cifrado. */
  async addRecord(drawId: string, dto: DrawRecordDto, file: { buffer: Buffer; size: number } | undefined, actor: Actor) {
    let mime: string | null = null;
    if (file) {
      if (file.size > KYC_MAX_FILE_BYTES) throw new BusinessError('INVALID_INPUT', 'El acta supera el tamaño máximo (5 MB)');
      mime = sniffMime(file.buffer);
      if (!mime) throw new BusinessError('INVALID_INPUT', 'El acta debe ser PDF, JPG o PNG');
    }
    const stored = file ? await this.storage.save(file.buffer, 'actas') : null;
    try {
      return await this.db.tx(async (c) => {
        const d = await this.lockDraw(c, drawId);
        if (!['CLOSED', 'RESULT_PENDING'].includes(d.status) || !d.due) {
          throw new BusinessError('INVALID_STATE', 'El acta se registra después de realizado el sorteo y antes del resultado oficial');
        }
        if (d.has_record) throw new BusinessError('CONFLICT', 'El sorteo ya tiene acta registrada');
        await c.query(
          `INSERT INTO lottery.draw_record (draw_id, record_number, executor, inspector, notes, file_key, file_iv, file_tag, file_sha256, file_mime, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
          [drawId, dto.recordNumber, dto.executor, dto.inspector, dto.notes || null, stored?.storageKey ?? null, stored?.iv ?? null,
            stored?.tag ?? null, stored?.sha256 ?? null, mime, actor.id],
        );
        await this.audit.log(c, {
          actorType: 'STAFF',
          actorId: actor.id,
          action: 'DRAW_RECORD_ADDED',
          entity: 'lottery.draw',
          entityId: drawId,
          after: { recordNumber: dto.recordNumber, executor: dto.executor, inspector: dto.inspector, file: stored?.sha256 ?? null },
          ip: actor.ip,
        });
        await publish(c, 'staff', 'queue', { kind: 'results' });
        return { ok: true };
      });
    } catch (err) {
      if (stored) await this.storage.discard(stored.storageKey);
      throw err;
    }
  }

  /** Descarga el archivo del acta; cada consulta queda auditada. */
  async recordFile(drawId: string, actor: Actor) {
    const r = await this.db.one(`SELECT * FROM lottery.draw_record WHERE draw_id = $1`, [drawId]);
    if (!r?.file_key) throw new BusinessError('NOT_FOUND', 'El acta no tiene archivo adjunto');
    const content = await this.storage.load({ storageKey: r.file_key, iv: r.file_iv, tag: r.file_tag, sha256: r.file_sha256 });
    await this.db.tx((c) =>
      this.audit.log(c, {
        actorType: 'STAFF',
        actorId: actor.id,
        action: 'DRAW_RECORD_VIEWED',
        entity: 'lottery.draw',
        entityId: drawId,
        ip: actor.ip,
      }),
    );
    return { mime: r.file_mime as string, content };
  }

  async addIncident(drawId: string, dto: DrawIncidentDto, actor: Actor) {
    return this.db.tx(async (c) => {
      const d = await this.lockDraw(c, drawId);
      const res = await c.query(
        `INSERT INTO lottery.draw_incident (draw_id, kind, description, responsible, public_notice, created_by)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [drawId, dto.kind, dto.description, dto.responsible, dto.publicNotice || null, actor.id],
      );
      await this.audit.log(c, {
        actorType: 'STAFF',
        actorId: actor.id,
        action: 'DRAW_INCIDENT_ADDED',
        entity: 'lottery.draw_incident',
        entityId: res.rows[0].id,
        after: { drawId, ...dto },
        ip: actor.ip,
      });
      if (dto.publicNotice) await this.notifyDraw(c, drawId, d.game_id, d.status);
      return { id: res.rows[0].id };
    });
  }

  async resolveIncident(incidentId: string, resolution: string, actor: Actor) {
    return this.db.tx(async (c) => {
      const res = await c.query(
        `UPDATE lottery.draw_incident SET resolution = $2, resolved_at = now() WHERE id = $1 AND resolved_at IS NULL RETURNING draw_id`,
        [incidentId, resolution],
      );
      if (!res.rows[0]) throw new BusinessError('INVALID_STATE', 'La incidencia no existe o ya está resuelta');
      await this.audit.log(c, {
        actorType: 'STAFF',
        actorId: actor.id,
        action: 'DRAW_INCIDENT_RESOLVED',
        entity: 'lottery.draw_incident',
        entityId: incidentId,
        after: { resolution },
        ip: actor.ip,
      });
      return { ok: true };
    });
  }

  private async refreshTickets(c: Db, ticketIds: string[]) {
    for (const id of ticketIds) {
      const rows = (await c.query(`SELECT status, win FROM lottery.play WHERE ticket_id = $1`, [id])).rows;
      const status = aggregateTicketStatus(rows.map((r) => r.status as PlayStatus));
      const totalWin = rows.reduce((acc, r) => acc + BigInt(r.win), 0n);
      const upd = await c.query(
        `UPDATE lottery.ticket SET status = $2, total_win = $3 WHERE id = $1 AND status = 'OPEN' RETURNING player_id`,
        [id, status, totalWin.toString()],
      );
      // Las jugadas de otros sorteos del ticket también cambian de estado: siempre avisar.
      const playerId = upd.rows[0]?.player_id ?? (await c.query(`SELECT player_id FROM lottery.ticket WHERE id = $1`, [id])).rows[0].player_id;
      await publish(c, `player:${playerId}`, 'ticket', { id, status });
    }
  }
}
