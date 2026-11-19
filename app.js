'use strict';
// 현장사진 — 현장조사용 사진 기록 PWA
// 사진·정보는 IndexedDB(이 기기 브라우저)에만 저장. 서버로 아무것도 보내지 않음.

const $ = (s) => document.querySelector(s);
const pad = (n, w = 2) => String(n).padStart(w, '0');
const fmtTime = (t) => { const d = new Date(t); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; };
const fmtCoord = (p) => `${p.lat.toFixed(6)}, ${p.lon.toFixed(6)}`;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

// ---------- 설정 (localStorage, 실패해도 기본값으로 동작) ----------
const DEF = { project: null, maxSide: 3000, pos: 'bl', fields: { project: true, label: true, tag: true, memo: true, time: true, coord: true } };
let S = DEF;
try { const s = JSON.parse(localStorage.getItem('fp-settings') || 'null'); if (s) S = { ...DEF, ...s, fields: { ...DEF.fields, ...s.fields } }; } catch {}
const saveS = () => { try { localStorage.setItem('fp-settings', JSON.stringify(S)); } catch {} };

// ---------- 조사표 양식 ----------
// 한 줄 = 한 항목. "이름 | 빠른입력1, 빠른입력2"
const TEMPLATES = {
  basic: [],
  river: [
    '초본류 | 갈대, 달뿌리풀, 물억새, 고마리, 환삼덩굴, 쑥, 갈풀',
    '교목류 | 버드나무, 왕버들, 선버들, 아까시나무, 없음',
    '관목류 | 갯버들, 키버들, 족제비싸리, 없음',
    '식생 분포 형태(목본류) | 군락형, 띠형, 산재형, 단목, 없음',
    '식생 밀생정도 | 밀생, 보통, 산생, 없음',
    '평균 수고(m)',
    '흉고직경(cm)',
    '수관폭(m)',
    '비고',
  ],
};
const parseField = (line) => { const [n, o = ''] = line.split('|'); return { name: n.trim(), opts: o.split(',').map((x) => x.trim()).filter(Boolean) }; };
const fieldsOf = () => (current?.fields || []).map(parseField).filter((f) => f.name);
function fieldInputs(box, values) {
  box.innerHTML = fieldsOf().map((f) => `<label class="f">${esc(f.name)}<input type="text" data-f="${esc(f.name)}" value="${esc(values[f.name] || '')}" autocomplete="off"${/\((m|cm)\)$/.test(f.name) ? ' inputmode="decimal"' : ''}>
    ${f.opts.length ? `<span class="chips">${f.opts.map((o) => `<button type="button" data-v="${esc(o)}">${esc(o)}</button>`).join('')}</span>` : ''}</label>`).join('');
  box.querySelectorAll('input[data-f]').forEach(syncChips);
}
function syncChips(inp) {
  const vals = inp.value.split(',').map((x) => x.trim());
  inp.parentElement.querySelectorAll('.chips button').forEach((b) => b.classList.toggle('on', vals.includes(b.dataset.v)));
}
// 빠른입력 버튼: 누르면 추가, 다시 누르면 빼기 (여러 개 선택 가능)
document.addEventListener('click', (e) => {
  const b = e.target.closest('.chips button'); if (!b) return;
  e.preventDefault();
  const inp = b.closest('label').querySelector('input'), v = b.dataset.v;
  let vals = inp.value.split(',').map((x) => x.trim()).filter(Boolean);
  vals = vals.includes(v) ? vals.filter((x) => x !== v) : [...vals, v];
  inp.value = vals.join(', '); syncChips(inp); inp.dispatchEvent(new Event('input', { bubbles: true }));
});
document.addEventListener('input', (e) => { if (e.target.matches('input[data-f]')) syncChips(e.target); });
const readInputs = (box) => Object.fromEntries([...box.querySelectorAll('input[data-f]')].map((i) => [i.dataset.f, i.value.trim()]));
const sites = () => (current.sites ||= []);
const siteOf = (name) => sites().find((x) => x.name === name);
function upsertSite(name, values) {
  if (!name) return;
  const st = siteOf(name);
  if (st) st.values = { ...st.values, ...values };
  else sites().push({ name, values });
}
const saveProject = () => dbPut('projects', current);
function allSiteNames() {
  const n = sites().map((x) => x.name);
  for (const p of photos) if (p.label && !n.includes(p.label)) n.push(p.label);
  return n;
}

// ---------- IndexedDB ----------
let dbP;
function db() {
  return dbP ||= new Promise((res, rej) => {
    const r = indexedDB.open('field-photo', 1);
    r.onupgradeneeded = () => {
      const d = r.result;
      d.createObjectStore('projects', { keyPath: 'id' });
      d.createObjectStore('photos', { keyPath: 'id' }).createIndex('project', 'projectId');
    };
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
}
async function run(store, mode, fn) {
  const d = await db();
  return new Promise((res, rej) => {
    const t = d.transaction(store, mode); let out;
    const r = fn(t.objectStore(store));
    if (r) r.onsuccess = () => { out = r.result; };
    t.oncomplete = () => res(out); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error || new Error('저장 실패'));
  });
}
const dbAll = (s) => run(s, 'readonly', (o) => o.getAll());
const dbPut = (s, v) => run(s, 'readwrite', (o) => o.put(v));
const dbDel = (s, k) => run(s, 'readwrite', (o) => o.delete(k));
const photosOf = (pid) => run('photos', 'readonly', (o) => o.index('project').getAll(pid));

// ---------- 상태 ----------
let projects = [], photos = [], current = null;
const thumbUrls = new Map();

// ---------- 화면 공통 ----------
let toastT;
function toast(msg, ms = 2200) {
  let el = $('.toast'); if (!el) { el = document.createElement('div'); el.className = 'toast'; document.body.append(el); }
  el.textContent = msg; el.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => (el.hidden = true), ms);
}
async function busy(msg, fn) {
  const el = document.createElement('div'); el.className = 'busy'; el.textContent = msg; document.body.append(el);
  try { return await fn((m) => (el.textContent = m)); } finally { el.remove(); }
}
// 다이얼로그 안 입력칸에서 Enter 눌러도 닫히지 않게
document.querySelectorAll('dialog form').forEach((f) => f.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.tagName === 'INPUT') { e.preventDefault(); if (e.target.id === 'newPrj') $('#addPrj').click(); }
}));

// ---------- GPS ----------
let fix = null; // {lat, lon, acc, alt, t}
function gpsChip() {
  const el = $('#gps');
  if (!('geolocation' in navigator)) { el.className = 'gps no'; el.textContent = 'GPS 없음'; return; }
  if (!fix) return;
  const old = Date.now() - fix.t > 60000, a = Math.round(fix.acc);
  el.className = 'gps ' + (old ? 'no' : a <= 15 ? 'ok' : 'mid');
  el.textContent = old ? 'GPS 끊김' : `GPS ±${a}m`;
}
function startGps() {
  if (!('geolocation' in navigator)) return gpsChip();
  navigator.geolocation.watchPosition((p) => {
    fix = { lat: p.coords.latitude, lon: p.coords.longitude, acc: p.coords.accuracy, alt: p.coords.altitude, t: Date.now() }; gpsChip();
  }, (e) => { const el = $('#gps'); el.className = 'gps no'; el.textContent = e.code === 1 ? '위치 권한 없음' : 'GPS 찾는 중'; },
  { enableHighAccuracy: true, maximumAge: 5000, timeout: 30000 });
  setInterval(gpsChip, 10000);
}
function getFix(maxAge = 20000) {
  if (fix && Date.now() - fix.t < maxAge) return Promise.resolve(fix);
  if (!('geolocation' in navigator)) return Promise.resolve(null);
  return new Promise((res) => navigator.geolocation.getCurrentPosition(
    (p) => { fix = { lat: p.coords.latitude, lon: p.coords.longitude, acc: p.coords.accuracy, alt: p.coords.altitude, t: Date.now() }; gpsChip(); res(fix); },
    () => res(fix && Date.now() - fix.t < 120000 ? fix : null), { enableHighAccuracy: true, timeout: 8000, maximumAge: 5000 }));
}

// ---------- EXIF 읽기 (앨범 사진의 촬영일시·GPS) ----------
async function readExif(file) {
  try {
    const v = new DataView(await file.slice(0, 256 * 1024).arrayBuffer());
    if (v.getUint16(0) !== 0xFFD8) return {};
    let p = 2;
    while (p + 10 < v.byteLength) {
      const m = v.getUint16(p), len = v.getUint16(p + 2);
      if (m === 0xFFE1 && v.getUint32(p + 4) === 0x45786966) return parseTiff(v, p + 10);
      if ((m & 0xFF00) !== 0xFF00 || m === 0xFFDA) break;
      p += 2 + len;
    }
  } catch {}
  return {};
}
function parseTiff(v, t) {
  const le = v.getUint16(t) === 0x4949;
  const u16 = (o) => v.getUint16(t + o, le), u32 = (o) => v.getUint32(t + o, le);
  const ifd = (off) => { const n = u16(off), m = {}; for (let i = 0; i < n; i++) { const e = off + 2 + i * 12; m[u16(e)] = { type: u16(e + 2), count: u32(e + 4), off: e + 8 }; } return m; };
  const val = (e) => {
    if (!e) return undefined;
    const sz = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1 }[e.type] || 1;
    const o = e.count * sz > 4 ? u32(e.off) : e.off;
    if (e.type === 2) { let s = ''; for (let i = 0; i < e.count; i++) { const c = v.getUint8(t + o + i); if (!c) break; s += String.fromCharCode(c); } return s; }
    if (e.type === 5) { const a = []; for (let i = 0; i < e.count; i++) { const d = u32(o + i * 8 + 4); a.push(d ? u32(o + i * 8) / d : 0); } return a; }
    if (e.type === 3) return u16(o); if (e.type === 4) return u32(o); return v.getUint8(t + o);
  };
  const out = {}, i0 = ifd(u32(4));
  if (i0[0x8769]) {
    const d = val(ifd(val(i0[0x8769]))[0x9003]);
    const m = d && d.match(/^(\d{4}):(\d\d):(\d\d) (\d\d):(\d\d):(\d\d)/);
    if (m) out.time = new Date(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime();
  }
  if (i0[0x8825]) {
    const g = ifd(val(i0[0x8825])), la = val(g[2]), lo = val(g[4]);
    if (la && lo && la.length === 3 && lo.length === 3) {
      const f = (a) => a[0] + a[1] / 60 + a[2] / 3600;
      out.lat = f(la) * (val(g[1]) === 'S' ? -1 : 1); out.lon = f(lo) * (val(g[3]) === 'W' ? -1 : 1);
      const al = val(g[6]); if (al) out.alt = al[0] * (val(g[5]) === 1 ? -1 : 1);
      if (!out.lat && !out.lon) { delete out.lat; delete out.lon; }
    }
  }
  return out;
}

