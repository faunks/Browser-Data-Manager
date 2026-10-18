# Browser Data Manager - one-click launcher for a bare Windows PC.
#
# Needs nothing pre-installed (no Node, no npm, no git). On first run it:
#   1. downloads a portable Node.js into .\.runtime\node   (official zip, SHA-256 verified, no admin rights)
#   2. runs `npm ci` to fetch the dependencies
#   3. starts the app with --open
# Every later run skips straight to step 3. Delete .\.runtime and .\node_modules to reset.
#
# Usage:  start.bat                    (double-click)
#         start.bat --open=chrome      (any server flag is passed through)
#         start.bat --no-open          (don't open a browser window)

$ErrorActionPreference = 'Stop'
$ProgressPreference    = 'SilentlyContinue'   # Windows PowerShell 5.1 downloads are ~10x slower with the progress bar
Set-Location -LiteralPath $PSScriptRoot

# ---- settings -------------------------------------------------------------------------------
$NodeMajor    = 22                 # LTS line that better-sqlite3 11 / classic-level 1 ship prebuilt binaries for
$NodeFallback = 'v22.22.2'         # used only if nodejs.org's version index can't be read
$SystemNodeOk = 18, 20, 22         # an already-installed Node of these majors is used instead of downloading
# ---------------------------------------------------------------------------------------------

function Say($m)  { Write-Host "[bdm] $m" -ForegroundColor Cyan }
function Fail($m) { Write-Host ""; Write-Host "[bdm] ERROR: $m" -ForegroundColor Red; exit 1 }

# Older Windows 10 builds default to TLS 1.0/1.1, which nodejs.org rejects. 3072 = TLS 1.2.
try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor 3072 } catch {}

if (-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'server.js'))) {
    Fail "server.js not found next to this script. If you opened it from inside the .zip, extract the whole folder first."
}

# ---- pass-through args ----------------------------------------------------------------------
$appArgs = @($args)
$noOpen  = $appArgs -contains '--no-open'
$appArgs = @($appArgs | Where-Object { $_ -ne '--no-open' })
if (-not $noOpen -and -not ($appArgs | Where-Object { $_ -eq '--open' -or $_ -like '--open=*' })) {
    $appArgs += '--open'
}

# ---- already running? -----------------------------------------------------------------------
$port = if ($env:PORT) { [int]$env:PORT } else { 4321 }
try {
    $c = New-Object Net.Sockets.TcpClient
    $iar = $c.BeginConnect('127.0.0.1', $port, $null, $null)
    $up = $iar.AsyncWaitHandle.WaitOne(400) -and $c.Connected
    $c.Close()
} catch { $up = $false }
if ($up) {
    Say "Something is already listening on port $port - probably a Browser Data Manager that is already running."
    Say "Use its existing browser window. If you closed it, close the old console window (or Ctrl+C it) and run start.bat again:"
    Say "access needs a fresh single-use link that only the starting server can create."
    exit 0
}

# ---- 1. find or download Node ---------------------------------------------------------------
$node = $null; $npm = $null; $nodeVer = $null

$sysNode = Get-Command node.exe -ErrorAction SilentlyContinue
$sysNpm  = Get-Command npm.cmd  -ErrorAction SilentlyContinue
if ($sysNode -and $sysNpm) {
    try {
        $v = (& $sysNode.Source -v).Trim()
        if ($SystemNodeOk -contains [int]($v.TrimStart('v').Split('.')[0])) {
            $node = $sysNode.Source; $npm = $sysNpm.Source; $nodeVer = $v
            Say "Using installed Node $v"
        }
    } catch {}
}

