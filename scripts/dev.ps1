<#
.SYNOPSIS
    Start the PassagePort backend and the Vite dev server. Ctrl+C stops both.

.DESCRIPTION
    Backend:  http://127.0.0.1:8000 (uvicorn with reload)
    Frontend: http://127.0.0.1:5173 (Vite, proxies /api to the backend)

    Both bind to the loopback interface only: the default PP_AUTH_MODE=local has no login.
    Works in Windows PowerShell 5.1 and PowerShell 7+.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts\dev.ps1
#>

[CmdletBinding()]
param(
    [int]$BackendPort = 8000
)

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$backendDir = Join-Path $root 'backend'
$frontendDir = Join-Path $root 'frontend'

foreach ($tool in 'uv', 'node', 'npm') {
    if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) {
        Write-Error "'$tool' is not installed or not on PATH."
        exit 1
    }
}

function Invoke-In([string]$Directory, [scriptblock]$Command) {
    Push-Location $Directory
    try {
        & $Command
        if ($LASTEXITCODE -ne 0) { throw "command failed with exit code $LASTEXITCODE in $Directory" }
    }
    finally {
        Pop-Location
    }
}

if (-not (Test-Path (Join-Path $backendDir '.venv'))) {
    Write-Host '[dev] installing backend dependencies'
    Invoke-In $backendDir { uv sync --extra dev }
}
if (-not (Test-Path (Join-Path $frontendDir 'node_modules'))) {
    Write-Host '[dev] installing frontend dependencies'
    Invoke-In $frontendDir { npm ci }
}

$backendArgs = @(
    'run', 'uvicorn', 'passageport.main:app',
    '--reload', '--reload-dir', 'passageport',
    '--host', '127.0.0.1', '--port', "$BackendPort"
)
$envFile = Join-Path $root '.env'
if (Test-Path $envFile) {
    # Quoted because the repository path may contain spaces.
    $backendArgs += @('--env-file', "`"$envFile`"")
}

Write-Host "[dev] backend   http://127.0.0.1:$BackendPort  (API docs: /api/docs)"
Write-Host '[dev] frontend  http://127.0.0.1:5173'
Write-Host '[dev] Ctrl+C stops both'

$processes = @()
$exitCode = 0
try {
    $processes += Start-Process -FilePath 'uv' -ArgumentList $backendArgs `
        -WorkingDirectory $backendDir -NoNewWindow -PassThru
    # npm is a .cmd shim on Windows, so it is started through cmd.exe.
    $processes += Start-Process -FilePath $env:ComSpec `
        -ArgumentList @('/d', '/c', 'npm run dev -- --host 127.0.0.1') `
        -WorkingDirectory $frontendDir -NoNewWindow -PassThru

    while ($exitCode -eq 0) {
        Start-Sleep -Milliseconds 500
        foreach ($process in $processes) {
            if ($process.HasExited) {
                Write-Host "[dev] a server exited (pid $($process.Id)); shutting down the other one"
                $exitCode = 1
            }
        }
    }
}
finally {
    Write-Host ''
    Write-Host '[dev] stopping'
    foreach ($process in $processes) {
        if (-not $process.HasExited) {
            # /T ends the whole tree: uvicorn's reload worker and the node process behind npm.
            & taskkill.exe /PID $process.Id /T /F 2>&1 | Out-Null
        }
    }
}
exit $exitCode
