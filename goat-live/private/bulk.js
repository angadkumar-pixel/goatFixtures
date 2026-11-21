// Bulk add: Excel (.xlsx), CSV, pasted Excel cells, one-per-line lists, or a free-text paragraph.
// Exposes window.GoatBulk.parseText(text) / parseRows(rows) / readFile(file) → [{a, b}] in order.
window.GoatBulk = (() => {
  const TIME = /^\d{1,2}[:.]\d{2}(\s*[ap]\.?m\.?)?$/i, NUM = /^#?\d+[.)]?$/;
  const HEADER = /^(player|players|team|teams|name|names|side|a|b|p\s*[12ab]|player\s*[12ab]|team\s*[12ab]|match|no\.?|sr\.?|s\.?no\.?|#|time|court|vs|v|(phone|mobile|contact|whatsapp|number|ph\.?)\s*(no\.?|number)?\s*(of\s*)?(p|player|team)?\s*[12ab]?)$/i;
  // tidy a name: drop numbering like "1." / "Match 3:" / a leading "and"/"then"
  const tidy = (s) => String(s || '').replace(/\s+/g, ' ').trim()
    .replace(/^[^:]{0,24}:\s*/, '')                                            // "Today:", "Match 4:", "Court 2:"
    .replace(/^(?:match\s*\d+\s*[.)-]?|\d+\s*[.):-]|and\s+|then\s+|&\s+)\s*/i, '')
    .replace(/[.;,]+$/, '').trim();
  const isHeader = (cells) => { const v = cells.map((c) => String(c || '').trim()).filter(Boolean); return v.length > 0 && v.every((c) => HEADER.test(c)); };

  // a phone number: 98765 43210 / +91-98765-43210 / 919876543210 / Excel's 9.87654321E9
  const isPhone = (s) => /^\d(\.\d+)?e\+?\d+$/i.test(s) || (/^[+\d\s\-().]+$/.test(s) && /^\d{10,13}$/.test(s.replace(/\D/g, '')));
  // Row like: P1 | PhoneP1 | P2 | PhoneP2 (also works with a serial no./time column, or without phones).
  // Each phone belongs to the name just before it.
  function rowToItem(cells) {
    const names = [], phones = [];
    cells.map((c) => String(c == null ? '' : c).trim()).forEach((c) => {
      if (!c) return;
      if (isPhone(c)) { if (names.length && !phones[names.length - 1]) phones[names.length - 1] = c; return; }
      if (TIME.test(c) || NUM.test(c) || /^(vs\.?|v|v\/s)$/i.test(c)) return;
      names.push(c);
    });
    if (names.length >= 2) return { a: tidy(names[0]), b: tidy(names[1]), phoneA: phones[0] || '', phoneB: phones[1] || '' };
    if (names.length === 1) return parseText(names[0])[0] || null; // "Raj vs Amit" in one cell
    return null;
  }
  function parseRows(rows) {
    rows = rows.filter((r) => r && r.some((c) => String(c || '').trim()));
    if (rows.length && rows[0].filter((c) => String(c || '').trim()).every((c) => HEADER.test(String(c).trim()))) rows = rows.slice(1); // header row
    return rows.map(rowToItem).filter((x) => x && x.a && x.b);
  }
  function parseText(text) {
    const out = [];
    for (const raw of String(text || '').split(/\r?\n/)) {
      const line = raw.trim();
      if (!line) continue;
      if (line.includes('\t')) { const cells = line.split('\t'); if (!isHeader(cells)) { const it = rowToItem(cells); if (it) out.push(it); } continue; } // pasted Excel cells
      if (isHeader(line.split(/\s*[|,]\s*/))) continue;                                                       // a header line
      if (line.includes('|')) { const it = rowToItem(line.split('|')); if (it) out.push(it); continue; }     // A | B
      // "A vs B" (several per line / a paragraph): split at commas, semicolons, full stops, "and", "then"
      const re = /([^,;\n]+?)\s+(?:vs\.?|v\/s|v\.?|versus|against)\s+(.+?)(?=\s*(?:,|;|\.(?=\s|$)|\s+and\s+(?=[^,;]*\s(?:vs\.?|v\/s|v\.?|versus|against)\s)|\s+then\s+|$))/gi;
      let m, found = false;
      while ((m = re.exec(line))) { const a = tidy(m[1]), b = tidy(m[2]); if (a && b) { out.push({ a, b }); found = true; } }
      if (found) continue;
      const parts = line.split(/\s*,\s*/).filter(Boolean);                                                   // "A, B" (CSV line)
      if (parts.length >= 2) { const it = rowToItem(parts); if (it) out.push(it); }
    }
    return out;
  }

  // ── minimal .xlsx reader (zip + XML): every worksheet, in workbook order → [{ name, rows }] ──
  async function readXlsx(buf) { return (await readSheets(buf))[0].rows; } // first worksheet only
  async function readSheets(buf) {
    const dv = new DataView(buf), td = new TextDecoder();
    let eocd = -1;
    for (let i = buf.byteLength - 22; i >= Math.max(0, buf.byteLength - 70000); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) throw new Error('This file is not a valid .xlsx');
    const files = {};
    let p = dv.getUint32(eocd + 16, true);
    for (let k = 0, n = dv.getUint16(eocd + 10, true); k < n; k++) {
      const nlen = dv.getUint16(p + 28, true), elen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true);
      files[td.decode(new Uint8Array(buf, p + 46, nlen))] = { method: dv.getUint16(p + 10, true), size: dv.getUint32(p + 20, true), off: dv.getUint32(p + 42, true) };
      p += 46 + nlen + elen + clen;
    }
    async function read(name) {
      const f = files[name]; if (!f) return null;
      const start = f.off + 30 + dv.getUint16(f.off + 26, true) + dv.getUint16(f.off + 28, true);
      const data = new Uint8Array(buf, start, f.size);
      if (f.method === 0) return td.decode(data);
      if (!window.DecompressionStream) throw new Error('This browser cannot open .xlsx — save the sheet as CSV, or copy the cells and paste them.');
      return td.decode(await new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer());
    }
    const xml = (s) => new DOMParser().parseFromString(s, 'application/xml');
    const shared = [];
    const ss = await read('xl/sharedStrings.xml');
    if (ss) for (const si of xml(ss).getElementsByTagName('si')) shared.push([...si.getElementsByTagName('t')].map((t) => t.textContent).join(''));
    // sheet names + their files, from workbook.xml and its relationships (so the sheet order is the workbook's)
    const list = [];
    const wb = await read('xl/workbook.xml'), rels = await read('xl/_rels/workbook.xml.rels');
    if (wb && rels) {
      const target = {};
      for (const r of xml(rels).getElementsByTagName('Relationship')) target[r.getAttribute('Id')] = r.getAttribute('Target');
      for (const sh of xml(wb).getElementsByTagName('sheet')) {
        const idAttr = [...sh.attributes].find((a) => /(^|:)id$/.test(a.name) && a.name !== 'sheetId'), t = idAttr && target[idAttr.value];
        if (!t) continue;
        const path = t.startsWith('/') ? t.slice(1) : 'xl/' + t.replace(/^\.\//, '');
        if (files[path]) list.push({ name: sh.getAttribute('name') || '', path });
      }
    }
    if (!list.length) Object.keys(files).filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))
      .sort((a, b) => parseInt(a.match(/\d+/)[0]) - parseInt(b.match(/\d+/)[0])).forEach((p) => list.push({ name: '', path: p }));
    if (!list.length) throw new Error('No worksheet found in this file');
    const out = [];
    for (const sh of list) out.push({ name: sh.name, rows: sheetRows(xml(await read(sh.path)), shared) });
    return out;
  }
  function sheetRows(doc, shared) {
    const rows = [];
    for (const r of doc.getElementsByTagName('row')) {
      const cells = [];
      for (const c of r.getElementsByTagName('c')) {
        const col = (c.getAttribute('r') || '').replace(/\d+/g, '');
        const ci = col ? col.split('').reduce((a, ch) => a * 26 + ch.charCodeAt(0) - 64, 0) - 1 : cells.length;
        const t = c.getAttribute('t'), v = c.getElementsByTagName('v')[0];
        cells[ci] = t === 's' ? shared[+(v && v.textContent)] || '' : t === 'inlineStr' ? [...c.getElementsByTagName('t')].map((x) => x.textContent).join('') : v ? v.textContent : '';
      }
      rows.push(Array.from(cells, (x) => (x == null ? '' : x)));
    }
    return rows;
  }
  function csvRows(text) { // handles quoted cells
    const rows = []; let row = [], cell = '', q = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (q) { if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += ch; }
      else if (ch === '"') q = true;
      else if (ch === ',' || ch === ';' || ch === '\t') { row.push(cell); cell = ''; }
      else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
      else cell += ch;
    }
    if (cell || row.length) { row.push(cell); rows.push(row); }
    return rows;
  }
  // ── draw lists: one row per player → Category | Player | WhatsApp (in draw order) ──
  const CAT = /^(?:(?:boys|girls|men|women)\s+)?(?:u|under)\s*-?\s*(\d{1,2})(?:\s+(?:boys|girls))?$/i;
  const catName = (s) => { const m = String(s || '').trim().match(CAT); if (!m) return ''; const g = (String(s).match(/boys|girls|men|women/i) || [''])[0]; return (g ? g[0].toUpperCase() + g.slice(1).toLowerCase() + ' ' : '') + 'U' + Number(m[1]); };
  function asDraw(rows) {
    const cats = {}, order = []; let hits = 0, other = 0;
    rows.forEach((r) => {
      const cells = (r || []).map((c) => String(c == null ? '' : c).trim()).filter(Boolean);
      if (!cells.length) return;
      const ci = cells.findIndex((c) => catName(c));
      if (ci < 0) { if (!isHeader(cells) && !cells.every((c) => /^(category|cat|age|group|player|name|whatsapp|phone|mobile|number|sr\.?|no\.?|#)$/i.test(c))) other++; return; }
      const cat = catName(cells[ci]);
      const rest = cells.filter((_, k) => k !== ci && (isPhone(cells[k]) || !NUM.test(cells[k]))); // drop serial numbers, keep phones
      const phone = rest.find(isPhone) || '', names = rest.filter((c) => !isPhone(c));
      if (names.length !== 1) { other++; return; }
      if (!cats[cat]) { cats[cat] = []; order.push(cat); }
      cats[cat].push({ name: tidy(names[0]), phone });
      hits++;
    });
    if (hits < 2 || other > hits / 4) return null;
    return order.map((cat) => ({ cat, players: cats[cat] }));
  }
  // ── bracket sheets: the first round already paired (like the printed brackets) ──
  //   Category | Player 1 | WhatsApp 1 | Player 2 | WhatsApp 2      (or Player 1 | Player 2 | Phone 1 | Phone 2 under a
  //   title row such as "Boys Singles U11 | First Round"). "Bye" on one side = goes straight through. Columns found by header.
  const looseCat = (s) => { const m = String(s || '').match(/\b(girls\s+(?:singles\s+)?)?u\s*-?\s*(\d{1,2})\b/i); return m ? (m[1] ? 'Girls ' : '') + 'U' + Number(m[2]) : ''; };
  function asPairs(rows, startCat = '', out = {}, order = []) {
    let col = null, cat = startCat;
    const header = (cells) => {
      const c = { cat: -1, a: -1, b: -1, pa: -1, pb: -1 };
      cells.forEach((x, i) => {
        const t = String(x || '').toLowerCase().trim(); if (!t) return;
        const ph = /phone|whatsapp|mobile|contact|number|\bno\b/.test(t), one = /(?:^|\D)1\b|\ba\b/.test(t.replace(/no\./g, '')), two = /(?:^|\D)2\b|\bb\b/.test(t);
        if (/^(category|cat|age\s*group|group|event)$/.test(t)) c.cat = i;
        else if (ph && one) c.pa = i; else if (ph && two) c.pb = i;
        else if (/player|name|team/.test(t) && one) c.a = i; else if (/player|name|team/.test(t) && two) c.b = i;
      });
      return c.a >= 0 && c.b >= 0 ? c : null;
    };
    for (const r of rows) {
      const cells = (r || []).map((x) => String(x == null ? '' : x).trim());
      if (!cells.some(Boolean)) continue;
      const h = header(cells); if (h) { col = h; continue; }
      if (!col) { const c = cells.map(looseCat).find(Boolean); if (c) cat = c; continue; }
      const a = cells[col.a] || '', b = cells[col.b] || '';
      if (!a && !b) { const c = cells.map(looseCat).find(Boolean); if (c) cat = c; continue; }
      const rowCat = col.cat >= 0 ? catName(cells[col.cat]).replace(/^Boys /, '') || looseCat(cells[col.cat]) : '';
      if (!rowCat && cells.filter(Boolean).length === 1) { // a title row ("Boys Singles U13 | First Round", "BRACKET 2")
        const t = a || b, c = looseCat(t);
        if (c) { cat = c; continue; }
        if (/bracket|round|singles|doubles|draw|academy|tournament|pool|half/i.test(t)) continue;
      }
      const k = rowCat || cat; if (!k) continue;
      if (!out[k]) { out[k] = []; order.push(k); }
      out[k].push({ a, b, phoneA: col.pa >= 0 ? cells[col.pa] : '', phoneB: col.pb >= 0 ? cells[col.pb] : '' });
    }
    return order.length ? order.map((c) => ({ cat: c, pairs: out[c] })) : null;
  }
  // Workbook with one sheet per category: the sheet name ("U11", "Boys U13 …") or the title row inside names it.
  function pairsFromSheets(sheets) {
    const out = {}, order = [];
    sheets.forEach((sh) => asPairs(sh.rows, looseCat(sh.name), out, order));
    return order.length ? order.map((c) => ({ cat: c, pairs: out[c] })) : null;
  }
  const textRows = (text) => String(text || '').split(/\r?\n/).map((l) => (l.includes('\t') ? l.split('\t') : l.includes('|') ? l.split('|') : l.split(/\s*[,;]\s*/)));
  // Anything → { draw: [{cat, players}] } for a player list, or { items: [{a, b, …}] } for a list of matches.
  async function readAny(file) {
    const name = file.name.toLowerCase();
    if (name.endsWith('.xls')) throw new Error('Old .xls files are not supported — in Excel use Save As → .xlsx or CSV.');
    const sheets = name.endsWith('.xlsx') ? await readSheets(await file.arrayBuffer()) : null;
    const rows = sheets ? sheets[0].rows : name.endsWith('.csv') ? csvRows(await file.text()) : textRows(await file.text());
    const draw = (sheets ? pairsFromSheets(sheets) : asPairs(rows)) || asDraw(rows);
    if (draw) return { draw };
    return { items: name.endsWith('.xlsx') || name.endsWith('.csv') ? parseRows(rows) : parseText(rows.map((r) => r.join(' | ')).join('\n')) };
  }
  function parseAny(text) { const draw = asPairs(textRows(text)) || asDraw(textRows(text)); return draw ? { draw } : { items: parseText(text) }; }
  async function readFile(file) {
    const name = file.name.toLowerCase();
    if (name.endsWith('.xls')) throw new Error('Old .xls files are not supported — in Excel use Save As → .xlsx or CSV.');
    if (name.endsWith('.xlsx')) return parseRows(await readXlsx(await file.arrayBuffer()));
    const text = await file.text();
    return name.endsWith('.csv') ? parseRows(csvRows(text)) : parseText(text);
  }
  return { parseText, parseRows, readFile, csvRows, readAny, parseAny, asDraw, asPairs, pairsFromSheets, readXlsx, readSheets };
})();
