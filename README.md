# Malfred: Ashen Ring

A browser multiplayer spell brawler. Wizards fight on a stone platform floating in
lava; every hit knocks you back, and the more hurt you are the further you fly.
Fall off and you burn. It is an original game in the "knockback arena" genre.

## Modes

- **Endless Brawl** – public free-for-all that anyone can drop into. You gain XP
  for surviving and for knockouts; every level gives an upgrade point. Die and
  you respawn with a fresh build. Bots fill the arena when few people are online.
- **Private Room** – create a room, send friends the invite link (`/?room=CODE`),
  optionally add bots, and play a round-based match. The platform shrinks each
  round, the last wizard standing scores, and you spend upgrade points between
  rounds. First to 5 round wins takes the match. During the countdown before
  each round the spell bar moves to the middle of the screen as an upgrade shop,
  and everyone can walk around and cast as a warm-up: spells shove but don't hurt.
  When the round starts, everyone is put back on their start spot at full health.
- **Tutorial** – a private, guided practice against a Training Dummy: moving, the
  camera, bolts, knockback, learning spells, Shockwave, Blink, and finishing
  someone off in the lava.

## Arena terrain

Pillars and rocks are scattered over the platform. They block wizards and soak up
projectiles (area spells like Shockwave and Meteor go around them), so you can use
them as cover. As the platform shrinks, any that end up at the edge crumble into
the lava. The room host picks *Flat*, *Some* or *Lots* in the lobby. Endless Brawl
always uses *Some*.

## Wizard looks

Pick a look on the main menu, or cycle through them in the Esc menu during a game:
Classic, Ember Lord, Frostweaver, Shade, Archmage and Grovekeeper. Each look changes
the trim, the staff orb and the headwear. Your robe always keeps your fighter
colour so you stay easy to spot.

## Controls

| Input | Action |
| --- | --- |
| Right-click (hold to steer), or `Ctrl`+click on a Mac | Move |
| Left-click / `Q` | Cinder Bolt toward cursor |
| `W` `E` `R` `D` `F` | Seeker Wisp, Shockwave, Meteor, Blink, Mirror Ward |
| `S` | Stop |
| `Shift`+key, `1`, `2`, or the **+** buttons | Spend an upgrade point |
| Mouse at a screen edge, arrow keys | Pan the camera |
| Middle-mouse drag | Grab and drag the camera |
| Mouse wheel | Zoom toward the cursor |
| `Space` (tap / hold) | Snap to / keep the camera on your wizard |
| `Y` or double-tap `Space` | Toggle camera lock (follow your wizard) |
| `Esc` or ☰ | Menu: resume, sound on/off, graphics 3D / 2D, leave game |
| `M` or 🔊 | Sound on/off |

The camera is free by default (Warcraft III style) and jumps to your wizard when you
join, respawn or a new round starts. When your wizard is off-screen an edge arrow
points to them; click it to jump back. The pill in the bottom-left corner shows the
camera mode (click it to toggle the lock).

## Graphics: 3D or 2D

The game renders in **3D** by default (three.js): an angled overhead camera,
animated wizard models tinted in each player's colour, a shader-driven lava sea,
a stone platform with a real cliff edge that crumbles as it shrinks, particle
fire, falling meteors, shockwaves, ward bubbles, bloom and ACES tone mapping. The
server and the simulation are unchanged: the 2D world `(x, y)` is drawn on the 3D
ground plane `(x, 0, y)`, and clicks are raycast onto that plane so movement and
aiming land exactly under the cursor.

The original **2D** canvas renderer is still there. Switch with
*Esc → Graphics: 3D / 2D* (remembered in this browser). The game falls back to 2D
automatically when WebGL isn't available. In 3D the renderer lowers its resolution
(down to 1x), then turns bloom off, if the frame rate drops below about 55 fps.

On touch screens: tap to move, tap a spell slot to cast it at the nearest enemy,
drag with two fingers to pan and pinch to zoom.

## Run locally

```sh
npm install
npm start        # http://localhost:3000
npm test         # headless simulation smoke test
MALFRED_DEV=1 npm start   # testing: every human starts with all spells maxed
```

## Deploy (free)

The whole game is one small Node process (static files + WebSocket), with no
database and no build step. Any host that runs Node and allows WebSockets works.

**Render (free tier):** push this repo to GitHub, then in Render choose
*New → Blueprint* and pick the repo; `render.yaml` does the rest. Free instances
sleep after ~15 minutes without traffic, so the first visit after a pause takes
up to a minute to wake.

**Anything else:** a `Dockerfile` is included (Fly.io, Koyeb, Railway, a VPS…).
The server listens on `$PORT` (default 3000).

## Layout

- `shared/game.js` – authoritative simulation and spell definitions (used by server and client HUD)
- `server.js` – HTTP static server, rooms, WebSocket protocol, 30 Hz game loop
- `public/` – browser client (no framework, no bundler)
  - `client.js` – connection, HUD, input; `camera.js` – free camera (2D and tilted 3D projection)
  - `tutorial.js` – the guided tutorial steps and their completion checks
  - `render3d.js` – three.js renderer; `render.js` – 2D canvas renderer
  - `vendor/three/` – vendored three.js **0.187.0** (MIT): `three.module.min.js` / `three.core.min.js`
    (minified from the npm build with esbuild) plus the addons used (GLTFLoader, SkeletonUtils,
    EffectComposer, RenderPass, UnrealBloomPass, OutputPass). Loaded through an import map in
    `index.html`; nothing is fetched from a CDN.
  - `models/mage.glb` – the wizard: the Mage from Kay Lousberg's
    [KayKit Adventurers](https://kaylousberg.itch.io/kaykit-adventurers) pack (CC0), trimmed to the
    animations the game uses. See `public/models/CREDITS.txt`.
  - `sfx/` – sound samples, see `public/sfx/CREDITS.txt`
