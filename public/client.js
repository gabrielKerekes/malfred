import { SPELLS, SPELL_KEYS, TICK, PLAYER_R } from '/shared/game.js';

const $ = (id) => document.getElementById(id);
const cv = $('c'), ctx = cv.getContext('2d');
const ICON = { bolt: '🔥', seeker: '✨', shock: '💥', meteor: '☄️', blink: '🌀', ward: '🛡️', vigor: '❤️', swift: '👟' };
const KEYMAP = {};
for (const k of SPELL_KEYS) KEYMAP[SPELLS[k].key.toLowerCase()] = k;
const INTERP = 110; // ms of render delay used to smooth snapshots

let ws = null, myId = 0, mode = '', code = '', host = 0, botsWanted = 0;
let roster = new Map();
let snaps = [];            // {time, s, P: Map}
let me = null;             // private state: pts, lv, cd
let cur = null;            // latest snapshot
let pendingEv = [];        // {time, ev}
let parts = [];            // particles
let rings = [];            // expanding ring effects
let feed = [];
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
    snaps = []; cur = null; feed = []; parts = []; rings = []; pendingEv = [];
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
    if (pendingEv.length > 400) pendingEv.splice(0, pendingEv.length - 400); // rAF is paused in hidden tabs
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
  for (const h of ['', brawl ? 'Lvl' : 'Wins', 'Kills']) { const th = document.createElement('th'); th.textContent = h; hd.appendChild(th); }
  for (const p of list) {
    const r = t.insertRow();
    if (p.id === myId) r.className = 'me';
    const c = r.insertCell(); const dot = document.createElement('i'); dot.style.background = p.color;
    c.append(dot, p.name);
    r.insertCell().textContent = brawl ? p.level : p.score;
    r.insertCell().textContent = p.kills;
  }
  $('board').replaceChildren(t);
}

const slots = {};
function buildBar() {
  $('bar').replaceChildren();
  for (const k of SPELL_KEYS) {
    const d = SPELLS[k];
    const el = document.createElement('div');
    el.className = 'slot' + (d.passive ? ' passive' : '');
    el.title = `${d.name} [${d.key}] — ${d.desc}`;
    el.innerHTML = `<span class="k">${d.key}</span><div class="ico">${ICON[k]}</div><div class="lv"></div><div class="cdm"></div><button class="up" hidden>+</button>`;
    const up = el.querySelector('.up');
    up.onclick = (e) => { e.stopPropagation(); send({ t: 'up', s: k }); };
    if (!d.passive) el.onclick = () => castAtNearest(k);
    slots[k] = { el, lv: el.querySelector('.lv'), cd: el.querySelector('.cdm'), up, last: '' };
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
      s.lv.textContent = '●'.repeat(lv) + '○'.repeat(d.max - lv);
      s.up.hidden = !canUp;
    }
    if (!d.passive) s.cd.style.height = lv ? `${Math.min(100, 100 * me.cd[k] / (d.cd(lv) * TICK))}%` : '0';
  }
  let t = me.pts > 0 ? `${me.pts} upgrade point${me.pts > 1 ? 's' : ''} — click + or Shift+key` : '';
  if (mode === 'brawl') t = `Level ${roster.get(myId)?.level ?? 1} · ${me.xp}/${me.need} xp` + (t ? ' · ' + t : '');
  $('pts').textContent = t;
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
    b.dataset.sig = sig; b.textContent = h;
    if (sub) { const s = document.createElement('small'); s.textContent = sub; b.appendChild(s); }
  }
}

function addFeed(text) {
  feed.push({ text, time: performance.now() });
  if (feed.length > 5) feed.shift();
  drawFeed();
}
function drawFeed() {
  $('feed').replaceChildren(...feed.map((f) => { const d = document.createElement('div'); d.textContent = f.text; return d; }));
}
setInterval(() => { const n = performance.now(); const l = feed.length; feed = feed.filter((f) => n - f.time < 7000); if (feed.length !== l) drawFeed(); }, 1000);

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
  // Ctrl+click is the macOS one-button right-click, so treat it as move too
  if (e.pointerType === 'touch' || e.button === 2 || (e.button === 0 && e.ctrlKey)) { mouse.down = true; sendMove(); }
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
function burst(x, y, n, color, speed, life = 0.5, size = 3) {
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2, v = speed * (0.3 + Math.random() * 0.7);
    parts.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life, max: life, color, size: size * (0.5 + Math.random()) });
  }
}
function handleEvent(ev) {
  const [type, a, b, c, d] = ev;
  if (type === 'hit') burst(a, b, 12, c ? '#b9f' : '#fb5', 220);
  else if (type === 'refl') burst(a, b, 8, '#aef', 180);
  else if (type === 'shock') { rings.push({ x: a, y: b, r: c, t: 0, max: 0.35, color: '#9df' }); }
  else if (type === 'boom') { rings.push({ x: a, y: b, r: c, t: 0, max: 0.45, color: '#f93' }); burst(a, b, 36, '#f73', 380, 0.7, 5); }
  else if (type === 'blink') { burst(a, b, 12, '#c9f', 120); burst(c, d, 12, '#c9f', 120); }
  else if (type === 'lvl') { const p = cur?.Pm.get(a); if (p) rings.push({ x: p[1], y: p[2], r: 50, t: 0, max: 0.5, color: '#fd4' }); }
  else if (type === 'die') {
    burst(c, d, 40, '#f52', 300, 0.9, 5);
    const v = roster.get(a)?.name || '?', k = roster.get(b)?.name;
    addFeed(k ? `${k} knocked out ${v}` : `${v} fell into the lava`);
  }
}

