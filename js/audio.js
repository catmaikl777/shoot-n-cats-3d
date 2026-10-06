// ============================================================
// audio.js — звук на чистом WebAudio (синтез, без внешних файлов):
// выстрелы, попадания, взрывы, мяуканье, музыкальные стинги
// ============================================================

class AudioMan {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.enabled = true;
    this.volume = 0.7;
    this._noiseBuf = null;
    this._lastPlay = new Map();
  }

  /** Инициализация после первого жеста пользователя (политика автоплея) */
  init() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return;
    }
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) { this.enabled = false; return; }
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.volume;
      this.master.connect(this.ctx.destination);

      // Общий шумовой буфер для взрывов/выстрелов
      const len = this.ctx.sampleRate * 1.2;
      this._noiseBuf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const data = this._noiseBuf.getChannelData(0);
      for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;

      console.log('[Audio] WebAudio инициализирован');
    } catch (e) {
      console.warn('[Audio] недоступен:', e);
      this.enabled = false;
    }
  }

  setEnabled(v) { this.enabled = v; }
  setVolume(v) {
    this.volume = v;
    if (this.master) this.master.gain.value = v;
  }

  /** Простой лимит частоты (чтобы звуки не слипались) */
  _throttle(name, ms = 45) {
    const now = performance.now();
    const last = this._lastPlay.get(name) || 0;
    if (now - last < ms) return true;
    this._lastPlay.set(name, now);
    return false;
  }

  _noise(dur, gainVal, filterFreq, type = 'lowpass') {
    const src = this.ctx.createBufferSource();
    src.buffer = this._noiseBuf;
    const g = this.ctx.createGain();
    const f = this.ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = filterFreq;
    g.gain.setValueAtTime(gainVal, this.ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, this.ctx.currentTime + dur);
    src.connect(f).connect(g).connect(this.master);
    src.start();
    src.stop(this.ctx.currentTime + dur);
    return g;
  }

  _tone(freq, dur, type = 'sine', gainVal = 0.2, slideTo = null) {
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, this.ctx.currentTime);
    if (slideTo !== null) {
      o.frequency.exponentialRampToValueAtTime(Math.max(slideTo, 1), this.ctx.currentTime + dur);
    }
    g.gain.setValueAtTime(gainVal, this.ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, this.ctx.currentTime + dur);
    o.connect(g).connect(this.master);
    o.start();
    o.stop(this.ctx.currentTime + dur);
    return o;
  }

  /**
   * Воспроизвести эффект по имени.
   * @param {string} name
   */
  play(name) {
    if (!this.enabled || !this.ctx) return;
    if (this.ctx.state === 'suspended') this.ctx.resume();
    if (this._throttle(name)) return;

    try {
      switch (name) {
        case 'shoot':
          this._noise(0.12, 0.5, 2400, 'bandpass');
          this._tone(220, 0.08, 'square', 0.16, 70);
          break;
        case 'shoot_far':
          this._noise(0.16, 0.18, 900, 'lowpass');
          break;
        case 'hit':
          this._tone(880, 0.07, 'square', 0.18, 440);
          break;
        case 'hit_hs':
          this._tone(1400, 0.1, 'square', 0.22, 700);
          this._tone(2100, 0.08, 'sine', 0.14, 1050);
          break;
        case 'hurt':
          this._tone(160, 0.22, 'sawtooth', 0.24, 70);
          break;
        case 'death':
          this._tone(330, 0.5, 'sawtooth', 0.25, 55);
          this._noise(0.4, 0.2, 500, 'lowpass');
          break;
        case 'kill':
          this._tone(523, 0.1, 'square', 0.2);
          setTimeout(() => this.ctx && this._tone(784, 0.16, 'square', 0.2), 90);
          break;
        case 'pickup':
          this._tone(660, 0.08, 'sine', 0.22);
          setTimeout(() => this.ctx && this._tone(990, 0.14, 'sine', 0.2), 70);
          break;
        case 'pickup_far':
          this._tone(660, 0.1, 'sine', 0.08);
          break;
        case 'explode':
          this._noise(0.7, 0.75, 420, 'lowpass');
          this._tone(90, 0.5, 'sine', 0.4, 30);
          break;
        case 'nade_throw':
          this._noise(0.14, 0.2, 1400, 'bandpass');
          break;
        case 'jump':
          this._tone(300, 0.13, 'sine', 0.15, 560);
          break;
        case 'dash':
          this._noise(0.22, 0.3, 1800, 'bandpass');
          this._tone(180, 0.2, 'sawtooth', 0.1, 420);
          break;
        case 'meow': {
          // Мяуканье: вибрирующий тон с глиссандо
          const o = this._tone(520, 0.45, 'sawtooth', 0.16, 760);
          const lfo = this.ctx.createOscillator();
          const lg = this.ctx.createGain();
          lfo.frequency.value = 7;
          lg.gain.value = 28;
          lfo.connect(lg).connect(o.frequency);
          lfo.start();
          lfo.stop(this.ctx.currentTime + 0.45);
          break;
        }
        case 'meow_far':
          this._tone(540, 0.4, 'sawtooth', 0.06, 700);
          break;
        case 'goal':
          this._tone(523, 0.12, 'square', 0.22);
          setTimeout(() => this.ctx && this._tone(659, 0.12, 'square', 0.22), 110);
          setTimeout(() => this.ctx && this._tone(784, 0.24, 'square', 0.24), 220);
          break;
        case 'victory': {
          const notes = [523, 659, 784, 1046];
          notes.forEach((f, i) => setTimeout(() => this.ctx && this._tone(f, 0.3, 'square', 0.2), i * 140));
          break;
        }
        case 'defeat': {
          const notes = [392, 349, 311, 262];
          notes.forEach((f, i) => setTimeout(() => this.ctx && this._tone(f, 0.35, 'sawtooth', 0.18), i * 170));
          break;
        }
        case 'click':
          this._tone(700, 0.05, 'square', 0.12, 500);
          break;
        case 'reload':
          this._tone(240, 0.08, 'square', 0.14, 320);
          setTimeout(() => this.ctx && this._tone(420, 0.1, 'square', 0.14, 300), 140);
          break;
        default:
          break;
      }
    } catch (e) {
      console.warn('[Audio] ошибка', name, e);
    }
  }
}

export const audio = new AudioMan();