// ---------- EXIF 쓰기 (내보낸 JPG에 촬영일시·GPS 넣기) ----------
function makeExif(p) {
  const asc = (s) => { const b = new TextEncoder().encode(s + '\0'); return { type: 2, count: b.length, bytes: b }; };
  const rat = (arr) => { const b = new Uint8Array(arr.length * 8), v = new DataView(b.buffer); arr.forEach(([n, d], i) => { v.setUint32(i * 8, n); v.setUint32(i * 8 + 4, d); }); return { type: 5, count: arr.length, bytes: b }; };
  const byte = (arr) => ({ type: 1, count: arr.length, bytes: new Uint8Array(arr) });
  const long = (n) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n); return { type: 4, count: 1, bytes: b }; };
  const dms = (x) => { x = Math.abs(x); const d = Math.floor(x), mf = (x - d) * 60, m = Math.floor(mf); return [[d, 1], [m, 1], [Math.round((mf - m) * 60 * 10000), 10000]]; };
  const d = new Date(p.time), ds = `${d.getFullYear()}:${pad(d.getMonth() + 1)}:${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  const hasGps = p.lat != null && p.lon != null;
  const ifd0 = [[0x0132, asc(ds)], [0x8769, null]]; if (hasGps) ifd0.push([0x8825, null]);
  const exif = [[0x9003, asc(ds)], [0x9004, asc(ds)]];
  const gps = hasGps ? [[0, byte([2, 3, 0, 0])], [1, asc(p.lat >= 0 ? 'N' : 'S')], [2, rat(dms(p.lat))], [3, asc(p.lon >= 0 ? 'E' : 'W')], [4, rat(dms(p.lon))]] : null;
  if (gps && p.alt != null && isFinite(p.alt)) gps.push([5, byte([p.alt < 0 ? 1 : 0])], [6, rat([[Math.round(Math.abs(p.alt) * 100), 100]])]);
  const size = (es) => 2 + 12 * es.length + 4 + es.reduce((a, [, e]) => a + (e && e.bytes.length > 4 ? e.bytes.length + (e.bytes.length & 1) : 0), 0);
  const oE = 8 + size(ifd0), oG = oE + size(exif), total = oG + (gps ? size(gps) : 0);
  ifd0[1][1] = long(oE); if (gps) ifd0[2][1] = long(oG);
  const buf = new Uint8Array(total), v = new DataView(buf.buffer);
  buf.set([0x4D, 0x4D, 0, 0x2A, 0, 0, 0, 8]);
  const write = (off, es) => {
    v.setUint16(off, es.length); let data = off + 2 + 12 * es.length + 4;
    es.forEach(([tag, e], i) => {
      const q = off + 2 + i * 12; v.setUint16(q, tag); v.setUint16(q + 2, e.type); v.setUint32(q + 4, e.count);
      if (e.bytes.length <= 4) buf.set(e.bytes, q + 8); else { v.setUint32(q + 8, data); buf.set(e.bytes, data); data += e.bytes.length + (e.bytes.length & 1); }
    });
    v.setUint32(off + 2 + 12 * es.length, 0);
  };
  write(8, ifd0); write(oE, exif); if (gps) write(oG, gps);
  const seg = new Uint8Array(10 + total);
  seg.set([0xFF, 0xE1]); new DataView(seg.buffer).setUint16(2, 8 + total); seg.set([0x45, 0x78, 0x69, 0x66, 0, 0], 4); seg.set(buf, 10);
  return seg;
}
async function withExif(jpegBlob, p) {
  const b = new Uint8Array(await jpegBlob.arrayBuffer());
  let rest = 2; // SOI 뒤
  if (b[2] === 0xFF && b[3] === 0xE0) rest = 4 + ((b[4] << 8) | b[5]); // JFIF APP0 제거
  const exif = makeExif(p);
  const res = new Uint8Array(2 + exif.length + b.length - rest);
  res.set([0xFF, 0xD8]); res.set(exif, 2); res.set(b.subarray(rest), 2 + exif.length);
  return res;
}

// ---------- 이미지 처리 ----------
async function loadImg(blob) {
  const url = URL.createObjectURL(blob);
  const img = new Image();
  // decode() 대신 onload: 화면이 가려진 상태에서도 멈추지 않음
  try { await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url; }); } catch (e) { URL.revokeObjectURL(url); throw new Error('사진을 열 수 없습니다 (HEIC 등 지원 안 되는 형식일 수 있음)'); }
  return { img, done: () => URL.revokeObjectURL(url) };
}
function toBlob(c, q) { return new Promise((res) => c.toBlob(res, 'image/jpeg', q)); }
async function render(blob, { maxSide = 0, stamp = null, q = 0.9 } = {}) {
  const { img, done } = await loadImg(blob);
  let w = img.naturalWidth, h = img.naturalHeight;
  const k = maxSide ? Math.min(1, maxSide / Math.max(w, h)) : 1; w = Math.round(w * k); h = Math.round(h * k);
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const g = c.getContext('2d'); g.drawImage(img, 0, 0, w, h); done();
  if (stamp) drawStamp(g, w, h, stamp);
  const out = await toBlob(c, q); c.width = c.height = 0; return out;
}
function stampLines(p) {
  const f = S.fields, L = [];
  if (f.project && current) L.push(current.name);
  const lb = [f.label ? `No.${p.seq}` : '', f.label && p.label ? p.label : '', f.tag && p.tag ? `[${p.tag}]` : ''].filter(Boolean).join('  ');
  if (lb) L.push(lb);
  if (f.memo && p.memo) L.push(...p.memo.split('\n').filter((s) => s.trim()));
  if (f.time) L.push(fmtTime(p.time));
  if (f.coord && p.lat != null) L.push(`${fmtCoord(p)}${p.acc ? `  ±${Math.round(p.acc)}m` : ''}`);
  return L;
}
function drawStamp(g, w, h, lines) {
  if (!lines.length) return;
  const fs = Math.max(13, Math.round(Math.min(w, h) / 30)), padd = Math.round(fs * 0.6), lh = Math.round(fs * 1.32);
  g.font = `600 ${fs}px system-ui, -apple-system, "Malgun Gothic", "Apple SD Gothic Neo", sans-serif`;
  const maxW = w * 0.92 - padd * 2, wrapped = [];
  for (const line of lines) {           // 긴 줄은 접기
    let cur = '';
    for (const ch of line) { if (g.measureText(cur + ch).width > maxW && cur) { wrapped.push(cur); cur = ch; } else cur += ch; }
    wrapped.push(cur);
  }
  const tw = Math.max(...wrapped.map((l) => g.measureText(l).width));
  const bw = Math.ceil(tw + padd * 2), bh = wrapped.length * lh + padd * 2 - (lh - fs) + 2, m = Math.round(fs * 0.5);
  const x = S.pos[1] === 'r' ? w - bw - m : m, y = S.pos[0] === 'b' ? h - bh - m : m;
  g.fillStyle = 'rgba(0,0,0,.58)'; g.fillRect(x, y, bw, bh);
  g.fillStyle = '#fff'; g.textBaseline = 'top';
  g.shadowColor = 'rgba(0,0,0,.6)'; g.shadowBlur = fs / 8;
  wrapped.forEach((l, i) => g.fillText(l, x + padd, y + padd + i * lh));
  g.shadowBlur = 0;
}

// ---------- 목록 ----------
function thumbUrl(p) {
  if (!thumbUrls.has(p.id)) thumbUrls.set(p.id, URL.createObjectURL(p.thumb));
  return thumbUrls.get(p.id);
}
function renderList() {
  photos.sort((a, b) => a.seq - b.seq || a.time - b.time);
  $('#prjName').textContent = current ? current.name : '현장 선택';
  $('#prjCount').textContent = current ? `${photos.length}장` : '';
  const grid = $('#grid'), empty = $('#empty');
  grid.innerHTML = photos.map((p) => `<button class="tile" data-id="${p.id}">
    <div class="ph" style="background-image:url('${thumbUrl(p)}')"><span class="no">${p.seq}</span>${p.lat == null ? '<span class="nogps">위치없음</span>' : ''}</div>
    <div class="cap"><div class="lb">${esc([p.label, p.tag].filter(Boolean).join(' · ') || p.memo || '(이름 없음)')}</div><div class="tm">${fmtTime(p.time).slice(5, 16)}</div></div></button>`).join('');
  empty.hidden = photos.length > 0;
  empty.innerHTML = current ? '아직 사진이 없습니다.<br>아래 <b>촬영</b> 버튼을 누르세요.' : '먼저 위쪽에서 <b>현장</b>을 만들어 주세요.';
  $('#siteNames').innerHTML = current ? allSiteNames().map((n) => `<option value="${esc(n)}">`).join('') : '';
  if (tab === 'map') drawMarkers();
  if (tab === 'site') renderSites();
  if (tab === 'report') renderReport();
}
$('#grid').addEventListener('click', (e) => { const t = e.target.closest('.tile'); if (t) openEdit(photos.find((p) => p.id === t.dataset.id)); });

async function loadProject(id) {
  current = projects.find((p) => p.id === id) || null;
  S.project = current?.id || null; saveS();
  thumbUrls.forEach((u) => URL.revokeObjectURL(u)); thumbUrls.clear(); seqHi = 0;
  photos = current ? await photosOf(current.id) : [];
  renderList();
}
const nextSeq = () => photos.reduce((m, p) => Math.max(m, p.seq), 0) + 1;
// 연속 저장 때 번호가 겹치지 않게 미리 잡아 둠
let seqHi = 0;
const takeSeq = () => (seqHi = Math.max(seqHi, nextSeq() - 1) + 1);

// ---------- 촬영/가져오기 ----------
function needProject() { if (current) return false; toast('먼저 현장을 만들어 주세요'); openPrj(); return true; }

// 지점 화면에서 촬영/앨범을 누르면 정보 입력 없이 그 지점에 바로 저장 (shootFor = 지점명)
let shootFor = null; // { site, slot }
const SLOTS = { 1: '전경', 2: '수목 및 식생 현황' };
async function quickSave(items) {
  await busy('저장 중…', async (msg) => {
    let ok = 0;
    for (const [i, it] of items.entries()) {
      if (items.length > 1) msg(`저장 중… ${i + 1}/${items.length}`);
      try {
        await savePhoto({ id: uid(), projectId: current.id, seq: takeSeq(), label: shootFor.site, tag: SLOTS[shootFor.slot] || '', memo: '', time: it.time, lat: it.lat ?? null, lon: it.lon ?? null, alt: it.alt ?? null, acc: it.acc ?? null }, it.file);
        ok++;
      } catch (err) { console.error(err); toast(err.message, 4000); }
    }
    if (ok) toast(`${shootFor.site} · ${SLOTS[shootFor.slot]} — ${ok}장 저장`);
  });
  renderList(); renderSitePhotos();
}
$('#cam').onchange = (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) onCamFile(f); };
async function onCamFile(file) {
  if (needProject()) return;
  try {
    const [ex, gp] = await Promise.all([readExif(file), getFix()]);
    const loc = ex.lat != null ? { lat: ex.lat, lon: ex.lon, alt: ex.alt ?? gp?.alt ?? null, acc: null } : gp ? { lat: gp.lat, lon: gp.lon, alt: gp.alt, acc: gp.acc } : {};
    if (shootFor && $('#siteDlg').open) return await quickSave([{ file, time: Date.now(), ...loc }]);
    openEdit(null, { file, time: Date.now(), ...loc });
  } catch (e) { console.error(e); toast('사진을 처리하지 못했습니다: ' + e.message, 6000); }
}
$('#camNext').onchange = (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) onCamFile(f); };
$('#pick').onchange = (e) => { const fs = [...e.target.files]; e.target.value = ''; if (fs.length) onPickFiles(fs); };
async function onPickFiles(files) {
  if (needProject()) return;
  if (shootFor && $('#siteDlg').open) {
    const items = []; for (const f of files) { const ex = await readExif(f); items.push({ file: f, time: ex.time || f.lastModified || Date.now(), lat: ex.lat, lon: ex.lon, alt: ex.alt }); }
    return quickSave(items);
  }
  if (files.length === 1) {
    const ex = await readExif(files[0]);
    return openEdit(null, { file: files[0], time: ex.time || files[0].lastModified || Date.now(), lat: ex.lat, lon: ex.lon, alt: ex.alt, acc: null });
  }
  await busy('가져오는 중…', async (msg) => {
    let seq = nextSeq(), ok = 0;
    for (const [i, f] of files.entries()) {
      msg(`가져오는 중… ${i + 1}/${files.length}`);
      try {
        const ex = await readExif(f);
        await savePhoto({ id: uid(), projectId: current.id, seq: seq++, label: '', tag: '', memo: '', time: ex.time || f.lastModified || Date.now(), lat: ex.lat ?? null, lon: ex.lon ?? null, alt: ex.alt ?? null, acc: null }, f);
        ok++;
      } catch (err) { console.error(err); }
    }
    toast(`${ok}장 가져왔습니다` + (ok < files.length ? ` (${files.length - ok}장 실패)` : ''));
  });
  renderList();
}

async function savePhoto(rec, srcBlob) {
  if (srcBlob) {
    rec.blob = await render(srcBlob, { maxSide: S.maxSide, q: 0.92 });
    rec.thumb = await render(rec.blob, { maxSide: 400, q: 0.75 });
  }
  await dbPut('photos', rec);
  const i = photos.findIndex((p) => p.id === rec.id);
  if (i >= 0) photos[i] = rec; else photos.push(rec);
  navigator.storage?.persist?.().catch(() => {});
}

// ---------- 사진 정보 시트 ----------
let editing = null; // {rec, file, isNew}
let prevUrl = null, prevT;
function setLocText() {
  const r = editing.rec, el = $('#fLoc');
  el.className = 't' + (r.lat == null ? ' no' : '');
  el.textContent = r.lat == null ? '위치 없음' : `📍 ${fmtCoord(r)}${r.acc ? ` (±${Math.round(r.acc)}m)` : ''}`;
}
function formToRec() {
  const r = editing.rec;
  r.seq = Math.max(1, parseInt($('#fSeq').value, 10) || r.seq);
  r.label = $('#fLabel').value.trim(); r.tag = $('#fTag').value; r.memo = $('#fMemo').value.trim();
}
async function refreshPreview() {
  if (!editing) return;
  formToRec();
  const src = editing.file || editing.rec.blob;
  try {
    const b = await render(src, { maxSide: 1200, stamp: stampLines(editing.rec), q: 0.8 });
    if (prevUrl) URL.revokeObjectURL(prevUrl);
    prevUrl = URL.createObjectURL(b); $('#editImg').src = prevUrl;
  } catch (e) { toast(e.message, 4000); }
}
const queuePreview = () => { clearTimeout(prevT); prevT = setTimeout(refreshPreview, 350); };
['#fSeq', '#fLabel', '#fTag', '#fMemo'].forEach((s) => $(s).addEventListener('input', queuePreview));

function openEdit(rec, fresh) {
  const isNew = !rec;
  if (isNew) rec = { id: uid(), projectId: current.id, seq: nextSeq(), label: nextLabel ?? lastLabel(), tag: '', memo: '', time: fresh.time, lat: fresh.lat ?? null, lon: fresh.lon ?? null, alt: fresh.alt ?? null, acc: fresh.acc ?? null };
  editing = { rec: { ...rec }, file: fresh?.file || null, isNew };
  $('#editTitle').textContent = isNew ? '새 사진' : `No.${rec.seq} 사진`;
  $('#fSeq').value = rec.seq; $('#fLabel').value = rec.label; $('#fMemo').value = rec.memo;
  const tagSel = $('#fTag');
  if (rec.tag && ![...tagSel.options].some((o) => o.value === rec.tag)) tagSel.add(new Option(rec.tag, rec.tag));
  tagSel.value = rec.tag || '';
  $('#fReport').checked = !isNew && !!rec.label && reportPhoto(rec.label, rec.tag || '')?.id === rec.id;
  $('#fTime').textContent = '촬영: ' + fmtTime(rec.time);
  $('#tagList').innerHTML = [...new Set(photos.map((p) => p.tag).filter(Boolean))].map((t) => `<option value="${esc(t)}">`).join('');
  setLocText(); loadSiteBox(rec.label);
  $('#delBtn').hidden = isNew; $('#shareOne').hidden = isNew || !navigator.canShare; $('#saveNext').hidden = !isNew;
  $('#editImg').removeAttribute('src');
  $('#editDlg').showModal();
  refreshPreview();
}
let nextLabel = null;
const lastLabel = () => { const p = [...photos].sort((a, b) => b.time - a.time)[0]; return p?.label || ''; };
function loadSiteBox(name) {
  const box = $('#siteBox'), has = fieldsOf().length > 0;
  box.hidden = !has; if (!has) return;
  const prev = editing.siteName !== undefined && !siteOf(name) ? readInputs($('#siteFields')) : null; // 새 지점이면 입력하던 값 유지
  editing.siteName = name;
  $('#siteBoxName').textContent = name || '(지점명 없음)';
  fieldInputs($('#siteFields'), prev || siteOf(name)?.values || {});
}
$('#fLabel').addEventListener('change', () => editing && loadSiteBox($('#fLabel').value.trim()));
let returnSite = null;
// 지점 화면에서 연 사진이면 닫은 뒤 지점 화면으로 돌아감
function backToSite() { if (returnSite != null) { const n = returnSite; returnSite = null; openSite(n); } }
$('#editDlg').addEventListener('close', () => { setTimeout(backToSite, 0); nextLabel = null; editing = null; clearTimeout(prevT); if (prevUrl) { URL.revokeObjectURL(prevUrl); prevUrl = null; } });
$('#locNow').onclick = async () => {
  const b = $('#locNow'); b.disabled = true; b.textContent = '찾는 중…';
  const f = await getFix(5000); b.disabled = false; b.textContent = '현재 위치로';
  if (!f || !editing) return toast('위치를 못 찾았습니다. 위치 권한과 GPS를 확인하세요');
  Object.assign(editing.rec, { lat: f.lat, lon: f.lon, alt: f.alt, acc: f.acc }); setLocText(); queuePreview();
};
$('#locClear').onclick = () => { Object.assign(editing.rec, { lat: null, lon: null, alt: null, acc: null }); setLocText(); queuePreview(); };

async function doSave(next) {
  if (!editing) return;
  formToRec();
  const { rec, file } = editing;
  const btns = ['#saveBtn', '#saveNext'].map($); btns.forEach((b) => (b.disabled = true));
  try {
    if ($('#fReport').checked) {          // 같은 구간·같은 종류의 다른 ★는 해제
      for (const p of photos.filter((x) => x.id !== rec.id && x.label === rec.label && (x.tag || '') === (rec.tag || '') && x.report)) { p.report = false; await dbPut('photos', p); }
      rec.report = true;
    } else rec.report = false;
    await savePhoto(rec, file);
    if (fieldsOf().length && rec.label) { upsertSite(rec.label, readInputs($('#siteFields'))); await saveProject(); }
    $('#editDlg').close(); renderList(); backToSite();
    toast(`No.${rec.seq} 저장됨`);
  } catch (e) { console.error(e); toast('저장 실패: ' + e.message, 4000); }
  finally { btns.forEach((b) => (b.disabled = false)); }
}
$('#saveBtn').onclick = () => doSave(false);
// 저장 + 다음 촬영: 누르는 순간 카메라가 열리고(label), 그동안 지금 사진을 저장
$('#saveNext').addEventListener('click', (e) => { if (e.target.id !== 'camNext') doSave(false); });
$('#delBtn').onclick = async () => {
  const r = editing.rec;
  if (!confirm(`No.${r.seq} 사진을 삭제할까요? 되돌릴 수 없습니다.`)) return;
  await dbDel('photos', r.id);
  photos = photos.filter((p) => p.id !== r.id);
  if (thumbUrls.has(r.id)) { URL.revokeObjectURL(thumbUrls.get(r.id)); thumbUrls.delete(r.id); }
  $('#editDlg').close(); renderList(); backToSite(); toast('삭제했습니다');
};
$('#shareOne').onclick = async () => {
  formToRec();
  const r = editing.rec, saved = photos.find((p) => p.id === r.id);
  const file = new File([await exportJpeg({ ...saved, ...r }, true)], fileName({ ...saved, ...r }), { type: 'image/jpeg' });
  try { await navigator.share({ files: [file], title: r.label || `No.${r.seq}` }); } catch (e) { if (e.name !== 'AbortError') toast('공유할 수 없습니다'); }
};

// ---------- 현장 ----------
async function openPrj() {
  const counts = {};
  for (const p of projects) counts[p.id] = p.id === current?.id ? photos.length : (await run('photos', 'readonly', (o) => o.index('project').count(p.id)));
  $('#prjList').innerHTML = projects.length ? projects.sort((a, b) => b.created - a.created).map((p) =>
    `<button type="button" class="item${p.id === current?.id ? ' on' : ''}" data-id="${p.id}"><span class="nm">${esc(p.name)}</span><span class="muted">${counts[p.id]}장</span></button>`).join('')
    : '<div class="muted">현장이 없습니다. 아래에 이름을 넣고 추가하세요.</div>';
  $('#prjTools').hidden = !current; renderPresetBtns();
  $('#newPrj').value = '';
  if (!$('#prjDlg').open) $('#prjDlg').showModal();
}
$('#prjBtn').onclick = openPrj;
$('#prjList').addEventListener('click', async (e) => {
  const b = e.target.closest('.item'); if (!b) return;
  await loadProject(b.dataset.id); $('#prjDlg').close();
});
$('#addPrj').onclick = async () => {
  const name = $('#newPrj').value.trim(); if (!name) return $('#newPrj').focus();
  const p = { id: uid(), name, created: Date.now(), fields: [...TEMPLATES[$('#newTpl').value]], sites: [] };
  await dbPut('projects', p); projects.push(p);
  await loadProject(p.id); $('#prjDlg').close(); toast(`"${name}" 현장을 만들었습니다`);
};
$('#renPrj').onclick = async () => {
  const n = prompt('새 현장 이름', current.name); if (!n || !n.trim()) return;
  current.name = n.trim(); await dbPut('projects', current); renderList(); openPrj();
};
$('#fldPrj').onclick = () => { $('#fldText').value = (current.fields || []).join('\n'); $('#fldDlg').showModal(); };
$('#fldRiver').onclick = () => { $('#fldText').value = TEMPLATES.river.join('\n'); };
$('#fldSave').onclick = async () => {
  current.fields = $('#fldText').value.split('\n').map((x) => x.trim()).filter(Boolean);
  await saveProject(); $('#fldDlg').close(); renderList(); toast('조사 항목을 저장했습니다');
};
$('#delPrj').onclick = async () => {
  if (!confirm(`"${current.name}" 현장과 사진 ${photos.length}장을 모두 삭제할까요?\n되돌릴 수 없습니다. 먼저 내보내기로 백업했는지 확인하세요.`)) return;
  for (const p of photos) await dbDel('photos', p.id);
  await dbDel('projects', current.id);
  projects = projects.filter((p) => p.id !== current.id);
  await loadProject(projects[0]?.id); openPrj();
};

// ---------- 내보내기 ----------
const safe = (s) => String(s).replace(/[\\/:*?"<>|\r\n\t]+/g, '_').trim();
function fileName(p) {
  const d = new Date(p.time);
  return safe([pad(p.seq, 3), p.label, `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`].filter(Boolean).join('_')) + '.jpg';
}
async function exportJpeg(p, stamp) {
  const jpg = stamp ? await render(p.blob, { stamp: stampLines(p), q: 0.92 }) : p.blob;
  return withExif(jpg, p);
}
function csvText() {
  const q = (v) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const rows = [['번호', '지점명', '분류', '메모', '촬영일시', '위도', '경도', '고도(m)', '정확도(m)', '파일명']];
  for (const p of photos) rows.push([p.seq, p.label, p.tag, p.memo, fmtTime(p.time), p.lat?.toFixed(7), p.lon?.toFixed(7), p.alt != null ? p.alt.toFixed(1) : '', p.acc != null ? Math.round(p.acc) : '', photoPath(p)]);
  return '﻿' + rows.map((r) => r.map(q).join(',')).join('\r\n');
}
function siteCsvText() {
  const q = (v) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const fs = fieldsOf().map((f) => f.name);
  const rows = [['지점명', '시점', '종점', ...fs, '사진수', '대표 좌표', '사진 번호']];
  for (const n of allSiteNames()) {
    const st = siteOf(n), v = st?.values || {}, ps = photos.filter((p) => p.label === n), g = ps.find((p) => p.lat != null) || (st && sitePos(st));
    rows.push([n, st?.info?.['시점'], st?.info?.['종점'], ...fs.map((f) => v[f]), ps.length, g ? fmtCoord(g) : '', ps.map((p) => p.seq).join(' ')]);
  }
  return '\uFEFF' + rows.map((r) => r.map(q).join(',')).join('\r\n');
}
const photoPath = (p) => 'photos/' + (p.label ? safe(p.label) + '/' : '') + fileName(p);
function kmlText() {
  const pm = photos.filter((p) => p.lat != null).map((p) => `  <Placemark>
    <name>${esc(`${p.seq}${p.label ? ' ' + p.label : ''}`)}</name>
    <description><![CDATA[<img src="${photoPath(p)}" width="400"><br>${esc(p.tag)} ${esc(p.memo).replace(/\n/g, '<br>')}<br>${fmtTime(p.time)}]]></description>
    <TimeStamp><when>${new Date(p.time).toISOString()}</when></TimeStamp>
    <Point><coordinates>${p.lon.toFixed(7)},${p.lat.toFixed(7)}${p.alt != null ? ',' + p.alt.toFixed(1) : ''}</coordinates></Point>
  </Placemark>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<kml xmlns="http://www.opengis.net/kml/2.2"><Document>\n  <name>${esc(current.name)}</name>\n${pm}\n</Document></kml>\n`;
}
function download(blob, name) {
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
  document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 60000);
}
const stampName = () => { const d = new Date(); return `${safe(current.name)}_${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`; };
function canExport() { if (needProject()) return false; if (!photos.length) { toast('사진이 없습니다'); return false; } return true; }

$('#expBtn').onclick = () => { if (canExport()) { $('#expSite').hidden = !fieldsOf().length; $('#expDlg').showModal(); } };
$('#expCsv').onclick = () => download(new Blob([csvText()], { type: 'text/csv;charset=utf-8' }), stampName() + '_목록.csv');
$('#expSite').onclick = () => download(new Blob([siteCsvText()], { type: 'text/csv;charset=utf-8' }), stampName() + '_조사표.csv');
$('#expKml').onclick = () => download(new Blob([kmlText()], { type: 'application/vnd.google-earth.kml+xml' }), stampName() + '.kml');
// 보고서 자료: 구간별 조사값 + ★ 사진 (스탬프 없이 report/ 폴더에)
const REPORT_FIELDS = ['초본류', '교목류', '관목류', '식생 분포 형태(목본류)', '식생 밀생정도', '평균 수고(m)', '흉고직경(cm)', '수관폭(m)'];
const sectionNo = (name) => +((name.match(/(\d+)\s*구간/) || [])[1] || 0);
async function reportFiles() {
  const out = [], list = [];
  for (const s of sites()) {
    const sec = sectionNo(s.name); if (!sec) continue;
    const item = { name: s.name, section: sec, values: Object.fromEntries(REPORT_FIELDS.map((f) => [f, s.values?.[f] || ''])) };
    for (const slot of [1, 2]) {
      const p = reportPhoto(s.name, SLOTS[slot]); if (!p) continue;
      const file = `report/${pad(sec, 2)}_${slot}.jpg`;
      out.push({ name: file, data: new Uint8Array(await p.blob.arrayBuffer()) });
      item['photo' + slot] = { file, caption: p.memo || SLOTS[slot], seq: p.seq };
    }
    list.push(item);
  }
  out.push({ name: '보고서.json', data: new TextEncoder().encode(JSON.stringify({ app: 'field-photo', version: 1, project: current.name, exported: new Date().toISOString(), sites: list }, null, 1)) });
  return out;
}
async function exportZip(stamp) {
  await busy('ZIP 만드는 중…', async (msg) => {
  const enc = new TextEncoder(), files = [];
  for (const [i, p] of photos.entries()) { msg(`사진 처리 중… ${i + 1}/${photos.length}`); files.push({ name: photoPath(p), data: await exportJpeg(p, stamp) }); }
  if (fieldsOf().length || sites().length) files.push({ name: '조사표.csv', data: enc.encode(siteCsvText()) });
  files.push({ name: '사진목록.csv', data: enc.encode(csvText()) }, { name: '위치.kml', data: enc.encode(kmlText()) });
  if (sites().some((s) => sectionNo(s.name))) { msg('보고서 자료 정리 중…'); files.push(...await reportFiles()); }
  msg('ZIP 묶는 중…');
  if ($('#expDlg').open) $('#expDlg').close();
  download(makeZip(files), stampName() + '.zip'); toast('ZIP 파일을 저장했습니다 — PC의 보고서(PC) 탭에 넣으세요', 4000);
  });
}
$('#expZip').onclick = () => exportZip($('#expStamp').checked);
// 사진만: 구간별 폴더 + 정리된 파일 이름 (조사표·CSV 없이)
$('#expPhotos').onclick = () => busy('사진 ZIP 만드는 중…', async (msg) => {
  const stamp = $('#expStamp').checked, files = [];
  const list = [...photos].sort((x, y) => x.seq - y.seq);
  for (const [i, p] of list.entries()) {
    msg(`사진 처리 중… ${i + 1}/${list.length}`);
    files.push({ name: safe(current.name) + '/' + (p.label ? safe(p.label) + '/' : '') + fileName(p), data: await exportJpeg(p, stamp) });
  }
  msg('ZIP 묶는 중…');
  download(makeZip(files), stampName() + '_사진.zip');
  $('#expDlg').close(); toast(`사진 ${files.length}장을 ZIP으로 저장했습니다`);
});

// 카톡·네이버 등 앱 안 브라우저에서는 카메라·다운로드가 막힐 수 있어 바깥 브라우저로 안내
(() => {
  const ua = navigator.userAgent, kakao = /KAKAOTALK/i.test(ua);
  if (!(kakao || /NAVER\(inapp|Instagram|FBAN|FBAV|Line\/|DaumApps/i.test(ua))) return;
  $('#inappWarn').hidden = false;
  $('#openExt').onclick = () => {
    if (kakao) location.href = 'kakaotalk://web/openExternal?url=' + encodeURIComponent(location.href);
    else alert('오른쪽 위(또는 아래) 메뉴 ⋯ 에서 "다른 브라우저로 열기" / "Safari로 열기"를 누르세요.');
  };
})();

// 앱 설치 버튼: 설치 창을 띄울 수 있으면 띄우고, 아니면 지금 브라우저에 맞는 방법을 안내
(() => {
  const btn = $('#install'), ua = navigator.userAgent;
  if (matchMedia('(display-mode: standalone)').matches || navigator.standalone || location.protocol === 'file:') return;
  const ios = /iphone|ipad|ipod/i.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const android = /android/i.test(ua), kakao = /KAKAOTALK/i.test(ua), inApp = kakao || /NAVER|Instagram|FBAN|FBAV|Line\//i.test(ua);
  let deferred = null;
  addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferred = e; btn.hidden = false; });
  addEventListener('appinstalled', () => { btn.hidden = true; deferred = null; toast('설치했습니다. 홈 화면의 현장사진 아이콘으로 여세요', 4000); });
  if (ios || android || inApp) btn.hidden = false;      // 휴대폰에서는 항상 보이게
  btn.onclick = async () => {
    if (deferred) {
      deferred.prompt();
      if ((await deferred.userChoice).outcome === 'accepted') btn.hidden = true;
      deferred = null;
    } else if (kakao) {
      alert((ios ? 'Safari로 넘어갑니다.' : '인터넷(기본 브라우저)으로 넘어갑니다.') + '\n넘어간 페이지에서 "📲 설치"를 다시 눌러 주세요.');
      location.href = 'kakaotalk://web/openExternal?url=' + encodeURIComponent(location.href);
    } else if (inApp) {
      alert('앱 안 브라우저에서는 설치가 안 돼요.\n메뉴(⋮ 또는 …)에서 "다른 브라우저로 열기"를 누른 뒤 다시 눌러 주세요.');
    } else if (ios) {
      alert(/CriOS|FxiOS|EdgiOS/i.test(ua) ? '아이폰은 사파리에서만 설치돼요.\n이 주소를 사파리로 열고 공유(□↑) → "홈 화면에 추가"를 누르세요.'
        : '아래쪽 공유 버튼(□↑)을 누른 뒤 "홈 화면에 추가"를 누르세요.');
    } else if (android) {
      alert('브라우저 메뉴(⋮)에서 "앱 설치" 또는 "홈 화면에 추가"를 누르세요.\n(이미 설치했다면 홈 화면의 현장사진 아이콘으로 여세요)');
    }
  };
})();

// ZIP (무압축 저장 방식, UTF-8 파일명)
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(u8) { let c = 0xFFFFFFFF; for (let i = 0; i < u8.length; i++) c = CRC[(c ^ u8[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
function makeZip(files) {
  const enc = new TextEncoder(), parts = [], central = [], d = new Date();
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1), date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  let off = 0;
  for (const f of files) {
    const nm = enc.encode(f.name), crc = crc32(f.data), n = f.data.length;
    const h = new Uint8Array(30 + nm.length), v = new DataView(h.buffer);
    v.setUint32(0, 0x04034b50, true); v.setUint16(4, 20, true); v.setUint16(6, 0x0800, true); v.setUint16(8, 0, true);
    v.setUint16(10, time, true); v.setUint16(12, date, true); v.setUint32(14, crc, true); v.setUint32(18, n, true); v.setUint32(22, n, true);
    v.setUint16(26, nm.length, true); h.set(nm, 30);
    const c = new Uint8Array(46 + nm.length), cv = new DataView(c.buffer);
    cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true); cv.setUint16(8, 0x0800, true);
    cv.setUint16(12, time, true); cv.setUint16(14, date, true); cv.setUint32(16, crc, true); cv.setUint32(20, n, true); cv.setUint32(24, n, true);
    cv.setUint16(28, nm.length, true); cv.setUint32(42, off, true); c.set(nm, 46);
    parts.push(h, f.data); central.push(c); off += h.length + n;
  }
  const cs = central.reduce((a, c) => a + c.length, 0), e = new Uint8Array(22), ev = new DataView(e.buffer);
  ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, files.length, true); ev.setUint16(10, files.length, true); ev.setUint32(12, cs, true); ev.setUint32(16, off, true);
  return new Blob([...parts, ...central, e], { type: 'application/zip' });
}

// ---------- 지도 (카카오맵, 처음 열 때만 불러옴) ----------
// JavaScript 키는 원래 웹페이지에 노출되는 키이고, 카카오 개발자 콘솔에 등록한 도메인에서만 동작함
const KAKAO_KEY = '3a9a28c008059a145d2a12ea857e94e2';
let map = null, pins = [], tab = 'site', district = false;
function loadKakao() {
  if (window.kakao?.maps?.Map) return Promise.resolve();
  return new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = `https://dapi.kakao.com/v2/maps/sdk.js?appkey=${KAKAO_KEY}&autoload=false&libraries=services`;
    s.onload = () => (window.kakao?.maps ? kakao.maps.load(res) : rej(new Error('sdk')));
    s.onerror = rej; document.head.append(s);
  });
}
async function showMap() {
  if (!map) {
    try { await loadKakao(); } catch { $('#map').innerHTML = '<div class="map-msg">지도를 불러오지 못했습니다.<br>인터넷 연결을 확인하세요.<br><small>(계속 안 되면 카카오 개발자 콘솔의 도메인 등록 확인)</small></div>'; return; }
    const K = kakao.maps;
    map = new K.Map($('#map'), { center: new K.LatLng(36.5, 127.8), level: 12 });
    map.addControl(new K.MapTypeControl(), K.ControlPosition.TOPRIGHT);   // 지도 / 스카이뷰
    map.addControl(new K.ZoomControl(), K.ControlPosition.RIGHT);
  }
  setTimeout(() => { map.relayout(); drawMarkers(true); geocodeSites(); }, 50);
}
// 구간 시점·종점 주소 → 좌표 (카카오 주소 검색). 한 번 찾으면 저장해 둠
const stripAddr = (s) => (s || '').replace(/\(.*?\)/g, '').replace(/일원/g, '').trim();
async function geocodeSites() {
  if (!current || !window.kakao?.maps?.services) return;
  const todo = sites().filter((s) => s.info && !s.geo);
  if (!todo.length) return;
  const gc = new kakao.maps.services.Geocoder(), OK = kakao.maps.services.Status.OK;
  const q = (a) => a ? new Promise((res) => gc.addressSearch(a, (r, st) => res(st === OK && r[0] ? { lat: +r[0].y, lon: +r[0].x } : null))) : Promise.resolve(null);
  const prj = current;
  toast(`구간 위치 찾는 중… (${todo.length}개)`);
  for (const s of todo) {
    const start = await q(stripAddr(s.info['시점'])), end = await q(stripAddr(s.info['종점']));
    s.geo = { start, end, center: !start && !end ? await q(stripAddr(s.info['주소'])) : null };
  }
  await dbPut('projects', prj);
  if (prj === current) drawMarkers(true);
}
function sitePos(s) {
  if (s.pos) return s.pos;
  const g = s.geo || {};
  if (g.start && g.end) return { lat: (g.start.lat + g.end.lat) / 2, lon: (g.start.lon + g.end.lon) / 2 };
  return g.start || g.end || g.center || null;
}
const siteDone = (s) => { const fs = fieldsOf(); return fs.length > 0 && fs.every((f) => s.values?.[f.name]); };
function pin(lat, lon, html, cls, onTap) {
  const el = document.createElement('div'); el.className = cls; el.innerHTML = html;
  if (onTap) el.addEventListener('click', onTap);
  const o = new kakao.maps.CustomOverlay({ position: new kakao.maps.LatLng(lat, lon), content: el, clickable: true, yAnchor: 0.5, xAnchor: 0.5 });
  o.setMap(map); pins.push(o);
}
function drawMarkers(fit) {
  if (!map) return;
  pins.forEach((o) => o.setMap(null)); pins = [];
  const all = [];
  for (const s of current ? sites() : []) {      // 구간: 시점→종점 선 + 구간 이름
    const g = s.geo || {};
    if (g.start && g.end) {
      const line = new kakao.maps.Polyline({ path: [new kakao.maps.LatLng(g.start.lat, g.start.lon), new kakao.maps.LatLng(g.end.lat, g.end.lon)], strokeWeight: 5, strokeColor: '#1f9d55', strokeOpacity: 0.8 });
      line.setMap(map); pins.push(line);
    }
    const p = sitePos(s);
    if (p) { pin(p.lat, p.lon, esc(s.name.replace(/^육역화\s*/, '')), 'kste' + (siteDone(s) ? ' done' : ''), () => openSite(s.name)); all.push([p.lat, p.lon]); }
  }
  const pts = photos.filter((p) => p.lat != null);
  for (const p of pts) pin(p.lat, p.lon, String(p.seq), 'kpin', () => openEdit(p));
  if (fix) pin(fix.lat, fix.lon, '', 'kme');
  if (!fit) return;
  all.push(...pts.map((p) => [p.lat, p.lon])); if (fix && !all.length) all.push([fix.lat, fix.lon]);
  if (all.length > 1) { const b = new kakao.maps.LatLngBounds(); all.forEach(([a, o]) => b.extend(new kakao.maps.LatLng(a, o))); map.setBounds(b, 60, 60, 60, 60); }
  else if (all.length) { map.setCenter(new kakao.maps.LatLng(...all[0])); map.setLevel(3); }
}
$('#mapDistrict').onclick = (e) => {
  if (!map) return;
  district = !district; e.currentTarget.classList.toggle('on', district);
  map[district ? 'addOverlayMapTypeId' : 'removeOverlayMapTypeId'](kakao.maps.MapTypeId.USE_DISTRICT);
};
$('#mapMe').onclick = async () => {
  if (!map) return;
  const f = await getFix(10000); if (!f) return toast('위치를 못 찾았습니다');
  drawMarkers(false); map.setCenter(new kakao.maps.LatLng(f.lat, f.lon)); if (map.getLevel() > 4) map.setLevel(3);
};
document.querySelectorAll('.tabs button').forEach((b) => b.onclick = () => {
  document.querySelectorAll('.tabs button').forEach((x) => x.classList.toggle('on', x === b));
  tab = b.dataset.tab;
  $('#listView').hidden = tab !== 'list'; $('#siteView').hidden = tab !== 'site'; $('#mapView').hidden = tab !== 'map'; $('#reportView').hidden = tab !== 'report';
  if (tab === 'report') renderReport();
  if (tab === 'map') showMap();
  if (tab === 'site') renderSites();
});

