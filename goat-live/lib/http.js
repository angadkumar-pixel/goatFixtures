// Small helpers for the Vercel functions.
const crypto = require('crypto');

const PASSWORD = process.env.ADMIN_PASSWORD || '';
// Cookie-signing key: SESSION_SECRET if set, otherwise derived from the admin password.
const SECRET = process.env.SESSION_SECRET || crypto.createHash('sha256').update('goat-session:' + PASSWORD).digest('hex');

function json(res, code, body, cache = 'no-store') {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', cache);
  res.end(JSON.stringify(body));
}
const fail = (res, e, code = 500) => json(res, code, { error: e && e.message ? e.message : String(e) });
const isHttps = (req) => (req.headers['x-forwarded-proto'] || '').includes('https');
const clientIp = (req) => String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'x').split(',')[0].trim();
async function body(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') { try { return JSON.parse(req.body || '{}'); } catch { return {}; } }
  const chunks = []; for await (const c of req) chunks.push(c);
  try { return JSON.parse(Buffer.concat(chunks).toString() || '{}'); } catch { return {}; }
}
module.exports = { PASSWORD, SECRET, json, fail, isHttps, clientIp, body };
