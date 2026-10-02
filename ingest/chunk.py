"""Merge short caption cues into ~25 s searchable segments."""
import re

_WS = re.compile(r"\s+")

# Spoken fillers ("예", "어", "음" ...). They are a large share of all ASR words
# and carry no meaning; left in, each one becomes a giant Pagefind index chunk
# (tens of MB) that any search for a nearby word has to download.
FILLERS = {"예", "네", "어", "음", "아", "뭐", "막", "좀", "에", "응", "으", "엄"}
_FILLER = re.compile(r"(?<!\S)(?:%s)[.,?!]*(?!\S)" % "|".join(FILLERS))


def strip_fillers(text):
    return _WS.sub(" ", _FILLER.sub(" ", text)).strip()


def chunk(cues, target=25.0, max_chars=320):
    """cues: [[start, duration, text], ...] -> [{"start": int_seconds, "text": str}, ...]

    A segment closes once it spans `target` seconds or reaches `max_chars`,
    so each search hit points at a moment no more than ~25 s before the words.
    """
    segments, cur, cur_start, cur_len = [], [], None, 0
    for start, _dur, text in sorted(cues, key=lambda c: c[0]):
        text = strip_fillers(text)
        if not text or text.startswith("[") and text.endswith("]"):  # [음악], [박수]
            continue
        if cur and (start - cur_start >= target or cur_len + len(text) > max_chars):
            segments.append({"start": int(cur_start), "text": " ".join(cur)})
            cur, cur_len = [], 0
        if not cur:
            cur_start = start
        # ASR tracks sometimes repeat the previous line verbatim.
        if not cur or cur[-1] != text:
            cur.append(text)
            cur_len += len(text) + 1
    if cur:
        segments.append({"start": int(cur_start), "text": " ".join(cur)})
    return segments


def fmt_time(sec):
    sec = int(sec)
    h, rem = divmod(sec, 3600)
    m, s = divmod(rem, 60)
    return f"{h}:{m:02d}:{s:02d}" if h else f"{m}:{s:02d}"
