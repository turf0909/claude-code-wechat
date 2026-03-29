#!/usr/bin/env bun
/**
 * Claude Code WeChat Channel Plugin
 *
 * Bridges WeChat messages into a Claude Code session via the Channels MCP protocol.
 * Uses the official WeChat ClawBot ilink API (same as @tencent-weixin/openclaw-weixin).
 *
 * Flow:
 *   1. QR login via ilink/bot/get_bot_qrcode + get_qrcode_status
 *   2. Long-poll ilink/bot/getupdates for incoming messages (text, image, file, voice, link)
 *   3. Forward messages to Claude Code as <channel> events with media_type/media_path meta
 *   4. Show typing indicator via ilink/bot/getconfig + sendtyping
 *   5. Expose tools: wechat_thinking, wechat_reply, wechat_send_file
 */

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

// ── Config ────────────────────────────────────────────────────────────────────

const CHANNEL_NAME = "wechat";
const CHANNEL_VERSION = "0.2.0";
const DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com";
const BOT_TYPE = "3";
const CREDENTIALS_FILE = process.env.WECHAT_CREDENTIALS_FILE
  ? path.resolve(process.env.WECHAT_CREDENTIALS_FILE)
  : path.join(os.homedir(), ".claude", "channels", "wechat", "account.json");
const CREDENTIALS_DIR = path.dirname(CREDENTIALS_FILE);
const MEDIA_DIR = path.join(CREDENTIALS_DIR, "media");
const MEDIA_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const MEDIA_CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours

const LONG_POLL_TIMEOUT_MS = 35_000;
const API_TIMEOUT_MS = 15_000;
const MAX_CONSECUTIVE_FAILURES = 3;
const BACKOFF_DELAY_MS = 30_000;
const RETRY_DELAY_MS = 2_000;
const SESSION_EXPIRED_ERRCODE = -14;
const QR_LOGIN_TIMEOUT_MS = 480_000;
const QR_POLL_DELAY_MS = 1_000;
const MAX_MSG_LEN = 2_000;
const SPLIT_DELAY_MS = 800;

// ── Logging (stderr only — stdout is MCP stdio) ─────────────────────────────

const LOG_FILE = path.join(CREDENTIALS_DIR, "debug.log");
const LOG_OLD_FILE = `${LOG_FILE}.old`;
const LOG_MAX_BYTES = 10 * 1024 * 1024; // 10 MB
let logWriteCount = 0;

function rotateLogIfNeeded(): void {
  try {
    const stat = fs.statSync(LOG_FILE);
    if (stat.size > LOG_MAX_BYTES) {
      try { fs.unlinkSync(LOG_OLD_FILE); } catch {}
      fs.renameSync(LOG_FILE, LOG_OLD_FILE);
    }
  } catch {}
}

function appendLog(line: string): void {
  try {
    fs.appendFileSync(LOG_FILE, line);
    if (++logWriteCount % 500 === 0) rotateLogIfNeeded();
  } catch {}
}

function log(msg: string) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  process.stderr.write(`[wechat-channel] ${msg}\n`);
  appendLog(line);
}

function logError(msg: string) {
  const line = `[${new Date().toISOString()}] ERROR: ${msg}\n`;
  process.stderr.write(`[wechat-channel] ERROR: ${msg}\n`);
  appendLog(line);
}

// ── Media Cleanup ────────────────────────────────────────────────────────────

function cleanupOldMedia(): void {
  try {
    const now = Date.now();
    for (const file of fs.readdirSync(MEDIA_DIR)) {
      try {
        const filePath = path.join(MEDIA_DIR, file);
        const stat = fs.statSync(filePath);
        if (now - stat.mtimeMs > MEDIA_MAX_AGE_MS) {
          fs.unlinkSync(filePath);
          log(`Cleaned up expired file: ${file}`);
        }
      } catch {}
    }
  } catch {}
}

// ── Credentials ──────────────────────────────────────────────────────────────

type AccountData = {
  token: string;
  baseUrl: string;
  accountId: string;
  userId?: string;
  savedAt: string;
};

function loadCredentials(): AccountData | null {
  try {
    return JSON.parse(fs.readFileSync(CREDENTIALS_FILE, "utf-8"));
  } catch {
    return null;
  }
}

function saveCredentials(data: AccountData): void {
  fs.mkdirSync(CREDENTIALS_DIR, { recursive: true });
  fs.writeFileSync(CREDENTIALS_FILE, JSON.stringify(data, null, 2), "utf-8");
  try {
    fs.chmodSync(CREDENTIALS_FILE, 0o600);
  } catch {
    // best-effort
  }
}

// ── WeChat ilink API ─────────────────────────────────────────────────────────

function randomWechatUin(): string {
  const uint32 = crypto.randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(uint32), "utf-8").toString("base64");
}

function buildHeaders(token?: string, body?: string): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    AuthorizationType: "ilink_bot_token",
    "X-WECHAT-UIN": randomWechatUin(),
  };
  if (body) {
    headers["Content-Length"] = String(Buffer.byteLength(body, "utf-8"));
  }
  if (token?.trim()) {
    headers.Authorization = `Bearer ${token.trim()}`;
  }
  return headers;
}

