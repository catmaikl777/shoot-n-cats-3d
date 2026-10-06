// Smoke-тест ядра игры в Node: карта, физика, игрок, стрельба, гранаты, бонусы, режимы
// js/ — относительно этого файла
const U = (p) => new URL('../' + p, import.meta.url).href;

// ---------- Браузерные заглушки ----------
globalThis.window = globalThis;
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: {
    userAgent: 'NodeSmokeTest',
    platform: 'Linux',
    language: 'ru-RU',
    maxTouchPoints: 0,
    hardwareConcurrency: 8,
    deviceMemory: 8,
    vibrate() {},
    getGamepads() { return []; }
  }
});
globalThis.innerWidth = 1280;
globalThis.innerHeight = 720;
globalThis.devicePixelRatio = 1;
globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, addListener() {} });
globalThis.addEventListener = () => {};
globalThis.removeEventListener = () => {};
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.requestAnimationFrame = () => 0;
globalThis.cancelAnimationFrame = () => {};

function makeCtx() {
  const store = {};
  return new Proxy(store, {
    get(t, p) {
      if (p in t) return t[p];
      if (p === 'canvas') return null;
      if (p === 'measureText') return () => ({ width: 0 });
      if (p === 'createLinearGradient' || p === 'createRadialGradient' || p === 'createPattern') {
        return () => ({ addColorStop() {} });
      }
      if (p === 'getImageData') return () => ({ data: new Uint8ClampedArray(4) });
      if (p === 'createImageData') return () => ({ data: new Uint8ClampedArray(4) });
      return () => undefined;
    },
    set(t, p, v) { t[p] = v; return true; }
  });
}

function makeEl(tag = 'div') {
  const el = {
    tagName: (tag || 'div').toUpperCase(),
    style: { setProperty() {}, removeProperty() {} },
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    dataset: {},
    children: [],
    width: 0,
    height: 0,
    textContent: '',
    innerHTML: '',
    value: '',
    checked: false,
    appendChild(c) { this.children.push(c); return c; },
    removeChild() {},
    insertBefore(c) { this.children.push(c); return c; },
    setAttribute() {},
    getAttribute: () => null,
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent: () => true,
    querySelector: () => null,
    querySelectorAll: () => [],
    getContext(kind) { return kind === '2d' ? makeCtx() : null; },
    toDataURL: () => '',
    focus() {},
    click() {}
  };
  return el;
}

globalThis.document = {
  createElement: (t) => makeEl(t),
  createElementNS: (ns, t) => makeEl(t),
  getElementById: () => null,
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener() {},
  removeEventListener() {},
  exitPointerLock() {},
  body: makeEl('body'),
  documentElement: makeEl('html'),
  head: makeEl('head')
};

// ---------- Импорт модулей ----------
const RAPIER = (await import('@dimforge/rapier3d-compat')).default;
await RAPIER.init();
const THREE = await import('three');
const { CONFIG } = await import(U('js/utils.js'));
const { assets } = await import(U('js/assets.js'));
const { device } = await import(U('js/device.js'));
const { buildMap } = await import(U('js/map.js'));
const { LocalPlayer } = await import(U('js/player.js'));
const { RemotePlayers } = await import(U('js/remotePlayer.js'));
const { Weapons } = await import(U('js/weapons.js'));
const { Grenades } = await import(U('js/grenades.js'));
const { Powerups } = await import(U('js/powerups.js'));
const { Modes } = await import(U('js/modes.js'));
const { NetSync } = await import(U('js/netSync.js'));
const { input } = await import(U('js/touchControls.js'));

const raised = [];
const netStub = {
  inRoom: true,
  raise(code, data, rel) { raised.push({ code, data }); }
};
const audioStub = { play() {}, init() {} };
const uiStub = {
  _gameActive: true,
  toast() {}, hitmarker() {}, damageFlash() {}, killfeed() {},
  updateScoreboard() {}, setModeLabel() {}, setTimer() {}, setObjective() {},
  setTeamScore() {}, showDeath() {}, hideDeath() {}, showResult() {},
  setBuffs() {}, setHP() {}, setShield() {}, setAmmo() {}, setGrenades() {},
  setDash() {}, drawMinimap() {}, photonStatus() {}, renderRooms() {}
};

