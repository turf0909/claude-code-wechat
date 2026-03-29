#!/usr/bin/env bun
/**
 * Claude Code WeChat Bot — Agent SDK Mode (Full-Featured)
 *
 * Uses Claude Code Agent SDK instead of MCP Channel; no OAuth login required.
 * Feature-complete with Channel mode: text/image/file send & receive, typing indicator, token re-login, log rotation, etc.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";

// ── Config ────────────────────────────────────────────────────────────────────

const CHANNEL_VERSION = "0.2.0";
const DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com";
const BOT_TYPE = "3";
const CREDENTIALS_FILE = process.env.WECHAT_CREDENTIALS_FILE
  ? path.resolve(process.env.WECHAT_CREDENTIALS_FILE)
  : path.join(os.homedir(), ".claude", "channels", "wechat", "account.json");
const CREDENTIALS_DIR = path.dirname(CREDENTIALS_FILE);
const SESSION_FILE = path.join(CREDENTIALS_DIR, "sdk_sessions.json");
const MEDIA_DIR = path.join(CREDENTIALS_DIR, "media");
const MEDIA_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const MEDIA_CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000;

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
const SLASH_CMD_TIMEOUT_MS = 30_000;
const CDN_DOWNLOAD_TIMEOUT_MS = 30_000;
const CDN_UPLOAD_TIMEOUT_MS = 60_000;
const CDN_UPLOAD_MAX_RETRIES = 3;
const CDN_UPLOAD_RETRY_DELAY_MS = 1_000;
const WECHAT_CDN_BASE = "https://novac2c.cdn.weixin.qq.com/c2c";
const QR_RELOGIN_MAX_ATTEMPTS = 3;

const DEFAULT_SDK_MODEL = process.env.ANTHROPIC_MODEL || "auto";
const userModels = new Map<string, string>();

function getUserModel(senderId: string): string {
  return userModels.get(senderId) || DEFAULT_SDK_MODEL;
}

const userThinking = new Map<string, boolean>();

function getThinkingConfig(senderId: string): { type: "disabled" } | undefined {
  return userThinking.get(senderId) ? undefined : { type: "disabled" };
}
const TYPING_KEEPALIVE_MS = 4_000;
const TYPING_TICKET_STALE_MS = 48 * 60 * 60 * 1_000;
const TYPING_MAX_LIFETIME_MS = 5 * 60 * 1_000;
const CONFIG_CACHE_TTL_MS = 24 * 60 * 60 * 1_000;
const CONFIG_CACHE_INITIAL_RETRY_MS = 2_000;
const CONFIG_CACHE_MAX_RETRY_MS = 60 * 60 * 1_000;

// ── Logging ──────────────────────────────────────────────────────────────────

const LOG_FILE = path.join(CREDENTIALS_DIR, "sdk_debug.log");
const LOG_OLD_FILE = `${LOG_FILE}.old`;
const LOG_MAX_BYTES = 10 * 1024 * 1024;
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
  process.stderr.write(`[sdk-mode] ${msg}\n`);
  appendLog(line);
}

function logError(msg: string) {
  const line = `[${new Date().toISOString()}] ERROR: ${msg}\n`;
  process.stderr.write(`[sdk-mode] ERROR: ${msg}\n`);
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

// ── Types ────────────────────────────────────────────────────────────────────

type AccountData = {
  token: string;
  baseUrl: string;
  accountId: string;
  userId?: string;
  savedAt: string;
};

interface ImageItem {
  url?: string; cdn_url?: string; aeskey?: string;
  media?: { encrypt_query_param?: string; aes_key?: string; mid_size?: number; hd_size?: number };
}
interface FileItem {
  url?: string; file_name?: string; file_size?: number; len?: string;
  media?: { encrypt_query_param?: string; aes_key?: string };
}
interface LinkItem { url?: string; title?: string; desc?: string }
interface MessageItem {
  type?: number;
  text_item?: { text?: string };
  voice_item?: { text?: string };
  image_item?: ImageItem;
  file_item?: FileItem;
  link_item?: LinkItem;
  ref_msg?: { title?: string };
}
interface WeixinMessage {
  from_user_id?: string; to_user_id?: string; group_id?: string;
  message_type?: number; message_state?: number;
  item_list?: MessageItem[];
  context_token?: string;
}
interface GetUpdatesResp {
  ret?: number; errcode?: number; errmsg?: string;
  msgs?: WeixinMessage[]; get_updates_buf?: string;
}

const MSG_TYPE_USER = 1;
const MSG_ITEM_TEXT = 1;
const MSG_ITEM_IMAGE = 2;
const MSG_ITEM_VOICE = 3;
const MSG_ITEM_FILE = 4;
const MSG_ITEM_LINK = 5;
const MSG_TYPE_BOT = 2;
const MSG_STATE_FINISH = 2;
const UPLOAD_MEDIA_TYPE = { IMAGE: 1, FILE: 3 } as const;

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
      if (ref?.title) return { kind: "text", text: `[引用: ${ref.title}]\n${text}` };
      return { kind: "text", text };
    }
    if (item.type === MSG_ITEM_VOICE && item.voice_item?.text)
      return { kind: "text", text: item.voice_item.text };
    if (item.type === MSG_ITEM_IMAGE) {
      log(`Image message raw data: ${JSON.stringify(item)}`);
      if (item.image_item) return { kind: "image", imageItem: item.image_item };
      return { kind: "text", text: "[用户发送了一张图片，但无法获取图片数据]" };
    }
    if (item.type === MSG_ITEM_FILE) {
      log(`File message raw data: ${JSON.stringify(item)}`);
      const name = item.file_item?.file_name || "未知文件";
      if (item.file_item?.media?.encrypt_query_param && item.file_item?.media?.aes_key)
        return { kind: "file", fileItem: item.file_item, fileName: name };
      return { kind: "text", text: `[用户发送了文件: ${name}，但无法获取下载参数]` };
    }
    if (item.type === MSG_ITEM_LINK) {
      const title = item.link_item?.title || "";
      const url = item.link_item?.url || "";
      return { kind: "text", text: `[分享链接: ${title} ${url}]` };
    }
    log(`Unknown message type=${item.type}, raw data: ${JSON.stringify(item)}`);
  }
  return null;
}

// ── HTTP Utilities ───────────────────────────────────────────────────────────

async function fetchWithTimeout(
  input: string | URL, init: RequestInit, timeoutMs: number,
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

function buildHeaders(token?: string, body?: string): Record<string, string> {
  const uin = Buffer.from(String(crypto.randomBytes(4).readUInt32BE(0)), "utf-8").toString("base64");
  const headers: Record<string, string> = {
    "Content-Type": "application/json", AuthorizationType: "ilink_bot_token", "X-WECHAT-UIN": uin,
  };
  if (body) headers["Content-Length"] = String(Buffer.byteLength(body, "utf-8"));
  if (token?.trim()) headers.Authorization = `Bearer ${token.trim()}`;
  return headers;
}

async function apiFetch(params: {
  baseUrl: string; endpoint: string; body: string; token?: string; timeoutMs: number;
}): Promise<string> {
  const base = params.baseUrl.endsWith("/") ? params.baseUrl : `${params.baseUrl}/`;
  const url = new URL(params.endpoint, base).toString();
  const headers = buildHeaders(params.token, params.body);
  const res = await fetchWithTimeout(url, { method: "POST", headers, body: params.body }, params.timeoutMs);
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text}`);
  let json: any;
  try { json = JSON.parse(text); } catch { return text; }
  if (json.ret && json.ret !== 0 && json.ret !== SESSION_EXPIRED_ERRCODE)
    throw new Error(`API ret=${json.ret}: ${json.errmsg ?? text}`);
  if (json.errcode && json.errcode !== 0 && json.errcode !== SESSION_EXPIRED_ERRCODE)
    throw new Error(`API errcode ${json.errcode}: ${json.errmsg ?? text}`);
  return text;
}

// ── Crypto ───────────────────────────────────────────────────────────────────

function parseAesKey(aesKeyBase64: string): Buffer {
  const decoded = Buffer.from(aesKeyBase64, "base64");
  if (decoded.length === 16) return decoded;
  if (decoded.length === 32 && /^[0-9a-fA-F]{32}$/.test(decoded.toString("ascii")))
    return Buffer.from(decoded.toString("ascii"), "hex");
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

// ── CDN Download ─────────────────────────────────────────────────────────────

async function downloadAndDecryptCdn(
  encryptQueryParam: string, aesKeyBase64: string, label: string,
): Promise<Buffer | null> {
  const cdnUrl = `${WECHAT_CDN_BASE}/download?encrypted_query_param=${encodeURIComponent(encryptQueryParam)}`;
  try {
    const key = parseAesKey(aesKeyBase64);
    const res = await fetchWithTimeout(cdnUrl, {}, CDN_DOWNLOAD_TIMEOUT_MS);
    if (!res.ok) { logError(`${label} CDN download failed: HTTP ${res.status}`); return null; }
    const encrypted = Buffer.from(await res.arrayBuffer());
    return decryptAesEcb(encrypted, key);
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
  if (!imageItem.media?.encrypt_query_param || !imageItem.media?.aes_key) return null;
  const decrypted = await downloadAndDecryptCdn(imageItem.media.encrypt_query_param, imageItem.media.aes_key, "Image");
  if (!decrypted) return null;
  return { buf: decrypted, mimeType: detectImageMimeType(decrypted) };
}

async function downloadWechatFile(fileItem: FileItem, fileName: string): Promise<string | null> {
  if (!fileItem.media?.encrypt_query_param || !fileItem.media?.aes_key) return null;
  const decrypted = await downloadAndDecryptCdn(fileItem.media.encrypt_query_param, fileItem.media.aes_key, `File(${fileName})`);
  if (!decrypted) return null;
  const safeName = path.basename(fileName).replace(/[\x00-\x1f]/g, "_") || "unnamed";
  const filePath = path.join(MEDIA_DIR, `file_${Date.now()}_${safeName}`);
  fs.writeFileSync(filePath, decrypted);
  return filePath;
}

// ── CDN Upload ───────────────────────────────────────────────────────────────

async function getUploadUrl(baseUrl: string, token: string, params: {
  filekey: string; media_type: number; to_user_id: string;
  rawsize: number; rawfilemd5: string; filesize: number; no_need_thumb: boolean; aeskey: string;
}): Promise<{ upload_param?: string }> {
  const raw = await apiFetch({
    baseUrl, endpoint: "ilink/bot/getuploadurl",
    body: JSON.stringify({ ...params, base_info: { channel_version: CHANNEL_VERSION } }), token, timeoutMs: API_TIMEOUT_MS,
  });
  return JSON.parse(raw);
}

async function uploadBufferToCdn(params: {
  buf: Buffer; uploadParam: string; filekey: string; aeskey: Buffer;
}): Promise<string> {
  const ciphertext = encryptAesEcb(params.buf, params.aeskey);
  const cdnUrl = `${WECHAT_CDN_BASE}/upload?encrypted_query_param=${encodeURIComponent(params.uploadParam)}&filekey=${encodeURIComponent(params.filekey)}`;
  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= CDN_UPLOAD_MAX_RETRIES; attempt++) {
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
      const downloadParam = res.headers.get("x-encrypted-param");
      if (!downloadParam) throw new Error("CDN missing x-encrypted-param");
      return downloadParam;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (lastError.message.includes("4xx")) throw lastError;
      if (attempt < CDN_UPLOAD_MAX_RETRIES) {
        log(`CDN upload retry ${attempt}/${CDN_UPLOAD_MAX_RETRIES}: ${lastError.message}`);
        await new Promise((r) => setTimeout(r, CDN_UPLOAD_RETRY_DELAY_MS));
      }
    }
  }
  throw lastError ?? new Error("CDN upload failed");
}

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
  const mediaType = isImage ? UPLOAD_MEDIA_TYPE.IMAGE : UPLOAD_MEDIA_TYPE.FILE;

  const uploadResp = await getUploadUrl(baseUrl, token, {
    filekey, media_type: mediaType, to_user_id: to,
    rawsize, rawfilemd5, filesize, no_need_thumb: true, aeskey: aeskey.toString("hex"),
  });
  if (!uploadResp.upload_param) throw new Error("getUploadUrl returned no upload_param");

  const downloadParam = await uploadBufferToCdn({ buf: plaintext, uploadParam: uploadResp.upload_param, filekey, aeskey });
  const aesKeyBase64 = Buffer.from(aeskey.toString("hex")).toString("base64");
  const media = { encrypt_query_param: downloadParam, aes_key: aesKeyBase64, encrypt_type: 1 };

  if (caption) await sendTextMessage(baseUrl, token, to, caption, contextToken);

  const clientId = generateClientId();
  const item = isImage
    ? { type: MSG_ITEM_IMAGE, image_item: { media, mid_size: filesize } }
    : { type: MSG_ITEM_FILE, file_item: { media, file_name: fileName, len: String(rawsize) } };

  await apiFetch({
    baseUrl, endpoint: "ilink/bot/sendmessage",
    body: JSON.stringify({
      msg: { from_user_id: "", to_user_id: to, client_id: clientId,
        message_type: MSG_TYPE_BOT, message_state: MSG_STATE_FINISH,
        item_list: [item], context_token: contextToken },
      base_info: { channel_version: CHANNEL_VERSION },
    }), token, timeoutMs: API_TIMEOUT_MS,
  });
  log(`Media sent: ${fileName}`);
}

// ── WeChat API ───────────────────────────────────────────────────────────────

function loadCredentials(): AccountData | null {
  try { return JSON.parse(fs.readFileSync(CREDENTIALS_FILE, "utf-8")); } catch { return null; }
}

function saveCredentials(data: AccountData): void {
  fs.mkdirSync(CREDENTIALS_DIR, { recursive: true });
  fs.writeFileSync(CREDENTIALS_FILE, JSON.stringify(data, null, 2), "utf-8");
  try { fs.chmodSync(CREDENTIALS_FILE, 0o600); } catch {}
}

function generateClientId(): string {
  return `sdk-mode:${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
}

async function getUpdates(baseUrl: string, token: string, buf: string): Promise<GetUpdatesResp> {
  try {
    const raw = await apiFetch({
      baseUrl, endpoint: "ilink/bot/getupdates",
      body: JSON.stringify({ get_updates_buf: buf, base_info: { channel_version: CHANNEL_VERSION } }), token, timeoutMs: LONG_POLL_TIMEOUT_MS,
    });
    return JSON.parse(raw);
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") return { ret: 0, msgs: [], get_updates_buf: buf };
    throw err;
  }
}

async function sendTextMessage(
  baseUrl: string, token: string, to: string, text: string, contextToken: string,
): Promise<void> {
  await apiFetch({
    baseUrl, endpoint: "ilink/bot/sendmessage",
    body: JSON.stringify({
      msg: { from_user_id: "", to_user_id: to, client_id: generateClientId(),
        message_type: MSG_TYPE_BOT, message_state: MSG_STATE_FINISH,
        item_list: [{ type: MSG_ITEM_TEXT, text_item: { text } }], context_token: contextToken },
      base_info: { channel_version: CHANNEL_VERSION },
    }), token, timeoutMs: API_TIMEOUT_MS,
  });
}

function splitTextIntoChunks(text: string): string[] {
  if (text.length <= MAX_MSG_LEN) return [text];
  const chunks: string[] = [];
  const paragraphs = text.split(/\n\n+/);
  let current = "";
  for (const para of paragraphs) {
    if (current && (current.length + para.length + 2) > MAX_MSG_LEN) {
      chunks.push(current.trim()); current = para;
    } else {
      current = current ? `${current}\n\n${para}` : para;
    }
    if (current.length > MAX_MSG_LEN) {
      const lines = current.split(/\n/);
      current = "";
      for (const line of lines) {
        if (current && (current.length + line.length + 1) > MAX_MSG_LEN) {
          chunks.push(current.trim()); current = line;
        } else {
          current = current ? `${current}\n${line}` : line;
        }
        while (current.length > MAX_MSG_LEN) {
          chunks.push(current.slice(0, MAX_MSG_LEN)); current = current.slice(MAX_MSG_LEN);
        }
      }
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks;
}

// ── Typing Indicator ─────────────────────────────────────────────────────────

interface TicketCacheEntry { ticket: string; nextFetchAt: number; retryDelayMs: number }
const typingTicketCache = new Map<string, TicketCacheEntry>();
const typingTimers = new Map<string, { interval: ReturnType<typeof setInterval>; safety: ReturnType<typeof setTimeout> }>();

function pruneTypingTicketCache(): void {
  const staleThreshold = Date.now() - TYPING_TICKET_STALE_MS;
  for (const [userId, entry] of typingTicketCache) {
    if (entry.nextFetchAt < staleThreshold) typingTicketCache.delete(userId);
  }
}

async function fetchAndCacheTypingTicket(
  baseUrl: string, token: string, userId: string, contextToken: string,
): Promise<string | undefined> {
  const now = Date.now();
  const entry = typingTicketCache.get(userId);
  if (entry && now < entry.nextFetchAt) return entry.ticket || undefined;
  try {
    const raw = await apiFetch({
      baseUrl, endpoint: "ilink/bot/getconfig",
      body: JSON.stringify({ ilink_user_id: userId, context_token: contextToken, base_info: { channel_version: CHANNEL_VERSION } }),
      token, timeoutMs: 10_000,
    });
    const resp = JSON.parse(raw);
    if (resp.typing_ticket) {
      typingTicketCache.set(userId, {
        ticket: resp.typing_ticket,
        nextFetchAt: now + CONFIG_CACHE_TTL_MS * (0.5 + Math.random() * 0.5),
        retryDelayMs: CONFIG_CACHE_INITIAL_RETRY_MS,
      });
      return resp.typing_ticket;
    }
  } catch {}
  const prevDelay = entry?.retryDelayMs ?? CONFIG_CACHE_INITIAL_RETRY_MS;
  const nextDelay = Math.min(prevDelay * 2, CONFIG_CACHE_MAX_RETRY_MS);
  if (entry) { entry.nextFetchAt = now + nextDelay; entry.retryDelayMs = nextDelay; }
  else typingTicketCache.set(userId, { ticket: "", nextFetchAt: now + CONFIG_CACHE_INITIAL_RETRY_MS, retryDelayMs: CONFIG_CACHE_INITIAL_RETRY_MS });
  return entry?.ticket || undefined;
}

async function sendTypingIndicator(baseUrl: string, token: string, userId: string, status: 1 | 2 = 1): Promise<void> {
  const entry = typingTicketCache.get(userId);
  if (!entry?.ticket) return;
  try {
    await apiFetch({
      baseUrl, endpoint: "ilink/bot/sendtyping",
      body: JSON.stringify({ ilink_user_id: userId, typing_ticket: entry.ticket, status, base_info: { channel_version: CHANNEL_VERSION } }),
      token, timeoutMs: 5_000,
    });
  } catch {}
}

function startTypingKeepalive(baseUrl: string, token: string, userId: string): void {
  stopTypingKeepalive(userId);
  sendTypingIndicator(baseUrl, token, userId).catch(() => {});
  const interval = setInterval(() => { sendTypingIndicator(baseUrl, token, userId).catch(() => {}); }, TYPING_KEEPALIVE_MS);
  const safety = setTimeout(() => stopTypingKeepalive(userId), TYPING_MAX_LIFETIME_MS);
  typingTimers.set(userId, { interval, safety });
}

function stopTypingKeepalive(userId: string): void {
  const entry = typingTimers.get(userId);
  if (entry) { clearInterval(entry.interval); clearTimeout(entry.safety); typingTimers.delete(userId); }
}

function stopTypingAndNotify(baseUrl: string, token: string, userId: string): void {
  stopTypingKeepalive(userId);
  sendTypingIndicator(baseUrl, token, userId, 2).catch(() => {});
}

// ── QR Login & Re-Login ──────────────────────────────────────────────────────

async function doQRLogin(baseUrl: string = DEFAULT_BASE_URL): Promise<AccountData | null> {
  log("Fetching WeChat login QR code...");
  const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  const qrRes = await fetchWithTimeout(new URL(`ilink/bot/get_bot_qrcode?bot_type=${BOT_TYPE}`, base).toString(), {}, API_TIMEOUT_MS);
  if (!qrRes.ok) throw new Error(`QR fetch failed: ${qrRes.status}`);
  const qrResp = await qrRes.json() as { qrcode: string; qrcode_img_content: string };
  log(`QR code link: ${qrResp.qrcode_img_content}`);
  try {
    const qrterm = await import("qrcode-terminal");
    await new Promise<void>((r) => { qrterm.default.generate(qrResp.qrcode_img_content, {}, (qr: string) => { process.stderr.write(qr + "\n"); r(); }); });
  } catch {}

  const deadline = Date.now() + QR_LOGIN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const res = await fetchWithTimeout(
        new URL(`ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrResp.qrcode)}`, base).toString(),
        { headers: { "iLink-App-ClientVersion": "1" } }, LONG_POLL_TIMEOUT_MS,
      );
      const status = await res.json() as any;
      if (status.status === "confirmed" && status.bot_token && status.ilink_bot_id) {
        const account: AccountData = {
          token: status.bot_token, baseUrl: status.baseurl || baseUrl,
          accountId: status.ilink_bot_id, userId: status.ilink_user_id, savedAt: new Date().toISOString(),
        };
        saveCredentials(account);
        log(`WeChat connected: ${account.accountId}`);
        return account;
      }
      if (status.status === "expired") { log("QR code expired"); return null; }
    } catch (err) {
      if (!(err instanceof Error && err.name === "AbortError")) throw err;
    }
    await new Promise((r) => setTimeout(r, QR_POLL_DELAY_MS));
  }
  log("Login timed out");
  return null;
}

async function doQRReLogin(oldAccount: AccountData): Promise<AccountData> {
  log("Token expired, starting re-login...");
  for (let attempt = 1; attempt <= QR_RELOGIN_MAX_ATTEMPTS; attempt++) {
    log(`Re-login attempt (${attempt}/${QR_RELOGIN_MAX_ATTEMPTS})...`);
    const account = await doQRLogin(oldAccount.baseUrl);
    if (account) return account;
  }
  throw new Error(`Re-login failed: ${QR_RELOGIN_MAX_ATTEMPTS} attempts exhausted, QR code not scanned`);
}

// ── Session & Context Token Management ───────────────────────────────────────

const MAX_USER_SESSIONS = 500;
const userSessions = new Map<string, string>();

function loadSessions(): void {
  try {
    const data = JSON.parse(fs.readFileSync(SESSION_FILE, "utf-8"));
    for (const [k, v] of Object.entries(data)) { if (typeof v === "string") userSessions.set(k, v); }
    // Cap: drop oldest if over limit (Map preserves insertion order)
    while (userSessions.size > MAX_USER_SESSIONS) {
      const first = userSessions.keys().next().value;
      if (first !== undefined) userSessions.delete(first); else break;
    }
    log(`Restored ${userSessions.size} SDK sessions`);
  } catch (err) { if (fs.existsSync(SESSION_FILE)) logError(`Failed to load sessions: ${String(err)}`); }
}

function saveSessions(): void {
  try { fs.writeFileSync(SESSION_FILE, JSON.stringify(Object.fromEntries(userSessions), null, 2), "utf-8"); } catch {}
}

// ── Context Token Cache (persistent + TTL) ───────────────────────────────────

const CONTEXT_TOKEN_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const CONTEXT_TOKEN_MAX_ENTRIES = 500;
const CONTEXT_TOKEN_FILE = path.join(CREDENTIALS_DIR, "context_tokens.json");

interface ContextTokenEntry { token: string; updatedAt: number }
const contextTokens = new Map<string, ContextTokenEntry>();
let ctPersistTimer: ReturnType<typeof setTimeout> | null = null;

function pruneContextTokens(): void {
  const now = Date.now();
  for (const [k, v] of contextTokens) {
    if (now - v.updatedAt > CONTEXT_TOKEN_MAX_AGE_MS) contextTokens.delete(k);
  }
  if (contextTokens.size > CONTEXT_TOKEN_MAX_ENTRIES) {
    const sorted = [...contextTokens.entries()].sort((a, b) => a[1].updatedAt - b[1].updatedAt);
    const toDrop = sorted.length - CONTEXT_TOKEN_MAX_ENTRIES;
    for (let i = 0; i < toDrop; i++) contextTokens.delete(sorted[i][0]);
  }
}

function loadContextTokens(): void {
  try {
    const data = JSON.parse(fs.readFileSync(CONTEXT_TOKEN_FILE, "utf-8"));
    const now = Date.now();
    for (const [k, v] of Object.entries(data)) {
      if (typeof v === "string") { contextTokens.set(k, { token: v, updatedAt: now }); }
      else if (v && typeof v === "object" && "token" in (v as any)) { contextTokens.set(k, v as ContextTokenEntry); }
    }
    pruneContextTokens();
    log(`Restored ${contextTokens.size} context tokens`);
  } catch (err) { if (fs.existsSync(CONTEXT_TOKEN_FILE)) logError(`Failed to load context tokens: ${String(err)}`); }
}

function persistContextTokens(): void {
  try { fs.writeFileSync(CONTEXT_TOKEN_FILE, JSON.stringify(Object.fromEntries(contextTokens), null, 2), "utf-8"); } catch {}
}

function schedulePersistContextTokens(): void {
  if (ctPersistTimer) return;
  ctPersistTimer = setTimeout(() => { ctPersistTimer = null; persistContextTokens(); }, 5_000);
}

function cacheContextToken(key: string, token: string): void {
  contextTokens.set(key, { token, updatedAt: Date.now() });
  schedulePersistContextTokens();
}

function getCachedContextToken(key: string): string | undefined {
  return contextTokens.get(key)?.token;
}

// ── Session History ──────────────────────────────────────────────────────────

interface SessionInfo { id: string; slug: string; firstMessage: string; timestamp: string }

function getProjectSessionDir(): string {
  return path.join(os.homedir(), ".claude", "projects", process.cwd().replace(/\//g, "-"));
}

function listAllSessions(): SessionInfo[] {
  const dir = getProjectSessionDir();
  const results: SessionInfo[] = [];
  try {
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith(".jsonl")) continue;
      const id = file.replace(".jsonl", "");
      const filePath = path.join(dir, file);
      let slug = "", firstMessage = "", timestamp = "";
      try {
        const content = fs.readFileSync(filePath, "utf-8");
        const slugMatch = content.match(/"slug":"([^"]*)"/);
        if (slugMatch) slug = slugMatch[1];
        for (const line of content.split("\n")) {
          if (!line.includes('"type":"user"')) continue;
          try {
            const d = JSON.parse(line);
            if (!timestamp && d.timestamp) timestamp = d.timestamp;
            const c = d.message?.content;
            if (typeof c === "string") {
              const ch = c.match(/<channel[^>]*>\n?([\s\S]*?)\n?<\/channel>/);
              if (ch) { firstMessage = ch[1].trim().slice(0, 40); break; }
              if (!c.startsWith("<")) { firstMessage = c.slice(0, 40); break; }
            }
            if (Array.isArray(c)) {
              for (const b of c) { if (b?.type === "text" && b.text && !b.text.startsWith("<")) { firstMessage = b.text.slice(0, 40); break; } }
              if (firstMessage) break;
            }
          } catch {}
        }
      } catch {}
      if (timestamp) results.push({ id, slug, firstMessage, timestamp });
    }
  } catch {}
  results.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  return results;
}

// ── Slash Commands ───────────────────────────────────────────────────────────

async function handleSlashCommand(
  account: AccountData, senderId: string, cmd: string, contextToken: string,
): Promise<boolean> {
  const trimmed = cmd.trim();
  const lower = trimmed.toLowerCase();

  if (lower === "/new") {
    userAbortControllers.get(senderId)?.abort();
    userAbortControllers.delete(senderId);
    userQueues.delete(senderId);
    userSessions.delete(senderId);
    saveSessions();
    await sendTextMessage(account.baseUrl, account.token, senderId, "已开始新对话。旧对话可通过 /resume 恢复。", contextToken);
    return true;
  }

  if (lower === "/clear") {
    const sessionId = userSessions.get(senderId);
    if (!sessionId) {
      await sendTextMessage(account.baseUrl, account.token, senderId, "当前没有活跃的对话，无需清除。", contextToken);
      return true;
    }
    try {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), SLASH_CMD_TIMEOUT_MS);
      try {
        for await (const m of query({ prompt: "/clear", options: { model: getUserModel(senderId), resume: sessionId, permissionMode: "bypassPermissions", maxTurns: 1, thinking: getThinkingConfig(senderId), abortController: ac } })) {}
      } finally { clearTimeout(timer); }
      await sendTextMessage(account.baseUrl, account.token, senderId, "已清除对话上下文。", contextToken);
    } catch {
      await sendTextMessage(account.baseUrl, account.token, senderId, "清除上下文失败，请重试。", contextToken);
    }
    return true;
  }

  if (lower === "/stop") {
    const controller = userAbortControllers.get(senderId);
    if (controller) {
      controller.abort();
      userAbortControllers.delete(senderId);
      const queued = userQueues.get(senderId)?.length || 0;
      const msg = queued ? `已中止当前任务。还有 ${queued} 条排队消息待处理。` : "已中止当前任务。";
      await sendTextMessage(account.baseUrl, account.token, senderId, msg, contextToken);
    } else {
      await sendTextMessage(account.baseUrl, account.token, senderId, "当前没有正在执行的任务。", contextToken);
    }
    return true;
  }

  if (lower === "/cancel") {
    const controller = userAbortControllers.get(senderId);
    const queued = userQueues.get(senderId)?.length || 0;
    if (!controller && !queued) {
      await sendTextMessage(account.baseUrl, account.token, senderId, "当前没有正在执行或排队的任务。", contextToken);
      return true;
    }
    if (controller) { controller.abort(); userAbortControllers.delete(senderId); }
    userQueues.delete(senderId);
    const parts = [controller ? "已中止当前任务" : null, queued ? `已清空 ${queued} 条排队消息` : null].filter(Boolean);
    await sendTextMessage(account.baseUrl, account.token, senderId, `${parts.join("，")}。`, contextToken);
    return true;
  }

  if (lower === "/compact") {
    const sessionId = userSessions.get(senderId);
    if (!sessionId) {
      await sendTextMessage(account.baseUrl, account.token, senderId, "当前没有活跃的对话。", contextToken);
      return true;
    }
    await sendTextMessage(account.baseUrl, account.token, senderId, "正在压缩对话上下文...", contextToken);
    try {
      let result = "";
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), SLASH_CMD_TIMEOUT_MS);
      try {
        for await (const m of query({ prompt: "/compact", options: { model: getUserModel(senderId), resume: sessionId, permissionMode: "bypassPermissions", maxTurns: 1, thinking: getThinkingConfig(senderId), abortController: ac } })) {
          if ((m as any).type === "result") result = (m as any).result || "";
        }
      } finally { clearTimeout(timer); }
      await sendTextMessage(account.baseUrl, account.token, senderId, result || "对话已压缩。", contextToken);
    } catch (err) {
      await sendTextMessage(account.baseUrl, account.token, senderId, `压缩失败: ${String(err)}`, contextToken);
    }
    return true;
  }

  if (lower.startsWith("/resume")) {
    const arg = trimmed.slice(7).trim();
    if (!arg) {
      const sessions = listAllSessions();
      const currentId = userSessions.get(senderId);
      if (!sessions.length) { await sendTextMessage(account.baseUrl, account.token, senderId, "没有历史对话记录。", contextToken); return true; }
      const lines = sessions.slice(0, 10).map((s, i) => {
        const date = s.timestamp.slice(0, 16).replace("T", " ");
        const title = s.firstMessage || s.slug || "(无标题)";
        const current = s.id === currentId ? " [当前]" : "";
        return `${i + 1}. ${date}\n   ${title}${current}\n   /resume ${s.id.slice(0, 8)}`;
      });
      await sendTextMessage(account.baseUrl, account.token, senderId, `历史对话 (最近 ${Math.min(sessions.length, 10)} 个):\n\n${lines.join("\n\n")}`, contextToken);
      return true;
    }
    const match = listAllSessions().find((s) => s.id.startsWith(arg));
    if (!match) { await sendTextMessage(account.baseUrl, account.token, senderId, `未找到: ${arg}`, contextToken); return true; }
    userSessions.set(senderId, match.id);
    saveSessions();
    await sendTextMessage(account.baseUrl, account.token, senderId, `已恢复对话: ${match.firstMessage || match.slug || "(无标题)"}\n\n继续发消息即可。`, contextToken);
    return true;
  }

  if (lower.startsWith("/model")) {
    const arg = trimmed.slice(6).trim();
    if (!arg) {
      const current = getUserModel(senderId);
      await sendTextMessage(account.baseUrl, account.token, senderId,
        `当前模型: ${current}\n\n用法: /model <模型名>\n例如: /model auto\n      /model glm-5\n\n输入 /model default 恢复默认`, contextToken);
      return true;
    }
    const targetModel = arg === "default" ? DEFAULT_SDK_MODEL : arg;
    await sendTextMessage(account.baseUrl, account.token, senderId, `正在验证模型 ${targetModel}...`, contextToken);
    try {
      let verified = false;
      let modelUsed = "";
      let resultMsg = "";

      const MODEL_VERIFY_TIMEOUT_MS = 30_000;
      const ac = new AbortController();
      const verifyResult = await Promise.race([
        (async () => {
          for await (const m of query({
            prompt: "回复一个字：好",
            options: { model: targetModel, permissionMode: "bypassPermissions", maxTurns: 1, thinking: getThinkingConfig(senderId), abortController: ac },
          })) {
            const msg = m as any;
            if (msg.type === "assistant" && msg.message?.model) modelUsed = msg.message.model;
            if (msg.type === "result") {
              if (msg.subtype === "success" && !msg.is_error) verified = true;
              else resultMsg = msg.result || msg.error || "";
            }
          }
          return "done" as const;
        })(),
        new Promise<"timeout">((r) => setTimeout(() => { ac.abort(); r("timeout"); }, MODEL_VERIFY_TIMEOUT_MS)),
      ]);

      if (verifyResult === "timeout") {
        await sendTextMessage(account.baseUrl, account.token, senderId,
          `模型验证超时（${MODEL_VERIFY_TIMEOUT_MS / 1000}s）: ${targetModel} 可能不可用\n\n保持当前模型: ${getUserModel(senderId)}`, contextToken);
      } else if (verified) {
        if (arg === "default") { userModels.delete(senderId); } else { userModels.set(senderId, arg); }
        const info = modelUsed && modelUsed !== targetModel ? `${targetModel} (实际: ${modelUsed})` : targetModel;
        await sendTextMessage(account.baseUrl, account.token, senderId, `模型已切换为: ${info}\n\n如遇到兼容问题，发 /new 开始新对话后重试。`, contextToken);
      } else {
        const detail = resultMsg ? `\n${resultMsg.slice(0, 150)}` : "";
        await sendTextMessage(account.baseUrl, account.token, senderId, `模型验证失败: ${targetModel} 不可用${detail}\n\n保持当前模型: ${getUserModel(senderId)}`, contextToken);
      }
    } catch (err) {
      const errMsg = String(err).slice(0, 100);
      await sendTextMessage(account.baseUrl, account.token, senderId, `模型不可用: ${targetModel}\n${errMsg}\n\n保持当前模型: ${getUserModel(senderId)}`, contextToken);
    }
    log(`Model switched: user=${senderId} model=${getUserModel(senderId)}`);
    return true;
  }

  if (lower.startsWith("/thinking")) {
    const arg = trimmed.slice(9).trim().toLowerCase();
    if (!arg) {
      const status = userThinking.get(senderId) ? "开启" : "关闭";
      await sendTextMessage(account.baseUrl, account.token, senderId,
        `Thinking 模式: ${status}\n\n用法: /thinking on | off\n注意: 部分模型不支持 thinking，开启后若报错请发 /thinking off 关闭`, contextToken);
      return true;
    }
    if (arg === "on") {
      userThinking.set(senderId, true);
      await sendTextMessage(account.baseUrl, account.token, senderId, "已开启 Thinking 模式。如模型不支持导致报错，发 /thinking off 关闭。", contextToken);
    } else if (arg === "off") {
      userThinking.delete(senderId);
      await sendTextMessage(account.baseUrl, account.token, senderId, "已关闭 Thinking 模式。", contextToken);
    } else {
      await sendTextMessage(account.baseUrl, account.token, senderId, "用法: /thinking on | off", contextToken);
    }
    return true;
  }

  if (lower === "/status") {
    const model = getUserModel(senderId);
    const thinking = userThinking.get(senderId) ? "开启" : "关闭";
    const sessionId = userSessions.get(senderId);
    const session = sessionId ? `${sessionId.slice(0, 8)}...` : "无";
    const queued = userQueues.get(senderId)?.length || 0;
    const processing = processingUsers.has(senderId);
    const lines = [
      `当前状态:`,
      `模型: ${model}`,
      `Thinking: ${thinking}`,
      `Session: ${session}`,
      `任务: ${processing ? "处理中" : "空闲"}${queued ? ` (${queued} 条排队)` : ""}`,
      `版本: ${CHANNEL_VERSION}`,
    ];
    await sendTextMessage(account.baseUrl, account.token, senderId, lines.join("\n"), contextToken);
    return true;
  }

  if (lower === "/help") {
    await sendTextMessage(account.baseUrl, account.token, senderId,
      "可用命令:\n/new - 开始新对话（旧对话保留，可 /resume）\n/clear - 清除当前对话上下文（保留 session）\n/stop - 中止当前任务\n/cancel - 中止当前任务并清空排队消息\n/model - 查看/切换模型\n/thinking - 查看/切换 Thinking 模式（默认关闭）\n/status - 查看当前状态\n/resume - 查看历史对话列表\n/resume <id> - 恢复指定对话\n/compact - 压缩当前对话上下文\n/help - 显示此帮助", contextToken);
    return true;
  }

  if (/^\/\w+$/.test(trimmed)) {
    await sendTextMessage(account.baseUrl, account.token, senderId, `未知命令: ${trimmed}\n输入 /help 查看可用命令`, contextToken);
    return true;
  }

  return false;
}

// ── Per-User Message Queue ───────────────────────────────────────────────────

interface QueuedMessage { content: ExtractedContent; contextToken: string }
const userQueues = new Map<string, QueuedMessage[]>();
const processingUsers = new Set<string>();
const userAbortControllers = new Map<string, AbortController>();

async function processQueue(account: AccountData, senderId: string): Promise<void> {
  if (processingUsers.has(senderId)) return;
  processingUsers.add(senderId);
  try {
    while (true) {
      const queue = userQueues.get(senderId);
      if (!queue?.length) break;
      const msg = queue.shift()!;
      await processOneMessage(account, senderId, msg.content, msg.contextToken);
    }
  } finally {
    processingUsers.delete(senderId);
    userQueues.delete(senderId);
  }
}

// ── Message Handler (SDK query) ──────────────────────────────────────────────

async function handleMessage(
  account: AccountData, senderId: string, content: ExtractedContent, contextToken: string,
): Promise<void> {
  if (content?.kind === "text" && content.text.startsWith("/")) {
    const handled = await handleSlashCommand(account, senderId, content.text, contextToken);
    if (handled) return;
  }

  let queue = userQueues.get(senderId);
  if (!queue) { queue = []; userQueues.set(senderId, queue); }
  queue.push({ content, contextToken });

  // If already processing, notify user that the message is queued
  if (processingUsers.has(senderId)) {
    try {
      await sendTextMessage(account.baseUrl, account.token, senderId, "消息已收到，前一条正在处理中，请稍候。", contextToken);
    } catch {}
  }

  processQueue(account, senderId).catch((err) => logError(`Queue processing error: ${String(err)}`));
}

async function processOneMessage(
  account: AccountData, senderId: string, content: ExtractedContent, contextToken: string,
): Promise<void> {
  if (!content) return;
  const { baseUrl, token } = account;

  try {
    fetchAndCacheTypingTicket(baseUrl, token, senderId, contextToken)
      .then(() => startTypingKeepalive(baseUrl, token, senderId))
      .catch(() => {});

    await sendTextMessage(baseUrl, token, senderId, "正在处理...", contextToken);

    let prompt: string;
    if (content.kind === "text") {
      prompt = content.text;
    } else if (content.kind === "image") {
      const img = await downloadWechatImage(content.imageItem);
      if (img) {
        const ext = mimeToExt(img.mimeType);
        const imgPath = path.join(MEDIA_DIR, `img_${Date.now()}.${ext}`);
        fs.writeFileSync(imgPath, img.buf);
        prompt = `用户发了一张图片，已保存到 ${imgPath}，请用 Read 工具查看并分析。`;
      } else {
        prompt = "用户发了一张图片，但下载失败了。";
      }
    } else {
      const filePath = await downloadWechatFile(content.fileItem, content.fileName);
      if (filePath) {
        prompt = `用户发了文件 "${content.fileName}"，已保存到 ${filePath}，请用 Read 工具查看。`;
      } else {
        prompt = `用户发了文件 "${content.fileName}"，但下载失败了。`;
      }
    }

    const sessionId = userSessions.get(senderId);
    let result = "";
    let newSessionId: string | undefined;

    const toolsScript = path.join(path.dirname(new URL(import.meta.url).pathname), "wechat-tools.ts");
    const abortController = new AbortController();
    userAbortControllers.set(senderId, abortController);

    log(`SDK query: user=${senderId} session=${sessionId ?? "new"} prompt=${prompt.slice(0, 50)}...`);

    for await (const message of query({
      prompt,
      options: {
        model: getUserModel(senderId),
        resume: sessionId,
        permissionMode: "bypassPermissions",
        abortController,
        maxTurns: 10,
        systemPrompt: [
          "Messages are from real WeChat users via the WeChat ClawBot interface.",
          "IMPORTANT: The user is on WeChat and cannot see terminal output. Your text result will be automatically sent to the user.",
          "Even if you encounter errors or cannot process the request, you MUST still return a helpful text response. NEVER leave the user without a reply.",
          "Respond naturally in Chinese unless the user writes in another language.",
          "Keep replies concise — WeChat is a chat app, not an essay platform.",
          "Strip markdown formatting (WeChat doesn't render it). Use plain text.",
          "When media_path is mentioned in the prompt, the file has been downloaded locally — you can Read it.",
          "",
          "INTERACTION PATTERN for complex requests:",
          "1. When a request requires tool calls, FIRST call wechat_thinking with a short status (e.g. '正在阅读文件...'). This shows a status message to the user.",
          "2. Perform the tool calls (Read, Bash, Glob, etc.).",
          "3. If you need more tool calls, call wechat_thinking again to update status (e.g. '正在分析结果...').",
          "4. Return the final answer as plain text. The system will send it to WeChat automatically.",
          "NOTE: The WeChat ilink bot API does not support in-place message updates. Thinking and reply are separate messages.",
          "",
          "FILE SENDING:",
          "To send images or files to the user, use the wechat_send_file tool with an absolute file path.",
          "NEVER generate download links or use built-in file upload. ALWAYS use wechat_send_file for native WeChat delivery.",
        ].join("\n"),
        thinking: getThinkingConfig(senderId),
        mcpServers: {
          "wechat-tools": {
            command: "npx",
            args: ["tsx", toolsScript],
            env: {
              WECHAT_SENDER_ID: senderId,
              WECHAT_CONTEXT_TOKEN: contextToken,
              ...(process.env.WECHAT_CREDENTIALS_FILE ? { WECHAT_CREDENTIALS_FILE: process.env.WECHAT_CREDENTIALS_FILE } : {}),
            },
          },
        },
      },
    })) {
      const m = message as any;
      if (m.type === "system" && m.subtype === "init") newSessionId = m.session_id;
      if (m.type === "result") {
        if (m.subtype === "success" && !m.is_error) {
          result = m.result || "";
        } else {
          result = m.result || m.error || "处理失败，请重试";
        }
      }
    }

    userAbortControllers.delete(senderId);

    if (newSessionId) { userSessions.set(senderId, newSessionId); saveSessions(); }

    stopTypingAndNotify(baseUrl, token, senderId);

    if (!result.trim()) result = "（无回复内容）";

    const chunks = splitTextIntoChunks(result);
    for (let i = 0; i < chunks.length; i++) {
      if (i > 0) await new Promise((r) => setTimeout(r, SPLIT_DELAY_MS));
      await sendTextMessage(baseUrl, token, senderId, chunks[i], contextToken);
    }
    log(`Reply sent: user=${senderId} length=${result.length}`);
  } catch (err) {
    userAbortControllers.delete(senderId);
    stopTypingAndNotify(baseUrl, token, senderId);
    if (abortController.signal.aborted) {
      log(`Task aborted: user=${senderId}`);
      return;
    }
    logError(`Processing failed: user=${senderId} ${String(err)}`);
    try { await sendTextMessage(baseUrl, token, senderId, `处理出错: ${String(err)}`, contextToken); } catch {}
  }
}

// ── Polling Loop ─────────────────────────────────────────────────────────────

async function startPolling(account: AccountData): Promise<never> {
  let { baseUrl, token } = account;
  let getUpdatesBuf = "";
  let consecutiveFailures = 0;
  const syncBufFile = path.join(CREDENTIALS_DIR, "sync_buf.txt");
  try { getUpdatesBuf = fs.readFileSync(syncBufFile, "utf-8"); log(`Restored sync state`); } catch {}

  log("Listening for WeChat messages (SDK mode)...");

  while (true) {
    try {
      const resp = await getUpdates(baseUrl, token, getUpdatesBuf);
      const isError = (resp.ret !== undefined && resp.ret !== 0) || (resp.errcode !== undefined && resp.errcode !== 0);

      if (isError) {
        if (resp.errcode === SESSION_EXPIRED_ERRCODE || resp.ret === SESSION_EXPIRED_ERRCODE) {
          logError("Session expired, triggering re-login...");
          try {
            const newAccount = await doQRReLogin(account);
            account = newAccount;
            baseUrl = newAccount.baseUrl;
            token = newAccount.token;
            getUpdatesBuf = "";
            consecutiveFailures = 0;
            continue;
          } catch (err) {
            logError(`Re-login failed: ${String(err)}`);
            try { fs.unlinkSync(CREDENTIALS_FILE); } catch {}
            process.exit(1);
          }
        }
        consecutiveFailures++;
        logError(`getUpdates failed: ret=${resp.ret} errcode=${resp.errcode}`);
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          consecutiveFailures = 0;
          await new Promise((r) => setTimeout(r, BACKOFF_DELAY_MS));
        } else {
          await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
        }
        continue;
      }

      consecutiveFailures = 0;
      if (resp.get_updates_buf && resp.get_updates_buf !== getUpdatesBuf) {
        getUpdatesBuf = resp.get_updates_buf;
        try { fs.writeFileSync(syncBufFile, getUpdatesBuf, "utf-8"); } catch {}
      }

      for (const msg of resp.msgs ?? []) {
        if (msg.message_type !== MSG_TYPE_USER) continue;
        const content = extractContent(msg);
        if (!content) continue;

        const senderId = msg.from_user_id ?? "unknown";
        const isGroup = !!msg.group_id;
        const replyTarget = isGroup ? msg.group_id! : senderId;

        if (msg.context_token) cacheContextToken(replyTarget, msg.context_token);
        const ct = getCachedContextToken(replyTarget);
        if (!ct) { log(`Skipping message (no context_token): ${senderId}`); continue; }

        log(`Message received: from=${senderId} kind=${content.kind}${content.kind === "text" ? ` text=${content.text.slice(0, 50)}` : ""}...`);
        handleMessage(account, replyTarget, content, ct).catch((err) => logError(`handleMessage error: ${String(err)}`));
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

// ── Main ─────────────────────────────────────────────────────────────────────

let cleanupInterval: ReturnType<typeof setInterval> | null = null;

async function main() {
  fs.mkdirSync(CREDENTIALS_DIR, { recursive: true });
  fs.mkdirSync(MEDIA_DIR, { recursive: true });
  loadSessions();
  loadContextTokens();
  try { fs.writeFileSync(LOG_FILE, "", "utf-8"); } catch {}

  cleanupOldMedia();
  cleanupInterval = setInterval(() => {
    cleanupOldMedia();
    pruneContextTokens();
    pruneTypingTicketCache();
    persistContextTokens();
  }, MEDIA_CLEANUP_INTERVAL_MS);

  let account = loadCredentials();
  if (!account) {
    account = await doQRLogin();
    if (!account) { logError("Login failed, exiting"); process.exit(1); }
  } else {
    log(`Using saved account: ${account.accountId}`);
  }

  await startPolling(account);
}

function shutdown(): void {
  log("Shutting down...");
  if (cleanupInterval) clearInterval(cleanupInterval);
  if (ctPersistTimer) { clearTimeout(ctPersistTimer); ctPersistTimer = null; }
  saveSessions();
  persistContextTokens();
  for (const userId of [...typingTimers.keys()]) stopTypingKeepalive(userId);
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
main().catch((err) => { logError(`Fatal: ${String(err)}`); process.exit(1); });
