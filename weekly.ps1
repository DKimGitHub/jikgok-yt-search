# Weekly job (run by Windows Task Scheduler): fetch new videos/transcripts,
# then commit and push so GitHub Actions redeploys the site.
# Log: logs\weekly-YYYY-MM-DD.log
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot
New-Item -ItemType Directory -Force logs | Out-Null
$log = "logs\weekly-$(Get-Date -Format yyyy-MM-dd).log"
$env:PYTHONIOENCODING = "utf-8"

Start-Transcript -Path $log -Append | Out-Null
try {
    & .\update.ps1

    git add -A
    git diff --cached --quiet
    if ($LASTEXITCODE -eq 0) {
        Write-Host "No changes; nothing to deploy."
    } else {
        $done = (Get-Content data\state.json -Raw | ConvertFrom-Json).PSObject.Properties |
            Where-Object { $_.Value.status -eq "done" } | Measure-Object
        git commit -q -m "Weekly update: $($done.Count) videos searchable"
        git push -q origin main
        Write-Host "Pushed; GitHub Pages will redeploy in a few minutes."
    }
} catch {
    Write-Host "FAILED: $_"
    exit 1
} finally {
    Stop-Transcript | Out-Null
}
