# Machine-readable updater. Policy is an Authenticode-covered PE resource.
[CmdletBinding()]
param(
    [ValidateSet('State', 'Check', 'Stage', 'Install', 'Apply')][string]$Mode = 'Install',
    [int]$ParentProcessId = 0,
    [switch]$Deferred,
    [switch]$UseStaged,
    [switch]$CheckOnly,
    [string]$StateFile,
    [string]$TrustedStateJson
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Set-StrictMode -Version Latest
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)

function Write-Result($Value) { ConvertTo-Json -InputObject $Value -Compress -Depth 12 | Write-Output }
function Get-Origin([uri]$Uri) {
    if (-not $Uri.IsAbsoluteUri -or $Uri.Scheme -ne 'https' -or $Uri.UserInfo) { throw 'Update URLs must use HTTPS without credentials' }
    return $Uri.GetLeftPart([UriPartial]::Authority).TrimEnd('/').ToLowerInvariant()
}
function Assert-Origin([uri]$Uri, $Config) {
    if ((Get-Origin $Uri) -notin $Config.allowedOrigins) { throw 'Update URL origin is not allowed by the signed policy' }
}
function Test-Publisher($Signature, $Config) {
    if ($Signature.Status -ne 'Valid' -or -not $Signature.SignerCertificate) { return $false }
    if ($Signature.SignerCertificate.Thumbprint -in $Config.publisherThumbprints) { return $true }
    # Azure rotates short-lived certificates. An explicitly enabled, signed
    # publisher identity permits renewal while preserving Authenticode trust.
    if ($Config.PSObject.Properties['allowPublisherRenewal'] -and $Config.allowPublisherRenewal -and
        $Config.PSObject.Properties['publisherSubject'] -and $Config.publisherSubject) {
        return $Signature.SignerCertificate.Subject -ceq $Config.publisherSubject
    }
    return $false
}
function Read-Policy([string]$AppPath) {
    if (-not ('Bay.UpdateResources' -as [type])) {
        Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
namespace Bay {
  public static class UpdateResources {
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr LoadLibraryEx(string path, IntPtr file, uint flags);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool FreeLibrary(IntPtr module);
    [DllImport("kernel32.dll", EntryPoint="FindResourceW", SetLastError=true)] static extern IntPtr FindResource(IntPtr module, IntPtr name, IntPtr type);
    [DllImport("kernel32.dll", SetLastError=true)] static extern uint SizeofResource(IntPtr module, IntPtr resource);
    [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr LoadResource(IntPtr module, IntPtr resource);
    [DllImport("kernel32.dll")] static extern IntPtr LockResource(IntPtr resource);
    public static string Read(string path) {
      IntPtr module = LoadLibraryEx(path, IntPtr.Zero, 0x22);
      if (module == IntPtr.Zero) throw new Win32Exception();
      try {
        IntPtr resource = FindResource(module, new IntPtr(201), new IntPtr(10));
        if (resource == IntPtr.Zero) throw new InvalidOperationException("No signed Bay update policy");
        uint size = SizeofResource(module, resource);
        if (size == 0 || size > 1024*1024) throw new InvalidOperationException("Invalid update policy size");
        IntPtr data = LockResource(LoadResource(module, resource));
        if (data == IntPtr.Zero) throw new Win32Exception();
        byte[] bytes = new byte[size]; Marshal.Copy(data, bytes, 0, bytes.Length);
        return Encoding.UTF8.GetString(bytes);
      } finally { FreeLibrary(module); }
    }
  }
}
'@
    }
    $config = [Bay.UpdateResources]::Read($AppPath) | ConvertFrom-Json
    if (-not $config.enabled) { return $config }
    $signature = Get-AuthenticodeSignature -FilePath $AppPath
    if (-not (Test-Publisher $signature $config)) {
        throw 'The installed application update policy is not signed by a trusted publisher'
    }
    if ($config.channel -notin @('stable', 'beta')) { throw 'Invalid installed update channel' }
    if ($config.appVersion -notmatch '^\d+\.\d+\.\d+(\.\d+)?$' -or $config.appVersion -ne $config.version) { throw 'Invalid installed version' }
    Assert-Origin ([uri]$config.feedUrl) $config
    return $config
}
function Save-TrustedDownload([uri]$Uri, [string]$Destination, [long]$MaximumBytes, $Config) {
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    for ($redirect = 0; $redirect -le 5; $redirect++) {
        Assert-Origin $Uri $Config
        $request = [Net.HttpWebRequest]::Create($Uri)
        $request.AllowAutoRedirect = $false
        $request.Timeout = 120000
        $request.ReadWriteTimeout = 120000
        $response = $request.GetResponse()
        try {
            $status = [int]$response.StatusCode
            if ($status -ge 300 -and $status -lt 400) {
                $location = $response.Headers['Location']
                if (-not $location) { throw 'Update redirect has no destination' }
                $Uri = [uri]::new($Uri, $location)
                continue
            }
            if ($status -ne 200 -or $response.ContentLength -gt $MaximumBytes) { throw 'Invalid update response or size' }
            $source = $response.GetResponseStream()
            $target = [IO.File]::Open($Destination, [IO.FileMode]::Create, [IO.FileAccess]::Write, [IO.FileShare]::None)
            try {
                $buffer = New-Object byte[] 1048576
                [long]$total = 0
                while (($count = $source.Read($buffer, 0, $buffer.Length)) -gt 0) {
                    $total += $count
                    if ($total -gt $MaximumBytes) { throw 'Update response exceeds the allowed size' }
                    $target.Write($buffer, 0, $count)
                }
            } finally { $target.Dispose(); $source.Dispose() }
            return
        } finally { $response.Dispose() }
    }
    throw 'Too many update redirects'
}
function Get-Version([string]$Value) {
    if ($Value -notmatch '^\d+\.\d+\.\d+(\.\d+)?$') { throw 'Invalid update version' }
    $version = [version]$Value
    return [version]::new($version.Major, $version.Minor, $version.Build, [Math]::Max(0, $version.Revision))
}
function Assert-Feed($Feed, $Config) {
    if ($Feed.channel -ne $Config.channel -or $Feed.signed -isnot [bool] -or -not $Feed.signed) { throw 'Update channel is invalid or unsigned' }
    $null = Get-Version $Feed.version
    Assert-Origin ([uri]$Feed.url) $Config
    if ($Feed.sha256 -notmatch '^[a-fA-F0-9]{64}$') { throw 'Invalid update checksum' }
}
function Assert-Payload([string]$Installer, $Feed, $Config) {
    if ((Get-FileHash $Installer -Algorithm SHA256).Hash -ne $Feed.sha256) { throw 'Update checksum mismatch' }
    $signature = Get-AuthenticodeSignature -FilePath $Installer
    if (-not (Test-Publisher $signature $Config)) { throw 'Update publisher signature does not match' }
    $version = (Get-Item $Installer).VersionInfo.ProductVersion
    if ((Get-Version $version) -ne (Get-Version $Feed.version) -or
        (Get-Version $version) -le (Get-Version $Config.appVersion)) { throw 'Signed installer version does not match a newer update' }
}
function Get-StagedUpdate($Config) {
    $pending = Join-Path $env:LOCALAPPDATA "Bay/Updates/pending-$($Config.channel).json"
    if (-not (Test-Path -LiteralPath $pending)) { return $null }
    if ((Get-Item -LiteralPath $pending).Length -gt 1048576) { throw 'Invalid staged update metadata size' }
    $feed = Get-Content -LiteralPath $pending -Raw | ConvertFrom-Json
    Assert-Feed $feed $Config
    if ((Get-Version $feed.version) -le (Get-Version $Config.appVersion)) { return $null }
    $installer = Join-Path $env:LOCALAPPDATA "Bay/Updates/$($Config.channel)/$($feed.version)/BaySetup.exe"
    Assert-Payload $installer $feed $Config
    return [pscustomobject]@{ feed = $feed; installer = $installer }
}
function Test-ApplyCancelled([string]$StatePath) {
    return Test-Path -LiteralPath ($StatePath + '.cancel')
}
function Wait-ApplyParent($Parent, [string]$StatePath, [bool]$ApplyDeferred) {
    if (Test-ApplyCancelled $StatePath) { return $false }
    if ($Parent) {
        $deadline = [DateTime]::UtcNow.AddMinutes(2)
        while (-not $Parent.WaitForExit(250)) {
            if (Test-ApplyCancelled $StatePath) { return $false }
            if (-not $ApplyDeferred -and [DateTime]::UtcNow -ge $deadline) {
                throw 'Bay did not exit; update was left staged'
            }
        }
    }
    return -not (Test-ApplyCancelled $StatePath)
}
function New-ApplyCommand([string]$Source, [string]$StatePath, [int]$ParentId, [bool]$ApplyDeferred, [string]$ApplyStateJson = '') {
    # Carry the already authenticated script in the worker command. A writable
    # .ps1 copy in the cache would be executable code outside the signed policy.
    $memory = [IO.MemoryStream]::new()
    $gzip = [IO.Compression.GZipStream]::new($memory, [IO.Compression.CompressionLevel]::Optimal, $true)
    $writer = [IO.StreamWriter]::new($gzip, [Text.UTF8Encoding]::new($false))
    $payload = @{ source = $Source; state = $ApplyStateJson } | ConvertTo-Json -Compress -Depth 4
    try { $writer.Write($payload) } finally { $writer.Dispose() }
    try { $compressed = [Convert]::ToBase64String($memory.ToArray()) } finally { $memory.Dispose() }
    $deferredArgument = if ($ApplyDeferred) { '-Deferred' } else { '' }
    $stateArgument = if ($ApplyStateJson) { '-TrustedStateJson $payload.state' } else { '' }
    $bootstrap = '$memory = [IO.MemoryStream]::new([Convert]::FromBase64String(''{0}''), $false); $gzip = [IO.Compression.GZipStream]::new($memory, [IO.Compression.CompressionMode]::Decompress); $reader = [IO.StreamReader]::new($gzip, [Text.Encoding]::UTF8); $payload = $reader.ReadToEnd() | ConvertFrom-Json; $reader.Dispose(); & ([scriptblock]::Create($payload.source)) -Mode Apply -StateFile ''{1}'' -ParentProcessId {2} {3} {4}' -f $compressed, $StatePath.Replace("'", "''"), $ParentId, $deferredArgument, $stateArgument
    $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($bootstrap))
    if ($encoded.Length -gt 28000) { throw 'The authenticated update worker exceeds the Windows command-line limit' }
    return $encoded
}

