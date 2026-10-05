"""Step 4: build the Ctrl-F search index into site/search/ (runs in CI on every deploy).

Search is literal substring matching inside ~25 s transcript segments, ignoring
spaces, punctuation and case ("참나각성" also finds "참나 각성"). To answer that
without downloading every transcript, we index character pairs with positions:

  search/bi/NNNN.bin   bigram  -> [(segment, [positions...]), ...]   (exact phrase check)
  search/uni/NNN.bin   char    -> [segment, ...]                      (1-character queries)
  search/segs.bin      segment -> (video index, start second)
  search/videos.json   video index -> YouTube id
  search/t/<id>.json   [[start, text], ...] display text, fetched for result snippets

A query of n characters downloads only the shards of its bigrams, then keeps a
segment if those bigrams line up at consecutive positions: an exact match.

Shard file layout (little-endian):
  uint32 count; count x (uint32 c1, uint32 c2, uint32 offset, uint32 length); data
Postings are varints: bigram = (segment delta, n, position deltas...),
unigram = (segment delta). Must stay in sync with site/search.js.
"""
import json
import shutil
import struct

from chunk import chunk
from common import SITE, STATE_FILE, TRANSCRIPTS, VIDEOS_FILE, load_json

BI_SHARDS = 4096
UNI_SHARDS = 512
OUT = SITE / "search"


def normalize(text):
    """Characters that count for matching (keep in sync with search.js)."""
    return "".join(c for c in text.lower() if c.isalnum() or c == "_")


def shard_of(c1, c2, n):
    """FNV-1a over the two code points (c2 = 0 for unigrams)."""
    h = 0x811C9DC5
    for v in (c1, c2):
        for b in v.to_bytes(4, "little"):
            h = ((h ^ b) * 0x01000193) & 0xFFFFFFFF
    return h % n


def varint(n, out):
    while n >= 0x80:
        out.append((n & 0x7F) | 0x80)
        n >>= 7
    out.append(n)


def write_shards(table, n_shards, folder):
    """table: {(c1, c2): bytearray of postings} -> n_shards binary files."""
    shards = [[] for _ in range(n_shards)]
    for key, data in table.items():
        shards[shard_of(*key, n_shards)].append((key, data))
    folder.mkdir(parents=True, exist_ok=True)
    width = len(str(n_shards - 1))
    for i, entries in enumerate(shards):
        entries.sort()
        head = bytearray(struct.pack("<I", len(entries)))
        offset = 0
        for (c1, c2), data in entries:
            head += struct.pack("<IIII", c1, c2, offset, len(data))
            offset += len(data)
        (folder / f"{i:0{width}d}.bin").write_bytes(bytes(head) + b"".join(d for _, d in entries))


def main():
    videos = load_json(VIDEOS_FILE, [])
    state = load_json(STATE_FILE, {})
    if OUT.exists():
        shutil.rmtree(OUT)
    (OUT / "t").mkdir(parents=True)

    bi, uni = {}, {}            # key -> [last segment id, bytearray]
    seg_video, seg_start, vids = bytearray(), bytearray(), []
    seg = 0
    for v in videos:
        if state.get(v["id"], {}).get("status") != "done":
            continue
        tr = load_json(TRANSCRIPTS / f"{v['id']}.json", None)
        segs = chunk(tr["cues"]) if tr else []
        if not segs:
            continue
        vidx = len(vids)
        vids.append(v["id"])
        (OUT / "t" / f"{v['id']}.json").write_text(
            json.dumps([[s["start"], s["text"]] for s in segs], ensure_ascii=False, separators=(",", ":")),
            encoding="utf-8")
        for s in segs:
            seg_video += struct.pack("<H", vidx)
            seg_start += struct.pack("<I", s["start"])
            cps = [ord(c) for c in normalize(s["text"])]
            positions = {}
            for i in range(len(cps) - 1):
                positions.setdefault((cps[i], cps[i + 1]), []).append(i)
            for key, pos in positions.items():
                entry = bi.setdefault(key, [-1, bytearray()])
                varint(seg - entry[0], entry[1])
                varint(len(pos), entry[1])
                prev = 0
                for p in pos:
                    varint(p - prev, entry[1])
                    prev = p
                entry[0] = seg
            for c in set(cps):
                entry = uni.setdefault((c, 0), [-1, bytearray()])
                varint(seg - entry[0], entry[1])
                entry[0] = seg
            seg += 1

    write_shards({k: e[1] for k, e in bi.items()}, BI_SHARDS, OUT / "bi")
    write_shards({k: e[1] for k, e in uni.items()}, UNI_SHARDS, OUT / "uni")
    # uint32 count; uint16 video[count]; pad to 4 bytes; uint32 start[count]
    pad = b"\0" * ((4 - (4 + len(seg_video)) % 4) % 4)
    (OUT / "segs.bin").write_bytes(struct.pack("<I", seg) + bytes(seg_video) + pad + bytes(seg_start))
    (OUT / "videos.json").write_text(json.dumps(vids, separators=(",", ":")), encoding="utf-8")
    size = sum(f.stat().st_size for f in OUT.rglob("*") if f.is_file())
    print(f"search index: {len(vids)} videos, {seg:,} segments, {len(bi):,} bigrams, {size / 1e6:.0f} MB")


if __name__ == "__main__":
    main()
