import { afterEach, describe, expect, it } from 'vitest';
import { env, exports as workers } from 'cloudflare:workers';
import {
  abortAllDurableObjects,
  evictAllDurableObjects,
  reset,
  runDurableObjectAlarm,
  runInDurableObject,
} from 'cloudflare:test';
import {
  RULESET,
  type Command,
  type ServerMessage,
  type Snapshot,
} from '../../src/shared/protocol';
import type { RoomRecord } from '../../src/server/room';
import type { Guest } from '../../src/server/common';

const sockets: WebSocket[] = [];
class Client {
  messages: ServerMessage[] = [];
  state: Snapshot | null = null;
  constructor(public ws: WebSocket) {
    sockets.push(ws);
    ws.accept();
    ws.addEventListener('message', (e) => {
      if (e.data === 'pong') return;
      const m = JSON.parse(e.data as string) as ServerMessage;
      this.messages.push(m);
      if (m.type === 'STATE') this.state = m.state;
    });
  }
  async next<T extends ServerMessage['type']>(
    type: T,
    predicate: (m: Extract<ServerMessage, { type: T }>) => boolean = () => true,
  ) {
    let message: Extract<ServerMessage, { type: T }> | undefined;
    await expect
      .poll(
        () => {
          const index = this.messages.findIndex(
            (m) => m.type === type && predicate(m as Extract<ServerMessage, { type: T }>),
          );
          if (index >= 0)
            message = this.messages.splice(index, 1)[0] as Extract<ServerMessage, { type: T }>;
          return !!message;
        },
        { timeout: 4000, interval: 5 },
      )
      .toBe(true);
    return message!;
  }
  command(action: Command['action'], overrides: Partial<Command> = {}) {
    if (!this.state) throw new Error('Missing state');
    const command: Command = {
      actionId: crypto.randomUUID(),
      roundId: this.state.roundId,
      expectedVersion: this.state.version,
      action,
      ...overrides,
    };
    this.ws.send(JSON.stringify(command));
    return command;
  }
}
const origin = 'http://localhost';
async function post(
  path: string,
  cookie = '',
  body: unknown = {},
  extra: Record<string, string> = {},
) {
  return workers.default.fetch(
    new Request(origin + '/api' + path, {
      method: 'POST',
      headers: {
        Origin: origin,
        'Content-Type': 'application/json',
        Cookie: cookie,
        'CF-Connecting-IP': crypto.randomUUID(),
        ...extra,
      },
      body: JSON.stringify(body),
    }),
  );
}
async function guest(name = '') {
  const response = await post('/session', '', { name });
  expect(response.status).toBe(200);
  return response.headers.get('Set-Cookie')!.split(';')[0];
}
async function connect(path: string, cookie: string) {
  const response = await workers.default.fetch(
    new Request(origin + '/api' + path, {
      headers: {
        Origin: origin,
        Upgrade: 'websocket',
        Cookie: cookie,
        'CF-Connecting-IP': crypto.randomUUID(),
      },
    }),
  );
  expect(response.status).toBe(101);
  return new Client(response.webSocket!);
}
async function privateGame() {
  const aCookie = await guest('Alice'),
    bCookie = await guest('Blair');
  const created = await post('/rooms', aCookie);
  expect(created.status).toBe(201);
  const { code } = (await created.json()) as { code: string };
  expect((await post(`/rooms/${code}/join`, bCookie)).status).toBe(200);
  const a = await connect(`/rooms/${code}/ws`, aCookie);
  await a.next('STATE');
  const b = await connect(`/rooms/${code}/ws`, bCookie);
  await b.next('STATE', (m) => m.state.status === 'active');
  await a.next('STATE', (m) => m.state.status === 'active');
  return { code, aCookie, bCookie, a, b };
}
async function editRoom(code: string, edit: (room: RoomRecord) => void) {
  await runInDurableObject(env.ROOMS.getByName(code), (_instance, ctx) => {
    const room = JSON.parse(
      ctx.storage.sql.exec<{ data: string }>('SELECT data FROM room').one().data,
    ) as RoomRecord;
    edit(room);
    ctx.storage.sql.exec('UPDATE room SET data=?', JSON.stringify(room));
  });
}
afterEach(async () => {
  for (const ws of sockets.splice(0))
    try {
      ws.close();
    } catch {}
  await abortAllDurableObjects();
  await reset();
});

