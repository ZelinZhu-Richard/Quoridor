import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { serviceWorker } from './service-worker.mjs';

function harness() {
  const events = {};
  const stored = new Map();
  const origin = 'https://linebreak.test';
  let online = true;
  const network = vi.fn(async (request) => {
    if (!online) throw new TypeError('Offline');
    const url = typeof request === 'string' ? request : request.url;
    return new Response(url.endsWith('/app.js') ? 'application code' : '<html>game shell</html>', {
      headers: { Vary: 'Origin' },
    });
  });
  const cache = {
    async addAll(requests) {
      for (const request of requests) {
        expect(request.cache).toBe('reload');
        stored.set(request.url, { request, response: await network(request) });
      }
    },
  };
  const cacheStorage = {
    open: async () => cache,
    keys: async () => ['linebreak-old', 'linebreak-current', 'unrelated-cache'],
    delete: vi.fn(async () => true),
    async match(input, options = {}) {
      const request = input instanceof Request ? input : new Request(new URL(input, origin));
      const hit = stored.get(request.url);
      // Vite's Origin variation differs between precache fetches and module loads.
      if (
        !hit ||
        (!options.ignoreVary && request.headers.get('Origin') !== hit.request.headers.get('Origin'))
      )
        return;
      return hit.response.clone();
    },
  };
  const self = {
    location: { origin },
    addEventListener: (type, handler) => {
      events[type] = handler;
    },
    clients: { claim: vi.fn() },
    skipWaiting: vi.fn(),
  };
  runInNewContext(serviceWorker('linebreak-current', ['/', '/app.js']), {
    self,
    caches: cacheStorage,
    fetch: network,
    URL,
    Request: class extends Request {
      constructor(url, options) {
        super(new URL(url, origin), options);
      }
    },
  });
  function dispatch(type, extra = {}) {
    let result;
    events[type]({
      ...extra,
      waitUntil: (promise) => {
        result = promise;
      },
      respondWith: (promise) => {
        result = promise;
      },
    });
    return result;
  }
  return {
    dispatch,
    cacheStorage,
    self,
    offline: () => {
      online = false;
    },
    origin,
  };
}

describe('production offline shell', () => {
  it('reloads a saved local route and module assets offline despite Origin variation', async () => {
    const h = harness();
    await h.dispatch('install');
    h.offline();
    const page = await h.dispatch('fetch', {
      request: { url: h.origin + '/local', method: 'GET', mode: 'navigate' },
    });
    expect(await page.text()).toContain('game shell');
    const module = await h.dispatch('fetch', {
      request: new Request(h.origin + '/app.js', { headers: { Origin: h.origin } }),
    });
    expect(await module.text()).toBe('application code');
  });
  it('never intercepts API calls, mutations, or external requests', () => {
    const h = harness();
    for (const request of [
      new Request(h.origin + '/api/health'),
      new Request(h.origin + '/', { method: 'POST' }),
      new Request('https://other.test/app.js'),
    ]) {
      expect(h.dispatch('fetch', { request })).toBeUndefined();
    }
  });
  it('keeps updates waiting until allowed and deletes only previous app caches', async () => {
    const h = harness();
    await h.dispatch('install');
    expect(h.self.skipWaiting).not.toHaveBeenCalled();
    h.dispatch('message', { data: { type: 'SKIP_WAITING' } });
    expect(h.self.skipWaiting).toHaveBeenCalledOnce();
    await h.dispatch('activate');
    expect(h.cacheStorage.delete.mock.calls).toEqual([['linebreak-old']]);
    expect(h.self.clients.claim).toHaveBeenCalledOnce();
  });
});
