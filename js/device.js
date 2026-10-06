// ============================================================
// device.js — определение устройства, DPR, ориентации, качества
// ============================================================

import { isTouchDevice, isIOS, clamp } from './utils.js';

/**
 * Класс Device — единый источник правды о возможностях устройства.
 * Слушает resize / orientationchange / devicePixelRatio,
 * пересчитывает размер рендера и уровень качества.
 */
class Device {
  constructor() {
    /** true, если основной ввод — тач (телефон/планшет) */
    this.isTouch = isTouchDevice();
    this.isIOS = isIOS();

    /** Уровень качества по умолчанию — определяем по железу */
    this.tier = this._detectTier();

    /** Ограничение DPR (по ТЗ: максимум 2) */
    this.maxDPR = this.tier === 'low' ? 1.25 : 2;

    /** Текущая ориентация */
    this.orientation = window.matchMedia('(orientation: portrait)').matches
      ? 'portrait'
      : 'landscape';

    /** Размеры окна (CSS-пиксели) */
    this.width = window.innerWidth;
    this.height = window.innerHeight;
    this.dpr = this._computeDPR();

    /** Флаг: можно ли показывать тач-контролы */
    this.showTouch = this.isTouch;

    /** Поддержка продвинутых API */
    this.hasVibration = 'vibrate' in navigator;
    this.hasGamepad = 'getGamepads' in navigator;
    this.webgl2 = this._hasWebGL2();

    this._listeners = [];
    this._bind();
  }

  // ---------- Определение уровня качества ----------
  _detectTier() {
    const cores = navigator.hardwareConcurrency || 4;
    const mem = navigator.deviceMemory || 4; // ГБ (Chrome)
    const ua = navigator.userAgent;

    // Дешёвые Android-определения
    const lowAndroid = /Android/.test(ua) && /; wv\)/.test(ua) === false && cores <= 4 && mem <= 3;
    const oldIOS = /iPhone|iPad/.test(ua) && /OS 1[0-5]_/.test(ua);

    if (oldIOS || lowAndroid || cores <= 3 || mem <= 2) return 'low';
    if (cores >= 8 && mem >= 6) return 'high';
    return 'medium';
  }

  _computeDPR() {
    const raw = window.devicePixelRatio || 1;
    return clamp(raw, 1, this.maxDPR);
  }

  _hasWebGL2() {
    try {
      const c = document.createElement('canvas');
      return !!c.getContext('webgl2');
    } catch (_) {
      return false;
    }
  }

  // ---------- Слушатели ----------
  _bind() {
    const onResize = () => {
      this.width = window.innerWidth;
      this.height = window.innerHeight;
      this.dpr = this._computeDPR();
      const o = window.matchMedia('(orientation: portrait)').matches
        ? 'portrait' : 'landscape';
      const changed = o !== this.orientation;
      this.orientation = o;
      this._fire(changed ? 'orientation' : 'resize');
      this._fire('resize');
    };

    window.addEventListener('resize', onResize);
    window.addEventListener('orientationchange', () => {
      // Safari обновляет размеры с задержкой
      setTimeout(onResize, 250);
      setTimeout(onResize, 700);
    });
    // Пользователь может поменять масштаб в настройках ОС
    window.addEventListener('pagehide', () => {});
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', onResize);
    }
  }

  _fire(type) {
    for (const fn of this._listeners) {
      try { fn(type); } catch (e) { console.error('[Device]', e); }
    }
  }

  /** Подписка на изменение размеров/ориентации. Возвращает unsubscribe. */
  onChange(fn) {
    this._listeners.push(fn);
    return () => {
      const i = this._listeners.indexOf(fn);
      if (i >= 0) this._listeners.splice(i, 1);
    };
  }

  /** Обновить ограничение DPR (вызывается при смене качества) */
  setMaxDPR(v) {
    this.maxDPR = clamp(v, 0.75, 3);
    const d = this._computeDPR();
    if (Math.abs(d - this.dpr) > 0.01) {
      this.dpr = d;
      this._fire('resize');
    }
  }

  /** Параметры качества для рендера */
  qualityParams(level) {
    switch (level) {
      case 'low':
        return {
          dpr: 1,
          shadows: false,
          shadowMapSize: 512,
          ssao: false,
          bloom: false,
          aa: 'none',
          antialias: false,
          lightCount: 2,
          viewDistance: 140
        };
      case 'high':
        return {
          dpr: 2,
          shadows: true,
          shadowMapSize: 2048,
          ssao: false,   // SSAO выключено даже на high — слишком дорого на мобилках
          bloom: true,
          aa: 'fxaa',
          antialias: true,
          lightCount: 4,
          viewDistance: 260
        };
      default: // medium
        return {
          dpr: 1.5,
          shadows: true,
          shadowMapSize: 1024,
          ssao: false,
          bloom: false,
          aa: 'fxaa',
          antialias: false,
          lightCount: 3,
          viewDistance: 200
        };
    }
  }

  /** Строка для логов */
  info() {
    return [
      `touch=${this.isTouch}`,
      `ios=${this.isIOS}`,
      `tier=${this.tier}`,
      `dpr=${this.dpr}`,
      `webgl2=${this.webgl2}`,
      `mem=${navigator.deviceMemory || '?'}GB`,
      `cores=${navigator.hardwareConcurrency || '?'}`
    ].join(' ');
  }
}

export const device = new Device();
