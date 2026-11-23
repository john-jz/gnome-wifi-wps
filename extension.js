import NM from 'gi://NM';
import Clutter from 'gi://Clutter';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Network from 'resource:///org/gnome/shell/ui/status/network.js';
import {QuickSettingsItem} from 'resource:///org/gnome/shell/ui/quickSettings.js';

import {Extension, InjectionManager, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

const AP_FLAGS = NM['80211ApFlags'];

function ssidToUtf8(ap) {
    const bytes = ap.get_ssid();
    if (!bytes)
        return null;
    return NM.utils_ssid_to_utf8(bytes.get_data());
}

// Finds every actor carrying a `_network` property -- GNOME's own per-SSID
// row widget (class `NMWirelessNetworkItem` as of GNOME 51, confirmed live
// via Looking Glass). Its exact container nesting (a scroll view wrapping a
// box layout) isn't documented, so this walks the actor tree rather than
// assuming a fixed depth.
function findNetworkRows(actor, out = []) {
    if (!actor)
        return out;
    if (actor._network)
        out.push(actor);
    if (typeof actor.get_children === 'function') {
        for (const child of actor.get_children())
            findNetworkRows(child, out);
    }
    return out;
}

// Each row's `_network` wrapper holds `_accessPoints` as a Set of the real
// NM.AccessPoint objects sharing that SSID (confirmed live: a plain Array
// assumption breaks here, it is genuinely a Set).
function wpsAccessPoint(network) {
    for (const ap of network?._accessPoints ?? [])
        if (ap.get_flags() & AP_FLAGS.WPS)
            return ap;
    return null;
}

// Adds a small "WPS" button onto the quick-settings row for any nearby
// WPS-capable access point. This relies on GNOME Shell's private Wi-Fi
// quick-settings internals -- not a documented extension API. The property
// names here were verified live (via Looking Glass) against this machine's
// actual GNOME 51.1, not copied blind from older published extensions
// (gse-disconnect-wifi, wifi-hotspot-quick-settings) that inspired the
// approach -- their exact property names (`_networkItems` as a Map) turned
// out to already be stale here (`_networks`, an Array, plus a `_network`
// back-reference on each row widget). Every access point below fails soft
// (no-ops) rather than throwing if something is missing, so a future GNOME
// release renaming something again just means no WPS buttons appear, not a
// broken Wi-Fi menu.
class WpsRowController {
    constructor() {
        this._buttons = new Map(); // row actor -> button
        this._hookedDevices = new Set();
        this._deviceSignalIds = new Map();
        this._clientSignalId = 0;
        this._menuOpenId = 0;
    }

    attachIndicator(indicator) {
        this._client = indicator?._client;
        const toggle = indicator?._wirelessToggle;
        if (!toggle || !this._client)
            return;
        this._toggle = toggle;

        try {
            this._clientSignalId = this._client.connect('device-added',
                (client, device) => this._hookDevice(device));
        } catch (e) { /* non-fatal -- hot-plugged devices just won't get a button */ }

        try {
            this._menuOpenId = toggle.menu?.connect('open-state-changed', (menu, open) => {
                if (open)
                    this._syncAll();
            });
        } catch (e) { /* non-fatal -- see first-sync fallback below */ }

        for (const device of toggle._nmDevices ?? [])
            this._hookDevice(device);
    }

    _syncAll() {
        for (const device of this._hookedDevices)
            this._syncDevice(device);
    }

    _hookDevice(device) {
        if (!device || device.get_device_type?.() !== NM.DeviceType.WIFI)
            return;
        if (this._hookedDevices.has(device))
            return;
        this._hookedDevices.add(device);

        const refresh = () => this._syncDevice(device);
        const ids = [
            device.connect('access-point-added', refresh),
            device.connect('access-point-removed', refresh),
        ];
        this._deviceSignalIds.set(device, ids);
        refresh();
    }

    _syncDevice(device) {
        const menuItem = this._toggle?._items?.get(device);
        const box = menuItem?._mainSection?.box;
        if (!box)
            return;

        const rows = findNetworkRows(box);
        const liveRows = new Set(rows);

        // Drop buttons whose row is gone (GNOME rebuilds this list whenever
        // the AP scan results change).
        for (const [row, button] of [...this._buttons]) {
            if (!liveRows.has(row)) {
                button.destroy();
                this._buttons.delete(row);
            }
        }

        for (const row of rows) {
            if (this._buttons.has(row))
                continue;
            const ap = wpsAccessPoint(row._network);
            if (!ap)
                continue;
            this._addButton(row, device, ap);
        }
    }

    _addButton(row, device, ap) {
        let button;
        try {
            button = new QuickSettingsItem({
                style_class: 'button',
                can_focus: true,
                icon_name: 'network-wireless-symbolic',
                label: _('WPS'),
                x_align: Clutter.ActorAlign.END,
            });
        } catch (e) {
            return;
        }

        button.connect('clicked', () => this._connect(device, ap));

        const destroyId = row.connect('destroy', () => {
            this._buttons.delete(row);
        });
        button.connect('destroy', () => {
            try {
                row.disconnect(destroyId);
            } catch (e) { /* row may already be gone */ }
        });

        try {
            row.add_child(button);
        } catch (e) {
            button.destroy();
            return;
        }

        this._buttons.set(row, button);
    }

    _connect(device, ap) {
        const ssid = ssidToUtf8(ap) ?? _('network');

        const connection = new NM.SimpleConnection();
        connection.add_setting(new NM.SettingConnection({
            type: '802-11-wireless',
            id: `wps-${ssid}`,
        }));
        connection.add_setting(new NM.SettingWireless({
            ssid: ap.get_ssid(),
        }));
        connection.add_setting(new NM.SettingWirelessSecurity({
            key_mgmt: 'wpa-psk',
            wps_method: NM.SettingWirelessSecurityWpsMethod.PBC,
        }));

        Main.notify(_('WPS: %s').format(ssid),
            _('Press the WPS button on the router now (you have about 2 minutes)'));

        this._client.add_and_activate_connection_async(
            connection, device, ap.get_path(), null,
            (client, result) => {
                try {
                    client.add_and_activate_connection_finish(result);
                    Main.notify(_('WPS: %s').format(ssid), _('Connected'));
                } catch (e) {
                    Main.notify(_('WPS: %s').format(ssid),
                        _('Failed: %s').format(e.message));
                }
            });
    }

    destroy() {
        if (this._menuOpenId && this._toggle?.menu) {
            try {
                this._toggle.menu.disconnect(this._menuOpenId);
            } catch (e) { /* menu may already be gone */ }
        }
        this._menuOpenId = 0;

        if (this._clientSignalId && this._client) {
            try {
                this._client.disconnect(this._clientSignalId);
            } catch (e) { /* client may already be gone */ }
        }
        this._clientSignalId = 0;

        for (const [device, ids] of this._deviceSignalIds) {
            for (const id of ids) {
                try {
                    device.disconnect(id);
                } catch (e) { /* device may already be gone */ }
            }
        }
        this._deviceSignalIds.clear();
        this._hookedDevices.clear();

        for (const button of this._buttons.values())
            button.destroy();
        this._buttons.clear();
    }
}

export default class WifiWpsExtension extends Extension {
    enable() {
        this._injectionManager = new InjectionManager();
        this._controller = new WpsRowController();

        const controller = this._controller;
        this._injectionManager.overrideMethod(
            Network.Indicator.prototype, '_init',
            originalMethod => {
                return function (...args) {
                    const result = originalMethod.call(this, ...args);
                    controller.attachIndicator(this);
                    return result;
                };
            }
        );

        const indicator = Main.panel.statusArea.quickSettings?._network;
        if (indicator)
            this._controller.attachIndicator(indicator);
    }

    disable() {
        this._injectionManager?.clear();
        this._injectionManager = null;

        this._controller?.destroy();
        this._controller = null;
    }
}
