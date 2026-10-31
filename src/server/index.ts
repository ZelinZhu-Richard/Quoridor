import { RULESET, emptyInputSchema, roomCodeSchema, sessionInputSchema } from '../shared/protocol';
import { errorMessage, HttpError, MAX_MESSAGE, newCode, parseJson, type AppEnv } from './common';
import { issueGuest, readGuest, requireOrigin } from './auth';
export { GameRoom } from './room';
export { Matchmaker } from './matchmaker';
const headers = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
};
const json = (body: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { ...headers, ...extra } });
async function body(req: Request): Promise<unknown> {
  if (!req.headers.get('content-type')?.startsWith('application/json'))
    throw new HttpError(415, 'CONTENT_TYPE', 'Send JSON for this request.');
  const reader = req.body?.getReader();
  if (!reader) return {};
  let size = 0;
  const chunks: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_MESSAGE) {
      await reader.cancel();
      throw new HttpError(413, 'TOO_LARGE', 'Keep requests under 4 KB.');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return parseJson(new TextDecoder().decode(bytes) || '{}');
}
export default {
  async fetch(req: Request, env: AppEnv): Promise<Response> {
    const url = new URL(req.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(req);
    try {
      if (url.pathname === '/api/health' && req.method === 'GET')
        return json({ ok: true, ruleset: RULESET });
      const upgrade = req.headers.get('Upgrade')?.toLowerCase() === 'websocket';
      if (req.method !== 'POST' && !upgrade)
        throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'Use the supported request method.');
      requireOrigin(req);
      const ip = req.headers.get('CF-Connecting-IP') ?? 'local';
      if (env.ENTRY_LIMIT && !(await env.ENTRY_LIMIT.limit({ key: ip })).success)
        throw new HttpError(
          429,
          'RATE_LIMITED',
          'Too many connection requests. Try again in a minute.',
        );
      if (url.pathname === '/api/session' && req.method === 'POST') {
        const input = sessionInputSchema.safeParse(await body(req));
        if (!input.success)
          throw new HttpError(
            400,
            'BAD_NAME',
            'Use a name of 24 characters or fewer, without control characters.',
          );
        const { guest, cookie } = await issueGuest(req, env, input.data.name);
        return json({ name: guest.name }, 200, { 'Set-Cookie': cookie });
      }
      const guest = await readGuest(req, env);
      if (!guest)
        throw new HttpError(
          401,
          'UNAUTHORIZED',
          'Your guest session expired. Reload to reconnect.',
        );
      if (env.SESSION_LIMIT && !(await env.SESSION_LIMIT.limit({ key: guest.id })).success)
        throw new HttpError(429, 'RATE_LIMITED', 'Too many requests. Try again in a minute.');
      if (url.pathname === '/api/rooms' && req.method === 'POST') {
        if (!emptyInputSchema.safeParse(await body(req)).success)
          throw new HttpError(400, 'BAD_REQUEST', 'Room creation takes an empty JSON object.');
        for (let attempt = 0; attempt < 5; attempt++) {
          const code = newCode(),
            room = env.ROOMS.getByName(code);
          if (await room.initialize(code, 'private', [guest], crypto.randomUUID()))
            return json({ code, seat: 'A' }, 201);
        }
        throw new HttpError(503, 'TRY_AGAIN', 'Could not create a room. Try again.');
      }
      const match = url.pathname.match(/^\/api\/rooms\/([^/]+)\/(join|ws)$/);
      if (match) {
        const code = match[1].toUpperCase();
        if (!roomCodeSchema.safeParse(code).success)
          throw new HttpError(400, 'BAD_CODE', 'Enter a valid eight-character room code.');
        const room = env.ROOMS.getByName(code);
        if (match[2] === 'join' && req.method === 'POST') {
          if (!emptyInputSchema.safeParse(await body(req)).success)
            throw new HttpError(400, 'BAD_REQUEST', 'Joining a room takes an empty JSON object.');
          const result = await room.join(guest);
          if (!result.ok) throw new HttpError(result.status, result.code, result.message);
          return json({ code: result.code, seat: result.seat });
        }
        if (match[2] === 'ws' && upgrade)
          return room.fetch(
            new Request('https://room.internal/connect', {
              headers: { Upgrade: 'websocket', 'X-Guest': JSON.stringify(guest) },
            }),
          );
      }
      if (url.pathname === '/api/matchmaking/ws' && upgrade)
        return env.MATCHMAKER.getByName('global-v1').fetch(
          new Request('https://queue.internal/connect', {
            headers: { Upgrade: 'websocket', 'X-Guest': JSON.stringify(guest) },
          }),
        );
      throw new HttpError(404, 'NOT_FOUND', 'That game endpoint does not exist.');
    } catch (error) {
      const result = errorMessage(error);
      return json(
        result,
        error instanceof HttpError ? error.status : result.code === 'INTERNAL_ERROR' ? 500 : 400,
      );
    }
  },
} satisfies ExportedHandler<AppEnv>;
