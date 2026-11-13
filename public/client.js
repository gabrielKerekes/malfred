import { SPELLS, SPELL_KEYS, TICK, SKINS, SKIN_IDS } from '/shared/game.js';
import { sfx, setListener, setSizzle, toggleMute, isMuted } from './audio.js';
import { cam, toWorld, updateCamera, drawCameraHud, touchGesture, setProjection } from './camera.js';
import {
  drawLava, drawArena, drawZones, drawPlayers, drawProjectiles, drawEffects, drawVignette, drawBackdrop as paintBackdrop,
  fxEvent, resetFx, shakeOffset, drawTerrain, drawTerrainTops, drawSkinPreview,
} from './render.js';
import { ICONS, FEED_KILL, FEED_LAVA } from './icons.js';
import { createTutorial } from './tutorial.js';

const $ = (id) => document.getElementById(id);
const cv = $('c'), ctx = cv.getContext('2d');
const KEYMAP = {};
for (const k of SPELL_KEYS) KEYMAP[SPELLS[k].key.toLowerCase()] = k;
const INTERP = 110; // ms of render delay used to smooth snapshots


let ws = null, myId = 0, mode = '', code = '', host = 0, botsWanted = 0, terrain = 1;
let roster = new Map();
let snaps = [];            // {time, s, P: Map}
let me = null;             // private state: pts, lv, cd
let cur = null;            // latest snapshot
let pendingEv = [];        // {time, ev}
let feed = [];             // {el, time}
let mouse = { x: 0, y: 0, down: false, lastSend: 0 };
let moveMark = null;
let W = 0, H = 0;

// ---------------- graphics: 3D (three.js, default) or 2D canvas ----------------
// The WebGL canvas sits under #c; #c stays on top as the input surface and the
// overlay for names, health bars and camera HUD.
const glCanvas = $('gl');
let gfx = '3d';
try { gfx = localStorage.getItem('malfred-gfx') === '2d' ? '2d' : '3d'; } catch {}
let r3d = null, r3dFailed = false, r3dLoading = null;
const use3d = () => gfx === '3d' && !!r3d;
function loadR3d() {
  if (!r3dLoading) {
    r3dLoading = import('./render3d.js')
      .then(async (m) => { if (!(await m.init(glCanvas))) throw new Error('WebGL unavailable'); r3d = m; })
      .catch((e) => { console.warn('[malfred] 3D renderer unavailable, using 2D', e); r3dFailed = true; gfx = '2d'; })
      .finally(applyGfx);
  }
  return r3dLoading;
}
function applyGfx() {
  setProjection(use3d() ? '3d' : '2d');
  r3d?.setActive(use3d() && !!ws);
  resetFx(); r3d?.resetFx();
  const b = $('btnGfx');
  b.textContent = r3dFailed ? 'Graphics: 2D (3D unavailable)' : `Graphics: ${gfx === '3d' ? (r3d ? '3D' : '3D (loading…)') : '2D'}`;
  b.disabled = r3dFailed;
}
$('btnGfx').onclick = () => {
  gfx = gfx === '3d' ? '2d' : '3d';
  try { localStorage.setItem('malfred-gfx', gfx); } catch {}
  if (gfx === '3d' && !r3d) loadR3d();
  applyGfx();
};
if (gfx === '3d') loadR3d(); else applyGfx();

// ---------------- menu / connection ----------------
$('name').value = localStorage.getItem('malfred-name') || '';
const urlRoom = new URLSearchParams(location.search).get('room');
if (urlRoom) $('code').value = urlRoom.toUpperCase();

