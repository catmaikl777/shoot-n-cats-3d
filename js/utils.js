// ============================================================
// utils.js — общие утилиты: математика, объекты, события, кэш
// ============================================================

/** Линейная интерполяция */
export const lerp = (a, b, t) => a + (b - a) * t;

/** Ограничение значения диапазоном */
export const clamp = (v, min, max) => (v < min ? min : v > max ? max : v);

/** Плавное (экспоненциальное) сглаживание, независимое от FPS */
export const damp = (a, b, lambda, dt) => lerp(a, b, 1 - Math.exp(-lambda * dt));

/** Кратчайший путь угла (радианы) — чтобы интерполяция не «плыла» через 2π */
export function angleLerp(a, b, t) {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

export function angleDamp(a, b, lambda, dt) {
  return angleLerp(a, b, 1 - Math.exp(-lambda * dt));
}

/** Случайное число в диапазоне */
export const rand = (min, max) => min + Math.random() * (max - min);

/** Случайное целое в диапазоне [min, max] */
export const randInt = (min, max) => Math.floor(rand(min, max + 1));

/** Выбрать случайный элемент массива */
export const pick = (arr) => arr[(Math.random() * arr.length) | 0];

/** Форматирование времени матчей: 300 -> "05:00" */
export function formatTime(sec) {
  sec = Math.max(0, Math.floor(sec));
  const m = (sec / 60) | 0;
  const s = sec % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/** Безопасное получение элемента по id */
export const $ = (id) => document.getElementById(id);

/** Создание DOM-элемента из хтмл-строки */
export function el(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

/** Эвристическое определение браузера iOS (даже если маскируется) */
export const isIOS = () =>
  /iP(hone|ad|od)/.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

/** Эвристика: тач-устройство */
export const isTouchDevice = () =>
  'ontouchstart' in window || navigator.maxTouchPoints > 0;

/** Вибрация (Vibration API) — безопасно вызывать всегда */
export function vibrate(ms, enabled = true) {
  if (!enabled) return;
  try {
    if (navigator.vibrate && typeof ms === 'number') navigator.vibrate(ms);
  } catch (_) { /* iOS не поддерживает — игнорируем */ }
}

/** Дебаунс */
export function debounce(fn, wait = 120) {
  let t = 0;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), wait);
  };
}

/** Ограничитель частоты вызовов (throttle) по времени */
export function throttle(fn, interval = 100) {
  let last = 0;
  return (...args) => {
    const now = performance.now();
    if (now - last >= interval) {
      last = now;
      fn(...args);
    }
  };
}

/** Простой эмиттер событий */
export class Emitter {
  constructor() { this._map = new Map(); }
  on(evt, fn) {
    if (!this._map.has(evt)) this._map.set(evt, new Set());
    this._map.get(evt).add(fn);
    return () => this.off(evt, fn);
  }
  off(evt, fn) { this._map.get(evt)?.delete(fn); }
  emit(evt, ...args) {
    const set = this._map.get(evt);
    if (!set) return;
    for (const fn of [...set]) {
      try { fn(...args); } catch (e) { console.error('[Emitter]', evt, e); }
    }
  }
}

/** Хранилище настроек в localStorage с дефолтами */
export class Settings {
  constructor(key = 'snc3d_settings') {
    this.key = key;
    this.data = {
      nick: '',
      sens: 1.0,
      invY: false,
      quality: 'auto',
      vibration: true,
      joySize: 'medium',
      joyRight: false,
      autofire: true,
      ctrlAlpha: 0.45,
      minimap: true,
      tutorialDone: false,
      lastMode: 'team'
    };
    this.load();
  }
  load() {
    try {
      const raw = localStorage.getItem(this.key);
      if (raw) Object.assign(this.data, JSON.parse(raw));
    } catch (_) { /* повреждённый кэш — используем дефолты */ }
  }
  save() {
    try { localStorage.setItem(this.key, JSON.stringify(this.data)); } catch (_) {}
  }
  get(k) { return this.data[k]; }
  set(k, v) {
    this.data[k] = v;
    this.save();
  }
}

/** Глобальные константы игры */
export const CONFIG = {
  // Физика/геймплей
  GRAVITY: -22,
  WALK_SPEED: 6.2,
  RUN_SPEED: 8.4,
  SPRINT_MULT: 1.35,
  JUMP_VEL: 8.2,
  DASH_SPEED: 26,
  DASH_TIME: 0.28,
  DASH_COOLDOWN: 3.0,
  PLAYER_HEIGHT: 1.55,
  PLAYER_RADIUS: 0.42,

  // Оружие
  MAG_SIZE: 30,
  RESERVE_AMMO: 150,
  FIRE_INTERVAL: 0.11,
  RELOAD_TIME: 1.7,
  DAMAGE: 12,
  HEADSHOT_MULT: 2.0,
  SPREAD_BASE: 0.012,
  SPREAD_MOVE: 0.03,
  BULLET_RANGE: 140,

  // Гранаты
  NADE_COUNT: 3,
  NADE_RADIUS: 5.5,
  NADE_DAMAGE_MAX: 75,
  NADE_FUSE: 2.4,
  NADE_COOLDOWN: 1.0,

  // Рывок/жизни
  MAX_HP: 100,
  RESPAWN_TIME: 3.0,
  SHIELD_MAX: 50,

  // Сеть
  NET_SEND_RATE: 1 / 30,   // 30 Гц состояний
  INTERP_DELAY: 0.13,      // 130 мс задержка интерполяции
  SNAPSHOT_BUFFER: 6,

  // Режимы
  MATCH_TIME: 300,         // 5 минут
  KING_SCORE: 200,
  DELIVERY_TARGET: 5,

  // Карта
  MAP_SIZE: 200
};

/** Коды сетевых событий Photon */
export const EV = {
  STATE: 1,      // движение/состояние (unreliable)
  SHOOT: 2,      // выстрел (reliable)
  NADE: 3,       // граната (reliable)
  DEATH: 4,      // смерть (reliable)
  POWERUP: 5,    // подбор бонуса (reliable)
  MODE: 6,       // обновление режима/счёта (reliable)
  HIT: 7,        // подтверждение попадания (reliable)
  TAUNT: 8,      // мяуканье (reliable)
  CHAT: 9        // текстовый чат (reliable)
};
