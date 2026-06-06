# START_APP.ps1
# Startup script for VisionClaw OpenClaw Gateway simulation and mobile client configurations

$ErrorActionPreference = "Stop"
$HandoffDir = Join-Path $PSScriptRoot "_handoff"
$LogPath = Join-Path $HandoffDir "LAST_RUN.log"
$ServerPort = 18790

if (-not (Test-Path $HandoffDir)) {
    New-Item -ItemType Directory -Path $HandoffDir -Force | Out-Null
}

# Clear old log or create a new one
"$(Get-Date -Format 'o') [INFO] Starting VisionClaw API Gateway server..." | Out-File -FilePath $LogPath -Encoding utf8

function Log-Message($msg) {
    $timestamped = "$(Get-Date -Format 'o') [INFO] $msg"
    Write-Host $timestamped -ForegroundColor Green
    $timestamped | Out-File -FilePath $LogPath -Append -Encoding utf8
}

function Log-Error($msg) {
    $timestamped = "$(Get-Date -Format 'o') [ERROR] $msg"
    Write-Host $timestamped -ForegroundColor Red
    $timestamped | Out-File -FilePath $LogPath -Append -Encoding utf8
}

Log-Message "Starting backend Node.js server (server.js)..."

# Start the Node.js process and redirect stdout/stderr to LAST_RUN.log
$nodeProcess = Start-Process -FilePath "node" -ArgumentList "server.js" -NoNewWindow -PassThru

# Give Node a moment to bind to the port
Start-Sleep -Seconds 2

if ($nodeProcess.HasExited) {
    Log-Error "Node.js process failed to start. Check if port $ServerPort is already in use."
    exit 1
}

Log-Message "Dashboard Server active at: http://localhost:$ServerPort"
Log-Message "Opening Dashboard in default web browser..."

# Launch the default web browser to the local page to bring it 'in the face' of the user
Start-Process "http://localhost:$ServerPort"

Write-Host "`n--------------------------------------------------" -ForegroundColor Cyan
Write-Host "VisionClaw Edge Gateway is active!" -ForegroundColor Cyan
Write-Host "Press Ctrl+C to terminate services gracefully." -ForegroundColor Cyan
Write-Host "--------------------------------------------------`n" -ForegroundColor Cyan

try {
    # Enter wait loop while monitoring process life
    while (-not $nodeProcess.HasExited) {
        Start-Sleep -Seconds 1
    }
}
catch [System.Management.Automation.PipelineStoppedException] {
    Log-Message "Termination signal received via PipelineStoppedException."
}
catch {
    Log-Error $_.Exception.Message
}
finally {
    if (-not $nodeProcess.HasExited) {
        Log-Message "Terminating background Node.js server..."
        Stop-Process -Id $nodeProcess.Id -Force
    }
    Log-Message "Shutdown clean and complete."
}
