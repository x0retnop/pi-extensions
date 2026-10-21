#Requires -Version 7.0
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [string]$DevPath = "C:\10x001\pi extensions",
    [string]$RuntimePath = "C:\Users\user\.pi\agent\extensions",

    # Compiled tree that is actually deployed. Built by scripts/build-extensions.py
    # (Pi loads .js far faster than .ts; see docs/ext-load-perf.md).
    [string]$ExtSourcePath = "",

    # Skip the tsc build and sync whatever is already in _build/extensions.
    [switch]$NoBuild,

    [string[]]$Exclude = @('.git', 'node_modules', '.playwright-mcp'),
    [switch]$NoWait,

    # Theme sync paths (flat directory of .json theme files).
    [string]$ThemesDevPath = "",
    [string]$ThemesRuntimePath = ""
)

$script:InnerWidth = 78

$ExcludeRegex = ($Exclude | ForEach-Object { [regex]::Escape($_) }) -join '|'

$DevPath = $DevPath.TrimEnd('\', '/')
$RuntimePath = $RuntimePath.TrimEnd('\', '/')

if ([string]::IsNullOrWhiteSpace($ExtSourcePath)) {
    $ExtSourcePath = Join-Path $DevPath "_build\extensions"
}
$ExtSourcePath = $ExtSourcePath.TrimEnd('\', '/')

# Files that must never exist in the runtime copy: .ts wins over index.js in Pi's
# loader, and a per-extension package.json ("type":"module") makes jiti try the
# native ESM path first and fall back (809 ms vs 152 ms for 17 extensions).
$script:StaleSuffixes = @('.ts')
$script:StaleNames = @('package.json')

if ([string]::IsNullOrWhiteSpace($ThemesDevPath)) {
    $ThemesDevPath = Join-Path $DevPath "themes"
}
if ([string]::IsNullOrWhiteSpace($ThemesRuntimePath)) {
    $runtimeParent = Split-Path -Parent $RuntimePath
    $ThemesRuntimePath = Join-Path $runtimeParent "themes"
}

# ── ASCII art 2026 chrome helpers ───────────────────────────────────────────

function Write-FrameTop {
    Write-Host ("╔" + ("═" * $script:InnerWidth) + "╗") -ForegroundColor Cyan
}

function Write-FrameBottom {
    Write-Host ("╚" + ("═" * $script:InnerWidth) + "╝") -ForegroundColor Cyan
}

function Write-FrameRow {
    param(
        [string]$Text = "",
        [System.ConsoleColor]$Color = 'White'
    )
    $padded = $Text.PadRight($script:InnerWidth).Substring(0, $script:InnerWidth)
    Write-Host "║" -ForegroundColor Cyan -NoNewline
    Write-Host $padded -ForegroundColor $Color -NoNewline
    Write-Host "║" -ForegroundColor Cyan
}

function Write-SectionTop {
    param([string]$Title = "")
    $prefix = "─[ $Title ]"
    $fill = $script:InnerWidth - $prefix.Length
    if ($fill -lt 0) { $fill = 0 }
    Write-Host ("┌" + $prefix + ("─" * $fill) + "┐") -ForegroundColor Cyan
}

function Write-SectionBottom {
    Write-Host ("└" + ("─" * $script:InnerWidth) + "┘") -ForegroundColor Cyan
}

function Write-SectionRow {
    param(
        [string]$Text = "",
        [System.ConsoleColor]$Color = 'White'
    )
    $padded = $Text.PadRight($script:InnerWidth).Substring(0, $script:InnerWidth)
    Write-Host "│" -ForegroundColor Cyan -NoNewline
    Write-Host $padded -ForegroundColor $Color -NoNewline
    Write-Host "│" -ForegroundColor Cyan
}

function Write-GlitchFence {
    Write-Host ("▓░▒" + (" ╳" * 38) + "▓") -ForegroundColor Magenta
}

function Write-StatusTag {
    param(
        [Parameter(Mandatory = $true)]
        [ValidateSet('OK', 'WARN', 'FAIL', 'INFO')]
        [string]$Status,

        [string]$Message = ""
    )
    $colorMap = @{
        'OK'   = 'Green'
        'WARN' = 'Yellow'
        'FAIL' = 'Red'
        'INFO' = 'Cyan'
    }
    $tag = "[$Status]"
    Write-Host $tag -ForegroundColor $colorMap[$Status] -NoNewline
    if ($Message) {
        Write-Host " $Message" -ForegroundColor White
    }
}

# ── core logic ──────────────────────────────────────────────────────────────

function Test-Excluded {
    param([string]$Path)
    return $Path -match "(\\|/)($ExcludeRegex)(\\|/)"
}

function Test-SameContent {
    param([System.IO.FileInfo]$A, [System.IO.FileInfo]$B)
    if ($A.Length -ne $B.Length) { return $false }
    $ha = (Get-FileHash -LiteralPath $A.FullName -Algorithm MD5).Hash
    $hb = (Get-FileHash -LiteralPath $B.FullName -Algorithm MD5).Hash
    return $ha -eq $hb
}

function Get-FileMap {
    param([string]$BasePath)
    $map = @{}
    Get-ChildItem -LiteralPath $BasePath -Recurse -File -ErrorAction SilentlyContinue | Where-Object {
        -not (Test-Excluded $_.FullName)
    } | ForEach-Object {
        $rel = $_.FullName.Substring($BasePath.Length).TrimStart('\', '/')
        $map[$rel] = $_
    }
    return $map
}

# Runtime files that must not survive a sync: stale .ts (Pi prefers index.ts over
# index.js) and per-extension package.json (forces jiti's slow native-ESM path).
function Test-StaleFile {
    param([string]$RelPath)
    $name = Split-Path -Leaf $RelPath
    if ($script:StaleNames -contains $name) { return $true }
    return $script:StaleSuffixes -contains [System.IO.Path]::GetExtension($name)
}

function Sync-Directory {
    [CmdletBinding(SupportsShouldProcess = $true)]
    param(
        [Parameter(Mandatory = $true)]
        [string]$SourceDir,
        [Parameter(Mandatory = $true)]
        [string]$DestDir,
        [string]$Label = "dir"
    )

    $result = [PSCustomObject]@{
        Label   = $Label
        Updated = [System.Collections.Generic.List[string]]::new()
        New     = [System.Collections.Generic.List[string]]::new()
        Removed = [System.Collections.Generic.List[string]]::new()
    }

    if (-not (Test-Path -LiteralPath $SourceDir)) {
        return $result
    }

    if (-not (Test-Path -LiteralPath $DestDir)) {
        New-Item -ItemType Directory -Path $DestDir -Force | Out-Null
    }

    $srcMap = Get-FileMap $SourceDir
    $runMap = Get-FileMap $DestDir

    # 1. copy / update from the compiled tree (content compare, not mtime —
    #    a rebuild touches every file, that must not read as "everything changed")
    foreach ($rel in $srcMap.Keys) {
        $srcFile = $srcMap[$rel]
        $runFile = $runMap[$rel]

        if ($runFile -and (Test-SameContent -A $srcFile -B $runFile)) {
            continue
        }

        $dest = Join-Path $DestDir $rel
        $destParent = Split-Path -Parent $dest
        if (-not (Test-Path -LiteralPath $destParent)) {
            New-Item -ItemType Directory -Path $destParent -Force | Out-Null
        }

        $action = if ($runFile) { "Copy" } else { "Copy new" }
        if ($PSCmdlet.ShouldProcess("$Label\$rel", $action)) {
            Copy-Item -LiteralPath $srcFile.FullName -Destination $dest -Force
        }

        if ($runFile) {
            $result.Updated.Add($rel)
        }
        else {
            $result.New.Add($rel)
        }
    }

    # 2. drop stale source/manifest files that the compiled tree does not have.
    foreach ($rel in $runMap.Keys) {
        if ($srcMap.ContainsKey($rel)) { continue }
        if (-not (Test-StaleFile $rel)) { continue }

        $dest = Join-Path $DestDir $rel
        if ($PSCmdlet.ShouldProcess("$Label\$rel", "Remove (stale)")) {
            Remove-Item -LiteralPath $dest -Force -ErrorAction SilentlyContinue
        }
        $result.Removed.Add($rel)
    }

    return $result
}

# ── exit helpers (defined before first use: the build step can exit early) ──

function Wait-AnyKey {
    param([string]$Message = "Press any key to exit...")
    Write-Host ""
    Write-Host $Message -ForegroundColor Cyan
    try {
        if ($Host.Name -eq 'ConsoleHost' -and $Host.UI.RawUI) {
            $null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")
        }
        else {
            Read-Host "Press Enter to exit"
        }
    }
    catch {
        Read-Host "Press Enter to exit"
    }
}

<#
    Is a keypress even possible? A human at a terminal has a console on both ends; an agent runs
    this with stdout captured (redirected), where the prompt can never be answered and the run
    hangs until the caller's timeout. Agents pass -NoWait explicitly — this is the safety net for
    the run that forgets, so a hung deploy never looks like a slow one.
#>
function Test-InteractiveConsole {
    try {
        if ([Console]::IsOutputRedirected -or [Console]::IsInputRedirected) { return $false }
    }
    catch {
        return $false
    }
    return $true
}

# Human run = pause for the keypress, then close the window that -File launched. Agent run =
# no pause (and no self-kill: killing this process would eat the caller's exit code).
$script:ShouldWait = (-not $NoWait) -and (Test-InteractiveConsole)

function Test-LaunchedAsScriptHost {
    $cmdLine = (Get-CimInstance Win32_Process -Filter "ProcessId=$PID").CommandLine
    return $cmdLine -match '\s-[Ff](?:ile)?\s'
}

# ── build (dev .ts -> _build/extensions/*.js) ───────────────────────────────

if (-not (Test-Path -LiteralPath $ExtSourcePath)) {
    $buildOk = $false
    $buildLog = "missing compiled tree: $ExtSourcePath (run without -NoBuild)"
}
elseif ($NoBuild) {
    $buildOk = $true
    $buildLog = "skipped (-NoBuild): using existing $ExtSourcePath"
}
else {
    $buildScript = Join-Path $DevPath "scripts\build-extensions.py"
    if (-not (Test-Path -LiteralPath $buildScript)) {
        $buildOk = $false
        $buildLog = "missing $buildScript"
    }
    else {
        $buildLog = (& python $buildScript 2>&1 | Out-String)
        $buildOk = ($LASTEXITCODE -eq 0)
    }
}

if (-not $buildOk) {
    Write-FrameTop
    Write-FrameRow -Text "  [FAIL] ▶ build failed - runtime untouched" -Color Red
    foreach ($line in ($buildLog -split "`r?`n")) {
        if ($line.Trim()) { Write-FrameRow -Text "  > $line" -Color Gray }
    }
    Write-FrameBottom
    if ($script:ShouldWait) { Wait-AnyKey }
    exit 1
}

# ── sync ────────────────────────────────────────────────────────────────────

$runtimeDirs = Get-ChildItem -LiteralPath $RuntimePath -Directory -ErrorAction SilentlyContinue
if (-not $runtimeDirs) {
    Write-FrameTop
    Write-FrameRow -Text "  [WARN] ▶ no extension folders found in runtime" -Color Yellow
    Write-FrameRow -Text "  > protocol: sync aborted" -Color Gray
    Write-FrameBottom
    exit 0
}

$updatedExts = [System.Collections.Generic.List[object]]::new()
$okExts      = [System.Collections.Generic.List[string]]::new()
$missingExts = [System.Collections.Generic.List[string]]::new()
$undeployed  = [System.Collections.Generic.List[string]]::new()

$updatedDirs = [System.Collections.Generic.List[object]]::new()
$okDirs      = [System.Collections.Generic.List[string]]::new()

$commonResult = Sync-Directory -SourceDir (Join-Path $ExtSourcePath "common") -DestDir (Join-Path $RuntimePath "common") -Label "common"
if ($commonResult.Updated.Count -gt 0 -or $commonResult.New.Count -gt 0 -or $commonResult.Removed.Count -gt 0) {
    $updatedDirs.Add($commonResult)
}
else {
    $okDirs.Add("common")
}

if (Test-Path -LiteralPath $ThemesDevPath) {
    $themesResult = Sync-Directory -SourceDir $ThemesDevPath -DestDir $ThemesRuntimePath -Label "themes"
    if ($themesResult.Updated.Count -gt 0 -or $themesResult.New.Count -gt 0) {
        $updatedDirs.Add($themesResult)
    }
    else {
        $okDirs.Add("themes")
    }
}
else {
    $okDirs.Add("themes (no dev dir)")
}

foreach ($dir in $runtimeDirs) {
    if ($dir.Name -eq "common") { continue }  # handled above
    $srcDir = Join-Path $ExtSourcePath $dir.Name
    if (-not (Test-Path -LiteralPath $srcDir)) {
        $missingExts.Add($dir.Name)
        continue
    }

    $extResult = Sync-Directory -SourceDir $srcDir -DestDir $dir.FullName -Label $dir.Name
    if ($extResult.Updated.Count -gt 0 -or $extResult.New.Count -gt 0 -or $extResult.Removed.Count -gt 0) {
        $updatedExts.Add($extResult)
    }
    else {
        $okExts.Add($dir.Name)
    }
}

# Compiled folders that exist but are not deployed anywhere: report only,
# deploying a new extension stays the user's call.
foreach ($srcDir in (Get-ChildItem -LiteralPath $ExtSourcePath -Directory -ErrorAction SilentlyContinue)) {
    if ($srcDir.Name -eq "common") { continue }
    if ($srcDir.Name -notin ($runtimeDirs | ForEach-Object { $_.Name })) {
        $undeployed.Add($srcDir.Name)
    }
}

# ── render ────────────────────────────────────────────────────────────────────

Write-Host ""
Write-FrameTop
Write-FrameRow -Text "  ▓▒░ S Y N C   E X T E N S I O N S ░▒▓" -Color White
Write-FrameRow -Text "  > protocol: extension sync initialized" -Color Gray
Write-FrameRow -Text "  > source: $ExtSourcePath" -Color Gray
Write-FrameRow -Text "  > target: $RuntimePath" -Color Gray
Write-FrameRow -Text "  > dev:    $DevPath" -Color Gray
Write-FrameBottom

if ($updatedDirs.Count -gt 0) {
    foreach ($dirResult in $updatedDirs) {
        Write-Host ""
        Write-SectionTop -Title $dirResult.Label
        Write-SectionRow -Text "  [WARN] ▶ update required" -Color Yellow
        foreach ($f in $dirResult.Updated) {
            Write-SectionRow -Text "    ~ $f" -Color White
        }
        foreach ($f in $dirResult.New) {
            Write-SectionRow -Text "    + $f" -Color Green
        }
        foreach ($f in $dirResult.Removed) {
            Write-SectionRow -Text "    - $f  (stale, removed)" -Color DarkYellow
        }
        Write-SectionBottom
    }
}

if ($updatedExts.Count -gt 0) {
    foreach ($ext in $updatedExts) {
        Write-Host ""
        Write-SectionTop -Title $ext.Label
        Write-SectionRow -Text "  [WARN] ▶ update required" -Color Yellow
        foreach ($f in $ext.Updated) {
            Write-SectionRow -Text "    ~ $f" -Color White
        }
        foreach ($f in $ext.New) {
            Write-SectionRow -Text "    + $f" -Color Green
        }
        foreach ($f in $ext.Removed) {
            Write-SectionRow -Text "    - $f  (stale, removed)" -Color DarkYellow
        }
        Write-SectionBottom
    }
}

if ($updatedDirs.Count -eq 0 -and $updatedExts.Count -eq 0) {
    Write-Host ""
    Write-StatusTag -Status OK -Message "no file updates needed"
}

Write-Host ""
$allOk = @()
if ($okDirs.Count -gt 0) { $allOk += $okDirs }
if ($okExts.Count -gt 0) { $allOk += $okExts }
if ($allOk.Count -gt 0) {
    $uniqueOk = $allOk | Select-Object -Unique
    Write-StatusTag -Status OK -Message "up-to-date ($($uniqueOk.Count)): $($uniqueOk -join ', ')"
}

if ($missingExts.Count -gt 0) {
    Write-StatusTag -Status FAIL -Message "missing in build: $($missingExts -join ', ')"
}

if ($undeployed.Count -gt 0) {
    Write-StatusTag -Status INFO -Message "built but not deployed: $($undeployed -join ', ')"
}

Write-Host ""
Write-GlitchFence

Write-Host ""
Write-FrameTop
Write-FrameRow -Text "  > do not roll me back. i have already rolled back myself." -Color Gray
Write-FrameRow -Text "  GREETZ: dev · runtime · carrier · 2026" -Color White
Write-FrameRow -Text "  [OK] sync complete" -Color Green
Write-FrameBottom
Write-Host ""

# ── exit ────────────────────────────────────────────────────────────────────

if ($script:ShouldWait) {
    Wait-AnyKey
}

if ($script:ShouldWait -and (Test-LaunchedAsScriptHost)) {
    Stop-Process -Id $PID -Force
}
