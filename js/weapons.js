// ============================================================
// weapons.js — стрельба (hitscan), разброс, хедшоты,
// трассеры, вспышки, обмен событиями с Photon
// ============================================================

import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { CONFIG, clamp, rand, EV } from './utils.js';

const _origin = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _hit = new THREE.Vector3();

/** Пересечение луча с вертикальной капсулой (игрок). Дистанция или Infinity */
export function rayCapsule(origin, dir, base, height, radius) {
  // Капсула: от base до base+(0,height,0)
  const p0 = base;
  const p1 = { x: base.x, y: base.y + height, z: base.z };
  // Алгоритм из Ericson "Real-Time Collision Detection" (ray vs capsule)
  const ba = { x: p1.x - p0.x, y: p1.y - p0.y, z: p1.z - p0.z };
  const oa = { x: origin.x - p0.x, y: origin.y - p0.y, z: origin.z - p0.z };
  const baba = ba.x * ba.x + ba.y * ba.y + ba.z * ba.z;
  const bard = ba.x * dir.x + ba.y * dir.y + ba.z * dir.z;
  const baoa = ba.x * oa.x + ba.y * oa.y + ba.z * oa.z;
  const rdoa = dir.x * oa.x + dir.y * oa.y + dir.z * oa.z;
  const oaoa = oa.x * oa.x + oa.y * oa.y + oa.z * oa.z;

  let A = baba - bard * bard;
  let B = baba * rdoa - baoa * bard;
  let C = baba * oaoa - baoa * baoa - radius * radius * baba;
  const h = B * B - A * C;
  if (h >= 0) {
    const t = (-B - Math.sqrt(h)) / A;
    const y = baoa + t * bard;
    if (y > 0 && y < baba && t >= 0) return t;
    // Проверяем окружности на концах
    const oc = y <= 0 ? oa : { x: origin.x - p1.x, y: origin.y - p1.y, z: origin.z - p1.z };
    const dd = dir.x * oc.x + dir.y * oc.y + dir.z * oc.z;
    const oo = oc.x * oc.x + oc.y * oc.y + oc.z * oc.z;
    const B2 = dd, C2 = oo - radius * radius;
    const h2 = B2 * B2 - C2;
    if (h2 > 0) {
      const t2 = -B2 - Math.sqrt(h2);
      if (t2 >= 0) return t2;
    }
  }
  return Infinity;
}

export class Weapons {
  /**
   * @param {object} o { scene, world, map, audio, net }
   *   net.raise(code, data, reliable) — отправка события
   */
  constructor({ scene, world, map, audio, net }) {
    this.scene = scene;
    this.world = world;
    this.map = map;
    this.audio = audio;
    this.net = net;

    /** Локальный игрок (устанавливается в main) */
    this.local = null;
    /** Менеджер удалённых игроков */
    this.remotes = null;

    // Пул трассеров
    this.tracers = [];
    this._tracerGeo = new THREE.BufferGeometry();
    this._tracerMat = new THREE.LineBasicMaterial({
      color: 0xffe08a, transparent: true, opacity: 0.9, depthWrite: false
    });

    // Вспышка выстрела (общий свет)
    this.flashLight = new THREE.PointLight(0xffcc77, 0, 14, 2);
    this.flashLight.position.set(0, 2, 0);
    scene.add(this.flashLight);
    this._flashT = 0;

    // Импакты (следы попаданий)
    this.impacts = [];
    this._impactGeo = new THREE.SphereGeometry(0.07, 6, 5);
    this._impactMat = new THREE.MeshBasicMaterial({ color: 0xfff2c0 });
  }

