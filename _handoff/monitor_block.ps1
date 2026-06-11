$path = '_handoff\LAST_RUN.log'
$stopwatch = [System.Diagnostics.Stopwatch]::StartNew()
while ($stopwatch.Elapsed.TotalSeconds -lt 9) {
    $tail = Get-Content -Path $path -Tail 50 -ErrorAction SilentlyContinue
    if ($tail -match 'POST Voice Check PASSED') {
        Write-Host 'PASSED'
        exit 0
    }
    if ($tail -match 'POST Failed:') {
        Write-Host 'FAILED'
        exit 0
    }
    if ($tail -match 'Error') {
        Write-Host 'ERROR'
        exit 0
    }
    Start-Sleep -Seconds 1
}
Write-Host 'WAITING'
exit 0
