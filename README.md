# Wi-Fi WPS

A GNOME Shell extension that adds WPS (Wi-Fi Protected Setup) push-button
connect directly onto GNOME's own Wi-Fi quick-settings network list — no
separate menu, no separate tile.

## Why

GNOME Settings' Wi-Fi panel used to show a WPS option in the password dialog
when connecting to a WPS-capable network. That dialog was rewritten for GTK4
and the WPS flow didn't make the trip — as of GNOME 51, `gnome-control-center`
and `libnma`/`libnma-gtk4` have no WPS code paths at all (checked directly:
no WPS-related strings anywhere in those binaries). `nm-applet`'s classic tray
dialog still has it, but GNOME has no system tray by default.

This extension fills that gap in place, inside the real Wi-Fi network list,
using NetworkManager's own `libnm` (no shelling out to `nmcli`/`wpa_cli`, no
extra daemons).

## What it does

- Scans the Wi-Fi quick-settings list (the one you get by clicking the Wi-Fi
  tile) for access points that advertise WPS support, detected via
  `NM.AccessPoint`'s `80211ApFlags.WPS` flag — the same mechanism
  NetworkManager itself uses internally.
- Adds a small "WPS" button directly onto that access point's row.
- Clicking it creates a connection profile with `wps-method = pbc` and
  activates it, then shows a notification telling you to press the physical
  WPS button on that router within the ~2 minute window.

PIN-method WPS isn't exposed in the UI — push-button is nearly universal on
real hardware, and surfacing a PIN well (generating one, displaying it, timing
it against the router's own admin UI) needs more UX than a first cut over.

## How it integrates with the native Wi-Fi menu

GNOME Shell doesn't expose a documented extension point for adding to its
built-in Wi-Fi list, so this uses `InjectionManager` (GNOME's own supported
tool for safely overriding built-in Shell methods) to hook
`Main.panel.statusArea.quickSettings._network`'s private internals
(`_wirelessToggle`, `_items`, `_networkItems`, `checkAccessPoint()`) and
attach a button onto the row for each WPS-capable AP. This pattern mirrors
real published extensions that do the same kind of thing — e.g.
[gse-disconnect-wifi](https://github.com/kgshank/gse-disconnect-wifi) adds a
per-row "Disconnect" button the same way, and
[wifi-hotspot-quick-settings](https://github.com/Aryan10/wifi-hotspot-quick-settings)
uses the same `InjectionManager` attach pattern.

**This is private API, not a stable one.** Those property names aren't part
of any documented extension contract and can change on any GNOME release
without notice. Every private-property access here fails soft (no-ops
instead of throwing) specifically so a future GNOME update that renames
something just means no WPS buttons appear — not a broken Wi-Fi menu.

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
