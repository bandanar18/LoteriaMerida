import { Injectable } from '@nestjs/common';
import { CurrencyCode, formatAmount, parseAmount, drawStar } from '@loteria/domain';
import { AuditService } from '../audit/audit.service';
import { DbService } from '../common/db.service';
import { BusinessError, pgErrorCode } from '../common/errors';
import { config } from '../config';
import { RngService } from '../rng/rng.service';
import { LedgerService } from '../wallet/ledger.service';
import { DrawLifecycleService } from './draw-lifecycle.service';

/** Tope por recarga de saldo de prueba. */
const MAX_TOPUP: Record<CurrencyCode, string> = { VES: '10000', USDT: '250' };

/**
 * Simulador del jugador (solo juegos demo y con SIMULATION_MODE activo).
 *
 * - Recarga: acredita saldo de prueba vía ledger (contrapartida: cuenta de la casa PAYMENT_CLEARING / SIMULATION).
 * - Sorteo privado: cada jugador tiene su propio sorteo abierto, que no aparece en listados públicos ni en el backoffice.
 * - Ejecutar: el jugador lo sortea al instante con el mismo RNG provably fair (semilla comprometida al crear el sorteo)
 *   y se liquida con la misma lógica que un sorteo real. El resultado no depende de lo apostado.
 */
@Injectable()
export class SimulationService {
  constructor(
    private readonly db: DbService,
    private readonly ledger: LedgerService,
    private readonly audit: AuditService,
    private readonly rng: RngService,
    private readonly lifecycle: DrawLifecycleService,
  ) {}

  private assertEnabled() {
    if (!config.simulationMode) throw new BusinessError('NOT_FOUND', 'El simulador no está disponible');
  }

  status() {
    return { enabled: config.simulationMode, maxTopup: MAX_TOPUP };
  }

  async topup(playerId: string, currency: CurrencyCode, amountText: string, idempotencyKey: string) {
    this.assertEnabled();
    let amount: bigint;
    try {
      amount = parseAmount(amountText, currency);
    } catch (e) {
      throw new BusinessError('INVALID_INPUT', (e as Error).message);
    }
    const max = parseAmount(MAX_TOPUP[currency], currency);
    if (amount <= 0n || amount > max) {
      throw new BusinessError('LIMIT_EXCEEDED', `La recarga de prueba va de 0 a ${formatAmount(max, currency)} ${currency}`);
    }
    return this.db.tx(async (c) => {
      const res = await this.ledger.post(c, {
        type: 'SIM_TOPUP',
        refProduct: 'ADJUST',
        refId: playerId,
        idempotencyKey: `sim:topup:${playerId}:${idempotencyKey}`,
        createdBy: playerId,
        metadata: { simulation: true },
        entries: [
          { accountId: await this.ledger.house(c, 'PAYMENT_CLEARING', 'SIMULATION', currency), direction: 'D', amount },
          { accountId: await this.ledger.playerCash(c, playerId, currency), direction: 'C', amount },
        ],
      });
      if (!res.duplicate) {
        await this.audit.log(c, {
          actorType: 'PLAYER',
          actorId: playerId,
          action: 'SIM_TOPUP',
          entity: 'wallet.ledger_transaction',
          entityId: res.transactionId,
          after: { currency, amount },
        });
      }
      const bal = await c.query(`SELECT balance::text FROM wallet.account WHERE id = $1`, [
        await this.ledger.playerCash(c, playerId, currency),
      ]);
      return { currency, amount: amount.toString(), balance: bal.rows[0].balance };
    });
  }

  /** Devuelve el sorteo privado abierto del jugador para ese juego; si no hay, lo crea. */
  async currentDraw(playerId: string, gameId: string) {
    this.assertEnabled();
    const game = await this.db.one(`SELECT id, is_demo FROM lottery.game WHERE id = $1 AND status = 'ACTIVE'`, [gameId]);
    if (!game) throw new BusinessError('NOT_FOUND', 'Juego no encontrado');
    if (!game.is_demo) throw new BusinessError('INVALID_INPUT', 'El simulador solo funciona con juegos en modo demo');
    const find = () =>
      this.db.one(
        `SELECT id, game_id, draw_at, close_at, status, seed_hash, now() AS server_now
           FROM lottery.draw WHERE sim_player_id = $1 AND game_id = $2 AND status = 'OPEN'`,
        [playerId, gameId],
      );
    const existing = await find();
    if (existing) return existing;
    const { serverSeed, seedHash } = this.rng.newCommitment();
    try {
      // Hora lejana para que el planificador nunca lo cierre; se fija al momento de sortear.
      await this.db.query(
        `INSERT INTO lottery.draw (game_id, draw_at, sales_open_at, close_at, status, is_extraordinary, seed_hash, server_seed, sim_player_id)
         VALUES ($1, now() + interval '30 days', now(), now() + interval '30 days', 'OPEN', true, $2, $3, $4)`,
        [gameId, seedHash, serverSeed, playerId],
      );
    } catch (err) {
      if (pgErrorCode(err) !== '23505') throw err; // doble clic: otro request ya lo creó
    }
    return find();
  }

