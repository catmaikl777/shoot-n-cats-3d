// ============================================================
// photon_handlers.js — диспетчер событий Photon для игровых систем:
// движение, выстрелы, гранаты, смерти, бонусы, режимы, лобби/UI
// ============================================================

import { EV, CONFIG } from './utils.js';

/**
 * Привязать все обработчики Photon к игровым подсистемам.
 * @param {object} ctx {
 *   net, local, remotes, netSync, weapons, grenades, powerups,
 *   modes, ui, audio, onJoined, onLeft, onMatchEnd
 * }
 */
export function attachPhotonHandlers(ctx) {
  const { net, ui, audio } = ctx;

  // ----------------------------------------------------------
  // Входящие игровые события
  // ----------------------------------------------------------
  net.on('photonEvent', ({ code, content, actorNr }) => {
    try {
      switch (code) {
        case EV.STATE:
          ctx.netSync.onRemoteState(actorNr, content);
          break;

        case EV.SHOOT:
          ctx.weapons.onRemoteShoot(actorNr, content);
          break;

        case EV.NADE:
          ctx.grenades.onRemoteThrow(actorNr, content);
          break;

        case EV.DEATH:
          handleDeath(ctx, content);
          break;

        case EV.POWERUP:
          if (content.by === ctx.local.actorNr) break; // своё уже обработано
          ctx.powerups.onRemotePickup(actorNr, content);
          break;

        case EV.HIT:
          // Урон пришёл именно нам (shooter указал to) — мы авторитетны для своего HP
          if (content && content.to === ctx.local.actorNr) {
            ctx.weapons.onIncomingHit(ctx.local, content);
          }
          break;

        case EV.MODE:
          ctx.modes.onNet(content, actorNr);
          break;

        case EV.TAUNT:
          onTaunt(ctx, actorNr);
          break;

        default:
          break;
      }
    } catch (e) {
      console.error('[Photon] ошибка обработки события', code, e);
    }
  });

  // ----------------------------------------------------------
  // Игроки заходят/выходят
  // ----------------------------------------------------------
  net.on('actorJoin', (actor) => {
    if (!ctx.net.inRoom) return;
    const team = teamForActor(actor.actorNr);
    const rp = ctx.remotes.spawn({
      actorNr: actor.actorNr,
      name: actor.name || `Кот_${actor.actorNr}`,
      team
    });
    rp.team = team;
    ctx.modes.onPlayerJoin?.(actor.actorNr, team, rp.name);
    ui?.updateScoreboard?.();
  });

  net.on('actorLeave', (actor) => {
    ctx.remotes.remove(actor.actorNr);
    ctx.modes.onPlayerLeave?.(actor.actorNr);
    ui?.updateScoreboard?.();
    ui?.killfeed?.('—', `${actor.name || `Кот_${actor.actorNr}`} вышел`);
  });

  // ----------------------------------------------------------
  // Лобби / жизненный цикл комнаты
  // ----------------------------------------------------------
  net.on('joined', (info) => {
    console.log('[Photon] комната присоединена:', info);
    ctx.netSync.start();
    ctx.onJoined?.(info);
  });

  net.on('left', () => {
    ctx.netSync.stop();
    ctx.onLeft?.();
  });

  net.on('roomLost', () => {
    ctx.netSync.stop();
    if (ctx.ui?._gameActive) ui?.showReconnect?.('Связь с комнатой потеряна');
    ctx.onLeft?.();
  });

  net.on('reconnecting', ({ attempt, delay }) => {
    // Диалог только если матч реально идёт (в лобби реконнект нормален и невидим)
    if (ctx.ui?._gameActive) ui?.showReconnect?.(`Переподключение… попытка ${attempt}`);
  });

  net.on('reconnectFailed', () => {
    const inMatch = ctx.ui?._gameActive;
    ui?.hideReconnect?.();
    if (inMatch) ui?.showReconnect?.('Не удалось переподключиться', true);
    ctx.onLeft?.();
  });

  net.on('error', ({ code, message }) => {
    console.warn('[Photon] ошибка:', code, message);
    ui?.photonStatus?.('ошибка', 'err');
  });

  net.on('badAppId', () => {
    ui?.showMessage?.(
      'Photon AppID не настроен.\n' +
      'Зарегистрируйтесь на photonengine.com, создайте RealTime App ' +
      'и вставьте AppId в js/photon.js (PHOTON_APP_ID).',
      'Мультиплеер недоступен'
    );
  });

  net.on('state', (name) => {
    const label =
      name === 'JoinedLobby' ? 'онлайн' :
      name === 'Disconnected' ? 'нет связи' :
      name === 'Error' ? 'ошибка' : 'подключение…';
    ui?.photonStatus?.(label, name === 'JoinedLobby' ? 'ok' : '');
  });

  net.on('rooms', (rooms) => ui?.renderRooms?.(rooms));
}

// ----------------------------------------------------------
// Смерть: единая обработка на всех клиентах
// ----------------------------------------------------------
function handleDeath(ctx, content) {
  const { local, remotes, ui, audio, modes, net } = ctx;
  const victimNr = content.victim;
  const killerNr = content.killer;
  const headshot = !!content.hs;

  const killer = killerNr === local.actorNr
    ? local
    : remotes.get(killerNr);
  const victim = victimNr === local.actorNr
    ? local
    : remotes.get(victimNr);

  const killerName = killer ? killer.name : 'Мир';
  const victimName = victim ? victim.name : `Кот_${victimNr}`;

  // Жертва умирает
  if (victim) {
    if (victim === local) {
      if (local.alive) local.die(killerName);
    } else {
      victim.die();
    }
  }

  // Убийца получает заслугу (единообразно на всех клиентах)
  if (killer && killer !== victim) {
    killer.kills = (killer.kills || 0) + 1;
    killer.score = (killer.score || 0) + (headshot ? 150 : 100);
    modes.onKill?.(killer, victim, headshot);
    if (killer === local) {
      audio?.play('kill');
      ui?.toast?.(headshot ? 'ХЕДШОТ!' : 'Убийство!');
      ui?.hitmarker?.(true);
    }
  }
  if (victim) victim.deaths = (victim.deaths || 0) + 1;

  ui?.killfeed?.(killerName, victimName, headshot);
  ui?.updateScoreboard?.();

  if (victim === local) {
    ui?.showDeath?.(killerName, headshot);
  }
}

// ----------------------------------------------------------
// Таунт (мяуканье)
// ----------------------------------------------------------
function onTaunt(ctx, actorNr) {
  const rp = ctx.remotes.get(actorNr);
  const name = rp ? rp.name : `Кот_${actorNr}`;
  ctx.ui?.toast?.(`${name}: мяу! 🐱`);
  ctx.audio?.play('meow_far');
}

// ----------------------------------------------------------
// Детерминированное распределение команд по номеру актора:
// 1→A, 2→B, 3→A, 4→B … (одинаково для всех клиентов)
// ----------------------------------------------------------
export function teamForActor(actorNr) {
  return actorNr % 2 === 1 ? 'a' : 'b';
}
