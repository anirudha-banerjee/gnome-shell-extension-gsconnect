"use strict";

// Imports
const Lang = imports.lang;
const Gettext = imports.gettext.domain("gsconnect");
const _ = Gettext.gettext;

const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;

// Local Imports
function getPath() {
    // Diced from: https://github.com/optimisme/gjs-examples/
    let m = new RegExp("@(.+):\\d+").exec((new Error()).stack.split("\n")[1]);
    let p = Gio.File.new_for_path(m[1]).get_parent().get_parent().get_parent();
    return p.get_path();
}

imports.searchPath.push(getPath());

const Common = imports.common;
const Protocol = imports.service.protocol;
const PluginsBase = imports.service.plugins.base;


var METADATA = {
    name: "battery",
    summary: _("Battery"),
    description: _("Monitor battery level and charging state"),
    wiki: "https://github.com/andyholmes/gnome-shell-extension-gsconnect/wiki/Battery-Plugin",
    incomingPackets: ["kdeconnect.battery"],
    outgoingPackets: ["kdeconnect.battery.request"]
};


/**
 * Battery Plugin
 * https://github.com/KDE/kdeconnect-kde/tree/master/plugins/battery
 *
 * TODO: It's possible to report battery stats if deviceType is "laptop", see:
 *       https://github.com/GNOME/gnome-shell/blob/master/js/ui/status/power.js
 */
var Plugin = new Lang.Class({
    Name: "GSConnectBatteryPlugin",
    Extends: PluginsBase.Plugin,
    Properties: {
        "charging": GObject.ParamSpec.boolean(
            "charging",
            "isCharging",
            "Whether the device is charging",
            GObject.ParamFlags.READABLE,
            false
        ),
        "level": GObject.ParamSpec.int(
            "level",
            "isCharging",
            "Whether the device is charging",
            GObject.ParamFlags.READABLE,
            -1
        )
    },
    
    _init: function (device) {
        this.parent(device, "battery");
        
        this._charging = false;
        this._level = -1;
        
        this.update();
    },
    
    get charging() { return this._charging; },
    get level() { return this._level; },
    
    handlePacket: function (packet) {
        Common.debug("Battery: handlePacket()");
    
        this._charging = packet.body.isCharging;
        this.notify("charging");
        this._dbus.emit_property_changed(
            "charging",
            new GLib.Variant("b", packet.body.isCharging)
        );
        
        this._level = packet.body.currentCharge;
        this.notify("level");
        this._dbus.emit_property_changed(
            "level",
            new GLib.Variant("i", packet.body.currentCharge)
        );
        
        if (packet.body.thresholdEvent > 0) {
            this.threshold();
        }
    },
    
    threshold: function () {
        Common.debug("Battery: threshold()");
        
        let notif = new Gio.Notification();
        // TRANSLATORS: Low Battery Warning
        notif.set_title(_("Low Battery Warning"));
        notif.set_body(
            // TRANSLATORS: eg. Google Pixel's battery level is 15%
            _("%s's battery level is %d%%").format(this.device.name, this.level)
        );
        notif.set_icon(new Gio.ThemedIcon({ name: "battery-caution-symbolic" }));
        
        if (this.device._plugins.has("findmyphone")) {
            Common.debug("Battery: has findmyphone plugin; enabling action");
            
            notif.add_button(
                _("Locate"),
                "app.batteryWarning('" + this._dbus.get_object_path() + "')"
            );
        }
        
        this.device.daemon.send_notification("battery-warning", notif);
    },
    
    /**
     * Request an update
     * TODO: test/check this works
     */
    update: function () {
        Common.debug("Battery: update()");
        
        let packet = new Protocol.Packet({
            id: 0,
            type: "kdeconnect.battery.request",
            body: { request: true }
        });
        
        this.device._channel.send(packet);
    }
});

