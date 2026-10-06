// ============================================================
// remotePlayer.js — удалённые игроки: буфер снимков,
// интерполяция с задержкой ~130 мс, экстраполяция, теги над головой
// ============================================================

import * as THREE from 'three';
import { CONFIG, damp, clamp, angleLerp, lerp } from './utils.js';
import { buildCat, buildRifle, animateCat } from './player.js';

const TEAM_COLORS = {
  a: { fur: 0x43a9ff, belly: 0xdff1ff, tag: '#43d9ff' },
  b: { fur: 0xff5a5a, belly: 0xffe3e3, tag: '#ff5a5a' },
  neutral: { fur: 0x9aa3b5, belly: '#eeeeee', tag: '#cfd6e4' }
};

/** Текстовый спрайт-тег над головой */
function makeNameTag(name, color) {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 64;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, 256, 64);
  ctx.font = 'bold 34px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineWidth = 6;
  ctx.strokeStyle = 'rgba(0,0,0,0.85)';
  ctx.strokeText(name, 128, 32);
  ctx.fillStyle = color;
  ctx.fillText(name, 128, 32);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(2.4, 0.6, 1);
  sprite.renderOrder = 999;
  return sprite;
}

/** Полоска HP над головой (спрайт с canvas, обновляется при смене hp) */
function makeHpBar() {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 16;
  const tex = new THREE.CanvasTexture(canvas);
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(1.5, 0.19, 1);
  sprite.renderOrder = 998;
  return { sprite, canvas, tex };
}

export class RemotePlayer {
  constructor({ scene, actorNr, name, team, isBot = false }) {
    this.scene = scene;
    this.actorNr = actorNr;
    this.name = name || `Кот_${actorNr}`;
    this.team = team || 'a';
    this.isBot = isBot;

    // Состояние здоровья (для HUD/анимации)
    this.hp = CONFIG.MAX_HP;
    this.shield = 0;
    this.alive = true;
    this.kills = 0;
    this.deaths = 0;
    this.score = 0;
    /** Активные баффы {ключ: остаток сек} — API совпадает с LocalPlayer */
    this.buffs = {};

    // Визуал
    const col = TEAM_COLORS[this.team] || TEAM_COLORS.neutral;
    this.cat = buildCat({ fur: col.fur, belly: typeof col.belly === 'number' ? col.belly : 0xffffff });
    this.group = this.cat.group;
    this.rifle = buildRifle(0x2f3642);
    this.rifle.scale.setScalar(0.85);
    this.cat.parts.gunMount.add(this.rifle);
    this.cat.rifle = this.rifle;
    this.group.rotation.y = randYaw();
    scene.add(this.group);

    // Теги
    this.tag = makeNameTag(this.name, col.tag);
    this.tag.position.y = 1.75;
    this.group.add(this.tag);
    const hp = makeHpBar();
    this.hpBar = hp;
    hp.sprite.position.y = 1.5;
    this.group.add(hp.sprite);
    this._lastHpDrawn = -1;

    // Снимки для интерполяции
    this.snapshots = [];
    this.renderPos = new THREE.Vector3(0, 1, 0);
    this.renderYaw = 0;
    this.animPhase = 0;
    this.speedSm = 0;
    this.recoil = 0;
    this.aiming = false;
    this._extrapolating = false;
    this._smoothPos = new THREE.Vector3();
    this._smoothInit = false;
  }

  /** Положить снимок состояния (вызывается из netSync) */
  pushState(s) {
    if (!s) return;
    const snap = {
      x: s.x, y: s.y, z: s.z,
      ry: s.ry ?? 0,
      pitch: s.pitch ?? 0,
      hp: s.hp ?? this.hp,
      sh: s.sh ?? 0,
      anim: s.anim ?? 0,
      alive: s.alive !== 0,
      recv: performance.now()
    };
    this.snapshots.push(snap);
    // Держим буфер не длиннее SNAPSHOT_BUFFER
    if (this.snapshots.length > CONFIG.SNAPSHOT_BUFFER) {
      this.snapshots.splice(0, this.snapshots.length - CONFIG.SNAPSHOT_BUFFER);
    }
    // Мгновенно применяем «жёсткие» поля (hp/alive), чтобы HUD не отставал
    if (typeof snap.hp === 'number') this.hp = snap.hp;
    this.shield = snap.sh ?? this.shield;
    if (snap.alive !== this.alive) {
      this.alive = snap.alive;
      this.group.visible = this.alive;
    }
  }

