/**
 * Shared settings module — loaded on every page (login, dashboard, game).
 * Settings are personal device preferences, so they live in localStorage
 * (unlike game progress/XP/achievements, which stay server-side per account).
 */
(function(){
  const KEY = 'cwSettings';

  const DEFAULTS = {
    masterVolume: 80,
    musicVolume: 45,
    sfxVolume: 80,
    muted: false,
    brightness: 100,       // 50-150, mapped to a CSS brightness() filter
    darkMode: true,
    graphicsQuality: 'high', // 'low' | 'medium' | 'high'
    interactionIndicator: true,
    reduceMotion: false,
    tutorial: true,
    hints: true,
    timerEnabled: true
  };

  function getSettings(){
    try{
      const raw = localStorage.getItem(KEY);
      if(!raw) return Object.assign({}, DEFAULTS);
      const parsed = JSON.parse(raw);
      return Object.assign({}, DEFAULTS, parsed);
    }catch(e){
      return Object.assign({}, DEFAULTS);
    }
  }

  function saveSettings(partial){
    const current = getSettings();
    const next = Object.assign({}, current, partial);
    try{ localStorage.setItem(KEY, JSON.stringify(next)); }catch(e){ /* storage not critical */ }
    applyGlobalSettings(next);
    return next;
  }

  function applyGlobalSettings(settings){
    settings = settings || getSettings();
    document.documentElement.setAttribute('data-theme', settings.darkMode ? 'dark' : 'light');
    document.documentElement.style.filter = 'brightness(' + (settings.brightness / 100) + ')';
    document.documentElement.classList.toggle('reduce-motion', !!settings.reduceMotion);
  }

  // Apply immediately so there's no flash of the wrong theme/brightness.
  applyGlobalSettings();

  window.CyberSettings = { get: getSettings, save: saveSettings, apply: applyGlobalSettings, DEFAULTS: DEFAULTS };
})();
