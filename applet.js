// Central de Controle — applet do Cinnamon inspirado no Control Center do macOS Big Sur.
const Applet = imports.ui.applet;
const PopupMenu = imports.ui.popupMenu;
const Util = imports.misc.util;
const Signals = imports.signals;
const St = imports.gi.St;
const Clutter = imports.gi.Clutter;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const Cvc = imports.gi.Cvc;
const NM = imports.gi.NM;
const Pango = imports.gi.Pango;

const MPRIS_PREFIX = 'org.mpris.MediaPlayer2.';
const SPAWN_FLAGS = Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE;

function icon(name, cls) {
    return new St.Icon({ icon_name: name, icon_type: St.IconType.SYMBOLIC, style_class: cls || 'cc-icon' });
}

function label(text, cls) {
    let l = new St.Label({ text: text, style_class: cls });
    l.clutter_text.ellipsize = Pango.EllipsizeMode.END;
    return l;
}

function run(argv, cb) {
    try {
        let p = Gio.Subprocess.new(argv, SPAWN_FLAGS);
        p.communicate_utf8_async(null, null, (proc, res) => {
            let out = '';
            try { [, out] = proc.communicate_utf8_finish(res); } catch (e) { }
            if (cb) cb(proc.get_successful(), out || '');
        });
    } catch (e) {
        global.logError('[controlcenter] ' + argv.join(' ') + ': ' + e);
        if (cb) cb(false, '');
    }
}

function debounce(ms, fn) {
    let id = 0;
    return (...args) => {
        if (id) GLib.source_remove(id);
        id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => { id = 0; fn(...args); return GLib.SOURCE_REMOVE; });
    };
}

/* ---------- Slider em formato de pílula (estilo macOS) ---------- */
class PillSlider {
    constructor(iconName) {
        this._value = 0;
        this._dragging = false;
        this.actor = new St.Widget({ style_class: 'cc-slider', layout_manager: new Clutter.BinLayout(),
                                     x_expand: true, reactive: true });
        this._area = new St.DrawingArea({ style_class: 'cc-slider-area', x_expand: true, y_expand: true });
        this._area.connect('repaint', () => this._repaint());
        this.icon = new St.Icon({ icon_name: iconName, icon_type: St.IconType.SYMBOLIC, style_class: 'cc-slider-icon' });
        // Camada por cima do desenho: ícone encostado à esquerda, centralizado na vertical
        let overlay = new St.BoxLayout({ x_expand: true, y_expand: true });
        overlay.add(this.icon, { x_fill: false, y_fill: false, y_align: St.Align.MIDDLE });
        this.actor.add_child(this._area);
        this.actor.add_child(overlay);
        this.actor.connect('button-press-event', (a, e) => this._begin(e));
        this.actor.connect('scroll-event', (a, e) => this._scroll(e));
    }

    get value() { return this._value; }
    get dragging() { return this._dragging; }

    setValue(v) {
        this._value = Math.max(0, Math.min(1, v));
        this._area.queue_repaint();
    }

    setSensitive(on) {
        this.actor.reactive = on;
        this.actor.opacity = on ? 255 : 110;
    }

    _repaint() {
        let cr = this._area.get_context();
        let node = this._area.get_theme_node();
        let [w, h] = this._area.get_surface_size();
        let r = h / 2;
        let pill = (x1) => {
            cr.newSubPath();
            cr.arc(r, r, r, Math.PI / 2, 3 * Math.PI / 2);
            cr.arc(Math.max(r, x1 - r), r, r, -Math.PI / 2, Math.PI / 2);
            cr.closePath();
        };
        pill(w);
        Clutter.cairo_set_source_color(cr, node.get_color('-cc-track-color'));
        cr.fill();
        let kx = r + (w - 2 * r) * this._value;
        pill(kx + r);
        Clutter.cairo_set_source_color(cr, node.get_color('-cc-fill-color'));
        cr.fill();
        cr.arc(kx, r, r - 0.5, 0, 2 * Math.PI);
        Clutter.cairo_set_source_color(cr, node.get_color('-cc-knob-color'));
        cr.fillPreserve();
        cr.setLineWidth(1);
        Clutter.cairo_set_source_color(cr, node.get_color('-cc-knob-border-color'));
        cr.stroke();
        cr.$dispose();
    }

    _begin(event) {
        if (event.get_button() !== 1) return Clutter.EVENT_PROPAGATE;
        this._dragging = true;
        this._device = event.get_device();
        this._device.grab(this.actor);
        this._motionId = this.actor.connect('motion-event', (a, e) => { this._moveTo(e); return Clutter.EVENT_STOP; });
        this._releaseId = this.actor.connect('button-release-event', () => { this._end(); return Clutter.EVENT_STOP; });
        this._moveTo(event);
        return Clutter.EVENT_STOP;
    }

    _end() {
        if (!this._dragging) return;
        this._dragging = false;
        this.actor.disconnect(this._motionId);
        this.actor.disconnect(this._releaseId);
        this._device.ungrab();
        this.emit('drag-end', this._value);
    }

    _moveTo(event) {
        let [x] = event.get_coords();
        let [ax] = this.actor.get_transformed_position();
        let w = this._area.width, r = this._area.height / 2;
        this.setValue((x - ax - r) / Math.max(1, w - 2 * r));
        this.emit('value-changed', this._value);
    }

