// THE GOAT — match rules, shared by the laptop server (wifi-server.js) and the Vercel functions (api/*.js).
// Everything works on a plain `state` object passed in; no I/O here.
const crypto = require('crypto');
const shared = require('../public/js/goat-shared');

const BOARD_SIZE = 10;
const uid = () => crypto.randomBytes(5).toString('hex');
const clean = (s, n = 60) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n);
const DEFAULT_SETTINGS = { notify: false, replayMinutes: 10, matchMinutes: 20, restMinutes: 15, courtNames: '1, 2, 3, 4, 5', courts: 5, liveToTop: true, adSeconds: 8, callMinutes: 5, autoCall: true, autoStart: true,
  catStart: { U11: 570, U13: 690, U15: 840, U17: 960 }, autoFill: false }; // category start times (minutes after midnight, India time)

// Knockout fields (draws only): cat 'U13' · rd 'QF' · no 5 (match number in its category) · pa/pb 'Winner of #3' while unknown
// · nx/ns: the winner goes to match nx, side ns · xa/xb: nobody will come for that side (→ walkover) · wo: decided by walkover
const KO = ['cat', 'rd', 'no', 'pa', 'pb', 'nx', 'ns', 'bye'];
// hold: true = in its category's list but NOT in the order of play (top 10) yet — the organiser adds it when wanted.
function newMatch({ a, b, phoneA, phoneB, ...rest }) {
  const contact = phoneA || phoneB ? { contact: { a: clean(phoneA, 20), b: clean(phoneB, 20) } } : {};
  const ko = {}; KO.forEach((k) => { if (rest[k] != null && rest[k] !== '') ko[k] = k === 'no' ? Number(rest[k]) : clean(rest[k], 40); });
  const extra = {}; if (rest.xa) extra.xa = true; if (rest.xb) extra.xb = true; if (rest.hold) extra.hold = true;
  return { ...contact, ...ko, ...extra, id: uid(), a: clean(a), b: clean(b), court: '', time: null, timeLocked: false, status: 'queued', ending: false, shownAt: null,
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
  if (!String(st.settings.courtNames || '').trim()) { st.settings.courtNames = DEFAULT_SETTINGS.courtNames; st.settings.courts = 5; } // THE GOAT: courts 1–5
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
  const courtNames = () => shared.courtList(st.settings);
  const courtCap = () => courtNames().length;
  const capError = () => new Error(`All ${courtCap()} courts are busy. End a match first.`);
  function moveTo(id, to) {
    const from = idxOf(id);
    if (from < 0) return;
    const [m] = st.matches.splice(from, 1);
    const inOrder = st.matches.filter((x) => !x.hold).length; // held matches always sit after the order of play
    to = Math.max(0, Math.min(m.hold ? st.matches.length : inOrder, Number(to) | 0));
    st.matches.splice(to, 0, m);
  }
  const courtBusy = (court, exceptId) => !!court && st.matches.some((m) => isActive(m) && m.id !== exceptId && String(m.court) === String(court));
  function freeCourt() {
    const used = new Set(st.matches.filter(isActive).map((m) => String(m.court)));
    for (const c of courtNames()) if (!used.has(c)) return c;
    return '';
  }
  // Can this match be played now? Both players known, neither on court in another match (a kid entered in two
  // categories), and — if possible — both rested since their last match.
  const pn = shared.pname;
  function busyNames(exceptId) { const s = new Set(); st.matches.forEach((x) => { if (isActive(x) && x.id !== exceptId) [x.a, x.b].forEach((n) => n && s.add(pn(n))); }); return s; }
  function rested(m, now) {
    const R = (Number(st.settings.restMinutes) || 0) * 60000; if (!R) return true;
    const me = [m.a, m.b].map(pn);
    return !st.done.some((d) => d.endedAt && now - d.endedAt < R && !d.wo && [d.a, d.b].some((n) => n && me.includes(pn(n))));
  }
  const playable = (m, busy = busyNames(m.id)) => shared.known(m) && ![m.a, m.b].some((n) => busy.has(pn(n)));
  // the next match to put on a court: first in the order that can be played (rested players first)
  function pickNext(now, skip = () => false) {
    const busy = busyNames(), q = st.matches.filter((x) => x.status === 'queued' && !x.hold && !skip(x) && playable(x, busy));
    return q.find((x) => rested(x, now)) || q[0] || null;
  }
  // While match F is "finishing", the next queued match gets "BE READY · COURT n" on the board.
  function flagReady(f, now) {
    if (st.matches.some((x) => x.ready && x.readyFor === f.id)) return;
    const next = pickNext(now, (x) => x.ready);
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
    const busy = busyNames();
    const waiting = st.matches.filter((x) => (x.status === 'queued' && !x.hold && playable(x, busy)) || (x.status === 'called' && !x.pinned));
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
    const ready = st.matches.find((x) => x.ready), first = ready ? pickNext(now, (x) => x.ready && x !== ready) : null;
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
  const notReady = (m) => { if (!shared.known(m)) return new Error(`Players not known yet (${m.pa || m.pb || 'waiting for an earlier match'}) — type the names in, or finish that match first`);
    const b = busyNames(m.id), who = [m.a, m.b].find((n) => b.has(pn(n))); return who ? new Error(`${who} is on court in another match right now`) : null; };
  // Put matches into the order of play: held matches whose players are known, oldest category first (its start time),
  // then by match number (= round order) — so a category moves on to its quarter/semi/final before the next one floods the courts.
  function fill(now, { cat = null, upto = BOARD_SIZE, timeGate = false } = {}) {
    const s = st.settings, inOrder = () => st.matches.filter((x) => !x.hold).length;
    const cand = st.matches.filter((x) => x.hold && x.status === 'queued' && shared.known(x) && (cat == null || x.cat === cat)
      && (!timeGate || shared.catAt(s, x.cat, now) <= now + 30 * 60000))
      .sort((x, y) => (shared.catAt(s, x.cat, now) - shared.catAt(s, y.cat, now)) || ((x.no || 0) - (y.no || 0)));
    let added = 0;
    for (const x of cand) { if (inOrder() >= upto) break; unhold(x); added++; }
    return added;
  }
  function unhold(x) { x.hold = false; moveTo(x.id, st.matches.filter((y) => !y.hold && y !== x).length); }
  function hold(x) { if (x.status === 'called') backToQueue(x); // counting down → stop it and take it out
    if (x.status !== 'queued') throw new Error(x.status === 'live' ? 'This match is being played — end it first' : 'Only a waiting match can be taken out'); unflagReady(x); clearReady(x); x.hold = true; x.delay = 0; moveTo(x.id, st.matches.length); }
  return { fill, unhold, hold, idxOf, liveCount, courtCap, courtNames, capError, moveTo, courtBusy, freeCourt, flagReady, unflagReady, startMatch, backToQueue, callMatch, onBoard, boardError, rebalance, pickNext, notReady };
}

// A knockout match is over → its winner goes into the next round (name + WhatsApp number). No winner (both absent /
// cancelled) → that side of the next match stays empty, so the other player gets a walkover. Repeats down the bracket.
function advance(st, m, now) {
  if (!m.nx) return;
  const dep = st.matches.find((x) => x.id === m.nx); if (!dep || dep.status !== 'queued') return;
  const side = m.ns === 'b' ? 'b' : 'a', x = 'x' + side;
  const w = m.winner === 'a' || m.winner === 'b' ? m.winner : null;
  if (w) {
    dep[side] = w === 'a' ? m.a : m.b; dep[x] = false;
    dep.carry = Object.assign(dep.carry || {}, { [side]: { from: m.id, side: w } });        // phone number follows (online)
    if (m.contact) dep.contact = Object.assign({ a: '', b: '' }, dep.contact, { [side]: m.contact[w] || '' }); // (laptop)
  } else { dep[side] = ''; dep[x] = true; }
  settle(st, now);
}
function settle(st, now) {
  for (let guard = 0; guard < 50; guard++) {
    const m = st.matches.find((x) => x.status === 'queued' && ((x.xa && x.xb) || (x.xa && x.b) || (x.xb && x.a)));
    if (!m) return;
    finish(st, m, m.xa && m.xb ? null : m.xa ? 'b' : 'a', now, true);
  }
}
function finish(st, m, winner, now, wo) {
  ops(st).unflagReady(m);
  st.matches.splice(st.matches.indexOf(m), 1);
  Object.assign(m, { status: 'done', ending: false, endedAt: now, calledAt: null, callAt: null, winner: winner === 'a' || winner === 'b' ? winner : null });
  if (wo) m.wo = true;
  clearReady(m);
  st.done.unshift(m);
  advance(st, m, now);
}

// Live matches, then matches counting down to start, always hold the top spots of the board (stable order otherwise).
function activeOnTop(st) {
  const live = st.matches.filter((m) => m.status === 'live'), called = st.matches.filter((m) => m.status === 'called');
  const rest = st.matches.filter((m) => m.status !== 'live' && m.status !== 'called' && !m.hold);
  const held = st.matches.filter((m) => m.status !== 'live' && m.status !== 'called' && m.hold);
  st.matches = live.concat(called, rest, held);
}

// Apply one admin action to the state (mutates it). Returns extra info for the admin, or null. Throws on bad input.
function apply(st, act, now = Date.now()) {
  const result = applyAction(st, act, now);
  activeOnTop(st);
  if (st.settings.autoFill && act.type !== 'removeCat') { // automatic mode: keep the top 10 topped up
    const o = ops(st);
    if (o.fill(now, { timeGate: true })) { o.rebalance(now); activeOnTop(st); }
  }
  return result;
}
function applyAction(st, act, now) {
  const o = ops(st);
  const m = act.id ? st.matches.find((x) => x.id === act.id) : null;
  if (m && m.status === 'bye' && !['showBye', 'move', 'fillBye'].includes(act.type)) throw new Error('This is a bye shown on the board — use “Take off the screen”');
  switch (act.type) {
    case 'add': {
      const list = Array.isArray(act.items) ? act.items : [act];
      const made = list.filter((x) => clean(x.a) || clean(x.b)).slice(0, 1000).map(newMatch);
      if (!made.length) throw new Error('Enter at least one player name');
      st.matches.splice(act.where === 'next' ? o.liveCount() : st.matches.length, 0, ...made);
      o.rebalance(now);
      break;
    }
    case 'draw': { // knockout draws from a player list (see public/js/goat-draw.js)
      const D = require('../public/js/goat-draw');
      const cats = (Array.isArray(act.cats) ? act.cats : []).filter((c) => c && clean(c.cat, 20));
      if (!cats.length) throw new Error('No categories in the list');
      const have = new Set(st.matches.concat(st.done).map((x) => x.cat).filter(Boolean));
      const s = act.settings || {};
      if (s.courtNames != null && clean(s.courtNames, 60)) { st.settings.courtNames = clean(s.courtNames, 60); st.settings.courts = shared.courtList(st.settings).length; }
      if (Number(s.matchMinutes) >= 5) st.settings.matchMinutes = Math.min(120, Math.round(+s.matchMinutes));
      if (s.restMinutes != null && s.restMinutes !== '' && Number(s.restMinutes) >= 0) st.settings.restMinutes = Math.min(120, Math.round(+s.restMinutes));
      const all = [];
      cats.forEach((c) => {
        const cat = clean(c.cat, 20);
        if (have.has(cat)) throw new Error(`${cat} already has a draw. Undo it (or delete its matches) first.`);
        if (Array.isArray(c.pairs)) { // first round fixed by the organiser (incl. byes)
          const pairs = c.pairs.slice(0, 256).map((p) => ({ a: clean(p.a), b: clean(p.b), phoneA: clean(p.phoneA, 20), phoneB: clean(p.phoneB, 20) }));
          all.push(...D.drawPairs(cat, pairs).matches);
        } else {
          const players = (c.players || []).slice(0, 256).map((p) => ({ name: clean(p.name), phone: clean(p.phone, 20) }));
          all.push(...D.draw(cat, players).matches);
        }
      });
      if (s.catStart != null) { const cs = typeof s.catStart === 'string' ? shared.parseCatStart(s.catStart) : s.catStart; if (cs && Object.keys(cs).length) st.settings.catStart = Object.assign({}, st.settings.catStart, cs); }
      // nothing goes into the order of play by itself: every match waits in its category list until the organiser adds it
      const at = (x) => shared.catAt(st.settings, x.cat, now) || 0;
      const ordered = all.slice().sort((x, y) => at(x) - at(y) || (x.cat < y.cat ? -1 : x.cat > y.cat ? 1 : 0) || x.no - y.no);
      const id = {}; ordered.forEach((x) => { id[x.key] = uid(); });
      const made = ordered.map((x) => { const nm = newMatch(Object.assign({}, x, { nx: x.nxKey ? id[x.nxKey] : '', hold: true })); nm.id = id[x.key]; return nm; });
      st.matches.push(...made);
      made.filter((x) => x.bye).forEach((x) => { finish(st, x, x.bye, now, true); }); // byes: through to the next round straight away
      settle(st, now);
      o.rebalance(now);
      return { drawn: made.filter((x) => !x.bye).length, byes: made.filter((x) => x.bye).length };
    }
    case 'queue': { // add to / take out of the order of play (top 10)
      const list = (Array.isArray(act.ids) ? act.ids : [act.id]).map((i) => st.matches.find((x) => x.id === i)).filter(Boolean);
      if (!list.length) throw new Error('Match not found');
      list.forEach((x) => { if (act.on === false) o.hold(x); else if (x.hold) { o.unhold(x); if (act.to != null) o.moveTo(x.id, act.to); } });
      o.rebalance(now);
      break;
    }
    case 'fill': { // "Fill the top 10 from this category"
      const n = o.fill(now, { cat: act.cat ? clean(act.cat, 20) : null, upto: Math.max(1, Math.min(60, Number(act.upto) || BOARD_SIZE)) });
      o.rebalance(now);
      return { added: n };
    }
    case 'setWinner': { // a match ended without a winner → choose it later; the winner then goes into the next round
      const x = st.done.find((y) => y.id === act.id);
      if (!x) throw new Error('Match not found');
      const w = act.winner === 'b' ? 'b' : 'a';
      if (!x[w]) throw new Error('No player on that side');
      const dep = x.nx && st.matches.find((y) => y.id === x.nx);
      if (x.nx && !dep) throw new Error('The next-round match was already decided — Restore it first');
      if (dep && dep.status !== 'queued') throw new Error('The next-round match is already on court');
      x.winner = w; x.wo = !!act.wo;
      advance(st, x, now);
      break;
    }
    case 'fillBye': { // a late entry takes a bye: the bye becomes a real match, the next round waits for its winner again
      const name = clean(act.name); if (!name) throw new Error('Type the new player\'s name');
      let x = st.done.find((y) => y.id === act.id && y.bye), fromBoard = false;
      if (!x) { x = st.matches.find((y) => y.id === act.id && y.status === 'bye'); fromBoard = !!x; }
      if (!x) throw new Error('Bye not found');
      const dep = x.nx && st.matches.find((y) => y.id === x.nx);
      if (x.nx && (!dep || dep.status !== 'queued')) throw new Error('The next-round match has already started — too late to change this bye');
      const empty = x.bye === 'a' ? 'b' : 'a';
      if (fromBoard) st.matches.splice(st.matches.indexOf(x), 1); else st.done.splice(st.done.indexOf(x), 1);
      x[empty] = name; x['p' + empty] = ''; x['x' + empty] = false;
      x.contact = { a: clean(act.phoneA, 20), b: clean(act.phoneB, 20) }; // both sides (the page sends the existing number too)
      Object.assign(x, { status: 'queued', hold: true, bye: '', wo: false, winner: null, endedAt: null, shownAt: null, court: '', time: null, byeTo: '' });
      if (dep) { const sd = x.ns === 'b' ? 'b' : 'a'; dep[sd] = ''; dep['x' + sd] = false; if (dep.contact) dep.contact[sd] = ''; if (dep.carry) delete dep.carry[sd]; }
      st.matches.push(x);
      break;
    }
    case 'swap': { // swap two players between waiting matches (same round): names + their WhatsApp numbers
      const A = st.matches.find((y) => y.id === act.idA), B = st.matches.find((y) => y.id === act.idB);
      const sa = act.sideA === 'b' ? 'b' : 'a', sb = act.sideB === 'b' ? 'b' : 'a';
      if (!A || !B) throw new Error('Match not found');
      if ([A, B].some((y) => y.status !== 'queued')) throw new Error('Only matches that have not started can be changed');
      if (A === B && sa === sb) break;
      [A[sa], B[sb]] = [B[sb], A[sa]];
      [A, B].forEach((y) => { ['a', 'b'].forEach((k) => { if (y[k]) y['x' + k] = false; }); });
      if (act.contactA) A.contact = { a: clean(act.contactA.a, 20), b: clean(act.contactA.b, 20) };
      if (act.contactB && A !== B) B.contact = { a: clean(act.contactB.a, 20), b: clean(act.contactB.b, 20) };
      [A, B].forEach(clearReady);
      o.rebalance(now);
      break;
    }
    case 'showBye': { // put a bye on the board ("X — BYE, through to the Round of 32") or take it off again
      if (act.on === false) {
        const i = st.matches.findIndex((x) => x.id === act.id && x.status === 'bye');
        if (i < 0) throw new Error('That bye is not on the board');
        const [x] = st.matches.splice(i, 1); x.status = 'done'; st.done.unshift(x);
        break;
      }
      const i = st.done.findIndex((x) => x.id === act.id && x.bye);
      if (i < 0) throw new Error('Bye not found');
      const [x] = st.done.splice(i, 1);
      const dep = x.nx && st.matches.find((y) => y.id === x.nx);
      Object.assign(x, { status: 'bye', hold: false, byeTo: dep ? dep.rd : '' });
      st.matches.splice(o.liveCount(), 0, x); // right under the matches on court, so it's seen
      break;
    }
    case 'removeCat': {
      const cat = clean(act.cat, 20); if (!cat) throw new Error('Which category?');
      if (st.matches.some((x) => x.cat === cat && isActive(x))) throw new Error(cat + ' has a match on court — end it first');
      const n = st.matches.filter((x) => x.cat === cat).length;
      st.matches = st.matches.filter((x) => x.cat !== cat); st.done = st.done.filter((x) => x.cat !== cat);
      return { removed: n };
    }
    case 'update': {
      if (!m) throw new Error('Match not found');
      if ('a' in act) { m.a = clean(act.a); if (m.a) m.xa = false; }
      if ('b' in act) { m.b = clean(act.b); if (m.b) m.xb = false; }
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
        if (m.status === 'queued') { const e = o.notReady(m); if (e) throw e; }
        if (m.hold) m.hold = false;
        if (m.status === 'queued' && o.liveCount(m.id) >= o.courtCap()) throw o.capError();
        if (act.court != null && act.court !== '') { if (o.courtBusy(clean(act.court, 12), m.id)) throw new Error('Court ' + clean(act.court, 12) + ' is busy'); m.court = clean(act.court, 12); }
        o.startMatch(m, now);
        if (st.settings.liveToTop) o.moveTo(m.id, o.liveCount(m.id));
      } else o.backToQueue(m);
      break;
    }
    case 'call': {
      if (!m) throw new Error('Match not found');
      if (m.status === 'queued') { const e = o.notReady(m); if (e) throw e; }
      if (m.status === 'queued' && o.liveCount(m.id) >= o.courtCap()) throw o.capError();
      if (act.court && o.courtBusy(clean(act.court, 12), m.id)) throw new Error('Court ' + clean(act.court, 12) + ' is busy');
      const court = act.court ? clean(act.court, 12) : (m.court && !o.courtBusy(m.court, m.id) ? m.court : o.freeCourt());
      if (!court) throw new Error('All courts are busy');
      m.hold = false;
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
      const wasOn = isActive(m);
      st.matches.splice(o.idxOf(m.id), 1);
      Object.assign(m, { status: 'done', ending: false, endedAt: now, calledAt: null, callAt: null, winner: act.winner === 'a' || act.winner === 'b' ? act.winner : null });
      if (act.wo) m.wo = true; // walkover / no-show: decided without playing
      st.done.unshift(m);
      if (m.winner) advance(st, m, now); // no winner chosen → the next round keeps waiting ("Winner of #n") until one is chosen on the bracket card
      if (st.settings.autoCall && wasOn) { // hand the freed court to whoever is next (the "be ready" match first)
        const court = freed && !o.courtBusy(freed) ? freed : o.freeCourt();
        const r1 = st.matches.find((x) => x.status === 'queued' && x.readyFor === m.id);
        const next = (r1 && !o.notReady(r1) ? r1 : null) || o.pickNext(now);
        if (court && next) { o.callMatch(next, court, now); return { called: { a: next.a, b: next.b, court } }; }
      }
      if (readyOne) clearReady(readyOne);
      break;
    }
    case 'restore': {
      const i = st.done.findIndex((x) => x.id === act.id);
      if (i < 0) throw new Error('Match not found');
      const [r] = st.done.splice(i, 1);
      if (r.bye) throw new Error("A bye can't be restored");
      o.backToQueue(r); r.endedAt = null; r.shownAt = null; r.wo = false; r.hold = false;
      const dep = r.nx && st.matches.find((x) => x.id === r.nx && x.status === 'queued');
      if (dep) { const sd = r.ns === 'b' ? 'b' : 'a'; dep[sd] = ''; dep['x' + sd] = false; } // the next round waits for it again
      st.matches.splice(o.liveCount(), 0, r);
      break;
    }
    case 'remove': {
      if (m) o.unflagReady(m);
      const i = o.idxOf(act.id);
      if (i >= 0) { st.matches.splice(i, 1); if (m.nx) { m.winner = null; advance(st, m, now); } } // knockout: cancelled → the next opponent gets a walkover
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
        matchMinutes: num(s.matchMinutes ?? cur.matchMinutes, 5, 120, 20),
        courts: clean(s.courtNames ?? cur.courtNames ?? '', 60) ? clean(s.courtNames ?? cur.courtNames, 60).split(/[,\s]+/).filter(Boolean).length : num(s.courts ?? cur.courts, 1, 20, 4),
        liveToTop: s.liveToTop ?? cur.liveToTop,
        adSeconds: num(s.adSeconds ?? cur.adSeconds, 2, 120, 8),
        callMinutes: num(s.callMinutes ?? cur.callMinutes, 0, 60, 5),
        restMinutes: num(s.restMinutes ?? cur.restMinutes, 0, 120, 15),
        courtNames: clean(s.courtNames ?? cur.courtNames ?? '', 60),
        autoCall: s.autoCall ?? cur.autoCall,
        autoStart: s.autoStart ?? cur.autoStart,
        notify: s.notify ?? cur.notify,
        catStart: s.catStart != null ? (typeof s.catStart === 'string' ? shared.parseCatStart(s.catStart) : s.catStart) : cur.catStart || {},
        autoFill: !!(s.autoFill ?? cur.autoFill),
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
