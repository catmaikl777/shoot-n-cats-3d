// ============================================================
// map.js — сборка большой карты ~200×200 м из модулей
// Зоны: город (центр), парк (юг), промзона (север),
//       метро (подземка), крыши (верхний ярус)
// Статика запекается в InstancedMesh, коллизии — фикс. тела Rapier
// ============================================================

import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { CONFIG, rand, pick } from './utils.js';

const HALF = CONFIG.MAP_SIZE / 2; // 100

// Цвета материалов (используются как tint поверх текстур)
const C = {
  building: 0x8d97ab,
  buildingDark: 0x5f6a80,
  brick: 0x9c6b52,
  road: 0x3a3f47,
  sidewalk: 0x9aa1ad,
  grass: 0x4f7a35,
  metal: 0x77808c,
  containerA: 0xc0553d,
  containerB: 0x3d7ac0,
  containerC: 0x4da36a,
  wood: 0x9b7345,
  leaf: 0x3f7a34,
  leafDark: 0x2e5f28,
  rock: 0x7d7568,
  water: 0x2f6d8e
};

export class GameMap {
  constructor(scene, world, assets, quality) {
    this.scene = scene;
    this.world = world;          // Rapier.World
    this.assets = assets;
    this.quality = quality;

    this.group = new THREE.Group();
    this.group.name = 'map';
    scene.add(this.group);

    /** AABB для быстрых проверок (двери, зоны) */
    this.colliders = [];

    /** Точки возрождения: { team: 'a'|'b', pos: Vector3 } */
    this.spawns = { a: [], b: [] };

    /** Точки интереса для режимов */
    this.points = {
      center: new THREE.Vector3(0, 0, 0),
      king: new THREE.Vector3(0, 0, 0),
      deliveryNeutral: new THREE.Vector3(0, 0, -46),
      baseA: new THREE.Vector3(-84, 0, 0),
      baseB: new THREE.Vector3(84, 0, 0)
    };

    /** Счётчик для LOD/скрытия */
    this._instanced = 0;
  }

  // ---------- Материалы ----------
  _mat(texKey, repeat, color = 0xffffff, opts = {}) {
    const tex = this.assets ? this.assets.tex(texKey, repeat[0], repeat[1]) : null;
    return new THREE.MeshStandardMaterial({
      map: tex,
      color,
      roughness: opts.roughness ?? 0.9,
      metalness: opts.metalness ?? 0.05,
      ...opts.extra
    });
  }

  _flatMat(color, opts = {}) {
    return new THREE.MeshStandardMaterial({
      color,
      roughness: opts.roughness ?? 0.85,
      metalness: opts.metalness ?? 0.02
    });
  }

  // ---------- Низкоуровневые примитивы ----------

  /** Ящик + фиксированный коллайдер Rapier */
  addBox(x, y, z, w, h, d, material, opts = {}) {
    const geo = new THREE.BoxGeometry(w, h, d);
    const mesh = new THREE.Mesh(geo, material);
    mesh.position.set(x, y, z);
    if (opts.ry) mesh.rotation.y = opts.ry;
    mesh.castShadow = opts.castShadow !== false;
    mesh.receiveShadow = opts.receive !== false;
    this.group.add(mesh);
    if (opts.collider !== false) this._collider(x, y, z, w, h, d, opts.ry || 0);
    return mesh;
  }

  /** Цилиндр + коллайдер (бочки, деревья, колонны) */
  addCyl(x, y, z, r, h, material, opts = {}) {
    const geo = new THREE.CylinderGeometry(r, r * (opts.taper ?? 1), h, opts.seg || 12);
    const mesh = new THREE.Mesh(geo, material);
    mesh.position.set(x, y, z);
    mesh.castShadow = opts.castShadow !== false;
    mesh.receiveShadow = true;
    this.group.add(mesh);
    if (opts.collider !== false) {
      // Капсульная/цилиндрическая коллизия приближается кубом по диаметру
      this._collider(x, y, z, r * 1.8, h, r * 1.8, 0);
    }
    return mesh;
  }