    _scroll(event) {
        let dir = event.get_scroll_direction();
        let step = 0.05;
        if (dir === Clutter.ScrollDirection.UP) this.setValue(this._value + step);
        else if (dir === Clutter.ScrollDirection.DOWN) this.setValue(this._value - step);
        else if (dir === Clutter.ScrollDirection.SMOOTH) {
            let [, dy] = event.get_scroll_delta();
            this.setValue(this._value - dy * step);
        } else return Clutter.EVENT_PROPAGATE;
        this.emit('value-changed', this._value);
        this.emit('drag-end', this._value);
        return Clutter.EVENT_STOP;
    }
}
Signals.addSignalMethods(PillSlider.prototype);

/* ---------- Botão redondo (toggle) ---------- */
function circleButton(iconName, onClick) {
    let btn = new St.Button({ style_class: 'cc-circle', can_focus: true });
    btn.set_child(icon(iconName, 'cc-circle-icon'));
    btn.connect('clicked', onClick);
    btn.setActive = (on) => on ? btn.add_style_pseudo_class('checked') : btn.remove_style_pseudo_class('checked');
    btn.setIcon = (n) => { btn.get_child().icon_name = n; };
    return btn;
}

/* Linha da caixa de conectividade: [círculo] Título / Subtítulo */
function toggleRow(iconName, title, onToggle, onOpen, wrapTitle) {
    let row = new St.BoxLayout({ style_class: 'cc-row' });
    let btn = circleButton(iconName, onToggle);
    let texts = new St.BoxLayout({ vertical: true });
    let t = label(title, 'cc-title');
    if (wrapTitle) {
        t.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        t.clutter_text.line_wrap = true;
    }
    let s = label('', 'cc-subtitle');
    texts.add(t, { x_fill: true });
    texts.add(s, { x_fill: true });
    let textBtn = new St.Button({ child: texts, style_class: 'cc-row-text',
                                  x_fill: true, y_fill: false, x_align: St.Align.START, y_align: St.Align.MIDDLE });
    textBtn.connect('clicked', onOpen || onToggle);
    row.add(btn, { x_fill: false, y_fill: false, y_align: St.Align.MIDDLE });
    row.add(textBtn, { expand: true, x_fill: true, y_fill: true });
    return { actor: row, button: btn, subtitle: s };
}

/* Bloco quadrado pequeno: círculo em cima, texto embaixo */
function smallTile(iconName, title, onClick) {
    let tile = new St.Button({ style_class: 'cc-card cc-small', x_fill: true, y_fill: false, y_align: St.Align.MIDDLE });
    let box = new St.BoxLayout({ vertical: true });
    let c = new St.Bin({ style_class: 'cc-circle', child: icon(iconName, 'cc-circle-icon') });
    let l = new St.Label({ text: title, style_class: 'cc-small-label' });
    l.clutter_text.line_wrap = true;
    l.clutter_text.set_line_alignment(Pango.Alignment.CENTER);
    box.add(c, { x_fill: false, y_fill: false, x_align: St.Align.MIDDLE });
    box.add(l, { x_fill: false, x_align: St.Align.MIDDLE });
    tile.set_child(box);
    tile.connect('clicked', onClick);
    tile.setActive = (on) => on ? c.add_style_pseudo_class('checked') : c.remove_style_pseudo_class('checked');
    return tile;
}

/* Cabeçalho de cartão: título clicável (com seta) + ícone de atalho à direita */
function cardHeader(text, iconName, onIconClick, onTitleClick) {
    let row = new St.BoxLayout({ style_class: 'cc-card-header' });
    let titleBox = new St.BoxLayout({ style_class: 'cc-header-title' });
    titleBox.add(new St.Label({ text: text, style_class: 'cc-title' }), { y_fill: false, y_align: St.Align.MIDDLE });
    let chevron = icon('pan-down-symbolic', 'cc-chevron');
    titleBox.add(chevron, { y_fill: false, y_align: St.Align.MIDDLE });
    let titleBtn = new St.Button({ child: titleBox, style_class: 'cc-header-button' });
    titleBtn.connect('clicked', onTitleClick);
    row.add(titleBtn, { expand: true, x_fill: false, x_align: St.Align.START, y_fill: false, y_align: St.Align.MIDDLE });
    let b = new St.Button({ style_class: 'cc-mini-button', child: icon(iconName, 'cc-mini-icon') });
    b.connect('clicked', onIconClick);
    row.add(b, { x_fill: false, y_fill: false, y_align: St.Align.MIDDLE });
    return { actor: row, chevron: chevron };
}

/* Item de lista com marca de seleção (saídas de áudio) */
function listItem(text, selected, onClick) {
    let row = new St.BoxLayout({ style_class: 'cc-list-row' });
    let check = icon('object-select-symbolic', 'cc-check');
    check.opacity = selected ? 255 : 0;
    row.add(check, { x_fill: false, y_fill: false, y_align: St.Align.MIDDLE });
    row.add(label(text, 'cc-list-label'), { expand: true, y_fill: false, y_align: St.Align.MIDDLE });
    let b = new St.Button({ style_class: 'cc-list-item', child: row, x_fill: true });
    b.connect('clicked', onClick);
    return b;
}

