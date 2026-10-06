// ============================================================
// grenades.js — гранаты: физика отскока (Rapier), таймер,
// радиус урона, взрывные эффекты, сетевые события
// ============================================================

import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { CONFIG, clamp, EV, rand } from './utils.js';

const NADE_R = 0.16;      // радиус модели/коллайдера
const NADE_SPEED = 14;    // базовая скорость броска

export class Grenades {
  constructor({ scene, world, map, audio, net }) {
    this.scene = scene;
    this.world = world;
    this.map = map;
    this.audio = audio;
    this.net = net;

    this.local = null;
    this.remotes = null;

    this.list = [];   // { mesh, body, fuse, owner, remote }

    // Геометрия/материал общие
    this.geo = new THREE.SphereGeometry(NADE_R, 10, 8);
    this.mat = new THREE.MeshStandardMaterial({
      color: 0x4a5d3a, roughness: 0.6, metalness: 0.35,
      emissive: 0x113311, emissiveIntensity: 0.3
    });

    // Эффекты взрыва
    this.explosions = [];
    this._flashGeo = new THREE.SphereGeometry(1, 14, 10);
    this._flashMat = new THREE.MeshBasicMaterial({
      color: 0xffbb55, transparent: true, opacity: 0.9, depthWrite: false
    });
    this._light = new THREE.PointLight(0xffaa44, 0, 26, 2);
    scene.add(this._light);
  }

  /** Бросок локальным игроком. params: {origin, dir, power} */
  throwLocal(params) {
    if (!params || !this.local) return false;
    if (this.local.grenades <= 0 || this.local.nadeCd > 0) return false;

    const info = this.local.throwGrenade(params.power);
    if (!info) return false;

    const dir = info.dir.clone().normalize();
    const speed = NADE_SPEED * (0.45 + info.power * 0.75);

    this._spawn({
      origin: info.origin,
      velocity: { x: dir.x * speed, y: dir.y * speed + 3.5, z: dir.z * speed },
      owner: this.local.actorNr,
      remote: false
    });

    this.net?.raise(EV.NADE, {
      x: +info.origin.x.toFixed(2),
      y: +info.origin.y.toFixed(2),
      z: +info.origin.z.toFixed(2),
      vx: +(dir.x * speed).toFixed(2),
      vy: +(dir.y * speed + 3.5).toFixed(2),
      vz: +(dir.z * speed).toFixed(2)
    }, true);

    this.audio?.play('nade_throw');
    return true;
  }

  /** Бросок удалённого игрока (событие EV.NADE) */
  onRemoteThrow(actorNr, data) {
    this._spawn({
      origin: { x: data.x, y: data.y, z: data.z },
      velocity: { x: data.vx, y: data.vy, z: data.vz },
      owner: actorNr,
      remote: true
    });
  }

  _spawn({ origin, velocity, owner, remote }) {
    const body = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(origin.x, origin.y, origin.z)
        .setLinvel(velocity.x, velocity.y, velocity.z)
        .setCcdEnabled(true)
        .setLinearDamping(0.15)
        .setAngularDamping(0.4)
    );
    this.world.createCollider(
      RAPIER.ColliderDesc.ball(NADE_R)
        .setRestitution(0.55)     // отскок
        .setFriction(0.7),
      body
    );

    const mesh = new THREE.Mesh(this.geo, this.mat.clone());
    mesh.castShadow = true;
    mesh.position.set(origin.x, origin.y, origin.z);
    this.scene.add(mesh);

    this.list.push({ mesh, body, fuse: CONFIG.NADE_FUSE, owner, remote, exploded: false });
  }

  update(dt) {
    for (let i = this.list.length - 1; i >= 0; i--) {
      const g = this.list[i];
      g.fuse -= dt;

      const t = g.body.translation();
      g.mesh.position.set(t.x, t.y, t.z);
      // Вращение для наглядности
      g.mesh.rotation.x += dt * 6;
      g.mesh.rotation.y += dt * 9;
      // Мигание перед взрывом
      const blink = g.fuse < 0.8 ? (Math.sin(g.fuse * 30) > 0 ? 1.4 : 0.6) : 0.3;
      g.mesh.material.emissiveIntensity = blink;

      if (g.fuse <= 0) {
        this._explode(g);
        this.world.removeRigidBody(g.body);
        this.scene.remove(g.mesh);
        g.mesh.material.dispose();
        this.list.splice(i, 1);
      }
    }

    // Обновление взрывов
    for (let i = this.explosions.length - 1; i >= 0; i--) {
      const e = this.explosions[i];
      e.life -= dt;
      const k = 1 - e.life / e.max;
      e.mesh.scale.setScalar(0.5 + k * 5.5);
      e.mesh.material.opacity = Math.max(0, 0.9 * (1 - k));
      if (e.life <= 0) {
        this.scene.remove(e.mesh);
        e.mesh.material.dispose();
        this.explosions.splice(i, 1);
      }
    }

    if (this._light.intensity > 0) {
      this._light.intensity = Math.max(0, this._light.intensity - dt * 400);
    }
  }

  _explode(g) {
    if (g.exploded) return;
    g.exploded = true;
    const pos = g.mesh.position.clone();

    // Эффект
    const mesh = new THREE.Mesh(this._flashGeo, this._flashMat.clone());
    mesh.position.copy(pos);
    mesh.scale.setScalar(0.5);
    this.scene.add(mesh);
    this.explosions.push({ mesh, life: 0.45, max: 0.45 });
    this._light.position.copy(pos);
    this._light.intensity = 60;
    this.audio?.play('explode');
    if (navigator.vibrate && !g.remote) navigator.vibrate(60);

    // Урон: считаем для локального игрока и для удалённых
    const R = CONFIG.NADE_RADIUS;
    const maxDmg = CONFIG.NADE_DAMAGE_MAX;

    // Своя граната — вредим тем, кого видим (клиент-авторитетно)
    if (!g.remote && this.remotes) {
      for (const rp of this.remotes.map.values()) {
        if (!rp.alive) continue;
        if (rp.team === this.local?.team) continue;
        const d = rp.group.position.distanceTo(pos);
        if (d > R) continue;
        // Проверка, не за стеной ли цель
        if (this.map?.hasLineOfSight(pos, rp.group.position.clone().setY(pos.y))) {
          const dmg = Math.round(maxDmg * (1 - d / R));
          if (dmg <= 0) continue;
          rp.hp = Math.max(0, rp.hp - dmg);
          this.net?.raise(EV.HIT, { to: rp.actorNr, from: g.owner, dmg, hs: 0 }, true);
        }
      }
    }

    // Любая граната может ранить локального игрока
    if (this.local && this.local.alive) {
      const d = this.local.position.distanceTo(pos);
      if (d <= R) {
        const dmg = Math.round(maxDmg * (1 - d / R) * (g.owner === this.local.actorNr ? 0.6 : 1));
        if (dmg > 0) {
          const died = this.local.takeDamage(dmg, { source: g.owner });
          this.audio?.play('hurt');
          window.__snc?.ui?.damageFlash?.();
          if (died) {
            this.net?.raise(EV.DEATH, { killer: g.owner, victim: this.local.actorNr, hs: 0 }, true);
            this.audio?.play('death');
          }
        }
      }
    }
  }

  /** Сброс при выходе из комнаты */
  clear() {
    for (const g of this.list) {
      this.world.removeRigidBody(g.body);
      this.scene.remove(g.mesh);
      g.mesh.material.dispose();
    }
    this.list.length = 0;
    for (const e of this.explosions) this.scene.remove(e.mesh);
    this.explosions.length = 0;
    this._light.intensity = 0;
  }
}
