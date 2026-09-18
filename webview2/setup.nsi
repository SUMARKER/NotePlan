; NotePlan for Windows — WebView2 + .NET 宿主安装脚本（NSIS 3）
; 打包 publish-selfcontained 输出；用户级安装（无需管理员）；自带 WebView2 检测。

Unicode true
ManifestDPIAware true

!define APPNAME "NotePlan for Windows"
!define COMPANY "NotePlanWpf contributors"
!define VERSION "0.1.0"
!define EXENAME "NotePlan for Windows.exe"
!define UNKEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\NotePlanWpf"
!define WEBVIEW2_KEY "SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"

Name "${APPNAME} ${VERSION}"
OutFile "dist\NotePlan-for-Windows-Setup-${VERSION}-webview2.exe"
InstallDir "$LOCALAPPDATA\Programs\NotePlan for Windows"
InstallDirRegKey HKCU "Software\NotePlanWpf" "InstallDir"
RequestExecutionLevel user
SetCompressor /SOLID lzma

Icon "assets\icon.ico"
UninstallIcon "assets\icon.ico"

!include "MUI2.nsh"
!define MUI_ICON "assets\icon.ico"
!define MUI_UNICON "assets\icon.ico"
!define MUI_ABORTWARNING
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "SimpChinese"

; ---- 安装器初始化：检查 WebView2 运行时 ----
Function .onInit
  ClearErrors
  ReadRegStr $0 HKLM "${WEBVIEW2_KEY}" "pv"
  IfErrors 0 wvDone
  ClearErrors
  ReadRegStr $0 HKCU "Software\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}" "pv"
  IfErrors 0 wvDone
    MessageBox MB_ICONEXCLAMATION|MB_YESNO|MB_DEFBUTTON1 \
      "未检测到 Microsoft WebView2 运行时（Windows 10/11 通常已内置）。$\n$\n是否现在打开官方下载页？下载安装 WebView2 后再继续使用本应用。" \
      IDYES wvOpen IDNO wvDone
  wvOpen:
    ExecShell "open" "https://developer.microsoft.com/microsoft-edge/webview2/"
  wvDone:
FunctionEnd

Section "安装"
  SetOutPath "$INSTDIR"
  File /r "publish-selfcontained\*.*"

  CreateDirectory "$SMPROGRAMS\${APPNAME}"
  CreateShortcut "$SMPROGRAMS\${APPNAME}\${APPNAME}.lnk" "$INSTDIR\${EXENAME}"
  CreateShortcut "$DESKTOP\${APPNAME}.lnk" "$INSTDIR\${EXENAME}"
  CreateShortcut "$SMPROGRAMS\${APPNAME}\卸载 ${APPNAME}.lnk" "$INSTDIR\Uninstall.exe"

  WriteRegStr HKCU "Software\NotePlanWpf" "InstallDir" "$INSTDIR"

  WriteUninstaller "$INSTDIR\Uninstall.exe"
  WriteRegStr HKCU "${UNKEY}" "DisplayName" "${APPNAME}"
  WriteRegStr HKCU "${UNKEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "${UNKEY}" "Publisher" "${COMPANY}"
  WriteRegStr HKCU "${UNKEY}" "DisplayIcon" "$INSTDIR\${EXENAME}"
  WriteRegStr HKCU "${UNKEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNKEY}" "UninstallString" "$INSTDIR\Uninstall.exe"
  WriteRegStr HKCU "${UNKEY}" "QuietUninstallString" "$INSTDIR\Uninstall.exe /S"
  WriteRegDWORD HKCU "${UNKEY}" "EstimatedSize" 69000
SectionEnd

Section "Uninstall"
  ExecWait 'taskkill /f /im $\"${EXENAME}$\"'
  RMDir /r "$INSTDIR"
  Delete "$DESKTOP\${APPNAME}.lnk"
  RMDir "$SMPROGRAMS\${APPNAME}"
  DeleteRegKey HKCU "${UNKEY}"
  DeleteRegKey HKCU "Software\NotePlanWpf"
SectionEnd
