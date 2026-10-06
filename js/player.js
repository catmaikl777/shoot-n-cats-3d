// ============================================================
// player.js — локальный игрок: процедурная модель кота,
// физика капсулы (Rapier), камера от третьего лица, состояние
// ============================================================

import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { CONFIG, clamp, damp, angleDamp, lerp, rand } from './utils.js';

// ------------------------------------------------------------
// Процедурная модель кота (fallback, если нет GLB из манифеста)
// parts содержит именованные узлы для анимации
// ------------------------------------------------------------

export function buildCat({ fur = 0xff8a3d, belly = 0xfff1dd, eyes = 0x9dff5e } = {}) {
  const g = new THREE.Group();
  g.name = 'cat';

  const furMat = new THREE.MeshStandardMaterial({ color: fur, roughness: 0.82, metalness: 0.02 });
  const bellyMat = new THREE.MeshStandardMaterial({ color: belly, roughness: 0.9 });
  const darkMat = new THREE.MeshStandardMaterial({ color: 0x2a2130, roughness: 0.7 });
  const eyeMat = new THREE.MeshStandardMaterial({ color: eyes, emissive: eyes, emissiveIntensity: 0.55, roughness: 0.25 });
  const noseMat = new THREE.MeshStandardMaterial({ color: 0xff7b8a, roughness: 0.5 });

  // --- Тело ---
  const body = new THREE.Group();
  body.name = 'body';
  const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.34, 0.5, 4, 10), furMat);
  torso.rotation.z = Math.PI / 2;   // горизонтально
  torso.scale.set(1, 1, 0.92);
  torso.castShadow = true;
  body.add(torso);
  const chest = new THREE.Mesh(new THREE.SphereGeometry(0.3, 12, 10), bellyMat);
  chest.position.set(0.2, -0.1, 0);
  chest.scale.set(1, 0.8, 0.85);
  body.add(chest);
  g.add(body);

  // --- Голова ---
  const head = new THREE.Group();
  head.name = 'head';
  head.position.set(0.55, 0.28, 0);
  const skull = new THREE.Mesh(new THREE.SphereGeometry(0.27, 14, 12), furMat);
  skull.scale.set(1.05, 0.95, 0.95);
  skull.castShadow = true;
  head.add(skull);
  const muzzle = new THREE.Mesh(new THREE.SphereGeometry(0.14, 10, 8), bellyMat);
  muzzle.position.set(0.2, -0.06, 0);
  muzzle.scale.set(1, 0.8, 1.1);
  head.add(muzzle);
  const nose = new THREE.Mesh(new THREE.ConeGeometry(0.045, 0.05, 4), noseMat);
  nose.position.set(0.32, -0.03, 0);
  nose.rotation.z = -Math.PI / 2;
  head.add(nose);

  // Глаза
  for (const s of [-1, 1]) {
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.062, 10, 8), eyeMat);
    eye.position.set(0.2, 0.07, s * 0.13);
    head.add(eye);
    const pupil = new THREE.Mesh(new THREE.SphereGeometry(0.03, 8, 6), darkMat);
    pupil.position.set(0.245, 0.07, s * 0.13);
    pupil.scale.set(0.5, 1.3, 1);
    head.add(pupil);
  }

  // Уши
  const ears = [];
  for (const s of [-1, 1]) {
    const ear = new THREE.Mesh(new THREE.ConeGeometry(0.11, 0.24, 4), furMat);
    ear.position.set(-0.03, 0.25, s * 0.15);
    ear.rotation.x = s * 0.22;
    ear.castShadow = true;
    head.add(ear);
    ears.push(ear);
  }
  // Усики
  const whiskerMat = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.75 });
  for (const s of [-1, 1]) {
    for (let i = -1; i <= 1; i++) {
      const pts = [
        new THREE.Vector3(0.3, -0.05, s * 0.08),
        new THREE.Vector3(0.42, -0.05 + i * 0.05, s * 0.3)
      ];
      head.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), whiskerMat));
    }
  }
  g.add(head);

  // --- Ноги (4 сустава для ходьбы) ---
  const legs = [];
  const legPos = [
    [0.34, -0.28, 0.2],    // передняя правая
    [0.34, -0.28, -0.2],   // передняя левая
    [-0.34, -0.28, 0.2],   // задняя правая
    [-0.34, -0.28, -0.2]   // задняя левая
  ];
  for (const [x, y, z] of legPos) {
    const hip = new THREE.Group();
    hip.position.set(x, y, z);
    const upper = new THREE.Mesh(new THREE.CapsuleGeometry(0.085, 0.2, 3, 7), furMat);
    upper.position.y = -0.14;
    upper.castShadow = true;
    hip.add(upper);
    const paw = new THREE.Mesh(new THREE.SphereGeometry(0.1, 8, 6), bellyMat);
    paw.position.set(0.03, -0.3, 0);
    paw.scale.set(1.2, 0.7, 1);
    hip.add(paw);
    g.add(hip);
    legs.push(hip);
  }

  // --- Хвост (сегменты) ---
  const tail = new THREE.Group();
  tail.name = 'tail';
  tail.position.set(-0.6, 0.1, 0);
  let parent = tail;
  const tailSegs = [];
  for (let i = 0; i < 5; i++) {
    const seg = new THREE.Group();
    const m = new THREE.Mesh(
      new THREE.CapsuleGeometry(0.065 - i * 0.007, 0.16, 3, 6),
      i === 4 ? darkMat : furMat
    );
    m.rotation.x = Math.PI / 2;
    m.position.z = -0.1;
    m.castShadow = true;
    seg.add(m);
    seg.position.set(-0.1, i === 0 ? 0 : 0.03, i === 0 ? 0 : -0.16);
    parent.add(seg);
    parent = seg;
    tailSegs.push(seg);
  }
  g.add(tail);

  // --- Точка крепления оружия (между передних лап) ---
  const gunMount = new THREE.Group();
  gunMount.name = 'gunMount';
  gunMount.position.set(0.5, -0.1, 0);
  g.add(gunMount);

  g.traverse((o) => {
    if (o.isMesh) { o.castShadow = true; o.receiveShadow = false; }
  });

  // Модель собрана мордой в +X, игровой forward — +Z: укладываем поворот в шелл,
  // чтобы нос смотрел в +Z. (Владельцы крутят group.rotation.y отдельно.)
  g.rotation.y = -Math.PI / 2;
  const shell = new THREE.Group();
  shell.name = 'catShell';
  shell.add(g);

  return {
    group: shell,
    parts: { body, head, ears, legs, tail, tailSegs, gunMount },
    materials: { furMat, bellyMat, eyeMat, darkMat }
  };
}

