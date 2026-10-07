// ============================================================
// modes.js — три режима игры:
//   1) Команда A vs Команда B (фраги, 5 минут)
//   2) Царь горы (захват точки, 200 очков)
//   3) Доставка корма (мячи корма на свою базу, 5 штук)
// ============================================================

import * as THREE from 'three';
import { CONFIG, EV, formatTime, clamp } from './utils.js';

export const MODE_INFO = {
  team:     { label: 'Команда A vs Команда B', short: 'Команды' },
  king:     { label: 'Царь горы',              short: 'Царь горы' },
  delivery: { label: 'Доставка корма',         short: 'Доставка' }
};

const KING_RADIUS = 6;      // радиус захвата
const KING_TICK = 1;        // очки раз в секунду
const BALL_COUNT = 3;       // мячей корма на карте
const CARRY_OFFSET = new THREE.Vector3(0, 1.9, 0);

export class Modes {
  constructor({ scene, map, net, local, remotes, ui, audio }) {
    this.scene = scene;
    this.map = map;
    this.net = net;
    this.local = local;
    this.remotes = remotes;
    this.ui = ui;
    this.audio = audio;

    this.mode = 'team';
    this.running = false;
    this.timeLeft = CONFIG.MATCH_TIME;
    this.finished = false;

    // Командные очки
    this.score = { a: 0, b: 0 };

    // Царь горы
    this.kingOwner = null;   // 'a' | 'b' | null
    this.kingProgress = 0;   // -1..1 (в сторону B / A)
    this.kingMesh = null;

    // Доставка корма
    this.balls = [];
    this.carrier = null;     // actorNr с мячом
    this.goalCount = { a: 0, b: 0 };

    this._tickAcc = 0;
    this._netAcc = 0;

    /** Функция строк таблицы очков (подключает main.js) */
    this.rowsFn = null;
  }

  // ----------------------------------------------------------
  // Настройка и запуск
  // ----------------------------------------------------------
  setMode(mode) {
    this.mode = MODE_INFO[mode] ? mode : 'team';
    console.log(`[Modes] режим: ${this.mode}`);
  }

  start() {
    this.timeLeft = CONFIG.MATCH_TIME;
    this.score = { a: 0, b: 0 };
    this.goalCount = { a: 0, b: 0 };
    this.kingOwner = null;
    this.kingProgress = 0;
    this.finished = false;
    this.running = true;
    this._buildObjective();
    this.ui?.setModeLabel?.(MODE_INFO[this.mode].label);
  }

  stop() {
    this.running = false;
    this._clearObjective();
  }

  reset() {
    this.stop();
    this.timeLeft = CONFIG.MATCH_TIME;
    this.score = { a: 0, b: 0 };
    this.goalCount = { a: 0, b: 0 };
    this.carrier = null;
  }

  // ----------------------------------------------------------
  // Визуал целей
  // ----------------------------------------------------------
  _buildObjective() {
    this._clearObjective();

    if (this.mode === 'king') {
      const p = this.map.points.king;
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(KING_RADIUS - 0.5, KING_RADIUS, 40),
        new THREE.MeshBasicMaterial({
          color: 0xffffff, transparent: true, opacity: 0.55,
          side: THREE.DoubleSide, depthWrite: false
        })
      );
      ring.rotation.x = -Math.PI / 2;
      ring.position.set(p.x, 0.12, p.z);
      this.scene.add(ring);

      const disc = new THREE.Mesh(
        new THREE.CircleGeometry(KING_RADIUS, 40),
        new THREE.MeshBasicMaterial({
          color: 0x888888, transparent: true, opacity: 0.16,
          side: THREE.DoubleSide, depthWrite: false
        })
      );
      disc.rotation.x = -Math.PI / 2;
      disc.position.set(p.x, 0.1, p.z);
      this.scene.add(disc);

      this.kingMesh = { ring, disc };
    }

