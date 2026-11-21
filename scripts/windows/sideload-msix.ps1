# Signs a copy of an MSIX from package.ps1 -Msix with a throwaway certificate, for installing it outside the Store.
#
#   pwsh -File scripts/windows/sideload-msix.ps1 -Package dist/windows/Bay-X.Y.Z-windows-x64.msix
#
# Writes <name>-sideload.msix and Bay-sideload.cer beside the package. The certificate's subject is the package's
# Publisher, as Windows requires; its private key is deleted once the copy is signed. To install on a test PC, trust
# the certificate once from an administrator PowerShell, then open the .msix:
#
#   Import-Certificate -FilePath Bay-sideload.cer -CertStoreLocation Cert:\LocalMachine\TrustedPeople
[CmdletBinding()]
param([Parameter(Mandatory)][string]$Package)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$Package = (Resolve-Path $Package).Path
if ([IO.Path]::GetExtension($Package) -ne '.msix') { throw "$Package isn't an .msix" }
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [IO.Compression.ZipFile]::OpenRead($Package)
try {
    $entry = $archive.GetEntry('AppxManifest.xml')
    if (-not $entry) { throw "$Package has no AppxManifest.xml" }
    $reader = New-Object IO.StreamReader($entry.Open())
    try { [xml]$manifest = $reader.ReadToEnd() } finally { $reader.Dispose() }
} finally { $archive.Dispose() }
$publisher = $manifest.Package.Identity.Publisher
if (-not $publisher) { throw 'The package manifest names no publisher' }

$signtool = (Get-Command signtool.exe -ErrorAction SilentlyContinue).Source
if (-not $signtool) {
    $sdk = Get-ChildItem (Join-Path ${env:ProgramFiles(x86)} 'Windows Kits/10/bin') -Directory |
        Sort-Object { try { [version]$_.Name } catch { [version]'0.0' } } -Descending |
        Where-Object { Test-Path (Join-Path $_.FullName 'x64/signtool.exe') } | Select-Object -First 1
    if (-not $sdk) { throw 'Install the Windows SDK or add signtool.exe to PATH' }
    $signtool = Join-Path $sdk.FullName 'x64/signtool.exe'
}

$directory = Split-Path $Package -Parent
$copy = Join-Path $directory ([IO.Path]::GetFileNameWithoutExtension($Package) + '-sideload.msix')
$certificatePath = Join-Path $directory 'Bay-sideload.cer'
Copy-Item $Package $copy -Force
# Code signing (1.3.6.1.5.5.7.3.3), not a certificate authority.
$certificate = New-SelfSignedCertificate -Type Custom -Subject $publisher -KeyUsage DigitalSignature `
    -FriendlyName 'Bay sideload test' -CertStoreLocation Cert:\CurrentUser\My -NotAfter (Get-Date).AddYears(1) `
    -TextExtension @('2.5.29.37={text}1.3.6.1.5.5.7.3.3', '2.5.29.19={text}')
try {
    & $signtool sign /fd SHA256 /sha1 $certificate.Thumbprint $copy
    if ($LASTEXITCODE -ne 0) { throw 'Signing the sideload copy failed' }
    Export-Certificate -Cert $certificate -FilePath $certificatePath -Type CERT | Out-Null
} finally {
    Remove-Item "Cert:\CurrentUser\My\$($certificate.Thumbprint)" -DeleteKey -Force -ErrorAction SilentlyContinue
}
Write-Output $copy
Write-Output $certificatePath
