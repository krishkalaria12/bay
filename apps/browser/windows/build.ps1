[CmdletBinding()]
param(
  [ValidateSet('Debug', 'Release')][string]$Configuration = 'Debug',
  [string]$EngineDirectory = $env:BAY_WINDOWS_ENGINE_DIR,
  [switch]$Run
)
$ErrorActionPreference = 'Stop'
if (-not $EngineDirectory) { throw 'Set BAY_WINDOWS_ENGINE_DIR or pass -EngineDirectory with the verified engine artifact path.' }
$repo = (Resolve-Path (Join-Path $PSScriptRoot '../../..')).Path
$engineRoot = (Resolve-Path $EngineDirectory).Path
$engine = if (Test-Path (Join-Path $engineRoot "runtime")) { Join-Path $engineRoot "runtime" } else { $engineRoot }
$output = Join-Path $PSScriptRoot "x64/$Configuration/Bay"
foreach ($name in @('NNCore.dll', 'libcef.dll', 'chrome_elf.dll', 'bootstrap.exe')) {
  if (-not (Test-Path (Join-Path $engine $name))) { throw "Engine artifact is missing $name" }
}
$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio/Installer/vswhere.exe'
if (-not (Test-Path $vswhere)) { throw 'Install Visual Studio with Desktop development with C++ and Windows App SDK.' }
$msbuild = & $vswhere -latest -products '*' -requires Microsoft.Component.MSBuild -find 'MSBuild/**/Bin/MSBuild.exe' | Select-Object -First 1
if (-not $msbuild) { throw 'MSBuild was not found.' }
Push-Location (Join-Path $repo 'apps/browser')
try {
  & pnpm exec react-native autolink-windows --sln windows/Bay.sln
  if ($LASTEXITCODE) { throw 'React Native Windows autolinking failed.' }
  & $msbuild (Join-Path $PSScriptRoot 'Bay.sln') /restore /m "/p:Configuration=$Configuration" /p:Platform=x64
  if ($LASTEXITCODE) { throw 'Windows host build failed.' }
  New-Item -ItemType Directory -Force $output | Out-Null
  Copy-Item (Join-Path $engine '*') $output -Recurse -Force
  Copy-Item (Join-Path $engine 'bootstrap.exe') (Join-Path $output 'Bay.exe') -Force
  if ($Configuration -eq 'Release') {
    $bundle = Join-Path $output 'Bundle'
    New-Item -ItemType Directory -Force $bundle | Out-Null
    & pnpm exec react-native bundle --platform windows --dev false --entry-file index.windows.js --bundle-output (Join-Path $bundle 'index.windows.bundle') --assets-dest $bundle
    if ($LASTEXITCODE) { throw 'Windows JavaScript bundle failed.' }
  }
} finally { Pop-Location }
if ($Run) { Start-Process -FilePath (Join-Path $output 'Bay.exe') -WorkingDirectory $output }
Write-Output (Join-Path $output 'Bay.exe')
