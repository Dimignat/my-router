# my-router

Config and a simple web GUI for a fleet of GL.iNet travel routers running
OpenWrt + NetShift. Routers pull this repo from GitHub and self-update.

---

## 1. The device

| | |
|---|---|
| Model | GL.iNet GL-MT3000 ("Beryl AX") |
| Arch | `aarch64_cortex-a53`, target `mediatek/filogic` |
| OS | OpenWrt 24.10.7 (`r29197-ab4c7d6af7`), kernel 6.6 |
| LAN IP | `192.168.2.1` (`br-lan`, /24) |
| RAM | 512 MB (~340 MB available) |
| Storage | 202 MB overlay, ~149 MB free — **don't install anything large** |

### Access

```bash
ssh root@192.168.2.1      # root, key-based; user `di` is NOT set up
```

Gotchas that will bite you:

- **Login is `root`.** `ssh 192.168.2.1` uses your local username and fails.
- **No `scp`/`sftp`** — dropbear has no sftp-server. Pipe over stdin instead:
  ```bash
  tar czf - www cgi-bin scripts | ssh root@192.168.2.1 'tar xzf - -C /tmp/mr'
  ```
- **No `git`** on the device. Updates use `curl` + the GitHub tarball API.
- **No `timeout`**, no bash. It's BusyBox `ash` — POSIX sh only, no bashisms.
- Useful tools that *are* present: `curl`, `wget`, `jsonfilter`, `uci`, `ubus`,
  `tar`, `logger`, `crontab`.

---

## 2. How traffic actually flows

The router proxies traffic through **NetShift** (`netshift` 0.9.6), a shell
wrapper around **sing-box** (1.14.0-extended). It is *not* a normal VPN client.

```
LAN client → dnsmasq (53) → sing-box tproxy → urltest group → one of 9 VLESS nodes → internet
                                    ↓
                         direct-out (Russian sites bypass the tunnel)
```

Key pieces:

- **`redshield-1-out` … `redshield-9-out`** — nine VLESS/REALITY nodes.
- **`redshield-urltest-out`** — picks the lowest-latency node automatically,
  re-testing every 10 min (`urltest_check_interval`). **This is what carries
  traffic.**
- **`redshield-out`** — selector whose default is the urltest group.
- **`direct-out`** — bypass. Russian domains/subnets (`nalog.ru`, `mos.ru`,
  bank IPs, plus a remote `.srs` whitelist) skip the tunnel entirely.

Config lives in UCI at `/etc/config/netshift`, which NetShift renders into
`/etc/sing-box/config.json`. **Edit the UCI config, not the JSON** — the JSON is
regenerated and your edits will be lost.

> **Secrets:** `/etc/config/netshift` contains live VLESS UUIDs, REALITY public
> keys and server hostnames. It is `chmod 600` and **must never be committed** —
> this repo is public. Proxy credentials stay on the device only.

### The Clash API — the useful control surface

sing-box exposes a Clash-compatible API on `192.168.2.1:9090`, **unauthenticated
and reachable from the whole LAN**. `netshift clash_api` wraps it:

```bash
netshift clash_api get_proxies                              # all nodes + last latency
netshift clash_api get_group_latency redshield-urltest-out  # re-test (~5s), returns ms
netshift clash_api set_group_proxy redshield-out redshield-urltest-out
netshift clash_api get_proxy_latency <tag>
```

`jsonfilter` needs **double** quotes for bracket keys — single quotes silently
return nothing:

```bash
netshift clash_api get_proxies | jsonfilter -e '@.proxies["redshield-urltest-out"].now'
```

### netshift CLI

```bash
netshift get_status          # {"enabled":1,"status":"enabled"}
netshift get_system_info     # versions, model
netshift check_proxy         # connectivity test (verbose, dumps config)
netshift check_logs          # service logs
netshift list_update         # refresh domain lists (also runs daily at 09:13 via cron)
/etc/init.d/netshift restart # restart tunnel; LAN and Wi-Fi stay up
```

---

## 3. What this repo installs

| Repo path | On the router | Purpose |
|---|---|---|
| `www/` | `/www/app/` | Kiosk GUI, served by stock uhttpd |
| `cgi-bin/router-api` | `/www/cgi-bin/router-api` | JSON control API (CGI) |
| `scripts/my-router-update` | `/usr/bin/my-router-update` | Pulls master, applies it |
| `scripts/install.sh` | — | Installer; also used by the updater |
| `config/settings.conf` | `/etc/my-router/settings.conf` | Repo/branch; seeded once, never overwritten |

State the router keeps: `/etc/my-router/version` (applied commit SHA) and
`/etc/my-router/last-update`.

### Deploy from a dev machine

