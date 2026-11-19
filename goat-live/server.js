// THE GOAT — live fixtures server. Zero dependencies: `node server.js`.
// Public:  /  (home)   /fixtures  (live board)   /ads  (slideshow)
// Admin:   /admin  (password login, controls everything)
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT) || 3000;
const ROOT = __dirname;
const PUB = path.join(ROOT, 'public');
const PRIV = path.join(ROOT, 'private');
const DATA = path.join(ROOT, 'data');
const ADS = path.join(PUB, 'ads');
const BOARD_SIZE = 10;

fs.mkdirSync(DATA, { recursive: true });
fs.mkdirSync(ADS, { recursive: true });

function readOrCreate(file, make) {
  const p = path.join(DATA, file);
  try { return fs.readFileSync(p, 'utf8').trim(); } catch { const v = make(); fs.writeFileSync(p, v); return v; }
}
const SECRET = readOrCreate('.secret', () => crypto.randomBytes(32).toString('hex'));
const PASSWORD = process.env.ADMIN_PASSWORD || readOrCreate('admin-password.txt', () => crypto.randomBytes(6).toString('base64url'));

// ───────────────────────── state ─────────────────────────
const STATE_FILE = path.join(DATA, 'state.json');
const uid = () => crypto.randomBytes(5).toString('hex');
const clean = (s, n = 60) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n);

function seedState() {
  const matches = [];
  for (let i = 0; i < 14; i++) matches.push(newMatch({ a: `Player ${i * 2 + 1}`, b: `Player ${i * 2 + 2}` }));
  return {
    title: 'THE GOAT Badminton Tournament',
    subtitle: 'Next 10 Matches',
    settings: { replayMinutes: 10, matchMinutes: 15, courts: 4, liveToTop: true, adSeconds: 8, callMinutes: 5, autoCall: true, autoStart: true },
    matches, done: [], replayNonce: 0, rev: 0,
  };
}
function newMatch({ a, b, court = '', time = null }) {
  return { id: uid(), a: clean(a), b: clean(b), court: clean(court, 12), time: Number.isFinite(time) ? time : null,
    timeLocked: Number.isFinite(time), status: 'queued', ending: false, shownAt: null, startedAt: null, endedAt: null, calledAt: null, callAt: null, ready: false, readyFor: null, readyCourt: '', readyAt: null, delay: 0 };
}

let state;
try { state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { state = seedState(); }
state.settings = { ...seedState().settings, ...(state.settings || {}) };
const history = [];

function save() {
  const tmp = STATE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 1));
  fs.renameSync(tmp, STATE_FILE);
}

// Tentative schedule. Each court is busy for matchMinutes (15) from when its match started (or is called to start).
// Waiting matches, in order, take whichever court frees up first, plus any delay the admin added.
// Recomputed on every change and every 15 s, so an overrunning match pushes the times behind it.
function normalize(now = Date.now()) {
  const D = (Number(state.settings.matchMinutes) || 15) * 60000, n = state.settings.courts || 4;
  const free = Array.from({ length: n }, () => now);
  const earliest = () => free.indexOf(Math.min(...free));
  state.matches.forEach((m) => {
    if (m.status !== 'live' && m.status !== 'called') return;
    const end = m.status === 'live' ? Math.max(now, (m.startedAt || now) + D) : Math.max(now, m.callAt) + D;
    const k = +m.court >= 1 && +m.court <= n ? +m.court - 1 : earliest();
    free[k] = Math.max(free[k], end);
    m.time = m.status === 'live' ? m.startedAt : m.callAt;
  });
  state.matches.forEach((m) => {
    if (m.status !== 'queued') return;
    const k = earliest();
    const t = Math.max(now, free[k]) + (Number(m.delay) || 0) * 60000;
    m.time = Math.ceil(t / 60000) * 60000;
    m.timeLocked = false;
    free[k] = t + D;
  });
  if (state.done.length > 300) state.done.length = 300;
}
const courtCap = () => state.settings.courts || 4;
const capError = () => new Error(`All ${courtCap()} courts are busy. End a match first.`);

const idxOf = (id) => state.matches.findIndex((m) => m.id === id);
// "active" = on a court (live) or called to one and counting down
const isActive = (m) => m.status === 'live' || m.status === 'called';
const liveCount = (exceptId) => state.matches.filter((m) => isActive(m) && m.id !== exceptId).length;
function moveTo(id, to) {
  const from = idxOf(id);
  if (from < 0) return;
  const [m] = state.matches.splice(from, 1);
  to = Math.max(0, Math.min(state.matches.length, Number(to) | 0));
  state.matches.splice(to, 0, m);
}
function courtBusy(court, exceptId) {
  return !!court && state.matches.some((m) => isActive(m) && m.id !== exceptId && String(m.court) === String(court));
}
function freeCourt() {
  const used = new Set(state.matches.filter(isActive).map((m) => String(m.court)));
  for (let c = 1; c <= (state.settings.courts || 4); c++) if (!used.has(String(c))) return String(c);
  return '';
}

