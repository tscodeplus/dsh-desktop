# ============================================================================
# DSH Desktop Build Script
# ============================================================================
# Automates: WSL sync → dsh fetch/build (single-mode git-follow) → dep
# flattening → sidecar build → Node runtime fetch → Tauri packaging
#
# Usage (Windows PowerShell, run from desktop/ directory):
#   .\scripts\build.ps1                  # Build portable + NSIS installer (default)
#   .\scripts\build.ps1 -Portable        # Build portable only (win-unpacked)
#   .\scripts\build.ps1 -Nsis            # Build NSIS installer only
#   .\scripts\build.ps1 -Clean           # Clean before building
#   .\scripts\build.ps1 -SkipClean       # Override -Clean: keep src-tauri/target
#   .\scripts\build.ps1 -NoSync          # Skip WSL code sync
#   .\scripts\build.ps1 -SyncOnly        # Only sync code from WSL, no build
#   .\scripts\build.ps1 -SkipFetchDsh    # Skip fetch-dsh (use existing .dsh-build)
#   .\scripts\build.ps1 -CheckOnly       # Only verify prerequisites
#
# From WSL2:
#   powershell.exe -File "E:\Code\dsh-desktop\desktop\scripts\build.ps1"
# ============================================================================

param(
    [switch]$Portable,
    [switch]$Nsis,
    [switch]$Clean,
    [switch]$SkipClean,
    [switch]$NoSync,
    [switch]$SyncOnly,
    [switch]$SkipFetchDsh,
    [switch]$CheckOnly
)

# ---------------------------------------------------------------------------
# Setup
# ---------------------------------------------------------------------------

$ErrorActionPreference = "Stop"
$ScriptDir = $PSScriptRoot
$DesktopDir = Split-Path -Parent $ScriptDir
$RootDir = Split-Path -Parent $DesktopDir   # repo root (WSL sync source)

# Use npmmirror for the bundled Node runtime download (fetch-node.cjs default;
# GitHub often unreachable from China). Override via NODE_MIRROR.
$env:NODE_MIRROR = "https://npmmirror.com/mirrors/node"

# Default: build all targets (portable + NSIS)
# -Portable: only portable
# -Nsis: only NSIS
if (-not $Portable -and -not $Nsis) {
    $Portable = $true
    $Nsis = $true
}

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

$StartTime = Get-Date

function Write-Step([string]$msg) {
    Write-Host ""
    Write-Host ">>> $msg" -ForegroundColor Cyan
}

function Write-OK([string]$msg) {
    Write-Host "    OK  $msg" -ForegroundColor Green
}

function Write-Warn([string]$msg) {
    Write-Host "    WARN  $msg" -ForegroundColor Yellow
}

function Write-Fail([string]$msg) {
    Write-Host "    FAIL  $msg" -ForegroundColor Red
}

function Write-Info([string]$msg) {
    Write-Host "    ..  $msg" -ForegroundColor Gray
}

# Run a command via cmd /c to avoid PowerShell treating stderr as fatal errors.
# Returns ($success: bool, $output: string)
function Invoke-Cmd([string]$command, [string]$cwd) {
    $prevEA = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    $prevCwd = Get-Location
    try {
        Set-Location $cwd
        # Set CI=true so pnpm doesn't prompt for TTY on clean builds
        $env:CI = "true"
        $output = cmd /c "$command 2>&1" 2>&1 | Out-String
        $success = ($LASTEXITCODE -eq 0)
        return @{ Success = $success; Output = $output }
    } finally {
        Set-Location $prevCwd
        $ErrorActionPreference = $prevEA
    }
}

# Canonical installer lookup: newest NSIS setup in the bundle dir. Shared by
# the rename step (Invoke-TauriBuild) and the summary (Write-Summary) so the
# two can never drift apart.
function Get-LatestInstaller {
    Get-ChildItem "$DesktopDir\src-tauri\target\release\bundle\nsis\*.exe" -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending |
        Select-Object -First 1
}

# ---------------------------------------------------------------------------
# Prerequisite checks
# ---------------------------------------------------------------------------

