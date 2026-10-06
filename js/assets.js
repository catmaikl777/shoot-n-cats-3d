// ============================================================
// assets.js — автозагрузчик ассетов: прямые CC0-URL,
// кэш в IndexedDB, прогресс, процедурные фолбэки
// ============================================================

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js';

const DB_NAME = 'snc3d-cache';
const DB_STORE = 'files';
const MAX_PARALLEL = 4;

/** Открытие IndexedDB (идемпотентно) */
function openDB() {
  return new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) return reject(new Error('IndexedDB недоступен'));
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(DB_STORE)) db.createObjectStore(DB_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Прочитать Blob из кэша. null если нет. */
async function idbGet(url) {
  try {
    const db = await openDB();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(DB_STORE, 'readonly');
      const r = tx.objectStore(DB_STORE).get(url);
      r.onsuccess = () => resolve(r.result || null);
      r.onerror = () => reject(r.error);
    });
  } catch (_) {
    return null;
  }
}

/** Положить Blob в кэш (ошибки молча игнорируем) */
async function idbPut(url, blob) {
  try {
    const db = await openDB();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(DB_STORE, 'readwrite');
      tx.objectStore(DB_STORE).put(blob, url);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (_) { /* кэш не критичен */ }
}

// ------------------------------------------------------------
// Процедурные текстуры-заглушки (canvas) — если сеть недоступна
// ------------------------------------------------------------

function makeCanvas(size = 256) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  return c;
}

/** Базовый шум по точкам */
function noiseFill(ctx, size, base, variance, block = 1) {
  const img = ctx.createImageData(size, size);
  const d = img.data;
  for (let y = 0; y < size; y += block) {
    for (let x = 0; x < size; x += block) {
      const n = base + (Math.random() * 2 - 1) * variance;
      const r = Math.max(0, Math.min(255, n));
      const g = Math.max(0, Math.min(255, n));
      const b = Math.max(0, Math.min(255, n));
      for (let yy = 0; yy < block && y + yy < size; yy++) {
        for (let xx = 0; xx < block && x + xx < size; xx++) {
          const i = ((y + yy) * size + (x + xx)) * 4;
          d[i] = r; d[i + 1] = g; d[i + 2] = b; d[i + 3] = 255;
        }
      }
    }
  }
  ctx.putImageData(img, 0, 0);
}

/** Наложить линии сетки (для кафеля, асфальта, бетона) */
function gridLines(ctx, size, step, color, width = 1) {
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  for (let i = 0; i <= size; i += step) {
    ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i, size); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, i); ctx.lineTo(size, i); ctx.stroke();
  }
}