```bash
tar czf - www cgi-bin scripts config \
  | ssh root@192.168.2.1 'rm -rf /tmp/mr && mkdir -p /tmp/mr && tar xzf - -C /tmp/mr \
                          && sh /tmp/mr/scripts/install.sh'
```

Then open **http://192.168.2.1/app/**.

---

## 4. The GUI

Aimed at users who are not confident with computers, so: three actions, plain
Russian, no jargon ("VPN", "proxy", "sing-box" appear nowhere), ~84px touch
targets, and a status lamp that always pairs colour with words.

| Button | Action | What happens | Time |
|---|---|---|---|
| **Переподключиться** (Reconnect) | `?action=reconnect` | Re-tests node latency, forces the urltest group to re-pick. Existing connections survive. | ~5 s |
| **Перезапустить** (Reload) | `?action=reload` | `/etc/init.d/netshift restart`. Internet blips; **Wi-Fi stays up**, nobody is kicked off. | ~10 s |
| Обновить программу (link) | `?action=update` | Forces a pull from GitHub now. | ~10 s |

### API

All responses are JSON. Long actions are **detached** and polled, so uhttpd's
60 s `script_timeout` is never hit.

```
GET /cgi-bin/router-api?action=status
  → {"ok":true,"vpn_enabled":1,"online":1,"settling":0,
     "node":"redshield-2-out","latency":318,"version":"<sha>","uptime":830153}

GET ?action=reconnect | reload | update   → {"ok":true,"job":"<id>"}
GET ?action=job_status&job=<id>           → {"ok":true,"state":"running|done|failed","rc":0}
```

`settling:1` means the tunnel is up but sing-box hasn't chosen a node yet —
normal for a few seconds after a restart, and shown as "Подключаемся…", not as
an error.

`online` is a real reachability check (`generate_204`), cached 30 s so that
polling every 5 s doesn't hammer the link.

**Security:** the query string is parsed without `eval` and both `action` and
`job` are stripped to a character whitelist. The API is root-capable and
**unauthenticated on the LAN** — anyone on the Wi-Fi can restart the tunnel.
That's the same trust level as LuCI and the open Clash API on :9090; it is a
deliberate trade for one-tap use. Don't expose it to the WAN.

---

## 5. Auto-update from GitHub

Repo: **https://github.com/Dimignat/my-router** (public, branch `master`).

Every router runs `*/15 * * * * /usr/bin/my-router-update`. Each run:

1. `GET api.github.com/repos/<repo>/commits/master` with
   `Accept: application/vnd.github.sha` → remote SHA.
2. Compares to `/etc/my-router/version`; exits if equal.
3. Downloads `codeload.github.com/<repo>/tar.gz/<sha>`, extracts to `/tmp`.
4. **Sanity-checks the tree** (`www/` and `cgi-bin/router-api` must exist).
5. Runs the *downloaded* `scripts/install.sh` — so update logic ships with the
   content and can fix itself.
6. Writes the new SHA only on success.

Safety properties worth preserving if you change this:

- A lock dir (`/var/lock/my-router-update.lock`) stops cron and the GUI button
  from running at once.
- The web UI is staged in `/www/app.new` then swapped, so a half-copied UI is
  never served.
- Any failure leaves the previous version in place and the SHA unchanged, so
  the next run retries.
- **A bad commit on master reaches every router within 15 minutes.** There is no
  staged rollout. Test on one device before pushing.

Manual use:

```bash
my-router-update           # apply if changed
my-router-update --force   # re-apply current master
my-router-update --check   # report only; exit 10 = update available
logread -e my-router-update
```

### Adding a new router

```bash
ssh root@<ip>   # verify netshift + sing-box are installed and working
tar czf - www cgi-bin scripts config | ssh root@<ip> \
  'rm -rf /tmp/mr && mkdir -p /tmp/mr && tar xzf - -C /tmp/mr && sh /tmp/mr/scripts/install.sh'
```

The installer is idempotent and adds the cron job itself. Configure proxy
credentials on the device via UCI — never in this repo.

---

## 6. Troubleshooting

| Symptom | Check |
|---|---|
| GUI unreachable | `/etc/init.d/uhttpd restart`; is `/www/app/index.html` there? |
| Buttons do nothing | `logread -e router-api`; run the CGI by hand: `QUERY_STRING='action=status' /www/cgi-bin/router-api` |
| "Нет соединения" persists | `netshift check_proxy`, then `netshift clash_api get_group_latency redshield-urltest-out` — if every node is `0`/absent, the WAN or all nodes are down |
| Node shows "unknown" | Normal for ~15 s after a restart (`settling:1`) |
| Update not applying | `logread -e my-router-update`; `cat /etc/my-router/version`; stale lock: `rmdir /var/lock/my-router-update.lock` |
| Router full | `df -h /overlay` — 149 MB free; job logs live in `/tmp` (tmpfs, cleared on reboot) |