// ------------------------------------------------------------
// Процедурная винтовка (оружие в лапах)
// ------------------------------------------------------------

export function buildRifle(color = 0x39414f) {
  const g = new THREE.Group();
  const bodyMat = new THREE.MeshStandardMaterial({ color, roughness: 0.55, metalness: 0.55 });
  const darkMat = new THREE.MeshStandardMaterial({ color: 0x1b1f26, roughness: 0.6, metalness: 0.4 });
  const accentMat = new THREE.MeshStandardMaterial({ color: 0xff8a3d, roughness: 0.5, metalness: 0.3 });

  const receiver = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.14, 0.12), bodyMat);
  receiver.castShadow = true;
  g.add(receiver);

  const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.03, 0.55, 8), darkMat);
  barrel.rotation.z = Math.PI / 2;
  barrel.position.set(0.55, 0.02, 0);
  barrel.castShadow = true;
  g.add(barrel);

  const muzzle = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.1, 8), accentMat);
  muzzle.rotation.z = Math.PI / 2;
  muzzle.position.set(0.82, 0.02, 0);
  g.add(muzzle);

  const stock = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.16, 0.09), bodyMat);
  stock.position.set(-0.42, -0.02, 0);
  stock.rotation.z = 0.1;
  g.add(stock);

  const mag = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.24, 0.08), darkMat);
  mag.position.set(0.02, -0.17, 0);
  mag.rotation.z = 0.12;
  g.add(mag);

  const grip = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.18, 0.08), darkMat);
  grip.position.set(-0.2, -0.14, 0);
  grip.rotation.z = 0.35;
  g.add(grip);

  const scope = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.24, 10), darkMat);
  scope.rotation.z = Math.PI / 2;
  scope.position.set(0.05, 0.13, 0);
  g.add(scope);

  // Дуло-эффект: точка вылета пули
  const muzzlePoint = new THREE.Object3D();
  muzzlePoint.position.set(0.9, 0.02, 0);
  g.add(muzzlePoint);

  g.userData.muzzle = muzzlePoint;
  g.scale.setScalar(1);
  return g;
}