// ---------------- wizard look ----------------
// The robe takes your fighter colour in game; the menu previews it in a neutral one.
const PREVIEW_COLOR = '#4da6ff';
let skin = 'classic';
try { const v = localStorage.getItem('malfred-skin'); if (SKIN_IDS.includes(v)) skin = v; } catch {}
const skinCards = SKINS.map((k) => {
  const b = document.createElement('button');
  b.className = 'skin'; b.type = 'button'; b.setAttribute('role', 'radio'); b.title = k.name;
  const c = document.createElement('canvas');
  const l = document.createElement('span'); l.textContent = k.name;
  b.append(c, l);
  b.onclick = () => setSkin(k.id);
  $('skins').appendChild(b);
  return { id: k.id, b, c };
});
function setSkin(id) {
  skin = id;
  try { localStorage.setItem('malfred-skin', id); } catch {}
  for (const k of skinCards) { k.b.classList.toggle('on', k.id === id); k.b.setAttribute('aria-checked', k.id === id); }
  $('btnSkin').textContent = `Look: ${SKINS.find((k) => k.id === id).name}`;
  send({ t: 'skin', s: id });
}
function drawSkinCards(now) {
  const dpr = Math.min(2, devicePixelRatio || 1);
  for (const k of skinCards) {
    const w = Math.round(k.c.clientWidth * dpr), h = Math.round(k.c.clientHeight * dpr);
    if (!w || !h) continue;
    if (k.c.width !== w || k.c.height !== h) { k.c.width = w; k.c.height = h; }
    drawSkinPreview(k.c, PREVIEW_COLOR, k.id, now);
  }
}
$('btnSkin').onclick = () => setSkin(SKIN_IDS[(SKIN_IDS.indexOf(skin) + 1) % SKIN_IDS.length]);

// ---------------- tutorial ----------------
const tut = createTutorial($('tut'), {
  onBrawl: () => { leaveGame(); connect({ t: 'join', mode: 'brawl' }); },
  onMenu: () => leaveGame(),
});
try { if (localStorage.getItem('malfred-tutorial') !== 'done') $('btnTutorial').classList.add('new'); } catch {}

function connect(joinMsg) {
  $('err').textContent = 'Connecting…';
  localStorage.setItem('malfred-name', $('name').value);
  joinMsg.name = $('name').value;
  joinMsg.skin = skin;
  const sock = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  sock.onopen = () => sock.send(JSON.stringify(joinMsg));
  sock.onmessage = (e) => onMsg(JSON.parse(e.data), sock);
  sock.onclose = () => {
    if (ws === sock) {
      ws = null; $('hud').hidden = true; $('pause').hidden = true; $('menu').style.display = ''; tut.stop();
      r3d?.setActive(false);
      setSizzle(false);
      $('err').textContent = 'Disconnected from server.';
    } else if ($('err').textContent === 'Connecting…') $('err').textContent = 'Could not connect.';
  };
}
$('btnBrawl').onclick = () => connect({ t: 'join', mode: 'brawl' });
$('btnCreate').onclick = () => connect({ t: 'join', mode: 'create' });
$('btnJoin').onclick = () => connect({ t: 'join', mode: 'room', code: $('code').value });
$('btnTutorial').onclick = () => connect({ t: 'join', mode: 'tutorial' });
$('code').onkeydown = (e) => { if (e.key === 'Enter') $('btnJoin').click(); };

const send = (o) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); };
setSkin(skin);

function onMsg(m, sock) {
  if (m.t === 'err') { $('err').textContent = m.m; sock.close(); return; }
  if (m.t === 'joined') {
    ws = sock; myId = m.id; mode = m.mode; code = m.code;
    snaps = []; cur = null; feed = []; pendingEv = []; resetFx(); r3d?.resetFx(); r3d?.setActive(use3d()); $('feed').replaceChildren();
    $('menu').style.display = 'none'; $('hud').hidden = false; $('err').textContent = '';
    const link = `${location.origin}/?room=${code}`;
    if (mode === 'rounds') {
      history.replaceState(null, '', `?room=${code}`);
      $('roomInfo').textContent = `Room ${code}`;
      $('link').value = link; $('lobbyCode').textContent = code;
    } else {
      history.replaceState(null, '', location.pathname);
      $('roomInfo').textContent = mode === 'tutorial' ? 'Tutorial' : 'Endless Brawl';
    }
    if (mode === 'tutorial') tut.start(); else tut.stop();
    buildBar();
  } else if (m.t === 'roster') {
    host = m.host; botsWanted = m.bots; terrain = m.terrain ?? terrain;
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
    soundEvents(s, now);
    if (pendingEv.length > 400) pendingEv.splice(0, pendingEv.length - 400); // rAF is paused in hidden tabs
    const phaseChanged = !cur || cur.ph !== s.ph;
    cur = s; me = m.me;
    if (mode === 'tutorial') tut.snapshot(s, me, myId, roster);
    updateBar();
    updateBanner();
    if (phaseChanged) drawLobby();
  }
}

