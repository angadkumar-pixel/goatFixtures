// THE GOAT — Control Room. Compact rows; tap a match to act on it; drag the ⋮⋮ handle to reorder (works across both columns).
(() => {
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const boardList = $('#boardList'), queueList = $('#queueList'), sheet = $('#sheet');
  let S = null, prevIds = null, drag = null, openId = null, suppressClick = false, showAllQueue = false;

  const N = () => (S && S.boardSize) || 10;
  const find = (id) => S && S.matches.find((m) => m.id === id);
  const idx = (id) => S.matches.findIndex((m) => m.id === id);
  const courts = () => (S && S.settings && S.settings.courts) || 4;
  const fmtDur = (min) => (min >= 60 ? `${Math.floor(min / 60)}h ${min % 60}m` : `${min}m`);
  const played = (m) => (m.startedAt ? fmtDur(Math.max(0, Math.round((GoatLive.now() - m.startedAt) / 60000))) : '');
  const fmtLeft = (at) => { const s = Math.max(0, Math.ceil((at - GoatLive.now()) / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
  const vs = (m) => `${esc(m.a || 'TBA')}<i>V</i>${esc(m.b || 'TBA')}`;
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
  function toast(msg, { error = false, action = null, ms = 4500 } = {}) {
    const t = document.createElement('div');
    t.className = 'toast' + (error ? ' error' : '');
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
    return `~${GoatLive.fmtTime(m.time)}${m.delay ? ` <small>+${m.delay}′</small>` : ''}`; // tentative
  }
  function rowHTML(m, i) {
    const cls = [m.status, m.status === 'live' && m.ending ? 'ending' : '', m.status === 'queued' && m.ready ? 'ready' : ''].join(' ');
    return `<li class="m ${cls}" data-id="${m.id}" data-i="${i}" tabindex="0"><span class="grip" aria-label="Drag to reorder">⋮⋮</span><span class="no">${i + 1}</span>
      <span class="who">${vs(m)}</span><span class="b">${badge(m)}</span></li>`;
  }

  const active = (m) => m.status === 'live' || m.status === 'called';
  const onCourt = () => S.matches.filter(active).length;

  function render() {
    if (!S || drag) return;
    const n = N(), board = S.matches.slice(0, n).map((m, i) => [m, i]), queue = S.matches.slice(n);
    boardList.innerHTML = board.length ? board.map(([m, i]) => rowHTML(m, i)).join('') : '<li class="empty">No matches yet</li>';
    const QN = 10, shown = showAllQueue ? queue : queue.slice(0, QN); // next 10 fit on screen; the rest fold away
    queueList.innerHTML = queue.length
      ? shown.map((m, i) => rowHTML(m, i + n)).join('') + (queue.length > QN ? `<li class="more"><button type="button">${showAllQueue ? 'Show fewer' : `Show ${queue.length - QN} more`}</button></li>` : '')
      : '<li class="empty">Queue empty — add below</li>';
    $('#boardCount').textContent = `${S.matches.filter((m) => m.status === 'live').length}/${courts()} courts live`;
    $('#queueCount').textContent = queue.length ? `${queue.length} waiting` : '';
    const result = (m) => m.winner ? `${m.winner === 'a' ? '<b class="won">🏆 ' + esc(m.a) + '</b>' : esc(m.a)}<i>V</i>${m.winner === 'b' ? '<b class="won">🏆 ' + esc(m.b) + '</b>' : esc(m.b)}` : vs(m);
    $('#doneList').innerHTML = S.done.slice(0, 100).map((m) => `<li><span>${result(m)}</span><button type="button" data-restore="${m.id}">Restore</button></li>`).join('');
    $('#doneCount').textContent = S.done.length;
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
    $('#sheetTitle').innerHTML = vs(m);
    const pos = idx(m.id) + 1;
    const sub = m.status === 'live' ? `Court ${esc(m.court || '–')} · live for ${played(m) || '0m'}`
      : m.status === 'called' ? `Court ${esc(m.court)} · starts in <span class="cd" data-at="${m.callAt}">${fmtLeft(m.callAt)}</span>`
      : `${m.ready ? `Be ready for Court ${esc(m.readyCourt || '–')} · ` : ''}#${pos} in order · around ${GoatLive.fmtTime(m.time)} (tentative)`;
    $('#sheetSub').innerHTML = sub;
    const courtSel = (cur, name = 'court') => {
      let o = cur ? '' : '<option value="">Next free court</option>';
      for (let c = 1; c <= courts(); c++) o += `<option value="${c}" ${String(cur) === String(c) ? 'selected' : ''}>Court ${c}</option>`;
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
      const full = onCourt() >= courts(), offBoard = idx(m.id) >= N();
      const why = offBoard ? 'Drag it onto the board to start it' : full ? `All ${courts()} courts busy` : '';
      h = `<div class="line"><label>Delay by</label><input type="number" inputmode="numeric" min="0" max="180" value="${m.delay || 0}" data-field="delay"><label>min</label>
          <button type="button" data-act="setdelay">Set</button></div>
        <div class="line"><label>Court</label>${courtSel(m.readyCourt || '', 'startCourt')}</div>
        ${why ? `<p class="why">${why}</p>` : ''}
        <button type="button" class="big go" data-act="call" ${why ? 'disabled' : ''}>📣 Call to court (${(S.settings && S.settings.callMinutes) || 5} min countdown)</button>
        <button type="button" class="big start" data-act="start" ${why ? 'disabled' : ''}>● Start match now</button>`;
    }
    $('#sheetActs').innerHTML = h;
    if (resetForm) { const f = $('#editForm'), c = contacts[m.id] || {}; f.a.value = m.a; f.b.value = m.b; f.phoneA.value = c.a || ''; f.phoneB.value = c.b || ''; }
  }
  $('#sheetActs').addEventListener('click', async (e) => {
    const b = e.target.closest('button[data-act]'); if (!b) return;
    const m = find(openId); if (!m) return;
    const a = b.dataset.act;
    if (a === 'ending') act('ending', { id: m.id, on: !m.ending });
    else if (a === 'end') { sheet.close(); endMatch(m); }
    else if (a === 'win-a' || a === 'win-b') { sheet.close(); endMatch(m, a.slice(4)); }
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
    if (await act('update', { id: m.id, a: f.a.value, b: f.b.value, phoneA: f.phoneA.value, phoneB: f.phoneB.value })) { toast('Saved'); sheet.close(); }
  });
  $('#delBtn').onclick = () => {
    const m = find(openId); if (!m) return;
    if (confirm(`Delete ${m.a} v ${m.b}?`)) { act('remove', { id: m.id }); sheet.close(); }
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
  let bulkItems = [];
  function showBulk(items, note) {
    bulkItems = items;
    const b = $('#bulkAdd');
    b.disabled = !items.length;
    b.textContent = items.length ? `Add ${items.length} match${items.length > 1 ? 'es' : ''} to the queue` : 'Add';
    $('#bulkPreview').innerHTML = note ? `<p class="bad">${esc(note)}</p>`
      : items.length ? `<span>${items.length} found, in this order:</span><ol>${items.map((x) => `<li>${esc(x.a)}${x.phoneA ? '<span class="ph">📱' + esc(x.phoneA) + '</span>' : ''}<i>V</i>${esc(x.b)}${x.phoneB ? '<span class="ph">📱' + esc(x.phoneB) + '</span>' : ''}</li>`).join('')}</ol>`
      : '<span>Nothing recognised yet.</span>';
  }
  $('#bulkBtn').onclick = () => { $('#bulkText').value = ''; $('#bulkFile').value = ''; showBulk([]); bulkDlg.showModal(); };
  $('#bulkText').addEventListener('input', (e) => showBulk(GoatBulk.parseText(e.target.value)));
  $('#bulkFile').addEventListener('change', async (e) => {
    const f = e.target.files[0]; if (!f) return;
    try { showBulk(await GoatBulk.readFile(f)); } catch (err) { showBulk([], err.message); }
  });
  $('#bulkAdd').onclick = async () => {
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
      d.target = lst === boardList ? Math.min(N(), S.matches.length) : S.matches.length;
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
    if (await act('add', { a: f.a.value, b: f.b.value })) { f.a.value = ''; f.b.value = ''; f.a.focus(); }
  });
  $('#doneList').addEventListener('click', (e) => { const r = e.target.closest('[data-restore]'); if (r) act('restore', { id: r.dataset.restore }); });

  $('#undoBtn').onclick = () => act('undo');
  $('#logoutBtn').onclick = async () => { await fetch('/api/logout', { method: 'POST' }); location.href = '/admin'; };

  // ── WhatsApp: phone numbers + message log (admin only) ──
  let contacts = {}, wa = { provider: 'none', ready: false }, waLog = [], adminT = null;
  function refreshAdminData(delay = 0) {
    clearTimeout(adminT);
    adminT = setTimeout(async () => {
      try {
        const r = await fetch('/api/admin-data', { cache: 'no-store' });
        if (!r.ok) return;
        const j = await r.json();
        contacts = j.contacts || {}; wa = j.whatsapp || wa; waLog = j.log || [];
        renderWA();
      } catch {}
    }, delay);
  }
  function renderWA() {
    if (!S) return;
    const on = !!(S.settings && S.settings.notify);
    $('#waBadge').textContent = on ? (wa.ready ? 'ON' : 'ON · test mode') : 'OFF';
    $('#waMode').textContent = wa.ready ? `Sending through ${wa.provider === 'meta' ? 'Meta' : wa.provider === 'gupshup-enterprise' ? 'Gupshup (Enterprise)' : 'Gupshup'}` : 'Test mode: nothing is sent until the Gupshup keys and templates are added in Vercel';
    const t = $('#waToggle'); t.textContent = on ? 'Messages ON' : 'Messages OFF'; t.className = on ? 'on' : '';
    const kind = { soon: 'Coming up', next: "You're next", later: 'Moved later' };
    $('#waLog').innerHTML = waLog.length ? waLog.map((e) => {
      const cls = /^sent/.test(e.status) ? 'ok' : /^test/.test(e.status) ? 'test' : 'bad';
      return `<li><span class="st ${cls}">${esc(e.status)}</span><b>${esc(kind[e.kind] || e.kind)}</b> → ${esc(e.name)} ${esc(e.to || '')} · ${new Date(e.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}<p>${esc(e.text)}</p></li>`;
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
  refreshAdminData();
  setInterval(() => { if ($('#waBox').open) refreshAdminData(); }, 10000);

  GoatLive.connect((s) => { S = s; render(); renderWA(); }, (ok) => { $('#conn').className = 'conn ' + (ok ? 'ok' : 'bad'); });
  setInterval(() => document.querySelectorAll('.cd[data-at]').forEach((el) => { el.textContent = fmtLeft(+el.dataset.at); }), 500);
  setInterval(() => { if (!sheet.open) render(); }, 30000);
})();
