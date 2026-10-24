'use strict';

// Lance le simulateur et le tableau de bord ensemble : npm run demo
const path = require('node:path');
const { startSimulator } = require('./simulator');
const { createServer, loadConfig } = require('../server');

startSimulator();
const config = loadConfig(path.join(__dirname, 'config.demo.json'));
const port = Number(process.env.PORT) || config.port;
createServer(config).listen(port, () => console.log(`\nTableau de bord (démo) : http://localhost:${port}`));