// ------------------------------------------------------------
// Общая анимация кота — используется локальным и удалёнными игроками
// st: { phase, speed, moving, grounded, aiming, headYaw, headPitch, recoil }
// ------------------------------------------------------------

export function animateCat(cat, dt, st) {
  const { body, head, ears, legs, tailSegs } = cat.parts;
  const runFactor = clamp(st.speed / CONFIG.RUN_SPEED, 0, 1);
  const air = !st.grounded;

  if (st.moving) {
    // Ходьба/бег: диагональный аллюр
    const amp = 0.55 * (0.5 + runFactor);
    legs[0].rotation.x = Math.sin(st.phase) * amp;
    legs[3].rotation.x = Math.sin(st.phase) * amp;
    legs[1].rotation.x = Math.sin(st.phase + Math.PI) * amp;
    legs[2].rotation.x = Math.sin(st.phase + Math.PI) * amp;
    body.position.y = Math.abs(Math.sin(st.phase * 2)) * 0.045 * runFactor;
    body.rotation.z = Math.sin(st.phase) * 0.04;
  } else {
    // Покой: лапы на месте, дыхание
    for (const l of legs) l.rotation.x = damp(l.rotation.x, 0, 8, dt);
    body.position.y = Math.sin(performance.now() * 0.002) * 0.012;
    body.rotation.z = damp(body.rotation.z, 0, 6, dt);
  }

  if (air) {
    // В полёте лапы поджаты
    for (const l of legs) l.rotation.x = damp(l.rotation.x, -0.6, 10, dt);
  }

  // Хвост: волна
  const t = performance.now() * 0.003;
  tailSegs.forEach((seg, i) => {
    seg.rotation.y = Math.sin(t + i * 0.7) * (0.18 + runFactor * 0.25);
    seg.rotation.x = Math.cos(t * 0.8 + i * 0.5) * 0.1 - (air ? 0.2 : 0);
  });

  // Голова
  head.rotation.x = damp(head.rotation.x, st.headPitch ?? -0.05, 8, dt);
  head.rotation.y = damp(head.rotation.y, st.headYaw ?? 0, 6, dt);

  // Уши дрожат при беге
  const twitch = runFactor * 0.15;
  ears[0].rotation.z = Math.sin(t * 3) * twitch;
  ears[1].rotation.z = -Math.sin(t * 3) * twitch;

  // Отдача (оружие обновляет владелец)
  const rec = st.recoil ?? 0;
  if (cat.rifle) {
    cat.rifle.rotation.x = -rec * 2.2;
    cat.rifle.position.x = -rec * 0.35;
  }
}

// ------------------------------------------------------------
// Локальный игрок
// ------------------------------------------------------------

const UP = new THREE.Vector3(0, 1, 0);
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _rayDir = new THREE.Vector3();

