// THE GOAT — match rules, shared by the laptop server (wifi-server.js) and the Vercel functions (api/*.js).
// Everything works on a plain `state` object passed in; no I/O here.
const crypto = require('crypto');

const BOARD_SIZE = 10;
const uid = () => crypto.randomBytes(5).toString('hex');
const clean = (s, n = 60) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n);
const DEFAULT_SETTINGS = { notify: false, replayMinutes: 10, matchMinutes: 15, courts: 4, liveToTop: true, adSeconds: 8, callMinutes: 5, autoCall: true, autoStart: true };

function newMatch({ a, b, phoneA, phoneB }) {
  const contact = phoneA || phoneB ? { contact: { a: clean(phoneA, 20), b: clean(phoneB, 20) } } : {};
  return { ...contact, id: uid(), a: clean(a), b: clean(b), court: '', time: null, timeLocked: false, status: 'queued', ending: false, shownAt: null,
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

// Tentative schedule — one implementation shared with the browser (public/js/goat-shared.js).
const shared = require('../public/js/goat-shared');
function normalize(st, now = Date.now()) { return shared.normalize(st, now); }

// Countdown finished → the called match goes live by itself. Returns true if anything changed.
function autoStart(st, now = Date.now()) {
  if (!st.settings.autoStart) return false;
  const due = st.matches.filter((m) => m.status === 'called' && m.callAt <= now);
  due.forEach((m) => ops(st).startMatch(m, now));
  if (due.length) activeOnTop(st);
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
    Object.assign(m, { status: 'queued', ending: false, startedAt: null, calledAt: null, callAt: null, court: '', pinned: false });
  }
  const onBoard = (m) => st.matches.indexOf(m) < BOARD_SIZE;
  const boardError = () => new Error('Only matches on the board can start. Drag it onto the board first.');
  // The court that is counting down belongs to whoever is highest in the order of play.
  // e.g. a match dragged above the called one takes over its court and countdown. Manual calls (pinned) stay put.
  function rebalance(now) {
    const waiting = st.matches.filter((x) => x.status === 'queued' || (x.status === 'called' && !x.pinned));
    const called = waiting.filter((x) => x.status === 'called');
    if (called.length) {
      const should = waiting.slice(0, called.length);
      if (!should.every((x) => x.status === 'called')) {
        const slots = called.map((x) => ({ court: x.court, callAt: x.callAt, calledAt: x.calledAt })).sort((a, b) => a.callAt - b.callAt);
        called.forEach((x) => { if (!should.includes(x)) Object.assign(x, { status: 'queued', court: '', callAt: null, calledAt: null, pinned: false }); });
        should.forEach((x, i) => { clearReady(x); Object.assign(x, { status: 'called', ending: false, court: slots[i].court, callAt: slots[i].callAt, calledAt: slots[i].calledAt, pinned: false }); });
      }
    }
    // "be ready" also follows the order: it belongs to the first waiting match
    const ready = st.matches.find((x) => x.ready), first = st.matches.find((x) => x.status === 'queued');
    if (ready && first && ready !== first) {
      const { readyFor, readyCourt } = ready;
      clearReady(ready);
      Object.assign(first, { ready: true, readyFor, readyCourt, readyAt: now });
    }
  }
  // Call a match to a court: it shows "Court N · starts in mm:ss", then goes live automatically.
  function callMatch(m, court, now, minutes = st.settings.callMinutes, pinned = false) {
    clearReady(m);
    m.status = 'called'; m.ending = false; m.court = court; m.calledAt = now; m.pinned = !!pinned;
    m.callAt = Math.round(now + Math.max(0, minutes) * 60000);
    m.time = m.callAt;
    if (st.settings.liveToTop) moveTo(m.id, liveCount(m.id));
  }
  return { idxOf, liveCount, courtCap, capError, moveTo, courtBusy, freeCourt, flagReady, unflagReady, startMatch, backToQueue, callMatch, onBoard, boardError, rebalance };
}

// Live matches, then matches counting down to start, always hold the top spots of the board (stable order otherwise).
function activeOnTop(st) {
  const live = st.matches.filter((m) => m.status === 'live'), called = st.matches.filter((m) => m.status === 'called');
  const rest = st.matches.filter((m) => m.status !== 'live' && m.status !== 'called');
  st.matches = live.concat(called, rest);
}

// Apply one admin action to the state (mutates it). Returns extra info for the admin, or null. Throws on bad input.
function apply(st, act, now = Date.now()) {
  const result = applyAction(st, act, now);
  activeOnTop(st);
  return result;
}
function applyAction(st, act, now) {
  const o = ops(st);
  const m = act.id ? st.matches.find((x) => x.id === act.id) : null;
  switch (act.type) {
    case 'add': {
      const list = Array.isArray(act.items) ? act.items : [act];
      const made = list.filter((x) => clean(x.a) || clean(x.b)).slice(0, 1000).map(newMatch);
      if (!made.length) throw new Error('Enter at least one player name');
      st.matches.splice(act.where === 'next' ? o.liveCount() : st.matches.length, 0, ...made);
      o.rebalance(now);
      break;
    }
    case 'update': {
      if (!m) throw new Error('Match not found');
      if ('a' in act) m.a = clean(act.a);
      if ('b' in act) m.b = clean(act.b);
      if ('court' in act) m.court = clean(act.court, 12);
      if ('phoneA' in act || 'phoneB' in act) m.contact = { a: clean(act.phoneA, 20), b: clean(act.phoneB, 20) };
      break;
    }
    case 'delay': {
      if (!m) throw new Error('Match not found');
      m.delay = Math.max(0, Math.min(180, Math.round(Number(act.minutes) || 0)));
      break;
    }
    case 'move': if (!m) throw new Error('Match not found'); o.moveTo(act.id, act.to); o.rebalance(now); break;
    case 'live': {
      if (!m) throw new Error('Match not found');
      if (act.live) {
        if (m.status === 'queued' && !o.onBoard(m)) throw o.boardError();
        if (m.status === 'queued' && o.liveCount(m.id) >= o.courtCap()) throw o.capError();
        if (act.court != null && act.court !== '') { if (o.courtBusy(clean(act.court, 12), m.id)) throw new Error('Court ' + clean(act.court, 12) + ' is busy'); m.court = clean(act.court, 12); }
        o.startMatch(m, now);
        if (st.settings.liveToTop) o.moveTo(m.id, o.liveCount(m.id));
      } else o.backToQueue(m);
      break;
    }
    case 'call': {
      if (!m) throw new Error('Match not found');
      if (m.status === 'queued' && !o.onBoard(m)) throw o.boardError();
      if (m.status === 'queued' && o.liveCount(m.id) >= o.courtCap()) throw o.capError();
      if (act.court && o.courtBusy(clean(act.court, 12), m.id)) throw new Error('Court ' + clean(act.court, 12) + ' is busy');
      const court = act.court ? clean(act.court, 12) : (m.court && !o.courtBusy(m.court, m.id) ? m.court : o.freeCourt());
      if (!court) throw new Error('All courts are busy');
      o.callMatch(m, court, now, Number.isFinite(act.minutes) ? act.minutes : undefined, true);
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
      Object.assign(m, { status: 'done', ending: false, endedAt: now, calledAt: null, callAt: null, winner: act.winner === 'a' || act.winner === 'b' ? act.winner : null });
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
        notify: s.notify ?? cur.notify,
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
const strip = (m) => { if (!m.contact) return m; const { contact, ...rest } = m; return rest; }; // screens never get phone numbers
const view = (st, extra = {}) => ({ ...st, matches: st.matches.map(strip), done: st.done.map(strip), boardSize: BOARD_SIZE, now: Date.now(), ...extra });

module.exports = { BOARD_SIZE, clean, newMatch, newState, migrate, normalize, autoStart, apply, view, ops };
