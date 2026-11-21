// Knockout draws + order of play. Shared by the browser (window.GoatDraw) and the server (require). No dependencies.
//
//  draw(cat, players)  players in list order → every match of the category, all rounds:
//      • the draw is the next power of two (33 players → 64), byes spread evenly: each half gets an equal share
//        (46 players → 23 + 23), and so does every quarter, eighth, …  Byes only ever happen in Round 1.
//      • players next to each other in the list meet in Round 1 (if neither has a bye).
//      • later rounds are "Winner of #5 v Winner of #6"; a bye player goes straight into Round 2.
//  order(matches)       one order of play for all categories together (see the rules there)
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.GoatDraw = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const ROUND_NAME = { R1: 'First Round', R128: 'Round of 128', R64: 'Round of 64', R32: 'Round of 32', R16: 'Pre-Quarter Final', QF: 'Quarter Final', SF: 'Semi Final', F: 'Final' };
  const bySize = (n) => (n === 2 ? 'F' : n === 4 ? 'SF' : n === 8 ? 'QF' : n === 16 ? 'R16' : 'R' + n);

  // n players in a draw of `size`: top half gets ceil(n/2), bottom half floor(n/2), all the way down.
  function leaves(list, size) {
    if (size === 1) return [list[0] || null];
    const top = Math.ceil(list.length / 2);
    return leaves(list.slice(0, top), size / 2).concat(leaves(list.slice(top), size / 2));
  }

  function draw(cat, players) {
    players = players.filter((p) => p && String(p.name || '').trim());
    const n = players.length;
    if (n < 2) throw new Error(`${cat}: needs at least 2 players`);
    let size = 2; while (size < n) size *= 2;
    const byes = size - n, matches = [];
    let slots = leaves(players, size).map((p) => (p ? { player: p } : null)); // what comes up from each position
    let round = 1;
    while (slots.length > 1) {
      const rd = round === 1 && byes ? 'R1' : bySize(slots.length), next = [], made = [];
      for (let i = 0; i < slots.length; i += 2) {
        const x = slots[i], y = slots[i + 1];
        if (!x || !y) { next.push(x || y); continue; }       // a bye: goes straight up
        const m = { key: cat + ':' + round + ':' + i, cat, rd, round, a: '', b: '', phoneA: '', phoneB: '', pa: '', pb: '' };
        [[x, 'a'], [y, 'b']].forEach(([s, side]) => {
          if (s.player) { m[side] = s.player.name; m['phone' + side.toUpperCase()] = s.player.phone || ''; }
          else { m['p' + side] = s.match; s.feeder.nxKey = m.key; s.feeder.ns = side; }
        });
        made.push(m);
        next.push({ match: m, feeder: m });
      }
      matches.push(...made);
      slots = next;
      round++;
    }
    matches.forEach((m, i) => { m.no = i + 1; });
    matches.forEach((m) => { ['pa', 'pb'].forEach((k) => { if (m[k]) m[k] = 'Winner of #' + m[k].no; }); }); // m[k] held the feeder match
    return { cat, players: n, size, byes, rounds: round - 1, matches };
  }

  // A draw whose first round is already fixed (from the organiser's bracket sheet), in bracket order.
  // pairs: [{a, phoneA, b, phoneB}] — "Bye" (or blank) on one side = that player goes straight through.
  // Row 1 v row 2 winners meet in the next round, row 3 v row 4, … (so bracket 1's rows, then bracket 2's).
  const isBye = (s) => !String(s || '').trim() || /^s*(bye|by|-+|—|x)s*$/i.test(String(s));
  function drawPairs(cat, pairs) {
    pairs = (pairs || []).filter(Boolean);
    if (!pairs.length) throw new Error(cat + ': no matches');
    let n = 1; while (n < pairs.length) n *= 2;
    const hasBye = n > pairs.length || pairs.some((p) => isBye(p.a) || isBye(p.b));
    const matches = []; let slots = [];
    for (let i = 0; i < n; i++) {
      const p = pairs[i] || {}, A = !isBye(p.a), B = !isBye(p.b);
      if (!A && !B) { slots.push(null); continue; }
      const m = { key: cat + ':1:' + i, cat, rd: hasBye ? 'R1' : bySize(2 * n), round: 1, a: A ? String(p.a).trim() : '', b: B ? String(p.b).trim() : '',
        phoneA: A ? p.phoneA || '' : '', phoneB: B ? p.phoneB || '' : '', pa: A ? '' : 'Bye', pb: B ? '' : 'Bye', bye: A && B ? '' : A ? 'a' : 'b' };
      matches.push(m); slots.push(m);
    }
    let round = 2;
    while (slots.length > 1) {
      const next = [];
      for (let i = 0; i < slots.length; i += 2) {
        const m = { key: cat + ':' + round + ':' + i, cat, rd: bySize(slots.length), round, a: '', b: '', pa: '', pb: '', xa: false, xb: false };
        [[slots[i], 'a'], [slots[i + 1], 'b']].forEach(([f, side]) => { if (f) { f.nxKey = m.key; f.ns = side; m['p' + side] = f; } else m['x' + side] = true; });
        matches.push(m); next.push(m);
      }
      slots = next; round++;
    }
    matches.forEach((m, i) => { m.no = i + 1; });
    matches.forEach((m) => { ['pa', 'pb'].forEach((k) => { if (m[k] && typeof m[k] === 'object') m[k] = 'Winner of #' + m[k].no; }); });
    const players = pairs.reduce((t, p) => t + (isBye(p.a) ? 0 : 1) + (isBye(p.b) ? 0 : 1), 0);
    return { cat, players, size: 2 * n, byes: matches.filter((m) => m.bye).length, rounds: round - 1, matches };
  }

  // Order of play for several categories at once, worked out by playing the day through:
  //  • categories start one after another (youngest first); the next one joins once the one before has
  //    `joinAfter` of its matches under way (by default: its first two rounds)
  //  • when a court frees up it goes to whichever started category has waited longest for a court,
  //    taking that category's next match whose players are known (or will be) and have had `rest` minutes off
  //  • so every category keeps moving, nobody plays back to back, and each final is played as soon as it can
  //    — the youngest category finishes first, the others follow, instead of four finals at the very end.
  function order(all, { courts = 4, matchMin = 20, restMin = 15, joinAfter = null, start = 0 } = {}) {
    const cats = [...new Set(all.map((m) => m.cat))];
    const byCat = {}; cats.forEach((c) => { byCat[c] = all.filter((m) => m.cat === c).sort((a, b) => a.round - b.round || a.no - b.no); });
    const join = cats.map((c, k) => {
      if (k === 0) return 0;
      if (joinAfter && joinAfter[cats[k - 1]] != null) return joinAfter[cats[k - 1]];
      const p = byCat[cats[k - 1]], r2 = Math.min(2, Math.max(...p.map((m) => m.round)));
      return p.filter((m) => m.round <= r2).length; // the previous category's first two rounds
    });
    const D = matchMin * 60000, REST = restMin * 60000;
    const feeders = {}; all.forEach((m) => { if (m.nxKey) (feeders[m.nxKey] = feeders[m.nxKey] || []).push(m.key); });
    const end = {}, free = Array.from({ length: courts }, () => start), out = [], playedBy = {}, lastServed = {};
    const started = (k) => k === 0 || (playedBy[cats[k - 1]] || 0) >= join[k] || started2(k - 1);
    const started2 = (k) => (playedBy[cats[k]] || 0) >= byCat[cats[k]].length; // the one before is finished → join anyway
    // kids entered in two categories (same name): never two matches at once. A later-round match counts as theirs
    // while they could still be in it (they're somewhere in the matches that feed it).
    const pn = (n) => String(n || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
    const catsOf = {}; all.forEach((m) => [m.a, m.b].forEach((n) => { if (n) (catsOf[pn(n)] = catsOf[pn(n)] || new Set()).add(m.cat); }));
    const dual = new Set(Object.keys(catsOf).filter((k) => catsOf[k].size > 1));
    const byKey = {}; all.forEach((m) => { byKey[m.key] = m; });
    const who = {}; // match key → double-entry kids who may play in it
    const whoOf = (m) => who[m.key] || (who[m.key] = [...new Set([m.a, m.b].map(pn).filter((k) => dual.has(k))
      .concat(...(feeders[m.key] || []).map((f) => whoOf(byKey[f]))))]);
    const busy = {};
    const readyAt = (m) => Math.max(start, ...(feeders[m.key] || []).map((f) => (end[f] == null ? Infinity : end[f] + REST)),
      ...whoOf(m).map((k) => (busy[k] == null ? start : busy[k] + REST)));
    let left = all.length, guard = 0;
    while (left && guard++ < 10000) {
      const k = free.indexOf(Math.min(...free)), T = free[k];
      let best = null;
      cats.forEach((c, ci) => {
        if (!started(ci)) return;
        const m = byCat[c].find((x) => !x.done); if (!m) return;
        const cand = byCat[c].filter((x) => !x.done).map((x) => ({ x, t: readyAt(x) })).find((o) => o.t <= T) || null;
        const soonest = cand || byCat[c].filter((x) => !x.done).map((x) => ({ x, t: readyAt(x) })).sort((a, b) => a.t - b.t)[0];
        if (!soonest || soonest.t === Infinity) return;
        const o = { c, ci, m: soonest.x, t: Math.max(T, soonest.t), waited: lastServed[c] == null ? -Infinity : lastServed[c] };
        if (!best || o.t < best.t || (o.t === best.t && (o.waited < best.waited || (o.waited === best.waited && o.ci < best.ci)))) best = o;
      });
      if (!best) break;
      const m = best.m;
      m.done = true; left--;
      end[m.key] = best.t + D; free[k] = best.t + D;
      whoOf(m).forEach((p) => { busy[p] = Math.max(busy[p] || 0, best.t + D); });
      playedBy[best.c] = (playedBy[best.c] || 0) + 1; lastServed[best.c] = best.t + (guard * 1e-6);
      out.push(Object.assign(m, { estStart: best.t, court: k }));
    }
    out.forEach((m) => { delete m.done; });
    return out;
  }

  // Short facts for the preview / the organiser.
  function summary(d) {
    const per = {};
    d.matches.forEach((m) => { per[m.rd] = (per[m.rd] || 0) + 1; });
    return { cat: d.cat, players: d.players, size: d.size, byes: d.byes, r1: per.R1 || per[d.matches[0] && d.matches[0].rd] || 0, matches: d.matches.length, perRound: per };
  }
  return { draw, drawPairs, isBye, order, summary, ROUND_NAME };
});
