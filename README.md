# Warehouse Cyber Watch

A 3D, first-person warehouse walkthrough where you judge whether things you
find are real security issues or not, across 3 sequential levels — with
accounts, XP/ranks, achievements, a leaderboard, and a dashboard, all backed
by MySQL.

## Folder structure

```
warehouse-cyber-watch/
├── server.js              Node.js server (auth, API, static file hosting)
├── db.js                  MySQL data-access layer (via mysql2)
├── schema.sql              Run once to create the database + tables
├── package.json
└── public/
    ├── loading.html        Splash screen
    ├── index.html          Login / Register page
    ├── dashboard.html      Levels, progress, XP/rank, achievements, leaderboard, settings
    ├── game.html            The 3D game itself
    ├── css/
    │   ├── auth.css         Shared styling for login/register/dashboard
    │   ├── dashboard.css     Dashboard-specific styling
    │   └── game.css          Styling for the game HUD/overlays
    └── js/
        ├── settings.js       Shared display/theme settings (localStorage)
        ├── auth.js           Login/register form logic
        ├── dashboard.js       Dashboard rendering + settings controls
        └── game.js            The full Three.js game (scene, characters,
                                interactions, difficulty content, hints, etc.)
```

The game loads Three.js from a CDN (`cdnjs.cloudflare.com/.../three.min.js`)
inside `game.html`, so you'll need an internet connection the first time each
browser loads it (cached after that). Everything else runs on your own
machine, talking to MySQL on `localhost`.

## Setup

**You need:** [Node.js](https://nodejs.org) (14+) and [XAMPP](https://www.apachefriends.org/)
(for its MySQL/MariaDB service — you don't need Apache/PHP running for this).

**1. Start MySQL in XAMPP** — open the XAMPP Control Panel and click **Start**
next to *MySQL*.

**2. Create the database and tables** — import `schema.sql` one of two ways:

- *phpMyAdmin* (easiest): open `http://localhost/phpmyadmin` → **Import** tab
  → choose `schema.sql` → **Go**.
- *Command line*:
  ```bash
  mysql -u root -p < schema.sql
  ```
  (XAMPP's default root password is blank — just press Enter.)

**3. Install dependencies** — this project has exactly one: the MySQL driver.
  ```bash
  cd warehouse-cyber-watch
  npm install
  ```

**4. Run it**
  ```bash
  node server.js
  ```
  You should see `Connected to MySQL.` followed by the server URL. If you
  instead see a connection error, the message tells you what to check
  (MySQL running? schema imported? credentials right?).

Then open **http://localhost:3000** in your browser. To stop the server,
press `Ctrl+C`.

### If your MySQL setup isn't the XAMPP default

The server assumes XAMPP's defaults: host `localhost`, port `3306`, user
`root`, no password, database `cyberwatch`. Override any of these with
environment variables if yours differ:

```bash
DB_HOST=localhost DB_PORT=3306 DB_USER=root DB_PASSWORD=yourpass DB_NAME=cyberwatch node server.js
```

## How accounts & data work

- **MySQL holds three tables** (see `schema.sql`): `users` (accounts),
  `scores` (one row per shift you play), and `progress` (XP, rank, unlocked
  and completed levels, best score per level, and earned achievements).
- **Sessions are not in MySQL** — they live in the server's memory, since
  they're short-lived login tokens, not data you need to keep. Restarting
  the server signs everyone out (they just log back in); it does **not**
  touch your account, scores, or progress in MySQL.
- Passwords are never stored in plain text — each is hashed with a random
  salt using Node's built-in `crypto.scrypt`, and only the salt + hash are
  saved.
- Logging in sets an `HttpOnly` session cookie valid for 14 days.
- **This is a self-hosted setup meant for personal, classroom, or internal
  training use** — not a production-hardened auth system. If you ever
  deploy this somewhere public, put it behind HTTPS and use a real,
  non-default MySQL user/password rather than XAMPP's root-with-no-password
  default.

## Using the app

1. Open the site → a short loading screen → **Login / Register**.
2. Create an account (username 3-24 characters, password 6+ characters).
3. **Dashboard**: pick a level (Level 1 is unlocked to start; 2 and 3 unlock
   as you clear the one before), track XP/rank/achievements, check the
   leaderboard, and adjust Settings (audio, brightness, theme, hints, etc.).
4. Play a level: WASD to move, mouse to look, click to inspect something,
   then judge it — flag it as a concern or call it fine — and find out
   immediately if you were right.
5. Clear all 13 real issues to complete the level and unlock the next one;

> **Each level has its own floor plan.**
>
> | Level | Layout | What it is like |
> |---|---|---|
> | 1 (Trainee) | Training hall (36 × 50) | One straight aisle, racks on both sides, full hints on the map |
> | 2 (Standard) | L-shaped warehouse (48 × 44, solid corner block) | Two wings joined at a corner; entrance at the east end, loading dock at the far north; floor plan only |
> | 3 (Expert) | Wide hub (50 × 36) | Offices in a central block, rack rows that block sight-lines, entrance west / dock east; no hints |
>
> All three have the same 13 real issues and 6 decoys, in different places. `npm run check:layout`
> runs the real game code with a stand-in for the 3D engine and checks, for every level, that all
> 19 objects exist, that every part of the floor can be reached on foot from the spawn point, that
> nothing is sealed off, and that Level 1 is still identical to the original hall.
> Floor-plan images for Levels 2 and 3 are in `docs/floor-plans/`.
   your result is saved automatically either way.

## API reference

| Method | Route                 | Body                                                                                   | Notes                              |
|--------|-----------------------|-----------------------------------------------------------------------------------------|-------------------------------------|
| POST   | `/api/register`       | `{ username, password }`                                                                 | Creates account + logs in           |
| POST   | `/api/login`          | `{ username, password }`                                                                 | Verifies password, logs in          |
| POST   | `/api/logout`         | —                                                                                        | Clears the session                  |
| GET    | `/api/me`             | —                                                                                        | Returns the signed-in username      |
| POST   | `/api/save-score`     | `{ score, found, total, difficulty, allFound, wrongCount, decoysCorrect, decoysTotal, timeLeftAtEnd, timeLimit }` | Requires being signed in; returns XP/achievements/updated progress |
| GET    | `/api/progress`       | —                                                                                        | XP, rank, unlocked/completed levels, achievements |
| GET    | `/api/leaderboard`    | —                                                                                        | Top 50 players by XP                |
| POST   | `/api/change-password`| `{ currentPassword, newPassword }`                                                        | —                                    |
| POST   | `/api/reset-progress` | —                                                                                        | Wipes XP/progress/history for the account |
| GET    | `/api/dashboard`      | —                                                                                        | Shift history + stats               |

## Extending it

- Want to inspect or edit data directly? Open phpMyAdmin
  (`http://localhost/phpmyadmin`) → the `cyberwatch` database → browse the
  `users`, `scores`, or `progress` tables.
- Want a hosted MySQL instance instead of XAMPP later (e.g. for a real
  deployment)? Just point the `DB_*` environment variables at it — nothing
  else in the app needs to change, since all the SQL lives in `db.js`.
