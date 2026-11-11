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
