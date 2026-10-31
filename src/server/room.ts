import { DurableObject } from 'cloudflare:workers';
import { applyAction, initializeGame, other, type GameState, type Player } from '@linebreak/rules';
import { commandSchema, type Snapshot } from '../shared/protocol';
import {
  closeSocket,
  consumeRate,
  DAY,
  errorMessage,
  guestSchema,
  HEARTBEAT_TIMEOUT,
  HttpError,
  initializeLimits,
  messageText,
  parseJson,
  safeSend,
  type AppEnv,
  type Guest,
} from './common';

type Seat = {
  guest: Guest;
  connected: boolean;
  connectionId: string | null;
  disconnectedAt: number | null;
};
export type RoomRecord = {
  code: string;
  kind: 'private' | 'random';
  initializationId: string;
  status: Snapshot['status'];
  roundId: string;
  version: number;
  game: GameState;
  seats: { A: Seat; B: Seat | null };
  rematch: { A: boolean; B: boolean };
  createdAt: number;
  lastActivity: number;
  expiresAt: number;
  cancellationReason: string | null;
};
type Attachment = {
  player: Player;
  guestId: string;
  connectionId: string;
  createdAt: number;
  lastMessage: number;
  expiresAt: number;
};
const seat = (guest: Guest): Seat => ({
  guest,
  connected: false,
  connectionId: null,
  disconnectedAt: null,
});
const success = <T extends object>(value: T) => ({ ok: true as const, ...value });
const failure = (status: number, code: string, message: string) => ({
  ok: false as const,
  status,
  code,
  message,
});
export class GameRoom extends DurableObject<AppEnv> {
  private erased = false;
  constructor(ctx: DurableObjectState, env: AppEnv) {
    super(ctx, env);
    this.initializeTables();
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }
  private initializeTables() {
    this.ctx.storage.sql.exec(
      'CREATE TABLE IF NOT EXISTS room (id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL)',
    );
    this.ctx.storage.sql.exec(
      'CREATE TABLE IF NOT EXISTS receipts (guest_id TEXT NOT NULL, action_id TEXT NOT NULL, payload TEXT NOT NULL, version INTEGER NOT NULL, PRIMARY KEY(guest_id,action_id))',
    );
    initializeLimits(this.ctx.storage.sql);
    this.erased = false;
  }
  private read(): RoomRecord | null {
    if (this.erased) return null;
    return (
      this.ctx.storage.sql
        .exec<{ data: string }>('SELECT data FROM room WHERE id=1')
        .toArray()
        .map((row) => JSON.parse(row.data) as RoomRecord)[0] ?? null
    );
  }
  private save(room: RoomRecord) {
    this.ctx.storage.sql.exec(
      'INSERT INTO room(id,data) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data',
      JSON.stringify(room),
    );
  }
  private schedule(room: RoomRecord) {
    const hasConnections = this.ctx.getWebSockets().length > 0;
    const next =
      room.status === 'waiting' && room.kind === 'random'
        ? Math.min(room.createdAt + 60000, Date.now() + 30000)
        : hasConnections
          ? Date.now() + 30000
          : room.expiresAt;
    this.ctx.waitUntil(
      this.ctx.storage.setAlarm(Math.max(Date.now() + 1000, Math.min(next, room.expiresAt))),
    );
  }
  initialize(
    code: string,
    kind: 'private' | 'random',
    guests: Guest[],
    initializationId: string,
  ): boolean {
    if (this.erased) this.initializeTables();
    const existing = this.read();
    if (existing) return existing.initializationId === initializationId;
    const now = Date.now();
    const room: RoomRecord = {
      code,
      kind,
      initializationId,
      status: 'waiting',
      roundId: crypto.randomUUID(),
      version: 0,
      game: initializeGame(),
      seats: {
        A: seat(guestSchema.parse(guests[0])),
        B: guests[1] ? seat(guestSchema.parse(guests[1])) : null,
      },
      rematch: { A: false, B: false },
      createdAt: now,
      lastActivity: now,
      expiresAt: now + (kind === 'private' ? DAY : 7 * DAY),
      cancellationReason: null,
    };
    this.save(room);
    this.schedule(room);
    return true;
  }
  join(guest: Guest) {
    const room = this.read();
    if (!room) return failure(404, 'ROOM_NOT_FOUND', 'That room does not exist. Check the code.');
    if (room.expiresAt <= Date.now())
      return failure(410, 'ROOM_EXPIRED', 'This room expired. Create a new room.');
    const existing = this.playerFor(room, guest.id);
    if (existing) return success({ code: room.code, seat: existing });
    if (room.status !== 'waiting' || room.seats.B || room.kind !== 'private')
      return failure(403, 'ROOM_FULL', 'Both seats belong to other players. Create a new room.');
    room.seats.B = seat(guestSchema.parse(guest));
    room.version++;
    this.save(room);
    this.broadcast(room);
    return success({ code: room.code, seat: 'B' as const });
  }
  private playerFor(room: RoomRecord, id: string): Player | null {
    return room.seats.A.guest.id === id ? 'A' : room.seats.B?.guest.id === id ? 'B' : null;
  }
  private snapshot(room: RoomRecord, you: Player): Snapshot {
    const publicSeat = (value: Seat, player: Player) => ({
      name: value.guest.name || `Player ${player}`,
      connected: value.connected,
      disconnectedAt: value.disconnectedAt,
    });
    return {
      code: room.code,
      kind: room.kind,
      status: room.status,
      roundId: room.roundId,
      version: room.version,
      game: room.game,
      players: {
        A: publicSeat(room.seats.A, 'A'),
        B: room.seats.B ? publicSeat(room.seats.B, 'B') : null,
      },
      rematch: room.rematch,
      you,
      expiresAt: room.expiresAt,
      cancellationReason: room.cancellationReason,
    };
  }
  private broadcast(room: RoomRecord) {
    for (const ws of this.ctx.getWebSockets()) {
      const a = ws.deserializeAttachment() as Attachment;
      if (room.seats[a.player]?.connectionId === a.connectionId)
        safeSend(ws, { type: 'STATE', state: this.snapshot(room, a.player) });
    }
  }
  private reconcile(room: RoomRecord) {
    let changed = false;
    for (const player of ['A', 'B'] as const) {
      const value = room.seats[player];
      if (!value) continue;
      const socket = this.ctx.getWebSockets().find((ws) => {
        const a = ws.deserializeAttachment() as Attachment;
        return a.connectionId === value.connectionId && ws.readyState === WebSocket.OPEN;
      });
      let alive = false;
      if (socket) {
        const a = socket.deserializeAttachment() as Attachment;
        const last = Math.max(
          a.lastMessage,
          this.ctx.getWebSocketAutoResponseTimestamp(socket)?.getTime() ?? 0,
        );
        alive = Date.now() - last <= HEARTBEAT_TIMEOUT && a.expiresAt > Date.now();
        if (!alive) closeSocket(socket, 4000, 'Connection timed out');
      }
      if (value.connected !== alive) {
        value.connected = alive;
        value.disconnectedAt = alive ? null : Date.now();
        changed = true;
      }
    }
    if (changed) {
      room.version++;
      this.save(room);
    }
    return changed;
  }
  async fetch(req: Request) {
    const guest = guestSchema.safeParse(parseJson(req.headers.get('X-Guest') ?? '{}'));
    if (!guest.success || guest.data.exp <= Date.now())
      return new Response('Unauthorized', { status: 401 });
    const room = this.read();
    if (!room || room.expiresAt <= Date.now())
      return new Response('Room expired or missing', { status: 404 });
    const player = this.playerFor(room, guest.data.id);
    if (!player) return new Response('Unauthorized seat', { status: 403 });
    this.reconcile(room);
    const value = room.seats[player]!;
    for (const socket of this.ctx.getWebSockets()) {
      const a = socket.deserializeAttachment() as Attachment;
      if (a.player === player) {
        safeSend(socket, { type: 'REPLACED' });
        closeSocket(socket, 4001, 'Seat opened in another tab');
      }
    }
    const pair = new WebSocketPair(),
      [client, server] = Object.values(pair),
      now = Date.now(),
      connectionId = crypto.randomUUID();
    this.ctx.acceptWebSocket(server, [player]);
    server.serializeAttachment({
      player,
      guestId: guest.data.id,
      connectionId,
      createdAt: now,
      lastMessage: now,
      expiresAt: guest.data.exp,
    } satisfies Attachment);
    value.connected = true;
    value.connectionId = connectionId;
    value.disconnectedAt = null;
    value.guest.exp = guest.data.exp;
    if (room.status === 'waiting' && room.seats.A.connected && room.seats.B?.connected) {
      room.status = 'active';
      room.expiresAt = now + 7 * DAY;
      room.lastActivity = now;
      if (room.kind === 'random')
        this.ctx.waitUntil(
          this.env.MATCHMAKER.getByName('global-v1').finishAssignment(room.initializationId),
        );
    }
    room.version++;
    this.save(room);
    this.broadcast(room);
    this.schedule(room);
    return new Response(null, { status: 101, webSocket: client });
  }
  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    const attachment = ws.deserializeAttachment() as Attachment;
    let actionId: string | undefined;
    try {
      let room = this.read();
      if (!room || room.expiresAt <= Date.now())
        throw new HttpError(410, 'ROOM_EXPIRED', 'This room expired. Start a new game.');
      if (
        room.seats[attachment.player]?.connectionId !== attachment.connectionId ||
        attachment.expiresAt <= Date.now()
      )
        throw new HttpError(403, 'UNAUTHORIZED', 'This connection no longer controls this seat.');
      consumeRate(this.ctx.storage.sql, attachment.guestId);
      const parsed = commandSchema.safeParse(parseJson(messageText(message)));
      if (!parsed.success)
        throw new HttpError(
          400,
          'BAD_ACTION',
          'Send a valid action with a round, version, and action ID.',
        );
      const command = parsed.data;
      actionId = command.actionId;
      attachment.lastMessage = Date.now();
      ws.serializeAttachment(attachment);
      const presenceChanged = this.reconcile(room);
      if (presenceChanged) this.broadcast(room);
      const payload = JSON.stringify(command);
      const receipt = this.ctx.storage.sql
        .exec<{ payload: string; version: number }>(
          'SELECT payload,version FROM receipts WHERE guest_id=? AND action_id=?',
          attachment.guestId,
          command.actionId,
        )
        .toArray()[0];
      if (receipt) {
        if (receipt.payload !== payload)
          throw new HttpError(
            409,
            'ACTION_ID_REUSED',
            'That action ID has already been used for a different action.',
          );
        safeSend(ws, { type: 'ACK', actionId, version: receipt.version });
        safeSend(ws, { type: 'STATE', state: this.snapshot(room, attachment.player) });
        return;
      }
      if (room.roundId !== command.roundId)
        throw new HttpError(
          409,
          'WRONG_ROUND',
          'A new round has started. Choose your action again.',
        );
      if (room.version !== command.expectedVersion)
        throw new HttpError(
          409,
          'STALE_VERSION',
          'The board changed. Check the updated position and try again.',
        );
      const player = attachment.player,
        action = command.action;
      this.ctx.storage.transactionSync(() => {
        // No asynchronous work between checking the version and persisting the state + receipt.
        if (action.type === 'REQUEST_REMATCH') {
          if (room!.status !== 'finished')
            throw new HttpError(
              409,
              'NOT_FINISHED',
              'Finish this round before requesting a rematch.',
            );
          room!.rematch[player] = true;
          if (room!.rematch.A && room!.rematch.B) {
            room!.game = initializeGame();
            room!.roundId = crypto.randomUUID();
            room!.rematch = { A: false, B: false };
            room!.status = 'active';
          }
        } else if (action.type === 'CLAIM_DISCONNECT_WIN') {
          const opponent = room!.seats[other(player)];
          if (
            room!.status !== 'active' ||
            !room!.seats[player]?.connected ||
            !opponent ||
            opponent.connected ||
            opponent.disconnectedAt === null ||
            Date.now() - opponent.disconnectedAt < 90000
          )
            throw new HttpError(
              409,
              'TOO_EARLY',
              'Wait 90 seconds while your opponent is disconnected before claiming a win.',
            );
          room!.game = { ...room!.game, winner: player, endReason: 'disconnect' };
          room!.status = 'finished';
        } else {
          if (room!.status !== 'active')
            throw new HttpError(
              409,
              'NOT_ACTIVE',
              'Wait until both players join, or start a new round.',
            );
          if (action.type !== 'RESIGN' && (!room!.seats.A.connected || !room!.seats.B?.connected))
            throw new HttpError(
              409,
              'PAUSED',
              'The game is paused until your opponent reconnects.',
            );
          room!.game = applyAction(room!.game, player, action);
          if (room!.game.winner) room!.status = 'finished';
        }
        room!.version++;
        room!.lastActivity = Date.now();
        room!.expiresAt = Date.now() + 7 * DAY;
        this.save(room!);
        this.ctx.storage.sql.exec(
          'INSERT INTO receipts(guest_id,action_id,payload,version) VALUES(?,?,?,?)',
          attachment.guestId,
          command.actionId,
          payload,
          room!.version,
        );
      });
      safeSend(ws, { type: 'ACK', actionId, version: room.version });
      this.broadcast(room);
      this.schedule(room);
    } catch (error) {
      safeSend(ws, { type: 'ERROR', ...errorMessage(error), ...(actionId ? { actionId } : {}) });
      const room = this.read();
      if (room && room.seats[attachment.player]?.connectionId === attachment.connectionId)
        safeSend(ws, { type: 'STATE', state: this.snapshot(room, attachment.player) });
    }
  }
  webSocketClose(ws: WebSocket) {
    this.disconnected(ws);
  }
  webSocketError(ws: WebSocket) {
    closeSocket(ws, 1011, 'Connection error');
    this.disconnected(ws);
  }
  private disconnected(ws: WebSocket) {
    const attachment = ws.deserializeAttachment() as Attachment,
      room = this.read();
    if (!room) return;
    const value = room.seats[attachment.player];
    if (value?.connectionId !== attachment.connectionId) return;
    if (value.connected) {
      value.connected = false;
      value.disconnectedAt = Date.now();
      room.version++;
      this.save(room);
      this.broadcast(room);
    }
    this.schedule(room);
  }
  async alarm() {
    const room = this.read();
    if (!room) return;
    if (Date.now() >= room.expiresAt) {
      for (const ws of this.ctx.getWebSockets()) closeSocket(ws, 4004, 'Room expired');
      if (room.kind === 'random')
        await this.env.MATCHMAKER.getByName('global-v1').finishAssignment(room.initializationId);
      // deleteAll also drops SQL tables. Late socket-close events must not query them.
      this.erased = true;
      await this.ctx.storage.deleteAll();
      return;
    }
    const changed = this.reconcile(room);
    if (
      room.kind === 'random' &&
      room.status === 'waiting' &&
      Date.now() - room.createdAt >= 60000
    ) {
      room.status = 'cancelled';
      room.cancellationReason = 'Opponent did not connect in time.';
      room.version++;
      room.expiresAt = Date.now() + DAY;
      this.save(room);
    }
    if (room.kind === 'random' && room.status !== 'waiting')
      await this.env.MATCHMAKER.getByName('global-v1').finishAssignment(room.initializationId);
    if (changed || room.status === 'cancelled') this.broadcast(room);
    this.ctx.storage.sql.exec('DELETE FROM limits WHERE reset_at < ?', Date.now() - DAY);
    this.schedule(room);
  }
}
