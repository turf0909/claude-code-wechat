# Claude Code WeChat

Connect WeChat to Claude Code — chat with Claude Code directly from WeChat.

Based on the official WeChat ClawBot ilink API, this project bridges WeChat messages into Claude Code sessions, letting you interact with Claude Code from your phone.

## How It Works

```
WeChat user sends a message
    |
WeChat ClawBot -> ilink API (long polling)
    |
Channel mode MCP server (local stdio)
    | notifications/claude/channel
Claude Code receives message, generates response
    |
wechat_thinking / wechat_reply / wechat_send_file tools
    |
ilink/bot/sendmessage -> WeChat user receives reply
```

## Features

- **Text messaging** — Messages auto-forwarded between WeChat and Claude Code
- **Image support** — Receive and send images (CDN download/upload with AES-128-ECB encryption)
- **File support** — Receive and send arbitrary files
- **Voice messages** — Automatic speech-to-text via WeChat
- **Link sharing** — Parse shared links from users
- **Group chat** — Auto-detect group messages, reply to correct group
- **Typing indicator** — Show "typing..." in WeChat while processing
- **Long message splitting** — Auto-split messages over 2000 chars
- **Token expiry auto-relogin** — QR code re-scan on session expiry (up to 3 times)
- **Credential persistence** — Context tokens and login saved to disk, auto-restore on restart
- **Processing status** — Send "processing..." message for complex requests
- **CDN upload retry** — Auto-retry up to 3 times (4xx fails immediately, 5xx/network retries)
- **Graceful shutdown** — Ctrl-C saves state and cleans up typing indicators
- **Media management** — Downloaded files saved to `media/`, auto-cleanup after 7 days

## Prerequisites

