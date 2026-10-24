'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { once } = require('node:events');
const { startDevice, createCover, createSwitch } = require('../tools/simulator');
const { createServer } = require('../server');

let servers = [];
let base;

before(async () => {
  servers = [
    startDevice(9101, 'cover', createCover(100), 'secret'),
    startDevice(9102, 'plug', createSwitch()),
  ];
  const app = createServer({
    requestTimeout: 1000,
    devices: [
      { id: 'cover', name: 'Volet', room: 'Salon', type: 'cover', host: '127.0.0.1:9101', password: 'secret' },
      { id: 'plug', name: 'Lampe', room: 'Salon', type: 'switch', host: '127.0.0.1:9102' },
      { id: 'down', name: 'Absent', type: 'switch', host: '127.0.0.1:9199' },
    ],
  });
  servers.push(app.listen(0));
  await Promise.all(servers.map((s) => (s.listening ? null : once(s, 'listening'))));
  base = `http://127.0.0.1:${app.address().port}`;
});

after(() => servers.forEach((s) => s.close()));

const post = (id, body) =>
  fetch(`${base}/api/devices/${id}/action`, { method: 'POST', body: JSON.stringify(body) });

test('liste les modules avec leur état, y compris hors ligne', async () => {
  const { devices } = await (await fetch(`${base}/api/devices`)).json();
  const byId = Object.fromEntries(devices.map((d) => [d.id, d]));
  assert.strictEqual(byId.cover.online, true, byId.cover.error);
  assert.strictEqual(byId.cover.status.position, 100);
  assert.strictEqual(byId.plug.status.on, false);
  assert.strictEqual(byId.down.online, false);
  assert.strictEqual(byId.down.room, 'Autres');
  assert.strictEqual(byId.cover.webUrl, 'http://127.0.0.1:9101');
});

test('allume et éteint la prise', async () => {
  let res = await post('plug', { action: 'on' });
  assert.strictEqual((await res.json()).status.on, true);
  res = await post('plug', { action: 'toggle' });
  assert.strictEqual((await res.json()).status.on, false);
});

test('pilote le volet (auth Digest) et valide la position', async () => {
  let res = await post('cover', { action: 'position', position: 50 });
  assert.strictEqual(res.status, 200);
  assert.strictEqual((await res.json()).status.state, 'closing');
  res = await post('cover', { action: 'stop' });
  assert.strictEqual((await res.json()).status.state, 'stopped');
  res = await post('cover', { action: 'position', position: 150 });
  assert.strictEqual(res.status, 400);
  res = await post('cover', { action: 'on' });
  assert.strictEqual(res.status, 400);
});

test('refuse un module inconnu et protège les fichiers statiques', async () => {
  assert.strictEqual((await post('nope', { action: 'on' })).status, 404);
  assert.strictEqual((await fetch(`${base}/`)).status, 200);
  assert.strictEqual((await fetch(`${base}/..%2fserver.js`)).status, 403);
});
