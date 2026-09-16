# Setting up a new router

Start-to-finish for a new GL.iNet GL-MT3000 that should join the fleet.
Budget about 45 minutes. Everything here was verified against the working
router at `192.168.2.1`.

> **Do this at a desk, on a wired connection, with the router in front of you.**
> Flashing firmware over Wi-Fi is how routers get bricked.

---

## 0. What you need

- The router, its PSU, and an Ethernet cable
- A computer that can reach `192.168.8.1` (GL.iNet stock) / `192.168.1.1` (OpenWrt)
- Your list of new VLESS keys
- An internet uplink for the router (WAN port or repeater)

Target versions — the combination known to work:

| | Version |
|---|---|
| OpenWrt | **24.10.7** (`mediatek/filogic`, `aarch64_cortex-a53`) |
| NetShift | **0.9.7** (latest; the reference router runs 0.9.6) |
| sing-box | 1.12.22 from the feed; NetShift then installs **1.14.0-extended** |

---

## 1. Flash OpenWrt 24.10.7

GL-MT3000 ships with GL.iNet's own firmware. Replace it with vanilla OpenWrt.

```bash
# Download and verify BEFORE flashing.
curl -LO https://downloads.openwrt.org/releases/24.10.7/targets/mediatek/filogic/openwrt-24.10.7-mediatek-filogic-glinet_gl-mt3000-squashfs-sysupgrade.bin
shasum -a 256 openwrt-24.10.7-mediatek-filogic-glinet_gl-mt3000-squashfs-sysupgrade.bin
# must print:
# 261a365629e7ff40287d325567f29617401b66e1efa51238eeb77300c0338b35
```

**If the checksum does not match, stop.** Do not flash it.

Then, from the GL.iNet web UI (`http://192.168.8.1`):

1. **System → Upgrade → Local Upgrade**
2. Select the `-squashfs-sysupgrade.bin` file
3. **Uncheck "Keep settings"** — you are changing firmware family
4. Flash, and wait. Do not unplug. The router comes back on **`192.168.1.1`**

<details>
<summary>If it ends up unbootable</summary>

GL-MT3000 has a U-Boot recovery web server: unplug, hold **Reset**, plug in,
keep holding ~8 s until the LED flashes, then open `http://192.168.1.1` and
upload the `-initramfs-kernel.bin` image.
</details>

---

## 2. First boot

```bash
ssh root@192.168.1.1        # no password yet
passwd                      # set one
```

Get it online — plug the WAN port into your uplink, or configure a repeater in
LuCI (`http://192.168.1.1` → Network → Wireless). Confirm before continuing:

```bash
ping -c3 1.1.1.1 && nslookup openwrt.org
```

Set the LAN subnet. **Every router in the fleet uses a different one**, or you
cannot tell them apart and the GUI's own address collides:

```bash
uci set network.lan.ipaddr='192.168.3.1'    # .2.1 is taken by the first router
uci commit network
/etc/init.d/network restart
# reconnect on the new address
```

---

## 3. Install NetShift

```bash
sh <(wget -O - https://raw.githubusercontent.com/yandexru45/netshift/refs/heads/main/install.sh)
```

This pulls the **latest** release (0.9.7 as of 2026-09-16), installs `netshift`
and `luci-app-netshift`, and brings in `sing-box`, `jq` and `coreutils-base64`
as dependencies. It needs ~25 MB free and refuses OpenWrt 23.

Then install the extended sing-box, which is what the reference router runs and
what the REALITY/gRPC nodes need:

```bash
netshift component_action sing_box install_extended
netshift show_sing_box_version     # expect 1.14.0-extended
```

Verify:

```bash
netshift get_status                # {"enabled":1,...}
netshift get_system_info
```

NetShift also appears in LuCI under **Services → NetShift**.

---

## 4. Add your VLESS keys

The keys live in UCI, **never in this repo** — it is public.

```bash
uci set netshift.redshield.urltest_proxy_links="vless://KEY1
vless://KEY2
vless://KEY3"
uci commit netshift
/etc/init.d/netshift restart
```

Paste the links one per line, exactly as given. Keeping them in the same order
as the reference router matters if you want the GUI's country labels to line up
(see *Exit countries* in `CLAUDE.md`) — the mapping is positional.

Match the rest of the reference router's routing config:

```bash
uci set netshift.redshield.connection_type='proxy'
uci set netshift.redshield.proxy_config_type='urltest'
uci set netshift.redshield.urltest_check_interval='10m'
uci set netshift.redshield.urltest_tolerance='150'
uci set netshift.redshield.urltest_testing_url='https://www.gstatic.com/generate_204'
uci set netshift.redshield.fully_routed_ips='192.168.3.0/24'   # THIS router's subnet

# Russian sites bypass the tunnel.
uci set netshift.direct_routes.connection_type='exclusion'
uci set netshift.direct_routes.user_domain_list_type='text'
uci set netshift.direct_routes.user_domains_text='cloud.ru
sbercloud.ru
nalog.ru
mos.ru
sberdevices.ru'
uci set netshift.direct_routes.remote_domain_lists='https://raw.githubusercontent.com/Noktomezo/RussiaFancyLists/main/lists/whitelist-sing-box/domains.srs'

uci commit netshift
/etc/init.d/netshift restart
```

Check it took — **all three rulesets must be present**:

```bash
sleep 20
grep -c 'direct_routes-user-domains-ruleset' /etc/sing-box/config.json   # expect 4, not 0
netshift clash_api get_group_latency redshield-urltest-out               # expect latencies
```

If that count is `0`, the rulesets did not generate. Clear the cache and retry:

```bash
rm -rf /tmp/sing-box/rulesets
/etc/init.d/netshift restart
```

---

## 5. Install the GUI

From your computer, in a checkout of this repo:

```bash
NEW=192.168.3.1
tar czf - www cgi-bin scripts config | ssh root@$NEW \
  'rm -rf /tmp/mr && mkdir -p /tmp/mr && tar xzf - -C /tmp/mr && sh /tmp/mr/scripts/install.sh'
```

The installer registers `router.lan`, sets up the root dispatcher, and adds the
15-minute update cron. From then on the router tracks `master` by itself.

Open **http://router.lan** from a device on that router's Wi-Fi.

---

## 6. Check it before handing it over

```bash
curl -s "http://192.168.3.1/cgi-bin/router-api?action=status"
# want: "online":1, a real "node", a "latency", "reason":""

curl -s "http://192.168.3.1/cgi-bin/router-api?action=servers" | head -c 300
```

Then, from a device on the router's Wi-Fi:

- [ ] `http://router.lan` loads and shows a green lamp
- [ ] **Переподключиться** completes and reports success
- [ ] **Выбрать страну** lists the servers with countries and latencies
- [ ] A blocked site opens
- [ ] A direct-routed site (`sberdevices.ru`, `nalog.ru`) opens
- [ ] `cat /etc/my-router/version` matches `git rev-parse HEAD`

---

## Gotchas

- **The install script always takes the newest NetShift.** To pin a version,
  download that release's `.ipk` files from
  `github.com/yandexru45/netshift/releases` and `opkg install` them directly.
- **Don't enable `procd respawn` on netshift.** It restart-loops and silently
  drops the direct-routing rules — see the note in `CLAUDE.md`.
- **Give each router its own LAN subnet**, and set `fully_routed_ips` to match.
- **Never commit `/etc/config/netshift`.** It holds live VLESS UUIDs and REALITY
  keys, and this repo is public.
- **A bad commit reaches every router within 15 minutes.** The updater
  health-checks after installing and rolls back on failure, but test on one
  device first.
