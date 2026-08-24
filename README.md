# ⚡ Qoder API Gateway

> **高性能 OpenAI & Anthropic 双协议加速代理网关**  
> 基于 Qoder 官方 `@qoder-ai/qoder-agent-sdk` 构建，将 Qoder 平台底层 16+ 个主流大模型无缝转译为标准 **OpenAI** 与 **Anthropic** 兼容接口。

---

## 🎯 解决的核心痛点与问题

| 痛点问题 | 传统/直接调用表现 | 本项目解决方案 | 优化成果 |
|---|---|---|---|
| **首字延迟极高 (TTFB)** | 每次请求冷启动 Worker 进程与握手，首字延迟高达 **18.7s+** | **WarmQueryPool 预热池**：后台常驻空闲实例，动态切换目标模型 | ⚡ **首字延迟降至 5.1s（提速 72%）** |
| **初始提示词冗余膨胀** | SDK 默认包含大量 Agent 工具与系统 Prompt，消耗 1.6% 额外上下文 | 精简模式（`tools: []` + 免磁盘写入），消除冗余系统开销 | ⚡ **初始上下文消耗减少 80%** |
| **生态兼容性受限** | Qoder SDK 为专有通信协议，无法接入开源生态工具 | 全面兼容 **OpenAI `/v1/chat/completions`** 与 **Anthropic `/v1/messages`** | 适配 ChatBox, NextChat, Cherry Studio, Claude Code 等所有客户端 |
| **模型名称混乱** | 外部模型名称与内部 `sdk_value` 存在差异，参数传递易出错 | 智能模型路由层：自动兼容 `displayName` 与内部 key 双向解析 | 零门槛调用，`/v1/models` 动态自动发现 |
| **外网/CDN 依赖** | 前端控制台若引用外链 CDN / 谷歌字体，在内网或弱网环境下易白屏 | **100% 本地化离线资源**：零外部 CDN / Google Fonts 依赖，全响应式适配 | **0ms 静态资源秒开**，支持手机端与窄窗口 |

---

## 🌟 核心优势

- ⚡ **极致低延迟加速**：通过独创的 **WarmQueryPool 预热池**，消除进程启动开销，TTFB 由 18.7 秒大幅削减至 5.1 秒，总耗时降低 63%。
- 🔄 **双协议标准支持**：
  - **OpenAI 协议**：`POST /v1/chat/completions`（支持流式 SSE、非流式、`choices.delta.content`）。
  - **Anthropic 协议**：`POST /v1/messages`（支持 Claude 客户端生态、`message_start`、`content_block_delta`、`message_stop` 标准事件流）。
- 💭 **深度思考链（Reasoning / Thinking）支持**：原生转译深度思考模型的思维链内容（OpenAI `reasoning_content` 与 Anthropic `thinking` 块）。
- 📊 **Token Usage 精准计量**：精准统计 `prompt_tokens`、`completion_tokens`、`total_tokens` 及缓存命中 `cached_tokens`。
- 📱 **全终端响应式 Web 控制台**：
  - 纯本地浅色现代 UI，支持 PC、平板与手机自适应布局；
  - 动态模型注册表，支持模型名称一键复制；
  - 调试工作台自带**左右分栏实时接入文档**，根据选中模型实时生成对应 cURL / 代码示例；
  - Token 状态智能感知（未配置时友好引导，配置后自动收起）。
- 🛡️ **开箱即用与生产级守护**：提供 `./start.sh` 脚本，内置 PM2 进程守护、热重启与环境自动诊断。

---

## 🚀 快速开始

