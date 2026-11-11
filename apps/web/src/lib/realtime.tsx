import { QueryKey, useQueryClient } from '@tanstack/react-query';
import { createContext, ReactNode, useContext, useEffect, useState } from 'react';
import { io } from 'socket.io-client';
import { getAccessToken, refreshSession } from './api';
import { useAuth } from './auth';
import { syncServerClock } from './format';

/**
 * Tiempo real (Socket.IO). El servidor solo avisa "algo cambió"; aquí se invalidan las consultas
 * afectadas y TanStack Query vuelve a pedir el dato al API, que sigue siendo la fuente de verdad.
 */
const EVENT_KEYS: Record<string, (data: any) => QueryKey[]> = {
  // Público (lobby)
  draw: (d) => [['draws', d.gameId], ['verify', d.id], ['admin', 'draws'], ['admin', 'dashboard'], ['admin', 'next-band', d.gameId], ['tickets']],
  'game-availability': (d) => [['games'], ['admin', 'games'], ['draws', d.gameId], ['admin', 'draws', d.gameId], ['admin', 'dashboard']],
  'futures-availability': () => [['platform']],
  sports: () => [['sports'], ['admin', 'sports']],
  odds: () => [['sports', 'events'], ['admin', 'sports']],
  // Jugador
  balance: () => [['balances'], ['transactions']],
  ticket: () => [['tickets']],
  bet: () => [['sports', 'bets']],
  deposit: () => [['deposits'], ['kyc']],
  withdrawal: () => [['withdrawals'], ['kyc']],
  kyc: () => [['kyc'], ['me']],
  // Staff
  queue: (d) => [['admin', d.kind], ['admin', 'dashboard'], ...(d.kind === 'results' ? [['admin', 'draws']] : [])],
  exposure: () => [['admin', 'exposure'], ['admin', 'dashboard']],
  'sports-exposure': () => [['admin', 'sports'], ['admin', 'dashboard']],
};

export type LinkState = 'connecting' | 'live' | 'offline';
const RealtimeContext = createContext<LinkState>('connecting');

export function RealtimeProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const { user } = useAuth();
  const [state, setState] = useState<LinkState>('connecting');

  useEffect(() => {
    const socket = io({
      path: '/api/v1/socket.io',
      transports: ['websocket'],
      autoConnect: false,
      // Función: en cada reconexión se envía el token vigente.
      auth: (cb) => cb(user ? { token: getAccessToken() } : {}),
    });
    const resync = () => qc.invalidateQueries();
    socket.on('hello', (d: { serverNow: string }) => {
      syncServerClock(d.serverNow);
      setState('live');
    });
    // Tras reconectar pudo haberse perdido algún aviso: refrescar todo lo visible.
    socket.io.on('reconnect', resync);
    socket.on('resync', resync);
    socket.on('disconnect', async (reason) => {
      setState('offline');
      // El servidor corta al vencer el token: renovar y volver a conectar.
      if (reason === 'io server disconnect' && user && (await refreshSession())) socket.connect();
    });
    socket.on('connect_error', async (err) => {
      setState('offline');
      if (err.message === 'UNAUTHENTICATED' && user && (await refreshSession())) socket.connect();
    });
    socket.onAny((event: string, data: unknown) => {
      for (const queryKey of EVENT_KEYS[event]?.(data ?? {}) ?? []) qc.invalidateQueries({ queryKey });
    });
    // StrictMode monta y desmonta el efecto antes de montarlo otra vez en desarrollo.
    // Esperar un turno evita abrir un WebSocket que se cancela durante el handshake.
    const connectTimer = setTimeout(() => socket.connect(), 0);
    return () => {
      clearTimeout(connectTimer);
      socket.close();
    };
  }, [qc, user?.id]);

  return <RealtimeContext.Provider value={state}>{children}</RealtimeContext.Provider>;
}

export const useRealtime = () => useContext(RealtimeContext);

/** Indicador de conexión en vivo para la cabecera. */
export function LiveDot({ dark }: { dark?: boolean }) {
  const state = useRealtime();
  const color = state === 'live' ? 'bg-emerald-400' : state === 'connecting' ? 'bg-amber-400' : 'bg-red-500';
  const label = state === 'live' ? 'En vivo' : state === 'connecting' ? 'Conectando…' : 'Sin conexión en vivo';
  return (
    <span className={`flex items-center gap-1.5 text-xs ${dark ? 'text-white/70' : 'text-black/50'}`} title={label}>
      <span className={`relative flex h-2 w-2`}>
        {state === 'live' && <span className={`absolute inline-flex h-full w-full animate-ping rounded-full ${color} opacity-60`} />}
        <span className={`relative inline-flex h-2 w-2 rounded-full ${color}`} />
      </span>
      <span className="hidden sm:inline">{label}</span>
    </span>
  );
}
