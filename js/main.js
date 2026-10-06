// ============================================================
// main.js — точка входа: загрузка ассетов, сцена Three.js,
// физика Rapier, игровой цикл, мультиплеер Photon, HUD
// ============================================================

import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';

import { CONFIG, EV, Settings, clamp, formatTime } from './utils.js';
import { device } from './device.js';
import { assets } from './assets.js';
import { buildMap } from './map.js';
import { LocalPlayer } from './player.js';
import { RemotePlayers } from './remotePlayer.js';
import { Weapons } from './weapons.js';
import { Grenades } from './grenades.js';
import { Powerups } from './powerups.js';
import { Modes, MODE_INFO } from './modes.js';
import { NetSync } from './netSync.js';
import { net, PHOTON_APP_ID } from './photon.js';
import { attachPhotonHandlers, teamForActor } from './photon_handlers.js';
import { UI } from './ui.js';
import { audio } from './audio.js';
import { input, initTouchControls, updateTouchControls } from './touchControls.js';
import { Tutorial } from './tutorial.js';

// ------------------------------------------------------------
// Глобальное состояние (для отладки: window.__snc)
// ------------------------------------------------------------
const G = {
  ready: false,
  playing: false,     // матч идёт (мы в комнате)
  last: 0,

  renderer: null,
  scene: null,
  camera: null,
  world: null,
  map: null,

  local: null,
  remotes: null,
  weapons: null,
  grenades: null,
  powerups: null,
  modes: null,
  netSync: null,

  ui: null,
  settings: null,
  tutorial: null,

  sun: null,
  hemi: null,
  quality: null,
  miniCtx: null,
  birds: [],

  hudAcc: 0,
  miniAcc: 0,
  prevFire: false,
  fireEdge: false,
  quickPending: false
};

const APP_ID_OK = typeof PHOTON_APP_ID === 'string' &&
  PHOTON_APP_ID.length > 0 && !PHOTON_APP_ID.startsWith('YOUR_');

// ============================================================
// ЗАГРУЗКА
// ============================================================
async function boot() {
  G.settings = new Settings();
  const ui = (G.ui = new UI(G.settings));
  ui.init();

  G.tutorial = new Tutorial(G.settings);
  G.tutorial.init(() => ui.show('screen-menu'));
  ui.on('tutorial', () => G.tutorial.start());

  ui.show('screen-loading');

  // 1. Ассеты (CC0: Poly Haven и др.) — при ошибке работаем на процедурных
  try {
    await assets.loadAll((done, total, key) => ui.showLoadingProgress(done, total, key));
  } catch (e) {
    console.warn('[Boot] ассеты:', e);
    ui.setLoadError('Не все ассеты загрузились — используются процедурные текстуры.');
  }
  ui.showLoadingProgress(1, 1, 'готово');

  // 2. Физика
  ui.showLoadingProgress(1, 1, 'физика');
  await RAPIER.init();

  // 3. Сцена и миры
  initRenderer();
  initScene();
  initWorld();

  // 4. Ввод, UI-связки, сеть
  initControls();
  initPhoton();

  // 5. Цикл
  G.last = performance.now();
  requestAnimationFrame(frame);

  ui.setLoadError('');
  ui.show('screen-menu');
  G.ready = true;
  console.log('[Boot] готово', device.info());
}

// ============================================================
// РЕНДЕР / СЦЕНА
// ============================================================
function initRenderer() {
  const canvas = document.getElementById('game-canvas');
  G.quality = device.qualityParams(
    G.settings.get('quality') === 'auto' ? device.tier : G.settings.get('quality')
  );

  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: G.quality.antialias,
    powerPreference: 'high-performance',
    stencil: false
  });
  renderer.setPixelRatio(Math.min(device.dpr, G.quality.dpr));
  renderer.setSize(device.width, device.height, false);
  renderer.shadowMap.enabled = G.quality.shadows;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  G.renderer = renderer;

  device.onChange(() => {
    renderer.setPixelRatio(Math.min(device.dpr, G.quality.dpr));
    renderer.setSize(device.width, device.height, false);
    G.camera.aspect = device.width / Math.max(1, device.height);
    G.camera.updateProjectionMatrix();
  });
}