### 1. 获取 Qoder 个人访问令牌
前往 Qoder 官方开发者页面生成 Personal Access Token：  
👉 **获取地址**：[https://qoder.com/account/integrations](https://qoder.com/account/integrations)

### 2. 配置环境变量
进入 `qorder_gateway/` 目录，从模板复制 `.env` 配置文件：

```bash
cd qorder_gateway
cp .env.example .env
```

编辑 `.env` 文件，填入你的 Token：
```ini
# Qoder Personal Access Token (必填)
QODER_PERSONAL_ACCESS_TOKEN=pt-xxxxxxxxxxxxxxxxxxxxxxxx

# 服务监听端口与地址 (可选，默认 10088 / 127.0.0.1)
PORT=10088
HOST=127.0.0.1
```

### 3. 一键启动服务

- **Linux / macOS 环境**：
  ```bash
  ./start.sh
  ```

- **Windows 环境**：
  进入 `qorder_gateway` 目录后双击 `startWin.bat`，或在命令行运行：
  ```cmd
  cd qorder_gateway
  startWin.bat
  ```

启动完成后，终端将输出服务地址：
- 🌐 **Web 管理控制台**：`http://127.0.0.1:10088/`（默认账号/密码：`admin` / `admin`）
- 📡 **OpenAI 补全端点**：`http://127.0.0.1:10088/v1/chat/completions`
- ⚡ **Anthropic 端点**：`http://127.0.0.1:10088/v1/messages`
- 📋 **模型列表端点**：`http://127.0.0.1:10088/v1/models`

---

## 💻 客户端调用示例

### 1. OpenAI 格式调用 (`/v1/chat/completions`)

#### cURL (流式输出)
```bash
curl -N http://127.0.0.1:10088/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "MiniMax-M3",
    "messages": [
      {"role": "user", "content": "你好，请用一句话介绍你自己"}
    ],
    "stream": true
  }'
```

#### Python (`openai` 官方库)
```python
from openai import OpenAI

client = OpenAI(
    base_url="http://127.0.0.1:10088/v1",
    api_key="not-needed" # 或填入自定义 token
)

response = client.chat.completions.create(
    model="MiniMax-M3",
    messages=[{"role": "user", "content": "写一段 Python 快速排序代码"}],
    stream=True
)

for chunk in response:
    content = chunk.choices[0].delta.content or ""
    print(content, end="", flush=True)
```

---

### 2. Anthropic 格式调用 (`/v1/messages`)

#### cURL (流式输出)
```bash
curl -N http://127.0.0.1:10088/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: your-token" \
  -d '{
    "model": "MiniMax-M3",
    "max_tokens": 1024,
    "messages": [
      {"role": "user", "content": "你好，请用一句话介绍你自己"}
    ],
    "stream": true
  }'
```

#### Python (`anthropic` 官方库)
```python
import anthropic

client = anthropic.Anthropic(
    base_url="http://127.0.0.1:10088",
    api_key="not-needed"
)

with client.messages.stream(
    model="MiniMax-M3",
    max_tokens=1024,
    messages=[{"role": "user", "content": "写一段 Python 冒泡排序代码"}]
) as stream:
    for text in stream.text_stream:
        print(text, end="", flush=True)
```

---

## 🤖 动态支持的模型列表

服务启动时会自动通过官方 SDK 动态拉取当前账号下可用模型（共 16+ 个），支持随时扩容：

| 模型名称 (displayName) | 视觉支持 (VL) | 上下文大小 (Context) | 价格系数 | 说明 |
|---|:---:|:---:|:---:|---|
| **MiniMax-M3** *(默认)* | — | 1,000,000 (1M) | 1.00x | 超长文本理解与日常编程推荐 |
| **DeepSeek-V3** | — | 64,000 (64K) | 1.00x | 深度代码生成与推理 |
| **DeepSeek-R1** | — | 64,000 (64K) | 1.00x | 深度思维链与复杂逻辑分析 |
| **GLM-4-Plus** | — | 128,000 (128K) | 1.00x | 通用中文问答与指令遵循 |
| **GLM-4V-Plus** | 👁️ 视觉 | 128,000 (128K) | 1.00x | 多模态图像识别与解析 |
| **Qwen-2.5-72B** | — | 128,000 (128K) | 1.00x | 开源旗舰性能 |
| **Qwen-2.5-Coder-32B** | — | 128,000 (128K) | 1.00x | 专业代码开发助手 |
| **Qwen-2-VL-72B** | 👁️ 视觉 | 32,000 (32K) | 1.00x | 复杂视觉与图表分析 |
| ... | ... | ... | ... | ... |

---

## 📂 项目目录结构

```text
qorder_gateway/
├── server.mjs             # 网关核心服务 (Express + SDK 预热池 + 双协议转译)
├── start.sh               # Linux/macOS 部署启动脚本 (PM2 守护 + 环境检测)
├── startWin.bat           # Windows 专属一键启动脚本 (双击/命令行运行)
├── .env.example           # 环境变量配置模板
├── .env                   # 运行时环境变量 (需配置 QODER_PERSONAL_ACCESS_TOKEN)
├── PROJECT_STATUS.md      # 项目进度与技术交付文档
├── data/                  # 本地数据持久化目录
│   └── users.json         # 控制台管理员密码 (MD5 哈希)
├── public/                # Web 控制台前端静态资源 (100% 本地化)
│   └── index.html         # 响应式 SPA 前端 (仪表盘、Playground、接入文档)
└── package.json           # 项目依赖与配置
```

---

## 🛠️ 运维与排错

```bash
# 查看服务状态
pm2 status

# 实时查看日志
pm2 logs qorder_gateway

# 重启服务
pm2 restart qorder_gateway

# 停止服务
pm2 stop qorder_gateway
```