/* ===================================================================== */
class ControlCenterApplet extends Applet.IconApplet {
    constructor(metadata, orientation, panelHeight, instanceId) {
        super(orientation, panelHeight, instanceId);
        this._meta = metadata;
        this._signals = [];   // [obj, id]
        this._dbusSubs = [];  // [conn, id]
        this._timeouts = [];

        this.set_applet_icon_symbolic_path(metadata.path + '/control-center-symbolic.svg');
        this.set_applet_tooltip('Central de Controle');

        this.menuManager = new PopupMenu.PopupMenuManager(this);
        this.menu = new Applet.AppletPopupMenu(this, orientation);
        this.menu.setCustomStyleClass('cc-menu');
        this.menuManager.addMenu(this.menu);

        this._buildUI();
        this.menu.addActor(this._root);
        this.menu.connect('open-state-changed', (m, open) => { if (open) this._onOpen(); });

        this._initSettings();
        this._initNetwork();
        this._initBluetooth();
        this._initSound();
        this._initMpris();
        this._initBrightness();
    }

    _connect(obj, sig, fn) {
        this._signals.push([obj, obj.connect(sig, fn)]);
    }

    /* ---------------- UI ---------------- */
    _buildUI() {
        this._root = new St.BoxLayout({ vertical: true, style_class: 'cc-root' });

        // Linha de cima: conectividade | (Não Perturbe + 2 quadrados)
        let top = new St.BoxLayout({ style_class: 'cc-grid' });
        this._root.add_child(top);

        let net = new St.BoxLayout({ vertical: true, style_class: 'cc-card cc-net' });
        this._wifiRow = toggleRow('network-wireless-signal-excellent-symbolic', 'Wi‑Fi',
            () => this._toggleWifi(), () => this._launch(['cinnamon-settings', 'network']));
        this._btRow = toggleRow('bluetooth-active-symbolic', 'Bluetooth',
            () => this._toggleBluetooth(), () => this._launch(['cinnamon-settings', 'bluetooth']));
        this._lanRow = toggleRow('network-wired-symbolic', 'Rede',
            () => this._launch(['cinnamon-settings', 'network']));
        net.add_child(this._wifiRow.actor);
        net.add_child(this._btRow.actor);
        net.add_child(this._lanRow.actor);
        top.add_child(net);

        let right = new St.BoxLayout({ vertical: true, style_class: 'cc-col', x_expand: true });
        let dndCard = new St.BoxLayout({ style_class: 'cc-card cc-dnd' });
        this._dndRow = toggleRow('weather-clear-night-symbolic', 'Não Perturbe', () => this._toggleDnd(), null, true);
        dndCard.add(this._dndRow.actor, { expand: true, x_fill: true });
        right.add_child(dndCard);

        let smalls = new St.BoxLayout({ style_class: 'cc-grid', x_expand: true });
        this._nightTile = smallTile('night-light-symbolic', 'Luz\nNoturna', () => this._toggleNightLight());
        this._darkTile = smallTile('weather-few-clouds-night-symbolic', 'Modo\nEscuro', () => this._toggleDarkMode());
        smalls.add(this._nightTile, { expand: true, x_fill: true, y_fill: true });
        smalls.add(this._darkTile, { expand: true, x_fill: true, y_fill: true });
        right.add(smalls, { expand: true, x_fill: true, y_fill: true });
        top.add(right, { expand: true, x_fill: true, y_fill: true });

        // Tela
        let display = new St.BoxLayout({ vertical: true, style_class: 'cc-card cc-wide' });
        this._displayHeader = cardHeader('Tela', 'video-display-symbolic',
            () => this._launch(['cinnamon-settings', 'display']), () => this._toggleExpand('display'));
        display.add_child(this._displayHeader.actor);
        this._brightSlider = new PillSlider('display-brightness-symbolic');
        display.add_child(this._brightSlider.actor);
        this._brightHint = label('', 'cc-hint');
        this._brightHint.hide();
        display.add_child(this._brightHint);
        this._displaysBox = new St.BoxLayout({ vertical: true, style_class: 'cc-expand' });
        this._displaysBox.hide();
        display.add_child(this._displaysBox);
        this._root.add_child(display);

        // Som
        let sound = new St.BoxLayout({ vertical: true, style_class: 'cc-card cc-wide' });
        this._soundHeader = cardHeader('Som', 'audio-speakers-symbolic',
            () => this._launch(['cinnamon-settings', 'sound']), () => this._toggleExpand('sound'));
        sound.add_child(this._soundHeader.actor);
        this._volSlider = new PillSlider('audio-volume-high-symbolic');
        sound.add_child(this._volSlider.actor);
        this._outputsBox = new St.BoxLayout({ vertical: true, style_class: 'cc-expand' });
        this._outputsBox.hide();
        sound.add_child(this._outputsBox);
        this._root.add_child(sound);

        // Tocando agora
        let media = new St.BoxLayout({ style_class: 'cc-card cc-wide cc-media' });
        this._art = new St.Icon({ style_class: 'cc-art', icon_name: 'audio-x-generic-symbolic', icon_type: St.IconType.SYMBOLIC });
        let mtexts = new St.BoxLayout({ vertical: true });
        this._mTitle = label('Nada tocando', 'cc-title');
        this._mArtist = label('', 'cc-subtitle');
        mtexts.add_child(this._mTitle);
        mtexts.add_child(this._mArtist);
        let ctrls = new St.BoxLayout({ style_class: 'cc-media-ctrls' });
        let mbtn = (n, m) => {
            let b = new St.Button({ style_class: 'cc-media-button', child: icon(n, 'cc-media-icon') });
            b.connect('clicked', () => this._mediaCall(m));
            ctrls.add(b, { y_fill: false, y_align: St.Align.MIDDLE });
            return b;
        };
        this._prevBtn = mbtn('media-skip-backward-symbolic', 'Previous');
        this._playBtn = mbtn('media-playback-start-symbolic', 'PlayPause');
        this._nextBtn = mbtn('media-skip-forward-symbolic', 'Next');
        // Capa + textos formam um botão que traz o player para a frente
        let info = new St.BoxLayout({ style_class: 'cc-media-info-box' });
        info.add(this._art, { x_fill: false, y_fill: false, y_align: St.Align.MIDDLE });
        info.add(mtexts, { expand: true, y_fill: false, y_align: St.Align.MIDDLE });
        this._mediaInfo = new St.Button({ style_class: 'cc-media-info', child: info, x_fill: true });
        this._mediaInfo.connect('clicked', () => this._raisePlayer());
        media.add(this._mediaInfo, { expand: true, x_fill: true, y_fill: false, y_align: St.Align.MIDDLE });
        media.add(ctrls, { y_fill: false, y_align: St.Align.MIDDLE });
        this._root.add_child(media);
    }