// ---------------- rendering ----------------
function resize() {
  const dpr = Math.min(2, devicePixelRatio || 1);
  W = innerWidth; H = innerHeight;
  cv.width = W * dpr; cv.height = H * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
addEventListener('resize', resize); resize();

// tiling lava texture
const lava = document.createElement('canvas'); lava.width = lava.height = 256;
{
  const g = lava.getContext('2d');
  g.fillStyle = '#8f1d05'; g.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 70; i++) {
    const x = Math.random() * 256, y = Math.random() * 256, r = 10 + Math.random() * 34;
    const hot = Math.random() < 0.5;
    for (const ox of [-256, 0, 256]) for (const oy of [-256, 0, 256]) {
      const gr = g.createRadialGradient(x + ox, y + oy, 0, x + ox, y + oy, r);
      gr.addColorStop(0, hot ? '#ff9a1fcc' : '#3d0b02cc'); gr.addColorStop(1, hot ? '#ff9a1f00' : '#3d0b0200');
      g.fillStyle = gr; g.beginPath(); g.arc(x + ox, y + oy, r, 0, 7); g.fill();
    }
  }
}
const lavaPat = ctx.createPattern(lava, 'repeat');

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

  // camera: follow me; when dead, pull back to show the whole arena
  const follow = mine && mine.alive;
  const ts = follow ? Math.min(W, H) / 900 : Math.min(W, H) / (2 * radius + 260);
  const k = 1 - Math.exp(-6 * dt);
  cam.s = lerp(cam.s, Math.max(0.35, ts), k);
  cam.x = lerp(cam.x, follow ? mine.x : 0, k); cam.y = lerp(cam.y, follow ? mine.y : 0, k);

  ctx.save();
  ctx.translate(W / 2, H / 2); ctx.scale(cam.s, cam.s); ctx.translate(-cam.x, -cam.y);
  const vw = W / cam.s, vh = H / cam.s;

  // lava
  ctx.save();
  const off = (now / 60) % 256;
  ctx.translate(off, off * 0.6);
  ctx.fillStyle = lavaPat;
  ctx.fillRect(cam.x - vw / 2 - off - 1, cam.y - vh / 2 - off * 0.6 - 1, vw + 2, vh + 2);
  ctx.restore();

  // platform
  ctx.save();
  ctx.shadowColor = '#ffb347'; ctx.shadowBlur = 40;
  ctx.beginPath(); ctx.arc(0, 0, radius, 0, Math.PI * 2);
  const pg = ctx.createRadialGradient(0, 0, radius * 0.2, 0, 0, radius);
  pg.addColorStop(0, '#6d655f'); pg.addColorStop(0.85, '#514942'); pg.addColorStop(1, '#2e2622');
  ctx.fillStyle = pg; ctx.fill();
  ctx.shadowBlur = 0; ctx.clip();
  ctx.strokeStyle = '#0000002e'; ctx.lineWidth = 2;
  ctx.beginPath();
  for (let g = -Math.ceil(radius / 80) * 80; g <= radius; g += 80) {
    ctx.moveTo(g, -radius); ctx.lineTo(g, radius); ctx.moveTo(-radius, g); ctx.lineTo(radius, g);
  }
  ctx.stroke();
  ctx.restore();
  ctx.strokeStyle = '#ff8a2a'; ctx.lineWidth = 3;
  ctx.beginPath(); ctx.arc(0, 0, radius, 0, Math.PI * 2); ctx.stroke();

  // meteor warnings
  for (const z of b.Z) {
    const p = 1 - z[4] / (SPELLS.meteor.delay * TICK);
    ctx.fillStyle = '#ff450033'; ctx.strokeStyle = '#ff6a00';
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(z[1], z[2], z[3], 0, 7); ctx.fill(); ctx.stroke();
    ctx.beginPath(); ctx.arc(z[1], z[2], z[3] * Math.min(1, p), 0, 7); ctx.fillStyle = '#ff6a0055'; ctx.fill();
  }

  if (moveMark && now - moveMark.t < 400) {
    const q = (now - moveMark.t) / 400;
    ctx.strokeStyle = `rgba(140,255,140,${1 - q})`; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(moveMark.x, moveMark.y, 14 * (1 - q) + 3, 0, 7); ctx.stroke();
  }

  // players
  ctx.textAlign = 'center';
  for (const p of players) {
    if (!p.alive) continue;
    const info = roster.get(p.id) || { color: '#ccc', name: '' };
    ctx.fillStyle = '#0006';
    ctx.beginPath(); ctx.ellipse(p.x + 3, p.y + 6, PLAYER_R, PLAYER_R * 0.8, 0, 0, 7); ctx.fill();
    // staff
    ctx.strokeStyle = '#e8d9b0'; ctx.lineWidth = 4; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(p.x + Math.cos(p.face) * 8, p.y + Math.sin(p.face) * 8);
    ctx.lineTo(p.x + Math.cos(p.face) * 30, p.y + Math.sin(p.face) * 30); ctx.stroke();
    // robe + hood
    ctx.fillStyle = info.color;
    ctx.beginPath(); ctx.arc(p.x, p.y, PLAYER_R, 0, 7); ctx.fill();
    ctx.lineWidth = p.id === myId ? 3 : 2; ctx.strokeStyle = p.id === myId ? '#fff' : '#0009'; ctx.stroke();
    ctx.fillStyle = '#0005';
    ctx.beginPath(); ctx.arc(p.x - Math.cos(p.face) * 3, p.y - Math.sin(p.face) * 3, PLAYER_R * 0.55, 0, 7); ctx.fill();
    if (p.lava && Math.random() < 0.5) burst(p.x, p.y, 1, '#fa3', 90, 0.4);
    if (p.ward) {
      ctx.strokeStyle = '#9fe8ff'; ctx.lineWidth = 3; ctx.shadowColor = '#9fe8ff'; ctx.shadowBlur = 12;
      ctx.beginPath(); ctx.arc(p.x, p.y, PLAYER_R + 8 + Math.sin(now / 60) * 1.5, 0, 7); ctx.stroke();
      ctx.shadowBlur = 0;
    }
    // hp bar + name
    const bw = 44, hx = p.x - bw / 2, hy = p.y - PLAYER_R - 16, hf = Math.max(0, p.hp / p.maxHp);
    ctx.fillStyle = '#000a'; ctx.fillRect(hx - 1, hy - 1, bw + 2, 7);
    ctx.fillStyle = hf > 0.5 ? '#5d5' : hf > 0.25 ? '#ec3' : '#e43'; ctx.fillRect(hx, hy, bw * hf, 5);
    ctx.font = '600 13px system-ui, sans-serif';
    ctx.lineWidth = 3; ctx.strokeStyle = '#000b'; ctx.strokeText(info.name, p.x, hy - 6);
    ctx.fillStyle = '#fff'; ctx.fillText(info.name, p.x, hy - 6);
  }

  // projectiles
  for (const jb of b.J) {
    const ja = a.Jm.get(jb[0]) || jb;
    const x = lerp(ja[2], jb[2], f), y = lerp(ja[3], jb[3], f);
    const seeker = jb[1] === 1, r = seeker ? 13 : 10;
    const gr = ctx.createRadialGradient(x, y, 0, x, y, r * 2.2);
    gr.addColorStop(0, '#fff'); gr.addColorStop(0.35, seeker ? '#b48cff' : '#ffb13d'); gr.addColorStop(1, seeker ? '#b48cff00' : '#ff5a0000');
    ctx.fillStyle = gr; ctx.beginPath(); ctx.arc(x, y, r * 2.2, 0, 7); ctx.fill();
    if (jb[4] === myId) { ctx.strokeStyle = '#fff8'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.stroke(); }
    if (Math.random() < 0.6) parts.push({ x, y, vx: 0, vy: 0, life: 0.25, max: 0.25, color: seeker ? '#b48cff' : '#ff8a2a', size: 4 });
  }

  // rings + particles
  rings = rings.filter((r) => (r.t += dt) < r.max);
  for (const r of rings) {
    const q = r.t / r.max;
    ctx.globalAlpha = 1 - q; ctx.strokeStyle = r.color; ctx.lineWidth = 6;
    ctx.beginPath(); ctx.arc(r.x, r.y, r.r * (0.3 + 0.7 * q), 0, 7); ctx.stroke();
  }
  parts = parts.filter((p) => (p.life -= dt) > 0);
  if (parts.length > 900) parts.splice(0, parts.length - 900);
  for (const p of parts) {
    p.x += p.vx * dt; p.y += p.vy * dt; p.vx *= 0.94; p.vy *= 0.94;
    ctx.globalAlpha = p.life / p.max; ctx.fillStyle = p.color;
    ctx.beginPath(); ctx.arc(p.x, p.y, p.size * (p.life / p.max), 0, 7); ctx.fill();
  }
  ctx.globalAlpha = 1;
  ctx.restore();

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

function drawBackdrop(now) {
  ctx.save();
  const off = (now / 60) % 256;
  ctx.translate(off, off * 0.6);
  ctx.fillStyle = lavaPat; ctx.fillRect(-off - 1, -off * 0.6 - 1, W + 2, H + 2);
  ctx.restore();
}
requestAnimationFrame(frame);
