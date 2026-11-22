import GObject from 'gi://GObject';
import NM from 'gi://NM';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as QuickSettings from 'resource:///org/gnome/shell/ui/quickSettings.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {Extension, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

const AP_FLAGS = NM['80211ApFlags'];

function ssidToUtf8(ap) {
    const bytes = ap.get_ssid();
    if (!bytes)
        return null;
    return NM.utils_ssid_to_utf8(bytes.get_data());
}

const WpsToggle = GObject.registerClass(
class WpsToggle extends QuickSettings.QuickMenuToggle {
    _init() {
        super._init({
            title: _('WPS'),
            iconName: 'network-wireless-symbolic',
            toggleMode: false,
        });

        this.menu.setHeader('network-wireless-symbolic', _('Wi-Fi WPS'),
            _('Connect to a network via its WPS button'));

        this._itemsSection = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._itemsSection);
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this.menu.addAction(_('Rescan'), () => this._rescan());

        this._client = null;
        this._device = null;
        this._apAddedId = 0;
        this._apRemovedId = 0;

        NM.Client.new_async(null, (obj, result) => {
            try {
                this._client = NM.Client.new_finish(result);
                this._attachDevice();
                this._refresh();
            } catch (e) {
                logError(e, 'wifi-wps: failed to connect to NetworkManager');
                this._showMessage(_('Could not reach NetworkManager'));
            }
        });
    }

    _attachDevice() {
        const device = this._client.get_devices().find(
            d => d.get_device_type() === NM.DeviceType.WIFI);
        if (!device)
            return;

        this._device = device;
        this._apAddedId = device.connect('access-point-added', () => this._refresh());
        this._apRemovedId = device.connect('access-point-removed', () => this._refresh());
    }

    _rescan() {
        if (!this._device)
            return;
        this._showMessage(_('Scanning…'));
        try {
            this._device.request_scan_async(null, (dev, result) => {
                try {
                    dev.request_scan_finish(result);
                } catch (e) {
                    // Already scanning, or scan throttled -- not fatal, the
                    // access-point-added signal still fires for new results.
                }
                this._refresh();
            });
        } catch (e) {
            logError(e, 'wifi-wps: rescan failed');
        }
    }

    _showMessage(text) {
        this._itemsSection.removeAll();
        const item = new PopupMenu.PopupMenuItem(text);
        item.setSensitive(false);
        this._itemsSection.addMenuItem(item);
    }

    _refresh() {
        if (!this._device) {
            this._showMessage(_('No Wi-Fi device found'));
            return;
        }

        const bySsid = new Map();
        for (const ap of this._device.get_access_points()) {
            const flags = ap.get_flags();
            if (!(flags & AP_FLAGS.WPS))
                continue;
            const ssid = ssidToUtf8(ap);
            if (!ssid || bySsid.has(ssid))
                continue;
            bySsid.set(ssid, ap);
        }

        if (bySsid.size === 0) {
            this._showMessage(_('No WPS-capable networks nearby'));
            return;
        }

        this._itemsSection.removeAll();
        for (const [ssid, ap] of bySsid) {
            const item = new PopupMenu.PopupMenuItem(
                _('%s — push the router’s WPS button').format(ssid));
            item.connect('activate', () => this._connect(ssid, ap));
            this._itemsSection.addMenuItem(item);
        }
    }

    _connect(ssid, ap) {
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
            connection, this._device, ap.get_path(), null,
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
        if (this._device) {
            if (this._apAddedId)
                this._device.disconnect(this._apAddedId);
            if (this._apRemovedId)
                this._device.disconnect(this._apRemovedId);
        }
        super.destroy();
    }
});

const WpsIndicator = GObject.registerClass(
class WpsIndicator extends QuickSettings.SystemIndicator {
    _init() {
        super._init();
        this._toggle = new WpsToggle();
        this.quickSettingsItems.push(this._toggle);
    }

    destroy() {
        this.quickSettingsItems.forEach(item => item.destroy());
        super.destroy();
    }
});

export default class WifiWpsExtension extends Extension {
    enable() {
        this._indicator = new WpsIndicator();
        Main.panel.statusArea.quickSettings.addExternalIndicator(this._indicator);
    }

    disable() {
        this._indicator?.destroy();
        this._indicator = null;
    }
}