function initScene() {
  const scene = new THREE.Scene();
  G.scene = scene;

  const q = G.quality;
  const sky = 0x9dbde0;
  scene.fog = new THREE.Fog(sky, q.viewDistance * 0.4, q.viewDistance);

  const camera = new THREE.PerspectiveCamera(
    72, device.width / Math.max(1, device.height), 0.1, q.viewDistance + 200
  );
  camera.position.set(0, 4, 8);
  G.camera = camera;

  // Освещение
  const hemi = new THREE.HemisphereLight(0xcfe4ff, 0x50463a, 0.75);
  scene.add(hemi);
  G.hemi = hemi;

  const sun = new THREE.DirectionalLight(0xfff2dd, 2.3);
  sun.position.set(40, 60, 30);
  sun.castShadow = q.shadows;
  sun.shadow.mapSize.set(q.shadowMapSize, q.shadowMapSize);
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 220;
  const ext = 60;
  sun.shadow.camera.left = -ext;
  sun.shadow.camera.right = ext;
  sun.shadow.camera.top = ext;
  sun.shadow.camera.bottom = -ext;
  sun.shadow.bias = -0.0012;
  sun.shadow.normalBias = 0.03;
  scene.add(sun);
  scene.add(sun.target);
  G.sun = sun;

  // HDRI-фон (Poly Haven CC0) + отражения для PBR
  const hdri = assets.get('hdri_day') || assets.get('hdri_sunset');
  if (hdri) {
    try {
      const pmrem = new THREE.PMREMGenerator(G.renderer);
      const env = pmrem.fromEquirectangular(hdri).texture;
      scene.environment = env;
      scene.background = env;
      scene.backgroundBlurriness = 0.35;
      scene.backgroundIntensity = 0.9;
      pmrem.dispose();
      console.log('[Scene] HDRI применён');
    } catch (e) {
      console.warn('[Scene] HDRI не применился:', e);
      scene.background = new THREE.Color(sky);
    }
  } else {
    scene.background = new THREE.Color(sky);
  }
}

function initWorld() {
  G.world = new RAPIER.World({ x: 0, y: CONFIG.GRAVITY, z: 0 });
  G.world.timestep = 1 / 60;

  G.map = buildMap(G.scene, G.world, assets, G.quality);
  G.remotes = new RemotePlayers(G.scene);
  G.local = new LocalPlayer({ scene: G.scene, world: G.world, camera: G.camera, map: G.map });

  G.weapons = new Weapons({
    scene: G.scene, world: G.world, map: G.map, audio, net
  });
  G.weapons.local = G.local;
  G.weapons.remotes = G.remotes;
  G.weapons.setCamera(G.camera);

  G.grenades = new Grenades({
    scene: G.scene, world: G.world, map: G.map, audio, net
  });
  G.grenades.local = G.local;
  G.grenades.remotes = G.remotes;

  G.powerups = new Powerups({ scene: G.scene, map: G.map, audio, net });
  G.powerups.local = G.local;
  G.powerups.build();

  G.modes = new Modes({
    scene: G.scene, map: G.map, net, local: G.local,
    remotes: G.remotes, ui: G.ui, audio
  });

  G.netSync = new NetSync({ net, local: G.local, remotes: G.remotes });

  // Мини-карта
  const mini = document.getElementById('minimap');
  G.miniCtx = mini ? mini.getContext('2d') : null;

  // Декоративные птицы (модели из манифеста)
  initBirds();

  // Глобальная точка доступа для отладки/системных модулей
  window.__snc = {
    get ui() { return G.ui; },
    get remotes() { return G.remotes; },
    get local() { return G.local; },
    get modes() { return G.modes; },
    get net() { return net; },
    get map() { return G.map; },
    G
  };

  // Связка Photon → игровые системы
  attachPhotonHandlers({
    net,
    local: G.local,
    remotes: G.remotes,
    netSync: G.netSync,
    weapons: G.weapons,
    grenades: G.grenades,
    powerups: G.powerups,
    modes: G.modes,
    ui: G.ui,
    audio,
    onJoined: startMatch,
    onLeft: endMatch
  });

  // HUD-провайдеры
  G.ui.setScoreProvider(scoreRows);
  G.modes.rowsFn = scoreRows;
  G.ui.onRespawn(respawnLocal);
  G.ui.onRespawnNow(() => { G.ui.hideDeath(); respawnLocal(); });
  G.ui.onLeave(leaveRoom);
}

function initBirds() {
  const key = Math.random() > 0.5 ? 'bird_parrot' : 'bird_stork';
  const gltf = assets.get(key);
  if (!gltf || !gltf.scene || !gltf.animations?.length) return;
  try {
    for (let i = 0; i < 3; i++) {
      const model = gltf.scene.clone(true);
      const mixer = new THREE.AnimationMixer(model);
      mixer.clipAction(gltf.animations[0]).play();
      model.scale.setScalar(1.4);
      G.scene.add(model);
      G.birds.push({
        model, mixer,
        r: 46 + i * 16,
        y: 24 + i * 7,
        speed: 0.1 + i * 0.025,
        phase: i * 2.1
      });
    }
    console.log('[Scene] птицы добавлены:', key);
  } catch (e) {
    console.warn('[Scene] птицы:', e);
  }
}

