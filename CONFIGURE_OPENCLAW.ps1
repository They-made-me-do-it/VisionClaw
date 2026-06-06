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

$ConfigPaths = @(
    (Join-Path $HOME ".openclaw\openclaw.json"),
    (Join-Path $HOME ".openclaw-autoclaw\openclaw.json")
)

foreach ($ConfigFile in $ConfigPaths) {
    $ConfigDir = Split-Path $ConfigFile
    if (-not (Test-Path $ConfigDir)) {
        New-Item -ItemType Directory -Path $ConfigDir -Force | Out-Null
    }
    if (-not (Test-Path $ConfigFile)) {
        "{}" | Out-File -FilePath $ConfigFile -Encoding utf8
    }

    Write-Host "Reading OpenClaw configuration from $ConfigFile..." -ForegroundColor Cyan
    $jsonContent = Get-Content -Raw -Path $ConfigFile
    $config = $jsonContent | ConvertFrom-Json

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
