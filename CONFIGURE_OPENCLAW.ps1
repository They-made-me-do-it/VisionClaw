# CONFIGURE_OPENCLAW.ps1
# Script to configure local OpenClaw Gateway options per system specifications

$ErrorActionPreference = "Stop"

# Load .env configuration at workspace root
$envFile = Join-Path $PSScriptRoot ".env"
if (Test-Path $envFile) {
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
}

function Repair-OpenClawConfigFile {
    param(
        [string]$ConfigFile
    )
    $ConfigDir = Split-Path $ConfigFile
    if (-not (Test-Path $ConfigDir)) {
        New-Item -ItemType Directory -Path $ConfigDir -Force | Out-Null
    }
    
    $parsed = $false
    $attempts = 0
    $config = $null
    
    while (-not $parsed -and $attempts -lt 3) {
        $attempts++
        if (-not (Test-Path $ConfigFile) -or (Get-Item $ConfigFile).Length -eq 0) {
            "{}" | Out-File -FilePath $ConfigFile -Encoding utf8 -Force
        }
        
        try {
            $jsonContent = Get-Content -Raw -Path $ConfigFile
            $config = $jsonContent | ConvertFrom-Json
            $parsed = $true
        } catch {
            Write-Host "WARNING: Failed to parse JSON config at $ConfigFile. Attempting recovery..." -ForegroundColor Yellow
            $backups = @(
                "$ConfigFile.known-good",
                "$ConfigFile.last-good",
                "$ConfigFile.bak",
                "$ConfigFile.bak.1"
            )
            $recovered = $false
            foreach ($backup in $backups) {
                $backupPath = Join-Path $ConfigDir (Split-Path $backup -Leaf)
                if (Test-Path $backupPath) {
                    Write-Host "Restoring configuration from backup: $backupPath" -ForegroundColor Cyan
                    Copy-Item -Path $backupPath -Destination $ConfigFile -Force
                    $recovered = $true
                    break
                }
            }
            if (-not $recovered) {
                Write-Host "No valid backups found. Initializing new empty configuration." -ForegroundColor Red
                "{}" | Out-File -FilePath $ConfigFile -Encoding utf8 -Force
            }
        }
    }
    
    if (-not $parsed) {
        Write-Host "CRITICAL: Configuration file $ConfigFile could not be repaired." -ForegroundColor Red
        return $null
    }

    # Inspect plugins and ensure they exist and have a manifest if enabled
    $changed = $false
    
    if ($config -and $config.PSObject.Properties['plugins'] -and $config.plugins.PSObject.Properties['entries']) {
        foreach ($pluginName in $config.plugins.entries.PSObject.Properties.Name) {
            $pluginEntry = $config.plugins.entries.$pluginName
            if ($pluginEntry -and $pluginEntry.PSObject.Properties['enabled'] -and $pluginEntry.enabled -eq $true) {
                # Check if the folder exists and contains manifest.json
                $pluginFolder = Join-Path $ConfigDir "plugins\$pluginName"
                $manifestPath = Join-Path $pluginFolder "manifest.json"
                if (-not (Test-Path $manifestPath)) {
                    Write-Host "WARNING: Stale plugin '$pluginName' enabled but manifest/directory missing at $manifestPath. Disabling plugin." -ForegroundColor Yellow
                    $pluginEntry.enabled = $false
                    $changed = $true
                }
            }
        }
    }

    if ($changed) {
        Write-Host "Writing auto-repaired configuration to $ConfigFile..." -ForegroundColor Green
        $newJson = $config | ConvertTo-Json -Depth 20
        $newJson | Out-File -FilePath $ConfigFile -Encoding utf8 -Force
    }

    return $config
}

$ConfigPaths = @(
    (Join-Path $HOME ".openclaw\openclaw.json"),
    (Join-Path $HOME ".openclaw\openclaw.runtime.json"),
    (Join-Path $HOME ".openclaw-autoclaw\openclaw.json"),
    (Join-Path $HOME ".openclaw-autoclaw\openclaw.runtime.json")
)

