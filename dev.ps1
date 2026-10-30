# SPDX-License-Identifier: Apache-2.0
# Copyright (c) 2026 Raku Inkyetta 羽梦千景
#
# FontFox —— 开发模式启动器（由 dev.cmd 双击调用）。
#
# exe 清单是 asInvoker，开发会话无需提权；删除系统字体的 UAC 由应用在运行时按需申请。

param()

$ErrorActionPreference = 'Continue'
Set-Location -LiteralPath $PSScriptRoot

function Stop-WithError([string]$message) {
    Write-Host ""
    Write-Host "[x] $message" -ForegroundColor Red
    exit 1
}


Write-Host "============================================================" -ForegroundColor DarkGray
Write-Host "  FontFox  ·  开发模式 (Vite + Tauri 热更新)" -ForegroundColor White
Write-Host "============================================================" -ForegroundColor DarkGray
Write-Host ""

# ── Node.js ────────────────────────────────────────────────────
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Stop-WithError "找不到 Node.js，请先安装： https://nodejs.org/"
}

# ── Rust 工具链 ────────────────────────────────────────────────
$cargoBin = Join-Path $env:USERPROFILE ".cargo\bin"
if (Test-Path (Join-Path $cargoBin "cargo.exe")) {
    $env:Path = "$cargoBin;$env:Path"
}
if (-not (Get-Command cargo -ErrorAction SilentlyContinue)) {
    Stop-WithError "找不到 Rust 工具链 (cargo)。安装方式： https://rustup.rs/"
}
$cargoVersion = (& cargo --version) -join " "
Write-Host "[*] $cargoVersion" -ForegroundColor DarkGray
Write-Host "[*] node $(& node --version)" -ForegroundColor DarkGray
Write-Host "[*] 以当前用户身份运行（无需管理员）" -ForegroundColor DarkGray

# ── 端口占用提示（不阻断）──────────────────────────────────────
try {
    $listening = Get-NetTCPConnection -LocalPort 1420 -State Listen -ErrorAction SilentlyContinue
    if ($listening) {
        Write-Host ""
        Write-Host "[!] 端口 1420 已被占用，可能已有一个开发实例在运行。" -ForegroundColor Yellow
        Write-Host "    若是上次异常退出残留，可先执行： taskkill /IM fontfox.exe /F" -ForegroundColor DarkGray
    }
} catch {
    # 查询失败不影响启动
}

# ── 前端依赖 ───────────────────────────────────────────────────
if (-not (Test-Path (Join-Path $PSScriptRoot "node_modules"))) {
    Write-Host ""
    Write-Host "[*] 首次运行，正在安装前端依赖……" -ForegroundColor DarkGray
    & npm.cmd install --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { Stop-WithError "前端依赖安装失败。" }
}

Write-Host ""
Write-Host "[*] 启动开发环境；首次编译 Rust 大约需要 1 分钟……" -ForegroundColor DarkGray
Write-Host "[*] 关闭本窗口即可停止全部进程。" -ForegroundColor DarkGray
Write-Host ""

& npm.cmd run tauri dev
$code = $LASTEXITCODE

if ($code -ne 0) {
    Write-Host ""
    Write-Host "[!] 开发进程以退出码 $code 结束。" -ForegroundColor Yellow
} else {
    Write-Host ""
    Write-Host "[*] 开发进程已正常退出。" -ForegroundColor DarkGray
}

exit $code