// Firebase Realtime Database over its REST API, from the Vercel functions (plain fetch, no packages).
// Env: FIREBASE_DB_URL (https://<project>-default-rtdb.<region>.firebasedatabase.app)
//      FIREBASE_SERVICE_ACCOUNT (the whole service-account JSON file, pasted as the value)
const crypto = require('crypto');

const DB = (process.env.FIREBASE_DB_URL || '').trim().replace(/\/+$/, '');
const scope = 'https://www.googleapis.com/auth/firebase.database https://www.googleapis.com/auth/userinfo.email';

function serviceAccount() {
  const raw = (process.env.FIREBASE_SERVICE_ACCOUNT || '').trim();
  if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT is not set in Vercel → Settings → Environment Variables.');
  let sa;
  try { sa = JSON.parse(raw); } catch { try { sa = JSON.parse(Buffer.from(raw, 'base64').toString()); } catch { throw new Error('FIREBASE_SERVICE_ACCOUNT is not valid JSON (paste the whole downloaded file).'); } }
  sa.private_key = String(sa.private_key || '').replace(/\\n/g, '\n');
  return sa;
}
let cached = null;
async function accessToken() {
  if (process.env.FIREBASE_TEST_TOKEN) return process.env.FIREBASE_TEST_TOKEN; // local tests only
  if (cached && cached.exp > Date.now() + 60000) return cached.token;
  const sa = serviceAccount(), now = Math.floor(Date.now() / 1000);
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ iss: sa.client_email, scope, aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 })}`;
  const sig = crypto.createSign('RSA-SHA256').update(unsigned).sign(sa.private_key, 'base64url');
  const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${sig}` }) });
  const j = await r.json();
  if (!j.access_token) throw new Error('Firebase sign-in failed: ' + (j.error_description || j.error || r.status));
  cached = { token: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 };
  return cached.token;
}

// Two ways to sign in: FIREBASE_DB_SECRET (Project settings → Service accounts → Database secrets — simplest,
// works even when the organisation blocks key creation) or FIREBASE_SERVICE_ACCOUNT (a service-account JSON key).
const DB_SECRET = (process.env.FIREBASE_DB_SECRET || '').trim();
async function authParam() {
  if (DB_SECRET && !process.env.FIREBASE_TEST_TOKEN) return 'auth=' + encodeURIComponent(DB_SECRET);
  if (!DB_SECRET && !process.env.FIREBASE_SERVICE_ACCOUNT && !process.env.FIREBASE_TEST_TOKEN)
    throw new Error('Set FIREBASE_DB_SECRET (Firebase → Project settings → Service accounts → Database secrets) in Vercel → Settings → Environment Variables.');
  return 'access_token=' + encodeURIComponent(await accessToken());
}

async function req(method, path, { body, query = '', headers = {} } = {}) {
  if (!DB) throw new Error('FIREBASE_DB_URL is not set in Vercel → Settings → Environment Variables.');
  const url = `${DB}/${path}.json?${await authParam()}${query}`;
  const r = await fetch(url, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let data = null; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!r.ok && r.status !== 412) throw new Error(`Firebase ${method} ${path}: ${r.status} ${data && data.error ? data.error : text}`.slice(0, 300));
  return { status: r.status, data, etag: r.headers.get('etag') };
}

const get = async (path, query) => (await req('GET', path, { query })).data;
const patch = (path, body) => req('PATCH', path, { body });
const put = (path, body) => req('PUT', path, { body });
const del = (path) => req('DELETE', path);

// Claim the next revision (compare-and-set). Only one writer can move rev from `base` to `next`.
async function claim(base, next) {
  const cur = await req('GET', 'goat/meta/rev', { headers: { 'X-Firebase-ETag': 'true' } });
  if ((Number(cur.data) || 0) !== base) return false;
  const r = await req('PUT', 'goat/meta/rev', { body: next, headers: { 'if-match': cur.etag } });
  return r.status === 200;
}

// Undo history (private, never sent to screens): last 25 snapshots.
async function pushHistory(tree) {
  await req('POST', 'goat_private/history', { body: { at: Date.now(), tree } });
  const keys = Object.keys((await get('goat_private/history', '&shallow=true')) || {}).sort();
  const extra = keys.slice(0, Math.max(0, keys.length - 25));
  if (extra.length) await patch('goat_private/history', Object.fromEntries(extra.map((k) => [k, null])));
  return Math.min(keys.length, 25);
}
async function lastHistory() {
  const keys = Object.keys((await get('goat_private/history', '&shallow=true')) || {}).sort();
  if (!keys.length) return null;
  const key = keys[keys.length - 1];
  return { key, count: keys.length, entry: await get('goat_private/history/' + key) };
}
const dropHistory = (key) => del('goat_private/history/' + key);

// Login limiter: 5 wrong passwords per address per 10 minutes.
const ipKey = (ip) => crypto.createHash('sha256').update(String(ip)).digest('hex').slice(0, 24);
async function failCount(ip) {
  const f = await get('goat_private/fails/' + ipKey(ip));
  return f && Date.now() - f.t < 10 * 60000 ? f.n : 0;
}
async function addFail(ip) { const n = (await failCount(ip)) + 1; await put('goat_private/fails/' + ipKey(ip), { n, t: Date.now() }); }
const clearFails = (ip) => del('goat_private/fails/' + ipKey(ip));

// Load the fixtures as a plain state object (plus the raw tree, for diffing).
async function load() {
  const shared = require('../public/js/goat-shared'), core = require('./core');
  const tree = (await get('goat')) || {};
  return { tree, st: core.migrate(shared.toState(tree)) };
}
// Save `next` (based on revision `base`), sending only what changed. Returns false if someone else saved first.
async function commit(oldTree, next, base) {
  const shared = require('../public/js/goat-shared');
  next.rev = base + 1;
  const changes = shared.diff(oldTree, shared.toTree(next, oldTree));
  if (!(await claim(base, base + 1))) return false;
  await patch('goat', changes);
  return true;
}

module.exports = { DB, req, get, patch, claim, load, commit, pushHistory, lastHistory, dropHistory, failCount, addFail, clearFails };
