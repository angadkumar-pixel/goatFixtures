// THE GOAT — match rules, shared by the laptop server (wifi-server.js) and the Vercel functions (api/*.js).
// Everything works on a plain `state` object passed in; no I/O here.
const crypto = require('crypto');

const BOARD_SIZE = 10;
const uid = () => crypto.randomBytes(5).toString('hex');
const clean = (s, n = 60) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n);
const DEFAULT_SETTINGS = { replayMinutes: 10, matchMinutes: 15, courts: 4, liveToTop: true, adSeconds: 8, callMinutes: 5, autoCall: true, autoStart: true };

function newMatch({ a, b }) {
  return { id: uid(), a: clean(a), b: clean(b), court: '', time: null, timeLocked: false, status: 'queued', ending: false, shownAt: null,
    startedAt: null, endedAt: null, calledAt: null, callAt: null, ready: false, readyFor: null, readyCourt: '', readyAt: null, delay: 0 };
}
function newState({ sample = false } = {}) {
  const matches = [];
  if (sample) for (let i = 0; i < 14; i++) matches.push(newMatch({ a: `Player ${i * 2 + 1}`, b: `Player ${i * 2 + 2}` }));
  return { title: 'THE GOAT Badminton Tournament', subtitle: 'Next 10 Matches', settings: { ...DEFAULT_SETTINGS }, matches, done: [], replayNonce: 0, rev: 0 };
}
const clearReady = (m) => Object.assign(m, { ready: false, readyFor: null, readyCourt: '', readyAt: null });
// Bring state saved by older versions up to date.
function migrate(st) {
  st.settings = { ...DEFAULT_SETTINGS, ...(st.settings || {}) };
  st.matches = st.matches || []; st.done = st.done || [];
  st.rev = st.rev || 0; st.replayNonce = st.replayNonce || 0;
  st.matches.forEach((m) => {
    if (m.status === 'queued') m.court = '';
    m.calledAt ??= null; m.callAt ??= null; m.delay ??= 0;
    if (m.ready === undefined || m.status !== 'queued') clearReady(m);
  });
  return st;
}

const isActive = (m) => m.status === 'live' || m.status === 'called';

// Tentative schedule. Each court is busy for matchMinutes (15) from when its match started (or is called to start).
// Waiting matches, in order, take whichever court frees up first, plus any delay the admin added.
function normalize(st, now = Date.now()) {
  const D = (Number(st.settings.matchMinutes) || 15) * 60000, n = st.settings.courts || 4;
  const free = Array.from({ length: n }, () => now);
  const earliest = () => free.indexOf(Math.min(...free));
  st.matches.forEach((m) => {
    if (!isActive(m)) return;
    const end = m.status === 'live' ? Math.max(now, (m.startedAt || now) + D) : Math.max(now, m.callAt) + D;
    const k = +m.court >= 1 && +m.court <= n ? +m.court - 1 : earliest();
    free[k] = Math.max(free[k], end);
    m.time = m.status === 'live' ? m.startedAt : m.callAt;
  });
  st.matches.forEach((m) => {
    if (m.status !== 'queued') return;
    const k = earliest();
    const t = Math.max(now, free[k]) + (Number(m.delay) || 0) * 60000;
    m.time = Math.ceil(t / 60000) * 60000;
    m.timeLocked = false;
    free[k] = t + D;
  });
  if (st.done.length > 300) st.done.length = 300;
  return st;
}

// Countdown finished → the called match goes live by itself. Returns true if anything changed.
function autoStart(st, now = Date.now()) {
  if (!st.settings.autoStart) return false;
  const due = st.matches.filter((m) => m.status === 'called' && m.callAt <= now);
  due.forEach((m) => ops(st).startMatch(m, now));
  return due.length > 0;
}

// Helpers bound to one state object.
function ops(st) {
  const idxOf = (id) => st.matches.findIndex((m) => m.id === id);
  const liveCount = (exceptId) => st.matches.filter((m) => isActive(m) && m.id !== exceptId).length;
  const courtCap = () => st.settings.courts || 4;
  const capError = () => new Error(`All ${courtCap()} courts are busy. End a match first.`);
  function moveTo(id, to) {
    const from = idxOf(id);
    if (from < 0) return;
    const [m] = st.matches.splice(from, 1);
    to = Math.max(0, Math.min(st.matches.length, Number(to) | 0));
    st.matches.splice(to, 0, m);
  }
  const courtBusy = (court, exceptId) => !!court && st.matches.some((m) => isActive(m) && m.id !== exceptId && String(m.court) === String(court));
  function freeCourt() {
    const used = new Set(st.matches.filter(isActive).map((m) => String(m.court)));
    for (let c = 1; c <= courtCap(); c++) if (!used.has(String(c))) return String(c);
    return '';
  }
  // While match F is "finishing", the next queued match gets "BE READY · COURT n" on the board.
  function flagReady(f, now) {
    if (st.matches.some((x) => x.ready && x.readyFor === f.id)) return;
    const next = st.matches.find((x) => x.status === 'queued' && !x.ready);
    if (next) Object.assign(next, { ready: true, readyFor: f.id, readyCourt: f.court || '', readyAt: now });
  }
  const unflagReady = (f) => st.matches.forEach((x) => { if (x.readyFor === f.id) clearReady(x); });
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
  function callMatch(m, court, now, minutes = st.settings.callMinutes) {
    clearReady(m);
    m.status = 'called'; m.ending = false; m.court = court; m.calledAt = now;
    m.callAt = Math.round(now + Math.max(0, minutes) * 60000);
    m.time = m.callAt;
    if (st.settings.liveToTop) moveTo(m.id, liveCount(m.id));
  }
  return { idxOf, liveCount, courtCap, capError, moveTo, courtBusy, freeCourt, flagReady, unflagReady, startMatch, backToQueue, callMatch };
}