    _launch(argv) {
        this.menu.close();
        Util.spawn(argv);
    }

    on_applet_clicked() {
        this.menu.toggle();
    }

    _onOpen() {
        this._collapse();
        this._refreshBrightness();
        this._refreshBluetooth();
    }

    /* ---------------- Seções expansíveis (Tela / Som) ---------------- */
    _toggleExpand(which) {
        let open = this._expanded === which ? null : which;
        this._collapse();
        if (!open) return;
        this._expanded = open;
        if (open === 'display') {
            this._displayHeader.chevron.icon_name = 'pan-up-symbolic';
            this._displaysBox.show();
            this._loadDisplays();
        } else {
            this._soundHeader.chevron.icon_name = 'pan-up-symbolic';
            this._outputsBox.show();
            this._renderOutputs();
        }
    }

    _collapse() {
        this._expanded = null;
        this._displaysBox.hide();
        this._outputsBox.hide();
        this._displayHeader.chevron.icon_name = 'pan-down-symbolic';
        this._soundHeader.chevron.icon_name = 'pan-down-symbolic';
    }

    /* ---------------- Taxa de atualização (Muffin DisplayConfig) ---------------- */
    _displayCall(method, params, cb) {
        Gio.DBus.session.call('org.cinnamon.Muffin.DisplayConfig', '/org/cinnamon/Muffin/DisplayConfig',
            'org.cinnamon.Muffin.DisplayConfig', method, params, null, Gio.DBusCallFlags.NONE, -1, null,
            (c, res) => {
                let out = null, err = null;
                try { out = c.call_finish(res); } catch (e) { err = e; }
                cb(out, err);
            });
    }

    _loadDisplays() {
        this._displayCall('GetCurrentState', null, (out, err) => {
            if (err) {
                this._displayState = null;
                this._renderDisplays('Não foi possível ler os monitores.');
                return;
            }
            this._displayState = out.recursiveUnpack();
            this._renderDisplays();
        });
    }

    // Uma opção por taxa arredondada (ex.: 60 e 59,94 viram "60 Hz"), só para a resolução atual
    _rateOptions(modes, current) {
        let byRate = new Map();
        for (let m of modes) {
            if (m[1] !== current[1] || m[2] !== current[2]) continue;
            let r = Math.round(m[3]);
            if (r < 48 && m !== current) continue;
            let prev = byRate.get(r);
            if (!prev || m === current || (prev !== current && m[3] > prev[3])) byRate.set(r, m);
        }
        return [...byRate.entries()].sort((a, b) => b[0] - a[0]);
    }

    _renderDisplays(error) {
        this._displaysBox.destroy_all_children();
        if (error || !this._displayState) {
            this._displaysBox.add_child(label(error || '', 'cc-hint'));
            return;
        }
        let [, monitors, logicals] = this._displayState;
        for (let lm of logicals) {
            for (let spec of lm[5]) {
                let mon = monitors.find(m => m[0][0] === spec[0]);
                if (!mon) continue;
                let current = mon[1].find(m => m[6]['is-current']);
                if (!current) continue;
                let name = mon[2]['display-name'] || spec[0];
                let block = new St.BoxLayout({ vertical: true, style_class: 'cc-display-block' });
                block.add_child(label(name, 'cc-list-title'));
                block.add_child(label(`${current[1]} × ${current[2]} · ${current[3].toFixed(2).replace('.', ',')} Hz`, 'cc-subtitle'));
                let pills = new St.BoxLayout({ style_class: 'cc-pills' });
                for (let [r, mode] of this._rateOptions(mon[1], current)) {
                    let p = new St.Button({ style_class: 'cc-pill', label: `${r} Hz` });
                    if (mode === current) p.add_style_pseudo_class('checked');
                    else p.connect('clicked', () => this._applyMode(spec[0], mode[0]));
                    pills.add_child(p);
                }
                block.add_child(pills);
                this._displaysBox.add_child(block);
            }
        }
        if (!this._displaysBox.get_n_children())
            this._displaysBox.add_child(label('Nenhum monitor ativo encontrado.', 'cc-hint'));
    }

