// ============================================================
// photon.js — клиент Photon Realtime (LoadBalancing).
// Никакого своего сервера: комнаты, матчмейкинг, relay — Photon Cloud.
// ============================================================

import { Emitter } from './utils.js';

// ============================================================
//  ВСТАВЬТЕ СЮДА СВОЙ AppID с дашборда photonengine.com
//  (Dashboard → Create App → тип RealTime → AppId string)
// ============================================================
export const PHOTON_APP_ID = '95ae7e33-c745-49ff-ae39-4d1750249816';
export const PHOTON_APP_VERSION = '1.0';
// ============================================================

const PROTOCOL_WSS = 1; // 1 = WSS (WebSocket Secure)

/** Коды состояний SDK (совпадают с Photon.LoadBalancing.LoadBalancingClient.State) */
const STATE = {
  Error: -1,
  Uninitialized: 0,
  ConnectingToNameServer: 1,
  ConnectedToNameServer: 2,
  ConnectingToMasterserver: 3,
  ConnectedToMaster: 4,
  JoinedLobby: 5,
  ConnectingToGameserver: 6,
  ConnectedToGameserver: 7,
  Joined: 8,
  Disconnected: 10
};

/** Определение ближайшего региона по языку браузера */
export function detectRegion() {
  const lang = (navigator.language || 'en').toLowerCase();
  const region = lang.split('-')[1] || '';
  const map = {
    // Азия
    cn: 'asia', tw: 'asia', hk: 'asia', jp: 'asia', kr: 'asia', sg: 'asia',
    th: 'asia', vn: 'asia', id: 'asia', my: 'asia', ph: 'asia', in: 'asia', tw: 'asia',
    // США
    us: 'us', ca: 'us', mx: 'us',
    // Россия/СНГ/Европа
    ru: 'eu', ua: 'eu', by: 'eu', kz: 'eu', de: 'eu', fr: 'eu', gb: 'eu', en: 'eu',
    it: 'eu', es: 'eu', pt: 'eu', pl: 'eu', tr: 'eu', nl: 'eu', se: 'eu', no: 'eu',
    fi: 'eu', cz: 'eu', ro: 'eu', bg: 'eu', rs: 'eu'
  };
  return map[region] || map[lang] || 'eu';
}

export class PhotonNet extends Emitter {
  constructor() {
    super();

    this.client = null;
    this.connected = false;
    this.inRoom = false;
    this.region = detectRegion();
    this.nick = 'Кот_Боец';
    this.pendingMode = 'team';
    this._reconnectTries = 0;
    this._wantConnection = false;
    this._roomName = '';

    // События наружу: 'state' (имя), 'rooms', 'joined', 'left', 'error',
    // 'actorJoin', 'actorLeave', 'photonEvent', 'ready', 'opError'
  }

  /** Есть ли SDK в окне */
  get sdkAvailable() {
    return typeof window !== 'undefined' && !!window.Photon;
  }

  /** Подключение к Master-серверу региона */
  connect(region = null) {
    if (!this.sdkAvailable) {
      const err = new Error('Photon SDK не загружен (lib/photon-javascript-sdk.min.js)');
      console.error('[Photon]', err.message);
      this.emit('error', { code: -1, message: err.message });
      return false;
    }
    if (this.client && this.connected) return true;

    this.region = region || this.region;
    this._wantConnection = true;

    if (!this.client) {
      console.log(`[Photon] создание клиента region=${this.region}`);
      this.client = new window.Photon.LoadBalancing.LoadBalancingClient(
        PROTOCOL_WSS,
        PHOTON_APP_ID,
        PHOTON_APP_VERSION
      );
      this._wire();
    }

    try {
      this.client.connectToRegionMaster(this.region);
      this.emit('state', 'ConnectingToNameServer');
      return true;
    } catch (e) {
      console.error('[Photon] ошибка подключения:', e);
      this.emit('error', { code: -2, message: String(e.message || e) });
      return false;
    }
  }

