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

// Walks NetworkManager's own list of access points (the public libnm API --
// stable across GNOME versions) rather than anything private, so the only
// private surface this touches is *locating the row widget* for an AP
// GNOME already knows about.
function wpsAccessPoints(device) {
    return device.get_access_points().filter(ap => ap.get_flags() & AP_FLAGS.WPS);
}

// Adds a small "WPS" button onto the quick-settings row for any nearby
// WPS-capable access point. This relies on GNOME Shell's private Wi-Fi
// quick-settings internals (_wirelessToggle, _items, _networkItems,
// checkAccessPoint()) -- not a documented extension API. Verified against
// real, published extensions doing the same kind of thing (gse-disconnect-
// wifi adds a per-row "Disconnect" button the same way; wifi-hotspot-quick-
// settings uses the same InjectionManager pattern to attach to the
// indicator). These property names can change on a future GNOME release
// without notice -- every method here fails soft (no-ops) rather than
// throwing into GNOME Shell's own code if something is missing.
class WpsRowController {
    constructor() {
        this._buttons = new Map(); // apMenuItem -> button
        this._hookedDevices = new Set();
        this._deviceSignalIds = new Map(); // device -> [signal ids]
        this._clientSignalId = 0;
    }

    attachIndicator(indicator) {
        this._indicator = indicator;
        this._client = indicator?._client;
        const toggle = indicator?._wirelessToggle;
        if (!toggle || !this._client)
            return;

        this._toggle = toggle;

        try {
            this._clientSignalId = this._client.connect('device-added',
                (client, device) => this._hookDevice(device));
        } catch (e) {
            // Non-fatal -- devices added after this point just won't get a
            // WPS button until the next enable()/disable() cycle.
        }

        for (const device of toggle._nmDevices ?? [])
            this._hookDevice(device);
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
        if (!menuItem?._networkItems)
            return;

        const entries = [...menuItem._networkItems.entries()];
        const wpsAps = wpsAccessPoints(device);

        // Drop buttons whose AP is gone or no longer WPS-capable.
        for (const [apMenuItem, button] of [...this._buttons]) {
            const entry = entries.find(([, item]) => item === apMenuItem);
            const stillWps = entry && wpsAps.some(ap => entry[0].checkAccessPoint(ap));
            if (!stillWps) {
                button.destroy();
                this._buttons.delete(apMenuItem);
            }
        }

        // Add a button for each WPS-capable AP that doesn't have one yet.
        for (const ap of wpsAps) {
            const entry = entries.find(([network]) => network.checkAccessPoint(ap));
            if (!entry)
                continue;
            const [, apMenuItem] = entry;
            if (this._buttons.has(apMenuItem))
                continue;

            this._addButton(apMenuItem, device, ap);
        }
    }

    _addButton(apMenuItem, device, ap) {
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

        const destroyId = apMenuItem.connect('destroy', () => {
            this._buttons.delete(apMenuItem);
        });
        button.connect('destroy', () => apMenuItem.disconnect(destroyId));

        try {
            apMenuItem.add_child(button);
        } catch (e) {
            button.destroy();
            return;
        }

        this._buttons.set(apMenuItem, button);
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