// Apply one admin action to the state (mutates it). Returns extra info for the admin, or null. Throws on bad input.
function apply(st, act, now = Date.now()) {
  const o = ops(st);
  const m = act.id ? st.matches.find((x) => x.id === act.id) : null;
  switch (act.type) {
    case 'add': {
      const list = Array.isArray(act.items) ? act.items : [act];
      const made = list.filter((x) => clean(x.a) || clean(x.b)).slice(0, 1000).map(newMatch);
      if (!made.length) throw new Error('Enter at least one player name');
      st.matches.splice(act.where === 'next' ? o.liveCount() : st.matches.length, 0, ...made);
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
    case 'move': if (!m) throw new Error('Match not found'); o.moveTo(act.id, act.to); break;
    case 'live': {
      if (!m) throw new Error('Match not found');
      if (act.live) {
        if (m.status === 'queued' && o.liveCount(m.id) >= o.courtCap()) throw o.capError();
        if (act.court != null) m.court = clean(act.court, 12);
        o.startMatch(m, now);
        if (st.settings.liveToTop) o.moveTo(m.id, o.liveCount(m.id));
      } else o.backToQueue(m);
      break;
    }
    case 'call': {
      if (!m) throw new Error('Match not found');
      if (m.status === 'queued' && o.liveCount(m.id) >= o.courtCap()) throw o.capError();
      const court = act.court ? clean(act.court, 12) : (m.court && !o.courtBusy(m.court, m.id) ? m.court : o.freeCourt());
      if (!court) throw new Error('All courts are busy');
      o.callMatch(m, court, now, Number.isFinite(act.minutes) ? act.minutes : undefined);
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
      if (m.ending && m.status === 'live') o.flagReady(m, now); else o.unflagReady(m);
      break;
    }
    case 'end': {
      if (!m) throw new Error('Match not found');
      const freed = m.status === 'live' ? m.court || '' : '';
      const readyOne = st.matches.find((x) => x.readyFor === m.id);
      st.matches.splice(o.idxOf(m.id), 1);
      Object.assign(m, { status: 'done', ending: false, endedAt: now, calledAt: null, callAt: null });
      st.done.unshift(m);
      if (st.settings.autoCall) { // hand the freed court to whoever is next (the "be ready" match first)
        const court = freed && !o.courtBusy(freed) ? freed : o.freeCourt();
        const next = st.matches.find((x) => x.status === 'queued' && x.readyFor === m.id) || st.matches.find((x) => x.status === 'queued');
        if (court && next) { o.callMatch(next, court, now); return { called: { a: next.a, b: next.b, court } }; }
      }
      if (readyOne) clearReady(readyOne);
      break;
    }
    case 'restore': {
      const i = st.done.findIndex((x) => x.id === act.id);
      if (i < 0) throw new Error('Match not found');
      const [r] = st.done.splice(i, 1);
      o.backToQueue(r); r.endedAt = null; r.shownAt = null;
      st.matches.splice(o.liveCount(), 0, r);
      break;
    }
    case 'remove': {
      if (m) o.unflagReady(m);
      const i = o.idxOf(act.id);
      if (i >= 0) st.matches.splice(i, 1);
      else st.done = st.done.filter((x) => x.id !== act.id);
      break;
    }
    case 'settings': {
      if ('title' in act) st.title = clean(act.title, 80);
      if ('subtitle' in act) st.subtitle = clean(act.subtitle, 80);
      const s = act.settings || {}, cur = st.settings;
      const num = (v, lo, hi, d) => (Number.isFinite(+v) ? Math.max(lo, Math.min(hi, +v)) : d);
      st.settings = {
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
    case 'replay': st.replayNonce++; break;
    case 'clearDone': st.done = []; break;
    case 'resetAll': st.matches = []; st.done = []; break;
    default: throw new Error('Unknown action');
  }
  return null;
}

// What the pages receive.
const view = (st, extra = {}) => ({ ...st, boardSize: BOARD_SIZE, now: Date.now(), ...extra });

module.exports = { BOARD_SIZE, clean, newMatch, newState, migrate, normalize, autoStart, apply, view, ops };
