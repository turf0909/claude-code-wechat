#!/usr/bin/env bun
/**
 * WeChat Tools MCP Server — for SDK mode
 *
 * Exposes wechat_send_file tool so Claude can send native WeChat files/images.
 * Reads account from account.json, context_token from WECHAT_CONTEXT_TOKEN env var.
 * Spawned by the SDK mode main process as an MCP server child process.
 */

import fs from "node:fs";
import path from "node:path";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import { MAX_FILE_SIZE_BYTES } from "../shared/config.ts";
import type { AccountData } from "../shared/types.ts";
import { uploadAndSendMedia } from "../shared/cdn.ts";
import { sendTextMessage } from "../shared/message.ts";
import { loadCredentials } from "../shared/credentials.ts";

// ── Env ─────────────────────────────────────────────────────────────────────

const SENDER_ID = process.env.WECHAT_SENDER_ID || "";
const CONTEXT_TOKEN = process.env.WECHAT_CONTEXT_TOKEN || "";

// ── Account (cached) ────────────────────────────────────────────────────────

let cachedAccount: AccountData | null = null;
function getAccount(): AccountData | null {
  if (!cachedAccount) {
    cachedAccount = loadCredentials();
  }
  return cachedAccount;
}

// ── MCP Server ──────────────────────────────────────────────────────────────

const mcp = new Server(
  { name: "wechat-tools", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "wechat_thinking",
      description: "Send a short status message to the WeChat user (e.g. '正在读取文件...'). Use this before long operations so the user sees progress.",
      inputSchema: {
        type: "object" as const,
        properties: {
          text: { type: "string", description: "Short status text" },
        },
        required: ["text"],
      },
    },
    {
      name: "wechat_send_file",
      description: "Send an image or file to the WeChat user as a native WeChat message (not a download link). Use absolute file path.",
      inputSchema: {
        type: "object" as const,
        properties: {
          file_path: { type: "string", description: "Absolute path to the local file to send" },
          caption: { type: "string", description: "Optional text caption to send before the file" },
        },
        required: ["file_path"],
      },
    },
  ],
}));

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const account = getAccount();
  if (!account) return { content: [{ type: "text" as const, text: "error: no account credentials" }] };
  if (!SENDER_ID || !CONTEXT_TOKEN) return { content: [{ type: "text" as const, text: "error: missing sender/context" }] };

  if (req.params.name === "wechat_thinking") {
    const { text } = req.params.arguments as { text: string };
    try {
      await sendTextMessage(account.baseUrl, account.token, SENDER_ID, text, CONTEXT_TOKEN);
      return { content: [{ type: "text" as const, text: `sent: ${text}` }] };
    } catch (err) {
      return { content: [{ type: "text" as const, text: `send failed: ${String(err)}` }] };
    }
  }

  if (req.params.name === "wechat_send_file") {
    const { file_path, caption } = req.params.arguments as { file_path: string; caption?: string };
    if (!fs.existsSync(file_path)) return { content: [{ type: "text" as const, text: `error: file not found: ${file_path}` }] };
    const fileSize = fs.statSync(file_path).size;
    if (fileSize > MAX_FILE_SIZE_BYTES) return { content: [{ type: "text" as const, text: `error: file too large (${(fileSize / 1024 / 1024).toFixed(1)}MB, max ${MAX_FILE_SIZE_BYTES / 1024 / 1024}MB)` }] };
    try {
      const sendTextFn = async (text: string) => {
        await sendTextMessage(account.baseUrl, account.token, SENDER_ID, text, CONTEXT_TOKEN);
      };
      await uploadAndSendMedia(account.baseUrl, account.token, SENDER_ID, file_path, CONTEXT_TOKEN, sendTextFn, caption);
      return { content: [{ type: "text" as const, text: `sent: ${path.basename(file_path)}` }] };
    } catch (err) {
      return { content: [{ type: "text" as const, text: `send failed: ${String(err)}` }] };
    }
  }

  throw new Error(`Unknown tool: ${req.params.name}`);
});

async function main() {
  await mcp.connect(new StdioServerTransport());
}

main().catch((err) => { process.stderr.write(`wechat-tools error: ${err}\n`); process.exit(1); });
