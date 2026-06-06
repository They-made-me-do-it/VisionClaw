# START_APP.ps1
# Startup script for VisionClaw OpenClaw Gateway and mobile client configurations

$ErrorActionPreference = "SilentlyContinue"
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

# 1. Load .env file at workspace root
$envFile = Join-Path $PSScriptRoot ".env"
if (Test-Path $envFile) {
    Log-Message "Loading env configurations from $envFile..."
    Get-Content $envFile | ForEach-Object {
        $line = $_.Trim()
        if ($line -and -not $line.StartsWith("#")) {
            if ($line -match '^([^=]+)=(.*)$') {
                $key = $Matches[1].Trim()
                $val = $Matches[2].Trim()
                if ($val -match '^["''](.*)["'']$') {
                    $val = $Matches[1]
                }
                [System.Environment]::SetEnvironmentVariable($key, $val, "Process")
            }
        }
    }
} else {
    Log-Message "No .env file found at $envFile."
}

# 2. Run OpenClaw configuration script
Log-Message "Auto-configuring OpenClaw settings..."
& (Join-Path $PSScriptRoot "CONFIGURE_OPENCLAW.ps1")

# 3. Check and start OpenClaw Gateway Daemon
$gatewayProcess = $null
$gatewayToken = $env:OPENCLAW_GATEWAY_TOKEN
if (-not $gatewayToken) {
    $gatewayToken = "bcc2b8fb978d0aaab930713064dff7ac9c801c2e7e6a5f16"
}

Log-Message "Checking OpenClaw Gateway service status..."
$healthCheck = & openclaw --profile autoclaw gateway health 2>&1
if ($LASTEXITCODE -eq 0 -and $healthCheck -match "OK") {
    Log-Message "OpenClaw Gateway is already running and healthy. Skipping manual start."
} else {
    Log-Message "OpenClaw Gateway is not running or unhealthy. Starting background gateway process..."
    $gatewayLog = Join-Path $HandoffDir "OPENCLAW_GATEWAY.log"
    "" | Out-File -FilePath $gatewayLog -Encoding utf8
    
    $gatewayProcess = Start-Process -FilePath "openclaw.cmd" -ArgumentList "--profile autoclaw gateway run --force --port 18789 --token $gatewayToken" -RedirectStandardOutput $gatewayLog -RedirectStandardError $gatewayLog -NoNewWindow -PassThru
    
    # Wait for gateway to bind
    Start-Sleep -Seconds 3
    if ($gatewayProcess.HasExited) {
        Log-Error "Failed to start OpenClaw Gateway. See logs at: $gatewayLog"
        exit 1
    }
    Log-Message "OpenClaw Gateway successfully started (PID: $($gatewayProcess.Id)). Log: $gatewayLog"
}

# 4. Start Dashboard Static File Server (Node.js)
Log-Message "Starting backend Node.js server (server.js)..."
$nodeProcess = Start-Process -FilePath "node" -ArgumentList "server.js" -NoNewWindow -PassThru

# Give Node a moment to bind to the port
Start-Sleep -Seconds 2

if ($nodeProcess.HasExited) {
    Log-Error "Node.js process failed to start. Check if port $ServerPort is already in use."
    exit 1
}

Log-Message "Dashboard Server active at: http://localhost:$ServerPort"
Log-Message "Opening Dashboard in default web browser..."
Start-Process "http://localhost:$ServerPort"

Write-Host "`n--------------------------------------------------" -ForegroundColor Cyan
Write-Host "VisionClaw Edge Gateway is active!" -ForegroundColor Cyan
Write-Host "Press Ctrl+C to terminate services gracefully." -ForegroundColor Cyan
Write-Host "--------------------------------------------------`n" -ForegroundColor Cyan

try {
    # Enter wait loop while monitoring process life
    while (-not $nodeProcess.HasExited -and ($null -eq $gatewayProcess -or -not $gatewayProcess.HasExited)) {
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
    if ($nodeProcess -and -not $nodeProcess.HasExited) {
        Log-Message "Terminating background Node.js server..."
        Stop-Process -Id $nodeProcess.Id -Force
    }
    if ($gatewayProcess -and -not $gatewayProcess.HasExited) {
        Log-Message "Terminating background OpenClaw Gateway server..."
        Stop-Process -Id $gatewayProcess.Id -Force
    }
    Log-Message "Shutdown clean and complete."
}

