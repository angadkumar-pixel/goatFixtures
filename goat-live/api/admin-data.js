// GET /api/admin-data (admin only) → phone numbers, WhatsApp status, the message log, who couldn't be reached,
// and the delivery-report address to paste into Gupshup.
const outbox = require('../lib/outbox');
const notify = require('../lib/notify');
const auth = require('../lib/auth');
const { SECRET, HOOK_KEY, json, fail } = require('../lib/http');

module.exports = async (req, res) => {
  if (!auth.isAdmin(req.headers.cookie, SECRET)) return json(res, 401, { error: 'Not logged in' });
  try {
    const webhookUrl = `https://${req.headers['x-forwarded-host'] || req.headers.host}/api/wa-status?key=${HOOK_KEY}`;
    json(res, 200, Object.assign(await outbox.adminData(), { whatsapp: notify.status(), webhookUrl }));
  } catch (e) { fail(res, e); }
};
