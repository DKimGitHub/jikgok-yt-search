# One-shot update: list videos -> fetch new transcripts -> build pages -> build search index.
# Usage:  .\update.ps1            (all pending videos; resumable, safe to stop with Ctrl+C)
#         .\update.ps1 -Limit 200 (at most 200 videos this run)
param([int]$Limit = 0)
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot
$py = Join-Path $PSScriptRoot ".venv\Scripts\python.exe"  # absolute: steps below run from ingest\
if (-not (Test-Path $py)) {
    python -m venv .venv
    & $py -m pip install -q -r requirements.txt
}
Push-Location ingest
try {
    & $py -W ignore fetch_videos.py
    if ($Limit -gt 0) { & $py -W ignore fetch_captions.py --limit $Limit }
    else { & $py -W ignore fetch_captions.py }
    & $py -W ignore build_pages.py
} finally { Pop-Location }
# Pinned to 1.3.0: Pagefind 1.4+ NFD-normalizes Hangul for diacritic matching, which
# puts every Korean word into a single ~25 MB index chunk (multi-second searches).
# Pagefind never removes old chunks, so start from an empty output folder.
if (Test-Path site\pagefind) { Remove-Item -Recurse -Force site\pagefind }
npx -y pagefind@1.3.0 --site site
Write-Host "`nDone. Preview:  python -m http.server 8765 --directory site"