function Check-Prerequisites {
    Write-Step "Checking prerequisites"

    $errors = @()

    # Node.js (>= 22.19 — dsh engines; 24 LTS recommended)
    try {
        $nodeVer = node --version 2>&1 | Out-String
        Write-OK "Node.js $($nodeVer.Trim())"
        $major = [int]($nodeVer.Trim() -replace '^v(\d+)\..*', '$1')
        if ($major -lt 22) {
            $errors += "Node.js >= 22.19 required (dsh engines). Found $($nodeVer.Trim())"
        }
    } catch {
        $errors += "Node.js not found. Install from https://nodejs.org/"
    }

    # pnpm (11.x — matches dsh's packageManager). Look for the .cmd shim
    # (npm global also ships pnpm.ps1, but cmd /c can't run .ps1 — it may
    # even hang on the "how do you want to open this file" dialog), fall
    # back to pnpm.exe. Run it via cmd /c from a local cwd: executing a
    # .cmd directly from a UNC working directory (powershell.exe invoked
    # from WSL) fails because cmd.exe rejects UNC cwds — the old code
    # worked around that with a Push-Location C:\ hack.
    $pnpm = Get-Command pnpm.cmd -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $pnpm) { $pnpm = Get-Command pnpm.exe -ErrorAction SilentlyContinue | Select-Object -First 1 }
    if ($pnpm) {
        $r = Invoke-Cmd "`"$($pnpm.Source)`" --version" $env:TEMP
        $pnpmVer = ($r.Output -split "`n" | Where-Object { $_ -match '^\d+\.\d+\.\d+' } | Select-Object -First 1).Trim()
        if ($r.Success -and $pnpmVer) {
            Write-OK "pnpm v$pnpmVer"
        } else {
            $errors += "pnpm not found. Install with: npm install -g pnpm@11"
        }
    } else {
        $errors += "pnpm not found. Install with: npm install -g pnpm@11"
    }

    # Rust toolchain (Tauri)
    try {
        $rustVer = rustc --version 2>&1 | Out-String
        Write-OK "Rust $($rustVer.Trim())"
    } catch {
        $errors += "rustc not found. Install via https://rustup.rs (MSVC toolchain required)"
    }

    # Check key files
    if (-not (Test-Path "$DesktopDir\package.json")) {
        $errors += "desktop/package.json not found at $DesktopDir"
    }
    if (-not (Test-Path "$DesktopDir\dsh-ref.json")) {
        $errors += "desktop/dsh-ref.json not found (dependency following manifest)"
    }
    if (-not (Test-Path "$DesktopDir\src-tauri\tauri.conf.json")) {
        $errors += "src-tauri/tauri.conf.json not found"
    }

    if ($errors.Count -gt 0) {
        Write-Host ""
        Write-Host "=== PREREQUISITE ERRORS ===" -ForegroundColor Red
        foreach ($e in $errors) {
            Write-Host "  X $e" -ForegroundColor Red
        }
        exit 1
    }

    Write-OK "All prerequisites satisfied"
    Write-Info "Root:    $RootDir"
    Write-Info "Desktop: $DesktopDir"
}

# ---------------------------------------------------------------------------
# Clean
# ---------------------------------------------------------------------------

function Invoke-Clean {
    Write-Step "Cleaning previous build artifacts"

    $dirs = @(
        "$DesktopDir\.sidecar-deps",
        "$DesktopDir\.dsh-build",
        "$DesktopDir\src-tauri\target"
    )

    foreach ($dir in $dirs) {
        if (Test-Path $dir) {
            try {
                Remove-Item -Path $dir -Recurse -Force -ErrorAction Stop
                Write-OK "Removed $($dir.Replace($DesktopDir, '...'))"
            } catch {
                Write-Warn "Could not remove $dir - may be locked"
                Write-Info "Waiting 3s and retrying..."
                Start-Sleep -Seconds 3
                try {
                    Remove-Item -Path $dir -Recurse -Force -ErrorAction Stop
                    Write-OK "Removed (retry)"
                } catch {
                    Write-Fail "Cannot remove $dir. Close other programs and retry."
                    throw
                }
            }
        }
    }
}

# ---------------------------------------------------------------------------
# Kill stale processes
# ---------------------------------------------------------------------------

function Invoke-KillStaleProcesses {
    $stale = Get-Process -Name "dsh-desktop" -ErrorAction SilentlyContinue
    if ($stale) {
        Write-Step "Killing stale dsh-desktop processes"
        $stale | Stop-Process -Force -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 2
        Write-OK "Terminated $($stale.Count) dsh-desktop process(es)"
    }
}

# ---------------------------------------------------------------------------
# Sync code from WSL
# ---------------------------------------------------------------------------

# Default WSL source path (Linux side) and Windows target path.
# Override via environment variables or edit the defaults below.
$WslSourcePath = if ($env:DSHD_WSL_SRC) { $env:DSHD_WSL_SRC } else { "/home/iwapu/projects/dsh-desktop/" }
$WinTargetPath  = if ($env:DSHD_WIN_TARGET) { $env:DSHD_WIN_TARGET } else { "E:\Code\dsh-desktop" }

