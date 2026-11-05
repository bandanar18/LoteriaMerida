import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { TicketView } from '../components/TicketView';
import { ErrorBox, Modal, Notice, Spinner } from '../components/ui';
import { post } from '../lib/api';
import { useAuth } from '../lib/auth';
import { countdown, Currency, hour, money, normalizeAmount, toMinor, useNow } from '../lib/format';
import { Draw, Game, useDraws, useGames } from '../lib/queries';

interface CartPlay {
  drawId: string;
  symbolId: string;
  amount: string; // tal como lo escribió el jugador
}

export function PlayPage() {
  const games = useGames();
  const [gameId, setGameId] = useState<string>();
  const game = games.data?.find((g) => g.id === gameId) ?? games.data?.[0];

  if (games.isLoading) return <Spinner />;
  if (!game) return <Notice>No hay juegos disponibles.</Notice>;

  return (
    <div className="space-y-4">
      <div className="flex gap-2 overflow-x-auto">
        {games.data!.map((g) => (
          <button
            key={g.id}
            onClick={() => setGameId(g.id)}
            className={`btn shrink-0 ${g.id === game.id ? 'bg-selva-800 text-white' : 'bg-white text-selva-900 ring-1 ring-black/10'}`}
          >
            {g.name}
          </button>
        ))}
      </div>
      <GameBoard key={game.id} game={game} />
    </div>
  );
}

