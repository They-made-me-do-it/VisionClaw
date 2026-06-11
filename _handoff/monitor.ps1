$path = '_handoff\LAST_RUN.log'
$timeout = 180
$stopwatch = [System.Diagnostics.Stopwatch]::StartNew()
$fileStream = [System.IO.File]::Open($path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
$fileStream.Seek(0, [System.IO.SeekOrigin]::End) | Out-Null
$reader = New-Object System.IO.StreamReader($fileStream)
Write-Host 'Monitoring LAST_RUN.log for POST Voice Check PASSED...'
while ($stopwatch.Elapsed.TotalSeconds -lt $timeout) {
    while (-not $reader.EndOfStream) {
        $line = $reader.ReadLine()
        if ($line -match 'POST Voice Check PASSED') {
            Write-Host 'USER_POST_PASSED_DETECTED'
            $reader.Close()
            exit 0
        }
    }
    Start-Sleep -Seconds 1
}
Write-Host 'USER_POST_TIMEOUT'
$reader.Close()
exit 1