// ============================================================
// ВВОД / УПРАВЛЕНИЕ
// ============================================================
function initControls() {
  // Синхронизация настроек камеры
  input.sensitivity = G.settings.get('sens');
  input.invertY = !!G.settings.get('invY');

  input.onShoot = (shooter) => {
    // Автострельба выключена → стреляем только по нажатию (edge)
    if (!input.autofire && !G.fireEdge) return;
    const res = G.weapons.fire(shooter);
    if (res) G.fireEdge = false;
  };

  initTouchControls({
    onNadeRelease: (power) => {
      G.grenades.throwLocal({ power });
    },
    onTaunt: () => {
      if (!G.playing) return;
      net.raise(EV.TAUNT, {}, true);
      audio.play('meow');
    },
    onPauseSwipe: () => {
      if (G.ui.current === 'screen-game') G.ui.showPause();
      else if (G.ui.current === 'screen-pause') G.ui.resume();
    }
  });

  // Первая активация звука (политика автоплея)
  const unlock = () => {
    audio.init();
    window.removeEventListener('pointerdown', unlock);
    window.removeEventListener('keydown', unlock);
  };
  window.addEventListener('pointerdown', unlock);
  window.addEventListener('keydown', unlock);

  // Смена качества графики из настроек
  G.ui.onSettingsChange((params) => applyQuality(params));

  // Настройки камеры читаем из хранилища (меняется на лету)
  setInterval(() => {
    input.sensitivity = G.settings.get('sens');
    input.invertY = !!G.settings.get('invY');
  }, 500);
}

function applyQuality(p) {
  G.quality = { ...G.quality, ...p };
  const r = G.renderer;
  r.setPixelRatio(Math.min(device.dpr, p.dpr));
  r.shadowMap.enabled = p.shadows;
  if (G.sun) {
    G.sun.castShadow = p.shadows;
    G.sun.shadow.mapSize.set(p.shadowMapSize, p.shadowMapSize);
    if (G.sun.shadow.map) {
      G.sun.shadow.map.dispose();
      G.sun.shadow.map = null;
    }
  }
  G.camera.far = p.viewDistance + 200;
  G.camera.updateProjectionMatrix();
  if (G.scene.fog) {
    G.scene.fog.near = p.viewDistance * 0.4;
    G.scene.fog.far = p.viewDistance;
  }
}

// ============================================================
// СЕТЬ / ЛОББИ
// ============================================================
function initPhoton() {
  const ui = G.ui;

  ui.on('refreshRooms', () => net.refreshRooms());
  ui.on('nick', (name) => net.setNick(name));

  // Действие, ожидающее подключения к Photon (клик до «онлайн»)
  let pendingOp = null;
  const runPending = () => {
    const op = pendingOp;
    pendingOp = null;
    if (!op) return;
    if (op.kind === 'quick') doQuickJoin();
    else if (op.kind === 'create') net.createRoom(op.name, { mode: op.mode });
    else if (op.kind === 'join') net.joinRoom(op.name, { mode: op.mode });
  };
  // Гарантируем подключение: если уже онлайн — выполняем сразу,
  // иначе ждём событие 'ready' (JoinedLobby)
  const ensureReady = (op) => {
    pendingOp = op;
    if (net.connected) runPending();
    else net.connect();
  };
  net.on('ready', () => { if (pendingOp) runPending(); });
  net.on('error', () => { pendingOp = null; });

  ui.on('quickJoin', () => {
    if (!requirePhoton(ui)) return;
    prepareNick();
    ui.photonStatus(net.connected ? 'поиск комнаты…' : 'подключение…');
    ensureReady({ kind: 'quick' });
  });

  ui.on('createRoom', ({ name, mode }) => {
    if (!requirePhoton(ui)) return;
    prepareNick();
    ensureReady({ kind: 'create', name, mode: mode || currentMode() });
  });

  ui.on('joinRoom', ({ name, mode }) => {
    if (!requirePhoton(ui)) return;
    prepareNick();
    ensureReady({ kind: 'join', name, mode: mode || currentMode() });
  });

  // Быстрая игра: открытых комнат нет → создаём свою
  net.on('opError', ({ errorCode }) => {
    if (!G.quickPending) return;
    G.quickPending = false;
    console.log('[Photon] joinRandom не нашёл комнату, создаём (code ' + errorCode + ')');
    net.createRoom(null, { mode: currentMode() });
  });

  // Кнопка отмены в диалоге переподключения обрабатывается в ui.js
  // (вызовет leaveRoom через ui.onLeave)

  if (!APP_ID_OK) {
    ui.photonStatus('нужен AppID', 'err');
    ui.renderRooms([]);
    return;
  }
  net.connect();
}

