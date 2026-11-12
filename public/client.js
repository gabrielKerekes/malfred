import { SPELLS, SPELL_KEYS, TICK } from '/shared/game.js';
import {
  drawLava, drawArena, drawZones, drawPlayers, drawProjectiles, drawEffects, drawVignette, drawBackdrop as paintBackdrop,
  fxEvent, resetFx, shakeOffset,
} from './render.js';
import { ICONS, FEED_KILL, FEED_LAVA } from './icons.js';

const $ = (id) => document.getElementById(id);
const cv = $('c'), ctx = cv.getContext('2d');
const KEYMAP = {};
for (const k of SPELL_KEYS) KEYMAP[SPELLS[k].key.toLowerCase()] = k;
const INTERP = 110; // ms of render delay used to smooth snapshots

let ws = null, myId = 0, mode = '', code = '', host = 0, botsWanted = 0;
let roster = new Map();
let snaps = [];            // {time, s, P: Map}
let me = null;             // private state: pts, lv, cd
let cur = null;            // latest snapshot
let pendingEv = [];        // {time, ev}
let feed = [];             // {el, time}
let mouse = { x: 0, y: 0, down: false, lastSend: 0 };
let cam = { x: 0, y: 0, s: 1 };
let moveMark = null;
let W = 0, H = 0;

// ---------------- menu / connection ----------------
$('name').value = localStorage.getItem('malfred-name') || '';
const urlRoom = new URLSearchParams(location.search).get('room');
if (urlRoom) $('code').value = urlRoom.toUpperCase();

function connect(joinMsg) {
  $('err').textContent = 'Connecting…';
  localStorage.setItem('malfred-name', $('name').value);
  joinMsg.name = $('name').value;
  const sock = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  sock.onopen = () => sock.send(JSON.stringify(joinMsg));
  sock.onmessage = (e) => onMsg(JSON.parse(e.data), sock);
  sock.onclose = () => {
    if (ws === sock) {
      ws = null; $('hud').hidden = true; $('menu').style.display = '';
      $('err').textContent = 'Disconnected from server.';
    } else if ($('err').textContent === 'Connecting…') $('err').textContent = 'Could not connect.';
  };
}
$('btnBrawl').onclick = () => connect({ t: 'join', mode: 'brawl' });
$('btnCreate').onclick = () => connect({ t: 'join', mode: 'create' });
$('btnJoin').onclick = () => connect({ t: 'join', mode: 'room', code: $('code').value });
$('code').onkeydown = (e) => { if (e.key === 'Enter') $('btnJoin').click(); };

const send = (o) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); };

function onMsg(m, sock) {
  if (m.t === 'err') { $('err').textContent = m.m; sock.close(); return; }
  if (m.t === 'joined') {
    ws = sock; myId = m.id; mode = m.mode; code = m.code;
    snaps = []; cur = null; feed = []; pendingEv = []; resetFx(); $('feed').replaceChildren();
    $('menu').style.display = 'none'; $('hud').hidden = false; $('err').textContent = '';
    const link = `${location.origin}/?room=${code}`;
    if (mode === 'rounds') {
      history.replaceState(null, '', `?room=${code}`);
      $('roomInfo').textContent = `Room ${code}`;
      $('link').value = link; $('lobbyCode').textContent = code;
    } else {
      history.replaceState(null, '', location.pathname);
      $('roomInfo').textContent = 'Endless Brawl';
    }
    buildBar();
  } else if (m.t === 'roster') {
    host = m.host; botsWanted = m.bots;
    roster = new Map(m.list.map((p) => [p.id, p]));
    drawBoard(); drawLobby();
  } else if (m.t === 's') {
    const now = performance.now();
    const s = m.s;
    s.Pm = new Map(s.P.map((p) => [p[0], p]));
    s.Jm = new Map(s.J.map((j) => [j[0], j]));
    snaps.push({ time: now, s });
    if (snaps.length > 30) snaps.shift();
    for (const ev of s.ev) pendingEv.push({ time: now, ev });
    const phaseChanged = !cur || cur.ph !== s.ph;
    cur = s; me = m.me;
    updateBar();
    updateBanner();
    if (phaseChanged) drawLobby();
  }
}

