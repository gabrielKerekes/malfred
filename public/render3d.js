// three.js renderer: the same 2D simulation drawn as a 3D scene under a tilted
// Warcraft III-style camera. World (x, y) is the ground plane (x, 0, y), 1 unit = 1
// simulation unit. The camera itself (look point, zoom, raycasting) lives in
// camera.js; this module mirrors it into a THREE.PerspectiveCamera each frame.
//
// Interface used by client.js:
//   init(canvas) -> Promise<boolean>   (false when WebGL is unavailable)
//   render(state, overlayCtx)          per frame; also draws names/bars/numbers on the 2D overlay
//   fxEvent(ev, env), resetFx(), setActive(on)
//
// Hot paths avoid allocation: particles live in fixed typed arrays, effect meshes
// are pooled, temporaries are module-level vectors.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { SPELLS, TICK, PLAYER_R, SKINS, PILLAR } from '/shared/game.js';
import { cam, camPose, toScreen, FOV } from './camera.js';

const TAU = Math.PI * 2;
const REDUCED_MOTION = matchMedia('(prefers-reduced-motion: reduce)').matches;
const LAVA_Y = -22;     // lava surface below the platform top
const WIZ_S = 40;       // model scale: the Mage's body is ~0.9 wide -> ~36 units (2 x PLAYER_R)
const CHEST = 46;       // projectile flight height
const HEAD = 112;       // name / health bar anchor above the feet
const WADE = 14;        // how deep wizards stand in lava
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const lerp = (x, y, f) => x + (y - x) * f;
const rand = (a, b) => a + Math.random() * (b - a);
const smooth = (e0, e1, x) => { const t = clamp01((x - e0) / (e1 - e0)); return t * t * (3 - 2 * t); };
const angDiff = (a, b) => Math.atan2(Math.sin(b - a), Math.cos(b - a));
function seeded(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let renderer = null, scene, camera, composer = null, bloom = null, renderPass;
let ready = false, active = false;
let W = 1, H = 1, pixelRatio = 1, maxPR = 1;
const U = { uTime: { value: 0 }, uR: { value: 500 } }; // uniforms shared by every patched material

// ---------------- GLSL helpers ----------------
const NOISE = /* glsl */`
float hash12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
vec2 hash22(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * vec3(.1031, .1030, .0973)); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.xx + p3.yz) * p3.zy); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p), u = f * f * (3. - 2. * f);
  return mix(mix(hash12(i), hash12(i + vec2(1, 0)), u.x), mix(hash12(i + vec2(0, 1)), hash12(i + vec2(1, 1)), u.x), u.y);
}
float fbm(vec2 p) { float s = 0., a = .5; for (int i = 0; i < 4; i++) { s += a * vnoise(p); p = p * 2.03 + vec2(1.7, 9.2); a *= .5; } return s; }
float fbm3(vec2 p) { float s = 0., a = .5; for (int i = 0; i < 3; i++) { s += a * vnoise(p); p = p * 2.03 + vec2(1.7, 9.2); a *= .5; } return s; }
// distance to the nearest Voronoi cell border (crust plate seams)
float vEdge(vec2 x, float t) {
  vec2 n = floor(x), f = fract(x); float d1 = 8., d2 = 8.;
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
    vec2 g = vec2(float(i), float(j)), o = hash22(n + g);
    o = .5 + .38 * sin(t + 6.2831 * o);
    vec2 r = g + o - f; float d = dot(r, r);
    if (d < d1) { d2 = d1; d1 = d; } else if (d < d2) d2 = d;
  }
  return sqrt(d2) - sqrt(d1);
}`;

// ---------------- textures (procedural canvases) ----------------
function canvas(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
function stoneCanvas() {
  const S = 512, c = canvas(S, S), g = c.getContext('2d'), R = seeded(3);
  g.fillStyle = '#2b231f'; g.fillRect(0, 0, S, S);
  const T = 128; // 4 x 4 flagstones per texture (texture spans 256 world units)
  for (let row = 0; row < S / T; row++) {
    const off = (row % 2) * (T / 2);
    for (let col = -1; col <= S / T; col++) {
      const k = 0.8 + R() * 0.35, warm = R() * 12;
      const x = col * T + off, y = row * T;
      for (const ox of [-S, 0, S]) {
        g.fillStyle = `rgb(${92 * k + warm},${83 * k + warm * 0.5},${76 * k})`; g.fillRect(x + ox + 3, y + 3, T - 6, T - 6);
        g.fillStyle = 'rgba(255,236,210,0.08)'; g.fillRect(x + ox + 3, y + 3, T - 6, 3);
        g.fillStyle = 'rgba(0,0,0,0.25)'; g.fillRect(x + ox + 3, y + T - 6, T - 6, 3);
      }
    }
  }
  for (let i = 0; i < 9000; i++) { g.fillStyle = R() < 0.5 ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.1)'; const s = 1 + R() * 2.2; g.fillRect(R() * S, R() * S, s, s); }
  const wrap = (fn) => { for (const ox of [-S, 0, S]) for (const oy of [-S, 0, S]) fn(ox, oy); };
  for (let i = 0; i < 14; i++) {
    const x = R() * S, y = R() * S, r = 30 + R() * 90;
    wrap((ox, oy) => {
      const gr = g.createRadialGradient(x + ox, y + oy, 0, x + ox, y + oy, r);
      gr.addColorStop(0, 'rgba(18,10,6,0.3)'); gr.addColorStop(1, 'rgba(18,10,6,0)');
      g.fillStyle = gr; g.fillRect(x + ox - r, y + oy - r, r * 2, r * 2);
    });
  }
  g.lineCap = g.lineJoin = 'round';
  for (let i = 0; i < 18; i++) {
    let x = R() * S, y = R() * S, a = R() * TAU;
    const pts = [[x, y]];
    for (let s = 0, n = 4 + Math.floor(R() * 5); s < n; s++) { a += (R() - 0.5) * 1.2; const l = 8 + R() * 18; x += Math.cos(a) * l; y += Math.sin(a) * l; pts.push([x, y]); }
    wrap((ox, oy) => {
      g.beginPath(); pts.forEach(([px, py], k) => (k ? g.lineTo(px + ox, py + oy) : g.moveTo(px + ox, py + oy)));
      g.strokeStyle = 'rgba(10,5,3,0.75)'; g.lineWidth = 2; g.stroke();
    });
  }
  return c;
}
// scorch decal: dark burn (rgb+alpha) and glowing fissures (separate canvas)
function scorchCanvases() {
  const S = 256, R = seeded(99), dark = canvas(S, S), hot = canvas(S, S), dg = dark.getContext('2d'), hg = hot.getContext('2d');
  let gr = dg.createRadialGradient(128, 128, 0, 128, 128, 128);
  gr.addColorStop(0, 'rgba(8,4,2,0.92)'); gr.addColorStop(0.45, 'rgba(20,10,6,0.7)'); gr.addColorStop(1, 'rgba(20,10,6,0)');
  dg.fillStyle = gr; dg.fillRect(0, 0, S, S);
  gr = hg.createRadialGradient(128, 128, 0, 128, 128, 64);
  gr.addColorStop(0, 'rgba(255,190,90,1)'); gr.addColorStop(1, 'rgba(255,90,20,0)');
  hg.fillStyle = gr; hg.fillRect(0, 0, S, S);
  hg.lineCap = dg.lineCap = 'round';
  for (let i = 0; i < 11; i++) {
    let a = (i / 11) * TAU + R() * 0.4, x = 128, y = 128;
    const pts = [[x, y]], len = 60 + R() * 55;
    for (let s = 0; s < len; s += 12) { a += (R() - 0.5) * 0.9; x += Math.cos(a) * 12; y += Math.sin(a) * 12; pts.push([x, y]); }
    for (const [g, col, w] of [[dg, 'rgba(5,2,1,0.85)', 4], [hg, 'rgba(255,140,40,1)', 2.4]]) {
      g.strokeStyle = col; g.lineWidth = w; g.beginPath();
      pts.forEach(([px, py], k) => (k ? g.lineTo(px, py) : g.moveTo(px, py)));
      g.stroke();
    }
  }
  return [dark, hot];
}
// engraved sigil in the arena centre (glow layer)
function sigilCanvas() {
  const S = 512, c = canvas(S, S), g = c.getContext('2d'), R = seeded(42);
  g.translate(S / 2, S / 2); g.scale(S / 320, S / 320);
  g.strokeStyle = '#fff'; g.lineWidth = 1.8; g.lineCap = 'round';
  g.beginPath(); g.arc(0, 0, 150, 0, TAU); g.moveTo(136, 0); g.arc(0, 0, 136, 0, TAU); g.moveTo(52, 0); g.arc(0, 0, 52, 0, TAU); g.stroke();
  g.beginPath();
  for (let i = 0; i <= 7; i++) { const a = ((i * 3) / 7) * TAU - Math.PI / 2; if (i) g.lineTo(Math.cos(a) * 136, Math.sin(a) * 136); else g.moveTo(Math.cos(a) * 136, Math.sin(a) * 136); }
  g.stroke();
  for (let i = 0; i < 18; i++) {
    g.save(); g.rotate((i / 18) * TAU); g.translate(0, -143); g.beginPath();
    for (let s = 0; s < 3; s++) { g.moveTo((R() - 0.5) * 8, (R() - 0.5) * 9); g.lineTo((R() - 0.5) * 8, (R() - 0.5) * 9); }
    g.stroke(); g.restore();
  }
  return c;
}
function canvasTex(c, srgb = true) {
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

// ---------------- material patching ----------------
// Adds world-position-based emissive light (lava glow) to a built-in material.
function patch(mat, key, glsl) {
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = U.uTime; sh.uniforms.uR = U.uR;
    sh.vertexShader = 'varying vec3 vWp;\n' + sh.vertexShader.replace('#include <project_vertex>',
      '#include <project_vertex>\nvWp = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    sh.fragmentShader = 'uniform float uTime; uniform float uR; varying vec3 vWp;\n' + sh.fragmentShader.replace(
      '#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n' + glsl);
  };
  mat.customProgramCacheKey = () => key;
  return mat;
}

// ---------------- particles ----------------
const P_VERT = /* glsl */`
attribute float aSize; attribute vec4 aCol; varying vec4 vCol; uniform float uScale;
void main() {
  vCol = aCol;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = min(aSize * uScale / max(1.0, -mv.z), 600.0);
}`;
const P_FRAG = /* glsl */`
varying vec4 vCol; uniform float uSoft;
void main() {
  float d = length(gl_PointCoord - 0.5) * 2.0;
  if (d > 1.0) discard;
  float a = 1.0 - d; a = mix(a * a, a, uSoft);
  float core = exp(-d * d * 7.0) * (1.0 - uSoft);
  gl_FragColor = vec4(vCol.rgb * (1.0 + core * 1.5), vCol.a * a);
}`;
const pScale = { value: 1 };
function pointsMaterial(blending, soft) {
  return new THREE.ShaderMaterial({
    uniforms: { uScale: pScale, uSoft: { value: soft } }, vertexShader: P_VERT, fragmentShader: P_FRAG,
    blending, transparent: true, depthWrite: false,
  });
}
const K_GLOW = 0, K_FLAME = 1, K_SPARK = 2, K_SMOKE = 3, K_EMBER = 4;
class Particles {
  constructor(cap, blending, soft) {
    this.cap = cap; this.n = 0;
    this.pos = new Float32Array(cap * 3); this.col = new Float32Array(cap * 4); this.size = new Float32Array(cap);
    this.vel = new Float32Array(cap * 3); this.life = new Float32Array(cap); this.max = new Float32Array(cap);
    this.kind = new Uint8Array(cap); this.s0 = new Float32Array(cap); this.c0 = new Float32Array(cap * 3);
    this.drag = new Float32Array(cap); this.grav = new Float32Array(cap);
    const geo = new THREE.BufferGeometry();
    this.aPos = new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage);
    this.aCol = new THREE.BufferAttribute(this.col, 4).setUsage(THREE.DynamicDrawUsage);
    this.aSize = new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', this.aPos); geo.setAttribute('aCol', this.aCol); geo.setAttribute('aSize', this.aSize);
    geo.setDrawRange(0, 0);
    this.points = new THREE.Points(geo, pointsMaterial(blending, soft));
    this.points.frustumCulled = false;
    this.ambient = 0;
  }
  spawn(x, y, z, vx, vy, vz, life, size, kind, r, g, b, drag = 0.93, grav = 0) {
    if (this.n >= this.cap) return;
    const i = this.n++, i3 = i * 3;
    this.pos[i3] = x; this.pos[i3 + 1] = y; this.pos[i3 + 2] = z;
    this.vel[i3] = vx; this.vel[i3 + 1] = vy; this.vel[i3 + 2] = vz;
    this.life[i] = this.max[i] = life; this.s0[i] = size; this.kind[i] = kind;
    this.c0[i3] = r; this.c0[i3 + 1] = g; this.c0[i3 + 2] = b; this.drag[i] = drag; this.grav[i] = grav;
    if (kind === K_EMBER) this.ambient++;
  }
  // random burst in all directions (horizontal plane plus a bit of lift)
  burst(x, y, z, n, speed, life, size, kind, r, g, b, drag = 0.92, lift = 0.4, grav = 0) {
    for (let k = 0; k < n; k++) {
      const a = Math.random() * TAU, v = speed * (0.3 + Math.random() * 0.7), l = life * (0.6 + Math.random() * 0.4);
      this.spawn(x, y, z, Math.cos(a) * v, (Math.random() - 0.3) * v * lift * 2, Math.sin(a) * v, l, size * (0.6 + Math.random() * 0.8), kind, r, g, b, drag, grav);
    }
  }
  update(dt) {
    const { pos, vel, col, size, life, max, kind, s0, c0, drag, grav } = this;
    let n = this.n, amb = 0;
    for (let i = 0; i < n; i++) {
      life[i] -= dt;
      if (life[i] <= 0) { this.move(--n, i); i--; continue; }
      const i3 = i * 3, i4 = i * 4, k = kind[i];
      if (k === K_FLAME) vel[i3 + 1] += 70 * dt; // flames rise
      vel[i3 + 1] -= grav[i] * dt;
      if (drag[i] !== 1) { const d = Math.pow(drag[i], dt * 60); vel[i3] *= d; vel[i3 + 1] *= d; vel[i3 + 2] *= d; }
      pos[i3] += vel[i3] * dt; pos[i3 + 1] += vel[i3 + 1] * dt; pos[i3 + 2] += vel[i3 + 2] * dt;
      const q = life[i] / max[i];
      if (k === K_FLAME) { // white-yellow -> orange -> deep red, HDR so the hot core blooms
        const h = q;
        col[i4] = 0.85 + 2.3 * h; col[i4 + 1] = 0.12 + 1.4 * h * h; col[i4 + 2] = 0.02 + 0.5 * h * h * h;
        col[i4 + 3] = q > 0.25 ? 0.9 : q * 3.6;
        size[i] = s0[i] * (0.45 + 0.55 * q);
      } else if (k === K_SMOKE) {
        col[i4] = c0[i3]; col[i4 + 1] = c0[i3 + 1]; col[i4 + 2] = c0[i3 + 2];
        col[i4 + 3] = Math.min(1, (1 - q) * 6) * q * 0.5;
        size[i] = s0[i] * (1 + (1 - q) * 1.8);
      } else if (k === K_EMBER) {
        amb++;
        col[i4] = c0[i3]; col[i4 + 1] = c0[i3 + 1]; col[i4 + 2] = c0[i3 + 2];
        col[i4 + 3] = Math.min(1, q * 3, (1 - q) * 4) * (0.6 + 0.4 * Math.sin(life[i] * 13 + i));
        size[i] = s0[i];
      } else {
        col[i4] = c0[i3]; col[i4 + 1] = c0[i3 + 1]; col[i4 + 2] = c0[i3 + 2];
        col[i4 + 3] = q;
        size[i] = k === K_SPARK ? s0[i] * (0.5 + 0.5 * q) : s0[i] * (0.4 + 0.6 * q);
      }
    }
    this.n = n; this.ambient = amb;
    this.commit();
  }
  // move particle `from` into slot `to` (swap-remove)
  move(from, to) {
    if (from === to) return;
    const f3 = from * 3, t3 = to * 3;
    for (let c = 0; c < 3; c++) {
      this.pos[t3 + c] = this.pos[f3 + c]; this.vel[t3 + c] = this.vel[f3 + c]; this.c0[t3 + c] = this.c0[f3 + c];
    }
    this.life[to] = this.life[from]; this.max[to] = this.max[from]; this.kind[to] = this.kind[from];
    this.s0[to] = this.s0[from]; this.drag[to] = this.drag[from]; this.grav[to] = this.grav[from];
  }
  commit() {
    const n = this.n;
    this.points.geometry.setDrawRange(0, n);
    if (!n) return;
    for (const a of [this.aPos, this.aCol, this.aSize]) { a.clearUpdateRanges(); a.addUpdateRange(0, n * a.itemSize); a.needsUpdate = true; }
  }
  clear() { this.n = 0; this.ambient = 0; this.commit(); }
}
// immediate-mode glow points, rebuilt every frame (projectile cores, staff tips, meteor glows)
class Glows extends Particles {
  begin() { this.n = 0; }
  add(x, y, z, size, r, g, b, a = 1) {
    if (this.n >= this.cap) return;
    const i = this.n++, i3 = i * 3, i4 = i * 4;
    this.pos[i3] = x; this.pos[i3 + 1] = y; this.pos[i3 + 2] = z;
    this.col[i4] = r; this.col[i4 + 1] = g; this.col[i4 + 2] = b; this.col[i4 + 3] = a; this.size[i] = size;
  }
}
let fx, smoke, glows; // additive particles, smoke (alpha blended), per-frame glows

// ---------------- ground decals (draped over the rim into the lava) ----------------
const DECAL_VERT = /* glsl */`
uniform float uR; uniform float uDrape; varying vec2 vUv; varying vec3 vWp;
void main() {
  vUv = uv * 2.0 - 1.0;
  vec4 wp = modelMatrix * vec4(position, 1.0);
  float d = length(wp.xz);
  wp.y = mix(wp.y, ${LAVA_Y.toFixed(1)} + 0.8, uDrape * smoothstep(uR - 1.0, uR + 8.0, d));
  vWp = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;
const RING_FRAG = /* glsl */`
uniform vec3 uCol; uniform float uA; uniform float uW; varying vec2 vUv;
void main() {
  float r = length(vUv);
  float band = smoothstep(1.0 - uW, 1.0 - uW * 0.4, r) * (1.0 - smoothstep(0.985, 1.0, r));
  float a = band * uA;
  if (a < 0.003) discard;
  gl_FragColor = vec4(uCol, a);
}`;
const decalGeo = new THREE.PlaneGeometry(2, 2, 24, 24).rotateX(-Math.PI / 2);
function decalMat(frag, uniforms, blending = THREE.AdditiveBlending) {
  return new THREE.ShaderMaterial({
    uniforms: { uR: U.uR, uTime: U.uTime, uDrape: { value: 1 }, ...uniforms },
    vertexShader: DECAL_VERT, fragmentShader: frag, transparent: true, depthWrite: false, blending,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
  });
}
// pooled flat rings: shock fronts, level-ups, reflect pings, move marker...
const rings = []; // {mesh, mat, t, max, x, y, r0, r1, col, w, active}
function ring(x, y, r0, r1, max, r, g, b, w = 0.18, h = 0.5, blend = THREE.AdditiveBlending) {
  let o = rings.find((q) => !q.active && q.mat.blending === blend);
  if (!o) {
    if (rings.length > 40) return null;
    const mat = decalMat(RING_FRAG, { uCol: { value: new THREE.Color() }, uA: { value: 1 }, uW: { value: 0.2 } }, blend);
    o = { mesh: new THREE.Mesh(decalGeo, mat), mat, active: false };
    o.mesh.renderOrder = 2; scene.add(o.mesh); rings.push(o);
  }
  Object.assign(o, { active: true, t: 0, max, x, y, r0, r1, w, h });
  o.mat.uniforms.uCol.value.setRGB(r, g, b);
  o.mesh.visible = true;
  return o;
}
function updateRings(dt) {
  for (const o of rings) {
    if (!o.active) continue;
    o.t += dt;
    if (o.t >= o.max) { o.active = false; o.mesh.visible = false; continue; }
    const q = o.t / o.max, e = 1 - Math.pow(1 - q, 3);
    const r = lerp(o.r0, o.r1, e);
    o.mesh.position.set(o.x, o.h, o.y); o.mesh.scale.set(r, 1, r);
    o.mat.uniforms.uA.value = 1 - q; o.mat.uniforms.uW.value = o.w * (1 - 0.5 * q);
  }
}

// ---------------- scene construction ----------------
let lava, lavaMat, topGeo, cliffGeo, topMesh, cliffMesh, rubble, sigil, sigilMat, keyLight, hemi;
const RIM_N = 192;
const TOP_FR = [0.22, 0.45, 0.65, 0.8, 0.9, 0.96];             // inner rings as a fraction of R
const CLIFF_Y = [-4, -11, -20, -32, -60, -130];                    // cliff rows (top row = bevel)
const CLIFF_OUT = [2.5, 4.5, 3.5, 1, -4, -14];                      // bulge per row
const rimJag = new Float32Array(RIM_N), cliffJit = new Float32Array(RIM_N * CLIFF_Y.length);
let platR = -1;

function buildPlatform() {
  const R = seeded(21);
  for (let i = 0; i < RIM_N; i++) {
    const a = (i / RIM_N) * TAU;
    rimJag[i] = 2.8 * Math.sin(7 * a + 1.3) + 2.2 * Math.sin(17 * a + 0.4) + 1.6 * Math.sin(31 * a + 2.2) + (R() - 0.5) * 3.5;
  }
  for (let k = 0; k < CLIFF_Y.length; k++) for (let i = 0; i < RIM_N; i++) cliffJit[k * RIM_N + i] = k ? (R() - 0.5) * (4 + k * 2) : 0;
  // top: centre + rings + rim + bevel
  const rings = TOP_FR.length + 2;
  const nTop = 1 + rings * RIM_N;
  topGeo = new THREE.BufferGeometry();
  topGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(nTop * 3), 3));
  topGeo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(nTop * 2), 2));
  const idx = [];
  for (let i = 0; i < RIM_N; i++) idx.push(0, 1 + (i + 1) % RIM_N, 1 + i);
  for (let r = 0; r < rings - 1; r++) for (let i = 0; i < RIM_N; i++) {
    const a = 1 + r * RIM_N + i, b = 1 + r * RIM_N + (i + 1) % RIM_N, c = a + RIM_N, d = b + RIM_N;
    idx.push(a, b, c, b, d, c);
  }
  topGeo.setIndex(idx);
  // cliff: rows of RIM_N + 1 (seam vertex for the wrapped u coordinate)
  const C = RIM_N + 1, nC = C * CLIFF_Y.length;
  cliffGeo = new THREE.BufferGeometry();
  cliffGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(nC * 3), 3));
  cliffGeo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(nC * 2), 2));
  const ci = [];
  for (let k = 0; k < CLIFF_Y.length - 1; k++) for (let i = 0; i < RIM_N; i++) {
    const a = k * C + i, b = a + 1, c = a + C, d = b + C;
    ci.push(a, b, c, b, d, c);
  }
  cliffGeo.setIndex(ci);
}

function updatePlatform(R) {
  if (Math.abs(R - platR) < 0.05) return;
  platR = R;
  const tp = topGeo.attributes.position.array, tu = topGeo.attributes.uv.array;
  tp[0] = tp[1] = tp[2] = 0; tu[0] = tu[1] = 0;
  const rings = TOP_FR.length + 2;
  for (let r = 0; r < rings; r++) for (let i = 0; i < RIM_N; i++) {
    const a = (i / RIM_N) * TAU, c = Math.cos(a), s = Math.sin(a);
    let rr, y = 0;
    if (r < TOP_FR.length) rr = TOP_FR[r] * R + rimJag[i] * Math.pow(TOP_FR[r], 6);
    else if (r === TOP_FR.length) rr = R + rimJag[i];
    else { rr = R + rimJag[i] + 2.5; y = -4; }
    const v = 1 + r * RIM_N + i;
    tp[v * 3] = c * rr; tp[v * 3 + 1] = y; tp[v * 3 + 2] = s * rr;
    tu[v * 2] = c * rr / 256; tu[v * 2 + 1] = s * rr / 256;
  }
  const cp = cliffGeo.attributes.position.array, cu = cliffGeo.attributes.uv.array, C = RIM_N + 1;
  for (let k = 0; k < CLIFF_Y.length; k++) for (let i = 0; i <= RIM_N; i++) {
    const j = i % RIM_N, a = (i / RIM_N) * TAU;
    const rr = R + rimJag[j] + CLIFF_OUT[k] + cliffJit[k * RIM_N + j];
    const v = k * C + i;
    cp[v * 3] = Math.cos(a) * rr; cp[v * 3 + 1] = CLIFF_Y[k]; cp[v * 3 + 2] = Math.sin(a) * rr;
    cu[v * 2] = (i / RIM_N) * TAU * R / 256; cu[v * 2 + 1] = CLIFF_Y[k] / 256;
  }
  for (const g of [topGeo, cliffGeo]) {
    g.attributes.position.needsUpdate = true; g.attributes.uv.needsUpdate = true;
    g.computeVertexNormals(); g.computeBoundingSphere();
  }
  // rubble crumbling off the rim (on the ledge, or half sunk in the lava)
  for (let i = 0; i < rubbleData.length; i++) {
    const d = rubbleData[i], rr = R + d.off;
    const y = d.off < 4 ? -1 : LAVA_Y - d.s * 0.3;
    tmpM.compose(tv1.set(Math.cos(d.a) * rr, y, Math.sin(d.a) * rr), tq.setFromEuler(te.set(d.rx, d.ry, d.rz)), tv2.setScalar(d.s));
    rubble.setMatrixAt(i, tmpM);
  }
  rubble.instanceMatrix.needsUpdate = true;
  sigil.visible = R > 200;
}
const rubbleData = [];
const tmpM = new THREE.Matrix4(), tv1 = new THREE.Vector3(), tv2 = new THREE.Vector3(), tv3 = new THREE.Vector3(), tq = new THREE.Quaternion(), te = new THREE.Euler();

function rockGeometry(seed, detail = 0) {
  const g = new THREE.IcosahedronGeometry(1, detail), p = g.attributes.position, R = seeded(seed);
  const cache = new Map(); // keep shared corners together so the rock stays closed
  for (let i = 0; i < p.count; i++) {
    const key = `${p.getX(i).toFixed(3)},${p.getY(i).toFixed(3)},${p.getZ(i).toFixed(3)}`;
    let k = cache.get(key);
    if (k === undefined) { k = 0.72 + R() * 0.5; cache.set(key, k); }
    p.setXYZ(i, p.getX(i) * k, p.getY(i) * k * 0.8, p.getZ(i) * k);
  }
  g.computeVertexNormals();
  return g;
}

function buildScene() {
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0a0302);
  camera = new THREE.PerspectiveCamera(FOV, 1, 10, 20000);

  hemi = new THREE.HemisphereLight(0x6a5878, 0xff5a1a, 1.1);
  scene.add(hemi);
  keyLight = new THREE.DirectionalLight(0xffd2a8, 2.4);
  keyLight.castShadow = true;
  keyLight.shadow.mapSize.set(2048, 2048);
  keyLight.shadow.bias = -0.0004; keyLight.shadow.normalBias = 1.5;
  scene.add(keyLight, keyLight.target);

  // lava: one big plane that follows the camera; the shader works in world space
  lavaMat = new THREE.ShaderMaterial({
    uniforms: { uTime: U.uTime, uR: U.uR },
    vertexShader: `varying vec3 vW; void main() { vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
    fragmentShader: `uniform float uTime; uniform float uR; varying vec3 vW;
${NOISE}
void main() {
  float t = uTime;
  vec2 p = vW.xz * 0.0032;
  p += 0.004 * vec2(sin(t * 2.1 + vW.z * 0.05), cos(t * 1.7 + vW.x * 0.05)); // heat shimmer
  vec2 q = vec2(fbm3(p + vec2(0.0, t * 0.035)), fbm3(p + vec2(5.2, 1.3) - t * 0.028));
  vec2 w = p * 1.6 + q * 1.5;
  float n = fbm(w + t * 0.02);
  float e = vEdge(w * 2.4, t * 0.25);
  float hot = smoothstep(0.38, 0.8, n);
  vec3 molten = mix(vec3(0.55, 0.07, 0.01), vec3(2.1, 0.62, 0.1), hot * hot);
  float crust = smoothstep(0.02, 0.12, e) * (1.0 - smoothstep(0.6, 0.78, n + 0.08 * sin(t * 0.7 + w.x * 3.0)));
  vec3 crustCol = vec3(0.07, 0.022, 0.012) * (0.55 + 0.9 * fbm3(w * 6.0));
  vec3 col = mix(molten, crustCol, crust * 0.94);
  col *= 0.88 + 0.12 * sin(t * 1.4 + n * 9.0);
  float d = length(vW.xz);
  float rim = exp(-max(d - uR, 0.0) / 70.0);
  col += vec3(1.6, 0.4, 0.05) * rim * 0.45 * (0.8 + 0.2 * sin(t * 3.0 + d * 0.05));
  col *= mix(1.0, 0.45, smoothstep(uR + 200.0, uR + 1300.0, d));
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`,
  });
  lava = new THREE.Mesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), lavaMat);
  lava.position.y = LAVA_Y; lava.frustumCulled = false;
  scene.add(lava);

  // platform
  buildPlatform();
  const stone = canvasTex(stoneCanvas());
  stone.wrapS = stone.wrapT = THREE.RepeatWrapping;
  const bump = canvasTex(stone.image, false);
  bump.wrapS = bump.wrapT = THREE.RepeatWrapping;
  const topMat = patch(new THREE.MeshStandardMaterial({ map: stone, bumpMap: bump, bumpScale: 3, roughness: 0.9, metalness: 0 }), 'top', `
    float rd = length(vWp.xz);
    float heat = smoothstep(uR - 60.0, uR + 2.0, rd);
    totalEmissiveRadiance += vec3(1.0, 0.28, 0.04) * heat * heat * (0.32 + 0.06 * sin(uTime * 3.0 + rd * 0.1)) * (0.3 + diffuseColor.rgb);`);
  topMesh = new THREE.Mesh(topGeo, topMat);
  topMesh.receiveShadow = true;
  const cliffMat = patch(new THREE.MeshStandardMaterial({ map: stone, bumpMap: bump, bumpScale: 4, color: 0x8a7468, roughness: 1, metalness: 0 }), 'cliff', `
    float glow = smoothstep(-2.0, ${(LAVA_Y - 2).toFixed(1)}, vWp.y);
    totalEmissiveRadiance += vec3(2.4, 0.55, 0.08) * glow * glow * (0.75 + 0.25 * sin(uTime * 2.3 + vWp.x * 0.03 + vWp.z * 0.02));`);
  cliffMesh = new THREE.Mesh(cliffGeo, cliffMat);
  scene.add(topMesh, cliffMesh);

  // rubble along the rim
  const rr = seeded(5);
  for (let i = 0; i < 110; i++) rubbleData.push({ a: rr() * TAU, off: -6 + rr() * 34, s: 2 + rr() * 5.5, rx: rr() * 6, ry: rr() * 6, rz: rr() * 6 });
  rubble = new THREE.InstancedMesh(rockGeometry(11), patch(new THREE.MeshStandardMaterial({ color: 0x4a3a32, roughness: 1, flatShading: true }), 'rubble', `
    totalEmissiveRadiance += vec3(2.0, 0.45, 0.06) * smoothstep(-4.0, ${(LAVA_Y + 2).toFixed(1)}, vWp.y);`), rubbleData.length);
  scene.add(rubble);
  buildObstacles(stone, bump);

  // glowing sigil engraved into the centre
  sigilMat = new THREE.MeshBasicMaterial({ map: canvasTex(sigilCanvas()), color: new THREE.Color(1.6, 0.45, 0.1), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
  sigil = new THREE.Mesh(new THREE.PlaneGeometry(320, 320).rotateX(-Math.PI / 2), sigilMat);
  sigil.position.y = 0.3;
  scene.add(sigil);

  fx = new Particles(5000, THREE.AdditiveBlending, 0);
  smoke = new Particles(1200, THREE.NormalBlending, 1);
  glows = new Glows(800, THREE.AdditiveBlending, 0);
  fx.points.renderOrder = 5; smoke.points.renderOrder = 4; glows.points.renderOrder = 6;
  scene.add(smoke.points, fx.points, glows.points);

  buildEffects();
}

// ---------------- effect pools ----------------
let lights = [], scorches = [], zonePool = [], fireballs = [], shockWalls = [], debris, wardMat, wardGeo, meMarker, moveRing;
const debrisData = [];
const SCORCH_FRAG = /* glsl */`
uniform sampler2D uDark; uniform sampler2D uHot; uniform float uA; uniform float uG; uniform float uR; varying vec2 vUv; varying vec3 vWp;
void main() {
  if (length(vWp.xz) > uR + 2.0) discard;
  vec2 uv = vUv * 0.5 + 0.5;
  vec4 d = texture2D(uDark, uv); vec4 h = texture2D(uHot, uv);
  float a = d.a * uA;
  vec3 col = d.rgb * (1.0 - h.a * uG) + h.rgb * h.a * uG * 3.0;
  gl_FragColor = vec4(col, max(a, h.a * uG));
  #include <colorspace_fragment>
}`;
const ZONE_FRAG = /* glsl */`
uniform float uP; uniform float uTime; varying vec2 vUv;
void main() {
  float r = length(vUv);
  if (r > 1.0) discard;
  float a = atan(vUv.y, vUv.x);
  float dash = step(0.45, fract(a * 16.0 / 6.2831 + uTime * 0.6));
  float rim = smoothstep(0.92, 0.955, r) * (1.0 - smoothstep(0.985, 1.0, r)) * (0.35 + 0.65 * dash);
  float fill = 0.10 + 0.22 * uP;
  float grow = step(r, uP) * 0.18;
  float ticks = 0.0;
  for (int k = 0; k < 4; k++) {
    float an = float(k) * 1.5708 + uTime * 0.7;
    vec2 dir = vec2(cos(an), sin(an));
    float along = dot(vUv, dir), across = abs(dot(vUv, vec2(-dir.y, dir.x)));
    ticks += step(0.62, along) * step(along, 0.82) * (1.0 - smoothstep(0.012, 0.025, across));
  }
  float shadow = smoothstep(0.12 + 0.45 * uP, 0.0, r) * (0.35 + 0.6 * uP);
  vec3 glow = vec3(1.9, 0.48, 0.08);
  float g = fill + grow + rim * (0.6 + 0.6 * uP) * 2.0 + ticks * 0.8;
  gl_FragColor = vec4(glow * g * (1.0 - shadow), max(clamp(g, 0.0, 1.0), shadow));
}`;
const FIREBALL_FRAG = /* glsl */`
uniform float uQ; uniform float uTime; varying vec3 vN; varying vec3 vP;
${NOISE}
void main() {
  float n = fbm(vP.xy * 2.2 + vP.z * 1.3 + uTime * 2.0);
  float fres = pow(1.0 - abs(vN.z), 1.5);
  float heat = (1.0 - uQ) * (0.4 + 0.9 * n) * (1.0 - fres * 0.8);
  vec3 col = mix(vec3(0.5, 0.05, 0.005), vec3(2.6, 0.9, 0.18), clamp(heat * 1.2, 0.0, 1.0));
  col += vec3(1.2, 0.8, 0.4) * smoothstep(0.75, 1.0, heat);
  float a = (1.0 - uQ) * (1.0 - uQ) * clamp(n * 1.4 - 0.15 - fres * 0.9, 0.0, 1.0) * 0.7;
  gl_FragColor = vec4(col, a);
}`;
const FB_VERT = /* glsl */`varying vec3 vN; varying vec3 vP; void main() { vN = normalize(normalMatrix * normal); vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const WALL_FRAG = /* glsl */`
uniform float uA; uniform vec3 uCol; varying vec2 vUv2;
void main() {
  float a = uA * (1.0 - vUv2.y) * (1.0 - vUv2.y) * (0.6 + 0.4 * sin(vUv2.x * 120.0));
  gl_FragColor = vec4(uCol, a);
}`;
const WARD_FRAG = /* glsl */`
uniform float uTime; varying vec3 vN; varying vec3 vP;
void main() {
  float fres = pow(1.0 - abs(vN.z), 2.2);
  float bands = 0.5 + 0.5 * sin(vP.y * 9.0 - uTime * 5.0 + sin(atan(vP.z, vP.x) * 3.0 + uTime * 2.0) * 1.5);
  vec3 col = vec3(0.45, 1.3, 2.2) * (0.12 + fres * 1.6 + bands * 0.12);
  gl_FragColor = vec4(col, 0.25 + fres * 0.75);
}`;

function buildEffects() {
  // point light pool: projectiles and explosions borrow these
  for (let i = 0; i < 4; i++) {
    const l = new THREE.PointLight(0xff8a2a, 0, 420, 2);
    scene.add(l); lights.push(l);
  }
  // scorch decals
  const [dark, hot] = scorchCanvases().map((c) => canvasTex(c));
  for (let i = 0; i < 14; i++) {
    const mat = decalMat(SCORCH_FRAG, { uDark: { value: dark }, uHot: { value: hot }, uA: { value: 0 }, uG: { value: 0 } }, THREE.NormalBlending);
    mat.uniforms.uDrape.value = 0;
    const mesh = new THREE.Mesh(decalGeo, mat);
    mesh.visible = false; mesh.renderOrder = 1; scene.add(mesh);
    scorches.push({ mesh, mat, t: 0, max: 7, on: false });
  }
  // meteor telegraphs + falling rocks
  const rockG = rockGeometry(7, 1);
  const rockMat = new THREE.MeshStandardMaterial({ color: 0x2a1a14, roughness: 0.9, flatShading: true, emissive: new THREE.Color(1.4, 0.35, 0.05), emissiveIntensity: 1 });
  for (let i = 0; i < 10; i++) {
    const mat = decalMat(ZONE_FRAG, { uP: { value: 0 } }, THREE.NormalBlending);
    const decal = new THREE.Mesh(decalGeo, mat); decal.renderOrder = 2;
    const rock = new THREE.Mesh(rockG, rockMat);
    decal.visible = rock.visible = false;
    scene.add(decal, rock);
    zonePool.push({ id: -1, decal, mat, rock, seen: 0 });
  }
  // meteor fireballs
  const sph = new THREE.IcosahedronGeometry(1, 3);
  for (let i = 0; i < 6; i++) {
    const mat = new THREE.ShaderMaterial({ uniforms: { uQ: { value: 0 }, uTime: U.uTime }, vertexShader: FB_VERT, fragmentShader: FIREBALL_FRAG, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    const mesh = new THREE.Mesh(sph, mat); mesh.visible = false; scene.add(mesh);
    fireballs.push({ mesh, mat, t: 0, max: 0.5, r: 100, on: false });
  }
  // shockwave walls
  const cyl = new THREE.CylinderGeometry(1, 1, 1, 48, 1, true).translate(0, 0.5, 0);
  const wallVert = `varying vec2 vUv2; void main() { vUv2 = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
  for (let i = 0; i < 6; i++) {
    const mat = new THREE.ShaderMaterial({ uniforms: { uA: { value: 0 }, uCol: { value: new THREE.Color(0.6, 1.4, 2.4) } }, vertexShader: wallVert, fragmentShader: WALL_FRAG, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
    const mesh = new THREE.Mesh(cyl, mat); mesh.visible = false; scene.add(mesh);
    shockWalls.push({ mesh, mat, t: 0, max: 0.45, r: 100, on: false });
  }
  // debris chunks (instanced, simple physics)
  debris = new THREE.InstancedMesh(rockGeometry(3), new THREE.MeshStandardMaterial({ color: 0x3a2a22, roughness: 1, flatShading: true, emissive: new THREE.Color(0.9, 0.2, 0.03) }), 120);
  debris.count = 0; debris.frustumCulled = false;
  scene.add(debris);
  // ward bubble
  wardGeo = new THREE.IcosahedronGeometry(1, 3);
  wardMat = new THREE.ShaderMaterial({ uniforms: { uTime: U.uTime }, vertexShader: FB_VERT, fragmentShader: WARD_FRAG, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
  // my wizard's ground ring and the right-click move marker
  const mk = (r, g, b, w) => {
    const mat = decalMat(RING_FRAG, { uCol: { value: new THREE.Color(r, g, b) }, uA: { value: 1 }, uW: { value: w } });
    const m = new THREE.Mesh(decalGeo, mat); m.renderOrder = 2; m.visible = false; scene.add(m);
    return m;
  };
  meMarker = mk(1, 1, 1, 0.14);
  moveRing = mk(0.5, 2.2, 0.6, 0.3);
}

function lightFlash(x, y, z, r, g, b, power, max) {
  flashes.push({ x, y, z, r, g, b, power, t: 0, max });
  if (flashes.length > 8) flashes.shift();
}
const flashes = [];

function addScorch(x, y, r) {
  let s = scorches.find((q) => !q.on) || scorches.reduce((a, q) => (q.t > a.t ? q : a));
  s.on = true; s.t = 0;
  s.mesh.visible = true; s.mesh.position.set(x, 0.4, y); s.mesh.scale.set(r * 1.25, 1, r * 1.25);
  s.mesh.rotation.y = Math.random() * TAU;
}
function addFireball(x, y, r) {
  const f = fireballs.find((q) => !q.on) || fireballs[0];
  f.on = true; f.t = 0; f.r = r; f.mesh.visible = true; f.mesh.position.set(x, 10, y);
}
function addShockWall(x, y, r, col) {
  const s = shockWalls.find((q) => !q.on) || shockWalls[0];
  s.on = true; s.t = 0; s.r = r; s.mesh.visible = true; s.mesh.position.set(x, 0, y);
  s.mat.uniforms.uCol.value.setRGB(col[0], col[1], col[2]);
}
function addDebris(x, y, n, speed) {
  for (let i = 0; i < n; i++) {
    if (debrisData.length >= 120) debrisData.shift();
    const a = Math.random() * TAU, v = speed * rand(0.35, 1);
    debrisData.push({ x: x + Math.cos(a) * 10, y: 8, z: y + Math.sin(a) * 10, vx: Math.cos(a) * v, vy: rand(250, 520), vz: Math.sin(a) * v,
      rx: Math.random() * 6, ry: Math.random() * 6, wx: rand(-9, 9), wy: rand(-9, 9), s: rand(3, 7.5), life: rand(1.6, 2.6), glow: 1 });
  }
}

// ---------------- wizards ----------------
let gltf = null, atlas = null, baseMat = null;
const CL = {};             // clips by role
const texCache = new Map(); // colour -> tinted atlas texture
const wiz = new Map();      // player id -> wizard state
const UPPER = /^(spine|chest|head|upperarm|lowerarm|wrist|hand|handslot|elbow)/;
function split(clip, upper, name) {
  const tracks = clip.tracks.filter((t) => UPPER.test(t.name.split('.')[0]) === upper);
  return new THREE.AnimationClip(name, clip.duration, tracks);
}

// Skins (shared/game.js): the robe keeps the player's colour; trim, staff crystal and headwear change.
const SKIN = new Map(SKINS.map((s) => [s.id, s]));
const skinOf = (id) => SKIN.get(id) || SKIN.get('classic') || SKINS[0];
// Atlas swatches (8 x 4 grid of 32 x 64 vertical gradients, v = 0 at the top). Mage parts by swatch:
// robe/sleeves 0,1; hat (and a strip at the back of the head) 1,1; cape 2,1; under-robe/trousers 7,1;
// silver front panel, hem, cuffs, hat buckle 3,0 / 4,0; belt and hat band 5,0; staff crystal 6,2.
// 6,1 and 7,0 are unused by the Mage: they carry the colours of the procedural headwear.
const SW_ROBE = [1, 1], SW_DARK = [7, 1], SW_TRIM = [3, 0], SW_ACC = [6, 1], SW_ACC2 = [7, 0];
// per hat: [ACC top -> bottom colours], [ACC2 top -> bottom]
const ACC_COLS = {
  horns: [['#ffc070', '#c8421a', '#3a1a12', '#140c0a'], ['#ff8a3a', '#5a1408']],
  crown: [['#fff4c0', '#d9a830'], ['#ff6a7a', '#7a0618']],
  antlers: [['#f4ead0', '#c9b08a', '#6b4a2a', '#3a2614'], ['#b8ff8a', '#2f6a28']],
  hood: [['#888', '#222'], ['#888', '#222']],
  pointed: [['#888', '#222'], ['#888', '#222']],
};

// Recolour the KayKit gradient atlas: robe/hat/cape in the player's colour, trim and crystal per skin.
function tintTex(hex, skin) {
  const key = hex + '|' + skin.id;
  let t = texCache.get(key);
  if (t) return t;
  const S = 256, c = canvas(S, S), g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(atlas.image, 0, 0, S, S);
  const img = g.getImageData(0, 0, S, S), d = img.data;
  const rgb = (h) => { const sr = new THREE.Color(h).convertLinearToSRGB(); return [sr.r * 255, sr.g * 255, sr.b * 255]; };
  const base = rgb(hex), trim = rgb(skin.trim), orb = rgb(skin.orb);
  // [col, row, colour, brightness, lift]: lift adds a little grey sheen so near-black trims keep their shape
  const regions = [[0, 1, base, 1.0, 0], [1, 1, base, 1.0, 0], [2, 1, base, 0.62, 0], [7, 1, base, 0.42, 0],
    [3, 0, trim, 1.0, 34], [4, 0, trim, 0.9, 30], [5, 0, trim, 0.85, 26], [6, 2, orb, 1.1, 70]];
  for (const [cx, cy, cl, k, lift] of regions) {
    const x0 = cx * 32, y0 = cy * 64;
    let top = 1;
    for (let y = y0; y < y0 + 64; y++) for (let x = x0; x < x0 + 32; x++) {
      const i = (y * S + x) * 4; top = Math.max(top, 0.3 * d[i] + 0.59 * d[i + 1] + 0.11 * d[i + 2]);
    }
    for (let y = y0; y < y0 + 64; y++) for (let x = x0; x < x0 + 32; x++) {
      const i = (y * S + x) * 4, l = Math.pow((0.3 * d[i] + 0.59 * d[i + 1] + 0.11 * d[i + 2]) / top, 0.8) * k;
      const sh = lift * l * l * l;
      d[i] = Math.min(255, cl[0] * l + sh); d[i + 1] = Math.min(255, cl[1] * l + sh); d[i + 2] = Math.min(255, cl[2] * l + sh);
    }
  }
  g.putImageData(img, 0, 0);
  // headwear swatches: plain vertical gradients
  const [accA, accB] = ACC_COLS[skin.hat] || ACC_COLS.pointed;
  for (const [[cx, cy], stops] of [[SW_ACC, accA], [SW_ACC2, accB]]) {
    const gr = g.createLinearGradient(0, cy * 64, 0, cy * 64 + 64);
    stops.forEach((s, i) => gr.addColorStop(i / (stops.length - 1), s));
    g.fillStyle = gr; g.fillRect(cx * 32, cy * 64, 32, 64);
  }
  t = new THREE.CanvasTexture(c);
  t.flipY = atlas.flipY; t.colorSpace = THREE.SRGBColorSpace;
  t.magFilter = THREE.LinearFilter; t.minFilter = THREE.LinearMipmapLinearFilter;
  texCache.set(key, t);
  return t;
}

// ---------------- procedural headwear (head-bone space, model units; +z = face, hair top ~0.96) ----------------
// Each piece maps its UVs into an atlas swatch so it shares the wizard's material (hit flash, lava burn, ashes).
function swatchUV(geo, sw, tOf) {
  const p = geo.attributes.position, n = p.count, uv = new Float32Array(n * 2);
  const u = (sw[0] * 32 + 12) / 256;
  for (let i = 0; i < n; i++) { uv[i * 2] = u; uv[i * 2 + 1] = (sw[1] * 64 + 3 + clamp01(tOf(i, p)) * 58) / 256; }
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return geo;
}
// tapered tube along a curve; radius(t) with t = 0 at the start, 1 at the end
function taperTube(pts, segs, radial, radius) {
  const curve = new THREE.CatmullRomCurve3(pts), fr = curve.computeFrenetFrames(segs, false);
  const pos = [], nor = [], tt = [], idx = [], P = new THREE.Vector3(), N = new THREE.Vector3();
  for (let i = 0; i <= segs; i++) {
    const t = i / segs, r = radius(t);
    curve.getPointAt(t, P);
    for (let j = 0; j <= radial; j++) {
      const a = (j / radial) * TAU, c = Math.cos(a), s = -Math.sin(a);
      N.set(0, 0, 0).addScaledVector(fr.normals[i], c).addScaledVector(fr.binormals[i], s).normalize();
      pos.push(P.x + N.x * r, P.y + N.y * r, P.z + N.z * r); nor.push(N.x, N.y, N.z); tt.push(t);
    }
  }
  for (let i = 0; i < segs; i++) for (let j = 0; j < radial; j++) {
    const a = i * (radial + 1) + j, b = a + radial + 1;
    idx.push(a, b, a + 1, b, b + 1, a + 1);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setIndex(idx);
  g.userData.t = tt;
  return g;
}
const mergeAll = (list) => mergeGeometries(list.map((g) => (g.index ? g.toNonIndexed() : g)));
const hatGeoCache = new Map();
function hatGeometry(hat) {
  if (hatGeoCache.has(hat)) return hatGeoCache.get(hat);
  const V = (x, y, z) => new THREE.Vector3(x, y, z);
  const parts = [], tips = [];
  const tubeUV = (g, sw, flip) => swatchUV(g, sw, (i) => (flip ? 1 - g.userData.t[i] : g.userData.t[i]));
  if (hat === 'horns') {
    for (const sx of [1, -1]) {
      const pts = [V(0.3, 0.74, 0.04), V(0.56, 0.86, 0.02), V(0.8, 1.0, -0.06), V(0.92, 1.26, 0.0), V(0.84, 1.5, 0.14), V(0.7, 1.62, 0.24)]
        .map((p) => p.setX(p.x * sx));
      parts.push(tubeUV(taperTube(pts, 18, 9, (t) => 0.15 * (1 - t * 0.93) * (1 + 0.07 * Math.sin(t * 40))), SW_ACC, true));
      tips.push(pts[pts.length - 1].clone());
    }
    // a dark iron circlet under the horns
    const ring = new THREE.TorusGeometry(0.5, 0.045, 6, 28).rotateX(Math.PI / 2).rotateX(-0.22).translate(0, 0.64, 0.02);
    parts.push(swatchUV(ring, SW_TRIM, () => 0.45));
  } else if (hat === 'hood') {
    // ellipsoidal cowl with the pole at the back-top (pulled into a drooping tip), open around the face
    const f = V(0, -0.5, 1).normalize(), back = f.clone().negate(), OPEN = 1.2;
    const e1 = V(1, 0, 0), e2 = new THREE.Vector3().crossVectors(back, e1).normalize();
    const SC = V(0.6, 0.6, 0.68), C = V(0, 0.44, -0.08);
    const shell = (k, inner) => {
      const NP = 14, NT = 32, pos = [], idx = [], ts = [], dir = new THREE.Vector3();
      for (let i = 0; i <= NP; i++) {
        const ph = (i / NP) * (Math.PI - OPEN);
        for (let j = 0; j <= NT; j++) {
          const th = (j / NT) * TAU;
          dir.copy(back).multiplyScalar(Math.cos(ph)).addScaledVector(e1, Math.sin(ph) * Math.cos(th)).addScaledVector(e2, Math.sin(ph) * Math.sin(th));
          const tip = Math.pow(Math.cos(Math.min(ph, Math.PI / 2)), 10);
          // cloth gathered toward the tip: radial folds that deepen down the back, and a little flare over the shoulders
          const fold = 1 + 0.045 * Math.sin(th * 9) * smooth(0.15, 0.9, ph / (Math.PI - OPEN));
          const flare = fold * (1 + 0.16 * smooth(0.1, 0.8, -dir.y) * smooth(-0.2, 0.5, -dir.z));
          pos.push(C.x + dir.x * SC.x * k * flare, C.y + dir.y * SC.y * k + tip * 0.04, C.z + dir.z * SC.z * k * flare - tip * 0.3);
          ts.push(i / NP);
        }
      }
      for (let i = 0; i < NP; i++) for (let j = 0; j < NT; j++) {
        const a = i * (NT + 1) + j, b = a + NT + 1;
        if (inner) idx.push(a, a + 1, b, b, a + 1, b + 1); else idx.push(a, b, a + 1, b, b + 1, a + 1);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setIndex(idx); g.computeVertexNormals();
      return swatchUV(g, inner ? SW_DARK : SW_ROBE, (i) => (inner ? 1 : 0.1 + ts[i] * 0.75));
    };
    // (a, b, a+1) winds outward: d/dphi x d/dtheta ~ e1 x e2 = back at the pole
    parts.push(shell(1, false), shell(0.95, true));
    // trim band around the opening
    const rim = new THREE.TorusGeometry(Math.sin(OPEN), 0.07, 7, 40);
    rim.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(V(0, 0, 1), f)).translate(f.x * Math.cos(OPEN), f.y * Math.cos(OPEN), f.z * Math.cos(OPEN));
    rim.scale(SC.x, SC.y, SC.z).translate(C.x, C.y, C.z);
    parts.push(swatchUV(rim, SW_TRIM, () => 0.25));
  } else if (hat === 'crown') {
    const N = 32, PTS = 8, r0 = 0.5, h = 0.13, ph = 0.17, y0 = 0.62, pos = [], idx = [], ts = [];
    const peak = (j) => { const d = Math.abs(((j % (N / PTS)) / (N / PTS)) - 0.5) * 2; return 1 - d; }; // 0..1 per point
    // rows: outer bottom, outer top, inner top, inner bottom
    for (let row = 0; row < 4; row++) for (let j = 0; j <= N; j++) {
      const a = (j / N) * TAU + Math.PI / PTS, top = row === 1 || row === 2;
      const y = top ? y0 + h + ph * peak(j) : y0;
      const r = (row < 2 ? 1 : 0.92) * r0 * (top ? 1.1 : 1);
      pos.push(Math.sin(a) * r, y, Math.cos(a) * r); ts.push(top ? 0.05 : 0.8);
    }
    for (let row = 0; row < 3; row++) for (let j = 0; j < N; j++) {
      const a = row * (N + 1) + j, b = a + N + 1;
      idx.push(a, a + 1, b, b, a + 1, b + 1);
    }
    const band = new THREE.BufferGeometry();
    band.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    band.setIndex(idx); band.computeVertexNormals();
    parts.push(swatchUV(band, SW_TRIM, (i) => ts[i]));
    // gems on every point, a big one at the front
    for (let k = 0; k < PTS; k++) {
      const a = (k / PTS) * TAU, r = r0 * 1.1;
      const gem = new THREE.OctahedronGeometry(0.05, 0).scale(1, 1.4, 1).translate(Math.sin(a) * r, y0 + h + ph + 0.05, Math.cos(a) * r);
      parts.push(swatchUV(gem, SW_ACC2, () => 0.3));
    }
    const front = new THREE.OctahedronGeometry(0.075, 0).scale(1, 1.3, 0.6).translate(0, y0 + h * 0.55, r0 * 1.04 + 0.02);
    parts.push(swatchUV(front, SW_ACC2, () => 0.15));
    tips.push(V(0, y0 + h * 0.55, r0 * 1.04 + 0.06));
    for (const g of parts) g.rotateX(-0.14); // worn a little jauntily, tipped back
    tips[0].applyAxisAngle(V(1, 0, 0), -0.14);
  } else if (hat === 'antlers') {
    for (const sx of [1, -1]) {
      const beam = [V(0.26, 0.8, -0.02), V(0.44, 0.98, -0.08), V(0.66, 1.24, -0.14), V(0.8, 1.52, -0.08), V(0.78, 1.82, 0.06)].map((p) => p.setX(p.x * sx));
      const curve = new THREE.CatmullRomCurve3(beam);
      parts.push(tubeUV(taperTube(beam, 16, 7, (t) => 0.095 * (1 - t * 0.7)), SW_ACC, true));
      tips.push(beam[beam.length - 1].clone());
      for (const [at, dx, dy, dz, len] of [[0.3, 0.06, 0.34, 0.26, 1], [0.55, 0.3, 0.28, -0.02, 1], [0.78, -0.14, 0.26, 0.12, 0.85]]) {
        const s = curve.getPointAt(at), e = V(s.x + dx * sx * len, s.y + dy * len, s.z + dz * len);
        const m = s.clone().lerp(e, 0.5).add(V(0.03 * sx, 0.05, 0));
        parts.push(tubeUV(taperTube([s, m, e], 8, 6, (t) => 0.058 * (1 - t * 0.7)), SW_ACC, true));
      }
      // two leaves at the base
      for (const [lx, ly, lz, ry] of [[0.36, 0.84, 0.12, 0.6], [0.42, 0.8, -0.12, -0.5]]) {
        const leaf = new THREE.OctahedronGeometry(0.1, 0).scale(0.55, 0.18, 1.25).rotateY(ry * sx).rotateZ(-0.5 * sx).translate(lx * sx, ly, lz);
        parts.push(swatchUV(leaf, SW_ACC2, (i, p) => 0.5 - (p.getY(i) - ly) * 2));
      }
    }
  }
  const res = parts.length ? { geo: mergeAll(parts), tips } : null;
  if (res) res.geo.computeBoundingSphere();
  hatGeoCache.set(hat, res);
  return res;
}

const WIZ_GLSL = `
  float rd = length(vWp.xz);
  float lavaL = smoothstep(uR - 120.0, uR + 20.0, rd) * (1.0 - smoothstep(${LAVA_Y.toFixed(1)}, 90.0, vWp.y));
  totalEmissiveRadiance += vec3(1.0, 0.3, 0.05) * lavaL * 0.9 * (0.3 + diffuseColor.rgb);`;

function makeWizard(id, color, skin) {
  const root = SkeletonUtils.clone(gltf.scene);
  root.scale.setScalar(WIZ_S);
  root.position.y = -40;
  const tilt = new THREE.Group(); tilt.position.y = 40; tilt.add(root);
  const obj = new THREE.Group(); obj.add(tilt);
  const mat = patch(baseMat.clone(), 'wiz', WIZ_GLSL);
  mat.map = tintTex(color, skin);
  mat.emissive = new THREE.Color(0, 0, 0);
  let staff = null, hatNode = null;
  root.traverse((o) => {
    if (o.isMesh) { o.material = mat; o.castShadow = true; o.frustumCulled = false; }
    if (o.name === '2H_Staff') staff = o;
    if (o.name === 'Mage_Hat') { hatNode = o; o.scale.multiply(tv1.set(0.72, 1, 0.72)); } // narrower brim: the stock one hides the body from above
  });
  // headwear: the stock pointed hat, or a procedural piece on the head bone in its place
  const hatTips = [];
  const hw = skin.hat !== 'pointed' && hatNode && hatNode.parent ? hatGeometry(skin.hat) : null;
  if (hw) {
    hatNode.visible = false;
    const acc = new THREE.Mesh(hw.geo, mat);
    acc.castShadow = true; acc.frustumCulled = false;
    hatNode.parent.add(acc);
    for (const p of hw.tips) { const o = new THREE.Object3D(); o.position.copy(p); hatNode.parent.add(o); hatTips.push(o); }
  }
  const tip = new THREE.Object3D(); tip.position.set(0, 1.2, 0);
  (staff || root).add(tip);
  const ward = new THREE.Mesh(wardGeo, wardMat);
  ward.scale.setScalar(40); ward.position.y = 46; ward.visible = false; ward.renderOrder = 3;
  obj.add(ward);
  scene.add(obj);
  const mixer = new THREE.AnimationMixer(root);
  const A = {};
  for (const k of Object.keys(CL)) {
    const a = mixer.clipAction(CL[k]);
    if (['cast', 'hit', 'dieA', 'dieB'].includes(k)) { a.setLoop(THREE.LoopOnce, 1); a.clampWhenFinished = true; }
    a.setEffectiveWeight(0); a.play();
    A[k] = a;
  }
  A.cast.timeScale = 1.7; A.hit.timeScale = 1.5;
  A.knock.time = 0.16; A.knock.timeScale = 0;
  A.tumble.timeScale = 1.6;
  return {
    id, color, skin: skin.id, hat: skin.hat, hatTips, obj, tilt, root, mat, tip, ward, mixer, A,
    glow: new THREE.Color(color).multiplyScalar(3), orb: new THREE.Color(skin.orb).multiplyScalar(3),
    x: 0, y: 0, vx: 0, vy: 0, h: 0, yaw: 0, hp: 0, alive: false, lava: false, face: 0,
    castT: 9, castAng: 0, hitT: 9, flash: 0, spin: 0, dying: null, cheer: 0,
  };
}

function castBy(id, ang) {
  const w = wiz.get(id);
  if (w && w.alive) { w.castT = 0; w.castAng = ang; w.A.cast.reset().play(); }
}
function nearestWizard(x, y, maxD) {
  let best = null, bd = maxD;
  for (const [id, w] of wiz) {
    if (!w.alive) continue;
    const d = Math.hypot(w.x - x, w.y - y);
    if (d < bd) { bd = d; best = id; }
  }
  return best;
}

const nums = []; // floating damage numbers {x, y, h, v, t, me}
let myDanger = 0;

function updateWizards(players, roster, myId, dt, now, phase, winner) {
  if (!gltf) return;
  for (const p of players) {
    const info = roster.get(p.id) || { color: '#cccccc' };
    const skin = skinOf(info.skin);
    let w = wiz.get(p.id);
    if (w && (w.color !== info.color || w.skin !== skin.id)) { disposeWizard(w); wiz.delete(p.id); w = null; }
    if (!w) { w = makeWizard(p.id, info.color, skin); wiz.set(p.id, w); w.obj.visible = false; }
    w.seen = now;
    if (w.alive && !p.alive) startDeath(w);
    if (!w.alive && p.alive) respawn(w, p);
    w.alive = !!p.alive;
    if (p.alive) updateLiving(w, p, dt, now, p.id === myId, phase !== 'play' && winner === p.id);
    else if (w.dying) updateDying(w, dt, now);
    w.mixer.update(dt);
  }
  for (const [id, w] of wiz) if (w.seen !== now) { disposeWizard(w); wiz.delete(id); }
}
function disposeWizard(w) { scene.remove(w.obj); w.mat.dispose(); w.mixer.stopAllAction(); }

function respawn(w, p) {
  Object.assign(w, { x: p.x, y: p.y, vx: 0, vy: 0, h: 0, hp: p.hp, castT: 9, hitT: 9, flash: 0, spin: 0, dying: null, yaw: Math.atan2(Math.cos(p.face), Math.sin(p.face)) });
  w.obj.visible = true;
  w.mat.color.setRGB(1, 1, 1);
  w.tilt.rotation.set(0, 0, 0);
  for (const k of ['dieA', 'dieB']) w.A[k].stop().play().setEffectiveWeight(0);
}

const tipV = new THREE.Vector3();
function updateLiving(w, p, dt, now, isMe, cheering) {
  // damage -> flinch + floating number
  const dmg = w.hp - p.hp;
  if (dmg > 0.5 && (!p.lava || dmg >= 4)) {
    w.flash = 1;
    if (dmg >= 2) {
      w.hitT = 0; w.A.hit.reset().play();
      nums.push({ x: p.x + rand(-8, 8), y: p.y, h: HEAD - 10, v: Math.round(dmg), t: 0, me: isMe });
      if (nums.length > 40) nums.shift();
    }
  }
  w.hp = p.hp;
  w.flash = Math.max(0, w.flash - dt * 6);
  w.castT += dt; w.hitT += dt;
  // velocity from interpolated position deltas (teleports ignored)
  if (dt > 0) {
    const mx = p.x - w.x, my = p.y - w.y, k = 1 - Math.exp(-12 * dt);
    if (Math.abs(mx) + Math.abs(my) > 70) { w.vx = w.vy = 0; } else { w.vx = lerp(w.vx, mx / dt, k); w.vy = lerp(w.vy, my / dt, k); }
  }
  w.x = p.x; w.y = p.y; w.lava = !!p.lava; w.face = p.face;
  const speed = Math.hypot(w.vx, w.vy);
  const knock = smooth(330, 600, speed);
  const run = smooth(15, 90, speed) * (1 - knock);
  const tumble = smooth(650, 800, speed);

  // facing: cast direction while casting, against the shove while flung, else the snapshot face
  let ang = p.face;
  if (w.castT < 0.5) ang = w.castAng;
  else if (knock > 0.4) ang = Math.atan2(w.vy, w.vx) + Math.PI;
  const yawT = Math.atan2(Math.cos(ang), Math.sin(ang));
  w.yaw += angDiff(w.yaw, yawT) * (1 - Math.exp(-(w.castT < 0.15 ? 30 : 16) * dt));

  // height: wading in the lava, or on the stone
  const hT = p.lava ? LAVA_Y - WADE : 0;
  w.h += (hT - w.h) * (1 - Math.exp(-(hT < w.h ? 7 : 12) * dt));

  // tumble / lean
  if (tumble > 0.5) w.spin += dt * 13; else { w.spin = Math.atan2(Math.sin(w.spin), Math.cos(w.spin)); w.spin *= Math.exp(-9 * dt); }
  w.tilt.rotation.x = -knock * 0.45 - w.spin;

  w.obj.position.set(p.x, w.h, p.y);
  w.obj.rotation.y = w.yaw;

  // animation weights: lower body (legs) and upper body layers + full-body overrides
  const castW = w.castT < 0.55 ? clamp01(w.castT / 0.06) * clamp01((0.55 - w.castT) / 0.15) : 0;
  const hitW = w.hitT < 0.45 ? clamp01(w.hitT / 0.05) * clamp01((0.45 - w.hitT) / 0.15) : 0;
  w.cheer += ((cheering ? 1 : 0) - w.cheer) * (1 - Math.exp(-6 * dt));
  const full = Math.min(1, knock + w.cheer);
  const kW = knock * (1 - tumble), tW = knock * tumble;
  const over = Math.min(1, castW + hitW) * (1 - full);
  const A = w.A;
  A.idleL.setEffectiveWeight((1 - full) * (1 - run)); A.runL.setEffectiveWeight((1 - full) * run);
  const rest = (1 - full) - over;
  A.idleU.setEffectiveWeight(rest * (1 - run)); A.runU.setEffectiveWeight(rest * run);
  const ov = castW + hitW || 1;
  A.cast.setEffectiveWeight(over * castW / ov); A.hit.setEffectiveWeight(over * hitW / ov);
  A.knock.setEffectiveWeight(kW); A.tumble.setEffectiveWeight(tW);
  A.cheer.setEffectiveWeight(w.cheer * (1 - knock));
  A.dieA.setEffectiveWeight(0); A.dieB.setEffectiveWeight(0);
  const ts = Math.max(0.6, Math.min(1.35, speed / 230));
  A.runL.timeScale = A.runU.timeScale = ts;

  // material: hit flash, lava burn, low health pulse
  const hf = clamp01(p.hp / p.maxHp);
  let er = w.flash * 1.6, eg = w.flash * 1.6, eb = w.flash * 1.6;
  if (p.lava) { const pu = 0.5 + 0.3 * Math.sin(now / 45 + p.id); er += 1.3 * pu; eg += 0.35 * pu; eb += 0.05 * pu; }
  else if (hf < 0.5) { const pu = (0.5 - hf) * (0.75 + 0.25 * Math.sin(now / 150)); er += 0.9 * pu; eg += 0.08 * pu; }
  w.mat.emissive.setRGB(er, eg, eb);

  w.ward.visible = !!p.ward;
  if (p.ward) { const s = 40 + Math.sin(now / 90) * 1.2; w.ward.scale.set(s, s, s); }

  // staff tip glow in the skin's orb colour (flares while casting)
  w.tip.getWorldPosition(tipV);
  const fl = 1 + castW * 2.5, g = w.orb;
  glows.add(tipV.x, tipV.y, tipV.z, 16 + 3 * Math.sin(now / 110 + p.id) + castW * 20, g.r * fl, g.g * fl, g.b * fl, 0.85);
  glows.add(tipV.x, tipV.y, tipV.z, 5 + castW * 6, 3, 3, 3, 1);
  // headwear glints: ember horn tips, the crown's front gem, motes on the antler tips
  for (let k = 0; k < w.hatTips.length; k++) {
    w.hatTips[k].getWorldPosition(tipV);
    const pu = 0.75 + 0.25 * Math.sin(now / (w.hat === 'antlers' ? 240 : 130) + k * 2.1 + p.id);
    const sz = w.hat === 'crown' ? 7 : w.hat === 'horns' ? 8 : 6;
    glows.add(tipV.x, tipV.y, tipV.z, sz * pu, g.r * 0.6 * pu, g.g * 0.6 * pu, g.b * 0.6 * pu, 0.8);
  }

  if (p.lava) {
    if (Math.random() < 0.9) fx.spawn(p.x + rand(-13, 13), LAVA_Y + rand(0, 20), p.y + rand(-13, 13), rand(-15, 15), rand(40, 90), rand(-15, 15), rand(0.35, 0.7), rand(12, 20), K_FLAME, 0, 0, 0, 0.95);
    if (Math.random() < 0.15) smoke.spawn(p.x + rand(-10, 10), LAVA_Y + 40, p.y + rand(-10, 10), rand(-10, 10), rand(25, 45), rand(-10, 10), rand(0.9, 1.4), rand(16, 26), K_SMOKE, 0.12, 0.09, 0.08, 0.98);
  } else if (knock > 0.4 && Math.random() < 0.6) {
    smoke.spawn(p.x + rand(-8, 8), 4, p.y + rand(-8, 8), -w.vx * 0.1, rand(10, 30), -w.vy * 0.1, rand(0.4, 0.7), rand(10, 16), K_SMOKE, 0.32, 0.27, 0.24, 0.92);
  }
  if (isMe) {
    myDanger = Math.max(myDanger, p.lava ? 0.85 : clamp01((0.35 - hf) / 0.35) * 0.8);
    meMarker.visible = true;
    meMarker.position.set(p.x, Math.max(w.h, LAVA_Y) + 0.6, p.y);
    meMarker.material.uniforms.uDrape.value = p.lava ? 0 : 1;
    const s = 27 + Math.sin(now / 260) * 1.5;
    meMarker.scale.set(s, 1, s);
    meMarker.material.uniforms.uCol.value.copy(w.glow).multiplyScalar(0.6);
    meMarker.material.uniforms.uA.value = 0.75 + 0.25 * Math.sin(now / 260);
  }
}

function startDeath(w) {
  w.dying = { t: 0, lava: w.lava };
  w.ward.visible = false;
  const k = w.lava ? 'dieB' : 'dieA';
  for (const a of Object.values(w.A)) a.setEffectiveWeight(0);
  w.A[k].reset().play(); w.A[k].timeScale = w.lava ? 1.4 : 1.2; w.A[k].setEffectiveWeight(1);
  w.tilt.rotation.x = 0; w.spin = 0;
}
function updateDying(w, dt, now) {
  const d = w.dying;
  d.t += dt;
  const x = w.x, y = w.y;
  if (d.lava) {
    // sinks into the lava, burning
    w.h -= dt * (25 + d.t * 50);
    const q = clamp01(d.t / 1.6);
    w.mat.emissive.setRGB(1.8 * q + 0.6, 0.45 * q + 0.1, 0.05);
    if (Math.random() < 0.95) fx.spawn(x + rand(-16, 16), LAVA_Y + rand(0, 25), y + rand(-16, 16), rand(-25, 25), rand(60, 130), rand(-25, 25), rand(0.35, 0.75), rand(14, 26), K_FLAME, 0, 0, 0, 0.95);
    if (Math.random() < 0.3) smoke.spawn(x + rand(-12, 12), LAVA_Y + 30, y + rand(-12, 12), rand(-10, 10), rand(30, 60), rand(-10, 10), rand(1, 1.6), rand(18, 30), K_SMOKE, 0.1, 0.08, 0.07, 0.98);
    if (d.t > 0.15 && Math.random() < 0.3) ring(x, y, 16, 34 + d.t * 20, 0.5, 2.5, 1.2, 0.3, 0.12, LAVA_Y + 0.5);
    if (d.t > 1.8) { w.obj.visible = false; w.dying = null; }
  } else {
    // collapses, chars to ash, crumbles away
    const q = clamp01((d.t - 0.7) / 1.3);
    const c = 1 - 0.88 * q;
    w.mat.color.setRGB(c, c * 0.95, c * 0.9);
    w.mat.emissive.setRGB(0.9 * q * (0.6 + 0.4 * Math.sin(now / 60)), 0.2 * q, 0.02);
    if (d.t > 1.4) w.h -= dt * 30;
    if (Math.random() < 0.7) fx.spawn(x + rand(-14, 14), rand(2, 30) * (1 - q * 0.5), y + rand(-14, 14), rand(-15, 15), rand(30, 80), rand(-15, 15), rand(0.3, 0.6), rand(8, 14), K_FLAME, 0, 0, 0, 0.95);
    if (q > 0 && Math.random() < 0.4) smoke.spawn(x + rand(-14, 14), rand(5, 30), y + rand(-14, 14), rand(-15, 15), rand(20, 45), rand(-15, 15), rand(0.8, 1.3), rand(12, 20), K_SMOKE, 0.09, 0.07, 0.06, 0.98);
    if (d.t > 2.4) { w.obj.visible = false; w.dying = null; }
  }
  w.obj.position.y = w.h;
}

// ---------------- projectiles & meteors ----------------
const proj = new Map(); // id -> {seen, lx, ly}
let stamp = 0;
const lightCand = []; // reused: {x, y, z, r, g, b, power}
for (let i = 0; i < 4; i++) lightCand.push({ x: 0, y: 0, z: 0, r: 0, g: 0, b: 0, p: 0 });
let nCand = 0;
function candidate(x, y, z, r, g, b, p) {
  // keep the brightest few (explosions beat projectiles), nearest to the view as a tie-break
  let slot = nCand < 4 ? nCand++ : -1;
  if (slot < 0) {
    let low = 0;
    for (let i = 1; i < 4; i++) if (lightCand[i].p < lightCand[low].p) low = i;
    if (lightCand[low].p >= p) return;
    slot = low;
  }
  Object.assign(lightCand[slot], { x, y, z, r, g, b, p });
}

function updateProjectiles(a, b, f, now, myId) {
  stamp++;
  for (const jb of b.J) {
    const ja = a.Jm.get(jb[0]) || jb;
    const x = lerp(ja[2], jb[2], f), z = lerp(ja[3], jb[3], f), seeker = jb[1] === 1;
    let st = proj.get(jb[0]);
    if (!st) {
      st = { seen: 0, lx: x, ly: z };
      proj.set(jb[0], st);
      const w = wiz.get(jb[4]);
      if (w) castBy(jb[4], Math.atan2(z - w.y, x - w.x));
    }
    st.seen = stamp;
    const dx = x - st.lx, dz = z - st.ly;
    st.lx = x; st.ly = z;
    const y = CHEST;
    if (seeker) {
      const pul = Math.sin(now / 80 + jb[0]);
      glows.add(x, y, z, 44 + 5 * pul, 0.75, 0.22, 1.6, 0.6);
      glows.add(x, y, z, 22, 1.6, 0.65, 1.6, 0.9);
      glows.add(x, y, z, 9, 2.2, 2, 2.6, 1);
      for (let k = 0; k < 3; k++) {
        const an = now * 0.009 + (k * TAU) / 3;
        glows.add(x + Math.cos(an) * 15, y + Math.sin(an * 1.3) * 8, z + Math.sin(an) * 15, 7, 2.5, 2, 3.5, 1);
      }
      const sw = now * 0.012 + jb[0];
      for (let k = 0; k < 2; k++) {
        const o = k ? Math.PI : 0;
        fx.spawn(x + Math.cos(sw + o) * 9, y + Math.sin(sw * 1.3 + o) * 6, z + Math.sin(sw + o) * 9, rand(-10, 10), rand(-5, 10), rand(-10, 10), rand(0.3, 0.55), rand(9, 15), K_GLOW, k ? 1.6 : 0.9, k ? 0.6 : 0.3, k ? 2.0 : 2.4, 0.9);
      }
      candidate(x, y, z, 0.6, 0.3, 1, 1);
    } else {
      glows.add(x, y, z, 40, 1.4, 0.35, 0.06, 0.55);
      glows.add(x, y, z, 20, 2.2, 1.1, 0.3, 0.9);
      glows.add(x, y, z, 8 + Math.sin(now / 30 + x) * 1, 2.6, 2.1, 1.3, 1);
      // flame trail
      for (let k = 0; k < 3; k++) {
        const q = k / 3;
        fx.spawn(x - dx * q + rand(-3, 3), y + rand(-3, 3), z - dz * q + rand(-3, 3), rand(-20, 20), rand(0, 25), rand(-20, 20), rand(0.2, 0.36), rand(14, 22), K_FLAME, 0, 0, 0, 0.95);
      }
      if (Math.random() < 0.5) fx.spawn(x, y, z, rand(-60, 60), rand(-20, 60), rand(-60, 60), rand(0.2, 0.4), rand(3, 5), K_SPARK, 4, 1.8, 0.4, 0.94, 300);
      candidate(x, y, z, 1, 0.45, 0.12, 1);
    }
    if (jb[4] === myId) glows.add(x, y, z, seeker ? 34 : 30, 0.35, 0.35, 0.35, 0.5);
  }
  for (const [id, st] of proj) {
    if (st.seen === stamp) continue;
    fx.burst(st.lx, CHEST, st.ly, 6, 70, 0.3, 10, K_GLOW, 2.5, 1, 0.3);
    proj.delete(id);
  }
}

const FALL = new THREE.Vector3(-330, 820, -280); // meteors arrive from high up, north-west
function updateZones(a, b, f, dt, now) {
  const total = SPELLS.meteor.delay * TICK;
  for (const zp of zonePool) zp.seen = 0;
  for (const z of b.Z) {
    const [id, x, y, r] = z;
    let zp = zonePool.find((q) => q.id === id);
    if (!zp) {
      zp = zonePool.find((q) => q.id === -1 || !q.decal.visible);
      if (!zp) continue;
      zp.id = id;
      // the caster is whoever is facing the target spot most squarely
      let best = null, bd = 0.4;
      for (const [pid, w] of wiz) {
        if (!w.alive || Math.hypot(x - w.x, y - w.y) > 660) continue;
        const d = Math.abs(angDiff(w.face, Math.atan2(y - w.y, x - w.x)));
        if (d < bd) { bd = d; best = pid; }
      }
      if (best !== null) { const w = wiz.get(best); castBy(best, Math.atan2(y - w.y, x - w.x)); }
    }
    zp.seen = 1;
    const za = a.Z.find((q) => q[0] === id);
    const p = clamp01(1 - (za ? lerp(za[4], z[4], f) : z[4]) / total);
    zp.decal.visible = true;
    zp.decal.position.set(x, 0.5, y); zp.decal.scale.set(r, 1, r);
    zp.mat.uniforms.uP.value = p;
    // the rock: falls along an angled path, accelerating
    const e = Math.pow(1 - p, 1.5);
    const mx = x + FALL.x * e, my = FALL.y * e + 6, mz = y + FALL.z * e;
    zp.rock.visible = p < 1;
    zp.rock.position.set(mx, my, mz);
    const s = 13 + 9 * p;
    zp.rock.scale.set(s, s, s);
    zp.rock.rotation.set(now / 210 + id, now / 330, now / 270);
    glows.add(mx, my, mz, s * 5, 2.4, 0.6, 0.1, 0.75);
    glows.add(mx, my, mz, s * 2.4, 4, 2.4, 0.9, 0.9);
    // fiery tail along the path + smoke
    const ux = FALL.x / 1000, uy = FALL.y / 1000, uz = FALL.z / 1000;
    for (let k = 0; k < 4; k++) {
      const back = rand(0.3, 2.2) * s;
      fx.spawn(mx + ux * back + rand(-s, s) * 0.4, my + uy * back + rand(-s, s) * 0.4, mz + uz * back + rand(-s, s) * 0.4,
        ux * rand(60, 160), uy * rand(60, 160), uz * rand(60, 160), rand(0.25, 0.5), s * rand(1.2, 2), K_FLAME, 0, 0, 0, 0.95);
    }
    if (Math.random() < 0.5) smoke.spawn(mx + ux * s * 2.5, my + uy * s * 2.5, mz + uz * s * 2.5, ux * 40, uy * 40, uz * 40, rand(0.7, 1.1), s * 1.6, K_SMOKE, 0.1, 0.08, 0.07, 0.96);
    candidate(mx, my, mz, 1, 0.45, 0.1, 2 + p);
  }
  for (const zp of zonePool) if (!zp.seen && zp.decal.visible) { zp.decal.visible = zp.rock.visible = false; zp.id = -1; }
}

// ---------------- terrain: pillars and rocks ----------------
// Shared geometry (a few seeded variants) and materials, scaled per obstacle; nothing per obstacle to dispose.
const OBS_GLSL = `
  float rd = length(vWp.xz);
  float heat = smoothstep(uR - 70.0, uR + 2.0, rd) * (1.0 - smoothstep(0.0, 70.0, vWp.y));
  totalEmissiveRadiance += vec3(1.0, 0.28, 0.04) * heat * (0.22 + 0.05 * sin(uTime * 3.0 + rd * 0.1)) * (0.3 + diffuseColor.rgb);
  totalEmissiveRadiance += vec3(1.0, 0.3, 0.06) * (1.0 - smoothstep(0.0, 45.0, vWp.y)) * 0.1 * (0.4 + diffuseColor.rgb);
  float sunk = 1.0 - smoothstep(${(LAVA_Y - 4).toFixed(1)}, -1.0, vWp.y);
  totalEmissiveRadiance += vec3(2.2, 0.55, 0.08) * sunk;`;
const AO_FRAG = /* glsl */`
uniform float uA; uniform float uR; varying vec2 vUv; varying vec3 vWp;
void main() {
  if (length(vWp.xz) > uR + 1.0) discard;
  float r = length(vUv);
  float a = (1.0 - smoothstep(0.3, 1.0, r)) * uA;
  gl_FragColor = vec4(0.025, 0.012, 0.008, a);
}`;
const PILLAR_VARIANTS = 4, ROCK_VARIANTS = 4;
const pillarGeos = [], rockGeos = [];
let obsStoneMat, obsRockMat, runeMat, runeGeo, aoMat, pebbles;
const obs = new Map();      // id -> obstacle
const crumbled = new Set(); // ids already toppled by a 'crumble' event (may linger a frame in snapshots)
let obsStamp = 0, obsInstant = true, pebDirty = false;

function runeCanvas() {
  const c = canvas(512, 64), g = c.getContext('2d'), R = seeded(77);
  g.strokeStyle = '#fff'; g.lineCap = 'round'; g.lineJoin = 'round';
  g.shadowColor = '#fff'; g.shadowBlur = 6;
  g.lineWidth = 2; g.globalAlpha = 0.55;
  g.beginPath(); g.moveTo(0, 8); g.lineTo(512, 8); g.moveTo(0, 56); g.lineTo(512, 56); g.stroke();
  g.globalAlpha = 1; g.lineWidth = 3.2;
  for (let k = 0; k < 16; k++) { // one glyph per cell: a stem plus a few strokes
    const x = k * 32 + 16;
    g.beginPath();
    g.moveTo(x + (R() - 0.5) * 6, 16); g.lineTo(x + (R() - 0.5) * 6, 48);
    for (let s = 0, n = 2 + Math.floor(R() * 2); s < n; s++) {
      const y = 18 + R() * 28;
      g.moveTo(x, y); g.lineTo(x + (R() < 0.5 ? -1 : 1) * (5 + R() * 6), y + (R() - 0.5) * 16);
    }
    g.stroke();
  }
  return c;
}

// a weathered, fluted column of radius 1 and height 1 (y 0..1), with a plinth; intact capital or broken top
function pillarGeometry(seed) {
  const R = seeded(seed), broken = seed % 2 === 1;
  const NS = 24, NH = 12, y0 = 0.1, yTop = broken ? 0.84 : 0.92, lean = (R() - 0.5) * 0.05;
  const dents = []; // chipped spots
  for (let i = 0; i < 6; i++) dents.push([R() * TAU, y0 + R() * (yTop - y0), 0.25 + R() * 0.3, 0.05 + R() * 0.06]);
  const jag = []; for (let i = 0; i < 5; i++) jag.push([R() * TAU, R() * 0.6 + 0.4]);
  const topAt = (a) => {
    if (!broken) return yTop;
    let h = 0; for (const [p, w] of jag) h += w * Math.cos(a * 2 + p * 3) * 0.5 + 0.2 * Math.sin(a * 5 + p);
    return yTop + 0.05 + 0.13 * h / jag.length;
  };
  const pos = [], uv = [], idx = [];
  const noise = new Map();
  for (let i = 0; i <= NH; i++) for (let j = 0; j <= NS; j++) {
    const a = (j / NS) * TAU, top = i === NH;
    const y = top ? topAt(a) : y0 + (yTop - y0) * (i / NH);
    const q = (y - y0) / (yTop - y0);
    const key = `${i},${j % NS}`; // same jitter on both sides of the seam
    if (!noise.has(key)) noise.set(key, (R() - 0.5) * 0.06);
    let r = (1 - 0.1 * q) * (1 - 0.05 * (0.5 + 0.5 * Math.cos(a * 12))) + noise.get(key);
    for (const [da, dy, w, depth] of dents) {
      const d = Math.hypot(angDiff(a, da) * 0.8, (y - dy) * 2.2);
      if (d < w) r -= depth * (1 - d / w);
    }
    if (i === 0) r *= 1.04;
    pos.push(Math.cos(a) * r + lean * q, y, Math.sin(a) * r);
    uv.push((j / NS) * 0.8, y * 0.55);
  }
  for (let i = 0; i < NH; i++) for (let j = 0; j < NS; j++) {
    const a = i * (NS + 1) + j, b = a + NS + 1;
    idx.push(a, b, a + 1, b, b + 1, a + 1);
  }
  // top cap: fan to a centre point (sunken on a broken column)
  const c0 = pos.length / 3;
  pos.push(lean, broken ? yTop + 0.02 : yTop, 0); uv.push(0.4, 0.2);
  const tr = NH * (NS + 1);
  for (let j = 0; j < NS; j++) {
    const a = tr + j;
    pos.push(pos[a * 3], pos[a * 3 + 1], pos[a * 3 + 2]); uv.push(0.4 + pos[a * 3] * 0.15, 0.2 + pos[a * 3 + 2] * 0.15);
  }
  for (let j = 0; j < NS; j++) idx.push(c0, c0 + 1 + ((j + 1) % NS), c0 + 1 + j);
  const shaft = new THREE.BufferGeometry();
  shaft.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  shaft.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  shaft.setIndex(idx); shaft.computeVertexNormals();
  const parts = [shaft];
  const ring = (rt, rb, h, y, n, rot) => parts.push(new THREE.CylinderGeometry(rt, rb, h, n, 1).rotateY(rot).translate(0, y + h / 2, 0));
  ring(1.3, 1.42, 0.055, 0, 8, Math.PI / 8);          // plinth
  ring(1.12, 1.22, 0.05, 0.055, 8, R() * 0.4);         // step
  ring(1.06, 1.1, 0.025, y0 - 0.005, 24, 0);           // base moulding
  if (!broken) {
    ring(0.98, 0.9, 0.03, yTop - 0.005, 24, 0);        // collar
    parts.push(new THREE.BoxGeometry(2.1, 0.06, 2.1).rotateY(R() * 0.3).translate(lean, yTop + 0.055, 0)); // abacus
  }
  const g = mergeAll(parts);
  g.computeBoundingSphere();
  return g;
}

function buildObstacles(stone, bump) {
  for (let i = 0; i < PILLAR_VARIANTS; i++) pillarGeos.push(pillarGeometry(101 + i));
  for (let i = 0; i < ROCK_VARIANTS; i++) rockGeos.push(rockGeometry(201 + i * 7, 1));
  obsStoneMat = patch(new THREE.MeshStandardMaterial({ map: stone, bumpMap: bump, bumpScale: 2.5, color: 0xfff0dc, roughness: 0.88, metalness: 0 }), 'obs', OBS_GLSL);
  obsRockMat = patch(new THREE.MeshStandardMaterial({ map: stone, bumpMap: bump, bumpScale: 3, color: 0xd8c2ae, roughness: 0.92, metalness: 0, flatShading: true }), 'obsRock', OBS_GLSL);
  const rt = canvasTex(runeCanvas());
  rt.wrapS = THREE.RepeatWrapping;
  runeMat = new THREE.MeshBasicMaterial({ map: rt, color: new THREE.Color(2, 0.55, 0.12), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
  runeGeo = new THREE.CylinderGeometry(1, 1, 1, 32, 1, true);
  const ru = runeGeo.attributes.uv; for (let i = 0; i < ru.count; i++) ru.setX(i, ru.getX(i) * 3);
  aoMat = decalMat(AO_FRAG, { uA: { value: 0.6 } }, THREE.NormalBlending);
  aoMat.uniforms.uDrape.value = 0;
  pebbles = new THREE.InstancedMesh(rockGeometry(13), rubble.material, 200);
  pebbles.count = 0; pebbles.castShadow = true; pebbles.receiveShadow = true; pebbles.frustumCulled = false;
  scene.add(pebbles);
}

function makeObstacle(q) {
  const [id, kind, x, y, r] = q, R = seeded(id * 7919 + 13), pillar = kind === PILLAR;
  const pivot = new THREE.Group(); pivot.position.set(x, 0, y);
  let mesh, H;
  if (pillar) {
    H = 112 + R() * 38;
    mesh = new THREE.Mesh(pillarGeos[Math.floor(R() * PILLAR_VARIANTS)], obsStoneMat);
    mesh.scale.set(r, H, r);
    if (R() < 0.75) { // glowing rune band
      const band = new THREE.Mesh(runeGeo, runeMat);
      band.position.y = 0.3 + R() * 0.25; band.scale.set(1.05, 0.085, 1.05); band.renderOrder = 3;
      mesh.add(band);
    }
  } else {
    H = r * 0.9;
    mesh = new THREE.Mesh(rockGeos[Math.floor(R() * ROCK_VARIANTS)], obsRockMat);
    mesh.scale.set(r * 1.05, r * (0.8 + R() * 0.25), r * 1.05);
    mesh.position.y = r * 0.12;
    mesh.rotation.set((R() - 0.5) * 0.3, 0, (R() - 0.5) * 0.3);
  }
  mesh.rotation.y = R() * TAU;
  mesh.castShadow = mesh.receiveShadow = true;
  pivot.add(mesh);
  const ao = new THREE.Mesh(decalGeo, aoMat);
  ao.renderOrder = 1; ao.position.set(x, 0.35, y);
  const aoS = r * (pillar ? 1.75 : 1.55);
  ao.scale.set(aoS, 1, aoS);
  scene.add(pivot, ao);
  const peb = [];
  for (let k = 0, n = pillar ? 4 + Math.floor(R() * 4) : 2 + Math.floor(R() * 2); k < n; k++) {
    const a = R() * TAU, d = r * (pillar ? 1.35 : 1.05) + R() * r * 0.5;
    peb.push([x + Math.cos(a) * d, y + Math.sin(a) * d, (pillar ? 3 : 2) + R() * (pillar ? 5 : 3), R() * 6, R() * 6]);
  }
  return { id, kind, x, y, r, H, pivot, mesh, ao, aoS, peb, state: 'idle', t: 0, seen: 0, dx: 0, dz: 0, py: 0, vy: 0, ang: 0, slide: 0, splashed: false };
}
function removeObstacle(o) { scene.remove(o.pivot, o.ao); obs.delete(o.id); pebDirty = true; }
function clearObstacles() {
  for (const o of [...obs.values()]) removeObstacle(o);
  crumbled.clear(); obsInstant = true;
  if (pebbles) { pebbles.count = 0; }
}

function dust(x, y, r, n, up = 1) {
  for (let i = 0; i < n; i++) {
    const a = Math.random() * TAU, d = r * rand(0.7, 1.2), v = rand(40, 110);
    smoke.spawn(x + Math.cos(a) * d, rand(2, 14) * up, y + Math.sin(a) * d, Math.cos(a) * v, rand(10, 45) * up, Math.sin(a) * v, rand(0.7, 1.3), rand(22, 40), K_SMOKE, 0.34, 0.29, 0.25, 0.93);
  }
}
function lavaSplash(x, y, s) {
  ring(x, y, 10 * s, 70 * s, 0.6, 4, 1.2, 0.2, 0.2, LAVA_Y + 0.6);
  ring(x, y, 6 * s, 40 * s, 0.9, 2.5, 0.7, 0.12, 0.3, LAVA_Y + 0.5);
  fx.burst(x, LAVA_Y + 4, y, Math.round(26 * s), 300 * s, 0.7, 5, K_SPARK, 4, 1.5, 0.3, 0.95, 2.4, 600);
  for (let i = 0; i < 22 * s; i++) {
    const a = Math.random() * TAU, v = rand(30, 120) * s;
    fx.spawn(x + Math.cos(a) * 14 * s, LAVA_Y + rand(0, 14), y + Math.sin(a) * 14 * s, Math.cos(a) * v, rand(80, 260) * s, Math.sin(a) * v, rand(0.45, 0.85), rand(22, 40) * s, K_FLAME, 0, 0, 0, 0.93);
  }
  for (let i = 0; i < 10 * s; i++) smoke.spawn(x + rand(-20, 20) * s, LAVA_Y + rand(20, 50), y + rand(-20, 20) * s, rand(-25, 25), rand(40, 90), rand(-25, 25), rand(1.3, 2.1), rand(36, 60) * s, K_SMOKE, 0.1, 0.08, 0.07, 0.95);
  lightFlash(x, LAVA_Y + 40, y, 1, 0.45, 0.1, 5 * s, 0.5);
}

// the platform let go of this one: topple outward over the rim into the lava
function startFall(o) {
  const d = Math.hypot(o.x, o.y) || 1;
  o.dx = o.x / d; o.dz = o.y / d;
  o.state = 'fall'; o.t = 0; o.py = 0; o.vy = 0; o.ang = 0; o.slide = 0; o.splashed = false;
  const off = o.kind === PILLAR ? o.r * 0.75 : 0; // pillars tip over their outer base edge
  o.pivot.position.set(o.x + o.dx * off, 0, o.y + o.dz * off);
  o.mesh.position.x = -o.dx * off; o.mesh.position.z = -o.dz * off;
  pebDirty = true;
  // crack, dust and stone chips
  dust(o.x, o.y, o.r, o.kind === PILLAR ? 14 : 8);
  addDebris(o.x, o.y, o.kind === PILLAR ? 14 : 8, o.r * 4);
  ring(o.x, o.y, o.r * 0.8, o.r * 2.4, 0.5, 2.2, 0.6, 0.12, 0.2);
  addShake(0.15 * Math.max(0, 1 - Math.hypot(o.x - cam.x, o.y - cam.y) / 700));
}
function crumbleAt(x, y, r, kind) {
  let best = null, bd = 6 + r * 0.3;
  for (const o of obs.values()) {
    if (o.state === 'fall') continue;
    const dd = Math.hypot(o.x - x, o.y - y);
    if (dd < bd) { bd = dd; best = o; }
  }
  if (best) {
    if (best.state === 'sink') best.pivot.position.y = 0;
    crumbled.add(best.id); startFall(best);
  } else { // never saw it (or already gone): just the splash where it went in
    const d = Math.hypot(x, y) || 1;
    dust(x, y, r, 6);
    lavaSplash(x + (x / d) * r * (kind === PILLAR ? 3 : 1.5), y + (y / d) * r * (kind === PILLAR ? 3 : 1.5), kind === PILLAR ? 1.3 : 0.8);
  }
}

const obsQ = new THREE.Quaternion(), obsAxis = new THREE.Vector3();
function updateObstacles(list, dt, now) {
  obsStamp++;
  for (const q of list) {
    if (crumbled.has(q[0])) continue;
    let o = obs.get(q[0]);
    if (o && (o.kind !== q[1] || o.x !== q[2] || o.y !== q[3] || o.r !== q[4])) { removeObstacle(o); o = null; } // id reused by another match
    if (!o) {
      o = makeObstacle(q); obs.set(o.id, o); pebDirty = true;
      if (!obsInstant) { // rises out of the stone
        o.state = 'rise'; o.t = 0;
        dust(o.x, o.y, o.r, o.kind === PILLAR ? 10 : 5);
        ring(o.x, o.y, o.r * 0.6, o.r * 2, 0.45, 1.6, 0.5, 0.1, 0.2);
      }
    }
    o.seen = obsStamp;
  }
  // forget crumbled ids once the snapshots stop listing them
  if (crumbled.size) for (const id of crumbled) if (!list.some((q) => q[0] === id)) crumbled.delete(id);
  if (list.length) obsInstant = false;
  const R = U.uR.value;
  for (const o of obs.values()) { // (deleting the current entry mid-iteration is safe for a Map)
    if (o.seen !== obsStamp && (o.state === 'idle' || o.state === 'rise')) { // removed (new layout): sink into the floor
      o.state = 'sink'; o.t = 0; pebDirty = true;
      dust(o.x, o.y, o.r, o.kind === PILLAR ? 8 : 4);
    }
    if (o.state === 'idle') continue;
    o.t += dt;
    if (o.state === 'rise') {
      const q = clamp01(o.t / 0.6), e = 1 - Math.pow(1 - q, 3);
      o.pivot.position.y = -o.H * 1.05 * (1 - e);
      o.ao.scale.set(o.aoS * e, 1, o.aoS * e);
      if (Math.random() < 0.5 * (1 - q)) dust(o.x, o.y, o.r, 1);
      if (q >= 1) { o.state = 'idle'; o.pivot.position.y = 0; }
    } else if (o.state === 'sink') {
      const q = clamp01(o.t / 0.5);
      o.pivot.position.y = -o.H * 1.05 * q * q;
      o.ao.scale.set(o.aoS * (1 - q), 1, o.aoS * (1 - q));
      if (Math.random() < 0.6) dust(o.x, o.y, o.r, 1);
      if (q >= 1) removeObstacle(o);
    } else if (o.state === 'fall') {
      const pillar = o.kind === PILLAR, t = o.t;
      // lava is thick: once in, things only drift and sink slowly
      const inLava = o.py < LAVA_Y + (pillar ? 0 : o.r * 0.3), drag = inLava ? 0.2 : 1;
      if (pillar) {
        o.ang = Math.min(1.62, 0.06 + 1.9 * t * t);
        o.slide += (20 + 50 * Math.min(t, 1)) * drag * dt;
        if (t > 0.3) o.vy -= 520 * dt;
      } else {
        o.ang += dt * (2.5 + 5 * Math.min(t, 1)) * drag;
        o.slide += (50 + 160 * Math.min(t, 1)) * drag * dt;
        if (Math.hypot(o.x, o.y) + o.slide > R + o.r * 0.2) o.vy -= 900 * dt;
      }
      if (inLava) o.vy = Math.max(o.vy, pillar ? -32 : -45);
      o.py += o.vy * dt;
      const px = o.pivot.position.x, pz = o.pivot.position.z;
      o.pivot.position.set(o.x + o.dx * ((pillar ? o.r * 0.75 : 0) + o.slide), o.py, o.y + o.dz * ((pillar ? o.r * 0.75 : 0) + o.slide));
      obsAxis.set(o.dz, 0, -o.dx);
      o.pivot.quaternion.copy(obsQ.setFromAxisAngle(obsAxis, o.ang));
      const k = clamp01(1 - t * 2.5);
      o.ao.scale.set(o.aoS * k, 1, o.aoS * k);
      // where the column meets the lava: splash on impact, then it burns as it goes under
      const reach = pillar ? o.H * 0.8 * Math.sin(o.ang) : 0;
      const sx = o.pivot.position.x + o.dx * reach, sz = o.pivot.position.z + o.dz * reach;
      if (!o.splashed && (pillar ? o.ang > 1.25 : inLava)) {
        o.splashed = true;
        lavaSplash(sx, sz, pillar ? 1.4 : 0.9);
        addShake(0.25 * Math.max(0, 1 - Math.hypot(sx - cam.x, sz - cam.y) / 800));
      }
      if (o.splashed) {
        for (let k2 = 0; k2 < 2; k2++) {
          const f = Math.random();
          fx.spawn(lerp(px, sx, f) + rand(-o.r, o.r) * 0.6, LAVA_Y + rand(0, 10), lerp(pz, sz, f) + rand(-o.r, o.r) * 0.6, rand(-15, 15), rand(50, 120), rand(-15, 15), rand(0.35, 0.7), rand(16, 28), K_FLAME, 0, 0, 0, 0.95);
        }
        if (Math.random() < 0.25) smoke.spawn(lerp(px, sx, Math.random()), LAVA_Y + 30, lerp(pz, sz, Math.random()), rand(-10, 10), rand(30, 60), rand(-10, 10), rand(1, 1.6), rand(24, 40), K_SMOKE, 0.1, 0.08, 0.07, 0.97);
      } else if (Math.random() < 0.4) dust(o.pivot.position.x, o.pivot.position.z, o.r * 0.5, 1);
      if (o.py < LAVA_Y - o.r * 2.6 - 12 || t > 5) removeObstacle(o);
    }
  }
  if (pebDirty) {
    pebDirty = false;
    let n = 0;
    for (const o of obs.values()) {
      if (o.state === 'fall' || o.state === 'sink') continue;
      for (const [x, y, s, rx, ry] of o.peb) {
        if (n >= 200) break;
        tmpM.compose(tv1.set(x, s * 0.25, y), tq.setFromEuler(te.set(rx, ry, 0)), tv2.setScalar(s));
        pebbles.setMatrixAt(n++, tmpM);
      }
    }
    pebbles.count = n;
    pebbles.instanceMatrix.needsUpdate = true;
  }
  runeMat.color.setRGB(2, 0.55, 0.12).multiplyScalar(0.8 + 0.2 * Math.sin(now / 420));
}

// ---------------- events ----------------
let trauma = 0, shakeT = 0;
const addShake = (v) => { trauma = Math.min(1, trauma + v); };

export function fxEvent(ev, env) {
  if (!ready) return;
  const [type, a, b, c, d] = ev;
  const P = env.P || [];
  const mine = P.find((p) => p[0] === env.myId && p[5] & 1);
  const near = (x, y, R) => Math.max(0, 1 - Math.hypot(x - cam.x, y - cam.y) / R);
  if (type === 'hit') {
    const seek = !!c;
    fx.burst(a, CHEST, b, 16, 280, 0.35, 4, K_SPARK, seek ? 2.4 : 4, seek ? 1.4 : 1.9, seek ? 4 : 0.4, 0.9, 0.6, 400);
    if (seek) fx.burst(a, CHEST, b, 10, 90, 0.45, 22, K_GLOW, 1.4, 0.5, 2.6, 0.9);
    else for (let i = 0; i < 10; i++) fx.spawn(a + rand(-6, 6), CHEST + rand(-6, 6), b + rand(-6, 6), rand(-70, 70), rand(-10, 80), rand(-70, 70), rand(0.3, 0.5), rand(18, 28), K_FLAME, 0, 0, 0, 0.94);
    glows.add(a, CHEST, b, 46, 1.7, 0.8, 0.25, 0.8);
    lightFlash(a, CHEST, b, seek ? 0.7 : 1, seek ? 0.4 : 0.5, seek ? 1 : 0.15, 3, 0.2);
    if (mine && Math.hypot(a - mine[1], b - mine[2]) < 60) addShake(0.3); else addShake(0.1 * near(a, b, 450));
  } else if (type === 'refl') {
    fx.burst(a, CHEST, b, 14, 240, 0.3, 4, K_SPARK, 1.6, 3.2, 4, 0.9);
    ring(a, b, 10, 40, 0.3, 1.2, 2.8, 3.6, 0.25);
  } else if (type === 'shock') {
    const who = nearestWizard(a, b, 40);
    if (who !== null) castBy(who, wiz.get(who).face);
    ring(a, b, c * 0.15, c, 0.45, 1.3, 2.6, 4, 0.16);
    ring(a, b, c * 0.1, c * 0.9, 0.45, 0, 0, 0, 0.2, 0.4, THREE.NormalBlending); // dark refraction band inside the front
    addShockWall(a, b, c, [0.6, 1.4, 2.4]);
    for (let i = 0; i < 40; i++) {
      const ang = Math.random() * TAU, v = c * rand(2, 3.2);
      fx.spawn(a + Math.cos(ang) * 20, rand(6, 50), b + Math.sin(ang) * 20, Math.cos(ang) * v, rand(-10, 40), Math.sin(ang) * v, rand(0.25, 0.4), rand(3, 5), K_SPARK, i % 3 ? 1.8 : 4, i % 3 ? 3 : 4, 4, 0.9);
    }
    for (let i = 0; i < 12; i++) {
      const ang = Math.random() * TAU, v = c * rand(0.7, 1.1);
      smoke.spawn(a, 8, b, Math.cos(ang) * v, rand(5, 20), Math.sin(ang) * v, rand(0.5, 0.8), rand(20, 30), K_SMOKE, 0.3, 0.3, 0.32, 0.9);
    }
    lightFlash(a, 40, b, 0.5, 0.8, 1, 5, 0.3);
    const meHit = mine && Math.hypot(a - mine[1], b - mine[2]) < c + PLAYER_R;
    addShake(meHit ? 0.28 : 0.12 * near(a, b, 600));
  } else if (type === 'boom') {
    addFireball(a, b, c);
    ring(a, b, c * 0.3, c * 1.2, 0.55, 4, 1.4, 0.25, 0.22);
    addShockWall(a, b, c * 1.1, [2.4, 0.8, 0.15]);
    addScorch(a, b, c);
    addDebris(a, b, 18, c * 2.2);
    fx.burst(a, 20, b, 50, c * 3.4, 0.6, 5, K_SPARK, 4, 1.6, 0.3, 0.92, 0.9, 500);
    for (let i = 0; i < 40; i++) {
      const ang = Math.random() * TAU, v = rand(0.3, 1.5) * c;
      fx.spawn(a + Math.cos(ang) * 10, rand(5, 30), b + Math.sin(ang) * 10, Math.cos(ang) * v, rand(40, 200), Math.sin(ang) * v, rand(0.45, 0.9), rand(28, 50), K_FLAME, 0, 0, 0, 0.93);
    }
    for (let i = 0; i < 18; i++) {
      const ang = Math.random() * TAU, v = rand(0.2, 1.1) * c;
      smoke.spawn(a, rand(10, 50), b, Math.cos(ang) * v, rand(30, 110), Math.sin(ang) * v, rand(1.2, 2), rand(36, 60), K_SMOKE, 0.09, 0.07, 0.06, 0.94);
    }
    lightFlash(a, 70, b, 1, 0.5, 0.15, 8, 0.5);
    addShake(0.65 * near(a, b, 850));
  } else if (type === 'blink') {
    const who = nearestWizard(c, d, 60);
    const w = who !== null ? wiz.get(who) : null;
    if (w) { castBy(who, Math.atan2(d - b, c - a)); w.x = c; w.y = d; w.vx = w.vy = 0; }
    const L = Math.hypot(c - a, d - b), n = Math.min(24, Math.ceil(L / 12));
    for (let i = 0; i <= n; i++) { // streak of afterglow along the path
      const q = i / n;
      fx.spawn(lerp(a, c, q), CHEST + rand(-14, 14), lerp(b, d, q), rand(-8, 8), rand(-4, 8), rand(-8, 8), rand(0.25, 0.45), rand(16, 26), K_GLOW, 1.4, 0.7, 2.8, 0.9);
    }
    for (const [x, y, s] of [[a, b, 1], [c, d, 1.3]]) { // flash columns at both ends
      for (let k = 0; k < 7; k++) fx.spawn(x + rand(-8, 8), 8 + k * 12, y + rand(-8, 8), 0, rand(20, 60), 0, rand(0.3, 0.5), 34 * s, K_GLOW, 1.8, 1.0, 3.2, 0.9);
      fx.burst(x, CHEST, y, 14, 200, 0.4, 4, K_SPARK, 2.6, 2, 4, 0.9);
    }
    ring(c, d, 10, 44, 0.3, 1.6, 0.9, 3, 0.25);
    lightFlash(c, 50, d, 0.7, 0.45, 1, 4, 0.3);
  } else if (type === 'lvl') {
    const p = P.find((q) => q[0] === a);
    if (p) {
      ring(p[1], p[2], 20, 60, 0.7, 3.5, 2.6, 0.6, 0.15);
      for (let i = 0; i < 22; i++) {
        const ang = Math.random() * TAU;
        fx.spawn(p[1] + Math.cos(ang) * 24, rand(0, 30), p[2] + Math.sin(ang) * 24, Math.cos(ang) * 15, rand(40, 110), Math.sin(ang) * 15, rand(0.7, 1.1), rand(7, 11), K_GLOW, 3.5, 2.6, 0.5, 0.97);
      }
    }
  } else if (type === 'die') {
    const inLava = Math.hypot(c, d) > U.uR.value;
    const y0 = inLava ? LAVA_Y : 0;
    for (let i = 0; i < 30; i++) fx.spawn(c + rand(-14, 14), y0 + rand(0, 40), d + rand(-14, 14), rand(-100, 100), rand(60, 220), rand(-100, 100), rand(0.5, 0.9), rand(20, 34), K_FLAME, 0, 0, 0, 0.93);
    fx.burst(c, y0 + 30, d, 26, 380, 0.5, 4, K_SPARK, 4, 2, 0.6, 0.9, 0.8, 400);
    for (let i = 0; i < 14; i++) smoke.spawn(c + rand(-10, 10), y0 + rand(10, 40), d + rand(-10, 10), rand(-40, 40), rand(30, 80), rand(-40, 40), rand(1.2, 1.8), rand(24, 40), K_SMOKE, 0.09, 0.07, 0.06, 0.95);
    ring(c, d, 20, 80, 0.5, 4, 0.9, 0.2, 0.18, inLava ? LAVA_Y + 0.6 : 0.5);
    lightFlash(c, y0 + 40, d, 1, 0.4, 0.1, 6, 0.5);
    addShake(a === env.myId ? 0.5 : 0.2 * near(c, d, 600));
  } else if (type === 'crumble') crumbleAt(a, b, c, d);
}

export function resetFx() {
  if (!ready) return;
  fx.clear(); smoke.clear(); nums.length = 0; flashes.length = 0; debrisData.length = 0; trauma = 0; myDanger = 0;
  for (const r of rings) { r.active = false; r.mesh.visible = false; }
  for (const s of scorches) { s.on = false; s.mesh.visible = false; }
  for (const f of [...fireballs, ...shockWalls]) { f.on = false; f.mesh.visible = false; }
  for (const z of zonePool) { z.id = -1; z.decal.visible = z.rock.visible = false; }
  for (const w of wiz.values()) disposeWizard(w);
  wiz.clear(); proj.clear();
  clearObstacles(); // rebuilt (without the rise animation) from the next snapshot
}

// ---------------- per-frame effect updates ----------------
function updateFx(dt, view) {
  // ambient embers drifting up off the lava around the view
  const R = U.uR.value;
  for (let k = 0; k < 3 && fx.ambient < 90; k++) {
    const a = Math.random() * TAU, r = Math.sqrt(Math.random()) * view;
    const x = cam.x + Math.cos(a) * r, z = cam.y + Math.sin(a) * r;
    if (Math.hypot(x, z) < R + 12) continue;
    const hot = Math.random() < 0.6;
    fx.spawn(x, LAVA_Y + 2, z, rand(-12, 12), rand(25, 60), rand(-12, 12), rand(1.6, 3.2), rand(3, 6), K_EMBER, hot ? 3.5 : 2.4, hot ? 1.4 : 0.5, hot ? 0.3 : 0.08, 1);
  }
  // occasional lava bubbles bursting near the rim
  if (Math.random() < 0.08) {
    const a = Math.random() * TAU, rr = R + rand(20, 160), x = Math.cos(a) * rr, z = Math.sin(a) * rr;
    fx.burst(x, LAVA_Y + 1, z, 8, 60, 0.6, 4, K_SPARK, 4, 1.5, 0.3, 0.95, 2.5, 260);
  }
  for (const s of scorches) {
    if (!s.on) continue;
    s.t += dt;
    if (s.t > s.max) { s.on = false; s.mesh.visible = false; continue; }
    const q = s.t / s.max;
    s.mat.uniforms.uA.value = 1 - q * q;
    s.mat.uniforms.uG.value = clamp01(1 - s.t / 2.2) * (0.85 + 0.15 * Math.sin(s.t * 40));
  }
  for (const f of fireballs) {
    if (!f.on) continue;
    f.t += dt;
    if (f.t > f.max) { f.on = false; f.mesh.visible = false; continue; }
    const q = f.t / f.max, s = f.r * (0.3 + 0.6 * (1 - Math.pow(1 - q, 3)));
    f.mesh.scale.set(s, s * 0.7, s); f.mesh.position.y = 8 + 30 * q;
    f.mat.uniforms.uQ.value = q;
  }
  for (const s of shockWalls) {
    if (!s.on) continue;
    s.t += dt;
    if (s.t > s.max) { s.on = false; s.mesh.visible = false; continue; }
    const q = s.t / s.max, e = 1 - Math.pow(1 - q, 3), r = s.r * (0.15 + 0.85 * e);
    s.mesh.scale.set(r, 55 * (1 - q * 0.5), r);
    s.mat.uniforms.uA.value = (1 - q) * 0.55;
  }
  // debris
  let n = 0;
  for (const p of debrisData) {
    p.life -= dt;
    if (p.life <= 0) continue;
    p.vy -= 1100 * dt;
    p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
    const onStone = Math.hypot(p.x, p.z) < R;
    const floor = onStone ? p.s * 0.5 : LAVA_Y - p.s * 0.6;
    if (p.y < floor) {
      p.y = floor;
      if (onStone && p.vy < -120) { p.vy *= -0.3; p.vx *= 0.6; p.vz *= 0.6; } else { p.vy = 0; p.vx *= 0.85; p.vz *= 0.85; p.wx *= 0.8; p.wy *= 0.8; }
      if (!onStone) p.life = Math.min(p.life, 0.4);
    }
    p.rx += p.wx * dt; p.ry += p.wy * dt;
    const sc = p.s * Math.min(1, p.life * 3);
    tmpM.compose(tv1.set(p.x, p.y, p.z), tq.setFromEuler(te.set(p.rx, p.ry, 0)), tv2.setScalar(sc));
    debris.setMatrixAt(n, tmpM);
    if (Math.random() < 0.25 && p.y > 4) fx.spawn(p.x, p.y, p.z, 0, 10, 0, 0.3, 8, K_FLAME, 0, 0, 0, 0.95);
    debrisData[n++] = p;
  }
  debrisData.length = n;
  debris.count = n;
  debris.instanceMatrix.needsUpdate = true;
  updateRings(dt);
  // explosion flashes take the point lights first
  let fn = 0;
  for (const fl of flashes) {
    fl.t += dt;
    if (fl.t >= fl.max) continue;
    flashes[fn++] = fl;
    const q = 1 - fl.t / fl.max;
    candidate(fl.x, fl.y, fl.z, fl.r, fl.g, fl.b, fl.power * q * q + 0.5);
  }
  flashes.length = fn;
}

function applyLights() {
  for (let i = 0; i < lights.length; i++) {
    const l = lights[i];
    if (i < nCand) {
      const c = lightCand[i];
      l.position.set(c.x, Math.max(c.y + 10, 45), c.z); // keep clear of the floor: falloff explodes near 0
      l.color.setRGB(c.r, c.g, c.b);
      const pw = Math.min(c.p, 8);
      l.intensity = 7000 * pw; l.distance = 220 + 40 * pw;
    } else l.intensity = 0;
  }
  nCand = 0;
}

// ---------------- overlay: names, health bars, damage numbers, vignette ----------------
const labelCache = new Map();
function nameLabel(name, isMe) {
  const key = (isMe ? '1' : '0') + name;
  let l = labelCache.get(key);
  if (!l) {
    if (labelCache.size > 200) labelCache.clear();
    const font = '600 26px system-ui, -apple-system, "Segoe UI", sans-serif';
    const m = canvas(1, 1).getContext('2d'); m.font = font;
    const w = Math.ceil(m.measureText(name).width) + 14;
    const c = canvas(w, 36), g = c.getContext('2d');
    g.font = font; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.lineJoin = 'round'; g.lineWidth = 6; g.strokeStyle = 'rgba(0,0,0,0.75)'; g.strokeText(name, w / 2, 18);
    g.fillStyle = isMe ? '#ffe2a8' : '#fff'; g.fillText(name, w / 2, 18);
    l = { c, w: w / 2, h: 18 };
    labelCache.set(key, l);
  }
  return l;
}
const scr = { x: 0, y: 0 };
const lag = new Map();
let vigKey = '', vigGrad = null, dangerGrad = null;
function drawOverlay(ctx, players, roster, myId, dt, now) {
  const k = Math.max(0.75, Math.min(1.25, cam.s / (Math.min(W, H) / 900)));
  for (const p of players) {
    if (!p.alive) continue;
    const w = wiz.get(p.id), info = roster.get(p.id) || { name: '' };
    const h = (w ? w.h : 0) + HEAD;
    if (!toScreen(p.x, p.y, h, scr)) continue;
    if (scr.x < -60 || scr.x > W + 60 || scr.y < -60 || scr.y > H + 60) continue;
    const bw = 44 * k, bh = 5 * k, hx = scr.x - bw / 2, hy = scr.y;
    const hf = clamp01(p.hp / p.maxHp);
    let lf = lag.get(p.id) ?? hf;
    lf = hf > lf ? hf : Math.max(hf, lf - dt * 0.5);
    lag.set(p.id, lf);
    ctx.fillStyle = 'rgba(10,4,2,0.72)'; ctx.fillRect(hx - 1.5, hy - 1.5, bw + 3, bh + 3);
    ctx.fillStyle = '#ffe6c0'; ctx.fillRect(hx, hy, bw * lf, bh);
    ctx.fillStyle = hf > 0.5 ? '#5fd35f' : hf > 0.25 ? '#f0c43a' : '#ff4a32'; ctx.fillRect(hx, hy, bw * hf, bh);
    ctx.fillStyle = 'rgba(255,255,255,0.3)'; ctx.fillRect(hx, hy, bw * hf, 1.5);
    if (info.name) {
      const l = nameLabel(info.name, p.id === myId);
      ctx.drawImage(l.c, scr.x - l.w / 2 * k, hy - 3 - l.h * k, l.w * k, l.h * k);
    }
  }
  if (lag.size > 64) lag.clear();
  if (nums.length) {
    ctx.font = '800 16px system-ui, -apple-system, "Segoe UI", sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.lineJoin = 'round'; ctx.lineWidth = 3.5;
    let nn = 0;
    for (const d of nums) {
      d.t += dt;
      if (d.t >= 0.9) continue;
      nums[nn++] = d;
      const q = d.t / 0.9, pop = 1 + 0.5 * clamp01(1 - d.t * 8);
      if (!toScreen(d.x, d.y, d.h + 40 * (1 - (1 - q) * (1 - q)), scr)) continue;
      ctx.globalAlpha = 1 - q * q * q;
      ctx.save(); ctx.translate(scr.x, scr.y); ctx.scale(pop * k, pop * k);
      ctx.strokeStyle = 'rgba(20,6,2,0.85)'; ctx.strokeText(d.v, 0, 0);
      ctx.fillStyle = d.me ? '#ff6a5a' : '#ffe08a'; ctx.fillText(d.v, 0, 0);
      ctx.restore();
    }
    nums.length = nn;
    ctx.globalAlpha = 1;
  }
  // vignette (pulses red when I'm low or burning)
  const key = W + 'x' + H;
  if (key !== vigKey) {
    vigKey = key;
    const r0 = Math.min(W, H) * 0.38, r1 = Math.hypot(W, H) * 0.62;
    vigGrad = ctx.createRadialGradient(W / 2, H / 2, r0, W / 2, H / 2, r1);
    vigGrad.addColorStop(0, 'rgba(0,0,0,0)'); vigGrad.addColorStop(1, 'rgba(12,3,0,0.5)');
    dangerGrad = ctx.createRadialGradient(W / 2, H / 2, r0 * 0.9, W / 2, H / 2, r1);
    dangerGrad.addColorStop(0, 'rgba(200,20,0,0)'); dangerGrad.addColorStop(1, 'rgba(210,30,0,0.55)');
  }
  ctx.fillStyle = vigGrad; ctx.fillRect(0, 0, W, H);
  if (myDanger > 0.01) {
    ctx.globalAlpha = myDanger * (0.7 + 0.3 * Math.sin(now / 170));
    ctx.fillStyle = dangerGrad; ctx.fillRect(0, 0, W, H);
    ctx.globalAlpha = 1;
  }
}

// ---------------- frame ----------------
// dynamic resolution: mean frame time over ~2 s windows, ignoring stalls (tab switches, screenshots)
let ftSum = 0, ftN = 0, ftLast = 0, lastDrop = -1e9, goodWins = 0;
/**
 * state: { a, b, f, players, radius, now, dt, roster, myId, moveMark }
 * ctx: the 2D overlay context (already cleared by the caller).
 */
let cpuMs = 0;
export function render(state, ctx) {
  if (!ready) return;
  const tStart = performance.now();
  const { a, b, f, players, radius, now, dt, roster, myId, moveMark } = state;
  U.uTime.value = now / 1000; U.uR.value = radius;
  updatePlatform(radius);
  glows.begin();
  meMarker.visible = false;
  myDanger = Math.max(0, myDanger - dt * 2);
  updateWizards(players, roster, myId, dt, now, b.ph, b.w);
  updateProjectiles(a, b, f, now, myId);
  updateZones(a, b, f, dt, now);
  updateObstacles(b.O || [], dt, now);
  const p = camPose();
  updateFx(dt, Math.min(2200, p.d * 1.2));
  fx.update(dt); smoke.update(dt); glows.commit();
  applyLights();

  if (moveMark && now - moveMark.t < 400) {
    const q = (now - moveMark.t) / 400, s = 16 * (1 - q) + 5;
    moveRing.visible = true; moveRing.position.set(moveMark.x, 0.6, moveMark.y); moveRing.scale.set(s, 1, s);
    moveRing.material.uniforms.uA.value = 1 - q;
  } else moveRing.visible = false;

  // camera from camera.js, plus a little shake
  trauma = Math.max(0, trauma - dt * 1.8); shakeT += dt;
  let sx = 0, sz = 0;
  if (!REDUCED_MOTION && trauma > 0) {
    const m = 9 * trauma * trauma / cam.s, t = shakeT;
    sx = m * (Math.sin(t * 47.3) * 0.6 + Math.sin(t * 83.1 + 1.7) * 0.4);
    sz = m * (Math.sin(t * 53.9 + 0.5) * 0.6 + Math.sin(t * 97.7 + 2.3) * 0.4);
  }
  camera.aspect = W / H; camera.fov = FOV;
  camera.near = Math.max(5, p.d * 0.1); camera.far = p.d * 5 + 4000;
  camera.position.set(p.x + sx, p.y, p.z + sz);
  camera.lookAt(cam.x + sx, 0, cam.y + sz);
  camera.updateProjectionMatrix();
  pScale.value = (H * pixelRatio) / (2 * Math.tan(FOV * Math.PI / 360));

  // lava plane follows the view; key light + its shadow box follow the look point
  lava.position.set(cam.x, LAVA_Y, cam.y);
  lava.scale.setScalar(p.d * 8 + 4000);
  const half = Math.min(1500, p.d * 0.95);
  keyLight.position.set(cam.x - 380, 1000, cam.y - 300);
  keyLight.target.position.set(cam.x, 0, cam.y);
  const sc = keyLight.shadow.camera;
  if (Math.abs(sc.right - half) > 1) { sc.left = -half; sc.right = half; sc.top = half; sc.bottom = -half; sc.near = 100; sc.far = 2600; sc.updateProjectionMatrix(); }

  renderer.info.reset();
  composer.render();

  drawOverlay(ctx, players, roster, myId, dt, now);
  cpuMs = lerp(cpuMs, performance.now() - tStart, 0.05);
  adapt();
}

// dynamic resolution: keep the frame rate up by trading pixel ratio, then bloom
function adapt() {
  const t = performance.now(), d = t - ftLast;
  ftLast = t;
  if (document.hidden || d > 100 || !adaptOn) return;
  ftSum += d; ftN++;
  if (ftSum < 2000) return;
  const mean = ftSum / ftN;
  ftSum = ftN = 0;
  if (mean > 18) { // below ~55 fps: fewer pixels first, then no bloom
    goodWins = 0; lastDrop = t;
    if (pixelRatio > 1) setPR(Math.max(1, pixelRatio > 1.5 ? 1.5 : pixelRatio - 0.25));
    else if (bloom.enabled) { bloom.enabled = false; console.info('[malfred] 3D: bloom off to hold the frame rate'); }
  } else if (mean < 17.2 && pixelRatio < maxPR && ++goodWins >= 10 && t - lastDrop > 60000) {
    goodWins = 0; setPR(Math.min(maxPR, pixelRatio + 0.25)); // try a step back up, at most once a minute
  }
}
function setPR(pr) {
  pixelRatio = pr;
  renderer.setPixelRatio(pr);
  setMSAA();
  composer.setPixelRatio(pr);
  resize();
}
// MSAA only at 1x: above that the pixel density hides aliasing and the resolve isn't worth it
function setMSAA() {
  const n = pixelRatio > 1 ? 0 : 4;
  for (const rt of [composer.renderTarget1, composer.renderTarget2]) {
    if (rt.samples !== n) { rt.samples = n; rt.dispose(); }
  }
}

function resize() {
  W = innerWidth; H = innerHeight;
  renderer.setSize(W, H, false);
  if (composer) composer.setSize(W, H);
}

// perf experiments from the console: (await import('/render3d.js')).debug.set({ bloom: false })
export const debug = {
  set(o) {
    if ('bloom' in o) bloom.enabled = o.bloom;
    if ('shadows' in o) { keyLight.castShadow = o.shadows; }
    if ('lava' in o) lava.visible = o.lava;
    if ('pr' in o) { maxPR = o.pr; setPR(o.pr); }
    if ('adapt' in o) adaptOn = o.adapt;
    return stats();
  },
};
let adaptOn = true;

export function setActive(on) {
  active = on;
  if (renderer) renderer.domElement.hidden = !on;
  if (!on && ready) clearObstacles();
}
export const stats = () => ({ cpuMs: +cpuMs.toFixed(2), pixelRatio, bloom: !!bloom?.enabled, particles: fx ? fx.n + smoke.n : 0, ready, calls: renderer?.info.render.calls, tris: renderer?.info.render.triangles });

export async function init(canvasEl) {
  try {
    renderer = new THREE.WebGLRenderer({ canvas: canvasEl, antialias: false, powerPreference: 'high-performance', stencil: false });
  } catch (e) {
    console.warn('[malfred] WebGL unavailable, using the 2D renderer', e);
    return false;
  }
  maxPR = Math.min(2, devicePixelRatio || 1);
  pixelRatio = maxPR;
  renderer.setPixelRatio(pixelRatio);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.info.autoReset = false;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  buildScene();
  W = innerWidth; H = innerHeight;
  const rt = new THREE.WebGLRenderTarget(W * pixelRatio, H * pixelRatio, { type: THREE.HalfFloatType, samples: 4 });
  composer = new EffectComposer(renderer, rt);
  composer.setPixelRatio(pixelRatio);
  setMSAA();
  renderPass = new RenderPass(scene, camera);
  bloom = new UnrealBloomPass(new THREE.Vector2(W, H), 0.3, 0.35, 1.0);
  // bloom is a soft blur anyway: run its mip chain at half the drawing-buffer size
  const bloomSize = bloom.setSize.bind(bloom);
  bloom.setSize = (w, h) => bloomSize(Math.max(1, w >> 1), Math.max(1, h >> 1));
  // never let an over-bright pixel (Inf in the half-float buffer) into the bloom blur,
  // where it would turn into NaN and smear black blocks across the screen
  const hp = bloom.materialHighPassFilter;
  hp.fragmentShader = hp.fragmentShader.replace('vec4 texel = texture2D( tDiffuse, vUv );',
    'vec4 texel = clamp( texture2D( tDiffuse, vUv ), vec4( 0.0 ), vec4( 48.0 ) );');
  hp.needsUpdate = true;
  composer.addPass(renderPass); composer.addPass(bloom); composer.addPass(new OutputPass());
  resize();
  addEventListener('resize', () => { if (renderer) resize(); });

  gltf = await new GLTFLoader().loadAsync('models/mage.glb');
  let src = null;
  gltf.scene.traverse((o) => { if (o.isMesh && !src) src = o.material; });
  atlas = src.map;
  baseMat = new THREE.MeshStandardMaterial({ map: atlas, roughness: 0.75, metalness: 0 });
  const clip = (n) => gltf.animations.find((c) => c.name === n);
  CL.idleL = split(clip('Idle'), false, 'idleL'); CL.idleU = split(clip('Idle'), true, 'idleU');
  CL.runL = split(clip('Running_A'), false, 'runL'); CL.runU = split(clip('Running_A'), true, 'runU');
  CL.cast = split(clip('Spellcast_Shoot'), true, 'cast');
  CL.hit = split(clip('Hit_A'), true, 'hit');
  CL.knock = clip('Dodge_Backward'); CL.tumble = clip('Jump_Idle');
  CL.dieA = clip('Death_A'); CL.dieB = clip('Death_B'); CL.cheer = clip('Cheer');
  renderer.compile(scene, camera);
  ready = true;
  setActive(active);
  return true;
}
