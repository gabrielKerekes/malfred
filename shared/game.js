// Authoritative game simulation. Pure JS: runs on the server, and the client
// imports the constants (SPELLS, TICK) for its HUD.

export const TICK = 30;
export const DT = 1 / TICK;
export const PLAYER_R = 18;
export const BASE_HP = 100;
export const BASE_SPEED = 230;

// level 0 = locked. cd in seconds.
export const SPELLS = {
  bolt: {
    key: 'Q', name: 'Cinder Bolt', max: 5, start: 1,
    desc: 'Fast bolt that damages and knocks back the first enemy hit.',
    cd: () => 1.1, dmg: (l) => 6 + 2 * l, kb: (l) => 340 + 45 * l, speed: 640, life: 1.1, r: 10,
  },
  seeker: {
    key: 'W', name: 'Seeker Wisp', max: 4, start: 0,
    desc: 'Slow wisp that homes in on the nearest enemy.',
    cd: (l) => 8 - 0.5 * l, dmg: (l) => 8 + 3 * l, kb: (l) => 400 + 60 * l, speed: 300, life: 4, r: 13,
  },
  shock: {
    key: 'E', name: 'Shockwave', max: 4, start: 0,
    desc: 'Blast around you: shoves enemies away and turns their projectiles.',
    cd: (l) => 9.5 - 0.5 * l, dmg: (l) => 4 + 2 * l, kb: (l) => 520 + 80 * l, radius: (l) => 140 + 15 * l,
  },
  meteor: {
    key: 'R', name: 'Meteor', max: 4, start: 0,
    desc: 'Calls a meteor on the target spot after a short delay. Huge knockback.',
    cd: (l) => 11.5 - 0.5 * l, dmg: (l) => 14 + 5 * l, kb: (l) => 600 + 80 * l, radius: (l) => 105 + 10 * l,
    delay: 0.9, range: 620,
  },
  blink: {
    key: 'D', name: 'Blink', max: 4, start: 0,
    desc: 'Teleport a short distance toward the cursor.',
    cd: (l) => 11 - l, range: (l) => 230 + 45 * l,
  },
  ward: {
    key: 'F', name: 'Mirror Ward', max: 4, start: 0,
    desc: 'Brief shield that reflects projectiles and halves blast knockback.',
    cd: (l) => 12.5 - l, dur: (l) => 1.0 + 0.25 * l,
  },
  vigor: {
    key: '1', name: 'Vigor', max: 5, start: 0, passive: true,
    desc: '+15 max health per level.',
  },
  swift: {
    key: '2', name: 'Swiftness', max: 5, start: 0, passive: true,
    desc: '+6% movement speed per level.',
  },
};
export const SPELL_KEYS = Object.keys(SPELLS);

const COLORS = ['#ff5a4d', '#4da6ff', '#5fd35f', '#ffcc33', '#c77dff', '#ff8fd0',
  '#33d6c9', '#ff9933', '#b0e04a', '#8fa3ff', '#e0e0e0', '#c98a5a'];
const BOT_NAMES = ['Ashka', 'Brimm', 'Cindra', 'Dross', 'Emberly', 'Fumo', 'Grit', 'Halcyn',
  'Ignar', 'Jett', 'Kiln', 'Lumen', 'Morrow', 'Nox', 'Pyra', 'Scoria'];

const rnd = Math.random;
const hyp = Math.hypot;

export class Game {
  constructor(mode, opts = {}) {
    this.mode = mode; // 'brawl' | 'rounds'
    this.allSpells = !!opts.allSpells; // dev/testing: humans start with every spell maxed
    this.tick = 0;
    this.players = new Map();
    this.projs = [];
    this.zones = [];
    this.events = [];
    this.nextId = 1;
    this.phase = mode === 'brawl' ? 'play' : 'lobby';
    this.phaseT = 0;
    this.playT = 0;
    this.round = 0;
    this.radius = 500;
    this.winner = 0;
    this.lastDead = 0;
    this.targetScore = 5;
    this.dirty = true;
  }

