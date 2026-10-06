// ============================================================
// netSync.js — сериализация состояния, отправка 30 Гц,
// приём и интерполяция, базовая «согласованность» (reconciliation)
// ============================================================

import { CONFIG, EV, clamp } from './utils.js';

export class NetSync {
  /**
   * @param {object} o { net, local, remotes }
   */
  constructor({ net, local, remotes }) {
    this.net = net;
    this.local = local;
    this.remotes = remotes;

    this.sendTimer = 0;
    this.sendRate = CONFIG.NET_SEND_RATE;
    this.enabled = false;

    this.sentCount = 0;
    this.recvCount = 0;

    this._lastSent = null;
  }

  start() {
    this.enabled = true;
    this.sendTimer = 0;
  }

  stop() {
    this.enabled = false;
  }

  /**
   * Вызывается каждый кадр из main.js.
   * Отправляем состояние с фиксированной частотой (30 Гц),
   * промежуточные кадры ничего не шлют.
   */
  update(dt) {
    if (!this.enabled || !this.net?.inRoom) return;
    this.sendTimer += dt;
    if (this.sendTimer < this.sendRate) return;
    this.sendTimer = 0;
    this.sendState();
  }

  /** Упаковать и отправить своё состояние (unreliable — потеря пакета не критична) */
  sendState() {
    const p = this.local;
    if (!p) return;
    const s = p.netState();
    // Не шлём статичные дубликаты слишком часто (экономия трафика)
    const key = `${s.x}${s.y}${s.z}${s.ry}${s.hp}${s.alive}${s.anim}`;
    if (key === this._lastSent && p.alive) return;
    this._lastSent = key;

    this.net.raise(EV.STATE, s, false);
    this.sentCount++;
  }

  /**
   * Приём состояния удалённого игрока (EVENT code 1).
   * Данные кладутся в буфер снимков — плавную интерполяцию
   * выполняет remotePlayer.update() с задержкой INTERP_DELAY.
   */
  onRemoteState(actorNr, content) {
    if (!content || actorNr === this.local?.actorNr) return;
    let rp = this.remotes.get(actorNr);
    if (!rp) {
      // Игрок мог присоединиться раньше, чем событие actorJoin обработалось
      rp = this.remotes.spawn({
        actorNr,
        name: content.name || `Кот_${actorNr}`,
        team: content.team || 'a'
      });
    }
    rp.pushState(content);
    this.recvCount++;
  }

  /** Обновить команду у удалённого игрока (при смене/первом входе) */
  setRemoteTeam(actorNr, team) {
    const rp = this.remotes.get(actorNr);
    if (rp && rp.team !== team) rp.setTeam(team);
  }

  /**
   * Лёгкая «согласованность»: если мы мертвы, а по данным сети живы
   * (например, нас возродили на другом клиенте), синхронизируем.
   * Вызывается при потере/восстановлении связи.
   */
  reconcile() {
    const p = this.local;
    if (!p) return;
    // Собственное состояние всегда авторитетно — просто убедимся,
    // что таймеры/кулдауны не зависли после реконнекта
    p.fireCd = Math.max(0, p.fireCd);
    console.log('[Net] reconcile: локальное состояние принят');
  }

  stats() {
    return { sent: this.sentCount, recv: this.recvCount };
  }
}