    if (this.mode === 'delivery') {
      const p = this.map.points.deliveryNeutral;
      for (let i = 0; i < BALL_COUNT; i++) {
        const angle = (i / BALL_COUNT) * Math.PI * 2;
        const pos = new THREE.Vector3(
          p.x + Math.cos(angle) * 3,
          0.8,
          p.z + Math.sin(angle) * 3
        );
        const ball = new THREE.Mesh(
          new THREE.SphereGeometry(0.55, 14, 12),
          new THREE.MeshStandardMaterial({
            color: 0xffb347, emissive: 0x8a4a10, emissiveIntensity: 0.5,
            roughness: 0.5, metalness: 0.1
          })
        );
        ball.castShadow = true;
        ball.position.copy(pos);
        this.scene.add(ball);
        this.balls.push({
          mesh: ball, home: pos.clone(),
          state: 'free',      // free | carried | scored
          carrier: null
        });
      }
    }
  }

  _clearObjective() {
    if (this.kingMesh) {
      this.scene.remove(this.kingMesh.ring, this.kingMesh.disc);
      this.kingMesh.ring.geometry.dispose();
      this.kingMesh.ring.material.dispose();
      this.kingMesh.disc.geometry.dispose();
      this.kingMesh.disc.material.dispose();
      this.kingMesh = null;
    }
    for (const b of this.balls) {
      this.scene.remove(b.mesh);
      b.mesh.geometry.dispose();
      b.mesh.material.dispose();
    }
    this.balls.length = 0;
  }

  // ----------------------------------------------------------
  // Основной тик
  // ----------------------------------------------------------
  update(dt) {
    if (!this.running || this.finished) return;

    this.timeLeft -= dt;
    if (this.timeLeft <= 0) {
      this.timeLeft = 0;
      this._finish();
      return;
    }

    if (this.mode === 'king') this._updateKing(dt);
    if (this.mode === 'delivery') this._updateDelivery(dt);

    // HUD раз в 0.2 с
    this._tickAcc += dt;
    if (this._tickAcc >= 0.2) {
      this._tickAcc = 0;
      this.ui?.setTimer?.(formatTime(this.timeLeft));
      this.ui?.setObjective?.(this._objectiveText());
      this.ui?.setTeamScore?.(this.score.a, this.score.b);
    }
  }

  // ----------------------------------------------------------
  // ЦАРЬ ГОРЫ
  // ----------------------------------------------------------
  _updateKing(dt) {
    const c = this.map.points.king;
    const inside = { a: 0, b: 0 };

    const count = (pos, team) => {
      if (!pos) return;
      if (Math.hypot(pos.x - c.x, pos.z - c.z) <= KING_RADIUS) inside[team]++;
    };

    // Локальный игрок
    if (this.local?.alive) count(this.local.position, this.local.team);
    // Удалённые
    for (const rp of this.remotes.map.values()) {
      if (rp.alive) count(rp.group.position, rp.team);
    }

    const aIn = inside.a > 0 && inside.b === 0;
    const bIn = inside.b > 0 && inside.a === 0;
    const contested = inside.a > 0 && inside.b > 0;

    // Движение прогресса захвата: -1 (полностью A) .. +1 (полностью B)
    if (aIn && !contested) this.kingProgress = clamp(this.kingProgress - dt * 0.5, -1, 1);
    if (bIn && !contested) this.kingProgress = clamp(this.kingProgress + dt * 0.5, -1, 1);

    if (this.kingProgress <= -1) this.kingOwner = 'a';
    else if (this.kingProgress >= 1) this.kingOwner = 'b';
    else if (Math.abs(this.kingProgress) < 0.15) this.kingOwner = null;

    // Очки капают владельцу точки
    if (this.kingOwner && !contested) {
      this._tickAcc += 0; // (таймер HUD отдельный)
      this._netAcc += dt;
      if (this._netAcc >= KING_TICK) {
        this._netAcc = 0;
        this.score[this.kingOwner] += 5;
        if (this.score[this.kingOwner] >= CONFIG.KING_SCORE) this._finish();
      }
    }

    // Визуал
    if (this.kingMesh) {
      const col = this.kingOwner === 'a' ? 0x43d9ff
        : this.kingOwner === 'b' ? 0xff4d5e
        : contested ? 0xffd54a : 0xffffff;
      this.kingMesh.ring.material.color.setHex(col);
      this.kingMesh.disc.material.color.setHex(col);
      const t = performance.now() * 0.002;
      this.kingMesh.ring.material.opacity = 0.45 + Math.sin(t) * 0.15;
      this.kingMesh.ring.rotation.z += dt * 0.4;
    }
  }

  // ----------------------------------------------------------
  // ДОСТАВКА КОРМА
  // ----------------------------------------------------------
  _updateDelivery(dt) {
    const carriers = new Map();

    // Сначала — сетевые события (pickup/goal) приходят через onNet.
    // Здесь — визуал мячей и проверка подбора, если мяч свободен.
    for (const b of this.balls) {
      if (b.state === 'free') {
        b.mesh.position.copy(b.home);
        b.mesh.rotation.y += dt * 2;

        // Подбор локальным игроком
        const p = this.local;
        if (p && p.alive && this.carrier === null) {
          if (p.position.distanceTo(b.home) < 1.8) {
            b.state = 'carried';
            b.carrier = p.actorNr;
            this.carrier = p.actorNr;
            this.net?.raise(EV.MODE, { t: 'pickup', ball: this.balls.indexOf(b), player: p.actorNr }, true);
            this.audio?.play('pickup');
            this.ui?.toast?.('Мяч корма взят! Отнеси на базу');
          }
        }
      } else if (b.state === 'carried') {
        // Мяч следует за носителем
        const holder = this._actorPos(b.carrier);
        if (holder) {
          b.mesh.position.copy(holder).add(CARRY_OFFSET);
          b.mesh.rotation.x += dt * 3;
        } else if (b.carrier !== null) {
          // Носитель пропал — мяч возвращается домой
          this._freeBall(this.balls.indexOf(b), false);
        }
      } else if (b.state === 'scored') {
        b.mesh.visible = false;
      }
    }

    // Проверка доставки на свою базу
    if (this.carrier !== null) {
      const holder = this._actorPos(this.carrier);
      const team = this._actorTeam(this.carrier);
      if (holder && team) {
        const base = team === 'a' ? this.map.points.baseA : this.map.points.baseB;
        if (Math.hypot(holder.x - base.x, holder.z - base.z) < 5) {
          const ballIdx = this.balls.findIndex((x) => x.carrier === this.carrier);
          if (ballIdx >= 0) {
            this.balls[ballIdx].state = 'scored';
            this.goalCount[team]++;
            this.score[team] = this.goalCount[team];
            this.carrier = null;
            this.audio?.play('goal');
            this.ui?.toast?.(`ГОЛ! ${team.toUpperCase()} → ${this.goalCount[team]}`);
            this.net?.raise(EV.MODE, { t: 'goal', team, ball: ballIdx }, true);
            if (this.goalCount[team] >= CONFIG.DELIVERY_TARGET) this._finish();
            // Через 4 сек мяч снова появляется на нейтральной точке
            setTimeout(() => this._freeBall(ballIdx, true), 4000);
          }
        }
      }
    }
  }

  _freeBall(idx, reset) {
    const b = this.balls[idx];
    if (!b) return;
    b.state = 'free';
    b.carrier = null;
    b.mesh.visible = true;
    if (reset) b.mesh.position.copy(b.home);
    if (this.carrier !== null) {
      const holder = this.balls.find((x) => x.carrier === this.carrier);
      if (!holder) this.carrier = null;
    }
  }

  _actorPos(actorNr) {
    if (actorNr === this.local?.actorNr) return this.local.position;
    const rp = this.remotes.get(actorNr);
    return rp ? rp.group.position : null;
  }

  _actorTeam(actorNr) {
    if (actorNr === this.local?.actorNr) return this.local.team;
    const rp = this.remotes.get(actorNr);
    return rp ? rp.team : null;
  }

  // ----------------------------------------------------------
  // События
  // ----------------------------------------------------------
  /** Выстрел-убийство (из photon_handlers) */
  onKill(killer) {
    if (this.mode === 'team') {
      if (killer?.team) {
        this.score[killer.team] += 1;
        if (this.score[killer.team] >= CONFIG.FRAG_LIMIT_TEAM ||
            this.score.a >= CONFIG.FRAG_LIMIT_TEAM ||
            this.score.b >= CONFIG.FRAG_LIMIT_TEAM) {
          this._finish();
        }
      }
    }
    this.ui?.setTeamScore?.(this.score.a, this.score.b);
  }

  onPlayerJoin() { this.ui?.updateScoreboard?.(); }
  onPlayerLeave() { this.ui?.updateScoreboard?.(); }

  /** Входящие события режима (pickup/goal/…) */
  onNet(content, actorNr) {
    if (!content) return;
    switch (content.t) {
      case 'pickup': {
        const b = this.balls[content.ball];
        if (!b) break;
        b.state = 'carried';
        b.carrier = content.player;
        this.carrier = content.player;
        if (content.player !== this.local?.actorNr) {
          const rp = this.remotes.get(content.player);
          this.ui?.toast?.(`${rp?.name || 'Кот'} взял мяч корма`);
        }
        break;
      }
      case 'goal': {
        this.goalCount[content.team] = Math.max(
          this.goalCount[content.team],
          this.goalCount[content.team] + 1
        );
        this.score[content.team] = this.goalCount[content.team];
        if (this.carrier !== null && this._actorTeam(this.carrier) === content.team) {
          this.carrier = null;
        }
        const b = this.balls[content.ball];
        if (b) {
          b.state = 'scored';
          b.carrier = null;
          b.mesh.visible = false;
          setTimeout(() => this._freeBall(content.ball, true), 4000);
        }
        this.ui?.setObjective?.(this._objectiveText());
        if (this.goalCount[content.team] >= CONFIG.DELIVERY_TARGET) this._finish();
        break;
      }
      default:
        break;
    }
  }

  // ----------------------------------------------------------
  // Итоги
  // ----------------------------------------------------------
  _objectiveText() {
    switch (this.mode) {
      case 'king':
        return `Царь горы — ${this.score.a}:${this.score.b} (до ${CONFIG.KING_SCORE})`;
      case 'delivery':
        return `Корм: ${this.goalCount.a}:${this.goalCount.b} (до ${CONFIG.DELIVERY_TARGET})`;
      default:
        return `Фраги: ${this.score.a}:${this.score.b}`;
    }
  }

  _finish() {
    if (this.finished) return;
    this.finished = true;
    this.running = false;

    let winner = null;
    if (this.mode === 'delivery') {
      winner = this.goalCount.a === this.goalCount.b ? null
        : this.goalCount.a > this.goalCount.b ? 'a' : 'b';
    } else {
      winner = this.score.a === this.score.b ? null
        : this.score.a > this.score.b ? 'a' : 'b';
    }

    console.log(`[Modes] матч окончен. победитель: ${winner}`);
    this.audio?.play(winner === this.local?.team ? 'victory' : 'defeat');
    try {
      this.ui?.showResult?.({
        winner,
        myTeam: this.local?.team,
        mode: MODE_INFO[this.mode].label,
        score: { ...this.score },
        goals: { ...this.goalCount },
        rows: this.rowsFn?.() || [],
        time: formatTime(CONFIG.MATCH_TIME)
      });
    } catch (e) {
      console.error('showResult err', e);
    }
  }

  hud() {
    return {
      label: MODE_INFO[this.mode].label,
      time: formatTime(this.timeLeft),
      objective: this._objectiveText(),
      scoreA: this.score.a,
      scoreB: this.score.b
    };
  }
}
