// ============================================================
// ui.js — HUD, меню, лобби, таблица очков, килл-фид, настройки
// ============================================================

import { $, el, Settings, formatTime, clamp, debounce } from './utils.js';
import { device } from './device.js';
import { applySettings as applyTouchSettings, setControlsVisible } from './touchControls.js';
import { MODE_INFO } from './modes.js';

const SCREENS = ['screen-loading', 'screen-menu', 'screen-lobby', 'screen-settings',
  'screen-tutorial', 'screen-game', 'screen-pause', 'screen-result'];

export class UI {
  constructor(settings) {
    this.settings = settings || new Settings();
    this.current = 'screen-loading';
    this._gameActive = false;
    this._scoreRows = null;
    this._kfCount = 0;
    this._deathTimer = 0;
    this._onRespawn = null;
    this._onLeave = null;
    this._onSettingsChange = null;
    this._minimapOn = this.settings.get('minimap');
  }

  init() {
    this._bindMenu();
    this._bindSettings();
    this._bindHud();
    this._bindLobby();
    this.applyAllSettings();
  }

  // ----------------------------------------------------------
  // Навигация между экранами
  // ----------------------------------------------------------
  show(id) {
    // Пауза/результат — оверлеи поверх сцены: игровой экран не прячем
    const overlay = id === 'screen-pause' || id === 'screen-result';
    const keepGame = overlay && this._gameActive;
    for (const s of SCREENS) {
      const active = s === id || (keepGame && s === 'screen-game');
      document.getElementById(s)?.classList.toggle('active', active);
    }
    this.current = id;
    if (id === 'screen-menu' || id === 'screen-lobby') this._gameActive = false;

    // Тач-контролы видны только на активном игровом экране
    setControlsVisible(id === 'screen-game');
    const hudVisible = this._gameActive &&
      (id === 'screen-game' || id === 'screen-pause');
    document.getElementById('hud')?.classList.toggle('hidden', !hudVisible);
    if (id !== 'screen-game') document.exitPointerLock?.();
  }

  /** Матч начался — игровой экран/оверлеи активны */
  enterMatch() { this._gameActive = true; }

  /** Матч закончился (выход из комнаты) */
  leaveMatch() {
    this._gameActive = false;
    this.hideDeath();
    this.hideReconnect();
    this.toggleScoreboard(false);
  }

  _bindMenu() {
    $('btn-play')?.addEventListener('click', () => this.show('screen-lobby'));
    $('btn-settings')?.addEventListener('click', () => this.show('screen-settings'));
    $('btn-tutorial')?.addEventListener('click', () => this.emit('tutorial'));
    $('btn-about')?.addEventListener('click', () => {
      $('about-text')?.classList.toggle('hidden');
    });

    $('btn-settings-back')?.addEventListener('click', () => this.show('screen-menu'));
    $('btn-settings-done')?.addEventListener('click', () => {
      this.show(this._settingsBack || 'screen-menu');
      this._settingsBack = null;
    });

    $('btn-lobby-back')?.addEventListener('click', () => this.show('screen-menu'));

    $('btn-resume')?.addEventListener('click', () => this.resume());
    $('btn-pause-settings')?.addEventListener('click', () => {
      this._settingsBack = 'screen-pause';
      this.show('screen-settings');
    });
    $('btn-leave')?.addEventListener('click', () => {
      this.hidePause();
      this._onLeave?.('lobby');
    });

    $('btn-result-again')?.addEventListener('click', () => this._onLeave?.('lobby'));
    $('btn-result-menu')?.addEventListener('click', () => this._onLeave?.('menu'));

    $('btn-reconnect-cancel')?.addEventListener('click', () => {
      this.hideReconnect();
      this._onLeave?.('lobby');
    });
  }

