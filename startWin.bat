@echo off
:: ==============================================================================
:: Qoder OpenAPI & Anthropic 代理服务 Windows 启动脚本
:: 运行环境: Windows (CMD / PowerShell / 双击运行)
:: ==============================================================================

chcp 65001 >nul
title Qoder API Gateway - Windows Launcher

echo =================================================================
echo  ⚡ Qoder API Gateway - Windows 服务启动器
echo =================================================================

:: 切换到当前脚本所在目录
cd /d "%~dp0"

:: 1. 检查 Node.js 环境
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo.
    echo ❌ 错误: 未检测到 Node.js，请先安装 Node.js (版本需 ^>= 18.0)
    echo    官方下载地址: https://nodejs.org/
    echo.
    pause
    exit /b 1
)

:: 检查 Node.js 版本
for /f "tokens=1 delims=." %%a in ('node -e "console.log(process.versions.node.split('.')[0])"') do set NODE_VER=%%a
if %NODE_VER% lss 18 (
    echo.
    echo ❌ 错误: 当前 Node.js 主版本为 v%NODE_VER%，必须 ^>= v18.0
    echo.
    pause
    exit /b 1
)
echo ✓ Node.js 环境正常 (v%NODE_VER%)

:: 2. 检查 .env 配置文件
if not exist ".env" (
    if exist ".env.example" (
        echo 📄 未发现 .env 文件，正在从 .env.example 自动创建...
        copy .env.example .env >nul
    ) else (
        echo.
        echo ⚠️ 警告: 未找到 .env 配置文件
    )
)

:: 检查 .env 中是否配置了 Token
findstr /i "QODER_PERSONAL_ACCESS_TOKEN" .env >nul 2>nul
if %errorlevel% neq 0 (
    echo.
    echo ❌ 错误: 未在 .env 文件中检测到 QODER_PERSONAL_ACCESS_TOKEN
    echo    请用记事本打开 .env 并填入你的 Qoder 个人访问令牌。
    echo    👉 Token 获取地址: https://qoder.com/account/integrations
    echo.
    pause
    exit /b 1
)

:: 3. 检查依赖
if not exist "node_modules" (
    echo.
    echo 📦 首次运行，正在自动安装项目依赖 (npm install)...
    call npm install
    if %errorlevel% neq 0 (
        echo ❌ 依赖安装失败，请检查网络后重试。
        pause
        exit /b 1
    )
) else (
    echo ✓ 项目依赖已就绪
)

:: 4. 清除干扰代理
set http_proxy=
set https_proxy=
set all_proxy=
set HTTP_PROXY=
set HTTPS_PROXY=
set ALL_PROXY=

echo.
echo =================================================================
echo  🎉 Qoder OpenAPI & Anthropic 服务正在启动...
echo -----------------------------------------------------------------
echo  🌐 Web 控制台地址:    http://127.0.0.1:10088/
echo  📡 OpenAI 补全端点:   http://127.0.0.1:10088/v1/chat/completions
echo  ⚡ Anthropic 端点:    http://127.0.0.1:10088/v1/messages
echo  📋 模型列表端点:      http://127.0.0.1:10088/v1/models
echo  🔑 默认控制台账号:    admin / admin
echo =================================================================
echo  按 Ctrl + C 可终止服务
echo =================================================================
echo.

:: 启动服务
node server.mjs

pause
