import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';

const base = new URL(process.argv[2] || 'http://127.0.0.1:5173');
const all = [];
async function post(path, cookie, body = {}) {
  const res = await fetch(new URL('/api' + path, base), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: base.origin, Cookie: cookie || '' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`);
  return res;
}
async function guest(name) {
  return (await post('/session', '', { name })).headers.get('set-cookie').split(';')[0];
}
async function connect(path, cookie) {
  const url = new URL('/api' + path, base);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(url, { origin: base.origin, headers: { Cookie: cookie } });
  all.push(ws);
  const client = { ws, state: null, messages: [], listeners: [] };
  ws.on('message', (data) => {
    if (data.toString() === 'pong') return;
    const message = JSON.parse(data.toString());
    client.messages.push(message);
    if (message.type === 'STATE') client.state = message.state;
    for (const listener of [...client.listeners]) listener();
  });
  client.wait = (type, predicate = () => true) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        remove();
        reject(new Error(`Timed out waiting for ${type}`));
      }, 15000);
      const remove = () => {
        clearTimeout(timer);
        client.listeners = client.listeners.filter((fn) => fn !== check);
      };
      const check = () => {
        const i = client.messages.findIndex((m) => m.type === type && predicate(m));
        if (i >= 0) {
          const m = client.messages.splice(i, 1)[0];
          remove();
          resolve(m);
        }
      };
      client.listeners.push(check);
      check();
    });
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  const heartbeat = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) ws.send('ping');
  }, 20000);
  ws.once('close', () => clearInterval(heartbeat));
  return client;
}
async function act(client, action, command) {
  command ||= {
    actionId: randomUUID(),
    roundId: client.state.roundId,
    expectedVersion: client.state.version,
    action,
  };
  client.ws.send(JSON.stringify(command));
  const ack = await client.wait('ACK', (m) => m.actionId === command.actionId);
  await client.wait('STATE', (m) => m.state.version >= ack.version);
  return command;
}
async function play(code, cookies, label) {
  let a = await connect(`/rooms/${code}/ws`, cookies[0]),
    b = await connect(`/rooms/${code}/ws`, cookies[1]);
  await a.wait('STATE', (m) => m.state.status === 'active');
  await b.wait('STATE', (m) => m.state.status === 'active');
  const bCookie = a.state.you === 'B' ? cookies[0] : cookies[1];
  if (a.state.you === 'B') [a, b] = [b, a];
  assert.deepEqual(a.state.game.pawns, { A: { row: 8, col: 2 }, B: { row: 8, col: 6 } });
  await act(a, { type: 'PLACE_WALL', wall: { orientation: 'horizontal', row: 3, col: 3 } });
  await b.wait('STATE', (m) => m.state.game.ply === 1);
  await act(b, { type: 'PLACE_WALL', wall: { orientation: 'vertical', row: 4, col: 3 } });
  await a.wait('STATE', (m) => m.state.game.ply === 2);
  const move = await act(a, { type: 'MOVE', to: { row: 7, col: 2 } });
  await b.wait('STATE', (m) => m.state.game.ply === 3);
  await act(a, null, move);
  assert.equal(a.state.game.ply, 3);
  await act(b, { type: 'MOVE', to: { row: 7, col: 6 } });
  await a.wait('STATE', (m) => m.state.game.ply === 4);
  b.ws.close();
  await a.wait('STATE', (m) => !m.state.players.B.connected);
  b = await connect(`/rooms/${code}/ws`, bCookie);
  await b.wait('STATE', (m) => m.state.players.A.connected && m.state.players.B.connected);
  await a.wait('STATE', (m) => m.state.players.B.connected);
  assert.equal(b.state.game.ply, 4);
  for (let row = 6; row >= 0; row--) {
    const next = a.state.game.ply + 1;
    await act(a, { type: 'MOVE', to: { row, col: 2 } });
    await b.wait('STATE', (m) => m.state.game.ply === next);
    if (row > 0) {
      const ply = b.state.game.ply + 1;
      await act(b, { type: 'MOVE', to: { row, col: 6 } });
      await a.wait('STATE', (m) => m.state.game.ply === ply);
    }
  }
  assert.equal(a.state.game.winner, 'A');
  assert.deepEqual(a.state.game, b.state.game);
  const oldRound = a.state.roundId;
  await act(a, { type: 'REQUEST_REMATCH' });
  await b.wait('STATE', (m) => m.state.rematch.A);
  await act(b, { type: 'REQUEST_REMATCH' });
  await a.wait('STATE', (m) => m.state.roundId !== oldRound);
  assert.equal(a.state.game.turn, 'A');
  assert.equal(a.state.game.walls.length, 0);
  await act(a, { type: 'RESIGN' });
  await b.wait('STATE', (m) => m.state.status === 'finished');
  assert.equal(b.state.game.winner, 'B');
  a.ws.close();
  b.ws.close();
  console.log(
    `${label}: synchronized walls, full race, duplicate retry, reconnect, victory, rematch, resignation passed.`,
  );
}
try {
  const health = await fetch(new URL('/api/health', base));
  assert.equal(health.status, 200);
  const cookies = await Promise.all([guest('Verification A'), guest('Verification B')]);
  const { code } = await (await post('/rooms', cookies[0])).json();
  await post(`/rooms/${code}/join`, cookies[1]);
  await play(code, cookies, 'Private room');
  const queueCookies = await Promise.all([guest('Verification A'), guest('Verification B')]);
  const qa = await connect('/matchmaking/ws', queueCookies[0]),
    qb = await connect('/matchmaking/ws', queueCookies[1]);
  qa.ws.send(JSON.stringify({ type: 'JOIN', ruleset: 'linebreak-same-side-v1' }));
  await qa.wait('QUEUED');
  qb.ws.send(JSON.stringify({ type: 'JOIN', ruleset: 'linebreak-same-side-v1' }));
  const [ma, mb] = await Promise.all([qa.wait('MATCHED'), qb.wait('MATCHED')]);
  assert.equal(
    ma.code,
    mb.code,
    'A different real player entered the queue during verification. Re-run on an empty queue.',
  );
  qa.ws.close();
  qb.ws.close();
  await play(ma.code, queueCookies, 'Matchmaking');
  console.log(`Online verification passed at ${base.origin}`);
} finally {
  for (const ws of all) ws.close();
}
