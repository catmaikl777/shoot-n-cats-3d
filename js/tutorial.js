// ============================================================
// tutorial.js — обучение: 6 страниц с артом, точками и переходами
// ============================================================

import { $, el } from './utils.js';

const PAGES = [
  {
    art: '🕹',
    title: 'Движение',
    desc: 'Слева — виртуальный джойстик: тяните пальцем, чтобы идти. На клавиатуре — WASD. Прыжок — кнопка ⤒ или Space, рывок — ≫ или Shift.'
  },
  {
    art: '👁',
    title: 'Камера и прицел',
    desc: 'Свайпом по правой половине экрана вращайте камеру. Щипок двумя пальцами — приближение. На ПКМ: ЛКМ — огонь, ПКМ — прицеливание.'
  },
  {
    art: '🔫',
    title: 'Стрельба',
    desc: 'Кнопка огня справа. Автострельба при удержании (настраивается). Хедшоты наносят двойной урон. Перезарядка — ⟳ или R.'
  },
  {
    art: '💣',
    title: 'Гранаты и бонусы',
    desc: 'Удерживайте ◉ (или G), чтобы набрать силу броска. Светящиеся колонны на карте — бонусы: лечение, щит, скорострел, рикошет.'
  },
  {
    art: '🐱',
    title: 'Мяуканье',
    desc: 'Двойной тап по экрану — мяуканье в общий чат. Радует союзников и раздражает врагов.'
  },
  {
    art: '🏆',
    title: 'Режимы и победа',
    desc: 'Команды — набери больше фрагов за 5 минут. Царь горы — удерживай точку. Доставка корма — принеси 5 мячей на свою базу. Удачи, кот!'
  }
];

export class Tutorial {
  constructor(settings) {
    this.settings = settings;
    this.page = 0;
    this.active = false;
    this._onDone = null;
  }

  init(onDone) {
    this._onDone = onDone;
    $('tut-next')?.addEventListener('click', () => this.next());
    $('tut-skip')?.addEventListener('click', () => this.finish());
  }

  start() {
    this.page = 0;
    this.active = true;
    this._render();
    document.getElementById('screen-tutorial')?.classList.add('active');
  }

  next() {
    this.page++;
    if (this.page >= PAGES.length) { this.finish(); return; }
    this._render();
  }

  finish() {
    this.active = false;
    this.settings?.set('tutorialDone', true);
    document.getElementById('screen-tutorial')?.classList.remove('active');
    this._onDone?.();
  }

  _render() {
    const p = PAGES[this.page];
    if (!p) return;
    const art = $('tut-art'), title = $('tut-title'), desc = $('tut-desc'), dots = $('tut-dots');
    if (art) art.textContent = p.art;
    if (title) title.textContent = p.title;
    if (desc) desc.textContent = p.desc;
    if (dots) {
      dots.innerHTML = PAGES.map((_, i) =>
        `<i class="${i === this.page ? 'on' : ''}"></i>`).join('');
    }
    const next = $('tut-next');
    if (next) next.textContent = this.page === PAGES.length - 1 ? 'Понятно!' : 'Далее';
    const skip = $('tut-skip');
    if (skip) skip.classList.toggle('hidden', this.page === 0);
  }
}
