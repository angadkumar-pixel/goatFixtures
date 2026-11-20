// GET /api/wa-events?since=<ms> (admin only) → WhatsApp pop-ups since then (delivered / not delivered / call them),
// plus the app version so an open Control Room reloads itself after an update.
const outbox = require('../lib/outbox');
const auth = require('../lib/auth');
const { SECRET, json, fail } = require('../lib/http');

module.exports = async (req, res) => {
  if (!auth.isAdmin(req.headers.cookie, SECRET)) return json(res, 401, { error: 'Not logged in' });
  try {
    const since = Number((req.query || {}).since) || Date.now();
    json(res, 200, { now: Date.now(), events: await outbox.events(since), ver: process.env.VERCEL_GIT_COMMIT_SHA || '' });
  } catch (e) { fail(res, e); }
};
