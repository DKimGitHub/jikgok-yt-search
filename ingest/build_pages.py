"""Step 3: turn transcripts into one static HTML page per video under site/video/.

Each ~25 s segment becomes <h2 id="t-SECONDS">, which Pagefind turns into a
sub-result, so every search hit carries the timestamp to jump to.
Then run build_search.py (GitHub Actions does this on every deploy).
"""
import datetime as dt
import html
import json

from chunk import chunk, fmt_time
from common import SITE, STATE_FILE, TRANSCRIPTS, VIDEOS_FILE, load_config, load_json, save_json

PAGE = """<!doctype html>
<html lang="{lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{title_e}</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/variable/pretendardvariable-dynamic-subset.min.css">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Nanum+Myeongjo:wght@800&display=swap">
<link rel="stylesheet" href="../style.css">
</head>
<body class="transcript-page">
<main data-pagefind-body data-pagefind-sort="date:{date}">
  <!-- One tag per field: Pagefind does not split comma lists in these attributes. -->
  <meta data-pagefind-meta="vid[content]" content="{vid}">
  <meta data-pagefind-meta="date[content]" content="{date}">
  <meta data-pagefind-meta="duration[content]" content="{duration}">
  <meta data-pagefind-meta="image[content]" content="{thumb}">
  <meta data-pagefind-filter="year[content]" content="{year}">
  <meta data-pagefind-filter="type[content]" content="{type_e}">
  <p class="back"><a href="../index.html" data-pagefind-ignore>← 검색으로</a></p>
  <h1 data-pagefind-meta="title">{title_e}</h1>
  <p class="meta" data-pagefind-ignore>{date_label} · {duration_label} ·
    <a href="https://www.youtube.com/watch?v={vid}">YouTube에서 보기</a></p>
{sections}
</main>
</body>
</html>
"""

SECTION = """  <section>
    <h2 id="t-{start}"><a href="../index.html?v={vid}&amp;t={start}">{label}</a></h2>
    <p>{text}</p>
  </section>"""


def main():
    cfg = load_config()
    videos = load_json(VIDEOS_FILE, [])
    state = load_json(STATE_FILE, {})
    out_dir = SITE / "video"
    out_dir.mkdir(parents=True, exist_ok=True)

    written, seconds, keep = 0, 0, set()
    for v in videos:
        if state.get(v["id"], {}).get("status") != "done":
            continue
        tr = load_json(TRANSCRIPTS / f"{v['id']}.json", None)
        if not tr:
            continue
        segs = chunk(tr["cues"])
        if not segs:
            continue
        vid, date = v["id"], v.get("published") or ""
        sections = "\n".join(
            SECTION.format(vid=vid, start=s["start"], label=fmt_time(s["start"]),
                           text=html.escape(s["text"]))
            for s in segs)
        page = PAGE.format(
            lang=cfg["site_lang"], vid=vid, title_e=html.escape(v["title"]),
            date=date, year=date[:4] or "unknown", type_e=html.escape(v.get("type", "기타")),
            duration=v.get("duration") or 0,
            thumb=f"https://i.ytimg.com/vi/{vid}/mqdefault.jpg",
            date_label=date or "날짜 미상",
            duration_label=fmt_time(v.get("duration") or 0),
            sections=sections)
        name = f"{vid}.html"
        keep.add(name)
        path = out_dir / name
        if not path.exists() or path.read_text(encoding="utf-8") != page:
            path.write_text(page, encoding="utf-8")
            written += 1
        seconds += v.get("duration") or 0

    # Title search: every playable video, including those without captions.
    # Compact rows: [id, title, date, duration, type, has_transcript_page]
    titles = [[v["id"], v["title"], v.get("published") or "", v.get("duration") or 0,
               v.get("type", "기타"), int(f"{v['id']}.html" in keep)]
              for v in videos
              if state.get(v["id"], {}).get("status") not in ("members", "unavailable")]
    (SITE / "titles.json").write_text(
        json.dumps(titles, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")

    removed = 0
    for old in out_dir.glob("*.html"):
        if old.name not in keep:
            old.unlink()
            removed += 1

    save_json(SITE / "stats.json", {
        "videos": len(keep), "titles": len(titles), "channel_videos": len(videos),
        "hours": round(seconds / 3600), "updated": dt.date.today().isoformat(),
        "title": cfg["site_title"], "channel": cfg["channel"]})
    print(f"{len(keep)} video pages ({written} written, {removed} removed). "
          f"Next: build_search.py (runs in CI on deploy)")


if __name__ == "__main__":
    main()
