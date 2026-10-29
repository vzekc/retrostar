# DECnet gateway

RetroStar runs the [decnet-gateway](https://code.netzhansa.com/hanshuebner/decnet-gateway)
daemon on the server's bridge `br0`. A member's machine anywhere on the
Internet joins RetroStar's DECnet LAN as a node of the member's own DECnet
block. It needs nothing but UDP to the server: no OpenVPN, no router. The
member sets the client up in the web application at `/decnet-gateway`.

The gateway encrypts and authenticates each packet between the client and
the server (ChaCha20-Poly1305, one key per client). On the RetroStar network
itself DECnet is cleartext, as on any DECnet LAN; the page says so.

## Addresses

- DECnet addresses come from RetroStar's allocation plan: area 23, each
  member's `decnet_block` (see `/decnet`). A gateway client is a named node
  (`decnet_host`) of the member's own block. A member without a block is sent
  to `/decnet` to allocate one first.
- Every node of a member's blocks can have one gateway client; there is no
  further limit.
- A node is offered and accepted when
  - no active gateway client uses it, and
  - its MAC (`AA-00-04-00` followed by area × 1024 + node, low byte first;
    SQL `decnet_mac(node)`) has no `host` row seen in the last 30 days. A
    machine of the member's own seen there may be moved behind the gateway
    when the member confirms it (`move: true`); a machine of another member's
    blocks the node.
- The node's name goes through `setDecnetHostName`: six characters, a letter
  first, unique.
- Self-service clients are endnodes (`endnode_only`); the gateway drops
  routing messages from them.

## Keys

- The connection line (`DNGW1 <host> <port> <key-id> 23.<node> <key>`) and
  its QR code are shown once, when a client is created and after each rekey,
  with a `.dngw` download (the line as a file). The responses carry
  `Cache-Control: no-store`.
- The web application never stores the key. It keeps the gateway's `key_id`
  and the key's fingerprint.
- Rekey issues a new key at once; the old one stops working. At most ten
  rekeys per client per day.
- Revocation removes the key at the gateway at once.

## Data

Table `decnet_gateway_client` (migration
`db/migrations/20261029120122_decnet_gateway_client.sql`):

| Column | Meaning |
|---|---|
| `id` | uuid, primary key |
| `user_id` | owner (`ON DELETE CASCADE`) |
| `node_number` | `decnet_host(node_number) ON DELETE RESTRICT`; set to null on a revoked record when its node is released |
| `address`, `name` | the client's DECnet address and node name |
| `key_id`, `key_fingerprint` | the gateway's key identifier (unique) and the key's fingerprint |
| `created_at`, `rekeyed_at`, `last_seen` | |
| `rekey_day`, `rekey_count` | the daily rekey limit |
| `needs_rekey` | the gateway did not know the client at the last reconciliation |
| `revoked_at`, `revoked_by`, `revoke_reason` | |

A unique index on `node_number` where `revoked_at` is null keeps one active
client per node. `update_gateway_host(mac)` creates or touches the `host` row
of a MAC learned on the gateway's bridge port, owned by the owner of the
active client with that MAC; MACs without one are ignored.

## Routes

| Route | Who | |
|---|---|---|
| `GET /decnet-gateway` | member | the page (`templates/decnet-gateway.html`, `public/js/decnet-gateway.js`), linked from `/decnet` and from each node of the member's block |
| `GET /api/decnet/gateway-clients` | member | `{gateway: {available, version}, clients, nodes}`: own active clients, own nodes with their names, clients and recently seen machines; an admin's `?all=1` lists every member's clients |
| `POST /api/decnet/gateway-clients` | member | `{node_number, name, move?}` → 201 `{client, line, qr_svg}` |
| `POST /api/decnet/gateway-clients/:id/rekey` | owner, admin | → `{client, line, qr_svg}`; 429 after ten a day |
| `DELETE /api/decnet/gateway-clients/:id` | owner, admin | body `{reason?}` → 204 |
| `GET /api/decnet/gateway-clients/:id/status` | owner, admin | live counters and endpoint from the gateway |

The existing DECnet routes respect the clients:

- `DELETE /api/decnet/hosts/:nodeNumber` answers 409 while an active client
  uses the node.
- Releasing (`DELETE /api/decnet/blocks/:id`) or reassigning
  (`PUT /api/decnet/blocks/:id`) a block revokes its clients at the gateway
  first.
- Deleting a user deletes their client records; the next reconciliation
  (within 10 s) removes their keys at the gateway.

## Control socket

`src/decnetGateway.js` talks to the daemon's control socket
(`DECNET_GATEWAY_SOCKET`, default `/run/decnet-gateway/control.sock`).
Protocol v1: one JSON request per line, answered by one JSON line. Every
request carries `"v": 1` and `"op"`. A refusal is
`{"ok": false, "error": code, "message": text}` with `code` one of
`unsupported`, `bad-request`, `exists`, `not-found`, `address-in-use`.

| op | Request | Answer |
|---|---|---|
| `hello` | | `{ok, protocol: 1, version}` |
| `add` | `name`, `address: "23.<node>"`, `endnode_only: true` | `{ok, key_id, line, fingerprint, mac}` |
| `rekey` | `key_id` | as `add` |
| `remove` | `key_id` | `{ok}` |
| `list` | | `{ok, clients: [{key_id, name, address, mac, fingerprint, endnode_only}]}` |
| `stats` | `key_id` (optional) | `{ok, clients: [{key_id, connected, last_rx, endpoint, rx_packets, rx_bytes, tx_packets, tx_bytes, drops: {bad_source, ethertype, replay, auth, rate}}]}` |

- A client's name at the gateway is `rs:<record id> <user>/<NAME>`.
- Creation inserts the record in a transaction, calls `add`, stores `key_id`
  and fingerprint and commits; a record that does not commit has its key
  removed again.
- Reconciliation, at startup and on every poll: gateway clients named `rs:…`
  without an active record of that id and key are removed; active records
  the gateway does not know are marked `needs_rekey` (a rekey then issues a
  key of a new id). Clients with other names (set up by hand) are left alone.
- A poller (`server.js`, every 10 s) reads `stats`, sets `last_seen` of the
  connected clients and publishes `decnet-gateway-connect` and
  `decnet-gateway-disconnect` events. Endpoints (IP addresses) appear only in
  the status route's answer, never in the database or the event log.
- Without the socket (development) the page says the gateway is not
  available, creation answers 503, and the rest of the application works.

`bridgeInfo.js` records MACs learned on the gateway's bridge port (`dngw0`,
`DECNET_GATEWAY_TAP`) through `update_gateway_host(mac)`, and those on the
OpenVPN TAPs through `update_host` as before.

