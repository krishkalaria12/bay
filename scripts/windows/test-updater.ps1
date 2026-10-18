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
function Get-Item {
    param($Path, $LiteralPath)
    if ($LiteralPath) { return [IO.FileInfo]::new($LiteralPath) }
    return [pscustomobject]@{ VersionInfo = [pscustomobject]@{ ProductVersion = $script:productVersion } }
}
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
$fixture = 'param($Mode, $StateFile, $ParentProcessId, [switch]$Deferred) @{ mode=$Mode; path=$StateFile; parent=$ParentProcessId; deferred=[bool]$Deferred } | ConvertTo-Json -Compress'
$path = 'C:\Bay\quote'' $(throw ''must not execute'')\state.json'
foreach ($deferred in @($false, $true)) {
    $encoded = New-ApplyCommand $fixture $path 123 $deferred
    $bootstrap = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String($encoded))
    $result = (& ([scriptblock]::Create($bootstrap))) | ConvertFrom-Json
    if ($result.mode -ne 'Apply' -or $result.path -cne $path -or $result.parent -ne 123 -or $result.deferred -ne $deferred) {
        throw 'Authenticated worker arguments changed during encoding'
    }
}
$temporary = Join-Path ([IO.Path]::GetTempPath()) ('Bay-updater-test-' + [guid]::NewGuid())
$previousLocalAppData = $env:LOCALAPPDATA
try {
    $env:LOCALAPPDATA = $temporary
    $updates = Join-Path $temporary 'Bay/Updates'
    $null = New-Item -ItemType Directory -Path $updates -Force
    $pending = Join-Path $updates 'pending-beta.json'
    $script:signature.Status = 'Valid'
    $script:signature.SignerCertificate.Thumbprint = 'trusted'
    $script:productVersion = '1.2.4'
    if (Get-StagedUpdate $config) { throw 'Missing cache was accepted' }
    $feed | ConvertTo-Json | Set-Content -LiteralPath $pending
    $staged = Get-StagedUpdate $config
    if ($staged.feed.version -ne '1.2.4' -or $staged.installer -ne (Join-Path $updates 'beta/1.2.4/BaySetup.exe')) {
        throw 'Staged update did not resolve to the canonical cache path'
    }
    $script:hash = 'b' * 64
    Assert-Throws { Get-StagedUpdate $config }
    $script:hash = 'a' * 64
    $script:signature.Status = 'HashMismatch'
    Assert-Throws { Get-StagedUpdate $config }
    $script:signature.Status = 'Valid'
    $feed.version = '../escape'
    $feed | ConvertTo-Json | Set-Content -LiteralPath $pending
    Assert-Throws { Get-StagedUpdate $config }

    $statePath = Join-Path $temporary 'state.json'
    $fixture = 'param($Mode, $StateFile, $ParentProcessId, [switch]$Deferred, $TrustedStateJson) $TrustedStateJson'
    $trusted = @{ appPath = $path; feed = @{ version = '1.2.4' }; policy = @{ appVersion = '1.2.3'; channel = 'beta' } } | ConvertTo-Json -Compress
    [IO.File]::WriteAllText($statePath, $trusted)
    $encoded = New-ApplyCommand $fixture $statePath 123 $true $trusted
    [IO.File]::WriteAllText($statePath, '{"appPath":"C:\\old-bay\\Bay.exe"}')
    $bootstrap = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String($encoded))
    if ((& ([scriptblock]::Create($bootstrap))) -cne $trusted) {
        throw 'Worker trusted modified cache metadata instead of its authenticated arguments'
    }
    if (-not (Wait-ApplyParent $null $statePath $false)) { throw 'Exited parent was not accepted' }
    [IO.File]::WriteAllText($statePath + '.cancel', '')
    if (Wait-ApplyParent $null $statePath $true) { throw 'Cancelled worker can still install' }
    Remove-Item -LiteralPath ($statePath + '.cancel')
    $parent = [pscustomobject]@{ calls = 0; statePath = $statePath }
    $parent | Add-Member -MemberType ScriptMethod -Name WaitForExit -Value {
        param($milliseconds)
        $this.calls++
        [IO.File]::WriteAllText($this.statePath + '.cancel', '')
        return $false
    }
    if (Wait-ApplyParent $parent $statePath $true) { throw 'Waiting worker ignored cancellation' }
    if ($parent.calls -ne 1) { throw 'Cancelled worker kept waiting for the parent' }
} finally {
    $env:LOCALAPPDATA = $previousLocalAppData
    Remove-Item -LiteralPath $temporary -Recurse -Force -ErrorAction SilentlyContinue
}
Write-Output 'Updater policy, payload, authenticated worker, cache recovery and cancellation checks passed'
