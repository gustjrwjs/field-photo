'use strict';
// 브라우저 안에서 한글 현장조사표(HWPX)를 채움 — 설치 프로그램 없이 PC 브라우저에서 동작
// 양식: 구간마다 표 1개 — 식생 8칸(이름 칸 아래), 현장사진 2칸 + 설명 2칸. 빈 칸만 채움(예전 양식의 빨간 "(현장조사)" 칸도 지원)
const HWPX = (() => {
  const td = new TextDecoder(), te = new TextEncoder();
  const UNIT = { '평균 수고(m)': 'm', '흉고직경(cm)': 'cm', '수관폭(m)': 'm' };
  const xesc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  async function inflate(u8) {
    return new Uint8Array(await new Response(new Blob([u8]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer());
  }
  // ZIP 읽기 (무압축·deflate)
  async function unzip(buf) {
    const u8 = new Uint8Array(buf), dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    let e = u8.length - 22;
    while (e >= 0 && dv.getUint32(e, true) !== 0x06054b50) e--;
    if (e < 0) throw new Error('ZIP 파일이 아닙니다');
    const n = dv.getUint16(e + 10, true), out = [];
    let p = dv.getUint32(e + 16, true);
    for (let i = 0; i < n; i++) {
      const method = dv.getUint16(p + 10, true), csize = dv.getUint32(p + 20, true);
      const nlen = dv.getUint16(p + 28, true), xlen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true), off = dv.getUint32(p + 42, true);
      const name = td.decode(u8.subarray(p + 46, p + 46 + nlen));
      const start = off + 30 + dv.getUint16(off + 26, true) + dv.getUint16(off + 28, true);
      const raw = u8.subarray(start, start + csize);
      if (method !== 0 && method !== 8) throw new Error('지원하지 않는 압축 방식: ' + name);
      if (!name.endsWith('/')) out.push({ name, data: method === 0 ? raw.slice() : await inflate(raw) });
      p += 46 + nlen + xlen + clen;
    }
    return out;
  }

  // 사진을 칸 비율의 JPEG로 (자르지 않고 축소·가운데 맞춤)
  async function cropJpeg(blob, ratio, maxW = 1600) {
    const url = URL.createObjectURL(blob), img = new Image();
    try { await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url; }); }
    finally { setTimeout(() => URL.revokeObjectURL(url), 0); }
    // 자르지 않음: 사진 전체를 칸 비율의 흰 바탕 안에 들어가게 축소해서 가운데에 놓음
    const w = img.naturalWidth, h = img.naturalHeight;
    const W = maxW, H = Math.round(W / ratio), k = Math.min(W / w, H / h);
    const dw = Math.round(w * k), dh = Math.round(h * k);
    const c = document.createElement('canvas'); c.width = W; c.height = H;
    const g = c.getContext('2d');
    g.fillStyle = '#fff'; g.fillRect(0, 0, W, H);
    g.imageSmoothingQuality = 'high';
    g.drawImage(img, 0, 0, w, h, Math.round((W - dw) / 2), Math.round((H - dh) / 2), dw, dh);
    const out = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.88));
    return { data: new Uint8Array(await out.arrayBuffer()), W, H };
  }

  // 사진 개체(hp:pic)를 새 그림으로 바꿈: 칸 크기(curSz)는 그대로, 그림 정보만 새로
  function rewritePic(xml, id, Wpx, Hpx) {
    const W = Wpx * 75, H = Hpx * 75;   // 1px = 75 HWPUNIT (96dpi)
    const cur = xml.match(/<hp:curSz width="(\d+)" height="(\d+)"/), cw = +cur[1], chh = +cur[2];
    return xml
      .replace(/binaryItemIDRef="[^"]*"/, `binaryItemIDRef="${id}"`)
      .replace(/<hp:orgSz [^>]*\/>/, `<hp:orgSz width="${W}" height="${H}"/>`)
      .replace(/<hp:imgRect>[\s\S]*?<\/hp:imgRect>/, `<hp:imgRect><hc:pt0 x="0" y="0"/><hc:pt1 x="${W}" y="0"/><hc:pt2 x="${W}" y="${H}"/><hc:pt3 x="0" y="${H}"/></hp:imgRect>`)
      .replace(/<hp:imgClip [^>]*\/>/, `<hp:imgClip left="0" right="${W}" top="0" bottom="${H}"/>`)
      .replace(/<hp:imgDim [^>]*\/>/, `<hp:imgDim dimwidth="${W}" dimheight="${H}"/>`)
      .replace(/<hc:scaMatrix e1="[^"]*"( e2="[^"]*" e3="[^"]*" e4="[^"]*") e5="[^"]*"/, `<hc:scaMatrix e1="${(cw / W).toFixed(6)}"$1 e5="${(chh / H).toFixed(6)}"`)
      .replace(/<hp:shapeComment>[\s\S]*?<\/hp:shapeComment>/, '<hp:shapeComment>현장사진</hp:shapeComment>');
  }

  // 칸 이름 → 앱 항목. 값은 이름 칸 바로 아래 칸(같은 열, 다음 행)에 들어감
  const LABEL = { '초본류': '초본류', '교목류': '교목류', '관목류': '관목류', '식생 분포 형태(목본류)': '식생 분포 형태(목본류)',
    '식생 밀생정도': '식생 밀생정도', '평균 수고': '평균 수고(m)', '흉고직경': '흉고직경(cm)', '수관폭': '수관폭(m)' };
  const MARK = '(현장조사)';   // 예전 양식의 빨간 표시 — 빈 칸처럼 취급

  // 여는/닫는 태그 짝 찾기 (표 안에 표가 있어도 맞게)
  function ranges(s, open, close, from = 0, to = s.length) {
    const re = new RegExp(`<${open}\\b|</${open}>`, 'g'), out = [], st = [];
    re.lastIndex = from;
    for (let m; (m = re.exec(s)) && m.index < to;) {
      if (m[0][1] !== '/') st.push(m.index);
      else { const a = st.pop(); out.push({ a, b: m.index + close.length, depth: st.length }); }
    }
    return out.sort((x, y) => x.a - y.a);
  }
  const textOf = (x) => [...x.matchAll(/<hp:t>([^<]*)<\/hp:t>/g)].map((m) => m[1]).join('').replace(/&amp;/g, '&').trim();

  // 구간 표: "식생 종류"가 들어 있는 표 (문서 순서 = 1구간, 2구간 …)
  function sectionTables(sec) {
    const all = ranges(sec, 'hp:tbl', '</hp:tbl>').filter((t) => sec.slice(t.a, t.b).includes('>식생 종류<'));
    return all.filter((t) => !all.some((u) => u !== t && u.a > t.a && u.b < t.b));   // 가장 안쪽 표만
  }
  function cellsOf(sec, t) {
    const list = ranges(sec, 'hp:tc', '</hp:tc>', t.a, t.b);
    const top = Math.min(...list.map((c) => c.depth));
    return list.filter((c) => c.depth === top).map((c) => {
      const x = sec.slice(c.a, c.b);
      const ad = [...x.matchAll(/<hp:cellAddr colAddr="(\d+)" rowAddr="(\d+)"\/>/g)].pop();
      const sz = [...x.matchAll(/<hp:cellSz width="(\d+)" height="(\d+)"\/>/g)].pop();
      return { a: c.a, b: c.b, x, col: +ad[1], row: +ad[2], w: +sz[1], h: +sz[2], text: textOf(x) };
    });
  }

  // 새 그림 개체 (글자처럼 취급, 칸 크기에 맞춤)
  function newPic(id, Wpx, Hpx, cw, ch, z, pid) {
    const W = Wpx * 75, H = Hpx * 75;
    return `<hp:pic id="${pid}" zOrder="${z}" numberingType="NONE" textWrap="TOP_AND_BOTTOM" textFlow="BOTH_SIDES" lock="0" dropcapstyle="None" href="" groupLevel="0" instid="${pid + 1}" reverse="0">` +
      `<hp:offset x="0" y="0"/><hp:orgSz width="${W}" height="${H}"/><hp:curSz width="${cw}" height="${ch}"/><hp:flip horizontal="0" vertical="0"/>` +
      `<hp:rotationInfo angle="0" centerX="${cw >> 1}" centerY="${ch >> 1}" rotateimage="1"/><hp:renderingInfo><hc:transMatrix e1="1" e2="0" e3="0" e4="0" e5="1" e6="0"/>` +
      `<hc:scaMatrix e1="${(cw / W).toFixed(6)}" e2="0" e3="0" e4="0" e5="${(ch / H).toFixed(6)}" e6="0"/><hc:rotMatrix e1="1" e2="0" e3="0" e4="0" e5="1" e6="0"/></hp:renderingInfo>` +
      `<hc:img binaryItemIDRef="${id}" bright="0" contrast="0" effect="REAL_PIC" alpha="0"/>` +
      `<hp:imgRect><hc:pt0 x="0" y="0"/><hc:pt1 x="${W}" y="0"/><hc:pt2 x="${W}" y="${H}"/><hc:pt3 x="0" y="${H}"/></hp:imgRect>` +
      `<hp:imgClip left="0" right="${W}" top="0" bottom="${H}"/><hp:inMargin left="0" right="0" top="0" bottom="0"/><hp:imgDim dimwidth="${W}" dimheight="${H}"/><hp:effects/>` +
      `<hp:sz width="${cw}" widthRelTo="ABSOLUTE" height="${ch}" heightRelTo="ABSOLUTE"/>` +
      `<hp:pos treatAsChar="1" affectLSpacing="0" flowWithText="1" allowOverlap="0" holdAnchorAndSO="0" vertRelTo="PARA" horzRelTo="PARA" vertAlign="TOP" horzAlign="LEFT" vertOffset="0" horzOffset="0"/>` +
      `<hp:outMargin left="0" right="0" top="0" bottom="0"/><hp:shapeComment>현장사진</hp:shapeComment></hp:pic>`;
  }

  // template: 양식 HWPX(ArrayBuffer), data: 보고서.json 내용, photoOf(site, slot) → Blob|null
  // 양식: 구간마다 표 1개. 빈 칸(또는 예전 양식의 빨간 "(현장조사)" 칸)만 채우고, 이미 글이 있는 칸은 건드리지 않음
  async function fill(template, data, photoOf, progress = () => {}) {
    const files = await unzip(template);
    const get = (n) => files.find((f) => f.name === n);
    const secF = get('Contents/section0.xml'), headF = get('Contents/header.xml'), hpfF = get('Contents/content.hpf');
    if (!secF || !headF || !hpfF) throw new Error('한글 HWPX 양식이 아닙니다');
    let sec = td.decode(secF.data), head = td.decode(headF.data), hpf = td.decode(hpfF.data);

    const tables = sectionTables(sec), nsec = tables.length;
    if (!nsec) throw new Error('이 양식에서 구간 조사표(“식생 종류” 표)를 찾지 못했습니다.');

    // 채울 글자는 칸의 글자 모양을 쓰되, 검정이 아니면 검정 사본을 목록 맨 끝에 추가 (중간에 넣으면 번호가 밀려 서식이 깨짐)
    const blackCache = new Map();
    let nextChar = Math.max(...[...head.matchAll(/<hh:charPr id="(\d+)"/g)].map((m) => +m[1])) + 1;
    const blackOf = (id) => {
      if (blackCache.has(id)) return blackCache.get(id);
      const xml = head.match(new RegExp(`<hh:charPr id="${id}"[\\s\\S]*?</hh:charPr>`))?.[0];
      let out = id;
      if (xml && !/textColor="#000000"/.test(xml)) {
        out = String(nextChar++);
        head = head.replace('</hh:charProperties>', xml.replace(`id="${id}"`, `id="${out}"`).replace(/textColor="#[0-9A-Fa-f]{6}"/, 'textColor="#000000"') + '</hh:charProperties>')
          .replace(/(<hh:charProperties itemCnt=")(\d+)/, (a, b, c) => b + (+c + 1));
      }
      blackCache.set(id, out); return out;
    };
    // 칸에 글자 넣기: 빈 run 또는 "(현장조사)" run을 바꿈. 줄 배치 정보는 지워서 한글이 다시 계산
    const putText = (x, v) => {
      const re = /<hp:run charPrIDRef="(\d+)"(?:\/>|><hp:t\/><\/hp:run>|><hp:t>\(현장조사\)<\/hp:t><\/hp:run>)/;
      const m = x.match(re); if (!m) return null;
      return x.replace(re, `<hp:run charPrIDRef="${blackOf(m[1])}"><hp:t>${xesc(v)}</hp:t></hp:run>`).replace(/<hp:linesegarray>[\s\S]*?<\/hp:linesegarray>/g, '');
    };
    const empty = (c) => !c.text || c.text === MARK;

    const bySec = new Map((data.sites || []).map((s) => [+s.section, s]));
    const missing = new Map();
    const miss = (secNo, what) => { if (bySec.has(secNo)) missing.set(secNo, [...(missing.get(secNo) || []), what]); };
    const edits = [], newBins = [];
    let nText = 0, nPic = 0;
    let z = Math.max(0, ...[...sec.matchAll(/zOrder="(\d+)"/g)].map((m) => +m[1])) + 1;
    const pidBase = 1500000000 + Math.floor(Math.random() * 400000000);

    for (let ti = 0; ti < nsec; ti++) {
      const secNo = ti + 1, s = bySec.get(secNo), cells = cellsOf(sec, tables[ti]);
      const at = (r, c) => cells.find((x) => x.row === r && x.col === c);
      // 식생 8칸
      for (const [label, f] of Object.entries(LABEL)) {
        const lc = cells.find((c) => c.text === label);
        const vc = lc && at(lc.row + 1, lc.col);
        if (!vc) throw new Error(`${secNo}구간 표에서 "${label}" 칸을 찾지 못했습니다. 양식이 바뀌었으면 알려 주세요.`);
        if (!empty(vc)) continue;                                   // 이미 적힌 칸은 그대로
        let v = s?.values?.[f] ? String(s.values[f]).trim() : '';
        if (v && UNIT[f] && /^[\d.\s~\-]+$/.test(v)) v += UNIT[f];
        if (!v) { miss(secNo, f); continue; }
        const nx = putText(vc.x, v); if (!nx) continue;
        edits.push({ a: vc.a, b: vc.b, x: nx }); nText++;
      }
      // 현장사진: 제목 칸 아래 줄 = 사진 2칸, 그 아래 줄 = 설명 2칸
      const hc = cells.find((c) => c.text.replace(/\s/g, '') === '4.현장사진');
      if (!hc) throw new Error(`${secNo}구간 표에서 "4. 현장사진" 칸을 찾지 못했습니다.`);
      const row = (r) => cells.filter((c) => c.row === r).sort((a, b) => a.col - b.col);
      const picCells = row(hc.row + 1), capCells = row(hc.row + 2);
      for (let k = 0; k < 2; k++) {
        const slot = k + 1, ph = s?.['photo' + slot];
        const cc = capCells[k];
        if (cc && empty(cc)) {
          const v = ph?.caption || '';
          if (!v) miss(secNo, '사진' + slot + ' 설명');
          else { const nx = putText(cc.x, v); if (nx) { edits.push({ a: cc.a, b: cc.b, x: nx }); nText++; } }
        }
        const pc = picCells[k];
        if (!pc) continue;
        progress(`사진 넣는 중… ${secNo}구간`);
        const blob = ph ? await photoOf(s, slot) : null;
        if (!blob) { miss(secNo, '사진' + slot); continue; }
        const old = pc.x.match(/<hp:pic\b[\s\S]*?<\/hp:pic>/);
        const id = `fp${secNo}_${slot}`;
        let nx;
        if (old) {                                                   // 예전 양식: 예시 그림을 바꿔 끼움
          const cur = old[0].match(/<hp:curSz width="(\d+)" height="(\d+)"/);
          const img = await cropJpeg(blob, +cur[1] / +cur[2]);
          newBins.push({ name: `BinData/${id}.jpg`, data: img.data, id });
          nx = pc.x.replace(old[0], rewritePic(old[0], id, img.W, img.H));
        } else {                                                     // 새 양식: 빈 칸에 그림을 새로 넣음
          const cw = pc.w - 1020, ch = pc.h - 432;
          const img = await cropJpeg(blob, cw / ch);
          const m = pc.x.match(/<hp:run charPrIDRef="(\d+)"(?:\/>|><hp:t\/><\/hp:run>)/);
          if (!m) continue;
          newBins.push({ name: `BinData/${id}.jpg`, data: img.data, id });
          nx = pc.x.replace(m[0], `<hp:run charPrIDRef="${m[1]}">${newPic(id, img.W, img.H, cw, ch, z++, pidBase + nPic * 2)}<hp:t/></hp:run>`)
            .replace(/<hp:linesegarray>[\s\S]*?<\/hp:linesegarray>/g, '');
        }
        edits.push({ a: pc.a, b: pc.b, x: nx }); nPic++;
      }
    }
    // 뒤에서부터 바꿔야 위치가 안 밀림
    for (const e of edits.sort((p, q) => q.a - p.a)) sec = sec.slice(0, e.a) + e.x + sec.slice(e.b);

    // 새 그림 등록, 더 안 쓰는 예시 그림은 빼서 용량 줄이기
    hpf = hpf.replace('</opf:manifest>', newBins.map((b) => `<opf:item id="${b.id}" href="${b.name}" media-type="image/jpg" isEmbeded="1"/>`).join('') + '</opf:manifest>');
    const others = files.filter((f) => /^Contents\/(masterpage|header)/.test(f.name)).map((f) => f === headF ? head : td.decode(f.data)).join('');
    const unused = [...hpf.matchAll(/<opf:item id="([^"]+)" href="(BinData\/[^"]+)"[^>]*\/>/g)]
      .filter(([, id]) => !sec.includes(`binaryItemIDRef="${id}"`) && !others.includes(`"${id}"`));
    for (const [tag] of unused) hpf = hpf.replace(tag, '');
    const drop = new Set(unused.map((u) => u[2]));

    secF.data = te.encode(sec); headF.data = te.encode(head); hpfF.data = te.encode(hpf);
    const outFiles = files.filter((f) => !drop.has(f.name));
    const mi = outFiles.findIndex((f) => f.name === 'mimetype');
    if (mi > 0) outFiles.unshift(outFiles.splice(mi, 1)[0]);            // mimetype은 맨 앞
    outFiles.push(...newBins.map(({ name, data }) => ({ name, data })));
    return { blob: makeZip(outFiles), nsec, nText, nPic, missing };
  }

  return { unzip, fill };
})();