export class LocalPlayer {
  constructor({ scene, world, camera, map }) {
    this.scene = scene;
    this.world = world;
    this.camera = camera;
    this.map = map;

    this.name = 'Кот_Боец';
    this.team = 'a';
    this.actorNr = 1;

    // --- Состояние ---
    this.hp = CONFIG.MAX_HP;
    this.shield = 0;
    this.alive = true;
    this.kills = 0;
    this.deaths = 0;
    this.score = 0;

    // Боезапас
    this.mag = CONFIG.MAG_SIZE;
    this.reserve = CONFIG.RESERVE_AMMO;
    this.reloading = false;
    this.reloadT = 0;
    this.fireCd = 0;
    this.grenades = CONFIG.NADE_COUNT;
    this.nadeCd = 0;

    // Баффы: { key: timeLeft }
    this.buffs = {};

    // Рывок
    this.dashCd = 0;
    this.dashT = 0;
    this.dashDir = new THREE.Vector3();

    // Камера
    this.camYaw = 0;
    this.camPitch = -0.12;
    this.camDist = 5.2;
    this.camDistTarget = 5.2;
    this.shoulder = 0.9;

    // Физика
    const r = CONFIG.PLAYER_RADIUS;
    const halfH = CONFIG.PLAYER_HEIGHT / 2 - r;
    this.body = world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(0, 3, 0)
        .setCcdEnabled(true)
        .setLinearDamping(0.05)
        .setAngularDamping(8)
    );
    this.collider = world.createCollider(
      RAPIER.ColliderDesc.capsule(halfH, r)
        .setFriction(0)
        .setRestitution(0)
        .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS),
      this.body
    );
    this.body.lockRotations(true, true);

    this.grounded = false;
    this._groundCheckCd = 0;

    // Визуал
    const cat = buildCat();
    this.cat = cat;
    this.group = cat.group;
    this.group.position.set(0, 3, 0);
    scene.add(this.group);

    this.rifle = buildRifle();
    this.rifle.scale.setScalar(0.85);
    cat.parts.gunMount.add(this.rifle);

    // Анимация
    this.animPhase = 0;
    this.speedSm = 0;
    this.recoil = 0;
    this.aiming = false;

    // Трассеры/эффекты живут в weapons.js
    this._muzzleFlash = 0;
  }

  // ---------- Позиция/ориентация ----------
  get position() {
    const t = this.body.translation();
    _v.set(t.x, t.y, t.z);
    return _v;
  }

  setPosition(x, y, z) {
    this.body.setTranslation({ x, y, z }, true);
    this.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.group.position.set(x, y, z);
  }

  get velocity() {
    const l = this.body.linvel();
    _v2.set(l.x, l.y, l.z);
    return _v2;
  }

  /** Направление взгляда (куда смотрит камера/прицел) */
  get aimDir() {
    return new THREE.Vector3(
      Math.cos(this.camPitch) * Math.sin(this.camYaw),
      Math.sin(this.camPitch),
      Math.cos(this.camPitch) * Math.cos(this.camYaw)
    );
  }

  /** Точка выстрела (глаза кота) */
  eyePosition() {
    const p = this.position;
    return new THREE.Vector3(p.x, p.y + 0.45, p.z);
  }

  // ---------- Обновление ----------
  /**
   * @param {number} dt секунды
   * @param {object} input — общий объект ввода (touchControls + клавиатура)
   */
  update(dt, input) {
    if (!this.alive) {
      // Мёртвый игрок не принимает ввод — только тикаем таймеры респавна снаружи
      this._mag = 0;
      return;
    }

    // 1. Обновляем баффы
    for (const k of Object.keys(this.buffs)) {
      this.buffs[k] -= dt;
      if (this.buffs[k] <= 0) delete this.buffs[k];
    }
    this.dashCd = Math.max(0, this.dashCd - dt);
    this.nadeCd = Math.max(0, this.nadeCd - dt);
    this.fireCd = Math.max(0, this.fireCd - dt);

    // 2. Прицел/камера
    const look = input.consumeLook();
    const sens = input.sensitivity ?? 1;
    this.camYaw -= look.x * 0.0028 * sens;
    this.camPitch -= look.y * 0.0028 * sens * (input.invertY ? -1 : 1);
    this.camPitch = clamp(this.camPitch, -Math.PI / 4, Math.PI / 4); // ±45°
    this.camDistTarget = clamp(look.zoom ?? this.camDistTarget, 3, 9);
    this.camDist = damp(this.camDist, this.camDistTarget, 8, dt);
    this.aiming = !!input.aim;

    // 3. Движение относительно yaw камеры
    const mv = input.move;
    const mag = clamp(Math.hypot(mv.x, mv.y), 0, 1);
    let speed = lerp(CONFIG.WALK_SPEED, CONFIG.RUN_SPEED, mag);
    if (this.buffs.speed) speed *= CONFIG.SPRINT_MULT;

    const sin = Math.sin(this.camYaw), cos = Math.cos(this.camYaw);
    // Вперёд по yaw: (sin, 0, cos); вправо (экранно): (-cos, 0, sin)
    let wishX = sin * mv.y - cos * mv.x;
    let wishZ = cos * mv.y + sin * mv.x;
    const wishLen = Math.hypot(wishX, wishZ);
    if (wishLen > 0.0001) {
      wishX = (wishX / wishLen) * mag * speed;
      wishZ = (wishZ / wishLen) * mag * speed;
    }

    // 4. Рывок
    if (this.dashT > 0) {
      this.dashT -= dt;
      const vy = this.velocity.y;
      this.body.setLinvel({
        x: this.dashDir.x * CONFIG.DASH_SPEED,
        y: vy,
        z: this.dashDir.z * CONFIG.DASH_SPEED
      }, true);
    } else {
      const vel = this.body.linvel();
      const control = this.grounded ? 1 : 0.35;
      this.body.setLinvel({
        x: lerp(vel.x, wishX, clamp(control * 12 * dt, 0, 1)),
        y: vel.y,
        z: lerp(vel.z, wishZ, clamp(control * 12 * dt, 0, 1))
      }, true);
    }

    if (input.dash && this.dashCd <= 0 && mag > 0.1) {
      this.startDash(mv);
      input.dash = false;
    }

    // 5. Прыжок
    if (input.jump) {
      input.jump = false;
      if (this.grounded) {
        this.body.setLinvel({ x: this.velocity.x, y: CONFIG.JUMP_VEL, z: this.velocity.z }, true);
        this.grounded = false;
        input.vibrate?.(20);
      }
    }

    // 6. Перезарядка
    if (this.reloading) {
      this.reloadT -= dt;
      if (this.reloadT <= 0) this._finishReload();
    } else if (input.reload || (this.mag <= 0 && this.reserve > 0)) {
      if (this.mag < CONFIG.MAG_SIZE && this.reserve > 0) this.startReload();
      input.reload = false;
    }

    // 7. Стрельба (удержание)
    if (input.fire && this.fireCd <= 0 && !this.reloading && this.mag > 0) {
      input.onShoot?.(this);
    }

    // 8. Запоминаем параметры для пост-шага (визуал/камера)
    this._mag = mag;
    this._wishX = wishX;
    this._wishZ = wishZ;

    // 9. world.step() выполняется в main.js ДО вызова postStep()
  }

  /**
   * Пост-обработка после физического шага мира:
   * проверка земли, ограничение картой, визуал, камера.
   */
  postStep(dt) {
    if (!this.alive) {
      this._checkGround(dt);
      this._clampToMap();
      this.group.position.copy(this.position);
      this._animate(dt, 0);
      this._updateCamera(dt, true);
      return;
    }

    // Проверка земли
    this._checkGround(dt);

    // Ограничение картой + избегание проваливания
    this._clampToMap();

    // Визуал
    const speedNow = Math.hypot(this.velocity.x, this.velocity.z);
    this.speedSm = damp(this.speedSm, speedNow, 10, dt);
    this.group.position.copy(this.position);
    // Поворот тела: по направлению движения, либо по камере при прицеливании
    let targetYaw = this.camYaw;
    const mag = this._mag || 0;
    if (mag > 0.08 && !this.aiming) targetYaw = Math.atan2(this._wishX, this._wishZ);
    this.group.rotation.y = angleDamp(this.group.rotation.y, targetYaw, 14, dt);

    this.recoil = damp(this.recoil, 0, 12, dt);
    this._animate(dt, mag);

    // Камера
    this._updateCamera(dt, false);
  }

  startDash(mv) {
    const sin = Math.sin(this.camYaw), cos = Math.cos(this.camYaw);
    let dx = sin * mv.y - cos * mv.x;
    let dz = cos * mv.y + sin * mv.x;
    const len = Math.hypot(dx, dz) || 1;
    this.dashDir.set(dx / len, 0, dz / len);
    this.dashT = CONFIG.DASH_TIME;
    this.dashCd = CONFIG.DASH_COOLDOWN;
    this.buffs.dashFx = 0.3;
  }

  startReload() {
    if (this.reloading || this.reserve <= 0 || this.mag >= CONFIG.MAG_SIZE) return;
    this.reloading = true;
    this.reloadT = CONFIG.RELOAD_TIME;
  }

  _finishReload() {
    this.reloading = false;
    const need = CONFIG.MAG_SIZE - this.mag;
    const take = Math.min(need, this.reserve);
    this.mag += take;
    this.reserve -= take;
    this.reloadT = 0;
  }

  consumeAmmo() {
    if (this.mag <= 0) return false;
    this.mag--;
    this.recoil = Math.min(this.recoil + 0.045, 0.25);
    if (this.mag === 0 && this.reserve > 0) this.startReload();
    return true;
  }

  /** Бросок гранаты с силой 0..1 */
  throwGrenade(power) {
    if (this.grenades <= 0 || this.nadeCd > 0) return null;
    this.grenades--;
    this.nadeCd = CONFIG.NADE_COOLDOWN;
    return {
      origin: this.eyePosition(),
      dir: this.aimDir,
      power: clamp(power, 0.25, 1)
    };
  }

  _checkGround(dt) {
    const p = this.position;
    const ray = new RAPIER.Ray(
      { x: p.x, y: p.y, z: p.z },
      { x: 0, y: -1, z: 0 }
    );
    const hit = this.world.castRay(ray, CONFIG.PLAYER_HEIGHT / 2 + 0.25, true);
    const vy = this.velocity.y;
    this.grounded = !!hit && vy <= 1.5;
  }

  _clampToMap() {
    const p = this.position;
    const lim = CONFIG.MAP_SIZE / 2 - 1;
    let x = p.x, z = p.z, y = p.y;
    if (x < -lim) x = -lim;
    if (x > lim) x = lim;
    if (z < -lim) z = -lim;
    if (z > lim) z = lim;
    // Не даём упасть сквозь пол
    if (y < -40) { y = 4; this.body.setLinvel({ x: 0, y: 0, z: 0 }, true); }
    if (x !== p.x || z !== p.z || y !== p.y) {
      this.body.setTranslation({ x, y, z }, true);
    }
  }

  // ---------- Камера от третьего лица ----------
  _updateCamera(dt, dead) {
    const p = this.position;
    const eye = new THREE.Vector3(p.x, p.y + (dead ? 0.6 : 0.85), p.z);

    const pitch = this.camPitch + this.recoil;
    const dir = new THREE.Vector3(
      Math.cos(pitch) * Math.sin(this.camYaw),
      Math.sin(pitch),
      Math.cos(pitch) * Math.cos(this.camYaw)
    );

    // Смещение плеча (over-the-shoulder): экранно-право
    const right = new THREE.Vector3(-Math.cos(this.camYaw), 0, Math.sin(this.camYaw));
    const shoulder = this.aiming ? 0.55 : 0.85;
    const target = eye.clone()
      .addScaledVector(dir, -this.camDist)
      .addScaledVector(right, shoulder);
    target.y += 0.35;

    // Не даём камере провалиться в стены
    const toCam = target.clone().sub(eye);
    const dist = toCam.length();
    toCam.normalize();
    const ray = new RAPIER.Ray({ x: eye.x, y: eye.y, z: eye.z }, { x: toCam.x, y: toCam.y, z: toCam.z });
    const hit = this.world.castRay(ray, dist + 0.3, true);
    if (hit) {
      const toi = hit.timeOfImpact ?? hit.toi ?? dist;
      target.copy(eye).addScaledVector(toCam, Math.max(0.8, toi - 0.3));
    }

    if (dead) {
      target.y += 1.5;
    }

    this.camera.position.lerp(target, clamp(14 * dt, 0, 1));
    const lookAt = eye.clone().addScaledVector(dir, 10);
    lookAt.addScaledVector(right, shoulder * 0.6);
    this.camera.lookAt(lookAt);
  }

  // ---------- Анимация ----------
  _animate(dt, moveAmt) {
    this.animPhase += dt * (4 + clamp(this.speedSm / CONFIG.RUN_SPEED, 0, 1) * 9);
    animateCat(this.cat, dt, {
      phase: this.animPhase,
      speed: this.speedSm,
      moving: moveAmt > 0.05 || this.speedSm > 0.4,
      grounded: this.grounded,
      aiming: this.aiming,
      headYaw: this.aiming ? 0 : clamp(-this.group.rotation.y + this.camYaw, -0.7, 0.7) * 0.4,
      headPitch: this.aiming ? clamp(this.camPitch * 0.7, -0.5, 0.5) : -0.05,
      recoil: this.recoil
    });
    if (this.rifle) {
      this.rifle.rotation.x = -this.recoil * 2.2;
      this.rifle.position.x = -this.recoil * 0.35;
      this.cat.parts.gunMount.rotation.x = damp(
        this.cat.parts.gunMount.rotation.x,
        this.aiming ? -this.camPitch * 0.5 : 0, 10, dt
      );
    }
    if (this._muzzleFlash > 0) this._muzzleFlash -= dt;
  }

  /** Эффект выстрела (вызывает weapons.js) */
  flashMuzzle() {
    this._muzzleFlash = 0.05;
    this.recoil = Math.min(this.recoil + 0.04, 0.3);
  }

  // ---------- Урон / смерть ----------
  /** @returns {boolean} true — если смерть */
  takeDamage(amount, { headshot = false, source = null } = {}) {
    if (!this.alive) return false;
    let dmg = amount * (headshot ? CONFIG.HEADSHOT_MULT : 1);

    if (this.shield > 0) {
      const absorbed = Math.min(this.shield, dmg);
      this.shield -= absorbed;
      dmg -= absorbed;
    }
    this.hp -= dmg;
    if (this.hp <= 0) {
      this.hp = 0;
      this.die(source);
      return true;
    }
    return false;
  }

  die(killerName = null) {
    if (!this.alive) return;
    this.alive = false;
    this.deaths++;
    this.reloading = false;
    this.dashT = 0;
    this.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this._killerName = killerName;
  }

  respawn(pos) {
    this.hp = CONFIG.MAX_HP;
    this.shield = 0;
    this.alive = true;
    this.mag = CONFIG.MAG_SIZE;
    this.reserve = CONFIG.RESERVE_AMMO;
    this.grenades = CONFIG.NADE_COUNT;
    this.buffs = {};
    this.dashCd = 0;
    this.reloading = false;
    this.setPosition(pos.x, pos.y, pos.z);
    this.group.rotation.y = this.camYaw;
  }

  /** Текущее состояние для отправки по сети */
  netState() {
    const p = this.position;
    return {
      x: +p.x.toFixed(2),
      y: +p.y.toFixed(2),
      z: +p.z.toFixed(2),
      ry: +this.group.rotation.y.toFixed(3),
      pitch: +this.camPitch.toFixed(3),
      hp: Math.round(this.hp),
      sh: Math.round(this.shield),
      w: 0,
      anim: this.speedSm > 0.5 ? (this.speedSm > 6 ? 2 : 1) : 0,
      alive: this.alive ? 1 : 0,
      t: Date.now()
    };
  }

  dispose() {
    this.world.removeRigidBody(this.body);
    this.scene.remove(this.group);
  }
}