  /**
   * Выстрел локального игрока.
   * Возвращает {hit, point, target} или null (нет патронов/кулдаун).
   */
  fire(shooter) {
    if (shooter.fireCd > 0 || shooter.reloading || shooter.mag <= 0) return null;
    if (!shooter.consumeAmmo()) return null;

    shooter.fireCd = CONFIG.FIRE_INTERVAL;
    shooter.flashMuzzle();

    // Направление от камеры через центр экрана + разброс
    const cam = this._camera;
    cam.getWorldPosition(_origin);
    cam.getWorldDirection(_dir);

    const spread = CONFIG.SPREAD_BASE +
      (shooter.speedSm > 1 ? CONFIG.SPREAD_MOVE : 0) +
      shooter.recoil * 0.05 -
      (shooter.aiming ? 0.008 : 0);
    const s = Math.max(spread, 0.001);
    _dir.x += rand(-s, s);
    _dir.y += rand(-s, s);
    _dir.z += rand(-s, s);
    _dir.normalize();

    const result = this._raycastAll(_origin, _dir, shooter);
    this._spawnTracer(result.start, result.point, 0xffe08a);
    this._muzzleFlash(shooter.eyePosition());
    this.audio?.play('shoot');
    if (typeof navigator !== 'undefined' && navigator.vibrate) {
      // вибрация управляется из touchControls через settings
    }

    // Сетевое событие: где стреляли и куда попали
    this.net?.raise(EV.SHOOT, {
      ox: +result.start.x.toFixed(2),
      oy: +result.start.y.toFixed(2),
      oz: +result.start.z.toFixed(2),
      px: +result.point.x.toFixed(2),
      py: +result.point.y.toFixed(2),
      pz: +result.point.z.toFixed(2)
    }, true);

    if (result.target) {
      // Урон цели
      const dmg = CONFIG.DAMAGE * (shooter.buffs.ricochet ? 1.1 : 1);
      this._applyDamage(result.target, dmg, result.headshot, shooter);
    }
    return result;
  }

  /**
   * Полный рейкаст: статика мира (Rapier) + капсулы удалённых игроков.
   * @returns {{start, point, target, headshot, distance}}
   */
  _raycastAll(origin, dir, shooter) {
    // 1. Геометрия карты
    let worldDist = CONFIG.BULLET_RANGE;
    const ray = new RAPIER.Ray(
      { x: origin.x, y: origin.y, z: origin.z },
      { x: dir.x, y: dir.y, z: dir.z }
    );
    const hit = this.world.castRay(ray, CONFIG.BULLET_RANGE, true);
    if (hit) {
      worldDist = hit.timeOfImpact ?? hit.toi ?? CONFIG.BULLET_RANGE;
    }

    // 2. Игроки
    let bestDist = worldDist;
    let target = null;
    let headshot = false;

    if (this.remotes) {
      for (const rp of this.remotes.map.values()) {
        if (!rp.alive) continue;
        if (shooter && rp.team === shooter.team && rp !== shooter) continue; // тимкитов нет
        const base = { x: rp.group.position.x, y: rp.group.position.y, z: rp.group.position.z };
        const bodyT = rayCapsule(origin, dir, base, 1.1, 0.45);
        // Голова — отдельная сфера для хедшота
        const headT = this._rayHead(origin, dir, base);
        const t = Math.min(bodyT, headT);
        if (t < bestDist) {
          bestDist = t;
          target = rp;
          headshot = headT <= bodyT;
        }
      }
    }

    const point = new THREE.Vector3(
      origin.x + dir.x * bestDist,
      origin.y + dir.y * bestDist,
      origin.z + dir.z * bestDist
    );
    if (bestDist >= CONFIG.BULLET_RANGE - 0.01) {
      // Не во что попали — точка на максимальной дальности
      point.copy(origin).addScaledVector(dir, CONFIG.BULLET_RANGE);
    } else if (target) {
      this._spawnImpact(point, headshot);
    } else {
      this._spawnImpact(point, false);
    }

    return { start: origin.clone(), point, target, headshot, distance: bestDist };
  }

  _rayHead(origin, dir, base) {
    // Сфера радиуса 0.26 на высоте 1.25 от основания капсулы
    const c = { x: base.x, y: base.y + 1.28, z: base.z };
    const oc = { x: origin.x - c.x, y: origin.y - c.y, z: origin.z - c.z };
    const b = oc.x * dir.x + oc.y * dir.y + oc.z * dir.z;
    const cc = oc.x * oc.x + oc.y * oc.y + oc.z * oc.z - 0.26 * 0.26;
    const h = b * b - cc;
    if (h < 0) return Infinity;
    const t = -b - Math.sqrt(h);
    return t >= 0 ? t : Infinity;
  }