## Phases

1. **Self-service endnodes in area 23** (this): members' clients as
   endnodes of their own blocks.
2. **Later phases:**
   - HECnet areas: clients with addresses outside area 23.
   - Routers: clients that route (`endnode_only: false`).
   - RetroStar as DECnet node 23.1 answering NICE, so that members can
     `COPY KNOWN NODES` from it and get the names of the allocation plan.

## Open items

- How addresses outside area 23 are allocated and who approves them.
- Which members' clients may route, and how the web application grants it.
- Where node 23.1 runs and how it learns the names of `decnet_host`.

## Deployment

The web application deploys with every push to main (`deploy.yml`); its
migration runs then. The gateway daemon is installed on the server
separately, once its Debian package is published.

- [ ] Install the package from code.netzhansa.com's apt registry, which the
      server already uses for `lattice`
      (`https://code.netzhansa.com/api/packages/hanshuebner/debian stable main`):
      `sudo apt update && sudo apt install decnet-gateway`.
- [ ] Configure `/etc/decnet-gateway/gateway.conf` (root's, mode 0600),
      before any client exists, since each connection line embeds the host
      and port:
      ```
      listen 0.0.0.0:26003
      public-host retrostar.classic-computing.de
      public-port 26003
      bridge br0
      tap dngw0
      state /var/lib/decnet-gateway/state
      ```
      IPv6 is disabled on the server, so the gateway listens on IPv4.
- [ ] Enable the control socket at `/run/decnet-gateway/control.sock`, group
      `decnet-gateway`, mode 0660, and start the service:
      `sudo systemctl enable --now decnet-gateway`; check
      `journalctl -u decnet-gateway` (`decnet-gateway on UDP …, dngw0 in br0`).
- [ ] Put the web server's user (`hans`, see
      `systemd/retrostar-webserver.service`) into the group:
      `sudo usermod -aG decnet-gateway hans`, then
      `sudo systemctl restart retrostar-webserver`.
- [ ] Environment of the web server (`webserver/.env`), only where the
      defaults do not fit:
      `DECNET_GATEWAY_SOCKET=/run/decnet-gateway/control.sock`,
      `DECNET_GATEWAY_TAP=dngw0`.
- [x] Hetzner Cloud firewall: inbound UDP 26003 to the server (beside the
      OpenVPN range UDP 1194–1294). Probes from outside arrive on `eth0`.
- [ ] A host firewall on the server, if one filters input, passes UDP 26003;
      bridge or nftables filters pass EtherTypes 6001–6004 and 9000 between
      `br0`'s ports.
- [ ] Check: the web server's log shows `decnet-gateway: available`;
      `/decnet-gateway` offers the member's nodes; a test client connects,
      appears with `last_seen`, and its machine shows up on `/status`.