    _applyMode(connector, modeId) {
        let [serial, monitors, logicals, props] = this._displayState;
        let curMode = (conn) => {
            let mon = monitors.find(m => m[0][0] === conn);
            let cur = mon && mon[1].find(m => m[6]['is-current']);
            return cur ? cur[0] : '';
        };
        let lms = logicals.map(lm => [lm[0], lm[1], lm[2], lm[3], lm[4],
            lm[5].map(spec => [spec[0], spec[0] === connector ? modeId : curMode(spec[0]), {}])]);
        let p = {};
        if (props['supports-changing-layout-mode'] && props['layout-mode'] !== undefined)
            p['layout-mode'] = new GLib.Variant('u', props['layout-mode']);
        if (props['legacy-ui-scaling-factor'] !== undefined)
            p['legacy-ui-scaling-factor'] = new GLib.Variant('i', props['legacy-ui-scaling-factor']);
        // método 2 = persistente; o Cinnamon pede confirmação e reverte sozinho se não for confirmada
        let params = new GLib.Variant('(uua(iiduba(ssa{sv}))a{sv})', [serial, 2, lms, p]);
        this.menu.close();
        this._displayCall('ApplyMonitorsConfig', params, (out, err) => {
            if (err) global.logError('[controlcenter] ApplyMonitorsConfig: ' + err.message);
        });
    }

    /* ---------------- Saídas de áudio ---------------- */
    _renderOutputs() {
        if (!this._outputsBox.visible) return;
        this._outputsBox.destroy_all_children();
        if (!this._mixer || this._mixer.get_state() !== Cvc.MixerControlState.READY) return;
        let def = this._mixer.get_default_sink();
        let sinks = this._mixer.get_sinks();
        for (let s of sinks) {
            this._outputsBox.add(listItem(s.get_description() || s.get_name(), def && s.id === def.id,
                () => this._mixer.set_default_sink(s)), { x_fill: true });
        }
        if (!sinks.length) this._outputsBox.add_child(label('Nenhuma saída de áudio encontrada.', 'cc-hint'));
    }

    /* ---------------- Trazer o player para a frente ---------------- */
    _raisePlayer() {
        let p = this._currentPlayer();
        if (!p) return;
        this.menu.close();
        Gio.DBus.session.call(p.name, '/org/mpris/MediaPlayer2', 'org.mpris.MediaPlayer2', 'Raise',
            null, null, Gio.DBusCallFlags.NONE, -1, null, null);
    }

    /* ------------- GSettings: Não Perturbe, Luz Noturna, Modo Escuro ------------- */
    _initSettings() {
        this._notif = new Gio.Settings({ schema_id: 'org.cinnamon.desktop.notifications' });
        this._color = new Gio.Settings({ schema_id: 'org.cinnamon.settings-daemon.plugins.color' });
        this._iface = new Gio.Settings({ schema_id: 'org.cinnamon.desktop.interface' });
        this._shellTheme = new Gio.Settings({ schema_id: 'org.cinnamon.theme' });
        try { this._portal = new Gio.Settings({ schema_id: 'org.x.apps.portal' }); } catch (e) { this._portal = null; }

        this._connect(this._notif, 'changed::display-notifications', () => this._updateSettings());
        this._connect(this._color, 'changed::night-light-enabled', () => this._updateSettings());
        this._connect(this._iface, 'changed::gtk-theme', () => this._updateSettings());
        this._updateSettings();
    }

    _isDark() {
        return /dark/i.test(this._iface.get_string('gtk-theme'));
    }

    _updateSettings() {
        let dnd = !this._notif.get_boolean('display-notifications');
        this._dndRow.button.setActive(dnd);
        this._dndRow.subtitle.text = dnd ? 'Ativado' : '';
        this._dndRow.subtitle.visible = dnd;

        this._nightTile.setActive(this._color.get_boolean('night-light-enabled'));

        let dark = this._isDark();
        this._darkTile.setActive(dark);
        if (dark) this._root.remove_style_class_name('cc-light');
        else this._root.add_style_class_name('cc-light');
        if (this.menu.actor) {
            if (dark) this.menu.actor.remove_style_class_name('cc-menu-light');
            else this.menu.actor.add_style_class_name('cc-menu-light');
        }
    }

    _toggleDnd() {
        this._notif.set_boolean('display-notifications', !this._notif.get_boolean('display-notifications'));
    }

    _toggleNightLight() {
        let on = !this._color.get_boolean('night-light-enabled');
        this._color.set_boolean('night-light-enabled', on);
        // Fora do horário agendado o recurso só ficaria "armado"; como no macOS, ligar pelo
        // painel ativa imediatamente (o daemon volta ao agendamento no dia seguinte).
        if (on) {
            Gio.DBus.session.call('org.cinnamon.SettingsDaemon.Color', '/org/cinnamon/SettingsDaemon/Color',
                'org.freedesktop.DBus.Properties', 'Set',
                new GLib.Variant('(ssv)', ['org.cinnamon.SettingsDaemon.Color', 'DisabledUntilTomorrow', new GLib.Variant('b', false)]),
                null, Gio.DBusCallFlags.NONE, -1, null, null);
        }
    }