function doQuickJoin() {
  G.quickPending = true;
  G.ui.photonStatus('поиск комнаты…');
  const ok = net.joinRandom(currentMode());
  if (!ok) G.quickPending = false;
}

function requirePhoton(ui) {
  if (!net.sdkAvailable) {
    ui.showMessage?.(
      'Файл Photon SDK не найден: public/lib/photon-javascript-sdk.min.js',
      'Мультиплеер недоступен'
    );
    return false;
  }
  if (!APP_ID_OK) {
    ui.showMessage?.(
      'Вставьте свой AppId в js/photon.js (PHOTON_APP_ID).\n' +
      'Зарегистрируйтесь бесплатно на photonengine.com → Dashboard → ' +
      'Create App → тип RealTime → скопируйте AppId.',
      'Не настроен Photon AppID'
    );
    return false;
  }
  return true;
}

function prepareNick() {
  const nick = G.settings.get('nick') || `Кот_${Math.floor(Math.random() * 900 + 100)}`;
  G.settings.set('nick', nick);
  net.setNick(nick);
}

function currentMode() {
  return document.querySelector('#mode-select .chip.sel')?.dataset.mode ||
    G.settings.get('lastMode') || 'team';
}

// ============================================================
// ЖИЗНЕННЫЙ ЦИКЛ МАТЧА
// ============================================================
function startMatch(info) {
  if (G.playing) return;
  G.playing = true;

  const actorNr = net.myActorNr;
  const team = teamForActor(actorNr);
  const mode = net.roomProperty('mode', net.pendingMode || 'team');

  G.local.actorNr = actorNr;
  G.local.team = team;
  G.local.name = G.settings.get('nick') || net.nick || 'Кот_Боец';

  // Уже присутствующие в комнате игроки
  for (const a of net.actors()) {
    if (a.actorNr === actorNr) continue;
    G.remotes.spawn({
      actorNr: a.actorNr,
      name: a.name || `Кот_${a.actorNr}`,
      team: teamForActor(a.actorNr)
    });
  }

  G.modes.setMode(MODE_INFO[mode] ? mode : 'team');
  G.ui.setModeShort(MODE_INFO[G.modes.mode]?.short || '');
  G.ui.enterMatch();
  G.ui.show('screen-game');
  document.body.classList.add('playing');

  respawnLocal(true);
  G.modes.start();
  G.netSync.start();
  G.ui.updateScoreboard();
  G.ui.hideDeath();

  audio.init();
  audio.play('pickup');
  G.ui.toast(`Комната «${info?.name ?? ''}» · ${MODE_INFO[G.modes.mode].label}`, 2600);
  console.log(`[Match] старт: actor=${actorNr} team=${team} mode=${G.modes.mode}`);
}

function endMatch() {
  if (!G.playing) return;
  G.playing = false;

  G.netSync.stop();
  G.modes.reset();
  G.grenades.clear();
  G.weapons.clear();
  G.remotes.clear();

  G.ui.leaveMatch();
  document.body.classList.remove('playing');
  G.ui.show(G.leaveTarget === 'menu' ? 'screen-menu' : 'screen-lobby');
  G.leaveTarget = 'lobby';
  console.log('[Match] окончен/покинут');
}

function leaveRoom(target = 'lobby') {
  G.leaveTarget = target;
  net.leaveRoom();   // → событие 'left' → endMatch()
  endMatch();        // страховка, если событие уже не придёт
}

function respawnLocal(first = false) {
  if (!G.playing) return;
  const team = G.local.team;
  const enemies = G.remotes.positions(team === 'a' ? 'b' : 'a');
  const pos = G.map.spawnForTeam(team, enemies);
  G.local.respawn(pos);
  // Смотрим на центр карты
  G.local.camYaw = team === 'a' ? Math.PI / 2 : -Math.PI / 2;
  G.local.camPitch = -0.12;
  G.local.group.rotation.y = G.local.camYaw;
  if (!first) G.ui.toast('Возрождение!', 900);
}

