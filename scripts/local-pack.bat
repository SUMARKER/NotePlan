@echo off
setlocal
rem ==========================================================================
 rem 本地一键打包：Electron + Tauri（WebView2 方案已停止更新，不参与）
 rem 可用环境变量覆盖默认值：
 rem   LOCAL_DIST     Electron 输出目录（默认 D:\noteplan-dist\electron；
 rem                  放在笔记库工作区外，避免被 IDE/索引器锁定 asar）
 rem   ELECTRON_MIRROR / ELECTRON_BUILDER_BINARIES_MIRROR
 rem                  electron 与 electron-builder 工具的下载镜像（默认 npmmirror）
 rem 依赖：Node.js >= 18（含 npm）、Rust 1.75+ MSVC、cargo tauri-cli
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
echo 打包完成：
echo   Electron 安装包: %LOCAL_DIST%\NotePlan-for-Windows-Setup-*.exe
echo   Tauri    安装包: %ROOT%\tauri\src-tauri\target\release\bundle\nsis\*-setup.exe
exit /b 0

:err
popd
echo 打包失败（exit %errorlevel%）
exit /b 1