describe('guest authentication and room authorization', () => {
  it('issues an HttpOnly credential, preserves identity and rejects invalid names', async () => {
    const response = await post('/session', '', { name: 'Alice' }),
      cookie = response.headers.get('Set-Cookie')!;
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');
    const first = cookie.split(';')[0],
      renewed = await post('/session', first, { name: 'New name' });
    const payload = (value: string) =>
      JSON.parse(atob(value.split('=')[1].split('.')[0].replace(/-/g, '+').replace(/_/g, '/')));
    expect(payload(renewed.headers.get('Set-Cookie')!).id).toBe(payload(first).id);
    expect((await post('/session', '', { name: 'x'.repeat(25) })).status).toBe(400);
  });
  it('rejects absent/tampered credentials and cross-origin upgrades or mutations', async () => {
    expect((await post('/rooms')).status).toBe(401);
    const cookie = await guest();
    expect((await post('/rooms', cookie + 'tampered')).status).toBe(401);
    expect((await post('/rooms', cookie, {}, { Origin: 'https://evil.example' })).status).toBe(403);
    const response = await workers.default.fetch(
      new Request(origin + '/api/matchmaking/ws', {
        headers: { Upgrade: 'websocket', Cookie: cookie, Origin: 'https://evil.example' },
      }),
    );
    expect(response.status).toBe(403);
  });
  it('reserves seats across refresh and blocks a third player', async () => {
    const { code, aCookie, a } = await privateGame(),
      third = await guest('Intruder');
    expect((await post(`/rooms/${code}/join`, third)).status).toBe(403);
    const unauthorized = await workers.default.fetch(
      new Request(origin + `/api/rooms/${code}/ws`, {
        headers: {
          Upgrade: 'websocket',
          Cookie: third,
          Origin: origin,
          'CF-Connecting-IP': crypto.randomUUID(),
        },
      }),
    );
    expect(unauthorized.status).toBe(403);
    const returned = await post(`/rooms/${code}/join`, aCookie);
    expect(await returned.json()).toEqual({ code, seat: 'A' });
    expect(JSON.stringify(a.state)).not.toContain('guest');
    expect(JSON.stringify(a.state)).not.toContain('connectionId');
    const refreshed = await connect(`/rooms/${code}/ws`, aCookie);
    await refreshed.next('STATE');
    await a.next('REPLACED');
    expect(refreshed.state?.you).toBe('A');
  });
  it('returns clear errors for missing rooms and oversized requests', async () => {
    const cookie = await guest();
    expect((await post('/rooms/ABCDEFGH/join', cookie)).status).toBe(404);
    expect((await post('/session', '', { name: 'x'.repeat(5000) })).status).toBe(413);
  });
});
describe('authoritative gameplay', () => {
  it('synchronizes moves and canonical walls, with duplicate protection', async () => {
    const { a, b } = await privateGame();
    expect(a.state?.game.pawns).toEqual({ A: { row: 8, col: 2 }, B: { row: 8, col: 6 } });
    const command = a.command({ type: 'MOVE', to: { row: 7, col: 2 } });
    await a.next('ACK');
    const aState = await a.next('STATE', (m) => m.state.game.ply === 1);
    const bState = await b.next('STATE', (m) => m.state.game.ply === 1);
    expect(aState.state.game).toEqual(bState.state.game);
    a.ws.send(JSON.stringify(command));
    await a.next('ACK', (m) => m.actionId === command.actionId);
    expect((await a.next('STATE')).state.game.ply).toBe(1);
    a.ws.send(JSON.stringify({ ...command, action: { type: 'MOVE', to: { row: 6, col: 2 } } }));
    expect((await a.next('ERROR')).code).toBe('ACTION_ID_REUSED');
    b.command({ type: 'PLACE_WALL', wall: { orientation: 'horizontal', row: 3, col: 3 } });
    await b.next('ACK');
    expect((await b.next('STATE', (m) => m.state.game.ply === 2)).state.game.walls).toHaveLength(1);
  });
  it('rejects wrong turns, stale versions, invented seats, and malformed wall geometry', async () => {
    const { a, b } = await privateGame();
    b.command({ type: 'MOVE', to: { row: 7, col: 6 } });
    expect((await b.next('ERROR')).code).toBe('NOT_YOUR_TURN');
    a.command({ type: 'MOVE', to: { row: 7, col: 2 } }, { expectedVersion: 0 });
    expect((await a.next('ERROR')).code).toBe('STALE_VERSION');
    for (const extra of [
      { player: 'B' },
      {
        action: {
          type: 'PLACE_WALL',
          wall: { orientation: 'horizontal', row: 2, col: 2, length: 1 },
        },
      },
      {
        action: {
          type: 'PLACE_WALL',
          wall: { orientation: 'horizontal', row: 2, col: 2, length: 3 },
        },
      },
      {
        action: {
          type: 'PLACE_WALL',
          wall: {
            segments: [
              [0, 0, 0, 1],
              [0, 1, 1, 1],
            ],
          },
        },
      },
    ]) {
      a.ws.send(
        JSON.stringify({
          actionId: crypto.randomUUID(),
          roundId: a.state!.roundId,
          expectedVersion: a.state!.version,
          action: { type: 'MOVE', to: { row: 7, col: 2 } },
          ...extra,
        }),
      );
      expect((await a.next('ERROR')).code).toBe('BAD_ACTION');
    }
    expect(a.state?.game.ply).toBe(0);
  });
  it('atomically accepts only one simultaneous action for the same version', async () => {
    const { a } = await privateGame();
    const version = a.state!.version;
    const c1 = a.command({ type: 'MOVE', to: { row: 7, col: 2 } }, { expectedVersion: version });
    const c2 = a.command({ type: 'MOVE', to: { row: 8, col: 1 } }, { expectedVersion: version });
    await a.next('ACK', (m) => m.actionId === c1.actionId);
    expect((await a.next('ERROR', (m) => m.actionId === c2.actionId)).code).toBe('STALE_VERSION');
    expect(a.state?.game.ply).toBe(1);
  });
  it('keeps the same goal for B and resets only after both rematch requests', async () => {
    const { code, a, b } = await privateGame();
    await editRoom(code, (r) => {
      r.game.pawns.B = { row: 1, col: 6 };
      r.game.turn = 'B';
    });
    b.command({ type: 'MOVE', to: { row: 0, col: 6 } });
    await b.next('ACK');
    await b.next('STATE', (m) => m.state.status === 'finished');
    await a.next('STATE', (m) => m.state.status === 'finished');
    expect(a.state?.game.winner).toBe('B');
    const round = a.state!.roundId;
    a.command({ type: 'REQUEST_REMATCH' });
    await a.next('ACK');
    await a.next('STATE', (m) => m.state.rematch.A);
    await b.next('STATE', (m) => m.state.rematch.A);
    expect(a.state?.roundId).toBe(round);
    b.command({ type: 'REQUEST_REMATCH' });
    await b.next('ACK');
    await a.next('STATE', (m) => m.state.roundId !== round);
    expect(a.state?.game).toMatchObject({
      turn: 'A',
      pawns: { A: { row: 8, col: 2 }, B: { row: 8, col: 6 } },
      walls: [],
      winner: null,
    });
  });
  it('prevents sealing either pawn from the shared goal on the server', async () => {
    const { code, a } = await privateGame();
    await editRoom(code, (r) => {
      r.game.walls = [
        { orientation: 'vertical', row: 7, col: 1 },
        { orientation: 'vertical', row: 7, col: 2 },
      ];
    });
    a.command({ type: 'PLACE_WALL', wall: { orientation: 'horizontal', row: 7, col: 1 } });
    expect((await a.next('ERROR')).code).toBe('NO_PATH');
  });
  it('rate limits malformed and excessive game messages', async () => {
    const { a } = await privateGame();
    for (let i = 0; i < 32; i++) a.ws.send('{}');
    expect((await a.next('ERROR', (m) => m.code === 'RATE_LIMITED')).message).toContain('Wait');
  });
});
describe('hibernation, restart, and disconnects', () => {
  it('expires idle rooms and returns a normal not-found response afterward', async () => {
    const { code, aCookie } = await privateGame();
    await editRoom(code, (r) => {
      r.expiresAt = Date.now() - 1;
    });
    await runDurableObjectAlarm(env.ROOMS.getByName(code));
    expect((await post(`/rooms/${code}/join`, aCookie)).status).toBe(404);
  });
  it('retains sockets, state and receipts through real hibernation', async () => {
    const { a, b } = await privateGame();
    const command = a.command({ type: 'MOVE', to: { row: 7, col: 2 } });
    await a.next('ACK');
    await a.next('STATE', (m) => m.state.game.ply === 1);
    await b.next('STATE', (m) => m.state.game.ply === 1);
    await evictAllDurableObjects();
    a.ws.send(JSON.stringify(command));
    await a.next('ACK');
    b.command({ type: 'MOVE', to: { row: 7, col: 6 } });
    await b.next('ACK');
    expect((await a.next('STATE', (m) => m.state.game.ply === 2)).state.game.pawns.B.row).toBe(7);
  });
  it('restores persisted state after a forced object restart and reconnect', async () => {
    const { code, a, aCookie, bCookie } = await privateGame();
    a.command({ type: 'PLACE_WALL', wall: { orientation: 'vertical', row: 4, col: 4 } });
    await a.next('ACK');
    await a.next('STATE', (m) => m.state.game.ply === 1);
    await abortAllDurableObjects();
    const restored = await connect(`/rooms/${code}/ws`, aCookie);
    await restored.next('STATE');
    const peer = await connect(`/rooms/${code}/ws`, bCookie);
    await peer.next('STATE');
    expect(restored.state?.game.walls).toEqual([{ orientation: 'vertical', row: 4, col: 4 }]);
    expect(restored.state?.game.turn).toBe('B');
  });
  it('pauses on disconnect, rejects premature claims, and resumes on return', async () => {
    const { code, a, b, bCookie } = await privateGame();
    b.ws.close();
    await a.next('STATE', (m) => !m.state.players.B?.connected);
    a.command({ type: 'MOVE', to: { row: 7, col: 2 } });
    expect((await a.next('ERROR')).code).toBe('PAUSED');
    a.command({ type: 'CLAIM_DISCONNECT_WIN' });
    expect((await a.next('ERROR')).code).toBe('TOO_EARLY');
    const back = await connect(`/rooms/${code}/ws`, bCookie);
    await back.next('STATE');
    await a.next('STATE', (m) => !!m.state.players.B?.connected);
    a.command({ type: 'MOVE', to: { row: 7, col: 2 } });
    await a.next('ACK');
  });
  it('allows a claim after 90 seconds and never auto-awards a win', async () => {
    const { code, a, b } = await privateGame();
    b.ws.close();
    await a.next('STATE', (m) => !m.state.players.B?.connected);
    await editRoom(code, (r) => {
      r.seats.B!.disconnectedAt = Date.now() - 91000;
    });
    await runDurableObjectAlarm(env.ROOMS.getByName(code));
    expect(a.state?.game.winner).toBeNull();
    a.command({ type: 'CLAIM_DISCONNECT_WIN' });
    await a.next('ACK');
    expect((await a.next('STATE', (m) => m.state.status === 'finished')).state.game).toMatchObject({
      winner: 'A',
      endReason: 'disconnect',
    });
  });
});
describe('real FIFO matchmaking', () => {
  it('pairs concurrent entrants exactly once, with two distinct seats per room', async () => {
    const cookies = await Promise.all(Array.from({ length: 8 }, (_, i) => guest(`Guest ${i}`)));
    const clients = await Promise.all(cookies.map((c) => connect('/matchmaking/ws', c)));
    clients.forEach((c) => c.ws.send(JSON.stringify({ type: 'JOIN', ruleset: RULESET })));
    const matches = await Promise.all(clients.map((c) => c.next('MATCHED')));
    const counts = new Map<string, number>();
    for (const m of matches) counts.set(m.code, (counts.get(m.code) ?? 0) + 1);
    expect(counts.size).toBe(4);
    expect([...counts.values()]).toEqual([2, 2, 2, 2]);
    for (const [code] of counts) {
      const indexes = matches.map((m, i) => (m.code === code ? i : -1)).filter((i) => i >= 0);
      const one = await connect(`/rooms/${code}/ws`, cookies[indexes[0]]);
      await one.next('STATE');
      const two = await connect(`/rooms/${code}/ws`, cookies[indexes[1]]);
      await two.next('STATE');
      expect(one.state?.you).not.toBe(two.state?.you);
      expect(two.state?.status).toBe('active');
    }
  });
  it('does not self-match repeated joins; cancellation removes the queue entry', async () => {
    const c = await connect('/matchmaking/ws', await guest());
    c.ws.send(JSON.stringify({ type: 'JOIN', ruleset: RULESET }));
    await c.next('QUEUED');
    c.ws.send(JSON.stringify({ type: 'JOIN', ruleset: RULESET }));
    await c.next('QUEUED');
    c.ws.send(JSON.stringify({ type: 'CANCEL' }));
    await c.next('CANCELLED');
    const count = await runInDurableObject(
      env.MATCHMAKER.getByName('global-v1'),
      (_i, ctx) => ctx.storage.sql.exec<{ n: number }>('SELECT count(*) AS n FROM queue').one().n,
    );
    expect(count).toBe(0);
  });
  it('removes closed connections and preserves queue order across hibernation', async () => {
    const a = await connect('/matchmaking/ws', await guest()),
      b = await connect('/matchmaking/ws', await guest());
    a.ws.send(JSON.stringify({ type: 'JOIN', ruleset: RULESET }));
    await a.next('QUEUED');
    await evictAllDurableObjects();
    a.ws.close();
    await expect
      .poll(async () =>
        runInDurableObject(
          env.MATCHMAKER.getByName('global-v1'),
          (_i, ctx) =>
            ctx.storage.sql.exec<{ n: number }>('SELECT count(*) AS n FROM queue').one().n,
        ),
      )
      .toBe(0);
    b.ws.send(JSON.stringify({ type: 'JOIN', ruleset: RULESET }));
    await b.next('QUEUED');
    const c = await connect('/matchmaking/ws', await guest());
    c.ws.send(JSON.stringify({ type: 'JOIN', ruleset: RULESET }));
    expect((await b.next('MATCHED')).code).toBe((await c.next('MATCHED')).code);
  });
  it('recovers a committed reservation after restart without assigning players twice', async () => {
    const cookies = await Promise.all([guest('A'), guest('B')]);
    const decodeGuest = (cookie: string): Guest =>
      JSON.parse(atob(cookie.split('=')[1].split('.')[0].replace(/-/g, '+').replace(/_/g, '/')));
    const guests = cookies.map(decodeGuest),
      id = crypto.randomUUID(),
      code = 'ABCDEFGH';
    await runInDurableObject(env.MATCHMAKER.getByName('global-v1'), (_i, ctx) => {
      ctx.storage.sql.exec(
        'INSERT INTO assignments(id,a,b,data) VALUES(?,?,?,?)',
        id,
        guests[0].id,
        guests[1].id,
        JSON.stringify({ id, code, guests, status: 'reserved', createdAt: Date.now() }),
      );
      return ctx.storage.setAlarm(Date.now() + 30000);
    });
    await abortAllDurableObjects();
    await runDurableObjectAlarm(env.MATCHMAKER.getByName('global-v1'));
    const a = await connect('/matchmaking/ws', cookies[0]);
    a.ws.send(JSON.stringify({ type: 'JOIN', ruleset: RULESET }));
    expect((await a.next('MATCHED')).code).toBe(code);
    const b = await connect('/matchmaking/ws', cookies[1]);
    b.ws.send(JSON.stringify({ type: 'CANCEL' }));
    expect((await b.next('MATCHED')).code).toBe(code);
    expect((await post(`/rooms/${code}/join`, cookies[0])).status).toBe(200);
  });
  it('cancels an unstarted random match after 60 seconds and permits requeue', async () => {
    const cookies = await Promise.all([guest(), guest()]);
    const a = await connect('/matchmaking/ws', cookies[0]),
      b = await connect('/matchmaking/ws', cookies[1]);
    a.ws.send(JSON.stringify({ type: 'JOIN', ruleset: RULESET }));
    await a.next('QUEUED');
    b.ws.send(JSON.stringify({ type: 'JOIN', ruleset: RULESET }));
    const { code } = await a.next('MATCHED');
    await b.next('MATCHED');
    a.ws.close();
    b.ws.close();
    const roomClient = await connect(`/rooms/${code}/ws`, cookies[0]);
    await roomClient.next('STATE');
    await editRoom(code, (r) => {
      r.createdAt = Date.now() - 61000;
    });
    await runDurableObjectAlarm(env.ROOMS.getByName(code));
    expect(
      (await roomClient.next('STATE', (m) => m.state.status === 'cancelled')).state
        .cancellationReason,
    ).toContain('did not connect');
    const requeue = await connect('/matchmaking/ws', cookies[0]);
    requeue.ws.send(JSON.stringify({ type: 'JOIN', ruleset: RULESET }));
    await requeue.next('QUEUED');
  });
});
