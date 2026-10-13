// SPDX-License-Identifier: MIT

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Graphene from 'gi://Graphene';
import Meta from 'gi://Meta';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {ensureActorVisibleInScrollView} from 'resource:///org/gnome/shell/misc/animationUtils.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const PANEL_WIDTH = 360;
const PANEL_MAX_HEIGHT = 460;
const POINTER_GAP = 12;
const PREVIEW_CHARS = 400;
const MAX_ENTRY_CHARS = 200000;
const PASTE_DELAY_MS = 150;

// Apps that paste with Ctrl+Shift+V instead of Ctrl+V
const TERMINALS = /ptyxis|terminal|console|kgx|ghostty|kitty|alacritty|wezterm|foot|tilix|konsole|xterm|terminator/i;
// Password managers mark what they copy with this type so it is not recorded
const SECRET_MIMETYPE = 'x-kde-passwordManagerHint';

// Whether the shell is drawing its own popups dark; same rule the shell uses
// to choose between its light and dark stylesheets.
function shellIsDark() {
    const preference = St.Settings.get().color_scheme;
    switch (Main.sessionMode.colorScheme) {
    case 'force-dark':
        return true;
    case 'force-light':
        return false;
    case 'prefer-light':
        return preference === St.SystemColorScheme.PREFER_DARK;
    default:
        return preference !== St.SystemColorScheme.PREFER_LIGHT;
    }
}

/**
 * The list of entries, newest first.
 *
 * Unpinned entries live in the session's runtime directory, so they survive
 * the screen locking but are gone after logging out. Pinned entries are kept
 * in the user's data directory.
 */
class History {
    constructor(limit) {
        this.limit = limit;
        this.items = [];
        this._sessionPath = GLib.build_filenamev([GLib.get_user_runtime_dir(), 'clipboard-panel-history.json']);
        this._pinnedDir = GLib.build_filenamev([GLib.get_user_data_dir(), 'clipboard-panel']);
        this._pinnedPath = GLib.build_filenamev([this._pinnedDir, 'pinned.json']);
    }

    load() {
        const session = this._read(this._sessionPath);
        const pinned = this._read(this._pinnedPath);
        if (session.length > 0) {
            // the session file has the full ordering, pinned entries included
            this.items = session;
        } else {
            this.items = pinned.map(item => ({...item, pinned: true}));
        }
    }

    _read(path) {
        try {
            const [ok, bytes] = GLib.file_get_contents(path);
            if (!ok)
                return [];
            const parsed = JSON.parse(new TextDecoder().decode(bytes));
            return parsed.filter(item => typeof item?.text === 'string')
                .map(item => ({text: item.text, pinned: !!item.pinned}));
        } catch {
            return [];
        }
    }

    _write(path, items) {
        try {
            GLib.file_set_contents_full(path, JSON.stringify(items),
                GLib.FileSetContentsFlags.CONSISTENT, 0o600);
        } catch (e) {
            console.warn(`clipboard-panel: could not save ${path}: ${e.message}`);
        }
    }

    save() {
        GLib.mkdir_with_parents(this._pinnedDir, 0o700);
        this._write(this._sessionPath, this.items);
        this._write(this._pinnedPath, this.items.filter(item => item.pinned));
    }

    add(text) {
        if (!text || text.trim() === '' || text.length > MAX_ENTRY_CHARS)
            return;
        const existing = this.items.findIndex(item => item.text === text);
        if (existing === 0)
            return;
        const pinned = existing > 0 && this.items[existing].pinned;
        if (existing > 0)
            this.items.splice(existing, 1);
        this.items.unshift({text, pinned});
        this._trim();
        this.save();
    }

    _trim() {
        let unpinned = 0;
        this.items = this.items.filter(item => item.pinned || ++unpinned <= this.limit);
    }

    remove(item) {
        this.items = this.items.filter(other => other !== item);
        this.save();
    }

    togglePin(item) {
        item.pinned = !item.pinned;
        this.save();
    }

    clearUnpinned() {
        this.items = this.items.filter(item => item.pinned);
        this.save();
    }
}