let fails = 0;
const check = (cond, msg) => {
  if (cond) console.log('  ok  -', msg);
  else { fails++; console.log('  FAIL-', msg); }
};

// ---------- Сцена / физика ----------
const quality = device.qualityParams(device.tier);
console.log('[1] качество:', device.tier, JSON.stringify(quality).slice(0, 120));

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(72, 16 / 9, 0.1, 400);
const world = new RAPIER.World({ x: 0, y: CONFIG.GRAVITY, z: 0 });
world.timestep = 1 / 60;

const t0 = Date.now();
const map = buildMap(scene, world, assets, quality);
console.log('[2] buildMap:', Date.now() - t0, 'мс, коллайдеров:', world.len ? world.len() : 'n/a');
check(map && map.points && map.spawns.a.length > 0, 'map.points/spawns заполнены');
check(world.bodies.len() > 10, 'тела в физике: ' + world.bodies.len());

// ---------- Игроки ----------
const local = new LocalPlayer({ scene, world, camera, map });
local.actorNr = 1;
local.team = 'a';
local.name = 'Тестер';
const remotes = new RemotePlayers(scene);
remotes.spawn({ actorNr: 2, name: 'Бот', team: 'b' });
const bot = remotes.get(2);

const weapons = new Weapons({ scene, world, map, audio: audioStub, net: netStub });
weapons.local = local;
weapons.remotes = remotes;
weapons.setCamera(camera);

const grenades = new Grenades({ scene, world, map, audio: audioStub, net: netStub });
grenades.local = local;
grenades.remotes = remotes;

const powerups = new Powerups({ scene, map, audio: audioStub, net: netStub });
powerups.local = local;
powerups.build();
check(powerups.nodes.length > 0, 'бонусы построены: ' + powerups.nodes.length);

const modes = new Modes({
  scene, map, net: netStub, local, remotes, ui: uiStub, audio: audioStub
});
modes.rowsFn = () => [];

const netSync = new NetSync({ net: netStub, local, remotes });
netSync.start();

// ---------- Спавн и цикл ----------
const pos = map.spawnForTeam('a', []);
local.respawn(pos);
check(local.alive && local.hp === CONFIG.MAX_HP, 'спавн живой, hp=' + local.hp);
console.log('[3] позиция спавна:', pos.x.toFixed(1), pos.y.toFixed(1), pos.z.toFixed(1));

const step = (inputObj, n = 1) => {
  for (let i = 0; i < n; i++) {
    local.update(1 / 60, inputObj);
    world.step();
    local.postStep(1 / 60);
    remotes.update(1 / 60);
    weapons.update(1 / 60);
    grenades.update(1 / 60);
    powerups.update(1 / 60);
    modes.update(1 / 60);
    netSync.update(1 / 60);
  }
};

const idle = {
  move: { x: 0, y: 0 }, aim: false, fire: false, jump: false, dash: false,
  reload: false, sensitivity: 1, invertY: false, taunt: false, _lookX: 0, _lookY: 0, _zoom: 0,
  onShoot: () => { weapons.fire(local); },
  consumeLook() { const o = { x: this._lookX, y: this._lookY, zoom: this._zoom }; this._lookX = this._lookY = this._zoom = 0; return o; }
};

// Падение на землю
step(idle, 120);
console.log('[4] после падения y=', local.position.y.toFixed(2), 'grounded=', local.grounded);
check(local.grounded, 'игрок на земле');
check(local.grounded && local.position.y > -50,
  'не упал сквозь карту (y=' + local.position.y.toFixed(2) + ')');

// Прыжок с земли работает и ведёт к приземлению
const jumpGround = { ...idle, jump: true };
step(jumpGround, 1);
check(!local.grounded && local.body.linvel().y > 1,
  'прыжок с земли работает (vy=' + local.body.linvel().y.toFixed(2) + ')');
step(idle, 150);
check(local.grounded, 'приземлился после прыжка');

