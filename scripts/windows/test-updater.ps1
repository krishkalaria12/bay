# Security/contract checks using the actual updater functions and deterministic
# certificate/file mocks. No network, certificate store, or installer is used.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$repo = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$tokens = $null; $errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile((Join-Path $repo 'packaging/windows/update.ps1'), [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw ($errors | Out-String) }
foreach ($function in $ast.FindAll({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $false)) {
    Invoke-Expression $function.Extent.Text
}
function Assert-Throws([scriptblock]$Action) {
    $threw = $false
    try { & $Action } catch { $threw = $true }
    if (-not $threw) { throw 'Expected operation to be rejected' }
}
$script:signature = [pscustomobject]@{ Status = 'Valid'; SignerCertificate = [pscustomobject]@{ Thumbprint = 'trusted'; Subject = 'CN=Bay Publisher' } }
$script:hash = 'a' * 64
$script:productVersion = '1.2.4.0'
function Get-AuthenticodeSignature { param($FilePath) return $script:signature }
function Get-FileHash { param($Path, $Algorithm) return [pscustomobject]@{ Hash = $script:hash } }
function Get-Item { param($Path) return [pscustomobject]@{ VersionInfo = [pscustomobject]@{ ProductVersion = $script:productVersion } } }
$config = [pscustomobject]@{ appVersion = '1.2.3'; channel = 'beta'; publisherThumbprints = @('trusted'); allowedOrigins = @('https://updates.example.test') }
$feed = [pscustomobject]@{ version = '1.2.4'; channel = 'beta'; signed = $true; sha256 = 'a' * 64; url = 'https://updates.example.test/releases/setup.exe' }
Assert-Feed $feed $config
Assert-Payload 'mock.exe' $feed $config
if ((Get-Version '1.2.4') -ne (Get-Version '1.2.4.0')) { throw 'Three/four component versions compare differently' }
Assert-Throws { Assert-Origin ([uri]'http://updates.example.test/setup.exe') $config }
Assert-Throws { Assert-Origin ([uri]'https://untrusted.example.test/setup.exe') $config }
Assert-Throws { Assert-Origin ([uri]'https://user:password@updates.example.test/setup.exe') $config }
$feed.channel = 'stable'; Assert-Throws { Assert-Feed $feed $config }; $feed.channel = 'beta'
$feed.signed = $false; Assert-Throws { Assert-Feed $feed $config }; $feed.signed = $true
$feed.sha256 = 'bad'; Assert-Throws { Assert-Feed $feed $config }; $feed.sha256 = 'a' * 64
$script:hash = 'b' * 64; Assert-Throws { Assert-Payload 'mock.exe' $feed $config }; $script:hash = 'a' * 64
$script:signature.Status = 'HashMismatch'; Assert-Throws { Assert-Payload 'mock.exe' $feed $config }; $script:signature.Status = 'Valid'
$script:signature.SignerCertificate.Thumbprint = 'wrong'; Assert-Throws { Assert-Payload 'mock.exe' $feed $config }; $script:signature.SignerCertificate.Thumbprint = 'trusted'
$script:productVersion = '1.2.3'; Assert-Throws { Assert-Payload 'mock.exe' $feed $config }
$script:productVersion = '1.2.5'; Assert-Throws { Assert-Payload 'mock.exe' $feed $config }
Assert-Throws { Get-Version '../../escape' }
$config | Add-Member -NotePropertyName allowPublisherRenewal -NotePropertyValue $true
$config | Add-Member -NotePropertyName publisherSubject -NotePropertyValue 'CN=Bay Publisher'
$script:productVersion = '1.2.4.0'
$script:signature.SignerCertificate.Thumbprint = 'renewed'
Assert-Payload 'mock.exe' $feed $config
$script:signature.SignerCertificate.Subject = 'CN=Another Publisher'
Assert-Throws { Assert-Payload 'mock.exe' $feed $config }
$script:signature.SignerCertificate.Subject = 'CN=Bay Publisher'
$script:signature.Status = 'NotTrusted'
Assert-Throws { Assert-Payload 'mock.exe' $feed $config }
Write-Output 'Updater origin, channel, checksum, signature, version and downgrade checks passed'
