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

import fs from "node:fs";
import path from "node:path";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

// ── Shared imports ──────────────────────────────────────────────────────────

import {
  CHANNEL_VERSION, DEFAULT_BASE_URL,
  CREDENTIALS_FILE, CREDENTIALS_DIR, MEDIA_DIR,
  MAX_CONSECUTIVE_FAILURES, BACKOFF_DELAY_MS, RETRY_DELAY_MS,
  SESSION_EXPIRED_ERRCODE,
  MSG_TYPE_USER, SPLIT_DELAY_MS, MAX_FILE_SIZE_BYTES,
  MEDIA_CLEANUP_INTERVAL_MS,
} from "../shared/config.ts";
import type { AccountData } from "../shared/types.ts";
import { initLogger, log, logError, clearLogFile } from "../shared/logger.ts";
import { extractContent, splitTextIntoChunks, sendTextMessage, getUpdates } from "../shared/message.ts";
import { downloadWechatImage, mimeToExt, downloadWechatFile, uploadAndSendMedia } from "../shared/cdn.ts";
import {
  fetchAndCacheTypingTicket, startTypingKeepalive,
  stopTypingAndNotify, stopAllTyping,
  pruneTypingTicketCache,
} from "../shared/typing.ts";
import {
  initContextTokenStore, loadContextTokens, persistContextTokens,
  pruneContextTokens, cacheContextToken, getCachedContextToken,
  clearPersistTimer,
} from "../shared/context-token.ts";
import { loadCredentials } from "../shared/credentials.ts";
import { doQRLogin, doQRReLogin, type QRNotifyCallback } from "../shared/qr-login.ts";
import { cleanupOldMedia } from "../shared/media.ts";

// ── Channel-specific constants ──────────────────────────────────────────────

const CHANNEL_NAME = "wechat";

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

// ── MCP notification helper for QR login/re-login ───────────────────────────

const qrNotify: QRNotifyCallback = async (message) => {
  await mcp.notification({
    method: "notifications/claude/channel",
    params: { content: message, meta: { sender: "system", sender_id: "system" } },
  });
};

// ── Tool handlers ───────────────────────────────────────────────────────────

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
      const sendTextFn = async (text: string) => {
        await sendTextMessage(activeAccount!.baseUrl, activeAccount!.token, sender_id, text, contextToken);
      };
      await uploadAndSendMedia(activeAccount.baseUrl, activeAccount.token, sender_id, file_path, contextToken, sendTextFn, caption);
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

      const isError =
        (resp.ret !== undefined && resp.ret !== 0) ||
        (resp.errcode !== undefined && resp.errcode !== 0);
      if (isError) {
        const isSessionExpired =
          resp.errcode === SESSION_EXPIRED_ERRCODE || resp.ret === SESSION_EXPIRED_ERRCODE;

        if (isSessionExpired) {
          logError("Session expired (errcode -14), triggering re-login...");
          try {
            const newAccount = await doQRReLogin(account, qrNotify);
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
            // Remove invalid credentials so next startup triggers setup.js QR login
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

      if (resp.get_updates_buf && resp.get_updates_buf !== getUpdatesBuf) {
        getUpdatesBuf = resp.get_updates_buf;
        try {
          fs.writeFileSync(syncBufFile, getUpdatesBuf, "utf-8");
        } catch {
          // ignore
        }
      }

      for (const msg of resp.msgs ?? []) {
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
          const metaCopy = { ...meta };
          (async () => {
            const img = await downloadWechatImage(content.imageItem);
            if (img) {
              const ext = mimeToExt(img.mimeType);
              const imgPath = path.join(MEDIA_DIR, `img_${Date.now()}.${ext}`);
              fs.writeFileSync(imgPath, img.buf);
              log(`Image saved to: ${imgPath}`);
              metaCopy.media_type = "image";
              metaCopy.media_path = imgPath;
              await mcp.notification({
                method: "notifications/claude/channel",
                params: { content: "[图片]", meta: metaCopy },
              });
            } else {
              await mcp.notification({
                method: "notifications/claude/channel",
                params: { content: "[图片-下载失败]", meta: metaCopy },
              });
            }
          })().catch((err) => logError(`Image processing error: ${String(err)}`));
        } else if (content.kind === "file") {
          log(`File received: from=${senderId} name=${content.fileName}`);
          const metaCopy = { ...meta };
          const fileName = content.fileName;
          (async () => {
            const filePath = await downloadWechatFile(content.fileItem, fileName);
            if (filePath) {
              log(`File saved to: ${filePath}`);
              metaCopy.media_type = "file";
              metaCopy.media_path = filePath;
              await mcp.notification({
                method: "notifications/claude/channel",
                params: { content: `[文件: ${fileName}]`, meta: metaCopy },
              });
            } else {
              await mcp.notification({
                method: "notifications/claude/channel",
                params: { content: `[文件: ${fileName} - 下载失败]`, meta: metaCopy },
              });
            }
          })().catch((err) => logError(`File processing error: ${String(err)}`));
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
  // Initialize shared modules
  initLogger("wechat-channel", path.join(CREDENTIALS_DIR, "debug.log"));
  initContextTokenStore("context_tokens.json");

  // Connect MCP transport first (Claude Code expects stdio handshake)
  await mcp.connect(new StdioServerTransport());
  log("MCP connection ready");

  fs.mkdirSync(CREDENTIALS_DIR, { recursive: true });
  fs.mkdirSync(MEDIA_DIR, { recursive: true });

  clearLogFile();
  loadContextTokens();

  // Periodic cleanup: media files, stale caches
  cleanupOldMedia();
  cleanupInterval = setInterval(() => {
    cleanupOldMedia();
    pruneContextTokens();
    pruneTypingTicketCache();
    persistContextTokens();
  }, MEDIA_CLEANUP_INTERVAL_MS);

  let account = loadCredentials();

  if (!account) {
    log("No saved credentials found, starting WeChat QR login...");
    account = await doQRLogin(DEFAULT_BASE_URL, qrNotify);
    if (!account) {
      logError("Login failed, exiting.");
      process.exit(1);
    }
  } else {
    log(`Using saved account: ${account.accountId}`);
  }

  activeAccount = account;

  await startPolling(account);
}

function shutdown(): void {
  log("Shutting down, saving state...");
  if (cleanupInterval) clearInterval(cleanupInterval);
  clearPersistTimer();
  persistContextTokens();
  stopAllTyping();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

main().catch((err) => {
  logError(`Fatal: ${String(err)}`);
  process.exit(1);
});