  // ----------------------------------------------------------
  // Настройки
  // ----------------------------------------------------------
  _bindSettings() {
    const s = this.settings;
    const sens = $('set-sens'), invy = $('set-invy'), qual = $('set-quality');
    const vib = $('set-vib'), jsz = $('set-joysize'), jright = $('set-joyright');
    const af = $('set-autofire'), alpha = $('set-alpha'), mm = $('set-minimap');

    if (sens) {
      sens.value = s.get('sens');
      $('val-sens').textContent = Number(s.get('sens')).toFixed(1);
      sens.addEventListener('input', () => {
        s.set('sens', parseFloat(sens.value));
        $('val-sens').textContent = parseFloat(sens.value).toFixed(1);
        this.applyAllSettings();
      });
    }
    if (invy) {
      invy.checked = !!s.get('invY');
      invy.addEventListener('change', () => { s.set('invY', invy.checked); this.applyAllSettings(); });
    }
    if (qual) {
      qual.value = s.get('quality');
      qual.addEventListener('change', () => { s.set('quality', qual.value); this.applyAllSettings(); });
    }
    if (vib) {
      vib.checked = !!s.get('vibration');
      vib.addEventListener('change', () => { s.set('vibration', vib.checked); this.applyAllSettings(); });
    }
    if (jsz) {
      jsz.value = s.get('joySize');
      jsz.addEventListener('change', () => { s.set('joySize', jsz.value); this.applyAllSettings(); });
    }
    if (jright) {
      jright.checked = !!s.get('joyRight');
      jright.addEventListener('change', () => { s.set('joyRight', jright.checked); this.applyAllSettings(); });
    }
    if (af) {
      af.checked = !!s.get('autofire');
      af.addEventListener('change', () => { s.set('autofire', af.checked); this.applyAllSettings(); });
    }
    if (alpha) {
      alpha.value = s.get('ctrlAlpha');
      $('val-alpha').textContent = Number(s.get('ctrlAlpha')).toFixed(2);
      alpha.addEventListener('input', () => {
        s.set('ctrlAlpha', parseFloat(alpha.value));
        $('val-alpha').textContent = parseFloat(alpha.value).toFixed(2);
        this.applyAllSettings();
      });
    }
    if (mm) {
      mm.checked = !!s.get('minimap');
      mm.addEventListener('change', () => {
        s.set('minimap', mm.checked);
        this._minimapOn = mm.checked;
        $('minimap-wrap')?.classList.toggle('hidden', !mm.checked);
      });
    }
  }

  /** Прокинуть настройки во все подсистемы */
  applyAllSettings() {
    const s = this.settings;
    const q = s.get('quality') === 'auto' ? device.tier : s.get('quality');
    const p = device.qualityParams(q);
    device.setMaxDPR(p.dpr);
    this._onSettingsChange?.(p);

    applyTouchSettings({
      vibration: s.get('vibration'),
      joySize: s.get('joySize'),
      joyRight: s.get('joyRight'),
      ctrlAlpha: s.get('ctrlAlpha'),
      autofire: s.get('autofire')
    });
    $('minimap-wrap')?.classList.toggle('hidden', !s.get('minimap'));
  }

  onSettingsChange(fn) { this._onSettingsChange = fn; }

  // ----------------------------------------------------------
  // Лобби
  // ----------------------------------------------------------
  _bindLobby() {
    const nick = $('input-nick');
    if (nick) {
      nick.value = this.settings.get('nick') || '';
      nick.addEventListener('change', () => {
        this.settings.set('nick', nick.value.trim() || 'Кот_Боец');
        this.emit('nick', this.settings.get('nick'));
      });
    }

    $('btn-refresh')?.addEventListener('click', () => this.emit('refreshRooms'));
    $('btn-quick')?.addEventListener('click', () => this.emit('quickJoin'));
    $('btn-create')?.addEventListener('click', () => {
      const name = $('input-newroom').value.trim();
      this.emit('createRoom', { name, mode: this._selectedMode() });
    });
    $('btn-join-name')?.addEventListener('click', () => {
      const name = $('input-room').value.trim();
      if (name) this.emit('joinRoom', { name, mode: this._selectedMode() });
    });

    $('mode-select')?.addEventListener('click', (e) => {
      const b = e.target.closest('[data-mode]');
      if (!b) return;
      $('mode-select').querySelectorAll('.chip').forEach((c) => c.classList.remove('sel'));
      b.classList.add('sel');
      this.settings.set('lastMode', b.dataset.mode);
    });
    // Восстановить последний выбранный режим
    const last = this.settings.get('lastMode');
    if (last) {
      const btn = document.querySelector(`#mode-select [data-mode="${last}"]`);
      if (btn) {
        $('mode-select').querySelectorAll('.chip').forEach((c) => c.classList.remove('sel'));
        btn.classList.add('sel');
      }
    }
  }