  /** Привязка колбэков SDK */
  _wire() {
    const c = this.client;
    const S = window.Photon.LoadBalancing.LoadBalancingClient.State;

    c.onStateChange = (state) => {
      const name = window.Photon.LoadBalancing.LoadBalancingClient.stateName[state] || state;
      console.log(`[Photon] state → ${name}`);
      this.emit('state', name);

      if (state === S.JoinedLobby) {
        this.connected = true;
        this._reconnectTries = 0;
        this.emit('ready');
        this.refreshRooms();
      }
      if (state === S.Joined) {
        this.inRoom = true;
        this._reconnectTries = 0;
        this._roomName = c.myRoom().getName();
        console.log(`[Photon] вошли в комнату "${this._roomName}"`);
        this.emit('joined', { name: this._roomName, createdByMe: this._lastCreated });
      }
      if (state === S.Disconnected) {
        const wasInRoom = this.inRoom;
        this.connected = false;
        this.inRoom = false;
        if (this._wantConnection) this._tryReconnect();
        else this.emit('left', { reason: 'disconnect' });
        if (wasInRoom) this.emit('roomLost');
      }
      if (state === S.Error) {
        this.connected = false;
      }
    };

    c.onError = (code, msg) => {
      console.warn(`[Photon] error ${code}: ${msg}`);
      this.emit('error', { code, message: msg });
      // Типовые ошибки: плохой AppID / нет места
      if (code === 32756 || /AppId/i.test(msg || '')) {
        this.emit('badAppId');
      }
    };

    c.onOperationResponse = (errorCode, errorMsg, code) => {
      if (errorCode !== 0) {
        console.warn(`[Photon] op ${code} failed: ${errorCode} ${errorMsg}`);
        this.emit('opError', { errorCode, errorMsg, code });
      }
    };

    c.onRoomList = (rooms) => {
      this.emit('rooms', rooms);
    };
    c.onRoomListUpdate = (rooms, updated, added, removed) => {
      console.log(`[Photon] список комнат: +${added.length} ~${updated.length} -${removed.length}`);
      this.emit('rooms', rooms);
    };

    c.onJoinRoom = (createdByMe) => {
      this._lastCreated = createdByMe;
      if (createdByMe) this.emit('created', { name: this._roomName });
    };

    c.onActorJoin = (actor) => {
      if (actor.actorNr === c.myActor().actorNr) return;
      console.log(`[Photon] игрок вошёл #${actor.actorNr} "${actor.name}"`);
      this.emit('actorJoin', actor);
    };

    c.onActorLeave = (actor) => {
      console.log(`[Photon] игрок вышел #${actor.actorNr}`);
      this.emit('actorLeave', actor);
    };

    c.onActorPropertiesChange = (actor) => {
      this.emit('actorProps', actor);
    };

    c.onMyRoomPropertiesChange = () => {
      this.emit('roomProps', c.myRoom());
    };

    // Главный сетевой диспетчер событий игры
    c.onEvent = (eventCode, content, actorNr) => {
      this.emit('photonEvent', { code: eventCode, content, actorNr });
    };
  }

  _tryReconnect() {
    if (this._reconnectTries >= 5) {
      this.emit('reconnectFailed');
      this._wantConnection = false;
      return;
    }
    this._reconnectTries++;
    const delay = Math.min(1000 * Math.pow(2, this._reconnectTries - 1), 10000);
    console.log(`[Photon] реконнект #${this._reconnectTries} через ${delay} мс`);
    this.emit('reconnecting', { attempt: this._reconnectTries, delay });
    setTimeout(() => {
      if (this._wantConnection && !this.connected) this.connect();
    }, delay);
  }

  // ---------- Лобби ----------

  /** Обновить список комнат */
  refreshRooms() {
    if (!this.client || !this.connected) return [];
    // Метод availableRooms() возвращает закешированный список;
    // принудительное обновление — повторный вход в лобби не требуется:
    // SDK присылает onRoomList/onRoomListUpdate автоматически при подключении
    const rooms = this.client.availableRooms ? this.client.availableRooms() : [];
    this.emit('rooms', rooms);
    return rooms;
  }

