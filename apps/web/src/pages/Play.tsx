import { useMutation, useQueries, useQueryClient } from '@tanstack/react-query';
import { ReactNode, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { RecentStrip, useUpcomingDraws } from '../components/ResultsBoard';
import { TicketView } from '../components/TicketView';
import { ErrorBox, Modal, Notice, Spinner } from '../components/ui';
import { get, post } from '../lib/api';
import { useAuth } from '../lib/auth';
import { countdown, Currency, dateTime, hour, money, normalizeAmount, todayCaracas, toMinor, useNow } from '../lib/format';
import { NumberBalls, SymbolArt, symbolName } from '../components/SymbolArt';
import { Draw, Game, kinoSize, matchDigits, Modality, playedLabel, Symbol, symbolWords, useGames, useSimulationStatus } from '../lib/queries';

interface CartPlay {
  drawId: string;
  symbolId: string;
  amount: string; // tal como lo escribió el jugador
  modality: Modality['code'];
  /** Kino: los números elegidos, ordenados. */
  numbers?: number[];
}

const QUICK_AMOUNTS: Record<Currency, string[]> = {
  VES: ['5', '10', '20', '50', '100'],
  USDT: ['0.5', '1', '2', '5', '10'],
};

/** "3000" → "30×" */
const factorLabel = (x100: string) => `${Number(BigInt(x100)) / 100}×`;
const winFor = (amount: bigint, factorX100: string) => (amount * BigInt(factorX100)) / 100n;

export function PlayPage() {
  const games = useGames();
  const [gameId, setGameId] = useState<string>();
  const game = games.data?.find((g) => g.id === gameId) ?? games.data?.[0];

  if (games.isLoading) return <Spinner />;
  if (!game) return <Notice>No hay juegos disponibles.</Notice>;

  return (
    <div className="space-y-3">
      {games.data!.length > 1 && (
        <div className="no-scrollbar -mx-4 flex snap-x gap-2 overflow-x-auto px-4">
          {games.data!.map((g) => (
            <button
              key={g.id}
              onClick={() => setGameId(g.id)}
              className={`btn shrink-0 snap-start ${g.id === game.id ? 'bg-selva-800 text-white' : 'bg-white text-selva-900 ring-1 ring-black/10'}`}
            >
              {g.name}
            </button>
          ))}
        </div>
      )}
      <RecentStrip key={`strip-${game.id}`} game={game} />
      <GameBoard key={game.id} game={game} />
    </div>
  );
}

/** Modo simulador: un único sorteo privado que el jugador sortea cuando quiere. */
export interface SimMode {
  draw: Draw;
  onBought: (ticket: any) => void;
  /** Acción extra (botón «Sortear»): va en la barra del pulgar en móvil y bajo el ticket en escritorio. */
  action?: ReactNode;
}

export function GameBoard({ game, sim }: { game: Game; sim?: SimMode }) {
  const { user } = useAuth();
  const qc = useQueryClient();
  const simStatus = useSimulationStatus();
  const { today, todayDraws, tomorrowDraws } = useUpcomingDraws(sim ? undefined : game.id);
  const now = useNow();
  const [currency, setCurrency] = useState<Currency>('VES');
  // Triple Andino abre en «Las 3» (participa en las tres modalidades y cobra el premio mayor).
  const [modalityCode, setModalityCode] = useState<Modality['code']>(game.modalities.find((m) => (m.code === 'FULL' || m.code === 'DUAL') && m.status === 'ACTIVE')?.code ?? 'EXACT');
  const [pendingInfo, setPendingInfo] = useState<Modality | null>(null);
  const [selectedDraws, setSelectedDraws] = useState<string[]>([]);
  const [selectedSymbols, setSelectedSymbols] = useState<string[]>([]);
  // Buscador del tablero (70 animales): por número exacto/prefijo o por nombre, sin tildes.
  const [symbolQuery, setSymbolQuery] = useState('');
  const norm = (t: string) => t.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const sq = norm(symbolQuery.trim());
  const visibleSymbols = sq ? game.symbols.filter((s) => s.number.startsWith(sq) || norm(s.name).includes(sq)) : game.symbols;
  const [amount, setAmount] = useState('10');
  const [cart, setCart] = useState<CartPlay[]>([]);
  const [idemKey, setIdemKey] = useState(() => crypto.randomUUID());
  const [receipt, setReceipt] = useState<any>(null);
  const [sheetOpen, setSheetOpen] = useState(false);

  const words = symbolWords(game);
  const limits = game.limits.find((l) => l.currency === currency)!;
  // Triple Andino: se escribe el número (3 cifras; terminal 2; última cifra 1) en vez de tocar un dibujo.
  // Triple Andino (000–999) y Terminal Nevado (00–99): se escribe el número con el teclado.
  const isDigits = game.board === 'DIGITS3' || game.board === 'DIGITS2';
  const width = game.board === 'DIGITS2' ? 2 : 3;
  const [digits, setDigits] = useState('');
  // Kino Teleférico: se marcan 5, 6 o 7 números del 01 al 40.
  const isKino = game.board === 'KINO';
  const [kinoPicks, setKinoPicks] = useState<number[]>([]);
  const symbolByNumber = useMemo(() => new Map(game.symbols.map((s) => [s.number, s])), [game.symbols]);
  const modalityByCode = useMemo(() => new Map(game.modalities.map((m) => [m.code, m])), [game.modalities]);
  const modality = game.modalities.find((m) => m.code === modalityCode) ?? game.modalities[0];
  const factor = modality?.factor_x100 ?? '3000';
  // «Las 3»: una jugada; exacto paga el factor completo, las 2 últimas 1/10 y la última 1/100. Solo el mayor.
  // «Las 3» (Triple) y «Las 2» (Terminal): una jugada en varias modalidades, cobra un solo premio.
  const combo = isDigits && (modality?.code === 'FULL' || modality?.code === 'DUAL');
  const comboLabel = modality?.code === 'DUAL' ? '2 en 1' : '3 en 1';
  const tier = (div: bigint) => (BigInt(factor) / div).toString();
  const k = isDigits ? (width === 2 ? 2 : matchDigits(modality?.code)) : 0;
  useEffect(() => {
    setDigits('');
    setKinoPicks([]);
  }, [modalityCode]);
  const kSize = isKino ? kinoSize(modality?.code) : 0;
  useEffect(() => {
    if (!isKino) return;
    const first = kinoPicks.length === kSize ? symbolByNumber.get(String(Math.min(...kinoPicks)).padStart(2, '0')) : undefined;
    setSelectedSymbols(first ? [first.id] : []);
  }, [isKino, kinoPicks, kSize, symbolByNumber]);
  useEffect(() => {
    if (!isDigits) return;
    const sym = digits.length === k ? symbolByNumber.get(digits.padStart(width, '0')) : undefined;
    setSelectedSymbols(sym ? [sym.id] : []);
  }, [isDigits, digits, k, symbolByNumber]);
  const draws = useMemo(
    () => [...(todayDraws.data ?? []), ...(tomorrowDraws.data ?? [])],
    [todayDraws.data, tomorrowDraws.data],
  );
  const openDraws = sim ? [sim.draw] : draws.filter((d) => d.status === 'OPEN' && new Date(d.close_at).getTime() > now);
  const drawById = useMemo(() => new Map((sim ? [sim.draw] : draws).map((d) => [d.id, d])), [draws, sim?.draw]);
  const symbolById = useMemo(() => new Map(game.symbols.map((s) => [s.id, s])), [game.symbols]);

  // Al cerrar un sorteo, quitarlo de la selección y del ticket.
  useEffect(() => {
    const open = new Set(openDraws.map((d) => d.id));
    setSelectedDraws((s) => (s.some((id) => !open.has(id)) ? s.filter((id) => open.has(id)) : s));
    setCart((c) => (c.some((p) => !open.has(p.drawId)) ? c.filter((p) => open.has(p.drawId)) : c));
  }, [openDraws.map((d) => d.id).join()]);

  useEffect(() => {
    if (selectedDraws.length === 0 && openDraws[0]) setSelectedDraws([openDraws[0].id]);
  }, [openDraws[0]?.id]);

  // Al comprar o vaciar desde la hoja del ticket, cerrarla si queda vacía.
  useEffect(() => {
    if (cart.length === 0) setSheetOpen(false);
  }, [cart.length]);

  const amountMinor = toMinor(amount, currency);
  const amountError =
    amountMinor === null
      ? 'Monto inválido'
      : amountMinor < BigInt(limits.min_play)
        ? `Mínimo ${money(limits.min_play, currency)}`
        : amountMinor > BigInt(limits.max_play)
          ? `Máximo ${money(limits.max_play, currency)}`
          : null;

  // Animales agotados: llegaron al tope de pago en alguno de los sorteos elegidos (el servidor lo vuelve a verificar al vender).
  const availability = useQueries({
    queries: selectedDraws.map((drawId) => ({
      queryKey: ['availability', drawId, currency],
      queryFn: () => get<{ soldOut: string[] }>(`/lottery/draws/${drawId}/availability?currency=${currency}`),
      refetchInterval: 30_000,
    })),
  });
  const soldOutKey = availability.map((q) => (q.data?.soldOut ?? []).join(',')).join('|');
  const soldOut = useMemo(() => new Set(availability.flatMap((q) => q.data?.soldOut ?? [])), [soldOutKey]);
  useEffect(() => {
    // Triple: el agotado se calcula para el triple exacto; terminal y última cifra los verifica el servidor.
    if (isDigits && modality?.code !== 'EXACT') return;
    setSelectedSymbols((sel) => (sel.some((id) => soldOut.has(id)) ? sel.filter((id) => !soldOut.has(id)) : sel));
  }, [soldOut]);

  const toggle = <T,>(list: T[], v: T) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  const newPlays = selectedDraws.length * selectedSymbols.length;
  const canAdd = !amountError && newPlays > 0 && modality?.status === 'ACTIVE';

  function addToCart() {
    if (!canAdd) return;
    const next = [...cart];
    const numbers = isKino ? [...kinoPicks].sort((a, b) => a - b) : undefined;
    const put = (drawId: string, symbolId: string, code: Modality['code']) => {
      const existing = next.find(
        (p) => p.drawId === drawId && p.symbolId === symbolId && p.modality === code && (p.numbers?.join() ?? '') === (numbers?.join() ?? ''),
      );
      if (existing) existing.amount = normalizeAmount(amount);
      else next.push({ drawId, symbolId, amount: normalizeAmount(amount), modality: code, ...(numbers ? { numbers } : {}) });
    };
    for (const drawId of selectedDraws) for (const symbolId of selectedSymbols) put(drawId, symbolId, modality.code);
    setCart(next);
    setSelectedSymbols([]);
    setDigits('');
    setKinoPicks([]);
    setIdemKey(crypto.randomUUID());
  }

  function removePlay(p: CartPlay) {
    setCart(cart.filter((x) => x !== p));
    setIdemKey(crypto.randomUUID());
  }

  const total = cart.reduce((acc, p) => acc + (toMinor(p.amount, currency) ?? 0n), 0n);
  const maxWin = cart.reduce((acc, p) => acc + winFor(toMinor(p.amount, currency) ?? 0n, modalityByCode.get(p.modality)?.factor_x100 ?? factor), 0n);

  const buy = useMutation({
    mutationFn: () => post('/lottery/tickets', { gameId: game.id, currency, plays: cart }, { 'idempotency-key': idemKey }),
    onSuccess: (ticket) => {
      if (sim) sim.onBought(ticket);
      else setReceipt(ticket);
      setCart([]);
      setSheetOpen(false);
      setIdemKey(crypto.randomUUID());
      qc.invalidateQueries({ queryKey: ['balances'] });
      qc.invalidateQueries({ queryKey: ['tickets'] });
      qc.invalidateQueries({ queryKey: ['availability'] });
    },
    onError: () => qc.invalidateQueries({ queryKey: ['availability'] }),
  });

  const ticketPanel = (
    <TicketPanel
      cart={cart}
      currency={currency}
      total={total}
      maxWin={maxWin}
      symbolById={symbolById}
      modalityByCode={modalityByCode}
      drawById={drawById}
      onRemove={removePlay}
      onClear={() => setCart([])}
      onBuy={() => buy.mutate()}
      buying={buy.isPending}
      error={buy.error}
      user={user}
    />
  );

  return (
    <div className="grid gap-3 pb-24 lg:grid-cols-[minmax(0,1fr)_340px] lg:gap-4 lg:pb-0">
      <div className="min-w-0 space-y-3">
        <section className="card overflow-hidden">
          <div className="flex items-center gap-3 bg-gradient-to-r from-selva-800 to-selva-600 px-4 py-3 text-white">
            <div className="min-w-0 flex-1">
              <h1 className="truncate text-lg font-extrabold">{game.name}</h1>
              <p className="text-xs text-white/75">
                {game.code} · cierre {game.close_minutes_before} min antes
              </p>
            </div>
            <div className="shrink-0 rounded-xl bg-white/15 px-3 py-1.5 text-center leading-tight">
              <div className="text-lg font-extrabold text-oro-300">{combo ? comboLabel : factorLabel(factor)}</div>
              <div className="text-[10px] text-white/75">{combo ? `hasta ${factorLabel(factor)}` : 'paga'}</div>
            </div>
          </div>
          {game.is_demo && (
            <div className="bg-amber-100 px-4 py-2 text-center text-xs font-bold tracking-wide text-amber-900">
              DEMO - NO CANJEABLE · Juego en propuesta, sin autorización oficial
            </div>
          )}
          {game.is_demo && !sim && simStatus.data?.enabled && user?.kind === 'PLAYER' && (
            <Link to="/simulador" className="flex items-center justify-between gap-2 border-b border-black/5 bg-selva-900/[0.03] px-4 py-2.5 text-sm font-semibold text-selva-800">
              <span>🎮 Prueba el juego completo en el simulador</span>
              <span aria-hidden>→</span>
            </Link>
          )}
          {game.modalities.length > 1 && (
            <div className="px-4 pt-3 pb-1">
              <div className={`grid gap-1 rounded-xl bg-black/5 p-1 ${game.modalities.length > 3 ? 'grid-cols-4' : 'grid-cols-3'}`} role="tablist" aria-label="Modalidad">
                {[...game.modalities].sort((a, b) => Number(b.code === 'FULL' || b.code === 'DUAL') - Number(a.code === 'FULL' || a.code === 'DUAL')).map((m) => {
                  const pending = m.status !== 'ACTIVE';
                  const active = m.code === modality?.code;
                  return (
                    <button
                      key={m.code}
                      role="tab"
                      aria-selected={active}
                      onClick={() => (pending ? setPendingInfo(m) : setModalityCode(m.code))}
                      className={`rounded-lg px-1 py-2 text-xs font-semibold leading-tight sm:text-sm ${active ? 'bg-white shadow-sm' : pending ? 'text-black/35' : 'text-black/60'}`}
                    >
                      {m.name}
                      <span className="block text-[10px] font-normal">{pending ? 'Próximamente' : m.code === 'FULL' ? '3 en 1' : m.code === 'DUAL' ? '2 en 1' : factorLabel(m.factor_x100)}</span>
                    </button>
                  );
                })}
              </div>
              <p className="mt-2 text-xs text-black/55">
                {modality?.description}
              </p>
            </div>
          )}
        </section>

        <section className="card p-4">
          <h2 className="mb-2 font-semibold text-selva-900">1. Elige el sorteo</h2>
          {openDraws.length === 0 && (todayDraws.isLoading || tomorrowDraws.isLoading) ? (
            <Spinner />
          ) : openDraws.length === 0 ? (
            <Notice>No hay sorteos en venta en este momento. Revisa los resultados o vuelve más tarde.</Notice>
          ) : (
            <div className="no-scrollbar -mx-4 flex snap-x gap-2 overflow-x-auto px-4 sm:mx-0 sm:flex-wrap sm:px-0">
              {openDraws.map((d) => {
                const active = selectedDraws.includes(d.id);
                const tomorrow = todayCaracas(new Date(d.draw_at)) !== today;
                return (
                  <button
                    key={d.id}
                    onClick={() => setSelectedDraws(toggle(selectedDraws, d.id))}
                    aria-pressed={active}
                    className={`min-w-[5.5rem] shrink-0 snap-start rounded-xl px-3 py-2 text-left ring-1 transition ${active ? 'bg-selva-700 text-white ring-selva-700' : 'bg-white ring-black/10 hover:ring-selva-600'}`}
                  >
                    {d.sim ? (
                      <>
                        <div className="text-base font-bold">🎲 Simulación</div>
                        <div className={`text-[11px] ${active ? 'text-white/80' : 'text-black/50'}`}>se sortea cuando tú quieras</div>
                      </>
                    ) : (
                      <>
                        <div className="text-base font-bold">
                          {hour(d.draw_at)} {d.is_extraordinary && <span title="Sorteo extraordinario">⭐</span>}
                        </div>
                        {tomorrow && (
                          <div className={`text-[11px] font-semibold ${active ? 'text-white/90' : 'text-sky-800'}`}>Mañana</div>
                        )}
                        <div className={`text-[11px] tabular-nums ${active ? 'text-white/80' : 'text-black/50'}`}>cierra en {countdown(d.close_at, now)}</div>
                      </>
                    )}
                  </button>
                );
              })}
            </div>
          )}
          {selectedDraws.length > 1 && <p className="mt-2 text-xs text-black/50">{selectedDraws.length} sorteos seleccionados: {words.every} se juega en todos.</p>}
        </section>

        {isKino ? (
          <section className="card p-4">
            <div className="mb-1 flex items-center justify-between">
              <h2 className="font-semibold text-selva-900">2. Elige {kSize} números</h2>
              <span className={`badge tabular-nums ${kinoPicks.length === kSize ? 'bg-emerald-100 text-emerald-800' : 'bg-black/5 text-black/60'}`}>
                {kinoPicks.length} de {kSize}
              </span>
            </div>
            <p className="mb-3 text-xs text-black/50">Del 01 al 40, sin repetir. Se extraen 7: ganas si salen todos los que elegiste.</p>
            <KinoPicker size={kSize} value={kinoPicks} onChange={setKinoPicks} />
          </section>
        ) : isDigits ? (
          <section className="card p-4">
            <h2 className="mb-1 font-semibold text-selva-900">
              2. {width === 2 || k === 3 ? 'Escribe tu número' : k === 2 ? 'Escribe las 2 cifras finales' : 'Escribe la última cifra'}
            </h2>
            <p className="mb-3 text-xs text-black/50">
              {width === 2
                ? modality?.code === 'APPROX'
                  ? 'Del 00 al 99. Ganas si sale el número anterior o el siguiente al tuyo (juegas 17: gana con 16 o 18).'
                  : modality?.code === 'DUAL'
                    ? 'Del 00 al 99. Tu número juega en directo y en aproximación: cobras un solo premio, el que te toque.'
                    : 'Del 00 al 99. Ganas si salen tus dos cifras en el mismo orden.'
                : combo ? 'Del 000 al 999. Participa en triple, terminal y última cifra: cobras el premio mayor que aciertes.' : k === 3 ? 'Del 000 al 999. Gana si salen las tres cifras en el mismo orden.' : k === 2 ? 'Gana si el triple ganador termina en esas dos cifras, en el mismo orden.' : 'Gana si el triple ganador termina en esa cifra.'}
            </p>
            <DigitPicker
              size={k}
              value={digits}
              onChange={setDigits}
              soldOut={modality?.code === 'EXACT' && digits.length === width && soldOut.has(symbolByNumber.get(digits)?.id ?? '')}
            />
          </section>
        ) : (
        <section className="card p-3 sm:p-4">
          <div className="mb-2 flex items-center justify-between px-1">
            <h2 className="font-semibold text-selva-900">2. Elige {words.pick}</h2>
            {selectedSymbols.length > 0 && (
              <button className="rounded-lg px-2 py-1 text-xs font-medium text-selva-700" onClick={() => setSelectedSymbols([])}>
                Limpiar ({selectedSymbols.length})
              </button>
            )}
          </div>
          {game.symbols.length > 40 && (
            <div className="relative mb-2">
              <input
                className="input pl-9"
                type="search"
                inputMode="search"
                placeholder="Buscar por número o nombre"
                value={symbolQuery}
                onChange={(e) => setSymbolQuery(e.target.value)}
                aria-label={`Buscar ${words.one}`}
              />
              <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-black/35">🔍</span>
            </div>
          )}
          <div className="grid grid-cols-5 gap-1.5 sm:grid-cols-7 sm:gap-2 md:grid-cols-8 lg:grid-cols-7 xl:grid-cols-10">
            {visibleSymbols.length === 0 && <p className="col-span-full py-6 text-center text-sm text-black/50">{words.none} con «{symbolQuery}».</p>}
            {visibleSymbols.map((s) => {
              const active = selectedSymbols.includes(s.id);
              const out = soldOut.has(s.id);
              return (
                <button
                  key={s.id}
                  disabled={out}
                  onClick={() => setSelectedSymbols(toggle(selectedSymbols, s.id))}
                  className={`relative flex min-h-[4.25rem] flex-col items-center justify-center overflow-hidden rounded-xl px-0.5 py-1.5 ring-1 transition active:scale-95 disabled:cursor-not-allowed disabled:opacity-50 disabled:active:scale-100 ${active ? 'bg-oro-300 ring-2 ring-oro-500' : 'bg-selva-900/[0.03] ring-black/5 hover:bg-oro-300/40'}`}
                  aria-pressed={active}
                  aria-label={`${s.number} ${s.name}${out ? ' (agotado)' : ''}`}
                >
                  {out && (
                    <span className="absolute inset-x-0 top-1/2 -translate-y-1/2 -rotate-12 bg-red-600/90 py-0.5 text-center text-[9px] font-bold tracking-wide text-white uppercase">
                      Agotado
                    </span>
                  )}
                  <span className="text-[1.5rem] leading-none sm:text-3xl">{s.emoji}</span>
                  <span className="mt-1 text-xs font-extrabold text-selva-900 tabular-nums">{s.number}</span>
                  <span className="line-clamp-2 w-full text-center text-[10px] leading-tight text-black/60">{s.name}</span>
                </button>
              );
            })}
          </div>
        </section>
        )}

        <section className="card p-4">
          <div className="mb-3 flex items-center justify-between gap-2">
            <h2 className="font-semibold text-selva-900">3. Monto por jugada</h2>
            <div className="flex rounded-xl bg-black/5 p-1">
              {(['VES', 'USDT'] as Currency[]).map((c) => (
                <button
                  key={c}
                  disabled={cart.length > 0 && c !== currency}
                  title={cart.length > 0 && c !== currency ? 'Vacía el ticket para cambiar de moneda' : undefined}
                  onClick={() => {
                    setCurrency(c);
                    setAmount(c === 'VES' ? '10' : '1');
                  }}
                  className={`rounded-lg px-3 py-1.5 text-sm font-semibold disabled:opacity-40 ${currency === c ? 'bg-white shadow-sm' : 'text-black/60'}`}
                >
                  {c === 'VES' ? 'Bs.' : 'USDT'}
                </button>
              ))}
            </div>
          </div>
          <div className="grid grid-cols-5 gap-1.5">
            {QUICK_AMOUNTS[currency].map((q) => (
              <button
                key={q}
                onClick={() => setAmount(q)}
                className={`rounded-xl py-2.5 text-sm font-semibold tabular-nums ring-1 ${normalizeAmount(amount) === q ? 'bg-selva-700 text-white ring-selva-700' : 'bg-white ring-black/10'}`}
              >
                {q}
              </button>
            ))}
          </div>
          <div className="mt-2 flex items-center gap-2">
            <input
              className="input flex-1 text-right tabular-nums"
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              aria-label="Monto por jugada"
            />
            <button className="btn-primary hidden lg:inline-flex" disabled={!canAdd} onClick={addToCart}>
              Agregar {newPlays || ''} jugada{newPlays === 1 ? '' : 's'}
            </button>
          </div>
          <p className={`mt-2 text-xs ${amountError ? 'text-red-700' : 'text-black/50'}`}>
            {amountError ??
              (modality?.code === 'DUAL'
                ? `Cobras un solo premio: si sale tu número ${money(winFor(amountMinor ?? 0n, factor), currency)} · si sale el anterior o el siguiente ${money(winFor(amountMinor ?? 0n, tier(5n)), currency)}.`
                : combo
                ? `Cobras solo el premio mayor: exacto ${money(winFor(amountMinor ?? 0n, factor), currency)} · 2 últimas ${money(winFor(amountMinor ?? 0n, tier(10n)), currency)} · última ${money(winFor(amountMinor ?? 0n, tier(100n)), currency)}.`
                : `Si acierta, cada jugada paga ${money(winFor(amountMinor ?? 0n, factor), currency)}.`)}{' '}
            Límites:{' '}
            {money(limits.min_play, currency)} – {money(limits.max_play, currency)} por jugada{limits.max_player_per_draw && <>, hasta {money(limits.max_player_per_draw, currency)} por sorteo</>}.
          </p>
        </section>
      </div>

      <aside className="hidden lg:sticky lg:top-20 lg:block lg:self-start">
        <div className="card p-4">{ticketPanel}</div>
        {sim?.action && <div className="mt-3">{sim.action}</div>}
      </aside>

      {/* Barra de acción móvil: queda sobre la navegación inferior, al alcance del pulgar. */}
      {(newPlays > 0 || cart.length > 0 || sim?.action) && (
        <div className="fixed inset-x-0 bottom-[calc(3.5rem+env(safe-area-inset-bottom))] z-30 border-t border-black/10 bg-white/95 px-3 py-2 shadow-[0_-4px_16px_rgba(0,0,0,0.08)] backdrop-blur lg:hidden">
          {sim?.action && <div className={`mx-auto max-w-xl ${newPlays > 0 || cart.length > 0 ? 'mb-2' : ''}`}>{sim.action}</div>}
          <div className={`mx-auto max-w-xl gap-2 ${newPlays > 0 || cart.length > 0 ? 'flex' : 'hidden'}`}>
            {newPlays > 0 ? (
              <button className="btn-primary flex-1 py-3 text-base" disabled={!canAdd} onClick={addToCart}>
                {amountError ?? `Agregar ${newPlays} jugada${newPlays === 1 ? '' : 's'} · ${money((amountMinor ?? 0n) * BigInt(newPlays), currency)}`}
              </button>
            ) : null}
            {cart.length > 0 && (
              <button className={`btn-gold py-3 ${newPlays > 0 ? 'px-4' : 'flex-1 text-base'}`} onClick={() => setSheetOpen(true)}>
                🎟️ {newPlays > 0 ? cart.length : `Ver ticket (${cart.length}) · ${money(total, currency)}`}
              </button>
            )}
          </div>
        </div>
      )}

      <Modal open={sheetOpen} onClose={() => setSheetOpen(false)} title="Tu ticket">
        {ticketPanel}
      </Modal>
      <Modal open={!!pendingInfo} onClose={() => setPendingInfo(null)} title={pendingInfo?.name ?? ''}>
        <div className="space-y-3 text-sm">
          <p>{pendingInfo?.description}</p>
          <Notice tone="warn">
            Esta modalidad está pendiente de aprobación: su condición de premio y su tabla de pagos aún no están definidas por el ente
            competente. Por ahora puedes jugar <b>{words.exact}</b>.
          </Notice>
        </div>
      </Modal>
      <Modal open={!!receipt} onClose={() => setReceipt(null)} title="¡Ticket comprado!">
        {receipt && <TicketView ticket={receipt} />}
      </Modal>
    </div>
  );
}

function TicketPanel(props: {
  cart: CartPlay[];
  currency: Currency;
  total: bigint;
  maxWin: bigint;
  symbolById: Map<string, Symbol>;
  modalityByCode: Map<string, Modality>;
  drawById: Map<string, Draw>;
  onRemove: (p: CartPlay) => void;
  onClear: () => void;
  onBuy: () => void;
  buying: boolean;
  error: unknown;
  user: ReturnType<typeof useAuth>['user'];
}) {
  const { cart, currency, user } = props;
  return (
    <div>
      <h2 className="mb-3 hidden font-semibold text-selva-900 lg:block">Tu ticket</h2>
      {cart.length === 0 ? (
        <p className="py-6 text-center text-sm text-black/40">Agrega jugadas para armar tu ticket.</p>
      ) : (
        <ul className="mb-3 max-h-[45vh] divide-y divide-black/5 overflow-x-hidden overflow-y-auto lg:max-h-80">
          {cart.map((p) => {
            const s = props.symbolById.get(p.symbolId)!;
            const d = props.drawById.get(p.drawId);
            return (
              <li key={p.drawId + p.symbolId + p.modality + (p.numbers?.join() ?? '')} className="flex items-center gap-2 py-2 text-sm">
                {!p.numbers && <SymbolArt className="text-2xl" emoji={s.emoji} number={playedLabel(p.modality, s.number)} />}
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium">
                    {p.numbers ? (
                      <span className="flex flex-wrap items-center gap-1">
                        {props.modalityByCode.get(p.modality)?.name} <NumberBalls numbers={p.numbers} />
                      </span>
                    ) : s.emoji ? <>{s.number} {symbolName(s.number, s.name)}</> : <>{props.modalityByCode.get(p.modality)?.name} {playedLabel(p.modality, s.number)}</>}
                  </div>
                  <div className="text-xs text-black/50">
                    {d?.sim ? 'Simulación' : `Sorteo ${d ? dateTime(d.draw_at) : ''}`}
                    {s.emoji && <> · {props.modalityByCode.get(p.modality)?.name ?? 'Exacto'}</>}
                  </div>
                </div>
                <span className="tabular-nums">{money(toMinor(p.amount, currency) ?? 0n, currency)}</span>
                <button className="-mr-1 p-2 text-black/30 hover:text-red-600" aria-label="Quitar jugada" onClick={() => props.onRemove(p)}>
                  ✕
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <div className="space-y-1 border-t border-black/5 pt-3 text-sm">
        <div className="flex justify-between">
          <span className="text-black/60">Total</span>
          <span className="font-bold tabular-nums">{money(props.total, currency)}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-black/60">Premio máximo</span>
          <span className="font-semibold text-selva-700 tabular-nums">{money(props.maxWin, currency)}</span>
        </div>
      </div>
      <div className="mt-3 space-y-2">
        <ErrorBox error={props.error} />
        {user?.kind === 'PLAYER' ? (
          <button className="btn-gold w-full py-3 text-base" disabled={cart.length === 0 || props.buying} onClick={props.onBuy}>
            {props.buying ? 'Procesando…' : 'Comprar ticket'}
          </button>
        ) : user ? (
          <Notice tone="warn">Las cuentas de staff no pueden apostar.</Notice>
        ) : (
          <Link to="/login" className="btn-gold w-full py-3">
            Entra para comprar
          </Link>
        )}
        {cart.length > 0 && (
          <button className="btn-ghost w-full" onClick={props.onClear}>
            Vaciar ticket
          </button>
        )}
      </div>
    </div>
  );
}

/** Teclado de cifras (Triple Andino): bolitas con el número y teclas grandes, al alcance del pulgar. */
function DigitPicker({ size, value, onChange, soldOut }: { size: number; value: string; onChange: (v: string | ((prev: string) => string)) => void; soldOut: boolean }) {
  const press = (d: string) => onChange((v) => (v.length >= size ? (v + d).slice(-size) : v + d));
  const random = () => onChange(Array.from({ length: size }, () => String(Math.floor(Math.random() * 10))).join(''));
  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9'];
  return (
    <div>
      <div className="mb-3 flex justify-center gap-2" aria-live="polite" aria-label={`Número: ${value || 'vacío'}`}>
        {Array.from({ length: size }, (_, i) => (
          <span
            key={i}
            className={`flex h-16 w-16 items-center justify-center rounded-full text-4xl font-extrabold tabular-nums shadow-inner ring-2 ${value[i] !== undefined ? 'bg-gradient-to-br from-oro-300 to-amber-400 text-selva-950 ring-amber-500' : 'bg-black/5 text-black/20 ring-black/10'}`}
          >
            {value[i] ?? '·'}
          </span>
        ))}
      </div>
      {soldOut && <Notice tone="warn">Ese número llegó al tope de pago en el sorteo elegido. Prueba otro.</Notice>}
      <div className="mx-auto mt-2 grid max-w-xs grid-cols-3 gap-2">
        {keys.map((d) => (
          <button key={d} type="button" className="rounded-xl bg-selva-900/[0.04] py-3 text-xl font-bold ring-1 ring-black/10 active:scale-95" onClick={() => press(d)}>
            {d}
          </button>
        ))}
        <button type="button" className="rounded-xl bg-white py-3 text-sm font-semibold text-selva-800 ring-1 ring-black/10 active:scale-95" onClick={random}>
          🎲 Azar
        </button>
        <button type="button" className="rounded-xl bg-selva-900/[0.04] py-3 text-xl font-bold ring-1 ring-black/10 active:scale-95" onClick={() => press('0')}>
          0
        </button>
        <button
          type="button"
          className="rounded-xl bg-white py-3 text-lg ring-1 ring-black/10 active:scale-95 disabled:opacity-40"
          disabled={!value}
          aria-label="Borrar"
          onClick={() => onChange((v) => v.slice(0, -1))}
        >
          ⌫
        </button>
      </div>
    </div>
  );
}

/** Tablero Kino (01–40): se marcan exactamente `size` números; con la selección completa, el resto queda bloqueado. */
function KinoPicker({ size, value, onChange }: { size: number; value: number[]; onChange: (v: number[] | ((prev: number[]) => number[])) => void }) {
  const full = value.length >= size;
  const random = () => {
    const pool = Array.from({ length: 40 }, (_, i) => i + 1);
    const out: number[] = [];
    for (let i = 0; i < size; i++) out.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
    onChange(out.sort((a, b) => a - b));
  };
  return (
    <div>
      <div className="grid grid-cols-8 gap-1.5">
        {Array.from({ length: 40 }, (_, i) => i + 1).map((n) => {
          const on = value.includes(n);
          return (
            <button
              key={n}
              type="button"
              aria-pressed={on}
              disabled={!on && full}
              onClick={() => onChange((v) => (v.includes(n) ? v.filter((x) => x !== n) : v.length >= size ? v : [...v, n].sort((a, b) => a - b)))}
              className={`aspect-square rounded-full text-sm font-bold tabular-nums ring-1 transition active:scale-95 disabled:opacity-35 ${on ? 'bg-gradient-to-br from-oro-300 to-amber-400 text-selva-950 ring-amber-500' : 'bg-selva-900/[0.04] ring-black/10'}`}
            >
              {String(n).padStart(2, '0')}
            </button>
          );
        })}
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2">
        <button type="button" className="rounded-xl bg-white py-2.5 text-sm font-semibold text-selva-800 ring-1 ring-black/10 active:scale-95" onClick={random}>
          🎲 Al azar
        </button>
        <button type="button" className="rounded-xl bg-white py-2.5 text-sm font-semibold ring-1 ring-black/10 active:scale-95 disabled:opacity-40" disabled={!value.length} onClick={() => onChange([])}>
          Limpiar
        </button>
      </div>
    </div>
  );
}