async function fetchWithTimeout(
  input: string | URL,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(input, { ...init, signal: controller.signal });
    clearTimeout(timer);
    return res;
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

async function apiFetch(params: {
  baseUrl: string;
  endpoint: string;
  body: string;
  token?: string;
  timeoutMs: number;
}): Promise<string> {
  const base = params.baseUrl.endsWith("/")
    ? params.baseUrl
    : `${params.baseUrl}/`;
  const url = new URL(params.endpoint, base).toString();
  const headers = buildHeaders(params.token, params.body);
  const res = await fetchWithTimeout(url, {
    method: "POST",
    headers,
    body: params.body,
  }, params.timeoutMs);
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text}`);
  let json: any;
  try { json = JSON.parse(text); } catch { return text; }
  if (json.ret && json.ret !== 0 && json.ret !== SESSION_EXPIRED_ERRCODE) {
    throw new Error(`API ret=${json.ret} errcode=${json.errcode ?? 0}: ${json.errmsg ?? text}`);
  }
  if (json.errcode && json.errcode !== 0 && json.errcode !== SESSION_EXPIRED_ERRCODE) {
    throw new Error(`API errcode ${json.errcode}: ${json.errmsg ?? text}`);
  }
  return text;
}

// ── QR Login ─────────────────────────────────────────────────────────────────

interface QRCodeResponse {
  qrcode: string;
  qrcode_img_content: string;
}

interface QRStatusResponse {
  status: "wait" | "scaned" | "confirmed" | "expired";
  bot_token?: string;
  ilink_bot_id?: string;
  baseurl?: string;
  ilink_user_id?: string;
}

async function fetchQRCode(baseUrl: string): Promise<QRCodeResponse> {
  const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  const url = new URL(
    `ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(BOT_TYPE)}`,
    base,
  );
  const res = await fetchWithTimeout(url.toString(), {}, API_TIMEOUT_MS);
  if (!res.ok) throw new Error(`QR fetch failed: ${res.status}`);
  return (await res.json()) as QRCodeResponse;
}

async function pollQRStatus(
  baseUrl: string,
  qrcode: string,
): Promise<QRStatusResponse> {
  const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  const url = new URL(
    `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`,
    base,
  );
  try {
    const res = await fetchWithTimeout(url.toString(), {
      headers: { "iLink-App-ClientVersion": "1" },
    }, LONG_POLL_TIMEOUT_MS);
    if (!res.ok) throw new Error(`QR status failed: ${res.status}`);
    return (await res.json()) as QRStatusResponse;
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      return { status: "wait" };
    }
    throw err;
  }
}

async function doQRLogin(
  baseUrl: string,
): Promise<AccountData | null> {
  log("Fetching WeChat login QR code...");
  const qrResp = await fetchQRCode(baseUrl);

  const qrUrl = qrResp.qrcode_img_content;
  log(`\nQR scan link: ${qrUrl}\n`);

  // Push QR link to Claude Code UI (stderr may be invisible in MCP stdio mode)
  try {
    await mcp.notification({
      method: "notifications/claude/channel",
      params: {
        content: `请扫码登录微信: ${qrUrl}`,
        meta: { sender: "system", sender_id: "system" },
      },
    });
  } catch {}

  try {
    const qrterm = await import("qrcode-terminal");
    await new Promise<void>((resolve) => {
      qrterm.default.generate(qrUrl, {}, (qr: string) => {
        process.stderr.write(qr + "\n");
        resolve();
      });
    });
  } catch {}

  log("Waiting for QR scan...");
  const deadline = Date.now() + QR_LOGIN_TIMEOUT_MS;
  let scannedPrinted = false;

  while (Date.now() < deadline) {
    const status = await pollQRStatus(baseUrl, qrResp.qrcode);

    switch (status.status) {
      case "wait":
        break;
      case "scaned":
        if (!scannedPrinted) {
          log("QR scanned, please confirm in WeChat...");
          scannedPrinted = true;
        }
        break;
      case "expired":
        log("QR code expired, please restart.");
        return null;
      case "confirmed": {
        if (!status.ilink_bot_id || !status.bot_token) {
          logError("Login confirmed but no bot info returned");
          return null;
        }
        const account: AccountData = {
          token: status.bot_token,
          baseUrl: status.baseurl || baseUrl,
          accountId: status.ilink_bot_id,
          userId: status.ilink_user_id,
          savedAt: new Date().toISOString(),
        };
        saveCredentials(account);
        log("WeChat connected successfully!");
        return account;
      }
    }
    await new Promise((r) => setTimeout(r, QR_POLL_DELAY_MS));
  }

  log("Login timed out");
  return null;
}

// ── WeChat Message Types ─────────────────────────────────────────────────────

interface TextItem {
  text?: string;
}

interface RefMessage {
  message_item?: MessageItem;
  title?: string;
}

interface ImageItem {
  url?: string;
  cdn_url?: string;
  thumb_url?: string;
  aeskey?: string;
  media?: {
    encrypt_query_param?: string;
    aes_key?: string;
    mid_size?: number;
    thumb_size?: number;
    thumb_height?: number;
    thumb_width?: number;
    hd_size?: number;
  };
}

interface FileItem {
  url?: string;
  file_name?: string;
  file_size?: number;
  len?: string;
  media?: {
    encrypt_query_param?: string;
    aes_key?: string;
  };
}

interface LinkItem {
  url?: string;
  title?: string;
  desc?: string;
}

interface MessageItem {
  type?: number;
  text_item?: TextItem;
  voice_item?: { text?: string };
  image_item?: ImageItem;
  file_item?: FileItem;
  link_item?: LinkItem;
  ref_msg?: RefMessage;
}

interface WeixinMessage {
  from_user_id?: string;
  to_user_id?: string;
  client_id?: string;
  session_id?: string;
  group_id?: string;
  message_type?: number;
  message_state?: number;
  item_list?: MessageItem[];
  context_token?: string;
  create_time_ms?: number;
}

interface GetUpdatesResp {
  ret?: number;
  errcode?: number;
  errmsg?: string;
  msgs?: WeixinMessage[];
  get_updates_buf?: string;
  longpolling_timeout_ms?: number;
}

// Message type constants
const MSG_TYPE_USER = 1;
const MSG_ITEM_TEXT = 1;
const MSG_ITEM_IMAGE = 2;
const MSG_ITEM_VOICE = 3;
const MSG_ITEM_FILE = 4;
const MSG_ITEM_LINK = 5;
const MSG_TYPE_BOT = 2;
const MSG_STATE_FINISH = 2;

type ExtractedContent =
  | { kind: "text"; text: string }
  | { kind: "image"; imageItem: ImageItem }
  | { kind: "file"; fileItem: FileItem; fileName: string }
  | null;

function extractContent(msg: WeixinMessage): ExtractedContent {
  if (!msg.item_list?.length) return null;
  for (const item of msg.item_list) {
    if (item.type === MSG_ITEM_TEXT && item.text_item?.text) {
      const text = item.text_item.text;
      const ref = item.ref_msg;
      if (!ref) return { kind: "text", text };
      const parts: string[] = [];
      if (ref.title) parts.push(ref.title);
      if (!parts.length) return { kind: "text", text };
      return { kind: "text", text: `[引用: ${parts.join(" | ")}]\n${text}` };
    }
    if (item.type === MSG_ITEM_VOICE && item.voice_item?.text) {
      return { kind: "text", text: item.voice_item.text };
    }
    if (item.type === MSG_ITEM_IMAGE) {
      log(`Image message raw data: ${JSON.stringify(item)}`);
      if (item.image_item) return { kind: "image", imageItem: item.image_item };
      return { kind: "text", text: "[用户发送了一张图片，但无法获取图片数据]" };
    }
    if (item.type === MSG_ITEM_FILE) {
      log(`File message raw data: ${JSON.stringify(item)}`);
      const name = item.file_item?.file_name || "unknown_file";
      if (item.file_item?.media?.encrypt_query_param && item.file_item?.media?.aes_key) {
        return { kind: "file", fileItem: item.file_item, fileName: name };
      }
      return { kind: "text", text: `[用户发送了文件: ${name}，但无法获取下载参数]` };
    }
    if (item.type === MSG_ITEM_LINK) {
      const title = item.link_item?.title || "";
      const url = item.link_item?.url || "";
      return { kind: "text", text: `[用户分享了链接: ${title} ${url}]` };
    }
    // Unknown type - log for debugging
    log(`Unknown message type=${item.type}, raw data: ${JSON.stringify(item)}`);
  }
  return null;
}

const WECHAT_CDN_BASE = "https://novac2c.cdn.weixin.qq.com/c2c";

function parseAesKey(aesKeyBase64: string): Buffer {
  const decoded = Buffer.from(aesKeyBase64, "base64");
  if (decoded.length === 16) return decoded;
  if (decoded.length === 32 && /^[0-9a-fA-F]{32}$/.test(decoded.toString("ascii"))) {
    return Buffer.from(decoded.toString("ascii"), "hex");
  }
  throw new Error(`invalid aes_key: decoded to ${decoded.length} bytes`);
}

function decryptAesEcb(encrypted: Buffer, key: Buffer): Buffer {
  const decipher = crypto.createDecipheriv("aes-128-ecb", key, null);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]);
}

function encryptAesEcb(plaintext: Buffer, key: Buffer): Buffer {
  const cipher = crypto.createCipheriv("aes-128-ecb", key, null);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}

function aesEcbPaddedSize(plaintextSize: number): number {
  return Math.ceil((plaintextSize + 1) / 16) * 16;
}

// ── CDN Upload ──────────────────────────────────────────────────────────────

const UPLOAD_MEDIA_TYPE = { IMAGE: 1, VIDEO: 2, FILE: 3, VOICE: 4 } as const;

interface GetUploadUrlResp {
  upload_param?: string;
  thumb_upload_param?: string;
}

async function getUploadUrl(
  baseUrl: string,
  token: string,
  params: {
    filekey: string;
    media_type: number;
    to_user_id: string;
    rawsize: number;
    rawfilemd5: string;
    filesize: number;
    no_need_thumb: boolean;
    aeskey: string;
  },
): Promise<GetUploadUrlResp> {
  const raw = await apiFetch({
    baseUrl,
    endpoint: "ilink/bot/getuploadurl",
    body: JSON.stringify({
      ...params,
      base_info: { channel_version: CHANNEL_VERSION },
    }),
    token,
    timeoutMs: API_TIMEOUT_MS,
  });
  return JSON.parse(raw) as GetUploadUrlResp;
}

const CDN_UPLOAD_MAX_RETRIES = 3;
const CDN_UPLOAD_RETRY_DELAY_MS = 1_000;
const CDN_UPLOAD_TIMEOUT_MS = 60_000; // 60s per attempt
const MAX_FILE_SIZE_BYTES = 100 * 1024 * 1024; // 100MB

async function uploadBufferToCdn(params: {
  buf: Buffer;
  uploadParam: string;
  filekey: string;
  aeskey: Buffer;
}): Promise<string> {
  const ciphertext = encryptAesEcb(params.buf, params.aeskey);
  const cdnUrl = `${WECHAT_CDN_BASE}/upload?encrypted_query_param=${encodeURIComponent(params.uploadParam)}&filekey=${encodeURIComponent(params.filekey)}`;

  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= CDN_UPLOAD_MAX_RETRIES; attempt++) {
    try {
      const res = await fetchWithTimeout(cdnUrl, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: ciphertext,
      }, CDN_UPLOAD_TIMEOUT_MS);
      await res.arrayBuffer();
      if (!res.ok) {
        const errMsg = res.headers.get("x-error-message") ?? `status ${res.status}`;
        if (res.status >= 400 && res.status < 500) {
          throw new Error(`CDN upload failed (4xx, no retry): ${errMsg}`);
        }
        throw new Error(`CDN upload failed: ${errMsg}`);
      }
      const downloadParam = res.headers.get("x-encrypted-param");
      if (!downloadParam) throw new Error("CDN response missing x-encrypted-param header");
      return downloadParam;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (lastError.message.includes("4xx, no retry")) throw lastError;
      if (attempt < CDN_UPLOAD_MAX_RETRIES) {
        log(`CDN upload failed (attempt ${attempt}/${CDN_UPLOAD_MAX_RETRIES}): ${lastError.message}, retrying...`);
        await new Promise((r) => setTimeout(r, CDN_UPLOAD_RETRY_DELAY_MS));
      }
    }
  }
  throw lastError ?? new Error("CDN upload failed after retries");
}

async function uploadAndSendMedia(
  baseUrl: string,
  token: string,
  to: string,
  filePath: string,
  contextToken: string,
  caption?: string,
): Promise<void> {
  const plaintext = fs.readFileSync(filePath);
  const rawsize = plaintext.length;
  const rawfilemd5 = crypto.createHash("md5").update(plaintext).digest("hex");
  const filesize = aesEcbPaddedSize(rawsize);
  const filekey = crypto.randomBytes(16).toString("hex");
  const aeskey = crypto.randomBytes(16);
  const fileName = path.basename(filePath);

  // Determine media type from extension
  const ext = path.extname(filePath).toLowerCase();
  const isImage = [".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp"].includes(ext);
  const mediaType = isImage ? UPLOAD_MEDIA_TYPE.IMAGE : UPLOAD_MEDIA_TYPE.FILE;

  log(`Uploading file: ${fileName} size=${rawsize} type=${isImage ? "image" : "file"}`);

  const uploadResp = await getUploadUrl(baseUrl, token, {
    filekey,
    media_type: mediaType,
    to_user_id: to,
    rawsize,
    rawfilemd5,
    filesize,
    no_need_thumb: true,
    aeskey: aeskey.toString("hex"),
  });
  if (!uploadResp.upload_param) throw new Error("getUploadUrl returned no upload_param");

  const downloadParam = await uploadBufferToCdn({
    buf: plaintext,
    uploadParam: uploadResp.upload_param,
    filekey,
    aeskey,
  });
  log(`CDN upload successful: filekey=${filekey}`);

  const aesKeyBase64 = Buffer.from(aeskey.toString("hex")).toString("base64");
  const media = { encrypt_query_param: downloadParam, aes_key: aesKeyBase64, encrypt_type: 1 };

  if (caption) {
    await sendTextMessage(baseUrl, token, to, caption, contextToken);
  }

  const clientId = generateClientId();
  const item = isImage
    ? { type: MSG_ITEM_IMAGE, image_item: { media, mid_size: filesize } }
    : { type: MSG_ITEM_FILE, file_item: { media, file_name: fileName, len: String(rawsize) } };

  await apiFetch({
    baseUrl,
    endpoint: "ilink/bot/sendmessage",
    body: JSON.stringify({
      msg: {
        from_user_id: "",
        to_user_id: to,
        client_id: clientId,
        message_type: MSG_TYPE_BOT,
        message_state: MSG_STATE_FINISH,
        item_list: [item],
        context_token: contextToken,
      },
      base_info: { channel_version: CHANNEL_VERSION },
    }),
    token,
    timeoutMs: API_TIMEOUT_MS,
  });
  log(`Media message sent: ${fileName}`);
}

const CDN_DOWNLOAD_TIMEOUT_MS = 30_000;

async function downloadAndDecryptCdn(
  encryptQueryParam: string,
  aesKeyBase64: string,
  label: string,
): Promise<Buffer | null> {
  const cdnUrl = `${WECHAT_CDN_BASE}/download?encrypted_query_param=${encodeURIComponent(encryptQueryParam)}`;
  log(`${label} CDN download: ${cdnUrl.slice(0, 150)}...`);

  try {
    const key = parseAesKey(aesKeyBase64);
    const res = await fetchWithTimeout(cdnUrl, {}, CDN_DOWNLOAD_TIMEOUT_MS);
    if (!res.ok) {
      logError(`${label} CDN download failed: HTTP ${res.status}`);
      return null;
    }
    const encrypted = Buffer.from(await res.arrayBuffer());
    const decrypted = decryptAesEcb(encrypted, key);
    log(`${label} decrypted successfully: ${decrypted.length} bytes`);
    return decrypted;
  } catch (err) {
    logError(`${label} download/decrypt error: ${String(err)}`);
    return null;
  }
}

function detectImageMimeType(buf: Buffer): string {
  if (buf[0] === 0x89 && buf[1] === 0x50) return "image/png";
  if (buf[0] === 0x47 && buf[1] === 0x49) return "image/gif";
  if (buf[0] === 0x52 && buf[1] === 0x49) return "image/webp";
  return "image/jpeg";
}

function mimeToExt(mimeType: string): string {
  if (mimeType.includes("png")) return "png";
  if (mimeType.includes("gif")) return "gif";
  if (mimeType.includes("webp")) return "webp";
  return "jpg";
}

async function downloadWechatImage(imageItem: ImageItem): Promise<{ buf: Buffer; mimeType: string } | null> {
  if (!imageItem.media?.encrypt_query_param || !imageItem.media?.aes_key) {
    logError("Image missing download parameters");
    return null;
  }
  const decrypted = await downloadAndDecryptCdn(
    imageItem.media.encrypt_query_param, imageItem.media.aes_key, "Image",
  );
  if (!decrypted) return null;
  return { buf: decrypted, mimeType: detectImageMimeType(decrypted) };
}

async function downloadWechatFile(fileItem: FileItem, fileName: string): Promise<string | null> {
  if (!fileItem.media?.encrypt_query_param || !fileItem.media?.aes_key) {
    logError("File missing download parameters");
    return null;
  }
  const decrypted = await downloadAndDecryptCdn(
    fileItem.media.encrypt_query_param, fileItem.media.aes_key, `File(${fileName})`,
  );
  if (!decrypted) return null;
  const safeName = path.basename(fileName).replace(/[\x00-\x1f]/g, "_") || "unnamed";
  const filePath = path.join(MEDIA_DIR, `file_${Date.now()}_${safeName}`);
  fs.writeFileSync(filePath, decrypted);
  return filePath;
}

// ── Context Token Cache ──────────────────────────────────────────────────────

const CONTEXT_TOKEN_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const CONTEXT_TOKEN_MAX_ENTRIES = 500;

interface ContextTokenEntry {
  token: string;
  updatedAt: number;
}

const contextTokenCache = new Map<string, ContextTokenEntry>();
const CONTEXT_TOKEN_FILE = path.join(CREDENTIALS_DIR, "context_tokens.json");

function pruneContextTokens(): void {
  const now = Date.now();
  for (const [k, v] of contextTokenCache) {
    if (now - v.updatedAt > CONTEXT_TOKEN_MAX_AGE_MS) {
      contextTokenCache.delete(k);
    }
  }
  if (contextTokenCache.size > CONTEXT_TOKEN_MAX_ENTRIES) {
    const sorted = [...contextTokenCache.entries()].sort((a, b) => a[1].updatedAt - b[1].updatedAt);
    const toDrop = sorted.length - CONTEXT_TOKEN_MAX_ENTRIES;
    for (let i = 0; i < toDrop; i++) {
      contextTokenCache.delete(sorted[i][0]);
    }
  }
}

function loadContextTokens(): void {
  try {
    const data = JSON.parse(fs.readFileSync(CONTEXT_TOKEN_FILE, "utf-8"));
    const now = Date.now();
    for (const [k, v] of Object.entries(data)) {
      // TODO: remove plain-string migration after 2026-07-01
      if (typeof v === "string") {
        contextTokenCache.set(k, { token: v, updatedAt: now });
      } else if (v && typeof v === "object" && "token" in (v as any)) {
        const entry = v as ContextTokenEntry;
        contextTokenCache.set(k, entry);
      }
    }
    pruneContextTokens();
    log(`Restored ${contextTokenCache.size} context tokens`);
  } catch {}
}

let persistTimer: ReturnType<typeof setTimeout> | null = null;

function persistContextTokens(): void {
  try {
    const obj = Object.fromEntries(contextTokenCache);
    fs.writeFileSync(CONTEXT_TOKEN_FILE, JSON.stringify(obj, null, 2), "utf-8");
  } catch {}
}

function schedulePersistContextTokens(): void {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    persistContextTokens();
  }, 5_000);
}

function cacheContextToken(userId: string, token: string): void {
  contextTokenCache.set(userId, { token, updatedAt: Date.now() });
  schedulePersistContextTokens();
}

function getCachedContextToken(userId: string): string | undefined {
  return contextTokenCache.get(userId)?.token;
}

// ── getUpdates / sendMessage ─────────────────────────────────────────────────

async function getUpdates(
  baseUrl: string,
  token: string,
  getUpdatesBuf: string,
): Promise<GetUpdatesResp> {
  try {
    const raw = await apiFetch({
      baseUrl,
      endpoint: "ilink/bot/getupdates",
      body: JSON.stringify({
        get_updates_buf: getUpdatesBuf,
        base_info: { channel_version: CHANNEL_VERSION },
      }),
      token,
      timeoutMs: LONG_POLL_TIMEOUT_MS,
    });
    return JSON.parse(raw) as GetUpdatesResp;
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      return { ret: 0, msgs: [], get_updates_buf: getUpdatesBuf };
    }
    throw err;
  }
}

function generateClientId(): string {
  return `claude-code-wechat:${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
}