export default class ClipboardPanelExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._history = new History(this._settings.get_int('history-size'));
        this._history.load();
        this._settingsChangedId = this._settings.connect('changed::history-size', () => {
            this._history.limit = this._settings.get_int('history-size');
        });

        // Made up front: key presses sent on a keyboard that was only just
        // created are dropped.
        const seat = Clutter.get_default_backend().get_default_seat();
        this._virtualKeyboard = seat.create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);

        this._clipboard = St.Clipboard.get_default();
        this._selection = global.display.get_selection();
        this._ownerChangedId = this._selection.connect('owner-changed', (_selection, type) => {
            if (type === Meta.SelectionType.SELECTION_CLIPBOARD)
                this._recordClipboard();
        });
        this._recordClipboard();

        this._takeShortcut();
        Main.wm.addKeybinding('toggle-panel', this._settings,
            Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW | Shell.ActionMode.POPUP,
            () => this.toggle());
    }

    disable() {
        Main.wm.removeKeybinding('toggle-panel');
        this._returnShortcut();
        this._close();
        if (this._pasteTimeoutId) {
            GLib.source_remove(this._pasteTimeoutId);
            this._pasteTimeoutId = 0;
        }
        this._selection.disconnect(this._ownerChangedId);
        this._settings.disconnect(this._settingsChangedId);
        this._history.save();
        this._virtualKeyboard = null;
        this._selection = null;
        this._clipboard = null;
        this._history = null;
        this._settings = null;
    }

    // GNOME binds Super+V to the notification list by default. Take our
    // shortcut off that action while the extension is enabled.
    _takeShortcut() {
        this._shellKeys = new Gio.Settings({schema_id: 'org.gnome.shell.keybindings'});
        const ours = this._settings.get_strv('toggle-panel');
        const theirs = this._shellKeys.get_strv('toggle-message-tray');
        this._displaced = theirs.filter(accelerator => ours.includes(accelerator));
        if (this._displaced.length > 0) {
            this._shellKeys.set_strv('toggle-message-tray',
                theirs.filter(accelerator => !ours.includes(accelerator)));
        }
    }

    _returnShortcut() {
        if (this._displaced.length > 0) {
            const theirs = this._shellKeys.get_strv('toggle-message-tray');
            this._shellKeys.set_strv('toggle-message-tray',
                [...theirs, ...this._displaced.filter(accelerator => !theirs.includes(accelerator))]);
        }
        this._displaced = [];
        this._shellKeys = null;
    }

    _recordClipboard() {
        const mimetypes = this._clipboard.get_mimetypes(St.ClipboardType.CLIPBOARD);
        if (mimetypes.includes(SECRET_MIMETYPE))
            return;
        this._clipboard.get_text(St.ClipboardType.CLIPBOARD, (_clipboard, text) => {
            // the extension may have been disabled while the text was fetched
            this._history?.add(text);
        });
    }

    toggle() {
        if (this._backdrop)
            this._close();
        else
            this._open();
    }

    _open() {
        this._targetWindow = global.display.focus_window;
        this._anchor = null;
        this._rows = [];
        this._selected = -1;

        // A transparent layer over the whole screen: it takes the keyboard
        // while the panel is open, and a click on it closes the panel.
        this._backdrop = new St.Widget({
            reactive: true,
            x: 0,
            y: 0,
            width: global.stage.width,
            height: global.stage.height,
        });
        this._backdrop.connect('button-press-event', (_actor, event) => {
            // presses inside the panel belong to its cards and buttons
            const [x, y] = event.get_coords();
            if (this._panel.get_transformed_extents().contains_point(new Graphene.Point({x, y})))
                return Clutter.EVENT_PROPAGATE;
            this._close();
            return Clutter.EVENT_STOP;
        });
        this._backdrop.connect('key-press-event', (_actor, event) => this._onKeyPress(event));

        const light = !shellIsDark();
        this._panel = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            style_class: `popup-menu-content clipboard-panel${light ? ' clipboard-light' : ''}`,
            reactive: true,
            width: PANEL_WIDTH,
        });
        this._backdrop.add_child(this._panel);

        const header = new St.BoxLayout({style_class: 'clipboard-header'});
        header.add_child(new St.Label({
            text: 'Clipboard',
            style_class: 'clipboard-title',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        }));
        this._clearButton = new St.Button({
            label: 'Clear all',
            style_class: 'button clipboard-clear',
            can_focus: false,
        });
        this._clearButton.connect('clicked', () => {
            this._history.clearUnpinned();
            this._rebuildList();
        });
        header.add_child(this._clearButton);
        this._panel.add_child(header);

        this._list = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            style_class: 'clipboard-list',
            x_expand: true,
        });
        this._scroll = new St.ScrollView({
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            x_expand: true,
            y_expand: true,
            child: this._list,
        });
        this._panel.add_child(this._scroll);

        Main.layoutManager.uiGroup.add_child(this._backdrop);
        this._rebuildList();

        this._grab = Main.pushModal(this._backdrop, {actionMode: Shell.ActionMode.POPUP});
        global.stage.set_key_focus(this._backdrop);

        this._panel.opacity = 0;
        this._panel.ease({
            opacity: 255,
            duration: 120,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
    }

    _close() {
        if (!this._backdrop)
            return;
        if (this._grab) {
            Main.popModal(this._grab);
            this._grab = null;
        }
        this._backdrop.destroy();
        this._backdrop = null;
        this._panel = null;
        this._scroll = null;
        this._list = null;
        this._clearButton = null;
        this._rows = [];
    }

    _rebuildList() {
        this._list.destroy_all_children();
        this._rows = this._history.items.map(item => this._makeRow(item));
        // A scrolling list squeezes its rows down to their minimum height
        // before it starts to scroll, which would cut every card to one line,
        // so each row's minimum is pinned to the height it wants.
        const width = this._panel.get_theme_node().adjust_for_width(PANEL_WIDTH);
        for (const row of this._rows) {
            this._list.add_child(row);
            row.min_height = row.get_preferred_height(width)[1];
        }
        if (this._rows.length === 0)
            this._list.add_child(this._makeEmptyState());

        this._clearButton.visible = this._history.items.some(item => !item.pinned);
        this._select(this._rows.length > 0 ? Math.min(Math.max(this._selected, 0), this._rows.length - 1) : -1);
        this._place();
    }

    _makeRow(item) {
        const row = new St.BoxLayout({
            style_class: 'clipboard-item',
            reactive: true,
            track_hover: true,
            x_expand: true,
        });
        row._item = item;

        const label = new St.Label({
            text: item.text.trim().slice(0, PREVIEW_CHARS),
            style_class: 'clipboard-item-text',
            x_expand: true,
            y_align: Clutter.ActorAlign.START,
        });
        label.clutter_text.line_wrap = true;
        label.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
        label.clutter_text.ellipsize = Pango.EllipsizeMode.END;

        const button = new St.Button({
            style_class: 'clipboard-item-button',
            child: label,
            x_expand: true,
            x_align: Clutter.ActorAlign.FILL,
            can_focus: false,
        });
        button.connect('clicked', () => this._activate(item));
        row.add_child(button);

        const actions = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            style_class: 'clipboard-actions',
            y_align: Clutter.ActorAlign.START,
        });
        const pin = new St.Button({
            style_class: 'clipboard-action',
            child: new St.Icon({icon_name: 'view-pin-symbolic'}),
            accessible_name: item.pinned ? 'Unpin' : 'Pin',
            can_focus: false,
        });
        if (item.pinned)
            pin.add_style_pseudo_class('checked');
        pin.connect('clicked', () => {
            this._history.togglePin(item);
            this._rebuildList();
        });
        const remove = new St.Button({
            style_class: 'clipboard-action',
            child: new St.Icon({icon_name: 'window-close-symbolic'}),
            accessible_name: 'Delete',
            can_focus: false,
        });
        remove.connect('clicked', () => {
            this._history.remove(item);
            this._rebuildList();
        });
        actions.add_child(pin);
        actions.add_child(remove);
        row.add_child(actions);

        row.connect('notify::hover', () => {
            if (row.hover)
                this._select(this._rows.indexOf(row), false);
        });
        return row;
    }

    _makeEmptyState() {
        const box = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            style_class: 'clipboard-empty',
            x_expand: true,
        });
        box.add_child(new St.Icon({
            icon_name: 'edit-paste-symbolic',
            x_align: Clutter.ActorAlign.CENTER,
        }));
        box.add_child(new St.Label({
            text: 'Nothing here yet',
            style_class: 'clipboard-empty-title',
            x_align: Clutter.ActorAlign.CENTER,
        }));
        const hint = new St.Label({
            text: 'Text you copy will show up here.',
            x_align: Clutter.ActorAlign.CENTER,
        });
        box.add_child(hint);
        return box;
    }

    // Size the panel to its contents, then put it next to the pointer,
    // flipped or shifted where it would otherwise leave the screen.
    _place() {
        this._panel.set_height(-1);
        const [, naturalHeight] = this._panel.get_preferred_height(PANEL_WIDTH);
        const height = Math.min(naturalHeight, PANEL_MAX_HEIGHT);
        this._panel.set_height(height);

        if (!this._anchor) {
            const [x, y] = global.get_pointer();
            this._anchor = {x, y, monitor: global.display.get_current_monitor()};
        }
        const area = Main.layoutManager.getWorkAreaForMonitor(this._anchor.monitor);
        let x = this._anchor.x + POINTER_GAP;
        let y = this._anchor.y + POINTER_GAP;
        if (x + PANEL_WIDTH > area.x + area.width)
            x = this._anchor.x - POINTER_GAP - PANEL_WIDTH;
        if (y + height > area.y + area.height)
            y = this._anchor.y - POINTER_GAP - height;
        x = Math.max(area.x + 6, Math.min(x, area.x + area.width - PANEL_WIDTH - 6));
        y = Math.max(area.y + 6, Math.min(y, area.y + area.height - height - 6));
        this._panel.set_position(Math.round(x), Math.round(y));
    }

    _select(index, scrollTo = true) {
        this._rows[this._selected]?.remove_style_pseudo_class('selected');
        this._selected = index;
        const row = this._rows[index];
        if (!row)
            return;
        row.add_style_pseudo_class('selected');
        if (scrollTo)
            ensureActorVisibleInScrollView(this._scroll, row);
    }

    _onKeyPress(event) {
        const count = this._rows.length;
        switch (event.get_key_symbol()) {
        case Clutter.KEY_Escape:
            this._close();
            return Clutter.EVENT_STOP;
        case Clutter.KEY_Down:
        case Clutter.KEY_Tab:
            if (count > 0)
                this._select((this._selected + 1) % count);
            return Clutter.EVENT_STOP;
        case Clutter.KEY_Up:
        case Clutter.KEY_ISO_Left_Tab:
            if (count > 0)
                this._select((this._selected - 1 + count) % count);
            return Clutter.EVENT_STOP;
        case Clutter.KEY_Return:
        case Clutter.KEY_KP_Enter:
            if (this._rows[this._selected])
                this._activate(this._rows[this._selected]._item);
            return Clutter.EVENT_STOP;
        case Clutter.KEY_Delete:
            if (this._rows[this._selected]) {
                this._history.remove(this._rows[this._selected]._item);
                this._rebuildList();
            }
            return Clutter.EVENT_STOP;
        default:
            return Clutter.EVENT_STOP;
        }
    }

    // Put the entry on the clipboard, hand the keyboard back to the window
    // that had it, then press the paste shortcut there.
    _activate(item) {
        const target = this._targetWindow;
        this._close();
        this._clipboard.set_text(St.ClipboardType.CLIPBOARD, item.text);
        if (!this._settings.get_boolean('paste-on-select') || !target)
            return;

        if (this._pasteTimeoutId)
            GLib.source_remove(this._pasteTimeoutId);
        this._pasteTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, PASTE_DELAY_MS, () => {
            this._pasteTimeoutId = 0;
            if (global.display.focus_window === target)
                this._pressPaste(TERMINALS.test(target.get_wm_class() ?? ''));
            return GLib.SOURCE_REMOVE;
        });
    }

    _pressPaste(withShift) {
        const keys = [Clutter.KEY_Control_L];
        if (withShift)
            keys.push(Clutter.KEY_Shift_L);
        keys.push(Clutter.KEY_v);

        const time = Clutter.get_current_event_time() * 1000;
        for (const key of keys)
            this._virtualKeyboard.notify_keyval(time, key, Clutter.KeyState.PRESSED);
        for (const key of keys.reverse())
            this._virtualKeyboard.notify_keyval(time, key, Clutter.KeyState.RELEASED);
    }
}
