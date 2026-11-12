// World rendering: lava, arena, wizards, spells, particles and screen effects.
// Anything expensive (textures, glows, wizard parts, name labels) is pre-rendered
// once to offscreen canvases and blitted with drawImage every frame, so the hot
// path allocates almost no gradients.
import { SPELLS, TICK, PLAYER_R } from '/shared/game.js';

const TAU = Math.PI * 2;
const REDUCED_MOTION = matchMedia('(prefers-reduced-motion: reduce)').matches;
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const lerp = (x, y, f) => x + (y - x) * f;
const rand = (a, b) => a + Math.random() * (b - a);
const wrapMod = (v, m) => ((v % m) + m) % m;
const angDiff = (a, b) => Math.atan2(Math.sin(b - a), Math.cos(b - a));
const lerpAng = (a, b, f) => a + angDiff(a, b) * f;

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.ceil(w); c.height = Math.ceil(h);
  return c;
}
// small seeded RNG so textures are stable between reloads
function seeded(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function rgb(hex) {
  let h = hex.replace('#', '');
  if (h.length === 3) h = h.replace(/./g, (c) => c + c);
  const n = parseInt(h.slice(0, 6), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
const rgba = (c, a) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})`;
const mix = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
const smooth = (e0, e1, x) => { const t = clamp01((x - e0) / (e1 - e0)); return t * t * (3 - 2 * t); };

// ---------------- generic sprites ----------------
const glowCache = new Map();
/** Soft radial glow sprite in the given colour (cached). */
function glow(color) {
  let c = glowCache.get(color);
  if (!c) {
    c = makeCanvas(64, 64);
    const g = c.getContext('2d'), col = rgb(color);
    const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    gr.addColorStop(0, rgba(col, 1)); gr.addColorStop(0.22, rgba(col, 0.7));
    gr.addColorStop(0.55, rgba(col, 0.18)); gr.addColorStop(1, rgba(col, 0));
    g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
    glowCache.set(color, c);
  }
  return c;
}
const blit = (ctx, img, x, y, r) => ctx.drawImage(img, x - r, y - r, r * 2, r * 2);

function radialSprite(size, stops) {
  const c = makeCanvas(size, size), g = c.getContext('2d'), h = size / 2;
  const gr = g.createRadialGradient(h, h, 0, h, h, h);
  for (const [o, col] of stops) gr.addColorStop(o, col);
  g.fillStyle = gr; g.fillRect(0, 0, size, size);
  return c;
}
const smokeSpr = radialSprite(64, [[0, 'rgba(48,36,30,0.75)'], [0.6, 'rgba(40,30,26,0.3)'], [1, 'rgba(40,30,26,0)']]);
const shadowSpr = radialSprite(64, [[0, 'rgba(0,0,0,0.6)'], [0.55, 'rgba(0,0,0,0.38)'], [1, 'rgba(0,0,0,0)']]);
const wardSpr = (() => {
  const c = radialSprite(128, [[0, 'rgba(120,220,255,0)'], [0.6, 'rgba(120,220,255,0.08)'], [0.86, 'rgba(150,230,255,0.35)'],
    [0.94, 'rgba(210,248,255,0.85)'], [1, 'rgba(160,235,255,0)']]);
  const g = c.getContext('2d');
  g.fillStyle = 'rgba(255,255,255,0.35)';
  g.beginPath(); g.ellipse(42, 36, 14, 6, -0.7, 0, TAU); g.fill();
  return c;
})();
// flame colours, hottest first
const FLAME = ['#fff1b0', '#ffb030', '#ff6a14', '#b8260a'];

// craggy meteor rock, lit hot on its leading (lower-right) side
const rockSpr = (() => {
  const c = makeCanvas(72, 72), g = c.getContext('2d'), R = seeded(17);
  g.translate(36, 36);
  g.beginPath();
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * TAU, r = 25 + R() * 8;
    if (i) g.lineTo(Math.cos(a) * r, Math.sin(a) * r); else g.moveTo(Math.cos(a) * r, Math.sin(a) * r);
  }
  g.closePath();
  const gr = g.createRadialGradient(9, 12, 2, 0, 0, 34);
  gr.addColorStop(0, '#ffe08a'); gr.addColorStop(0.25, '#e0621a'); gr.addColorStop(0.6, '#4a2416'); gr.addColorStop(1, '#1c0f09');
  g.fillStyle = gr; g.fill();
  g.strokeStyle = '#140904'; g.lineWidth = 2.5; g.stroke();
  g.fillStyle = 'rgba(20,8,4,0.55)';
  for (const [x, y, r] of [[-10, -8, 5], [4, -14, 3.5], [-14, 6, 3], [6, 2, 2.5]]) { g.beginPath(); g.arc(x, y, r, 0, TAU); g.fill(); }
  return c;
})();

// scorch decal left by meteors: dark burn + glowing fissures (separate sprites so
// the glow can fade faster than the burn)
const [scorchSpr, scorchGlowSpr] = (() => {
  const S = 256, R = seeded(99);
  const dark = radialSprite(S, [[0, 'rgba(8,4,2,0.9)'], [0.45, 'rgba(20,10,6,0.65)'], [1, 'rgba(20,10,6,0)']]);
  const hot = makeCanvas(S, S), hg = hot.getContext('2d'), dg = dark.getContext('2d');
  const hr = hg.createRadialGradient(128, 128, 0, 128, 128, 70);
  hr.addColorStop(0, 'rgba(255,190,90,0.9)'); hr.addColorStop(1, 'rgba(255,90,20,0)');
  hg.fillStyle = hr; hg.fillRect(0, 0, S, S);
  hg.lineCap = dg.lineCap = 'round';
  for (let i = 0; i < 11; i++) {
    let a = (i / 11) * TAU + R() * 0.4, x = 128, y = 128;
    const pts = [[x, y]], len = 60 + R() * 55;
    for (let s = 0; s < len; s += 12) { a += (R() - 0.5) * 0.9; x += Math.cos(a) * 12; y += Math.sin(a) * 12; pts.push([x, y]); }
    for (const [g, col, w] of [[dg, 'rgba(5,2,1,0.8)', 4], [hg, 'rgba(255,140,40,0.95)', 2.2]]) {
      g.strokeStyle = col; g.lineWidth = w; g.beginPath();
      pts.forEach(([px, py], k) => (k ? g.lineTo(px, py) : g.moveTo(px, py)));
      g.stroke();
    }
  }
  return [dark, hot];
})();

const labelCache = new Map();
function nameLabel(name, isMe) {
  const key = (isMe ? '1' : '0') + name;
  let l = labelCache.get(key);
  if (!l) {
    if (labelCache.size > 200) labelCache.clear();
    const font = '600 26px system-ui, -apple-system, "Segoe UI", sans-serif';
    const m = makeCanvas(1, 1).getContext('2d'); m.font = font;
    const w = Math.ceil(m.measureText(name).width) + 14;
    const c = makeCanvas(w, 36), g = c.getContext('2d');
    g.font = font; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.lineJoin = 'round'; g.lineWidth = 6; g.strokeStyle = 'rgba(0,0,0,0.75)';
    g.strokeText(name, w / 2, 18);
    g.fillStyle = isMe ? '#ffe2a8' : '#fff'; g.fillText(name, w / 2, 18);
    l = { c, w: w / 2, h: 18 };
    labelCache.set(key, l);
  }
  return l;
}

// ---------------- wizard figures ----------------
// 3/4-view wizards assembled from pre-rendered parts (robe, sleeve and hat per
// colour, head shared) into one small canvas per wizard each frame. Composing per
// wizard lets pose, walk cycle, tints and the death animation apply to the whole
// figure at once. Coordinates: origin at the feet, +x = facing direction.
const PSC = 3; // part supersampling
function part(x0, y0, x1, y1, draw) {
  const w = x1 - x0, h = y1 - y0, c = makeCanvas(w * PSC, h * PSC), g = c.getContext('2d');
  g.scale(PSC, PSC); g.translate(-x0, -y0); g.lineJoin = 'round'; g.lineCap = 'round';
  draw(g);
  return { c, x: x0, y: y0, w, h };
}
const drawPart = (g, p, x = 0, y = 0) => g.drawImage(p.c, x + p.x, y + p.y, p.w, p.h);
const GOLD = '#e4b54f';

const headPart = part(-10, -10, 11, 17, (g) => {
  g.fillStyle = '#dcd7ce'; g.beginPath(); g.ellipse(-3, 0.5, 5.5, 6, 0, 0, TAU); g.fill(); // hair
  const gr = g.createRadialGradient(2, -2, 1, 0.5, 0, 7.5);
  gr.addColorStop(0, '#f8d6b0'); gr.addColorStop(1, '#c48a63');
  g.fillStyle = gr; g.beginPath(); g.arc(0.5, 0, 6.3, 0, TAU); g.fill();
  g.strokeStyle = 'rgba(60,30,15,0.55)'; g.lineWidth = 0.8; g.stroke();
  g.fillStyle = '#e2a47a'; g.beginPath(); g.ellipse(6.3, 1.1, 1.8, 1.4, 0, 0, TAU); g.fill(); // nose
  g.fillStyle = '#1d0f08'; g.beginPath(); g.arc(3.5, -0.7, 1, 0, TAU); g.fill(); // eye
  g.strokeStyle = '#f4f1ea'; g.lineWidth = 1.6; g.beginPath(); g.moveTo(1.5, -2.8); g.lineTo(5.6, -2.3); g.stroke(); // brow
  // long pointed beard sweeping forward and down
  g.beginPath(); g.moveTo(-2.6, 1.4); g.quadraticCurveTo(1, 4.2, 6.8, 2.4);
  g.quadraticCurveTo(7.4, 9.5, 2.6, 16); g.quadraticCurveTo(0.2, 9, -2.6, 1.4); g.closePath();
  const bg = g.createLinearGradient(0, 2, 0, 16);
  bg.addColorStop(0, '#f6f3ec'); bg.addColorStop(1, '#bdb6aa');
  g.fillStyle = bg; g.fill();
  g.strokeStyle = 'rgba(70,60,50,0.55)'; g.lineWidth = 0.7; g.stroke();
  g.strokeStyle = 'rgba(120,110,100,0.5)'; g.lineWidth = 0.5;
  g.beginPath(); g.moveTo(2, 5); g.quadraticCurveTo(3.5, 9, 2.8, 13); g.moveTo(4.6, 4.6); g.quadraticCurveTo(5, 8, 4, 11); g.stroke();
  g.fillStyle = '#f4f1ea'; g.beginPath(); g.ellipse(5.4, 3.1, 2.6, 1.2, 0.3, 0, TAU); g.fill(); // moustache
});

const SHOULDER_Y = -31;
const kitCache = new Map();
/** Per-colour robe, sleeves and hat. */
function wizardKit(color) {
  let k = kitCache.get(color);
  if (k) return k;
  const base = rgb(color), dark = mix(base, [20, 8, 4], 0.5), deep = mix(base, [10, 4, 2], 0.68), light = mix(base, [255, 250, 240], 0.35);
  const robe = part(-17, -5, 17, 33, (g) => {
    const body = () => {
      g.beginPath(); g.moveTo(-8, 0); g.quadraticCurveTo(-11, 12, -14, 27); g.quadraticCurveTo(-6, 31, 0, 30.4);
      g.quadraticCurveTo(7, 31, 14, 27); g.quadraticCurveTo(11, 12, 8, 0); g.quadraticCurveTo(0, -3, -8, 0); g.closePath();
    };
    body();
    const gr = g.createLinearGradient(-14, 0, 14, 0);
    gr.addColorStop(0, rgba(deep, 1)); gr.addColorStop(0.55, rgba(base, 1)); gr.addColorStop(1, rgba(light, 1));
    g.fillStyle = gr; g.fill();
    g.strokeStyle = 'rgba(0,0,0,0.25)'; g.lineWidth = 1;
    g.beginPath(); g.moveTo(-4, 13); g.quadraticCurveTo(-6, 21, -7.5, 29); g.moveTo(1, 14); g.quadraticCurveTo(1.5, 22, 2.5, 30);
    g.moveTo(9, 14); g.quadraticCurveTo(10, 21, 11, 27.5); g.stroke();
    g.strokeStyle = GOLD; g.lineWidth = 1.1; g.beginPath(); g.moveTo(5, 4); g.quadraticCurveTo(6, 17, 7.4, 30.3); g.stroke();
    g.lineWidth = 1.7; g.beginPath(); g.moveTo(-14, 27); g.quadraticCurveTo(-6, 31, 0, 30.4); g.quadraticCurveTo(7, 31, 14, 27); g.stroke();
    // rope belt
    g.fillStyle = '#3a2416'; g.beginPath(); g.moveTo(-9.6, 9); g.quadraticCurveTo(0, 11.5, 9.6, 9); g.lineTo(9.9, 12);
    g.quadraticCurveTo(0, 14.5, -9.9, 12); g.closePath(); g.fill();
    g.fillStyle = GOLD; g.fillRect(4, 9.8, 2.8, 3);
    // mantle over the shoulders
    g.beginPath(); g.moveTo(-9, 0); g.quadraticCurveTo(0, -3.6, 9, 0); g.quadraticCurveTo(10.5, 5, 7, 7.5);
    g.quadraticCurveTo(0, 9.5, -7, 7.5); g.quadraticCurveTo(-10.5, 5, -9, 0); g.closePath();
    g.fillStyle = rgba(dark, 1); g.fill(); g.strokeStyle = 'rgba(0,0,0,0.5)'; g.lineWidth = 0.9; g.stroke();
    body(); g.strokeStyle = 'rgba(0,0,0,0.65)'; g.lineWidth = 1.1; g.stroke();
  });
  const sleeve = (shade) => part(-6, -6.5, 18, 6.5, (g) => {
    g.beginPath(); g.moveTo(-3, -3.8); g.quadraticCurveTo(6, -4.2, 11, -4.6); g.lineTo(12.6, -5.2);
    g.quadraticCurveTo(13.8, 0, 12.6, 5.2); g.lineTo(11, 4.6); g.quadraticCurveTo(6, 4.6, -3, 3.8);
    g.quadraticCurveTo(-5.4, 0, -3, -3.8); g.closePath();
    g.fillStyle = rgba(shade, 1); g.fill(); g.strokeStyle = 'rgba(0,0,0,0.6)'; g.lineWidth = 0.9; g.stroke();
    g.strokeStyle = GOLD; g.lineWidth = 1; g.beginPath(); g.moveTo(11.8, -4.6); g.lineTo(11.8, 4.6); g.stroke();
    g.fillStyle = '#efc69b'; g.beginPath(); g.arc(14.4, 0, 2.7, 0, TAU); g.fill();
    g.strokeStyle = 'rgba(80,40,20,0.5)'; g.lineWidth = 0.6; g.stroke();
  });
  const hat = part(-17, -31, 16, 6, (g) => {
    g.fillStyle = rgba(deep, 1); g.beginPath(); g.ellipse(0, 0, 14, 4.2, 0, 0, TAU); g.fill();
    g.strokeStyle = 'rgba(0,0,0,0.6)'; g.lineWidth = 0.9; g.stroke();
    g.beginPath(); g.moveTo(-7.5, -0.5); g.quadraticCurveTo(-4.5, -12, -3, -18); g.quadraticCurveTo(-6, -25.5, -14, -28);
    g.quadraticCurveTo(-2.5, -24.5, 1.5, -17); g.quadraticCurveTo(5.5, -9, 7.5, -0.5); g.closePath();
    const gr = g.createLinearGradient(-8, 0, 8, 0);
    gr.addColorStop(0, rgba(deep, 1)); gr.addColorStop(0.55, rgba(base, 1)); gr.addColorStop(1, rgba(light, 1));
    g.fillStyle = gr; g.fill(); g.strokeStyle = 'rgba(0,0,0,0.6)'; g.lineWidth = 0.9; g.stroke();
    g.beginPath(); g.moveTo(-7.4, -1); g.quadraticCurveTo(0, 1.6, 7.4, -1); g.lineTo(6.9, -4.2);
    g.quadraticCurveTo(0, -1.8, -6.6, -4.2); g.closePath(); g.fillStyle = GOLD; g.fill();
    g.strokeStyle = 'rgba(60,30,0,0.5)'; g.lineWidth = 0.6; g.stroke();
    // little star on the cone
    g.fillStyle = '#ffeaa0'; g.beginPath();
    for (let i = 0; i < 10; i++) { const a = (i / 10) * TAU - Math.PI / 2, r = i % 2 ? 0.9 : 2.2; g.lineTo(0.8 + Math.cos(a) * r, -10 + Math.sin(a) * r); }
    g.fill();
    g.strokeStyle = rgba(light, 0.9); g.lineWidth = 1.1; g.beginPath(); g.ellipse(0, 0, 14, 4.2, 0, 0.2, Math.PI - 0.2); g.stroke();
  });
  k = { robe, sleeve: sleeve(dark), sleeveBack: sleeve(deep), hat };
  kitCache.set(color, k);
  return k;
}

const FSC = 2; // figure canvas supersampling
const FIG = { x: -40, y: -90, w: 80, h: 104 };
const FEET = 9;     // feet sit this far below the simulation position
const PIVOT = 24;   // lean / tumble pivot above the feet

/** Draw a posed wizard into st's private canvas. Returns the staff tip in local (unflipped) coords. */
function composeWizard(st, kit, pose) {
  const g = st.g;
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.globalCompositeOperation = 'source-over'; g.globalAlpha = 1;
  g.clearRect(0, 0, st.cv.width, st.cv.height);
  g.setTransform(pose.flip ? -FSC : FSC, 0, 0, FSC, -FIG.x * FSC, -FIG.y * FSC);
  const { phase, walk } = pose;
  const sY = SHOULDER_Y + pose.bob;
  // feet (alternate stride + lift)
  const fx = Math.sin(phase) * 5 * walk;
  const l1 = Math.max(0, Math.cos(phase)) * 2.6 * walk, l2 = Math.max(0, -Math.cos(phase)) * 2.6 * walk;
  g.fillStyle = '#22140d';
  g.beginPath(); g.ellipse(-2.5 - fx, -1.4 - l2, 4.6, 2.4, 0, 0, TAU); g.fill();
  g.beginPath(); g.ellipse(4 + fx, -0.8 - l1, 4.9, 2.6, 0, 0, TAU); g.fill();
  // off arm behind the body
  g.save(); g.translate(-3.5, sY + 3); g.rotate(pose.offA); drawPart(g, kit.sleeveBack); g.restore();
  // robe, swaying about the shoulders
  g.save(); g.translate(0, sY); g.transform(1, 0, pose.shear, 1, 0, 0); g.scale(1, pose.breath); drawPart(g, kit.robe); g.restore();
  // head + hat
  const hx = 1 + pose.shear * 3, hy = sY - 7;
  drawPart(g, headPart, hx, hy);
  g.save(); g.translate(hx - 0.5, hy - 5); g.rotate(pose.hatTilt); drawPart(g, kit.hat); g.restore();
  // staff, then the front arm whose hand grips it
  const shx = 4, shy = sY + 3;
  const hdx = shx + Math.cos(pose.armA) * 14.4, hdy = shy + Math.sin(pose.armA) * 14.4;
  const dx = Math.cos(pose.staffA), dy = Math.sin(pose.staffA), push = pose.thrust * 5;
  const bx = hdx - dx * (13 - push), by = hdy - dy * (13 - push), tx = hdx + dx * (30 + push), ty = hdy + dy * (30 + push);
  g.lineCap = 'round';
  g.strokeStyle = '#26160c'; g.lineWidth = 3.4; g.beginPath(); g.moveTo(bx, by); g.lineTo(tx, ty); g.stroke();
  g.strokeStyle = '#94643a'; g.lineWidth = 2; g.stroke();
  g.strokeStyle = '#26160c'; g.lineWidth = 1.4; g.beginPath(); g.arc(tx + dx * 2.6, ty + dy * 2.6, 2.8, 0, TAU); g.stroke();
  g.save(); g.translate(shx, shy); g.rotate(pose.armA); drawPart(g, kit.sleeve); g.restore();
  // whole-figure tints
  g.globalCompositeOperation = 'source-atop';
  if (pose.tint > 0) { g.globalAlpha = pose.tint; g.fillStyle = pose.tintCol; g.fillRect(FIG.x, FIG.y, FIG.w, FIG.h); }
  if (pose.flash > 0) { g.globalAlpha = pose.flash; g.fillStyle = '#ffffff'; g.fillRect(FIG.x, FIG.y, FIG.w, FIG.h); }
  g.globalCompositeOperation = 'source-over'; g.globalAlpha = 1;
  return { x: tx + dx * 2.6, y: ty + dy * 2.6 };
}

// ---------------- lava ----------------
const LAVA = 512;
const lavaMolten = (() => {
  const c = makeCanvas(LAVA, LAVA), g = c.getContext('2d'), R = seeded(7);
  g.fillStyle = '#a92608'; g.fillRect(0, 0, LAVA, LAVA);
  const blob = (x, y, r, col, a) => {
    for (const ox of [-LAVA, 0, LAVA]) for (const oy of [-LAVA, 0, LAVA]) {
      const cx = x + ox, cy = y + oy;
      if (cx + r < 0 || cx - r > LAVA || cy + r < 0 || cy - r > LAVA) continue;
      const gr = g.createRadialGradient(cx, cy, 0, cx, cy, r);
      gr.addColorStop(0, rgba(col, a)); gr.addColorStop(1, rgba(col, 0));
      g.fillStyle = gr; g.fillRect(cx - r, cy - r, r * 2, r * 2);
    }
  };
  for (let i = 0; i < 110; i++) {
    const hot = R() < 0.55;
    blob(R() * LAVA, R() * LAVA, 18 + R() * 60, hot ? [255, 160, 40] : [110, 16, 3], 0.7);
  }
  for (let i = 0; i < 45; i++) blob(R() * LAVA, R() * LAVA, 6 + R() * 16, [255, 236, 150], 0.75);
  return c;
})();
// floating crust plates (a wrapped Voronoi map) with glowing seams between them
const lavaCrust = (() => {
  const N = 256, R = seeded(11), seeds = [];
  for (let i = 0; i < 34; i++) {
    const x = R() * N, y = R() * N, open = R() < 0.24, shade = R();
    for (const ox of [-N, 0, N]) for (const oy of [-N, 0, N]) seeds.push(x + ox, y + oy, open ? 1 : 0, shade);
  }
  const img = new ImageData(N, N), d = img.data;
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    let d1 = 1e9, d2 = 1e9, c1 = 0;
    for (let s = 0; s < seeds.length; s += 4) {
      const dx = seeds[s] - x, dy = seeds[s + 1] - y, dd = dx * dx + dy * dy;
      if (dd < d1) { d2 = d1; d1 = dd; c1 = s; } else if (dd < d2) d2 = dd;
    }
    const edge = Math.sqrt(d2) - Math.sqrt(d1), i = (y * N + x) * 4;
    const k = 0.75 + 0.45 * seeds[c1 + 3] + R() * 0.25;
    const col = mix([44 * k, 14 * k, 6 * k], [150, 44, 8], (1 - smooth(1.5, 7, edge)) * 0.7);
    d[i] = col[0]; d[i + 1] = col[1]; d[i + 2] = col[2];
    d[i + 3] = seeds[c1 + 2] ? 0 : smooth(1.2, 5.5, edge) * 235;
  }
  const small = makeCanvas(N, N); small.getContext('2d').putImageData(img, 0, 0);
  const c = makeCanvas(LAVA, LAVA), g = c.getContext('2d');
  g.imageSmoothingQuality = 'high';
  g.drawImage(small, 0, 0, LAVA, LAVA);
  return c;
})();

// ---------------- stone platform ----------------
const STONE_PX = 1024, STONE_WORLD = 512; // texture is supersampled 2x
const stoneTex = (() => {
  const c = makeCanvas(STONE_PX, STONE_PX), g = c.getContext('2d'), R = seeded(3), S = STONE_PX;
  g.fillStyle = '#2a221e'; g.fillRect(0, 0, S, S); // mortar
  const T = 128; // 64 world units per flagstone
  const tile = (x, y, w, h) => {
    const k = 0.82 + R() * 0.32, warm = R() * 10;
    const col = [88 * k + warm, 80 * k + warm * 0.5, 73 * k];
    for (const ox of [-S, 0, S]) {
      const tx = x + ox;
      if (tx + w < 0 || tx > S) continue;
      g.fillStyle = rgba(col, 1); g.fillRect(tx + 3, y + 3, w - 6, h - 6);
      g.fillStyle = 'rgba(255,236,210,0.07)'; g.fillRect(tx + 3, y + 3, w - 6, 3); g.fillRect(tx + 3, y + 3, 3, h - 6);
      g.fillStyle = 'rgba(0,0,0,0.22)'; g.fillRect(tx + 3, y + h - 6, w - 6, 3); g.fillRect(tx + w - 6, y + 3, 3, h - 6);
    }
  };
  for (let row = 0; row < S / T; row++) {
    const off = (row % 2) * (T / 2);
    for (let col = -1; col <= S / T; col++) tile(col * T + off, row * T, T, T);
  }
  for (let i = 0; i < 14000; i++) { // grain
    g.fillStyle = R() < 0.5 ? 'rgba(255,255,255,0.045)' : 'rgba(0,0,0,0.09)';
    const s = 1 + R() * 2.5; g.fillRect(R() * S, R() * S, s, s);
  }
  const wrap = (fn) => { for (const ox of [-S, 0, S]) for (const oy of [-S, 0, S]) fn(ox, oy); };
  for (let i = 0; i < 22; i++) { // ash stains
    const x = R() * S, y = R() * S, r = 40 + R() * 120;
    wrap((ox, oy) => {
      const gr = g.createRadialGradient(x + ox, y + oy, 0, x + ox, y + oy, r);
      gr.addColorStop(0, 'rgba(18,10,6,0.28)'); gr.addColorStop(1, 'rgba(18,10,6,0)');
      g.fillStyle = gr; g.fillRect(x + ox - r, y + oy - r, r * 2, r * 2);
    });
  }
  g.lineCap = 'round'; g.lineJoin = 'round';
  for (let i = 0; i < 26; i++) { // cracks
    let x = R() * S, y = R() * S, a = R() * TAU;
    const pts = [[x, y]], segs = 4 + Math.floor(R() * 6);
    for (let s = 0; s < segs; s++) { a += (R() - 0.5) * 1.2; const l = 14 + R() * 26; x += Math.cos(a) * l; y += Math.sin(a) * l; pts.push([x, y]); }
    wrap((ox, oy) => {
      const path = (d) => { g.beginPath(); pts.forEach(([px, py], k) => (k ? g.lineTo(px + ox + d, py + oy + d) : g.moveTo(px + ox + d, py + oy + d))); };
      path(1.5); g.strokeStyle = 'rgba(255,230,200,0.07)'; g.lineWidth = 1.5; g.stroke();
      path(0); g.strokeStyle = 'rgba(12,6,3,0.7)'; g.lineWidth = 2.6; g.stroke();
    });
  }
  return c;
})();

// engraved sigil in the arena centre, plus a matching glow layer
const SIGIL_R = 160;
function sigilDraw(g, R) {
  g.lineCap = 'round';
  g.beginPath(); g.arc(0, 0, 150, 0, TAU); g.moveTo(136, 0); g.arc(0, 0, 136, 0, TAU); g.moveTo(52, 0); g.arc(0, 0, 52, 0, TAU); g.stroke();
  g.beginPath();
  for (let i = 0; i <= 7; i++) {
    const a = ((i * 3) / 7) * TAU - Math.PI / 2;
    if (i) g.lineTo(Math.cos(a) * 136, Math.sin(a) * 136); else g.moveTo(Math.cos(a) * 136, Math.sin(a) * 136);
  }
  g.stroke();
  for (let i = 0; i < 18; i++) { // runes around the band
    g.save(); g.rotate((i / 18) * TAU); g.translate(0, -143);
    g.beginPath();
    for (let s = 0; s < 3; s++) { g.moveTo((R() - 0.5) * 8, (R() - 0.5) * 9); g.lineTo((R() - 0.5) * 8, (R() - 0.5) * 9); }
    g.stroke(); g.restore();
  }
}
const [sigilSpr, sigilGlowSpr] = (() => {
  const mk = () => { const c = makeCanvas(SIGIL_R * 4, SIGIL_R * 4), g = c.getContext('2d'); g.scale(2, 2); g.translate(SIGIL_R, SIGIL_R); return [c, g]; };
  const [c1, g1] = mk(), [c2, g2] = mk();
  // engraved look: faint light lip offset below a dark groove (same seed so the passes line up)
  for (const [dy, col, w] of [[1.2, 'rgba(255,230,200,0.07)', 2], [0, 'rgba(10,5,3,0.5)', 2.6]]) {
    g1.save(); g1.translate(0, dy); g1.strokeStyle = col; g1.lineWidth = w; sigilDraw(g1, seeded(42)); g1.restore();
  }
  g2.strokeStyle = 'rgba(255,120,40,0.9)'; g2.lineWidth = 1.6; sigilDraw(g2, seeded(42));
  return [c1, c2];
})();

// crumbling rim: fixed jagged offsets around the circle, scaled to the live radius
const RIM_N = 200;
const rimCos = new Float32Array(RIM_N), rimSin = new Float32Array(RIM_N), rimJag = new Float32Array(RIM_N);
const pebbles = [];
{
  const R = seeded(21);
  for (let i = 0; i < RIM_N; i++) {
    const a = (i / RIM_N) * TAU;
    rimCos[i] = Math.cos(a); rimSin[i] = Math.sin(a);
    rimJag[i] = 2.8 * Math.sin(7 * a + 1.3) + 2 * Math.sin(17 * a + 0.4) + 1.5 * Math.sin(31 * a + 2.2) + (R() - 0.5) * 3;
  }
  for (let i = 0; i < 110; i++) pebbles.push({ a: R() * TAU, off: -10 + R() * 34, s: 1.8 + R() * 4.5 });
}
function rimPath(ctx, radius, dy = 0) {
  ctx.beginPath();
  for (let i = 0; i < RIM_N; i++) {
    const r = radius + rimJag[i];
    if (i) ctx.lineTo(rimCos[i] * r, rimSin[i] * r + dy); else ctx.moveTo(rimCos[i] * r, rimSin[i] * r + dy);
  }
  ctx.closePath();
}

let pats = null;
function patterns(ctx) {
  if (!pats) {
    const stone = ctx.createPattern(stoneTex, 'repeat');
    stone.setTransform(new DOMMatrix().scale(STONE_WORLD / STONE_PX));
    pats = { molten: ctx.createPattern(lavaMolten, 'repeat'), crust: ctx.createPattern(lavaCrust, 'repeat'), stone };
  }
  return pats;
}

function lavaLayer(ctx, pat, v, ox, oy) {
  ox = wrapMod(ox, LAVA); oy = wrapMod(oy, LAVA);
  ctx.save(); ctx.translate(ox, oy);
  ctx.fillStyle = pat; ctx.fillRect(v.x - ox, v.y - oy, v.w, v.h);
  ctx.restore();
}

/** Animated lava filling the view rect {x, y, w, h} (in current coordinates). */
export function drawLava(ctx, now, view) {
  const p = patterns(ctx), t = now / 1000;
  const v = { x: view.x - 40, y: view.y - 40, w: view.w + 80, h: view.h + 80 };
  lavaLayer(ctx, p.molten, v, t * 13, t * 8);
  ctx.globalAlpha = 0.9 + 0.08 * Math.sin(t * 1.1);
  lavaLayer(ctx, p.crust, v, -t * 5 + 40 * Math.sin(t * 0.21), t * 3.5);
  ctx.globalAlpha = 1;
}

/** Menu backdrop: lava in screen space plus a vignette. */
export function drawBackdrop(ctx, now, W, H) {
  drawLava(ctx, now, { x: 0, y: 0, w: W, h: H });
  vignette(ctx, W, H, 0, now);
}

let heatGrad = null, heatKey = -1, shadeGrad = null;
let decals = [];
/** Heat glow, cliff, stone top, centre sigil, scorch marks and crumbling rim. */
export function drawArena(ctx, radius, now) {
  const p = patterns(ctx);
  const rk = Math.round(radius);
  if (rk !== heatKey) { // gradients only rebuilt when the radius changes
    heatKey = rk;
    heatGrad = ctx.createRadialGradient(0, 0, rk - 6, 0, 0, rk + 190);
    heatGrad.addColorStop(0, 'rgba(255,200,100,0.6)'); heatGrad.addColorStop(0.18, 'rgba(255,130,40,0.32)');
    heatGrad.addColorStop(1, 'rgba(255,80,0,0)');
    shadeGrad = ctx.createRadialGradient(0, 0, 0, 0, 0, rk + 8);
    shadeGrad.addColorStop(0, 'rgba(255,230,200,0.07)'); shadeGrad.addColorStop(0.55, 'rgba(0,0,0,0)');
    shadeGrad.addColorStop(0.9, 'rgba(14,7,3,0.38)'); shadeGrad.addColorStop(0.97, 'rgba(120,40,10,0.25)');
    shadeGrad.addColorStop(1, 'rgba(255,120,40,0.45)');
  }
  ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha = 0.85 + 0.15 * Math.sin(now / 420);
  ctx.fillStyle = heatGrad; ctx.fillRect(-rk - 190, -rk - 190, (rk + 190) * 2, (rk + 190) * 2);
  ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = 1;
  // cliff face (seen slightly from above)
  rimPath(ctx, radius, 18); ctx.fillStyle = '#170d09'; ctx.fill();
  ctx.strokeStyle = 'rgba(255,110,30,0.45)'; ctx.lineWidth = 3; ctx.stroke();
  rimPath(ctx, radius, 8); ctx.fillStyle = '#3a2820'; ctx.fill();
  // stone top
  rimPath(ctx, radius); ctx.fillStyle = p.stone; ctx.fill();
  ctx.save(); ctx.clip();
  if (radius > SIGIL_R + 20) {
    ctx.drawImage(sigilSpr, -SIGIL_R, -SIGIL_R, SIGIL_R * 2, SIGIL_R * 2);
    ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha = 0.12 + 0.08 * Math.sin(now / 700);
    ctx.drawImage(sigilGlowSpr, -SIGIL_R, -SIGIL_R, SIGIL_R * 2, SIGIL_R * 2);
    ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = 1;
  }
  for (const d of decals) {
    const q = d.t / d.max, s = d.r * 1.25;
    ctx.globalAlpha = 1 - q * q;
    ctx.drawImage(scorchSpr, d.x - s, d.y - s, s * 2, s * 2);
    const hq = clamp01(d.t / 2.2);
    if (hq < 1) {
      ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha = (1 - hq) * (0.8 + 0.2 * Math.sin(now / 60));
      ctx.drawImage(scorchGlowSpr, d.x - s, d.y - s, s * 2, s * 2);
      ctx.globalCompositeOperation = 'source-over';
    }
  }
  ctx.globalAlpha = 1;
  ctx.fillStyle = shadeGrad; ctx.fillRect(-rk - 10, -rk - 10, rk * 2 + 20, rk * 2 + 20);
  ctx.restore();
  rimPath(ctx, radius);
  ctx.lineJoin = 'round';
  ctx.strokeStyle = 'rgba(26,15,10,0.95)'; ctx.lineWidth = 4.5; ctx.stroke();
  ctx.strokeStyle = 'rgba(255,160,80,0.6)'; ctx.lineWidth = 1.4; ctx.stroke();
  // rubble crumbling off the edge
  ctx.beginPath();
  for (const pb of pebbles) {
    const r = radius + pb.off, x = Math.cos(pb.a) * r, y = Math.sin(pb.a) * r;
    ctx.moveTo(x + pb.s, y); ctx.arc(x, y, pb.s, 0, TAU);
  }
  ctx.fillStyle = '#271a14'; ctx.fill();
  ctx.strokeStyle = 'rgba(255,130,40,0.55)'; ctx.lineWidth = 1; ctx.stroke();
}

// ---------------- vignette ----------------
let vigKey = '', vigGrad = null, dangerGrad = null, myDanger = 0;
function vignette(ctx, W, H, danger, now) {
  const key = W + 'x' + H;
  if (key !== vigKey) {
    vigKey = key;
    const r0 = Math.min(W, H) * 0.35, r1 = Math.hypot(W, H) * 0.62;
    vigGrad = ctx.createRadialGradient(W / 2, H / 2, r0, W / 2, H / 2, r1);
    vigGrad.addColorStop(0, 'rgba(0,0,0,0)'); vigGrad.addColorStop(1, 'rgba(12,3,0,0.6)');
    dangerGrad = ctx.createRadialGradient(W / 2, H / 2, r0 * 0.9, W / 2, H / 2, r1);
    dangerGrad.addColorStop(0, 'rgba(200,20,0,0)'); dangerGrad.addColorStop(1, 'rgba(210,30,0,0.55)');
  }
  ctx.fillStyle = vigGrad; ctx.fillRect(0, 0, W, H);
  if (danger > 0.01) {
    ctx.globalAlpha = danger * (0.7 + 0.3 * Math.sin(now / 170));
    ctx.fillStyle = dangerGrad; ctx.fillRect(0, 0, W, H);
    ctx.globalAlpha = 1;
  }
}
/** Screen-space vignette; pulses red when the local wizard is low or burning. */
export function drawVignette(ctx, W, H, now) { vignette(ctx, W, H, myDanger, now); }

// ---------------- particles & effects state ----------------
const parts = [];   // {x,y,vx,vy,life,max,size,kind,img,col,drag,amb}
const rings = [];   // {kind,x,y,r,t,max,color}
const ghosts = [];  // blink afterimages
const nums = [];    // floating damage numbers
const dying = [];   // death animations
const falling = []; // meteors in the air this frame
let trauma = 0, shakeT = 0;
const K_GLOW = 0, K_SPARK = 1, K_SMOKE = 2, K_FLAME = 3;

function emit(x, y, n, color, speed, life, size, kind = K_GLOW, drag = 0.93) {
  const img = kind === K_SMOKE ? smokeSpr : kind === K_FLAME ? null : glow(color);
  for (let i = 0; i < n; i++) {
    const a = Math.random() * TAU, v = speed * (0.3 + Math.random() * 0.7), l = life * (0.6 + Math.random() * 0.4);
    parts.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: l, max: l, size: size * (0.6 + Math.random() * 0.8), kind, img, col: color, drag });
  }
}
/** One licking flame tongue: rises, cools from white-yellow through orange to red. */
function flame(x, y, vx, vy, life, size) {
  parts.push({ x, y, vx, vy, life, max: life, size, kind: K_FLAME, img: null, drag: 0.95 });
}
function addShake(v) { trauma = Math.min(1, trauma + v); }

export function resetFx() {
  parts.length = rings.length = ghosts.length = nums.length = falling.length = dying.length = 0;
  decals = []; trails.clear(); pstate.clear(); seenZones.clear(); trauma = 0; myDanger = 0;
}

/** Screen shake offset in CSS px for this frame (subtle, decays quickly). */
export function shakeOffset(dt) {
  trauma = Math.max(0, trauma - dt * 1.8);
  shakeT += dt;
  if (REDUCED_MOTION || trauma <= 0) return [0, 0];
  const m = 9 * trauma * trauma, t = shakeT;
  return [m * (Math.sin(t * 47.3) * 0.6 + Math.sin(t * 83.1 + 1.7) * 0.4), m * (Math.sin(t * 53.9 + 0.5) * 0.6 + Math.sin(t * 97.7 + 2.3) * 0.4)];
}

// ---------------- wizards ----------------
const pstate = new Map(); // id -> per-wizard animation state + private canvas

function castBy(id, ang) {
  const st = pstate.get(id);
  if (st && st.alive) { st.cast = 1; st.castAng = ang; }
}
function nearestWizard(x, y, maxD) {
  let best = null, bd = maxD;
  for (const [id, st] of pstate) {
    if (!st.alive) continue;
    const d = Math.hypot(st.x - x, st.y - y);
    if (d < bd) { bd = d; best = id; }
  }
  return best;
}

/**
 * Spawn visuals for a server event. env: {P: latest snapshot players, myId, cam}.
 */
export function fxEvent(ev, env) {
  const [type, a, b, c, d] = ev;
  const P = env.P || [];
  const mine = P.find((p) => p[0] === env.myId && p[5] & 1);
  const near = (x, y, R) => Math.max(0, 1 - Math.hypot(x - env.cam.x, y - env.cam.y) / R);
  if (type === 'hit') {
    const col = c ? '#c08cff' : '#ffb347';
    emit(a, b, 14, col, 260, 0.35, 2, K_SPARK, 0.9);
    if (c) emit(a, b, 8, col, 90, 0.45, 8);
    else for (let i = 0; i < 8; i++) flame(a + rand(-6, 6), b + rand(-6, 6), rand(-60, 60), rand(-90, 10), rand(0.3, 0.5), rand(8, 13));
    rings.push({ kind: 'flash', x: a, y: b, r: 30, t: 0, max: 0.2, color: col });
    if (mine && Math.hypot(a - mine[1], b - mine[2]) < 60) addShake(0.3); else addShake(0.1 * near(a, b, 450));
  } else if (type === 'refl') {
    emit(a, b, 12, '#aeefff', 220, 0.3, 2, K_SPARK, 0.9);
    rings.push({ kind: 'ring', x: a, y: b, r: 34, t: 0, max: 0.25, color: '#aeefff' });
  } else if (type === 'shock') {
    const who = nearestWizard(a, b, 40);
    if (who !== null) castBy(who, -Math.PI / 2);
    rings.push({ kind: 'shock', x: a, y: b, r: c, t: 0, max: 0.42 });
    for (let i = 0; i < 34; i++) {
      const ang = Math.random() * TAU, v = c * rand(2, 3.2), l = rand(0.25, 0.4);
      parts.push({ x: a + Math.cos(ang) * 20, y: b + Math.sin(ang) * 20, vx: Math.cos(ang) * v, vy: Math.sin(ang) * v, life: l, max: l, size: 2.2, kind: K_SPARK, col: i % 3 ? '#bfe9ff' : '#ffffff', drag: 0.9 });
    }
    emit(a, b, 10, '', c * 0.9, 0.7, 16, K_SMOKE, 0.9);
    const meHit = mine && Math.hypot(a - mine[1], b - mine[2]) < c + PLAYER_R;
    addShake(meHit ? 0.28 : 0.12 * near(a, b, 600));
  } else if (type === 'boom') {
    rings.push({ kind: 'boom', x: a, y: b, r: c, t: 0, max: 0.55 });
    decals.push({ x: a, y: b, r: c, t: 0, max: 7 });
    if (decals.length > 14) decals.shift();
    emit(a, b, 36, '#ff8a2a', c * 3.4, 0.5, 2.6, K_SPARK, 0.9);
    for (let i = 0; i < 34; i++) {
      const ang = Math.random() * TAU, v = rand(0.3, 1.6) * c;
      flame(a + Math.cos(ang) * 10, b + Math.sin(ang) * 10, Math.cos(ang) * v, Math.sin(ang) * v - 40, rand(0.45, 0.85), rand(14, 26));
    }
    emit(a, b, 16, '', c * 1.1, 1.4, 26, K_SMOKE, 0.93);
    addShake(0.65 * near(a, b, 850));
  } else if (type === 'blink') {
    const who = nearestWizard(c, d, 60);
    const st = who !== null ? pstate.get(who) : null;
    if (st) { castBy(who, Math.atan2(d - b, c - a)); st.px = c; st.py = d; st.vx = st.vy = 0; }
    for (let i = 0; i < 4; i++) {
      const q = i / 4;
      ghosts.push({ x: lerp(a, c, q), y: lerp(b, d, q), cv: st ? st.cv : null, t: -i * 0.03, max: 0.5 });
    }
    rings.push({ kind: 'streak', x: a, y: b, x2: c, y2: d, t: 0, max: 0.3 });
    emit(a, b, 14, '#c99bff', 140, 0.5, 6);
    emit(c, d, 18, '#e2c8ff', 200, 0.4, 2, K_SPARK, 0.9);
    rings.push({ kind: 'ring', x: c, y: d, r: 40, t: 0, max: 0.3, color: '#c99bff' });
  } else if (type === 'lvl') {
    const p = P.find((q) => q[0] === a);
    if (p) {
      rings.push({ kind: 'ring', x: p[1], y: p[2], r: 56, t: 0, max: 0.6, color: '#ffd84d' });
      for (let i = 0; i < 18; i++) {
        const ang = Math.random() * TAU, l = rand(0.7, 1.1);
        parts.push({ x: p[1] + Math.cos(ang) * 22, y: p[2] + Math.sin(ang) * 22, vx: Math.cos(ang) * 20, vy: -rand(40, 90), life: l, max: l, size: rand(3, 6), kind: K_GLOW, img: glow('#ffd84d'), drag: 0.97 });
      }
    }
  } else if (type === 'die') {
    for (let i = 0; i < 26; i++) flame(c + rand(-14, 14), d + rand(-10, 10), rand(-120, 120), rand(-200, 20), rand(0.5, 0.9), rand(12, 22));
    emit(c, d, 24, '#ffc070', 380, 0.5, 2.4, K_SPARK, 0.9);
    emit(c, d, 16, '', 120, 1.6, 22, K_SMOKE, 0.95);
    rings.push({ kind: 'ring', x: c, y: d, r: 80, t: 0, max: 0.5, color: '#ff5522' });
    addShake(a === env.myId ? 0.5 : 0.2 * near(c, d, 600));
  }
}

function newState(p) {
  const cv = makeCanvas(FIG.w * FSC, FIG.h * FSC);
  return { cv, g: cv.getContext('2d'), x: p.x, y: p.y, vx: 0, vy: 0, hp: p.hp, lag: p.hp, flash: 0, rec: 0,
    cast: 0, castAng: p.face, face: p.face, flip: Math.cos(p.face) < 0, phase: 0, spin: 0, alive: false, lava: false, color: '#cccccc' };
}

/**
 * Animate and draw every wizard (living ones sorted by y, plus death animations),
 * then HP bars and names on top. players: [{id,x,y,hp,maxHp,alive,ward,lava,face}].
 */
export function drawPlayers(ctx, players, roster, myId, now, dt) {
  myDanger = Math.max(0, myDanger - dt * 2);
  const ids = new Set();
  for (const p of players) {
    ids.add(p.id);
    const st = pstate.get(p.id);
    if (st && st.alive && !p.alive) startDeath(st);
    if (st && !p.alive) st.alive = false;
  }
  for (const id of pstate.keys()) if (!ids.has(id)) pstate.delete(id);
  drawDying(ctx, dt, now);

  const list = players.filter((p) => p.alive).sort((p, q) => p.y - q.y);
  for (const p of list) {
    const info = roster.get(p.id) || { color: '#cccccc', name: '' };
    const isMe = p.id === myId;
    let st = pstate.get(p.id);
    if (!st) { st = newState(p); pstate.set(p.id, st); }
    if (!st.alive) { // (re)spawned
      Object.assign(st, { alive: true, x: p.x, y: p.y, vx: 0, vy: 0, hp: p.hp, lag: p.hp, flash: 0, rec: 0, cast: 0, spin: 0 });
    }
    const dmg = st.hp - p.hp;
    if (dmg > 0.5 && (!p.lava || dmg >= 4)) {
      st.flash = 1; st.rec = 1;
      if (dmg >= 2) { nums.push({ x: p.x + rand(-8, 8), y: p.y - 58, v: Math.round(dmg), t: 0, me: isMe }); if (nums.length > 40) nums.shift(); }
    }
    st.hp = p.hp;
    st.lag = p.hp > st.lag ? p.hp : Math.max(p.hp, st.lag - dt * p.maxHp * 0.5);
    st.flash = Math.max(0, st.flash - dt * 6);
    st.rec = Math.max(0, st.rec - dt * 4.5);
    st.cast = Math.max(0, st.cast - dt / 0.3);
    // velocity from interpolated position deltas (ignore teleports / respawns)
    if (dt > 0) {
      const mx = p.x - st.x, my = p.y - st.y;
      const k = 1 - Math.exp(-12 * dt);
      if (Math.abs(mx) + Math.abs(my) > 70) { st.vx = st.vy = 0; } else { st.vx = lerp(st.vx, mx / dt, k); st.vy = lerp(st.vy, my / dt, k); }
    }
    st.x = p.x; st.y = p.y; st.face = p.face; st.lava = !!p.lava; st.color = info.color;
    if (isMe) myDanger = Math.max(myDanger, p.lava ? 0.85 : clamp01((0.35 - p.hp / p.maxHp) / 0.35) * 0.8);
    drawWizard(ctx, p, info, isMe, st, now, dt);
  }
  for (const p of list) {
    const info = roster.get(p.id) || { color: '#cccccc', name: '' };
    const st = pstate.get(p.id);
    const bw = 42, bh = 5, hx = p.x - bw / 2, hy = p.y + FEET - 82;
    const hf = clamp01(p.hp / p.maxHp), lf = clamp01(st.lag / p.maxHp);
    ctx.fillStyle = 'rgba(10,4,2,0.72)'; ctx.fillRect(hx - 1.5, hy - 1.5, bw + 3, bh + 3);
    ctx.fillStyle = '#ffe6c0'; ctx.fillRect(hx, hy, bw * lf, bh);
    ctx.fillStyle = hf > 0.5 ? '#5fd35f' : hf > 0.25 ? '#f0c43a' : '#ff4a32'; ctx.fillRect(hx, hy, bw * hf, bh);
    ctx.fillStyle = 'rgba(255,255,255,0.3)'; ctx.fillRect(hx, hy, bw * hf, 1.5);
    if (info.name) {
      const l = nameLabel(info.name, p.id === myId);
      ctx.drawImage(l.c, p.x - l.w / 2, hy - 3 - l.h, l.w, l.h);
    }
  }
}

function drawWizard(ctx, p, info, isMe, st, now, dt) {
  const kit = wizardKit(info.color);
  const speed = Math.hypot(st.vx, st.vy);
  const knock = smooth(330, 600, speed);              // flung by knockback
  const walk = smooth(15, 90, speed) * (1 - knock);   // walking under own power
  st.phase += speed * dt * (TAU / 34) * (1 - knock);  // one stride cycle per ~34 units
  if (speed > 680) st.spin += dt * Math.sign(st.vx || 1) * 11;
  else { st.spin = Math.atan2(Math.sin(st.spin), Math.cos(st.spin)); st.spin *= Math.exp(-8 * dt); }

  const castW = clamp01((1 - st.cast) * 6) * clamp01(st.cast * 2.5) * (st.cast > 0 ? 1 : 0);
  const dirAng = st.cast > 0 ? st.castAng : p.face;
  const cx = Math.cos(dirAng);
  if (cx < -0.08) st.flip = true; else if (cx > 0.08) st.flip = false;
  const flip = st.flip;
  const aim = flip ? angDiff(0, Math.PI - st.castAng) : angDiff(0, st.castAng); // local aim angle
  const vxLocal = flip ? -st.vx : st.vx;
  const idle = 1 - walk;
  const swing = Math.sin(st.phase);

  let armA = 1.15 + swing * 0.25 * walk, staffA = -1.42 + swing * 0.06 * walk, offA = 1.95 - swing * 0.35 * walk;
  armA = lerpAng(armA, aim, castW); staffA = lerpAng(staffA, aim, castW);
  if (knock > 0) {
    armA = lerpAng(armA, -2.2 + Math.sin(now / 40 + p.id) * 0.5, knock);
    offA = lerpAng(offA, -2.6 + Math.cos(now / 45 + p.id) * 0.5, knock);
    staffA = lerpAng(staffA, armA + 0.6, knock);
  }
  const pose = {
    flip, phase: st.phase, walk,
    bob: -Math.abs(swing) * 1.7 * walk + Math.sin(now / 550 + p.id) * 0.7 * idle + st.rec * 1.5,
    breath: 1 + Math.sin(now / 550 + p.id) * 0.015 * idle,
    shear: swing * 0.09 * walk - Math.max(-1, Math.min(1, vxLocal / 300)) * 0.1 + Math.sin(now / 800 + p.id) * 0.025 * idle,
    hatTilt: -0.06 - st.rec * 0.3 - knock * 0.3 + swing * 0.03 * walk,
    armA, staffA, offA, thrust: castW,
    tint: 0, tintCol: '#ff2a10', flash: st.flash * 0.85,
  };
  const hf = clamp01(p.hp / p.maxHp);
  if (p.lava) { pose.tint = 0.35 + 0.2 * Math.sin(now / 45 + p.id); pose.tintCol = '#ff6a1a'; }
  else if (hf < 0.5) pose.tint = (0.5 - hf) * 0.75 * (0.75 + 0.25 * Math.sin(now / 150));
  const tip = composeWizard(st, kit, pose);
  const tipX = flip ? -tip.x : tip.x;

  const fy = p.y + FEET;
  ctx.drawImage(shadowSpr, p.x - 21, fy - 8, 42, 16);
  if (isMe) {
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = 0.25; ctx.drawImage(glow(info.color), p.x - 40, fy - 20, 80, 40);
    ctx.globalAlpha = 0.6 + 0.2 * Math.sin(now / 260);
    ctx.strokeStyle = info.color; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.ellipse(p.x, fy, 25, 11, 0, 0, TAU); ctx.stroke();
    ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
  }
  const lean = Math.max(-1, Math.min(1, st.vx / 500)) * knock * 0.6 + st.rec * 0.22 * (flip ? 1 : -1);
  const rot = lean + st.spin;
  let tipWX, tipWY;
  if (p.lava && Math.abs(rot) < 0.08) {
    // wading in lava: the feet sink below the surface
    const s = 8 + Math.sin(now / 160 + p.id) * 1.5, vis = -FIG.y - s;
    ctx.drawImage(st.cv, 0, 0, st.cv.width, vis * FSC, p.x + FIG.x, fy + FIG.y + s, FIG.w, vis);
    tipWX = p.x + tipX; tipWY = fy + tip.y + s;
  } else {
    const sq = st.rec * 0.08;
    ctx.save(); ctx.translate(p.x, fy - PIVOT); ctx.rotate(rot); ctx.scale(1 + sq, 1 - sq);
    ctx.drawImage(st.cv, FIG.x, FIG.y + PIVOT, FIG.w, FIG.h);
    ctx.restore();
    const c = Math.cos(rot), s = Math.sin(rot), ly = tip.y + PIVOT;
    tipWX = p.x + tipX * c - ly * s; tipWY = fy - PIVOT + tipX * s + ly * c;
  }
  // glowing staff tip in the player's colour (flares while casting)
  ctx.globalCompositeOperation = 'lighter';
  blit(ctx, glow(info.color), tipWX, tipWY, 11 + 2 * Math.sin(now / 110 + p.id) + castW * 12);
  blit(ctx, glow('#ffffff'), tipWX, tipWY, 4 + castW * 4);
  if (p.lava) { // molten ripple around the legs
    ctx.globalAlpha = 0.6 + 0.3 * Math.sin(now / 120 + p.id);
    ctx.strokeStyle = '#ffc060'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.ellipse(p.x, fy, 20 + Math.sin(now / 200) * 3, 8, 0, 0, TAU); ctx.stroke();
    ctx.globalAlpha = 1;
  }
  ctx.globalCompositeOperation = 'source-over';

  if (p.lava) {
    if (Math.random() < 0.8) flame(p.x + rand(-13, 13), fy - rand(0, 30), rand(-15, 15), -rand(50, 100), rand(0.35, 0.7), rand(8, 14));
    if (Math.random() < 0.15) {
      const l = rand(0.9, 1.4);
      parts.push({ x: p.x + rand(-10, 10), y: fy - 40, vx: rand(-10, 10), vy: -rand(30, 50), life: l, max: l, size: rand(10, 16), kind: K_SMOKE, img: smokeSpr, drag: 0.98 });
    }
  } else if (knock > 0.4 && Math.random() < 0.5) { // dust kicked up while skidding
    const l = rand(0.4, 0.7);
    parts.push({ x: p.x + rand(-8, 8), y: fy, vx: -st.vx * 0.1, vy: -st.vy * 0.1 - 10, life: l, max: l, size: rand(6, 10), kind: K_SMOKE, img: smokeSpr, drag: 0.92 });
  }
  if (p.ward) {
    const r = 36 + Math.sin(now / 90) * 1.2, wy = fy - 28;
    ctx.globalCompositeOperation = 'lighter';
    ctx.drawImage(wardSpr, p.x - r, wy - r, r * 2, r * 2);
    ctx.strokeStyle = 'rgba(190,242,255,0.8)'; ctx.lineWidth = 1.6;
    ctx.beginPath();
    for (let i = 0; i < 3; i++) {
      const a0 = now / 380 + (i * TAU) / 3;
      ctx.moveTo(p.x + Math.cos(a0) * (r - 2), wy + Math.sin(a0) * (r - 2));
      ctx.arc(p.x, wy, r - 2, a0, a0 + 0.8);
    }
    ctx.stroke();
    ctx.globalCompositeOperation = 'source-over';
  }
}

function startDeath(st) {
  // freeze the last pose into a detached canvas, scorched by how they died
  const cv = makeCanvas(st.cv.width, st.cv.height), g = cv.getContext('2d');
  g.drawImage(st.cv, 0, 0);
  g.globalCompositeOperation = 'source-atop';
  g.fillStyle = st.lava ? 'rgba(255,90,20,0.5)' : 'rgba(30,10,4,0.65)';
  g.fillRect(0, 0, cv.width, cv.height);
  dying.push({ cv, x: st.x, y: st.y, lava: st.lava, t: 0, max: st.lava ? 1.5 : 1.1 });
}

function drawDying(ctx, dt, now) {
  let n = 0;
  for (const d of dying) {
    d.t += dt;
    if (d.t >= d.max) continue;
    dying[n++] = d;
    const q = d.t / d.max, fy = d.y + FEET;
    if (d.lava) {
      // sinks into the lava, thrashing a little, wreathed in flame
      const s = Math.pow(q, 1.4) * -FIG.y, vis = -FIG.y - s, wob = Math.sin(now / 50) * 2 * (1 - q);
      if (vis > 1) ctx.drawImage(d.cv, 0, 0, d.cv.width, vis * FSC, d.x + FIG.x + wob, fy + FIG.y + s, FIG.w, vis);
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = 0.8 * (1 - q); ctx.strokeStyle = '#ffd080'; ctx.lineWidth = 2.5;
      ctx.beginPath(); ctx.ellipse(d.x, fy, 18 + q * 30, 7 + q * 12, 0, 0, TAU); ctx.stroke();
      ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
      if (Math.random() < 0.9) flame(d.x + rand(-14, 14), fy - rand(0, Math.max(4, vis * 0.6)), rand(-20, 20), -rand(60, 120), rand(0.35, 0.7), rand(10, 18));
    } else {
      // burns to ash and crumbles
      ctx.globalAlpha = 1 - q;
      const sy = 1 - 0.4 * q;
      ctx.drawImage(d.cv, d.x + FIG.x, fy + FIG.y * sy, FIG.w, FIG.h * sy);
      ctx.globalAlpha = 1;
      if (Math.random() < 0.8) flame(d.x + rand(-12, 12), fy - rand(5, 60) * (1 - q), rand(-20, 20), -rand(40, 90), rand(0.3, 0.6), rand(6, 12));
      if (Math.random() < 0.3) {
        const l = rand(0.8, 1.3);
        parts.push({ x: d.x + rand(-10, 10), y: fy - rand(10, 50), vx: rand(-15, 15), vy: -rand(20, 40), life: l, max: l, size: rand(8, 14), kind: K_SMOKE, img: smokeSpr, drag: 0.98 });
      }
    }
  }
  dying.length = n;
}

// ---------------- projectiles & meteors ----------------
const trails = new Map(); // projectile id -> {pts, seen}
const seenZones = new Set();
let stamp = 0;

/** Bolts (fiery comet trail) and seeker wisps (swirling tail), interpolated between snapshots a and b. */
export function drawProjectiles(ctx, a, b, f, myId, now) {
  stamp++;
  ctx.globalCompositeOperation = 'lighter';
  for (const jb of b.J) {
    const ja = a.Jm.get(jb[0]) || jb;
    const x = lerp(ja[2], jb[2], f), y = lerp(ja[3], jb[3], f), seeker = jb[1] === 1;
    let tr = trails.get(jb[0]);
    if (!tr) {
      tr = { pts: [], seen: 0 }; trails.set(jb[0], tr);
      const st = pstate.get(jb[4]);
      if (st) castBy(jb[4], Math.atan2(y - st.y, x - st.x));
    }
    tr.seen = stamp;
    const last = tr.pts[tr.pts.length - 1];
    if (!last || Math.abs(last.x - x) + Math.abs(last.y - y) > 1.5) {
      tr.pts.push({ x, y });
      if (tr.pts.length > (seeker ? 22 : 10)) tr.pts.shift();
    }
    if (seeker) drawSeeker(ctx, tr.pts, x, y, now, jb[0]); else drawBolt(ctx, tr.pts, x, y, now);
    if (jb[4] === myId) {
      ctx.globalAlpha = 0.45; ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 1.2;
      ctx.beginPath(); ctx.arc(x, y, seeker ? 15 : 12, 0, TAU); ctx.stroke(); ctx.globalAlpha = 1;
    }
  }
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  for (const [id, tr] of trails) {
    if (tr.seen === stamp) continue;
    const l = tr.pts[tr.pts.length - 1];
    if (l) emit(l.x, l.y, 5, '#ffb347', 60, 0.3, 5);
    trails.delete(id);
  }
}

function drawBolt(ctx, pts, x, y, now) {
  const g = glow('#ff6a14'), n = pts.length;
  for (let i = 0; i < n; i++) {
    const q = (i + 1) / n;
    ctx.globalAlpha = 0.5 * q;
    blit(ctx, g, pts[i].x, pts[i].y, 4 + 13 * q);
  }
  ctx.globalAlpha = 1;
  blit(ctx, g, x, y, 24);
  blit(ctx, glow('#ffd36b'), x, y, 13);
  blit(ctx, glow('#ffffff'), x, y, 6 + Math.sin(now / 30 + x) * 0.8);
  // licking flames shed behind the bolt
  if (n > 1) {
    const p0 = pts[n - 2], dx = x - p0.x, dy = y - p0.y;
    flame(x - dx * 0.5 + rand(-3, 3), y - dy * 0.5 + rand(-3, 3), rand(-25, 25), rand(-45, 5), rand(0.18, 0.32), rand(7, 11));
  }
}

function drawSeeker(ctx, pts, x, y, now, id) {
  const vio = glow('#a46bff'), pink = glow('#ff9cf0'), white = glow('#ffffff'), n = pts.length;
  for (let i = 1; i < n; i++) {
    const p0 = pts[i - 1], p1 = pts[i];
    let dx = p1.x - p0.x, dy = p1.y - p0.y;
    const dl = Math.hypot(dx, dy) || 1; dx /= dl; dy /= dl;
    const q = i / n, amp = 9 * (1 - q) + 2.5, s = Math.sin(now * 0.011 + i * 0.6 + id) * amp;
    ctx.globalAlpha = 0.6 * q;
    blit(ctx, vio, p1.x - dy * s, p1.y + dx * s, 3 + 6 * q);
    blit(ctx, pink, p1.x + dy * s, p1.y - dx * s, 2.5 + 4.5 * q);
  }
  ctx.globalAlpha = 1;
  blit(ctx, vio, x, y, 28 + 3 * Math.sin(now / 80 + id));
  blit(ctx, pink, x, y, 12);
  blit(ctx, white, x, y, 6.5);
  for (let k = 0; k < 3; k++) {
    const an = now * 0.009 + (k * TAU) / 3;
    blit(ctx, white, x + Math.cos(an) * 12, y + Math.sin(an) * 12, 3);
  }
}

/** Meteor telegraphs on the ground: target zone, dashed rim and the falling meteor's growing shadow. */
export function drawZones(ctx, a, b, f, now) {
  falling.length = 0;
  const total = SPELLS.meteor.delay * TICK;
  for (const z of b.Z) {
    const [id, x, y, r] = z;
    if (!seenZones.has(id)) {
      seenZones.add(id);
      // the caster is whoever is facing the target spot most squarely
      let best = null, bd = 0.4;
      for (const [pid, st] of pstate) {
        if (!st.alive || Math.hypot(x - st.x, y - st.y) > 660) continue;
        const d = Math.abs(angDiff(st.face, Math.atan2(y - st.y, x - st.x)));
        if (d < bd) { bd = d; best = pid; }
      }
      if (best !== null) castBy(best, Math.atan2(y - pstate.get(best).y, x - pstate.get(best).x));
    }
    const za = a.Z.find((q) => q[0] === id);
    const p = clamp01(1 - (za ? lerp(za[4], z[4], f) : z[4]) / total);
    ctx.fillStyle = `rgba(255,70,10,${0.08 + 0.14 * p})`;
    ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.fill();
    ctx.fillStyle = 'rgba(255,130,40,0.16)';
    ctx.beginPath(); ctx.arc(x, y, r * p, 0, TAU); ctx.fill();
    ctx.setLineDash([16, 10]); ctx.lineDashOffset = -now / 25;
    ctx.strokeStyle = `rgba(255,140,50,${0.55 + 0.45 * p})`; ctx.lineWidth = 2.5;
    ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.stroke();
    ctx.setLineDash([]);
    ctx.lineWidth = 2; ctx.beginPath();
    for (let k = 0; k < 4; k++) {
      const an = (k * TAU) / 4 + now / 900;
      ctx.moveTo(x + Math.cos(an) * r * 0.82, y + Math.sin(an) * r * 0.82);
      ctx.lineTo(x + Math.cos(an) * r * 0.62, y + Math.sin(an) * r * 0.62);
    }
    ctx.stroke();
    const sr = r * (0.12 + 0.45 * p);
    ctx.globalAlpha = 0.35 + 0.6 * p;
    ctx.drawImage(shadowSpr, x - sr, y - sr * 0.8, sr * 2, sr * 1.6);
    ctx.globalAlpha = 1;
    if (p < 1) falling.push({ x, y, p, id });
  }
  if (seenZones.size > 64) for (const id of seenZones) { if (!b.Z.some((z) => z[0] === id)) seenZones.delete(id); }
}

// rock falling in from the upper left, trailing fire and smoke
const FALL_UX = -0.42, FALL_UY = -0.91;
function drawMeteors(ctx, now) {
  const orange = glow('#ff6a14'), yellow = glow('#ffe08a');
  for (const m of falling) {
    const dist = Math.pow(1 - m.p, 1.35) * 600, s = 12 + 12 * m.p;
    const mx = m.x + FALL_UX * dist, my = m.y + FALL_UY * dist;
    ctx.globalCompositeOperation = 'lighter';
    for (let k = 9; k >= 0; k--) {
      const d = k * s * 0.9;
      ctx.globalAlpha = (1 - k / 10) * 0.7;
      blit(ctx, orange, mx + FALL_UX * d, my + FALL_UY * d, s * 2.2 * (1 - k / 12));
    }
    ctx.globalAlpha = 1;
    blit(ctx, yellow, mx, my, s * 1.9);
    ctx.globalCompositeOperation = 'source-over';
    ctx.save(); ctx.translate(mx, my); ctx.rotate(now / 160 + m.id);
    ctx.drawImage(rockSpr, -s, -s, s * 2, s * 2);
    ctx.restore();
    for (let i = 0; i < 2; i++) {
      const back = rand(0.2, 1.2) * s;
      flame(mx + FALL_UX * back + rand(-s, s) * 0.5, my + FALL_UY * back + rand(-s, s) * 0.5, FALL_UX * rand(60, 140), FALL_UY * rand(60, 140), rand(0.25, 0.45), s * rand(0.8, 1.3));
    }
    if (Math.random() < 0.35) {
      const l = rand(0.6, 1);
      parts.push({ x: mx + FALL_UX * s * 2, y: my + FALL_UY * s * 2, vx: FALL_UX * 40, vy: FALL_UY * 40, life: l, max: l, size: s * 0.9, kind: K_SMOKE, img: smokeSpr, drag: 0.96 });
    }
  }
}

// ---------------- effects pass ----------------
/**
 * Particles, rings, afterimages, falling meteors and damage numbers.
 * view: {x, y, w, h} visible world rect; radius: arena radius (for ambient embers).
 */
export function drawEffects(ctx, dt, now, view, radius) {
  // ambient embers drifting up off the lava
  let amb = 0;
  for (const p of parts) if (p.amb) amb++;
  if (amb < 45 && Math.random() < 0.7) {
    const x = view.x + Math.random() * view.w, y = view.y + Math.random() * view.h;
    if (Math.hypot(x, y) > radius + 14) {
      const l = rand(1.4, 2.8);
      parts.push({ x, y, vx: rand(-12, 12), vy: -rand(20, 45), life: l, max: l, size: rand(2, 4), kind: K_GLOW, img: glow(Math.random() < 0.6 ? '#ffb347' : '#ff6a1a'), drag: 1, amb: true });
    }
  }
  for (const d of decals) d.t += dt;
  while (decals.length && decals[0].t > decals[0].max) decals.shift();

  // blink afterimages
  ctx.globalCompositeOperation = 'lighter';
  let gn = 0;
  for (const g of ghosts) {
    g.t += dt;
    if (g.t >= g.max) continue;
    ghosts[gn++] = g;
    if (g.t < 0) continue;
    const al = 1 - g.t / g.max;
    if (g.cv) {
      ctx.globalAlpha = 0.45 * al;
      ctx.drawImage(g.cv, g.x + FIG.x, g.y + FEET + FIG.y, FIG.w, FIG.h);
    }
    ctx.globalAlpha = 0.5 * al;
    ctx.drawImage(glow('#b37dff'), g.x - 24, g.y + FEET - 64, 48, 70);
  }
  ghosts.length = gn;
  ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';

  // particle update (in-place compaction, no per-frame allocation)
  let n = 0;
  for (const p of parts) {
    p.life -= dt;
    if (p.life <= 0) continue;
    p.x += p.vx * dt; p.y += p.vy * dt;
    if (p.kind === K_FLAME) p.vy -= 60 * dt; // flames rise
    if (p.drag !== 1) { const k = Math.pow(p.drag, dt * 60); p.vx *= k; p.vy *= k; }
    parts[n++] = p;
  }
  parts.length = n;
  if (parts.length > 1600) parts.splice(0, parts.length - 1600);

  for (const p of parts) {
    if (p.kind !== K_SMOKE) continue;
    const q = p.life / p.max;
    ctx.globalAlpha = q * 0.55;
    blit(ctx, smokeSpr, p.x, p.y, p.size * (1 + (1 - q) * 1.6));
  }
  ctx.globalCompositeOperation = 'lighter';
  const fl = FLAME.map(glow);
  for (const p of parts) {
    const q = p.life / p.max;
    if (p.kind === K_FLAME) {
      const img = q > 0.72 ? fl[0] : q > 0.48 ? fl[1] : q > 0.25 ? fl[2] : fl[3];
      ctx.globalAlpha = q > 0.25 ? 0.85 : q * 3.4;
      blit(ctx, img, p.x, p.y, p.size * (0.45 + 0.55 * q));
    } else if (p.kind === K_GLOW) {
      ctx.globalAlpha = p.amb ? Math.min(1, q * 3) * 0.8 : q;
      blit(ctx, p.img, p.x, p.y, p.size * (0.4 + 0.6 * q));
    } else if (p.kind === K_SPARK) {
      ctx.globalAlpha = q; ctx.strokeStyle = p.col; ctx.lineWidth = p.size * (0.5 + 0.5 * q);
      ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(p.x - p.vx * 0.035, p.y - p.vy * 0.035); ctx.stroke();
    }
  }

  // rings and flashes
  let rn = 0;
  ctx.lineCap = 'round';
  for (const r of rings) {
    r.t += dt;
    if (r.t >= r.max) continue;
    rings[rn++] = r;
    const q = r.t / r.max, e = 1 - Math.pow(1 - q, 3), al = 1 - q;
    if (r.kind === 'shock') {
      const rr = r.r * (0.15 + 0.85 * e);
      ctx.globalAlpha = al * 0.25; blit(ctx, glow('#bfe9ff'), r.x, r.y, rr * 1.1);
      ctx.globalAlpha = al * 0.55; ctx.strokeStyle = '#8fd4ff'; ctx.lineWidth = 16 * al + 2;
      ctx.beginPath(); ctx.arc(r.x, r.y, rr, 0, TAU); ctx.stroke();
      ctx.globalAlpha = al * 0.9; ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(r.x, r.y, rr + 6, 0, TAU); ctx.stroke();
      // dark refraction band just inside the wave front
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = al * 0.3; ctx.strokeStyle = '#06101a'; ctx.lineWidth = 7;
      ctx.beginPath(); ctx.arc(r.x, r.y, Math.max(0, rr - 11), 0, TAU); ctx.stroke();
      ctx.globalCompositeOperation = 'lighter';
    } else if (r.kind === 'boom') {
      const fq = clamp01(1 - q * 3);
      if (fq > 0) { ctx.globalAlpha = fq; blit(ctx, glow('#fff2c0'), r.x, r.y, r.r * 1.5); }
      ctx.globalAlpha = al * 0.8; ctx.strokeStyle = '#ff8a2a'; ctx.lineWidth = 14 * al + 2;
      ctx.beginPath(); ctx.arc(r.x, r.y, r.r * (0.3 + 0.9 * e), 0, TAU); ctx.stroke();
    } else if (r.kind === 'flash') {
      ctx.globalAlpha = al; blit(ctx, glow(r.color), r.x, r.y, r.r * (0.6 + 0.6 * q));
    } else if (r.kind === 'streak') {
      ctx.globalAlpha = al * 0.7; ctx.strokeStyle = '#c99bff'; ctx.lineWidth = 10 * al + 1;
      ctx.beginPath(); ctx.moveTo(r.x, r.y); ctx.lineTo(r.x2, r.y2); ctx.stroke();
      ctx.globalAlpha = al; ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 2 * al + 0.5; ctx.stroke();
    } else {
      ctx.globalAlpha = al; ctx.strokeStyle = r.color; ctx.lineWidth = 5 * al + 1;
      ctx.beginPath(); ctx.arc(r.x, r.y, r.r * (0.3 + 0.7 * e), 0, TAU); ctx.stroke();
    }
  }
  rings.length = rn;
  ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';

  drawMeteors(ctx, now);

  // floating damage numbers
  if (nums.length) {
    ctx.font = '800 15px system-ui, -apple-system, "Segoe UI", sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.lineJoin = 'round'; ctx.lineWidth = 3.5;
    let nn = 0;
    for (const d of nums) {
      d.t += dt;
      if (d.t >= 0.9) continue;
      nums[nn++] = d;
      const q = d.t / 0.9, pop = 1 + 0.5 * clamp01(1 - d.t * 8);
      ctx.globalAlpha = 1 - q * q * q;
      ctx.save(); ctx.translate(d.x, d.y - 34 * (1 - (1 - q) * (1 - q))); ctx.scale(pop, pop);
      ctx.strokeStyle = 'rgba(20,6,2,0.85)'; ctx.strokeText(d.v, 0, 0);
      ctx.fillStyle = d.me ? '#ff6a5a' : '#ffe08a'; ctx.fillText(d.v, 0, 0);
      ctx.restore();
    }
    nums.length = nn;
    ctx.globalAlpha = 1;
  }
}