// ============================================================
// ТАБЛИЦА ОЧКОВ
// ============================================================
function scoreRows() {
  const rows = [{
    name: `${G.local.name} (вы)`,
    team: G.local.team,
    kills: G.local.kills,
    deaths: G.local.deaths,
    score: G.local.score,
    isMe: true
  }];
  for (const rp of G.remotes.map.values()) {
    rows.push({
      name: rp.name,
      team: rp.team,
      kills: rp.kills,
      deaths: rp.deaths,
      score: rp.score
    });
  }
  return rows.sort((a, b) => b.score - a.score);
}

// ============================================================
// HUD
// ============================================================
function updateHud(dt) {
  const p = G.local;

  G.hudAcc += dt;
  if (G.hudAcc >= 0.1) {
    G.hudAcc = 0;
    G.ui.setHP(p.hp);
    G.ui.setShield(p.shield);
    G.ui.setAmmo(p.mag, p.reserve, p.reloading);
    G.ui.setGrenades(p.grenades, CONFIG.NADE_COUNT);
    G.ui.setDash(1 - p.dashCd / CONFIG.DASH_COOLDOWN);
    G.ui.setBuffs(p.buffs);
  }

  G.miniAcc += dt;
  if (G.miniAcc >= 0.15) {
    G.miniAcc = 0;
    G.ui.updateScoreboard();
    drawMinimap();
  }
}

function drawMinimap() {
  if (!G.miniCtx || !G.ui._minimapOn) return;
  const pts = [];
  const m = G.map.points;
  pts.push({ x: m.baseA.x, z: m.baseA.z, color: '#43d9ff' });
  pts.push({ x: m.baseB.x, z: m.baseB.z, color: '#ff4d5e' });
  pts.push({ x: m.deliveryNeutral.x, z: m.deliveryNeutral.z, color: '#ffd54a' });
  if (G.modes.mode === 'king') pts.push({ x: m.king.x, z: m.king.z, color: '#ffffff' });

  const allies = [];
  const enemies = [];
  for (const rp of G.remotes.map.values()) {
    if (!rp.alive) continue;
    (rp.team === G.local.team ? allies : enemies).push({
      x: rp.group.position.x, z: rp.group.position.z
    });
  }

  G.ui.drawMinimap(G.miniCtx, {
    playerPos: G.local.position,
    yaw: G.local.camYaw,
    allies, enemies,
    points: pts
  });
}

// ============================================================
// ИГРОВОЙ ЦИКЛ
// ============================================================
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min((now - G.last) / 1000, 0.05);
  G.last = now;
  if (!G.ready) return;

  const gameVisible = document.getElementById('screen-game')?.classList.contains('active');
  const active = G.playing && G.ui.current === 'screen-game';

  if (active) {
    // Край нажатия (для выключенного автоогня)
    if (input.fire && !G.prevFire) G.fireEdge = true;
    G.prevFire = input.fire;

    updateTouchControls(dt);

    // 1) пред-шаговые расчёты игрока
    G.local.update(dt, input);
    // 2) физический шаг мира
    G.world.step();
    // 3) пост-шаг: земля, границы, визуал, камера
    G.local.postStep(dt);

    // Остальные системы
    G.remotes.update(dt);
    G.weapons.update(dt);
    G.grenades.update(dt);
    G.powerups.update(dt);
    G.modes.update(dt);
    G.netSync.update(dt);

    // Птицы и солнце
    updateAmbient(dt);
    updateHud(dt);
  } else if (G.playing) {
    updateAmbient(dt);
  }

  if (G.renderer && gameVisible) {
    G.renderer.render(G.scene, G.camera);
  }
}

function updateAmbient(dt) {
  const t = performance.now() * 0.001;
  for (const b of G.birds) {
    const a = t * b.speed + b.phase;
    b.model.position.set(Math.cos(a) * b.r, b.y + Math.sin(t * 0.6 + b.phase) * 1.5, Math.sin(a) * b.r);
    b.model.rotation.y = -a + Math.PI / 2;
    b.mixer.update(dt);
  }
  // Следящая тень: солнце едет за игроком
  if (G.sun && G.local) {
    const p = G.local.position;
    G.sun.position.set(p.x + 40, 62, p.z + 30);
    G.sun.target.position.set(p.x, 0, p.z);
    G.sun.target.updateMatrixWorld();
  }
}

// ============================================================
// СТАРТ
// ============================================================
boot().catch((e) => {
  console.error('[Boot] фатальная ошибка:', e);
  const err = document.getElementById('loading-error');
  if (err) {
    err.textContent = `Ошибка запуска: ${e.message || e}. Попробуйте обновить страницу.`;
  }
});
