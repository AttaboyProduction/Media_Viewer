# Merge the latest GitHub branch ZIP into the project root.
# Called by Update.bat. Keeps local data\, media\, .venv\, etc.
param(
    [Parameter(Mandatory = $true)][string]$ZipUrl,
    [Parameter(Mandatory = $true)][string]$Root
)

$ErrorActionPreference = "Stop"

function Copy-UpdateFile {
    param(
        [Parameter(Mandatory = $true)][string]$Source,
        [Parameter(Mandatory = $true)][string]$Destination
    )
    $leaf = Split-Path -Leaf $Destination
    try {
        Copy-Item -LiteralPath $Source -Destination $Destination -Force -ErrorAction Stop
        return
    }
    catch {
        $message = $_.Exception.Message
        $locked = $message -match 'user-mapped section|being used by another process|cannot access the file'
        if (-not $locked) {
            throw ("Could not copy " + $leaf + ": " + $message)
        }
        Write-Host ("In use, replacing " + $leaf + "...")
    }
    # Overwriting a mapped file fails. Renaming it frees the name; the open
    # program keeps the old bytes until it closes them.
    $parent = Split-Path -Parent $Destination
    $bakName = $leaf + ".update-old"
    $bak = Join-Path $parent $bakName
    if (Test-Path -LiteralPath $bak) {
        Remove-Item -LiteralPath $bak -Force -ErrorAction SilentlyContinue
    }
    try {
        Rename-Item -LiteralPath $Destination -NewName $bakName -ErrorAction Stop
    }
    catch {
        throw ("Could not replace " + $leaf + " because it is open in another program. Close it and run Update.bat again.")
    }
    Copy-Item -LiteralPath $Source -Destination $Destination -Force
    Remove-Item -LiteralPath $bak -Force -ErrorAction SilentlyContinue
}

$Root = (Resolve-Path -LiteralPath $Root).Path
$tmp = Join-Path $env:TEMP ("scrap_download_update_" + [guid]::NewGuid().ToString("n"))
$zipPath = Join-Path $tmp "source.zip"

New-Item -ItemType Directory -Path $tmp -Force | Out-Null
try {
    Write-Host "Downloading..."
    Invoke-WebRequest -Uri $ZipUrl -OutFile $zipPath -UseBasicParsing
    Write-Host "Extracting..."
    Expand-Archive -Path $zipPath -DestinationPath $tmp -Force
    $inner = Get-ChildItem -Path $tmp -Directory | Select-Object -First 1
    if (-not $inner) {
        throw "ZIP had no top-level folder"
    }
    $src = $inner.FullName
    # Skip Update.bat so a mid-run overwrite cannot replace this updater with an
    # older ZIP copy (cmd re-reads the bat from disk and breaks). Skip the update
    # script too while it is the file driving the merge.
    $exclude = @(
        "data",
        "media",
        ".venv",
        "venv",
        "node_modules",
        "frontend\dist",
        "downloads",
        "downloaded_content",
        "backup",
        "Update.bat",
        "update_from_github.ps1"
    )
    Write-Host ("Merging into " + $Root)
    Get-ChildItem -Path $src -Force | ForEach-Object {
        if ($exclude -contains $_.Name) {
            return
        }
        $dest = Join-Path $Root $_.Name
        if ($_.PSIsContainer) {
            # Robocopy 0-7 = success; 8+ = failure. Clear the code so the process
            # exit status is not left at 1 ("files copied") after a good merge.
            # /XF keeps the live updater script if the ZIP ships an older copy.
            $xf = @()
            if ($_.Name -eq "scripts") {
                $xf = @("/XF", "update_from_github.ps1")
            }
            robocopy $_.FullName $dest /E /NFL /NDL /NJH /NJS /nc /ns /np @xf | Out-Null
            if ($LASTEXITCODE -ge 8) {
                throw ("robocopy failed for " + $_.Name + " code " + $LASTEXITCODE)
            }
            $global:LASTEXITCODE = 0
        }
        else {
            Copy-UpdateFile -Source $_.FullName -Destination $dest
        }
    }
    Write-Host "Files updated."
}
finally {
    Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
}

# Only reached when the merge succeeded. Robocopy's success codes (1-7) must not
# become this process's exit code or Update.bat will report a false failure.
exit 0