  /**
   * Интерполяция к моменту renderTime = now - INTERP_DELAY.
   * Берём два снимка вокруг целевого времени, lerp/angleLerp;
   * если цель за последним снимком — экстраполируем по последней скорости.
   */
  update(dt) {
    const now = performance.now();
    const target = now - CONFIG.INTERP_DELAY * 1000;
    const snaps = this.snapshots;

    if (snaps.length === 0) {
      // Нет данных — стоим на месте
      this._applyVisual(dt, this.renderPos, this.renderYaw, 0, -0.05);
      return;
    }

    if (snaps.length === 1) {
      const s = snaps[0];
      this.renderPos.set(s.x, s.y, s.z);
      this.renderYaw = s.ry;
      this._applyVisual(dt, this.renderPos, this.renderYaw, s.anim, s.pitch);
      return;
    }

    let a = snaps[0], b = snaps[snaps.length - 1];

    // Ищем пару снимков, окружающих target
    for (let i = 0; i < snaps.length - 1; i++) {
      if (snaps[i].recv <= target && snaps[i + 1].recv >= target) {
        a = snaps[i];
        b = snaps[i + 1];
        break;
      }
      // Если target раньше всех — берём первые два
      if (target < snaps[0].recv) { a = snaps[0]; b = snaps[1]; break; }
      // Если target позже всех — экстраполируем
      if (i === snaps.length - 2 && target > snaps[i + 1].recv) {
        a = snaps[i];
        b = snaps[i + 1];
        this._extrapolating = true;
      }
    }

    const span = b.recv - a.recv;
    let t = span > 0 ? clamp((target - a.recv) / span, 0, 1) : 1;

    const px = lerp(a.x, b.x, t);
    const py = lerp(a.y, b.y, t);
    const pz = lerp(a.z, b.z, t);
    const yaw = angleLerp(a.ry, b.ry, t);
    const pitch = lerp(a.pitch, b.pitch, t);
    const anim = b.anim;

    let targetPos = new THREE.Vector3(px, py, pz);

    // Экстраполяция по последней скорости (макс. 250 мс вперёд)
    if (target > b.recv) {
      const over = Math.min((target - b.recv) / 1000, 0.25);
      const vx = (b.x - a.x) / Math.max(span / 1000, 0.001);
      const vy = (b.y - a.y) / Math.max(span / 1000, 0.001);
      const vz = (b.z - a.z) / Math.max(span / 1000, 0.001);
      targetPos.x += vx * over;
      targetPos.y += vy * over;
      targetPos.z += vz * over;
      this._extrapolating = true;
    } else {
      this._extrapolating = false;
    }

    // Мягкое сглаживание (скрывает рывки при потере пакетов)
    if (!this._smoothInit) {
      this._smoothPos.copy(targetPos);
      this._smoothInit = true;
    } else {
      // При большом расхождении — быстрый snap, иначе — плавный lerp
      const dist = this._smoothPos.distanceTo(targetPos);
      const k = dist > 4 ? 1 : clamp(18 * dt, 0, 1);
      this._smoothPos.lerp(targetPos, k);
    }

    this.renderYaw = yaw;
    // Скорость для анимации
    const instSpeed = span > 0
      ? Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z) / (span / 1000)
      : 0;
    this.speedSm = damp(this.speedSm, clamp(instSpeed, 0, 16), 8, dt);
    this.animPhase += dt * (4 + clamp(this.speedSm / CONFIG.RUN_SPEED, 0, 1) * 9);