// ---------------- sound hooks ----------------
// The server has no "cast" events, so new projectiles / meteor zones are diffed
// against the previous snapshot and queued like events (same render delay).
function soundEvents(s, now) {
  const prev = cur;
  if (prev) {
    for (const j of s.J) if (!prev.Jm.has(j[0])) pendingEv.push({ time: now, ev: ['cast', j[1], j[2], j[3]] });
    const zs = new Set(prev.Z.map((z) => z[0]));
    for (const z of s.Z) if (!zs.has(z[0])) pendingEv.push({ time: now, ev: ['mcast', z[1], z[2], z[4] / TICK] });
    if (mode === 'rounds') {
      if (s.ph === 'inter' && s.pt !== prev.pt && s.pt <= 3) sfx.countdown(false);
      if (s.ph === 'play' && prev.ph === 'inter') sfx.countdown(true);
      if (s.ph === 'over' && prev.ph !== 'over') sfx.win();
    }
  }
  const my = s.Pm.get(myId);
  setSizzle(!!my && (my[5] & 5) === 5 && s.ph === 'play'); // alive and in lava
}
function updateMuteBtn() {
  $('btnMute').textContent = isMuted() ? '🔇' : '🔊';
  $('btnSound').textContent = isMuted() ? 'Sound: off (M)' : 'Sound: on (M)';
}
function flipMute() { toggleMute(); updateMuteBtn(); if (isMuted()) setSizzle(false); }
$('btnMute').onclick = $('btnSound').onclick = flipMute;
updateMuteBtn();

// ---------------- in-game menu ----------------
// The match keeps running server-side while this is open (it's multiplayer).
const showPause = (on) => { $('pause').hidden = !on; };
$('btnMenu').onclick = () => showPause(true);
$('btnResume').onclick = () => showPause(false);
$('pause').onpointerdown = (e) => { if (e.target === $('pause')) showPause(false); };
$('btnLeave').onclick = leaveGame;
function leaveGame() {
  const sock = ws;
  ws = null; // so onclose doesn't report "Disconnected"
  if (sock) sock.close();
  showPause(false); setSizzle(false); tut.stop();
  $('hud').hidden = true; $('lobby').hidden = true; $('menu').style.display = '';
  $('err').textContent = '';
  history.replaceState(null, '', location.pathname);
  snaps = []; cur = null; me = null;
  r3d?.setActive(false);
}

// ---------------- lobby ----------------
$('btnCopy').onclick = () => { navigator.clipboard?.writeText($('link').value).catch(() => $('link').select()); $('btnCopy').textContent = 'Copied'; setTimeout(() => ($('btnCopy').textContent = 'Copy'), 1200); };
$('btnStart').onclick = () => send({ t: 'start' });
$('botMinus').onclick = () => send({ t: 'bots', n: botsWanted - 1 });
$('botPlus').onclick = () => send({ t: 'bots', n: botsWanted + 1 });
for (const b of $('terrainRow').querySelectorAll('button')) b.onclick = () => send({ t: 'terrain', n: +b.dataset.n });

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
  for (const b of $('terrainRow').querySelectorAll('button')) {
    const on = +b.dataset.n === terrain;
    b.disabled = !isHost; b.classList.toggle('on', on); b.setAttribute('aria-checked', on);
  }
  $('btnStart').disabled = !isHost || roster.size < 2;
  $('lobbyNote').textContent = isHost
    ? (roster.size < 2 ? 'Need at least 2 fighters — add a bot or invite a friend.' : 'First to 5 round wins takes the match.')
    : 'Waiting for the host (★) to start…';
}

// ---------------- HUD ----------------
function drawBoard() {
  const brawl = mode !== 'rounds';
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
    // between rounds the bar is the upgrade shop: clicking a slot learns / levels it
    el.onclick = () => { if (shopping()) send({ t: 'up', s: k }); else if (!d.passive) castAtNearest(k); };
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
      if (s.last && lv > +s.last.split('|')[0]) sfx.upgrade();
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
  const shop = shopping();
  $('bottom').classList.toggle('shop', shop);
  const t = me.pts > 0 ? `${me.pts} upgrade point${me.pts > 1 ? 's' : ''}: ${shop ? 'click a spell' : 'click +'} or Shift+key` : '';
  if (mode === 'brawl') {
    $('xp').hidden = false;
    $('xpFill').style.width = `${Math.min(100, (100 * me.xp) / me.need)}%`;
    setText('xpTxt', `Level ${roster.get(myId)?.level ?? 1} · ${me.xp} / ${me.need} XP`);
  } else $('xp').hidden = true;
  updateHp();
  $('pts').textContent = t;
  $('pts').classList.toggle('glow', me.pts > 0);
}

