import type { GameRoom } from './room';
import type { Matchmaker } from './matchmaker';
import { z } from 'zod';
import { nameSchema, type ServerMessage } from '../shared/protocol';

export interface AppEnv {
  ROOMS: DurableObjectNamespace<GameRoom>;
  MATCHMAKER: DurableObjectNamespace<Matchmaker>;
  ASSETS: Fetcher;
  SESSION_SECRET?: string;
  ENTRY_LIMIT: RateLimit;
  SESSION_LIMIT: RateLimit;
}
export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
export const guestSchema = z.strictObject({
  id: z.string().regex(/^[a-f0-9]{64}$/),
  name: nameSchema,
  exp: z.number().int().positive(),
});
export type Guest = z.infer<typeof guestSchema>;
export const MAX_MESSAGE = 4096;
export const HEARTBEAT_TIMEOUT = 65000;
export const DAY = 86400000;
export function safeSend(ws: WebSocket, message: ServerMessage) {
  try {
    ws.send(JSON.stringify(message));
  } catch {
    /* Close/alarm handlers reconcile disconnected peers. */
  }
}
export function closeSocket(ws: WebSocket, code = 1000, reason = 'Closed') {
  try {
    ws.close(code, reason);
  } catch {
    /* Already closed. */
  }
}
export function newCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from(crypto.getRandomValues(new Uint8Array(8)), (n) => alphabet[n & 31]).join('');
}
export function messageText(input: string | ArrayBuffer) {
  if (typeof input !== 'string' || new TextEncoder().encode(input).byteLength > MAX_MESSAGE)
    throw new HttpError(400, 'BAD_MESSAGE', 'Send a JSON message under 4 KB.');
  return input;
}
export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, 'BAD_JSON', 'Send a valid JSON message.');
  }
}
export function consumeRate(sql: SqlStorage, key: string, limit = 30, period = 10000) {
  const now = Date.now(),
    row = sql
      .exec<{ count: number; reset_at: number }>(
        'SELECT count, reset_at FROM limits WHERE key = ?',
        key,
      )
      .toArray()[0];
  if (row && row.reset_at > now && row.count >= limit)
    throw new HttpError(429, 'RATE_LIMITED', 'Too many requests. Wait a moment and try again.');
  sql.exec(
    'INSERT INTO limits(key,count,reset_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET count=excluded.count, reset_at=excluded.reset_at',
    key,
    row && row.reset_at > now ? row.count + 1 : 1,
    row && row.reset_at > now ? row.reset_at : now + period,
  );
}
export function initializeLimits(sql: SqlStorage) {
  sql.exec(
    'CREATE TABLE IF NOT EXISTS limits (key TEXT PRIMARY KEY, count INTEGER NOT NULL, reset_at INTEGER NOT NULL)',
  );
}
export function errorMessage(error: unknown) {
  if (error instanceof HttpError) return { code: error.code, message: error.message };
  if (error instanceof Error && 'code' in error)
    return { code: String(error.code), message: error.message };
  return {
    code: 'INTERNAL_ERROR',
    message: 'The game service could not finish that request. Please try again.',
  };
}
