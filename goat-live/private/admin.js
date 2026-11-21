// THE GOAT — Control Room. Compact rows; tap a match to act on it; drag the ⋮⋮ handle to reorder (works across both columns).
(() => {
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const boardList = $('#boardList'), queueList = $('#queueList'), sheet = $('#sheet');
  let S = null, prevIds = null, drag = null, openId = null, suppressClick = false, showAllQueue = false;

  const N = () => (S && S.boardSize) || 10;
  const find = (id) => S && S.matches.find((m) => m.id === id);
  const idx = (id) => S.matches.findIndex((m) => m.id === id);
  const courts = () => (S ? GoatShared.courtList(S.settings).length : 4);
  const fmtDur = (min) => (min >= 60 ? `${Math.floor(min / 60)}h ${min % 60}m` : `${min}m`);
  const played = (m) => (m.startedAt ? fmtDur(Math.max(0, Math.round((GoatLive.now() - m.startedAt) / 60000))) : '');
  const fmtLeft = (at) => { const s = Math.max(0, Math.ceil((at - GoatLive.now()) / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
  const side = (m, k) => (m[k] ? esc(m[k]) : `<em class="tbd">${esc(m['p' + k] || 'TBA')}</em>`);
  const vs = (m) => `${side(m, 'a')}<i>V</i>${side(m, 'b')}`;
  const RN = (window.GoatDraw && GoatDraw.ROUND_NAME) || {};
  const tag = (m) => (m.cat ? `<span class="tag">${esc(m.cat)} · ${esc(m.rd === 'R1' ? 'R1' : m.rd)} #${m.no}</span>` : '');
  const known = (m) => !!(m.a && m.b);
  function toEpoch(hm) { const [h, mi] = hm.split(':').map(Number); const d = new Date(GoatLive.now()); d.setHours(h, mi, 0, 0); return d.getTime(); }

  async function act(type, data = {}) {
    try {
      const r = await fetch('/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type, ...data }) });
      if (r.status === 401) { location.reload(); return null; }
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { toast(j.error || 'Something went wrong', { error: true }); return null; }
      if (j.state) GoatLive.push(j.state);
      refreshAdminData(400);
      return j;
    } catch { toast('Cannot reach the server', { error: true }); return null; }
  }
  // same rule as the server: Indian mobile (10 digits from 6–9, optional 0 / 91 / +91), another country only with + / 00
  function badPhone(v) {
    const s = String(v || '').trim(); if (!s) return false;
    const intl = /^(\+|00)/.test(s); let d = s.replace(/\D/g, '');
    if (intl) { if (s.startsWith('00')) d = d.slice(2); return !(d.length >= 10 && d.length <= 15); }
    if (d.length === 11 && d[0] === '0') d = d.slice(1);
    if (d.length === 12 && d.startsWith('91')) d = d.slice(2);
    return !/^[6-9]\d{9}$/.test(d);
  }
  function phonesOk(f) {
    for (const k of ['phoneA', 'phoneB']) if (badPhone(f[k].value)) { toast(`“${f[k].value}” doesn't look like a mobile number (10 digits, e.g. 98765 43210)`, { error: true, ms: 6000 }); f[k].focus(); return false; }
    return true;
  }
  function toast(msg, { error = false, action = null, ms = 4500, kind = '' } = {}) {
    const t = document.createElement('div');
    t.className = 'toast' + (error ? ' error' : '') + (kind ? ' ' + kind : '');
    t.innerHTML = `<span>${esc(msg)}</span>`;
    if (action) { const b = document.createElement('button'); b.textContent = action.label; b.onclick = () => { action.fn(); t.remove(); }; t.append(b); }
    $('#toasts').append(t);
    setTimeout(() => t.remove(), ms);
  }

  // badge text shown on every row: court + live / countdown / be ready / time
  function badge(m) {
    if (m.status === 'live') return `C${esc(m.court || '?')} · ${m.ending ? 'FINISHING' : 'LIVE'}`;
    if (m.status === 'called') return `C${esc(m.court)} · <span class="cd" data-at="${m.callAt}">${fmtLeft(m.callAt)}</span>`;
    if (m.ready) return `READY · C${esc(m.readyCourt || '?')}`;
    if (m.hold && m.status === 'queued') return known(m) ? 'not in top 10' : 'waiting';
    if (!m.time) return 'waiting';
    return `~${GoatLive.fmtTime(m.time)}${m.delay ? ` <small>+${m.delay}′</small>` : ''}`; // tentative
  }
  function rowHTML(m, i) {
    const cls = [m.status, m.status === 'live' && m.ending ? 'ending' : '', m.status === 'queued' && m.ready ? 'ready' : ''].join(' ');
    return `<li class="m ${cls}" data-id="${m.id}" data-i="${i}" tabindex="0"><span class="grip" aria-label="Drag to reorder">⋮⋮</span><span class="no">${i + 1}</span>
      <span class="who">${tag(m)}${vs(m)}</span><span class="b">${badge(m)}</span></li>`;
  }

  const active = (m) => m.status === 'live' || m.status === 'called';
  const onCourt = () => S.matches.filter(active).length;

  function render() {
    if (!S || drag) return;
    const inOrder = S.matches.filter((m) => !m.hold); // held matches wait in their category list (top bar)
    const n = N(), board = inOrder.slice(0, n).map((m, i) => [m, i]), queue = inOrder.slice(n);
    boardList.innerHTML = board.length ? board.map(([m, i]) => rowHTML(m, i)).join('') : '<li class="empty">No matches yet</li>';
    const QN = 10, shown = showAllQueue ? queue : queue.slice(0, QN); // next 10 fit on screen; the rest fold away
    queueList.innerHTML = queue.length
      ? shown.map((m, i) => rowHTML(m, i + n)).join('') + (queue.length > QN ? `<li class="more"><button type="button">${showAllQueue ? 'Show fewer' : `Show ${queue.length - QN} more`}</button></li>` : '')
      : '<li class="empty">Nothing waiting — add matches from a category above</li>';
    $('#boardCount').textContent = `${S.matches.filter((m) => m.status === 'live').length}/${courts()} courts live`;
    $('#queueCount').textContent = queue.length ? `${queue.length} waiting` : '';
    const result = (m) => (m.cat ? tag(m) : '') + (m.wo ? '<small class="wo">W/O</small> ' : '') + (m.winner ? `${m.winner === 'a' ? '<b class="won">🏆 ' + esc(m.a) + '</b>' : esc(m.a)}<i>V</i>${m.winner === 'b' ? '<b class="won">🏆 ' + esc(m.b) + '</b>' : esc(m.b)}` : vs(m));
    const doneReal = S.done.filter((m) => !m.bye);
    $('#doneList').innerHTML = doneReal.slice(0, 100).map((m) => `<li><span>${result(m)}</span><button type="button" data-restore="${m.id}">Restore</button></li>`).join('');
    $('#doneCount').textContent = doneReal.length;
    renderCats();
    $('#undoBtn').disabled = !S.canUndo;
    if (prevIds) document.querySelectorAll('.m').forEach((el) => { if (!prevIds.has(el.dataset.id)) el.classList.add('new'); });
    prevIds = new Set(S.matches.map((m) => m.id));
    if (sheet.open && !$('#sheetActs').contains(document.activeElement)) fillSheet(false);
  }

  // ── match sheet ──
  function openSheet(id) { openId = id; fillSheet(true); if (!sheet.open) sheet.showModal(); }
  function fillSheet(resetForm) {
    const m = find(openId);
    if (!m) { sheet.close(); return; }
    $('#sheetTitle').innerHTML = (m.cat ? `<small class="sheet-tag">${esc(m.cat)} · ${esc(RN[m.rd] || m.rd)} · Match #${m.no}</small>` : '') + vs(m);
    const pos = idx(m.id) + 1;
    const sub = m.status === 'live' ? `Court ${esc(m.court || '–')} · live for ${played(m) || '0m'}`
      : m.status === 'called' ? `Court ${esc(m.court)} · starts in <span class="cd" data-at="${m.callAt}">${fmtLeft(m.callAt)}</span>`
      : m.hold ? 'Not in the top 10 yet — add it when you want it played'
      : `${m.ready ? `Be ready for Court ${esc(m.readyCourt || '–')} · ` : ''}#${pos} in order · ${m.time ? 'around ' + GoatLive.fmtTime(m.time) + ' (tentative)' : 'waiting for the earlier round'}`;
    $('#sheetSub').innerHTML = sub;
    const courtSel = (cur, name = 'court') => {
      let o = cur ? '' : '<option value="">Next free court</option>';
      for (const c of GoatShared.courtList(S.settings)) o += `<option value="${esc(c)}" ${String(cur) === String(c) ? 'selected' : ''}>Court ${esc(c)}</option>`;
      return `<select data-field="${name}">${o}</select>`;
    };
    let h = '';
    if (m.status === 'live') {
      h = `<button type="button" class="big fin ${m.ending ? 'on' : ''}" data-act="ending">🔔 ${m.ending ? 'Finishing (tap to cancel)' : 'Finishing'}</button>
        <div class="win-label">End match — who won?</div>
        <div class="win-row"><button type="button" class="big end" data-act="win-a">🏆 ${esc(m.a || 'Player A')}</button>
          <button type="button" class="big end" data-act="win-b">🏆 ${esc(m.b || 'Player B')}</button></div>
        <button type="button" class="ghost small" data-act="end">End without a result</button>
        <div class="line"><label>Court</label>${courtSel(m.court)}</div>`;
    } else if (m.status === 'called') {
      const left = Math.max(0, Math.round((m.callAt - GoatLive.now()) / 60000));
      h = `<div class="line"><label>Start in</label><input type="number" inputmode="numeric" min="0" max="120" value="${left}" data-field="mins"><label>min</label>
          <button type="button" data-act="setmins">Set</button></div>
        <button type="button" class="big go" data-act="startnow">▶ Start now</button>
        <button type="button" class="big stop" data-act="stop">■ Stop countdown (back to waiting)</button>
        <div class="line"><label>Court</label>${courtSel(m.court)}</div>`;
    } else {
      const full = onCourt() >= courts();
      const why = !known(m) ? `Waiting for ${[m.a ? '' : m.pa, m.b ? '' : m.pb].filter(Boolean).join(' and ')} — or type the names below` : full ? `All ${courts()} courts busy` : '';
      const wo = (known(m) ? `<div class="win-label">Already played? Enter the winner</div><div class="win-row"><button type="button" class="big end" data-act="res-a">🏆 ${esc(m.a)}</button><button type="button" class="big end" data-act="res-b">🏆 ${esc(m.b)}</button></div>` : '') + (known(m) ? `<div class="win-label">Player didn't turn up? (walkover)</div><div class="win-row"><button type="button" class="wo-btn" data-act="wo-a">${esc(m.a)} goes through</button><button type="button" class="wo-btn" data-act="wo-b">${esc(m.b)} goes through</button></div>` : '');
      h = `<div class="line"><label>Delay by</label><input type="number" inputmode="numeric" min="0" max="180" value="${m.delay || 0}" data-field="delay"><label>min</label>
          <button type="button" data-act="setdelay">Set</button></div>
        <div class="line"><label>Court</label>${courtSel(m.readyCourt || '', 'startCourt')}</div>
        ${why ? `<p class="why">${why}</p>` : ''}
        <button type="button" class="big go" data-act="call" ${why ? 'disabled' : ''}>📣 Call to court (${(S.settings && S.settings.callMinutes) || 5} min countdown)</button>
        <button type="button" class="big start" data-act="start" ${why ? 'disabled' : ''}>● Start match now</button>
        ${m.hold ? '<button type="button" class="big top10" data-act="top10">＋ Add to the top 10 (order of play)</button>' : '<button type="button" class="ghost small" data-act="untop">↩ Take out of the top 10</button>'}${wo}`;
    }
    $('#sheetActs').innerHTML = h;
    $('#delBtn').textContent = m.nx ? 'Cancel match (nobody goes through)' : 'Delete match';
    $('#editForm').a.required = !m.pa; $('#editForm').b.required = !m.pb;
    $('#editForm').a.placeholder = m.pa || ''; $('#editForm').b.placeholder = m.pb || '';
    if (resetForm) { const f = $('#editForm'), c = contacts[m.id] || {}; f.a.value = m.a; f.b.value = m.b; f.phoneA.value = c.a || ''; f.phoneB.value = c.b || ''; }
  }
  $('#sheetActs').addEventListener('click', async (e) => {
    const b = e.target.closest('button[data-act]'); if (!b) return;
    const m = find(openId); if (!m) return;
    const a = b.dataset.act;
    if (a === 'ending') act('ending', { id: m.id, on: !m.ending });
    else if (a === 'end') { sheet.close(); endMatch(m); }
    else if (a === 'win-a' || a === 'win-b') { sheet.close(); endMatch(m, a.slice(4)); }
    else if (a === 'wo-a' || a === 'wo-b') {
      const w = a.slice(3), name = w === 'a' ? m.a : m.b;
      if (!confirm(`Walkover: ${name} goes through${m.nx ? ' to the next round' : ''} without playing?`)) return;
      sheet.close(); const r = await act('end', { id: m.id, winner: w, wo: true }); if (r) toast(`${name} goes through (walkover)`, { action: { label: 'Undo', fn: () => act('undo') }, ms: 8000 });
    }
    else if (a === 'stop') { await act('live', { id: m.id, live: false }); toast('Countdown stopped'); }
    else if (a === 'call') {
      const c = $('#sheetActs [data-field=startCourt]').value;
      const r = await act('call', c ? { id: m.id, court: c } : { id: m.id });
      if (r && r.called) { toast(`${m.a} v ${m.b} called to Court ${r.called.court}`); sheet.close(); }
    }
    else if (a === 'startnow') { await act('live', { id: m.id, live: true }); sheet.close(); }
    else if (a === 'start') {
      const c = $('#sheetActs [data-field=startCourt]').value;
      await act('live', c ? { id: m.id, live: true, court: c } : { id: m.id, live: true });
      sheet.close();
    } else if (a === 'top10') { if (await act('queue', { id: m.id, on: true })) { toast('Added to the top 10'); sheet.close(); } }
    else if (a === 'untop') { if (await act('queue', { id: m.id, on: false })) { toast('Taken out of the top 10 (back in its category)'); sheet.close(); } }
    else if (a === 'res-a' || a === 'res-b') {
      const w = a.slice(4), name = w === 'a' ? m.a : m.b;
      if (!confirm(`Result: ${name} won ${m.a} v ${m.b}?${m.nx ? '\n\n' + name + ' goes into the next round.' : ''}`)) return;
      sheet.close(); const r = await act('end', { id: m.id, winner: w }); if (r) toast(`${name} won`, { action: { label: 'Undo', fn: () => act('undo') }, ms: 8000 });
    } else if (a === 'setmins') setMins(m);
    else if (a === 'setdelay') setDelay(m);
  });
  function setDelay(m) {
    const v = Number($('#sheetActs [data-field=delay]').value);
    if (!Number.isFinite(v) || v < 0) return toast('Enter the minutes', { error: true });
    act('delay', { id: m.id, minutes: v }).then((ok) => ok && toast(v ? `Delayed by ${v} min` : 'Delay removed'));
  }
  function setMins(m) {
    const v = Number($('#sheetActs [data-field=mins]').value);
    if (!Number.isFinite(v) || v < 0) return toast('Enter the minutes', { error: true });
    act('extend', { id: m.id, set: v }).then((ok) => ok && toast(`Starts in ${v} min`));
  }
  $('#sheetActs').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    if (e.target.dataset.field === 'mins') { e.preventDefault(); setMins(find(openId)); }
    if (e.target.dataset.field === 'delay') { e.preventDefault(); setDelay(find(openId)); }
  });
  $('#sheetActs').addEventListener('change', (e) => {
    if (e.target.dataset.field === 'court') act('update', { id: openId, court: e.target.value });
  });
  $('#editForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const m = find(openId); if (!m) return;
    const f = e.target;
    if (!phonesOk(f)) return;
    if (await act('update', { id: m.id, a: f.a.value, b: f.b.value, phoneA: f.phoneA.value, phoneB: f.phoneB.value })) { toast('Saved'); sheet.close(); }
  });
  $('#delBtn').onclick = () => {
    const m = find(openId); if (!m) return;
    const txt = m.nx ? `Cancel ${m.a || m.pa} v ${m.b || m.pb}?\n\nNobody from this match goes through — the next-round opponent gets a walkover. (To send one player through, use the walkover buttons instead.)` : `Delete ${m.a} v ${m.b}?`;
    if (confirm(txt)) { act('remove', { id: m.id }); sheet.close(); }
  };
  sheet.querySelectorAll('[data-close]').forEach((b) => (b.onclick = () => sheet.close()));
  sheet.addEventListener('click', (e) => { if (e.target === sheet) sheet.close(); }); // tap outside closes

  async function endMatch(m, winner) {
    const r = await act('end', winner ? { id: m.id, winner } : { id: m.id });
    if (!r) return;
    const next = r.called ? ` · ${r.called.a} v ${r.called.b} → Court ${r.called.court}` : '';
    const won = winner ? `${winner === 'a' ? m.a : m.b} won` : `Ended ${m.a} v ${m.b}`;
    toast(`${won}${next}`, { action: { label: 'Undo', fn: () => act('undo') }, ms: 8000 });
  }

  // ── bulk add: Excel / CSV file, pasted cells, lines, or a paragraph → preview → add in order ──
  const bulkDlg = $('#bulkDlg');
  let bulkItems = [], bulkDraw = null;
  const fmtHM = (t) => new Date(t).toTimeString().slice(0, 5);
  function showDraw(cats) {
    bulkItems = []; bulkDraw = cats;
    const s = (S && S.settings) || {}, courtsN = (GoatShared.courtList(s) || []).length || 4;
    let html = '', all = [], err = '';
    try {
      const ds = cats.map((c) => GoatDraw.draw(c.cat, c.players));
      ds.forEach((d) => all.push(...d.matches));
      const start = (() => { const t = new Date(GoatLive.now()); if (t.getHours() < 9 || (t.getHours() === 9 && t.getMinutes() < 30)) { t.setHours(9, 30, 0, 0); } return Math.ceil(t.getTime() / 60000) * 60000; })();
      const ord = GoatDraw.order(all, { courts: courtsN, matchMin: s.matchMinutes || 20, restMin: s.restMinutes ?? 15, start });
      const span = {}; ord.forEach((m) => { const x = (span[m.cat] = span[m.cat] || { a: m.estStart, f: 0 }); x.a = Math.min(x.a, m.estStart); if (m.rd === 'F') x.f = m.estStart; });
      html += `<table class="draw-sum"><tr><th>Category</th><th>Players</th><th>Round 1</th><th>Straight to next round</th><th>Matches</th><th>Starts ~</th><th>Final ~</th></tr>` +
        ds.map((d) => { const r1 = d.matches.filter((m) => m.round === 1).length; return `<tr><td><b>${esc(d.cat)}</b></td><td>${d.players}</td><td>${r1} match${r1 === 1 ? '' : 'es'} (${r1 * 2} players)</td><td>${d.byes ? d.byes + (d.byes === 1 ? ' player' : ' players') : '–'}</td><td>${d.matches.length}</td><td>${fmtHM(span[d.cat].a)}</td><td>${fmtHM(span[d.cat].f)}</td></tr>`; }).join('') + '</table>';
      const last = ord.reduce((x, m) => (m.estStart > x.estStart ? m : x), ord[0]);
      html += `<p class="draw-note">${all.length} matches · ${courtsN} courts · ${s.matchMinutes || 20} min each · last match ~${fmtHM(last.estStart)}. Times are estimates (see ⚙ Courts &amp; timing).</p>`;
      html += ds.map((d) => `<details><summary>${esc(d.cat)} — Round 1 and byes</summary><ol class="draw-r1">` +
        d.matches.filter((m) => m.round === 1).map((m) => `<li>#${m.no} ${esc(m.a)} <i>V</i> ${esc(m.b)}</li>`).join('') +
        (d.byes ? `<li class="bye">Start in the next round (no Round 1 match): ${esc(d.matches.filter((m) => m.round === 2).flatMap((m) => [m.a, m.b]).filter(Boolean).join(', '))}</li>` : '') + '</ol></details>').join('');
    } catch (e) { err = e.message; }
    const b = $('#bulkAdd');
    b.disabled = !!err; b.textContent = err ? 'Add' : `Create the draw (${all.length} matches)`;
    $('#bulkPreview').innerHTML = err ? `<p class="bad">${esc(err)}</p>` : html;
  }
  const lev = (a, b) => { const d = Array.from({ length: a.length + 1 }, (_, i) => [i]); for (let j = 1; j <= b.length; j++) d[0][j] = j;
    for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); return d[a.length][b.length]; };
  const digits = (p) => String(p || '').replace(/\D/g, '').slice(-10);
  // Same kid spelt two ways / two kids with one name: the schedule keeps a kid off two courts only when the names match exactly.
  function kidWarnings(cats) {
    const all = []; const pn = GoatShared.pname;
    cats.forEach((c) => (c.pairs || []).forEach((p, i) => [['a', 'phoneA'], ['b', 'phoneB']].forEach(([k, ph]) => { if (!GoatDraw.isBye(p[k])) all.push({ cat: c.cat, name: p[k], k: pn(p[k]), ph: digits(p[ph]), row: i + 1 }); })));
    const out = [], seen = new Set();
    for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) {
      const x = all[i], y = all[j], key = [x.cat, x.name, y.cat, y.name].join('|'); if (seen.has(key)) continue;
      if (x.k === y.k && x.cat === y.cat) { seen.add(key); out.push(`<b>${esc(x.name)}</b> is in ${esc(x.cat)} twice (row ${x.row} and row ${y.row}) — same kid?`); }
      else if (x.k === y.k && x.ph && y.ph && x.ph !== y.ph) { seen.add(key); out.push(`<b>${esc(x.name)}</b> (${esc(x.cat)}) and <b>${esc(y.name)}</b> (${esc(y.cat)}) have different numbers — if they are different kids, add a surname, otherwise the schedule treats them as one kid.`); }
      else if (x.k !== y.k && x.ph && x.ph === y.ph && x.cat !== y.cat && lev(x.k, y.k) <= (Math.min(x.k.length, y.k.length) >= 7 ? 2 : 1)) { seen.add(key); out.push(`<b>${esc(x.name)}</b> (${esc(x.cat)}) and <b>${esc(y.name)}</b> (${esc(y.cat)}) share a number — same kid? Use one spelling so their matches never clash.`); }
    }
    return out;
  }
  function showPairs(cats) {
    bulkItems = []; bulkDraw = cats;
    let html = '', total = 0, err = '';
    try {
      const ds = cats.map((c) => GoatDraw.drawPairs(c.cat, c.pairs));
      const cs = (S && S.settings && S.settings.catStart) || {}, hm = (v) => (v == null ? '–' : Math.floor(v / 60) + ':' + String(v % 60).padStart(2, '0'));
      html += '<table class="draw-sum"><tr><th>Category</th><th>Players</th><th>First-round matches</th><th>Byes</th><th>Matches to play</th><th>Starts</th></tr>' + ds.map((d) => {
        const r1 = d.matches.filter((m) => m.round === 1 && !m.bye).length, play = d.matches.filter((m) => !m.bye).length; total += play;
        return `<tr><td><b>${esc(d.cat)}</b></td><td>${d.players}</td><td>${r1}</td><td>${d.byes || '–'}</td><td>${play}</td><td>${hm(cs[d.cat])}</td></tr>`; }).join('') + '</table>';
      html += `<p class="draw-note">${total} matches in all. Nothing goes on the board by itself: open a category (buttons at the top) and add matches to the top 10 when you want them played.</p>`;
      const warn = kidWarnings(cats);
      if (warn.length) html += `<div class="draw-warn"><b>Check these names:</b><ul>${warn.map((w) => '<li>' + w + '</li>').join('')}</ul></div>`;
      html += ds.map((d) => `<details><summary>${esc(d.cat)} — first round</summary><ol class="draw-r1">` + d.matches.filter((m) => m.round === 1).map((m) =>
        `<li>#${m.no} ${esc(m.a || 'Bye')} <i>V</i> ${esc(m.b || 'Bye')}${m.bye ? ' <small>→ ' + esc(m[m.bye]) + ' goes through</small>' : ''}</li>`).join('') + '</ol></details>').join('');
    } catch (e) { err = e.message; }
    const b = $('#bulkAdd');
    b.disabled = !!err; b.textContent = err ? 'Add' : `Create the draw (${total} matches)`;
    $('#bulkPreview').innerHTML = err ? `<p class="bad">${esc(err)}</p>` : html;
  }
  function showAny(r, note) { if (r && r.draw && r.draw.some((c) => c.pairs)) return showPairs(r.draw); if (r && r.draw) showDraw(r.draw); else showBulk((r && r.items) || [], note); }
  function showBulk(items, note) {
    bulkItems = items; bulkDraw = null;
    const b = $('#bulkAdd');
    b.disabled = !items.length;
    b.textContent = items.length ? `Add ${items.length} match${items.length > 1 ? 'es' : ''} to the queue` : 'Add';
    $('#bulkPreview').innerHTML = note ? `<p class="bad">${esc(note)}</p>`
      : items.length ? `<span>${items.length} found, in this order:</span><ol>${items.map((x) => `<li>${esc(x.a)}${x.phoneA ? '<span class="ph">📱' + esc(x.phoneA) + '</span>' : ''}<i>V</i>${esc(x.b)}${x.phoneB ? '<span class="ph">📱' + esc(x.phoneB) + '</span>' : ''}</li>`).join('')}</ol>`
      : '<span>Nothing recognised yet.</span>';
  }
  $('#bulkBtn').onclick = () => { $('#bulkText').value = ''; $('#bulkFile').value = ''; showBulk([]); bulkDlg.showModal(); };
  $('#bulkText').addEventListener('input', (e) => showAny(GoatBulk.parseAny(e.target.value)));
  $('#bulkFile').addEventListener('change', async (e) => {
    const f = e.target.files[0]; if (!f) return;
    try { showAny(await GoatBulk.readAny(f)); } catch (err) { showBulk([], err.message); }
  });
  $('#bulkAdd').onclick = async () => {
    if (bulkDraw) {
      const r = await act('draw', { cats: bulkDraw });
      if (r) { toast(`Draw created: ${r.drawn} matches${r.byes ? ` (+ ${r.byes} byes, already through)` : ''}`); bulkDlg.close(); }
      return;
    }
    if (!bulkItems.length) return;
    const r = await act('add', { items: bulkItems, where: 'end' });
    if (r) { toast(`Added ${bulkItems.length} matches to the queue`); bulkDlg.close(); }
  };
  bulkDlg.querySelectorAll('[data-close]').forEach((b) => (b.onclick = () => bulkDlg.close()));

  // tap a row or a court card → open the sheet
  for (const el of [boardList, queueList]) {
    el.addEventListener('click', (e) => {
      if (suppressClick) { suppressClick = false; return; } // that press was a drag, not a tap
      if (e.target.closest('.more')) { showAllQueue = !showAllQueue; render(); return; }
      const r = e.target.closest('[data-id]'); if (r) openSheet(r.dataset.id);
    });
  }
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.classList && e.target.classList.contains('m')) openSheet(e.target.dataset.id);
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !e.target.matches('input')) { e.preventDefault(); act('undo'); }
  });

  // ── drag to reorder by holding any match row ──
  // mouse: press and move · finger: hold ~0.3 s, then move (a quick swipe still scrolls, a quick tap still opens)
  const clearMarks = () => document.querySelectorAll('.drop-before, .drop-after, .drop-end').forEach((x) => x.classList.remove('drop-before', 'drop-after', 'drop-end'));
  let press = null;
  document.addEventListener('pointerdown', (e) => {
    const li = e.target.closest('.list .m'); if (!li || e.button > 0) return;
    const touch = e.pointerType !== 'mouse', viaGrip = !!e.target.closest('.grip');
    press = { li, id: li.dataset.id, x0: e.clientX, y0: e.clientY, touch };
    if (viaGrip) { e.preventDefault(); startDrag(); }
    else if (touch) press.timer = setTimeout(startDrag, 300);
  });
  function startDrag() {
    if (!press) return;
    const p = press; press = null;
    drag = { li: p.li, id: p.id, x0: p.x0, y0: p.y0, target: null, touch: p.touch };
    p.li.classList.add('dragging');
    if (navigator.vibrate) navigator.vibrate(12);
  }
  document.addEventListener('pointermove', (e) => {
    if (press) {
      const dist = Math.hypot(e.clientX - press.x0, e.clientY - press.y0);
      if (press.touch) { if (dist > 8) { clearTimeout(press.timer); press = null; } } // finger moved early → it's a scroll
      else if (dist > 5) startDrag();
    }
    if (drag && !drag.touch) onDragMove(e.clientX, e.clientY);
  });
  document.addEventListener('touchmove', (e) => { // touch drags follow touch events so the page can't steal them to scroll
    if (!drag) return;
    e.preventDefault();
    onDragMove(e.touches[0].clientX, e.touches[0].clientY);
  }, { passive: false });
  const finish = (e) => {
    if (press) { clearTimeout(press.timer); press = null; return; }
    if (drag && !(e.type === 'pointercancel' && drag.touch)) onDragEnd();
  };
  document.addEventListener('pointerup', finish);
  document.addEventListener('pointercancel', finish);
  document.addEventListener('touchend', () => { if (drag && drag.touch) onDragEnd(); });
  document.addEventListener('contextmenu', (e) => { if (drag || e.target.closest('.list .m')) e.preventDefault(); });

  function onDragMove(clientX, clientY) {
    const d = drag; if (!d) return;
    const e = { clientX, clientY }, dx = clientX - d.x0, dy = clientY - d.y0;
    d.moved = true;
    d.li.style.transform = `translate(${dx}px, ${dy}px)`;
    clearMarks();
    // which column is the finger/mouse over? then snap to the nearest row in it (gaps between rows count too)
    const lst = [boardList, queueList].find((l) => { const r = l.getBoundingClientRect(); return e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top - 30 && e.clientY <= r.bottom + 40; });
    const rows = lst ? [...lst.querySelectorAll('.m:not(.dragging)')] : [];
    if (rows.length) {
      let row = rows.find((x) => { const r = x.getBoundingClientRect(); return e.clientY < r.top + r.height / 2; });
      const before = !!row;
      if (!row) row = rows[rows.length - 1];
      row.classList.add(before ? 'drop-before' : 'drop-after');
      d.target = +row.dataset.i + (before ? 0 : 1);
    } else if (lst) {
      lst.classList.add('drop-end');
      const len = S.matches.filter((m) => !m.hold).length;
      d.target = lst === boardList ? Math.min(N(), len) : len;
    } else d.target = null;
    if (e.clientY < 60) scrollBy(0, -12); else if (e.clientY > innerHeight - 60) scrollBy(0, 12);
  }
  function onDragEnd() {
    const d = drag; drag = null;
    if (!d) return;
    suppressClick = true; setTimeout(() => { suppressClick = false; }, 80);
    d.li.classList.remove('dragging'); d.li.style.transform = '';
    clearMarks();
    if (d.moved && d.target != null) {
      const from = idx(d.id);
      let to = d.target; if (from < to) to--;
      if (to !== from) act('move', { id: d.id, to });
    }
    render();
  }

  // ── add ──
  $('#addForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    if (!phonesOk(f)) return;
    if (await act('add', { a: f.a.value, b: f.b.value, phoneA: f.phoneA.value, phoneB: f.phoneB.value })) {
      f.a.value = ''; f.b.value = ''; f.phoneA.value = ''; f.phoneB.value = ''; f.a.focus();
    }
  });
  $('#doneList').addEventListener('click', (e) => { const r = e.target.closest('[data-restore]'); if (r) act('restore', { id: r.dataset.restore }); });

  function fillSettings() {
    if (!S) return;
    const s = S.settings || {}, f = $('#setForm'), list = GoatShared.courtList(s);
    $('#setSum').textContent = `Courts ${list.join(', ')} · ${s.matchMinutes || 20} min · rest ${s.restMinutes ?? 15} min${s.autoFill ? ' · AUTO top 10' : ''}`;
    if (f.contains(document.activeElement)) return;
    f.courtNames.value = list.join(', '); f.matchMinutes.value = s.matchMinutes || 20; f.restMinutes.value = s.restMinutes ?? 15; f.callMinutes.value = s.callMinutes ?? 5; f.catStart.value = GoatShared.fmtCatStart(s.catStart); f.autoFill.checked = !!s.autoFill;
  }
  $('#setForm').addEventListener('submit', async (e) => {
    e.preventDefault(); const f = e.target;
    const names = f.courtNames.value.split(/[,\s]+/).filter(Boolean);
    if (!names.length) return toast('Enter the court numbers, e.g. 1, 2, 3, 5', { error: true });
    if (await act('settings', { settings: { courtNames: names.join(', '), matchMinutes: +f.matchMinutes.value, restMinutes: +f.restMinutes.value, callMinutes: +f.callMinutes.value, catStart: f.catStart.value, autoFill: f.autoFill.checked } })) { toast('Saved'); f.querySelector('button').blur(); }
  });
  $('#undoBtn').onclick = () => act('undo');
  $('#logoutBtn').onclick = async () => { await fetch('/api/logout', { method: 'POST' }); location.href = '/admin'; };

  // ── categories: a button per category → all its matches by round; "+ Top 10" puts one into the order of play ──
  const catDlg = $('#catDlg'); let openCat = null; const RORD = ['R1', 'R128', 'R64', 'R32', 'R16', 'QF', 'SF', 'F'];
  const hm = (v) => (v == null ? '' : Math.floor(v / 60) + ':' + String(v % 60).padStart(2, '0'));
  function catList() {
    const cs = (S.settings && S.settings.catStart) || {}, set = new Set();
    S.matches.concat(S.done).forEach((m) => m.cat && set.add(m.cat));
    return [...set].sort((a, b) => (cs[a] ?? 1e9) - (cs[b] ?? 1e9) || (a < b ? -1 : 1));
  }
  function renderCats() {
    const cats = catList(), cs = (S.settings && S.settings.catStart) || {}, bar = $('#catBar');
    bar.hidden = !cats.length;
    bar.innerHTML = cats.map((c) => {
      const left = S.matches.filter((m) => m.cat === c).length, live = S.matches.filter((m) => m.cat === c && active(m)).length;
      const ready = S.matches.filter((m) => m.cat === c && m.hold && m.status === 'queued' && known(m)).length;
      return `<button type="button" data-cat="${esc(c)}" class="${openCat === c ? 'on' : ''}"><b>${esc(c)}</b><small>${cs[c] != null ? hm(cs[c]) + ' · ' : ''}${left ? left + ' to play' : 'done ✓'}${live ? ' · ' + live + ' on court' : ''}${ready ? ' · ' + ready + ' ready' : ''}</small></button>`;
    }).join('');
    if (catDlg.open) renderCatDlg();
  }
  $('#catBar').addEventListener('click', (e) => { const b = e.target.closest('[data-cat]'); if (!b) return; openCat = b.dataset.cat; $('#catFind').value = ''; renderCatDlg(); if (!catDlg.open) catDlg.showModal(); renderCats(); });
  // one match card in the bracket: #no · status, both players (winner in gold), one-tap "+ Top 10"
  function card(m, done) {
    const ord = S.matches.filter((x) => !x.hold);
    let chip = '', cls = '', foot = '';
    if (done) { cls = m.bye ? 'done bye' : 'done';
      chip = m.bye ? 'BYE' : m.winner ? (m.wo ? 'W/O' : 'DONE ✓') : 'NO RESULT';
    } else if (m.status === 'live') { cls = 'live'; chip = `LIVE · C${esc(m.court)}`; }
    else if (m.status === 'called') { cls = 'live'; chip = `C${esc(m.court)} · <span class="cd" data-at="${m.callAt}">${fmtLeft(m.callAt)}</span>`; }
    else if (!m.hold) { cls = 'in'; chip = `TOP 10 · #${ord.indexOf(m) + 1}`; foot = `<button type="button" class="mini" data-q="off" data-id="${m.id}">− Take out</button>`; }
    else if (known(m)) { cls = 'ready'; foot = `<button type="button" class="mini add" data-q="on" data-id="${m.id}">＋ Top 10</button>`; }
    else chip = 'WAITING';
    const p = (k) => {
      const won = done && m.winner === k, lost = done && m.winner && m.winner !== k;
      return `<div class="bp ${won ? 'w' : ''} ${lost ? 'l' : ''}">${won ? '🏆 ' : ''}${m[k] ? esc(m[k]) : `<em class="tbd">${esc(m['p' + k] || (m['x' + k] ? 'nobody' : 'TBA'))}</em>`}</div>`;
    };
    return `<div class="bm ${cls}" data-id="${done ? '' : m.id}" data-find="${esc(GoatShared.pname((m.a || '') + ' ' + (m.b || '')))}" tabindex="0">
      <div class="bh"><span>#${m.no}</span>${chip ? `<span class="chip">${chip}</span>` : ''}</div>${p('a')}${p('b')}${foot ? `<div class="bf">${foot}</div>` : ''}</div>`;
  }
  // The category as a real bracket: one column per round, match 1 above match 2, winners flow to the right.
  function renderCatDlg() {
    const c = openCat; if (!c) return;
    const cs = (S.settings && S.settings.catStart) || {};
    const ms = S.matches.filter((m) => m.cat === c).map((m) => [m, false]).concat(S.done.filter((m) => m.cat === c).map((m) => [m, true]));
    if (!ms.length) { catDlg.close(); return; }
    $('#catTitle').textContent = c + (cs[c] != null ? ' · starts ' + hm(cs[c]) : '');
    const left = ms.filter(([, d]) => !d).length, inTop = ms.filter(([m, d]) => !d && !m.hold).length;
    $('#catSub').textContent = `${left} matches to play · ${inTop} in the top 10 · tap a match: start it, enter the winner, walkover, change names or numbers`;
    const body = $('#catBody'), sx = body.scrollLeft, sy = body.scrollTop;
    const rds = [...new Set(ms.map(([m]) => m.rd))].sort((a, b) => RORD.indexOf(a) - RORD.indexOf(b));
    body.innerHTML = `<div class="bracket">${rds.map((rd) => {
      const list = ms.filter(([m]) => m.rd === rd).sort((x, y) => x[0].no - y[0].no);
      const todo = list.filter(([, d]) => !d).length;
      return `<section class="rcol"><h4>${esc(RN[rd] || rd)}<small>${todo ? todo + ' to play' : 'done ✓'}</small></h4><div class="rlist">${list.map(([m, d]) => card(m, d)).join('')}</div></section>`;
    }).join('')}</div>`;
    body.scrollLeft = sx; body.scrollTop = sy;
    applyFind();
  }
  function applyFind() {
    const q = GoatShared.pname($('#catFind').value);
    catDlg.querySelectorAll('.bm').forEach((el) => el.classList.toggle('hit', !!q && el.dataset.find.includes(q)));
    catDlg.querySelector('.bracket') && catDlg.querySelector('.bracket').classList.toggle('finding', !!q);
    const first = q && catDlg.querySelector('.bm.hit'); if (first) first.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' });
  }
  $('#catFind').addEventListener('input', applyFind);
  $('#catBody').addEventListener('click', async (e) => {
    const q = e.target.closest('[data-q]');
    if (q) { e.stopPropagation(); q.disabled = true; const r = await act('queue', { id: q.dataset.id, on: q.dataset.q === 'on' }); if (r) toast(q.dataset.q === 'on' ? 'Added to the top 10' : 'Taken out of the top 10'); return; }
    const el = e.target.closest('.bm[data-id]'); if (el && el.dataset.id) openSheet(el.dataset.id);
  });
  $('#catBody').addEventListener('keydown', (e) => { if (e.key === 'Enter') { const el = e.target.closest('.bm[data-id]'); if (el && el.dataset.id) openSheet(el.dataset.id); } });
  $('#catFill').onclick = async () => { const r = await act('fill', { cat: openCat }); if (r) toast(r.added ? `${r.added} ${openCat} match${r.added > 1 ? 'es' : ''} added to the top 10` : `No more ${openCat} matches ready (players not known yet), or the top 10 is full`); };
  $('#catDel').onclick = () => { if (confirm(`Delete the whole ${openCat} draw (all its matches and results)?\n\nOnly do this to import it again. You can Undo right after.`)) act('removeCat', { cat: openCat }).then((r) => { if (r) { toast(`${openCat} draw deleted`, { action: { label: 'Undo', fn: () => act('undo') }, ms: 9000 }); catDlg.close(); } }); };
  catDlg.querySelectorAll('[data-close]').forEach((b) => (b.onclick = () => catDlg.close()));
  catDlg.addEventListener('close', () => { openCat = null; renderCats(); });

  // ── players without a WhatsApp number (byes ignored) ──
  function renderNoPhone() {
    if (!S || $('#noPhoneBox').contains(document.activeElement)) return;
    const rows = [], more = [];
    S.matches.forEach((m) => ['a', 'b'].forEach((k) => {
      if (!m[k]) return;
      const c = contacts[m.id] || {}; if (String(c[k] || '').trim() && !badPhone(c[k])) return;
      const why = String(c[k] || '').trim() ? `“${esc(c[k])}” is not a valid number` : 'no number';
      const li = `<li><div><b>${esc(m[k])}</b> · ${m.cat ? esc(m.cat) + ' ' + esc(RN[m.rd] || m.rd) + ' #' + m.no : esc(m.a) + ' v ' + esc(m.b)} <small>${why}</small></div>
        <form class="np" data-id="${m.id}" data-side="${k}"><input type="tel" maxlength="20" placeholder="Add WhatsApp no."><button type="submit">Save</button></form></li>`;
      (m.hold && m.status === 'queued' ? more : rows).push(li);
    }));
    $('#noPhoneBox').hidden = !rows.length && !more.length;
    $('#noPhoneCount').textContent = rows.length || '';
    $('#noPhoneList').innerHTML = rows.join('') || '<li class="ok">Everyone in the top 10 has a number ✓</li>';
    $('#noPhoneMoreBox').hidden = !more.length; $('#noPhoneMoreCount').textContent = more.length; $('#noPhoneMore').innerHTML = more.join('');
  }
  $('#noPhoneBox').addEventListener('submit', async (e) => {
    e.preventDefault(); const f = e.target.closest('form.np'); if (!f) return;
    const v = f.querySelector('input').value, id = f.dataset.id, k = f.dataset.side;
    if (!v.trim() || badPhone(v)) return toast('Enter a 10-digit mobile number, e.g. 98765 43210', { error: true });
    const c = Object.assign({ a: '', b: '' }, contacts[id] || {}); c[k] = v.trim();
    f.querySelector('input').blur();
    if (await act('update', { id, phoneA: c.a, phoneB: c.b })) { contacts[id] = c; toast('Number saved — WhatsApp will go to them'); renderNoPhone(); }
  });

  // ── WhatsApp: phone numbers + message log (admin only) ──
  let contacts = {}, wa = { provider: 'none', ready: false }, waLog = [], waFailed = [], waPending = 0, waHook = { url: '', last: null }, adminT = null;
  function refreshAdminData(delay = 0) {
    clearTimeout(adminT);
    adminT = setTimeout(async () => {
      try {
        const r = await fetch('/api/admin-data', { cache: 'no-store' });
        if (!r.ok) return;
        const j = await r.json();
        contacts = j.contacts || {}; wa = j.whatsapp || wa; waLog = j.log || []; waFailed = j.failed || []; waPending = j.pending || 0; waHook = { url: j.webhookUrl || '', last: j.lastReport || null, info: j.hook || null, ok: j.hookOk || null };
        renderWA(); renderNoPhone();
      } catch {}
    }, delay);
  }
  function renderWA() {
    if (!S) return;
    const on = !!(S.settings && S.settings.notify);
    $('#waBadge').textContent = (on ? (wa.ready ? 'ON' : 'ON · test mode') : 'OFF') + (waPending ? ` · ${waPending} sending/retrying` : '');
    // delivery-report address for Gupshup (online only)
    $('#waHook').hidden = !waHook.url;
    if (waHook.url) {
      $('#waHookUrl').textContent = waHook.url;
      const mins = waHook.last ? Math.round((Date.now() - waHook.last) / 60000) : null;
      const h = waHook.info || {}, ago = mins < 1 ? 'just now' : mins + ' min ago';
      const working = !!waHook.ok; // at least one report has been matched to a message we sent
      $('#waHookState').innerHTML = working ? '<span class="on">✓ working — you get a pop-up for every delivered or failed message</span>'
        : !waHook.last ? '<span class="off">not connected yet</span>'
        : !h.reports ? `<span class="off">a report arrived ${ago} but could not be read</span>`
        : `<span class="off">reports arriving (${ago}) but not matched to a message yet — send a test</span>`;
      $('#waHookSetup').hidden = working;
      $('#waHookRaw').hidden = !waHook.info || working;
      if (waHook.info) { let s = h.sample || ''; try { s = JSON.stringify(JSON.parse(s), null, 1); } catch {} $('#waHookSample').textContent = (h.method || 'POST') + '  ' + s; }
    }
    // players we couldn't reach after 10 tries → call them
    const kindName = { soon: 'Coming up', next: "You're next", later: 'Moved later' };
    $('#failBox').hidden = !waFailed.length;
    $('#failCount').textContent = waFailed.length;
    $('#failList').innerHTML = waFailed.map((d) => `<li><div class="who"><b>${esc(d.name)}</b> · ${esc(d.match)}</div>
      <a class="tel" href="tel:${esc(d.to)}">📞 ${esc(d.to)}</a>
      <div class="why">“${esc(kindName[d.kind] || d.kind)}” not delivered after ${d.attempts} tries — ${esc(d.lastError || 'unknown error')}</div>
      <div class="btns"><button type="button" data-fail="retry" data-id="${esc(d.id)}">Try again</button><button type="button" class="ok" data-fail="done" data-id="${esc(d.id)}">Called ✓</button></div></li>`).join('');
    $('#waMode').textContent = wa.ready ? `Sending through ${wa.provider === 'meta' ? 'Meta' : wa.provider === 'gupshup-enterprise' ? 'Gupshup (Enterprise)' : 'Gupshup'}` : 'Test mode — missing in Vercel: ' + ((wa.missing || []).join(', ') || 'settings') + ' (then Redeploy)';
    const t = $('#waToggle'); t.textContent = on ? 'Messages ON' : 'Messages OFF'; t.className = on ? 'on' : '';
    const kind = { soon: 'Coming up', next: "You're next", later: 'Moved later' };
    $('#waLog').innerHTML = waLog.length ? waLog.map((e) => {
      const label = e.status === 'sent' ? (e.delivery === 'read' ? '✓✓ read' : e.delivery === 'delivered' ? '✓ delivered' : waHook.last ? 'accepted · waiting for delivery' : 'sent')
        : e.status === 'pending' ? `retrying (${e.attempts || 0}/10)${e.lastError ? ' — ' + e.lastError : ''}` : e.status === 'failed' ? `failed after ${e.attempts} tries — call them` : e.status;
      const cls = /^sent/.test(e.status) ? 'ok' : /^test|^pending|^skipped/.test(e.status) ? 'test' : 'bad';
      const at = e.sentAt || e.lastAttemptAt || e.createdAt || e.at;
      return `<li><span class="st ${cls}">${esc(label)}</span><b>${esc(kind[e.kind] || e.kind)}</b> → ${esc(e.name)} ${esc(e.to || '')} · ${new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}<p>${esc(e.text)}</p></li>`;
    }).join('') : '<li>No messages yet.</li>';
  }
  $('#waToggle').onclick = () => act('settings', { settings: { notify: !(S.settings && S.settings.notify) } });
  $('#waTest').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target, out = $('#waTestResult');
    out.className = 'wa-test-result'; out.textContent = 'Sending…';
    try {
      const r = await (await fetch('/api/wa-test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone: f.phone.value, kind: f.kind.value }) })).json();
      out.className = 'wa-test-result ' + (r.ok ? 'ok' : 'bad');
      out.textContent = r.ok ? `Sent to ${r.to} ✓ — check WhatsApp. (Gupshup id ${r.id || '-'})` : `Not sent: ${r.error}`;
    } catch { out.className = 'wa-test-result bad'; out.textContent = 'Could not reach the server'; }
  });
  $('#waHookCopy').onclick = async () => {
    try { await navigator.clipboard.writeText(waHook.url); } catch { const t = document.createElement('textarea'); t.value = waHook.url; document.body.append(t); t.select(); document.execCommand('copy'); t.remove(); }
    $('#waHookCopy').textContent = 'Copied ✓'; setTimeout(() => ($('#waHookCopy').textContent = 'Copy'), 1500);
  };
  $('#failList').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-fail]'); if (!b) return;
    b.disabled = true;
    try {
      await fetch('/api/wa-retry', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: b.dataset.id, action: b.dataset.fail }) });
      toast(b.dataset.fail === 'done' ? 'Marked as called' : 'Trying again…');
    } catch { toast('Cannot reach the server', { error: true }); }
    refreshAdminData();
  });
  refreshAdminData();

  // ── pop-ups: delivered / not delivered / call them (checked every 4 s) + reload after an update ──
  let popSince = Date.now(), appVer = null;
  const kindLabel = { soon: 'Coming up', next: "You're next", later: 'Moved later' };
  async function checkPops() {
    try {
      const r = await fetch('/api/wa-events?since=' + popSince, { cache: 'no-store' });
      if (r.status === 401) return;
      const j = await r.json();
      if (j.ver) {
        if (appVer === null) appVer = j.ver;
        else if (j.ver !== appVer && !sheet.open && !document.querySelector('dialog[open]')) { toast('Control Room updated — reloading…'); setTimeout(() => location.reload(), 1200); return; }
      }
      const ev = j.events || [];
      if (!ev.length) return;
      popSince = Math.max(popSince, ...ev.map((e) => e.at));
      const who = (e) => e.name || e.to;
      const group = (list, icon, word, kind) => {
        if (!list.length) return;
        const names = list.map(who);
        const label = list.length === 1 ? ` (${kindLabel[list[0].kind] || ''})` : '';
        toast(`${icon} ${word} ${names.slice(0, 3).join(', ')}${names.length > 3 ? ' +' + (names.length - 3) + ' more' : ''}${label}`, { kind, ms: 5000 });
      };
      group(ev.filter((e) => e.status === 'sent'), '✓', 'Sent to', 'good');
      group(ev.filter((e) => e.status === 'delivered'), '✓', 'Delivered to', 'good');
      ev.filter((e) => e.status === 'retry').forEach((e) => toast(`⚠ Not delivered to ${who(e)} (${kindLabel[e.kind] || ''}) — trying again automatically`, { error: true, ms: 7000 }));
      ev.filter((e) => e.status === 'call').forEach((e) => toast(`📞 Couldn't reach ${who(e)} ${e.to} — please call them`, { kind: 'call', ms: 15000 }));
      refreshAdminData(300);
    } catch {}
  }
  setInterval(checkPops, 4000);

  // Keep WhatsApp deliveries moving: sends due messages and retries failed ones (online there is no background timer,
  // so the open Control Room does this every 20 s). Also refreshes the panel.
  setInterval(async () => {
    if (S && S.settings && S.settings.notify) {
      try { await fetch('/api/wa-retry', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); } catch {}
    }
    refreshAdminData();
  }, 20000);

  GoatLive.connect((s) => { S = s; render(); renderWA(); fillSettings(); renderNoPhone(); }, (ok) => { $('#conn').className = 'conn ' + (ok ? 'ok' : 'bad'); });
  setInterval(() => document.querySelectorAll('.cd[data-at]').forEach((el) => { el.textContent = fmtLeft(+el.dataset.at); }), 500);
  setInterval(() => { if (!sheet.open) render(); }, 30000);
})();
