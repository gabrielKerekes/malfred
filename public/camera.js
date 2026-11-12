// Warcraft III-style free camera: edge panning, arrow keys, middle-drag, wheel zoom
// toward the cursor, Space to centre on your wizard, Y / double-Space to lock-follow.
// Interface used by client.js: `cam` {x, y, s}, `toWorld`, `updateCamera(dt, view)`,
// `drawCameraHud(ctx, color)` and `touchGesture()`.
import { PLAYER_R } from '/shared/game.js';

export const cam = { x: 0, y: 0, s: 1 };

const EDGE = 70;          // px from a window edge where edge panning starts (speed ramps up toward the edge)
const EDGE_UI = 8;        // over HUD elements (spell bar, buttons) only the outermost px pan
const PAN = 1100;         // pan speed in screen px/s (same feel at every zoom)
const CLAMP_PAD = 300;    // camera centre must stay within arena radius + this
const DOUBLE_TAP = 300;   // ms between Space presses that toggles the lock

const cv = document.getElementById('c');
const ptr = { x: 0, y: 0, inside: false, overUi: false };
const keys = new Set();   // held arrow keys
let spaceHeld = false, lastSpace = -1e9;
let locked = false;       // camera lock: follow my wizard
let autoView = true;      // spectator pull-back (dead / lobby) until the player takes over
let snapReq = false;
let tgtS = 0;             // target zoom scale (0 = not initialised)
let anchor = null;        // screen point the smooth zoom keeps fixed
let drag = null;          // middle-mouse drag: last screen point
const touches = new Map();
let pinch = null;         // {mx, my, d}
let lastUpdate = -1e9, lastId = -1, lastRound = -1, wasAlive = false;
let radius = 500, me = null;
let arrowHit = null, pillHit = null;

export const toWorld = (mx, my) => ({ x: (mx - innerWidth / 2) / cam.s + cam.x, y: (my - innerHeight / 2) / cam.s + cam.y });
export const touchGesture = () => touches.size > 1;

const active = () => performance.now() - lastUpdate < 300;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const baseS = () => Math.min(innerWidth, innerHeight) / 900;
function zoomLimits() {
  const lo = Math.min(baseS(), Math.min(innerWidth, innerHeight) / (2 * (radius + CLAMP_PAD)));
  return [lo, baseS() * 2.2];
}
const following = () => !!(me && me.alive && (locked || spaceHeld));

function panScreen(dx, dy) {
  cam.x += dx / cam.s; cam.y += dy / cam.s;
  autoView = false;
}
// zoom so the world point under (sx, sy) stays put
function zoomAt(s, sx, sy) {
  const w = toWorld(sx, sy);
  cam.s = s;
  cam.x = w.x - (sx - innerWidth / 2) / s; cam.y = w.y - (sy - innerHeight / 2) / s;
}
function clampCam() {
  const d = Math.hypot(cam.x, cam.y), lim = radius + CLAMP_PAD;
  if (d > lim) { cam.x *= lim / d; cam.y *= lim / d; }
}
const hitCircle = (h, x, y) => h && Math.hypot(x - h.x, y - h.y) <= h.r;
const hitRect = (h, x, y) => h && x >= h.x && x <= h.x + h.w && y >= h.y && y <= h.y + h.h;

// ---------------- input ----------------
// Registered at import time, i.e. before client.js's own canvas listeners, so a
// click on the off-screen arrow / lock pill can be swallowed before it casts or moves.
cv.style.touchAction = 'none';
cv.addEventListener('mousedown', (e) => { if (e.button === 1) e.preventDefault(); });
cv.addEventListener('auxclick', (e) => { if (e.button === 1) e.preventDefault(); });
cv.addEventListener('pointerdown', (e) => {
  if (!active()) return;
  const x = e.clientX, y = e.clientY;
  if (e.pointerType === 'touch') {
    touches.set(e.pointerId, { x, y });
    if (touches.size === 2) { pinch = pinchState(); return; }
    if (touches.size > 2) return;
  }
  if (e.button === 1) { e.preventDefault(); drag = { x, y }; return; }
  if (e.button === 0 || e.pointerType === 'touch') {
    if (hitCircle(arrowHit, x, y)) snapReq = true;
    else if (hitRect(pillHit, x, y)) { locked = !locked; if (locked) snapReq = true; }
    else return;
    e.stopImmediatePropagation(); e.preventDefault();
  }
});
addEventListener('pointermove', (e) => {
  const x = e.clientX, y = e.clientY;
  if (e.pointerType === 'touch') {
    ptr.inside = false;
    if (!touches.has(e.pointerId)) return;
    touches.set(e.pointerId, { x, y });
    if (touches.size === 2 && pinch && active()) {
      const p = pinchState();
      panScreen(pinch.mx - p.mx, pinch.my - p.my);
      const [lo, hi] = zoomLimits();
      tgtS = clamp(cam.s * p.d / Math.max(1, pinch.d), lo, hi);
      zoomAt(tgtS, p.mx, p.my);
      anchor = null; locked = false; pinch = p;
    }
    return;
  }
  ptr.x = x; ptr.y = y; ptr.inside = true; ptr.overUi = e.target !== cv;
  // middle button may be pressed while another button is already held (chorded press)
  if (e.buttons & 4) {
    if (drag && active()) { panScreen(drag.x - x, drag.y - y); locked = false; anchor = null; }
    drag = { x, y };
  } else drag = null;
});
function endTouch(e) {
  touches.delete(e.pointerId);
  if (touches.size < 2) pinch = null;
  if (e.button === 1) drag = null;
}
addEventListener('pointerup', endTouch);
addEventListener('pointercancel', endTouch);
document.documentElement.addEventListener('pointerleave', () => { ptr.inside = false; });
addEventListener('mouseout', (e) => { if (!e.relatedTarget) ptr.inside = false; });
addEventListener('blur', () => { ptr.inside = false; keys.clear(); spaceHeld = false; drag = null; });

