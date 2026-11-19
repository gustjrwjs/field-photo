'use strict';
// 브라우저 안에서 한글 현장조사표(HWPX)를 채움 — 설치 프로그램 없이 PC 브라우저에서 동작
// 양식: 구간마다 "(현장조사)" 11칸 = 하도형태(건너뜀) + 식생 8칸 + 사진 설명 2칸, 사진 칸 2개
const HWPX = (() => {
  const td = new TextDecoder(), te = new TextEncoder();
  const ORDER = [null, '초본류', '교목류', '관목류', '식생 분포 형태(목본류)', '식생 밀생정도', '평균 수고(m)', '흉고직경(cm)', '수관폭(m)'];
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

  // template: 양식 HWPX(ArrayBuffer), data: 보고서.json 내용, photoOf(site, slot) → Blob|null
  async function fill(template, data, photoOf, progress = () => {}) {
    const files = await unzip(template);
    const get = (n) => files.find((f) => f.name === n);
    const secF = get('Contents/section0.xml'), headF = get('Contents/header.xml'), hpfF = get('Contents/content.hpf');
    if (!secF || !headF || !hpfF) throw new Error('한글 HWPX 양식이 아닙니다');
    let sec = td.decode(secF.data), head = td.decode(headF.data), hpf = td.decode(hpfF.data);

    const RUN = /<hp:run charPrIDRef="(\d+)"><hp:t>\(현장조사\)<\/hp:t><\/hp:run>(<hp:linesegarray>[\s\S]*?<\/hp:linesegarray>)?/g;
    const total = (sec.match(RUN) || []).length;
    if (!total || total % 11) throw new Error(`이 양식의 (현장조사) 칸이 ${total}개라 맞지 않습니다. 아직 안 채운 원본 양식이어야 합니다.`);
    const nsec = total / 11;

    // 빨간 "(현장조사)" 글자 모양을 복사해 검은 글자 모양을 하나 추가
    const red = sec.match(/<hp:run charPrIDRef="(\d+)"><hp:t>\(현장조사\)/)[1];
    const redXml = head.match(new RegExp(`<hh:charPr id="${red}"[\\s\\S]*?</hh:charPr>`))[0];
    const black = Math.max(...[...head.matchAll(/<hh:charPr id="(\d+)"/g)].map((m) => +m[1])) + 1;
    // 글자 모양은 순서대로 번호가 매겨지므로 반드시 목록 맨 끝에 추가
    head = head.replace('</hh:charProperties>', redXml.replace(`id="${red}"`, `id="${black}"`).replace(/textColor="#[0-9A-Fa-f]{6}"/, 'textColor="#000000"') + '</hh:charProperties>')
      .replace(/(<hh:charProperties itemCnt=")(\d+)/, (a, b, c) => b + (+c + 1));

    const bySec = new Map((data.sites || []).map((s) => [+s.section, s]));
    const missing = new Map();
    const miss = (secNo, what) => { if (bySec.has(secNo)) missing.set(secNo, [...(missing.get(secNo) || []), what]); };
    let i = 0, nText = 0;
    sec = sec.replace(RUN, (m) => {
      const secNo = Math.floor(i / 11) + 1, slot = i % 11; i++;
      const s = bySec.get(secNo);
      let v = '';
      if (slot === 0) return m;                                       // 하도형태 및 지형: 직접 채움
      if (slot <= 8) {
        const f = ORDER[slot]; v = s?.values?.[f] ? String(s.values[f]).trim() : '';
        if (v && UNIT[f] && /^[\d.\s~\-]+$/.test(v)) v += UNIT[f];
        if (!v) { miss(secNo, f); return m; }
      } else {
        const ph = s?.['photo' + (slot - 8)]; v = ph?.caption || '';
        if (!v) { miss(secNo, '사진' + (slot - 8)); return m; }
      }
      nText++;
      return `<hp:run charPrIDRef="${black}"><hp:t>${xesc(v)}</hp:t></hp:run>`;   // 줄 배치 정보는 빼서 한글이 다시 계산
    });

    // 사진 칸: 첫 두 사진이 쓰는 그림(예시 사진)을 쓰는 개체들 = 구간별 사진1·사진2
    const pics = [...sec.matchAll(/<hp:pic\b[\s\S]*?<\/hp:pic>/g)];
    const refOf = (x) => (x.match(/binaryItemIDRef="([^"]*)"/) || [])[1];
    const slotRefs = pics.length >= 2 ? [refOf(pics[0][0]), refOf(pics[1][0])] : [];
    const slotPics = pics.filter((p) => slotRefs.includes(refOf(p[0])));
    const newBins = [];
    let nPic = 0;
    if (slotPics.length === nsec * 2) {
      const repl = new Map();
      for (let k = 0; k < slotPics.length; k++) {
        const secNo = Math.floor(k / 2) + 1, slot = (k % 2) + 1, s = bySec.get(secNo);
        progress(`사진 넣는 중… ${secNo}구간`);
        const blob = s && s['photo' + slot] ? await photoOf(s, slot) : null;
        if (!blob) continue;
        const xml = slotPics[k][0], cur = xml.match(/<hp:curSz width="(\d+)" height="(\d+)"/);
        const img = await cropJpeg(blob, +cur[1] / +cur[2]);
        const id = `fp${secNo}_${slot}`;
        newBins.push({ name: `BinData/${id}.jpg`, data: img.data, id });
        repl.set(slotPics[k].index, rewritePic(xml, id, img.W, img.H));
        nPic++;
      }
      // 뒤에서부터 바꿔야 위치가 안 밀림
      for (const [idx, xml] of [...repl].sort((a, b) => b[0] - a[0])) {
        const old = sec.slice(idx).match(/<hp:pic\b[\s\S]*?<\/hp:pic>/)[0];
        sec = sec.slice(0, idx) + xml + sec.slice(idx + old.length);
      }
    }

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
