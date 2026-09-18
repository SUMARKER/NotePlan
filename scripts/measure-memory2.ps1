$ErrorActionPreference = 'SilentlyContinue'

Write-Output '--- Electron (private MB) ---'
$eSum = 0
foreach ($p in Get-Process 'NotePlan for Windows' | Where-Object { $_.Path -like '*win-unpacked*' }) {
    $pm = $p.PrivateMemorySize64 / 1MB
    $ws = $p.WorkingSet64 / 1MB
    $eSum += $pm
    Write-Output ("  pid {0}: private={1} ws={2}" -f $p.Id, [math]::Round($pm, 0), [math]::Round($ws, 0))
}
Write-Output ("Electron private total: " + [math]::Round($eSum, 0) + " MB")

Write-Output '--- WebView2 host (private MB) ---'
$wSum = 0
foreach ($p in Get-Process 'NotePlan for Windows' | Where-Object { $_.Path -like '*net8.0-windows*' }) {
    $pm = $p.PrivateMemorySize64 / 1MB
    $ws = $p.WorkingSet64 / 1MB
    $wSum += $pm
    Write-Output ("  pid {0}: private={1} ws={2}" -f $p.Id, [math]::Round($pm, 0), [math]::Round($ws, 0))
}
Write-Output ("WPF host private total: " + [math]::Round($wSum, 0) + " MB")

Write-Output '--- WebView2 children (private MB) ---'
$our = Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe'" |
    Where-Object { $_.CommandLine -like '*webview-exe-name=*NotePlan*' -or $_.CommandLine -like '*NotePlanWpf*' }
$mSum = 0
foreach ($p in $our) {
    $proc = Get-Process -Id $p.ProcessId -ErrorAction SilentlyContinue
    if ($proc) {
        $pm = $proc.PrivateMemorySize64 / 1MB
        $mSum += $pm
        Write-Output ("  pid {0}: private={1}" -f $p.ProcessId, [math]::Round($pm, 0))
    }
}
Write-Output ("WebView2 children private total: " + [math]::Round($mSum, 0) + " MB")
Write-Output ("WebView2 grand total (host+children): " + [math]::Round($wSum + $mSum, 0) + " MB")
