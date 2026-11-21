// Shared by the browser (window.GoatShared) and the server (require). No dependencies.
//  - normalize(): tentative times (each match ~matchMinutes from when its court frees up)
//  - toTree()/toState()/diff(): how the fixtures are stored in Firebase so that every change
//    sends only the few matches that changed, not the whole list.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.GoatShared = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const isActive = (m) => m.status === 'live' || m.status === 'called';

  // Court names, e.g. "1, 2, 3, 5" (settings.courtNames); otherwise 1…courts.
  function courtList(s) {
    const raw = String((s && s.courtNames) || '').split(/[,\s]+/).map((x) => x.trim()).filter(Boolean);
    if (raw.length) return raw.slice(0, 20);
    return Array.from({ length: Number(s && s.courts) || 4 }, (_, i) => String(i + 1));
  }
  const pname = (n) => String(n || '').toLowerCase().replace(/[^a-z0-9]+/g, ''); // 'Aarav  Shah' = 'aarav shah'
  const known = (m) => !!(m.a && m.b); // both players known (a knockout match waits for its "Winner of #n")
  // Category start times, e.g. {U11: 570} = 9:30 (minutes after midnight, India time). Typed as "U11 9:30, U13 11:30, U15 2pm".
  function parseCatStart(text) {
    const out = {}, re = /((?:boys|girls)?\s*u\s*-?\s*\d{1,2})\s*[-:=@]?\s*(?:at\s*)?(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)?/gi;
    const str = String(text || '');
    let m; while ((m = re.exec(str))) {
      const g = (m[1].match(/boys|girls/i) || [''])[0], cat = (g ? g[0].toUpperCase() + g.slice(1).toLowerCase() + ' ' : '') + 'U' + Number(m[1].replace(/\D/g, ''));
      let h = Number(m[2]); const mi = Number(m[3] || 0), ap = (m[4] || '').toLowerCase();
      if (ap === 'pm' && h < 12) h += 12; else if (ap === 'am' && h === 12) h = 0; else if (!ap && h < 8) h += 12; // "2:00" = 2 pm
      if (h < 24 && mi < 60) out[cat] = h * 60 + mi;
    }
    return out;
  }
  const fmtCatStart = (o) => Object.keys(o || {}).sort((a, b) => o[a] - o[b]).map((c) => c + ' ' + Math.floor(o[c] / 60) + ':' + String(o[c] % 60).padStart(2, '0')).join(', ');
  const IST = 330 * 60000, DAY = 864e5;
  // the moment a category starts today (or 0 if no start time is set)
  const catAt = (s, cat, now) => { const v = s && s.catStart && cat != null ? s.catStart[cat] : null; return v == null ? 0 : Math.floor((now + IST) / DAY) * DAY - IST + v * 60000; };

  // Tentative times, by playing the rest of the day through:
  //  • each court is busy for matchMinutes from when its match started (or is called to start)
  //  • when a court frees up it takes the first waiting match (in the Control Room's order) that can be played then:
  //    both players known — or their earlier match will be over — and each player has had restMinutes off
  //  • plus any delay the admin added. A match whose players can't be worked out yet gets no time (TBA).
  function normalize(st, now) {
    now = now || Date.now();
    const s = st.settings || {}, D = (Number(s.matchMinutes) || 15) * 60000, REST = (s.restMinutes == null ? 15 : Number(s.restMinutes) || 0) * 60000;
    const courts = courtList(s), free = courts.map(() => now);
    const earliest = () => free.indexOf(Math.min(...free));
    const endOf = {}, pFree = {};
    const pk = (m, side) => pname(m[side]); // same kid in two categories (U13 + U15) = one person: never two matches at once
    const busyTill = (m, t) => ['a', 'b'].forEach((sd) => { if (m[sd]) { const k = pk(m, sd); pFree[k] = Math.max(pFree[k] || 0, t + REST); } });
    (st.done || []).forEach((m) => { endOf[m.id] = m.endedAt || 0; if (!m.wo) busyTill(m, m.endedAt || 0); }); // a bye / walkover isn't tiring
    st.matches.forEach((m) => {
      if (!isActive(m)) return;
      const end = m.status === 'live' ? Math.max(now, (m.startedAt || now) + D) : Math.max(now, m.callAt) + D;
      let k = courts.indexOf(String(m.court)); if (k < 0) k = earliest();
      free[k] = Math.max(free[k], end);
      endOf[m.id] = end; busyTill(m, end);
      m.time = m.status === 'live' ? m.startedAt : m.callAt;
    });
    const feed = {}; st.matches.forEach((m) => { if (m.nx) (feed[m.nx] = feed[m.nx] || []).push(m); });
    const readyAt = (m) => {
      let t = Math.max(now, catAt(s, m.cat, now)); // not before the category's start time
      ['a', 'b'].forEach((sd) => { if (m[sd]) t = Math.max(t, pFree[pk(m, sd)] || 0); });
      (feed[m.id] || []).forEach((f) => { if (!m[f.ns || 'a']) t = Math.max(t, endOf[f.id] == null ? Infinity : endOf[f.id] + REST); });
      if (!known(m) && !(feed[m.id] || []).length && !(m.xa || m.xb)) t = Infinity; // nobody can fill it in
      return t;
    };
    st.matches.forEach((m) => { if (m.hold && m.status === 'queued') { m.time = null; m.timeLocked = false; } }); // not in the order of play yet
    const waiting = st.matches.filter((m) => m.status === 'queued' && !m.hold), left = new Set(waiting);
    waiting.forEach((m) => { m.time = null; m.timeLocked = false; });
    while (left.size) {
      const k = earliest(), T = free[k];
      let pick = null, at = Infinity;
      for (const m of waiting) {
        if (!left.has(m)) continue;
        const r = readyAt(m) + (Number(m.delay) || 0) * 60000;
        if (r <= T) { pick = m; at = T; break; }
        if (r < at) { pick = m; at = r; }
      }
      if (!pick || at === Infinity) break;
      left.delete(pick);
      pick.time = Math.ceil(at / 60000) * 60000;
      endOf[pick.id] = at + D; free[k] = at + D; busyTill(pick, at + D);
    }
    if (st.done && st.done.length > 600) st.done.length = 600;
    return st;
  }

  // ── storage layout ──  goat/meta {title, subtitle, settings, replayNonce, rev, canUndo}
  //                      goat/matches/<id> {…, pos}   goat/done/<id>
  // Play order = matches sorted by `pos`. Moving a match changes only that match's pos, so a reorder
  // sends one small record instead of the whole order list.
  const SKIP = { id: 1, time: 1, timeLocked: 1, shownAt: 1, pos: 1, contact: 1, carry: 1 }; // contact = phone numbers, kept private
  function strip(m) {
    const o = {};
    Object.keys(m).sort().forEach((k) => { if (!SKIP[k] && m[k] !== null && m[k] !== undefined) o[k] = m[k]; });
    return o;
  }
  // New positions for `ids` (in the wanted order), keeping as many old positions as possible
  // (longest increasing run of old positions stays put; the rest slot in between).
  function assignPos(ids, oldPos) {
    const n = ids.length, res = new Array(n);
    const seq = [];
    ids.forEach((id, i) => { if (typeof oldPos[id] === 'number') seq.push({ i, p: oldPos[id] }); });
    const tails = [], tailIdx = [], prev = new Array(seq.length);
    seq.forEach((x, k) => {
      let lo = 0, hi = tails.length;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (tails[mid] < x.p) lo = mid + 1; else hi = mid; }
      tails[lo] = x.p; tailIdx[lo] = k; prev[k] = lo > 0 ? tailIdx[lo - 1] : -1;
    });
    for (let k = tails.length ? tailIdx[tails.length - 1] : -1; k >= 0; k = prev[k]) res[seq[k].i] = seq[k].p;
    for (let i = 0; i < n;) {
      if (res[i] !== undefined) { i++; continue; }
      let j = i; while (j < n && res[j] === undefined) j++;
      const lo = i > 0 ? res[i - 1] : j < n ? res[j] - (j - i + 1) * 1024 : 0;
      const hi = j < n ? res[j] : lo + (j - i + 1) * 1024;
      const step = (hi - lo) / (j - i + 1);
      for (let t = i; t < j; t++) res[t] = lo + step * (t - i + 1);
      i = j;
    }
    for (let i = 1; i < n; i++) if (!(res[i] - res[i - 1] > 1e-6)) return ids.map((_, k) => (k + 1) * 1024); // ran out of room → renumber
    return res;
  }
  function toTree(st, prevTree) {
    const old = (prevTree && prevTree.matches) || {};
    const oldPos = {};
    Object.keys(old).forEach((id) => { if (typeof old[id].pos === 'number') oldPos[id] = old[id].pos; });
    const pos = assignPos(st.matches.map((m) => m.id), oldPos);
    const tree = {
      meta: { title: st.title || '', subtitle: st.subtitle || '', settings: st.settings || {}, replayNonce: st.replayNonce || 0, rev: st.rev || 0, canUndo: !!st.canUndo },
      matches: {}, done: {},
    };
    st.matches.forEach((m, i) => { tree.matches[m.id] = Object.assign(strip(m), { pos: pos[i] }); });
    (st.done || []).forEach((m) => { tree.done[m.id] = strip(m); });
    return tree;
  }
  const list = (v) => (Array.isArray(v) ? v : v && typeof v === 'object' ? Object.keys(v).sort((a, b) => a - b).map((k) => v[k]) : []);
  function toState(tree) {
    tree = tree || {};
    const meta = tree.meta || {}, ms = tree.matches || {};
    const fill = (id, m) => Object.assign({ id, a: '', b: '', court: '', status: 'queued', ending: false, startedAt: null, endedAt: null, calledAt: null, callAt: null,
      ready: false, readyFor: null, readyCourt: '', readyAt: null, delay: 0 }, m);
    let ids;
    if (tree.order) ids = list(tree.order).filter((id) => ms[id]); // data saved by an earlier version
    else ids = Object.keys(ms).sort((a, b) => (ms[a].pos || 0) - (ms[b].pos || 0) || (a < b ? -1 : 1));
    return {
      title: meta.title || 'THE GOAT Badminton Tournament', subtitle: meta.subtitle || 'Next 10 Matches', settings: meta.settings || {},
      replayNonce: meta.replayNonce || 0, rev: meta.rev || 0, canUndo: !!meta.canUndo,
      matches: ids.map((id) => fill(id, ms[id])),
      done: Object.keys(tree.done || {}).map((id) => fill(id, tree.done[id])).sort((a, b) => (b.endedAt || 0) - (a.endedAt || 0)),
    };
  }
  // stable JSON so {a,b} and {b,a} compare equal (Firebase returns keys sorted)
  function stable(v) {
    if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
    if (v && typeof v === 'object') return '{' + Object.keys(v).sort().filter((k) => v[k] !== null && v[k] !== undefined).map((k) => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}';
    return JSON.stringify(v);
  }
  // Multi-path update that turns tree `a` into tree `b`, touching only what changed.
  function diff(a, b) {
    a = a || {};
    const p = {};
    if (stable(a.meta || {}) !== stable(b.meta)) p.meta = b.meta;
    if (a.order) p.order = null; // drop the old-style order list
    for (const key of ['matches', 'done']) {
      const A = a[key] || {}, B = b[key] || {};
      new Set([...Object.keys(A), ...Object.keys(B)]).forEach((id) => {
        if (!B[id]) p[key + '/' + id] = null;
        else if (!A[id] || stable(A[id]) !== stable(B[id])) p[key + '/' + id] = B[id];
      });
    }
    return p;
  }
  return { normalize, toTree, toState, diff, stable, courtList, known, pname, parseCatStart, fmtCatStart, catAt };
});
