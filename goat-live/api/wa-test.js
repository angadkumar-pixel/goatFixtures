// POST /api/wa-test { phone, kind } (admin only) → send one real WhatsApp message to check the Gupshup setup.
const notify = require('../lib/notify');
const auth = require('../lib/auth');
const { SECRET, json, fail, body } = require('../lib/http');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });
  if (!auth.isAdmin(req.headers.cookie, SECRET)) return json(res, 401, { error: 'Not logged in' });
  try {
    const { phone, kind } = await body(req);
    json(res, 200, await notify.testSend(phone, ['soon', 'next', 'later'].includes(kind) ? kind : 'next'));
  } catch (e) { fail(res, e); }
};
