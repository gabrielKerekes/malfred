// Procedural sound effects (Web Audio, no asset files). Positional: volume falls
// off with distance from the listener (camera centre) and pans left/right.

let ac = null, master = null, noiseBuf = null, sizzle = null;
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

const jit = (v, r = 0.08) => v * (1 + (Math.random() - 0.5) * 2 * r);

// ---------------- the sounds ----------------
export const sfx = {
  bolt(x, y) { const o = out(x, y, 0.5); if (!o) return;
    noise(o, { dur: 0.18, vol: 0.5, type: 'bandpass', f0: jit(2600), f1: 900, q: 1.5 });
    tone(o, { type: 'triangle', f0: jit(700), f1: 260, dur: 0.14, vol: 0.25 }); },
  seeker(x, y) { const o = out(x, y, 0.5); if (!o) return;
    tone(o, { type: 'sine', f0: jit(500), f1: 1300, dur: 0.35, vol: 0.25, attack: 0.04 });
    tone(o, { type: 'sine', f0: jit(760), f1: 1950, dur: 0.3, vol: 0.12, attack: 0.04, delay: 0.03 }); },
  hit(x, y, seeker) { const o = out(x, y, 0.8); if (!o) return;
    noise(o, { dur: 0.16, vol: 0.7, f0: 3000, f1: 400 });
    tone(o, { type: 'square', f0: jit(seeker ? 520 : 220), f1: 70, dur: 0.12, vol: 0.18 }); },
  reflect(x, y) { const o = out(x, y, 0.6); if (!o) return;
    tone(o, { type: 'triangle', f0: jit(1500), f1: 2400, dur: 0.18, vol: 0.3 });
    tone(o, { type: 'sine', f0: jit(2250), dur: 0.25, vol: 0.12, delay: 0.02 }); },
  shock(x, y) { const o = out(x, y, 0.9); if (!o) return;
    tone(o, { type: 'sine', f0: 160, f1: 40, dur: 0.35, vol: 0.8 });
    noise(o, { dur: 0.4, vol: 0.5, type: 'bandpass', f0: 600, f1: 3000, q: 0.7, attack: 0.01 }); },
  meteorCast(x, y, delay) { const o = out(x, y, 0.6); if (!o) return;
    // falling whistle that lands as the meteor does
    tone(o, { type: 'sine', f0: 1800, f1: 260, dur: delay, vol: 0.18, attack: 0.05 });
    noise(o, { dur: delay, vol: 0.18, type: 'bandpass', f0: 3000, f1: 500, q: 3, attack: delay * 0.6 }); },
  boom(x, y) { const o = out(x, y, 1); if (!o) return;
    tone(o, { type: 'sine', f0: 110, f1: 28, dur: 0.7, vol: 1 });
    noise(o, { dur: 0.9, vol: 0.9, f0: 1800, f1: 120, attack: 0.003 });
    noise(o, { dur: 0.08, vol: 0.6, type: 'highpass', f0: 2000 }); },
  blink(x, y) { const o = out(x, y, 0.6); if (!o) return;
    tone(o, { type: 'sine', f0: jit(300), f1: 1500, dur: 0.16, vol: 0.3 });
    tone(o, { type: 'sine', f0: jit(1500), f1: 600, dur: 0.14, vol: 0.18, delay: 0.12 }); },
  ward() { const o = out(undefined, undefined, 0.5); if (!o) return;
    tone(o, { type: 'triangle', f0: 880, f1: 1320, dur: 0.3, vol: 0.2, attack: 0.02 });
    tone(o, { type: 'sine', f0: 1320, dur: 0.45, vol: 0.12, attack: 0.05, delay: 0.05 }); },
  die(x, y, mine) { const o = out(mine ? undefined : x, y, mine ? 1 : 0.8); if (!o) return;
    noise(o, { dur: 0.8, vol: 0.7, type: 'bandpass', f0: 1600, f1: 200, q: 0.6, attack: 0.02 });
    tone(o, { type: 'sawtooth', f0: 330, f1: 55, dur: 0.6, vol: 0.18 }); },
  kill() { const o = out(undefined, undefined, 0.6); if (!o) return;
    [660, 880, 1320].forEach((f, i) => tone(o, { type: 'triangle', f0: f, dur: 0.18, vol: 0.25, delay: i * 0.06 })); },
  level() { const o = out(undefined, undefined, 0.6); if (!o) return;
    [523, 659, 784, 1047].forEach((f, i) => tone(o, { type: 'triangle', f0: f, dur: 0.22, vol: 0.22, delay: i * 0.07 })); },
  upgrade() { const o = out(undefined, undefined, 0.5); if (!o) return;
    tone(o, { type: 'square', f0: 990, f1: 1480, dur: 0.07, vol: 0.12 }); },
  denied() { const o = out(undefined, undefined, 0.35); if (!o) return;
    tone(o, { type: 'square', f0: 140, dur: 0.07, vol: 0.12 }); },
  countdown(last) { const o = out(undefined, undefined, 0.5); if (!o) return;
    tone(o, { type: 'sine', f0: last ? 1046 : 523, dur: last ? 0.4 : 0.12, vol: 0.3 }); },
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
    s.connect(f).connect(g).connect(master); s.start();
    sizzle = { s, g };
  } else if (!on && sizzle) {
    const { s, g } = sizzle; sizzle = null;
    g.gain.setTargetAtTime(0.0001, ac.currentTime, 0.08);
    s.stop(ac.currentTime + 0.4);
  }
}