// ---------- 조사표 탭 ----------
function renderSites() {
  const box = $('#siteListView'), fs = fieldsOf();
  if (!current) { box.innerHTML = '<div class="empty">먼저 현장을 만들어 주세요.</div>'; return; }
  const names = allSiteNames();
  box.innerHTML = names.map((n) => {
    const v = siteOf(n)?.values || {}, ps = photos.filter((p) => p.label === n);
    const filled = fs.filter((f) => v[f.name]).length;
    const kv = fs.filter((f) => v[f.name]).map((f) => `${esc(f.name)}: <b>${esc(v[f.name])}</b>`).join(' · ');
    const inf = siteOf(n)?.info, sta = (t) => (t || '').match(/\(([\d+.]+)\)/)?.[1];
    const sub = inf ? [sta(inf['시점']) && `${sta(inf['시점'])} ~ ${sta(inf['종점'])}`, inf['주소']].filter(Boolean).join(' · ') : '';
    return `<button type="button" class="site" data-n="${esc(n)}"><div class="hd"><b>${esc(n)}</b><span class="muted">사진 ${ps.length}장${fs.length ? ` · 항목 ${filled}/${fs.length}` : ''}</span></div>
      ${sub ? `<div class="sub">${esc(sub)}</div>` : ''}
      ${fs.length ? `<div class="bar-mini"><i style="width:${(filled / fs.length) * 100}%"></i></div>` : ''}
      ${kv ? `<div class="kv">${kv}</div>` : ''}
      ${ps.length ? `<div class="strip">${ps.slice(0, 6).map((p) => `<img src="${thumbUrl(p)}" alt="">`).join('')}</div>` : ''}</button>`;
  }).join('') || '<div class="empty">아직 지점이 없습니다.<br>사진을 찍을 때 <b>지점명</b>을 넣거나, 아래에서 미리 추가하세요.</div>';
  $('#siteHint').innerHTML = fs.length ? '' : '이 현장에는 조사 항목이 없습니다. 위쪽 현장 이름 → <b>조사 항목 편집</b>에서 추가할 수 있습니다.';
}
$('#siteListView').addEventListener('click', (e) => { const b = e.target.closest('.site'); if (b) openSite(b.dataset.n); });
$('#addSite').onclick = () => { if (!needProject()) openSite(null); };
let siteEditing = null;
function openSite(name) {
  siteEditing = name;
  $('#siteTitle').textContent = name ? '지점 조사표' : '새 지점';
  $('#sName').value = name || '';
  fieldInputs($('#sFieldsBox'), siteOf(name)?.values || {});
  const inf = siteOf(name)?.info;
  $('#sInfoBox').hidden = !inf;
  if (inf) {
    $('#sInfo').innerHTML = Object.entries(inf).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('');
    $('#sInfoSum').textContent = inf['시점']?.match(/\(([\d+.]+)\)/) ? `측점 ${inf['시점'].match(/\(([\d+.]+)\)/)[1]} ~ ${(inf['종점'] || '').match(/\(([\d+.]+)\)/)?.[1] || ''}` : '';
  }
  setSitePosText();
  renderSitePhotos();
  $('#sDel').hidden = !name;
  if (!$('#siteDlg').open) $('#siteDlg').showModal();
}
// 보고서에 넣을 사진: ★ 지정한 사진, 없으면 그 종류의 첫 장
const slotPhotos = (site, tag) => photos.filter((p) => p.label === site && (p.tag || '') === tag).sort((a, b) => a.seq - b.seq);
const reportPhoto = (site, tag) => { const ps = slotPhotos(site, tag); return ps.find((p) => p.report) || ps[0] || null; };
function renderSitePhotos() {
  for (const box of document.querySelectorAll('#sShots .shots')) {
    const slot = box.dataset.slot;
    const ps = !siteEditing ? [] : slot === '0' ? photos.filter((p) => p.label === siteEditing && !Object.values(SLOTS).includes(p.tag || '')).sort((a, b) => a.seq - b.seq) : slotPhotos(siteEditing, SLOTS[slot]);
    const rp = slot !== '0' && siteEditing ? reportPhoto(siteEditing, SLOTS[slot]) : null;
    if (slot === '0') box.hidden = !ps.length;
    const cnt = box.querySelector('[data-cnt]'); if (cnt) cnt.textContent = ps.length ? `${ps.length}장` : '';
    box.querySelector('[data-grid]').innerHTML = ps.map((p) => `<button type="button" data-id="${p.id}" class="${p === rp ? 'rep' : ''}" style="background-image:url('${thumbUrl(p)}')"><span>${p.seq}</span>${p === rp ? '<b>★</b>' : ''}${p.memo ? `<i>${esc(p.memo)}</i>` : ''}</button>`).join('');
  }
}
$('#siteDlg').addEventListener('close', () => { shootFor = null; });
function setSitePosText() {
  const s = siteOf(siteEditing), el = $('#sPosTxt'), p = s && sitePos(s);
  el.className = 't' + (p ? '' : ' no');
  el.textContent = !s ? '지도 위치: 저장 후 지정 가능' : s.pos ? `📍 현장에서 지정함 (±${Math.round(s.pos.acc || 0)}m)` : p ? '📍 주소로 찾은 대략 위치' : '지도 위치 없음';
}
$('#sPosNow').onclick = async () => {
  const n = await saveSite(); if (!n) return;
  const b = $('#sPosNow'); b.disabled = true; b.textContent = '찾는 중…';
  const f = await getFix(5000); b.disabled = false; b.textContent = '현재 위치로 지정';
  if (!f) return toast('위치를 못 찾았습니다. 위치 권한과 GPS를 확인하세요');
  siteOf(n).pos = { lat: f.lat, lon: f.lon, acc: f.acc }; await saveProject(); setSitePosText(); drawMarkers(false);
  toast('이 구간 위치를 현재 위치로 지정했습니다');
};
// 구간 화면의 촬영·앨범: 버튼(label)이 파일 입력을 직접 열고, 사진을 고른 뒤에 구간을 저장
$('#sShots').addEventListener('change', async (e) => {
  const inp = e.target; if (inp.type !== 'file') return;
  const files = [...inp.files], slot = inp.closest('.shots').dataset.slot; inp.value = '';
  if (!files.length) return;
  const n = await saveSite(); if (!n) return;
  shootFor = { site: n, slot };
  if (inp.hasAttribute('data-cam')) await onCamFile(files[0]); else await onPickFiles(files);
});
$('#sShots').addEventListener('click', async (e) => {
  const box = e.target.closest('.shots'); if (!box) return;
  const b = e.target.closest('button[data-id]'); if (!b) return;
  const n = await saveSite(); if (!n) return;
  $('#siteDlg').close(); returnSite = n; openEdit(photos.find((p) => p.id === b.dataset.id));
});
async function saveSite() {
  const n = $('#sName').value.trim();
  if (!n) { toast('지점명을 넣어 주세요'); $('#sName').focus(); return null; }
  const values = readInputs($('#sFieldsBox'));
  if (siteEditing && n !== siteEditing) {            // 이름 바꾸면 사진 지점명도 같이
    if (siteOf(n) && !confirm(`"${n}" 지점이 이미 있습니다. 합칠까요?`)) return null;
    for (const p of photos.filter((x) => x.label === siteEditing)) { p.label = n; await dbPut('photos', p); }
    const old = siteOf(siteEditing);
    if (old && !siteOf(n)) old.name = n; else if (old) current.sites = sites().filter((x) => x !== old);
  }
  const st = siteOf(n); if (st) st.values = values; else sites().push({ name: n, values });
  await saveProject(); renderList();
  siteEditing = n; $('#siteTitle').textContent = '지점 조사표'; $('#sDel').hidden = false;
  return n;
}
$('#sSave').onclick = async () => { if (await saveSite()) $('#siteDlg').close(); };
$('#sDel').onclick = async () => {
  const cnt = photos.filter((p) => p.label === siteEditing).length;
  if (!confirm(`"${siteEditing}" 지점의 조사 항목을 지울까요?${cnt ? `\n사진 ${cnt}장은 지우지 않고 남깁니다(지점명도 유지).` : ''}`)) return;
  current.sites = sites().filter((x) => x.name !== siteEditing); await saveProject();
  $('#siteDlg').close(); renderList();
};


