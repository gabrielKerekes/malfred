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
  rounds. First to 5 round wins takes the match.

## Controls

| Input | Action |
| --- | --- |
| Right-click (hold to steer) | Move |
| Left-click / `Q` | Cinder Bolt toward cursor |
| `W` `E` `R` `D` `F` | Seeker Wisp, Shockwave, Meteor, Blink, Mirror Ward |
| `S` | Stop |
| `Shift`+key, `1`, `2`, or the **+** buttons | Spend an upgrade point |
| Mouse at a screen edge, arrow keys | Pan the camera |
| Middle-mouse drag | Grab and drag the camera |
| Mouse wheel | Zoom toward the cursor |
| `Space` (tap / hold) | Snap to / keep the camera on your wizard |
| `Y` or double-tap `Space` | Toggle camera lock (follow your wizard) |

The camera is free by default (Warcraft III style) and jumps to your wizard when you
join, respawn or a new round starts. When your wizard is off-screen an edge arrow
points to them; click it to jump back. The pill in the bottom-left corner shows the
camera mode (click it to toggle the lock).

On touch screens: tap to move, tap a spell slot to cast it at the nearest enemy,
drag with two fingers to pan and pinch to zoom.

## Run locally

```sh
npm install
npm start        # http://localhost:3000
npm test         # headless simulation smoke test
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
- `public/` – canvas client (no framework, no bundler)
