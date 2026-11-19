// GET /api/rev → { rev, now }. Polled by every screen every ~1.5 s; Vercel's CDN answers all of them from one copy per second.
// Also where countdowns that reached 0 are turned into live matches (no background timers on Vercel).
const store = require('../lib/store');
const core = require('../lib/core');
const { json, fail } = require('../lib/http');

module.exports = async (req, res) => {
  try {
    let { rev, due } = await store.head();
    const now = Date.now();
    if (due && due <= now) {
      const { st } = await store.load();
      if (core.autoStart(st, now)) { core.normalize(st, now); if (await store.save(st, st.rev - 0)) rev = st.rev; }
    }
    json(res, 200, { rev, now }, 'public, s-maxage=1, stale-while-revalidate=1');
  } catch (e) { fail(res, e); }
};
