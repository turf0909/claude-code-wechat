#!/usr/bin/env bun
/**
 * WeChat Tools MCP Server — for SDK mode
 *
 * Exposes wechat_send_file tool so Claude can send native WeChat files/images.
 * Reads account from account.json, context_token from WECHAT_CONTEXT_TOKEN env var.
 * Spawned by the SDK mode main process as an MCP server child process.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";

// ── Config ───────────────────────────────────────────────────────────────────

const CREDENTIALS_FILE = process.env.WECHAT_CREDENTIALS_FILE
  ? path.resolve(process.env.WECHAT_CREDENTIALS_FILE)
  : path.join(os.homedir(), ".claude", "channels", "wechat", "account.json");
const SENDER_ID = process.env.WECHAT_SENDER_ID || "";
const CONTEXT_TOKEN = process.env.WECHAT_CONTEXT_TOKEN || "";
const API_TIMEOUT_MS = 15_000;
const CDN_UPLOAD_TIMEOUT_MS = 60_000;
const CDN_UPLOAD_MAX_RETRIES = 3;
const CDN_UPLOAD_RETRY_DELAY_MS = 1_000;
const MAX_FILE_SIZE_BYTES = 100 * 1024 * 1024; // 100MB
const WECHAT_CDN_BASE = "https://novac2c.cdn.weixin.qq.com/c2c";
const MSG_ITEM_TEXT = 1;
const MSG_ITEM_IMAGE = 2;
const MSG_ITEM_FILE = 4;
const MSG_TYPE_BOT = 2;
const MSG_STATE_FINISH = 2;

const CHANNEL_VERSION = "0.3.0";

type AccountData = { token: string; baseUrl: string; accountId: string };

let cachedAccount: AccountData | null = null;
function getAccount(): AccountData | null {
  if (!cachedAccount) {
    try { cachedAccount = JSON.parse(fs.readFileSync(CREDENTIALS_FILE, "utf-8")); } catch {}
  }
  return cachedAccount;
}

// ── HTTP / API ───────────────────────────────────────────────────────────────

async function fetchWithTimeout(input: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(input, { ...init, signal: controller.signal });
    clearTimeout(timer); return res;
  } catch (err) { clearTimeout(timer); throw err; }
}

function buildHeaders(token?: string, body?: string): Record<string, string> {
  const uin = Buffer.from(String(crypto.randomBytes(4).readUInt32BE(0)), "utf-8").toString("base64");
  const h: Record<string, string> = { "Content-Type": "application/json", AuthorizationType: "ilink_bot_token", "X-WECHAT-UIN": uin };
  if (body) h["Content-Length"] = String(Buffer.byteLength(body, "utf-8"));
  if (token?.trim()) h.Authorization = `Bearer ${token.trim()}`;
  return h;
}

async function apiFetch(baseUrl: string, endpoint: string, body: string, token: string): Promise<string> {
  const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  const url = new URL(endpoint, base).toString();
  const res = await fetchWithTimeout(url, { method: "POST", headers: buildHeaders(token, body), body }, API_TIMEOUT_MS);
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text}`);
  return text;
}

// ── Crypto ───────────────────────────────────────────────────────────────────

function encryptAesEcb(plaintext: Buffer, key: Buffer): Buffer {
  const cipher = crypto.createCipheriv("aes-128-ecb", key, null);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}

function aesEcbPaddedSize(size: number): number { return Math.ceil((size + 1) / 16) * 16; }

// ── CDN Upload & Send ────────────────────────────────────────────────────────

async function uploadAndSendMedia(
  baseUrl: string, token: string, to: string, filePath: string, contextToken: string, caption?: string,
): Promise<void> {
  const plaintext = fs.readFileSync(filePath);
  const rawsize = plaintext.length;
  const rawfilemd5 = crypto.createHash("md5").update(plaintext).digest("hex");
  const filesize = aesEcbPaddedSize(rawsize);
  const filekey = crypto.randomBytes(16).toString("hex");
  const aeskey = crypto.randomBytes(16);
  const fileName = path.basename(filePath);
  const ext = path.extname(filePath).toLowerCase();
  const isImage = [".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp"].includes(ext);
  const mediaType = isImage ? 1 : 3;

  const uploadResp = JSON.parse(await apiFetch(baseUrl, "ilink/bot/getuploadurl", JSON.stringify({
    filekey, media_type: mediaType, to_user_id: to, rawsize, rawfilemd5, filesize,
    no_need_thumb: true, aeskey: aeskey.toString("hex"), base_info: { channel_version: CHANNEL_VERSION },
  }), token));
  if (!uploadResp.upload_param) throw new Error("No upload_param");

  const ciphertext = encryptAesEcb(plaintext, aeskey);
  const cdnUrl = `${WECHAT_CDN_BASE}/upload?encrypted_query_param=${encodeURIComponent(uploadResp.upload_param)}&filekey=${encodeURIComponent(filekey)}`;
  let downloadParam = "";
  let lastErr: Error | null = null;
  for (let i = 1; i <= CDN_UPLOAD_MAX_RETRIES; i++) {
    try {
      const res = await fetchWithTimeout(cdnUrl, {
        method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: ciphertext,
      }, CDN_UPLOAD_TIMEOUT_MS);
      await res.arrayBuffer();
      if (!res.ok) {
        const errMsg = res.headers.get("x-error-message") ?? `status ${res.status}`;
        if (res.status >= 400 && res.status < 500) throw new Error(`CDN upload 4xx: ${errMsg}`);
        throw new Error(`CDN upload failed: ${errMsg}`);
      }
      downloadParam = res.headers.get("x-encrypted-param") || "";
      if (!downloadParam) throw new Error("Missing x-encrypted-param");
      break;
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err));
      if (lastErr.message.includes("4xx")) throw lastErr;
      if (i < CDN_UPLOAD_MAX_RETRIES) await new Promise((r) => setTimeout(r, CDN_UPLOAD_RETRY_DELAY_MS));
    }
  }
  if (!downloadParam) throw lastErr ?? new Error("CDN upload failed");

  if (caption) await sendText(baseUrl, token, to, caption, contextToken);

  const aesKeyBase64 = Buffer.from(aeskey.toString("hex")).toString("base64");
  const media = { encrypt_query_param: downloadParam, aes_key: aesKeyBase64, encrypt_type: 1 };
  const clientId = generateToolClientId();
  const item = isImage
    ? { type: MSG_ITEM_IMAGE, image_item: { media, mid_size: filesize } }
    : { type: MSG_ITEM_FILE, file_item: { media, file_name: fileName, len: String(rawsize) } };

  await apiFetch(baseUrl, "ilink/bot/sendmessage", JSON.stringify({
    msg: { from_user_id: "", to_user_id: to, client_id: clientId,
      message_type: MSG_TYPE_BOT, message_state: MSG_STATE_FINISH,
      item_list: [item], context_token: contextToken },
    base_info: { channel_version: CHANNEL_VERSION },
  }), token);
}

// ── MCP Server ───────────────────────────────────────────────────────────────

const mcp = new Server(
  { name: "wechat-tools", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

function generateToolClientId(): string {
  return `tools:${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
}

async function sendText(baseUrl: string, token: string, to: string, text: string, contextToken: string): Promise<void> {
  const clientId = generateToolClientId();
  await apiFetch(baseUrl, "ilink/bot/sendmessage", JSON.stringify({
    msg: { from_user_id: "", to_user_id: to, client_id: clientId,
      message_type: MSG_TYPE_BOT, message_state: MSG_STATE_FINISH,
      item_list: [{ type: MSG_ITEM_TEXT, text_item: { text } }], context_token: contextToken },
    base_info: { channel_version: CHANNEL_VERSION },
  }), token);
}

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
      await sendText(account.baseUrl, account.token, SENDER_ID, text, CONTEXT_TOKEN);
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
      await uploadAndSendMedia(account.baseUrl, account.token, SENDER_ID, file_path, CONTEXT_TOKEN, caption);
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
