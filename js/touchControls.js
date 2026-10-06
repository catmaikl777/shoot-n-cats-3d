// ============================================================
// touchControls.js — виртуальные джойстики, свайп камеры,
// кнопки действий, pinch-zoom, свайп-пауза, двойной тап-таунт,
// плюс десктопное управление (клавиатура + мышь)
// ============================================================

import { clamp, vibrate } from './utils.js';

// ------------------------------------------------------------
// Глобальный объект ввода — его читает player.js каждый кадр
// ------------------------------------------------------------
export const input = {
  move: { x: 0, y: 0 },      // -1..1 (x — вбок, y — вперёд)
  aim: false,                // прицеливание (ПКМ)
  fire: false,               // удержание огня
  jump: false,               // запрашивает прыжок (сбрасывается игроком)
  dash: false,               // запрашивает рывок
  reload: false,             // запрос перезарядки
  sensitivity: 1,
  invertY: false,
  autofire: true,            // авто-огонь при удержании (настраивается)
  taunt: false,              // мяуканье (двойной тап)
  paused: false,

  _lookX: 0,
  _lookY: 0,
  _zoom: 0,                  // накопленный pinch-zoom

  /** Забрать и обнулить дельту взгляда */
  consumeLook() {
    const out = { x: this._lookX, y: this._lookY, zoom: this._zoom };
    this._lookX = 0;
    this._lookY = 0;
    this._zoom = 0;
    return out;
  },

  addLook(dx, dy) {
    this._lookX += dx;
    this._lookY += dy;
  },

  addZoom(d) {
    this._zoom += d;
  }
};

// ------------------------------------------------------------
// Настройки (прокидываются из ui.js)
// ------------------------------------------------------------
const opts = {
  vibration: true,
  joySize: 'medium',
  joyRight: false,
  alpha: 0.45,
  autofire: true
};

const JOY_RADIUS = { small: 96, medium: 132, large: 164 };

let els = {};
let callbacks = {
  onNadeRelease: null,  // (power 0..1)
  onTaunt: null,
  onPauseSwipe: null
};

// Состояние касаний
let joyPointer = null;      // id пальца джойстика
let joyOrigin = { x: 0, y: 0 };
let joyVec = { x: 0, y: 0 };
let aimPointer = null;
let aimLast = { x: 0, y: 0 };
let joyHideTimer = 0;

// Pinch
const activePointers = new Map(); // id -> {x, y, zone}
let pinchStartDist = 0;

// Задержки ввода (чтобы тап по кнопке не выстрелил и т.п.)
let nadeHolding = false;
let nadeStartTime = 0;

// Десктоп
const keys = new Set();
let mouseLocked = false;