    this._applyVisual(dt, this._smoothPos, yaw, anim, pitch, a.recv === b.recv);
  }

  _applyVisual(dt, pos, yaw, animState, pitch) {
    this.group.position.copy(pos);
    this.group.rotation.y = yaw;

    const moving = animState > 0;
    const aiming = animState === 1 && false; // аним 1 = бег, 2 = быстрый бег
    this.aiming = aiming;

    animateCat(this.cat, dt, {
      phase: this.animPhase,
      speed: this.speedSm,
      moving,
      grounded: true,
      aiming,
      headYaw: 0,
      headPitch: clamp(pitch ?? 0, -0.6, 0.6),
      recoil: this.recoil
    });

    if (this.recoil > 0) this.recoil = Math.max(0, this.recoil - dt * 6);
    this.rifle.rotation.x = -this.recoil * 2.2;
    this.cat.parts.gunMount.rotation.x = damp(
      this.cat.parts.gunMount.rotation.x,
      aiming ? -(pitch ?? 0) * 0.5 : 0, 10, dt
    );

    // Обновляем полоску HP только при изменении
    const hpInt = Math.round(this.hp);
    if (hpInt !== this._lastHpDrawn) {
      this._lastHpDrawn = hpInt;
      this._drawHp(hpInt);
    }
    this.hpBar.sprite.visible = hpInt < CONFIG.MAX_HP && this.alive;
    this.tag.visible = this.alive;
  }

  _drawHp(hp) {
    const { canvas, tex } = this.hpBar;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, 128, 16);
    ctx.fillStyle = 'rgba(0,0,0,0.7)';
    ctx.fillRect(0, 0, 128, 16);
    const pct = clamp(hp / CONFIG.MAX_HP, 0, 1);
    ctx.fillStyle = pct > 0.5 ? '#5eff8a' : pct > 0.25 ? '#ffd54a' : '#ff4d5e';
    ctx.fillRect(2, 2, 124 * pct, 12);
    tex.needsUpdate = true;
  }

  /** Мгновенный показ выстрела (вызывается при событии SHOOT) */
  flashShot() {
    this.recoil = 0.28;
  }

  /** Точка выстрела удалённого игрока (для трассера) */
  muzzlePosition() {
    const p = this.group.position;
    return new THREE.Vector3(p.x, p.y + 0.75, p.z).add(
      new THREE.Vector3(Math.sin(this.renderYaw), 0, Math.cos(this.renderYaw)).multiplyScalar(0.9)
    );
  }

  setTeam(team) {
    this.team = team;
    const col = TEAM_COLORS[team] || TEAM_COLORS.neutral;
    this.cat.materials.furMat.color.setHex(col.fur);
    // Перерисовать тег
    this.group.remove(this.tag);
    this.tag.material.map.dispose();
    this.tag = makeNameTag(this.name, col.tag);
    this.tag.position.y = 1.75;
    this.group.add(this.tag);
  }

  die() {
    this.alive = false;
    this.group.visible = false;
    this.deaths++;
  }

  respawnAt(x, y, z) {
    this.alive = true;
    this.hp = CONFIG.MAX_HP;
    this.group.visible = true;
    this.snapshots.length = 0;
    this._smoothInit = false;
    this.renderPos.set(x, y, z);
    this.group.position.set(x, y, z);
  }

  dispose() {
    this.scene.remove(this.group);
    this.group.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) {
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        mats.forEach((m) => { if (m.map) m.map.dispose(); m.dispose(); });
      }
    });
  }
}

function randYaw() { return Math.random() * Math.PI * 2; }

// ------------------------------------------------------------
// Менеджер удалённых игроков
// ------------------------------------------------------------

export class RemotePlayers {
  constructor(scene) {
    this.scene = scene;
    this.map = new Map(); // actorNr -> RemotePlayer
  }

  spawn({ actorNr, name, team, isBot }) {
    if (this.map.has(actorNr)) return this.map.get(actorNr);
    const rp = new RemotePlayer({ scene: this.scene, actorNr, name, team, isBot });
    this.map.set(actorNr, rp);
    console.log(`[Net] спавн удалённого игрока #${actorNr} "${name}" команда=${team}`);
    return rp;
  }

  get(actorNr) { return this.map.get(actorNr) || null; }

  remove(actorNr) {
    const rp = this.map.get(actorNr);
    if (rp) {
      rp.dispose();
      this.map.delete(actorNr);
      console.log(`[Net] удалён игрок #${actorNr}`);
    }
  }

  /** Все позиции врагов для выбора точки спавна */
  positions(team) {
    const out = [];
    for (const rp of this.map.values()) {
      if (rp.alive && rp.team !== team) out.push(rp.group.position.clone());
    }
    return out;
  }

  update(dt) {
    for (const rp of this.map.values()) rp.update(dt);
  }

  clear() {
    for (const rp of this.map.values()) rp.dispose();
    this.map.clear();
  }
}
