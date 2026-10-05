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
# Ctrl-F search index for local preview (CI rebuilds it on deploy).
Push-Location ingest
try { & $py -W ignore build_search.py } finally { Pop-Location }
Write-Host "`nDone. Preview:  python -m http.server 8765 --directory site"