  // ---------- players ----------
  addPlayer(name, bot = false) {
    const id = this.nextId++;
    const used = new Set([...this.players.values()].map((p) => p.color));
    const color = COLORS.find((c) => !used.has(c)) || COLORS[id % COLORS.length];
    if (bot) {
      const names = new Set([...this.players.values()].map((p) => p.name));
      name = BOT_NAMES.find((n) => !names.has(n)) || 'Bot ' + id;
    }
    const p = {
      id, name, color, bot, x: 0, y: 0, vx: 0, vy: 0, tx: null, ty: null, mvx: 0, mvy: 0,
      face: 0, hp: BASE_HP, maxHp: BASE_HP, alive: false, ward: 0, lava: false,
      cd: {}, lv: {}, pts: 0, score: 0, kills: 0, deaths: 0, level: 1, xp: 0,
      lastHitBy: 0, lastHitTick: -999, respawn: 0,
    };
    this.resetBuild(p);
    this.players.set(id, p);
    if (this.mode === 'brawl') this.spawn(p);
    this.dirty = true;
    return p;
  }

  removePlayer(id) {
    this.players.delete(id);
    this.dirty = true;
  }

  resetBuild(p) {
    for (const k of SPELL_KEYS) { p.lv[k] = SPELLS[k].start; p.cd[k] = 0; }
    p.pts = this.mode === 'brawl' ? 2 : 3;
    p.level = 1; p.xp = 0; p.maxHp = BASE_HP;
    if (this.allSpells && !p.bot) {
      for (const k of SPELL_KEYS) p.lv[k] = SPELLS[k].max;
      p.maxHp += 15 * SPELLS.vigor.max;
    }
  }

  spawn(p, x, y) {
    if (x === undefined) {
      const a = rnd() * Math.PI * 2, r = this.radius * 0.55 * Math.sqrt(rnd());
      x = Math.cos(a) * r; y = Math.sin(a) * r;
    }
    p.x = x; p.y = y; p.vx = p.vy = 0; p.tx = p.ty = null;
    p.hp = p.maxHp; p.alive = true; p.lava = false;
    p.ward = this.mode === 'brawl' ? Math.round(1.5 * TICK) : 0;
    p.lastHitBy = 0;
    for (const k of SPELL_KEYS) p.cd[k] = 0;
  }

  // ---------- inputs ----------
  setMove(id, x, y) {
    const p = this.players.get(id);
    if (!p || !p.alive || this.phase !== 'play') return;
    p.tx = x; p.ty = y;
  }

  stop(id) {
    const p = this.players.get(id);
    if (p) p.tx = p.ty = null;
  }

  upgrade(id, k) {
    const p = this.players.get(id), def = SPELLS[k];
    if (!p || !def || p.pts < 1 || p.lv[k] >= def.max) return;
    p.pts--; p.lv[k]++;
    if (k === 'vigor') { p.maxHp += 15; p.hp += 15; }
  }

  cast(id, s, x, y) {
    const p = this.players.get(id), def = SPELLS[s];
    if (!p || !p.alive || this.phase !== 'play' || !def || def.passive) return;
    const lv = p.lv[s];
    if (!lv || p.cd[s] > 0) return;
    let dx = x - p.x, dy = y - p.y;
    const d = hyp(dx, dy);
    if (d < 1) { dx = Math.cos(p.face); dy = Math.sin(p.face); } else { dx /= d; dy /= d; }
    p.face = Math.atan2(dy, dx);
    p.cd[s] = Math.round(def.cd(lv) * TICK);
    if (s === 'bolt' || s === 'seeker') {
      this.projs.push({
        id: this.nextId++, type: s, owner: id, lv,
        x: p.x + dx * (PLAYER_R + 6), y: p.y + dy * (PLAYER_R + 6),
        vx: dx * def.speed, vy: dy * def.speed, life: Math.round(def.life * TICK),
      });
    } else if (s === 'shock') {
      const R = def.radius(lv);
      for (const t of this.players.values()) {
        if (t === p || !t.alive) continue;
        const ex = t.x - p.x, ey = t.y - p.y, ed = hyp(ex, ey) || 1;
        if (ed > R + PLAYER_R) continue;
        const f = (1 - 0.5 * Math.min(1, ed / R)) * (t.ward > 0 ? 0.5 : 1);
        this.hit(t, id, def.dmg(lv) * f, ex / ed, ey / ed, def.kb(lv) * f);
      }
      for (const j of this.projs) {
        if (j.owner === id) continue;
        const ex = j.x - p.x, ey = j.y - p.y, ed = hyp(ex, ey) || 1;
        if (ed > R) continue;
        const sp = hyp(j.vx, j.vy);
        j.vx = ex / ed * sp; j.vy = ey / ed * sp; j.owner = id;
        j.life = Math.round(SPELLS[j.type].life * TICK);
      }
      this.ev('shock', Math.round(p.x), Math.round(p.y), R);
    } else if (s === 'meteor') {
      const r = Math.min(d, def.range);
      this.zones.push({
        id: this.nextId++, owner: id, lv, x: p.x + dx * r, y: p.y + dy * r,
        r: def.radius(lv), t: Math.round(def.delay * TICK),
      });
    } else if (s === 'blink') {
      const r = Math.min(d, def.range(lv));
      const ox = p.x, oy = p.y;
      p.x += dx * r; p.y += dy * r; p.vx *= 0.3; p.vy *= 0.3; p.tx = p.ty = null;
      this.ev('blink', Math.round(ox), Math.round(oy), Math.round(p.x), Math.round(p.y));
    } else if (s === 'ward') {
      p.ward = Math.round(def.dur(lv) * TICK);
    }
  }