  _selectedMode() {
    return document.querySelector('#mode-select .chip.sel')?.dataset.mode || 'team';
  }

  photonStatus(text, cls = '') {
    const e = $('photon-status');
    if (e) {
      e.textContent = text;
      e.className = `chip ${cls}`;
    }
  }

  renderRooms(rooms) {
    const box = $('room-list');
    if (!box) return;
    const list = Array.isArray(rooms) ? rooms : [];
    if (!list.length) {
      box.innerHTML = '<div class="room-empty">Список пуст. Создайте комнату.</div>';
      return;
    }
    box.innerHTML = '';
    for (const r of list) {
      const name = r.getName ? r.getName() : r.name;
      const players = r.getPlayerCount ? r.getPlayerCount() : (r.playerCount ?? 0);
      const max = r.getMaxPlayers ? r.getMaxPlayers() : (r.maxPlayers ?? 8);
      const mode = r.getCustomProperty ? r.getCustomProperty('mode') : r.mode;
      const div = el(`
        <div class="room-item">
          <span class="rname">${escapeHtml(name)}</span>
          <span class="rmeta">${MODE_INFO[mode]?.short || mode || '—'} · ${players}/${max}</span>
          <span class="rjoin">войти</span>
        </div>`);
      div.addEventListener('click', () => this.emit('joinRoom', { name, mode: mode || 'team' }));
      box.appendChild(div);
    }
  }

  // ----------------------------------------------------------
  // HUD
  // ----------------------------------------------------------
  _bindHud() {
    $('btn-pause')?.addEventListener('click', () => this.showPause());
    $('btn-scoreboard')?.addEventListener('click', () => this.toggleScoreboard(true));
    const sb = $('btn-scoreboard');
    if (sb) {
      const off = () => this.toggleScoreboard(false);
      sb.addEventListener('pointerup', off);
      sb.addEventListener('pointerleave', off);
    }
    $('btn-respawn-now')?.addEventListener('click', () => this._respawnNow?.());
  }

  setHP(hp) {
    const fill = $('hp-fill'), txt = $('hp-text');
    if (!fill) return;
    const pct = clamp(hp / 100, 0, 1) * 100;
    fill.style.width = `${pct}%`;
    fill.classList.toggle('low', hp <= 35);
    if (txt) txt.textContent = Math.max(0, Math.round(hp));
  }

  setShield(v) {
    let e = document.getElementById('hud-shield');
    if (!e) {
      e = el('<div id="hud-shield" class="hud-chip" style="color:#ffd54a">🛡 0</div>');
      document.querySelector('.hud-top-left')?.appendChild(e);
    }
    e.textContent = `🛡 ${Math.round(v)}`;
    e.style.display = v > 0 ? '' : 'none';
  }

  setAmmo(mag, reserve, reloading = false) {
    const m = $('ammo-mag'), r = $('ammo-res');
    if (m) m.textContent = reloading ? '…' : String(mag);
    if (r) r.textContent = `/${reserve}`;
  }

  setGrenades(n, max = 3) {
    const box = $('nades');
    if (!box) return;
    if (box.childElementCount !== max) {
      box.innerHTML = Array.from({ length: max }, () => '<i></i>').join('');
    }
    [...box.children].forEach((c, i) => c.classList.toggle('spent', i >= n));
  }