// ------------------------------------------------------------
// Инициализация
// ------------------------------------------------------------
export function initTouchControls(callbacksIn = {}) {
  Object.assign(callbacks, callbacksIn);

  els = {
    root: document.getElementById('touch-controls'),
    joyZone: document.getElementById('joy-zone'),
    aimZone: document.getElementById('aim-zone'),
    joyBase: document.getElementById('joy-base'),
    joyStick: document.getElementById('joy-stick'),
    btnFire: document.getElementById('btn-fire'),
    btnJump: document.getElementById('btn-jump'),
    btnNade: document.getElementById('btn-grenade'),
    btnDash: document.getElementById('btn-dash'),
    btnReload: document.getElementById('btn-reload'),
    keyHints: document.getElementById('key-hints'),
    canvas: document.getElementById('game-canvas')
  };

  // --- Джойстик ---
  els.joyZone.addEventListener('pointerdown', onJoyStart, { passive: false });
  els.joyZone.addEventListener('pointermove', onJoyMove, { passive: false });
  els.joyZone.addEventListener('pointerup', onJoyEnd, { passive: false });
  els.joyZone.addEventListener('pointercancel', onJoyEnd, { passive: false });

  // --- Камера (свайп) ---
  els.aimZone.addEventListener('pointerdown', onAimStart, { passive: false });
  els.aimZone.addEventListener('pointermove', onAimMove, { passive: false });
  els.aimZone.addEventListener('pointerup', onAimEnd, { passive: false });
  els.aimZone.addEventListener('pointercancel', onAimEnd, { passive: false });

  // --- Кнопки действий ---
  bindHoldButton(els.btnFire, (down) => {
    input.fire = down;
    els.btnFire.classList.toggle('pressed', down);
    if (down) vibrate(12, opts.vibration);
  });
  bindTapButton(els.btnJump, () => {
    input.jump = true;
    vibrate(20, opts.vibration);
  });
  bindHoldButton(els.btnDash, (down) => {
    if (down) { input.dash = true; vibrate(25, opts.vibration); }
  });
  bindTapButton(els.btnReload, () => { input.reload = true; });

  // Граната: удержание копит силу, отпускание бросает
  bindHoldButton(els.btnNade, (down) => {
    if (down) {
      nadeHolding = true;
      nadeStartTime = performance.now();
      els.btnNade.classList.add('pressed');
    } else if (nadeHolding) {
      nadeHolding = false;
      els.btnNade.classList.remove('pressed');
      const power = clamp((performance.now() - nadeStartTime) / 1500, 0.15, 1);
      callbacks.onNadeRelease?.(power);
    }
  });

  // --- Десктоп: клавиатура ---
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', () => keys.clear());

  // --- Десктоп: мышь ---
  if (els.canvas) {
    els.canvas.addEventListener('mousedown', onMouseDown);
    window.addEventListener('mouseup', onMouseUp);
    els.canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('pointerlockchange', () => {
      mouseLocked = document.pointerLockElement === els.canvas;
    });
  }

  applySettings(opts);
  return input;
}

// ------------------------------------------------------------
// Джойстик движения
// ------------------------------------------------------------
function onJoyStart(e) {
  if (joyPointer !== null) return;
  e.preventDefault();
  joyPointer = e.pointerId;
  joyOrigin = { x: e.clientX, y: e.clientY };
  activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY, zone: 'joy' });

  const r = JOY_RADIUS[opts.joySize] || 132;
  els.joyBase.style.left = `${joyOrigin.x}px`;
  els.joyBase.style.top = `${joyOrigin.y}px`;
  els.joyBase.classList.add('show');
  joyHideTimer = 0;
  try { els.joyZone.setPointerCapture(e.pointerId); } catch (_) {}
}

function onJoyMove(e) {
  if (e.pointerId !== joyPointer) return;
  e.preventDefault();
  const r = (JOY_RADIUS[opts.joySize] || 132) / 2;
  let dx = e.clientX - joyOrigin.x;
  let dy = e.clientY - joyOrigin.y;
  const len = Math.hypot(dx, dy);
  const max = r;
  if (len > max) {
    dx = (dx / len) * max;
    dy = (dy / len) * max;
  }
  joyVec.x = dx / max;
  joyVec.y = -dy / max;   // экранная ось Y инвертирована (вверх = +)

  els.joyStick.style.transform = `translate(${dx}px, ${dy}px)`;
  input.move.x = clamp(joyVec.x, -1, 1);
  input.move.y = clamp(joyVec.y, -1, 1);
  activePointers.get(e.pointerId).x = e.clientX;
  activePointers.get(e.pointerId).y = e.clientY;
}

function onJoyEnd(e) {
  if (e.pointerId !== joyPointer) return;
  joyPointer = null;
  joyVec = { x: 0, y: 0 };
  input.move.x = 0;
  input.move.y = 0;
  els.joyStick.style.transform = 'translate(0px, 0px)';
  joyHideTimer = 1.5; // автоскрытие через 1.5 сек
  activePointers.delete(e.pointerId);
}

// ------------------------------------------------------------
// Свайп камеры + pinch-zoom
// ------------------------------------------------------------
function onAimStart(e) {
  e.preventDefault();
  // Двойной тап — мяуканье
  registerDoubleTap(e);
  if (aimPointer === null) {
    aimPointer = e.pointerId;
    aimLast = { x: e.clientX, y: e.clientY };
  }
  activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY, zone: 'aim' });
  updatePinch();
  try { els.aimZone.setPointerCapture(e.pointerId); } catch (_) {}
}

