'use strict';

// Serveur du tableau de bord : sert l'interface web et relaie les commandes
// vers les modules Shelly du réseau local. Aucune dépendance externe.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { ShellyDevice, ShellyError } = require('./lib/shelly');

const PUBLIC_DIR = path.join(__dirname, 'public');
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};
const DEVICE_TYPES = ['cover', 'switch'];

function loadConfig(file) {
  if (!fs.existsSync(file)) {
    console.error(`Fichier de configuration introuvable : ${file}`);
    console.error('Copiez config.example.json en config.json et renseignez les adresses IP de vos modules.');
    process.exit(1);
  }
  const config = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(config.devices) || config.devices.length === 0) {
    throw new Error('La configuration doit contenir une liste « devices » non vide');
  }
  const ids = new Set();
  for (const d of config.devices) {
    if (!d.id || !d.host || !d.name) throw new Error(`Module incomplet (id, name et host requis) : ${JSON.stringify(d)}`);
    if (!DEVICE_TYPES.includes(d.type)) throw new Error(`Type inconnu « ${d.type} » pour ${d.id} (attendu : ${DEVICE_TYPES.join(', ')})`);
    if (ids.has(d.id)) throw new Error(`Identifiant en double : ${d.id}`);
    ids.add(d.id);
  }
  return config;
}

function createServer(config) {
  const timeout = config.requestTimeout ?? 3000;
  const devices = new Map(config.devices.map((d) => [d.id, new ShellyDevice(d, { timeout })]));

  function describe(device) {
    const { id, name, room, type, host } = device.config;
    return {
      id,
      name,
      room: room || 'Autres',
      type,
      webUrl: device.config.webUrl || device.baseUrl,
      host,
    };
  }

  async function readState(device) {
    try {
      return { ...describe(device), online: true, status: await device.status() };
    } catch (err) {
      return { ...describe(device), online: false, error: err.message };
    }
  }

  function sendJson(res, status, body) {
    res.writeHead(status, { 'Content-Type': MIME_TYPES['.json'], 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      let data = '';
      req.on('data', (chunk) => {
        data += chunk;
        if (data.length > 10_000) reject(new ShellyError('Requête trop volumineuse', 413));
      });
      req.on('end', () => {
        try {
          resolve(data ? JSON.parse(data) : {});
        } catch {
          reject(new ShellyError('JSON invalide', 400));
        }
      });
      req.on('error', reject);
    });
  }

  function serveStatic(req, res, pathname) {
    const relative = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
    const file = path.normalize(path.join(PUBLIC_DIR, relative));
    if (!file.startsWith(PUBLIC_DIR + path.sep)) {
      res.writeHead(403).end();
      return;
    }
    fs.readFile(file, (err, content) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Introuvable');
        return;
      }
      res.writeHead(200, { 'Content-Type': MIME_TYPES[path.extname(file)] || 'application/octet-stream' });
      res.end(req.method === 'HEAD' ? undefined : content);
    });
  }

  async function handleApi(req, res, pathname) {
    if (pathname === '/api/devices' && req.method === 'GET') {
      const states = await Promise.all([...devices.values()].map(readState));
      return sendJson(res, 200, { pollInterval: config.pollInterval ?? 3000, devices: states });
    }

    const match = pathname.match(/^\/api\/devices\/([^/]+)(\/action)?$/);
    const device = match && devices.get(decodeURIComponent(match[1]));
    if (!device) return sendJson(res, 404, { error: 'Module inconnu' });

    if (!match[2] && req.method === 'GET') {
      return sendJson(res, 200, await readState(device));
    }

    if (match[2] && req.method === 'POST') {
      const body = await readBody(req);
      await device.action(body.action, body.position);
      return sendJson(res, 200, await readState(device));
    }

    return sendJson(res, 405, { error: 'Méthode non autorisée' });
  }

  return http.createServer(async (req, res) => {
    const { pathname } = new URL(req.url, 'http://localhost');
    try {
      if (pathname.startsWith('/api/')) return await handleApi(req, res, pathname);
      if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res, pathname);
      sendJson(res, 405, { error: 'Méthode non autorisée' });
    } catch (err) {
      const status = err instanceof ShellyError ? err.status : 500;
      if (status === 500) console.error(err);
      sendJson(res, status, { error: err.message });
    }
  });
}

if (require.main === module) {
  const configFile = path.resolve(process.env.CONFIG || path.join(__dirname, 'config.json'));
  const config = loadConfig(configFile);
  const port = Number(process.env.PORT) || config.port || 8080;
  const host = process.env.HOST || config.listen || '0.0.0.0';
  createServer(config).listen(port, host, () => {
    console.log(`Tableau de bord domotique : http://localhost:${port}`);
    console.log(`${config.devices.length} module(s) configuré(s) depuis ${configFile}`);
  });
}

module.exports = { createServer, loadConfig };
