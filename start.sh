#!/bin/bash
# ==============================================================================
# Qoder OpenAPI & Anthropic 代理服务启动与管理脚本
# 使用官方 @qoder-ai/qoder-agent-sdk (Worker Transport, 预热池加速模式)
# ==============================================================================

set -e

# 进入当前脚本所在目录
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# --- 基础运行配置 ---
APP_NAME="qorder_gateway"
PORT=10088
HOST="127.0.0.1" # 默认仅监听本地 127.0.0.1 (如需开放局域网访问可配置为 0.0.0.0)

echo "================================================================="
echo "🔍 [1/5] 正在检测运行环境..."
echo "================================================================="

# 1. 检查 Node.js (>= 18)
if ! command -v node >/dev/null 2>&1; then
  echo "❌ 错误: 未检测到 Node.js，请先安装 Node.js (>= 18.0)"
  exit 1
fi
NODE_MAJOR=$(node -e "console.log(process.versions.node.split('.')[0])")
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "❌ 错误: Node.js 版本过低 ($NODE_MAJOR), 需要 >= 18"
  exit 1
fi

# 2. 检查并加载 .env 配置文件
if [ -f ".env" ]; then
  echo "📄 正在加载 .env 配置文件..."
  set -a
  source .env
  set +a
fi

if [ -z "$QODER_PERSONAL_ACCESS_TOKEN" ]; then
  echo "❌ 错误: 未设置 QODER_PERSONAL_ACCESS_TOKEN"
  echo "   请在 .env 中配置或 export 环境变量。"
  echo "   👉 获取地址: https://qoder.com/account/integrations"
  exit 1
fi

# 3. 检查并安装 PM2
if ! command -v pm2 >/dev/null 2>&1; then
  echo "📦 正在自动安装 PM2..."
  npm install -g pm2
fi

# 4. 检查并安装项目依赖
if [ ! -d "node_modules" ]; then
  echo "📦 [2/5] 正在安装服务依赖..."
  npm install
else
  echo "✓ 依赖已就绪"
fi

# 5. 清除可能干扰直连的代理环境变量
unset http_proxy https_proxy all_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY

echo "🚀 [3/5] 正在启动/重启 PM2 进程: ${APP_NAME} (监听: ${HOST}:${PORT})..."

# 6. 启动/重启
if pm2 describe "$APP_NAME" >/dev/null 2>&1; then
  echo "🔄 检测到服务已在运行，正在执行热重启..."
  PORT=$PORT HOST=$HOST pm2 restart "$APP_NAME" --update-env
else
  echo "✨ 首次启动服务..."
  PORT=$PORT HOST=$HOST pm2 start server.mjs --name "$APP_NAME" --update-env
fi

pm2 save >/dev/null 2>&1 || true

echo "================================================================="
echo "🎉 [4/5] Qoder OpenAPI & Anthropic 服务已成功运行 (预热池加速模式)!"
echo "-----------------------------------------------------------------"
echo "🌐 网页控制台:         http://${HOST}:${PORT}/"
echo "📡 OpenAI 补全接口:    http://${HOST}:${PORT}/v1/chat/completions"
echo "⚡ Anthropic 接口:     http://${HOST}:${PORT}/v1/messages"
echo "📋 模型列表接口:       http://${HOST}:${PORT}/v1/models"
echo "🔧 鉴权:              Bearer <token> 或 x-api-key: <token>"
echo "================================================================="
echo "💡 健康检查:           curl http://${HOST}:${PORT}/v1/models"
echo "📊 PM2 日志:           pm2 logs ${APP_NAME}"
echo "================================================================="