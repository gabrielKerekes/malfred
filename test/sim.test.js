// Headless smoke test: bots play full matches in both modes; state must stay sane.
import assert from 'node:assert';
import { Game, TICK, PLAYER_R, PILLAR } from '../shared/game.js';

function sane(g) {
  for (const p of g.players.values()) {
    assert(Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.hp), 'non-finite player state');
  }
  JSON.stringify(g.snapshot());
}

// rounds: a bot-only match must reach a champion and return to the lobby
{
  const g = new Game('rounds');
  for (let i = 0; i < 5; i++) g.addPlayer('', true);
  assert(g.start());
  let over = false, rounds = 0, i = 0;
  for (; i < TICK * 60 * 40 && g.phase !== 'lobby'; i++) {
    g.step(); sane(g);
    if (g.phase === 'over') over = true;
    rounds = Math.max(rounds, g.round);
  }
  assert(over, 'match never finished');
  assert.strictEqual(g.phase, 'lobby');
  const best = Math.max(...[...g.players.values()].map((p) => p.score));
  assert.strictEqual(best, g.targetScore);
  console.log(`rounds ok: ${rounds} rounds in ${(i / TICK).toFixed(0)}s of game time`);
}

// brawl: kills, respawns and level-ups all happen
{
  const g = new Game('brawl');
  for (let i = 0; i < 8; i++) g.addPlayer('', true);
  let maxLevel = 1;
  for (let i = 0; i < TICK * 60 * 5; i++) {
    g.step(); sane(g);
    for (const p of g.players.values()) maxLevel = Math.max(maxLevel, p.level);
  }
  const ps = [...g.players.values()];
  const kills = ps.reduce((a, p) => a + p.kills, 0), deaths = ps.reduce((a, p) => a + p.deaths, 0);
  assert(deaths > 0 && kills > 0 && maxLevel > 2, 'brawl too quiet');
  console.log(`brawl ok: ${kills} kills, ${deaths} deaths, top level ${maxLevel} in 5 min`);
}

// projectiles from different casters cancel out, even head-on at full speed; same caster's don't
{
  const g = new Game('brawl');
  const a = g.addPlayer('a'), b = g.addPlayer('b');
  g.spawn(a, -300, 0); g.spawn(b, 300, 0);
  g.cast(a.id, 'bolt', 300, 0); g.cast(b.id, 'bolt', -300, 0);
  let clash = 0;
  for (let i = 0; i < 30; i++) { g.step(); for (const e of g.snapshot().ev) if (e[0] === 'clash') clash++; }
  assert.strictEqual(clash, 1, 'head-on bolts should clash once');
  assert.strictEqual(g.projs.length, 0, 'both bolts gone');
  assert(a.hp === a.maxHp && b.hp === b.maxHp, 'nobody hit');

  const h = new Game('brawl');
  const c = h.addPlayer('c'); h.spawn(c, 0, 0);
  c.lv.seeker = 1; h.cast(c.id, 'bolt', 300, 0); h.cast(c.id, 'seeker', 300, 0);
  for (let i = 0; i < 5; i++) h.step();
  assert.strictEqual(h.projs.length, 2, "own projectiles don't cancel");
  console.log('clash ok');
}

// terrain: generated per round, bodies never end up inside it, pillars stop projectiles
{
  const g = new Game('rounds', { terrain: 2 });
  for (let i = 0; i < 4; i++) g.addPlayer('', true);
  assert(g.start());
  assert(g.obstacles.length > 4, 'lots of terrain expected');
  for (let i = 0; i < TICK * 90; i++) {
    g.step(); sane(g);
    for (const p of g.alive()) for (const o of g.obstacles) {
      assert(Math.hypot(p.x - o.x, p.y - o.y) >= o.r + PLAYER_R - 0.5, 'wizard inside an obstacle');
    }
  }
  for (const o of g.obstacles) assert(Math.hypot(o.x, o.y) + o.r * 0.4 < g.radius + 1, 'obstacle left in the lava');

  const h = new Game('brawl', { terrain: 0 });
  const a = h.addPlayer('a'), b = h.addPlayer('b');
  h.spawn(a, -200, 0); h.spawn(b, 200, 0); a.ward = b.ward = 0;
  h.obstacles.push({ id: 999, kind: PILLAR, x: 0, y: 0, r: 30 });
  h.cast(a.id, 'bolt', 200, 0);
  for (let i = 0; i < 30; i++) h.step();
  assert.strictEqual(b.hp, b.maxHp, 'pillar should block the bolt');
  assert.strictEqual(h.projs.length, 0);
  console.log('terrain ok');
}

// between rounds everyone can move and cast, nothing hurts, and the round starts from the spawn spots
{
  const g = new Game('rounds', { terrain: 0 });
  const a = g.addPlayer('a'), b = g.addPlayer('b');
  assert(g.start());
  assert.strictEqual(g.phase, 'inter');
  const [sx, sy] = g.spawnSlots.get(a.id);
  g.setMove(a.id, b.x, b.y);
  g.cast(a.id, 'bolt', b.x, b.y);
  for (let i = 0; i < TICK; i++) g.step();
  assert(Math.hypot(a.x - sx, a.y - sy) > 50, 'should be able to walk during the warmup');
  assert.strictEqual(b.hp, b.maxHp, 'warmup hits must not hurt');
  while (g.phase === 'inter') g.step();
  assert(Math.hypot(a.x - sx, a.y - sy) < 10, 'round starts from the spawn spot');
  assert(a.alive && b.alive && a.cd.bolt <= 1);
  console.log('warmup ok');
}

// tutorial: the dummy never acts, and you keep what you learned when you respawn
{
  const g = new Game('brawl', { tutorial: true });
  const d = g.addDummy(), p = g.addPlayer('me', false, 'frost');
  assert.strictEqual(p.skin, 'frost');
  assert.strictEqual(g.addPlayer('x', false, 'nope').skin, 'classic', 'unknown skins fall back');
  g.removePlayer(3);
  g.upgrade(p.id, 'shock');
  g.obstacles = []; g.terrain = 0;
  g.spawn(d, 100, 0); g.spawn(p, -100, 0); // apart, so bodies don't shove each other
  const x0 = d.x, y0 = d.y;
  for (let i = 0; i < TICK * 5; i++) g.step();
  assert(d.x === x0 && d.y === y0 && g.projs.length === 0, 'dummy should stand still');
  g.kill(p);
  for (let i = 0; i < TICK * 4; i++) g.step();
  assert(p.alive && p.lv.shock === 1, 'tutorial respawn keeps the build');
  assert.strictEqual(p.xp, 0, 'no XP in the tutorial');
  console.log('tutorial ok');
}
