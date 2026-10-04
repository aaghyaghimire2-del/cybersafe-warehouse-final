// Layout checker — run with:  npm run check:layout   (add  -- --verbose  for the full per-task table)
//
// Runs the REAL public/js/game.js in Node, with a small stand-in for the 3D engine (run_game.js),
// then checks each level's floor plan. Nothing is rendered; this tests the numbers the game builds
// from: where every task sits, what blocks the player, and where the player can actually walk.
//
// For each of the three levels it checks:
//   - 13 real issues and 6 decoys exist, with no duplicates, none outside the walls
//   - the spawn point is on free floor
//   - every walkable cell can be reached on foot from the spawn (nothing is sealed off)
//   - every task has a spot to stand within 3.5 m (the game lets you inspect from 5.2 m)
//   - no collision box sits outside the room, and the IT officer can be clicked from the spawn
//   - neither worker's patrol route runs through furniture
//   - the map labels and racks are inside the room
// And: Level 1 is still identical to the original training hall (tests/layout/baseline_level1.json).
const path = require('path');
const fs = require('fs');
const { run } = require('./run_game.js');

const FILE = path.join(__dirname, '..', '..', 'public', 'js', 'game.js');
const VERBOSE = process.argv.includes('--verbose');
const LEVELS = [
  { key: 'easy',   name: 'Level 1 (Trainee)  ' },
  { key: 'normal', name: 'Level 2 (Standard) ' },
  { key: 'hard',   name: 'Level 3 (Expert)   ' }
];
const r1 = n => (Math.round(n * 10) / 10).toFixed(1);
const r3 = n => Math.round(n * 1000) / 1000;

