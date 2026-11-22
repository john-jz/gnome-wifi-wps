# Wi-Fi WPS

A GNOME Shell extension that adds WPS (Wi-Fi Protected Setup) push-button
connect to Quick Settings.

## Why

GNOME Settings' Wi-Fi panel used to show a WPS option in the password dialog
when connecting to a WPS-capable network. That dialog was rewritten for GTK4
and the WPS flow didn't make the trip — as of GNOME 51, `gnome-control-center`
and `libnma`/`libnma-gtk4` have no WPS code paths at all (checked directly:
no WPS-related strings anywhere in those binaries). `nm-applet`'s classic tray
dialog still has it, but GNOME has no system tray by default.

This extension fills that gap natively in Quick Settings, using NetworkManager's
own `libnm` (no shelling out to `nmcli`/`wpa_cli`, no extra daemons).

## What it does

- Adds a "WPS" entry to Quick Settings.
- Lists currently-visible access points that advertise WPS support (detected
  via `NM.AccessPoint`'s `80211ApFlags.WPS` flag — the same mechanism
  NetworkManager itself uses internally).
- Clicking an entry creates a connection profile with
  `wps-method = pbc` and activates it, then shows a notification telling you
  to press the physical WPS button on that router within the ~2 minute window.

PIN-method WPS isn't exposed in the UI — push-button is nearly universal on
real hardware, and surfacing a PIN well (generating one, displaying it, timing
it against the router's own admin UI) needs more UX than a first cut over.

## Requirements

- GNOME Shell 48–51 (ESM extension API).
- `wpa_supplicant` as NetworkManager's Wi-Fi backend (not `iwd` — `iwd`'s WPS
  support is far more limited). Check with:
  `systemctl is-active wpa_supplicant.service`.

## Install

```sh
./install.sh
```

Then either log out/in (Wayland), or on X11 press `Alt+F2`, type `r`, Enter —
and enable it:

```sh
gnome-extensions enable wifi-wps@john-jz.github.io
```

## Known limitations

- NetworkManager's `80211ApFlags` on this hardware/driver combination sets the
  generic `WPS` bit reliably, but not always the more specific `WPS_PBC`/
  `WPS_PIN` sub-flags, even for APs confirmed (via a raw `iw scan` dump) to
  advertise `Config methods: Label, Display, PBC`. So this extension always
  attempts the `pbc` method rather than branching on those sub-flags — that
  matches real-world WPS routers, which are overwhelmingly push-button.
- A hidden/unresolved SSID (empty in NetworkManager's scan cache until a probe
  response arrives) is skipped from the list, since a connection profile can't
  be built without a known SSID.
