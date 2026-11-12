// Sound effects: recorded CC0 samples (public/sfx, see public/sfx/CREDITS.txt) for
// impacts, procedural Web Audio synthesis for casts and UI, and as the fallback
// while samples load. Positional: volume falls off with distance from the
// listener (camera centre) and pans left/right.

let ac = null, master = null, noiseBuf = null, crackleBuf = null, sizzle = null;
let muted = false;
try { muted = localStorage.getItem('malfred-muted') === '1'; } catch {}
const listener = { x: 0, y: 0, s: 1, w: 1000 };

function init() {
  if (ac) return;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return;
  ac = new AC();
  master = ac.createGain();
  master.gain.value = muted ? 0 : 0.55;
  // gentle limiter so a pile of meteors doesn't clip
  const comp = ac.createDynamicsCompressor();
  comp.threshold.value = -14; comp.ratio.value = 6;
  master.connect(comp).connect(ac.destination);
  noiseBuf = ac.createBuffer(1, ac.sampleRate * 1.5, ac.sampleRate);
  const d = noiseBuf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  loadSamples();
  // fire crackle: sparse random pops, each a tiny decaying noise burst
  crackleBuf = ac.createBuffer(1, ac.sampleRate * 2, ac.sampleRate);
  const c = crackleBuf.getChannelData(0);
  for (let n = 0; n < 160; n++) {
    const at = Math.floor(Math.random() * (c.length - 600)), len = 40 + Math.random() * 400, amp = 0.3 + Math.random() * 0.7;
    for (let i = 0; i < len; i++) c[at + i] += (Math.random() * 2 - 1) * amp * Math.exp(-i / (len / 4));
  }
}
// browsers only allow audio after a user gesture
for (const ev of ['pointerdown', 'keydown']) {
  addEventListener(ev, () => { init(); if (ac && ac.state === 'suspended') ac.resume(); }, { capture: true });
}

export function isMuted() { return muted; }
export function toggleMute() {
  muted = !muted;
  try { localStorage.setItem('malfred-muted', muted ? '1' : '0'); } catch {}
  if (master) master.gain.setTargetAtTime(muted ? 0 : 0.55, ac.currentTime, 0.02);
  return muted;
}
export function setListener(x, y, s, w) { listener.x = x; listener.y = y; listener.s = s; listener.w = w; }

// output node for a sound at world (x, y); null when too far away to hear
function out(x, y, vol = 1) {
  if (!ac || muted || ac.state !== 'running') return null;
  let g = vol, pan = 0;
  if (x !== undefined) {
    const half = listener.w / 2 / listener.s; // half the visible width in world units
    const dx = x - listener.x, dist = Math.hypot(dx, y - listener.y);
    g *= 1 / (1 + Math.max(0, dist - half * 0.6) / (half * 0.6));
    if (g < 0.04) return null;
    pan = Math.max(-0.8, Math.min(0.8, dx / (half * 1.4)));
  }
  const gain = ac.createGain(); gain.gain.value = g;
  if (ac.createStereoPanner) {
    const p = ac.createStereoPanner(); p.pan.value = pan;
    gain.connect(p).connect(master);
  } else gain.connect(master);
  return gain;
}

function env(param, t, peak, attack, decay) {
  param.setValueAtTime(0.0001, t);
  param.exponentialRampToValueAtTime(peak, t + attack);
  param.exponentialRampToValueAtTime(0.0001, t + attack + decay);
}

function tone(dest, { type = 'sine', f0, f1 = f0, dur, vol = 0.5, attack = 0.005, delay = 0 }) {
  const t = ac.currentTime + delay;
  const o = ac.createOscillator(), g = ac.createGain();
  o.type = type;
  o.frequency.setValueAtTime(f0, t);
  if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(f1, t + dur);
  env(g.gain, t, vol, attack, dur);
  o.connect(g).connect(dest);
  o.start(t); o.stop(t + attack + dur + 0.05);
}

function noise(dest, { dur, vol = 0.5, type = 'lowpass', f0 = 1200, f1 = f0, q = 0.8, attack = 0.005, delay = 0 }) {
  const t = ac.currentTime + delay;
  const s = ac.createBufferSource(); s.buffer = noiseBuf;
  s.playbackRate.value = 0.8 + Math.random() * 0.4;
  const f = ac.createBiquadFilter(); f.type = type; f.Q.value = q;
  f.frequency.setValueAtTime(f0, t);
  if (f1 !== f0) f.frequency.exponentialRampToValueAtTime(f1, t + dur);
  const g = ac.createGain();
  env(g.gain, t, vol, attack, dur);
  s.connect(f).connect(g).connect(dest);
  s.start(t, Math.random() * 0.5); s.stop(t + attack + dur + 0.05);
}

