# Linebreak

Two pawns. One finish line. A complete local and online strategy game built with React, TypeScript, Vite, and Cloudflare Workers.

## Play

- **Local:** two people share a device. After the first production visit finishes caching, local play also works offline. Games survive refreshes in browser storage.
- **Private room:** create a room and send its invitation link or eight-character code to a friend. Seats belong to guest credentials, not the room code.
- **Find a match:** a durable FIFO queue pairs real connected guests. There are no bots or simulated opponents. Start requires both players to connect.

## Rules

The board has 9 × 9 cells. Coordinates in code are zero-based:

| Player | Start           | Goal              |
| ------ | --------------- | ----------------- |
| A      | row 8, column 2 | any cell in row 0 |
| B      | row 8, column 6 | any cell in row 0 |

A starts every round. On each turn, move one cell orthogonally or place one wall. Adjacent pawns can be jumped when the straight landing is open; diagonal sidesteps are permitted only when the straight jump is blocked by a wall or boundary.

Every wall is one rigid piece with **exactly two consecutive, collinear grid-edge segments**. Players have unlimited pieces. Both anchor coordinates are integers from 0 to 7:

```ts
type Wall = {
  orientation: 'horizontal' | 'vertical';
  row: number;
  col: number;
};
```

- Horizontal `(r,c)` blocks `(r,c)–(r+1,c)` and `(r,c+1)–(r+1,c+1)`.
- Vertical `(r,c)` blocks `(r,c)–(r,c+1)` and `(r+1,c)–(r+1,c+1)`.
- Shared movement edges are forbidden. Perpendicular crossings and vertex touching are allowed. Two touching pieces remain separate walls.
- BFS must find a route from **each current pawn position to row 0**, ignoring the other pawn as a temporary occupant. Long detours are legal; complete enclosure is not.
- The first pawn to enter row 0 wins. A new online round requires both rematch requests; seats stay fixed.

## Install and develop

Use Node **22.12+** and npm. Keep this checkout in your project’s working subfolder:

```sh
git clone https://github.com/ZelinZhu-Richard/Quoridor.git workspace
cd workspace
npm ci
npm run dev
```

Open the printed localhost URL. This single process serves React, the Worker, SQLite Durable Objects, and WebSockets locally. No Cloudflare login is needed for development. Local data lives in `.wrangler/` and is ignored by Git.

The local-only signing key is built in for localhost. Optionally copy `.dev.vars.example` to `.dev.vars` and supply your own key of at least 32 characters. A deployment **never** uses the development fallback.

## Checks

```sh
npm test
npm run typecheck
npm run build
```

`npm run check` runs all three. `npm run test:rules` runs rules and UI tests; `npm run test:workers` runs the actual Workers-runtime integration suite using `@cloudflare/vitest-plugin`. The integration tests exercise real Durable Object hibernation and forced restarts, SQL persistence, identity, origin validation, concurrent matchmaking, retries, cancellation, rematches, and disconnect recovery.

Preview the production build, including the service worker:

```sh
npm run build
npm run preview
```

Run a full independent-client network check against a running preview/deployment:

```sh
node scripts/verify-online.mjs http://127.0.0.1:5173
node scripts/verify-online.mjs https://linebreak.YOUR-SUBDOMAIN.workers.dev
```

This script creates labeled verification guests, completes private and matchmade games over real WebSockets, reconnects one client, checks duplicate delivery, rematches, and resigns the final round. Run it when the random queue is empty so it pairs its two verification guests together.

## Cloudflare deployment

The frontend and backend deploy together as one Worker named `linebreak`. The checked-in Wrangler configuration uses Worker Static Assets, SPA routing, `/api/*` Worker-first routing, SQLite-backed `GameRoom` and `Matchmaker` class exports, rate-limit bindings, and WebSocket Hibernation. No database or domain purchase is needed.

1. Sign in to your free Cloudflare account:

   ```sh
   npx wrangler login --browser=false --scopes account:read user:read workers:write
   npx wrangler whoami
   ```

   Open the printed sign-in link. If you have multiple accounts, select the intended free account using `CLOUDFLARE_ACCOUNT_ID`. If prompted for a workers.dev subdomain, choose an available free name. Do not upgrade the account.

2. Run `npm run check`, then deploy:

   ```sh
   npm run deploy
   ```