// ---------------- lobby ----------------
$('btnCopy').onclick = () => { navigator.clipboard?.writeText($('link').value).catch(() => $('link').select()); $('btnCopy').textContent = 'Copied'; setTimeout(() => ($('btnCopy').textContent = 'Copy'), 1200); };
$('btnStart').onclick = () => send({ t: 'start' });
$('botMinus').onclick = () => send({ t: 'bots', n: botsWanted - 1 });
$('botPlus').onclick = () => send({ t: 'bots', n: botsWanted + 1 });

function drawLobby() {
  const show = mode === 'rounds' && cur && cur.ph === 'lobby';
  $('lobby').hidden = !show;
  if (!show) return;
  $('lobbyList').replaceChildren(...[...roster.values()].map((p) => {
    const el = document.createElement('span');
    el.style.borderColor = p.color;
    el.textContent = p.name + (p.bot ? ' (bot)' : p.id === host ? ' ★' : '');
    return el;
  }));
  const isHost = host === myId;
  $('botN').textContent = botsWanted;
  $('botMinus').disabled = $('botPlus').disabled = !isHost;
  $('btnStart').disabled = !isHost || roster.size < 2;
  $('lobbyNote').textContent = isHost
    ? (roster.size < 2 ? 'Need at least 2 fighters — add a bot or invite a friend.' : 'First to 5 round wins takes the match.')
    : 'Waiting for the host (★) to start…';
}

// ---------------- HUD ----------------
function drawBoard() {
  const brawl = mode === 'brawl';
  const list = [...roster.values()].sort((a, b) => brawl ? (b.level - a.level || b.kills - a.kills) : (b.score - a.score || b.kills - a.kills));
  const t = document.createElement('table');
  const hd = t.insertRow();
  for (const h of ['#', brawl ? 'Wizards' : 'Standings', brawl ? 'Lvl' : 'Wins', 'KO']) { const th = document.createElement('th'); th.textContent = h; hd.appendChild(th); }
  list.forEach((p, i) => {
    const r = t.insertRow();
    if (p.id === myId) r.className = 'me';
    r.style.setProperty('--c', p.color);
    r.insertCell().textContent = i + 1;
    const c = r.insertCell(); const dot = document.createElement('i'); dot.style.background = p.color;
    const nm = document.createElement('span'); nm.textContent = p.name + (p.bot ? '' : p.id === myId ? ' (you)' : '');
    c.append(dot, nm);
    r.insertCell().textContent = brawl ? p.level : p.score;
    r.insertCell().textContent = p.kills;
  });
  $('board').replaceChildren(t);
}

const slots = {};
function buildBar() {
  $('bar').replaceChildren();
  for (const k of SPELL_KEYS) {
    const d = SPELLS[k];
    const el = document.createElement('div');
    el.className = `slot s-${k}` + (d.passive ? ' passive' : '');
    // name/desc/key are static spell constants, never user input
    el.innerHTML = `<div class="face"><div class="ico">${ICONS[k]}</div><div class="cdm"></div><span class="cdt"></span></div>`
      + `<span class="k">${d.key}</span><div class="lv"></div><button class="up" hidden aria-label="Upgrade ${d.name}">+</button>`
      + `<div class="tip"><div class="tt"><b>${d.name}</b><kbd>${d.key}</kbd></div><p>${d.desc}</p><div class="tl"></div></div>`;
    const up = el.querySelector('.up');
    up.onclick = (e) => { e.stopPropagation(); send({ t: 'up', s: k }); };
    if (!d.passive) el.onclick = () => castAtNearest(k);
    slots[k] = { el, lv: el.querySelector('.lv'), cd: el.querySelector('.cdm'), cdt: el.querySelector('.cdt'), tl: el.querySelector('.tl'), up, last: '', p: -1, txt: '' };
    $('bar').appendChild(el);
  }
}

