[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$AppPath,
    [switch]$HostingSpike,
    [ValidateRange(1, 120)][int]$StartupSeconds = 15
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$AppPath = (Resolve-Path $AppPath).Path
$directory = Split-Path $AppPath -Parent
foreach ($name in @('chrome.dll', 'chrome_elf.dll', 'icudtl.dat', 'resources.pak', 'bay-ui/index.html', 'bay-ui/native_host.mojom-webui.js')) {
    if (-not (Test-Path (Join-Path $directory $name))) { throw "Missing runtime file $name" }
}
$data = Join-Path ([IO.Path]::GetTempPath()) ('Bay-smoke-' + [guid]::NewGuid())
$previousData = $env:BAY_DATA_DIR
$process = $null
try {
    $env:BAY_DATA_DIR = $data
    $arguments = @("--user-data-dir=`"$data`"", '--enable-features=Webium,SurfaceEmbed')
    if ($HostingSpike) { $arguments += '--bay-hosting-spike' }
    $process = Start-Process -FilePath $AppPath -ArgumentList $arguments -WorkingDirectory $directory -PassThru
    $deadline = (Get-Date).AddSeconds($StartupSeconds)
    $windowAppeared = $false
    while ((Get-Date) -lt $deadline) {
        Start-Sleep -Milliseconds 250
        $process.Refresh()
        if ($process.HasExited) { throw "Bay exited during startup with code $($process.ExitCode)" }
        if ($process.MainWindowHandle -ne [IntPtr]::Zero) { $windowAppeared = $true; break }
    }
    if (-not $windowAppeared) { throw "Bay did not create a desktop window in $StartupSeconds seconds" }
    Start-Sleep -Seconds 2
    $process.Refresh()
    if ($process.HasExited) { throw "Bay exited after creating its window: $($process.ExitCode)" }
    Write-Output 'Liveness passed: Bay created a desktop window and remained running'
    Write-Output 'This does not pass the Windows hosting gate; record that separately using packaging/windows/hosting-gate.md'
} finally {
    $env:BAY_DATA_DIR = $previousData
    if ($process) {
        $process.Refresh()
        if (-not $process.HasExited) {
            $process.CloseMainWindow() | Out-Null
            if (-not $process.WaitForExit(5000)) { Stop-Process -Id $process.Id -Force }
        }
    }
    # The profile lives outside an installed/user profile. Preserve it on failure
    # so Crashpad dumps and Chromium logs can be inspected.
    Write-Output "Smoke profile: $data"
}