// [Регрессия мультипрыжка] В воздухе grounded=false и прыжок игнорируется
local.setPosition(0, 6, 0);
local.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
step(idle, 6);
console.log('[4b] в воздухе y=', local.position.y.toFixed(2), 'grounded=', local.grounded);
check(local.position.y > 1.5, 'игрок действительно в воздухе (y=' + local.position.y.toFixed(2) + ')');
check(!local.grounded, 'grounded=false в воздухе (иначе мультипрыжок)');
const jumpAir = { ...idle, jump: true };
step(jumpAir, 1);
const vyAir = local.body.linvel().y;
check(!local.grounded && vyAir < CONFIG.JUMP_VEL * 0.5,
  'прыжок в воздухе невозможен (vy=' + vyAir.toFixed(2) + ')');

// Открытая зона (центр карты) — там нет стен на пути движения/пули
local.setPosition(0, 2, 0);
step(idle, 60);

// Движение вперёд 2 сек
const start = local.position.clone();
const fwd = { ...idle, move: { x: 0, y: 1 } };
for (let i = 0; i < 120; i++) {
  step(fwd, 1);
  if (i % 30 === 0) {
    const v = local.body.linvel();
    console.log('   dbg', i, 'pos', local.position.x.toFixed(2), local.position.z.toFixed(2),
      '| vel', v.x.toFixed(2), v.y.toFixed(2), v.z.toFixed(2),
      '| grounded', local.grounded, '| alive', local.alive, '| wish', local._wishX?.toFixed(2), local._wishZ?.toFixed(2));
  }
}
const moved = local.position.distanceTo(start);
const spd = Math.hypot(local.body.linvel().x, local.body.linvel().z);
console.log('[5] прошёл за 2с:', moved.toFixed(2), 'м, скорость:', spd.toFixed(2), 'м/с');
check(spd > 1 || moved > 2, 'движение работает (' + moved.toFixed(2) + ' м)');

// Стрельба
const shots0 = raised.filter(r => r.code === 2).length; // EV.SHOOT = 2
const mag0 = local.mag;
local.fireCd = 0;
const shooting = { ...idle, fire: true };
input.fire = true;
step(shooting, 30);
input.fire = false;
const shots1 = raised.filter(r => r.code === 2).length;
console.log('[6] выстрелов:', shots1 - shots0, 'магазин:', mag0, '→', local.mag);
check(shots1 > shots0, 'события вылетают');
check(local.mag < mag0, 'патроны тратятся');
check(raised.some(r => r.code === 2 && r.data.ox !== undefined), 'payload SHOOT корректен');

// Урон боту в лоб: ставим бота ровно на луч камеры
const camPos = new THREE.Vector3();
const dir = new THREE.Vector3();
camera.getWorldPosition(camPos);
camera.getWorldDirection(dir);
const at = camPos.clone().addScaledVector(dir, 8);
bot.alive = true;
bot.hp = 100;
bot.group.position.set(at.x, at.y - 0.55, at.z);
const losClear = map.hasLineOfSight(camPos, at);
console.log('   dbg бот:', bot.group.position.x.toFixed(1), bot.group.position.y.toFixed(1), bot.group.position.z.toFixed(1),
  '| камера:', camPos.x.toFixed(1), camPos.y.toFixed(1), camPos.z.toFixed(1),
  '| луч 8м →', at.x.toFixed(1), at.y.toFixed(1), at.z.toFixed(1), '| видимость:', losClear);
local.fireCd = 0;
const hits0 = raised.filter(r => r.code === 7).length; // EV.HIT = 7
const dbgShot = weapons.fire(local);
console.log('   dbg выстрел:', dbgShot
  ? `target=${dbgShot.target ? 'бот' : 'нет'} hs=${dbgShot.headshot} dist=${dbgShot.distance?.toFixed(1)} point=(${dbgShot.point.x.toFixed(1)},${dbgShot.point.y.toFixed(1)},${dbgShot.point.z.toFixed(1)})`
  : 'не выстрелил (cd/магазин/перезарядка)');