    _toggleDarkMode() {
        let toDark = !this._isDark();
        let swap = (name) => toDark
            ? name.replace(/Light/g, 'Dark').replace(/light/g, 'dark')
            : name.replace(/Dark/g, 'Light').replace(/dark/g, 'light');
        let themeExists = (name, sub) => [GLib.get_home_dir() + '/.themes', GLib.get_home_dir() + '/.local/share/themes', '/usr/share/themes']
            .some(d => GLib.file_test(`${d}/${name}/${sub}`, GLib.FileTest.IS_DIR));
        let iconExists = (name) => [GLib.get_home_dir() + '/.icons', GLib.get_home_dir() + '/.local/share/icons', '/usr/share/icons']
            .some(d => GLib.file_test(`${d}/${name}`, GLib.FileTest.IS_DIR));

        let gtk = swap(this._iface.get_string('gtk-theme'));
        let icons = swap(this._iface.get_string('icon-theme'));
        let shell = swap(this._shellTheme.get_string('name'));

        if (themeExists(gtk, 'gtk-3.0')) this._iface.set_string('gtk-theme', gtk);
        if (iconExists(icons)) this._iface.set_string('icon-theme', icons);
        if (themeExists(shell, 'cinnamon')) this._shellTheme.set_string('name', shell);
        if (this._portal) this._portal.set_string('color-scheme', toDark ? 'prefer-dark' : 'prefer-light');
    }

    /* ---------------- Rede (NetworkManager) ---------------- */
    _initNetwork() {
        NM.Client.new_async(null, (obj, res) => {
            try {
                this._nm = NM.Client.new_finish(res);
            } catch (e) {
                global.logError('[controlcenter] NM: ' + e);
                return;
            }
            ['notify::wireless-enabled', 'notify::primary-connection', 'notify::active-connections',
             'notify::state', 'notify::devices'].forEach(s => this._connect(this._nm, s, () => this._updateNetwork()));
            this._updateNetwork();
        });
    }

    _updateNetwork() {
        let nm = this._nm;
        if (!nm) return;
        let hasWifi = nm.get_devices().some(d => d.get_device_type() === NM.DeviceType.WIFI);
        this._wifiRow.actor.visible = hasWifi;
        let wifiOn = nm.wireless_enabled;
        let active = nm.get_active_connections() || [];
        let wifiConn = active.find(c => c.get_connection_type() === '802-11-wireless');
        this._wifiRow.button.setActive(wifiOn);
        this._wifiRow.button.setIcon(wifiOn ? 'network-wireless-signal-excellent-symbolic' : 'network-wireless-offline-symbolic');
        this._wifiRow.subtitle.text = !wifiOn ? 'Desligado' : (wifiConn ? wifiConn.get_id() : 'Não conectado');

        let primary = nm.get_primary_connection();
        let wired = active.find(c => c.get_connection_type() === '802-3-ethernet');
        let conn = wired || primary;
        let online = nm.get_state() >= NM.State.CONNECTED_LOCAL && conn;
        this._lanRow.button.setActive(!!online);
        this._lanRow.button.setIcon(wired ? 'network-wired-symbolic'
                                          : (online ? 'network-wireless-signal-excellent-symbolic' : 'network-offline-symbolic'));
        this._lanRow.subtitle.text = online ? conn.get_id() : 'Desconectado';
    }

    _toggleWifi() {
        if (!this._nm) return;
        run(['nmcli', 'radio', 'wifi', this._nm.wireless_enabled ? 'off' : 'on']);
    }

    /* ---------------- Bluetooth (BlueZ via D-Bus) ---------------- */
    _initBluetooth() {
        this._btAdapter = null;
        this._btQueue = debounce(250, () => this._refreshBluetooth());
        let sys = Gio.DBus.system;
        for (let [iface, sig] of [['org.freedesktop.DBus.Properties', 'PropertiesChanged'],
                                  ['org.freedesktop.DBus.ObjectManager', 'InterfacesAdded'],
                                  ['org.freedesktop.DBus.ObjectManager', 'InterfacesRemoved']]) {
            this._dbusSubs.push([sys, sys.signal_subscribe('org.bluez', iface, sig, null, null,
                Gio.DBusSignalFlags.NONE, () => this._btQueue())]);
        }
        this._refreshBluetooth();
    }

    _refreshBluetooth() {
        Gio.DBus.system.call('org.bluez', '/', 'org.freedesktop.DBus.ObjectManager', 'GetManagedObjects',
            null, null, Gio.DBusCallFlags.NONE, -1, null, (conn, res) => {
                let objs;
                try {
                    [objs] = conn.call_finish(res).recursiveUnpack();
                } catch (e) {
                    this._btAdapter = null;
                    this._btRow.actor.visible = false;
                    return;
                }
                let adapter = null, connected = [];
                for (let path in objs) {
                    let o = objs[path];
                    if (!adapter && o['org.bluez.Adapter1']) adapter = { path, powered: o['org.bluez.Adapter1'].Powered };
                    let d = o['org.bluez.Device1'];
                    if (d && d.Connected) connected.push(d.Alias || d.Name || 'Dispositivo');
                }
                this._btAdapter = adapter;
                this._btRow.actor.visible = !!adapter;
                if (!adapter) return;
                this._btRow.button.setActive(adapter.powered);
                this._btRow.button.setIcon(adapter.powered ? 'bluetooth-active-symbolic' : 'bluetooth-disabled-symbolic');
                this._btRow.subtitle.text = !adapter.powered ? 'Desligado'
                    : (connected.length ? connected.join(', ') : 'Ligado');
            });
    }

