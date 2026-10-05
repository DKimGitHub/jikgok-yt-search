// Ctrl-F search over transcript segments. File formats: ingest/build_search.py.
// A query matches a ~25 s segment when its characters appear there consecutively,
// ignoring spaces, punctuation and case. Deterministic: no ranking guesses.
const BI_SHARDS = 4096;
const UNI_SHARDS = 512;
const BASE = new URL("search/", import.meta.url);
const WORD = /[\p{L}\p{N}_]/u;

/** Characters that count for matching (keep in sync with build_search.normalize). */
export function normalize(text) {
  let out = "";
  for (const ch of text.toLowerCase()) if (WORD.test(ch)) out += ch;
  return out;
}

function shardOf(c1, c2, n) { // FNV-1a over both code points, 4 bytes each, little-endian
  let h = 0x811c9dc5;
  for (const v of [c1, c2]) {
    for (let i = 0; i < 4; i++) {
      h ^= (v >>> (8 * i)) & 0xff;
      h = Math.imul(h, 0x01000193) >>> 0;
    }
  }
  return h % n;
}

const shardCache = new Map();
function loadShard(kind, i, width) {
  const path = `${kind}/${String(i).padStart(width, "0")}.bin`;
  if (!shardCache.has(path)) {
    shardCache.set(path, fetch(new URL(path, BASE)).then((r) => r.arrayBuffer()).then((buf) => {
      const dv = new DataView(buf);
      const count = dv.getUint32(0, true);
      const dataStart = 4 + count * 16;
      const index = new Map();
      for (let e = 0; e < count; e++) {
        const o = 4 + e * 16;
        index.set(`${dv.getUint32(o, true)},${dv.getUint32(o + 4, true)}`,
          new Uint8Array(buf, dataStart + dv.getUint32(o + 8, true), dv.getUint32(o + 12, true)));
      }
      return index;
    }));
  }
  return shardCache.get(path);
}

async function postings(c1, c2) {
  const bigram = c2 !== 0;
  const n = bigram ? BI_SHARDS : UNI_SHARDS;
  const index = await loadShard(bigram ? "bi" : "uni", shardOf(c1, c2, n), String(n - 1).length);
  return index.get(`${c1},${c2}`) || new Uint8Array(0);
}

function* varints(bytes) {
  let n = 0, shift = 0;
  for (const b of bytes) {
    n += (b & 0x7f) * 2 ** shift;
    if (b & 0x80) shift += 7;
    else { yield n; n = 0; shift = 0; }
  }
}

/** Bigram postings -> Map(segment -> Set(positions)). */
function decodeBigram(bytes) {
  const out = new Map();
  const it = varints(bytes);
  let seg = -1;
  for (let d = it.next(); !d.done; d = it.next()) {
    seg += d.value;
    const n = it.next().value;
    const pos = new Set();
    let p = 0;
    for (let k = 0; k < n; k++) { p += it.next().value; pos.add(p); }
    out.set(seg, pos);
  }
  return out;
}

let segTable = null;
/** segment -> video index and start second; video index -> YouTube id. */
export function loadSegments() {
  segTable ??= Promise.all([
    fetch(new URL("segs.bin", BASE)).then((r) => r.arrayBuffer()),
    fetch(new URL("videos.json", BASE)).then((r) => r.json()),
  ]).then(([buf, ids]) => {
    const count = new DataView(buf).getUint32(0, true);
    const startOffset = 4 + count * 2 + ((4 - ((4 + count * 2) % 4)) % 4);
    return { video: new Uint16Array(buf, 4, count), start: new Uint32Array(buf, startOffset, count), ids };
  });
  return segTable;
}

/** Segment ids (ascending) whose text contains the query. [] when nothing matches. */
export async function findSegments(query) {
  const q = [...normalize(query)].map((c) => c.codePointAt(0));
  if (!q.length) return [];
  if (q.length === 1) {
    const out = [];
    let seg = -1;
    for (const d of varints(await postings(q[0], 0))) out.push((seg += d));
    return out;
  }
  // Bigrams at offsets 0, 2, 4, ... and the last one overlap to cover every character.
  const offsets = [];
  for (let i = 0; i < q.length - 1; i += 2) offsets.push(i);
  if (offsets.at(-1) !== q.length - 2) offsets.push(q.length - 2);
  const lists = (await Promise.all(offsets.map((o) => postings(q[o], q[o + 1]))))
    .map((bytes, i) => ({ off: offsets[i], map: decodeBigram(bytes) }));
  lists.sort((a, b) => a.map.size - b.map.size);
  const [first, ...rest] = lists;
  const out = [];
  for (const [seg, positions] of first.map) {
    const others = rest.map((l) => l.map.get(seg));
    if (others.some((p) => !p)) continue;
    for (const p of positions) {
      const start = p - first.off;
      if (rest.every((l, k) => others[k].has(start + l.off))) { out.push(seg); break; }
    }
  }
  return out.sort((a, b) => a - b);
}

const textCache = new Map();
/** [[start, text], ...] for one video. */
export function loadText(vid) {
  if (!textCache.has(vid)) textCache.set(vid, fetch(new URL(`t/${vid}.json`, BASE)).then((r) => r.json()));
  return textCache.get(vid);
}

/** HTML of `text` with every occurrence of the (normalized) query wrapped in <mark>. */
export function markMatches(text, nq, escape) {
  if (!nq) return escape(text);
  const chars = [...text];
  let norm = "";
  const owner = []; // UTF-16 index in `norm` -> index in `chars`
  chars.forEach((ch, i) => {
    for (const lc of ch.toLowerCase()) {
      if (!WORD.test(lc)) continue;
      norm += lc;
      for (let k = 0; k < lc.length; k++) owner.push(i);
    }
  });
  let html = "", last = 0, from = 0, at;
  while ((at = norm.indexOf(nq, from)) !== -1) {
    const s = owner[at], e = owner[at + nq.length - 1] + 1;
    if (s >= last) {
      html += escape(chars.slice(last, s).join("")) + `<mark>${escape(chars.slice(s, e).join(""))}</mark>`;
      last = e;
    }
    from = at + 1;
  }
  return html + escape(chars.slice(last).join(""));
}
