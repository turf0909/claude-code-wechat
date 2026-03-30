import os from "node:os";
import path from "node:path";

// ── Version ───────��─────────────────────────────────────────────────────────
export const CHANNEL_VERSION = "0.3.0";

// ── WeChat API ────────���─────────────────────────────────────────────────────
export const DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com";
export const BOT_TYPE = "3";
export const WECHAT_CDN_BASE = "https://novac2c.cdn.weixin.qq.com/c2c";

// ── Timeouts ────��───────────────────────────────────────────────────────────
export const LONG_POLL_TIMEOUT_MS = 35_000;
export const API_TIMEOUT_MS = 15_000;
export const CDN_DOWNLOAD_TIMEOUT_MS = 30_000;
export const CDN_DOWNLOAD_MAX_RETRIES = 2;
export const CDN_DOWNLOAD_RETRY_DELAY_MS = 1_000;
export const CDN_UPLOAD_TIMEOUT_MS = 60_000;
export const CDN_UPLOAD_MAX_RETRIES = 3;
export const CDN_UPLOAD_RETRY_DELAY_MS = 1_000;
export const QR_LOGIN_TIMEOUT_MS = 480_000;
export const QR_POLL_DELAY_MS = 1_000;

// ── Polling ──────��────────────────────────��─────────────────────────────────
export const MAX_CONSECUTIVE_FAILURES = 3;
export const BACKOFF_DELAY_MS = 30_000;
export const RETRY_DELAY_MS = 2_000;
export const SESSION_EXPIRED_ERRCODE = -14;

// ── Messages ─────────���───────────────────────────────���──────────────────────
export const MAX_MSG_LEN = 2_000;
export const SPLIT_DELAY_MS = 800;
export const MAX_FILE_SIZE_BYTES = 100 * 1024 * 1024; // 100MB

export const MSG_TYPE_USER = 1;
export const MSG_TYPE_BOT = 2;
export const MSG_STATE_FINISH = 2;
export const MSG_ITEM_TEXT = 1;
export const MSG_ITEM_IMAGE = 2;
export const MSG_ITEM_VOICE = 3;
export const MSG_ITEM_FILE = 4;
export const MSG_ITEM_LINK = 5;
export const UPLOAD_MEDIA_TYPE = { IMAGE: 1, VIDEO: 2, FILE: 3, VOICE: 4 } as const;

// ── Typing ───────────────────────────────────────────���──────────────────────
export const TYPING_KEEPALIVE_MS = 4_000;
export const TYPING_TICKET_STALE_MS = 48 * 60 * 60 * 1_000;
export const TYPING_MAX_LIFETIME_MS = 5 * 60 * 1_000;
export const CONFIG_CACHE_TTL_MS = 24 * 60 * 60 * 1_000;
export const CONFIG_CACHE_INITIAL_RETRY_MS = 2_000;
export const CONFIG_CACHE_MAX_RETRY_MS = 60 * 60 * 1_000;
export const TYPING_CONFIG_TIMEOUT_MS = 10_000;
export const TYPING_SEND_TIMEOUT_MS = 5_000;

// ── Context Token ─────────���──────────────────────────────���──────────────────
export const CONTEXT_TOKEN_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const CONTEXT_TOKEN_MAX_ENTRIES = 500;

// ── Media ────���───────────────────────────────────────��──────────────────────
export const MEDIA_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const MEDIA_CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000;

// ── QR Re-login ─────────────────────────────────────────────────────────────
export const QR_RELOGIN_MAX_ATTEMPTS = 3;

export const BASE_INFO = { channel_version: CHANNEL_VERSION } as const;

// ── Paths ───────────────────────────────────────────────────────────────────
export const CREDENTIALS_FILE = process.env.WECHAT_CREDENTIALS_FILE
  ? path.resolve(process.env.WECHAT_CREDENTIALS_FILE)
  : path.join(os.homedir(), ".claude", "channels", "wechat", "account.json");
export const CREDENTIALS_DIR = path.dirname(CREDENTIALS_FILE);
export const MEDIA_DIR = path.join(CREDENTIALS_DIR, "media");
