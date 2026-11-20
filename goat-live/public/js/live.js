// Shared live connection for every page.
//  • Online (Vercel): one live connection to Firebase Realtime Database; each change is pushed instantly and
//    carries only the matches that changed. No per-screen polling.
//  • Laptop / venue Wi-Fi (wifi-server.js): instant push over Server-Sent Events.
window.GoatLive = (() => {
  const CFG = window.GOAT_CONFIG || {};
  const S = window.GoatShared;
  let offset = 0, lastRev = -1, cb = () => {}, status = () => {};
  const now = () => Date.now() + offset;
  const getJSON = async (u, opt) => { const r = await fetch(u, { cache: 'no-store', ...opt }); if (!r.ok) throw new Error(String(r.status)); return r.json(); };

  // newest state wins (an older copy can never roll a screen back)
  function accept(s) {
    if (!s || typeof s.rev !== 'number' || s.rev < lastRev) return;
    lastRev = s.rev;
    if (s.now && !CFG.dbUrl) offset = s.now - Date.now();
    cb(s);
  }

  // ── Firebase mode ──
  function firebase() {
    let tree = {}, es = null, fails = 0, emitT = null, lastState = null;
    const syncClock = () => getJSON('/api/time').then((t) => { offset = t.now - Date.now(); }).catch(() => {});
    syncClock(); setInterval(syncClock, 5 * 60000);
    function setPath(path, value) {
      const parts = path.split('/').filter(Boolean);
      if (!parts.length) { tree = value && typeof value === 'object' ? value : {}; return; }
      let node = tree;
      for (let i = 0; i < parts.length - 1; i++) { if (!node[parts[i]] || typeof node[parts[i]] !== 'object') node[parts[i]] = {}; node = node[parts[i]]; }
      const k = parts[parts.length - 1];
      if (value === null) delete node[k]; else node[k] = value;
    }
    function emit() {
      clearTimeout(emitT);
      emitT = setTimeout(() => {
        const st = S.toState(tree);
        S.normalize(st, now()); // tentative times are worked out on the device
        st.boardSize = 10; st.now = now(); st.transport = 'firebase';
        if (st.rev >= lastRev) { lastRev = st.rev; lastState = st; cb(st); }
        pokeCountdowns(st);
      }, 30);
    }
    // Countdown reached 0 → ask the server to start the match (any screen can; the server does it once).
    const poked = new Map();
    function pokeCountdowns(st) {
      if (polling || (st.settings && st.settings.autoStart === false)) return; // spectators' phones never poke the server
      st.matches.forEach((m) => {
        if (m.status !== 'called' || !m.callAt || m.callAt > now() - 300) return;
        const last = poked.get(m.id) || 0;
        if (Date.now() - last < 8000) return;
        poked.set(m.id, Date.now());
        setTimeout(() => fetch('/api/tick', { method: 'POST' }).catch(() => {}), Math.random() * 1500);
      });
    }
    // Tentative times drift with the clock, so refresh them now and then. Countdowns tick on their own in each page,
    // so there is no need to rebuild 300 matches every second (that made weak screens stutter).
    setInterval(() => { if (lastRev >= 0) emit(); }, 20000);
    setInterval(() => { if (lastState) pokeCountdowns(lastState); }, 1000); // a countdown reaching 0 still starts the match on time
    // Phones watching the board (spectators) read a shared copy every 10 s from /api/board instead of each holding a
    // live database connection, so any number of them is fine. Also the fallback if live connections are refused.
    let polling = false;
    async function pollBoard() {
      polling = true;
      try {
        const t = await getJSON('/api/board?t=' + Math.floor(Date.now() / 5000));
        if (t && t.meta) { tree = t; status(true); emit(); }
      } catch { status(false); }
      setTimeout(pollBoard, document.hidden ? 30000 : 10000);
    }
    const isAdmin = /^\/admin/.test(location.pathname);
    const phone = !isAdmin && matchMedia('(pointer: coarse)').matches && Math.min(screen.width, screen.height) < 820;
    if (phone || /[?&]poll=1\b/.test(location.search)) { pollBoard(); return; }
    // big screens also keep WhatsApp retries / delivery checks running (the server does it at most every 20 s)
    if (!isAdmin) setInterval(() => { if (!document.hidden) fetch('/api/wa-kick', { method: 'POST' }).catch(() => {}); }, 30000 + Math.random() * 5000);
    function open() {
      if (polling) return;
      es = new EventSource(CFG.dbUrl.replace(/\/+$/, '') + '/goat.json');
      const onData = (patch) => (e) => {
        const { path, data } = JSON.parse(e.data);
        if (patch) Object.keys(data || {}).forEach((k) => setPath(path.replace(/\/+$/, '') + '/' + k, data[k]));
        else setPath(path, data);
        fails = 0; status(true); emit();
      };
      es.addEventListener('put', onData(false));
      es.addEventListener('patch', onData(true));
      es.addEventListener('keep-alive', () => status(true));
      es.onopen = () => status(true);
      es.onerror = () => { status(false); if (es.readyState === 2) { fails++; if (fails >= 4 && !isAdmin) { pollBoard(); return; } setTimeout(open, Math.min(15000, 1000 * 2 ** fails)); } };
    }
    open();
  }

  // ── laptop server mode ──
  function sse() {
    const es = new EventSource('/api/stream');
    es.addEventListener('state', (e) => { status(true); accept(JSON.parse(e.data)); });
    es.onerror = () => status(false);
  }
  async function poll() { // laptop server with ?poll (testing)
    try { const h = await getJSON('/api/rev'); status(true); if (h.rev !== lastRev) accept(await getJSON('/api/state')); } catch { status(false); }
    setTimeout(poll, 1000);
  }

  function connect(onState, onStatus = () => {}) {
    cb = onState; status = onStatus;
    if (CFG.dbUrl) return firebase();
    const forcePoll = new URLSearchParams(location.search).has('poll');
    (async function first() {
      try {
        const s = await getJSON('/api/state');
        status(true); accept(s);
        if (!forcePoll && window.EventSource) sse(); else setTimeout(poll, 1000);
      } catch { status(false); setTimeout(first, 3000); }
    })();
  }
  const fmtTime = (t) => (t ? new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }) : 'TBA');
  return { connect, now, fmtTime, push: accept, mode: CFG.dbUrl ? 'firebase' : 'local' };
})();
