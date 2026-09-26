'use strict';
const path = require('path');
const express = require('express');
const config = require('./config');
const db = require('./db');
const auth = require('./auth');
const scheduler = require('./sync/scheduler');

function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'same-origin');
    next();
  });
  app.get('/healthz', async (req, res) => {
    try { await db.query('SELECT 1'); res.json({ ok: true }); } catch (e) { res.status(503).json({ ok: false, error: 'database unavailable' }); }
  });
  app.use(auth.authenticate);
  app.use('/api', require('./routes/api'));
  app.use(express.static(path.join(__dirname, '..', 'public'), { index: 'index.html', maxAge: '5m' }));
  app.get(/^\/(?!api\/).*/, (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));
  return app;
}

async function start() {
  await db.migrate();
  await auth.bootstrapAdmin();
  const app = createApp();
  const server = app.listen(config.port, () => console.log(`[web] GLF CRM listening on http://localhost:${config.port}`));
  scheduler.start();
  const shutdown = () => { scheduler.stop(); server.close(() => db.close().then(() => process.exit(0))); };
  process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
  return server;
}

if (require.main === module) start().catch((e) => { console.error(e); process.exit(1); });
module.exports = { createApp, start };