const clearReady = (m) => Object.assign(m, { ready: false, readyFor: null, readyCourt: '', readyAt: null });
// While match F is "finishing", the next queued match gets "BE READY · COURT n" on the board.
function flagReady(f, now) {
  if (state.matches.some((x) => x.ready && x.readyFor === f.id)) return;
  const next = state.matches.find((x) => x.status === 'queued' && !x.ready);
  if (next) Object.assign(next, { ready: true, readyFor: f.id, readyCourt: f.court || '', readyAt: now });
}
function unflagReady(f) { state.matches.forEach((x) => { if (x.readyFor === f.id) clearReady(x); }); }

function startMatch(m, now) {
  clearReady(m);
  m.status = 'live'; m.ending = false; m.startedAt = now; m.calledAt = null; m.callAt = null;
  if (!m.court || courtBusy(m.court, m.id)) m.court = freeCourt();
}
function backToQueue(m) {
  unflagReady(m); clearReady(m);
  Object.assign(m, { status: 'queued', ending: false, startedAt: null, calledAt: null, callAt: null, court: '' });
}
// Call a match to a court: it shows "Court N · starts in mm:ss", then goes live automatically.
function callMatch(m, court, now, minutes = state.settings.callMinutes) {
  clearReady(m);
  m.status = 'called'; m.ending = false; m.court = court; m.calledAt = now;
  m.callAt = Math.round(now + Math.max(0, minutes) * 60000);
  m.time = m.callAt; m.timeLocked = true;
  if (state.settings.liveToTop) moveTo(m.id, liveCount(m.id));
}