const PROCEDURAL = {
  // Серый асфальт с потёртостями
  tex_asphalt(ctx, S) {
    noiseFill(ctx, S, 62, 26, 2);
    ctx.globalAlpha = 0.25;
    for (let i = 0; i < 60; i++) {
      ctx.fillStyle = Math.random() > 0.5 ? '#3c3c3c' : '#7a7a7a';
      ctx.fillRect(Math.random() * S, Math.random() * S, Math.random() * 40, Math.random() * 40);
    }
    ctx.globalAlpha = 1;
  },
  // Бетон со швами
  tex_concrete(ctx, S) {
    noiseFill(ctx, S, 150, 18, 3);
    gridLines(ctx, S, S / 4, 'rgba(80,80,80,.55)', 2);
    ctx.globalAlpha = 0.2;
    for (let i = 0; i < 30; i++) {
      ctx.fillStyle = '#9a9a9a';
      ctx.beginPath();
      ctx.arc(Math.random() * S, Math.random() * S, Math.random() * 26, 0, 7);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  },
  // Трава
  tex_grass(ctx, S) {
    noiseFill(ctx, S, 96, 34, 2);
    ctx.globalAlpha = 0.5;
    for (let i = 0; i < 1400; i++) {
      const x = Math.random() * S, y = Math.random() * S;
      ctx.strokeStyle = Math.random() > 0.5 ? '#4d7a2e' : '#7fae4a';
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + (Math.random() * 6 - 3), y - 3 - Math.random() * 6);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  },
  // Камень
  tex_rock(ctx, S) {
    noiseFill(ctx, S, 118, 40, 4);
    ctx.globalAlpha = 0.35;
    ctx.strokeStyle = '#4a4a4a';
    for (let i = 0; i < 26; i++) {
      ctx.lineWidth = 1 + Math.random() * 3;
      ctx.beginPath();
      let x = Math.random() * S, y = Math.random() * S;
      ctx.moveTo(x, y);
      for (let k = 0; k < 5; k++) {
        x += Math.random() * 60 - 30; y += Math.random() * 60 - 30;
        ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  },
  // Рифлёный металл
  tex_metal(ctx, S) {
    noiseFill(ctx, S, 132, 14, 2);
    ctx.globalAlpha = 0.4;
    gridLines(ctx, S, S / 8, 'rgba(60,60,70,.8)', 3);
    ctx.globalAlpha = 0.2;
    for (let i = 0; i < 8; i++) {
      ctx.fillStyle = i % 2 ? '#8a5a3a' : '#5a6a7a';
      ctx.fillRect(0, (i * S) / 8, S, S / 8);
    }
    ctx.globalAlpha = 1;
  },
  // Дерево
  tex_wood(ctx, S) {
    noiseFill(ctx, S, 130, 22, 2);
    ctx.globalAlpha = 0.5;
    for (let i = 0; i < 40; i++) {
      ctx.strokeStyle = i % 2 ? '#7a5630' : '#9c7444';
      ctx.lineWidth = 1 + Math.random() * 3;
      ctx.beginPath();
      const y = Math.random() * S;
      ctx.moveTo(0, y);
      for (let x = 0; x <= S; x += 16) ctx.lineTo(x, y + Math.sin(x * 0.06) * 6);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  },
  // Кора
  tex_bark(ctx, S) {
    noiseFill(ctx, S, 92, 30, 2);
    ctx.globalAlpha = 0.55;
    for (let i = 0; i < 60; i++) {
      ctx.strokeStyle = '#4b3a26';
      ctx.lineWidth = 1 + Math.random() * 4;
      const x = Math.random() * S;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      for (let y = 0; y <= S; y += 20) ctx.lineTo(x + Math.sin(y * 0.1) * 5, y);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  },
  // Крашеная стена
  tex_paint(ctx, S) {
    noiseFill(ctx, S, 168, 24, 3);
    ctx.globalAlpha = 0.3;
    for (let i = 0; i < 50; i++) {
      ctx.fillStyle = ['#c86a4a', '#4a7ac8', '#c8b44a', '#68c87a'][(Math.random() * 4) | 0];
      ctx.fillRect(Math.random() * S, Math.random() * S, 20 + Math.random() * 70, 14 + Math.random() * 40);
    }
    ctx.globalAlpha = 1;
  }
};

/** Создать процедурную текстуру по ключу ассета */
function proceduralTexture(key) {
  const S = 256;
  const c = makeCanvas(S);
  const ctx = c.getContext('2d');
  (PROCEDURAL[key] || PROCEDURAL.tex_concrete)(ctx, S);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

// ------------------------------------------------------------
// Менеджер ассетов
// ------------------------------------------------------------

class Assets {
  constructor() {
    this.manifest = null;
    this.cache = new Map();   // key -> THREE.Texture | THREE.Group | null
    this.loaded = 0;
    this.total = 0;
    this.failed = [];
    this._draco = null;
  }

  /** Скачать manifest и загрузить всё. onProgress(done, total, key) */
  async loadAll(onProgress = () => {}) {
    const res = await fetch(new URL('./assets_manifest.json', import.meta.url));
    if (!res.ok) throw new Error(`assets_manifest.json: HTTP ${res.status}`);
    this.manifest = await res.json();

    // Берём только записи с непустым URL (пустой url = «модель добавит сам пользователь»)
    const entries = Object.entries(this.manifest.assets).filter(
      ([, a]) => a && typeof a.url === 'string' && a.url.length > 0
    );
    this.total = entries.length;
    this.loaded = 0;

    // Пул на MAX_PARALLEL параллельных загрузок
    let idx = 0;
    const worker = async () => {
      while (idx < entries.length) {
        const [key, def] = entries[idx++];
        try {
          const val = await this._loadOne(key, def);
          this.cache.set(key, val);
        } catch (err) {
          console.warn(`[Assets] не удалось загрузить "${key}":`, err.message);
          this.failed.push(key);
          this.cache.set(key, def.fallback === 'procedural' ? proceduralTexture(key) : null);
        }
        this.loaded++;
        onProgress(this.loaded, this.total, key);
      }
    };
    await Promise.all(Array.from({ length: MAX_PARALLEL }, worker));
    return this;
  }

  async _loadOne(key, def) {
    const bytes = await this._fetchBytes(def.url);
    switch (def.type) {
      case 'texture':  return this._makeTexture(bytes, def);
      case 'hdri':     return this._makeHDRI(bytes);
      case 'model':    return this._makeModel(bytes);
      default:         return bytes;
    }
  }

  /** Получить байты: IndexedDB → сеть (с сохранением в IDB) */
  async _fetchBytes(url) {
    const cached = await idbGet(url);
    if (cached) {
      const buf = await cached.arrayBuffer();
      if (buf.byteLength > 0) return buf;
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 25000);
    try {
      const res = await fetch(url, { signal: ctrl.signal, mode: 'cors' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const buf = await blob.arrayBuffer();
      await idbPut(url, blob);
      return buf;
    } finally {
      clearTimeout(timer);
    }
  }

  _makeTexture(bytes, def) {
    const url = URL.createObjectURL(new Blob([bytes], { type: 'image/jpeg' }));
    return new Promise((resolve, reject) => {
      new THREE.TextureLoader().load(
        url,
        (tex) => {
          URL.revokeObjectURL(url);
          tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
          tex.colorSpace = THREE.SRGBColorSpace;
          tex.anisotropy = 8;
          if (def.repeat) tex.repeat.set(def.repeat[0], def.repeat[1]);
          resolve(tex);
        },
        undefined,
        (e) => { URL.revokeObjectURL(url); reject(e); }
      );
    });
  }

  _makeHDRI(bytes) {
    const url = URL.createObjectURL(new Blob([bytes], { type: 'image/vnd.radiance' }));
    return new Promise((resolve, reject) => {
      new RGBELoader().load(
        url,
        (hdr) => {
          URL.revokeObjectURL(url);
          hdr.mapping = THREE.EquirectangularReflectionMapping;
          resolve(hdr);
        },
        undefined,
        (e) => { URL.revokeObjectURL(url); reject(e); }
      );
    });
  }

  _makeModel(bytes) {
    const url = URL.createObjectURL(new Blob([bytes], { type: 'model/gltf-binary' }));
    const loader = new GLTFLoader();
    // Draco-декодер с CDN Google — нужен только для сжатых GLB
    if (!this._draco) {
      this._draco = new DRACOLoader();
      this._draco.setDecoderPath('https://www.gstatic.com/draco/versioned/decoders/1.5.7/');
    }
    loader.setDRACOLoader(this._draco);
    return loader.loadAsync(url).then((gltf) => {
      URL.revokeObjectURL(url);
      return gltf;
    }).catch((e) => { URL.revokeObjectURL(url); throw e; });
  }

  /** Достать ассет по ключу (или null) */
  get(key) {
    return this.cache.has(key) ? this.cache.get(key) : null;
  }

  /** Текстура с заданным repeat (клон — не мутировать оригинал) */
  tex(key, repeatX = 1, repeatY = 1) {
    const base = this.get(key);
    if (!base || !base.isTexture) return proceduralTexture(key);
    const t = base.clone();
    t.needsUpdate = true;
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(repeatX, repeatY);
    return t;
  }

  /** Убрать кэш (диагностика) */
  async clearCache() {
    try {
      const db = await openDB();
      await new Promise((res, rej) => {
        const tx = db.transaction(DB_STORE, 'readwrite');
        tx.objectStore(DB_STORE).clear();
        tx.oncomplete = res; tx.onerror = rej;
      });
    } catch (_) {}
  }
}

export const assets = new Assets();
export { proceduralTexture };
