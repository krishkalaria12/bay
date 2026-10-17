[CmdletBinding()]
param(
    [Parameter(Mandatory)][ValidatePattern('^\d+\.\d+\.\d+(\.\d+)?$')][string]$Version,
    [Parameter(Mandatory)][string]$AppDirectory,
    [string]$OutputDirectory,
    [ValidateSet('stable', 'beta')][string]$Channel = 'beta',
    [string]$FeedUrl = $env:BAY_WINDOWS_UPDATE_FEED,
    [string]$DownloadBaseUrl = $env:BAY_WINDOWS_DOWNLOAD_BASE,
    [switch]$Unsigned
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$repo = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
if (-not $OutputDirectory) { $OutputDirectory = Join-Path $repo 'dist/windows' }
$AppDirectory = (Resolve-Path $AppDirectory).Path
if (-not (Test-Path (Join-Path $AppDirectory 'Bay.exe'))) { throw "Missing Bay.exe in $AppDirectory" }
if (-not (Test-Path (Join-Path $AppDirectory 'nncore.dll'))) { throw 'Stage the verified engine artifact before packaging' }
if ($env:BAY_SIGNING_CERT_SHA1 -and $env:BAY_SIGNING_CERT_SHA1 -notmatch '^[a-fA-F0-9]{40}$') { throw 'BAY_SIGNING_CERT_SHA1 must be a certificate thumbprint' }
if (-not $Unsigned -and -not $env:BAY_SIGNING_CERT_SHA1 -and -not $env:BAY_SIGNING_DLIB) {
    throw 'Configure BAY_SIGNING_CERT_SHA1 or BAY_SIGNING_DLIB and BAY_SIGNING_METADATA, or pass -Unsigned for local testing'
}
if ($FeedUrl -and ([uri]$FeedUrl).Scheme -ne 'https') { throw 'FeedUrl must use HTTPS' }
if ($DownloadBaseUrl -and ([uri]$DownloadBaseUrl).Scheme -ne 'https') { throw 'DownloadBaseUrl must use HTTPS' }
$compiler = Get-Command ISCC.exe -ErrorAction SilentlyContinue
if (-not $compiler) {
    $inno = Join-Path ${env:ProgramFiles(x86)} 'Inno Setup 6/ISCC.exe'
    if (-not (Test-Path $inno)) { throw 'Install Inno Setup 6 or add ISCC.exe to PATH' }
    $compilerPath = $inno
} else { $compilerPath = $compiler.Source }
$stage = Join-Path ([IO.Path]::GetTempPath()) ('Bay-package-' + [guid]::NewGuid())
New-Item $stage -ItemType Directory | Out-Null
New-Item $OutputDirectory -ItemType Directory -Force | Out-Null
$OutputDirectory = (Resolve-Path $OutputDirectory).Path
try {
    Copy-Item (Join-Path $AppDirectory '*') $stage -Recurse
    Copy-Item (Join-Path $repo 'LICENSE'), (Join-Path $repo 'NOTICE') $stage
    Copy-Item (Join-Path $repo 'packaging/windows/licenses') $stage -Recurse
    # Keep debugging symbols separate from the downloadable application.
    Get-ChildItem $stage -Filter '*.pdb' -Recurse | Remove-Item
    Copy-Item (Join-Path $repo 'packaging/windows/update.ps1') $stage
    $signArgs = @('/fd', 'SHA256', '/tr', 'http://timestamp.digicert.com', '/td', 'SHA256')
    if (-not $Unsigned) {
        $signtool = (Get-Command signtool.exe -ErrorAction Stop).Source
        if ($env:BAY_SIGNING_DLIB) {
            if (-not $env:BAY_SIGNING_METADATA) { throw 'BAY_SIGNING_METADATA is required with BAY_SIGNING_DLIB' }
            $signArgs += @('/dlib', $env:BAY_SIGNING_DLIB, '/dmdf', $env:BAY_SIGNING_METADATA)
        } else { $signArgs += @('/sha1', $env:BAY_SIGNING_CERT_SHA1) }
        foreach ($file in Get-ChildItem $stage -Recurse -File | Where-Object { $_.Extension -in '.exe', '.dll' }) {
            & $signtool sign @signArgs $file.FullName
            if ($LASTEXITCODE -ne 0) { throw "Signing failed: $($file.FullName)" }
        }
    }
    $publisher = if ($Unsigned) { @() } else { @((Get-AuthenticodeSignature (Join-Path $stage 'Bay.exe')).SignerCertificate.Thumbprint) }
    @{ enabled = (-not $Unsigned -and [bool]$FeedUrl); version = $Version; channel = $Channel;
       feedUrl = $FeedUrl; publisherThumbprints = $publisher } | ConvertTo-Json | Set-Content (Join-Path $stage 'update-config.json') -Encoding utf8
    # Inno signs its generated uninstaller at compile time, then the setup binary.
    $arguments = @("/DAppVersion=$Version", "/DStageDir=$stage", "/DOutputDir=$OutputDirectory")
    if (-not $Unsigned) {
        $command = '"' + $signtool + '" sign ' + (($signArgs | ForEach-Object { '"' + $_ + '"' }) -join ' ') + ' $f'
        $arguments += '/DSignToolCommand=1', "/Sbay=$command"
    }
    & $compilerPath @arguments (Join-Path $repo 'packaging/windows/Bay.iss')
    if ($LASTEXITCODE -ne 0) { throw 'Inno Setup compilation failed' }
    $installer = Join-Path $OutputDirectory "Bay-$Version-windows-x64-setup.exe"
    if (-not (Test-Path $installer)) { throw 'Installer was not produced' }
    if (-not $Unsigned -and (Get-AuthenticodeSignature $installer).Status -ne 'Valid') { throw 'Installer signature validation failed' }
    $checksum = (Get-FileHash $installer -Algorithm SHA256).Hash.ToLowerInvariant()
    "$checksum  $([IO.Path]::GetFileName($installer))" | Set-Content "$installer.sha256" -Encoding ascii
    $notes = Join-Path $repo "release-notes/$Version.md"
    $releaseNotes = if (Test-Path $notes) { Get-Content $notes -Raw } else { '' }
    @{ version = $Version; channel = $Channel; sha256 = $checksum; signed = -not $Unsigned;
       url = if ($DownloadBaseUrl) { $DownloadBaseUrl.TrimEnd('/') + '/' + [IO.Path]::GetFileName($installer) } else { $null };
       releaseNotes = $releaseNotes } | ConvertTo-Json | Set-Content (Join-Path $OutputDirectory "$Channel.json") -Encoding utf8
    $pdbs = @(Get-ChildItem $AppDirectory -Recurse -Filter '*.pdb' -File)
    if ($pdbs.Count) { Compress-Archive -Path $pdbs.FullName -DestinationPath (Join-Path $OutputDirectory "Bay-$Version-windows-x64-symbols.zip") -Force }
    Write-Output $installer
} finally { Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue }
