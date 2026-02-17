# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

RetroStar is a network monitoring and terminal access platform for VzEkC e.V. (German vintage computer club). It discovers retro computers connected to a network bridge, tracks their Ethernet protocols, and provides browser-based LAT terminal access.

## Repository Structure

- **webserver/** - Main Node.js/Koa web application (see `webserver/CLAUDE.md` for detailed architecture)
- **db/** - PostgreSQL migration scripts managed by `db/migrate.sh`
- **ca/** - Certificate authority setup for OpenVPN
- **client-package/** - Debian package source for RetroStar client
- **systemd/** - Service unit files (webserver, bridge, openvpn, protomon, latd)
- **Shell scripts** - Infrastructure utilities (bridge creation, user management, package building)

## Commands

All npm commands run from `webserver/`:

```bash
npm start              # Start server (port 3000, configurable via PORT)
npm run dev            # Dev server with hot reload (nodemon)
npm test               # Run tests (mocha + chai + supertest)
npm run format         # Format code with prettier
```

Database migrations (requires `PGDATABASE` env var):

```bash
db/migrate.sh up                   # Run pending migrations
db/migrate.sh new <description>    # Create new migration file
db/migrate.sh danger:reset         # Reset database (destructive)
```

## Code Style

Prettier (configured in `webserver/.prettierrc.json`): no semicolons, single quotes, 2-space indent, 80-char width.

## Testing

Tests require a running PostgreSQL instance. The test fixture creates an isolated database (`retrostar-test-{pid}`) per run and tears it down after. Tests live in `webserver/test/`.

## Key Infrastructure Dependencies

The server interacts with Linux-specific tools at runtime:
- `bridge fdb show` for host discovery on `br0`
- `tcpdump` on `br0` for protocol monitoring
- `llogin` for LAT terminal sessions (spawned via `node-pty`)
- TAP interface files in `/var/run/retrostar/clients/`

These won't be available in typical development environments; the webserver still starts but bridge/protocol features will be inactive.

## Environment Setup

Copy `webserver/.env.sample` to `webserver/.env`. Requires PostgreSQL connection (standard `PG*` env vars) and OIDC provider settings for forum-based authentication.