// ---------- 보고서(PC) 탭 ----------
function renderReport() {
  const box = $('#repList');
  // 이 기기에 입력한 자료가 있을 때만 "이 기기 자료로 만들기"를 보여 줌 (PC에서는 보통 없음 → ZIP을 넣어야 함)
  const local = !!current && (photos.length > 0 || sites().some((s) => REPORT_FIELDS.some((f) => s.values?.[f])));
  $('#repHere').hidden = !local;
  if (local) $('#repHere').textContent = `이 기기에 있는 "${current.name}" 자료로 바로 만들기`;
  if (!current) { box.innerHTML = '<div class="muted">현장을 먼저 고르세요.</div>'; return; }
  const ss = sites().filter((s) => sectionNo(s.name));
  box.innerHTML = ss.map((s) => {
    const n = REPORT_FIELDS.filter((f) => s.values?.[f]).length, p1 = reportPhoto(s.name, SLOTS[1]), p2 = reportPhoto(s.name, SLOTS[2]);
    const done = n === REPORT_FIELDS.length && p1 && p2;
    return `<button type="button" class="rrow site-link" data-n="${esc(s.name)}"><b>${esc(s.name)}</b>
      <span class="${p1 ? 'ok' : 'no'}">사진1 ${p1 ? '✓' : '✗'}</span><span class="${p2 ? 'ok' : 'no'}">사진2 ${p2 ? '✓' : '✗'}</span>
      <span class="${n === REPORT_FIELDS.length ? 'ok' : 'no'}">항목 ${n}/${REPORT_FIELDS.length}</span>${done ? ' ✅' : ''}</button>`;
  }).join('') || '<div class="muted">"육역화 N구간" 형식의 구간이 없습니다.</div>';
}
$('#repList').addEventListener('click', (e) => { const b = e.target.closest('[data-n]'); if (b) openSite(b.dataset.n); });
// ---------- 보고서 만들기: ZIP(보고서.json + report 사진) → 한글 양식(HWPX) 채워서 다운로드 ----------
const TPL = { '명하천': 'tpl/myeong.hwpx', '제천': 'tpl/je.hwpx' };
const tplFor = (name) => { const k = Object.keys(TPL).find((x) => (name || '').includes(x)); return k ? { key: k, url: TPL[k] } : null; };
function repShow(html, ok = true) { $('#repResult').innerHTML = `<div class="${ok ? 'rep-ok' : 'rep-err'}">${html}</div>`; }
async function makeReport(data, photoOf, customTpl) {
  const t = tplFor(data.project);
  if (!customTpl && !t) throw new Error(`"${data.project}" 현장의 양식이 없습니다. 그 현장 조사표를 한글에서 .hwpx로 저장해 ZIP과 같이 넣어 주세요.`);
  return busy('한글 파일 만드는 중…', async (msg) => {
    let tpl = customTpl;
    if (!tpl) { msg('양식 받는 중… (처음 한 번은 조금 걸립니다)'); tpl = await (await fetch(t.url)).arrayBuffer(); }
    // 자료가 하나도 없으면 빈 양식을 내려받지 않음
    const has = (s) => s && (REPORT_FIELDS.some((f) => s.values?.[f]) || s.photo1 || s.photo2);
    const done = (data.sites || []).filter(has).sort((a, b) => a.section - b.section);
    if (!done.length) throw new Error(`"${data.project}"에는 아직 입력한 조사 항목이나 사진이 없습니다. 폰에서 입력·촬영한 뒤 저장한 ZIP을 넣어 주세요.`);
    const res = await HWPX.fill(tpl, data, photoOf, msg);
    const d = new Date(), stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}`;
    const name = `현장조사표_${t ? t.key : safe(data.project)}_결과_${stamp}.hwpx`;
    download(new Blob([res.blob], { type: 'application/hwp+zip' }), name);
    const miss = done.filter((s) => res.missing.get(+s.section)).map((s) => `${s.section}구간: ${res.missing.get(+s.section).join(', ')}`);
    repShow(`✅ <b>${esc(data.project)}</b> 한글 파일을 다운로드했습니다<br><b>${esc(name)}</b> (다운로드 폴더)` +
      `<br><br>채운 구간: <b>${done.map((s) => s.section + '구간').join(', ')}</b> — 칸 ${res.nText}개 · 사진 ${res.nPic}장` +
      (miss.length ? `<br>이 구간들의 빈 칸 (빨간 (현장조사)로 남음):<br>${miss.map(esc).join('<br>')}` : '') +
      (res.nsec > done.length ? `<br>나머지 ${res.nsec - done.length}개 구간은 아직 자료가 없어 그대로입니다.` : '') +
      `<br><br>한글에서 열어 <b>${done[0].section}구간</b> 쪽을 확인하세요.`);
  });
}
async function reportFromFiles(list) {
  const files = [...list], zip = files.find((f) => /\.zip$/i.test(f.name)), tplFile = files.find((f) => /\.hwpx$/i.test(f.name));
  if (!zip) return repShow('앱에서 저장한 <b>ZIP 파일</b>을 넣어 주세요.', false);
  try {
    const entries = await HWPX.unzip(await zip.arrayBuffer());
    const j = entries.find((e) => e.name.endsWith('보고서.json'));
    if (!j) throw new Error('이 ZIP에는 보고서 자료(보고서.json)가 없습니다. 앱을 최신으로 열고 다시 저장해 주세요.');
    const data = JSON.parse(new TextDecoder().decode(j.data)), dir = j.name.slice(0, -'보고서.json'.length);
    const photoOf = async (s, slot) => { const e = entries.find((x) => x.name === dir + s['photo' + slot].file); return e ? new Blob([e.data], { type: 'image/jpeg' }) : null; };
    await makeReport(data, photoOf, tplFile ? await tplFile.arrayBuffer() : null);
  } catch (e) { console.error(e); repShow('❌ ' + esc(e.message), false); }
}
$('#repFile').onchange = (e) => { reportFromFiles(e.target.files); e.target.value = ''; };
const drop = $('#repDrop');
['dragenter', 'dragover'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach((t) => drop.addEventListener(t, () => drop.classList.remove('over')));
drop.addEventListener('drop', (e) => { e.preventDefault(); reportFromFiles(e.dataTransfer.files); });
addEventListener('dragover', (e) => e.preventDefault());                  // 상자 밖에 떨어뜨려도 브라우저가 파일을 열지 않게
addEventListener('drop', (e) => { e.preventDefault(); if (tab === 'report' && !e.target.closest('#repDrop')) reportFromFiles(e.dataTransfer.files); });
$('#repHere').onclick = async () => {
  if (!current) return toast('현장을 먼저 고르세요');
  const data = { project: current.name, sites: sites().filter((s) => sectionNo(s.name)).map((s) => {
    const it = { name: s.name, section: sectionNo(s.name), values: Object.fromEntries(REPORT_FIELDS.map((f) => [f, s.values?.[f] || ''])) };
    for (const slot of [1, 2]) { const p = reportPhoto(s.name, SLOTS[slot]); if (p) it['photo' + slot] = { caption: p.memo || SLOTS[slot], id: p.id }; }
    return it;
  }) };
  try { await makeReport(data, async (s, slot) => photos.find((p) => p.id === s['photo' + slot].id)?.blob || null); }
  catch (e) { console.error(e); repShow('❌ ' + esc(e.message), false); }
};

// ---------- 설정 ----------
$('#setBtn').onclick = async () => {
  $('#sSize').value = String(S.maxSide); $('#sPos').value = S.pos;
  document.querySelectorAll('#sFields input').forEach((c) => (c.checked = !!S.fields[c.dataset.k]));
  const est = await navigator.storage?.estimate?.().catch(() => null);
  $('#sStore').textContent = est ? `사용 중인 저장공간: ${(est.usage / 1048576).toFixed(0)}MB / 가능 ${(est.quota / 1073741824).toFixed(1)}GB` : '';
  $('#setDlg').showModal();
};
$('#sSize').onchange = (e) => { S.maxSide = +e.target.value; saveS(); };
$('#sPos').onchange = (e) => { S.pos = e.target.value; saveS(); };
$('#sFields').onchange = (e) => { S.fields[e.target.dataset.k] = e.target.checked; saveS(); };

// ---------- 미리 넣어 둔 현장 (하도육역화 현장조사표 HWP에서 뽑은 구간) ----------
const PRESETS = [{"name":"명하천 하도육역화","tpl":"river","sites":[{"name":"육역화 1구간","info":{"주소":"충청남도 공주시 사곡면 운암리 655-4","시점":"충청남도 공주시 사곡면 운암리 46 일원 (0+223)","종점":"충청남도 공주시 사곡면 운암리 117 일원 (0+346)","하폭(m)":"27.97","저수로 폭(m)":"24.42","하상재료(%)":"모래 (63.2), 자갈 (34.4)","대상지 폭(m)":"13","종방향 길이(m)":"122","대상지 높이(m)":"0.32"}},{"name":"육역화 2구간","info":{"주소":"충청남도 공주시 사곡면 운암리 655-4","시점":"충청남도 공주시 사곡면 운암리 120 (0+462)","종점":"충청남도 공주시 사곡면 운암리 120 (0+502)","하폭(m)":"28.93","저수로 폭(m)":"23.90","하상재료(%)":"모래 (63.2), 자갈 (34.4)","대상지 폭(m)":"9","종방향 길이(m)":"46","하폭대비 비율(%)":"23.89","대상지 높이(m)":"-0.05"}},{"name":"육역화 3구간","info":{"주소":"충청남도 공주시 사곡면 운암리 655-4","시점":"충청남도 공주시 사곡면 운암리 103 (0+762)","종점":"충청남도 공주시 사곡면 운암리 90 (0+853)","하폭(m)":"22.20","저수로 폭(m)":"10.46","하상재료(%)":"모래 (66.8), 자갈 (30.8)","대상지 폭(m)":"16","종방향 길이(m)":"90","하폭대비 비율(%)":"52.32","대상지 높이(m)":"0.14"}},{"name":"육역화 4구간","info":{"주소":"충청남도 공주시 사곡면 운암리 655-4","시점":"충청남도 공주시 사곡면 운암리 26-9 (0+971)","종점":"충청남도 공주시 사곡면 운암리 26-5 (1+032)","하폭(m)":"34.53","저수로 폭(m)":"20.07","하상재료(%)":"모래 (66.8), 자갈 (30.8)","대상지 폭(m)":"7","종방향 길이(m)":"60","대상지 높이(m)":"0.26"}},{"name":"육역화 5구간","info":{"주소":"충청남도 공주시 사곡면 회학리 560","시점":"충청남도 공주시 사곡면 회학리 393 일원 (2+054)","종점":"충청남도 공주시 사곡면 회학리 393 일원 (2+084)","하폭(m)":"30.78","저수로 폭(m)":"23.02","하상재료(%)":"모래 (61.2), 자갈 (37.1)","대상지 폭(m)":"10","종방향 길이(m)":"28","하폭대비 비율(%)":"49.57","대상지 높이(m)":"-0.25"}},{"name":"육역화 6구간","info":{"주소":"충청남도 공주시 사곡면 회학리 560","시점":"충청남도 공주시 사곡면 정안마곡사로 1557 일원 (2+186)","종점":"충청남도 공주시 사곡면 회학리 350-2 일원 (2+264)","하폭(m)":"28.76","저수로 폭(m)":"21.05","하상재료(%)":"모래 (61.2), 자갈 (37.1)","대상지 폭(m)":"8","종방향 길이(m)":"75","대상지 높이(m)":"0.16"}},{"name":"육역화 7구간","info":{"주소":"충청남도 공주시 사곡면 회학리 560","시점":"충청남도 공주시 사곡면 말구리길 3 일원 (2+535)","종점":"충청남도 공주시 사곡면 회학리 331 일원 (2+765)","하폭(m)":"26.65","저수로 폭(m)":"17.78","하상재료(%)":"모래 (66.4), 자갈 (31.2)","대상지 폭(m)":"16","종방향 길이(m)":"230","대상지 높이(m)":"0.59"}},{"name":"육역화 8구간","info":{"주소":"충청남도 공주시 사곡면 월가리 966","시점":"충청남도 공주시 사곡면 월가리 1036-4 일원 (3+216)","종점":"충청남도 공주시 사곡면 월가리 1035-2 (3+383)","하폭(m)":"18.86","저수로 폭(m)":"11.02","하상재료(%)":"모래 (66.4), 자갈 (31.2)","대상지 폭(m)":"8","종방향 길이(m)":"165","하폭대비 비율(%)":"29.88","대상지 높이(m)":"0.22"}},{"name":"육역화 9구간","info":{"주소":"충청남도 공주시 사곡면 월가리 966","시점":"충청남도 공주시 사곡면 월가리 1032-2 일원 (3+711)","종점":"충청남도 공주시 사곡면 월가리 1028-1 (3+855)","하폭(m)":"22.52","저수로 폭(m)":"10.55","하상재료(%)":"모래 (89.9), 자갈 (9.4)","대상지 폭(m)":"20","종방향 길이(m)":"145","하폭대비 비율(%)":"3.68","대상지 높이(m)":"-1.09"}},{"name":"육역화 10구간","info":{"주소":"충청남도 공주시 사곡면 월가리 966","시점":"충청남도 공주시 사곡면 월가리 1026-1 일원 (3+929)","종점":"충청남도 공주시 사곡면 월가리 878-6 일원 (4+080)","하폭(m)":"18.56","저수로 폭(m)":"13.88","하상재료(%)":"모래 (89.9), 자갈 (9.4)","대상지 폭(m)":"12","종방향 길이(m)":"150","하폭대비 비율(%)":"50.08","대상지 높이(m)":"-0.02"}},{"name":"육역화 11구간","info":{"주소":"충청남도 공주시 사곡면 월가리 966","시점":"충청남도 공주시 사곡면 월가리 877-1 일원 (4+128)","종점":"충청남도 공주시 사곡면 월가리 1024-1 (4+238)","하폭(m)":"22.93","저수로 폭(m)":"17.83","하상재료(%)":"모래 (89.9), 자갈 (9.4)","대상지 폭(m)":"8","종방향 길이(m)":"110","하폭대비 비율(%)":"55.28","대상지 높이(m)":"0.32"}},{"name":"육역화 12구간","info":{"주소":"충청남도 공주시 사곡면 월가리 966","시점":"충청남도 공주시 사곡면 월가리 966-6 일원 (4+345)","종점":"충청남도 공주시 사곡면 월가리 966-6 일원 (4+382)","하폭(m)":"28.99","저수로 폭(m)":"20.98","하상재료(%)":"모래 (89.9), 자갈 (9.4)","대상지 폭(m)":"13","종방향 길이(m)":"33","하폭대비 비율(%)":"23.04","대상지 높이(m)":"0.45"}},{"name":"육역화 13구간","info":{"주소":"충청남도 공주시 사곡면 월가리 966","시점":"충청남도 공주시 사곡면 월가리 626-3 일원 (4+631)","종점":"충청남도 공주시 사곡면 월가리 626-3 일원 (4+667)","하폭(m)":"26.96","저수로 폭(m)":"11.70","하상재료(%)":"모래 (93.5), 자갈 (5.7)","대상지 폭(m)":"15","종방향 길이(m)":"36","대상지 높이(m)":"0.14"}},{"name":"육역화 14구간","info":{"주소":"충청남도 공주시 사곡면 월가리 966","시점":"충청남도 공주시 사곡면 월가리 316-1 일원 (5+291)","종점":"충청남도 공주시 사곡면 월가리 318-3 (5+510)","하폭(m)":"18.92","저수로 폭(m)":"5.47","하상재료(%)":"모래 (93.5), 자갈 (5.7)","대상지 폭(m)":"13","종방향 길이(m)":"217","대상지 높이(m)":"-0.59"}},{"name":"육역화 15구간","info":{"주소":"충청남도 공주시 사곡면 월가리 966","시점":"충청남도 공주시 사곡면 월가리 302-2 (5+607)","종점":"충청남도 공주시 사곡면 월가리 302-2 (5+650)","하폭(m)":"17.52","저수로 폭(m)":"8.34","하상재료(%)":"모래 (95.6), 자갈 (3.2)","대상지 폭(m)":"9","종방향 길이(m)":"42","하폭대비 비율(%)":"48.81","대상지 높이(m)":"-0.56"}},{"name":"육역화 16구간","info":{"주소":"충청남도 공주시 사곡면 월가리 966","시점":"충청남도 공주시 사곡면 월가리 302-1 (5+778)","종점":"충청남도 공주시 사곡면 유룡리 365-1 (5+887)","하폭(m)":"17.67","저수로 폭(m)":"4.06","하상재료(%)":"모래 (95.6), 자갈 (3.2)","대상지 폭(m)":"11","종방향 길이(m)":"108","하폭대비 비율(%)":"7.85","대상지 높이(m)":"-0.53"}}]},{"name":"제천 하도육역화","tpl":"river","sites":[{"name":"육역화 1구간","info":{"주소":"세종특별자치시 나성동 804-54","시점":"세종특별자치시 나성동 804-54 (1+900)","종점":"세종특별자치시 나성동 804-54 (1+950)","하폭(m)":"87.25","저수로 폭(m)":"33.04","하상재료(%)":"모래 (80.8), 자갈 (19.0)","대상지 폭(m)":"22","종방향 길이(m)":"46","하폭대비 비율(%)":"64.14","대상지 높이(m)":"-0.74"}},{"name":"육역화 2구간","info":{"주소":"세종특별자치시 나성동 696","시점":"세종특별자치시 나성동 696 (2+690)","종점":"세종특별자치시 나성동 696 (2+790)","하폭(m)":"58.99","저수로 폭(m)":"23.26","하상재료(%)":"모래 (65.8), 자갈 (34.0)","대상지 폭(m)":"5","종방향 길이(m)":"100","하폭대비 비율(%)":"58.90","대상지 높이(m)":"0.05"}},{"name":"육역화 3구간","info":{"주소":"세종특별자치시 종촌동 695","시점":"세종특별자치시 종촌동 695 (3+014)","종점":"세종특별자치시 종촌동 691 (3+048)","하폭(m)":"48.09","저수로 폭(m)":"16.26","하상재료(%)":"모래 (65.8), 자갈 (34.0)","대상지 폭(m)":"7","종방향 길이(m)":"34","하폭대비 비율(%)":"38.42","대상지 높이(m)":"0.04"}},{"name":"육역화 4구간","info":{"주소":"세종특별자치시 종촌동 648","시점":"세종특별자치시 달빛1로 74 일원 (3+541)","종점":"세종특별자치시 달빛1로 74 일원 (3+600)","하폭(m)":"43.34","저수로 폭(m)":"16.20","하상재료(%)":"모래 (85.8), 자갈 (13.9)","대상지 폭(m)":"9","종방향 길이(m)":"59","대상지 높이(m)":"0.09"}},{"name":"육역화 5구간","info":{"주소":"세종특별자치시 종촌동 648","시점":"세종특별자치시 달빛1로 74 일원 (3+731)","종점":"세종특별자치시 달빛1로 74 일원 (3+803)","하폭(m)":"47.56","저수로 폭(m)":"18.38","하상재료(%)":"모래 (85.8), 자갈 (13.9)","대상지 폭(m)":"8","종방향 길이(m)":"70","하폭대비 비율(%)":"1.07","대상지 높이(m)":"-0.03"}},{"name":"육역화 6구간","info":{"주소":"세종특별자치시 종촌동 647","시점":"세종특별자치시 종촌동 647 (3+892)","종점":"세종특별자치시 아름동 1346 (4+093)","하폭(m)":"59.61","저수로 폭(m)":"15.13","하상재료(%)":"모래 (85.8), 자갈 (13.9)","대상지 폭(m)":"15","종방향 길이(m)":"135","하폭대비 비율(%)":"92.80","대상지 높이(m)":"0.05"}},{"name":"육역화 7구간","info":{"주소":"세종특별자치시 아름동 1483","시점":"세종특별자치시 달빛1로 131 일원 (4+196)","종점":"세종특별자치시 아름동 1305 일원 (4+665)","하폭(m)":"39.59","저수로 폭(m)":"16.14","하상재료(%)":"모래 (85.8), 자갈 (13.9)","대상지 폭(m)":"10","종방향 길이(m)":"430","하폭대비 비율(%)":"33.05","대상지 높이(m)":"0.02"}},{"name":"육역화 8구간","info":{"주소":"세종특별자치시 아름동 1483","시점":"세종특별자치시 달빛2로 7 일원 (4+739)","종점":"세종특별자치시 아름동 1302 일원 (4+926)","하폭(m)":"38.77","저수로 폭(m)":"16.50","하상재료(%)":"모래 (93.6), 자갈 (6.2)","대상지 폭(m)":"10","종방향 길이(m)":"185","하폭대비 비율(%)":"77.90","대상지 높이(m)":"-0.12"}},{"name":"육역화 9구간","info":{"주소":"세종특별자치시 아름동 1483","시점":"세종특별자치시 아름동 1483 (5+063)","종점":"세종특별자치시 아름동 1483 (5+123)","하폭(m)":"38.67","저수로 폭(m)":"15.01","하상재료(%)":"모래 (93.6), 자갈 (6.2)","대상지 폭(m)":"4","종방향 길이(m)":"60","하폭대비 비율(%)":"62.40","대상지 높이(m)":"-0.32"}},{"name":"육역화 10구간","info":{"주소":"세종특별자치시 아름동 1483","시점":"세종특별자치시 아름동 811 일원 (5+245)","종점":"세종특별자치시 아름동 809 일원 (5+501)","하폭(m)":"39.37","저수로 폭(m)":"14.65","하상재료(%)":"모래 (93.6), 자갈 (6.2)","대상지 폭(m)":"9","종방향 길이(m)":"256","하폭대비 비율(%)":"81.30","대상지 높이(m)":"-0.01"}}]}];
// 현장(구간 목록)을 추가하거나, 같은 이름 현장이 있으면 구간 정보만 새로 고침
async function applyPreset(d) {
  let p = projects.find((x) => x.name === d.name);
  if (!p) { p = { id: uid(), name: d.name, created: Date.now(), fields: [...(TEMPLATES[d.tpl] || TEMPLATES.river)], sites: [] }; projects.push(p); }
  p.sites ||= [];
  for (const s of d.sites) { const e = p.sites.find((x) => x.name === s.name); if (e) { e.info = s.info; delete e.geo; } else p.sites.push({ name: s.name, values: {}, info: s.info }); }
  await dbPut('projects', p);
  return p;
}
function renderPresetBtns() {
  const box = $('#presetBox'), left = PRESETS.filter((d) => !projects.some((p) => p.name === d.name));
  box.hidden = !left.length;
  box.innerHTML = left.map((d, i) => `<button type="button" class="item" data-i="${PRESETS.indexOf(d)}"><span class="nm">＋ ${esc(d.name)}</span><span class="muted">${d.sites.length}구간</span></button>`).join('');
}
$('#presetBox').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-i]'); if (!b) return;
  const p = await applyPreset(PRESETS[+b.dataset.i]);
  await loadProject(p.id); $('#prjDlg').close();
  document.querySelector('.tabs [data-tab=site]').click();
  toast(`"${p.name}" 구간 ${p.sites.length}개를 넣었습니다`);
});

// ---------- 링크로 구간 불러오기 (#import=...) ----------
// 구간 정보는 링크의 # 뒤에만 들어 있어 서버로 전송되지 않음
async function importCode(code) {
  const m = String(code).match(/import=([\w-]+)/) || String(code).trim().match(/^([\w-]{40,})$/);
  if (!m) return toast('불러오기 링크가 아닙니다');
  try {
    const b = Uint8Array.from(atob(m[1].replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
    const d = JSON.parse(await new Response(new Blob([b]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).text());
    const had = projects.some((x) => x.name === d.name);
    if (!confirm(had ? `"${d.name}" 현장에 구간 ${d.sites.length}개를 넣을까요?\n(이미 있는 구간은 도상 정보만 새로 고침, 입력한 값과 사진은 그대로)`
                     : `"${d.name}" 현장을 만들고 구간 ${d.sites.length}개를 넣을까요?`)) return;
    const p = await applyPreset(d); await loadProject(p.id);
    if ($('#prjDlg').open) $('#prjDlg').close();
    document.querySelector('.tabs [data-tab=site]').click();
    toast(`"${d.name}" 구간 ${d.sites.length}개를 불러왔습니다`, 3500);
  } catch (e) { console.error(e); toast('불러오기 실패: ' + e.message, 5000); }
}
async function importFromHash() {
  if (!location.hash.startsWith('#import=')) return;
  const h = location.hash; history.replaceState(null, '', location.pathname + location.search);
  await importCode(h);
}
window.addEventListener('hashchange', importFromHash);

// ---------- 시작 ----------
(async () => {
  try {
    projects = await dbAll('projects');
    for (const p of projects) {           // 하도형태 및 지형은 직접 채우므로 항목에서 뺌
      if (p.fields?.some((f) => f.startsWith('하도형태'))) { p.fields = p.fields.filter((f) => !f.startsWith('하도형태')); await dbPut('projects', p); }
    }
    await loadProject(projects.find((p) => p.id === S.project)?.id || projects.sort((a, b) => b.created - a.created)[0]?.id);
    if (!projects.length) {               // 처음 열면 명하천·제천 현장을 바로 넣어 둠
      for (const d of PRESETS) await applyPreset(d);
      await loadProject(projects[0].id);
    }
    if (location.hash.startsWith('#import=')) await importFromHash();
  } catch (e) { console.error(e); toast('저장소를 열 수 없습니다: ' + e.message, 6000); }
  startGps();
  if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});
})();
