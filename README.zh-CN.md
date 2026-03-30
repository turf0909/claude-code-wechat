# Claude Code WeChat

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D18-green.svg)](https://nodejs.org)
[![Claude Code](https://img.shields.io/badge/Claude%20Code-%3E%3D2.1.80-blue.svg)](https://claude.com/claude-code)

**[English](README.md) | [中文](README.zh-CN.md)**

在微信中直接与 Claude Code 对话。

基于微信官方 [ClawBot](https://github.com/nicepkg/openclaw) ilink API，将微信消息桥接到 Claude Code 会话，让你在手机上就能操作 Claude Code。

[为什么选这个](#为什么选这个) · [快速开始](#快速开始) · [斜杠命令](#斜杠命令仅-sdk-模式) · [模式对比](#模式对比)

<p align="center">
  <img src="docs/demo.png" alt="WeChat Demo" width="300" />
</p>

## 为什么选这个

- **随时随地写代码** — 在手机微信上 Review PR、调试问题、编辑代码，不用打开电脑
- **多用户独立会话** — 每个微信用户拥有独立的 Claude Code 会话和完整对话历史
- **两种模式，自由选择** — Channel 模式适合 Claude Code CLI 用户，SDK 模式适合 API Key 用户

## 工作原理

```
微信用户发送消息
    ↓
微信 ClawBot → ilink API (长轮询)
    ↓
Channel 模式 MCP server (本地 stdio)
    ↓ notifications/claude/channel
Claude Code 收到消息，生成回复
    ↓
wechat_thinking / wechat_reply / wechat_send_file 工具
    ↓
ilink/bot/sendmessage → 微信用户收到回复
```

## 功能特性

| 类别 | 功能 |
|------|------|
| 💬 消息 | 文字收发、长消息自动分段（2000字）、处理状态提示 |
| 🖼 媒体 | 图片收发（CDN + AES-128-ECB 加密）、文件收发、语音转文字 |
| 👥 社交 | 群聊支持、链接分享解析、输入状态指示 |
| 🔄 可靠性 | Token 过期自动重登（最多3次）、CDN 上传重试、凭据持久化 |
| 🧹 运维 | 优雅退出、媒体文件自动清理（7天）、日志轮转（10MB） |

## 前置要求

- [Node.js](https://nodejs.org) >= 18
- [Bun](https://bun.sh) >= 1.0（用于构建，启动脚本会自动安装）
- Python 3（仅 Channel 模式需要，用于更新 `.mcp.json`）
- 微信 ClawBot（支持 iOS 和 Android）

**Channel 模式**额外需要：
- [Claude Code](https://claude.com/claude-code) >= 2.1.80（需先执行 `claude login`）

**SDK 模式**额外需要：
- `ANTHROPIC_API_KEY`（从 [Anthropic Console](https://console.anthropic.com/) 获取，或使用 API 代理）

## 快速开始

```bash
git clone https://github.com/turf0909/claude-code-wechat.git
cd claude-code-wechat
cp .env.example .env
# 根据需要编辑 .env（参见下方"认证方式"）
```

两种模式可选：

### SDK 模式（推荐）

直接使用 Claude Agent SDK。支持多用户、斜杠命令、消息队列。需要 API Key。

```bash
# 编辑 .env: ANTHROPIC_API_KEY=sk-ant-xxx
./sdk-mode/start.sh

# 或指定工作目录，让 Claude 操作其他项目
./sdk-mode/start.sh ~/my-project
```

### Channel 模式

使用 Claude Code CLI 作为后端。支持 API Key 和 OAuth（未设置 Key 时回退到 OAuth）。

```bash
# 需要 claude login（CLI 认证），可选在 .env 中设置 ANTHROPIC_API_KEY
./channel-mode/start.sh

# 或指定工作目录
./channel-mode/start.sh ~/my-project
```

### 认证方式

启动脚本从项目根目录的 `.env` 文件自动检测 API 配置：
1. 设置了 `ANTHROPIC_API_KEY` → 使用 API Key（可配合 `ANTHROPIC_BASE_URL` 代理）
2. 未设置 → 使用 Claude Code 默认 API（仅 Channel 模式）

> Channel 模式无论是否设置 API Key，都需要先 `claude login`。SDK 模式只需要 `ANTHROPIC_API_KEY`。

> `.env` 文件已在 `.gitignore` 中，不会被提交。详见 `.env.example`。

> **工作目录说明**：不带参数时，Claude 在 bot 项目自身目录下工作。指定路径后，Claude 可以在该目录下读写文件、执行命令——适合让微信里的 Claude 帮你操作其他项目的代码。

### 开始聊天

打开微信，找到 ClawBot 对话，发送消息。Claude 的回复会自动发回微信。

### 使用 API 代理

通过代理转发请求（适用于企业环境或区域访问）：

```env
# .env
ANTHROPIC_API_KEY=your-key
ANTHROPIC_BASE_URL=https://your-proxy.example.com
```

### 手动操作（可选）

```bash
# 手动安装依赖并构建
bun install
npm run build

# 单独执行扫码登录
node dist/setup.js
node dist/setup.js --force   # 跳过"是否重新登录"确认
```

多用户场景可通过 `WECHAT_CREDENTIALS_FILE` 环境变量自定义凭据路径。

## 斜杠命令（仅 SDK 模式）

| 命令 | 说明 |
|------|------|
| `/new` | 开始新对话（旧对话保留，可 `/resume` 恢复） |
| `/clear` | 清除当前对话上下文（保留 session） |
| `/stop` | 中止当前正在执行的任务 |
| `/cancel` | 中止当前任务并清空排队消息 |
| `/resume` | 查看历史对话列表 |
| `/resume <id>` | 恢复指定对话（支持 ID 前缀匹配） |
| `/compact` | 压缩当前对话上下文 |
| `/model` | 查看当前模型 |
| `/model <名称>` | 切换模型（自动验证可用性） |
| `/thinking` | 查看 Thinking 模式状态 |
| `/thinking on/off` | 开启/关闭 Thinking 模式（默认关闭，部分模型不支持） |
| `/status` | 查看当前状态（模型、Thinking、Session、任务、版本） |
| `/help` | 显示命令帮助 |

## MCP 工具

| 工具 | 说明 |
|------|------|
| `wechat_thinking` | 发送处理状态消息 + 显示输入指示 |
| `wechat_reply` | 发送文字回复（自动分段长消息） |
| `wechat_send_file` | 通过 CDN 发送图片或文件 |

## 模式对比

| | Channel 模式 | SDK 模式（推荐） |
|---|---|---|
| 启动命令 | `./channel-mode/start.sh` | `./sdk-mode/start.sh` |
| 认证方式 | `claude login` + 可选 API Key | **仅 API Key** |
| Claude Code CLI | 需要 | **不需要** |
| 多用户独立对话 | 否（共享会话） | **是** |
| 斜杠命令 | 否 | **是** |
| 消息队列 | 否 | **是** |
| 响应延迟 | 低（持久连接） | ~3s（API 往返） |

## 后台运行 (tmux)

```bash
tmux new-session -d -s wechat './sdk-mode/start.sh ~/my-project'

# 查看输出
tmux attach -t wechat

# 终止
tmux kill-session -t wechat
```

## 文件结构

```
├── channel-mode/
│   ├── main.ts          # Channel 模式 MCP server 源码
│   └── start.sh         # Channel 模式启动脚本
├── sdk-mode/
│   ├── main.ts          # SDK 模式主程序
│   ├── wechat-tools.ts  # SDK 模式 MCP 工具（文件发送）
│   └── start.sh         # SDK 模式启动脚本
├── scripts/
│   ├── strip-bun-marker.cjs  # 构建后处理：移除 // @bun 标记
│   ├── reset-login.sh        # 清除微信登录状态
│   └── reset-all.sh          # 完全重置（登录状态 + 编译产物 + 依赖）
├── setup.ts             # 微信扫码登录工具（共用）
├── cli.mjs              # CLI 入口（npx 用）
├── docs/                # 截图和图片
├── dist/                # 构建产物
├── .env.example         # 环境变量配置模板
├── .gitignore
├── tsconfig.json
├── package.json
└── LICENSE
```

## 数据存储

所有数据保存在 `~/.claude/channels/wechat/` 下：

| 文件 | 说明 |
|------|------|
| `account.json` | 微信登录凭据（bot token、base URL、账号 ID） |
| `context_tokens.json` | 每用户/群的 context token（带 TTL） |
| `sdk_sessions.json` | SDK 模式用户-会话映射 |
| `sync_buf.txt` | 长轮询消息同步游标 |
| `debug.log` / `sdk_debug.log` | 调试日志（最大 10MB，自动轮转） |
| `media/` | 下载的图片和文件（7天后自动清理） |

## 注意事项

- Channel 模式和 SDK 模式共享微信凭据，但**不能同时运行**（两者都轮询同一个消息队列）
- ClawBot 同时支持 iOS 和 Android
- 首次启动时终端会显示二维码，用微信扫码登录
- 二维码过期后重启脚本即可获取新的

## 重置

```bash
# 仅清除登录状态（保留编译产物）
./scripts/reset-login.sh

# 完全重置（回到刚 clone 的状态）
./scripts/reset-all.sh
```

## 参与贡献

欢迎提交 Issue 和 Pull Request！

## 致谢

- [ClawBot](https://github.com/nicepkg/openclaw) — 微信机器人平台，提供 ilink API
- [Claude Code](https://claude.com/claude-code) — Anthropic 的 Claude CLI 工具
- [@anthropic-ai/claude-agent-sdk](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk) — Claude Code 编程接口 SDK

## 许可证

[MIT](LICENSE)
