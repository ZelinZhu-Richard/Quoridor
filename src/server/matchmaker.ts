import { DurableObject } from 'cloudflare:workers';
import { queueCommandSchema } from '../shared/protocol';
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
  newCode,
  parseJson,
  safeSend,
  type AppEnv,
  type Guest,
} from './common';
type Attachment = { guest: Guest; connectionId: string; lastMessage: number };
type QueueRow = { seq: number; guest_id: string; guest: string; connection_id: string };
type Assignment = {
  id: string;
  code: string;
  guests: [Guest, Guest];
  status: 'reserved' | 'ready';
  createdAt: number;
};
export class Matchmaker extends DurableObject<AppEnv> {
  private draining: Promise<void> | null = null;
  private inflight = new Map<string, Promise<Assignment | null>>();
  constructor(ctx: DurableObjectState, env: AppEnv) {
    super(ctx, env);
    ctx.storage.sql.exec(
      'CREATE TABLE IF NOT EXISTS queue (seq INTEGER PRIMARY KEY AUTOINCREMENT, guest_id TEXT NOT NULL UNIQUE, guest TEXT NOT NULL, connection_id TEXT NOT NULL)',
    );
    ctx.storage.sql.exec(
      'CREATE TABLE IF NOT EXISTS assignments (id TEXT PRIMARY KEY, a TEXT NOT NULL UNIQUE, b TEXT NOT NULL UNIQUE, data TEXT NOT NULL)',
    );
    initializeLimits(ctx.storage.sql);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }
  private assignments() {
    return this.ctx.storage.sql
      .exec<{ data: string }>('SELECT data FROM assignments')
      .toArray()
      .map((r) => JSON.parse(r.data) as Assignment);
  }
  private assignmentFor(id: string) {
    const row = this.ctx.storage.sql
      .exec<{ data: string }>('SELECT data FROM assignments WHERE a=? OR b=?', id, id)
      .toArray()[0];
    return row ? (JSON.parse(row.data) as Assignment) : null;
  }
  private readAssignment(id: string) {
    const row = this.ctx.storage.sql
      .exec<{ data: string }>('SELECT data FROM assignments WHERE id=?', id)
      .toArray()[0];
    return row ? (JSON.parse(row.data) as Assignment) : null;
  }
  private liveSockets() {
    return this.ctx.getWebSockets().filter((ws) => {
      const a = ws.deserializeAttachment() as Attachment;
      const last = Math.max(
        a.lastMessage,
        this.ctx.getWebSocketAutoResponseTimestamp(ws)?.getTime() ?? 0,
      );
      return (
        ws.readyState === WebSocket.OPEN &&
        Date.now() - last <= HEARTBEAT_TIMEOUT &&
        a.guest.exp > Date.now()
      );
    });
  }
  private notify(assignment: Assignment) {
    for (const ws of this.liveSockets()) {
      const a = ws.deserializeAttachment() as Attachment;
      if (assignment.guests.some((g) => g.id === a.guest.id))
        safeSend(ws, { type: 'MATCHED', code: assignment.code });
    }
  }
  private schedule() {
    this.ctx.waitUntil(this.ctx.storage.setAlarm(Date.now() + 30000));
  }
  fetch(req: Request) {
    const result = guestSchema.safeParse(parseJson(req.headers.get('X-Guest') ?? '{}'));
    if (!result.success || result.data.exp <= Date.now())
      return new Response('Unauthorized', { status: 401 });
    const guest = result.data;
    for (const ws of this.ctx.getWebSockets())
      if ((ws.deserializeAttachment() as Attachment).guest.id === guest.id) {
        safeSend(ws, { type: 'REPLACED' });
        closeSocket(ws, 4001, 'Queue opened in another tab');
      }
    const pair = new WebSocketPair(),
      [client, server] = Object.values(pair),
      connectionId = crypto.randomUUID();
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({
      guest,
      connectionId,
      lastMessage: Date.now(),
    } satisfies Attachment);
    this.ctx.storage.sql.exec(
      'UPDATE queue SET connection_id=?, guest=? WHERE guest_id=?',
      connectionId,
      JSON.stringify(guest),
      guest.id,
    );
    this.schedule();
    return new Response(null, { status: 101, webSocket: client });
  }
  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer) {
    try {
      const a = ws.deserializeAttachment() as Attachment;
      if (a.guest.exp <= Date.now() || ws.readyState !== WebSocket.OPEN)
        throw new HttpError(401, 'UNAUTHORIZED', 'Reload to renew your guest session.');
      // Closed/replaced queue sockets cannot re-enqueue through delayed messages.
      const current = this.ctx
        .getWebSockets()
        .filter(
          (s) =>
            (s.deserializeAttachment() as Attachment).guest.id === a.guest.id &&
            s.readyState === WebSocket.OPEN,
        );
      if (current.length !== 1 || current[0] !== ws)
        throw new HttpError(403, 'REPLACED', 'Matchmaking is open in another tab.');
      consumeRate(this.ctx.storage.sql, a.guest.id, 12, 10000);
      const result = queueCommandSchema.safeParse(parseJson(messageText(raw)));
      if (!result.success)
        throw new HttpError(
          400,
          'BAD_MESSAGE',
          'Refresh Linebreak to use the current matchmaking protocol.',
        );
      a.lastMessage = Date.now();
      ws.serializeAttachment(a);
      const existing = this.assignmentFor(a.guest.id);
      if (existing) {
        const ready = await this.ensureReady(existing.id);
        if (ready) this.notify(ready);
        return;
      }
      if (result.data.type === 'CANCEL') {
        this.ctx.storage.sql.exec('DELETE FROM queue WHERE guest_id=?', a.guest.id);
        safeSend(ws, { type: 'CANCELLED' });
        return;
      }
      this.ctx.storage.sql.exec(
        'INSERT INTO queue(guest_id,guest,connection_id) VALUES(?,?,?) ON CONFLICT(guest_id) DO UPDATE SET guest=excluded.guest, connection_id=excluded.connection_id',
        a.guest.id,
        JSON.stringify(a.guest),
        a.connectionId,
      );
      safeSend(ws, { type: 'QUEUED' });
      this.schedule();
      await this.drain();
    } catch (error) {
      safeSend(ws, { type: 'ERROR', ...errorMessage(error) });
      this.schedule();
    }
  }
  private ensureReady(id: string): Promise<Assignment | null> {
    const existing = this.inflight.get(id);
    if (existing) return existing;
    const work = this.initializeAssignment(id).finally(() => this.inflight.delete(id));
    this.inflight.set(id, work);
    return work;
  }
  private async initializeAssignment(id: string) {
    let assignment = this.readAssignment(id);
    if (!assignment) return null;
    if (assignment.status === 'ready') return assignment;
    for (let attempt = 0; attempt < 5; attempt++) {
      if (
        await this.env.ROOMS.getByName(assignment.code).initialize(
          assignment.code,
          'random',
          assignment.guests,
          assignment.id,
        )
      ) {
        assignment.status = 'ready';
        this.ctx.storage.sql.exec(
          'UPDATE assignments SET data=? WHERE id=?',
          JSON.stringify(assignment),
          id,
        );
        return assignment;
      }
      assignment.code = newCode();
      this.ctx.storage.sql.exec(
        'UPDATE assignments SET data=? WHERE id=?',
        JSON.stringify(assignment),
        id,
      );
    }
    throw new HttpError(503, 'MATCH_RETRY', 'Could not open your match yet. Retrying.');
  }
  private pruneQueue() {
    const live = this.liveSockets(),
      ids = new Set(live.map((ws) => (ws.deserializeAttachment() as Attachment).connectionId));
    for (const row of this.ctx.storage.sql.exec<QueueRow>('SELECT * FROM queue').toArray())
      if (!ids.has(row.connection_id))
        this.ctx.storage.sql.exec('DELETE FROM queue WHERE guest_id=?', row.guest_id);
    for (const ws of this.ctx.getWebSockets())
      if (!live.includes(ws)) closeSocket(ws, 4000, 'Queue connection timed out');
  }
  private drain() {
    if (this.draining) return this.draining;
    this.draining = this.drainLoop().finally(() => {
      this.draining = null;
    });
    return this.draining;
  }
  private async drainLoop() {
    for (const reservation of this.assignments().filter((a) => a.status === 'reserved')) {
      const ready = await this.ensureReady(reservation.id);
      if (ready) this.notify(ready);
    }
    while (true) {
      this.pruneQueue();
      const rows = this.ctx.storage.sql
        .exec<QueueRow>('SELECT * FROM queue ORDER BY seq LIMIT 2')
        .toArray();
      if (rows.length < 2) break;
      const reservation: Assignment = {
        id: crypto.randomUUID(),
        code: newCode(),
        guests: [JSON.parse(rows[0].guest), JSON.parse(rows[1].guest)],
        status: 'reserved',
        createdAt: Date.now(),
      };
      this.ctx.storage.transactionSync(() => {
        this.ctx.storage.sql.exec(
          'DELETE FROM queue WHERE guest_id IN (?,?)',
          rows[0].guest_id,
          rows[1].guest_id,
        );
        this.ctx.storage.sql.exec(
          'INSERT INTO assignments(id,a,b,data) VALUES(?,?,?,?)',
          reservation.id,
          rows[0].guest_id,
          rows[1].guest_id,
          JSON.stringify(reservation),
        );
      });
      this.schedule();
      const ready = await this.ensureReady(reservation.id);
      if (ready) this.notify(ready);
    }
  }
  finishAssignment(id: string) {
    this.ctx.storage.sql.exec('DELETE FROM assignments WHERE id=?', id);
  }
  webSocketClose(ws: WebSocket) {
    const a = ws.deserializeAttachment() as Attachment;
    this.ctx.storage.sql.exec(
      'DELETE FROM queue WHERE guest_id=? AND connection_id=?',
      a.guest.id,
      a.connectionId,
    );
  }
  webSocketError(ws: WebSocket) {
    closeSocket(ws, 1011, 'Connection error');
    this.webSocketClose(ws);
  }
  async alarm() {
    this.pruneQueue();
    await this.drain();
    for (const assignment of this.assignments())
      if (Date.now() - assignment.createdAt > DAY) this.finishAssignment(assignment.id);
    this.ctx.storage.sql.exec('DELETE FROM limits WHERE reset_at < ?', Date.now() - DAY);
    const count = this.ctx.storage.sql
      .exec<{ count: number }>('SELECT count(*) AS count FROM queue')
      .one().count;
    if (count || this.assignments().length || this.ctx.getWebSockets().length) this.schedule();
  }
}
