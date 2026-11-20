// POST /api/action (admin only) → apply one change and save it to Firebase; every screen gets it pushed instantly.
const fire = require('../lib/fire');
const outbox = require('../lib/outbox');
const core = require('../lib/core');
const shared = require('../public/js/goat-shared');
const auth = require('../lib/auth');
const { SECRET, json, fail, body } = require('../lib/http');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });
  if (!auth.isAdmin(req.headers.cookie, SECRET)) return json(res, 401, { error: 'Not logged in' });
  try {
    const act = await body(req);
    for (let attempt = 0; attempt < 4; attempt++) { // retry if another save landed at the same moment
      const { tree, st } = await fire.load();
      const base = st.rev, now = Date.now();
      if (act.type === 'undo') {
        const h = await fire.lastHistory();
        if (!h) return json(res, 400, { error: 'Nothing to undo' });
        const prev = core.migrate(shared.toState(h.entry.tree));
        prev.replayNonce = st.replayNonce; // undo never re-triggers the intro
        prev.canUndo = h.count - 1 > 0;
        if (!(await fire.commit(tree, prev, base))) continue;
        await fire.dropHistory(h.key);
        return json(res, 200, { ok: true, rev: prev.rev });
      }
      const before = tree; // exact previous contents, for undo
      const prevSt = JSON.parse(JSON.stringify(st));
      let result;
      try { result = core.apply(st, act, now); } catch (e) { return json(res, 400, { error: e.message }); }
      const keep = act.type !== 'replay';
      if (keep) st.canUndo = true;
      if (!(await fire.commit(tree, st, base))) continue;
      const [, contactsInfo] = await Promise.all([keep ? fire.pushHistory(before) : null, outbox.saveContacts(st)]);
      const wa = await outbox.afterChange(prevSt, st, contactsInfo); // WhatsApp: queue + send "soon" / "next" / "later"
      return json(res, 200, { ok: true, rev: st.rev, ...(result || {}), whatsapp: wa });
    }
    json(res, 409, { error: 'Busy, please try again' });
  } catch (e) { fail(res, e); }
};
