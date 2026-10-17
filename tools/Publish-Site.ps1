<#
.SYNOPSIS
    Builds the site and publishes it to an IIS folder on Windows Server 2019.

.DESCRIPTION
    Rebuilds the documentation index, runs 'dotnet publish', and copies the
    output to the target folder. The app pool is stopped during the copy
    because the AspNetCoreModule holds KnowledgeBase.dll open while the site is
    running, and appsettings.json is preserved so server-specific PRTG
    credentials are not overwritten by the repository's placeholder file.

    Run from an elevated PowerShell session on the web server, or from a
    deployment agent with rights to the target folder and to IIS.

.PARAMETER Destination
    Physical path of the IIS site. Defaults to C:\inetpub\KnowledgeBase.

.PARAMETER AppPool
    Application pool to stop and start around the copy. Leave empty to skip.

.PARAMETER Configuration
    Build configuration. Defaults to Release.

.PARAMETER SkipIndex
    Don't rebuild content/index.json first.

.PARAMETER OverwriteSettings
    Replace appsettings.json at the destination. Off by default so live PRTG
    credentials survive a deployment.

.EXAMPLE
    .\Publish-Site.ps1

.EXAMPLE
    .\Publish-Site.ps1 -Destination 'D:\Sites\KnowledgeBase' -AppPool 'KnowledgeBase'
#>
[CmdletBinding()]
param(
    [string] $Destination = 'C:\inetpub\KnowledgeBase',
    [string] $AppPool = 'KnowledgeBase',
    [string] $Configuration = 'Release',
    [switch] $SkipIndex,
    [switch] $OverwriteSettings
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

$projectPath = Join-Path $PSScriptRoot '..\src\KnowledgeBase\KnowledgeBase.csproj'
$projectPath = [System.IO.Path]::GetFullPath($projectPath)

if (-not (Test-Path -LiteralPath $projectPath)) {
    throw "Project not found: $projectPath"
}

if (-not (Get-Command dotnet -ErrorAction SilentlyContinue)) {
    throw 'The dotnet CLI was not found. Install the .NET 8 SDK on this machine, or build elsewhere and copy the publish output.'
}

# ------------------------------------------------------------------ 1. index

if (-not $SkipIndex) {
    Write-Host '== Rebuilding documentation index ==' -ForegroundColor Cyan
    & (Join-Path $PSScriptRoot 'Build-DocsIndex.ps1')
}

# ------------------------------------------------------------------ 2. build

$staging = Join-Path ([System.IO.Path]::GetTempPath()) ("kb-publish-" + [guid]::NewGuid().ToString('n').Substring(0, 8))

Write-Host "== Publishing ($Configuration) ==" -ForegroundColor Cyan
Write-Host "   staging: $staging"

& dotnet publish $projectPath `
    --configuration $Configuration `
    --output $staging `
    --nologo

if ($LASTEXITCODE -ne 0) {
    throw "dotnet publish failed with exit code $LASTEXITCODE."
}

# ------------------------------------------------- 3. preserve live settings

$liveSettings = Join-Path $Destination 'appsettings.json'
$keepSettings = $false
$savedSettings = $null

if ((Test-Path -LiteralPath $liveSettings) -and -not $OverwriteSettings) {
    $savedSettings = Get-Content -LiteralPath $liveSettings -Raw -Encoding UTF8
    $keepSettings = $true
    Write-Host '   existing appsettings.json will be preserved' -ForegroundColor Yellow
}

# ----------------------------------------------------------- 4. stop the pool

$poolWasRunning = $false

if ($AppPool) {
    Import-Module WebAdministration -ErrorAction SilentlyContinue

    if (Get-Module WebAdministration) {
        $poolPath = "IIS:\AppPools\$AppPool"

        if (Test-Path $poolPath) {
            $state = (Get-WebAppPoolState -Name $AppPool).Value
            if ($state -eq 'Started') {
                Write-Host "== Stopping app pool '$AppPool' ==" -ForegroundColor Cyan
                Stop-WebAppPool -Name $AppPool
                $poolWasRunning = $true

                # Wait for the worker process to release the DLLs.
                for ($i = 0; $i -lt 30; $i++) {
                    Start-Sleep -Milliseconds 500
                    if ((Get-WebAppPoolState -Name $AppPool).Value -eq 'Stopped') { break }
                }
            }
        }
        else {
            Write-Warning "App pool '$AppPool' not found; continuing without stopping it."
        }
    }
    else {
        Write-Warning 'WebAdministration module unavailable; cannot stop the app pool. If the copy fails with a locked file, stop the pool manually.'
    }
}

# ---------------------------------------------------------------- 5. copy out

try {
    if (-not (Test-Path -LiteralPath $Destination)) {
        New-Item -ItemType Directory -Path $Destination -Force | Out-Null
    }

    Write-Host "== Copying to $Destination ==" -ForegroundColor Cyan

    # /MIR mirrors the tree. logs\ holds stdout logs written by the module and
    # must not be deleted while IIS has a handle on it.
    $robocopyArgs = @(
        $staging, $Destination,
        '/MIR', '/NFL', '/NDL', '/NJH', '/NJS', '/NP', '/R:2', '/W:2',
        '/XD', 'logs'
    )

    & robocopy @robocopyArgs | Out-Null

    # Robocopy: 0-7 are success, 8+ are real failures.
    if ($LASTEXITCODE -ge 8) {
        throw "robocopy failed with exit code $LASTEXITCODE."
    }

    if ($keepSettings) {
        $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
        [System.IO.File]::WriteAllText($liveSettings, $savedSettings, $utf8NoBom)
        Write-Host '   appsettings.json restored' -ForegroundColor Yellow
    }
}
finally {
    if ($AppPool -and $poolWasRunning) {
        Write-Host "== Starting app pool '$AppPool' ==" -ForegroundColor Cyan
        Start-WebAppPool -Name $AppPool
    }

    if (Test-Path -LiteralPath $staging) {
        Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue
    }
}

Write-Host ''
Write-Host 'Published.' -ForegroundColor Green

if (-not $keepSettings) {
    Write-Host ''
    Write-Host 'Next: set the PRTG connection in' -ForegroundColor Yellow
    Write-Host "  $liveSettings" -ForegroundColor Yellow
    Write-Host 'then recycle the app pool.' -ForegroundColor Yellow
}
