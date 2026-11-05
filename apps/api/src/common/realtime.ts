import { Db } from './db.service';

export const REALTIME_CHANNEL = 'realtime';

/** Salas: `lobby` (público: sorteos y deportes), `player:<id>` (saldo, tickets, apuestas, KYC) y `staff` (colas del backoffice). */
export type Room = 'lobby' | 'staff' | `player:${string}`;

/**
 * Publica una notificación en tiempo real con pg_notify. Dentro de una transacción, Postgres solo la
 * entrega al hacer COMMIT, así que nadie se entera de cambios que terminaron en ROLLBACK.
 * Cada instancia del API escucha el canal y reenvía a sus sockets (sirve de fan-out sin Redis).
 * Los mensajes son avisos pequeños: el cliente vuelve a pedir el dato al API, que es la fuente de verdad.
 */
export async function publish(db: Db, room: Room, event: string, data: Record<string, unknown> = {}): Promise<void> {
  await db.query('SELECT pg_notify($1, $2)', [REALTIME_CHANNEL, JSON.stringify({ room, event, data })]);
}