// burst of fire crackle (sparse pops), optionally high-passed for a brighter sizzle
function crackle(dest, { dur, vol = 0.5, f = 1500, attack = 0.01, delay = 0 }) {
  const t = ac.currentTime + delay;
  const s = ac.createBufferSource(); s.buffer = crackleBuf;
  s.playbackRate.value = 0.8 + Math.random() * 0.5;
  const hp = ac.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = f;
  const g = ac.createGain();
  env(g.gain, t, vol, attack, dur);
  s.connect(hp).connect(g).connect(dest);
  s.start(t, Math.random() * 1.2); s.stop(t + attack + dur + 0.05);
}

// tone with vibrato (wobbly, magical)
function warble(dest, { type = 'sine', f0, f1 = f0, dur, vol = 0.3, rate = 7, depth = 0.03, attack = 0.02, delay = 0 }) {
  const t = ac.currentTime + delay;
  const o = ac.createOscillator(), lfo = ac.createOscillator(), lg = ac.createGain(), g = ac.createGain();
  o.type = type;
  o.frequency.setValueAtTime(f0, t);
  if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(f1, t + dur);
  lfo.frequency.value = rate; lg.gain.value = f0 * depth;
  lfo.connect(lg).connect(o.frequency);
  env(g.gain, t, vol, attack, dur);
  o.connect(g).connect(dest);
  o.start(t); lfo.start(t); o.stop(t + attack + dur + 0.05); lfo.stop(t + attack + dur + 0.05);
}

// crystal / bell: inharmonic partials with long decays
function bell(dest, { f, dur = 0.8, vol = 0.2, delay = 0 }) {
  [[1, 1], [2.76, 0.5], [5.4, 0.25], [8.93, 0.12]].forEach(([m, a]) =>
    tone(dest, { type: 'sine', f0: f * m, dur: dur / Math.sqrt(m), vol: vol * a, attack: 0.002, delay }));
}

const jit = (v, r = 0.08) => v * (1 + (Math.random() - 0.5) * 2 * r);

// ---------------- recorded samples ----------------
const SAMPLE_NAMES = ['fire_hit1', 'fire_hit2', 'fire_hit3', 'meteor', 'meteor_low', 'lava_death',
  'shock', 'ward', 'reflect', 'wisp_hit', 'blink', 'levelup'];
const samples = {};
function loadSamples() {
  for (const n of SAMPLE_NAMES) {
    fetch(`sfx/${n}.m4a`).then((r) => (r.ok ? r.arrayBuffer() : Promise.reject()))
      .then((b) => ac.decodeAudioData(b)).then((buf) => { samples[n] = buf; }).catch(() => {});
  }
}
// play a sample (random pick from a list) into dest; false if not loaded yet
function play(names, dest, { vol = 1, rate = 1, vary = 0.06, delay = 0 } = {}) {
  const list = Array.isArray(names) ? names : [names];
  const buf = samples[list[Math.floor(Math.random() * list.length)]];
  if (!buf) return false;
  const s = ac.createBufferSource(); s.buffer = buf;
  s.playbackRate.value = rate * (1 + (Math.random() - 0.5) * 2 * vary);
  const g = ac.createGain(); g.gain.value = vol;
  s.connect(g).connect(dest);
  s.start(ac.currentTime + delay);
  return true;
}
const FIRE_HITS = ['fire_hit1', 'fire_hit2', 'fire_hit3'];

