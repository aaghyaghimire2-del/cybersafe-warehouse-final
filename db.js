/**
 * MySQL data-access layer (XAMPP-friendly defaults: root user, no
 * password, localhost:3306). Override via environment variables if your
 * setup differs:
 *   DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME
 *
 * Sessions are NOT stored here — they live in memory in server.js, since
 * they're short-lived and don't need to survive a server restart.
 */

const mysql = require('mysql2/promise');

const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT ? Number(process.env.DB_PORT) : 3306,
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
database: process.env.DB_NAME || 'cyberwatch_final',
  waitForConnections: true,
  connectionLimit: 10
});

async function testConnection(){
  const conn = await pool.getConnection();
  try{ await conn.ping(); } finally{ conn.release(); }
}

/* ============================================================
   USERS
   ============================================================ */
async function getUserByKey(key){
  const [rows] = await pool.query('SELECT * FROM users WHERE username_key = ? LIMIT 1', [key]);
  return rows[0] || null;
}

async function createUser(key, displayName, salt, hash){
  const conn = await pool.getConnection();
  try{
    await conn.beginTransaction();
    await conn.query(
      'INSERT INTO users (username_key, display_name, salt, password_hash) VALUES (?, ?, ?, ?)',
      [key, displayName, salt, hash]
    );
    await conn.query(
      `INSERT INTO progress
        (username_key, xp, unlocked_easy, unlocked_normal, unlocked_hard,
         completed_easy, completed_normal, completed_hard,
         best_easy, best_normal, best_hard, achievements)
       VALUES (?, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, '[]')`,
      [key]
    );
    await conn.commit();
  }catch(err){
    await conn.rollback();
    throw err;
  }finally{
    conn.release();
  }
}

async function updateUserPassword(key, salt, hash){
  await pool.query('UPDATE users SET salt = ?, password_hash = ? WHERE username_key = ?', [salt, hash, key]);
}

/* ============================================================
   SCORES
   ============================================================ */
async function addScore(key, entry){
  await pool.query(
    `INSERT INTO scores
      (username_key, score, found, total, difficulty, all_found,
       wrong_count, decoys_correct, decoys_total, time_left_at_end, time_limit)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      key, entry.score, entry.found, entry.total, entry.difficulty, entry.allFound ? 1 : 0,
      entry.wrongCount, entry.decoysCorrect, entry.decoysTotal, entry.timeLeftAtEnd, entry.timeLimit
    ]
  );
}

async function countScores(key){
  const [rows] = await pool.query('SELECT COUNT(*) AS c FROM scores WHERE username_key = ?', [key]);
  return rows[0].c;
}

async function getScores(key){
  const [rows] = await pool.query(
    `SELECT score, found, total, difficulty, all_found AS allFound, created_at AS date
     FROM scores WHERE username_key = ? ORDER BY created_at ASC, id ASC`,
    [key]
  );
  return rows.map(r => ({
    score: r.score,
    found: r.found,
    total: r.total,
    difficulty: r.difficulty,
    allFound: !!r.allFound,
    date: r.date
  }));
}

async function deleteScores(key){
  await pool.query('DELETE FROM scores WHERE username_key = ?', [key]);
}

/* ============================================================
   PROGRESS
   ============================================================ */
function rowToProgress(row){
  let achievements = [];
  try{ achievements = JSON.parse(row.achievements || '[]'); }catch(e){ achievements = []; }
  return {
    xp: row.xp,
    unlocked: { easy: !!row.unlocked_easy, normal: !!row.unlocked_normal, hard: !!row.unlocked_hard },
    completed: { easy: !!row.completed_easy, normal: !!row.completed_normal, hard: !!row.completed_hard },
    bestScore: { easy: row.best_easy, normal: row.best_normal, hard: row.best_hard },
    achievements
  };
}

async function ensureProgressRow(key){
  const [rows] = await pool.query('SELECT * FROM progress WHERE username_key = ? LIMIT 1', [key]);
  if(rows[0]) return rowToProgress(rows[0]);
  // backfill for a user row that somehow has no matching progress row
  await pool.query(
    `INSERT INTO progress
      (username_key, xp, unlocked_easy, unlocked_normal, unlocked_hard,
       completed_easy, completed_normal, completed_hard,
       best_easy, best_normal, best_hard, achievements)
     VALUES (?, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, '[]')`,
    [key]
  );
  return {
    xp: 0,
    unlocked: { easy:true, normal:false, hard:false },
    completed: { easy:false, normal:false, hard:false },
    bestScore: { easy:0, normal:0, hard:0 },
    achievements: []
  };
}

async function saveProgress(key, progress){
  await pool.query(
    `UPDATE progress SET
      xp = ?,
      unlocked_easy = ?, unlocked_normal = ?, unlocked_hard = ?,
      completed_easy = ?, completed_normal = ?, completed_hard = ?,
      best_easy = ?, best_normal = ?, best_hard = ?,
      achievements = ?
     WHERE username_key = ?`,
    [
      progress.xp,
      progress.unlocked.easy ? 1 : 0, progress.unlocked.normal ? 1 : 0, progress.unlocked.hard ? 1 : 0,
      progress.completed.easy ? 1 : 0, progress.completed.normal ? 1 : 0, progress.completed.hard ? 1 : 0,
      progress.bestScore.easy, progress.bestScore.normal, progress.bestScore.hard,
      JSON.stringify(progress.achievements),
      key
    ]
  );
}

async function resetProgress(key){
  const fresh = {
    xp: 0,
    unlocked: { easy:true, normal:false, hard:false },
    completed: { easy:false, normal:false, hard:false },
    bestScore: { easy:0, normal:0, hard:0 },
    achievements: []
  };
  await saveProgress(key, fresh);
  return fresh;
}

/* ============================================================
   LEADERBOARD
   ============================================================ */
async function getAllProgressWithNames(){
  const [rows] = await pool.query(
    `SELECT u.username_key, u.display_name, p.*
     FROM users u JOIN progress p ON p.username_key = u.username_key`
  );
  return rows.map(r => ({
    key: r.username_key,
    username: r.display_name,
    progress: rowToProgress(r)
  }));
}

module.exports = {
  pool, testConnection,
  getUserByKey, createUser, updateUserPassword,
  addScore, countScores, getScores, deleteScores,
  ensureProgressRow, saveProgress, resetProgress,
  getAllProgressWithNames
};
