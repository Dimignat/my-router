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
| `www/img/background.webp` | `/www/app/img/` | Background photo (see below) |
| `cgi-bin/router-api` | `/www/cgi-bin/router-api` | JSON control API (CGI) |
| `cgi-bin/index-router` | `/www/cgi-bin/index-router` | Root dispatcher: GUI on the friendly name, LuCI otherwise |
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

Then open **http://router.lan** (or `http://router`).

### URLs

| URL | Serves |
|---|---|
| `http://router.lan`, `http://router` | Kiosk GUI (what users get) |
| `http://192.168.2.1/app/` | Same GUI, by IP |
| `http://192.168.2.1` | Redirects to LuCI, for administration |

**How the split works.** uhttpd has no virtual hosts, so `/www/cgi-bin/index-router`
is registered as its 404 handler (`uhttpd.main.error_page`) and branches on
`HTTP_HOST`: the friendly names get the GUI, everything else is redirected to
LuCI. It serves the page **only for `/`** and returns a real 404 for any other
missing path — without that guard a missing asset comes back as the GUI's HTML
with `200 OK`, which masks genuine breakage. Two settings this depends on:

- `uhttpd.main.no_dirlists='1'` — without it uhttpd answers `/` with a
  directory listing and the handler never runs.
- `/www/index.html` is moved to `/www/index.html.orig` — a real file at `/`
  would shadow the handler.

dnsmasq resolves both names via `dhcp.@domain[]` entries. It is already
authoritative for `.lan`, so rebind protection does not interfere. Note DNS on
this router is chained through sing-box (`noresolv=1`, `server=127.0.0.42`);
the `@domain` entries are answered by dnsmasq itself and are unaffected.

LuCI answers unauthenticated requests with **HTTP 403 and a login page** — that
is normal, not a fault of this setup.

---

## 4. The GUI

Reachable at **http://router.lan** (no path, no IP). Aimed at users who are
not confident with computers, so: three actions, plain
Russian, no jargon ("VPN", "proxy", "sing-box" appear nowhere), ~84px touch
targets, and a status lamp that always pairs colour with words.

| Button | Action | What happens | Time |
|---|---|---|---|
| **Переподключиться** (Reconnect) | `?action=reconnect` | Re-tests node latency, forces the urltest group to re-pick. Existing connections survive. | ~5 s |
| **Перезапустить** (Reload) | `?action=reload` | `/etc/init.d/netshift restart`. Internet blips; **Wi-Fi stays up**, nobody is kicked off. | ~10 s |
| **Проверить обновления** (Update) | `?action=update` | Pulls master from GitHub immediately instead of waiting for the 15-min cron. Reports whether a new version was installed or the router was already current. | ~5 s |

The footer shows the running node and the installed commit (`Версия fdb1cc7`),
so you can tell at a glance which version a device is on without SSH.

### The intro

On load the photo is shown full-bleed for **1 s**, then fades over 0.7 s while
the scrim comes up under it; the controls rise into place at 1.15 s. It is a
CSS animation on `.splash` — deliberately not JS — so a script failure can
never leave a user staring at a photo they cannot dismiss. `app.js` only tidies
up afterwards (removes the node, allows a tap to skip). Users who set
*reduce motion* skip the intro entirely.

### Changing the background

The page background is `www/img/background.webp`. To change it on every
router, replace that file and push:

```bash
cp /path/to/new.webp www/img/background.webp
git commit -am "New background" && git push
```

Routers pick it up on the next 15-minute poll, or immediately via the
**Проверить обновления** button.

- Keep the same filename, or update the `url()` in `www/style.css`.
- WebP, JPEG and PNG all work. Keep it small — it ships to every router over
  the tunnel, and the overlay has ~150 MB free. The current file is 10 KB.
- The installer stamps `?v=<timestamp>` onto the stylesheet, script and
  background URL on every install. **This matters:** uhttpd sends `ETag` and
  `Last-Modified` but no `Cache-Control`, so without the stamp a browser that
  already cached the old photo would keep showing it after a push.
- A portrait is cropped with `background-position: center 15%` so the subject
  survives tall phone viewports; adjust that if a new image crops badly.
- The photo sits under a dark scrim (`body::after`) that holds text contrast.
  If you swap in a much lighter or busier image, re-check legibility rather
  than assuming — the scrim is tuned, not magic.
- If the file is missing the page falls back to the original gradient, so a
  broken image degrades rather than blanking the page.

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
Push over SSH (`git@github.com:Dimignat/my-router.git`) — an HTTPS push has no
cached credential on the dev machine.

Every router runs `*/15 * * * * /usr/bin/my-router-update`. Each run:

1. `GET api.github.com/repos/<repo>/commits/master` with
   `Accept: application/vnd.github.sha` → remote SHA.
   **The URL carries a unique `?cb=` parameter.** That endpoint sends
   `cache-control: public, max-age=60`, so without it the CDN serves the
   previous commit for up to a minute after a push and the router decides it
   is already current — the update then appears to work only on a second
   attempt. A fresh cache key is the only reliable fix here; `Cache-Control:
   no-cache` request headers and the `git/refs` endpoint are both still served
   from the same cache. Don't remove it.
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
| `router.lan` doesn't resolve | Client must use the router for DNS. Check `uci show dhcp \| grep @domain`, then `nslookup router.lan 192.168.2.1`. Phones with private/secure DNS enabled bypass it — use the IP there. |
| `router.lan` shows a file listing | `uci set uhttpd.main.no_dirlists=1; uci commit uhttpd; /etc/init.d/uhttpd restart` |
| `router.lan` shows LuCI | `/www/index.html` is shadowing the handler, or `error_page` is unset — re-run the installer |
| Buttons do nothing | `logread -e router-api`; run the CGI by hand: `QUERY_STRING='action=status' /www/cgi-bin/router-api` |
| "Нет соединения" persists | `netshift check_proxy`, then `netshift clash_api get_group_latency redshield-urltest-out` — if every node is `0`/absent, the WAN or all nodes are down |
| Node shows "unknown" | Normal for ~15 s after a restart (`settling:1`) |
| Update not applying | `logread -e my-router-update`; `cat /etc/my-router/version`; stale lock: `rmdir /var/lock/my-router-update.lock` |
| Update says "already current" right after a push | The `?cb=` cache-buster is missing from the SHA request — see step 1 above |
| Router full | `df -h /overlay` — 149 MB free; job logs live in `/tmp` (tmpfs, cleared on reboot) |

