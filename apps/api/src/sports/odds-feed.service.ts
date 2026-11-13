import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { formatOdds, MARKET_TEMPLATES, marketTemplate, parseOdds, selectionName, SportCode } from '@loteria/domain';
import { AuditService } from '../audit/audit.service';
import { Db, DbService } from '../common/db.service';
import { BusinessError } from '../common/errors';
import { publish } from '../common/realtime';
import { config } from '../config';

/**
 * Conector de The Odds API (https://the-odds-api.com, v4): trae partidos próximos y cuotas decimales de varias casas
 * y los carga en las mismas tablas `sports.*` que usa el trader, así la pantalla del jugador no cambia.
 *
 * - Solo pre-partido: no hay cuotas en vivo ni marcadores (eso sigue siendo del trader, con resultado a 4 ojos).
 * - La cuota que se publica es la MEDIANA de las casas que ofrecen el mercado completo.
 * - Nunca reabre un mercado que el trader suspendió ni toca eventos que ya empezaron.
 * - Los nombres de ligas y mercados se muestran en español; los equipos conservan su nombre oficial.
 */

const BASE = 'https://api.the-odds-api.com/v4';

interface League {
  sport: SportCode;
  name: string;
  country: string;
  sort: number;
}

/** Códigos de mercado de cada deporte: ganador y total. Solo el fútbol tiene empate (1X2). */
const MARKETS: Record<SportCode, { winner: string; total: string; draw: boolean }> = {
  FOOTBALL: { winner: 'MATCH_RESULT', total: 'TOTAL_GOALS', draw: true },
  BASEBALL: { winner: 'MONEYLINE', total: 'TOTAL_RUNS', draw: false },
  BASKETBALL: { winner: 'BASKETBALL_MONEYLINE', total: 'BASKETBALL_TOTAL', draw: false },
  ICE_HOCKEY: { winner: 'HOCKEY_MONEYLINE', total: 'HOCKEY_TOTAL', draw: false },
  AMERICAN_FOOTBALL: { winner: 'GRIDIRON_MONEYLINE', total: 'GRIDIRON_TOTAL', draw: false },
};

/**
 * Ligas disponibles, por prioridad. Solo se consultan las que están activas (esa consulta no gasta créditos) y se rotan
 * según cuánto hace que se actualizaron, para repartir los créditos del plan. Las ligas de Venezuela (LVBP, FUTVE)
 * no existen en The Odds API: esas las carga el trader a mano.
 */
