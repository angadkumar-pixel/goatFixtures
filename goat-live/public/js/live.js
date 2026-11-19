// Shared live connection.
// Laptop/Wi-Fi server → instant push over Server-Sent Events.
// Vercel → checks a tiny "revision" every 1.5 s and downloads the fixtures only when something changed.
window.GoatLive = (() => {
  let offset = 0, lastRev = -1, cb = () => {}, status = () => {}, lastBucket = -1;
  const now = () => Date.now() + offset;
  const getJSON = async (u) => { const r = await fetch(u, { cache: 'no-store' }); if (!r.ok) throw new Error(String(r.status)); return r.json(); };

  // newest state wins (a cached copy can never roll the screen back)
  function accept(s) {
    if (!s || typeof s.rev !== 'number' || s.rev < lastRev) return;
    lastRev = s.rev;
    if (s.now) offset = s.now - Date.now();
    cb(s);
  }
  function sse() {
    const es = new EventSource('/api/stream');
    es.addEventListener('state', (e) => { status(true); accept(JSON.parse(e.data)); });
    es.onerror = () => status(false);
  }
  async function poll() {
    try {
      const h = await getJSON('/api/rev');
      status(true);
      const bucket = Math.floor(h.now / 30000); // also refresh every 30 s so tentative times follow the clock
      if (h.rev !== lastRev || bucket !== lastBucket) {
        lastBucket = bucket;
        accept(await getJSON(`/api/state?rev=${h.rev}&t=${bucket}`));
      }
    } catch { status(false); }
    setTimeout(poll, document.hidden ? 5000 : 1000);
  }
  function connect(onState, onStatus = () => {}) {
    cb = onState; status = onStatus;
    const forcePoll = new URLSearchParams(location.search).has('poll');
    (async function first() {
      try {
        const s = await getJSON('/api/state');
        status(true); accept(s);
        if (s.transport === 'sse' && !forcePoll && window.EventSource) sse(); else setTimeout(poll, 1000);
      } catch { status(false); setTimeout(first, 3000); }
    })();
  }
  const fmtTime = (t) => (t ? new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }) : 'TBA');
  return { connect, now, fmtTime, push: accept };
})();