    _toggleBluetooth() {
        let a = this._btAdapter;
        if (!a) return;
        let on = !a.powered;
        Gio.DBus.system.call('org.bluez', a.path, 'org.freedesktop.DBus.Properties', 'Set',
            new GLib.Variant('(ssv)', ['org.bluez.Adapter1', 'Powered', new GLib.Variant('b', on)]),
            null, Gio.DBusCallFlags.NONE, -1, null, (conn, res) => {
                try { conn.call_finish(res); }
                catch (e) { // rádio bloqueado pelo rfkill: desbloqueia e tenta pelo bluetoothctl
                    if (on) run(['rfkill', 'unblock', 'bluetooth'], () => run(['bluetoothctl', 'power', 'on']));
                }
            });
    }

    /* ---------------- Som (PulseAudio/PipeWire via Cvc) ---------------- */
    _initSound() {
        this._mixer = new Cvc.MixerControl({ name: 'Central de Controle' });
        this._connect(this._mixer, 'state-changed', () => this._onMixerState());
        this._connect(this._mixer, 'default-sink-changed', () => { this._onMixerState(); this._renderOutputs(); });
        this._connect(this._mixer, 'stream-added', () => this._renderOutputs());
        this._connect(this._mixer, 'stream-removed', () => this._renderOutputs());
        this._mixer.open();

        this._volSlider.connect('value-changed', (s, v) => this._setVolume(v));
    }

    _onMixerState() {
        if (this._mixer.get_state() !== Cvc.MixerControlState.READY) return;
        let sink = this._mixer.get_default_sink();
        if (sink === this._sink) return;
        if (this._sink && this._sinkIds) this._sinkIds.forEach(id => this._sink.disconnect(id));
        this._sink = sink;
        this._sinkIds = sink ? [sink.connect('notify::volume', () => this._updateVolume()),
                                sink.connect('notify::is-muted', () => this._updateVolume())] : null;
        this._updateVolume();
    }

    _updateVolume() {
        let s = this._sink;
        if (!s) return;
        let v = s.is_muted ? 0 : s.volume / this._mixer.get_vol_max_norm();
        if (!this._volSlider.dragging) this._volSlider.setValue(v);
        this._volSlider.icon.icon_name = v <= 0 ? 'audio-volume-muted-symbolic'
            : v < 0.34 ? 'audio-volume-low-symbolic' : v < 0.67 ? 'audio-volume-medium-symbolic' : 'audio-volume-high-symbolic';
    }

    _setVolume(v) {
        let s = this._sink;
        if (!s) return;
        s.volume = Math.round(v * this._mixer.get_vol_max_norm());
        s.push_volume();
        if (s.is_muted !== (v <= 0)) s.change_is_muted(v <= 0);
        this._updateVolume();
    }

    /* ---------------- Brilho (DDC/CI via ddcutil) ---------------- */
    _initBrightness() {
        this._ddcutil = GLib.find_program_in_path('ddcutil');
        this._ddcDisplays = null;
        this._ddcBusy = false;
        this._ddcPending = null;
        if (!this._ddcutil) {
            this._brightSlider.setValue(1);
            this._brightSlider.setSensitive(false);
            this._brightHint.text = 'Instale o ddcutil para ajustar o brilho.';
            this._brightHint.show();
            return;
        }
        let apply = debounce(150, (v) => this._setBrightness(v));
        this._brightSlider.connect('value-changed', (s, v) => apply(v));
    }

    _detectDisplays(cb) {
        if (this._ddcDisplays) return cb(this._ddcDisplays);
        run([this._ddcutil, 'detect', '--brief'], (ok, out) => {
            let nums = [];
            let re = /^Display (\d+)/gm, m;
            while ((m = re.exec(out))) nums.push(m[1]);
            if (nums.length) this._ddcDisplays = nums;
            cb(nums);
        });
    }

    _refreshBrightness() {
        if (!this._ddcutil || this._brightSlider.dragging || this._ddcBusy) return;
        this._detectDisplays((nums) => {
            if (!nums.length) {
                this._brightSlider.setSensitive(false);
                this._brightHint.text = 'Nenhum monitor com DDC/CI encontrado.';
                this._brightHint.show();
                return;
            }
            this._brightSlider.setSensitive(true);
            this._brightHint.hide();
            run([this._ddcutil, 'getvcp', '10', '--brief', '--display', nums[0]], (ok, out) => {
                let m = /VCP 10 C (\d+) (\d+)/.exec(out);
                if (m && !this._brightSlider.dragging) this._brightSlider.setValue(parseInt(m[1]) / Math.max(1, parseInt(m[2])));
            });
        });
    }

    _setBrightness(v) {
        if (this._ddcBusy) { this._ddcPending = v; return; }
        this._ddcBusy = true;
        let pct = String(Math.round(v * 100));
        this._detectDisplays((nums) => {
            let left = nums.length;
            let done = () => {
                if (--left > 0) return;
                this._ddcBusy = false;
                if (this._ddcPending !== null) { let p = this._ddcPending; this._ddcPending = null; this._setBrightness(p); }
            };
            if (!left) { left = 1; return done(); }
            nums.forEach(n => run([this._ddcutil, 'setvcp', '10', pct, '--display', n, '--noverify'], done));
        });
    }

