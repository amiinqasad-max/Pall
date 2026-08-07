# TARTAN

A premium endless arcade runner for the mobile web. Swipe to move a rolling ball
between lanes, survive a procedurally generated track that never repeats, and
chase the record.

Built as an installable PWA that runs at 60fps on mid-range Android, degrades
gracefully to 30fps on 1GB devices, and plays fully offline.

```bash
npm install
npm run dev          # http://localhost:5173
```

No configuration is needed to run it. With no backend and no ad account
configured, the game runs entirely locally — saves, records, progression and
house ads all work. See [Configuration](#configuration) to switch the real
services on.

---

## Contents

- [How it plays](#how-it-plays)
- [Architecture](#architecture)
- [The renderer](#the-renderer)
- [Track generation and fairness](#track-generation-and-fairness)
- [Economy](#economy)
- [Progression and daily content](#progression-and-daily-content)
- [Anti-cheat](#anti-cheat)
- [Ads](#ads)
- [Offline, saves and sync](#offline-saves-and-sync)
- [Performance](#performance)
- [Configuration](#configuration)
- [Backend setup](#backend-setup)
- [Deployment](#deployment)
- [Project layout](#project-layout)
- [Scripts](#scripts)
- [Known limitations](#known-limitations)

---

## How it plays

| Input | Action |
| --- | --- |
| Hold and drag anywhere | Steer — the ball follows your finger |
| Tap, or a second finger | Jump |
| Flick up | Jump (secondary) |
| Arrow keys / WASD, Space, Down | Steer, jump, drop — on desktop |

There are no swipe gestures. You put a thumb anywhere on the screen and drag;
the ball follows. The touch point is an **anchor**, not a destination — the ball
does not teleport to your finger, it tracks the offset from where you first
touched, so you can steer comfortably from wherever your thumb naturally rests.
Sensitivity is a fraction of the viewport width rather than a fixed
metres-per-pixel, so the same physical thumb sweep crosses the same amount of
road on every device.

The ball chases that target with a **critically damped spring** — the fastest
response that cannot overshoot. That is the specific reason it feels controlled
rather than floaty: it never oscillates around your finger, so it needs no
deadzone to hide wobble. Lateral velocity is clamped, so a violent flick
accelerates the ball hard but can never teleport it. Releasing carries a little
of the finger's motion through rather than stopping dead.

The spring is integrated at a fixed 1/240s substep rather than once per frame.
At ~41 rad/s it sits close to the stability limit of a 30fps frame time, and the
naive version rings or diverges on exactly the low-end hardware that can least
afford it.

The ball accelerates from 23 m/s to a terminal 63 m/s over about three minutes.
Score comes from distance, prisms collected (with a chain multiplier up to 5x),
near misses, and a bonus for each difficulty stage cleared.

Swipes register **mid-gesture**, the moment travel passes the threshold, rather
than on release — waiting for the finger to lift adds 80–150ms and is the single
biggest reason a swipe control feels laggy even at a locked frame rate. Inputs
arriving during a lane change are buffered rather than dropped, so a fast
double-swipe reliably moves two lanes.

There are ten obstacle types — blocks, drifters, rotors, sweepers, energy gates,
droppers, spinners, lasers, chasms and pulse pillars — each with its own motion
and its own counter-play.

---

## Architecture

Two worlds, one wire between them.

```
┌─────────────────────────────┐         ┌──────────────────────────────┐
│  React UI                   │         │  Phaser engine (lazy chunk)  │
│  screens, store, missions,  │◄───────►│  RunScene, track generator,  │
│  leaderboard, settings      │ events  │  renderer, collision         │
└──────────────┬──────────────┘         └──────────────────────────────┘
               │
      ┌────────▼─────────┐
      │  systems/        │  save · economy · xp · missions · daily
      │  (framework-free)│  audio · haptics · ads · analytics · sync
      └────────┬─────────┘
               │
      ┌────────▼─────────┐
      │  Supabase        │  anonymous auth · profiles · runs · RPCs
      └──────────────────┘
```

`src/game/events.ts` is the **only** connection between Phaser and React.
Neither side reaches into the other, which is what allows the canvas and its
whole WebGL context to be torn down when the player leaves the play screen — the
difference between roughly 90MB and 25MB resident on a low-end device, and the
most common reason a mobile web game gets killed in the background.

The `systems/` layer has no React and no Phaser imports. It is plain TypeScript
and can be tested and reasoned about on its own.

---

## The renderer

TARTAN is **not** a 3D game. It is a 2D renderer driven by a perspective divide
— the technique arcade racers used before hardware transforms existed.

Every point in the world is `(x, y, z)` in metres. Projecting it is one
division. There is no scene graph, no matrix stack, no depth buffer, and no
shader beyond Phaser's default quad pipeline. The entire visible world costs a
few hundred triangles.

Three details make it hold together:

**The camera is solved from the composition, not fixed.** `Projector.resize`
takes a framing — "the road should be 1.22× the viewport wide at the ball, the
ball should sit at 73% of the height" — and derives the focal length and horizon
that produce it. Fixing the focal length instead is the obvious approach and it
fails: the constants that frame a 20:9 phone correctly put the road at twice the
screen width on a squat one and push the ball off-screen in landscape.

**Curvature is integrated exactly once per frame.** The road renderer walks
segments outward accumulating a lateral offset, and records it into flat typed
arrays. The ball, obstacles, prisms and particles all read their position from
those arrays, so nothing can drift off the road — there is one integration and
everybody shares it.

**Painting far-to-near gives hill occlusion for free.** Nearer road covers the
road behind a crest, so no sorting or clipping is needed anywhere in the scene.

### Assets

There are none. Every texture is drawn into an offscreen canvas at boot, and
every sound is synthesised with the Web Audio API. No sprite atlas, no audio
files, no packing step, no cache busting, no resolution variants.

That is worth several megabytes of download, it removes the decode spike that
causes the first-collision stutter on low-end Android, and it makes a new ball
skin nine numbers in `src/data/cosmetics.ts`. The PWA icons are generated the
same way, from signed-distance maths, by `scripts/generate-icons.mjs`.

The music is a generative loop — a fixed chord progression driven by a lookahead
scheduler — whose intensity rises with the difficulty stage. It never seams and
never repeats identically.

---

## Track generation and fairness

The track is built one **feature** at a time — a curve, a crest, a narrowing, a
boost lane, a chasm, a gauntlet — rather than one obstacle at a time. Features
give a run its shape and rhythm; obstacles are then placed inside a feature.

The fairness contract is the important part, and it is enforced in code rather
than tuned by feel:

- Obstacle clusters are never closer than `(reaction + recovery) × current
  speed`. The spacing is derived from how fast the player will actually be
  moving when they arrive, not from a constant, so the late game gets denser and
  more varied but never unreadable.
- A cluster is verified to leave a corridor the ball physically fits through,
  **measured in metres and checked at every phase of its animation**, then
  shrunk or thinned until it does. Budgeting by lane count is not sufficient
  once the player steers freely: a four-lane rotating barrier is 8.6m wide at
  full extension, which covers the whole 10.8m road once the ball's radius is
  counted — and because forward speed is not the player's to control, they
  cannot dodge it by timing. `ensurePassable` enforces the real contract.
- A breather — a guaranteed empty stretch — is forced on a fixed cadence,
  because weighted random selection eventually produces a run that is
  technically fair and exhausting, and players quit during those.
- The opening 220m is flat, wide and empty. Nobody's first ten seconds should be
  a death.

Difficulty walks through six stages by elapsed time (Drift → Pulse → Surge →
Fracture → Overdrive → Singularity), each widening the obstacle vocabulary and
tightening the spacing.

### Collision

Collision runs on the **swept interval** between last frame's `z` and this
frame's `z`, not on the ball's current position. At 63 m/s a frame covers about
a metre; a position-only test would let the ball tunnel through thin obstacles
at high speed — the classic endless-runner bug where deaths feel random.

Obstacles are sampled at the exact moment of crossing rather than at the frame
boundary. At 60Hz that is up to a 16ms error, which is clearly visible on a
fast-rotating barrier.

An obstacle's solid extent at any instant is a pure function of its data and the
clock (`extentAt`), and collision and rendering both read it. There is no physics
body anywhere in this game, and no way for what you see to disagree with what
kills you.

---

## Economy

One currency: **Tartan Coins**. Coins have exactly three sources:

1. Rewarded ads
2. The daily challenge
3. Daily login rewards

Gameplay pays **no** coins. Not for distance, not for score, not for prisms, not
as random drops. This is enforced structurally — `earnCoins` accepts only a
`CoinSource`, which is a three-member union, and nothing in the run pipeline can
call it.

Coins buy cosmetics and nothing else. No skin rolls faster, no trail widens the
road, nothing changes a hitbox. The engine reads only `palette`, `colors` and
`style` off a cosmetic record, and no code anywhere branches on a cosmetic id.

The wallet keeps a transaction ledger (capped, most-recent-first), and the
server mirrors the same three-source rule as a `CHECK` constraint on
`coin_ledger.reason` plus a daily faucet ceiling in `grant_coins`.

---

## Progression and daily content

- **XP and levels** — 60 levels on a curve that is generous early (level 5 lands
  inside the first session) and stretches out later. XP comes from runs,
  missions, achievements and challenges. Levels unlock cosmetics, five
  environments and profile badges.
- **Daily challenge** — one objective, identical for every player worldwide,
  derived purely from the UTC date key. The track seed is derived the same way,
  so everyone races the same layout. No network call is needed to know what
  today's challenge is.
- **Daily rewards** — a 30-day login ladder with milestones at days 3, 7, 14 and
  30, and a rising multiplier after week one.
- **Missions** — three daily and three weekly, generated deterministically from
  the date so the set is stable and shareable.
- **Achievements** — fifteen, each awarding XP, evaluated against the lifetime
  stat block after every run.

Everything daily resets at **00:00 UTC**, not local midnight. That makes the
daily challenge genuinely identical worldwide and removes a class of exploits
where a player changes timezone to farm rewards.

---

## Anti-cheat

An honest framing of what each layer is worth.

**Client-side** (`src/systems/integrity.ts`): saves are signed with an HMAC over
a per-install key, so a save lifted from one device does not verify on another.
This detects casual tampering — the "open devtools and set coins to 999999" case,
which is the overwhelming majority of it. It does not and cannot stop a
determined attacker, because the code runs on their machine. A failed signature
does **not** wipe progress; punishing a player for a browser that dropped a key,
or for our own bug, is far worse than the alternative. The flag travels to the
server, which is where eligibility is actually decided.

**Server-side** (`supabase/migrations/0001_init.sql`): the client cannot insert a
score. There is no `INSERT` policy on `runs` at all. Submission goes through the
`submit_run` RPC, which:

- recomputes the physical bounds of the run — distance against terminal speed ×
  duration, score against the scoring formula, prisms against how much track
  existed — using constants stored in a `game_constants` table
- stamps the server clock, so leaderboard windows cannot be gamed
- rate-limits submissions per user
- increments a flag counter on rejection, and auto-bans only after a sustained
  pattern, because one bad row is a bug

The client validator in `integrity.ts` mirrors the SQL one exactly, so a player
gets immediate feedback and the server stays authoritative.

---

## Ads

Built against Google's H5 Games Ads API (the `adBreak`/`adConfig` surface that
ships with the AdSense tag), because it is the only Google product that serves
rewarded and interstitial formats to a web game.

Policy is enforced in `src/systems/ads.ts`, not left to call sites:

- Rewarded ads are **opt-in only**, always behind a button that states the reward
  first.
- Interstitials appear only on the game-over screen — never during play, never
  in the first three runs of an install, and never inside the frequency cap
  (2 minutes apart, 4 per session, 12 per day).
- The game pauses and mutes, and controls are released before the ad is
  requested, so no tap can land on an ad by accident.

**House ads.** When no ad can be served — blocked, offline, no fill, or no client
id configured — an in-game promo panel is shown instead and **the reward is still
granted**. It is labelled for what it is, does not imitate a third-party ad, and
does not fake a close button. A player who blocks ads gets a slightly worse deal,
never a broken game.

---

## Offline, saves and sync

Offline is the normal case, not the error case.

- **Storage** is IndexedDB, falling back to localStorage, falling back to memory.
  A private-mode browser that rejects both still *plays*, it just does not
  persist.
- **The service worker** (`scripts/sw-template.js`, wired up by a small Vite
  plugin) precaches the shell and every hashed bundle, serves navigations
  network-first with a 3s budget and falls back to the cached shell. Supabase
  and ad traffic are never intercepted.
- **Sync** reconciles when connectivity allows and nothing in the UI blocks on
  it. Conflicts resolve per-field toward the better outcome rather than
  latest-wins, so a player who plays offline on a plane and opens the app on a
  second device does not lose the run they just made. Coins are the one
  exception — the server is authoritative there, because taking a max would let
  someone fork their wallet across two devices.
- **Runs that fail to submit** are queued (best ten) and retried on reconnect.

---

## Performance

Targets: stable play on 1GB Android, 60fps on 2GB.

- **Three quality tiers**, resolved at boot from `deviceMemory`, core count and
  DPR, with `save-data` forcing the lowest. A `PerformanceGovernor` samples
  frame time and steps the tier down after two consecutive bad windows —
  never up, because oscillating is more distracting than simply running lower.
- **Immediate-mode sprite pooling.** Each frame calls `begin()`, acquires what it
  needs, and `end()` hides the rest. Nothing is allocated or destroyed in the
  steady state — GC pressure causes far more frame hitches on low-end Android
  than draw calls do.
- **Flat typed arrays** for all per-segment geometry; zero allocation in the
  collision pass.
- **Lazy engine chunk.** Phaser is ~320KB gzipped and none of it is needed for
  the menus, so it is fetched on the first Play press and cached by the service
  worker thereafter. Supabase is lazy for the same reason.

Initial load is about **84KB gzipped** (HTML + CSS + React + app), with the
engine arriving on demand.

One thing the tiers deliberately do **not** cut: lane dividers. They are
gameplay information — how a player reads which lane the ball is in and which
lane an obstacle occupies. The low tier shortens their draw distance instead,
which recovers nearly all the cost and costs the player nothing.

---

## Configuration

All optional. Copy `.env.example` to `.env.local`.

| Variable | Effect if unset |
| --- | --- |
| `VITE_SUPABASE_URL` | Local-only saves; leaderboard shows your runs only |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | As above. `VITE_SUPABASE_ANON_KEY` also accepted |
| `VITE_ADSENSE_CLIENT` | House ads serve instead of real ones; rewards still granted |

The publishable key is meant to be public — it ships in the client bundle and
row-level security is what protects the data.

**Never put a `service_role` key or an `sbp_` personal access token in a
`VITE_` variable.** Those are compiled into the JavaScript every visitor
downloads. A personal access token in particular is account-wide: it can create
and delete every project you own.

## Backend setup

1. Create a Supabase project (or use an existing one — see below).
2. Run `supabase/migrations/0001_init.sql` in the SQL editor.
3. Add `tartan` to **Settings → API → Exposed schemas** (alongside `public`).
4. Enable **Anonymous sign-ins** under Authentication → Providers.
5. Put the project URL and publishable key in `.env.local`.

### Why a `tartan` schema

Everything lives in a dedicated `tartan` schema rather than `public`. That is
deliberate: `profiles` and `coin_ledger` are among the most common table names
there are, and this migration dropped into a project that already has them
would skip the CREATE (`if not exists`) and then attach TARTAN's policies to
somebody else's tables. Policies are OR'd, so that *widens* access on tables
the game knows nothing about, and `enable row level security` on a table that
had it off breaks whatever was reading it.

An owned schema makes that impossible, lets the game share a project with an
unrelated app, and makes it removable with one `drop schema tartan cascade`.

Verify a live project end to end with:

```bash
VITE_SUPABASE_URL=... VITE_SUPABASE_PUBLISHABLE_KEY=... npm run verify:backend
```

It asserts the parts nothing else can: that anonymous sign-in works, that
`submit_run` rejects physically impossible runs, that RLS blocks the direct
write path into `runs`, and that the coin faucet refuses any source outside the
three legitimate ones.

Optionally schedule the pruning functions with `pg_cron`:

```sql
select cron.schedule('tartan-prune-analytics', '0 3 * * *', 'select public.prune_analytics()');
select cron.schedule('tartan-prune-runs',      '30 3 * * *', 'select public.prune_runs()');
```

---

## Deployment

Any static host works — the build output is plain files. `vercel.json` is
included and configures the two things that actually matter for an offline-first
PWA:

- `/assets/*` is served `immutable` for a year. The filenames are content
  hashes, so they can never go stale, and without this every launch revalidates
  the 1.4MB engine chunk over a mobile connection.
- `sw.js`, the shell and the manifest always revalidate. If the service worker
  is ever served from cache, a client can be pinned to an old build with no
  route back — which is the one failure mode an offline-first app cannot
  recover from on its own.

The app also reloads once when a new service worker takes control, so an
installed PWA picks up a new build instead of running the old bundle until the
user happens to cold-start it. It will not do this mid-run.

## Project layout

```
src/
  core/          rng, time, formatting, event bus — no dependencies
  data/          cosmetics, progression curve, missions, environments
  systems/       save, integrity, storage, economy, audio, haptics,
                 ads, analytics, sync, device tiering
  services/      supabase client, leaderboard
  state/         zustand stores (save state, UI state)
  game/
    config.ts    every tunable number in the game
    events.ts    the Phaser ↔ React contract
    render/      projection, road renderer, procedural textures
    world/       track generator, obstacle definitions
    systems/     swipe input, sprite pool
    scenes/      RunScene
  ui/
    screens/     home, play, store, missions, daily, leaderboard,
                 profile, settings
    components/  primitives, HUD, nav, toasts, ad overlay
    styles/      design system
supabase/migrations/   schema, RLS, validation RPCs
scripts/               icon generator, service worker template, smoke test
```

`src/game/config.ts` holds every balance number in the game. Tuning should never
mean hunting through scene code.

## Scripts

| Command | Does |
| --- | --- |
| `npm run dev` | Dev server |
| `npm run build` | Typecheck, then production build with service worker |
| `npm run preview` | Serve the production build |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run check` | Projection and control solvability checks (runs inside `build`) |
| `npm run icons` | Regenerate the PWA icon set |
| `npm run smoke` | Boot the built game in mobile Chromium, play a run, report errors and screenshots |
| `npm run verify:backend` | Assert a live Supabase project: auth, anti-cheat, RLS, coin faucet |
| `npm run verify:control` | Drive real pointer events at a dev server and assert the steering model (needs `npm run dev`) |
| `npm run verify:terrain` | Jump into far terrain and assert camera framing (needs `npm run dev`) |

The smoke test expects `npm run preview` to be running. It drives a real run
with synthetic swipes and fails on any console error.

---

## Known limitations

Worth stating plainly:

- **Haptics are Android-only.** `navigator.vibrate` has never shipped in iOS
  Safari. The setting is disabled there rather than pretending.
- **Rewarded ads need review.** The H5 Games Ads API requires an approved
  AdSense account and serves no fill until then; house ads cover that window.
- **Country flags need a server.** The leaderboard renders `profiles.country`,
  but nothing populates it — deriving it from the request IP is a small edge
  function that is not included here, deliberately, since it is a privacy
  decision that should be made explicitly.
- **No automated test suite.** There is a browser smoke test, not unit tests.
  The systems layer is framework-free and structured to be testable; the tests
  themselves are not written.
- **Analytics is fire-and-forget.** Events batch to a Postgres table. That is
  fine to a few thousand DAU and will want a real pipeline beyond that.