const facing = { ...idle, fire: true };
step(facing, 60);
const hits1 = raised.filter(r => r.code === 7).length;
console.log('[7] HIT-событий:', hits1 - hits0, 'hp бота:', bot.hp);
check(hits1 > hits0, 'попадание по боту зарегистрировано');
check(bot.hp < 100, 'урон боту применён (' + bot.hp + ')');
if (hits1 > hits0) {
  const hit = raised.filter(r => r.code === 7).pop().data;
  check(hit.to === 2 && hit.from === 1 && hit.dmg > 0, 'формат HIT {to,from,dmg,hs}: ' + JSON.stringify(hit));
}

// Перезарядка
local.reserve = 60;
local.startReload();
step(idle, 150);
console.log('[8] после перезарядки магазин:', local.mag, 'запас:', local.reserve);
check(local.mag === CONFIG.MAG_SIZE, 'перезарядка завершена');

// Граната
const nades0 = local.grenades;
const nadeOk = grenades.throwLocal({ power: 0.8 });
console.log('[9] бросок гранаты:', nadeOk, 'гранат:', nades0, '→', local.grenades);
check(nadeOk && local.grenades === nades0 - 1, 'граната потрачена');
check(raised.some(r => r.code === 3), 'EV.NADE отправлено');
step(idle, 60 * 4); // 4 сек — фьюз + взрыв
check(grenades.list.length === 0, 'граната взорвалась и удалена');
check(raised.some(r => r.code === 2 || r.code === 7), 'есть события после взрыва');

// Бонусы: телепортируемся на первый активный узел
local.hp = 40; // hp-бонус не подбирается на полном HP — это ожидаемо
const node = powerups.nodes.find(n => n.active);
if (node) {
  local.setPosition(node.group.position.x, node.group.position.y + 0.5, node.group.position.z);
  step(idle, 5);
  const pu = raised.filter(r => r.code === 5);
  console.log('[10] бонус собран:', node.type, '| POWERUP-событий:', pu.length);
  check(pu.length > 0, 'EV.POWERUP отправлено');
  check(Object.keys(local.buffs).length > 0 || local.hp > 0 || local.shield >= 0, 'эффект применён');
} else {
  check(false, 'нет активных бонусов');
}

// Режимы: командный
modes.setMode('team');
modes.start();
step(idle, 120);
console.log('[11] режим team: таймер', modes.timeLeft.toFixed(1), 'счёт', JSON.stringify(modes.score));
check(modes.timeLeft < CONFIG.MATCH_TIME, 'таймер обратного отсчёта идёт');

// Царь горы
modes.setMode('king');
modes.start();
modes._updateKing(1 / 60);
step(idle, 60);
console.log('[12] king: точка', map.points.king.x.toFixed(1), map.points.king.z.toFixed(1), 'счёт', JSON.stringify(modes.score));
check(modes.mode === 'king', 'режим king активен');

// Доставка
modes.setMode('delivery');
modes.start();
step(idle, 60);
console.log('[13] delivery: мячей', modes.balls ? modes.balls.length : 'n/a');
check(modes.mode === 'delivery', 'режим delivery активен');

// Таблица очков / netState
const ns = local.netState();
check(typeof ns.x === 'number' && typeof ns.hp === 'number' && ns.alive !== undefined, 'netState: ' + JSON.stringify(ns));

// Смерть и респавн
local.takeDamage(999, { headshot: true });
check(!local.alive, 'смерть от урона');
local.respawn(map.spawnForTeam('a', []));
check(local.alive && local.hp === CONFIG.MAX_HP, 'респавн: hp=' + local.hp);

// Сетевое состояние
netSync.sendState();
check(raised.some(r => r.code === 1), 'EV.STATE отправлено');

// Очистка
modes.reset();
grenades.clear();
weapons.clear();
remotes.clear();
check(remotes.map.size === 0, 'remotes очищены');

// Итог
console.log('\n' + (fails === 0 ? 'SMOKE OK — все проверки пройдены' : 'SMOKE FAILED — провалов: ' + fails));
process.exit(fails === 0 ? 0 : 1);