  /** cd 0..1 (1 = готов) */
  setDash(cdRatio) {
    const ring = $('dash-ring');
    if (!ring) return;
    ring.style.setProperty('--dash', `${clamp(cdRatio, 0, 1) * 100}%`);
    ring.classList.toggle('ready', cdRatio >= 1);
  }

  setBuffs(buffs) {
    const row = $('buff-row');
    if (!row) return;
    const labels = {
      speed: '» скорострел',
      shield: '◈ щит',
      ricochet: '↗ рикошет',
      homing: '◎ самонаведение',
      dashFx: ''
    };
    const parts = [];
    for (const [k, v] of Object.entries(buffs || {})) {
      if (labels[k] === undefined || !labels[k]) continue;
      parts.push(`<span class="buff">${labels[k]} ${Math.ceil(v)}с</span>`);
    }
    const html = parts.join('');
    if (row.innerHTML !== html) row.innerHTML = html;
  }

  setModeLabel(text) { const e = $('hud-mode'); if (e) e.textContent = text; }
  setTimer(text) { const e = $('hud-timer'); if (e) e.textContent = text; }
  setObjective(text) {
    const e = $('hud-objective');
    if (!e) return;
    e.textContent = text;
    e.classList.toggle('hidden', !text);
  }
  setTeamScore(a, b) {
    const box = $('score-mini');
    if (box) {
      box.innerHTML =
        `<div class="srow"><span>Команда A</span><b>${a}</b></div>` +
        `<div class="srow"><span>Команда B</span><b>${b}</b></div>`;
    }
  }

  toast(msg, ms = 1600) {
    const t = $('toast');
    if (!t) return;
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(this._toastT);
    this._toastT = setTimeout(() => t.classList.remove('show'), ms);
  }

  hitmarker(headshot) {
    const h = $('hitmarker');
    if (!h) return;
    h.classList.remove('show');
    void h.offsetWidth; // рестарт анимации
    h.classList.add('show');
    if (headshot) h.style.filter = 'hue-rotate(140deg)';
    else h.style.filter = '';
  }

  damageFlash() {
    let f = document.getElementById('dmg-flash');
    if (!f) {
      f = el('<div id="dmg-flash"></div>');
      Object.assign(f.style, {
        position: 'absolute', inset: '0', pointerEvents: 'none',
        boxShadow: 'inset 0 0 90px rgba(255,0,30,.85)', opacity: '0',
        transition: 'opacity .35s', zIndex: '25'
      });
      $('hud')?.appendChild(f);
    }
    f.style.transition = 'none';
    f.style.opacity = '1';
    requestAnimationFrame(() => {
      f.style.transition = 'opacity .4s';
      f.style.opacity = '0';
    });
  }

  killfeed(killer, victim, headshot = false) {
    const box = $('killfeed');
    if (!box) return;
    const item = el(`<div class="kf-item"><b>${escapeHtml(killer)}</b> ${headshot ? '🎯' : '☠'} <span class="victim">${escapeHtml(victim)}</span></div>`);
    box.appendChild(item);
    this._kfCount++;
    setTimeout(() => item.classList.add('fade'), 3600);
    setTimeout(() => item.remove(), 4200);
    while (box.children.length > 5) box.firstChild.remove();
  }

  // ----------------------------------------------------------
  // Смерть / респавн
  // ----------------------------------------------------------
  showDeath(killerName, headshot, onRespawn) {
    const ov = $('death-overlay');
    if (!ov) return;
    ov.classList.remove('hidden');
    $('death-killer').textContent = headshot
      ? `Убит (хедшот) — ${killerName}`
      : `Убит — ${killerName}`;
    this._onRespawn = onRespawn || this._onRespawn;
    this._deathTimer = 3;
    const c = $('respawn-count');
    if (c) c.textContent = '3';

    clearInterval(this._deathIv);
    this._deathIv = setInterval(() => {
      this._deathTimer -= 1;
      if (c) c.textContent = String(Math.max(0, this._deathTimer));
      if (this._deathTimer <= 0) {
        clearInterval(this._deathIv);
        this.hideDeath();
        this._onRespawn?.();
      }
    }, 1000);
  }

