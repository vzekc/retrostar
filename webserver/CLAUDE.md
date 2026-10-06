# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- **Start server:** `npm start` (runs on port 3000, configurable via `PORT` env var)
- **Dev server (hot reload):** `npm run dev`
- **Run tests:** `npm test` (mocha)
- **Format code:** `npm run format` (prettier)

## Testing

Tests use mocha + chai + supertest. The test fixture (`test/fixtures/db.js`) creates/drops an isolated PostgreSQL database per test run (`retrostar-test-{pid}`), using the migration script at `../db/migrate.sh`. A running PostgreSQL instance is required.

## Environment

Copy `.env.sample` to `.env`. Requires PostgreSQL connection (standard `PG*` env vars) and OIDC provider settings. The database name defaults to `retrostar`.

## Code Style

Prettier config (`.prettierrc.json`): no semicolons, single quotes, 2-space indent, 80-char width.

## Architecture

This is a Node.js/Koa web server for RetroStar, a retro computing network platform by VzEkC e.V. (German vintage computer club). It monitors hosts connected to a network bridge, tracks Ethernet protocols, and provides LAT terminal access.

### Key modules (`src/`)

- **server.js** - Entry point. Starts the host updater and listens on the configured port.
- **app.js** - Koa app setup: middleware chain (body parsing, static files, sessions, passport auth, DB transaction), all HTTP routes, and WebSocket handlers. Templates are rendered with EJS; Markdown files are also supported.
- **db.js** - PostgreSQL layer. All queries use parameterized statements. `withClient()` wraps operations in a transaction (BEGIN/COMMIT/ROLLBACK). The `middleware` function injects a DB client into `ctx.state.db` per request.
- **event.js** - Inserts events into a PostgreSQL `event` table. Real-time delivery uses PostgreSQL `LISTEN/NOTIFY` over a WebSocket (`/ws/event-log`).
- **bridgeInfo.js** - Polls `bridge fdb show` every second to discover hosts on `br0`, maps TAP interfaces to users via `tapInterfaces.js`, and updates the database.
- **protoMon.js** - Spawns `tcpdump` on `br0` to detect Ethernet protocols per host. Uses an expiring set (10-minute TTL).
- **ethernetToDecnet.js** - Converts DECnet MAC addresses (`AA:00:04:00:xx:xx`) to DECnet node IDs (`area.node`).
- **lattice.js** - Client of latticed's user socket (`LATTICE_SOCKET`, default `/run/latticed/users.sock`): lists the LAT services and opens users' sessions at its `Local>` prompt.

### Authentication

Two passport strategies: OIDC (forum-based login checking club membership rank) and local (username/password stored in DB). Session-based.

### Frontend

Server-rendered templates in `templates/` (EJS + HTML + Markdown), static assets in `public/`. Vanilla JS with Quill for rich text editing and xterm.js for the LAT terminal emulator.

### WebSocket endpoints

- `/ws/lat/:host` - Bidirectional terminal: a session at latticed's `Local>` prompt, connected to the LAT service `host`. Text frames are typed input; the page sends BREAK (0xFF 0xF3) as a binary frame.
- `/ws/event-log` - Real-time event stream using PostgreSQL LISTEN/NOTIFY.

### Database

PostgreSQL. Migrations live in `../db/migrate.sh` (sibling `db/` directory outside this webserver repo root). Key tables: `user`, `host`, `event`, `protocol`, `article`, `openvpn_configuration`, `ethernet_vendor`.
