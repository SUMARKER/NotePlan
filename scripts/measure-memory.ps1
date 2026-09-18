$ErrorActionPreference = 'SilentlyContinue'

# Electron 版（win-unpacked）
$e = Get-Process 'NotePlan for Windows' | Where-Object { $_.Path -like '*win-unpacked*' }
$eSum = ($e | Measure-Object WorkingSet64 -Sum).Sum / 1MB
Write-Output ('Electron    : processes=' + $e.Count + '  workingSet=' + [math]::Round($eSum, 0) + ' MB')

# WebView2 版：WPF 宿主
$w = Get-Process 'NotePlan for Windows' | Where-Object { $_.Path -like '*net8.0-windows*' }
$wSum = ($w | Measure-Object WorkingSet64 -Sum).Sum / 1MB
Write-Output ('WPF host    : processes=' + $w.Count + '  workingSet=' + [math]::Round($wSum, 0) + ' MB')

# WebView2 子进程（按 NotePlan 的 webview-exe-name / 用户数据目录识别）
$mv = Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe'" |
    Where-Object { $_.CommandLine -like '*NotePlanWpf*' -or $_.CommandLine -like '*webview-exe-name=*NotePlan*' }
$mvSum = 0
foreach ($p in $mv) {
    $proc = Get-Process -Id $p.ProcessId -ErrorAction SilentlyContinue
    if ($proc) { $mvSum += $proc.WorkingSet64 / 1MB }
}
Write-Output ('WebView2 sub: processes=' + $mv.Count + '  workingSet=' + [math]::Round($mvSum, 0) + ' MB')
Write-Output ('WebView2 ALL: workingSet=' + [math]::Round($wSum + $mvSum, 0) + ' MB')