  /** Создать комнату с настройками режима */
  createRoom(name, { mode = 'team', maxPlayers = 8, map = 'city', bots = 0 } = {}) {
    if (!this.client) return false;
    const roomName = (name || `cat_room_${Math.floor(Math.random() * 900 + 100)}`).slice(0, 24);
    this._roomName = roomName;
    this.pendingMode = mode;
    console.log(`[Photon] создание комнаты "${roomName}" mode=${mode}`);
    return this.client.createRoom(roomName, {
      maxPlayers,
      isVisible: true,
      isOpen: true,
      customGameProperties: { mode, map, bots },
      propsListedInLobby: ['mode', 'map']
    });
  }

  /** Войти в комнату по имени (создать, если не существует) */
  joinRoom(name, { mode = 'team', maxPlayers = 8, map = 'city' } = {}) {
    if (!this.client || !name) return false;
    this._roomName = name.slice(0, 24);
    this.pendingMode = mode;
    console.log(`[Photon] вход в комнату "${this._roomName}"`);
    return this.client.joinRoom(this._roomName, {}, {
      maxPlayers,
      isVisible: true,
      isOpen: true,
      customGameProperties: { mode, map, bots: 0 },
      propsListedInLobby: ['mode', 'map']
    });
  }

  /** Случайная комната (быстрая игра) */
  joinRandom(mode = 'team') {
    if (!this.client) return false;
    this.pendingMode = mode;
    console.log('[Photon] быстрая игра (joinRandomRoom)');
    const ok = this.client.joinRandomRoom({
      expectedCustomRoomProperties: undefined // берём любую открытую
    });
    return ok;
  }

  /** Свойство текущей комнаты */
  roomProperty(key, fallback = null) {
    if (!this.client || !this.inRoom) return fallback;
    const v = this.client.myRoom().getCustomProperty(key);
    return v === undefined ? fallback : v;
  }

  setRoomProperty(key, value) {
    if (this.client && this.inRoom) {
      this.client.myRoom().setCustomProperty(key, value);
    }
  }

  /** Установить никнейм актора */
  setNick(name) {
    this.nick = (name || 'Кот_Боец').slice(0, 16);
    try {
      if (this.client) this.client.myActor().setName(this.nick);
    } catch (_) {}
  }

  /** Номер своего актора */
  get myActorNr() {
    return this.client?.myActor?.().actorNr ?? 1;
  }

  /** Все акторы комнаты (включая своего) */
  actors() {
    if (!this.client || !this.inRoom) return [];
    return this.client.myRoomActorsArray();
  }

  /**
   * Отправить событие игры.
   * @param {number} code код из utils.EV
   * @param {object} data
   * @param {boolean} reliable true — доставка гарантирована (смерть, выстрел, бонус)
   */
  raise(code, data, reliable = false) {
    if (!this.client || !this.inRoom) return false;
    this.client.raiseEvent(code, data, { reliable: !!reliable });
    return true;
  }

  /** Выйти из комнаты */
  leaveRoom() {
    this._wantConnection = true;
    if (this.client && this.inRoom) {
      try { this.client.leaveRoom(); } catch (e) { console.warn('[Photon]', e); }
    }
    this.inRoom = false;
    this.emit('left', { reason: 'manual' });
  }

  /** Полное отключение */
  disconnect() {
    this._wantConnection = false;
    this.inRoom = false;
    this.connected = false;
    try { this.client?.disconnect(); } catch (_) {}
    this.emit('state', 'Disconnected');
  }

  /** Статус для UI */
  statusText() {
    if (!this.sdkAvailable) return 'SDK не найден';
    if (!this.connected) return 'подключение…';
    if (this.inRoom) return `комната: ${this._roomName}`;
    return `онлайн (${this.region})`;
  }
}

export const net = new PhotonNet();
