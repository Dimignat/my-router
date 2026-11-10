# Control-panel local hostname

On the home OpenWrt router at `192.168.2.1`, `panel.lan` resolves to the Deck's
reserved address, **192.168.2.110**. Devices using this router for DNS can open
**http://panel.lan**. The Deck redirects port 80 to `http://panel.lan:8090`.
The existing `router.lan` entries are unchanged.

Applied UCI configuration:

```text
config domain 'panel_lan'
    option name 'panel.lan'
    option ip '192.168.2.110'
```

To reproduce on this router:

```sh
uci set dhcp.panel_lan=domain
uci set dhcp.panel_lan.name='panel.lan'
uci set dhcp.panel_lan.ip='192.168.2.110'
uci commit dhcp
/etc/init.d/dnsmasq reload
```

This is home-specific configuration, not part of the fleet GUI installer or
automatic updater. The Deck's entry point is managed by
`../homeassistant/compose.panel.yaml` in the smart-home repository; the backend
also includes `panel.lan` in its hostname allowlist. The kiosk continues using
localhost, so its operation does not depend on local DNS.

Before applying the record, the router's DHCP configuration was backed up to
`/root/dhcp-before-panel-lan-20261108224339.conf`. DNS resolution was verified on
the router, Deck and Mac. The default-port redirect and live panel were checked
without changing HA configuration.

To remove just this DNS record without undoing later DHCP changes:

```sh
uci delete dhcp.panel_lan
uci commit dhcp
/etc/init.d/dnsmasq reload
```

To stop only the port-80 entry point, run from the Deck's `homeassistant` folder:

```sh
docker compose -f compose.panel.yaml stop panel-address
```

The IP address with port 8090 and the local kiosk remain usable.
