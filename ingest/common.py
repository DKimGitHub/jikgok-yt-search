"""Shared paths and small JSON helpers for the ingest pipeline."""
import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
TRANSCRIPTS = DATA / "transcripts"
VIDEOS_FILE = DATA / "videos.json"
STATE_FILE = DATA / "state.json"
SITE = ROOT / "site"
CONFIG_FILE = ROOT / "config.json"

# Windows consoles default to a legacy code page; titles are Korean.
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")


def ytdlp_opts(**extra):
    """yt-dlp options that request the Korean site, so YouTube returns the
    original Korean titles instead of auto-translating them to English."""
    opts = {"quiet": True, "no_warnings": True,
            "extractor_args": {"youtube": {"lang": ["ko"]}},
            "http_headers": {"Accept-Language": "ko-KR,ko;q=0.9"}}
    opts.update(extra)
    return opts


def load_json(path, default):
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except FileNotFoundError:
        return default


def save_json(path, obj):
    """Write atomically so an interrupted run never leaves a truncated file."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(obj, ensure_ascii=False, indent=1), encoding="utf-8")
    os.replace(tmp, path)


def load_config():
    cfg = load_json(CONFIG_FILE, {})
    cfg.setdefault("languages", ["ko"])
    cfg.setdefault("site_title", "Transcript Search")
    cfg.setdefault("site_lang", cfg["languages"][0])
    cfg["api_key"] = os.environ.get("YOUTUBE_API_KEY") or cfg.get("api_key") or None
    if not cfg.get("channel"):
        sys.exit("Set \"channel\" in config.json (channel URL, @handle, or UC... id).")
    return cfg