    /* ---------------- Mídia (MPRIS) ---------------- */
    _initMpris() {
        this._players = new Map(); // nome -> { proxy, id, order }
        this._playerOrder = 0;
        let bus = Gio.DBus.session;
        bus.call('org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus', 'ListNames',
            null, null, Gio.DBusCallFlags.NONE, -1, null, (c, res) => {
                try {
                    let [names] = c.call_finish(res).deepUnpack();
                    names.filter(n => n.startsWith(MPRIS_PREFIX)).forEach(n => this._addPlayer(n));
                } catch (e) { global.logError('[controlcenter] ListNames: ' + e); }
            });
        this._dbusSubs.push([bus, bus.signal_subscribe('org.freedesktop.DBus', 'org.freedesktop.DBus', 'NameOwnerChanged',
            '/org/freedesktop/DBus', null, Gio.DBusSignalFlags.NONE, (c, s, p, i, sig, params) => {
                let [name, oldOwner, newOwner] = params.deepUnpack();
                if (!name.startsWith(MPRIS_PREFIX)) return;
                if (oldOwner) this._removePlayer(name);
                if (newOwner) this._addPlayer(name);
            })]);
        this._updateMedia();
    }

    _addPlayer(name) {
        Gio.DBusProxy.new_for_bus(Gio.BusType.SESSION, Gio.DBusProxyFlags.GET_INVALIDATED_PROPERTIES, null,
            name, '/org/mpris/MediaPlayer2', 'org.mpris.MediaPlayer2.Player', null, (o, res) => {
                let proxy;
                try { proxy = Gio.DBusProxy.new_for_bus_finish(res); } catch (e) { return; }
                this._removePlayer(name);
                let id = proxy.connect('g-properties-changed', () => this._updateMedia());
                this._players.set(name, { name, proxy, id, order: ++this._playerOrder });
                this._updateMedia();
            });
    }

    _removePlayer(name) {
        let p = this._players.get(name);
        if (!p) return;
        p.proxy.disconnect(p.id);
        this._players.delete(name);
        this._updateMedia();
    }

    _currentPlayer() {
        let best = null, bestScore = -1;
        for (let p of this._players.values()) {
            let st = p.proxy.get_cached_property('PlaybackStatus');
            st = st ? st.unpack() : 'Stopped';
            let score = (st === 'Playing' ? 2e6 : st === 'Paused' ? 1e6 : 0) + p.order;
            if (score > bestScore) { best = p; bestScore = score; }
        }
        return best;
    }

    _updateMedia() {
        let p = this._currentPlayer();
        let meta = {}, status = 'Stopped';
        if (p) {
            let m = p.proxy.get_cached_property('Metadata');
            if (m) meta = m.recursiveUnpack();
            let s = p.proxy.get_cached_property('PlaybackStatus');
            if (s) status = s.unpack();
        }
        let title = meta['xesam:title'];
        let artist = meta['xesam:artist'];
        if (Array.isArray(artist)) artist = artist.join(', ');
        let has = !!p && !!title;
        this._mTitle.text = has ? title : 'Nada tocando';
        this._mArtist.text = has ? (artist || '') : '';
        this._mArtist.visible = has && !!artist;
        [this._prevBtn, this._playBtn, this._nextBtn].forEach(b => { b.reactive = !!p; b.opacity = p ? 255 : 90; });
        this._playBtn.get_child().icon_name = status === 'Playing' ? 'media-playback-pause-symbolic' : 'media-playback-start-symbolic';
        this._setArt(has ? meta['mpris:artUrl'] : null);
    }

    _setArt(url) {
        if (url === this._artUrl) return;
        this._artUrl = url;
        let fallback = () => {
            this._art.gicon = null;
            this._art.icon_name = 'audio-x-generic-symbolic';
            this._art.icon_type = St.IconType.SYMBOLIC;
            this._art.remove_style_class_name('cc-art-image');
        };
        let show = (file) => {
            if (this._artUrl !== url) return;
            this._art.icon_type = St.IconType.FULLCOLOR;
            this._art.gicon = new Gio.FileIcon({ file });
            this._art.add_style_class_name('cc-art-image');
        };
        if (!url) return fallback();
        if (url.startsWith('file://')) return show(Gio.File.new_for_uri(url));
        if (!/^https?:\/\//.test(url)) return fallback();

        let dir = GLib.build_filenamev([GLib.get_user_cache_dir(), 'controlcenter-art']);
        GLib.mkdir_with_parents(dir, 0o755);
        let dest = Gio.File.new_for_path(GLib.build_filenamev([dir, GLib.compute_checksum_for_string(GLib.ChecksumType.SHA1, url, -1)]));
        if (dest.query_exists(null)) return show(dest);
        fallback();
        this._artUrl = url;
        Gio.File.new_for_uri(url).load_contents_async(null, (f, res) => {
            try {
                let [, bytes] = f.load_contents_finish(res);
                dest.replace_contents(bytes, null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
                show(dest);
            } catch (e) { /* sem rede ou gvfs sem http: mantém o ícone padrão */ }
        });
    }

    _mediaCall(method) {
        let p = this._currentPlayer();
        if (p) p.proxy.call(method, null, Gio.DBusCallFlags.NONE, -1, null, null);
    }

    /* ---------------- Limpeza ---------------- */
    on_applet_removed_from_panel() {
        this._signals.forEach(([o, id]) => { try { o.disconnect(id); } catch (e) { } });
        this._dbusSubs.forEach(([c, id]) => c.signal_unsubscribe(id));
        for (let p of this._players.values()) p.proxy.disconnect(p.id);
        if (this._sink && this._sinkIds) this._sinkIds.forEach(id => this._sink.disconnect(id));
        if (this._mixer) this._mixer.close();
        this.menu.destroy();
    }
}

function main(metadata, orientation, panelHeight, instanceId) {
    return new ControlCenterApplet(metadata, orientation, panelHeight, instanceId);
}
