// Guided first match: a private brawl against a Training Dummy. Each step names one
// thing to do and watches the game state until the player has done it.

const STEPS = [
  { title: 'Move', text: '<b>Right-click</b> the ground to walk there (hold it to steer). On a Mac use <b>Ctrl+click</b>, on a touch screen just tap.',
    done: (t) => t.moved > 160 },
  { title: 'Camera', text: 'Push the mouse to a screen edge or use the <b>arrow keys</b> to look around, and the <b>wheel</b> to zoom. Press <b>Space</b> to snap back to your wizard.',
    done: (t) => t.keys.has(' ') },
  { title: 'Cinder Bolt', text: '<b>Left-click</b> (or press <b>Q</b>) to hurl a Cinder Bolt toward the cursor. Hit the Training Dummy.',
    done: (t) => t.dummyHurt },
  { title: 'Knockback', text: 'Every hit shoves the target, and the more hurt they are, the further they fly. Pillars and rocks stop projectiles: duck behind them for cover.',
    next: true },
  { title: 'Learn a spell', text: 'You have upgrade points. Press <b>Shift+E</b> or click the <b>+</b> on the Shockwave slot to learn it.',
    done: (t) => t.me?.lv.shock > 0 },
  { title: 'Shockwave', text: 'Walk up close to the dummy and press <b>E</b> to blast it away. A Shockwave also turns enemy projectiles around.',
    done: (t) => t.seen.has('shock') },
  { title: 'Blink', text: 'Learn Blink with <b>Shift+D</b>, then press <b>D</b> to teleport toward the cursor. It is your way back out of the lava.',
    done: (t) => t.seen.has('blink') },
  { title: 'Into the lava', text: 'Knock the Training Dummy off the platform. Lava burns anyone standing in it, you included!',
    done: (t) => t.dummyDied },
  { title: 'Ready!', text: 'That is the core of it. <b>W</b> Seeker Wisp, <b>R</b> Meteor and <b>F</b> Mirror Ward unlock with more upgrade points, and <b>1</b> / <b>2</b> are passive upgrades. Last wizard standing wins the round.',
    final: true },
];

export function createTutorial(el, { onBrawl, onMenu }) {
  const $ = (s) => el.querySelector(s);
  let i = -1, t = null;

  function show() {
    const s = STEPS[i];
    $('.tut-n').textContent = `${i + 1} / ${STEPS.length}`;
    $('.tut-h').textContent = s.title;
    $('.tut-p').innerHTML = s.text; // static strings above, never user input
    $('.tut-next').hidden = !s.next;
    $('.tut-skip').hidden = !!s.final;
    $('.tut-end').hidden = !s.final;
    $('.tut-bar').style.width = `${(100 * i) / (STEPS.length - 1)}%`;
    el.classList.remove('pop'); void el.offsetWidth; el.classList.add('pop');
  }

  function go(n) {
    i = Math.min(n, STEPS.length - 1);
    t = { moved: 0, keys: new Set(), seen: new Set(), dummyHurt: false, dummyDied: false, me: t?.me, from: null, dummyHp: null };
    show();
    if (STEPS[i].final) { try { localStorage.setItem('malfred-tutorial', 'done'); } catch {} }
  }

  function check() {
    const s = STEPS[i];
    if (s.done && s.done(t)) { go(i + 1); return true; }
    return false;
  }

  $('.tut-next').onclick = () => go(i + 1);
  $('.tut-skip').onclick = () => go(STEPS.length - 1);
  $('.tut-brawl').onclick = () => onBrawl();
  $('.tut-menu').onclick = () => onMenu();

  return {
    get on() { return i >= 0; },
    start() { el.hidden = false; t = null; go(0); },
    stop() { el.hidden = true; i = -1; },
    // s: decoded snapshot (with Pm), me: private state, roster: id -> info
    snapshot(s, me, myId, roster) {
      if (i < 0) return;
      t.me = me;
      const my = s.Pm.get(myId);
      if (my && my[5] & 1) {
        if (!t.from) t.from = [my[1], my[2]];
        t.moved = Math.max(t.moved, Math.hypot(my[1] - t.from[0], my[2] - t.from[1]));
      }
      const dummy = [...roster.values()].find((p) => p.dummy);
      const d = dummy && s.Pm.get(dummy.id);
      if (d) {
        if (t.dummyHp !== null && d[3] < t.dummyHp) t.dummyHurt = true;
        t.dummyHp = d[3];
      }
      for (const ev of s.ev) {
        t.seen.add(ev[0]);
        if (ev[0] === 'die' && dummy && ev[1] === dummy.id) t.dummyDied = true;
      }
      check();
    },
    key(k) { if (i >= 0) { t.keys.add(k); check(); } },
  };
}
