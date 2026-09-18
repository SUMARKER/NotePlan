param([int]$TargetPid = 0)
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Drawing
$p = if ($TargetPid -gt 0) { Get-Process -Id $TargetPid } else { Get-Process 'NotePlanNative' }
if (-not $p) { Write-Output 'no process'; exit }
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class W32 {
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out R r);
    public struct R { public int L, T, Rt, B; }
}
'@
$r = New-Object W32+R
[W32]::GetWindowRect($p.MainWindowHandle, [ref]$r) | Out-Null
$w = $r.Rt - $r.L
$h = $r.B - $r.T
$bmp = New-Object System.Drawing.Bitmap($w, $h)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($r.L, $r.T, 0, 0, $bmp.Size)
$bmp.Save('D:\workspace\NotePlan\native-shot.png')
Write-Output ("saved {0}x{1}" -f $w, $h)
