# Pykachu Go v3.4

A Pokédex-styled interactive Python & C++ coding puzzle hunt built with **React 19**, **TypeScript**, **Tailwind CSS v4**, and **Vite**, running at **JSON-level speed** with an optional **Google Sheets + Apps Script** telemetry backend copy (`apps-script/Code.gs`).

Players log in with their team credentials (`team` / `tid` + `securityKey`) from `public/data/teams.json`, scan QR signal codes around the venue, solve Python/C++ puzzles inside a retro CRT terminal, unlock Pokémon companions & gym badges, and report live scores to the Admin Command Node.

---

## Key Features

- **Ultra-Fast JSON-Level User Experience**:
  - `public/data/config.json` — languages, mission sectors, and level groups.
  - `public/data/puzzle.json` — branching puzzle graph, Python/C++ snippets, hints, Pokémon & badges.
  - `public/data/meme.json` — YouTube QR meme clips (`?memid=...`).
  - `public/data/teams.json` — indexed into an O(1) in-memory `Map` (`tid` & team name) for instant trainer login.
  - `public/data/admin.json` — organizer `{ name, password }` credentials for instant Admin Command Node authentication.
- **Google Apps Script Copy Included (`apps-script/Code.gs`)**:
  - Ready-to-deploy `.gs` backend with **zero hardcoded secrets, IDs, or sheet tab names** (reads strictly from `PropertiesService.getScriptProperties()`).
  - Supports `CacheService`, `LockService`, and differential telemetry log polling when `VITE_APPS_SCRIPT_URL` is configured, while working smoothly offline/locally via `localStorage` if left unset.
- **Authentic Pokédex Shell & CRT Terminal**: Responsive portrait-first hardware frame across mobile, tablet, and laptop viewports with Prof. Oak's chalkboard rules, Web Audio synthesized retro SFX, and Pokéball landscape-to-portrait rotation lock.
- **Terminal-Scoped Anti-Tab-Switch Protection**: Automatically locks only the Step 3 coding terminal on tab switch / focus loss, triggers Officer Jenny's 15-second cooldown penalty, and pauses active Brock hint timers.
- **Admin Command Node (`/admin`, `#admin`, or `?admin=1`)**:
  - Production sign-in and admin APIs are verified by the server using `ADMIN_PASSWORD`; set a private value on the server and keep it different from any password in `public/data/admin.json`.
  - Live monitoring (`REGISTRATION`, `LEVEL 1`, `LEVEL 2`, `LEVEL 3`, `LEADERBOARD`, `ROSTER LOG`), CSV telemetry export, and `CREATE & BULK` studio (create/edit/delete Teams, Memes, and Puzzles + `.xlsx` bulk import & `.json` export).

---

## Burst Traffic and Shared Caching

The app shell now uses immutable caching for hashed JavaScript/CSS, fast local PWA navigation, and cached bootstrap/catalog responses. The Express server also keeps short-lived hot copies of the epoch, bootstrap payload, and leaderboard, and pipelines each telemetry write to Redis.

For a 1,600-student launch, run the Express server as a Node service and configure Upstash Redis with enough throughput for the event. The in-memory Redis fallback is development-only and does not share state across replicas; `/api/health` reports `sharedStateReady`. A static Vercel deployment serves the client and cached JSON only; it does not run `server.ts` or provide the shared game-state API.

Google Apps Script is an asynchronous reporting sink, not the live state store for a burst. The server buffers writes to Sheets and groups each batch by team/session. Live progress and leaderboard reads come from Redis.

These changes reduce repeat reads and connection overhead; they do not guarantee a specific concurrent-user capacity. Actual capacity depends on the Node host, Redis plan/limits, network, and Apps Script quotas.

## Getting Started (Local Development)

### 1. Install Dependencies & Run
```bash
npm install
npm run dev
```
The app starts on `http://localhost:3000`.
- **Player Login Example**: Team `PRANAV` (or `T001`), Security Key `123`
- **Admin Command Node (`/admin`)**: Name `ADMIN` (or `PRANAV`), Password `123` *(configurable in `public/data/admin.json`)*
  - This example is for local development. Production uses the private server-side `ADMIN_PASSWORD` environment variable.

### 2. Optional: Connect Google Sheets Telemetry (`apps-script/Code.gs`)
1. Open your Google Sheet → **Extensions → Apps Script** and paste `apps-script/Code.gs`.
2. In **Project Settings → Script Properties**, add ALL required keys:
   - `SHEET_REG` (e.g. `Registration`)
   - `SHEET_L1` (e.g. `L1`), `SHEET_L2` (e.g. `L2`), `SHEET_L3` (e.g. `L3`)
   - `GAME_EPOCH` (`1`), `TEAM_RATE_LIMIT` (`90`), `TEAM_RATE_WINDOW_SECS` (`60`), `CACHE_TTL_SECS` (`21600`)
   - `ADMIN_PASSWORD` (use a private organizer password; it must not match a password in the public JSON file)
   - `MAX_PUZZLE_POINTS` (e.g. `500` — server-side upper bound per solve)
   - `SPREADSHEET_ID` (required only if Apps Script is standalone; optional if opened from Extensions → Apps Script)
3. Run `initializeSpreadsheet` once, then **Deploy → Web app** (`Execute as: Me`, `Who has access: Anyone`).
4. Copy `.env.example` to `.env` and set `VITE_APPS_SCRIPT_URL="<your-web-app-/exec-url>"`.

### 3. Build & Verify
```bash
npm run lint   # TypeScript check (tsc --noEmit)
npm run build  # Production bundle in ./dist
```

---

## Deploy to GitHub & Vercel

1. **Pre-Push Security Check**:
   - Set a private `ADMIN_PASSWORD` in the server host and Apps Script **Script Properties**. Keep it different from passwords in `public/data/admin.json`.
   - Confirm `.env` is untracked (`.gitignore` excludes `.env*` while keeping `.env.example`).
2. **Push to GitHub**:
   ```bash
   git init
   git add .
   git commit -m "feat: Pykachu Go v3.4"
   git branch -M main
   git remote add origin https://github.com/<your-username>/<your-repo>.git
   git push -u origin main
   ```
3. **Import into Vercel**:
   - Framework Preset: **Vite** (configured automatically via `vercel.json`)
   - Build Command: `npm run build` • Output Directory: `dist`
   - Environment Variables (Project Settings → Environment Variables):
     - `VITE_APPS_SCRIPT_URL`: Your deployed Google Apps Script `/exec` URL *(optional; runs locally if unset)*
     - `VITE_SITE_URL`: Custom canonical HTTPS domain for OG link previews *(optional; Vercel sets `VERCEL_PROJECT_PRODUCTION_URL` / `VERCEL_URL` automatically)*

