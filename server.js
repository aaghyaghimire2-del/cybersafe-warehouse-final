/**
 * Warehouse Cyber Watch — local server
 * -------------------------------------------------
 * Plain Node.js HTTP server. Accounts, shift scores, and progress
 * (XP/rank/unlocks/achievements) are stored in MySQL — see schema.sql
 * for the tables, and db.js for the query layer. Sessions live in
 * memory (they're short-lived and don't need to survive a restart).
 *
 * Setup (once):
 *   1. Start XAMPP's MySQL/MariaDB service.
 *   2. Import schema.sql (phpMyAdmin -> Import, or `mysql -u root -p < schema.sql`).
 *   3. npm install
 *
 * Run:   node server.js
 * Open:  http://localhost:3000
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const url = require('url');
const db = require('./db');

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 14; // 14 days

/* ============================================================
   PASSWORD HASHING (Node's built-in crypto.scrypt — no bcrypt dep)
   ============================================================ */
function hashPassword(password, salt){
  salt = salt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { salt, hash };
}
function verifyPassword(password, salt, expectedHash){
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(expectedHash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/* ============================================================
   PROGRESSION SYSTEM — XP, ranks, level unlocks, achievements
   (unchanged from before — only the storage underneath moved to MySQL)
   ============================================================ */
const LEVELS = ['easy','normal','hard'];
const DIFF_XP_MULT = { easy: 1, normal: 1.5, hard: 2 };
const CORRECT_POINTS = 10; // must match public/js/game.js — server recomputes score, never trusts the client's number
// Must match public/js/game.js's DIFFICULTIES (time, wrongPenalty) — kept
// here too so save-score can validate/compute independent of the client.
const DIFFICULTIES = {
  easy:   { time: 360, wrongPenalty: 2 },
  normal: { time: 240, wrongPenalty: 5 },
  hard:   { time: 150, wrongPenalty: 8 }
};

const RANKS = [
  { id:'trainee',    name:'Trainee',          min:0 },
  { id:'rookie',      name:'Security Rookie',  min:100 },
  { id:'defender',    name:'Cyber Defender',   min:300 },
  { id:'expert',      name:'Cyber Expert',     min:700 }
];

function rankForXP(xp){
  let current = RANKS[0];
  for(const r of RANKS){ if(xp >= r.min) current = r; }
  return current;
}
function nextRankInfo(xp){
  const current = rankForXP(xp);
  const idx = RANKS.findIndex(r=>r.id===current.id);
  if(idx === RANKS.length-1) return null; // already at max rank
  const next = RANKS[idx+1];
  return { name: next.name, xpNeeded: next.min - xp, threshold: next.min };
}

/* ============================================================
   ACHIEVEMENTS
   Two kinds, both reported through the same achievementStates() list:

   - "derived": earned status is computed fresh, every time, straight
     from the account's saved progress (levels unlocked/completed, XP).
     These are always correct even for old accounts that never had this
     code running before — nothing needs to be replayed or migrated.
   - "event": tied to the exact stats of one specific shift (first ever
     shift, a flawless run, etc.) that aren't retained in cumulative
     progress, so these are recorded once into progress.achievements
     via grant() at the moment they're earned (see /api/save-score).
   ============================================================ */
const ACHIEVEMENTS = {
  first_shift: {
    name:'First Shift', category:'Milestone', kind:'event',
    desc:'Play your very first shift.',
    requirement:'Complete one shift, any level, any result.'
  },
  level2_unlocked: {
    name:'Level 2 Unlocked', category:'Progression', kind:'derived',
    desc:'Unlock the Normal difficulty level.',
    requirement:'Clear every real issue on Level 1 (Easy).',
    derive:(p)=> !!p.unlocked.normal
  },
  level3_unlocked: {
    name:'Level 3 Unlocked', category:'Progression', kind:'derived',
    desc:'Unlock the Hard difficulty level.',
    requirement:'Clear every real issue on Level 2 (Normal).',
    derive:(p)=> !!p.unlocked.hard
  },
  perfect_easy: {
    name:'Easy, Cleared Perfectly', category:'Mastery', kind:'derived',
    desc:'Fully clear Level 1 (Easy).',
    requirement:'Correctly flag every real issue on Easy in one shift.',
    derive:(p)=> !!p.completed.easy
  },
  perfect_normal: {
    name:'Normal, Cleared Perfectly', category:'Mastery', kind:'derived',
    desc:'Fully clear Level 2 (Normal).',
    requirement:'Correctly flag every real issue on Normal in one shift.',
    derive:(p)=> !!p.completed.normal
  },
  perfect_hard: {
    name:'Hard, Cleared Perfectly', category:'Mastery', kind:'derived',
    desc:'Fully clear Level 3 (Hard).',
    requirement:'Correctly flag every real issue on Hard in one shift.',
    derive:(p)=> !!p.completed.hard
  },
  site_secured: {
    name:'Site Secured', category:'Milestone', kind:'derived',
    desc:'Clear all three difficulty levels.',
    requirement:'Complete Easy, Normal and Hard at least once each.',
    derive:(p)=> !!(p.completed.easy && p.completed.normal && p.completed.hard),
    meter:(p)=> ({ current: LEVELS.filter(l=>p.completed[l]).length, target: LEVELS.length, label:'levels cleared' })
  },
  flawless: {
    name:'Flawless Judgment', category:'Skill', kind:'event',
    desc:'Finish a shift without a single wrong call.',
    requirement:'Complete a shift with zero incorrect judgments.'
  },
  decoy_detective: {
    name:'Decoy Detective', category:'Skill', kind:'event',
    desc:'Correctly clear every decoy in one shift.',
    requirement:'Correctly mark every non-issue as fine in one shift.'
  },
  speed_runner: {
    name:'Speed Runner', category:'Skill', kind:'event',
    desc:'Clear a shift with time to spare.',
    requirement:'Complete a shift with over half the timer still remaining.'
  },
  security_rookie: {
    name:'Security Rookie', category:'Rank', kind:'derived',
    desc:'Reach the Security Rookie rank.',
    requirement:'Earn 100 XP.',
    derive:(p)=> p.xp >= 100,
    meter:(p)=> ({ current: Math.min(p.xp,100), target: 100, label:'XP' })
  },
  cyber_defender: {
    name:'Cyber Defender', category:'Rank', kind:'derived',
    desc:'Reach the Cyber Defender rank.',
    requirement:'Earn 300 XP.',
    derive:(p)=> p.xp >= 300,
    meter:(p)=> ({ current: Math.min(p.xp,300), target: 300, label:'XP' })
  },
  cyber_expert: {
    name:'Cyber Expert', category:'Rank', kind:'derived',
    desc:'Reach the Cyber Expert rank.',
    requirement:'Earn 700 XP.',
    derive:(p)=> p.xp >= 700,
    meter:(p)=> ({ current: Math.min(p.xp,700), target: 700, label:'XP' })
  }
};

function computeXP(entry){
  const correctJudgments = entry.found + Math.max(0, entry.decoysCorrect || 0);
  let xp = correctJudgments * 5;
  if(entry.allFound) xp += 30;
  return Math.round(xp * (DIFF_XP_MULT[entry.difficulty] || 1));
}

// Full Locked/Unlocked state for every achievement, computed fresh from
// this account's current progress. Derived ones are always accurate;
// event ones fall back to whatever was recorded in progress.achievements
// the moment they were earned.
function achievementStates(progress){
  return Object.keys(ACHIEVEMENTS).map(id=>{
    const a = ACHIEVEMENTS[id];
    const earned = a.kind === 'derived' ? a.derive(progress) : progress.achievements.includes(id);
    const out = {
      id, name:a.name, category:a.category, desc:a.desc, requirement:a.requirement,
      earned, status: earned ? 'Unlocked' : 'Locked'
    };
    if(!earned && a.meter){ out.progress = a.meter(progress); }
    return out;
  });
}

function earnedAchievementIds(progress){
  return achievementStates(progress).filter(a=>a.earned).map(a=>a.id);
}

function progressSummary(progress){
  const completedCount = LEVELS.filter(l=>progress.completed[l]).length;
  const rank = rankForXP(progress.xp);
  return {
    xp: progress.xp,
    rank: rank.name,
    nextRank: nextRankInfo(progress.xp),
    unlocked: progress.unlocked,
    completed: progress.completed,
    bestScore: progress.bestScore,
    totalScore: LEVELS.reduce((a,l)=>a+(progress.bestScore[l]||0), 0),
    progressPercent: Math.round((completedCount / LEVELS.length) * 100),
    achievements: achievementStates(progress)
  };
}

/* ============================================================
   SESSIONS — in memory (not MySQL; short-lived, restart-safe to lose)
   ============================================================ */
const sessions = new Map(); // token -> { username, expires }

function parseCookies(req){
  const header = req.headers.cookie;
  const out = {};
  if(!header) return out;
  header.split(';').forEach(pair=>{
    const idx = pair.indexOf('=');
    if(idx === -1) return;
    const k = pair.slice(0, idx).trim();
    const v = pair.slice(idx+1).trim();
    out[k] = decodeURIComponent(v);
  });
  return out;
}

function createSession(username){
  const token = crypto.randomBytes(24).toString('hex');
  sessions.set(token, { username, expires: Date.now() + SESSION_TTL_MS });
  return token;
}

function getSessionUser(req){
  const cookies = parseCookies(req);
  const token = cookies.sid;
  if(!token) return null;
  const session = sessions.get(token);
  if(!session) return null;
  if(session.expires < Date.now()){
    sessions.delete(token);
    return null;
  }
  return session.username;
}

function setSessionCookie(res, token){
  res.setHeader('Set-Cookie', `sid=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_MS/1000}`);
}
function clearSessionCookie(res){
  res.setHeader('Set-Cookie', 'sid=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
}

/* ============================================================
   REQUEST HELPERS
   ============================================================ */
function sendJSON(res, status, obj){
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}

function readJSONBody(req){
  return new Promise((resolve, reject)=>{
    let data = '';
    let size = 0;
    const MAX = 1024 * 100; // 100kb is plenty for this app's payloads
    req.on('data', chunk=>{
      size += chunk.length;
      if(size > MAX){ reject(new Error('Payload too large')); req.destroy(); return; }
      data += chunk;
    });
    req.on('end', ()=>{
      if(!data){ resolve({}); return; }
      try{ resolve(JSON.parse(data)); }
      catch(e){ reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

const MIME = {
  '.html':'text/html; charset=utf-8',
  '.css':'text/css; charset=utf-8',
  '.js':'application/javascript; charset=utf-8',
  '.json':'application/json; charset=utf-8',
  '.svg':'image/svg+xml',
  '.png':'image/png',
  '.ico':'image/x-icon'
};

function serveStatic(req, res, pathname){
  // default to the loading splash for the root
  if(pathname === '/') pathname = '/loading.html';
  const safePath = path.normalize(pathname).replace(/^(\.\.[\/\\])+/, '');
  const filePath = path.join(PUBLIC_DIR, safePath);

  // prevent path traversal outside the public directory
  if(!filePath.startsWith(PUBLIC_DIR)){
    res.writeHead(403); res.end('Forbidden'); return;
  }

  fs.readFile(filePath, (err, data)=>{
    if(err){
      res.writeHead(404, { 'Content-Type':'text/plain' });
      res.end('Not found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

/* ============================================================
   VALIDATION
   ============================================================ */
function validUsername(u){
  return typeof u === 'string' && /^[a-zA-Z0-9_\-]{3,24}$/.test(u);
}
function validPassword(p){
  return typeof p === 'string' && p.length >= 6 && p.length <= 200;
}

/* ============================================================
   ROUTES
   ============================================================ */
async function handleApi(req, res, pathname){
  // ---- POST /api/register ----
  if(pathname === '/api/register' && req.method === 'POST'){
    let body;
    try{ body = await readJSONBody(req); } catch(e){ return sendJSON(res, 400, { error:'Invalid request body.' }); }
    const username = (body.username || '').trim();
    const password = body.password || '';

    if(!validUsername(username)){
      return sendJSON(res, 400, { error:'Username must be 3-24 characters: letters, numbers, _ or - only.' });
    }
    if(!validPassword(password)){
      return sendJSON(res, 400, { error:'Password must be at least 6 characters.' });
    }

    const key = username.toLowerCase();
    const existing = await db.getUserByKey(key);
    if(existing){
      return sendJSON(res, 409, { error:'That username is already taken.' });
    }

    const { salt, hash } = hashPassword(password);
    await db.createUser(key, username, salt, hash);

    // No session/cookie here on purpose: registration no longer logs the
    // user in. They see a success message, then must log in separately.
    return sendJSON(res, 201, { username, message: 'Your account has been registered successfully.' });
  }

  // ---- POST /api/login ----
  if(pathname === '/api/login' && req.method === 'POST'){
    let body;
    try{ body = await readJSONBody(req); } catch(e){ return sendJSON(res, 400, { error:'Invalid request body.' }); }
    const username = (body.username || '').trim();
    const password = body.password || '';
    const key = username.toLowerCase();

    const user = await db.getUserByKey(key);
    if(!user || !verifyPassword(password, user.salt, user.password_hash)){
      return sendJSON(res, 401, { error:'Incorrect username or password.' });
    }

    const token = createSession(key);
    setSessionCookie(res, token);
    return sendJSON(res, 200, { username: user.display_name });
  }

  // ---- POST /api/logout ----
  if(pathname === '/api/logout' && req.method === 'POST'){
    const cookies = parseCookies(req);
    if(cookies.sid) sessions.delete(cookies.sid);
    clearSessionCookie(res);
    return sendJSON(res, 200, { ok:true });
  }

  // ---- GET /api/me ----
  if(pathname === '/api/me' && req.method === 'GET'){
    const key = getSessionUser(req);
    if(!key) return sendJSON(res, 401, { error:'Not signed in.' });
    const user = await db.getUserByKey(key);
    if(!user) return sendJSON(res, 401, { error:'Not signed in.' });
    return sendJSON(res, 200, { username: user.display_name });
  }

  // ---- POST /api/save-score ----
  if(pathname === '/api/save-score' && req.method === 'POST'){
    const key = getSessionUser(req);
    if(!key) return sendJSON(res, 401, { error:'Not signed in.' });

    let body;
    try{ body = await readJSONBody(req); } catch(e){ return sendJSON(res, 400, { error:'Invalid request body.' }); }

    // REAL_SCENARIO_COUNT/DECOY_COUNT match the live game content (see
    // game.js) — the client is never trusted for these, only for which
    // specific ones it says it found within those fixed limits.
    const REAL_SCENARIO_COUNT = 13;
    const DECOY_COUNT = 6;

    const difficulty = LEVELS.includes(body.difficulty) ? body.difficulty : 'normal';
    const total = REAL_SCENARIO_COUNT;
    const decoysTotal = DECOY_COUNT;
    const found = Number.isFinite(body.found) ? Math.max(0, Math.min(total, Math.round(body.found))) : 0;
    const decoysCorrect = Number.isFinite(body.decoysCorrect) ? Math.max(0, Math.min(decoysTotal, Math.round(body.decoysCorrect))) : 0;
    const timeLimit = DIFFICULTIES[difficulty].time;
    const timeLeftAtEnd = Number.isFinite(body.timeLeftAtEnd) ? Math.max(0, Math.min(timeLimit, body.timeLeftAtEnd)) : 0;
    const wrongCount = Number.isFinite(body.wrongCount) ? Math.max(0, Math.min(total + decoysTotal, Math.round(body.wrongCount))) : 0;
    const allFound = !!body.allFound && found >= total;

    // Score is derived server-side from validated counts and the level's
    // own penalty rate, rather than trusting a client-submitted number —
    // this is what closes the "forged 1,000,000 XP shift" gap found in
    // the security audit.
    const penalty = DIFFICULTIES[difficulty].wrongPenalty;
    const score = Math.max(0, (found + decoysCorrect) * CORRECT_POINTS - wrongCount * penalty);

    const entry = { score, found, total, difficulty, allFound, wrongCount, decoysCorrect, decoysTotal, timeLeftAtEnd, timeLimit };

    const isFirstShift = (await db.countScores(key)) === 0;
    await db.addScore(key, entry);

    const progress = await db.ensureProgressRow(key);
    const earnedBefore = new Set(earnedAchievementIds(progress));

    const xpGained = computeXP(entry);
    progress.xp += xpGained;

    if(entry.score > progress.bestScore[entry.difficulty]){
      progress.bestScore[entry.difficulty] = entry.score;
    }

    if(entry.allFound){
      progress.completed[entry.difficulty] = true;
      const idx = LEVELS.indexOf(entry.difficulty);
      if(idx >= 0 && idx < LEVELS.length-1){
        progress.unlocked[LEVELS[idx+1]] = true;
      }
    }

    // Event-only achievements get recorded now, tied to this exact
    // shift's stats. Derived ones (levels/rank/perfect-clears) need
    // nothing here — achievementStates() below works them out fresh
    // from the progress we just updated above.
    function grant(id){
      if(!progress.achievements.includes(id)) progress.achievements.push(id);
    }
    if(isFirstShift) grant('first_shift');
    if(entry.wrongCount === 0 && (entry.found > 0 || entry.decoysCorrect > 0)) grant('flawless');
    if(entry.decoysTotal > 0 && entry.decoysCorrect >= entry.decoysTotal) grant('decoy_detective');
    if(entry.allFound && entry.timeLeftAtEnd >= entry.timeLimit / 2) grant('speed_runner');

    await db.saveProgress(key, progress);

    const newlyEarned = achievementStates(progress)
      .filter(a => a.earned && !earnedBefore.has(a.id))
      .map(a => ({ id:a.id, name:a.name, desc:a.desc }));

    return sendJSON(res, 201, {
      ok:true,
      xpGained,
      newAchievements: newlyEarned,
      progress: progressSummary(progress)
    });
  }

  // ---- GET /api/progress ----
  if(pathname === '/api/progress' && req.method === 'GET'){
    const key = getSessionUser(req);
    if(!key) return sendJSON(res, 401, { error:'Not signed in.' });
    const progress = await db.ensureProgressRow(key);
    return sendJSON(res, 200, progressSummary(progress));
  }

  // ---- GET /api/leaderboard ----
  if(pathname === '/api/leaderboard' && req.method === 'GET'){
    const key = getSessionUser(req);
    if(!key) return sendJSON(res, 401, { error:'Not signed in.' });

    const all = await db.getAllProgressWithNames();
    const rows = all.map(({ key: k, username, progress }) => {
      const completedCount = LEVELS.filter(l=>progress.completed[l]).length;
      return {
        username,
        xp: progress.xp,
        rank: rankForXP(progress.xp).name,
        totalScore: LEVELS.reduce((a,l)=>a+(progress.bestScore[l]||0), 0),
        missionsCompleted: completedCount,
        isYou: k === key
      };
    });

    rows.sort((a,b)=> b.xp - a.xp || b.totalScore - a.totalScore);
    return sendJSON(res, 200, { leaderboard: rows.slice(0, 50) });
  }

  // ---- POST /api/change-password ----
  if(pathname === '/api/change-password' && req.method === 'POST'){
    const key = getSessionUser(req);
    if(!key) return sendJSON(res, 401, { error:'Not signed in.' });

    let body;
    try{ body = await readJSONBody(req); } catch(e){ return sendJSON(res, 400, { error:'Invalid request body.' }); }
    const currentPassword = body.currentPassword || '';
    const newPassword = body.newPassword || '';

    const user = await db.getUserByKey(key);
    if(!user || !verifyPassword(currentPassword, user.salt, user.password_hash)){
      return sendJSON(res, 401, { error:'Current password is incorrect.' });
    }
    if(!validPassword(newPassword)){
      return sendJSON(res, 400, { error:'New password must be at least 6 characters.' });
    }
    const { salt, hash } = hashPassword(newPassword);
    await db.updateUserPassword(key, salt, hash);
    return sendJSON(res, 200, { ok:true });
  }

  // ---- POST /api/reset-progress ----
  if(pathname === '/api/reset-progress' && req.method === 'POST'){
    const key = getSessionUser(req);
    if(!key) return sendJSON(res, 401, { error:'Not signed in.' });
    const fresh = await db.resetProgress(key);
    await db.deleteScores(key);
    return sendJSON(res, 200, { ok:true, progress: progressSummary(fresh) });
  }

  // ---- GET /api/dashboard ----
  if(pathname === '/api/dashboard' && req.method === 'GET'){
    const key = getSessionUser(req);
    if(!key) return sendJSON(res, 401, { error:'Not signed in.' });

    const scores = await db.getScores(key);
    const count = scores.length;
    const best = count ? Math.max(...scores.map(s=>s.score)) : 0;
    const avg = count ? Math.round(scores.reduce((a,s)=>a+s.score,0) / count) : 0;
    const cleared = scores.filter(s=>s.allFound).length;

    return sendJSON(res, 200, {
      scores,
      stats: { count, best, avg, cleared }
    });
  }

  sendJSON(res, 404, { error:'Not found.' });
}

/* ============================================================
   SERVER
   ============================================================ */
const server = http.createServer((req, res)=>{
  const parsed = url.parse(req.url);
  const pathname = decodeURIComponent(parsed.pathname);

  if(pathname.startsWith('/api/')){
    handleApi(req, res, pathname).catch(err=>{
      console.error(err);
      sendJSON(res, 500, { error:'Server error — is MySQL running and schema.sql imported?' });
    });
    return;
  }

  serveStatic(req, res, pathname);
});

db.testConnection()
  .then(()=>{
    console.log('Connected to MySQL.');
    server.listen(PORT, ()=>{
      console.log(`Warehouse Cyber Watch running at http://localhost:${PORT}`);
    });
  })
  .catch(err=>{
    console.error('\nCould not connect to MySQL:', err.message);
    console.error('Checklist:');
    console.error('  1. Is XAMPP\'s MySQL/MariaDB service running?');
    console.error('  2. Have you imported schema.sql? (phpMyAdmin -> Import, or `mysql -u root -p < schema.sql`)');
    console.error('  3. Do the DB_HOST/DB_USER/DB_PASSWORD/DB_NAME env vars (if you set any) match your setup?');
    process.exit(1);
  });