function apply(act) {
  const now = Date.now();
  const m = act.id ? state.matches.find((x) => x.id === act.id) : null;
  switch (act.type) {
    case 'add': {
      const list = Array.isArray(act.items) ? act.items : [act];
      const made = list.filter((x) => clean(x.a) || clean(x.b)).slice(0, 200).map(newMatch);
      if (!made.length) throw new Error('Enter at least one player name');
      const at = act.where === 'next' ? liveCount() : state.matches.length;
      state.matches.splice(at, 0, ...made);
      break;
    }
    case 'update': {
      if (!m) throw new Error('Match not found');
      if ('a' in act) m.a = clean(act.a);
      if ('b' in act) m.b = clean(act.b);
      if ('court' in act) m.court = clean(act.court, 12);
      break;
    }
    case 'delay': {
      if (!m) throw new Error('Match not found');
      m.delay = Math.max(0, Math.min(180, Math.round(Number(act.minutes) || 0)));
      break;
    }
    case 'move': if (!m) throw new Error('Match not found'); moveTo(act.id, act.to); break;
    case 'live': {
      if (!m) throw new Error('Match not found');
      if (act.live) {
        if (m.status === 'queued' && liveCount(m.id) >= courtCap()) throw capError();
        if (act.court != null) m.court = clean(act.court, 12);
        startMatch(m, now);
        if (state.settings.liveToTop) moveTo(m.id, liveCount(m.id));
      } else backToQueue(m);
      break;
    }
    case 'call': {
      if (!m) throw new Error('Match not found');
      if (m.status === 'queued' && liveCount(m.id) >= courtCap()) throw capError();
      const court = act.court ? clean(act.court, 12) : (m.court && !courtBusy(m.court, m.id) ? m.court : freeCourt());
      if (!court) throw new Error('All courts are busy');
      callMatch(m, court, now, Number.isFinite(act.minutes) ? act.minutes : undefined);
      return { called: { a: m.a, b: m.b, court } };
    }
    case 'extend': {
      if (!m || m.status !== 'called') throw new Error('That match is not waiting to start');
      m.callAt = Number.isFinite(act.set) ? now + Math.max(0, Math.min(120, act.set)) * 60000 : Math.max(now, m.callAt + (Number(act.minutes) || 0) * 60000);
      m.time = m.callAt;
      break;
    }
    case 'ending': {
      if (!m) throw new Error('Match not found');
      m.ending = !!act.on;
      if (m.ending && m.status === 'live') flagReady(m, now); else unflagReady(m);
      break;
    }
    case 'end': {
      if (!m) throw new Error('Match not found');
      const freed = m.status === 'live' ? m.court || '' : '';
      const readyOne = state.matches.find((x) => x.readyFor === m.id);
      state.matches.splice(idxOf(m.id), 1);
      Object.assign(m, { status: 'done', ending: false, endedAt: now, calledAt: null, callAt: null });
      state.done.unshift(m);
      if (state.settings.autoCall) { // hand the freed court to whoever is next in the queue
        const court = freed && !courtBusy(freed) ? freed : freeCourt();
        const next = state.matches.find((x) => x.status === 'queued' && x.readyFor === m.id) || state.matches.find((x) => x.status === 'queued');
        if (court && next) { callMatch(next, court, now); return { called: { a: next.a, b: next.b, court } }; }
      }
      if (readyOne) clearReady(readyOne);
      break;
    }
    case 'restore': {
      const i = state.done.findIndex((x) => x.id === act.id);
      if (i < 0) throw new Error('Match not found');
      const [r] = state.done.splice(i, 1);
      backToQueue(r); r.endedAt = null; r.shownAt = null;
      state.matches.splice(liveCount(), 0, r);
      break;
    }
    case 'remove': {
      if (m) unflagReady(m);
      const i = idxOf(act.id);
      if (i >= 0) state.matches.splice(i, 1);
      else state.done = state.done.filter((x) => x.id !== act.id);
      break;
    }
    case 'settings': {
      if ('title' in act) state.title = clean(act.title, 80);
      if ('subtitle' in act) state.subtitle = clean(act.subtitle, 80);
      const s = act.settings || {};
      const num = (v, lo, hi, d) => (Number.isFinite(+v) ? Math.max(lo, Math.min(hi, +v)) : d);
      const cur = state.settings;
      state.settings = {
        replayMinutes: num(s.replayMinutes ?? cur.replayMinutes, 0, 240, 10),
        matchMinutes: num(s.matchMinutes ?? cur.matchMinutes, 5, 120, 15),
        courts: num(s.courts ?? cur.courts, 1, 20, 4),
        liveToTop: s.liveToTop ?? cur.liveToTop,
        adSeconds: num(s.adSeconds ?? cur.adSeconds, 2, 120, 8),
        callMinutes: num(s.callMinutes ?? cur.callMinutes, 0, 60, 5),
        autoCall: s.autoCall ?? cur.autoCall,
        autoStart: s.autoStart ?? cur.autoStart,
      };
      break;
    }
    case 'replay': state.replayNonce++; break;
    case 'clearDone': state.done = []; break;
    case 'resetAll': state.matches = []; state.done = []; break;
    default: throw new Error('Unknown action');
  }
  return null;
}

function dispatch(act) {
  let result = null;
  if (act.type === 'undo') {
    const prev = history.pop();
    if (!prev) throw new Error('Nothing to undo');
    const nonce = state.replayNonce;
    state = prev;
    state.replayNonce = nonce; // undo never re-triggers the intro
  } else {
    const snapshot = JSON.parse(JSON.stringify(state));
    result = apply(act);
    if (act.type !== 'replay') { history.push(snapshot); if (history.length > 60) history.shift(); }
  }
  normalize();
  state.rev++;
  save();
  broadcast();
  return result;
}
// One-time cleanup: queued matches shouldn't hold a court (older versions kept it after "un-live").
state.matches.forEach((m) => {
  if (m.status === 'queued') m.court = '';
  m.calledAt ??= null; m.callAt ??= null;
  if (m.ready === undefined || m.status !== 'queued') clearReady(m);
  m.delay ??= 0;
});
normalize(); save();

// Countdown finished → the called match goes live by itself (not an undo step; Undo still reverts your last action).
setInterval(() => {
  if (!state.settings.autoStart) return;
  const now = Date.now();
  const due = state.matches.filter((m) => m.status === 'called' && m.callAt <= now);
  if (!due.length) return;
  due.forEach((m) => startMatch(m, now));
  normalize(); state.rev++; save(); broadcast();
}, 1000);

setInterval(() => {
  const sig = () => state.matches.map((m) => m.time).join(',');
  const before = sig();
  normalize();
  if (sig() !== before) { state.rev++; save(); broadcast(); }
}, 15000);

// ───────────────────────── live push (SSE) ─────────────────────────
const clients = new Set();
const payload = () => JSON.stringify({ ...state, now: Date.now(), canUndo: history.length > 0, boardSize: BOARD_SIZE });
function broadcast() { const msg = `event: state\ndata: ${payload()}\n\n`; for (const res of clients) res.write(msg); }
setInterval(() => { for (const res of clients) res.write(': ping\n\n'); }, 20000);

