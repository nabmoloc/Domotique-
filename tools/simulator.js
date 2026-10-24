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
      s.output = p.on === 'true';
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

function startDevice(port, name, handlers, password) {
  const realm = `shelly-${name}`;
  return http
    .createServer((req, res) => {
      // Comme les vrais modules Gen2+, autorise les appels depuis une page web (CORS).
      res.setHeader('Access-Control-Allow-Origin', '*');
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
      const handler =
        handlers[method] ||
        (method === 'Shelly.GetDeviceInfo' && (() => ({ name, id: `shelly-${port}`, model: 'SIM', gen: 4, app: 'Simulator', ver: '1.0.0' })));
      if (!url.pathname.startsWith('/rpc/') || !handler) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ code: 404, message: `No handler for ${method}` }));
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(handler(Object.fromEntries(url.searchParams))));
    })
    .listen(port, '127.0.0.1', () => console.log(`  ${name} simulé sur http://127.0.0.1:${port}`));
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
