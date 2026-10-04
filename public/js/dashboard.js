(function(){
  const LEVEL_META = {
    easy:   { n:1, num:'01', label:'LEVEL 1', tag:'TRAINEE',  bars:1, time:'6:00', xp:'×1',   penalty:'−2', guide:'Full hints',  need:'',
              sub:'Trainee level — the map and arrow point you to every issue.',
              desc:'Obvious clues — bright warning signs and clear tells. Great for learning the basics.' },
    normal: { n:2, num:'02', label:'LEVEL 2', tag:'STANDARD', bars:2, time:'4:00', xp:'×1.5', penalty:'−5', guide:'Layout only', need:'Clear Level 1 to unlock',
              sub:'Standard level — an L-shaped warehouse, floor plan only, no hints.',
              desc:'A new L-shaped floor plan with a corner to turn. More realistic scenarios — you\'ll need to look closely to catch them.' },
    hard:   { n:3, num:'03', label:'LEVEL 3', tag:'EXPERT',   bars:3, time:'2:30', xp:'×2',   penalty:'−8', guide:'No hints',    need:'Clear Level 2 to unlock',
              sub:'Expert level — no hints, 2:30 on the clock.',
              desc:'A brand-new floor plan. Subtle and easy to miss — clues blend in, with more distractions around them.' }
  };
  const LEVEL_ORDER = ['easy','normal','hard'];

  // Same ranks/thresholds as the server (server.js RANKS).
  const RANK_STEPS = [
    { name:'Trainee',         xp:0 },
    { name:'Security Rookie', xp:100 },
    { name:'Cyber Defender',  xp:300 },
    { name:'Cyber Expert',    xp:700 }
  ];
  const RANK_THRESHOLDS = RANK_STEPS.map(r=>r.xp);

  /* ---------- inline stroke icons (no emoji) ---------- */
  const ICON_PATHS = {
    check:  '<polyline points="20 6 9 17 4 12"></polyline>',
    checkc: '<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path><polyline points="22 4 12 14.01 9 11.01"></polyline>',
    arrow:  '<line x1="5" y1="12" x2="19" y2="12"></line><polyline points="12 5 19 12 12 19"></polyline>',
    replay: '<polyline points="1 4 1 10 7 10"></polyline><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"></path>',
    lock:   '<rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path>',
    unlock: '<rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 9.9-1"></path>',
    flag:   '<path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"></path><line x1="4" y1="22" x2="4" y2="15"></line>',
    shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path>',
    star:   '<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon>',
    eye:    '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle>',
    zap:    '<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon>',
    award:  '<circle cx="12" cy="8" r="7"></circle><polyline points="8.21 13.89 7 23 12 20 17 23 15.79 13.88"></polyline>'
  };
  function ico(name, size, sw){
    return '<svg width="' + size + '" height="' + size + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="' + (sw || 2) +
      '" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="flex-shrink:0;display:block">' + ICON_PATHS[name] + '</svg>';
  }
  const ACHV_ICON_NAME = {
    first_shift:'flag', level2_unlocked:'unlock', level3_unlocked:'unlock',
    perfect_easy:'checkc', perfect_normal:'checkc', perfect_hard:'checkc', site_secured:'shield',
    flawless:'star', decoy_detective:'eye', speed_runner:'zap',
    security_rookie:'award', cyber_defender:'award', cyber_expert:'award'
  };
  function achvIcon(id, earned, size){
    return earned ? ico(ACHV_ICON_NAME[id] || 'star', size) : ico('lock', size);
  }
  // Achievements the server can't give a progress number for get a plain-English tip instead of a fake meter.
  const ACH_TIPS = {
    decoy_detective: 'In one shift, mark all 6 “nothing wrong” objects as Looks Fine. Decoys count toward XP too — worth checking every time.'
  };

  function fmtDate(iso){
    const d = new Date(iso);
    return d.toLocaleDateString(undefined, { month:'short', day:'numeric', year:'numeric' }) +
      ' · ' + d.toLocaleTimeString(undefined, { hour:'2-digit', minute:'2-digit' });
  }

  let achievementsById = {};

  function esc(s){
    const d = document.createElement('div');
    d.textContent = s == null ? '' : String(s);
    return d.innerHTML;
  }

  function getContinueLevel(progress){
    for(const l of LEVEL_ORDER){
      if(progress.unlocked[l] && !progress.completed[l]) return l;
    }
    return 'hard'; // everything cleared — offer a replay of the toughest mission
  }

  function renderProfile(username, progress, hasShifts){
    document.getElementById('avatar-circle').textContent = username.charAt(0).toUpperCase();
    document.getElementById('profile-name').textContent = username;
    document.getElementById('profile-rank').textContent = progress.rank.toUpperCase();
    const hour = new Date().getHours();
    document.getElementById('profile-greeting').textContent = !hasShifts ? 'WELCOME' :
      hour < 12 ? 'GOOD MORNING' : hour < 18 ? 'GOOD AFTERNOON' : 'GOOD EVENING';
  }

  function renderContinue(progress, scores){
    const level = getContinueLevel(progress);
    const meta = LEVEL_META[level];
    const allCleared = LEVEL_ORDER.every(l=>progress.completed[l]);
    const firstTime = scores.length === 0;
    const continueBtn = document.getElementById('continue-btn');
    const label = document.getElementById('continue-card').querySelector('.continue-label');
    const mission = document.getElementById('continue-mission');
    const sub = document.getElementById('continue-sub');

    if(allCleared){
      label.textContent = 'ALL MISSIONS CLEARED';
      if(progress.nextRank){
        mission.textContent = 'Next target: ' + progress.nextRank.name;
        sub.textContent = progress.nextRank.xpNeeded + ' XP to go — a full Level 3 shift is worth up to 250 XP.';
      } else {
        mission.textContent = 'You\'ve mastered every mission';
        sub.textContent = 'Top rank reached — replay any level below to keep your skills sharp.';
      }
      continueBtn.href = 'game.html?level=hard';
      continueBtn.textContent = 'REPLAY LEVEL 3';
    } else {
      label.textContent = firstTime ? 'START HERE' : 'CONTINUE';
      mission.textContent = 'Level ' + meta.n + ' mission';
      sub.textContent = meta.sub;
      continueBtn.href = 'game.html?level=' + level;
      continueBtn.textContent = firstTime ? 'START LEVEL ' + meta.n : 'RESUME MISSION';
    }
    continueBtn.style.display = '';
  }

  function bestFoundFor(scores, id){
    let best = null;
    scores.forEach(s=>{
      if(s.difficulty !== id) return;
      if(best === null || s.found > best.found) best = { found:s.found, total:s.total };
    });
    return best;
  }

  function renderLevels(progress, scores){
    const grid = document.getElementById('level-grid');
    grid.innerHTML = LEVEL_ORDER.map(id=>{
      const meta = LEVEL_META[id];
      const unlocked = progress.unlocked[id];
      const completed = progress.completed[id];
      const best = progress.bestScore[id];
      let statusClass = 'locked', statusChip = '<span class="chip">' + ico('lock', 13, 2.4) + 'LOCKED</span>';
      if(unlocked && !completed){ statusClass = 'unlocked'; statusChip = '<span class="chip warn">AVAILABLE</span>'; }
      if(completed){ statusClass = 'completed'; statusChip = '<span class="chip ok">' + ico('check', 13, 2.6) + 'COMPLETED</span>'; }

      let btn;
      if(!unlocked) btn = '<button class="lv-btn" disabled>' + ico('lock', 15) + 'LOCKED</button>';
      else if(completed) btn = '<a class="lv-btn replay" href="game.html?level=' + id + '">' + ico('replay', 16) + 'REPLAY</a>';
      else btn = '<a class="lv-btn" href="game.html?level=' + id + '">PLAY' + ico('arrow', 16, 2.4) + '</a>';

      let bestBlock = '';
      if(completed){
        const bf = bestFoundFor(scores, id);
        bestBlock = '<div class="lv-best">BEST RESULT<div class="lv-best-row"><span class="lv-best-score mono">' + esc(best) + '</span>' +
          '<span class="lv-best-sub">score' + (bf ? ' · ' + esc(bf.found) + ' / ' + esc(bf.total) + ' found' : '') + '</span></div></div>';
      }
      const needBlock = (!unlocked && meta.need)
        ? '<div class="lv-need">' + ico('lock', 16) + '<span>' + meta.need + '</span></div>' : '';

      const bars = [1,2,3].map(n=>'<i class="' + (n <= meta.bars ? 'on' : '') + '"></i>').join('');

      return `
        <div class="level-card lv-${id} ${statusClass}" data-level="${id}">
          <div class="lv-num" aria-hidden="true">${meta.num}</div>
          <div class="lv-top"><span class="lv-tag">${meta.tag}</span></div>
          <div class="lv-name">${meta.label}</div>
          <div class="lv-desc">${meta.desc}</div>
          <div class="lv-meta">
            <div><span>TIME LIMIT</span><b class="mono">${meta.time}</b></div>
            <div><span>XP MULTIPLIER</span><b class="mono">${meta.xp}</b></div>
            <div><span>WRONG CALL</span><b class="mono">${meta.penalty} pts</b></div>
            <div><span>GUIDANCE</span><b>${meta.guide}</b></div>
          </div>
          <div class="lv-diff"><em>DIFFICULTY</em>${bars}</div>
          <div class="lv-statusrow">${statusChip}</div>
          ${bestBlock}
          ${needBlock}
          ${btn}
        </div>
      `;
    }).join('');
  }

  function renderStats(progress){
    document.getElementById('stat-progress').textContent = progress.progressPercent + '%';
    document.getElementById('progress-bar-fill').style.width = progress.progressPercent + '%';

    document.getElementById('stat-total-score').textContent = progress.totalScore;

    document.getElementById('stat-xp').textContent = progress.xp;
    document.getElementById('stat-rank').textContent = progress.rank;

    const xpBar = document.getElementById('xp-bar-fill');
    const xpCaption = document.getElementById('xp-caption');
    const ring = document.getElementById('avatar-ring');
    if(progress.nextRank){
      const floor = RANK_THRESHOLDS.filter(t=>t <= progress.xp).pop() || 0;
      const span = progress.nextRank.threshold - floor;
      const pct = span > 0 ? Math.max(4, Math.min(100, Math.round(((progress.xp - floor) / span) * 100))) : 100;
      xpBar.style.width = pct + '%';
      xpCaption.textContent = progress.nextRank.xpNeeded + ' XP to ' + progress.nextRank.name;
      if(ring){
        ring.style.setProperty('--p', pct);
        ring.title = progress.nextRank.xpNeeded + ' XP to ' + progress.nextRank.name;
      }
    } else {
      xpBar.style.width = '100%';
      xpCaption.textContent = 'Max rank reached';
      if(ring){ ring.style.setProperty('--p', 100); ring.title = 'Max rank reached'; }
    }
  }

  /* ---------- rank roadmap ---------- */
  function renderRoadmap(progress){
    const track = document.getElementById('roadmap-track');
    const note = document.getElementById('roadmap-note');
    const last = RANK_STEPS.length - 1;
    let cur = 0;
    RANK_STEPS.forEach((r, i)=>{ if(progress.xp >= r.xp) cur = i; });

    let fillPct = 100;
    if(cur < last){
      const floor = RANK_STEPS[cur].xp, ceil = RANK_STEPS[cur + 1].xp;
      const frac = Math.max(0, Math.min(1, (progress.xp - floor) / (ceil - floor)));
      fillPct = ((cur + frac) / last) * 100;
    }

    const nodes = RANK_STEPS.map((r, i)=>{
      const state = i < cur ? 'done' : (i === cur ? 'current' : 'next');
      const left = (i / last) * 100;
      const circ = state === 'done' ? ico('check', 16, 3) : state === 'current' ? ico('shield', 18) : ico('lock', 14);
      const here = state === 'current' ? '<span class="chip warn">YOU ARE HERE</span>' : '';
      return '<div class="rm-node ' + state + '" style="left:' + left + '%">' +
        '<div class="rm-dot">' + circ + '</div>' +
        '<div class="rm-name">' + esc(r.name) + '</div>' +
        '<div class="rm-xp mono">' + r.xp + ' XP</div>' + here + '</div>';
    }).join('');

    track.innerHTML = '<div class="rm-fill" style="width:' + fillPct + '%"></div>' + nodes;
    note.innerHTML = progress.nextRank
      ? '<span class="rm-xp-num mono">' + esc(progress.nextRank.xpNeeded) + ' XP</span> to ' + esc(progress.nextRank.name)
      : 'Top rank reached';
  }

  /* ---------- closest achievements ---------- */
  function renderGoals(progress){
    const list = document.getElementById('goals-list');
    const locked = progress.achievements.filter(a=>!a.earned);
    const ratio = a => a.progress.current / a.progress.target;
    const withMeter = locked.filter(a=>a.progress).sort((a,b)=> ratio(b) - ratio(a));
    const without = locked.filter(a=>!a.progress);
    const picks = withMeter.concat(without).slice(0, 2);

    if(!picks.length){
      list.innerHTML = '<div class="goal-empty">Every achievement is unlocked — nothing left to chase. Nice work.</div>';
      return;
    }
    list.innerHTML = picks.map(a=>{
      const kind = a.category === 'Rank' ? 'blue' : 'warn';
      let body;
      if(a.progress){
        const pct = Math.round(100 * a.progress.current / a.progress.target);
        body = '<div class="mini-bar-track"><div class="mini-bar-fill xp" style="width:' + pct + '%"></div></div>' +
          '<div class="goal-meter mono"><span>' + esc(a.progress.current) + ' / ' + esc(a.progress.target) + ' ' + esc(a.progress.label) + '</span>' +
          '<span>' + esc(a.progress.target - a.progress.current) + ' to go</span></div>';
      } else {
        body = '<div class="goal-tip">' + esc(ACH_TIPS[a.id] || a.requirement) + '</div>';
      }
      return '<div class="goal-row"><div class="goal-ico">' + ico(ACHV_ICON_NAME[a.id] || 'star', 22) + '</div>' +
        '<div class="goal-body"><div class="goal-name"><span>' + esc(a.name) + '</span><span class="chip ' + kind + '">' + esc((a.category || '').toUpperCase()) + '</span></div>' + body + '</div></div>';
    }).join('');
  }

  /* ---------- achievements (with All / Unlocked / Locked filter) ---------- */
  let currentFilter = 'all';
  let allAchievements = [];

  function paintAchievements(){
    const shown = allAchievements.filter(a=> currentFilter === 'all' ? true : currentFilter === 'unlocked' ? a.earned : !a.earned);

    const tabs = document.getElementById('achv-filters').querySelectorAll('.filter-tab');
    tabs.forEach(t=> t.classList.toggle('active', t.dataset.filter === currentFilter));

    const grid = document.getElementById('achv-grid');
    if(!shown.length){
      grid.innerHTML = '<div class="empty-state achv-empty">Nothing here yet — keep playing.</div>';
      return;
    }
    grid.innerHTML = shown.map(a=>{
      const meterHtml = (!a.earned && a.progress)
        ? `<div class="achv-mini"><div class="mini-bar-track"><div class="mini-bar-fill xp" style="width:${Math.round(100*a.progress.current/a.progress.target)}%"></div></div></div>`
        : '';
      return `
      <button type="button" class="achv-card ${a.earned ? 'earned' : 'locked'}" data-achv-id="${esc(a.id)}">
        <div class="achv-icon">${achvIcon(a.id, a.earned, 24)}</div>
        <div class="achv-name">${esc(a.name)}</div>
        <div class="achv-desc">${esc(a.desc)}</div>
        ${meterHtml}
        <div class="achv-more">${a.earned ? 'Unlocked — tap for details' : 'Locked — tap for details'}</div>
      </button>
    `;
    }).join('');
  }

  function renderAchievements(progress){
    allAchievements = progress.achievements;
    achievementsById = {};
    allAchievements.forEach(a => { achievementsById[a.id] = a; });

    const unlockedCount = allAchievements.filter(a=>a.earned).length;
    document.getElementById('achv-count').textContent = '· ' + unlockedCount + ' / ' + allAchievements.length + ' UNLOCKED';
    document.getElementById('f-all').textContent = allAchievements.length;
    document.getElementById('f-unlocked').textContent = unlockedCount;
    document.getElementById('f-locked').textContent = allAchievements.length - unlockedCount;
    paintAchievements();
  }

  function wireAchievements(){
    // One delegated listener each, so re-rendering the grid never loses its click handling.
    document.getElementById('achv-filters').addEventListener('click', (e)=>{
      const btn = e.target && e.target.closest ? e.target.closest('[data-filter]') : null;
      if(!btn) return;
      currentFilter = btn.dataset.filter;
      paintAchievements();
    });
    document.getElementById('achv-grid').addEventListener('click', (e)=>{
      const card = e.target && e.target.closest ? e.target.closest('.achv-card') : null;
      if(card) openAchievement(achievementsById[card.dataset.achvId]);
    });
  }

  function openAchievement(a){
    if(!a) return;
    const modalIcon = document.getElementById('achv-modal-icon');
    modalIcon.innerHTML = achvIcon(a.id, a.earned, 34);
    modalIcon.className = 'achv-modal-icon' + (a.earned ? ' earned' : '');
    document.getElementById('achv-modal-category').textContent = (a.category || '').toUpperCase();
    document.getElementById('achv-modal-name').textContent = a.name;
    const pill = document.getElementById('achv-modal-pill');
    pill.textContent = a.status;
    pill.className = 'achv-modal-status-pill ' + (a.earned ? 'earned' : 'locked');
    document.getElementById('achv-modal-desc').textContent = a.desc;
    document.getElementById('achv-modal-requirement').textContent = a.requirement;
    document.getElementById('achv-modal-completion').textContent = a.earned
      ? 'Completed — this achievement has been unlocked on your account.'
      : 'Not yet completed — keep playing to meet the requirement above.';

    const meterWrap = document.getElementById('achv-modal-meter-wrap');
    if(!a.earned && a.progress){
      meterWrap.style.display = '';
      const pct = Math.round(100 * a.progress.current / a.progress.target);
      document.getElementById('achv-modal-meter-fill').style.width = pct + '%';
      document.getElementById('achv-modal-meter-caption').textContent =
        `${a.progress.current} / ${a.progress.target} ${a.progress.label}`;
    } else {
      meterWrap.style.display = 'none';
    }

    document.getElementById('achv-overlay').classList.remove('hidden');
  }

  function wireAchievementModal(){
    const overlay = document.getElementById('achv-overlay');
    document.getElementById('achv-close').addEventListener('click', ()=> overlay.classList.add('hidden'));
    overlay.addEventListener('click', (e)=>{ if(e.target === overlay) overlay.classList.add('hidden'); });
    document.addEventListener('keydown', (e)=>{ if(e.key === 'Escape') overlay.classList.add('hidden'); });
  }

  function renderLeaderboard(rows){
    const body = document.getElementById('leaderboard-body');
    const youChip = document.getElementById('lb-you');
    const youIdx = rows.findIndex(r=>r.isYou);
    if(youIdx >= 0){
      youChip.textContent = 'YOU ARE #' + (youIdx + 1) + ' OF ' + rows.length;
      youChip.hidden = false;
    } else {
      youChip.hidden = true;
    }
    if(!rows.length){
      body.innerHTML = '<tr><td colspan="5" class="empty-state">No players yet.</td></tr>';
      return;
    }
    body.innerHTML = rows.map((r,i)=>`
      <tr class="${r.isYou ? 'is-you' : ''}">
        <td><span class="rank-medal ${i < 3 ? 'r' + (i+1) : ''}">${i+1}</span></td>
        <td>${esc(r.username)}${r.isYou ? ' (you)' : ''}</td>
        <td>${esc(r.rank)}</td>
        <td class="mono">${esc(r.xp)}</td>
        <td>${esc(r.missionsCompleted)} / 3</td>
      </tr>
    `).join('');
  }

  function renderHistory(scores){
    const body = document.getElementById('history-body');
    if(scores.length === 0){
      body.innerHTML = '<div class="empty-state"><div class="empty-title">No shifts yet</div><div>Finish your first mission and it will show up here.</div></div>';
      return;
    }
    const rows = scores.slice().reverse().slice(0, 20).map(s=>`
      <tr>
        <td>${fmtDate(s.date)}</td>
        <td><span class="chip ${s.difficulty === 'easy' ? 'ok' : s.difficulty === 'hard' ? 'bad' : 'warn'}">${esc(s.difficulty.toUpperCase())}</span></td>
        <td>${s.found} / ${s.total}</td>
        <td class="mono">${s.score}</td>
        <td><span class="chip ${s.allFound ? 'ok' : 'bad'}">${s.allFound ? 'Cleared' : 'Time ran out'}</span></td>
        <td><a class="row-link" href="game.html?level=${encodeURIComponent(s.difficulty)}">${ico('replay', 14)}REPLAY</a></td>
      </tr>
    `).join('');
    body.innerHTML = `
      <table class="history">
        <thead>
          <tr><th>DATE</th><th>LEVEL</th><th>FOUND</th><th>SCORE</th><th>RESULT</th><th></th></tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    `;
  }

  /* ============================================================
     MODALS
     ============================================================ */
  function wireModal(openBtnId, overlayId, closeBtnId){
    const openBtn = document.getElementById(openBtnId);
    const overlay = document.getElementById(overlayId);
    const closeBtn = document.getElementById(closeBtnId);
    if(openBtn) openBtn.addEventListener('click', ()=> overlay.classList.remove('hidden'));
    if(closeBtn) closeBtn.addEventListener('click', ()=> overlay.classList.add('hidden'));
    overlay.addEventListener('click', (e)=>{ if(e.target === overlay) overlay.classList.add('hidden'); });
  }

  function wireSettingsForms(){
    const pwForm = document.getElementById('password-form');
    const pwMsg = document.getElementById('pw-msg');
    pwForm.addEventListener('submit', async (e)=>{
      e.preventDefault();
      pwMsg.className = 'msg';
      const currentPassword = document.getElementById('current-password').value;
      const newPassword = document.getElementById('new-password').value;
      try{
        const res = await fetch('/api/change-password', {
          method:'POST', headers:{ 'Content-Type':'application/json' }, credentials:'include',
          body: JSON.stringify({ currentPassword, newPassword })
        });
        const data = await res.json();
        if(!res.ok){
          pwMsg.textContent = data.error || 'Could not update password.';
          pwMsg.className = 'msg show';
        } else {
          pwMsg.textContent = 'Password updated.';
          pwMsg.className = 'msg show ok';
          pwForm.reset();
        }
      } catch(err){
        pwMsg.textContent = 'Network error — is the server running?';
        pwMsg.className = 'msg show';
      }
    });

    document.getElementById('reset-progress-btn').addEventListener('click', async ()=>{
      if(!confirm('This will permanently reset your XP, rank, unlocked levels, achievements, and shift history. Continue?')) return;
      try{
        await fetch('/api/reset-progress', { method:'POST', credentials:'include' });
        window.location.reload();
      } catch(err){
        alert('Network error — is the server running?');
      }
    });
  }

  /* ============================================================
     PREFERENCES (Settings modal — audio/display/gameplay)
     ============================================================ */
  function populateSettingsUI(){
    const s = window.CyberSettings.get();
    document.getElementById('set-master-volume').value = s.masterVolume;
    document.getElementById('set-master-volume-val').textContent = s.masterVolume + '%';
    document.getElementById('set-music-volume').value = s.musicVolume;
    document.getElementById('set-music-volume-val').textContent = s.musicVolume + '%';
    document.getElementById('set-sfx-volume').value = s.sfxVolume;
    document.getElementById('set-sfx-volume-val').textContent = s.sfxVolume + '%';
    document.getElementById('set-mute').checked = s.muted;
    document.getElementById('set-brightness').value = s.brightness;
    document.getElementById('set-brightness-val').textContent = s.brightness + '%';
    document.getElementById('set-dark-mode').checked = s.darkMode;
    document.getElementById('set-fullscreen').checked = !!document.fullscreenElement;
    document.getElementById('set-graphics-quality').value = s.graphicsQuality;
    document.getElementById('set-interaction-indicator').checked = s.interactionIndicator;
    document.getElementById('set-reduce-motion').checked = s.reduceMotion;
    document.getElementById('set-tutorial').checked = s.tutorial;
    document.getElementById('set-hints').checked = s.hints;
    document.getElementById('set-timer').checked = s.timerEnabled;
  }

  function playTestSound(){
    const s = window.CyberSettings.get();
    if(s.muted) return;
    try{
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = 880;
      const vol = (s.masterVolume/100) * (s.sfxVolume/100) * 0.18;
      gain.gain.setValueAtTime(vol, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.3);
      osc.connect(gain); gain.connect(ctx.destination);
      osc.start(); osc.stop(ctx.currentTime + 0.3);
    }catch(e){ /* audio not critical */ }
  }

  function wirePreferences(){
    populateSettingsUI();

    const masterEl = document.getElementById('set-master-volume');
    masterEl.addEventListener('input', ()=>{
      document.getElementById('set-master-volume-val').textContent = masterEl.value + '%';
      window.CyberSettings.save({ masterVolume: parseInt(masterEl.value,10) });
    });

    const musicEl = document.getElementById('set-music-volume');
    musicEl.addEventListener('input', ()=>{
      document.getElementById('set-music-volume-val').textContent = musicEl.value + '%';
      window.CyberSettings.save({ musicVolume: parseInt(musicEl.value,10) });
    });

    const sfxEl = document.getElementById('set-sfx-volume');
    sfxEl.addEventListener('input', ()=>{
      document.getElementById('set-sfx-volume-val').textContent = sfxEl.value + '%';
      window.CyberSettings.save({ sfxVolume: parseInt(sfxEl.value,10) });
    });

    document.getElementById('set-mute').addEventListener('change', (e)=>{
      window.CyberSettings.save({ muted: e.target.checked });
    });

    document.getElementById('vol-decrease-btn').addEventListener('click', ()=>{
      const v = Math.max(0, window.CyberSettings.get().masterVolume - 10);
      window.CyberSettings.save({ masterVolume: v });
      populateSettingsUI();
    });
    document.getElementById('vol-increase-btn').addEventListener('click', ()=>{
      const v = Math.min(100, window.CyberSettings.get().masterVolume + 10);
      window.CyberSettings.save({ masterVolume: v });
      populateSettingsUI();
    });
    document.getElementById('test-sound-btn').addEventListener('click', playTestSound);

    const brightnessEl = document.getElementById('set-brightness');
    brightnessEl.addEventListener('input', ()=>{
      document.getElementById('set-brightness-val').textContent = brightnessEl.value + '%';
      window.CyberSettings.save({ brightness: parseInt(brightnessEl.value,10) });
    });

    document.getElementById('set-dark-mode').addEventListener('change', (e)=>{
      window.CyberSettings.save({ darkMode: e.target.checked });
    });

    document.getElementById('set-fullscreen').addEventListener('change', (e)=>{
      if(e.target.checked){
        document.documentElement.requestFullscreen().catch(()=>{ e.target.checked = false; });
      } else if(document.fullscreenElement){
        document.exitFullscreen();
      }
    });
    document.addEventListener('fullscreenchange', ()=>{
      const el = document.getElementById('set-fullscreen');
      if(el) el.checked = !!document.fullscreenElement;
    });

    document.getElementById('set-graphics-quality').addEventListener('change', (e)=>{
      window.CyberSettings.save({ graphicsQuality: e.target.value });
    });

    document.getElementById('set-interaction-indicator').addEventListener('change', (e)=>{
      window.CyberSettings.save({ interactionIndicator: e.target.checked });
    });

    document.getElementById('set-reduce-motion').addEventListener('change', (e)=>{
      window.CyberSettings.save({ reduceMotion: e.target.checked });
    });

    document.getElementById('set-tutorial').addEventListener('change', (e)=>{
      window.CyberSettings.save({ tutorial: e.target.checked });
    });
    document.getElementById('set-hints').addEventListener('change', (e)=>{
      window.CyberSettings.save({ hints: e.target.checked });
    });
    document.getElementById('set-timer').addEventListener('change', (e)=>{
      window.CyberSettings.save({ timerEnabled: e.target.checked });
    });
  }

  /* ============================================================
     LOAD
     ============================================================ */
  async function load(){
    let me;
    try{
      const meRes = await fetch('/api/me', { credentials:'include' });
      if(!meRes.ok){ window.location.href = '/'; return; }
      me = await meRes.json();
    } catch(e){ window.location.href = '/'; return; }

    const [progressRes, dashRes, leaderboardRes] = await Promise.all([
      fetch('/api/progress', { credentials:'include' }),
      fetch('/api/dashboard', { credentials:'include' }),
      fetch('/api/leaderboard', { credentials:'include' })
    ]);

    if(!progressRes.ok){ window.location.href = '/'; return; }
    const progress = await progressRes.json();
    const dash = await dashRes.json();
    const leaderboard = await leaderboardRes.json();

    const scores = dash.scores || [];
    renderProfile(me.username, progress, scores.length > 0);
    renderContinue(progress, scores);
    renderLevels(progress, scores);
    renderStats(progress);
    renderRoadmap(progress);
    renderGoals(progress);
    renderAchievements(progress);
    renderLeaderboard(leaderboard.leaderboard || []);
    renderHistory(scores);
    document.getElementById('welcome-card').hidden = scores.length > 0;
  }

  document.getElementById('logout-btn').addEventListener('click', async ()=>{
    await fetch('/api/logout', { method:'POST', credentials:'include' });
    window.location.href = '/';
  });

  wireModal('howtoplay-btn', 'howtoplay-overlay', 'howtoplay-close');
  wireModal('settings-btn', 'settings-overlay', 'settings-close');
  wireAchievementModal();
  wireAchievements();
  document.getElementById('settings-btn').addEventListener('click', populateSettingsUI);
  wireSettingsForms();
  wirePreferences();

  load();
})();