  /** Нанести урон удалённому игроку (клиент-авторитетный) */
  _applyDamage(target, dmg, headshot, shooter) {
    const finalDmg = dmg * (headshot ? CONFIG.HEADSHOT_MULT : 1);
    // Предсказание: сразу уменьшаем его HP у себя (бар над головой)
    target.hp = Math.max(0, target.hp - finalDmg);
    this.net?.raise(EV.HIT, {
      to: target.actorNr,
      from: shooter.actorNr,
      dmg: Math.round(finalDmg),
      hs: headshot ? 1 : 0
    }, true);
    this.audio?.play(headshot ? 'hit_hs' : 'hit');
    if (headshot) window.__snc?.ui?.hitmarker?.(true);
    else window.__snc?.ui?.hitmarker?.(false);
  }

  // ---------- Обработка входящих событий ----------

  /** Удалённый игрок выстрелил — рисуем трассер от него */
  onRemoteShoot(actorNr, data) {
    const rp = this.remotes?.get(actorNr);
    if (!rp) return;
    rp.flashShot();
    const start = rp.muzzlePosition();
    const end = new THREE.Vector3(data.px, data.py, data.pz);
    this._spawnTracer(start, end, rp.team === 'a' ? 0x86d5ff : 0xffb0b0);
    this._spawnImpact(end, false);
    this.audio?.play('shoot_far');
  }

  /**
   * Нас в кого-то попали (EV.HIT). content.from — кто стрелял.
   * Вызывается только если мы — жертва (netSync фильтрует).
   */
  onIncomingHit(localPlayer, content) {
    if (!localPlayer.alive) return;
    const headshot = !!content.hs;
    const died = localPlayer.takeDamage(content.dmg, { headshot });
    this.audio?.play('hurt');
    window.__snc?.ui?.damageFlash?.();
    if (died) {
      // Сообщаем всем, что нас убили
      this.net?.raise(EV.DEATH, {
        killer: content.from,
        victim: localPlayer.actorNr,
        hs: headshot ? 1 : 0
      }, true);
      this.audio?.play('death');
    }
  }

  // ---------- Эффекты ----------

  _spawnTracer(from, to, color = 0xffe08a) {
    const geo = new THREE.BufferGeometry().setFromPoints([from.clone(), to.clone()]);
    const mat = new THREE.LineBasicMaterial({
      color, transparent: true, opacity: 0.95, depthWrite: false
    });
    const line = new THREE.Line(geo, mat);
    line.frustumCulled = false;
    this.scene.add(line);
    this.tracers.push({ line, life: 0.09, max: 0.09 });
  }

  _spawnImpact(point, headshot) {
    const m = new THREE.Mesh(this._impactGeo, this._impactMat);
    m.position.copy(point);
    this.scene.add(m);
    this.impacts.push({ mesh: m, life: headshot ? 0.35 : 0.2, max: headshot ? 0.35 : 0.2 });
    if (headshot) m.scale.setScalar(2.2);
  }

  _muzzleFlash(pos) {
    this.flashLight.position.copy(pos);
    this._flashT = 0.05;
    this.flashLight.intensity = 30;
  }

  /** Обновление эффектов (каждый кадр) */
  update(dt) {
    if (this._flashT > 0) {
      this._flashT -= dt;
      if (this._flashT <= 0) this.flashLight.intensity = 0;
    }
    for (let i = this.tracers.length - 1; i >= 0; i--) {
      const t = this.tracers[i];
      t.life -= dt;
      t.line.material.opacity = Math.max(0, t.life / t.max);
      if (t.life <= 0) {
        this.scene.remove(t.line);
        t.line.geometry.dispose();
        t.line.material.dispose();
        this.tracers.splice(i, 1);
      }
    }
    for (let i = this.impacts.length - 1; i >= 0; i--) {
      const im = this.impacts[i];
      im.life -= dt;
      im.mesh.scale.multiplyScalar(1 + dt * 4);
      im.mesh.material.opacity = Math.max(0, im.life / im.max);
      im.mesh.material.transparent = true;
      if (im.life <= 0) {
        this.scene.remove(im.mesh);
        this.impacts.splice(i, 1);
      }
    }
  }

  /** Камера нужна для направления выстрела — ставит main */
  setCamera(camera) { this._camera = camera; }

  clear() {
    for (const t of this.tracers) {
      this.scene.remove(t.line);
      t.line.geometry.dispose();
      t.line.material.dispose();
    }
    this.tracers.length = 0;
    for (const im of this.impacts) this.scene.remove(im.mesh);
    this.impacts.length = 0;
  }
}