  // ---------- helpers ----------
  ev(...a) { this.events.push(a); }

  hit(t, ownerId, dmg, dx, dy, kb) {
    if (!t.alive) return;
    t.hp -= dmg;
    if (ownerId !== t.id) { t.lastHitBy = ownerId; t.lastHitTick = this.tick; }
    // the more hurt you are, the further you fly
    const mult = 1 + 1.6 * (1 - Math.max(0, t.hp) / t.maxHp);
    t.vx += dx * kb * mult; t.vy += dy * kb * mult;
    if (t.hp <= 0) this.kill(t);
  }

  kill(t) {
    t.alive = false; t.deaths++; t.tx = t.ty = null;
    this.lastDead = t.id;
    const k = this.tick - t.lastHitTick < 8 * TICK ? this.players.get(t.lastHitBy) : null;
    if (k) {
      k.kills++;
      if (this.mode === 'brawl') k.xp += 20 + 5 * t.level; else k.pts++;
    }
    this.ev('die', t.id, k ? k.id : 0, Math.round(t.x), Math.round(t.y));
    if (this.mode === 'brawl') { t.respawn = 3 * TICK; }
    this.dirty = true;
  }

  alive() { return [...this.players.values()].filter((p) => p.alive); }

  // ---------- round flow ----------
  start() {
    if (this.mode !== 'rounds' || (this.phase !== 'lobby' && this.phase !== 'over')) return false;
    if (this.players.size < 2) return false;
    for (const p of this.players.values()) { p.score = 0; p.kills = 0; p.deaths = 0; this.resetBuild(p); }
    this.round = 0;
    this.intermission(6);
    return true;
  }

  intermission(sec) {
    this.phase = 'inter'; this.phaseT = sec * TICK; this.round++;
    this.projs = []; this.zones = [];
    const n = this.players.size;
    this.radius = Math.min(700, 400 + 30 * n);
    let i = 0;
    const off = rnd() * Math.PI * 2;
    for (const p of this.players.values()) {
      if (this.round > 1) p.pts += 2;
      const a = off + (i++ / n) * Math.PI * 2;
      this.spawn(p, Math.cos(a) * this.radius * 0.6, Math.sin(a) * this.radius * 0.6);
      p.face = a + Math.PI;
    }
    this.dirty = true;
  }

  toLobby() {
    this.phase = 'lobby'; this.projs = []; this.zones = [];
    for (const p of this.players.values()) p.alive = false;
    this.dirty = true;
  }

  stepPhase() {
    if (this.mode === 'brawl') {
      const target = Math.min(1000, 330 + 55 * this.players.size);
      this.radius += (target - this.radius) * 0.01;
      return;
    }
    if (this.phase === 'lobby') return;
    if (this.players.size < 2) { this.toLobby(); return; }
    if (this.phase === 'inter') {
      if (--this.phaseT <= 0) { this.phase = 'play'; this.playT = 0; }
    } else if (this.phase === 'play') {
      this.playT++;
      if (this.playT > 6 * TICK) this.radius = Math.max(110, this.radius - 7 * DT);
      const al = this.alive();
      if (al.length <= 1) {
        const w = al[0] || this.players.get(this.lastDead) || [...this.players.values()][0];
        w.score++; w.pts++;
        this.winner = w.id;
        this.dirty = true;
        if (w.score >= this.targetScore) { this.phase = 'over'; this.phaseT = 9 * TICK; } else { this.phase = 'end'; this.phaseT = 3 * TICK; }
      }
    } else if (this.phase === 'end') {
      if (--this.phaseT <= 0) this.intermission(11);
    } else if (this.phase === 'over') {
      if (--this.phaseT <= 0) this.toLobby();
    }
  }

