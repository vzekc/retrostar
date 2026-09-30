# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

RetroStar is a network monitoring and terminal access platform for VzEkC e.V. (German vintage computer club). It discovers retro computers connected to a network bridge, tracks their Ethernet protocols, and provides browser-based LAT terminal access.

## Repository Structure

- **webserver/** - Main Node.js/Koa web application (see `webserver/CLAUDE.md` for detailed architecture)
- **db/** - PostgreSQL migration scripts managed by `db/migrate.sh`
- **ca/** - Certificate authority setup for OpenVPN
- **packages/** - Debian package sources: `retrostar-client` (scripts, assembled with dpkg-deb), `latd` and `mopd`; base versions in `packages/versions`
- **scripts/** - Package build and apt repository publishing, used by CI
- **ansible/** - Setup of RetroStar routers: generic roles, `router.yml`, `bring-up` for a new card, and each router's `host_vars` (see `ansible/README.md`)
- **keys/** - Public half of the apt repository's signing key, and the repository's index page
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

## Packages and Deployment

CI (`.github/workflows/`) does both; nothing is deployed by hand.

- **packages.yml** builds `latd` and `mopd` for bookworm and trixie on amd64, arm64 and armhf (ARM under qemu), and `retrostar-client` once, then publishes them into the signed apt repository on the `gh-pages` branch, served at https://vzekc.github.io/retrostar/. A package's version counts the commits that touched `packages/<name>`, so it changes exactly when the package does; a file already in the pool is never replaced. The signing key is the `APT_SIGNING_KEY` secret. The armhf builds are Debian's ARMv7 armhf and do not run on ARMv6 Pis (Pi 1, Zero).
- **deploy.yml** runs `deploy.sh` on the server over ssh: fetch main over HTTPS, `npm ci`, migrations, restart `retrostar-webserver`. The key (`DEPLOY_SSH_KEY`) is restricted on the server to that script.
- `install.sh` (`webserver/templates/install.sh.ejs`) adds the apt repository and installs `retrostar-client`. The package's `preinst` asks for the installation key only on a first installation without `/etc/retrostar/openvpn.conf`; `RETROSTAR_INSTALL_KEY` supplies it unattended.

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