function onAimMove(e) {
  e.preventDefault();
  const rec = activePointers.get(e.pointerId);
  if (rec) { rec.x = e.clientX; rec.y = e.clientY; }

  // Pinch — только когда ОБА пальца в зоне камеры. Палец джойстика — не пинч,
  // иначе одновременное «джойстик + свайп камеры» не работает.
  const aimCount = [...activePointers.values()].filter((p) => p.zone === 'aim').length;
  if (aimCount >= 2) {
    updatePinch();
    return;
  }
  if (e.pointerId !== aimPointer) return;

  const dx = e.clientX - aimLast.x;
  const dy = e.clientY - aimLast.y;
  aimLast = { x: e.clientX, y: e.clientY };
  input.addLook(dx * 1.0, dy * 1.0);

  // Свайп вверх от нижнего края — пауза
  if (e.clientY > window.innerHeight - 26 && dy < -18) {
    callbacks.onPauseSwipe?.();
  }
}

function onAimEnd(e) {
  activePointers.delete(e.pointerId);
  if (e.pointerId === aimPointer) aimPointer = null;
  const aimCount = [...activePointers.values()].filter((p) => p.zone === 'aim').length;
  if (aimCount < 2) pinchStartDist = 0;
}

function updatePinch() {
  const pts = [...activePointers.values()].filter((p) => p.zone === 'aim');
  if (pts.length < 2) return;
  const d = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
  if (pinchStartDist > 0) {
    const delta = (pinchStartDist - d) * 0.012; // разводим пальцы → зум
    input.addZoom(delta);
  }
  pinchStartDist = d;
}

// ------------------------------------------------------------
// Кнопки (универсальные обработчики)
// ------------------------------------------------------------
function bindTapButton(el, fn) {
  if (!el) return;
  el.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    fn(true);
  });
}

function bindHoldButton(el, fn) {
  if (!el) return;
  el.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    el.setPointerCapture?.(e.pointerId);
    fn(true);
  });
  const up = (e) => {
    e.preventDefault();
    e.stopPropagation();
    fn(false);
  };
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', up);
  el.addEventListener('lostpointercapture', () => fn(false));
}

// ------------------------------------------------------------
// Двойной тап — мяуканье (по любой свободной зоне экрана)
// ------------------------------------------------------------
let lastTapTime = 0;
let lastTapX = 0;
let lastTapY = 0;
export function registerDoubleTap(e) {
  const now = performance.now();
  const dist = Math.hypot(e.clientX - lastTapX, e.clientY - lastTapY);
  if (now - lastTapTime < 320 && dist < 45) {
    input.taunt = true;
    callbacks.onTaunt?.();
    vibrate(40, opts.vibration);
    lastTapTime = 0;
  } else {
    lastTapTime = now;
    lastTapX = e.clientX;
    lastTapY = e.clientY;
  }
}

// ------------------------------------------------------------
// Десктоп: клавиатура
// ------------------------------------------------------------
function onKeyDown(e) {
  if (e.repeat) return;
  const c = e.code;
  keys.add(c);
  switch (c) {
    case 'Space':
      input.jump = true;
      e.preventDefault();
      break;
    case 'ShiftLeft':
    case 'ShiftRight':
      input.dash = true;
      break;
    case 'KeyR':
      input.reload = true;
      break;
    case 'KeyG':
      nadeHolding = true;
      nadeStartTime = performance.now();
      break;
    case 'Tab':
      document.getElementById('scoreboard')?.classList.remove('hidden');
      e.preventDefault();
      break;
    case 'Escape':
      callbacks.onPauseSwipe?.();
      break;
  }
}

