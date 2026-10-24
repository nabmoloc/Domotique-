'use strict';

// Simulateur de modules Shelly Gen2+ (RPC) pour tester le tableau de bord sans matériel.
// Usage : node tools/simulator.js  -> volets sur les ports 9001-9003, prise sur 9004.

const http = require('node:http');
const crypto = require('node:crypto');

const SPEED = 10; // % par seconde

function createCover(initialPos = 100) {
  const s = { state: initialPos === 0 ? 'closed' : initialPos === 100 ? 'open' : 'stopped', current_pos: initialPos, target_pos: null, timer: null };
  const moveTo = (target) => {
    clearInterval(s.timer);
    if (target === s.current_pos) return;
    s.target_pos = target;
    s.state = target > s.current_pos ? 'opening' : 'closing';
    s.timer = setInterval(() => {
      const step = Math.sign(target - s.current_pos) * Math.min(SPEED / 4, Math.abs(target - s.current_pos));
      s.current_pos = Math.round(s.current_pos + step);
      if (s.current_pos === target) {
        clearInterval(s.timer);
        s.target_pos = null;
        s.state = target === 100 ? 'open' : target === 0 ? 'closed' : 'stopped';
      }
    }, 250);
  };
  return {
    'Cover.GetStatus': () => ({
      id: 0,
      source: 'simulator',
      state: s.state,
      apower: s.state === 'opening' || s.state === 'closing' ? 112.4 : 0,
      voltage: 231.2,
      current: 0,
      temperature: { tC: 41.3 },
      pos_control: true,
      current_pos: s.current_pos,
      target_pos: s.target_pos,
    }),
    'Cover.Open': () => (moveTo(100), null),
    'Cover.Close': () => (moveTo(0), null),
    'Cover.Stop': () => {
      clearInterval(s.timer);
      s.target_pos = null;
      s.state = 'stopped';
      return null;
    },
    'Cover.GoToPosition': (p) => (moveTo(Math.max(0, Math.min(100, Number(p.pos)))), null),
  };
}

function createSwitch() {
  const s = { output: false };
  return {
    'Switch.GetStatus': () => ({ id: 0, source: 'simulator', output: s.output, apower: s.output ? 42.7 : 0, temperature: { tC: 35 } }),
    'Switch.Set': (p) => {
      const was_on = s.output;
      s.output = p.on === true || p.on === 'true';
      return { was_on };
    },
    'Switch.Toggle': () => {
      const was_on = s.output;
      s.output = !s.output;
      return { was_on };
    },
  };
}

function checkDigest(req, password, realm) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Digest ')) return false;
  const p = {};
  header.replace(/(\w+)=(?:"([^"]*)"|([^,\s]*))/g, (_, k, a, b) => (p[k] = a ?? b));
  const h = (v) => crypto.createHash('sha256').update(v).digest('hex');
  const ha1 = h(`admin:${realm}:${password}`);
  const ha2 = h(`${req.method}:${p.uri}`);
  return p.response === h(`${ha1}:${p.nonce}:${p.nc}:${p.cnonce}:${p.qop}:${ha2}`);
}

// ---- WebSocket minimal (RFC 6455, trames texte uniquement) ---------------------

function wsAccept(req, socket) {
  const key = req.headers['sec-websocket-key'];
  const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  );
}

function wsSend(socket, text) {
  const payload = Buffer.from(text);
  const len = payload.length;
  const header = len < 126 ? Buffer.from([0x81, len]) : Buffer.from([0x81, 126, len >> 8, len & 0xff]);
  socket.write(Buffer.concat([header, payload]));
}

function wsReader(socket, onText) {
  let buf = Buffer.alloc(0);
  socket.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 2) {
      const opcode = buf[0] & 0x0f;
      let len = buf[1] & 0x7f;
      let offset = 2;
      if (len === 126) {
        if (buf.length < 4) return;
        len = buf.readUInt16BE(2);
        offset = 4;
      }
      const masked = buf[1] & 0x80;
      if (buf.length < offset + (masked ? 4 : 0) + len) return;
      const mask = masked ? buf.subarray(offset, offset + 4) : null;
      offset += masked ? 4 : 0;
      const payload = Buffer.from(buf.subarray(offset, offset + len));
      if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
      buf = buf.subarray(offset + len);
      if (opcode === 0x8) return socket.end(Buffer.from([0x88, 0]));
      if (opcode === 0x1) onText(payload.toString());
    }
  });
}

