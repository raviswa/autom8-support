'use strict';

require('dotenv').config();

const path = require('path');
const express = require('express');
const cors = require('cors');

const app = express();
const PORT = Number(process.env.PORT) || 8090;

const origin = process.env.FRONTEND_ORIGIN || 'https://app.autom8.works';
app.use(cors({
  origin: [origin, 'http://localhost:5173', 'http://localhost:3000', 'http://127.0.0.1:5173'],
  credentials: true,
  allowedHeaders: ['Content-Type', 'Authorization', 'x-restaurant-id', 'x-internal-secret'],
}));
app.use(express.json({ limit: '1mb' }));

app.get('/health', (_req, res) => res.json({ ok: true, service: 'autom8-support' }));

const ticketsRouter = require('./src/routes/tickets');
app.use('/tickets', ticketsRouter);
app.use('/api/tickets', ticketsRouter);

// Minimal admin UI (plain HTML — no React Router)
app.use('/admin', express.static(path.join(__dirname, 'public', 'admin')));
app.get('/admin', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin', 'index.html'));
});

// TODO(scale): if dedicated support staff shouldn't see owner app, serve only
// this admin UI on support.autom8.works (Railway custom domain → same service).

app.listen(PORT, () => {
  console.log(`[autom8-support] listening on :${PORT}`);
});