function pinchState() {
  const [a, b] = [...touches.values()];
  return { mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2, d: Math.hypot(a.x - b.x, a.y - b.y) };
}

cv.addEventListener('wheel', (e) => {
  if (!active()) return;
  e.preventDefault();
  const dy = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? innerHeight : 1);
  const [lo, hi] = zoomLimits();
  tgtS = clamp((tgtS || cam.s) * Math.exp(-dy * (e.ctrlKey ? 0.01 : 0.0015)), lo, hi);
  anchor = following() ? null : { x: e.clientX, y: e.clientY };
  autoView = false;
}, { passive: false });

// the Esc menu (client.js #pause) freezes camera input
const paused = () => document.getElementById('pause')?.hidden === false;

const ARROWS = { ArrowLeft: 1, ArrowRight: 1, ArrowUp: 1, ArrowDown: 1 };
addEventListener('keydown', (e) => {
  if (!active() || paused() || e.target.tagName === 'INPUT' || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.code === 'Space') {
    e.preventDefault();
    if (e.repeat) return;
    const now = performance.now();
    if (now - lastSpace < DOUBLE_TAP) { locked = !locked; lastSpace = -1e9; } else lastSpace = now;
    spaceHeld = true; snapReq = true;
  } else if (ARROWS[e.key]) {
    e.preventDefault();
    keys.add(e.key); locked = false;
  } else if (e.key.toLowerCase() === 'y' && !e.repeat) {
    locked = !locked;
    if (locked) snapReq = true;
  }
});
addEventListener('keyup', (e) => {
  if (e.code === 'Space') { spaceHeld = false; if (active()) e.preventDefault(); }
  keys.delete(e.key);
});

// ---------------- per-frame update ----------------
// view: { me: {x, y, alive} | undefined, radius, round, id }
export function updateCamera(dt, view) {
  lastUpdate = performance.now();
  radius = view.radius; me = view.me;
  const W = innerWidth, H = innerHeight;
  if (view.id !== lastId) {
    // fresh connection: start centred, reset input state
    lastId = view.id; wasAlive = false; lastRound = view.round;
    locked = false; autoView = true; anchor = null;
    tgtS = cam.s = baseS(); cam.x = cam.y = 0;
    document.activeElement?.blur?.();
  }
  const alive = !!(me && me.alive);
  if (alive && (!wasAlive || view.round !== lastRound)) snapReq = true; // join, respawn, new round
  if (!alive && wasAlive) autoView = true;                               // died: pull back
  wasAlive = alive; lastRound = view.round;

  const [lo, hi] = zoomLimits();
  tgtS = clamp(tgtS || baseS(), lo, hi);

  if (snapReq) {
    snapReq = false;
    if (alive) { cam.x = me.x; cam.y = me.y; autoView = false; anchor = null; } else autoView = true;
  }
  const follow = following();

  // edge + arrow-key panning, in screen px/s
  let dx = 0, dy = 0;
  if (paused()) keys.clear();
  if (!follow && !paused() && ptr.inside && document.hasFocus() && !drag && touches.size < 2) {
    // 0 at the inner border of the zone -> 1 at the window edge; starts at 35% speed
    const zone = ptr.overUi ? EDGE_UI : EDGE;
    const pull = (d) => (d < zone ? 0.35 + 0.65 * (1 - Math.max(0, d) / zone) : 0);
    dx = pull(W - 1 - ptr.x) - pull(ptr.x);
    dy = pull(H - 1 - ptr.y) - pull(ptr.y);
  }
  if (keys.has('ArrowLeft')) dx = -1;
  if (keys.has('ArrowRight')) dx = 1;
  if (keys.has('ArrowUp')) dy = -1;
  if (keys.has('ArrowDown')) dy = 1;
  if (dx || dy) {
    const l = Math.max(1, Math.hypot(dx, dy)); // keep partial speeds, cap diagonals at full speed
    panScreen(dx / l * PAN * dt, dy / l * PAN * dt);
    anchor = null;
  }

  // smooth zoom (toward the wheel cursor), or the spectator overview when dead
  const goal = autoView ? clamp(Math.min(W, H) / (2 * radius + 260), lo, hi) : tgtS;
  const ns = cam.s + (goal - cam.s) * (1 - Math.exp(-12 * dt));
  if (anchor && !follow && !autoView) zoomAt(ns, anchor.x, anchor.y); else cam.s = ns;
  if (Math.abs(goal - cam.s) < 1e-4) anchor = null;

  if (follow) {
    const k = 1 - Math.exp(-14 * dt);
    cam.x += (me.x - cam.x) * k; cam.y += (me.y - cam.y) * k;
  } else if (autoView) {
    const k = 1 - Math.exp(-4 * dt);
    cam.x -= cam.x * k; cam.y -= cam.y * k;
  }
  clampCam();
}

