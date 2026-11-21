// POST /api/wa-retry (admin only)
//   {}                          → send whatever WhatsApp messages are due (the Control Room calls this every ~20 s; drives retries)
//   { id, action: 'retry' }     → try a failed message again from scratch
//   { id, action: 'done' }      → remove it from "call these players" (handled by phone)
// POST /api/wa-kick (rewritten here as ?kick=1, anyone): keep WhatsApp moving — send what's due, retry, resend unconfirmed,
//   fill the call list. Vercel has no background timer, so TV/laptop boards call it every ~30 s, which keeps it going even
//   if the Control Room tab is asleep. Reveals nothing; runs at most once every 20 s however many screens ask.
const outbox = require('../lib/outbox');
const fire = require('../lib/fire');
const auth = require('../lib/auth');
const { SECRET, json, fail, body } = require('../lib/http');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });
  if (req.query && req.query.kick) return kick(req, res);
  if (!auth.isAdmin(req.headers.cookie, SECRET)) return json(res, 401, { error: 'Not logged in' });
  try {
    const { id, action } = await body(req);
    if (id) return json(res, 200, await outbox.failedAction(String(id), action === 'done' ? 'done' : 'retry'));
    json(res, 200, Object.assign({ ok: true }, await outbox.processQueue(null, 20000)));
  } catch (e) { fail(res, e); }
};

async function kick(req, res) {
  try {
    const [last, notifyOn] = await Promise.all([fire.get('goat_private/kick_at'), fire.get('goat/meta/settings/notify')]);
    if (!notifyOn) return json(res, 200, { ok: true, skipped: 'messages off' });
    if (last && Date.now() - last < 20000) return json(res, 200, { ok: true, skipped: 'recent' });
    await fire.patch('goat_private', { kick_at: Date.now() });
    // catch up: any top-10 match due a message that never got one (messages were OFF, or it became due as time passed)
    const [{ st }, contacts] = await Promise.all([fire.load(), fire.get('goat_private/contacts')]);
    const c = contacts || {};
    const caught = await outbox.afterChange(st, st, { before: c, after: c, changed: false });
    const r = await outbox.processQueue(null, 12000);
    json(res, 200, { ok: true, caughtUp: caught.queued || 0, pending: r.pending || 0 });
  } catch (e) { json(res, 200, { ok: false }); }
}