async function sendTextMessage(
  baseUrl: string,
  token: string,
  to: string,
  text: string,
  contextToken: string,
): Promise<string> {
  const clientId = generateClientId();
  await apiFetch({
    baseUrl,
    endpoint: "ilink/bot/sendmessage",
    body: JSON.stringify({
      msg: {
        from_user_id: "",
        to_user_id: to,
        client_id: clientId,
        message_type: MSG_TYPE_BOT,
        message_state: MSG_STATE_FINISH,
        item_list: [{ type: MSG_ITEM_TEXT, text_item: { text } }],
        context_token: contextToken,
      },
      base_info: { channel_version: CHANNEL_VERSION },
    }),
    token,
    timeoutMs: API_TIMEOUT_MS,
  });
  return clientId;
}

// ── Text Splitting ───────────────────────────────────────────────────────────

function splitTextIntoChunks(text: string): string[] {
  if (text.length <= MAX_MSG_LEN) return [text];
  const chunks: string[] = [];
  const paragraphs = text.split(/\n\n+/);
  let current = "";
  for (const para of paragraphs) {
    if (current && (current.length + para.length + 2) > MAX_MSG_LEN) {
      chunks.push(current.trim());
      current = para;
    } else {
      current = current ? `${current}\n\n${para}` : para;
    }
    if (current.length > MAX_MSG_LEN) {
      const lines = current.split(/\n/);
      current = "";
      for (const line of lines) {
        if (current && (current.length + line.length + 1) > MAX_MSG_LEN) {
          chunks.push(current.trim());
          current = line;
        } else {
          current = current ? `${current}\n${line}` : line;
        }
        while (current.length > MAX_MSG_LEN) {
          chunks.push(current.slice(0, MAX_MSG_LEN));
          current = current.slice(MAX_MSG_LEN);
        }
      }
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks;
}

// ── Typing Indicator ─────────────────────────────────────────────────────────

const TYPING_KEEPALIVE_MS = 4_000;
const CONFIG_CACHE_TTL_MS = 24 * 60 * 60 * 1_000; // 24h
const CONFIG_CACHE_INITIAL_RETRY_MS = 2_000;
const CONFIG_CACHE_MAX_RETRY_MS = 60 * 60 * 1_000; // 1h
const TYPING_TICKET_STALE_MS = 48 * 60 * 60 * 1_000; // 48h — evict if no activity

interface TicketCacheEntry {
  ticket: string;
  nextFetchAt: number;
  retryDelayMs: number;
}

const typingTicketCache = new Map<string, TicketCacheEntry>();

function pruneTypingTicketCache(): void {
  const staleThreshold = Date.now() - TYPING_TICKET_STALE_MS;
  for (const [userId, entry] of typingTicketCache) {
    if (entry.nextFetchAt < staleThreshold) {
      typingTicketCache.delete(userId);
    }
  }
}

async function fetchAndCacheTypingTicket(
  baseUrl: string, token: string, userId: string, contextToken: string,
): Promise<string | undefined> {
  const now = Date.now();
  const entry = typingTicketCache.get(userId);

  if (entry && now < entry.nextFetchAt) {
    return entry.ticket || undefined;
  }

  try {
    const raw = await apiFetch({
      baseUrl,
      endpoint: "ilink/bot/getconfig",
      body: JSON.stringify({
        ilink_user_id: userId,
        context_token: contextToken,
        base_info: { channel_version: CHANNEL_VERSION },
      }),
      token,
      timeoutMs: 10_000,
    });
    const resp = JSON.parse(raw);
    if (resp.typing_ticket) {
      typingTicketCache.set(userId, {
        ticket: resp.typing_ticket,
        nextFetchAt: now + CONFIG_CACHE_TTL_MS * (0.5 + Math.random() * 0.5),
        retryDelayMs: CONFIG_CACHE_INITIAL_RETRY_MS,
      });
      log(`typingTicket ${entry ? "refreshed" : "cached"} for ${userId}`);
      return resp.typing_ticket;
    }
  } catch (err) {
    log(`getconfig failed for ${userId}: ${String(err)}`);
  }

  const prevDelay = entry?.retryDelayMs ?? CONFIG_CACHE_INITIAL_RETRY_MS;
  const nextDelay = Math.min(prevDelay * 2, CONFIG_CACHE_MAX_RETRY_MS);
  if (entry) {
    entry.nextFetchAt = now + nextDelay;
    entry.retryDelayMs = nextDelay;
  } else {
    typingTicketCache.set(userId, {
      ticket: "",
      nextFetchAt: now + CONFIG_CACHE_INITIAL_RETRY_MS,
      retryDelayMs: CONFIG_CACHE_INITIAL_RETRY_MS,
    });
  }
  return entry?.ticket || undefined;
}

async function sendTypingIndicator(
  baseUrl: string, token: string, userId: string, status: 1 | 2 = 1,
): Promise<void> {
  const entry = typingTicketCache.get(userId);
  if (!entry?.ticket) return;
  try {
    await apiFetch({
      baseUrl,
      endpoint: "ilink/bot/sendtyping",
      body: JSON.stringify({
        ilink_user_id: userId,
        typing_ticket: entry.ticket,
        status,
        base_info: { channel_version: CHANNEL_VERSION },
      }),
      token,
      timeoutMs: 5_000,
    });
  } catch {
    // best-effort
  }
}

// ── Typing Keepalive Tracker ─────────────────────────────────────────────────

const typingTimers = new Map<string, { interval: ReturnType<typeof setInterval>; safety: ReturnType<typeof setTimeout> }>();

const TYPING_MAX_LIFETIME_MS = 5 * 60 * 1_000; // 5 min safety cap

function startTypingKeepalive(baseUrl: string, token: string, userId: string): void {
  stopTypingKeepalive(userId);
  sendTypingIndicator(baseUrl, token, userId).catch(() => {});
  const interval = setInterval(() => {
    sendTypingIndicator(baseUrl, token, userId).catch(() => {});
  }, TYPING_KEEPALIVE_MS);
  const safety = setTimeout(() => stopTypingKeepalive(userId), TYPING_MAX_LIFETIME_MS);
  typingTimers.set(userId, { interval, safety });
}

function stopTypingKeepalive(userId: string): void {
  const entry = typingTimers.get(userId);
  if (entry) {
    clearInterval(entry.interval);
    clearTimeout(entry.safety);
    typingTimers.delete(userId);
  }
}

function stopTypingAndNotify(baseUrl: string, token: string, userId: string): void {
  stopTypingKeepalive(userId);
  sendTypingIndicator(baseUrl, token, userId, 2).catch(() => {});
}

// ── QR Re-Login ─────────────────────────────────────────────────────────────
// Reuses fetchQRCode() and pollQRStatus() from QR Login section above.

const QR_RELOGIN_MAX_ATTEMPTS = 3;

async function doQRReLogin(oldAccount: AccountData): Promise<AccountData> {
  log("Token expired, starting re-login...");

  for (let attempt = 1; attempt <= QR_RELOGIN_MAX_ATTEMPTS; attempt++) {
    log(`Re-login attempt (${attempt}/${QR_RELOGIN_MAX_ATTEMPTS})...`);
    const qrResp = await fetchQRCode(oldAccount.baseUrl);
    const qrUrl = qrResp.qrcode_img_content;
    log(`Please scan QR to re-login: ${qrUrl}`);

    try {
      await mcp.notification({
        method: "notifications/claude/channel",
        params: {
          content: `⚠️ 微信 Token 已过期，请扫码重新登录: ${qrUrl}`,
          meta: { sender: "system", sender_id: "system" },
        },
      });
    } catch {}

    const deadline = Date.now() + QR_LOGIN_TIMEOUT_MS;
    let expired = false;
    while (Date.now() < deadline) {
      const status = await pollQRStatus(oldAccount.baseUrl, qrResp.qrcode);
      if (status.status === "confirmed" && status.bot_token && status.ilink_bot_id) {
        const newAccount: AccountData = {
          token: status.bot_token,
          baseUrl: status.baseurl || oldAccount.baseUrl,
          accountId: status.ilink_bot_id,
          userId: status.ilink_user_id,
          savedAt: new Date().toISOString(),
        };
        saveCredentials(newAccount);
        log(`Re-login successful: ${newAccount.accountId}`);
        try {
          await mcp.notification({
            method: "notifications/claude/channel",
            params: {
              content: "✅ 微信重新登录成功，恢复消息监听。",
              meta: { sender: "system", sender_id: "system" },
            },
          });
        } catch {}
        return newAccount;
      }
      if (status.status === "expired") {
        log("QR code expired, fetching new one...");
        expired = true;
        break;
      }
      await new Promise((r) => setTimeout(r, QR_POLL_DELAY_MS));
    }
    if (!expired) throw new Error("Re-login timed out");
  }
  throw new Error(`Re-login failed: ${QR_RELOGIN_MAX_ATTEMPTS} attempts, no QR scan`);
}

// ── MCP Channel Server ──────────────────────────────────────────────────────

const mcp = new Server(
  { name: CHANNEL_NAME, version: CHANNEL_VERSION },
  {
    capabilities: {
      experimental: { "claude/channel": {} },
      tools: {},
    },
    instructions: [
      `Messages from WeChat users arrive as <channel source="wechat" sender="..." sender_id="..." media_type="..." media_path="...">`,
      "CRITICAL: Every time you receive a channel message, you MUST call the wechat_reply tool to send your response back. The user is on WeChat and cannot see terminal output.",
      "You MUST pass the sender_id from the inbound tag to wechat_reply.",
      "IMPORTANT: Even if you encounter errors or cannot process the request, you MUST still call wechat_reply to inform the user. NEVER leave the user without a reply.",
      "After sending the reply, display the full reply content in the terminal so the operator can see what was sent.",
      "To send images or files to the user, use the wechat_send_file tool with an absolute file path.",
      "When media_path is present in the inbound tag, the file has been downloaded locally — you can Read it.",
      "Messages are from real WeChat users via the WeChat ClawBot interface.",
      "Respond naturally in Chinese unless the user writes in another language.",
      "Keep replies concise — WeChat is a chat app, not an essay platform.",
      "Strip markdown formatting (WeChat doesn't render it). Use plain text.",
      "",
      "INTERACTION PATTERN for complex requests:",
      "1. When a request requires tool calls, FIRST call wechat_thinking with a short status (e.g. '正在阅读文件...'). This shows a status message and starts a typing indicator.",
      "2. Perform the tool calls.",
      "3. Call wechat_reply to send the final answer. The thinking message stays as a separate status record.",
      "NOTE: The WeChat ilink bot API does not support in-place message updates. Thinking and reply are separate messages.",
      "",
      "Group chat: when is_group=true in meta, use group_id as sender_id when calling wechat_reply. from_sender_id identifies who actually sent the message.",
      "If can_reply=false in meta, tell the user to resend their message. Do NOT call wechat_reply (it will fail without a context_token).",
    ].join("\n"),
  },
);

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "wechat_thinking",
      description: "Send a 'thinking/processing' status message and start a typing indicator. Use before tool calls so the user sees progress.",
      inputSchema: {
        type: "object" as const,
        properties: {
          sender_id: { type: "string", description: "The sender_id (xxx@im.wechat)" },
          text: { type: "string", description: "Short status text, e.g. '正在阅读文件...' or '正在检索文献...'" },
        },
        required: ["sender_id", "text"],
      },
    },
    {
      name: "wechat_reply",
      description: "Send the final text reply. Long messages are automatically split into multiple parts.",
      inputSchema: {
        type: "object" as const,
        properties: {
          sender_id: { type: "string", description: "The sender_id from the inbound <channel> tag (xxx@im.wechat)" },
          text: { type: "string", description: "Plain-text message to send (no markdown)" },
        },
        required: ["sender_id", "text"],
      },
    },
    {
      name: "wechat_send_file",
      description: "Send an image or file to the WeChat user. Use absolute file path.",
      inputSchema: {
        type: "object" as const,
        properties: {
          sender_id: {
            type: "string",
            description: "The sender_id (xxx@im.wechat format)",
          },
          file_path: {
            type: "string",
            description: "Absolute path to the local file to send",
          },
          caption: {
            type: "string",
            description: "Optional text caption to send before the file",
          },
        },
        required: ["sender_id", "file_path"],
      },
    },
  ],
}));