export const LEAGUES: Record<string, League> = {
  basketball_nba: { sport: 'BASKETBALL', name: 'NBA', country: 'Estados Unidos', sort: 1 },
  icehockey_nhl: { sport: 'ICE_HOCKEY', name: 'NHL', country: 'Estados Unidos', sort: 1 },
  baseball_mlb: { sport: 'BASEBALL', name: 'MLB', country: 'Estados Unidos', sort: 2 },
  americanfootball_nfl: { sport: 'AMERICAN_FOOTBALL', name: 'NFL', country: 'Estados Unidos', sort: 1 },
  soccer_fifa_world_cup: { sport: 'FOOTBALL', name: 'Copa Mundial FIFA', country: 'Mundial', sort: 1 },
  soccer_fifa_world_cup_qualifiers_south_america: { sport: 'FOOTBALL', name: 'Eliminatorias CONMEBOL', country: 'Sudamérica', sort: 3 },
  soccer_conmebol_copa_libertadores: { sport: 'FOOTBALL', name: 'Copa Libertadores', country: 'Sudamérica', sort: 2 },
  soccer_conmebol_copa_sudamericana: { sport: 'FOOTBALL', name: 'Copa Sudamericana', country: 'Sudamérica', sort: 4 },
  soccer_conmebol_copa_america: { sport: 'FOOTBALL', name: 'Copa América', country: 'Sudamérica', sort: 5 },
  soccer_mexico_ligamx: { sport: 'FOOTBALL', name: 'Liga MX', country: 'México', sort: 10 },
  soccer_argentina_primera_division: { sport: 'FOOTBALL', name: 'Liga Profesional Argentina', country: 'Argentina', sort: 11 },
  soccer_brazil_campeonato: { sport: 'FOOTBALL', name: 'Brasileirão Serie A', country: 'Brasil', sort: 12 },
  soccer_spain_la_liga: { sport: 'FOOTBALL', name: 'LaLiga', country: 'España', sort: 20 },
  soccer_epl: { sport: 'FOOTBALL', name: 'Premier League', country: 'Inglaterra', sort: 21 },
  soccer_italy_serie_a: { sport: 'FOOTBALL', name: 'Serie A', country: 'Italia', sort: 22 },
  soccer_germany_bundesliga: { sport: 'FOOTBALL', name: 'Bundesliga', country: 'Alemania', sort: 23 },
  soccer_france_ligue_one: { sport: 'FOOTBALL', name: 'Ligue 1', country: 'Francia', sort: 24 },
  soccer_uefa_champs_league: { sport: 'FOOTBALL', name: 'Champions League', country: 'Europa', sort: 25 },
  basketball_euroleague: { sport: 'BASKETBALL', name: 'Euroliga', country: 'Europa', sort: 2 },
  basketball_nbl: { sport: 'BASKETBALL', name: 'NBL', country: 'Australia', sort: 3 },
  baseball_kbo: { sport: 'BASEBALL', name: 'KBO', country: 'Corea del Sur', sort: 4 },
  baseball_npb: { sport: 'BASEBALL', name: 'NPB', country: 'Japón', sort: 5 },
};

interface OddsEvent {
  id: string;
  commence_time: string;
  home_team: string;
  away_team: string;
  bookmakers: { key: string; markets: { key: string; outcomes: { name: string; price: number; point?: number }[] }[] }[];
}

interface Quote {
  type: string;
  line: number | null; // ×100
  odds: Record<string, string>; // código de selección → cuota
}

