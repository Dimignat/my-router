# Blocking IoT internet access

Applied on 2026-11-08 to the GL-MT3000 at `192.168.2.1`, running OpenWrt
24.10.7 and NetShift. The Fellow kettle (`192.168.2.101`, MAC
`00:4B:12:4D:14:38`) is blocked from direct internet access while remaining
reachable by Home Assistant on the Deck (`192.168.2.110`). Bluetooth is unaffected.

## Applied configuration

The exact rule is tracked in [config/20-iot-offline.nft](config/20-iot-offline.nft).
On the router it lives at `/etc/nftables.d/20-iot-offline.nft`. Firewall4 includes
these files inside its `inet fw4` table on reload and boot. The GUI installer and
automatic updater do not deploy this file; it is managed separately.

NetShift currently routes all of `192.168.2.0/24` through its proxy. Its packet
marking hook runs at priority `-150`, followed by transparent proxy interception
at `-100`. A normal LAN-to-WAN forwarding rule can miss traffic intercepted
before forwarding. This rule instead filters at prerouting priority **-160**,
before NetShift, without changing proxy configuration or restarting NetShift.

For source MACs in `iot_offline_macs` arriving on `br-lan`, it permits:

- IPv4 destinations in `192.168.2.0/24`, limited broadcast and IPv4 multicast.
- IPv6 unique-local, link-local and link-local multicast destinations.

All other IPv4/IPv6 destinations are dropped. Local DHCP, DNS, discovery and
Home Assistant communication remain possible. This is a block on routed internet
traffic, not isolation from other LAN devices or from services on the router.
It does not prevent a phone from transferring firmware over Bluetooth or undo an
update already downloaded. Change the allowed subnet if the LAN is renumbered.

## Verification

At deployment:

- `fw4 check` passed and firewall reload succeeded.
- Both custom chains were present; NetShift's rules remained present.
- Kettle HTTP returned 200; Home Assistant HTTP returned 200.
- The router's internet connectivity check returned HTTP 204.
- The drop counter was zero: no kettle internet attempt was observed during
  verification. End-to-end blocking of a real update attempt was not tested.

Read the current rules and drop counter:

```sh
ssh root@192.168.2.1 'nft list chain inet fw4 iot_offline_prerouting; nft list chain inet fw4 iot_offline_destinations'
```

## Adding devices or changing the rule

Add source MAC addresses to `iot_offline_macs`, separated by commas. Only add
devices intended to operate without cloud services. Keep the tracked and live
files in sync. After editing the router's file, validate before loading:

```sh
ssh root@192.168.2.1 'fw4 check && /etc/init.d/firewall reload'
```

To copy the tracked file to the router, run from this repository. This replaces
the live file, so first retrieve any live edits and back it up if needed:

```sh
ssh root@192.168.2.1 'cat > /etc/nftables.d/20-iot-offline.nft' < config/20-iot-offline.nft
ssh root@192.168.2.1 'fw4 check && /etc/init.d/firewall reload'
```

## Rollback

Disable the include by renaming it so it no longer ends in `.nft`, then reload:

```sh
ssh root@192.168.2.1 'mv /etc/nftables.d/20-iot-offline.nft /etc/nftables.d/20-iot-offline.nft.disabled && /etc/init.d/firewall reload'
```

To re-enable it, rename it back, run `fw4 check`, then reload the firewall.
