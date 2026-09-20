@echo off
setlocal
rem ==========================================================================
rem  One-click local packaging: Electron + Tauri
rem  NOTE: keep this file ASCII-only. cmd parses .bat in the ANSI codepage
rem        (GBK on zh-CN systems); UTF-8 Chinese here garbles the parser.
rem  Overridable env vars:
rem    LOCAL_DIST     Electron output dir (default D:\noteplan-dist\electron;
rem                   kept outside the repo so IDE/indexers cannot lock asar)
rem    ELECTRON_MIRROR / ELECTRON_BUILDER_BINARIES_MIRROR
rem                   download mirrors for electron / electron-builder tooling
rem                   (defaults: npmmirror)
rem  Requires: Node.js >= 18 (with npm), Rust 1.75+ MSVC, cargo tauri-cli
rem ==========================================================================

if not defined LOCAL_DIST set "LOCAL_DIST=D:\noteplan-dist\electron"
if not defined ELECTRON_MIRROR set "ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/"
if not defined ELECTRON_BUILDER_BINARIES_MIRROR set "ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/"

set "ROOT=%~dp0.."

echo [1/2] Electron ^>^>^> %LOCAL_DIST%
pushd "%ROOT%\electron"
if not exist node_modules (
  call npm ci --no-audit --no-fund || goto :err
)
call npm run build || goto :err
call npx electron-builder --win -c.directories.output="%LOCAL_DIST%" || goto :err
popd

echo [2/2] Tauri ^>^>^> target\release\bundle\nsis
pushd "%ROOT%\tauri\src-tauri"
call cargo tauri build || goto :err
popd

echo.
echo Done. Electron installer: %LOCAL_DIST%\NotePlan-for-Windows-Setup-*.exe
echo Done. Tauri installer:    %ROOT%\tauri\src-tauri\target\release\bundle\nsis\*-setup.exe
exit /b 0

:err
popd
echo Pack failed (exit %errorlevel%)
exit /b 1
