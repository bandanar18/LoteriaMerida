import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { capFundingRate, filterOutliers, FUNDING_INTEREST_E8, formatFx, medianFx, parseFx } from '@loteria/domain';
import { DbService } from '../common/db.service';

/**
 * Feed de precios de Cumbre Futuros (manual §3). La casa NO pone precios: el índice es la mediana de los tickers spot
 * públicos de varios exchanges. Cada tick queda guardado en futures.price_tick (inmutable).
 *
 * Fuentes en USDT que responden desde la ubicación del servidor (Binance y Bybit bloquean el acceso): Kraken, OKX,
 * KuCoin, Gate y Coinbase. Funding: mediana de las tasas publicadas por OKX, Gate y KuCoin.
 */

export interface SymbolFeed {
  symbol: string;
  index: bigint | null;
  tickId: number | null;
  at: number; // ms del último índice válido
  sources: Record<string, string>;
  ok: boolean; // ≥ 3 fuentes válidas y reciente
  fundingE8: bigint | null; // tasa del próximo periodo (mercado)
  fundingSources: Record<string, string>;
}

const SYMBOLS = {
  BTCUSDT: { kraken: 'XBTUSDT', okx: 'BTC-USDT', kucoin: 'BTC-USDT', gate: 'BTC_USDT', coinbase: 'BTC-USDT', okxSwap: 'BTC-USDT-SWAP', gateFut: 'BTC_USDT', kucoinFut: 'XBTUSDTM' },
  ETHUSDT: { kraken: 'ETHUSDT', okx: 'ETH-USDT', kucoin: 'ETH-USDT', gate: 'ETH_USDT', coinbase: 'ETH-USDT', okxSwap: 'ETH-USDT-SWAP', gateFut: 'ETH_USDT', kucoinFut: 'ETHUSDTM' },
  SOLUSDT: { kraken: 'SOLUSDT', okx: 'SOL-USDT', kucoin: 'SOL-USDT', gate: 'SOL_USDT', coinbase: 'SOL-USDT', okxSwap: 'SOL-USDT-SWAP', gateFut: 'SOL_USDT', kucoinFut: 'SOLUSDTM' },
} as const;
type Sym = keyof typeof SYMBOLS;

export const MIN_SOURCES = 3;
const TICK_MS = 2_000;
const STALE_SOURCE_MS = 10_000;
const FEED_DOWN_MS = 10_000;
const FUNDING_EVERY_MS = 60_000;
const JUMP_PPM = 100_000n; // 10 % en 1 minuto

async function getJson(url: string): Promise<any> {
  const res = await fetch(url, { signal: AbortSignal.timeout(2_500), headers: { 'user-agent': 'suerteandes-futures/0.1', accept: 'application/json' } });
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json();
}