let activeAccount: AccountData | null = null;

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (!activeAccount) {
    return { content: [{ type: "text" as const, text: "error: not logged in" }] };
  }

  if (req.params.name === "wechat_thinking") {
    const { sender_id, text } = req.params.arguments as { sender_id: string; text: string };
    const contextToken = getCachedContextToken(sender_id);
    if (!contextToken) return { content: [{ type: "text" as const, text: `error: no context_token for ${sender_id}` }] };
    try {
      const clientId = await sendTextMessage(activeAccount.baseUrl, activeAccount.token, sender_id, text, contextToken);
      startTypingKeepalive(activeAccount.baseUrl, activeAccount.token, sender_id);
      return { content: [{ type: "text" as const, text: `sent thinking: ${clientId}` }] };
    } catch (err) {
      return { content: [{ type: "text" as const, text: `thinking send failed: ${String(err)}` }] };
    }
  }

  if (req.params.name === "wechat_reply") {
    const { sender_id, text } = req.params.arguments as { sender_id: string; text: string };
    const contextToken = getCachedContextToken(sender_id);
    if (!contextToken) {
      return {
        content: [
          {
            type: "text" as const,
            text: `error: no context_token for ${sender_id}. The user may need to send a message first.`,
          },
        ],
      };
    }
    try {
      stopTypingAndNotify(activeAccount.baseUrl, activeAccount.token, sender_id);
      const chunks = splitTextIntoChunks(text);
      for (let i = 0; i < chunks.length; i++) {
        if (i > 0) await new Promise((r) => setTimeout(r, SPLIT_DELAY_MS));
        await sendTextMessage(
          activeAccount.baseUrl,
          activeAccount.token,
          sender_id,
          chunks[i],
          contextToken,
        );
      }
      return {
        content: [{ type: "text" as const, text: chunks.length > 1 ? `sent (${chunks.length} parts)` : "sent" }],
      };
    } catch (err) {
      return {
        content: [
          { type: "text" as const, text: `send failed: ${String(err)}` },
        ],
      };
    }
  }

  if (req.params.name === "wechat_send_file") {
    const { sender_id, file_path, caption } = req.params.arguments as {
      sender_id: string;
      file_path: string;
      caption?: string;
    };
    const contextToken = getCachedContextToken(sender_id);
    if (!contextToken) {
      return {
        content: [{ type: "text" as const, text: `error: no context_token for ${sender_id}` }],
      };
    }
    if (!fs.existsSync(file_path)) {
      return { content: [{ type: "text" as const, text: `error: file not found: ${file_path}` }] };
    }
    const fileSize = fs.statSync(file_path).size;
    if (fileSize > MAX_FILE_SIZE_BYTES) {
      return { content: [{ type: "text" as const, text: `error: file too large (${(fileSize / 1024 / 1024).toFixed(1)}MB, max ${MAX_FILE_SIZE_BYTES / 1024 / 1024}MB)` }] };
    }
    try {
      stopTypingAndNotify(activeAccount.baseUrl, activeAccount.token, sender_id);
      await uploadAndSendMedia(
        activeAccount.baseUrl,
        activeAccount.token,
        sender_id,
        file_path,
        contextToken,
        caption,
      );
      return { content: [{ type: "text" as const, text: `sent: ${path.basename(file_path)}` }] };
    } catch (err) {
      return {
        content: [{ type: "text" as const, text: `send file failed: ${String(err)}` }],
      };
    }
  }

  throw new Error(`unknown tool: ${req.params.name}`);
});

