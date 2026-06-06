# CONFIGURE_OPENCLAW.ps1
# Script to configure local OpenClaw Gateway options per system specifications

$ErrorActionPreference = "Stop"
$ConfigFile = Join-Path $HOME ".openclaw\openclaw.json"

if (-not (Test-Path $ConfigFile)) {
    Write-Error "OpenClaw configuration file not found at: $ConfigFile"
    exit 1
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

# Serialize back to JSON and write to file
$newJson = $config | ConvertTo-Json -Depth 20
$newJson | Out-File -FilePath $ConfigFile -Encoding utf8 -Force

Write-Host "OpenClaw config updated successfully!" -ForegroundColor Green
Write-Host "Exposed gateway over LAN bind with chatCompletions enabled." -ForegroundColor Gray
