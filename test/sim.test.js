// Headless smoke test: bots play full matches in both modes; state must stay sane.
import assert from 'node:assert';
import { Game, TICK } from '../shared/game.js';

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
