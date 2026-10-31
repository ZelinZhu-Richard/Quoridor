import { guestSchema, HttpError, DAY, type AppEnv, type Guest } from './common';
const encoder = new TextEncoder(),
  decoder = new TextDecoder();
const cookieName = 'linebreak_guest';
function encode(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}
function decode(text: string) {
  const raw = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}
export function isLocal(url: string) {
  return ['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname);
}
async function key(env: AppEnv, url: string) {
  const secret =
    env.SESSION_SECRET ||
    (isLocal(url) ? 'linebreak-local-development-only-secret-change-in-production' : null);
  if (!secret || secret.length < 32)
    throw new HttpError(
      503,
      'NOT_CONFIGURED',
      'Online play is not configured yet. The host must set SESSION_SECRET.',
    );
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}
export async function readGuest(req: Request, env: AppEnv): Promise<Guest | null> {
  const raw = req.headers
    .get('cookie')
    ?.split(';')
    .map((s) => s.trim())
    .find((s) => s.startsWith(`${cookieName}=`))
    ?.slice(cookieName.length + 1);
  if (!raw || raw.length > 1024) return null;
  const [payload, signature, ...extra] = raw.split('.');
  if (!payload || !signature || extra.length) return null;
  try {
    const valid = await crypto.subtle.verify(
      'HMAC',
      await key(env, req.url),
      decode(signature),
      encoder.encode(payload),
    );
    if (!valid) return null;
    const result = guestSchema.safeParse(JSON.parse(decoder.decode(decode(payload))));
    return result.success && result.data.exp > Date.now() ? result.data : null;
  } catch {
    return null;
  }
}
export async function issueGuest(req: Request, env: AppEnv, name?: string) {
  const previous = await readGuest(req, env);
  const guest: Guest = {
    id:
      previous?.id ??
      Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) =>
        b.toString(16).padStart(2, '0'),
      ).join(''),
    name: name ?? previous?.name ?? '',
    exp: Date.now() + 30 * DAY,
  };
  const payload = encode(encoder.encode(JSON.stringify(guest)));
  const signature = encode(
    new Uint8Array(
      await crypto.subtle.sign('HMAC', await key(env, req.url), encoder.encode(payload)),
    ),
  );
  return {
    guest,
    cookie: `${cookieName}=${payload}.${signature}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${30 * 86400}${isLocal(req.url) ? '' : '; Secure'}`,
  };
}
export function requireOrigin(req: Request) {
  if (req.headers.get('origin') !== new URL(req.url).origin)
    throw new HttpError(403, 'BAD_ORIGIN', 'Open Linebreak directly to make this request.');
}
