// THE GOAT — laptop / venue Wi-Fi server. Zero dependencies: `node wifi-server.js`.
// Same rules as the Vercel version (lib/core.js); here state lives in data/state.json and screens get instant pushes.
// Public:  /  (home)   /fixtures  (live board)   /ads  (slideshow)      Admin:  /admin  (password)
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const core = require('./lib/core');
const auth = require('./lib/auth');
const notify = require('./lib/notify');

const PORT = Number(process.env.PORT) || 3000;
const ROOT = __dirname;
const PUB = path.join(ROOT, 'public');
const PRIV = path.join(ROOT, 'private');
const DATA = path.join(ROOT, 'data');
const ADS = path.join(PUB, 'ads');
fs.mkdirSync(DATA, { recursive: true });
fs.mkdirSync(ADS, { recursive: true });

function readOrCreate(file, make) {
  const p = path.join(DATA, file);
  try { return fs.readFileSync(p, 'utf8').trim(); } catch { const v = make(); fs.writeFileSync(p, v); return v; }
}
const SECRET = readOrCreate('.secret', () => crypto.randomBytes(32).toString('hex'));
const PASSWORD = process.env.ADMIN_PASSWORD || readOrCreate('admin-password.txt', () => crypto.randomBytes(6).toString('base64url'));

// ── state ──
const STATE_FILE = path.join(DATA, 'state.json');
let state;
try { state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { state = core.newState({ sample: true }); }
core.migrate(state);
const history = [];
function save() {
  const tmp = STATE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 1));
  fs.renameSync(tmp, STATE_FILE);
}
// WhatsApp (same rules as online): who was told what, plus a log, kept in data/notify.json (private).
const NOTIFY_FILE = path.join(DATA, 'notify.json');
let outbox = { sent: {}, log: [] };
try { outbox = Object.assign(outbox, JSON.parse(fs.readFileSync(NOTIFY_FILE, 'utf8'))); } catch {}
const contactsOf = () => Object.fromEntries(state.matches.concat(state.done).filter((m) => m.contact).map((m) => [m.id, m.contact]));
async function sendMessages(prev, next) {
  if (!next.settings.notify) return;
  try {
    const { sentPatch, log } = await notify.run(prev, JSON.parse(JSON.stringify(next)), { contacts: contactsOf(), sent: outbox.sent, enabled: true });
    Object.assign(outbox.sent, sentPatch);
    outbox.log = log.reverse().concat(outbox.log).slice(0, 500);
    fs.writeFileSync(NOTIFY_FILE, JSON.stringify(outbox));
  } catch (e) { console.error('whatsapp', e); }
}

function dispatch(act) {
  let result = null;
  const prevSt = core.normalize(JSON.parse(JSON.stringify(state)));
  if (act.type === 'undo') {
    const prev = history.pop();
    if (!prev) throw new Error('Nothing to undo');
    const nonce = state.replayNonce, rev = state.rev;
    state = prev;
    state.replayNonce = nonce; // undo never re-triggers the intro
    state.rev = rev;           // revision only ever goes up, so every screen notices the undo
  } else {
    const snapshot = JSON.parse(JSON.stringify(state));
    result = core.apply(state, act);
    if (act.type !== 'replay') { history.push(snapshot); if (history.length > 60) history.shift(); }
  }
  core.normalize(state);
  state.rev++;
  save();
  broadcast();
  if (act.type !== 'undo') sendMessages(prevSt, state); // runs in the background, never blocks the board
  return result;
}
core.normalize(state); save();

// countdowns that reach 0 start by themselves; tentative times follow the clock
setInterval(() => { if (core.autoStart(state)) { core.normalize(state); state.rev++; save(); broadcast(); } }, 1000);
setInterval(() => {
  const sig = () => state.matches.map((m) => m.time).join(',');
  const before = sig();
  core.normalize(state);
  if (sig() !== before) { state.rev++; save(); broadcast(); }
}, 15000);

// ── live push (SSE) ──
const clients = new Set();
const payload = () => JSON.stringify(core.view(state, { canUndo: history.length > 0, transport: 'sse' }));
function broadcast() { const msg = `event: state\ndata: ${payload()}\n\n`; for (const res of clients) res.write(msg); }
setInterval(() => { for (const res of clients) res.write(': ping\n\n'); }, 20000);

// ── http ──
const fails = new Map();
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif', '.avif': 'image/avif', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.ico': 'image/x-icon' };
const AD_EXT = /\.(png|jpe?g|webp|gif|avif|svg|mp4|webm|mov)$/i;

