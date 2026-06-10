# VERIFY_SYSTEM.ps1
# System dependency verification script for VisionClaw Meta Ray-Ban Gateway

$ErrorActionPreference = "SilentlyContinue"
$HandoffDir = Join-Path $PSScriptRoot "_handoff"

if (-not (Test-Path $HandoffDir)) {
    New-Item -ItemType Directory -Path $HandoffDir -Force | Out-Null
}

$envSnapshot = @()
$envSnapshot += "=== ENVIRONMENT SNAPSHOT ==="
$envSnapshot += "Timestamp: $(Get-Date -Format 'o')"
$envSnapshot += "OS: $((Get-WmiObject Win32_OperatingSystem).Caption) ($([System.Environment]::OSVersion.VersionString))"
$envSnapshot += "PowerShell Version: $($PSVersionTable.PSVersion.ToString())"

$allPassed = $true
$failReasons = @()

# 1. Check Python
$pythonVer = & python --version 2>&1
if ($LASTEXITCODE -eq 0) {
    $envSnapshot += "Python: $pythonVer"
} else {
    $allPassed = $false
    $failReasons += "Python is missing or not added to PATH. Download it from python.org."
    $envSnapshot += "Python: Not Found"
}

# 2. Check Node & npm
$nodeVer = & node --version 2>&1
if ($LASTEXITCODE -eq 0) {
    $envSnapshot += "Node.js: $nodeVer"
} else {
    $allPassed = $false
    $failReasons += "Node.js is missing. Install Node.js (v18+) to run the mock API/OpenClaw simulation."
    $envSnapshot += "Node.js: Not Found"
}

$npmVer = & npm --version 2>&1
if ($LASTEXITCODE -eq 0) {
    $envSnapshot += "npm: $npmVer"
} else {
    $envSnapshot += "npm: Not Found"
}

# 3. Check Android Home
$AndroidHome = $env:ANDROID_HOME
if (-not $AndroidHome -and (Test-Path "C:\Users\jgeis\AppData\Local\Android\Sdk")) {
    $AndroidHome = "C:\Users\jgeis\AppData\Local\Android\Sdk"
    [System.Environment]::SetEnvironmentVariable("ANDROID_HOME", $AndroidHome, "Process")
    $env:ANDROID_HOME = $AndroidHome
}

if ($env:ANDROID_HOME) {
    $envSnapshot += "ANDROID_HOME: $($env:ANDROID_HOME)"
    if (Test-Path "$env:ANDROID_HOME\platform-tools\adb.exe") {
        $envSnapshot += "adb: Found"
    } else {
        $envSnapshot += "adb: Missing under ANDROID_HOME\platform-tools"
    }
} else {
    $allPassed = $false
    $failReasons += "ANDROID_HOME environment variable is not set. Please set it to your Android SDK root."
    $envSnapshot += "ANDROID_HOME: Not Found"
}

# 4. Check OpenClaw CLI & Gateway
$openclawVer = & openclaw --version 2>&1
if ($LASTEXITCODE -eq 0) {
    $envSnapshot += "OpenClaw CLI: $($openclawVer -join ' ')"
    $gatewayHealth = & openclaw --profile autoclaw gateway health 2>&1
    if ($LASTEXITCODE -eq 0) {
        $envSnapshot += "OpenClaw Gateway: Running & Healthy"
    } else {
        $envSnapshot += "OpenClaw Gateway: Stopped or Unhealthy"
        # Not failing the check completely if openclaw is present, since START_APP.ps1 can start it,
        # but let's log it in env snapshot.
    }
} else {
    $allPassed = $false
    $failReasons += "OpenClaw CLI is missing or not added to PATH. Install it via npm: npm install -g openclaw"
    $envSnapshot += "OpenClaw CLI: Not Found"
}
# 5. Check Gemini API Key
$GeminiKey = ""
if (Test-Path "$PSScriptRoot\.env") {
    $envContent = Get-Content "$PSScriptRoot\.env" -Encoding UTF8
    foreach ($line in $envContent) {
        if ($line -match "^GEMINI_API_KEY=(.*)$") {
            $GeminiKey = $Matches[1].Trim()
            if ($GeminiKey.StartsWith('"') -and $GeminiKey.EndsWith('"')) {
                $GeminiKey = $GeminiKey.Substring(1, $GeminiKey.Length - 2)
            }
            if ($GeminiKey.StartsWith("'") -and $GeminiKey.EndsWith("'")) {
                $GeminiKey = $GeminiKey.Substring(1, $GeminiKey.Length - 2)
            }
        }
    }
}

if (-not $GeminiKey) {
    $GeminiKey = $env:GEMINI_API_KEY
}

if (-not $GeminiKey) {
    $allPassed = $false
    $failReasons += "GEMINI_API_KEY is missing. Please define it in D:\Meta\.env."
    $envSnapshot += "Gemini API Key: Missing"
} else {
    $displayKey = $GeminiKey.Substring(0, [Math]::Min(10, $GeminiKey.Length))
    $envSnapshot += "Gemini API Key: Found ($displayKey...)"
    
    # Run API validation check by calling models endpoint
    $Url = "https://generativelanguage.googleapis.com/v1beta/models?key=$GeminiKey"
    try {
        $check = Invoke-RestMethod -Uri $Url -Method Get -TimeoutSec 5
        $envSnapshot += "Gemini API Key Validation: Success (Key is active)"
    } catch {
        $allPassed = $false
        $failReasons += "GEMINI_API_KEY verification failed. Response status: $_. Check that your key is active and not disabled."
        $envSnapshot += "Gemini API Key Validation: Failed"
    }
}



# Write environment snapshot to handoff directory
$SnapshotPath = Join-Path $HandoffDir "ENV_SNAPSHOT.txt"
$envSnapshot | Out-File -FilePath $SnapshotPath -Encoding utf8

# Print report
Write-Host "==================================================" -ForegroundColor Cyan
Write-Host "       VISIONCLAW SYSTEM VERIFICATION SUMMARY      " -ForegroundColor Cyan
Write-Host "==================================================" -ForegroundColor Cyan

if ($allPassed) {
    Write-Host "Result: PASS" -ForegroundColor Green
    Write-Host "All system prerequisites are met. Environment snapshot written to: $SnapshotPath" -ForegroundColor Gray
} else {
    Write-Host "Result: FAIL" -ForegroundColor Red
    Write-Host "`nActionable Instructions to Resolve Issues:" -ForegroundColor Yellow
    foreach ($reason in $failReasons) {
        Write-Host " - $reason" -ForegroundColor Yellow
    }
    Write-Host "`nEnvironment snapshot written to: $SnapshotPath" -ForegroundColor Gray
}

# Ensure pipeline status is initialized/updated
$StatusFile = Join-Path $HandoffDir "PIPELINE_STATUS.json"
$statusJson = @{
    status = if ($allPassed) { "VERIFIED" } else { "DEGRADED" }
    last_verified = (Get-Date -Format "o")
    verification_errors = $failReasons
} | ConvertTo-Json
$statusJson | Out-File -FilePath $StatusFile -Encoding utf8

exit (if ($allPassed) { 0 } else { 1 })
