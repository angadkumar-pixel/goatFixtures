// POST /api/action (admin only) → apply one change, save it, return the new state straight away.
const store = require('../lib/store');
const core = require('../lib/core');
const auth = require('../lib/auth');
const { SECRET, json, fail, body } = require('../lib/http');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });
  if (!auth.isAdmin(req.headers.cookie, SECRET)) return json(res, 401, { error: 'Not logged in' });
  try {
    const act = await body(req);
    for (let attempt = 0; attempt < 4; attempt++) { // retry if a phone/another admin saved at the same moment
      const { st, histLen } = await store.load();
      const now = Date.now(), base = st.rev;
      let next = st, result = null, ok, canUndo;
      if (act.type === 'undo') {
        const prev = await store.lastSnapshot();
        if (!prev) return json(res, 400, { error: 'Nothing to undo' });
        prev.replayNonce = st.replayNonce; // undo never re-triggers the intro
        next = prev;
        core.normalize(next, now);
        ok = await store.save(next, base, { pop: true });
        canUndo = histLen - 1 > 0;
      } else {
        const snapshot = JSON.stringify(st);
        try { result = core.apply(st, act, now); } catch (e) { return json(res, 400, { error: e.message }); }
        core.normalize(st, now);
        const keep = act.type !== 'replay';
        ok = await store.save(st, base, { push: keep ? snapshot : '' });
        canUndo = keep || histLen > 0;
      }
      if (ok) return json(res, 200, { ok: true, rev: next.rev, ...(result || {}), state: core.view(next, { canUndo, transport: 'poll' }) });
    }
    json(res, 409, { error: 'Busy, please try again' });
  } catch (e) { fail(res, e); }
};