// ── Long-poll loop ──────────────────────────────────────────────────────────

async function startPolling(account: AccountData): Promise<never> {
  let { baseUrl, token } = account;
  let getUpdatesBuf = "";
  let consecutiveFailures = 0;

  // Load cached sync buf if available
  const syncBufFile = path.join(CREDENTIALS_DIR, "sync_buf.txt");
  try {
    getUpdatesBuf = fs.readFileSync(syncBufFile, "utf-8");
    log(`Restored previous sync state (${getUpdatesBuf.length} bytes)`);
  } catch {
    // ignore
  }

  log("Started listening for WeChat messages...");

  while (true) {
    try {
      const resp = await getUpdates(baseUrl, token, getUpdatesBuf);

      // Handle API errors
      const isError =
        (resp.ret !== undefined && resp.ret !== 0) ||
        (resp.errcode !== undefined && resp.errcode !== 0);
      if (isError) {
        const isSessionExpired =
          resp.errcode === SESSION_EXPIRED_ERRCODE || resp.ret === SESSION_EXPIRED_ERRCODE;

        if (isSessionExpired) {
          logError("Session expired (errcode -14), triggering re-login...");
          try {
            const newAccount = await doQRReLogin(account);
            account = newAccount;
            activeAccount = newAccount;
            baseUrl = newAccount.baseUrl;
            token = newAccount.token;
            getUpdatesBuf = "";
            consecutiveFailures = 0;
            log("Switched to new token, resuming polling...");
            continue;
          } catch (err) {
            logError(`Re-login failed: ${String(err)}`);
            // Remove invalid credentials so next start.sh run triggers setup.js QR login
            try { fs.unlinkSync(CREDENTIALS_FILE); log("Removed invalid credentials"); } catch {}
            process.exit(1);
          }
        }

        consecutiveFailures++;
        logError(
          `getUpdates failed: ret=${resp.ret} errcode=${resp.errcode} errmsg=${resp.errmsg ?? ""}`,
        );
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          logError(
            `${MAX_CONSECUTIVE_FAILURES} consecutive failures, backing off ${BACKOFF_DELAY_MS / 1000}s`,
          );
          consecutiveFailures = 0;
          await new Promise((r) => setTimeout(r, BACKOFF_DELAY_MS));
        } else {
          await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
        }
        continue;
      }

      consecutiveFailures = 0;

      // Save sync buf
      if (resp.get_updates_buf && resp.get_updates_buf !== getUpdatesBuf) {
        getUpdatesBuf = resp.get_updates_buf;
        try {
          fs.writeFileSync(syncBufFile, getUpdatesBuf, "utf-8");
        } catch {
          // ignore
        }
      }

      // Process messages
      for (const msg of resp.msgs ?? []) {
        // Only process user messages (not bot messages)
        if (msg.message_type !== MSG_TYPE_USER) continue;

        const content = extractContent(msg);
        if (!content) continue;

        const senderId = msg.from_user_id ?? "unknown";
        const isGroup = !!msg.group_id;
        const replyTarget = isGroup ? msg.group_id! : senderId;

        // Cache context token by reply target (group_id for groups, sender_id for DMs)
        if (msg.context_token) {
          cacheContextToken(replyTarget, msg.context_token);
        }

        const canReply = !!getCachedContextToken(replyTarget);
        const senderName = senderId.split("@")[0] || senderId;
        const meta: Record<string, string> = {
          sender: senderName,
          sender_id: replyTarget,
          can_reply: String(canReply),
          ...(isGroup ? { is_group: "true", group_id: msg.group_id!, from_sender_id: senderId } : {}),
        };

        // Fetch typing ticket + start typing keepalive
        if (canReply && activeAccount && msg.context_token) {
          fetchAndCacheTypingTicket(baseUrl, token, replyTarget, msg.context_token)
            .then(() => startTypingKeepalive(baseUrl, token, replyTarget))
            .catch(() => {});
        }

        if (content.kind === "text") {
          log(`Message received: from=${senderId}${isGroup ? ` group=${msg.group_id}` : ""} text=${content.text.slice(0, 50)}...`);
          await mcp.notification({
            method: "notifications/claude/channel",
            params: { content: content.text, meta },
          });
        } else if (content.kind === "image") {
          log(`Image received: from=${senderId}`);
          const img = await downloadWechatImage(content.imageItem);
          if (img) {
            const ext = mimeToExt(img.mimeType);
            const imgPath = path.join(MEDIA_DIR, `img_${Date.now()}.${ext}`);
            fs.writeFileSync(imgPath, img.buf);
            log(`Image saved to: ${imgPath}`);
            meta.media_type = "image";
            meta.media_path = imgPath;
            await mcp.notification({
              method: "notifications/claude/channel",
              params: { content: "[图片]", meta },
            });
          } else {
            await mcp.notification({
              method: "notifications/claude/channel",
              params: { content: "[图片-下载失败]", meta },
            });
          }
        } else if (content.kind === "file") {
          log(`File received: from=${senderId} name=${content.fileName}`);
          const filePath = await downloadWechatFile(content.fileItem, content.fileName);
          if (filePath) {
            log(`File saved to: ${filePath}`);
            meta.media_type = "file";
            meta.media_path = filePath;
            await mcp.notification({
              method: "notifications/claude/channel",
              params: { content: `[文件: ${content.fileName}]`, meta },
            });
          } else {
            await mcp.notification({
              method: "notifications/claude/channel",
              params: { content: `[文件: ${content.fileName} - 下载失败]`, meta },
            });
          }
        }
      }
    } catch (err) {
      consecutiveFailures++;
      logError(`Polling error: ${String(err)}`);
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        consecutiveFailures = 0;
        await new Promise((r) => setTimeout(r, BACKOFF_DELAY_MS));
      } else {
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
      }
    }
  }
}

