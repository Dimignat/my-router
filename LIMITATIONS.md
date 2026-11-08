# Router limitations: heavy downloads kill the connection

Router: GL-MT3000 at `192.168.2.1`, OpenWrt 24.10.7, NetShift 0.9.6 driving sing-box 1.14.0-extended as a
tproxy. VLESS/REALITY nodes behind a `urltest` group, fake-IP DNS, whole LAN routed through it
(`fully_routed_ips`). See `CLAUDE.md` §1–2 for the device and how traffic flows.

## Symptom

During sustained, heavy downloads the internet dies for the whole LAN and stays dead until the router is
rebooted. LAN-only traffic (SSH between machines) keeps working.

Seen so far:

| when | what was running | outcome |
|---|---|---|
| 2026-09-30 | home-lab setup | froze, no logs survived |
| 2026-10-01 ~08:50 | 3 GB Whisper model download from HuggingFace on the GPU VM (.12), right after multi-GB PyTorch / checkpoint downloads | died; manual reboot |
| 2026-10-01 09:05 | 1.6 GB HuggingFace download, single stream throttled to 4 MB/s | one connection dropped mid-file; router survived |

Typical trigger: multi-GB transfers at 30+ MB/s over many parallel connections (pip / PyTorch wheels,
HuggingFace's Xet client, which opens many streams at once).

## What is known

- All LAN traffic goes through sing-box, a userspace Go process doing VLESS/Reality/gRPC on the
  MT7981's two Cortex-A53 cores. Kernel fast paths and hardware offload don't apply to it.
- DNS is sing-box's fake-IP. If sing-box hangs or dies, both routing and name resolution stop.
- 512 MB RAM (497 MB usable). At idle: ~98 MB used, sing-box RSS ~54 MB, conntrack 248 / 31232.
- The hardware watchdog is on (31 s). A frozen kernel would reboot by itself, but the router doesn't,
  so the kernel stays alive and the failure is most likely in userspace: sing-box hanging or being
  OOM-killed under load.
- **Root cause is not proven.** OpenWrt keeps logs in RAM (`logread`), so each reboot erased the evidence.

## Workarounds that work (client side)

- Throttle big downloads to one stream: `curl -L --limit-rate 4M --retry 5 -C - -o FILE URL`.
  `-C -` resumes a partial file after a drop.
- HuggingFace: `HF_HUB_DISABLE_XET=1` (plain HTTPS instead of the many-connection Xet client), or fetch
  files with throttled `curl` and point the tool at the local directory.
- Prefer copying models and wheels over the LAN from a machine that already has them.

## Possible fixes (not applied, by decision on 2026-10-01)

1. Ship router syslog to the Proxmox host (`log_ip=192.168.2.10`) so the next freeze leaves evidence.
2. Route pypi.org, pythonhosted.org, huggingface.co, hf.co, download.pytorch.org and github.com via
   `direct_routes` / `DIRECT_DOMAINS`. Lighter for sing-box (no encryption), but traffic still passes
   through it.
3. Stronger: exclude the lab hosts (.10–.12) from the tunnel by source IP so their traffic never touches
   sing-box. Only if nothing on them needs the VPN.
4. A cron health check that restarts just sing-box when the tunnel stops answering, so a hang recovers in
   about a minute without a reboot.
5. Cap sing-box's Go heap (`GOMEMLIMIT`) so it collects garbage before the kernel OOM-kills it.