$temporary = $null
try {
    if ($CheckOnly) { $Mode = 'Check' }
    if ($Mode -eq 'Apply') {
        if (-not $StateFile -or $ParentProcessId -le 0) { throw 'Apply requires a staged state and parent process' }
        if (Test-ApplyCancelled $StateFile) {
            Write-Result @{ status = 'cancelled' }
            exit 0
        }
        # appPath, installer and feed were frozen by the authenticated parent
        # script. Cache metadata is writable and must not select another signed
        # Bay executable's older policy or change the approved release.
        if (-not $TrustedStateJson) { throw 'Apply requires authenticated worker state' }
        $state = $TrustedStateJson | ConvertFrom-Json
        # Hold a handle to this exact process, avoiding PID reuse after it exits.
        $parent = Get-Process -Id $ParentProcessId -ErrorAction SilentlyContinue
        if (-not (Wait-ApplyParent $parent $StateFile ([bool]$Deferred))) {
            Write-Result @{ status = 'cancelled' }
            exit 0
        }
        $config = Read-Policy $state.appPath
        if (-not $config.enabled) { throw 'Updates are disabled' }
        if (($config | ConvertTo-Json -Compress -Depth 12) -cne
            ($state.policy | ConvertTo-Json -Compress -Depth 12)) {
            throw 'The installed application update policy changed while the update was waiting'
        }
        Assert-Feed $state.feed $config
        Assert-Payload $state.installer $state.feed $config
        if (Test-ApplyCancelled $StateFile) {
            Write-Result @{ status = 'cancelled' }
            exit 0
        }
        $process = Start-Process -FilePath $state.installer -ArgumentList '/SP-', '/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/CLOSEAPPLICATIONS' -Wait -PassThru
        if ($process.ExitCode -ne 0) { throw "Installer failed with exit code $($process.ExitCode)" }
        # Deferred updates apply after a natural quit and must not reopen Bay.
        if (-not $Deferred) { Start-Process -FilePath $state.appPath | Out-Null }
        Write-Result @{ status = 'installed'; version = $state.feed.version }
        exit 0
    }
    $appPath = Join-Path $PSScriptRoot 'Bay.exe'
    $config = Read-Policy $appPath
    if (-not $config.enabled -or $env:BAY_DATA_DIR) {
        Write-Result @{ status = 'disabled'; configured = $false; currentVersion = $config.appVersion; appVersion = $config.appVersion; buildNumber = $config.buildNumber; feedUrl = $null }
        exit 0
    }
    if ($Mode -eq 'State') {
        $staged = $null
        # A cache entry is a hint. Recheck the signed policy, feed, installer
        # checksum, publisher and version before recovering it after a restart.
        try { $staged = Get-StagedUpdate $config } catch { $staged = $null }
        Write-Result @{ status = 'ready'; configured = $true; currentVersion = $config.appVersion; appVersion = $config.appVersion;
            buildNumber = $config.buildNumber; channel = $config.channel; feedUrl = $config.feedUrl;
            staged = [bool]$staged; version = $(if ($staged) { $staged.feed.version } else { $null }) }
        exit 0
    }
    $pendingPath = Join-Path $env:LOCALAPPDATA "Bay/Updates/pending-$($config.channel).json"
    if ($UseStaged) {
        if ($Mode -ne 'Install') { throw 'UseStaged is only valid for Install' }
        $staged = Get-StagedUpdate $config
        if (-not $staged) {
            Write-Result @{ status = 'up-to-date'; currentVersion = $config.appVersion; version = $config.appVersion }
            exit 0
        }
        $feed = $staged.feed
    } else {
        $temporary = Join-Path ([IO.Path]::GetTempPath()) ('Bay-update-check-' + [guid]::NewGuid())
        New-Item $temporary -ItemType Directory | Out-Null
        $feedPath = Join-Path $temporary 'feed.json'
        Save-TrustedDownload ([uri]$config.feedUrl) $feedPath 1048576 $config
        $feed = Get-Content -LiteralPath $feedPath -Raw | ConvertFrom-Json
    }
    Assert-Feed $feed $config
    if ((Get-Version $feed.version) -le (Get-Version $config.appVersion)) {
        Write-Result @{ status = 'up-to-date'; currentVersion = $config.appVersion; version = $config.appVersion }
        exit 0
    }
    if ($Mode -eq 'Check') {
        Write-Result @{ status = 'available'; currentVersion = $config.appVersion; version = $feed.version; releaseNotes = $feed.releaseNotes }
        exit 0
    }
    $cache = Join-Path $env:LOCALAPPDATA "Bay/Updates/$($config.channel)/$($feed.version)"
    New-Item $cache -ItemType Directory -Force | Out-Null
    $installer = Join-Path $cache 'BaySetup.exe'
    if (-not (Test-Path $installer) -or (Get-FileHash $installer -Algorithm SHA256).Hash -ne $feed.sha256) {
        if ($UseStaged) { throw 'The staged installer is missing or modified' }
        $partial = Join-Path $temporary 'BaySetup.exe'
        Save-TrustedDownload ([uri]$feed.url) $partial 2147483648 $config
        Assert-Payload $partial $feed $config
        Move-Item $partial $installer -Force
    }
    Assert-Payload $installer $feed $config
    $pendingTemporary = $pendingPath + '.' + [guid]::NewGuid() + '.tmp'
    $feed | ConvertTo-Json -Depth 12 | Set-Content $pendingTemporary -Encoding utf8
    Move-Item $pendingTemporary $pendingPath -Force
    if ($Mode -eq 'Stage') {
        Write-Result @{ status = 'staged'; currentVersion = $config.appVersion; version = $feed.version }
        exit 0
    }
    if ($ParentProcessId -le 0) { throw 'Install requires ParentProcessId so it can wait for Bay to exit' }
    $worker = Join-Path $cache ('apply-' + [guid]::NewGuid())
    New-Item $worker -ItemType Directory | Out-Null
    $workerStateJson = @{ appPath = $appPath; installer = $installer; feed = $feed; policy = $config } | ConvertTo-Json -Depth 12
    $workerStateJson | Set-Content (Join-Path $worker 'state.json') -Encoding utf8
    $start = New-Object Diagnostics.ProcessStartInfo
    $start.FileName = Join-Path $PSHOME 'powershell.exe'
    if (-not (Test-Path $start.FileName)) { $start.FileName = Join-Path $PSHOME 'pwsh.exe' }
    # ShellExecute creates an independent worker without inheriting the CLI's
    # captured stdout pipe, so native callers receive EOF immediately.
    $start.UseShellExecute = $true
    $start.WindowStyle = [Diagnostics.ProcessWindowStyle]::Hidden
    $source = [IO.File]::ReadAllText($PSCommandPath, [Text.Encoding]::UTF8)
    $encoded = New-ApplyCommand $source (Join-Path $worker 'state.json') $ParentProcessId ([bool]$Deferred) $workerStateJson
    $start.Arguments = '-NoLogo -NoProfile -NonInteractive -EncodedCommand ' + $encoded
    $process = [Diagnostics.Process]::Start($start)
    if (-not $process) { throw 'Could not start the updater worker' }
    Write-Result @{ status = 'installing'; currentVersion = $config.appVersion; version = $feed.version; deferred = [bool]$Deferred;
        workerProcessId = $process.Id; cancelPath = (Join-Path $worker 'state.json.cancel') }
} catch {
    $failure = @{ status = 'error'; message = $_.Exception.Message }
    if ($Mode -eq 'Apply' -and $StateFile) {
        $failure | ConvertTo-Json -Compress | Set-Content ($StateFile + '.result.json') -Encoding utf8 -ErrorAction SilentlyContinue
    }
    Write-Result $failure
    exit 1
} finally {
    if ($temporary -and (Test-Path $temporary)) { Remove-Item $temporary -Recurse -Force -ErrorAction SilentlyContinue }
}