- [Node.js](https://nodejs.org) >= 18
- [Bun](https://bun.sh) >= 1.0 (for building; startup script auto-installs if missing)
- Python 3 (Channel mode uses it to update `.mcp.json`; not needed for SDK mode)
- WeChat ClawBot (supports iOS and Android)

**Channel mode requires:**
- [Claude Code](https://claude.com/claude-code) >= 2.1.80 (must run `claude login` first)

**SDK mode requires:**
- `ANTHROPIC_API_KEY` (from [Anthropic Console](https://console.anthropic.com/) or your API proxy)

## Quick Start

```bash
git clone https://github.com/turf0909/claude-code-wechat.git
cd claude-code-wechat
cp .env.example .env
# Edit .env if needed (see Authentication below)
```

Two modes are available — pick the one that fits your setup:

### SDK Mode (recommended)

Uses the Claude Agent SDK directly. Multi-user, slash commands, message queue. Requires an API Key.

```bash
# Edit .env: ANTHROPIC_API_KEY=sk-ant-xxx
./sdk-mode/start.sh

# Or specify a working directory for Claude to operate on
./sdk-mode/start.sh ~/my-project
```

### Channel Mode

Uses Claude Code CLI as the backend. Supports both API Key and OAuth (if no API Key is set, falls back to OAuth).

```bash
# Requires claude login (for CLI auth), plus optionally ANTHROPIC_API_KEY in .env
./channel-mode/start.sh

# Or with a working directory
./channel-mode/start.sh ~/my-project
```

### Authentication

The startup scripts auto-detect API configuration from `.env` (in project root):
1. `ANTHROPIC_API_KEY` set → use API Key (with optional `ANTHROPIC_BASE_URL` proxy)
2. Nothing set → use Claude Code's default API (Channel mode only)

> Channel mode always requires `claude login` regardless of API Key settings. SDK mode only needs `ANTHROPIC_API_KEY`.

> `.env` is gitignored and won't be committed. See `.env.example` for all options.

> **Working directory**: Without arguments, Claude works in the bot's own directory. With a path, Claude can read/write files and run commands in that directory — useful for having WeChat Claude help you with another project's code.

### Chat on WeChat

Open WeChat, find the ClawBot conversation, and send a message. Claude's reply is sent back to WeChat automatically.

### Using an API Proxy

To route requests through a proxy (e.g., for enterprise or regional access):

```env
# .env
ANTHROPIC_API_KEY=your-key
ANTHROPIC_BASE_URL=https://your-proxy.example.com
```

### Manual Steps (Optional)

```bash
# Install dependencies and build manually
bun install
npm run build

# Run QR login separately
node dist/setup.js
node dist/setup.js --force   # Skip "re-login?" confirmation
```

Use `WECHAT_CREDENTIALS_FILE` env var for custom credential paths (multi-user setups).

## Slash Commands (SDK Mode Only)

| Command | Description |
|---------|-------------|
| `/new` | Start new conversation (old one preserved, use `/resume` to restore) |
| `/clear` | Clear current conversation context (keep session) |
| `/stop` | Abort current running task |
| `/cancel` | Abort current task and clear queued messages |
| `/resume` | List conversation history |
| `/resume <id>` | Restore a specific conversation (prefix match) |
| `/compact` | Compact current conversation context |
| `/model` | View current model |
| `/model <name>` | Switch model (auto-validates availability) |
| `/thinking` | View Thinking mode status |
| `/thinking on/off` | Enable/disable Thinking mode (off by default; some models don't support it) |
| `/status` | View current status (model, Thinking, Session, task, version) |
| `/help` | Show command help |

## MCP Tools

| Tool | Description |
|------|-------------|
| `wechat_thinking` | Send a processing status message + typing indicator |
| `wechat_reply` | Send text reply to WeChat user (auto-splits long messages) |
| `wechat_send_file` | Send image or file to WeChat user via CDN |

## Background Running (tmux)

```bash
tmux new-session -d -s wechat './sdk-mode/start.sh ~/my-project'

# Attach to view output
tmux attach -t wechat

# Kill session
tmux kill-session -t wechat
```

## SDK Mode Features

- **Multi-user independent sessions** — Each WeChat user has their own conversation
- **Message queue** — Multiple messages processed in order, no drops
- **Session recovery** — Auto-restore on restart, `/resume` to switch history
- **Model switching** — Dynamic model switch via `/model`
- **No OAuth required** — Only needs `ANTHROPIC_API_KEY`

## Mode Comparison

| | Channel Mode (`channel-mode/start.sh`) | SDK Mode (`sdk-mode/start.sh`) |
|---|---|---|
| Authentication | `claude login` + optional API Key | **API Key only** |
| Claude Code CLI | Required | **Not required** |
| Multi-user sessions | No (shared session) | **Yes** |
| Slash commands | No | **Yes** |
| Message queue | No | **Yes** |
| Response latency | Low (persistent connection) | ~3s (API round-trip) |

## File Structure

```
├── channel-mode/
│   ├── main.ts          # Channel mode MCP server source
│   └── start.sh         # Channel mode startup script
├── sdk-mode/
│   ├── main.ts          # SDK mode main program
│   ├── wechat-tools.ts  # SDK mode MCP tools (file sending)
│   └── start.sh         # SDK mode startup script
├── scripts/
│   ├── strip-bun-marker.cjs  # Post-build: remove // @bun marker
│   ├── reset-login.sh        # Clear WeChat login state
│   └── reset-all.sh          # Full reset (login + build + deps)
├── setup.ts             # WeChat QR login tool (shared)
├── cli.mjs              # CLI entry point (for npx)
├── dist/                # Build output
├── .env.example         # Environment config template
├── .gitignore
├── tsconfig.json
├── package.json
└── LICENSE
```

## Data Storage

All data saved under `~/.claude/channels/wechat/`:

| File | Description |
|------|-------------|
| `account.json` | WeChat login credentials (bot token, base URL, account ID) |
| `context_tokens.json` | Per-user/group context tokens (with TTL) |
| `sdk_sessions.json` | SDK mode user-session mapping |
| `sync_buf.txt` | Message sync cursor for long polling |
| `debug.log` / `sdk_debug.log` | Debug logs (max 10MB, rotated) |
| `media/` | Downloaded images and files (auto-cleanup after 7 days) |

## Notes

- Channel mode and SDK mode share WeChat credentials but **cannot run simultaneously** (both poll the same message queue)
- ClawBot supports both iOS and Android
- First launch shows a QR code in terminal — scan with WeChat to log in
- If QR scan times out, restart the script to get a new QR code

## Reset

```bash
# Clear login state only (keep build)
./scripts/reset-login.sh

# Full reset (back to post-clone state)
./scripts/reset-all.sh
```

## License

[MIT](LICENSE)
