// POST /api/wa-retry (admin only)
//   {}                          → send whatever WhatsApp messages are due (the Control Room calls this every ~20 s; drives retries)
//   { id, action: 'retry' }     → try a failed message again from scratch
//   { id, action: 'done' }      → remove it from "call these players" (handled by phone)
const outbox = require('../lib/outbox');
const auth = require('../lib/auth');
const { SECRET, json, fail, body } = require('../lib/http');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });
  if (!auth.isAdmin(req.headers.cookie, SECRET)) return json(res, 401, { error: 'Not logged in' });
  try {
    const { id, action } = await body(req);
    if (id) return json(res, 200, await outbox.failedAction(String(id), action === 'done' ? 'done' : 'retry'));
    json(res, 200, Object.assign({ ok: true }, await outbox.processQueue(null, 20000)));
  } catch (e) { fail(res, e); }
};
