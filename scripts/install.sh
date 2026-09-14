#!/bin/sh
# Install / update my-router on an OpenWrt device.
#
#   sh scripts/install.sh                     install from the current directory
#   sh scripts/install.sh --from-update DIR   called by my-router-update
#
# Idempotent: safe to re-run. Only touches files this project owns.

set -u

SRC="$(cd "$(dirname "$0")/.." && pwd)"
FROM_UPDATE=0
if [ "${1:-}" = "--from-update" ]; then
    FROM_UPDATE=1
    SRC="${2:?--from-update needs a source dir}"
fi

WWW=/www/app
CGI=/www/cgi-bin/router-api
STATE_DIR=/etc/my-router

log() { echo "[install] $*"; }

[ -d "$SRC/www" ] || { log "no www/ in $SRC; aborting"; exit 1; }

mkdir -p "$STATE_DIR"

# --- web UI ---------------------------------------------------------------
log "installing web UI to $WWW"
mkdir -p "$WWW"
# Write to a temp dir then swap, so a half-copied UI is never served.
rm -rf "$WWW.new"
mkdir -p "$WWW.new"
cp -r "$SRC/www/." "$WWW.new/"
rm -rf "$WWW.old"
[ -d "$WWW" ] && mv "$WWW" "$WWW.old"
mv "$WWW.new" "$WWW"
rm -rf "$WWW.old"

# --- control API ----------------------------------------------------------
log "installing control API to $CGI"
cp "$SRC/cgi-bin/router-api" "$CGI.new"
chmod +x "$CGI.new"
mv "$CGI.new" "$CGI"

# --- updater --------------------------------------------------------------
log "installing updater to /usr/bin/my-router-update"
cp "$SRC/scripts/my-router-update" /usr/bin/my-router-update.new
chmod +x /usr/bin/my-router-update.new
mv /usr/bin/my-router-update.new /usr/bin/my-router-update

# --- repo/branch settings -------------------------------------------------
if [ -f "$SRC/config/settings.conf" ] && [ ! -f "$STATE_DIR/settings.conf" ]; then
    cp "$SRC/config/settings.conf" "$STATE_DIR/settings.conf"
    log "seeded $STATE_DIR/settings.conf"
fi

# --- cron: poll master every 15 minutes -----------------------------------
CRON_LINE='*/15 * * * * /usr/bin/my-router-update >/dev/null 2>&1'
if ! crontab -l 2>/dev/null | grep -qF 'my-router-update'; then
    log "adding update cron (every 15 min)"
    ( crontab -l 2>/dev/null; echo "$CRON_LINE" ) | crontab -
    /etc/init.d/cron restart >/dev/null 2>&1
else
    log "update cron already present"
fi

# --- friendly hostname ----------------------------------------------------
# Users get http://router.lan instead of an IP address. dnsmasq is already
# authoritative for .lan, so no rebind-protection exception is needed.
HOSTNAME_LOCAL="${MY_ROUTER_HOSTNAME:-router.lan}"
LAN_IP=$(uci -q get network.lan.ipaddr || echo 192.168.2.1)

dns_changed=0
# Register both the FQDN and the bare short name: phones that append a search
# domain send one, browsers that don't send the other.
for name in "$HOSTNAME_LOCAL" "${HOSTNAME_LOCAL%%.*}"; do
    if ! uci -q show dhcp | grep -q "\.name='$name'"; then
        log "registering $name -> $LAN_IP"
        uci add dhcp domain >/dev/null
        uci set dhcp.@domain[-1].name="$name"
        uci set dhcp.@domain[-1].ip="$LAN_IP"
        dns_changed=1
    fi
done
if [ "$dns_changed" = "1" ]; then
    uci commit dhcp
    /etc/init.d/dnsmasq restart >/dev/null 2>&1
else
    log "$HOSTNAME_LOCAL already registered"
fi

# --- root dispatcher ------------------------------------------------------
# uhttpd has no vhosts, so the 404 handler decides what "/" serves based on
# the Host header: the GUI on the friendly name, LuCI on the IP.
log "installing root dispatcher"
cp "$SRC/cgi-bin/index-router" /www/cgi-bin/index-router.new
chmod +x /www/cgi-bin/index-router.new
mv /www/cgi-bin/index-router.new /www/cgi-bin/index-router

# /www/index.html would shadow the handler, so move it aside once.
if [ -f /www/index.html ] && [ ! -f /www/index.html.orig ]; then
    mv /www/index.html /www/index.html.orig
    log "moved stock /www/index.html aside (kept as index.html.orig)"
fi

uhttpd_changed=0
if [ "$(uci -q get uhttpd.main.error_page)" != "/cgi-bin/index-router" ]; then
    uci set uhttpd.main.error_page='/cgi-bin/index-router'
    uhttpd_changed=1
    log "set uhttpd error_page handler"
fi
# Without this, uhttpd answers "/" with a directory listing and the handler
# above never runs.
if [ "$(uci -q get uhttpd.main.no_dirlists)" != "1" ]; then
    uci set uhttpd.main.no_dirlists='1'
    uhttpd_changed=1
    log "disabled directory listings"
fi
[ "$uhttpd_changed" = "1" ] && uci commit uhttpd

# --- uhttpd ---------------------------------------------------------------
# The kiosk UI lives at /app/ and the API at /cgi-bin/router-api; both are
# served by the stock uhttpd instance, so no extra daemon is needed.
/etc/init.d/uhttpd restart >/dev/null 2>&1

if [ "$FROM_UPDATE" = "0" ]; then
    log "installed. Open http://$HOSTNAME_LOCAL from the LAN."
fi