3. Provision the guest-signing secret immediately after the first deployment. Online endpoints return a configuration error until it is set:

   ```sh
   node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("base64url"))' | npx wrangler secret put SESSION_SECRET
   ```

   Keep this secret in Cloudflare, never Git or frontend code. Reuse it for later deployments; changing it invalidates existing guest credentials. `npm run deploy` preserves existing secrets.

4. Open the printed `https://linebreak.<subdomain>.workers.dev` URL, run the network verification script, and verify two separate devices as described below. The computer running the deployment can then shut down.

Cloudflare’s free quotas still apply. SQLite Durable Objects and static assets support the free plan, but excessive requests or storage usage can cause service errors until quotas reset. Hibernation, automatic heartbeat responses, bounded messages, rate limits, and expiry cleanup reduce unnecessary work. See [Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/) and [limits](https://developers.cloudflare.com/durable-objects/platform/limits/).

## Verify multiplayer on separate devices

1. Open the deployed URL on two devices, or separate browser profiles. Two tabs of the **same origin and profile share one guest** and cannot occupy both seats. A new tab taking the same seat disconnects its previous connection.
2. Create a private room on the first device and follow its link on the second. Confirm A at `(8,2)`, B at `(8,6)`, and both goal markers at the top.
3. Move and place both wall orientations. Verify the opponent sees each action, overlapping walls are rejected, and a move consumes exactly one turn.
4. Refresh one device. Its seat and game restore; play resumes when both connections return.
5. Finish a race to row 0. Request a rematch from both devices and check the reset positions.
6. Return both devices home and choose **Find an online match**. Verify matching and repeat gameplay. Try cancelling with only one device queued.
7. Disconnect one device during a game. Play pauses. After 90 seconds the connected player may claim victory; returning before the claim resumes the game. No automatic win is awarded when both are absent.
8. For offline local play, visit the production home page once while online, wait for **Ready for offline local play**, then disconnect the network and reload `/local`.

See [VERIFICATION.md](VERIFICATION.md) for the checks actually performed and their browser/device limits.

## Architecture and operational behavior

- `packages/rules`: pure shared rules and validated state serialization. No UI or network dependencies.
- `src/client`: responsive React interface, local saves, guest bootstrap, reconnecting sockets, persisted pending action IDs, and full-state reconciliation.
- `src/server`: same-origin Worker API; `GameRoom` owns seats, game state, presence and action receipts; singleton `Matchmaker` owns the FIFO queue and durable room reservations.
- `src/shared`: strict schemas for requests, game actions, queue commands and public snapshots.

API: `POST /api/session`, `POST /api/rooms`, `POST /api/rooms/:code/join`, `GET /api/rooms/:code/ws`, `GET /api/matchmaking/ws`, and `GET /api/health`.

Room actions include a UUID `actionId`, `roundId`, `expectedVersion`, and action payload. The server derives the seat from the authenticated socket. It atomically persists state and accepted-action receipts before acknowledging or broadcasting. A duplicate returns the previous acknowledgement; a reused ID with a changed payload is rejected. Stale versions receive a fresh snapshot and require a new action. Credentials and internal guest IDs never enter public snapshots.

Guest cookies are signed, HttpOnly, SameSite=Strict, Secure in production, and valid for 30 days. Clearing cookies loses access to the reserved seat. Names are optional and limited to 24 characters. Requests/messages are capped at 4 KB. Entry requests are limited per IP, API requests per guest, and socket actions per guest inside each Durable Object. Edge rate limiting is approximate across Cloudflare locations; Durable Object action limiting is authoritative within each object.

Private waiting rooms expire after 24 hours. Active/finished rooms expire after seven days without gameplay activity. Random matches that fail to connect both players within 60 seconds close and return the connected client to matchmaking. Queue cancellation wins before a durable reservation; after reservation, the existing match wins the race. Pending reservations are recovered idempotently after restart. Each object has a single alarm coordinating heartbeat checks and expiry.

The service worker caches only the static application shell, never API responses or credentials. Updates wait until home or a finished game. Online games never silently switch to offline/local play.

Use `npx wrangler tail` when investigating production errors. Application logs do not include credentials or game request bodies. SQL tables are created idempotently; persisted games carry a schema version and a same-side ruleset identifier. Preserve the Durable Object class exports and session secret on future deployments to retain ongoing games.
