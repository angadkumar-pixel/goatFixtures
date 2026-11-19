// Shared live connection: subscribes to /api/stream and keeps a server-clock offset.
window.GoatLive = (() => {
  let offset = 0;
  const now = () => Date.now() + offset;
  function connect(onState, onStatus = () => {}) {
    let es;
    if (new URLSearchParams(location.search).has('poll')) { // fallback for networks/proxies that block streaming
      let last = -1;
      const tick = async () => {
        try {
          const s = await (await fetch('/api/state', { cache: 'no-store' })).json();
          offset = s.now - Date.now(); onStatus(true);
          if (s.rev !== last) { last = s.rev; onState(s); }
        } catch { onStatus(false); }
      };
      tick(); const id = setInterval(tick, 2000);
      return () => clearInterval(id);
    }
    const open = () => {
      es = new EventSource('/api/stream');
      es.addEventListener('state', (e) => {
        const s = JSON.parse(e.data);
        offset = s.now - Date.now();
        onStatus(true);
        onState(s);
      });
      es.onerror = () => onStatus(false);
    };
    open();
    return () => es && es.close();
  }
  const fmtTime = (t) => (t ? new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }) : 'TBA');
  return { connect, now, fmtTime };
})();