// Between rounds, while there are points to spend, the spell bar grows and moves to the
// middle of the screen. Once they're spent it goes back down so you can warm up.
function shopping() { return mode === 'rounds' && cur?.ph === 'inter' && me?.pts > 0; }

const setText = (id, t) => { const el = $(id); if (el.textContent !== t) el.textContent = t; };
// my health bar: numbers + colour by fraction; the pale "lag" part shows recent damage
let hpLag = 1;
function updateHp() {
  const my = cur?.Pm.get(myId);
  if (!my) return;
  const hp = my[3], max = my[4], alive = my[5] & 1, f = alive ? Math.max(0, Math.min(1, hp / max)) : 0;
  hpLag = f > hpLag ? f : Math.max(f, hpLag - 0.04);
  $('hpFill').style.width = `${f * 100}%`;
  $('hpLag').style.width = `${hpLag * 100}%`;
  $('hp').dataset.lvl = !alive ? 'dead' : f > 0.5 ? 'ok' : f > 0.25 ? 'mid' : 'low';
  $('hp').classList.toggle('burn', !!(my[5] & 4) && !!alive);
  setText('hpTxt', alive ? `${hp} / ${max}` : `0 / ${max}`);
}

function updateBanner() {
  const b = $('banner');
  const my = cur.Pm.get(myId);
  const alive = my && (my[5] & 1);
  const wn = roster.get(cur.w)?.name || 'Nobody';
  let h = '', sub = '';
  if (mode === 'rounds') {
    if (cur.ph === 'inter') { h = `Round ${cur.rd} in ${cur.pt}`; sub = me?.pts > 0 ? 'Spend your upgrade points!' : 'Warm-up: spells shove but don\u2019t hurt yet'; }
    else if (cur.ph === 'end') h = `${wn} wins the round`;
    else if (cur.ph === 'over') { h = `🏆 ${wn} wins the match!`; sub = `Back to lobby in ${cur.pt}`; }
    else if (cur.ph === 'play' && !alive) sub = 'You are out — spectating until next round';
  } else if (!alive) { h = 'Burned!'; sub = mode === 'tutorial' ? 'Respawning…' : 'Respawning with a fresh build…'; }
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
function sendMove() {
  const w = toWorld(mouse.x, mouse.y);
  send({ t: 'move', x: Math.round(w.x), y: Math.round(w.y) });
  moveMark = { x: w.x, y: w.y, t: performance.now() };
  mouse.lastSend = performance.now();
}
function castAt(k) {
  if (me && (!me.lv[k] || me.cd[k] > 0)) { sfx.denied(); return; }
  if (k === 'ward') sfx.ward();
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
  if (e.pointerType === 'touch' && touchGesture()) { mouse.down = false; return; } // two-finger pan/pinch
  // Ctrl+click is the macOS one-button right-click, so treat it as move too
  if (e.pointerType === 'touch' || e.button === 2 || (e.button === 0 && e.ctrlKey)) { mouse.down = true; sendMove(); }
  else if (e.button === 0) castAt('bolt');
});
cv.addEventListener('pointermove', (e) => { mouse.x = e.clientX; mouse.y = e.clientY; });
addEventListener('pointerup', () => { mouse.down = false; });
addEventListener('keydown', (e) => {
  if (!ws || e.target.tagName === 'INPUT' || e.repeat) return;
  if (e.key === 'Escape') { showPause($('pause').hidden); e.preventDefault(); return; }
  if (!$('pause').hidden) return; // no casting from behind the menu
  const k = e.key.toLowerCase();
  if (mode === 'tutorial') tut.key(e.key);
  // digits change with Shift held, so match passives by physical key
  const spell = KEYMAP[k] || (e.code === 'Digit1' ? 'vigor' : e.code === 'Digit2' ? 'swift' : null);
  if (spell) {
    if (e.shiftKey || SPELLS[spell].passive) send({ t: 'up', s: spell });
    else castAt(spell);
    e.preventDefault();
  } else if (k === 's') send({ t: 'stop' });
  else if (k === 'm') flipMute();
});

