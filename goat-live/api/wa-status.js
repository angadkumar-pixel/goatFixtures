// Delivery reports from Gupshup: /api/wa-status?key=<secret>  (GET or POST; JSON, form fields or URL parameters)
// Gupshup calls this when a WhatsApp message is sent / delivered / read / failed. The address (with its key) is shown
// in the Control Room → WhatsApp panel; paste it into Gupshup → WhatsApp → Webhooks → Add Webhook.
const outbox = require('../lib/outbox');
const { HOOK_KEY, json } = require('../lib/http');

// Read the body whatever its type: JSON, form-urlencoded or plain text.
async function rawBody(req) {
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body;
  let text = typeof req.body === 'string' ? req.body : Buffer.isBuffer(req.body) ? req.body.toString() : '';
  if (!text && req.method !== 'GET') { const chunks = []; for await (const c of req) chunks.push(c); text = Buffer.concat(chunks).toString(); }
  text = text.trim();
  if (!text) return {};
  try { return JSON.parse(text); } catch {}
  if (/^[^=&\s]+=/.test(text)) return Object.fromEntries(new URLSearchParams(text));
  return { text };
}
// Fields that themselves hold JSON (e.g. response=[{...}]) → parsed.
const unwrap = (o) => {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return o;
  const out = {};
  for (const [k, v] of Object.entries(o)) {
    if (typeof v === 'string' && /^\s*[\[{]/.test(v)) { try { out[k] = JSON.parse(v); continue; } catch {} }
    out[k] = v;
  }
  return out;
};

module.exports = async (req, res) => {
  const q = Object.assign({}, req.query || {});
  if (q.key !== HOOK_KEY) return json(res, 401, { error: 'Bad key' });
  delete q.key;
  if (q['hub.challenge']) { res.statusCode = 200; res.setHeader('Content-Type', 'text/plain'); return res.end(String(q['hub.challenge'])); }
  try {
    const b = unwrap(await rawBody(req)), extra = unwrap(q);
    if (req.method === 'GET' && !Object.keys(extra).length) return json(res, 200, { ok: true }); // just checking the address
    let payload = Array.isArray(b) ? b : Object.assign({}, extra, b);
    if (!Array.isArray(payload) && Object.keys(payload).length === 1 && payload.response) payload = payload.response; // response=[...]
    const r = await outbox.handleReports(payload, req.method);
    json(res, 200, Object.assign({ ok: true }, r));
  } catch (e) {
    console.error('wa-status', e);
    json(res, 200, { ok: false }); // always 200 so Gupshup doesn't hammer us with retries
  }
};
