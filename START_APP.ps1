# START_APP.ps1
# Startup script for VisionClaw OpenClaw Gateway and mobile client configurations

param (
    [switch]$NoBrowser
)

$ErrorActionPreference = "Continue"
$HandoffDir = Join-Path $PSScriptRoot "_handoff"
$LogPath = Join-Path $HandoffDir "LAST_RUN.log"
$ServerPort = 18790

if (-not (Test-Path $HandoffDir)) {
    New-Item -ItemType Directory -Path $HandoffDir -Force | Out-Null
}

# 0. Nuclear Cleanup of previous instances
Write-Host "[INIT] Executing nuclear cleanup of previous node/openclaw instances..." -ForegroundColor Yellow
taskkill /F /IM node.exe /T 2>$null
taskkill /F /IM openclaw.exe /T 2>$null
# Kill any local ws_proxy.py, run_voice_handshake.py or live_voice_test.py python processes
Get-CimInstance Win32_Process -Filter "Name = 'python.exe' AND (CommandLine LIKE '%ws_proxy.py%' OR CommandLine LIKE '%run_voice_handshake.py%' OR CommandLine LIKE '%live_voice_test.py%')" | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 2

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

function Log-Warning($msg) {
    $timestamped = "$(Get-Date -Format 'o') [WARN] $msg"
    Write-Host $timestamped -ForegroundColor Yellow
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

# 3. Port Conflict Check & Resolution for OpenClaw Gateway (18789)
Log-Message "Checking for port conflicts on gateway port 18789..."
$gatewayToken = $env:OPENCLAW_GATEWAY_TOKEN
if (-not $gatewayToken) {
    $gatewayToken = "bcc2b8fb978d0aaab930713064dff7ac9c801c2e7e6a5f16"
}

$gatewayLog = Join-Path $HandoffDir "OPENCLAW_GATEWAY.log"
$gatewayErr = Join-Path $HandoffDir "OPENCLAW_GATEWAY.err"

# Check health before deciding to restart or clean port
$healthCheck = & openclaw --profile autoclaw gateway health 2>&1
$gatewayIsRunningHealthy = ($LASTEXITCODE -eq 0 -and $healthCheck -match "OK")

if (-not $gatewayIsRunningHealthy) {
    # Check if someone is listening on 18789
    $netstatGW = netstat -ano | Select-String ":18789 "
    if ($netstatGW) {
        Log-Warning "Port 18789 is occupied but health check failed. Terminating occupying process..."
        foreach ($line in $netstatGW) {
            if ($line.ToString() -match '\s+LISTENING\s+(\d+)') {
                $pidToKill = $Matches[1]
                Log-Message "Killing process $pidToKill holding port 18789..."
                Stop-Process -Id $pidToKill -Force -ErrorAction SilentlyContinue
            }
        }
        Start-Sleep -Seconds 1
    }
}

# 4. Port Conflict Check & Resolution for Dashboard Server (18790)
Log-Message "Checking for port conflicts on dashboard port $ServerPort..."
$netstatNode = netstat -ano | Select-String ":$ServerPort "
if ($netstatNode) {
    Log-Warning "Port $ServerPort is occupied. Terminating occupying process..."
    foreach ($line in $netstatNode) {
        if ($line.ToString() -match '\s+LISTENING\s+(\d+)') {
            $pidToKill = $Matches[1]
            Log-Message "Killing process $pidToKill holding port $ServerPort..."
            Stop-Process -Id $pidToKill -Force -ErrorAction SilentlyContinue
        }
    }
    Start-Sleep -Seconds 1
}

# 5. Start OpenClaw Gateway if not already running healthy
$gatewayProcess = $null
if ($gatewayIsRunningHealthy) {
    Log-Message "OpenClaw Gateway is already running and healthy. Skipping manual start."
} else {
    Log-Message "Starting background gateway process..."
    "" | Out-File -FilePath $gatewayLog -Encoding utf8
    
    $launcherScript = Join-Path $HOME ".openclaw-autoclaw\scripts\Start-OpenClawGateway.ps1"
    $gatewayProcess = Start-Process -FilePath "powershell.exe" -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File ""$launcherScript"" -Port 18789 -Token $gatewayToken -Force" -RedirectStandardOutput $gatewayLog -RedirectStandardError $gatewayErr -NoNewWindow -PassThru
    Start-Sleep -Seconds 3

    # If it failed immediately, check for config/plugin validation error
    if ($gatewayProcess.HasExited) {
        Log-Warning "Gateway failed to start on first attempt. Checking log for validation errors..."
        $logContent = Get-Content -Raw -Path $gatewayLog
        $officialLog = Join-Path $HOME ".openclaw-autoclaw\logs\gateway.log"
        if (Test-Path $officialLog) {
            $logContent += "`r`n" + (Get-Content -Raw -Path $officialLog -Tail 50)
        }

        if ($logContent -match 'validation failed: config\.plugins: Entry "([^"]+)" points to a plugin folder') {
            $offendingPlugin = $Matches[1]
            Log-Error "Detected stale/invalid plugin: $offendingPlugin. Automatically disabling and retrying..."
            
            $targetFiles = @(
                (Join-Path $HOME ".openclaw-autoclaw\openclaw.json"),
                (Join-Path $HOME ".openclaw-autoclaw\openclaw.runtime.json")
            )
            foreach ($file in $targetFiles) {
                if (Test-Path $file) {
                    try {
                        $cfg = Get-Content -Raw -Path $file | ConvertFrom-Json
                        if ($cfg.PSObject.Properties['plugins'] -and $cfg.plugins.PSObject.Properties['entries'] -and $cfg.plugins.entries.PSObject.Properties[$offendingPlugin]) {
                            $cfg.plugins.entries.$offendingPlugin.enabled = $false
                            $cfg | ConvertTo-Json -Depth 20 | Out-File -FilePath $file -Encoding utf8 -Force
                            Log-Message "Disabled plugin '$offendingPlugin' in $file"
                        }
                    } catch {}
                }
            }
            
            # Retry startup
            Log-Message "Retrying gateway startup after auto-repair..."
            $gatewayProcess = Start-Process -FilePath "powershell.exe" -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File ""$launcherScript"" -Port 18789 -Token $gatewayToken -Force" -RedirectStandardOutput $gatewayLog -RedirectStandardError $gatewayErr -NoNewWindow -PassThru
            Start-Sleep -Seconds 3
        }
    }

    if ($gatewayProcess.HasExited) {
        Log-Error "Failed to start OpenClaw Gateway. See logs at: $gatewayLog"
        exit 1
    }
    Log-Message "OpenClaw Gateway successfully started (PID: $($gatewayProcess.Id)). Log: $gatewayLog"
}

# 6. Start WebSocket Proxy (ws_proxy.py)
Log-Message "Starting local WebSocket proxy (ws_proxy.py)..."
$proxyLog = Join-Path $HandoffDir "WS_PROXY.log"
$proxyErr = Join-Path $HandoffDir "WS_PROXY_ERR.log"
$proxyProcess = Start-Process -FilePath "python" -ArgumentList "ws_proxy.py" -RedirectStandardOutput $proxyLog -RedirectStandardError $proxyErr -NoNewWindow -PassThru
Start-Sleep -Seconds 1

# 7. Start Dashboard Server (Node.js)
Log-Message "Starting backend Node.js server (server.js)..."
$nodeProcess = Start-Process -FilePath "node" -ArgumentList "server.js" -NoNewWindow -PassThru
Start-Sleep -Seconds 2

if ($nodeProcess.HasExited) {
    Log-Error "Node.js process failed to start. Port $ServerPort may be blocked."
    exit 1
}

Log-Message "Dashboard Server active at: http://localhost:$ServerPort"
if (-not $NoBrowser) {
    Log-Message "Opening Dashboard in default web browser..."
    Start-Process "http://localhost:$ServerPort"
} else {
    Log-Message "Skipping default web browser launch (-NoBrowser active)."
}

Write-Host "`n--------------------------------------------------" -ForegroundColor Cyan
Write-Host "VisionClaw Edge Gateway & Dashboard Active!" -ForegroundColor Cyan
Write-Host "Process Supervisor is monitoring services." -ForegroundColor Cyan
Write-Host "Press Ctrl+C to terminate services gracefully." -ForegroundColor Cyan
Write-Host "--------------------------------------------------`n" -ForegroundColor Cyan

# 7. Supervisor Health Monitoring & Auto-Restart Watch Loop
try {
    while ($true) {
        # A. Monitor Node.js Dashboard Server
        $nodeHealthy = $false
        try {
            $res = Invoke-RestMethod -Uri "http://127.0.0.1:$ServerPort/api/config" -Method Get -TimeoutSec 2
            if ($res -and $res.PSObject.Properties.Name -contains 'geminiApiKey') {
                $nodeHealthy = $true
            }
        } catch {
            Log-Warning "Node.js Server health check request failed: $($_.Exception.Message)"
        }

        if (-not $nodeHealthy) {
            Log-Warning "Node.js Server is unresponsive or stopped. Attempting recovery..."
            if ($nodeProcess -and -not $nodeProcess.HasExited) {
                Stop-Process -Id $nodeProcess.Id -Force -ErrorAction SilentlyContinue
            }
            # Clean port just in case
            $netstatNode = netstat -ano | Select-String ":$ServerPort "
            if ($netstatNode) {
                foreach ($line in $netstatNode) {
                    if ($line.ToString() -match '\s+LISTENING\s+(\d+)') {
                        Stop-Process -Id $Matches[1] -Force -ErrorAction SilentlyContinue
                    }
                }
                Start-Sleep -Seconds 1
            }
            $nodeProcess = Start-Process -FilePath "node" -ArgumentList "server.js" -NoNewWindow -PassThru
            Start-Sleep -Seconds 2
            Log-Message "Node.js Server restarted."
        }

        # B. Monitor OpenClaw Gateway Health
        $gatewayHealthy = $false
        $healthCheck = & openclaw --profile autoclaw gateway health 2>&1
        if ($LASTEXITCODE -eq 0 -and $healthCheck -match "OK") {
            $gatewayHealthy = $true
        }

        if (-not $gatewayHealthy) {
            Log-Warning "OpenClaw Gateway is unresponsive or stopped. Attempting recovery..."
            if ($gatewayProcess -and -not $gatewayProcess.HasExited) {
                Stop-Process -Id $gatewayProcess.Id -Force -ErrorAction SilentlyContinue
            }
            # Clean port
            $netstatGW = netstat -ano | Select-String ":18789 "
            if ($netstatGW) {
                foreach ($line in $netstatGW) {
                    if ($line.ToString() -match '\s+LISTENING\s+(\d+)') {
                        Stop-Process -Id $Matches[1] -Force -ErrorAction SilentlyContinue
                    }
                }
                Start-Sleep -Seconds 1
            }

            # Run pre-start config repair
            & (Join-Path $PSScriptRoot "CONFIGURE_OPENCLAW.ps1")

            $launcherScript = Join-Path $HOME ".openclaw-autoclaw\scripts\Start-OpenClawGateway.ps1"
            $gatewayProcess = Start-Process -FilePath "powershell.exe" -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File ""$launcherScript"" -Port 18789 -Token $gatewayToken -Force" -RedirectStandardOutput $gatewayLog -RedirectStandardError $gatewayErr -NoNewWindow -PassThru
            Start-Sleep -Seconds 3

            # Check if it failed immediately
            if ($gatewayProcess.HasExited) {
                $logContent = Get-Content -Raw -Path $gatewayLog
                $officialLog = Join-Path $HOME ".openclaw-autoclaw\logs\gateway.log"
                if (Test-Path $officialLog) {
                    $logContent += "`r`n" + (Get-Content -Raw -Path $officialLog -Tail 50)
                }

                if ($logContent -match 'validation failed: config\.plugins: Entry "([^"]+)" points to a plugin folder') {
                    $offendingPlugin = $Matches[1]
                    Log-Error "Detected stale/invalid plugin: $offendingPlugin. Automatically disabling and retrying..."
                    $targetFiles = @(
                        (Join-Path $HOME ".openclaw-autoclaw\openclaw.json"),
                        (Join-Path $HOME ".openclaw-autoclaw\openclaw.runtime.json")
                    )
                    foreach ($file in $targetFiles) {
                        if (Test-Path $file) {
                            try {
                                $cfg = Get-Content -Raw -Path $file | ConvertFrom-Json
                                if ($cfg.PSObject.Properties['plugins'] -and $cfg.plugins.PSObject.Properties['entries'] -and $cfg.plugins.entries.PSObject.Properties[$offendingPlugin]) {
                                    $cfg.plugins.entries.$offendingPlugin.enabled = $false
                                    $cfg | ConvertTo-Json -Depth 20 | Out-File -FilePath $file -Encoding utf8 -Force
                                    Log-Message "Disabled plugin '$offendingPlugin' in $file"
                                }
                            } catch {}
                        }
                    }
                    $gatewayProcess = Start-Process -FilePath "powershell.exe" -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File ""$launcherScript"" -Port 18789 -Token $gatewayToken -Force" -RedirectStandardOutput $gatewayLog -RedirectStandardError $gatewayErr -NoNewWindow -PassThru
                    Start-Sleep -Seconds 3
                }
            }

            if ($gatewayProcess.HasExited) {
                Log-Error "Failed to restart OpenClaw Gateway automatically."
            } else {
                Log-Message "OpenClaw Gateway restarted successfully."
            }
        }

        Start-Sleep -Seconds 5
    }
}
catch [System.Management.Automation.PipelineStoppedException] {
    Log-Message "Termination signal received via PipelineStoppedException."
}
catch {
    Log-Error $_.Exception.Message
}
finally {
    Log-Message "Shutting down processes gracefully on exit..."
    if ($nodeProcess -and -not $nodeProcess.HasExited) {
        Log-Message "Terminating background Node.js server..."
        Stop-Process -Id $nodeProcess.Id -Force
    }
    if ($gatewayProcess -and -not $gatewayProcess.HasExited) {
        Log-Message "Terminating background OpenClaw Gateway server..."
        Stop-Process -Id $gatewayProcess.Id -Force
    }
    if ($proxyProcess -and -not $proxyProcess.HasExited) {
        Log-Message "Terminating background WebSocket proxy..."
        Stop-Process -Id $proxyProcess.Id -Force
    }
    Log-Message "Shutdown clean and complete."
}