async function analyse(level) {
  const ctx = await run(level.key, FILE);
  if (ctx.__err) return { problems: ['the game failed to start: ' + ctx.__err.message], lines: [] };
  const t = ctx.__t, R = t.ROOM, obs = t.obstacles;
  const problems = [], lines = [];
  const real = t.roster.filter(d => d.isMistake), decoy = t.roster.filter(d => !d.isMistake);

  if (real.length !== 13 || decoy.length !== 6) problems.push(`expected 13 real + 6 decoys, found ${real.length} + ${decoy.length}`);
  const titles = real.map(d => d.title);
  if (titles.some((x, i) => titles.indexOf(x) !== i)) problems.push('duplicate task titles');
  const outside = t.roster.filter(d => d.worldPos.x < R.minX + 0.3 || d.worldPos.x > R.maxX - 0.3 || d.worldPos.z < R.minZ + 0.3 || d.worldPos.z > R.maxZ - 0.3);
  if (outside.length) problems.push('tasks outside the walls: ' + outside.map(d => d.title).join(', '));

  // walking grid, using the same collision test as the game (a 0.8 m box, 0..2 m high, against every obstacle)
  const step = 0.25, rad = 0.4;
  const free = (x, z) => {
    if (x < R.minX + 0.6 || x > R.maxX - 0.6 || z < R.minZ + 0.6 || z > R.maxZ - 0.6) return false;
    for (const b of obs) {
      if (!(b.max.x < x - rad || b.min.x > x + rad || b.max.z < z - rad || b.min.z > z + rad || b.max.y < 0 || b.min.y > 2)) return false;
    }
    return true;
  };
  const nx = Math.round((R.maxX - R.minX) / step), nz = Math.round((R.maxZ - R.minZ) / step);
  const cx = i => R.minX + i * step, cz = j => R.minZ + j * step;
  const ok = [...Array(nx + 1)].map((_, i) => [...Array(nz + 1)].map((_, j) => free(cx(i), cz(j))));
  const sp = t.playerPos, si = Math.round((sp.x - R.minX) / step), sj = Math.round((sp.z - R.minZ) / step);
  if (!ok[si][sj]) problems.push('the spawn point is inside something');
  const seen = [...Array(nx + 1)].map(() => Array(nz + 1).fill(false));
  const stack = [[si, sj]]; seen[si][sj] = true;
  let reach = 0, total = 0;
  while (stack.length) {
    const [i, j] = stack.pop(); reach++;
    for (const [a, b] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const u = i + a, v = j + b;
      if (u >= 0 && v >= 0 && u <= nx && v <= nz && ok[u][v] && !seen[u][v]) { seen[u][v] = true; stack.push([u, v]); }
    }
  }
  for (let i = 0; i <= nx; i++) for (let j = 0; j <= nz; j++) if (ok[i][j]) total++;
  if (reach !== total) problems.push(`${total - reach} walkable cells are sealed off from the spawn`);

  let worst = 0;
  for (const d of [...real, ...decoy]) {
    let best = Infinity;
    for (let i = 0; i <= nx; i++) for (let j = 0; j <= nz; j++) {
      if (!seen[i][j]) continue;
      const dd = Math.hypot(cx(i) - d.worldPos.x, cz(j) - d.worldPos.z);
      if (dd < best) best = dd;
    }
    worst = Math.max(worst, best);
    if (best > 3.5) problems.push(`"${d.title}" is ${best.toFixed(1)} m from any spot you can stand on`);
    lines.push(`     ${d.isMistake ? '[task ]' : '[decoy]'} ${d.title.padEnd(40)} (${r1(d.worldPos.x).padStart(5)}, ${r1(d.worldPos.z).padStart(5)})  ${best.toFixed(2)} m`);
  }

  const out = obs.filter(b => b.min.x < R.minX - 0.5 || b.max.x > R.maxX + 0.5 || b.min.z < R.minZ - 0.5 || b.max.z > R.maxZ + 0.5);
  if (out.length) problems.push(out.length + ' collision boxes sit outside the room');
  const o = t.officer.group.position, od = Math.hypot(o.x - sp.x, o.z - sp.z);
  if (od >= 5.2) problems.push(`the IT officer is ${r1(od)} m from the spawn (must be under 5.2 m to click)`);
  t.workers.forEach((w, i) => {
    const [a, b] = w.path; let hit = 0;
    for (let k = 0; k <= 40; k++) if (!free(a.x + (b.x - a.x) * k / 40, a.z + (b.z - a.z) * k / 40)) hit++;
    if (hit) problems.push(`worker ${i + 1}'s patrol route runs through an obstacle`);
  });
  if (t.labels.some(l => l.x < R.minX || l.x > R.maxX || l.z < R.minZ || l.z > R.maxZ)) problems.push('a map label is outside the room');
  if (t.racks.some(r => r.x - r.w / 2 < R.minX || r.x + r.w / 2 > R.maxX || r.z - r.d / 2 < R.minZ || r.z + r.d / 2 > R.maxZ)) problems.push('a rack is outside the room');

  const summary = `${level.name} ${t.layout.padEnd(6)} room ${R.maxX - R.minX} x ${R.maxZ - R.minZ} | ` +
    `${real.length}+${decoy.length} tasks | ${(100 * reach / total).toFixed(1)}% of floor reachable | farthest task ${worst.toFixed(2)} m | ` +
    `${t.racks.length} racks | ${obs.length} collision boxes`;
  return { problems, lines, summary, snapshot: {
    room: t.ROOM, start: [r3(sp.x), r3(sp.z), r3(t.yaw)],
    roster: t.roster.map(d => `${d.isMistake ? 'T' : 'D'}|${d.title}|${r3(d.worldPos.x)},${r3(d.worldPos.y)},${r3(d.worldPos.z)}`).sort(),
    obstacles: obs.map(b => [b.min.x, b.min.y, b.min.z, b.max.x, b.max.y, b.max.z].map(r3).join(',')).sort(),
    workers: t.workers.map(w => ({ start: [r3(w.group.position.x), r3(w.group.position.z)], path: w.path.map(p => [r3(p.x), r3(p.z)]) })),
    officer: [r3(o.x), r3(o.z), r3(t.officer.group.rotation.y)],
    racks: t.racks
  } };
}

(async () => {
  let failed = 0, level1Snapshot = null;
  console.log('\nLAYOUT CHECK — real game code, one pass per level\n');
  for (const level of LEVELS) {
    const res = await analyse(level);
    if (level.key === 'easy') level1Snapshot = res.snapshot;
    console.log((res.problems.length ? 'FAIL  ' : 'ok    ') + (res.summary || level.name));
    if (VERBOSE) res.lines.forEach(l => console.log(l));
    res.problems.forEach(p => { failed++; console.log('        !! ' + p); });
  }
  const baseline = JSON.parse(fs.readFileSync(path.join(__dirname, 'baseline_level1.json'), 'utf8'));
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const changed = ['room', 'start', 'roster', 'obstacles', 'workers', 'officer', 'racks'].filter(k => !same(level1Snapshot[k], baseline[k]));
  console.log((changed.length ? 'FAIL  ' : 'ok    ') + 'Level 1 is ' + (changed.length ? 'DIFFERENT from the original training hall in: ' + changed.join(', ') : 'identical to the original training hall (tasks, collision boxes, racks, characters)'));
  if (changed.length) failed++;
  console.log(failed ? `\n${failed} problem(s) found.\n` : '\nAll checks passed.\n');
  process.exit(failed ? 1 : 0);
})();
