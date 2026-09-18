$ErrorActionPreference = 'SilentlyContinue'
$our = Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe'" |
    Where-Object { $_.CommandLine -like '*webview-exe-name=*NotePlan*' -or $_.CommandLine -like '*NotePlanWpf*' }
$sum = 0
foreach ($p in $our) {
    $proc = Get-Process -Id $p.ProcessId -ErrorAction SilentlyContinue
    if ($proc) {
        $ws = $proc.WorkingSet64 / 1KB
        $sum += $ws
        Write-Output ("{0} -> {1} K" -f $p.ProcessId, [math]::Round($ws, 0))
    }
}
Write-Output ("webview-children total: " + [math]::Round($sum, 0) + " K")