function Invoke-SyncCode {
    Write-Step "Syncing code from WSL"

    # Check if wsl.exe is available (faster than `wsl --status` and avoids
    # UNC-path issues when powershell.exe is invoked from inside WSL).
    $wslExe = Get-Command wsl.exe -ErrorAction SilentlyContinue
    if (-not $wslExe) {
        Write-Warn "wsl.exe not found — skipping sync"
        Write-Info "Run this script from Windows to sync from WSL."
        return
    }

    # Convert Windows path (E:\Code\dsh-desktop) to WSL path
    $winDrive = ($WinTargetPath -replace '^([A-Za-z]):.*', '$1').ToLower()
    $wslTarget = $WinTargetPath -replace '^[A-Za-z]:', "/mnt/$winDrive" -replace '\\', '/'

    Write-Info "Source: $WslSourcePath"
    Write-Info "Target: $WinTargetPath (WSL: $wslTarget)"

    # rsync with an explicit --exclude list — the same contract as AGENTS.md
    # ("Syncing Code to Windows"). Do NOT switch back to `git ls-files ... |
    # rsync --delete --files-from=-`: with --files-from, --delete also removes
    # target-side files inside every directory the list touches — that deletes
    # node_modules/.sidecar-deps/src-tauri/target on Windows and forces a full
    # re-fetch of everything. Excluding the artifact dirs explicitly is the
    # only way --delete stays safe. .git is excluded (not needed for builds);
    # .codegraph too — its unix socket (daemon.sock) can't be written on
    # drvfs and makes rsync exit with code 23.
    $rsyncCmd = "cd '$WslSourcePath' && rsync -av --delete " +
        "--exclude='node_modules' --exclude='dist' --exclude='.dsh-build' " +
        "--exclude='.sidecar-deps' --exclude='src-tauri/target' " +
        "--exclude='coverage' --exclude='.env' --exclude='*.log' " +
        "--exclude='.git' --exclude='.codegraph' " +
        "./ '$wslTarget'"
    Write-Info "Running: wsl bash -c 'rsync -av --delete --exclude=...'"

    $prevEA = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    $proc = Start-Process -FilePath "wsl.exe" -ArgumentList "bash", "-c", $rsyncCmd -NoNewWindow -Wait -PassThru -RedirectStandardOutput "$env:TEMP\dsh-rsync-stdout.txt" -RedirectStandardError "$env:TEMP\dsh-rsync-stderr.txt"
    $success = ($proc.ExitCode -eq 0)
    $ErrorActionPreference = $prevEA

    if ($success) {
        Write-OK "Code synced successfully"
    } else {
        # rsync often exits non-zero on harmless errors (socket files, etc.)
        Write-Warn "rsync completed with warnings (non-fatal)"
        try {
            $errOutput = Get-Content "$env:TEMP\dsh-rsync-stderr.txt" -ErrorAction SilentlyContinue
            if ($errOutput) {
                $lines = $errOutput -split "`n"
                $lastLines = $lines[-5..-1] | Where-Object { $_ }
                foreach ($line in $lastLines) { Write-Info $line.Trim() }
            }
        } catch { }
    }
    Remove-Item "$env:TEMP\dsh-rsync-stdout.txt", "$env:TEMP\dsh-rsync-stderr.txt" -ErrorAction SilentlyContinue
}

# ---------------------------------------------------------------------------
# dsh fetch + build (single-mode git-follow, per dsh-ref.json)
# ---------------------------------------------------------------------------

function Invoke-FetchDsh {
    Write-Step "Fetching + building dsh (desktop/dsh-ref.json)"

    $r = Invoke-Cmd "pnpm fetch:dsh" $DesktopDir
    if (-not $r.Success) {
        Write-Fail "fetch-dsh failed (install/build of the pinned dsh ref)"
        Write-Host $r.Output
        throw "fetch-dsh failed"
    }

    if (-not (Test-Path "$DesktopDir\.dsh-build\dist\apps\cli\lib\bin.js")) {
        Write-Warn ".dsh-build/dist/apps/cli/lib/bin.js not found — the sidecar spawn path may need updating"
    }
    Write-OK "dsh built at .dsh-build/dist"
}

# ---------------------------------------------------------------------------
# Shell dependencies (typescript, tauri CLI, undici, ws ...)
# ---------------------------------------------------------------------------

