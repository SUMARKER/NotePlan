@echo off
set PATH=D:\workspace\tools\node\node-v22.23.2-win-x64;%PATH%

echo === 1. Download rustup-init ===
if not exist D:\workspace\tools\rustup-init.exe (
    powershell -NoProfile -Command "[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -UseBasicParsing 'https://win.rustup.rs/x86_64' -OutFile 'D:\workspace\tools\rustup-init.exe'"
)
if not exist D:\workspace\tools\rustup-init.exe (
    echo FAILED to download rustup-init
    exit /b 1
)
echo rustup-init downloaded OK

echo === 2. Install VS Build Tools via winget ===
winget install Microsoft.VisualStudio.2022.BuildTools --accept-source-agreements --accept-package-agreements --silent --override "--wait --passive --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended" 2>&1
echo VS Build Tools exit: %errorlevel%

echo === 3. Install Rust (MSVC target) ===
D:\workspace\tools\rustup-init.exe -y --default-toolchain stable-msvc 2>&1
echo Rust exit: %errorlevel%

echo === 4. Verify ===
set PATH=%USERPROFILE%\.cargo\bin;%PATH%
rustc --version
cargo --version

echo === ALL DONE ===
