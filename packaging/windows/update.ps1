# Invoked by Bay's update command. The publisher pins come from the signed build.
[CmdletBinding()]
param([switch]$CheckOnly)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$config = Get-Content (Join-Path $PSScriptRoot 'update-config.json') -Raw | ConvertFrom-Json
if (-not $config.enabled) { throw 'Updates are disabled for this unsigned or unconfigured build' }
if (([uri]$config.feedUrl).Scheme -ne 'https') { throw 'An HTTPS update feed is required' }
$feed = Invoke-RestMethod -Uri $config.feedUrl -TimeoutSec 60
if ($feed.channel -ne $config.channel) { throw 'Update channel mismatch' }
if ($feed.version -notmatch '^\d+\.\d+\.\d+(\.\d+)?$') { throw 'Invalid update version' }
if ([version]$feed.version -le [version]$config.version) { Write-Output 'Bay is up to date'; exit 0 }
if (([uri]$feed.url).Scheme -ne 'https' -or $feed.sha256 -notmatch '^[a-fA-F0-9]{64}$') { throw 'Invalid update payload' }
if ($CheckOnly) { $feed | ConvertTo-Json; exit 0 }
$temporary = Join-Path ([IO.Path]::GetTempPath()) ('Bay-update-' + [guid]::NewGuid())
New-Item $temporary -ItemType Directory | Out-Null
try {
    $installer = Join-Path $temporary 'BaySetup.exe'
    Invoke-WebRequest -Uri $feed.url -OutFile $installer -TimeoutSec 300
    if ((Get-FileHash $installer -Algorithm SHA256).Hash -ne $feed.sha256) { throw 'Update checksum mismatch' }
    $signature = Get-AuthenticodeSignature $installer
    if ($signature.Status -ne 'Valid' -or -not $signature.SignerCertificate -or
        $signature.SignerCertificate.Thumbprint -notin $config.publisherThumbprints) {
        throw 'Update Authenticode signature does not match a trusted Bay publisher'
    }
    $payloadVersion = (Get-Item $installer).VersionInfo.ProductVersion
    if ($payloadVersion -notmatch '^\d+\.\d+\.\d+(\.\d+)?$' -or [version]$payloadVersion -ne [version]$feed.version) {
        throw 'Signed installer version does not match the update feed'
    }
    # Inno Setup uses Restart Manager to close running Bay processes and applies
    # the same per-user installation. No elevated process or shell URL is used.
    $process = Start-Process -FilePath $installer -ArgumentList '/SP-', '/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/CLOSEAPPLICATIONS' -PassThru -Wait
    if ($process.ExitCode -ne 0) { throw "Installer failed with exit code $($process.ExitCode)" }
    Start-Process -FilePath (Join-Path $PSScriptRoot 'Bay.exe')
} finally {
    Remove-Item $temporary -Recurse -Force -ErrorAction SilentlyContinue
}