// ---------------- the sounds ----------------
export const sfx = {
  // Cinder Bolt: a fireball whooshing out of the staff
  bolt(x, y) { const o = out(x, y, 0.55); if (!o) return;
    noise(o, { dur: 0.32, vol: 0.7, type: 'bandpass', f0: jit(500), f1: 1600, q: 0.9, attack: 0.03 });
    noise(o, { dur: 0.25, vol: 0.5, f0: 900, f1: 250, attack: 0.01 });
    tone(o, { type: 'sine', f0: jit(150), f1: 70, dur: 0.18, vol: 0.35 });
    crackle(o, { dur: 0.35, vol: 0.6, f: 1800 }); },
  // Seeker Wisp: an airy, wobbling spirit released
  seeker(x, y) { const o = out(x, y, 0.5); if (!o) return;
    warble(o, { f0: jit(440), f1: 880, dur: 0.6, vol: 0.18, rate: 9, depth: 0.05, attack: 0.08 });
    warble(o, { f0: jit(660), f1: 1320, dur: 0.55, vol: 0.1, rate: 11, depth: 0.05, attack: 0.1, delay: 0.04 });
    noise(o, { dur: 0.5, vol: 0.25, type: 'highpass', f0: 4000, attack: 0.15 });
    bell(o, { f: jit(1760, 0.03), dur: 0.5, vol: 0.06, delay: 0.1 }); },
  // impacts: fireball bursts into flame; wisp pops with a chime
  hit(x, y, seeker) { const o = out(x, y, 0.85); if (!o) return;
    if (play(seeker ? 'wisp_hit' : FIRE_HITS, o, { vol: seeker ? 0.8 : 0.9 })) {
      if (!seeker) tone(o, { type: 'sine', f0: jit(120), f1: 45, dur: 0.2, vol: 0.4 }); // body thump
      return;
    }
    if (seeker) {
      tone(o, { type: 'sine', f0: jit(900), f1: 200, dur: 0.15, vol: 0.4 });
      bell(o, { f: jit(1200, 0.03), dur: 0.5, vol: 0.12 });
      noise(o, { dur: 0.2, vol: 0.35, type: 'bandpass', f0: 3000, f1: 800, q: 1 });
    } else {
      tone(o, { type: 'sine', f0: jit(120), f1: 45, dur: 0.22, vol: 0.7 });
      noise(o, { dur: 0.4, vol: 0.8, f0: 3500, f1: 300, attack: 0.002 });
      crackle(o, { dur: 0.6, vol: 0.7, f: 1200, attack: 0.02 });
    } },
  // Mirror Ward reflect: crystal ping
  reflect(x, y) { const o = out(x, y, 0.65); if (!o) return;
    if (play('reflect', o, { vol: 0.8, vary: 0.1 })) return;
    bell(o, { f: jit(1900, 0.04), dur: 0.7, vol: 0.3 });
    noise(o, { dur: 0.06, vol: 0.3, type: 'highpass', f0: 5000 }); },
  // Shockwave: a deep thump and a rush of air outward
  shock(x, y) { const o = out(x, y, 0.95); if (!o) return;
    tone(o, { type: 'sine', f0: 95, f1: 32, dur: 0.45, vol: 0.9, attack: 0.003 });
    if (play('shock', o, { vol: 0.9, rate: 1.15 })) return;
    noise(o, { dur: 0.55, vol: 0.75, type: 'bandpass', f0: 2600, f1: 220, q: 0.5, attack: 0.005 });
    noise(o, { dur: 0.12, vol: 0.4, f0: 6000, f1: 800 }); },
  // Meteor cast: a rising roar and whistle as it falls; lands with boom()
  meteorCast(x, y, delay) { const o = out(x, y, 0.65); if (!o) return;
    noise(o, { dur: delay * 0.25, vol: 0.55, f0: 300, f1: 1400, attack: delay * 0.8 });
    tone(o, { type: 'sine', f0: 1400, f1: 300, dur: delay * 0.25, vol: 0.12, attack: delay * 0.75 });
    crackle(o, { dur: delay * 0.2, vol: 0.4, f: 1500, attack: delay * 0.8 }); },
  // Meteor impact: explosion, debris and a lingering rumble
  boom(x, y) { const o = out(x, y, 1); if (!o) return;
    if (play('meteor', o, { vol: 1 })) { play('meteor_low', o, { vol: 1, vary: 0.04 }); return; }
    tone(o, { type: 'sine', f0: 90, f1: 24, dur: 0.9, vol: 1, attack: 0.002 });
    noise(o, { dur: 1.1, vol: 1, f0: 2800, f1: 90, attack: 0.002 });
    noise(o, { dur: 0.07, vol: 0.6, type: 'highpass', f0: 2500 });
    crackle(o, { dur: 1.3, vol: 0.8, f: 900, attack: 0.05 });
    noise(o, { dur: 1.4, vol: 0.4, f0: 160, f1: 60, attack: 0.15, delay: 0.1 }); },
  // Blink: a sucking warp out and a pop in
  blink(x, y) { const o = out(x, y, 0.6); if (!o) return;
    if (play('blink', o, { vol: 0.8, rate: 1.2 })) return;
    warble(o, { type: 'triangle', f0: jit(250), f1: 1600, dur: 0.18, vol: 0.25, rate: 30, depth: 0.15, attack: 0.12 });
    noise(o, { dur: 0.05, vol: 0.4, type: 'bandpass', f0: 1800, q: 2, attack: 0.13 });
    tone(o, { type: 'sine', f0: 1500, f1: 500, dur: 0.12, vol: 0.2, delay: 0.14 }); },
  // Mirror Ward: shimmering crystal shield forming
  ward() { const o = out(undefined, undefined, 0.5); if (!o) return;
    if (play('ward', o, { vol: 0.8 })) return;
    [1320, 1660, 1980].forEach((f, i) => bell(o, { f, dur: 0.9, vol: 0.12, delay: i * 0.05 }));
    noise(o, { dur: 0.5, vol: 0.2, type: 'highpass', f0: 6000, attack: 0.08 }); },
  // knocked out: plunge into lava, a hiss of steam and flames
  die(x, y, mine) { const o = out(mine ? undefined : x, y, mine ? 1 : 0.8); if (!o) return;
    if (play('lava_death', o, { vol: 1 })) { noise(o, { dur: 0.9, vol: 0.35, type: 'highpass', f0: 3000, attack: 0.05 }); return; }
    tone(o, { type: 'sine', f0: 140, f1: 40, dur: 0.4, vol: 0.6 });
    noise(o, { dur: 0.9, vol: 0.6, type: 'highpass', f0: 3000, attack: 0.05 });
    noise(o, { dur: 1.0, vol: 0.6, f0: 1200, f1: 200, attack: 0.03 });
    crackle(o, { dur: 1.2, vol: 0.8, f: 1000, attack: 0.05 }); },
  // UI-ish feedback for you
  kill() { const o = out(undefined, undefined, 0.6); if (!o) return;
    [660, 880, 1320].forEach((f, i) => tone(o, { type: 'triangle', f0: f, dur: 0.18, vol: 0.22, delay: i * 0.06 })); },
  level() { const o = out(undefined, undefined, 0.6); if (!o) return;
    if (play('levelup', o, { vol: 0.7, vary: 0 })) return;
    [523, 659, 784, 1047].forEach((f, i) => bell(o, { f, dur: 0.7, vol: 0.18, delay: i * 0.08 })); },
  upgrade() { const o = out(undefined, undefined, 0.5); if (!o) return;
    bell(o, { f: 1568, dur: 0.35, vol: 0.15 }); },
  denied() { const o = out(undefined, undefined, 0.35); if (!o) return;
    tone(o, { type: 'square', f0: 140, dur: 0.07, vol: 0.1 }); },
  countdown(last) { const o = out(undefined, undefined, 0.5); if (!o) return;
    if (last) { bell(o, { f: 1046, dur: 1, vol: 0.3 }); crackle(o, { dur: 0.5, vol: 0.4 }); }
    else tone(o, { type: 'sine', f0: 523, dur: 0.12, vol: 0.3 }); },
  win() { const o = out(undefined, undefined, 0.7); if (!o) return;
    [523, 659, 784, 1047, 784, 1047].forEach((f, i) => tone(o, { type: 'triangle', f0: f, dur: i === 5 ? 0.6 : 0.16, vol: 0.25, delay: i * 0.12 })); },
};

// looping lava sizzle while my wizard burns
export function setSizzle(on) {
  if (!ac || ac.state !== 'running') return;
  if (on && !sizzle) {
    const s = ac.createBufferSource(); s.buffer = noiseBuf; s.loop = true;
    const f = ac.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = 2500;
    const g = ac.createGain(); g.gain.value = 0.0001;
    g.gain.setTargetAtTime(0.25, ac.currentTime, 0.05);
    const c = ac.createBufferSource(); c.buffer = crackleBuf; c.loop = true;
    s.connect(f).connect(g); c.connect(g); g.connect(master); s.start(); c.start();
    sizzle = { s, c, g };
  } else if (!on && sizzle) {
    const { s, c, g } = sizzle; sizzle = null;
    g.gain.setTargetAtTime(0.0001, ac.currentTime, 0.08);
    s.stop(ac.currentTime + 0.4); c.stop(ac.currentTime + 0.4);
  }
}