function GameBoard({ game }: { game: Game }) {
  const { user } = useAuth();
  const qc = useQueryClient();
  const draws = useDraws(game.id);
  const now = useNow();
  const [currency, setCurrency] = useState<Currency>('VES');
  const [selectedDraws, setSelectedDraws] = useState<string[]>([]);
  const [selectedSymbols, setSelectedSymbols] = useState<string[]>([]);
  const [amount, setAmount] = useState('10');
  const [cart, setCart] = useState<CartPlay[]>([]);
  const [idemKey, setIdemKey] = useState(() => crypto.randomUUID());
  const [receipt, setReceipt] = useState<any>(null);

  const limits = game.limits.find((l) => l.currency === currency)!;
  const multiplier = Number(game.payout_multiplier);
  const openDraws = (draws.data ?? []).filter((d) => d.status === 'OPEN' && new Date(d.close_at).getTime() > now);
  const drawById = useMemo(() => new Map((draws.data ?? []).map((d) => [d.id, d])), [draws.data]);
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

  const amountMinor = toMinor(amount, currency);
  const amountError =
    amountMinor === null
      ? 'Monto inválido'
      : amountMinor < BigInt(limits.min_play)
        ? `Mínimo ${money(limits.min_play, currency)}`
        : amountMinor > BigInt(limits.max_play)
          ? `Máximo ${money(limits.max_play, currency)}`
          : null;

  function toggle<T>(list: T[], v: T) {
    return list.includes(v) ? list.filter((x) => x !== v) : [...list, v];
  }

  function addToCart() {
    if (amountError) return;
    const next = [...cart];
    for (const drawId of selectedDraws) {
      for (const symbolId of selectedSymbols) {
        const existing = next.find((p) => p.drawId === drawId && p.symbolId === symbolId);
        if (existing) existing.amount = normalizeAmount(amount);
        else next.push({ drawId, symbolId, amount: normalizeAmount(amount) });
      }
    }
    setCart(next);
    setSelectedSymbols([]);
    setIdemKey(crypto.randomUUID());
  }

  const total = cart.reduce((acc, p) => acc + (toMinor(p.amount, currency) ?? 0n), 0n);
  const maxWin = cart.reduce((acc, p) => acc + ((toMinor(p.amount, currency) ?? 0n) * BigInt(Math.round(multiplier * 100))) / 100n, 0n);

  const buy = useMutation({
    mutationFn: () =>
      post('/lottery/tickets', { gameId: game.id, currency, plays: cart }, { 'idempotency-key': idemKey }),
    onSuccess: (ticket) => {
      setReceipt(ticket);
      setCart([]);
      setIdemKey(crypto.randomUUID());
      qc.invalidateQueries({ queryKey: ['balances'] });
      qc.invalidateQueries({ queryKey: ['tickets'] });
    },
  });

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_340px]">
      <div className="space-y-4">
        <section className="card p-4">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <h2 className="font-semibold text-selva-900">1. Elige el sorteo</h2>
            <span className="text-xs text-black/50">
              Paga {multiplier}× · cierre {game.close_minutes_before} min antes ·{' '}
              {game.result_source === 'INTERNAL_RNG' ? 'RNG verificable' : 'resultado oficial'}
            </span>
          </div>
          {draws.isLoading ? (
            <Spinner />
          ) : openDraws.length === 0 ? (
            <Notice>No hay sorteos en venta en este momento. Revisa los resultados o vuelve más tarde.</Notice>
          ) : (
            <div className="flex flex-wrap gap-2">
              {openDraws.map((d) => {
                const active = selectedDraws.includes(d.id);
                const left = countdown(d.close_at, now);
                return (
                  <button
                    key={d.id}
                    onClick={() => setSelectedDraws(toggle(selectedDraws, d.id))}
                    className={`rounded-xl px-3 py-2 text-left ring-1 transition ${active ? 'bg-selva-700 text-white ring-selva-700' : 'bg-white ring-black/10 hover:ring-selva-600'}`}
                  >
                    <div className="text-sm font-bold">
                      {hour(d.draw_at)} {d.is_extraordinary && <span title="Sorteo extraordinario">⭐</span>}
                    </div>
                    <div className={`text-[11px] tabular-nums ${active ? 'text-white/80' : 'text-black/50'}`}>cierra en {left}</div>
                  </button>
                );
              })}
            </div>
          )}
        </section>

        <section className="card p-4">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="font-semibold text-selva-900">2. Elige tus animalitos</h2>
            {selectedSymbols.length > 0 && (
              <button className="text-xs text-selva-700" onClick={() => setSelectedSymbols([])}>
                Limpiar ({selectedSymbols.length})
              </button>
            )}
          </div>
          <div className="grid grid-cols-4 gap-2 sm:grid-cols-6 md:grid-cols-8">
            {game.symbols.map((s) => {
              const active = selectedSymbols.includes(s.id);
              return (
                <button
                  key={s.id}
                  onClick={() => setSelectedSymbols(toggle(selectedSymbols, s.id))}
                  className={`flex aspect-square flex-col items-center justify-center rounded-xl ring-1 transition ${active ? 'bg-oro-300 ring-2 ring-oro-500' : 'bg-selva-900/[0.03] ring-black/5 hover:bg-oro-300/40'}`}
                  aria-pressed={active}
                >
                  <span className="text-2xl leading-none sm:text-3xl">{s.emoji}</span>
                  <span className="mt-1 text-[10px] font-bold text-selva-900">{s.number}</span>
                  <span className="text-[10px] leading-tight text-black/60">{s.name}</span>
                </button>
              );
            })}
          </div>
        </section>

        <section className="card p-4">
          <h2 className="mb-3 font-semibold text-selva-900">3. Monto por jugada</h2>
          <div className="flex flex-wrap items-end gap-3">
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
            <div className="w-36">
              <input className="input text-right tabular-nums" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} aria-label="Monto por jugada" />
            </div>
            <button
              className="btn-primary"
              disabled={!!amountError || selectedDraws.length === 0 || selectedSymbols.length === 0}
              onClick={addToCart}
            >
              Agregar {selectedDraws.length * selectedSymbols.length || ''} jugada{selectedDraws.length * selectedSymbols.length === 1 ? '' : 's'}
            </button>
          </div>
          <p className="mt-2 text-xs text-black/50">
            {amountError ?? `Si acierta, cada jugada paga ${money(((amountMinor ?? 0n) * BigInt(Math.round(multiplier * 100))) / 100n, currency)}.`}{' '}
            Límites: {money(limits.min_play, currency)} – {money(limits.max_play, currency)} por jugada.
          </p>
        </section>
      </div>

      <aside className="lg:sticky lg:top-20 lg:self-start">
        <div className="card p-4">
          <h2 className="mb-3 font-semibold text-selva-900">Tu ticket</h2>
          {cart.length === 0 ? (
            <p className="py-6 text-center text-sm text-black/40">Agrega jugadas para armar tu ticket.</p>
          ) : (
            <ul className="mb-3 max-h-80 divide-y divide-black/5 overflow-y-auto">
              {cart.map((p) => {
                const s = symbolById.get(p.symbolId)!;
                const d = drawById.get(p.drawId) as Draw;
                return (
                  <li key={p.drawId + p.symbolId} className="flex items-center gap-2 py-2 text-sm">
                    <span className="text-xl">{s.emoji}</span>
                    <div className="flex-1">
                      <div className="font-medium">
                        {s.number} {s.name}
                      </div>
                      <div className="text-xs text-black/50">Sorteo {d ? hour(d.draw_at) : ''}</div>
                    </div>
                    <span className="tabular-nums">{money(toMinor(p.amount, currency) ?? 0n, currency)}</span>
                    <button
                      className="px-1 text-black/30 hover:text-red-600"
                      aria-label="Quitar jugada"
                      onClick={() => {
                        setCart(cart.filter((x) => x !== p));
                        setIdemKey(crypto.randomUUID());
                      }}
                    >
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
              <span className="font-bold tabular-nums">{money(total, currency)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-black/60">Premio máximo</span>
              <span className="font-semibold text-selva-700 tabular-nums">{money(maxWin, currency)}</span>
            </div>
          </div>
          <div className="mt-3 space-y-2">
            <ErrorBox error={buy.error} />
            {user?.kind === 'PLAYER' ? (
              <button className="btn-gold w-full py-3 text-base" disabled={cart.length === 0 || buy.isPending} onClick={() => buy.mutate()}>
                {buy.isPending ? 'Procesando…' : 'Comprar ticket'}
              </button>
            ) : user ? (
              <Notice tone="warn">Las cuentas de staff no pueden apostar.</Notice>
            ) : (
              <Link to="/login" className="btn-gold w-full py-3">
                Entra para comprar
              </Link>
            )}
            {cart.length > 0 && (
              <button className="btn-ghost w-full" onClick={() => setCart([])}>
                Vaciar ticket
              </button>
            )}
          </div>
        </div>
      </aside>

      <Modal open={!!receipt} onClose={() => setReceipt(null)} title="¡Ticket comprado!">
        {receipt && <TicketView ticket={receipt} />}
      </Modal>
    </div>
  );
}