  // ---------- main step ----------
  step() {
    this.tick++;
    this.stepPhase();
    const playing = this.phase === 'play';
    const moving = playing || this.phase === 'end' || this.phase === 'over';
    const R = this.radius;
    const lavaDps = this.mode === 'brawl' ? 16 : 12 + 0.3 * (this.playT / TICK);
    const fr = Math.exp(-2.6 * DT);

    for (const p of this.players.values()) {
      if (p.bot && (this.tick + p.id * 3) % 8 === 0) this.botThink(p);
      for (const k of SPELL_KEYS) if (p.cd[k] > 0) p.cd[k]--;
      if (!p.alive) {
        if (this.mode === 'brawl' && --p.respawn <= 0) { this.resetBuild(p); this.spawn(p); this.dirty = true; }
        continue;
      }
      if (!moving) continue;
      if (p.ward > 0) p.ward--;
      p.mvx = p.mvy = 0;
      if (p.tx !== null) {
        const dx = p.tx - p.x, dy = p.ty - p.y, d = hyp(dx, dy);
        const sp = BASE_SPEED * (1 + 0.06 * p.lv.swift);
        if (d <= sp * DT) { p.x = p.tx; p.y = p.ty; p.tx = p.ty = null; } else {
          p.mvx = dx / d * sp; p.mvy = dy / d * sp;
          p.x += p.mvx * DT; p.y += p.mvy * DT;
          p.face = Math.atan2(dy, dx);
        }
      }
      p.x += p.vx * DT; p.y += p.vy * DT;
      p.vx *= fr; p.vy *= fr;
      p.lava = hyp(p.x, p.y) > R;
      if (p.lava && playing) {
        p.hp -= lavaDps * DT;
        if (p.hp <= 0) { this.kill(p); continue; }
      }
      if (this.mode === 'brawl') {
        if (!p.lava) p.hp = Math.min(p.maxHp, p.hp + 1.5 * DT);
        p.xp += DT;
        const need = 10 + 6 * p.level;
        if (p.xp >= need) { p.xp -= need; p.level++; p.pts++; p.maxHp += 4; p.hp += 4; this.dirty = true; this.ev('lvl', p.id); }
      }
    }

    // bodies push each other apart
    const al = this.alive();
    for (let i = 0; i < al.length; i++) {
      for (let j = i + 1; j < al.length; j++) {
        const a = al[i], b = al[j];
        const dx = b.x - a.x, dy = b.y - a.y, d = hyp(dx, dy);
        if (d < PLAYER_R * 2 && d > 0.01) {
          const o = (PLAYER_R * 2 - d) / 2;
          a.x -= dx / d * o; a.y -= dy / d * o; b.x += dx / d * o; b.y += dy / d * o;
        }
      }
    }

    // projectiles
    for (const j of this.projs) {
      const def = SPELLS[j.type];
      if (j.type === 'seeker') {
        let best = null, bd = 650;
        for (const t of al) {
          if (t.id === j.owner || !t.alive) continue;
          const d = hyp(t.x - j.x, t.y - j.y);
          if (d < bd) { bd = d; best = t; }
        }
        if (best) {
          const cur = Math.atan2(j.vy, j.vx);
          let diff = Math.atan2(best.y - j.y, best.x - j.x) - cur;
          diff = Math.atan2(Math.sin(diff), Math.cos(diff));
          const turn = Math.max(-2.8 * DT, Math.min(2.8 * DT, diff));
          j.vx = Math.cos(cur + turn) * def.speed; j.vy = Math.sin(cur + turn) * def.speed;
        }
      }
      j.x += j.vx * DT; j.y += j.vy * DT;
      if (--j.life <= 0) { j.dead = true; continue; }
      for (const t of al) {
        if (t.id === j.owner || !t.alive) continue;
        if (hyp(t.x - j.x, t.y - j.y) > PLAYER_R + def.r) continue;
        if (t.ward > 0) {
          j.owner = t.id; j.vx = -j.vx; j.vy = -j.vy; j.life = Math.round(def.life * TICK);
          this.ev('refl', Math.round(j.x), Math.round(j.y));
        } else {
          const sp = hyp(j.vx, j.vy) || 1;
          this.hit(t, j.owner, def.dmg(j.lv), j.vx / sp, j.vy / sp, def.kb(j.lv));
          this.ev('hit', Math.round(j.x), Math.round(j.y), j.type === 'bolt' ? 0 : 1);
          j.dead = true;
        }
        break;
      }
    }
    this.projs = this.projs.filter((j) => !j.dead);

    // meteors
    for (const z of this.zones) {
      if (--z.t > 0) continue;
      const def = SPELLS.meteor;
      for (const t of al) {
        if (t.id === z.owner || !t.alive) continue;
        const dx = t.x - z.x, dy = t.y - z.y, d = hyp(dx, dy) || 1;
        if (d > z.r + PLAYER_R) continue;
        const f = (1 - 0.5 * Math.min(1, d / z.r)) * (t.ward > 0 ? 0.5 : 1);
        this.hit(t, z.owner, def.dmg(z.lv) * f, dx / d, dy / d, def.kb(z.lv) * f);
      }
      this.ev('boom', Math.round(z.x), Math.round(z.y), z.r);
    }
    this.zones = this.zones.filter((z) => z.t > 0);
  }