  /** Главный цикл таймера смерти (вызывает main, чтобы работало в паузе) */
  tickDeath(dt) {
    if ($('death-overlay')?.classList.contains('hidden')) return;
  }

  hideDeath() {
    $('death-overlay')?.classList.add('hidden');
    clearInterval(this._deathIv);
  }

  onRespawnNow(fn) { this._respawnNow = fn; }

  /** Колбэк выхода из комнаты/матча (регистрирует main.js) */
  onLeave(fn) { this._onLeave = fn; }

  /** Колбэк автоматического респавна по таймеру (регистрирует main.js) */
  onRespawn(fn) { this._onRespawn = fn; }

  // ----------------------------------------------------------
  // Пауза
  // ----------------------------------------------------------
  showPause() { this.show('screen-pause'); this.emit('pause'); }
  hidePause() { this.show('screen-game'); this.emit('resume'); }
  resume() { this.show('screen-game'); this.emit('resume'); }

  // ----------------------------------------------------------
  // Таблица очков
  // ----------------------------------------------------------
  toggleScoreboard(on) {
    $('scoreboard')?.classList.toggle('hidden', !on);
  }

  /**
   * @param {Array} [rows] [{name, team, kills, deaths, score, isMe}]
   *   Если не передан — берётся из провайдера (setScoreProvider).
   */
  updateScoreboard(rows) {
    const a = $('team-a-list'), b = $('team-b-list');
    if (!a || !b) return;
    const list = rows || this._scoreProvider?.() || [];
    const head = '<div class="sline head"><span>Игрок</span><span>K</span><span>D</span><span>Очки</span></div>';
    const line = (r) =>
      `<div class="sline ${r.isMe ? 'me' : ''}"><span class="nm">${escapeHtml(r.name)}</span>` +
      `<span>${r.kills}</span><span>${r.deaths}</span><span><b>${r.score}</b></span></div>`;
    a.innerHTML = head + list.filter((r) => r.team === 'a').map(line).join('');
    b.innerHTML = head + list.filter((r) => r.team === 'b').map(line).join('');
    const mode = $('sb-mode');
    if (mode) mode.textContent = this._modeLabel || '';
  }

  setModeShort(label) { this._modeLabel = label; }

  /** Провайдер строк таблицы очков (main: local + remotes) */
  setScoreProvider(fn) { this._scoreProvider = fn; }

  // ----------------------------------------------------------
  // Результаты
  // ----------------------------------------------------------
  showResult(data) {
    const t = $('result-title');
    const table = $('result-table');
    if (t) {
      if (data.winner === null) t.textContent = 'Ничья!';
      else if (data.winner === data.myTeam) t.textContent = 'ПОБЕДА! 🏆';
      else t.textContent = 'Поражение';
    }
    if (table) {
      const rows = data.rows || [];
      table.innerHTML =
        `<div class="rrow head"><span>Игрок</span><span>K</span><span>D</span><span>Очки</span></div>` +
        rows.map((r) =>
          `<div class="rrow"><span>${escapeHtml(r.name)}</span><span>${r.kills}</span>` +
          `<span>${r.deaths}</span><span><b>${r.score}</b></span></div>`
        ).join('') +
        `<div class="rrow"><span>Итог команд</span><span>${data.score?.a ?? data.goals?.a ?? 0}</span>` +
        `<span>${data.score?.b ?? data.goals?.b ?? 0}</span><span></span></div>`;
    }
    this.show('screen-result');
  }

  // ----------------------------------------------------------
  // Ошибки / реконнект
  // ----------------------------------------------------------
  showReconnect(text = 'Переподключение…', fatal = false) {
    const d = $('reconnect-dialog');
    if (!d) return;
    d.classList.remove('hidden');
    $('reconnect-text').textContent = text;
    $('btn-reconnect-cancel').textContent = fatal ? 'Выйти в меню' : 'Отмена';
  }

