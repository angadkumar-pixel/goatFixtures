// Delivery reports from Gupshup: POST /api/wa-status?key=<secret>
// Gupshup calls this when a WhatsApp message is sent / delivered / read / failed. The address (with its key) is shown
// in the Control Room → WhatsApp panel; paste it into Gupshup → WhatsApp → Webhooks → Add Webhook.
const outbox = require('../lib/outbox');
const { HOOK_KEY, json, body } = require('../lib/http');

module.exports = async (req, res) => {
  const q = req.query || {};
  if (q.key !== HOOK_KEY) return json(res, 401, { error: 'Bad key' });
  if (req.method === 'GET') { // some providers check the address first
    if (q['hub.challenge']) { res.statusCode = 200; res.setHeader('Content-Type', 'text/plain'); return res.end(String(q['hub.challenge'])); }
    return json(res, 200, { ok: true });
  }
  try {
    const r = await outbox.handleReports(await body(req));
    json(res, 200, Object.assign({ ok: true }, r));
  } catch (e) {
    console.error('wa-status', e);
    json(res, 200, { ok: false }); // always 200 so Gupshup doesn't hammer us with retries
  }
};