// ---------------- screen-space overlay ----------------
// off-screen arrows (my wizard, and the arena when it's fully out of view) + lock pill
export function drawCameraHud(g, color = '#fff') {
  const W = innerWidth, H = innerHeight;
  arrowHit = null;
  if (me && me.alive) {
    const sx = (me.x - cam.x) * cam.s + W / 2, sy = (me.y - cam.y) * cam.s + H / 2, m = PLAYER_R * cam.s;
    if (sx < -m || sx > W + m || sy < -m || sy > H + m) {
      const p = edgePoint(sx, sy, 46);
      drawArrow(g, p, color, '#fff', 15);
      arrowHit = { x: p.x, y: p.y, r: 30 };
    }
  }
  const ox = Math.max(0, Math.abs(cam.x) - W / 2 / cam.s), oy = Math.max(0, Math.abs(cam.y) - H / 2 / cam.s);
  if (Math.hypot(ox, oy) > radius) {
    const p = edgePoint(W / 2 - cam.x * cam.s, H / 2 - cam.y * cam.s, arrowHit ? 96 : 46);
    drawArrow(g, p, null, '#ff8a2a', 0);
  }

  // camera mode pill (click / tap toggles the lock)
  const narrow = W < 700;
  const text = locked ? (narrow ? '🔒 Cam lock' : '🔒 Camera locked · Y to free')
    : (narrow ? '🎥 Free cam' : '🎥 Free camera · Space centre · Y lock');
  g.save();
  g.font = '600 12px system-ui, sans-serif';
  const w = g.measureText(text).width + 18, h = 22, x = 12, y = narrow ? H - 104 : H - 34 - h; // room for the credit link below
  g.fillStyle = locked ? '#7a3d0ccc' : '#000000a0';
  g.strokeStyle = locked ? '#ffb066' : '#ffffff40'; g.lineWidth = 1;
  g.beginPath(); g.roundRect ? g.roundRect(x, y, w, h, 11) : g.rect(x, y, w, h); g.fill(); g.stroke();
  g.fillStyle = '#f3e6d8'; g.textAlign = 'left'; g.textBaseline = 'middle';
  g.fillText(text, x + 9, y + h / 2 + 1);
  g.restore();
  pillHit = { x, y, w, h };
}

// point where the ray from the screen centre toward (sx, sy) meets the inset screen edge
function edgePoint(sx, sy, inset) {
  const W = innerWidth, H = innerHeight, dx = sx - W / 2, dy = sy - H / 2;
  const t = Math.min((W / 2 - inset) / Math.max(1e-6, Math.abs(dx)), (H / 2 - inset) / Math.max(1e-6, Math.abs(dy)));
  return { x: W / 2 + dx * t, y: H / 2 + dy * t, a: Math.atan2(dy, dx) };
}
function drawArrow(g, p, fill, tip, disc) {
  g.save();
  g.translate(p.x, p.y);
  if (disc) {
    g.fillStyle = '#000a'; g.beginPath(); g.arc(0, 0, disc + 3, 0, 7); g.fill();
    g.fillStyle = fill; g.beginPath(); g.arc(0, 0, disc, 0, 7); g.fill();
    g.strokeStyle = '#fff'; g.lineWidth = 2; g.stroke();
  }
  g.rotate(p.a); g.translate(disc ? disc + 6 : 0, 0);
  g.fillStyle = tip; g.strokeStyle = '#000a'; g.lineWidth = 2;
  g.beginPath(); g.moveTo(16, 0); g.lineTo(-10, -11); g.lineTo(-10, 11); g.closePath(); g.stroke(); g.fill();
  g.restore();
}
