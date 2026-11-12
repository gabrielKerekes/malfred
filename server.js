// HTTP static file server + WebSocket game server. One process, no build step.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { Game, TICK } from './shared/game.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.m4a': 'audio/mp4', '.png': 'image/png', '.webp': 'image/webp',
  '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json', '.bin': 'application/octet-stream',
  '.ktx2': 'image/ktx2', '.json': 'application/json',
};
const BRAWL_MAX_HUMANS = 14;
const BRAWL_MIN_FIGHTERS = 6;
const ROOM_MAX = 10;
// MALFRED_DEV=1: every human starts with all spells at max level (for testing)
const DEV = process.env.MALFRED_DEV === '1';

const server = http.createServer((req, res) => {
  let p;
  try { p = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { res.writeHead(400); res.end('bad request'); return; }
  if (p === '/healthz') { res.writeHead(200); res.end('ok'); return; }
  if (p === '/') p = '/index.html';
  // /shared/* is served from ./shared, everything else from ./public; never above either
  const shared = p.startsWith('/shared/');
  const base = path.join(ROOT, shared ? 'shared' : 'public');
  const file = path.normalize(path.join(base, shared ? p.slice('/shared'.length) : p));
  if (!file.startsWith(base + path.sep) || !MIME[path.extname(file)]) { res.writeHead(404); res.end('not found'); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)], 'Cache-Control': 'no-cache' });
    res.end(data);
  });
});

const rooms = new Map(); // code -> room

function makeCode() {
  const A = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let c;
  do { c = Array.from({ length: 4 }, () => A[Math.floor(Math.random() * A.length)]).join(''); } while (rooms.has(c));
  return c;
}

function createRoom(mode) {
  const room = { code: makeCode(), mode, game: new Game(mode, { allSpells: DEV }), conns: new Map(), host: 0, bots: mode === 'rounds' ? 3 : 0 };
  rooms.set(room.code, room);
  syncBots(room);
  return room;
}

function syncBots(room) {
  const g = room.game;
  const bots = [...g.players.values()].filter((p) => p.bot);
  const humans = g.players.size - bots.length;
  const want = room.mode === 'brawl'
    ? Math.max(0, BRAWL_MIN_FIGHTERS - humans)
    : Math.min(room.bots, ROOM_MAX - humans);
  for (let i = bots.length; i < want; i++) g.addPlayer('', true);
  for (let i = bots.length; i > want; i--) g.removePlayer(bots[i - 1].id);
}

function send(ws, obj) { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); }

function sendRoster(room) {
  const msg = JSON.stringify({ t: 'roster', host: room.host, bots: room.bots, list: room.game.roster() });
  for (const ws of room.conns.keys()) if (ws.readyState === 1) ws.send(msg);
  room.game.dirty = false;
}

function join(ws, m) {
  const name = String(m.name || '').replace(/[^\p{L}\p{N} _\-.!?]/gu, '').trim().slice(0, 14) || 'Mage';
  let room;
  if (m.mode === 'brawl') {
    room = [...rooms.values()].find((r) => r.mode === 'brawl' && r.conns.size < BRAWL_MAX_HUMANS) || createRoom('brawl');
  } else if (m.mode === 'create') {
    room = createRoom('rounds');
  } else {
    room = rooms.get(String(m.code || '').toUpperCase().trim());
    if (!room || room.mode !== 'rounds') return send(ws, { t: 'err', m: 'Room not found.' });
    if (room.conns.size >= ROOM_MAX) return send(ws, { t: 'err', m: 'Room is full.' });
  }
  if (room.mode === 'rounds') {
    // make space for a human by dropping a bot if the room is full
    const g = room.game;
    if (g.players.size >= ROOM_MAX) {
      const b = [...g.players.values()].find((p) => p.bot);
      if (b) g.removePlayer(b.id);
    }
  }
  const p = room.game.addPlayer(name);
  ws.room = room; ws.pid = p.id;
  room.conns.set(ws, p.id);
  if (!room.host) room.host = p.id;
  syncBots(room);
  send(ws, { t: 'joined', id: p.id, code: room.code, mode: room.mode });
  sendRoster(room);
}

function leave(ws) {
  const room = ws.room;
  if (!room) return;
  ws.room = null;
  room.conns.delete(ws);
  room.game.removePlayer(ws.pid);
  if (room.conns.size === 0) { rooms.delete(room.code); return; }
  if (room.host === ws.pid) room.host = room.conns.values().next().value;
  syncBots(room);
  sendRoster(room);
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(-5000, Math.min(5000, v)) : null);

function onMessage(ws, raw) {
  let m;
  try { m = JSON.parse(raw); } catch { return; }
  if (!m || typeof m !== 'object') return;
  if (!ws.room) { if (m.t === 'join') join(ws, m); return; }
  const room = ws.room, g = room.game, id = ws.pid;
  const x = num(m.x), y = num(m.y);
  switch (m.t) {
    case 'move': if (x !== null && y !== null) g.setMove(id, x, y); break;
    case 'stop': g.stop(id); break;
    case 'cast': if (x !== null && y !== null && typeof m.s === 'string') g.cast(id, m.s, x, y); break;
    case 'up': if (typeof m.s === 'string') g.upgrade(id, m.s); break;
    case 'start': if (id === room.host) g.start(); break;
    case 'bots':
      if (id === room.host && room.mode === 'rounds' && g.phase === 'lobby' && Number.isInteger(m.n)) {
        room.bots = Math.max(0, Math.min(ROOM_MAX - 1, m.n));
        syncBots(room);
        sendRoster(room);
      }
      break;
  }
}

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 2048 });
wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', (raw) => onMessage(ws, raw));
  ws.on('close', () => leave(ws));
  ws.on('error', () => {});
});

// simulation loop: 30 ticks/s, snapshots every other tick
let n = 0;
setInterval(() => {
  n++;
  for (const room of rooms.values()) {
    const g = room.game;
    // a bug in one room must not take down every other room with it
    try { g.step(); } catch (e) { console.error(`room ${room.code} step failed:`, e); continue; }
    if (n % 2) continue;
    const snap = JSON.stringify(g.snapshot());
    for (const [ws, pid] of room.conns) {
      if (ws.readyState === 1) ws.send(`{"t":"s","s":${snap},"me":${JSON.stringify(g.priv(pid))}}`);
    }
    if (g.dirty) sendRoster(room);
  }
}, 1000 / TICK);

setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false; ws.ping();
  }
}, 30000);

server.listen(PORT, () => console.log(`Malfred listening on http://localhost:${PORT}${DEV ? ' (DEV: all spells unlocked)' : ''}`));
