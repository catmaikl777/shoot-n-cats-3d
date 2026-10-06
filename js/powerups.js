// ============================================================
// powerups.js — бонусы: HP, скорострел, щит, рикошет, самонаведение
// Спавн в фиксированных точках каждые 30 сек, подбор + сетевое событие
// ============================================================

import * as THREE from 'three';
import { CONFIG, clamp, EV } from './utils.js';

export const POWERUP_TYPES = {
  hp:      { label: '+25 HP',   color: 0x5eff8a, icon: '＋' },
  speed:   { label: 'Скорострел', color: 0x43d9ff, icon: '»' },
  shield:  { label: 'Щит 50',   color: 0xffd54a, icon: '◈' },
  ricochet:{ label: 'Рикошет',  color: 0xff8a3d, icon: '↗' },
  homing:  { label: 'Самонаведение', color: 0xff5ad9, icon: '◎' }
};

const TYPE_KEYS = Object.keys(POWERUP_TYPES);
const RESPAWN_TIME = 30;

export class Powerups {
  constructor({ scene, map, audio, net }) {
    this.scene = scene;
    this.map = map;
    this.audio = audio;
    this.net = net;

    this.local = null;

    /** Точки спавна (заполняются buildPowerups) */
    this.nodes = [];
    /** Фиксированные позиции на карте */
    this.spots = [
      { x: 0, z: 0 },        // центр — перекрёсток
      { x: -44, z: 66 },     // парк
      { x: 40, z: -60 },     // промзона
      { x: -70, z: -30 },    // запад
      { x: 70, z: 30 },      // восток
      { x: -84, z: 8 },      // метро
      { x: 22, z: 24 },      // город
      { x: 0, z: -46 }       // точка доставки корма
    ];

    this._t = 0;
    this._built = false;
  }

  /** Создать визуалы всех точек */
  build() {
    if (this._built) return;
    this._built = true;

    this.spots.forEach((s, i) => {
      const type = TYPE_KEYS[i % TYPE_KEYS.length];
      const def = POWERUP_TYPES[type];

      const group = new THREE.Group();
      group.position.set(s.x, 1.1, s.z);

      // Подставка
      const pad = new THREE.Mesh(
        new THREE.CylinderGeometry(0.7, 0.85, 0.2, 12),
        new THREE.MeshStandardMaterial({ color: 0x2a3550, roughness: 0.7, metalness: 0.3 })
      );
      pad.position.y = -1.0;
      pad.receiveShadow = true;
      group.add(pad);

      // Светящийся столб
      const beam = new THREE.Mesh(
        new THREE.CylinderGeometry(0.45, 0.45, 2, 12, 1, true),
        new THREE.MeshBasicMaterial({
          color: def.color, transparent: true, opacity: 0.16,
          side: THREE.DoubleSide, depthWrite: false
        })
      );
      group.add(beam);

      // Иконка-форма (разная для типа)
      const iconMat = new THREE.MeshStandardMaterial({
        color: def.color, emissive: def.color, emissiveIntensity: 0.85,
        roughness: 0.3, metalness: 0.4
      });
      let iconGeo;
      switch (type) {
        case 'hp':       iconGeo = new THREE.OctahedronGeometry(0.4, 0); break;
        case 'speed':    iconGeo = new THREE.ConeGeometry(0.38, 0.7, 6); break;
        case 'shield':   iconGeo = new THREE.IcosahedronGeometry(0.4, 0); break;
        case 'ricochet': iconGeo = new THREE.TetrahedronGeometry(0.45, 0); break;
        default:         iconGeo = new THREE.TorusGeometry(0.34, 0.14, 8, 16); break;
      }
      const icon = new THREE.Mesh(iconGeo, iconMat);
      group.add(icon);

      this.scene.add(group);
      this.nodes.push({ type, group, icon, active: true, cooldown: 0, id: i });
    });

    console.log(`[Powerups] создано точек: ${this.nodes.length}`);
  }

  update(dt) {
    this._t += dt;
    const now = performance.now() * 0.001;

    for (const n of this.nodes) {
      if (n.active) {
        // Вращение и парение
        n.icon.rotation.y = now * 1.6 + n.id;
        n.icon.rotation.x = Math.sin(now * 1.2 + n.id) * 0.4;
        n.icon.position.y = Math.sin(now * 2 + n.id) * 0.18;
        n.group.visible = true;
      } else {
        n.cooldown -= dt;
        n.group.visible = false;
        if (n.cooldown <= 0) {
          n.active = true;
          n.group.visible = true;
        }
      }
    }

    // Проверка подбора локальным игроком
    const p = this.local;
    if (p && p.alive) {
      for (const n of this.nodes) {
        if (!n.active) continue;
        const dx = p.position.x - n.group.position.x;
        const dz = p.position.z - n.group.position.z;
        const dy = p.position.y - n.group.position.y;
        if (dx * dx + dz * dz < 2.1 * 2.1 && Math.abs(dy) < 2.2) {
          this._collectLocal(n);
        }
      }
    }
  }

  _collectLocal(n) {
    const p = this.local;
    if (!p) return;

    const applied = this.applyEffect(n.type, p);
    if (!applied) return; // нечего брать (например, полное HP)

    n.active = false;
    n.cooldown = RESPAWN_TIME;
    this.audio?.play('pickup');
    window.__snc?.ui?.toast?.(POWERUP_TYPES[n.type].label);

    this.net?.raise(EV.POWERUP, { id: n.id, t: n.type, by: p.actorNr }, true);
  }

  /**
   * Применить эффект к игроку (локальному или удалённому — у обоих один API).
   * @returns {boolean} был ли подбор полезен
   */
  applyEffect(type, player) {
    switch (type) {
      case 'hp': {
        if (player.hp >= CONFIG.MAX_HP) return false;
        player.hp = Math.min(CONFIG.MAX_HP, player.hp + 25);
        return true;
      }
      case 'speed':
        player.buffs.speed = 10;
        return true;
      case 'shield':
        if (player.shield >= CONFIG.SHIELD_MAX) return false;
        player.shield = Math.min(CONFIG.SHIELD_MAX, (player.shield || 0) + CONFIG.SHIELD_MAX);
        return true;
      case 'ricochet':
        player.buffs.ricochet = 10;
        return true;
      case 'homing':
        player.buffs.homing = 5;
        return true;
      default:
        return false;
    }
  }

  /** Событие: кто-то (не мы) подобрал бонус */
  onRemotePickup(actorNr, content) {
    const n = this.nodes.find((x) => x.id === content.id);
    if (!n) return;
    n.active = false;
    n.cooldown = RESPAWN_TIME;
    const rp = window.__snc?.remotes?.get?.(actorNr);
    if (rp) this.applyEffect(content.t, rp);
    this.audio?.play('pickup_far');
  }

  clear() {
    for (const n of this.nodes) {
      this.scene.remove(n.group);
      n.group.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) o.material.dispose();
      });
    }
    this.nodes.length = 0;
    this._built = false;
  }
}