function Invoke-DesktopDeps {
    Write-Step "Installing shell dependencies (desktop/node_modules)"

    # pnpm >=10.30 / 11 block unapproved dependency build scripts by
    # default (strictDepBuilds). The desktop build never runs those scripts
    # (tsc-only; esbuild etc. are dev-only), so disable the strict gate.
    $installCmd = "pnpm install --frozen-lockfile --config.strict-dep-builds=false"
    if (Test-Path "$DesktopDir\pnpm-lock.yaml") {
        $r = Invoke-Cmd $installCmd $DesktopDir
    } else {
        $r = Invoke-Cmd "pnpm install --config.strict-dep-builds=false" $DesktopDir
    }
    if (-not $r.Success) {
        Write-Fail "pnpm install failed for the shell"
        Write-Host $r.Output
        throw "pnpm install failed"
    }
    if (-not (Test-Path "$DesktopDir\node_modules\.bin\tsc.cmd")) {
        Write-Fail "tsc not found after pnpm install — shell deps incomplete"
        throw "shell deps incomplete"
    }
    Write-OK "Shell dependencies installed"
}

# ---------------------------------------------------------------------------
# Bundle dependencies
# ---------------------------------------------------------------------------

function Invoke-BundleDeps {
    Write-Step "Bundling dependencies (flat node_modules)"

    $r = Invoke-Cmd "node scripts/bundle-deps.cjs" $DesktopDir

    $nmPath = "$DesktopDir\.sidecar-deps\node_modules"
    if (Test-Path $nmPath) {
        $count = (Get-ChildItem $nmPath).Count
        if ($count -gt 10) {
            Write-OK "$count packages staged in .sidecar-deps/node_modules/"
        } else {
            Write-Fail "Only $count packages staged — expected 300+. bundle-deps likely failed."
            Write-Host $r.Output
            throw "bundle-deps produced too few packages"
        }
    } else {
        Write-Fail "bundle-deps failed — .sidecar-deps/node_modules/ not created"
        Write-Host $r.Output
        throw "bundle-deps failed"
    }
}

# ---------------------------------------------------------------------------
# Sidecar TypeScript build
# ---------------------------------------------------------------------------

function Invoke-SidecarBuild {
    Write-Step "Building sidecar TypeScript"

    $r = Invoke-Cmd "pnpm build:sidecar" $DesktopDir

    if (-not $r.Success) {
        Write-Fail "Sidecar TypeScript build failed"
        Write-Host $r.Output
        throw "Sidecar tsc failed"
    }

    Write-OK "Sidecar compiled to .sidecar-deps\root"
}

# ---------------------------------------------------------------------------
# Version consistency check (desktop / tauri.conf.json)
# ---------------------------------------------------------------------------

function Invoke-VersionCheck {
    Write-Step "Checking version consistency"
    $desktopVer = (Get-Content "$DesktopDir\package.json" | ConvertFrom-Json).version
    $tauriVer = (Get-Content "$DesktopDir\src-tauri\tauri.conf.json" -Raw | ConvertFrom-Json).version
    if ($desktopVer -ne $tauriVer) {
        Write-Fail "Version mismatch: desktop=$desktopVer tauri.conf=$tauriVer"
        throw "Version mismatch — keep desktop/package.json and src-tauri/tauri.conf.json in sync"
    }
    Write-OK "Versions consistent: $desktopVer"
}

# ---------------------------------------------------------------------------
# Bundled Node runtime download
# ---------------------------------------------------------------------------

function Invoke-NodeRuntime {
    Write-Step "Fetching bundled Node runtime (desktop/.node-version)"

    $r = Invoke-Cmd "node scripts/fetch-node.cjs" $DesktopDir
    if (-not $r.Success) {
        Write-Fail "Node runtime download failed"
        Write-Host $r.Output
        throw "fetch-node failed"
    }
    Write-OK $r.Output
}

# ---------------------------------------------------------------------------
# Bundled pnpm (plugin management runs `dsh plugin` which spawns pnpm)
# ---------------------------------------------------------------------------

function Invoke-FetchPnpm {
    Write-Step "Fetching bundled pnpm (desktop/pnpm-version.json)"

    $r = Invoke-Cmd "node scripts/fetch-pnpm.cjs" $DesktopDir
    if (-not $r.Success) {
        Write-Fail "pnpm download failed"
        Write-Host $r.Output
        throw "fetch-pnpm failed"
    }
    Write-OK $r.Output
}

# ---------------------------------------------------------------------------
# Tauri build (NSIS installer + exe in src-tauri/target/release)
# ---------------------------------------------------------------------------