function onKeyUp(e) {
  keys.delete(e.code);
  if (e.code === 'KeyG' && nadeHolding) {
    nadeHolding = false;
    const power = clamp((performance.now() - nadeStartTime) / 1500, 0.15, 1);
    callbacks.onNadeRelease?.(power);
  }
  if (e.code === 'Tab') {
    document.getElementById('scoreboard')?.classList.add('hidden');
  }
}

function onMouseDown(e) {
  if (e.button === 0) {
    input.fire = true;
    if (!mouseLocked && els.canvas?.requestPointerLock) {
      els.canvas.requestPointerLock();
    }
  } else if (e.button === 2) {
    input.aim = true;
  }
}

function onMouseUp(e) {
  if (e.button === 0) input.fire = false;
  if (e.button === 2) input.aim = false;
}

function onMouseMove(e) {
  if (!mouseLocked) return;
  input.addLook(e.movementX || 0, e.movementY || 0);
}

// ------------------------------------------------------------
// Вызывается каждый кадр из main.js
// ------------------------------------------------------------
export function updateTouchControls(dt) {
  // WASD
  if (keys.size) {
    let x = 0, y = 0;
    if (keys.has('KeyW') || keys.has('ArrowUp')) y += 1;
    if (keys.has('KeyS') || keys.has('ArrowDown')) y -= 1;
    if (keys.has('KeyA') || keys.has('ArrowLeft')) x -= 1;
    if (keys.has('KeyD') || keys.has('ArrowRight')) x += 1;
    // Не затираем тач-джойстик, если он активен
    if (joyPointer === null) {
      const len = Math.hypot(x, y) || 1;
      input.move.x = x / len * (Math.hypot(x, y) > 0 ? 1 : 0);
      input.move.y = y / len * (Math.hypot(x, y) > 0 ? 1 : 0);
    }
  } else if (joyPointer === null && !isTouchActive()) {
    input.move.x = 0;
    input.move.y = 0;
  }

  // Автоскрытие джойстика
  if (joyHideTimer > 0) {
    joyHideTimer -= dt;
    if (joyHideTimer <= 0 && joyPointer === null) {
      els.joyBase?.classList.remove('show');
    }
  }

  // Удержание гранаты на десктопе (G)
  // сила применяется в main при отпускании

  // Индикатор заряда гранаты
  if (nadeHolding && els.btnNade) {
    const p = clamp((performance.now() - nadeStartTime) / 1500, 0, 1);
    els.btnNade.style.boxShadow = `0 0 ${6 + p * 18}px rgba(255,138,61,${0.3 + p * 0.6})`;
  } else if (els.btnNade) {
    els.btnNade.style.boxShadow = '';
  }

  // Сброс разовых запросов
  if (input.taunt) input.taunt = false;
}

function isTouchActive() {
  return joyPointer !== null;
}

/** Показать/скрыть тач-контролы (и подсказки клавиш) */
export function setControlsVisible(on) {
  els.root?.classList.toggle('on', !!on);
  els.keyHints?.classList.toggle('on', !!on);
}

/** Применить настройки (вызывается из ui.js при изменении) */
export function applySettings(s) {
  Object.assign(opts, s);
  if (s.vibration !== undefined) opts.vibration = s.vibration;
  if (s.joySize) opts.joySize = s.joySize;
  if (s.joyRight !== undefined) {
    opts.joyRight = s.joyRight;
    document.body.classList.toggle('joy-right', !!s.joyRight);
  }
  if (s.ctrlAlpha !== undefined) {
    opts.alpha = s.ctrlAlpha;
    document.documentElement.style.setProperty('--ctrl-alpha', String(s.ctrlAlpha));
  }
  if (s.autofire !== undefined) {
    opts.autofire = s.autofire;
    input.autofire = s.autofire;
  }
  const r = JOY_RADIUS[opts.joySize] || 132;
  document.documentElement.style.setProperty('--joy-size', `${r}px`);
}

/** Активна ли кнопка огня с учётом настройки автоогня */
export function wantsFire() {
  return input.fire;
}

/** Вибрация с учётом настроек */
export function buzz(ms) {
  vibrate(ms, opts.vibration);
}
