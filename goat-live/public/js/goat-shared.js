// Shared by the browser (window.GoatShared) and the server (require). No dependencies.
//  - normalize(): tentative times (each match ~matchMinutes from when its court frees up)
//  - toTree()/toState()/diff(): how the fixtures are stored in Firebase so that every change
//    sends only the few matches that changed, not the whole list.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.GoatShared = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const isActive = (m) => m.status === 'live' || m.status === 'called';

  // Each court is busy for matchMinutes from when its match started (or is called to start).
  // Waiting matches, in order, take whichever court frees up first, plus any delay the admin added.
  function normalize(st, now) {
    now = now || Date.now();
    const s = st.settings || {}, D = (Number(s.matchMinutes) || 15) * 60000, n = s.courts || 4;
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
    if (st.done && st.done.length > 300) st.done.length = 300;
    return st;
  }

  // ── storage layout ──  goat/meta {title, subtitle, settings, replayNonce, rev, canUndo}
  //                      goat/matches/<id> {…, pos}   goat/done/<id>
  // Play order = matches sorted by `pos`. Moving a match changes only that match's pos, so a reorder
  // sends one small record instead of the whole order list.
  const SKIP = { id: 1, time: 1, timeLocked: 1, shownAt: 1, pos: 1, contact: 1 }; // contact = phone numbers, kept private
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
  return { normalize, toTree, toState, diff, stable };
});
