$ErrorActionPreference = 'Stop'
# Sync frontend copy (electron) from tauri/src.
# index.html: copy then strip the Tauri-only api-shim script line.
$tauri = 'D:\workspace\NotePlan\tauri\src'
$srcIdx = Join-Path $tauri 'index.html'
foreach ($name in @('electron')) {
  $dst = "D:\workspace\NotePlan\$name\src"
  Copy-Item (Join-Path $tauri 'css\app.css') (Join-Path $dst 'css\app.css') -Force
  Copy-Item (Join-Path $tauri 'js\app.js') (Join-Path $dst 'js\app.js') -Force
  Copy-Item (Join-Path $tauri 'js\markdown.js') (Join-Path $dst 'js\markdown.js') -Force
  $c = [System.IO.File]::ReadAllText($srcIdx)
  $c = $c -replace '(?m)^\s*<script src="js/api-shim-tauri\.js"></script>\r?\n', ''
  $out = Join-Path $dst 'index.html'
  [System.IO.File]::WriteAllText($out, $c, (New-Object System.Text.UTF8Encoding($false)))
  $size = (Get-Item $out).Length
  $hasWeek = (Select-String -Path $out -Pattern 'weekplan' | Measure-Object).Count
  Write-Output "$name index.html: $size bytes, weekplan=$hasWeek"
}
