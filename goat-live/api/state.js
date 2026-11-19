// GET /api/state[?rev=N&t=bucket] → the full fixtures. With ?rev the CDN shares one copy per revision (and per 30 s for the clock).
const store = require('../lib/store');
const core = require('../lib/core');
const { json, fail } = require('../lib/http');

module.exports = async (req, res) => {
  try {
    const { st, histLen } = await store.load();
    core.normalize(st, Date.now()); // tentative times follow the clock
    const cache = req.query && req.query.rev ? 'public, s-maxage=30, stale-while-revalidate=5' : 'no-store';
    json(res, 200, core.view(st, { canUndo: histLen > 0, transport: 'poll' }), cache);
  } catch (e) { fail(res, e); }
};
