---
title: Phone and other devices
---

# Phone and other devices

The server binds `0.0.0.0:8000`, and every UI and image URL is relative, so on a normal Linux host you
can open `http://<host-ip>:8000` from any device on the LAN. `serve` prints the address it detects.

The UI is built for touch: tap to open a photo, double-tap to like, swipe to move between photos and
swipe down to close. The dock and its panels work the same as on desktop.

<div className="phones">

![The library](/img/screenshots/phone-library.jpg)
![The Subjects panel](/img/screenshots/phone-subjects.jpg)
![The info sheet](/img/screenshots/phone-lightbox-info.jpg)

</div>

## WSL2

WSL2 uses NAT by default, so the IP that `serve` prints (for example `172.x.x.x`) is only reachable
from the Windows host. To reach the server from other devices, use either option.

**Mirrored networking** (Windows 11 22H2 and later): add the following to `%UserProfile%\.wslconfig`,
then run `wsl --shutdown`. WSL then shares the Windows IP. You may also need to allow port 8000 in
the Windows firewall.

```ini
[wsl2]
networkingMode=mirrored
```

**Port proxy**: in an elevated PowerShell, run:

```powershell
netsh interface portproxy add v4tov4 listenport=8000 listenaddress=0.0.0.0 connectport=8000 connectaddress=<wsl-ip>
New-NetFirewallRule -DisplayName "photo-lib 8000" -Direction Inbound -LocalPort 8000 -Protocol TCP -Action Allow
```

The WSL IP changes on reboot, so you need to run the `netsh` command again after one.

Then browse to `http://<windows-lan-ip>:8000`.
