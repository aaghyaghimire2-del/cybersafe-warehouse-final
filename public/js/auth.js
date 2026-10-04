(function(){
  const tabs = document.querySelectorAll('.tab');
  const panels = document.querySelectorAll('.form-panel');
  const msg = document.getElementById('msg');

  function showMessage(text, ok){
    msg.textContent = text;
    msg.className = 'msg show' + (ok ? ' ok' : '');
  }
  function clearMessage(){
    msg.className = 'msg';
    msg.textContent = '';
  }

  function activateTab(name, keepMessage){
    tabs.forEach(t=>t.classList.toggle('active', t.dataset.tab === name));
    panels.forEach(p=>p.classList.toggle('active', p.dataset.panel === name));
    if(!keepMessage) clearMessage();
  }

  tabs.forEach(tab=>{
    tab.addEventListener('click', ()=> activateTab(tab.dataset.tab, false));
  });

  // Show a brief loading screen while we check whether you're already
  // signed in, then either go straight to the dashboard or reveal the
  // login/register card — avoids a flash of the login form.
  const bootLoading = document.getElementById('boot-loading');
  const authCard = document.getElementById('auth-card');

  function revealLoginCard(){
    bootLoading.style.opacity = '0';
    setTimeout(()=>{ bootLoading.style.display = 'none'; }, 350);
    authCard.style.display = 'block';
  }

  const sessionCheck = fetch('/api/me', { credentials:'include' })
    .then(r => r.ok ? r.json() : null)
    .catch(()=> null);
  const minDisplayTime = new Promise(resolve => setTimeout(resolve, 700));

  Promise.all([sessionCheck, minDisplayTime]).then(([data])=>{
    if(data && data.username){
      window.location.href = '/dashboard.html';
      return;
    }
    revealLoginCard();
  });

  document.getElementById('login-form').addEventListener('submit', async (e)=>{
    e.preventDefault();
    clearMessage();
    const btn = document.getElementById('login-btn');
    const username = document.getElementById('login-username').value.trim();
    const password = document.getElementById('login-password').value;
    btn.disabled = true; btn.textContent = 'SIGNING IN…';
    try{
      const res = await fetch('/api/login', {
        method:'POST',
        headers:{ 'Content-Type':'application/json' },
        credentials:'include',
        body: JSON.stringify({ username, password })
      });
      const data = await res.json();
      if(!res.ok){
        showMessage(data.error || 'Could not sign in.', false);
      } else {
        window.location.href = '/dashboard.html';
        return;
      }
    } catch(err){
      showMessage('Network error — is the server running?', false);
    }
    btn.disabled = false; btn.textContent = 'LOG IN';
  });

  document.getElementById('register-form').addEventListener('submit', async (e)=>{
    e.preventDefault();
    clearMessage();
    const btn = document.getElementById('register-btn');
    const username = document.getElementById('reg-username').value.trim();
    const password = document.getElementById('reg-password').value;
    const password2 = document.getElementById('reg-password2').value;

    if(password !== password2){
      showMessage('Passwords do not match.', false);
      return;
    }
    if(!/^[a-zA-Z0-9_\-]{3,24}$/.test(username)){
      showMessage('Username must be 3-24 characters: letters, numbers, _ or - only.', false);
      return;
    }

    btn.disabled = true; btn.textContent = 'CREATING…';
    try{
      const res = await fetch('/api/register', {
        method:'POST',
        headers:{ 'Content-Type':'application/json' },
        credentials:'include',
        body: JSON.stringify({ username, password })
      });
      const data = await res.json();
      if(!res.ok){
        showMessage(data.error || 'Could not create account.', false);
        btn.disabled = false; btn.textContent = 'CREATE ACCOUNT';
      } else {
        showMessage(data.message || 'Your account has been registered successfully.', true);
        document.getElementById('register-form').reset();
        // Keep the success message on screen, then move the person to the
        // Login tab — they must sign in themselves; we no longer log them
        // in automatically on registration.
        setTimeout(()=>{
          activateTab('login', true);
          const loginUser = document.getElementById('login-username');
          loginUser.value = username;
          document.getElementById('login-password').focus();
        }, 1600);
        return; // leave the CREATING… button state as-is until the tab switches
      }
    } catch(err){
      showMessage('Network error — is the server running?', false);
      btn.disabled = false; btn.textContent = 'CREATE ACCOUNT';
    }
  });
})();