function updateBar() {
  if (!me) return;
  for (const k of SPELL_KEYS) {
    const d = SPELLS[k], s = slots[k], lv = me.lv[k];
    const canUp = me.pts > 0 && lv < d.max;
    const sig = `${lv}|${canUp}`;
    if (sig !== s.last) {
      s.last = sig;
      s.el.classList.toggle('locked', lv === 0);
      s.el.classList.toggle('can-up', canUp);
      s.lv.innerHTML = '<i class="on"></i>'.repeat(lv) + '<i></i>'.repeat(d.max - lv);
      s.up.hidden = !canUp;
      let info = lv ? `Level ${lv} / ${d.max}` : 'Not learned yet: spend an upgrade point';
      if (!d.passive) info += ` · ${d.cd(Math.max(1, lv)).toFixed(1)}s cooldown`;
      if (canUp) info += ` · Shift+${d.key} to upgrade`;
      s.tl.textContent = info;
    }
    if (d.passive) continue;
    const left = lv ? me.cd[k] : 0;
    const p = lv ? Math.min(1, left / (d.cd(lv) * TICK)) : 0;
    if (p !== s.p) {
      if (p === 0 && s.p > 0) { s.el.classList.remove('ready'); void s.el.offsetWidth; s.el.classList.add('ready'); }
      s.p = p; s.cd.style.setProperty('--p', p.toFixed(3));
    }
    const sec = left / TICK;
    const txt = left > 0 ? (sec >= 1 ? String(Math.ceil(sec)) : sec.toFixed(1)) : '';
    if (txt !== s.txt) { s.txt = txt; s.cdt.textContent = txt; }
  }
  let t = me.pts > 0 ? `${me.pts} upgrade point${me.pts > 1 ? 's' : ''}: click + or Shift+key` : '';
  if (mode === 'brawl') {
    t = `Level ${roster.get(myId)?.level ?? 1}` + (t ? ' · ' + t : '');
    $('xp').hidden = false;
    $('xpFill').style.width = `${Math.min(100, (100 * me.xp) / me.need)}%`;
  } else $('xp').hidden = true;
  $('pts').textContent = t;
  $('pts').classList.toggle('glow', me.pts > 0);
}

function updateBanner() {
  const b = $('banner');
  const my = cur.Pm.get(myId);
  const alive = my && (my[5] & 1);
  const wn = roster.get(cur.w)?.name || 'Nobody';
  let h = '', sub = '';
  if (mode === 'rounds') {
    if (cur.ph === 'inter') { h = `Round ${cur.rd} in ${cur.pt}`; sub = 'Spend your upgrade points!'; }
    else if (cur.ph === 'end') h = `${wn} wins the round`;
    else if (cur.ph === 'over') { h = `🏆 ${wn} wins the match!`; sub = `Back to lobby in ${cur.pt}`; }
    else if (cur.ph === 'play' && !alive) sub = 'You are out — spectating until next round';
  } else if (!alive) { h = 'Burned!'; sub = 'Respawning with a fresh build…'; }
  const sig = h + '|' + sub;
  if (b.dataset.sig !== sig) {
    const headChanged = (b.dataset.h || '') !== h;
    b.dataset.sig = sig; b.dataset.h = h; b.textContent = h;
    if (sub) { const s = document.createElement('small'); s.textContent = sub; b.appendChild(s); }
    if (headChanged && h) { b.classList.remove('pop'); void b.offsetWidth; b.classList.add('pop'); }
  }
}