function send(res, code, body, type = 'application/json') {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}
function serveFile(req, res, file) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return send(res, 404, 'Not found', 'text/plain');
    const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
    const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
    if (range && /^video/.test(type)) { // videos need range requests to play/seek
      const start = range[1] ? +range[1] : 0, end = range[2] ? +range[2] : st.size - 1;
      res.writeHead(206, { 'Content-Type': type, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1 });
      return fs.createReadStream(file, { start, end }).pipe(res);
    }
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': st.size, 'Cache-Control': /^(image|video)/.test(type) ? 'public, max-age=300' : 'no-cache', 'Accept-Ranges': 'bytes' });
    fs.createReadStream(file).pipe(res);
  });
}
function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > 1e6) { reject(new Error('Too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString() || '{}')); } catch { reject(new Error('Bad JSON')); } });
  });
}
function lanAddresses() {
  const nets = require('os').networkInterfaces();
  return Object.entries(nets).flatMap(([name, list]) => (list || [])
    .filter((n) => n.family === 'IPv4' && !n.internal && !n.address.startsWith('169.254.'))
    .map((n) => ({ ip: n.address, iface: name })))
    .sort((a, b) => (/wi-?fi|wlan/i.test(b.iface) ? 1 : 0) - (/wi-?fi|wlan/i.test(a.iface) ? 1 : 0));
}
const PAGES = { '/': 'index.html', '/fixtures': 'fixtures.html', '/ads': 'ads.html', '/tv': 'tv.html' };

http.createServer(async (req, res) => {
  const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const admin = auth.isAdmin(req.headers.cookie, SECRET);
  try {
    if (p === '/api/stream') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.write(`retry: 2000\nevent: state\ndata: ${payload()}\n\n`);
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    if (p === '/config.js') return send(res, 200, 'window.GOAT_CONFIG = {};', 'text/javascript; charset=utf-8');
    if (p === '/api/state') return send(res, 200, payload());
    if (p === '/api/rev') return send(res, 200, { rev: state.rev, now: Date.now() });
    if (p === '/api/ads') {
      const files = fs.readdirSync(ADS).filter((f) => AD_EXT.test(f)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
      return send(res, 200, files.map((f) => ({ src: '/ads/' + encodeURIComponent(f), video: /\.(mp4|webm|mov)$/i.test(f) })));
    }
    if (p === '/api/login' && req.method === 'POST') {
      const ip = req.socket.remoteAddress, f = fails.get(ip) || { n: 0, t: 0 };
      if (f.n >= 5 && Date.now() - f.t < 10 * 60000) return send(res, 429, { error: 'Too many attempts. Wait 10 minutes.' });
      const body = await readJson(req);
      if (!auth.passwordOk(body.password, PASSWORD)) { fails.set(ip, { n: f.n + 1, t: Date.now() }); return send(res, 401, { error: 'Wrong password' }); }
      fails.delete(ip);
      res.setHeader('Set-Cookie', auth.makeCookie(SECRET, false));
      return send(res, 200, { ok: true });
    }
    if (p === '/api/wa-test' && req.method === 'POST') {
      if (!admin) return send(res, 401, { error: 'Not logged in' });
      const b = await readJson(req);
      return send(res, 200, await notify.testSend(b.phone, ['soon', 'next', 'later'].includes(b.kind) ? b.kind : 'next'));
    }
    if (p === '/api/admin-data') {
      if (!admin) return send(res, 401, { error: 'Not logged in' });
      return send(res, 200, { contacts: contactsOf(), log: outbox.log.slice(0, 150), whatsapp: notify.status() });
    }
    if (p === '/api/logout') { res.setHeader('Set-Cookie', auth.clearCookie()); return send(res, 200, { ok: true }); }
    if (p === '/api/action' && req.method === 'POST') {
      if (!admin) return send(res, 401, { error: 'Not logged in' });
      try { const result = dispatch(await readJson(req)); return send(res, 200, { ok: true, rev: state.rev, ...(result || {}) }); }
      catch (e) { return send(res, 400, { error: e.message }); }
    }
    if (p === '/admin') return serveFile(req, res, path.join(PRIV, admin ? 'admin.html' : 'login.html'));
    if (p.startsWith('/admin/')) { // admin-only assets
      if (!admin) return send(res, 401, 'Not logged in', 'text/plain');
      const f = path.normalize(path.join(PRIV, p.slice(7)));
      return f.startsWith(PRIV + path.sep) ? serveFile(req, res, f) : send(res, 404, 'Not found', 'text/plain');
    }
    if (PAGES[p]) return serveFile(req, res, path.join(PUB, PAGES[p]));
    const f = path.normalize(path.join(PUB, p));
    if (!f.startsWith(PUB + path.sep)) return send(res, 404, 'Not found', 'text/plain');
    return serveFile(req, res, f);
  } catch (e) {
    console.error(e);
    send(res, 500, { error: 'Server error' });
  }
}).listen(PORT, () => {
  console.log(`\n  THE GOAT live fixtures`);
  console.log(`  Home      http://localhost:${PORT}/`);
  lanAddresses().forEach((a) => console.log(`  On Wi-Fi  http://${a.ip}:${PORT}/   (${a.iface})`));
  console.log(`  Board     /fixtures      Ads  /ads      Admin  /admin`);
  console.log(process.env.ADMIN_PASSWORD ? '  Admin password: from ADMIN_PASSWORD' : `  Admin password: ${PASSWORD}   (saved in data/admin-password.txt)`);
  console.log('');
});