// ---------------- effects ----------------
function handleEvent(ev) {
  const [type, a, b, c, d] = ev;
  // sounds (cast/mcast are client-side events synthesized for audio only)
  if (type === 'cast') { if (a) sfx.seeker(b, c); else sfx.bolt(b, c); return; }
  if (type === 'mcast') { sfx.meteorCast(a, b, c); return; }
  if (type === 'clash') { // two projectiles cancelled: an impact burst for each kind, no damage
    sfx.hit(a, b, c && d);
    const env = { P: cur?.P, myId, cam };
    const fx = (e) => (use3d() ? r3d.fxEvent(e, env) : fxEvent(e, env));
    fx(['hit', a, b, c]);
    if (d !== c) fx(['hit', a, b, d]);
    return;
  }
  if (type === 'hit') sfx.hit(a, b, c);
  else if (type === 'refl') sfx.reflect(a, b);
  else if (type === 'shock') sfx.shock(a, b);
  else if (type === 'boom') sfx.boom(a, b);
  else if (type === 'blink') sfx.blink(c, d);
  else if (type === 'lvl' && a === myId) sfx.level();
  else if (type === 'die') { sfx.die(c, d, a === myId); if (b === myId && a !== myId) sfx.kill(); }
  // visuals
  if (use3d()) r3d.fxEvent(ev, { P: cur?.P, myId, cam }); else fxEvent(ev, { P: cur?.P, myId, cam });
  if (type === 'die') addFeed(b ? roster.get(b) || { name: '?' } : null, roster.get(a) || { name: '?' });
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

  // events queued while the tab was hidden are stale: drop them instead of replaying a burst
  while (pendingEv.length && pendingEv[0].time <= now - INTERP) {
    const e = pendingEv.shift();
    if (now - e.time < 1000) handleEvent(e.ev);
  }
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

  // camera (free / locked / spectator overview): see camera.js
  updateCamera(dt, { me: mine, radius, round: b.rd, id: myId });

  setListener(cam.x, cam.y, cam.s, W);
  if (use3d()) {
    // 3D scene on the WebGL canvas; #c becomes a transparent overlay
    ctx.clearRect(0, 0, W, H);
    r3d.render({ a, b, f, players, radius, now, dt, roster, myId, moveMark }, ctx);
    drawCameraHud(ctx, roster.get(myId)?.color);
    return;
  }
  const [shx, shy] = shakeOffset(dt);
  ctx.save();
  ctx.translate(shx, shy); // subtle screen shake, applied before the camera transform
  ctx.translate(W / 2, H / 2); ctx.scale(cam.s, cam.s); ctx.translate(-cam.x, -cam.y);
  const vw = W / cam.s, vh = H / cam.s;

  const view = { x: cam.x - vw / 2, y: cam.y - vh / 2, w: vw, h: vh };
  drawLava(ctx, now, view);
  drawArena(ctx, radius, now);
  drawZones(ctx, a, b, f, now);
  drawTerrain(ctx, b.O || [], now);

  if (moveMark && now - moveMark.t < 400) {
    const q = (now - moveMark.t) / 400;
    ctx.strokeStyle = `rgba(140,255,140,${1 - q})`; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(moveMark.x, moveMark.y, 14 * (1 - q) + 3, 0, 7); ctx.stroke();
  }

  drawPlayers(ctx, players, roster, myId, now, dt);
  drawProjectiles(ctx, a, b, f, myId, now);
  drawTerrainTops(ctx, b.O || [], players, now);
  drawEffects(ctx, dt, now, view, radius);
  ctx.restore();
  drawVignette(ctx, W, H, now);

  // off-screen arrows toward my wizard / the arena, camera lock indicator
  drawCameraHud(ctx, roster.get(myId)?.color);
}

function drawBackdrop(now) {
  paintBackdrop(ctx, now, W, H);
  if ($('menu').style.display !== 'none') drawSkinCards(now);
}
requestAnimationFrame(frame);