// kill feed: rows are appended/removed individually so their CSS animations don't restart
function feedName(p) {
  const s = document.createElement('b');
  s.textContent = p?.name || '?';
  if (p?.color) s.style.color = p.color;
  return s;
}
function addFeed(killer, victim) {
  const row = document.createElement('div');
  const via = document.createElement('span'); via.className = 'via';
  if (killer) {
    via.innerHTML = FEED_KILL;
    row.append(feedName(killer), via, feedName(victim));
  } else {
    via.innerHTML = FEED_LAVA;
    const t = document.createElement('span'); t.textContent = 'burned in the lava';
    row.append(feedName(victim), via, t);
  }
  if (victim?.id === myId || killer?.id === myId) row.className = 'mine';
  $('feed').appendChild(row);
  feed.push({ el: row, time: performance.now() });
  if (feed.length > 5) feed.shift().el.remove();
}
setInterval(() => {
  const n = performance.now();
  while (feed.length && n - feed[0].time > 7000) feed.shift().el.remove();
}, 500);

// ---------------- input ----------------
const toWorld = (mx, my) => ({ x: (mx - W / 2) / cam.s + cam.x, y: (my - H / 2) / cam.s + cam.y });

function sendMove() {
  const w = toWorld(mouse.x, mouse.y);
  send({ t: 'move', x: Math.round(w.x), y: Math.round(w.y) });
  moveMark = { x: w.x, y: w.y, t: performance.now() };
  mouse.lastSend = performance.now();
}
function castAt(k) {
  const w = toWorld(mouse.x, mouse.y);
  send({ t: 'cast', s: k, x: Math.round(w.x), y: Math.round(w.y) });
}
function castAtNearest(k) {
  if (!cur) return;
  const my = cur.Pm.get(myId);
  if (!my) return;
  let best = null, bd = 1e9;
  for (const p of cur.P) {
    if (p[0] === myId || !(p[5] & 1)) continue;
    const d = Math.hypot(p[1] - my[1], p[2] - my[2]);
    if (d < bd) { bd = d; best = p; }
  }
  if (best) send({ t: 'cast', s: k, x: best[1], y: best[2] });
}

cv.addEventListener('contextmenu', (e) => e.preventDefault());
cv.addEventListener('pointerdown', (e) => {
  mouse.x = e.clientX; mouse.y = e.clientY;
  if (e.pointerType === 'touch' || e.button === 2) { mouse.down = true; sendMove(); }
  else if (e.button === 0) castAt('bolt');
});
cv.addEventListener('pointermove', (e) => { mouse.x = e.clientX; mouse.y = e.clientY; });
addEventListener('pointerup', () => { mouse.down = false; });
addEventListener('keydown', (e) => {
  if (!ws || e.target.tagName === 'INPUT' || e.repeat) return;
  const k = e.key.toLowerCase();
  // digits change with Shift held, so match passives by physical key
  const spell = KEYMAP[k] || (e.code === 'Digit1' ? 'vigor' : e.code === 'Digit2' ? 'swift' : null);
  if (spell) {
    if (e.shiftKey || SPELLS[spell].passive) send({ t: 'up', s: spell });
    else castAt(spell);
    e.preventDefault();
  } else if (k === 's') send({ t: 'stop' });
});

// ---------------- effects ----------------
function handleEvent(ev) {
  fxEvent(ev, { P: cur?.P, myId, cam });
  if (ev[0] === 'die') addFeed(ev[2] ? roster.get(ev[2]) || { name: '?' } : null, roster.get(ev[1]) || { name: '?' });
}

