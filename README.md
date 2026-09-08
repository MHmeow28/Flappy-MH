# Flappy Meow 🐦🐱

A Flappy Bird–style game where your bird is your **Roblox avatar headshot**, with a
leaderboard, on-screen instructions, and all sound effects generated live with the
Web Audio API (no audio files to source or host).

## Features

- Enter any Roblox username → the game fetches their live avatar headshot via a
  server-side API route (avoids Roblox's CORS restrictions) and uses it as the bird.
- Classic flappy physics: gravity, flap impulse, scrolling pipes, collision detection.
- Score = number of pipes cleared. Per-player all-time high is stored in the browser
  (`localStorage`) and compared every run.
- Global Top 10 leaderboard, backed by Vercel KV (Redis).
- Sounds, all synthesized in-browser: a soft ambient hum, a flap chirp, a score blip,
  a game-over tone, and a triumphant fanfare the moment you beat your all-time high.
- Mute toggle, keyboard (Space / ↑) and tap/click controls.

## Run locally

```bash
npm install
npm run dev
```

Open http://localhost:3000. The leaderboard will work locally out of the box using
an in-memory fallback (resets on server restart) — see below to make it persistent.

## Deploy to Vercel + GitHub

1. Push this folder to a new GitHub repo:
   ```bash
   git init
   git add .
   git commit -m "Flappy Meow"
   git branch -M main
   git remote add origin https://github.com/<you>/flappy-meow.git
   git push -u origin main
   ```
2. Go to [vercel.com/new](https://vercel.com/new), import the repo. Framework preset
   "Next.js" is auto-detected — no config needed.
3. Click **Deploy**. That's it for a working demo (leaderboard runs in the in-memory
   fallback, which resets between deployments/cold starts).

## Make the leaderboard persistent (Vercel KV)

1. In your Vercel project dashboard → **Storage** tab → **Create Database** → **KV**
   (Upstash Redis under the hood).
2. Connect it to your project. Vercel automatically injects the required env vars
   (`KV_REST_API_URL`, `KV_REST_API_TOKEN`, etc.) into your deployment — no code
   changes needed. The app detects these automatically and switches from the
   in-memory fallback to real persistence.
3. Redeploy (or it will auto-redeploy after connecting storage).

## How the Roblox avatar lookup works

`app/api/roblox-avatar/route.ts` runs server-side (so it isn't blocked by CORS):

1. `POST https://users.roblox.com/v1/usernames/users` — resolves a username to a
   Roblox `userId`.
2. `GET https://thumbnails.roblox.com/v1/users/avatar-headshot` — fetches a circular
   150×150 headshot PNG for that `userId`.
3. Returns `{ userId, username, displayName, avatarUrl }` to the client, which loads
   it into an `<img>`/`Image()` used as the canvas bird sprite.

## Project structure

```
app/
  api/
    roblox-avatar/route.ts   # username -> avatar headshot URL
    leaderboard/route.ts     # GET top scores / POST a new score
  layout.tsx
  page.tsx
  globals.css
components/
  FlappyMeowGame.tsx          # canvas game loop, UI states, leaderboard panel
lib/
  sounds.ts                   # Web Audio synthesized sound effects
```

## Notes / ideas to extend

- Add difficulty ramp (increase `PIPE_SPEED` as score grows).
- Swap the in-memory fallback's cap (currently unlimited entries) for a TTL/prune.
- Add a "share score" button that deep-links back with `?score=`.
- Rate-limit `/api/leaderboard` POST per IP to reduce spoofed high scores.