  // ---------- bots ----------
  botThink(p) {
    if (p.pts > 0 && rnd() < 0.3) {
      const opts = SPELL_KEYS.filter((k) => p.lv[k] < SPELLS[k].max);
      if (opts.length) this.upgrade(p.id, opts[Math.floor(rnd() * opts.length)]);
    }
    if (!p.alive || this.phase !== 'play') return;
    const R = this.radius, d0 = hyp(p.x, p.y);
    const can = (s) => p.lv[s] > 0 && p.cd[s] <= 0;
    let near = null, nd = 1e9;
    for (const t of this.players.values()) {
      if (t === p || !t.alive) continue;
      const d = hyp(t.x - p.x, t.y - p.y);
      if (d < nd) { nd = d; near = t; }
    }
    if (d0 > R * 0.78) {
      const a = rnd() * Math.PI * 2, r = R * 0.35 * rnd();
      p.tx = Math.cos(a) * r; p.ty = Math.sin(a) * r;
      if (d0 > R && can('blink')) this.cast(p.id, 'blink', 0, 0);
    } else if (p.tx === null || rnd() < 0.06) {
      const a = rnd() * Math.PI * 2, r = R * 0.62 * Math.sqrt(rnd());
      p.tx = Math.cos(a) * r; p.ty = Math.sin(a) * r;
    }
    if (can('ward')) {
      for (const j of this.projs) {
        if (j.owner === p.id) continue;
        const dx = p.x - j.x, dy = p.y - j.y;
        if (hyp(dx, dy) < 150 && dx * j.vx + dy * j.vy > 0 && rnd() < 0.5) { this.cast(p.id, 'ward', p.x, p.y); break; }
      }
    }
    if (!near) return;
    const aim = (lead, noise) => [
      near.x + near.mvx * lead + (rnd() - 0.5) * noise,
      near.y + near.mvy * lead + (rnd() - 0.5) * noise,
    ];
    if (nd < 135 && can('shock')) this.cast(p.id, 'shock', near.x, near.y);
    else if (can('bolt') && nd < 620 && rnd() < 0.45) this.cast(p.id, 'bolt', ...aim(nd / 640, 90));
    else if (can('meteor') && nd < 580 && rnd() < 0.2) this.cast(p.id, 'meteor', ...aim(0.8, 80));
    else if (can('seeker') && nd < 600 && rnd() < 0.25) this.cast(p.id, 'seeker', near.x, near.y);
  }

  // ---------- network views ----------
  snapshot() {
    const P = [];
    for (const p of this.players.values()) {
      P.push([p.id, Math.round(p.x), Math.round(p.y), Math.max(0, Math.ceil(p.hp)), p.maxHp,
        (p.alive ? 1 : 0) | (p.ward > 0 ? 2 : 0) | (p.lava ? 4 : 0), Math.round(p.face * 100)]);
    }
    const s = {
      k: this.tick, ph: this.phase, pt: Math.ceil(this.phaseT / TICK), r: Math.round(this.radius),
      rd: this.round, w: this.winner, P,
      J: this.projs.map((j) => [j.id, j.type === 'bolt' ? 0 : 1, Math.round(j.x), Math.round(j.y), j.owner]),
      Z: this.zones.map((z) => [z.id, Math.round(z.x), Math.round(z.y), z.r, z.t]),
      ev: this.events,
    };
    this.events = [];
    return s;
  }

  roster() {
    return [...this.players.values()].map((p) => ({
      id: p.id, name: p.name, color: p.color, bot: p.bot,
      score: p.score, kills: p.kills, deaths: p.deaths, level: p.level,
    }));
  }

  priv(id) {
    const p = this.players.get(id);
    return p ? { pts: p.pts, lv: p.lv, cd: p.cd, xp: Math.floor(p.xp), need: 10 + 6 * p.level } : null;
  }
}