// ───────────────────────── auth ─────────────────────────
const sign = (v) => crypto.createHmac('sha256', SECRET).update(v).digest('base64url');
function makeToken() { const exp = String(Date.now() + 1000 * 60 * 60 * 24); return `${exp}.${sign(exp)}`; }
function isAdmin(req) {
  const c = /(?:^|;\s*)goat_admin=([^;]+)/.exec(req.headers.cookie || '');
  if (!c) return false;
  const [exp, sig] = c[1].split('.');
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  const a = Buffer.from(sig), b = Buffer.from(sign(exp));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
const fails = new Map();
function passwordOk(pw) {
  const a = crypto.createHash('sha256').update(String(pw || '')).digest();
  const b = crypto.createHash('sha256').update(PASSWORD).digest();
  return crypto.timingSafeEqual(a, b);
}

// ───────────────────────── http ─────────────────────────
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

// Real Wi-Fi/LAN IPv4 addresses (skips link-local 169.254.x.x and virtual adapters with no network).
function lanAddresses() {
  const nets = require('os').networkInterfaces();
  return Object.entries(nets).flatMap(([name, list]) => (list || [])
    .filter((n) => n.family === 'IPv4' && !n.internal && !n.address.startsWith('169.254.'))
    .map((n) => ({ ip: n.address, iface: name })))
    .sort((a, b) => (/wi-?fi|wlan/i.test(b.iface) ? 1 : 0) - (/wi-?fi|wlan/i.test(a.iface) ? 1 : 0));
}

const PAGES = { '/': 'index.html', '/fixtures': 'fixtures.html', '/ads': 'ads.html' };

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = decodeURIComponent(url.pathname);
  try {
    if (p === '/api/stream') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.write(`retry: 2000\nevent: state\ndata: ${payload()}\n\n`);
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    if (p === '/api/state') return send(res, 200, payload());
    if (p === '/api/ads') {
      const files = fs.readdirSync(ADS).filter((f) => AD_EXT.test(f)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
      return send(res, 200, files.map((f) => ({ src: '/ads/' + encodeURIComponent(f), video: /\.(mp4|webm|mov)$/i.test(f) })));
    }
    if (p === '/api/login' && req.method === 'POST') {
      const ip = req.socket.remoteAddress;
      const f = fails.get(ip) || { n: 0, t: 0 };
      if (f.n >= 5 && Date.now() - f.t < 10 * 60000) return send(res, 429, { error: 'Too many attempts. Wait 10 minutes.' });
      const body = await readJson(req);
      if (!passwordOk(body.password)) { fails.set(ip, { n: f.n + 1, t: Date.now() }); return send(res, 401, { error: 'Wrong password' }); }
      fails.delete(ip);
      res.setHeader('Set-Cookie', `goat_admin=${makeToken()}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400`);
      return send(res, 200, { ok: true });
    }
    if (p === '/api/logout') { res.setHeader('Set-Cookie', 'goat_admin=; Path=/; Max-Age=0'); return send(res, 200, { ok: true }); }
    if (p === '/api/action' && req.method === 'POST') {
      if (!isAdmin(req)) return send(res, 401, { error: 'Not logged in' });
      try { const result = dispatch(await readJson(req)); return send(res, 200, { ok: true, rev: state.rev, ...(result || {}) }); }
      catch (e) { return send(res, 400, { error: e.message }); }
    }
    if (p === '/api/info') { // Wi-Fi addresses for the admin "Join on Wi-Fi" panel
      if (!isAdmin(req)) return send(res, 401, { error: 'Not logged in' });
      return send(res, 200, { port: PORT, hosts: lanAddresses(), name: require('os').hostname() });
    }
    if (p === '/admin') return serveFile(req, res, path.join(isAdmin(req) ? PRIV : PUB, isAdmin(req) ? 'admin.html' : 'login.html'));
    if (p.startsWith('/admin/')) { // admin-only assets
      if (!isAdmin(req)) return send(res, 401, 'Not logged in', 'text/plain');
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
  const lan = lanAddresses();
  console.log(`\n  THE GOAT live fixtures`);
  console.log(`  Home      http://localhost:${PORT}/`);
  lan.forEach((a) => console.log(`  On Wi-Fi  http://${a.ip}:${PORT}/   (${a.iface})`));
  console.log(`  Board     /fixtures      Ads  /ads      Admin  /admin`);
  console.log(process.env.ADMIN_PASSWORD ? '  Admin password: from ADMIN_PASSWORD' : `  Admin password: ${PASSWORD}   (saved in data/admin-password.txt)`);
  console.log('');
});