  /** Фиксированное тело Rapier (куб) */
  _collider(x, y, z, w, h, d, ry = 0) {
    const body = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.fixed().setTranslation(x, y, z).setRotation(quatFromYaw(ry))
    );
    const shape = RAPIER.ColliderDesc.cuboid(w / 2, h / 2, d / 2)
      .setFriction(0.9)
      .setRestitution(0.05);
    this.world.createCollider(shape, body);
    this.colliders.push({
      min: new THREE.Vector3(x - w / 2, y - h / 2, z - d / 2),
      max: new THREE.Vector3(x + w / 2, y + h / 2, z + d / 2)
    });
    return body;
  }

  // ---------- Постройка ----------

  build() {
    this._ground();
    this._roads();
    this._city();
    this._park();
    this._industrial();
    this._metro();
    this._rooftops();
    this._boundary();
    this._spawns();
    this._decor();
    console.log(`[Map] собрано: объектов=${this.group.children.length}, коллайдеров=${this.colliders.length}`);
    return this;
  }

  // Земля: единый пол + по зонам свои материалы
  _ground() {
    const size = CONFIG.MAP_SIZE;
    // Общий грунт (асфальт города)
    const g = new THREE.Mesh(
      new THREE.PlaneGeometry(size, size),
      this._mat('tex_asphalt', [40, 40], 0xbfc4cc)
    );
    g.rotation.x = -Math.PI / 2;
    g.receiveShadow = true;
    this.group.add(g);

    // Пол в мире физики
    const body = this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    this.world.createCollider(
      RAPIER.ColliderDesc.cuboid(size / 2, 1, size / 2).setTranslation(0, -1, 0).setFriction(0.95),
      body
    );

    // Парковая трава (юг)
    const lawn = new THREE.Mesh(
      new THREE.PlaneGeometry(110, 60),
      this._mat('tex_grass', [26, 14], 0x9fd07a)
    );
    lawn.rotation.x = -Math.PI / 2;
    lawn.position.set(0, 0.02, 66);
    lawn.receiveShadow = true;
    this.group.add(lawn);

    // Площадка промзоны (север)
    const yard = new THREE.Mesh(
      new THREE.PlaneGeometry(150, 56),
      this._mat('tex_concrete', [20, 8], 0xb9bec6)
    );
    yard.rotation.x = -Math.PI / 2;
    yard.position.set(0, 0.02, -70);
    yard.receiveShadow = true;
    this.group.add(yard);

    // Пруд в парке
    const pond = new THREE.Mesh(
      new THREE.CircleGeometry(14, 32),
      new THREE.MeshStandardMaterial({ color: C.water, roughness: 0.15, metalness: 0.4, transparent: true, opacity: 0.9 })
    );
    pond.rotation.x = -Math.PI / 2;
    pond.position.set(-34, 0.06, 74);
    this.group.add(pond);
  }

  // Дороги с разметкой (город)
  _roads() {
    const roadMat = this._mat('tex_asphalt', [8, 40], 0x666c75, { roughness: 1 });
    const lineMat = this._flatMat(0xe8e2c8, { roughness: 0.7 });

    // Магистраль восток-запад
    const r1 = new THREE.Mesh(new THREE.PlaneGeometry(200, 12), roadMat);
    r1.rotation.x = -Math.PI / 2; r1.position.set(0, 0.03, 0); r1.receiveShadow = true;
    this.group.add(r1);
    // Магистраль север-юг
    const r2 = new THREE.Mesh(new THREE.PlaneGeometry(12, 200), roadMat);
    r2.rotation.x = -Math.PI / 2; r2.position.set(-14, 0.03, 0); r2.receiveShadow = true;
    this.group.add(r2);

    // Разметка (пунктир) — тонкие планки, не коллайдеры
    const dashGeo = new THREE.BoxGeometry(3, 0.05, 0.3);
    const dashes = new THREE.InstancedMesh(dashGeo, lineMat, 60);
    const m = new THREE.Matrix4();
    let i = 0;
    for (let x = -95; x <= 95 && i < 30; x += 7) {
      m.makeTranslation(x, 0.06, 0);
      dashes.setMatrixAt(i++, m);
    }
    for (let z = -95; z <= 95 && i < 60; z += 7) {
      m.makeTranslation(-14, 0.06, z);
      dashes.setMatrixAt(i++, m);
    }
    dashes.count = i;
    dashes.instanceMatrix.needsUpdate = true;
    this.group.add(dashes);

    // Тротуары вдоль дорог
    const swMat = this._flatMat(C.sidewalk, { roughness: 0.95 });
    this.addBox(0, 0.15, 7.5, 200, 0.3, 3, swMat, { collider: false, castShadow: false });
    this.addBox(0, 0.15, -7.5, 200, 0.3, 3, swMat, { collider: false, castShadow: false });
    this.addBox(-6.5, 0.15, 0, 3, 0.3, 200, swMat, { collider: false, castShadow: false });
    this.addBox(-21.5, 0.15, 0, 3, 0.3, 200, swMat, { collider: false, castShadow: false });
  }

  // ГОРОД: кварталы зданий, переулки, укрытия
  _city() {
    const wallMats = [
      this._mat('tex_paint', [4, 4], 0xcfd6e4),
      this._mat('tex_concrete', [4, 4], 0xa9b2c2),
      this._flatMat(C.brick, { roughness: 0.95 }),
      this._mat('tex_rock', [3, 3], 0xb0a898)
    ];
    const roofMat = this._flatMat(C.buildingDark, { roughness: 0.95 });
    const winMat = new THREE.MeshStandardMaterial({
      color: 0x1e2b44, roughness: 0.15, metalness: 0.85,
      emissive: 0x10203a, emissiveIntensity: 0.4
    });

    // Кварталы: сетка со смещением дорог
    const blocks = [
      // [cx, cz, w, d, floors]
      [22, 22, 26, 24, 5], [58, 24, 30, 26, 4], [88, 20, 22, 22, 6],
      [24, -24, 26, 26, 6], [58, -26, 30, 24, 3], [88, -22, 22, 24, 5],
      [-46, 30, 28, 26, 4], [-76, 34, 24, 24, 5],
      [-46, -30, 28, 26, 5], [-76, -34, 24, 24, 3],
      [-44, 66, 24, 20, 3], [34, 62, 22, 18, 4],
      [-46, -66, 26, 20, 4], [30, -66, 24, 18, 3]
    ];

    for (const [cx, cz, w, d, floors] of blocks) {
      const h = floors * 3.2;
      const mat = pick(wallMats);
      // Основной объём
      this.addBox(cx, h / 2, cz, w, h, d, mat);
      // Карниз/крыша
      this.addBox(cx, h + 0.35, cz, w + 0.8, 0.7, d + 0.8, roofMat, { collider: false });
      // Окна — одна текстурированная плоскость на фасад
      const win = new THREE.Mesh(new THREE.PlaneGeometry(w - 2, h - 2), winMat);
      win.position.set(cx, h / 2, cz + d / 2 + 0.05);
      this.group.add(win);
      const win2 = win.clone();
      win2.position.set(cx + w / 2 + 0.05, h / 2, cz);
      win2.rotation.y = Math.PI / 2;
      this.group.add(win2);

      // Лестница/пандус на крышу для части зданий (vertical gameplay)
      if (floors >= 4) this._roofRamp(cx - w / 2 - 4, cz, h);
    }

    // Автомобили-укрытия на дорогах
    const carColors = [0xd94f4f, 0x4f7dd9, 0xe0c341, 0xdddddd, 0x3f3f46];
    for (const [x, z, ry] of [
      [16, 2, 0], [46, -2.5, 0], [-52, 2.5, 0], [-11.5, 40, Math.PI / 2],
      [-16.5, -54, Math.PI / 2], [74, 3, 0]
    ]) {
      this._car(x, z, ry, pick(carColors));
    }

    // Баррикады/ящики в переулках
    const crateMat = this._mat('tex_wood', [1, 1], 0xc9a06a);
    for (const [x, z] of [[10, 14], [12, -14], [-32, 9], [64, 9], [-2, -30], [40, 12], [-30, -12]]) {
      this.addBox(x, 0.6, z, 1.3, 1.2, 1.3, crateMat, { ry: rand(0, Math.PI) });
      if (Math.random() > 0.5) {
        this.addBox(x + 1.2, 0.45, z + 0.6, 1, 0.9, 1, crateMat, { ry: rand(0, Math.PI) });
      }
    }
  }

  /** Пандус на крышу */
  _roofRamp(x, z, height) {
    const len = height * 1.35;
    const mat = this._mat('tex_metal', [2, 4], 0x9aa3ae, { metalness: 0.5, roughness: 0.6 });
    const ramp = new THREE.Mesh(new THREE.BoxGeometry(5, 0.4, len), mat);
    ramp.position.set(x, height / 2, z);
    ramp.rotation.x = -Math.atan2(height, len);
    ramp.castShadow = true;
    ramp.receiveShadow = true;
    this.group.add(ramp);

    // Физика: наклонный ящик — Rapier поддерживает кватернионы
    const rot = new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.atan2(height, len), 0, 0));
    const body = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.fixed()
        .setTranslation(x, height / 2, z)
        .setRotation({ x: rot.x, y: rot.y, z: rot.z, w: rot.w })
    );
    this.world.createCollider(
      RAPIER.ColliderDesc.cuboid(2.5, 0.2, len / 2).setFriction(0.8),
      body
    );
  }

  _car(x, z, ry, color) {
    const bodyMat = this._flatMat(color, { roughness: 0.4, metalness: 0.55 });
    const glassMat = new THREE.MeshStandardMaterial({ color: 0x14202f, roughness: 0.1, metalness: 0.9 });
    const g = new THREE.Group();
    const lower = new THREE.Mesh(new THREE.BoxGeometry(4.4, 1, 2), bodyMat);
    lower.position.y = 0.7;
    lower.castShadow = lower.receiveShadow = true;
    const cabin = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.85, 1.8), glassMat);
    cabin.position.set(-0.2, 1.55, 0);
    cabin.castShadow = true;
    const wheelGeo = new THREE.CylinderGeometry(0.42, 0.42, 0.35, 12);
    const wheelMat = this._flatMat(0x16171c, { roughness: 0.95 });
    for (const [wx, wz] of [[-1.4, 1], [1.4, 1], [-1.4, -1], [1.4, -1]]) {
      const w = new THREE.Mesh(wheelGeo, wheelMat);
      w.rotation.x = Math.PI / 2;
      w.position.set(wx, 0.42, wz);
      g.add(w);
    }
    g.add(lower, cabin);
    g.position.set(x, 0, z);
    g.rotation.y = ry;
    this.group.add(g);
    // Коллайдер одной «коробкой» под всю машину
    const cw = Math.abs(Math.cos(ry)) > 0.5 ? 4.4 : 2;
    const cd = Math.abs(Math.cos(ry)) > 0.5 ? 2 : 4.4;
    this._collider(x, 0.9, z, cw, 1.8, cd, 0);
  }

  // ПАРК: деревья, скамейки, беседка (юг)
  _park() {
    const trunkMat = this._mat('tex_bark', [1, 2], 0x9b7a52);
    const leafMat = this._flatMat(C.leaf, { roughness: 1 });
    const leafMat2 = this._flatMat(C.leafDark, { roughness: 1 });

    // Деревья: ствол + крона, InstancedMesh для крон
    const treeSpots = [];
    for (let i = 0; i < 34; i++) {
      const x = rand(-52, 54);
      const z = rand(44, 94);
      // Не сажаем на пруду
      if (Math.hypot(x + 34, z - 74) < 17) continue;
      treeSpots.push([x, z]);
    }
    for (const [x, z] of treeSpots) {
      const h = rand(3.4, 5.5);
      this.addCyl(x, h / 2, z, 0.32, h, trunkMat, { seg: 7 });
      const crown = new THREE.Mesh(
        new THREE.IcosahedronGeometry(rand(1.7, 2.6), 0),
        Math.random() > 0.5 ? leafMat : leafMat2
      );
      crown.position.set(x, h + 0.9, z);
      crown.scale.y = 1.15;
      crown.castShadow = true;
      this.group.add(crown);
    }

    // Беседка
    const gazeboX = 22, gazeboZ = 76;
    const woodM = this._mat('tex_wood', [2, 1], 0xb98d5c);
    this.addBox(gazeboX, 1.6, gazeboZ, 7, 0.3, 7, woodM, { collider: false });
    for (const [dx, dz] of [[-3, -3], [3, -3], [-3, 3], [3, 3]]) {
      this.addBox(gazeboX + dx, 1.6, gazeboZ + dz, 0.35, 3.2, 0.35, woodM, { collider: false });
    }
    const roof = new THREE.Mesh(new THREE.ConeGeometry(5.6, 2.2, 4), this._flatMat(0x8a4b3a));
    roof.position.set(gazeboX, 4.2, gazeboZ);
    roof.rotation.y = Math.PI / 4;
    roof.castShadow = true;
    this.group.add(roof);
    // Пол беседки как коллайдер, чтобы не провалиться
    this._collider(gazeboX, 1.4, gazeboZ, 7, 0.4, 7, 0);
    // Пандус в беседку
    this._smallRamp(gazeboX - 5.4, gazeboZ, 1.6, 4);

    // Скамейки
    const benchM = this._mat('tex_wood', [1, 1], 0xa5763f);
    for (const [x, z, ry] of [[8, 58, 0], [-16, 66, 1.2], [-40, 52, -0.6], [40, 84, 2.4]]) {
      this.addBox(x, 0.45, z, 2.2, 0.15, 0.6, benchM, { ry, collider: false });
      this.addBox(x, 0.85, z - 0.3, 2.2, 0.6, 0.12, benchM, { ry, collider: false });
      this._collider(x, 0.4, z, 2.2, 0.9, 0.7, ry);
    }

    // Камни-укрытия
    const rockM = this._mat('tex_rock', [1, 1], 0x9a9184);
    for (const [x, z] of [[-8, 82], [30, 54], [-44, 90], [12, 92]]) {
      const s = rand(1.2, 2.2);
      const rock = new THREE.Mesh(new THREE.DodecahedronGeometry(s, 0), rockM);
      rock.position.set(x, s * 0.55, z);
      rock.rotation.set(rand(0, 3), rand(0, 3), rand(0, 3));
      rock.castShadow = rock.receiveShadow = true;
      this.group.add(rock);
      this._collider(x, s * 0.5, z, s * 1.5, s * 1.2, s * 1.5, 0);
    }
  }

  _smallRamp(x, z, height, len) {
    const mat = this._mat('tex_wood', [1, 2], 0xb08c5c);
    const angle = -Math.atan2(height, len);
    const ramp = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.25, Math.hypot(height, len)), mat);
    ramp.position.set(x, height / 2, z);
    ramp.rotation.x = angle;
    ramp.castShadow = ramp.receiveShadow = true;
    this.group.add(ramp);
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(angle, 0, 0));
    const body = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.fixed().setTranslation(x, height / 2, z)
        .setRotation({ x: q.x, y: q.y, z: q.z, w: q.w })
    );
    this.world.createCollider(RAPIER.ColliderDesc.cuboid(1.2, 0.13, Math.hypot(height, len) / 2).setFriction(0.85), body);
  }

  // ПРОМЗОНА: контейнеры, цистерны, кран (север)
  _industrial() {
    const contMats = [
      this._mat('tex_metal', [2, 1], C.containerA, { metalness: 0.4, roughness: 0.7 }),
      this._mat('tex_metal', [2, 1], C.containerB, { metalness: 0.4, roughness: 0.7 }),
      this._mat('tex_metal', [2, 1], C.containerC, { metalness: 0.4, roughness: 0.7 })
    ];

    // Штабеля контейнеров (2 яруса — лазейки сверху)
    const stacks = [
      [-64, -58, 0], [-52, -62, 1], [-36, -56, 0],
      [-68, -76, 1], [-40, -78, 0],
      [6, -60, 1], [22, -64, 0], [40, -58, 1],
      [10, -84, 0], [34, -80, 1], [58, -66, 0],
      [-10, -70, 1], [-70, -44, 0], [64, -84, 1]
    ];
    for (const [x, z, stacked] of stacks) {
      const ry = Math.random() > 0.5 ? 0 : Math.PI / 2;
      const w = 6, d = 2.5, h = 2.6;
      this.addBox(x, h / 2, z, w, h, d, pick(contMats), { ry });
      if (stacked) {
        const ry2 = ry + (Math.random() > 0.5 ? 0 : Math.PI / 2);
        this.addBox(x + rand(-0.4, 0.4), h + h / 2, z + rand(-0.4, 0.4), w, h, d, pick(contMats), { ry: ry2 });
      }
    }

    // Цистерны (горизонтальные)
    const tankM = this._mat('tex_metal', [3, 2], 0xcfd3d8, { metalness: 0.7, roughness: 0.35 });
    for (const [x, z] of [[-86, -70], [-86, -86], [76, -56]]) {
      const tank = new THREE.Mesh(new THREE.CylinderGeometry(2.4, 2.4, 9, 16), tankM);
      tank.rotation.z = Math.PI / 2;
      tank.position.set(x, 2.6, z);
      tank.castShadow = tank.receiveShadow = true;
      this.group.add(tank);
      this._collider(x, 2.6, z, 9, 4.8, 4.8, 0);
      // Опоры
      this.addBox(x - 3.5, 1, z, 0.6, 2, 3.6, this._flatMat(0x555a63), { collider: false });
      this.addBox(x + 3.5, 1, z, 0.6, 2, 3.6, this._flatMat(0x555a63), { collider: false });
    }

    // Гараж/склад
    const shedM = this._mat('tex_paint', [4, 2], 0x93a0ad);
    this.addBox(-24, 4, -88, 30, 8, 18, shedM);
    const shedRoof = new THREE.Mesh(new THREE.BoxGeometry(31, 0.6, 19), this._mat('tex_metal', [4, 4], 0x6f7784, { metalness: 0.6 }));
    shedRoof.position.set(-24, 8.3, -88);
    shedRoof.castShadow = true;
    this.group.add(shedRoof);
    // Ворота (тёмный проём)
    const door = new THREE.Mesh(new THREE.PlaneGeometry(8, 5), this._flatMat(0x1b2029));
    door.position.set(-24, 2.5, -78.9);
    this.group.add(door);

    // Кран-манипулятор
    const craneM = this._flatMat(0xe0b83c, { roughness: 0.6, metalness: 0.4 });
    this.addBox(60, 9, -90, 1.6, 18, 1.6, craneM);
    this.addBox(52, 17.5, -90, 18, 1.4, 1.4, craneM, { collider: false });
    this.addBox(44, 13, -90, 0.3, 8, 0.3, this._flatMat(0x33373d), { collider: false });
    this._collider(60, 9, -90, 1.6, 18, 1.6, 0);

    // Шины-баррикады
    const tireM = this._flatMat(0x1d1f24, { roughness: 1 });
    for (let i = 0; i < 16; i++) {
      const x = rand(-80, 80), z = rand(-92, -50);
      const t = new THREE.Mesh(new THREE.TorusGeometry(0.5, 0.22, 8, 14), tireM);
      t.rotation.x = Math.PI / 2;
      t.position.set(x, 0.25, z);
      t.castShadow = true;
      this.group.add(t);
      if (i % 3 === 0) this._collider(x, 0.3, z, 1.1, 0.6, 1.1, 0);
    }
  }

  // МЕТРО: лестница вниз, тоннель и платформа (запад, под землёй)
  _metro() {
    const wallM = this._mat('tex_concrete', [4, 3], 0x8f97a4);
    const floorM = this._mat('tex_concrete', [6, 6], 0x777e8a);
    const tileM = this._flatMat(0xd8dce4, { roughness: 0.4 });

    // Вход: стена с проёмом у западной границы, рядом с дорогой
    const ex = -92, ez = 8;
    // Входная группа (киоск-вход)
    this.addBox(ex + 4, 1.5, ez, 6, 3, 8, wallM);
    const sign = new THREE.Mesh(new THREE.PlaneGeometry(4, 1), new THREE.MeshStandardMaterial({
      color: 0x0f2f1c, emissive: 0x2fff8a, emissiveIntensity: 0.9, roughness: 0.4
    }));
    sign.position.set(ex + 7.1, 2.4, ez);
    sign.rotation.y = Math.PI / 2;
    this.group.add(sign);

    // Лестница вниз (серия ступеней) — ведёт на y=-7
    const depth = 7;
    const steps = 14;
    const stepD = 1.4;
    const startX = -86;
    for (let i = 0; i < steps; i++) {
      const y = -(depth * (i + 0.5)) / steps;
      const x = startX - i * stepD;
      this.addBox(x, y - 0.25, ez, stepD, 0.5, 5, tileM, { collider: true, castShadow: false });
    }

    // Тоннель
    const tunLen = 30;
    const tunX = startX - steps * stepD - tunLen / 2;
    // Пол
    this.addBox(tunX, -depth - 0.25, ez, tunLen, 0.5, 7, floorM, { collider: true, castShadow: false });
    // Потолок
    this.addBox(tunX, -depth + 3.4, ez, tunLen, 0.5, 7, floorM, { collider: true, castShadow: false });
    // Стены
    this.addBox(tunX, -depth + 1.5, ez - 4, tunLen, 4, 0.6, wallM, { collider: true, castShadow: false });
    this.addBox(tunX, -depth + 1.5, ez + 4, tunLen, 4, 0.6, wallM, { collider: true, castShadow: false });

    // Платформа (расширение)
    const platX = tunX - 16;
    this.addBox(platX - 4, -depth - 0.25, ez, 12, 0.5, 16, floorM, { collider: true, castShadow: false });
    this.addBox(platX - 4, -depth + 3.4, ez - 6.5, 14, 4, 0.6, wallM, { collider: true, castShadow: false });
    // Колонны платформы
    for (let i = -1; i <= 1; i++) {
      this.addBox(platX - 4 + i * 4, -depth + 1.5, ez, 0.7, 3.6, 0.7, this._flatMat(0x4a5160), { collider: true });
    }
    // Свет на платформе
    const lamp = new THREE.PointLight(0xfff0c0, 22, 26, 2);
    lamp.position.set(platX - 4, -depth + 2.6, ez);
    this.group.add(lamp);
    const lamp2 = new THREE.PointLight(0xcfe4ff, 16, 22, 2);
    lamp2.position.set(tunX, -depth + 2.6, ez);
    this.group.add(lamp2);

    // Тыл: безопасная точка возрождения в тоннеле
    this.spawns.a.push(new THREE.Vector3(platX - 4, -depth + 1.2, ez));

    // Поезд-укрытие на путях (глубина)
    const trainM = this._mat('tex_metal', [4, 2], 0x3f6ea8, { metalness: 0.6, roughness: 0.4 });
    this.addBox(tunX - 6, -depth + 1.1, ez, 14, 2.6, 2.6, trainM, { collider: true, castShadow: false });
  }

  // КРЫШИ: верхний ярус — контейнерный «мост» и снайперские точки
  _rooftops() {
    // Уже частично сделано пандусами к зданиям. Добавим мост между двумя крышами
    const bridgeMat = this._mat('tex_metal', [3, 1], 0x8b93a1, { metalness: 0.5, roughness: 0.6 });
    // Здания в городе имеют крыши на высоте floors*3.2; мостим пару высоких
    const h1 = 5 * 3.2; // ~16
    const b = this.addBox(40, h1 + 0.6, 23, 26, 0.5, 3, bridgeMat, { collider: true, castShadow: true });
    b.position.set(40, h1 + 0.6, 23);

    // Антенны на крышах (декор + укрытие)
    const antM = this._flatMat(0xb94040, { roughness: 0.6 });
    for (const [x, y, z] of [[22, 17, 22], [-46, 14, -30], [88, 20, 20], [58, 11, -26]]) {
      this.addBox(x, y + 2, z, 0.2, 4, 0.2, antM, { collider: false });
      this.addBox(x, y + 3.6, z, 1.4, 0.16, 0.16, antM, { collider: false, castShadow: false });
    }
  }

  // Ограждение по периметру
  _boundary() {
    const m = this._flatMat(0x4b5261, { roughness: 0.9 });
    const t = 2, h = 6;
    this.addBox(0, h / 2, -HALF - t / 2, CONFIG.MAP_SIZE + 8, h, t, m, { castShadow: false });
    this.addBox(0, h / 2, HALF + t / 2, CONFIG.MAP_SIZE + 8, h, t, m, { castShadow: false });
    this.addBox(-HALF - t / 2, h / 2, 0, t, h, CONFIG.MAP_SIZE + 8, m, { castShadow: false });
    this.addBox(HALF + t / 2, h / 2, 0, t, h, CONFIG.MAP_SIZE + 8, m, { castShadow: false });
  }

  // Точки возрождения: по 8 на команду, на противоположных сторонах
  _spawns() {
    const aSpots = [
      [-88, 20], [-84, -8], [-70, 44], [-88, 60], [-72, -40], [-86, -60], [-64, 74], [-90, -30]
    ];
    const bSpots = [
      [88, -20], [84, 8], [70, -44], [88, -60], [72, 40], [86, 60], [64, -74], [90, 30]
    ];
    for (const [x, z] of aSpots) this.spawns.a.push(new THREE.Vector3(x, 1.2, z));
    for (const [x, z] of bSpots) this.spawns.b.push(new THREE.Vector3(x, 1.2, z));
    // Дополнительно: тоннель метро как укрытие-спавн для A
    this.spawns.a.push(new THREE.Vector3(-96, 1.2, 40));
    this.spawns.b.push(new THREE.Vector3(96, 1.2, -40));
  }

  // Декор: фонари, урны, указатели
  _decor() {
    const poleM = this._flatMat(0x3a4150, { metalness: 0.6, roughness: 0.5 });
    const lampGeo = new THREE.SphereGeometry(0.35, 8, 6);
    const lampMat = new THREE.MeshStandardMaterial({
      color: 0xfff3d0, emissive: 0xffd88a, emissiveIntensity: 1.4, roughness: 0.3
    });
    const lightXZ = [
      [6, 10], [-24, 10], [40, 10], [-60, 10], [6, -10], [-24, -10],
      [-40, 50], [20, 56], [-40, -50], [30, -46]
    ];
    let lights = 0;
    for (const [x, z] of lightXZ) {
      this.addCyl(x, 2.4, z, 0.12, 4.8, poleM, { seg: 6, collider: true });
      const head = new THREE.Mesh(lampGeo, lampMat);
      head.position.set(x, 4.9, z);
      this.group.add(head);
      // Максимум 4 активных источника света на мобильных
      if (lights < (this.quality?.lightCount ?? 3)) {
        const pl = new THREE.PointLight(0xffd9a0, 8, 22, 2);
        pl.position.set(x, 4.7, z);
        this.group.add(pl);
        lights++;
      }
    }

    // Указатели режимов у баз
    const mk = (x, z, color, rx = 0) => {
      const g = new THREE.Group();
      const p = new THREE.Mesh(new THREE.BoxGeometry(0.15, 3, 0.15), poleM);
      p.position.y = 1.5;
      const b = new THREE.Mesh(new THREE.BoxGeometry(1.8, 1, 0.1),
        new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.55, roughness: 0.5 }));
      b.position.y = 3;
      g.add(p, b);
      g.position.set(x, 0, z);
      g.rotation.y = rx;
      this.group.add(g);
      this._collider(x, 1.5, z, 0.4, 3, 0.4, 0);
    };
    mk(-84, 0, 0x43d9ff);
    mk(84, 0, 0xff4d5e, Math.PI);
    mk(0, -46, 0xffd54a);
  }

  /** Безопасная точка возрождения для команды (с наименьшим числом врагов рядом) */
  spawnForTeam(team, enemies = []) {
    const list = this.spawns[team] || this.spawns.a;
    let best = list[0], bestScore = -Infinity;
    for (const p of list) {
      let score = Math.random() * 10;
      for (const e of enemies) {
        const d = p.distanceTo(e);
        score += Math.min(d, 40);
      }
      if (score > bestScore) { bestScore = score; best = p; }
    }
    return best.clone();
  }

  /** Есть ли прямая видимость между точками (для ИИ/гранат) */
  hasLineOfSight(from, to) {
    const dir = to.clone().sub(from);
    const dist = dir.length();
    if (dist < 0.001) return true;
    dir.normalize();
    const ray = new RAPIER.Ray(
      { x: from.x, y: from.y, z: from.z },
      { x: dir.x, y: dir.y, z: dir.z }
    );
    const hit = this.world.castRay(ray, dist, true);
    return !hit;
  }

  dispose() {
    this.group.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) {
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        mats.forEach((m) => m.dispose());
      }
    });
    this.scene.remove(this.group);
  }
}

/** Кватернион из yaw (вокруг Y) — для Rapier */
function quatFromYaw(yaw) {
  const half = yaw / 2;
  return { x: 0, y: Math.sin(half), z: 0, w: Math.cos(half) };
}

/** Точка сбора: создаёт и строит карту */
export function buildMap(scene, world, assets, quality) {
  const map = new GameMap(scene, world, assets, quality);
  return map.build();
}
