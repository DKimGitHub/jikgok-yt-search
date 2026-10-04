"""Step 2: download public transcripts into data/transcripts/<id>.json.

Sources, in order:
  1. youtube-transcript-api  (public caption tracks, lightweight)
  2. yt-dlp                   (same tracks via another client; also yields upload dates)
  3. faster-whisper           (--whisper only: local speech-to-text for videos with no captions)

Only tracks whose *original* language is in config "languages" are accepted;
YouTube's machine-translated tracks and misdetected ASR (e.g. Russian ASR on a
Korean video) are ignored.

The run is resumable: data/state.json records the outcome per video, and each
transcript is saved as soon as it is fetched. If YouTube starts blocking
requests, the script backs off, then stops cleanly; just run it again later.
"""
import argparse
import datetime as dt
import json
import random
import sys
import tempfile
import time

from common import STATE_FILE, TRANSCRIPTS, VIDEOS_FILE, load_config, load_json, save_json, ytdlp_opts

# Final outcomes are not retried unless asked; "error" is retried automatically.
FINAL = {"done", "none", "members", "unavailable"}
RECHECK_DAYS = 30  # videos this new with no captions yet are re-checked each run


class Blocked(Exception):
    """YouTube is rate limiting / bot-checking this IP."""


# ------------------------------------------------ source 1: transcript-api

def via_transcript_api(vid, langs):
    from youtube_transcript_api import YouTubeTranscriptApi
    from youtube_transcript_api import _errors as E

    try:
        tracks = list(YouTubeTranscriptApi().list(vid))
    except (E.RequestBlocked, E.IpBlocked) as ex:
        raise Blocked(type(ex).__name__)
    except E.TranscriptsDisabled:
        return "none", None
    except E.AgeRestricted:
        return "unavailable", None
    except (E.VideoUnavailable, E.VideoUnplayable, E.InvalidVideoId,
            E.PoTokenRequired, E.YouTubeRequestFailed):
        return "retry-ytdlp", None  # could be members-only; yt-dlp tells us which

    for lang in langs:
        for want_generated in (False, True):  # manual track beats ASR
            for t in tracks:
                if t.language_code.split("-")[0] == lang and t.is_generated == want_generated:
                    try:
                        cues = [[s.start, s.duration, s.text] for s in t.fetch()]
                    except (E.RequestBlocked, E.IpBlocked) as ex:
                        raise Blocked(type(ex).__name__)
                    except (E.PoTokenRequired, E.YouTubeRequestFailed):
                        return "retry-ytdlp", None
                    return "done", {"source": "transcript-api", "lang": t.language_code,
                                    "kind": "auto" if t.is_generated else "manual", "cues": cues}
    return "none", None


# -------------------------------------------------------- source 2: yt-dlp

def _json3_to_cues(raw):
    cues = []
    for ev in json.loads(raw).get("events", []):
        text = "".join(s.get("utf8", "") for s in ev.get("segs") or []).replace("\n", " ").strip()
        if text:
            cues.append([ev.get("tStartMs", 0) / 1000, ev.get("dDurationMs", 0) / 1000, text])
    return cues


def via_ytdlp(vid, langs):
    """Returns (status, transcript_or_None, upload_date_or_None)."""
    import yt_dlp

    with yt_dlp.YoutubeDL(ytdlp_opts(skip_download=True)) as ydl:
        try:
            info = ydl.extract_info(f"https://www.youtube.com/watch?v={vid}", download=False)
        except yt_dlp.utils.DownloadError as ex:
            # We request the Korean site, so YouTube's reasons may arrive in Korean.
            msg = str(ex).lower()
            has = lambda *words: any(w in msg for w in words)  # noqa: E731
            if has("members-only", "join this channel", "회원 전용"):
                return "members", None, None
            if has("not a bot", "429", "too many requests", "봇이 아닌지", "봇이 아닙니다"):
                raise Blocked(str(ex)[:120])
            if has("private", "unavailable", "removed", "비공개", "사용할 수 없", "삭제"):
                return "unavailable", None, None
            raise

        date = info.get("upload_date")
        date = f"{date[:4]}-{date[4:6]}-{date[6:]}" if date else None
        manual = info.get("subtitles") or {}
        auto = info.get("automatic_captions") or {}

        for lang in langs:
            # Manual tracks first, then ASR in its *original* language only.
            for kind, formats in (("manual", manual.get(lang)), ("auto", auto.get(f"{lang}-orig"))):
                fmt = next((f for f in formats or [] if f.get("ext") == "json3"), None)
                if not fmt:
                    continue
                try:
                    raw = ydl.urlopen(fmt["url"]).read().decode("utf-8")
                except Exception as ex:  # noqa: BLE001 - network errors vary by transport
                    if "429" in str(ex):
                        raise Blocked("429 on caption download")
                    raise
                return "done", {"source": "yt-dlp", "lang": lang, "kind": kind,
                                "cues": _json3_to_cues(raw)}, date
        return "none", None, date


# ------------------------------------------------ source 3: local whisper

_whisper_model = None