export interface FeedStatus {
  enabled: boolean;
  running: boolean;
  intervalMinutes: number;
  leagues: string[];
  lastRun: {
    startedAt: string;
    finishedAt: string | null;
    trigger: string;
    leagues: number;
    events: number;
    markets: number;
    oddsChanged: number;
    creditsUsed: number | null;
    creditsRemaining: number | null;
    error: string | null;
  } | null;
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** Cuota decimal como texto "2.10" listo para parseOdds, o null si queda fuera del rango permitido (1.01–1000). */
function toOddsText(price: number): string | null {
  if (!Number.isFinite(price)) return null;
  const text = price.toFixed(2);
  try {
    parseOdds(text);
    return text;
  } catch {
    return null;
  }
}

/** Convierte las casas de un evento en mercados con la cuota mediana. Exportado para pruebas. */
export function buildQuotes(ev: OddsEvent, sport: SportCode): Quote[] {
  const quotes: Quote[] = [];

  // Ganador: 1X2 en fútbol; en los demás deportes siempre hay ganador (prórroga incluida).
  const kinds = MARKETS[sport];
  const h2hCodes: [string, string][] = kinds.draw ? [['1', ev.home_team], ['X', 'Draw'], ['2', ev.away_team]] : [['1', ev.home_team], ['2', ev.away_team]];
  const h2h: Record<string, number[]> = {};
  for (const b of ev.bookmakers) {
    const outcomes = b.markets.find((m) => m.key === 'h2h')?.outcomes;
    if (!outcomes) continue;
    const row = h2hCodes.map(([code, name]) => [code, outcomes.find((o) => o.name === name)?.price] as const);
    if (row.some(([, price]) => price === undefined)) continue; // la casa no ofrece el mercado completo
    for (const [code, price] of row) (h2h[code] ??= []).push(price!);
  }
  if (h2hCodes.every(([code]) => h2h[code]?.length)) {
    const odds: Record<string, string> = {};
    for (const [code] of h2hCodes) {
      const text = toOddsText(median(h2h[code]));
      if (text) odds[code] = text;
    }
    if (Object.keys(odds).length === h2hCodes.length) quotes.push({ type: kinds.winner, line: null, odds });
  }

  // Totales: se publica una sola línea, la más pareja entre Más de / Menos de (la "principal").
  const totals = new Map<number, { over: number[]; under: number[] }>();
  for (const b of ev.bookmakers) {
    const outcomes = b.markets.find((m) => m.key === 'totals')?.outcomes ?? [];
    for (const o of outcomes) {
      if (o.point === undefined || !(o.name === 'Over' || o.name === 'Under')) continue;
      const entry = totals.get(o.point) ?? { over: [], under: [] };
      (o.name === 'Over' ? entry.over : entry.under).push(o.price);
      totals.set(o.point, entry);
    }
  }
  let best: { point: number; over: number; under: number; books: number } | null = null;
  for (const [point, e] of totals) {
    if (!e.over.length || !e.under.length || point <= 0 || (point * 2) % 1 !== 0) continue; // solo enteros o .5
    const cand = { point, over: median(e.over), under: median(e.under), books: Math.min(e.over.length, e.under.length) };
    const better =
      !best ||
      cand.books > best.books ||
      (cand.books === best.books && Math.abs(cand.over - cand.under) < Math.abs(best.over - best.under));
    if (better) best = cand;
  }
  if (best) {
    const over = toOddsText(best.over);
    const under = toOddsText(best.under);
    if (over && under) quotes.push({ type: kinds.total, line: Math.round(best.point * 100), odds: { OVER: over, UNDER: under } });
  }
  return quotes;
}

@Injectable()
export class OddsFeedService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('OddsFeed');
  private timer?: NodeJS.Timeout;
  private first?: NodeJS.Timeout;
  private running = false;
  private lastManualAt = 0;

  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
  ) {}

  get enabled() {
    return config.oddsFeed.apiKey.length > 0;
  }

  onModuleInit() {
    if (!this.enabled) {
      this.log.warn('Sin ODDS_API_KEY: el conector de cuotas está apagado y los eventos se cargan a mano.');
      return;
    }
    const every = config.oddsFeed.intervalMinutes * 60_000;
    const auto = () => void this.sync('AUTO').catch(() => undefined);
    this.timer = setInterval(auto, every);
    // Un reinicio del API (p. ej. el modo watch al guardar un archivo) no debe gastar créditos: si ya hubo una
    // sincronización dentro del intervalo, la primera espera a que se cumpla.
    void this.db
      .one(`SELECT started_at FROM sports.feed_run WHERE error IS NULL AND finished_at IS NOT NULL ORDER BY id DESC LIMIT 1`)
      .then((last) => {
        const wait = last ? Math.max(0, new Date(last.started_at).getTime() + every - Date.now()) : 15_000;
        this.first = setTimeout(auto, Math.max(wait, 15_000));
      })
      .catch(() => (this.first = setTimeout(auto, every)));
  }

  onModuleDestroy() {
    clearTimeout(this.first);
    clearInterval(this.timer);
  }

  async status(): Promise<FeedStatus> {
    const run = await this.db.one(`SELECT * FROM sports.feed_run ORDER BY id DESC LIMIT 1`);
    return {
      enabled: this.enabled,
      running: this.running,
      intervalMinutes: config.oddsFeed.intervalMinutes,
      leagues: config.oddsFeed.leagues.length ? config.oddsFeed.leagues : Object.keys(LEAGUES),
      lastRun: run && {
        startedAt: new Date(run.started_at).toISOString(),
        finishedAt: run.finished_at ? new Date(run.finished_at).toISOString() : null,
        trigger: run.trigger,
        leagues: run.leagues,
        events: run.events,
        markets: run.markets,
        oddsChanged: run.odds_changed,
        creditsUsed: run.credits_used,
        creditsRemaining: run.credits_remaining,
        error: run.error,
      },
    };
  }

  /** Sincronización pedida por un trader. Se limita a una por minuto para no gastar créditos del plan. */
  async syncNow(actorId: string, ip?: string) {
    if (!this.enabled) throw new BusinessError('INVALID_STATE', 'Falta ODDS_API_KEY: el conector de cuotas no está configurado');
    if (this.running) throw new BusinessError('INVALID_STATE', 'Ya hay una sincronización en curso');
    if (Date.now() - this.lastManualAt < 60_000) throw new BusinessError('INVALID_STATE', 'Espera un minuto entre sincronizaciones manuales');
    this.lastManualAt = Date.now();
    await this.sync('MANUAL', { id: actorId, ip });
    return this.status();
  }

  private async fetchJson(path: string, params: Record<string, string>) {
    const url = new URL(`${BASE}${path}`);
    for (const [k, v] of Object.entries({ ...params, apiKey: config.oddsFeed.apiKey })) url.searchParams.set(k, v);
    const res = await fetch(url, { signal: AbortSignal.timeout(20_000), headers: { accept: 'application/json' } });
    if (!res.ok) {
      // El cuerpo del error no incluye la llave, pero igual solo se registra el estado.
      throw new Error(res.status === 401 ? 'The Odds API rechazó la llave (401)' : res.status === 429 ? 'Límite de The Odds API alcanzado (429)' : `The Odds API respondió ${res.status}`);
    }
    const num = (h: string) => {
      const v = Number(res.headers.get(h));
      return res.headers.has(h) && Number.isFinite(v) ? v : null;
    };
    return { data: (await res.json()) as any, remaining: num('x-requests-remaining'), used: num('x-requests-last') };
  }

  async sync(trigger: 'AUTO' | 'MANUAL', actor?: { id: string; ip?: string }) {
    if (!this.enabled || this.running) return;
    this.running = true;
    const run = (
      await this.db.query(`INSERT INTO sports.feed_run (trigger) VALUES ($1) RETURNING id`, [trigger])
    )[0] as { id: string };
    const totals = { leagues: 0, events: 0, markets: 0, oddsChanged: 0, used: 0, remaining: null as number | null };
    let error: string | null = null;
    try {
      // 1) Ligas activas (consulta gratuita) en el orden de prioridad configurado.
      const wanted = config.oddsFeed.leagues.length ? config.oddsFeed.leagues : Object.keys(LEAGUES);
      const catalog = (await this.fetchJson('/sports/', {})).data as { key: string; active: boolean }[];
      const active = new Set(catalog.filter((s) => s.active).map((s) => s.key));
      // Rotación: primero las ligas que hace más tiempo no se actualizan (las nuevas primero), respetando la prioridad.
      const seen = new Map<string, number>(
        (await this.db.query(`SELECT key, synced_at FROM sports.feed_league`)).map((r: { key: string; synced_at: Date }) => [r.key, new Date(r.synced_at).getTime()]),
      );
      const leagues = wanted
        .map((k, i) => ({ k, i }))
        .filter(({ k }) => active.has(k) && LEAGUES[k])
        .sort((a, b) => (seen.get(a.k) ?? 0) - (seen.get(b.k) ?? 0) || a.i - b.i)
        .map(({ k }) => k);

      const to = new Date(Date.now() + config.oddsFeed.horizonDays * 86_400_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
      for (const key of leagues) {
        if (totals.used >= config.oddsFeed.creditsPerSync) break; // presupuesto de esta ronda: las demás ligas esperan su turno
        if (totals.remaining !== null && totals.remaining < config.oddsFeed.minRemaining) {
          this.log.warn(`Quedan ${totals.remaining} créditos: se detiene la sincronización para no agotar el plan.`);
          break;
        }
        const { data, remaining, used } = await this.fetchJson(`/sports/${key}/odds/`, {
          regions: config.oddsFeed.regions,
          markets: 'h2h,totals',
          oddsFormat: 'decimal',
          dateFormat: 'iso',
          commenceTimeTo: to,
        });
        totals.remaining = remaining ?? totals.remaining;
        totals.used += used ?? 0;
        totals.leagues += 1;
        await this.db.query(
          `INSERT INTO sports.feed_league (key, synced_at) VALUES ($1, now()) ON CONFLICT (key) DO UPDATE SET synced_at = now()`,
          [key],
        );
        const r = await this.applyLeague(key, data as OddsEvent[]);
        totals.events += r.events;
        totals.markets += r.markets;
        totals.oddsChanged += r.oddsChanged;
      }
      this.log.log(`Sincronizado: ${totals.leagues} ligas, ${totals.events} eventos, ${totals.oddsChanged} cuotas cambiadas. Créditos restantes: ${totals.remaining ?? '?'}`);
    } catch (e) {
      error = (e as Error).message;
      this.log.error(`Falló la sincronización: ${error}`);
    } finally {
      await this.db.tx(async (c) => {
        await c.query(
          `UPDATE sports.feed_run SET finished_at = now(), leagues = $2, events = $3, markets = $4, odds_changed = $5,
                  credits_used = $6, credits_remaining = $7, error = $8 WHERE id = $1`,
          [run.id, totals.leagues, totals.events, totals.markets, totals.oddsChanged, totals.used, totals.remaining, error],
        );
        await this.audit.log(c, {
          actorType: actor ? 'STAFF' : 'SYSTEM',
          actorId: actor?.id ?? null,
          action: 'SPORTS_FEED_SYNC',
          entity: 'sports.feed_run',
          entityId: run.id,
          after: { trigger, ...totals, error },
          ip: actor?.ip,
        });
      }).catch((e) => this.log.error(`No se pudo cerrar el registro de sincronización: ${(e as Error).message}`));
      this.running = false;
    }
    if (error) throw new BusinessError('INVALID_STATE', error);
  }

  private async applyLeague(key: string, events: OddsEvent[]) {
    const league = LEAGUES[key];
    const out = { events: 0, markets: 0, oddsChanged: 0 };
    const sportTemplates = new Set(MARKET_TEMPLATES.filter((t) => t.sport === league.sport).map((t) => t.code));
    for (const ev of events) {
      if (!ev.id || !ev.home_team || !ev.away_team || ev.home_team === ev.away_team) continue;
      const startsAt = new Date(ev.commence_time);
      if (Number.isNaN(startsAt.getTime())) continue;
      const quotes = buildQuotes(ev, league.sport).filter((q) => sportTemplates.has(q.type));
      if (!quotes.length) continue;
      try {
        const r = await this.db.tx((c) => this.applyEvent(c, key, league, ev, startsAt, quotes));
        out.events += r.touched ? 1 : 0;
        out.markets += r.markets;
        out.oddsChanged += r.oddsChanged;
      } catch (e) {
        this.log.warn(`Evento ${ev.id} omitido: ${(e as Error).message}`);
      }
    }
    return out;
  }

  private async applyEvent(c: Db, key: string, league: League, ev: OddsEvent, startsAt: Date, quotes: Quote[]) {
    const comp = (
      await c.query(
        `INSERT INTO sports.competition (sport_code, name, country, sort, external_key) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (sport_code, name) DO UPDATE SET external_key = coalesce(sports.competition.external_key, EXCLUDED.external_key)
         RETURNING id`,
        [league.sport, league.name, league.country, league.sort, key],
      )
    ).rows[0];

    let event = (await c.query(`SELECT id, status, starts_at FROM sports.event WHERE external_id = $1 FOR UPDATE`, [ev.id])).rows[0];
    if (!event) {
      if (startsAt.getTime() < Date.now() + 60_000) return { touched: false, markets: 0, oddsChanged: 0 }; // ya empezó o está por empezar
      const ids: string[] = [];
      for (const name of [ev.home_team, ev.away_team]) {
        const p = await c.query(
          `INSERT INTO sports.participant (sport_code, name) VALUES ($1, $2)
           ON CONFLICT (sport_code, name) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
          [league.sport, name.trim()],
        );
        ids.push(p.rows[0].id);
      }
      event = (
        await c.query(
          `INSERT INTO sports.event (competition_id, home_id, away_id, starts_at, external_id) VALUES ($1, $2, $3, $4, $5)
           RETURNING id, status, starts_at`,
          [comp.id, ids[0], ids[1], startsAt.toISOString(), ev.id],
        )
      ).rows[0];
    } else if (event.status !== 'NOT_STARTED') {
      return { touched: false, markets: 0, oddsChanged: 0 }; // en vivo o terminado: ya es del trader
    } else if (new Date(event.starts_at).getTime() !== startsAt.getTime()) {
      await c.query(`UPDATE sports.event SET starts_at = $2 WHERE id = $1`, [event.id, startsAt.toISOString()]);
    }

    const names = { home: ev.home_team.trim(), away: ev.away_team.trim() };
    let markets = 0;
    let oddsChanged = 0;
    for (const q of quotes) {
      const t = marketTemplate(q.type)!;
      const lineText = q.line === null ? null : (q.line / 100).toFixed(2);
      const existing = (
        await c.query(
          `SELECT id, status FROM sports.market WHERE event_id = $1 AND type_code = $2 AND coalesce(line, -9999) = coalesce($3::numeric, -9999) FOR UPDATE`,
          [event.id, t.code, lineText],
        )
      ).rows[0];
      if (!existing) {
        const m = (await c.query(`INSERT INTO sports.market (event_id, type_code, line) VALUES ($1, $2, $3) RETURNING id`, [event.id, t.code, lineText])).rows[0];
        for (const [i, s] of t.selections.entries()) {
          const odds = formatOdds(parseOdds(q.odds[s.code]));
          const sel = (
            await c.query(`INSERT INTO sports.selection (market_id, code, name, odds, sort) VALUES ($1, $2, $3, $4, $5) RETURNING id`, [
              m.id,
              s.code,
              selectionName(s.name, { ...names, line: q.line }),
              odds,
              i,
            ])
          ).rows[0];
          await c.query(`INSERT INTO sports.odds_history (selection_id, odds) VALUES ($1, $2)`, [sel.id, odds]);
        }
        markets += 1;
        continue;
      }
      if (!['OPEN', 'SUSPENDED'].includes(existing.status)) continue;
      const sels = (await c.query(`SELECT id, code, odds::text FROM sports.selection WHERE market_id = $1 FOR UPDATE`, [existing.id])).rows;
      const changes: { selectionId: string; odds: string }[] = [];
      for (const s of sels) {
        const next = q.odds[s.code];
        if (!next) continue;
        const nextOdds = formatOdds(parseOdds(next));
        if (parseOdds(s.odds) === parseOdds(nextOdds)) continue;
        await c.query(`UPDATE sports.selection SET odds = $2 WHERE id = $1`, [s.id, nextOdds]);
        await c.query(`INSERT INTO sports.odds_history (selection_id, odds) VALUES ($1, $2)`, [s.id, nextOdds]);
        changes.push({ selectionId: s.id, odds: nextOdds });
      }
      if (changes.length) {
        oddsChanged += changes.length;
        await publish(c, 'lobby', 'odds', { eventId: event.id, marketId: existing.id, changes });
      }
    }
    if (markets) await publish(c, 'lobby', 'sports', { eventId: event.id });
    return { touched: true, markets, oddsChanged };
  }
}