// ---------------- rendering ----------------
function resize() {
  const dpr = Math.min(2, devicePixelRatio || 1);
  W = innerWidth; H = innerHeight;
  cv.width = W * dpr; cv.height = H * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
addEventListener('resize', resize); resize();

function sample(now) {
  // find the two snapshots around render time and interpolate
  const t = now - INTERP;
  let a = snaps[0], b = snaps[snaps.length - 1];
  for (let i = snaps.length - 1; i > 0; i--) {
    if (snaps[i - 1].time <= t) { a = snaps[i - 1]; b = snaps[i]; break; }
  }
  if (t >= b.time) a = b;
  const f = a === b ? 0 : Math.max(0, Math.min(1, (t - a.time) / (b.time - a.time)));
  return { a: a.s, b: b.s, f };
}
const lerp = (x, y, f) => x + (y - x) * f;

let last = performance.now();
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.05, (now - last) / 1000); last = now;
  if (!ws || !snaps.length) { drawBackdrop(now); return; }

  while (pendingEv.length && pendingEv[0].time <= now - INTERP) handleEvent(pendingEv.shift().ev);
  if (mouse.down && now - mouse.lastSend > 90) sendMove();

  const { a, b, f } = sample(now);
  const radius = lerp(a.r, b.r, f);
  const players = [];
  for (const pb of b.P) {
    const pa = a.Pm.get(pb[0]) || pb;
    // don't glide across the map on respawn / blink
    const jump = Math.hypot(pb[1] - pa[1], pb[2] - pa[2]) > 150 || (pa[5] & 1) !== (pb[5] & 1);
    players.push({
      id: pb[0], x: jump ? pb[1] : lerp(pa[1], pb[1], f), y: jump ? pb[2] : lerp(pa[2], pb[2], f),
      hp: pb[3], maxHp: pb[4], alive: pb[5] & 1, ward: pb[5] & 2, lava: pb[5] & 4, face: pb[6] / 100,
    });
  }
  const mine = players.find((p) => p.id === myId);

  // camera: follow me; when dead, pull back to show the whole arena
  const follow = mine && mine.alive;
  const ts = follow ? Math.min(W, H) / 900 : Math.min(W, H) / (2 * radius + 260);
  const k = 1 - Math.exp(-6 * dt);
  cam.s = lerp(cam.s, Math.max(0.35, ts), k);
  cam.x = lerp(cam.x, follow ? mine.x : 0, k); cam.y = lerp(cam.y, follow ? mine.y : 0, k);

  const [shx, shy] = shakeOffset(dt);
  ctx.save();
  ctx.translate(shx, shy); // subtle screen shake, applied before the camera transform
  ctx.translate(W / 2, H / 2); ctx.scale(cam.s, cam.s); ctx.translate(-cam.x, -cam.y);
  const vw = W / cam.s, vh = H / cam.s;

  const view = { x: cam.x - vw / 2, y: cam.y - vh / 2, w: vw, h: vh };
  drawLava(ctx, now, view);
  drawArena(ctx, radius, now);
  drawZones(ctx, a, b, f, now);

  if (moveMark && now - moveMark.t < 400) {
    const q = (now - moveMark.t) / 400;
    ctx.strokeStyle = `rgba(140,255,140,${1 - q})`; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(moveMark.x, moveMark.y, 14 * (1 - q) + 3, 0, 7); ctx.stroke();
  }

  drawPlayers(ctx, players, roster, myId, now, dt);
  drawProjectiles(ctx, a, b, f, myId, now);
  drawEffects(ctx, dt, now, view, radius);
  ctx.restore();
  drawVignette(ctx, W, H, now);

  // arrow back to the arena when it is off-screen
  if (follow) {
    const d = Math.hypot(mine.x, mine.y);
    if (d - radius > Math.min(vw, vh) / 2 - 40) {
      const ang = Math.atan2(-mine.y, -mine.x), rr = Math.min(W, H) / 2 - 50;
      ctx.save(); ctx.translate(W / 2 + Math.cos(ang) * rr, H / 2 + Math.sin(ang) * rr); ctx.rotate(ang);
      ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.moveTo(16, 0); ctx.lineTo(-10, -11); ctx.lineTo(-10, 11); ctx.fill();
      ctx.restore();
    }
  }
}

function drawBackdrop(now) { paintBackdrop(ctx, now, W, H); }
requestAnimationFrame(frame);