@Injectable()
export class FeedService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('FuturesFeed');
  private timer?: NodeJS.Timeout;
  private fundingTimer?: NodeJS.Timeout;
  /** Último precio válido de cada fuente: {sym: {source: {price, at}}}. */
  private last: Record<string, Record<string, { price: bigint; at: number }>> = {};
  readonly feeds = new Map<string, SymbolFeed>();
  private listeners: ((symbol: string) => Promise<void>)[] = [];
  private downSince = new Map<string, number>();
  private running = false;

  constructor(private readonly db: DbService) {
    for (const s of Object.keys(SYMBOLS)) {
      this.feeds.set(s, { symbol: s, index: null, tickId: null, at: 0, sources: {}, ok: false, fundingE8: null, fundingSources: {} });
      this.last[s] = {};
    }
  }

  onModuleInit() {
    if (process.env.FUTURES_FEED === 'off') {
      this.log.warn('Feed de futuros desactivado (FUTURES_FEED=off): los contratos quedan en «solo cerrar».');
      return;
    }
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    this.fundingTimer = setInterval(() => void this.fetchFunding(), FUNDING_EVERY_MS);
    void this.fetchFunding();
  }

  onModuleDestroy() {
    clearInterval(this.timer);
    clearInterval(this.fundingTimer);
  }

  /** El motor se suscribe para evaluar órdenes y liquidaciones después de cada tick. */
  onTick(fn: (symbol: string) => Promise<void>) {
    this.listeners.push(fn);
  }

  get(symbol: string): SymbolFeed | undefined {
    return this.feeds.get(symbol);
  }

  /** Precio marca válido o null si el feed está caído (manual §3.4: sin precio no se abre ni se liquida). */
  mark(symbol: string): { price: bigint; tickId: number } | null {
    const f = this.feeds.get(symbol);
    if (!f?.ok || f.index === null || f.tickId === null) return null;
    return { price: f.index, tickId: f.tickId };
  }

  private async fetchSpot() {
    const now = Date.now();
    const put = (sym: string, src: string, v: unknown) => {
      if (v === undefined || v === null || v === '') return;
      try {
        const p = parseFx(String(v));
        if (p > 0n) this.last[sym][src] = { price: p, at: now };
      } catch {
        /* dato inválido: se ignora */
      }
    };
    const syms = Object.keys(SYMBOLS) as Sym[];
    const jobs: Promise<void>[] = [
      getJson(`https://api.kraken.com/0/public/Ticker?pair=${syms.map((s) => SYMBOLS[s].kraken).join(',')}`).then((j) => {
        for (const s of syms) {
          const key = Object.keys(j.result ?? {}).find((k) => k === SYMBOLS[s].kraken || k.replace(/^X/, '') === SYMBOLS[s].kraken);
          put(s, 'kraken', key ? j.result[key]?.c?.[0] : undefined);
        }
      }),
    ];
    for (const s of syms) {
      const m = SYMBOLS[s];
      jobs.push(getJson(`https://www.okx.com/api/v5/market/ticker?instId=${m.okx}`).then((j) => put(s, 'okx', j.data?.[0]?.last)));
      jobs.push(getJson(`https://api.kucoin.com/api/v1/market/orderbook/level1?symbol=${m.kucoin}`).then((j) => put(s, 'kucoin', j.data?.price)));
      jobs.push(getJson(`https://api.gateio.ws/api/v4/spot/tickers?currency_pair=${m.gate}`).then((j) => put(s, 'gate', j?.[0]?.last)));
      jobs.push(getJson(`https://api.exchange.coinbase.com/products/${m.coinbase}/ticker`).then((j) => put(s, 'coinbase', j?.price)));
    }
    await Promise.allSettled(jobs);
  }

  private async tick() {
    if (this.running) return; // un tick a la vez
    this.running = true;
    try {
      await this.fetchSpot();
      const now = Date.now();
      for (const symbol of this.feeds.keys()) {
        const fresh = Object.entries(this.last[symbol]).filter(([, v]) => now - v.at <= STALE_SOURCE_MS);
        const prices = fresh.map(([, v]) => v.price);
        const kept = prices.length >= MIN_SOURCES ? filterOutliers(prices) : prices;
        const f = this.feeds.get(symbol)!;
        if (kept.length >= MIN_SOURCES) {
          const index = medianFx(kept);
          const sources = Object.fromEntries(fresh.map(([k, v]) => [k, formatFx(v.price)]));
          const row = await this.db.one<{ id: string }>(
            `INSERT INTO futures.price_tick (symbol, index_price, sources) VALUES ($1, $2, $3) RETURNING id`,
            [symbol, formatFx(index), sources],
          );
          const wasDown = !f.ok && f.at > 0;
          Object.assign(f, { index, tickId: Number(row!.id), at: now, sources, ok: true });
          this.downSince.delete(symbol);
          if (wasDown) await this.incident(symbol, 'RESUMED', 'El feed volvió a tener al menos 3 fuentes válidas');
          await this.checkJump(symbol, index);
          for (const fn of this.listeners) await fn(symbol).catch((e) => this.log.error(`Motor ${symbol}: ${e.message}`));
        } else {
          const since = this.downSince.get(symbol) ?? now;
          this.downSince.set(symbol, since);
          if (f.ok && now - f.at > FEED_DOWN_MS) {
            f.ok = false;
            await this.incident(symbol, 'FEED_DOWN', `Menos de ${MIN_SOURCES} fuentes válidas (${kept.length}). Solo cerrar; liquidaciones suspendidas.`);
            this.log.warn(`Feed caído en ${symbol}`);
          } else if (f.at === 0) f.ok = false;
          else if (now - f.at > FEED_DOWN_MS) f.ok = false;
        }
      }
    } catch (e) {
      this.log.error(`Tick: ${(e as Error).message}`);
    } finally {
      this.running = false;
    }
  }

  /** Salto anómalo: más de 10 % frente al índice de hace ~1 minuto → contrato en pausa e incidencia (manual §3.4). */
  private async checkJump(symbol: string, index: bigint) {
    const prev = await this.db.one<{ index_price: string }>(
      `SELECT index_price::text FROM futures.price_tick WHERE symbol = $1 AND created_at <= now() - interval '60 seconds'
        ORDER BY created_at DESC LIMIT 1`,
      [symbol],
    );
    if (!prev) return;
    const p = parseFx(prev.index_price);
    const dev = index > p ? index - p : p - index;
    if (dev * 1_000_000n > p * JUMP_PPM) {
      const r = await this.db.query(
        `UPDATE futures.contract SET status = 'PAUSED', status_reason = $2 WHERE symbol = $1 AND status <> 'PAUSED' RETURNING symbol`,
        [symbol, 'Salto de precio mayor al 10 % en 1 minuto'],
      );
      if (r.length) await this.incident(symbol, 'PRICE_JUMP', `Índice ${formatFx(p)} → ${formatFx(index)} en 1 minuto`);
    }
  }

  private async incident(symbol: string | null, kind: string, description: string) {
    await this.db.query(`INSERT INTO futures.incident (symbol, kind, description) VALUES ($1, $2, $3)`, [symbol, kind, description]);
  }

  /** Tasas de funding publicadas por el mercado (mediana, con tope de la plataforma). */
  private async fetchFunding() {
    for (const s of Object.keys(SYMBOLS) as Sym[]) {
      const m = SYMBOLS[s];
      const rates: Record<string, string> = {};
      const tryRate = async (src: string, url: string, pick: (j: any) => unknown) => {
        try {
          const v = pick(await getJson(url));
          if (v !== undefined && v !== null && v !== '') rates[src] = String(v);
        } catch {
          /* fuente no disponible */
        }
      };
      await Promise.all([
        tryRate('okx', `https://www.okx.com/api/v5/public/funding-rate?instId=${m.okxSwap}`, (j) => j.data?.[0]?.fundingRate),
        tryRate('gate', `https://api.gateio.ws/api/v4/futures/usdt/contracts/${m.gateFut}`, (j) => j.funding_rate),
        tryRate('kucoin', `https://api-futures.kucoin.com/api/v1/funding-rate/${m.kucoinFut}/current`, (j) => j.data?.value),
      ]);
      const vals = Object.values(rates).flatMap((v) => {
        try {
          return [parseFx(Number(v).toFixed(8))];
        } catch {
          return [];
        }
      });
      const f = this.feeds.get(s)!;
      f.fundingE8 = vals.length ? capFundingRate(medianFx(vals)) : FUNDING_INTEREST_E8;
      f.fundingSources = rates;
    }
  }
}