foreach ($ConfigFile in $ConfigPaths) {
    $ConfigDir = Split-Path $ConfigFile
    if ($ConfigFile -match "runtime.json" -and -not (Test-Path $ConfigFile)) {
        # Runtime file doesn't exist yet, which is fine since OpenClaw creates it on start
        continue
    }

    Write-Host "Reading and verifying OpenClaw configuration from $ConfigFile..." -ForegroundColor Cyan
    $config = Repair-OpenClawConfigFile -ConfigFile $ConfigFile
    if (-not $config) {
        continue
    }

    # Only apply gateway configuration modifications to main openclaw.json files
    if ($ConfigFile -match "openclaw\.json$") {

    # Initialize or update gateway properties
    if (-not $config.PSObject.Properties['gateway']) {
        $gateway = [PSCustomObject]@{
            http = [PSCustomObject]@{
                endpoints = [PSCustomObject]@{
                    chatCompletions = [PSCustomObject]@{
                        enabled = $true
                    }
                }
            }
            bind = "lan"
        }
        $config | Add-Member -MemberType NoteProperty -Name "gateway" -Value $gateway
    } else {
        if (-not $config.gateway.PSObject.Properties['http']) {
            $config.gateway | Add-Member -MemberType NoteProperty -Name "http" -Value [PSCustomObject]@{
                endpoints = [PSCustomObject]@{
                    chatCompletions = [PSCustomObject]@{
                        enabled = $true
                    }
                }
            }
        } else {
            if (-not $config.gateway.http.PSObject.Properties['endpoints']) {
                $config.gateway.http | Add-Member -MemberType NoteProperty -Name "endpoints" -Value [PSCustomObject]@{
                    chatCompletions = [PSCustomObject]@{
                        enabled = $true
                    }
                }
            } else {
                if (-not $config.gateway.http.endpoints.PSObject.Properties['chatCompletions']) {
                    $config.gateway.http.endpoints | Add-Member -MemberType NoteProperty -Name "chatCompletions" -Value [PSCustomObject]@{
                        enabled = $true
                    }
                } else {
                    $config.gateway.http.endpoints.chatCompletions.enabled = $true
                }
            }
        }
        # Ensure bind property exists or update it
        if (-not $config.gateway.PSObject.Properties['bind']) {
            $config.gateway | Add-Member -MemberType NoteProperty -Name "bind" -Value "lan"
        } else {
            $config.gateway.bind = "lan"
        }
    }

    # Ensure auth and remote tokens match env variable if defined
    $gatewayToken = $env:OPENCLAW_GATEWAY_TOKEN
    if ($gatewayToken) {
        # 1. Update gateway.auth.token
        if (-not $config.gateway.PSObject.Properties['auth']) {
            $config.gateway | Add-Member -MemberType NoteProperty -Name "auth" -Value ([PSCustomObject]@{
                mode = "token"
                token = $gatewayToken
            })
        } else {
            $config.gateway.auth.mode = "token"
            $config.gateway.auth.token = $gatewayToken
        }

        # 2. Update gateway.remote.token
        if (-not $config.gateway.PSObject.Properties['remote']) {
            $config.gateway | Add-Member -MemberType NoteProperty -Name "remote" -Value ([PSCustomObject]@{
                token = $gatewayToken
            })
        } else {
            $config.gateway.remote.token = $gatewayToken
        }
        Write-Host "Configured gateway auth and remote tokens at $ConfigFile to match env file: $gatewayToken" -ForegroundColor Yellow

        # Sync profile overrides files (.env and .gateway-token)
        if ($ConfigFile -match "openclaw-autoclaw") {
            $autoclawEnv = Join-Path $ConfigDir ".env"
            if (Test-Path $autoclawEnv) {
                Write-Host "Syncing token in $autoclawEnv..." -ForegroundColor Yellow
                $envContent = Get-Content -Raw -Path $autoclawEnv
                if ($envContent -match 'OPENCLAW_GATEWAY_TOKEN=.*') {
                    $envContent = $envContent -replace 'OPENCLAW_GATEWAY_TOKEN=.*', "OPENCLAW_GATEWAY_TOKEN=$gatewayToken"
                    $envContent | Out-File -FilePath $autoclawEnv -Encoding utf8 -Force
                }
            }
            $autoclawTokenFile = Join-Path $ConfigDir ".gateway-token"
            if (Test-Path $autoclawTokenFile) {
                Write-Host "Syncing token in $autoclawTokenFile..." -ForegroundColor Yellow
                $gatewayToken | Out-File -FilePath $autoclawTokenFile -Encoding utf8 -Force
            }
        }
    }

    # Serialize back to JSON and write to file
    $newJson = $config | ConvertTo-Json -Depth 20
    $newJson | Out-File -FilePath $ConfigFile -Encoding utf8 -Force

    Write-Host "OpenClaw config at $ConfigFile updated successfully!" -ForegroundColor Green
    }
}