  hideReconnect() { $('reconnect-dialog')?.classList.add('hidden'); }

  /** Общий диалог с сообщением (инструкции, ошибки настроек) */
  showMessage(text, title = 'Сообщение') {
    const t = $('msg-title'), p = $('msg-text');
    if (t) t.textContent = title;
    if (p) p.textContent = text;
    $('msg-dialog')?.classList.remove('hidden');
    $('btn-msg-ok')?.addEventListener('click', () => {
      $('msg-dialog')?.classList.add('hidden');
    }, { once: true });
  }

  showError(text) {
    const e = $('loading-error');
    if (e) e.textContent = text;
  }

  showLoadingProgress(done, total, key) {
    const pct = total ? Math.round((done / total) * 100) : 0;
    const fill = $('progress-fill');
    const txt = $('progress-text');
    if (fill) fill.style.width = `${pct}%`;
    if (txt) txt.textContent = `Загрузка ассетов… ${pct}% (${key || ''})`;
  }

  setLoadError(msg) {
    const e = $('loading-error');
    if (e) e.textContent = msg;
  }

  // ----------------------------------------------------------
  // Мини-карта
  // ----------------------------------------------------------
  drawMinimap(ctx2d, { playerPos, yaw, allies, enemies, points }) {
    if (!this._minimapOn || !ctx2d) return;
    const S = 140;
    const scale = S / CONFIG_MAP_SIZE;
    const cx = S / 2, cy = S / 2;
    ctx2d.clearRect(0, 0, S, S);
    ctx2d.fillStyle = 'rgba(8,12,22,.75)';
    ctx2d.fillRect(0, 0, S, S);

    // Сетка зон
    ctx2d.strokeStyle = 'rgba(255,255,255,.08)';
    ctx2d.lineWidth = 1;
    for (let i = 1; i < 4; i++) {
      const p = (i * S) / 4;
      ctx2d.beginPath(); ctx2d.moveTo(p, 0); ctx2d.lineTo(p, S); ctx2d.stroke();
      ctx2d.beginPath(); ctx2d.moveTo(0, p); ctx2d.lineTo(S, p); ctx2d.stroke();
    }

    // Точки интереса
    for (const p of points || []) {
      ctx2d.fillStyle = p.color;
      ctx2d.beginPath();
      ctx2d.arc(cx + p.x * scale, cy + p.z * scale, 4, 0, 7);
      ctx2d.fill();
    }

    const drawDot = (x, z, color, r) => {
      ctx2d.fillStyle = color;
      ctx2d.beginPath();
      ctx2d.arc(cx + x * scale, cy + z * scale, r, 0, 7);
      ctx2d.fill();
    };

    for (const a of allies || []) drawDot(a.x, a.z, '#43d9ff', 3.5);
    for (const e of enemies || []) drawDot(e.x, e.z, '#ff4d5e', 3.5);

    // Стрелка игрока
    ctx2d.save();
    ctx2d.translate(cx + playerPos.x * scale, cy + playerPos.z * scale);
    ctx2d.rotate(Math.PI - yaw);
    ctx2d.fillStyle = '#fff';
    ctx2d.beginPath();
    ctx2d.moveTo(0, -6); ctx2d.lineTo(4.5, 5); ctx2d.lineTo(-4.5, 5);
    ctx2d.closePath();
    ctx2d.fill();
    ctx2d.restore();
  }

  // ----------------------------------------------------------
  // Простая шина событий (ui → main)
  // ----------------------------------------------------------
  _handlers = {};
  on(evt, fn) { (this._handlers[evt] ||= []).push(fn); }
  emit(evt, data) {
    for (const fn of this._handlers[evt] || []) {
      try { fn(data); } catch (e) { console.error('[UI]', evt, e); }
    }
  }
}

const CONFIG_MAP_SIZE = 200;

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}
