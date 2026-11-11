# Runs order/tag island tests after relevant file edits (Cursor afterFileEdit hook).
# Reads JSON from stdin; filters by edited path; prints additional_context JSON.

$ErrorActionPreference = 'Continue'
$raw = [Console]::In.ReadToEnd()
if (-not $raw) {
  Write-Output '{}'
  exit 0
}

try {
  $payload = $raw | ConvertFrom-Json
} catch {
  Write-Output '{}'
  exit 0
}

$path = $null
foreach ($key in @('filePath', 'file_path', 'path', 'uri')) {
  if ($payload.PSObject.Properties.Name -contains $key -and $payload.$key) {
    $path = [string]$payload.$key
    break
  }
}
if (-not $path -and $payload.file) {
  $path = [string]$payload.file
}
if (-not $path -and $payload.edits) {
  try { $path = [string]$payload.edits[0].filePath } catch { }
}

if (-not $path) {
  Write-Output '{}'
  exit 0
}

$normalized = ($path -replace '\\', '/').ToLowerInvariant()
$watch = @(
  'order_islands.py',
  'tag_service.py',
  'rowreorder.ts',
  'rowreorder.selftest.ts',
  'pagination.ts',
  'pagination.selftest.ts',
  'paginationbar.tsx',
  'mediacollectionview.tsx',
  'tagspage.tsx',
  'taggroupspage.tsx',
  'viewerpage.tsx',
  'recentscrapedmediapanel.tsx',
  'duplicatespanel.tsx',
  'test_order_islands.py',
  'api/media.py',
  'media_service.py',
  'test_media_list.py',
  'test_tag_multi_groups.py',
  'run_order_tests.bat'
)

$hit = $false
foreach ($w in $watch) {
  if ($normalized.EndsWith($w) -or $normalized.Contains('/' + $w)) {
    $hit = $true
    break
  }
}
if (-not $hit) {
  Write-Output '{}'
  exit 0
}

# .cursor/hooks → repo root
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$runner = Join-Path $root 'scripts\run_order_tests.bat'

$out = & cmd /c "`"$runner`"" 2>&1 | Out-String
$code = $LASTEXITCODE

if ($code -eq 0) {
  $summary = "Order/tag auto-tests PASSED after edit to $normalized."
} else {
  $summary = "Order/tag auto-tests FAILED after edit to $normalized. Fix before finishing.`n$out"
}

$escaped = $summary.Replace('\', '\\').Replace('"', '\"').Replace("`r", '').Replace("`n", '\n')
Write-Output ("{`"additional_context`":`"$escaped`"}")
exit 0