if (-not $node) {
    $arch = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
    switch ($arch) {
        'AMD64' { $plat = 'win-x64' }
        'ARM64' { $plat = 'win-x64' }   # classic-level has no win-arm64 binary; Windows runs x64 Node via emulation
        default { Fail "Unsupported CPU architecture '$arch' (need 64-bit Windows)." }
    }

    $runtime = Join-Path $PSScriptRoot '.runtime'
    $nodeDir = Join-Path $runtime 'node'

    if (-not (Test-Path -LiteralPath (Join-Path $nodeDir 'node.exe'))) {
        New-Item -ItemType Directory -Force -Path $runtime | Out-Null

        $ver = $NodeFallback
        try {
            $idx = Invoke-RestMethod -Uri 'https://nodejs.org/dist/index.json' -UseBasicParsing -TimeoutSec 30
            $hit = $idx | Where-Object { $_.version -like "v$NodeMajor.*" -and ($_.files -contains "$plat-zip") } | Select-Object -First 1
            if ($hit) { $ver = $hit.version }
        } catch { Say "Couldn't read the Node version index, using $NodeFallback." }

        $name = "node-$ver-$plat"
        $base = "https://nodejs.org/dist/$ver"
        $zip  = Join-Path $runtime "$name.zip"

        Say "Downloading Node $ver ($plat), about 30 MB..."
        try { Invoke-WebRequest -Uri "$base/$name.zip" -OutFile $zip -UseBasicParsing -TimeoutSec 600 }
        catch { Fail "Couldn't download Node from nodejs.org: $($_.Exception.Message)`nCheck your internet connection / proxy / firewall and run again." }

        Say "Verifying checksum..."
        try {
            $sums = (Invoke-WebRequest -Uri "$base/SHASUMS256.txt" -UseBasicParsing -TimeoutSec 60).Content -split "`n"
            $line = $sums | Where-Object { $_ -match "\s$([regex]::Escape($name)).zip\s*$" } | Select-Object -First 1
            if (-not $line) { throw "no checksum listed for $name.zip" }
            $want = ($line.Trim() -split '\s+')[0].ToLower()
        } catch { Remove-Item -LiteralPath $zip -Force -ErrorAction SilentlyContinue; Fail "Couldn't get the checksum list: $($_.Exception.Message)" }
        $got = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLower()
        if ($got -ne $want) { Remove-Item -LiteralPath $zip -Force -ErrorAction SilentlyContinue; Fail "Checksum mismatch on the Node download (corrupt or tampered). Run again." }

        Say "Extracting..."
        $tmp = Join-Path $runtime 'extract.tmp'
        if (Test-Path -LiteralPath $tmp) { Remove-Item -LiteralPath $tmp -Recurse -Force }
        Add-Type -AssemblyName System.IO.Compression.FileSystem
        [IO.Compression.ZipFile]::ExtractToDirectory($zip, $tmp)
        if (Test-Path -LiteralPath $nodeDir) { Remove-Item -LiteralPath $nodeDir -Recurse -Force }
        Move-Item -LiteralPath (Join-Path $tmp $name) -Destination $nodeDir   # only appears once fully extracted
        Remove-Item -LiteralPath $tmp -Recurse -Force
        Remove-Item -LiteralPath $zip -Force
    }

    $node = Join-Path $nodeDir 'node.exe'
    $npm  = Join-Path $nodeDir 'npm.cmd'
    $nodeVer = (& $node -v).Trim()
    Say "Using portable Node $nodeVer"
}

# npm's install scripts look up `node` on PATH, so put the chosen one first.
$env:PATH = (Split-Path -Parent $node) + ';' + $env:PATH

# ---- 2. dependencies ------------------------------------------------------------------------
# Re-install when package-lock.json changes or the Node version does (native modules are ABI-specific).
$lock  = Join-Path $PSScriptRoot 'package-lock.json'
$stamp = Join-Path $PSScriptRoot 'node_modules\.bdm-installed'
$want  = $nodeVer + '|' + $(if (Test-Path -LiteralPath $lock) { (Get-FileHash -LiteralPath $lock -Algorithm SHA256).Hash } else { 'nolock' })
$have  = if (Test-Path -LiteralPath $stamp) { (Get-Content -LiteralPath $stamp -Raw).Trim() } else { '' }

if ($have -ne $want) {
    Say "Installing dependencies (first run only, may take a minute)..."
    $verb = if (Test-Path -LiteralPath $lock) { 'ci' } else { 'install' }
    $ErrorActionPreference = 'Continue'
    & $npm $verb --no-audit --no-fund
    $code = $LASTEXITCODE
    $ErrorActionPreference = 'Stop'
    if ($code -ne 0) {
        Fail ("npm $verb failed (exit $code).`n" +
              "Most often this is no internet access to registry.npmjs.org / github.com (the prebuilt SQLite/LevelDB binaries come from there),`n" +
              "or a proxy/antivirus blocking it. Fix that and run start.bat again.")
    }
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $stamp) | Out-Null
    Set-Content -LiteralPath $stamp -Value $want -Encoding ASCII
}

# ---- 3. run ---------------------------------------------------------------------------------
Say "Starting Browser Data Manager  (Ctrl+C or close this window to stop)"
$ErrorActionPreference = 'Continue'
& $node server.js @appArgs
exit $LASTEXITCODE