// ── Main ────────────────────────────────────────────────────────────────────

let cleanupInterval: ReturnType<typeof setInterval> | null = null;

async function main() {
  // Connect MCP transport first (Claude Code expects stdio handshake)
  await mcp.connect(new StdioServerTransport());
  log("MCP connection ready");

  // Ensure data directories exist
  fs.mkdirSync(CREDENTIALS_DIR, { recursive: true });
  fs.mkdirSync(MEDIA_DIR, { recursive: true });

  // Restore persisted context tokens
  loadContextTokens();

  // Clear debug log on startup
  try { fs.writeFileSync(LOG_FILE, "", "utf-8"); } catch {}

  // Periodic cleanup: media files, stale caches
  cleanupOldMedia();
  cleanupInterval = setInterval(() => {
    cleanupOldMedia();
    pruneContextTokens();
    pruneTypingTicketCache();
    persistContextTokens();
  }, MEDIA_CLEANUP_INTERVAL_MS);

  // Check for saved credentials
  let account = loadCredentials();

  if (!account) {
    log("No saved credentials found, starting WeChat QR login...");
    account = await doQRLogin(DEFAULT_BASE_URL);
    if (!account) {
      logError("Login failed, exiting.");
      process.exit(1);
    }
  } else {
    log(`Using saved account: ${account.accountId}`);
  }

  activeAccount = account;

  // Start long-poll (runs forever)
  await startPolling(account);
}

function shutdown(): void {
  log("Shutting down, saving state...");
  if (cleanupInterval) clearInterval(cleanupInterval);
  if (persistTimer) { clearTimeout(persistTimer); persistTimer = null; }
  persistContextTokens();
  for (const userId of [...typingTimers.keys()]) {
    stopTypingKeepalive(userId);
  }
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

main().catch((err) => {
  logError(`Fatal: ${String(err)}`);
  process.exit(1);
});