// Vérifie l'objet « auth » d'une trame JSON-RPC (Digest SHA-256 façon Shelly).
function checkRpcAuth(auth, password, realm, nonces) {
  if (!auth || !nonces.has(auth.nonce)) return false;
  const h = (v) => crypto.createHash('sha256').update(v).digest('hex');
  const ha1 = h(`admin:${realm}:${password}`);
  const ha2 = h('dummy_method:dummy_uri');
  return auth.response === h(`${ha1}:${auth.nonce}:${auth.nc}:${auth.cnonce}:auth:${ha2}`);
}

function startDevice(port, name, handlers, password, { cors = !process.env.SIM_NO_CORS } = {}) {
  const realm = `shelly-${name}`;
  const nonces = new Set();
  const getHandler = (method) =>
    handlers[method] ||
    (method === 'Shelly.GetDeviceInfo' && (() => ({ name, id: `shelly-${port}`, model: 'SIM', gen: 4, app: 'Simulator', ver: '1.0.0' })));

  const server = http.createServer((req, res) => {
    // Comme les vrais modules Gen2+, autorise les appels depuis une page web (CORS).
    // SIM_NO_CORS=1 simule un module qui ne l'autorise pas.
    if (cors) res.setHeader('Access-Control-Allow-Origin', '*');
    // /shelly reste accessible sans mot de passe, comme sur les vrais modules.
    if (req.url === '/shelly') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ name, id: `shelly-${port}`, model: 'SIM', gen: 4, ver: '1.0.0', app: 'Simulator', auth_en: Boolean(password) }));
    }
    if (password && !checkDigest(req, password, realm)) {
      res.writeHead(401, {
        'WWW-Authenticate': `Digest qop="auth", realm="${realm}", nonce="${Date.now()}", algorithm=SHA-256`,
      });
      return res.end();
    }
    const url = new URL(req.url, 'http://localhost');
    const method = url.pathname.replace(/^\/rpc\//, '');
    if (url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(`<h1>${name}</h1><p>Interface web simulée du module Shelly.</p>`);
    }
    const handler = getHandler(method);
    if (!url.pathname.startsWith('/rpc/') || !handler) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ code: 404, message: `No handler for ${method}` }));
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(handler(Object.fromEntries(url.searchParams))));
  });

  // JSON-RPC sur WebSocket (ws://<ip>/rpc), comme les vrais modules.
  server.on('upgrade', (req, socket) => {
    if (new URL(req.url, 'http://localhost').pathname !== '/rpc') return socket.destroy();
    wsAccept(req, socket);
    socket.on('error', () => {});
    wsReader(socket, (text) => {
      let frame;
      try {
        frame = JSON.parse(text);
      } catch {
        return;
      }
      const reply = (body) => wsSend(socket, JSON.stringify({ id: frame.id, src: `shelly-${port}`, dst: frame.src, ...body }));
      if (password && !checkRpcAuth(frame.auth, password, realm, nonces)) {
        const nonce = Math.floor(Date.now() / 1000) + nonces.size;
        nonces.add(nonce);
        return reply({
          error: { code: 401, message: JSON.stringify({ auth_type: 'digest', nonce, nc: 1, realm, algorithm: 'SHA-256' }) },
        });
      }
      const handler = getHandler(frame.method);
      if (!handler) return reply({ error: { code: 404, message: `No handler for ${frame.method}` } });
      reply({ result: handler(frame.params || {}) });
    });
  });

  return server.listen(port, process.env.SIM_HOST || '127.0.0.1', () => console.log(`  ${name} simulé sur le port ${port}`));
}

function startSimulator() {
  console.log('Simulateur Shelly :');
  return [
    startDevice(9001, 'volet-salon-1', createCover(100)),
    startDevice(9002, 'volet-salon-2', createCover(40)),
    startDevice(9003, 'volet-chambre', createCover(0), process.env.SIM_PASSWORD ?? 'demo'),
    startDevice(9004, 'lumiere-salon', createSwitch()),
  ];
}

if (require.main === module) startSimulator();

module.exports = { startSimulator, startDevice, createCover, createSwitch };