  /** Sortea ya el sorteo privado del jugador, lo liquida y devuelve si ganó o perdió. */
  async run(playerId: string, drawId: string) {
    this.assertEnabled();
    const winner = await this.db.tx(async (c) => {
      const d = (
        await c.query(
          `SELECT d.id, d.game_id, d.status, d.server_seed, d.seed_hash, d.sim_player_id, g.board, g.draw_count, g.star_max
             FROM lottery.draw d JOIN lottery.game g ON g.id = d.game_id WHERE d.id = $1 FOR UPDATE OF d`,
          [drawId],
        )
      ).rows[0];
      if (!d || d.sim_player_id !== playerId) throw new BusinessError('NOT_FOUND', 'Sorteo no encontrado');
      if (d.status !== 'OPEN') throw new BusinessError('INVALID_STATE', 'Este sorteo ya se jugó');
      const plays = await c.query(`SELECT count(*)::int AS n FROM lottery.play WHERE draw_id = $1 AND status = 'OPEN'`, [drawId]);
      if (plays.rows[0].n === 0) throw new BusinessError('INVALID_INPUT', 'Primero compra un ticket para este sorteo');

      const symbols = (await c.query(`SELECT id, number, name, emoji FROM lottery.symbol WHERE game_id = $1 ORDER BY sort`, [d.game_id]))
        .rows;
      let idx: number;
      let numbers: number[] | null = null;
      if (d.board === 'KINO') {
        const idxs = await this.rng.sampleFromCommitment(c, { consumer: 'lottery.draw', refId: d.id, serverSeed: d.server_seed, n: symbols.length, k: d.draw_count });
        idx = idxs[0];
        numbers = idxs.map((i) => Number(symbols[i].number));
      } else {
        idx = await this.rng.fromCommitment(c, { consumer: 'lottery.draw', refId: d.id, serverSeed: d.server_seed, n: symbols.length });
      }
      const w = { ...symbols[idx], numbers };
      await c.query(
        `UPDATE lottery.draw SET status = 'RESULT_CONFIRMED', result_symbol_id = $2, result_numbers = $3::smallint[], result_star = $4, confirmed_at = now(),
                close_at = now(), draw_at = now(),
                result_evidence = 'Simulación · RNG provably fair (HMAC-SHA256 sobre semilla comprometida)'
          WHERE id = $1`,
        [drawId, w.id, numbers ? `{${numbers.join(',')}}` : null, numbers && d.star_max ? drawStar(d.server_seed, d.id, d.star_max) : null],
      );
      await this.audit.log(c, {
        actorType: 'PLAYER',
        actorId: playerId,
        action: 'SIM_DRAW_RUN',
        entity: 'lottery.draw',
        entityId: drawId,
        after: { symbol: `${w.number} ${w.name}`, index: idx, seedHash: d.seed_hash },
      });
      return w;
    });

    await this.lifecycle.settleDraw(drawId);

    const plays = await this.db.query(
      `SELECT p.id, t.code AS ticket_code, t.currency, s.number, s.name, s.emoji, m.code AS modality, m.name AS modality_name, p.selection,
              p.amount::text, p.win::text, p.status
         FROM lottery.play p JOIN lottery.ticket t ON t.id = p.ticket_id JOIN lottery.symbol s ON s.id = p.symbol_id
         JOIN lottery.modality m ON m.id = p.modality_id
        WHERE p.draw_id = $1 AND t.player_id = $2 ORDER BY s.sort`,
      [drawId, playerId],
    );
    const sum = (k: 'amount' | 'win') =>
      plays.reduce((a: Record<string, string>, p: any) => {
        a[p.currency] = (BigInt(a[p.currency] ?? '0') + BigInt(p[k])).toString();
        return a;
      }, {});
    const seed = await this.db.one(`SELECT server_seed, seed_hash FROM lottery.draw WHERE id = $1`, [drawId]);
    return {
      drawId,
      result: { id: winner.id, number: winner.number, name: winner.name, emoji: winner.emoji, numbers: winner.numbers ?? null },
      won: plays.some((p: any) => p.status === 'WON'),
      staked: sum('amount'),
      won_amount: sum('win'),
      plays,
      serverSeed: seed.server_seed,
      seedHash: seed.seed_hash,
    };
  }
}