function Invoke-TauriBuild {
    Write-Step "Building Tauri app (NSIS)"

    $r = Invoke-Cmd "npx tauri build --bundles nsis" $DesktopDir

    if (-not $r.Success) {
        Write-Fail "tauri build failed"
        Write-Host $r.Output
        throw "tauri build failed"
    }

    # tauri v2 has no artifact-name config — the NSIS file comes out as
    # DSH Desktop_<v>_x64-setup.exe. Rename to the canonical
    # DSH-Desktop-Setup-<v>.exe so the updater's latest.yml URL
    # keeps working, then write latest.yml next to it.
    $setup = Get-LatestInstaller
    if ($setup) {
        $version = (Get-Content "$DesktopDir\package.json" | ConvertFrom-Json).version
        # Rename-Item never overwrites an existing target, even with -Force —
        # drop a stale installer from a previous build first.
        $target = "DSH-Desktop-Setup-$version.exe"
        $targetPath = "$DesktopDir\src-tauri\target\release\bundle\nsis\$target"
        try {
            if (Test-Path $targetPath) { Remove-Item $targetPath -Force -ErrorAction Stop }
            Rename-Item -Force $setup.FullName $target -ErrorAction Stop
        } catch {
            throw "Installer rename failed: $($_.Exception.Message). Fresh installer is still at $($setup.FullName)"
        }
        Write-OK "Renamed installer to $target"
        # latest.yml consumed by the in-app updater (release-meta.cjs).
        Invoke-Cmd "node scripts/release-meta.cjs `"$targetPath`" $version" $DesktopDir | Out-Null
    }

    Write-OK "Tauri build complete"
}

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------

function Write-Summary {
    Write-Host ""
    Write-Host "======================================" -ForegroundColor Green
    Write-Host " BUILD COMPLETE" -ForegroundColor Green
    Write-Host "======================================" -ForegroundColor Green

    $elapsed = [math]::Round(((Get-Date) - $StartTime).TotalSeconds, 1)
    Write-Host "  Duration: ${elapsed}s" -ForegroundColor White

    $exe = "$DesktopDir\src-tauri\target\release\dsh-desktop.exe"
    if (Test-Path $exe) {
        $exeSize = [math]::Round((Get-Item $exe).Length / 1MB, 1)
        Write-Host "  EXE (portable): src-tauri\target\release\dsh-desktop.exe  (${exeSize} MB)" -ForegroundColor White
    }

    $setupExe = Get-LatestInstaller
    if ($setupExe) {
        $setupSize = [math]::Round($setupExe.Length / 1MB, 1)
        Write-Host "  NSIS:     src-tauri\target\release\bundle\nsis\$($setupExe.Name)  (${setupSize} MB)" -ForegroundColor White
    }

    Write-Host ""
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

Write-Host ""
Write-Host "========================================" -ForegroundColor Magenta
Write-Host " DSH Desktop Builder" -ForegroundColor Magenta
Write-Host "========================================" -ForegroundColor Magenta
Write-Host "  Portable : $Portable" -ForegroundColor Gray
Write-Host "  NSIS     : $Nsis" -ForegroundColor Gray
Write-Host "  Clean    : $Clean" -ForegroundColor Gray
Write-Host "  Sync     : $(-not $NoSync)" -ForegroundColor Gray
Write-Host ""

Check-Prerequisites

if ($CheckOnly) {
    Write-Host ""
    Write-OK "All checks passed. Ready to build."
    exit 0
}

Invoke-KillStaleProcesses

# ── Sync ──
if (-not $NoSync) {
    Invoke-SyncCode
} else {
    Write-Step "Skipping WSL code sync (-NoSync)"
}

if ($SyncOnly) {
    Write-Host ""
    Write-OK "Sync complete. Exiting (-SyncOnly)."
    exit 0
}

# Version check must run after sync (the synced files are what gets built)
# and before fetch-dsh — the slowest step — so a mismatch fails fast instead
# of burning several minutes on fetch+build first.
Invoke-VersionCheck

if ($Clean) {
    if ($SkipClean) {
        Write-Step "Skipping clean (-SkipClean)"
    } else {
        Invoke-Clean
    }
}

if (-not $SkipFetchDsh) {
    Invoke-FetchDsh
} else {
    Write-Step "Skipping dsh fetch/build (-SkipFetchDsh)"
}

Invoke-DesktopDeps
Invoke-BundleDeps
Invoke-SidecarBuild
Invoke-NodeRuntime
Invoke-FetchPnpm

if ($Portable -or $Nsis) {
    Invoke-TauriBuild
} else {
    Write-Step "No bundle targets selected — nothing to build"
}

Write-Summary
