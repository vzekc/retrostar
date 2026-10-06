# RetroStar routers

A RetroStar router is a Raspberry Pi whose Ethernet port is bridged into the
RetroStar network while it reaches the internet over wifi. Whatever is on its
wire — a switch full of old machines, a terminal server — is on the RetroStar
LAN. On that bridge a router can also load machines over MOP and offer LAT
services of its own.

Each router is a host in [`inventory/hosts.ini`](inventory/hosts.ini) with its
settings in `host_vars/<name>/`; [`host_vars/travelstar`](host_vars/travelstar/vars.yml)
is one. [`router.yml`](router.yml) sets them up:

| Role | What it does | Settings |
|---|---|---|
| `usb_wifi` | keeps the wrong drivers off a wifi dongle | `usb_wifi_blacklist` |
| `retrostar_client` | `retrostar-client` from the RetroStar apt repository, its configuration fetched with the installation key | `retrostar_install_key_file` |
| `mop` | `mopd` on the bridge, serving files from [`files/mop`](files/mop) | `mop_files` |
| `lat` | `latticed` on the bridge, offering LAT services carried to telnet hosts | `lat_services`, `lat_node` |
| `infodisplay` | a Siemens 9772 on a USB RS-422 adapter showing an exhibition's information pages from its exhibitron site, with [`infodisplay.py`](https://code.netzhansa.com/hanshuebner/siemens-9772/src/branch/main/infodisplay.py) | `infodisplay_url`, `infodisplay_port`, `infodisplay_pages`, `infodisplay_seconds` |

and any roles a router names in `router_extra_roles`, from
[`requirements.yml`](requirements.yml) — its operator's account, say.
[`group_vars/routers`](group_vars/routers/vars.yml) has what all routers share.

## A new router

1. Add it to `inventory/hosts.ini` and write its `host_vars/<name>/vars.yml`.
   `router_image` is `arm64` for a Pi 3 or later, `armhf` for a Pi 2;
   `router_shell` is the account's login shell, bash unless it names another.
2. Put what the repository does not hold into `~/.config/retrostar/<name>/`:
   `authorized_keys`, `wifi` (one `ssid<TAB>password` a line), `install-key`
   (from https://retrostar.classic-computing.de/installation), and optionally
   `password-hash`.
3. Write the card, in a terminal that may write to removable media:

   ```sh
   ./bring-up <name> image
   ./bring-up <name> card disk6
   ```

4. Put the card in the Pi and power it, **Ethernet unplugged**: the RetroStar
   client refuses to install while that port carries the default route, and
   the router comes up on its wifi alone. Then:

   ```sh
   ./bring-up <name> wait
   ./bring-up <name> deploy
   ```

   The client bridges `eth0` into `br0` and the router reboots onto the
   bridge. Plug in the Ethernet port after that.

Once a router is up, a change is `ansible-playbook router.yml -l <name>`,
after `ansible-galaxy role install -r requirements.yml -p galaxy-roles --force`
for the roles from elsewhere.

## On a router

```sh
journalctl -u retrostar   # the tunnel to the RetroStar network
bridge link               # eth0 and the tunnel in br0
journalctl -u latticed    # the LAT sessions and where each was carried
journalctl -u mopd        # loads served
```
