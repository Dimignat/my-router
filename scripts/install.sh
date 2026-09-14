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

# --- uhttpd ---------------------------------------------------------------
# The kiosk UI lives at /app/ and the API at /cgi-bin/router-api; both are
# served by the stock uhttpd instance, so no extra daemon is needed.
/etc/init.d/uhttpd reload >/dev/null 2>&1 || /etc/init.d/uhttpd restart >/dev/null 2>&1

if [ "$FROM_UPDATE" = "0" ]; then
    log "installed. Open http://192.168.2.1/app/ from the LAN."
fi