def via_whisper(vid, lang, model_size):
    global _whisper_model
    import yt_dlp
    from faster_whisper import WhisperModel

    if _whisper_model is None:
        print(f"    loading whisper model '{model_size}' (first time downloads it)...")
        _whisper_model = WhisperModel(model_size, device="auto", compute_type="int8")
    with tempfile.TemporaryDirectory() as tmp:
        opts = ytdlp_opts(format="bestaudio/best", outtmpl=f"{tmp}/%(id)s.%(ext)s")
        with yt_dlp.YoutubeDL(opts) as ydl:
            path = ydl.prepare_filename(ydl.extract_info(
                f"https://www.youtube.com/watch?v={vid}", download=True))
        segments, _ = _whisper_model.transcribe(path, language=lang, vad_filter=True)
        cues = [[s.start, s.end - s.start, s.text.strip()] for s in segments]
    return {"source": "whisper", "lang": lang, "kind": "whisper", "cues": cues}


# ------------------------------------------------------------------- main

def process(v, cfg, args, state):
    vid, langs = v["id"], cfg["languages"]
    status, tr = None, None

    # Without an API key we have no upload dates yet: yt-dlp gets both at once.
    order = ["ytdlp", "api"] if not v.get("published") else ["api", "ytdlp"]
    for src in order:
        if src == "api":
            status, tr = via_transcript_api(vid, langs)
            if status != "retry-ytdlp":
                break
        else:
            status, tr, date = via_ytdlp(vid, langs)
            if date and not v.get("published"):
                v["published"] = date
            break  # yt-dlp's verdict is authoritative (it sees members-only etc.)

    if status == "retry-ytdlp":
        status = "unavailable"
    if status == "none" and args.whisper:
        tr = via_whisper(vid, langs[0], args.whisper_model)
        status = "done"

    if tr:
        tr.update(id=vid, fetched=dt.date.today().isoformat())
        save_json(TRANSCRIPTS / f"{vid}.json", tr)
    prev = state.get(vid, {})
    state[vid] = {"status": status, "source": tr and tr["source"],
                  "tries": prev.get("tries", 0) + 1, "at": dt.datetime.now().isoformat(timespec="seconds")}
    return status


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--limit", type=int, help="process at most N videos this run")
    ap.add_argument("--ids", nargs="+", help="only these video ids")
    ap.add_argument("--retry", nargs="*", default=[], metavar="STATUS",
                    help="also retry videos with these final statuses, e.g. --retry none unavailable")
    ap.add_argument("--whisper", action="store_true",
                    help="transcribe caption-less videos locally (pip install faster-whisper)")
    ap.add_argument("--whisper-model", default="small")
    ap.add_argument("--delay", type=float, nargs=2, default=[1.5, 3.5], metavar=("MIN", "MAX"),
                    help="random pause between videos in seconds (default 1.5 3.5)")
    args = ap.parse_args()
    if args.whisper:
        args.retry = list(set(args.retry) | {"none"})

    cfg = load_config()
    videos = load_json(VIDEOS_FILE, None)
    if videos is None:
        sys.exit("Run fetch_videos.py first.")
    state = load_json(STATE_FILE, {})
    retry = set(args.retry)

    # YouTube generates ASR captions some time after upload (hours for long live
    # streams), so a recent "none" may just mean "not yet": re-check those.
    recent = (dt.date.today() - dt.timedelta(days=RECHECK_DAYS)).isoformat()

    def due(v):
        status = state.get(v["id"], {}).get("status")
        return (status not in FINAL or status in retry
                or (status == "none" and (v.get("published") or "") >= recent))

    todo = [v for v in videos if (not args.ids or v["id"] in args.ids) and due(v)]
    if args.limit:
        todo = todo[:args.limit]
    print(f"{len(todo)} videos to process ({len(videos)} on channel)")

    counts, backoff = {}, 60
    try:
        for n, v in enumerate(todo, 1):
            while True:
                try:
                    status = process(v, cfg, args, state)
                    backoff = 60
                    break
                except Blocked as ex:
                    if backoff > 480:
                        print(f"\nYouTube keeps blocking ({ex}). Stopping; run again later to resume.")
                        raise KeyboardInterrupt
                    print(f"\n  blocked ({ex}); waiting {backoff}s")
                    time.sleep(backoff)
                    backoff *= 2
                except Exception as ex:  # noqa: BLE001 - record and move on
                    status = "error"
                    prev = state.get(v["id"], {})
                    state[v["id"]] = {"status": "error", "error": str(ex)[:200],
                                      "tries": prev.get("tries", 0) + 1}
                    break
            counts[status] = counts.get(status, 0) + 1
            print(f"[{n}/{len(todo)}] {status:<11} {v['id']}  {v['title'][:50]}")
            if n % 10 == 0:
                save_json(STATE_FILE, state)
                save_json(VIDEOS_FILE, videos)
            time.sleep(random.uniform(*args.delay))
    except KeyboardInterrupt:
        pass
    finally:
        save_json(STATE_FILE, state)
        save_json(VIDEOS_FILE, videos)  # persists upload dates learned via yt-dlp

    print("\nThis run:", counts)
    totals = {}
    for s in state.values():
        totals[s["status"]] = totals.get(s["status"], 0) + 1
    pending = len(videos) - sum(1 for v in videos if state.get(v["id"], {}).get("status") in FINAL)
    print("All time:", totals, f"| still pending: {pending}")


if __name__ == "__main__":
    main()
