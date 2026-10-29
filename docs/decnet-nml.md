# DECnet node 23.1

The server is DECnet node 23.1, `RSTAR`, run by
[decnet-nml](https://code.netzhansa.com/hanshuebner/decnet-nml) on `br0`.
It answers network management requests (NICE, object 19) from the names of
the allocation plan, so a member's system learns them with NCP:

    NCP> TELL 23.1 SHOW KNOWN NODES
    NCP> COPY KNOWN NODES FROM 23.1 TO BOTH
    NCP> LOOP NODE 23.1

- Known nodes are 23.1 and every named node of `decnet_host`, plus every
  node heard on the LAN. A node heard is REACHABLE, any other UNREACHABLE.
- decnet-nmld reads the names every minute from `GET /api/decnet/nodes`
  (`[{"address": "23.20", "name": "SMBRCK"}, …]`), which anyone may read.
- The node sits on `br0` through a veth pair, `dn0` with the node's Ethernet
  address AA-00-04-00-01-5C and `dn0br` as the bridge port, which
  decnet-nmld creates when it starts.

## Deployment

- [ ] `sudo apt update && sudo apt install decnet-nml` (code.netzhansa.com's
      apt registry, which the server also uses for `lattice` and
      `decnet-gateway`).
- [ ] `/etc/decnet-nml/decnet-nml.yml`: the package's file describes this
      node already (`address: 23.1`, `name: RSTAR`, `bridge: br0`,
      `names.url: http://localhost:3000/api/decnet/nodes`); the port is the
      web server's, 3000 unless `PORT` in `webserver/.env` sets another.
- [ ] `sudo systemctl enable --now decnet-nmld`; `journalctl -u decnet-nmld`
      shows "node list loaded".
