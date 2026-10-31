# Verification record

Verified on October 31, 2026.

## Automated checks

- `npm run check`: TypeScript, 55 tests, and the production build.
- 27 pure rules tests, 5 UI/persistence tests, 3 offline service-worker tests, and 20 integration tests in the actual Cloudflare Workers runtime.
- The integration suite invokes real Durable Object eviction and restart APIs, then checks persisted games, action receipts, connections, and interrupted matchmaking reservations.
- `scripts/verify-online.mjs` completed private and randomly matched games against both the local Worker and a deployed Cloudflare Worker using two independent signed-cookie/WebSocket clients. It checked both wall orientations, synchronization, retry deduplication, reconnect, top-row victory, rematch, and resignation.

## Visible browser checks

All browser work used Codex's visible in-app browser.

- Desktop and 390 × 844 mobile layouts inspected.
- Completed a local game after placing horizontal and vertical walls; verified victory, rematch, and refresh persistence.
- Used `127.0.0.1` and `localhost` as independent cookie origins against the same local backend. Both browser guests joined a private room, exchanged moves, and retained their seats after refresh.
- Loaded the production application, stopped its server, reloaded `/local`, and successfully played the next turn from the restored game.
- Automated UI coverage checks touch preview/confirmation and keyboard wall controls.

The in-app browser did not expose isolated profiles for two guests on the same public origin. Public multiplayer was therefore checked with independent authenticated network clients. Two physical devices and a native touch device have **not** been tested; follow the separate-device checklist in the README before a wider release.

## Deployment ownership

The initial public verification used Cloudflare's free, temporary claimable deployment. It requires the owner to complete Cloudflare's claim flow before the 60-minute preview expires. A temporary deployment is not evidence of permanent hosting. The private claim URL is intentionally excluded from this repository. The README also documents deployment to an authenticated Cloudflare account.
