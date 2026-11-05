import { Logger, OnModuleDestroy } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { OnGatewayConnection, OnGatewayInit, WebSocketGateway, WebSocketServer } from '@nestjs/websockets';
import { Client } from 'pg';
import { Server, Socket } from 'socket.io';
import { REALTIME_CHANNEL } from '../common/realtime';
import { config } from '../config';
import type { AuthUser, Role } from '../identity/auth.guard';

/**
 * WebSocket (Socket.IO) para avisos en tiempo real (Doc. Maestro §18.2).
 * Recibe las notificaciones de Postgres (LISTEN) y las reenvía a la sala correspondiente.
 * Conexión anónima → solo `lobby`; con token de acceso → además `player:<id>` o `staff`.
 */
@WebSocketGateway({ path: '/api/v1/socket.io', cors: false, serveClient: false })
export class RealtimeGateway implements OnGatewayInit, OnGatewayConnection, OnModuleDestroy {
  @WebSocketServer() server: Server;
  private readonly log = new Logger('Realtime');
  private listener: Client | null = null;
  private stopped = false;

  constructor(private readonly jwt: JwtService) {}

  afterInit(server: Server) {
    // Un token inválido o vencido rechaza la conexión para que el cliente renueve sesión y reintente.
    server.use(async (socket, next) => {
      const token = socket.handshake.auth?.token;
      if (!token) return next();
      try {
        const p = await this.jwt.verifyAsync<{ sub: string; role: Role; kind: AuthUser['kind']; exp: number }>(token);
        socket.data.user = { id: p.sub, role: p.role, kind: p.kind } satisfies AuthUser;
        socket.data.exp = p.exp;
        next();
      } catch {
        next(new Error('UNAUTHENTICATED'));
      }
    });
    void this.listen();
  }

  handleConnection(socket: Socket) {
    socket.join('lobby');
    const user: AuthUser | undefined = socket.data.user;
    if (user) {
      socket.join(user.kind === 'PLAYER' ? `player:${user.id}` : 'staff');
      // Al vencer el token se corta la conexión; el cliente renueva y se reconecta.
      const ms = socket.data.exp * 1000 - Date.now();
      const timer = setTimeout(() => socket.disconnect(true), Math.max(ms, 0));
      socket.on('disconnect', () => clearTimeout(timer));
    }
    socket.emit('hello', { serverNow: new Date().toISOString(), authenticated: !!user });
  }

  private async listen() {
    while (!this.stopped) {
      const client = new Client({ connectionString: config.databaseUrl });
      try {
        await client.connect();
        await client.query(`LISTEN ${REALTIME_CHANNEL}`);
        this.listener = client;
        this.log.log('Escuchando notificaciones de la base de datos');
        client.on('notification', (msg) => {
          try {
            const { room, event, data } = JSON.parse(msg.payload ?? '{}');
            if (typeof room === 'string' && typeof event === 'string') this.server.to(room).emit(event, data ?? {});
          } catch (err) {
            this.log.warn(`Notificación inválida: ${(err as Error).message}`);
          }
        });
        await new Promise<void>((resolve) => {
          client.once('error', (err) => {
            this.log.error(`Conexión LISTEN perdida: ${err.message}`);
            resolve();
          });
          client.once('end', () => resolve());
        });
      } catch (err) {
        this.log.error(`No se pudo escuchar notificaciones: ${(err as Error).message}`);
      } finally {
        this.listener = null;
        await client.end().catch(() => undefined);
      }
      if (!this.stopped) {
        // Los clientes refrescan sus datos al reconectar, así que un hueco breve no pierde estado.
        this.server.emit('resync', {});
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
  }

  async onModuleDestroy() {
    this.stopped = true;
    await this.listener?.end().catch(() => undefined);
  }
}
