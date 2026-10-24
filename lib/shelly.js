'use strict';

// Client minimal pour les modules Shelly.
// - Gen2+ (Plus, Pro, Gen3, Gen4) : API RPC HTTP (/rpc/<Méthode>), auth Digest SHA-256.
// - Gen1 (ancienne Shelly Plug S, etc.) : API REST (/status, /relay/0), auth Basic.

const crypto = require('node:crypto');

class ShellyError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'ShellyError';
    this.status = status;
  }
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function parseDigestChallenge(header) {
  const params = {};
  const re = /(\w+)=(?:"([^"]*)"|([^,\s]*))/g;
  let match;
  while ((match = re.exec(header)) !== null) {
    params[match[1]] = match[2] !== undefined ? match[2] : match[3];
  }
  return params;
}

function buildDigestHeader(challenge, { username, password, method, uri }) {
  const cnonce = crypto.randomBytes(8).toString('hex');
  const nc = '00000001';
  const qop = 'auth';
  const ha1 = sha256(`${username}:${challenge.realm}:${password}`);
  const ha2 = sha256(`${method}:${uri}`);
  const response = sha256(`${ha1}:${challenge.nonce}:${nc}:${cnonce}:${qop}:${ha2}`);
  return (
    `Digest username="${username}", realm="${challenge.realm}", nonce="${challenge.nonce}", ` +
    `uri="${uri}", algorithm=SHA-256, response="${response}", qop=${qop}, nc=${nc}, cnonce="${cnonce}"`
  );
}

async function fetchWithTimeout(url, options, timeout) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (err) {
    if (err.name === 'AbortError') throw new ShellyError('Module injoignable (délai dépassé)', 504);
    throw new ShellyError(`Module injoignable (${err.cause?.code || err.message})`, 502);
  } finally {
    clearTimeout(timer);
  }
}

async function readJson(res) {
  if (res.status === 401) throw new ShellyError('Authentification refusée (vérifier le mot de passe)', 401);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new ShellyError(`Erreur du module (HTTP ${res.status}) ${text}`.trim(), 502);
  }
  return res.json();
}

class ShellyDevice {
  constructor(config, { timeout = 3000 } = {}) {
    this.config = config;
    this.timeout = timeout;
    this.channel = config.channel ?? 0;
    this.generation = config.generation ?? 2;
    this.baseUrl = /^https?:\/\//.test(config.host) ? config.host.replace(/\/$/, '') : `http://${config.host}`;
  }

  // ---- Transport -----------------------------------------------------------

  async get(path) {
    const url = this.baseUrl + path;
    const { password } = this.config;

    if (this.generation === 1) {
      const headers = {};
      if (password) {
        const user = this.config.username || 'admin';
        headers.Authorization = 'Basic ' + Buffer.from(`${user}:${password}`).toString('base64');
      }
      return readJson(await fetchWithTimeout(url, { headers }, this.timeout));
    }

    let res = await fetchWithTimeout(url, {}, this.timeout);
    if (res.status === 401 && password) {
      const challenge = parseDigestChallenge(res.headers.get('www-authenticate') || '');
      const authorization = buildDigestHeader(challenge, {
        username: 'admin',
        password,
        method: 'GET',
        uri: path,
      });
      res = await fetchWithTimeout(url, { headers: { Authorization: authorization } }, this.timeout);
    }
    return readJson(res);
  }

  rpc(method, params = {}) {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) query.set(key, String(value));
    return this.get(`/rpc/${method}?${query}`);
  }

  // ---- Volets (Shelly 2PM en mode « cover ») ----------------------------------

  async coverStatus() {
    const s = await this.rpc('Cover.GetStatus', { id: this.channel });
    return {
      state: s.state, // open | closed | opening | closing | stopped | calibrating
      position: typeof s.current_pos === 'number' ? s.current_pos : null,
      targetPosition: typeof s.target_pos === 'number' ? s.target_pos : null,
      positionControl: Boolean(s.pos_control),
      power: typeof s.apower === 'number' ? s.apower : null,
      temperature: s.temperature?.tC ?? null,
    };
  }

  coverOpen() {
    return this.rpc('Cover.Open', { id: this.channel });
  }

  coverClose() {
    return this.rpc('Cover.Close', { id: this.channel });
  }

  coverStop() {
    return this.rpc('Cover.Stop', { id: this.channel });
  }

  coverGoTo(position) {
    return this.rpc('Cover.GoToPosition', { id: this.channel, pos: position });
  }

  // ---- Prises / relais -------------------------------------------------------

  async switchStatus() {
    if (this.generation === 1) {
      const s = await this.get('/status');
      const relay = s.relays?.[this.channel] || {};
      const meter = s.meters?.[this.channel] || {};
      return { on: Boolean(relay.ison), power: typeof meter.power === 'number' ? meter.power : null };
    }
    const s = await this.rpc('Switch.GetStatus', { id: this.channel });
    return {
      on: Boolean(s.output),
      power: typeof s.apower === 'number' ? s.apower : null,
      temperature: s.temperature?.tC ?? null,
    };
  }

  switchSet(on) {
    if (this.generation === 1) return this.get(`/relay/${this.channel}?turn=${on ? 'on' : 'off'}`);
    return this.rpc('Switch.Set', { id: this.channel, on });
  }

  switchToggle() {
    if (this.generation === 1) return this.get(`/relay/${this.channel}?turn=toggle`);
    return this.rpc('Switch.Toggle', { id: this.channel });
  }

  // ---- Interface générique ----------------------------------------------------

  status() {
    return this.config.type === 'cover' ? this.coverStatus() : this.switchStatus();
  }

  async action(name, value) {
    if (this.config.type === 'cover') {
      switch (name) {
        case 'open':
          return this.coverOpen();
        case 'close':
          return this.coverClose();
        case 'stop':
          return this.coverStop();
        case 'position': {
          const pos = Number(value);
          if (!Number.isInteger(pos) || pos < 0 || pos > 100) {
            throw new ShellyError('La position doit être un entier entre 0 et 100', 400);
          }
          return this.coverGoTo(pos);
        }
      }
    } else {
      switch (name) {
        case 'on':
          return this.switchSet(true);
        case 'off':
          return this.switchSet(false);
        case 'toggle':
          return this.switchToggle();
      }
    }
    throw new ShellyError(`Action « ${name} » non supportée pour ce module`, 400);
  }
}

module.exports = { ShellyDevice, ShellyError, parseDigestChallenge, buildDigestHeader };
