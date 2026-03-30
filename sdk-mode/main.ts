#!/usr/bin/env bun
/**
 * Claude Code WeChat Bot — Agent SDK Mode (Full-Featured)
 *
 * Uses Claude Code Agent SDK instead of MCP Channel; no OAuth login required.
 * Feature-complete with Channel mode: text/image/file send & receive, typing indicator, token re-login, log rotation, etc.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";

// ── Shared imports ──────────────────────────────────────────────────────────

import {
  CHANNEL_VERSION, DEFAULT_BASE_URL,
  CREDENTIALS_FILE, CREDENTIALS_DIR, MEDIA_DIR,
  MEDIA_CLEANUP_INTERVAL_MS,
  MAX_CONSECUTIVE_FAILURES, BACKOFF_DELAY_MS, RETRY_DELAY_MS,
  SESSION_EXPIRED_ERRCODE,
  SPLIT_DELAY_MS, MSG_TYPE_USER,
} from "../shared/config.ts";
import type { AccountData, ExtractedContent } from "../shared/types.ts";
import { initLogger, log, logError, clearLogFile } from "../shared/logger.ts";
import { extractContent, splitTextIntoChunks, sendTextMessage, getUpdates } from "../shared/message.ts";
import { downloadWechatImage, mimeToExt, downloadWechatFile } from "../shared/cdn.ts";
import {
  fetchAndCacheTypingTicket, startTypingKeepalive,
  stopTypingAndNotify, pruneTypingTicketCache, stopAllTyping,
} from "../shared/typing.ts";
import {
  initContextTokenStore, loadContextTokens, pruneContextTokens,
  persistContextTokens, clearPersistTimer, cacheContextToken, getCachedContextToken,
} from "../shared/context-token.ts";
import { loadCredentials } from "../shared/credentials.ts";
import { doQRLogin, doQRReLogin } from "../shared/qr-login.ts";
import { cleanupOldMedia } from "../shared/media.ts";

// ── SDK-Specific Constants ──────────────────────────────────────────────────

const DEFAULT_SDK_MODEL = process.env.ANTHROPIC_MODEL || "auto";
const SLASH_CMD_TIMEOUT_MS = 30_000;
const SESSION_FILE = path.join(CREDENTIALS_DIR, "sdk_sessions.json");
const TOOLS_SCRIPT_PATH = path.join(path.dirname(new URL(import.meta.url).pathname), "wechat-tools.js");

// ── User Model Selection ────────────────────────────────────────────────────

let activeAccount: AccountData;

const userModels = new Map<string, string>();

function getUserModel(senderId: string): string {
  return userModels.get(senderId) || DEFAULT_SDK_MODEL;
}

const userThinking = new Map<string, boolean>();

function getThinkingConfig(senderId: string): { type: "disabled" } | undefined {
  return userThinking.get(senderId) ? undefined : { type: "disabled" };
}

// ── Session Management ──────────────────────────────────────────────────────

const MAX_USER_SESSIONS = 500;
const userSessions = new Map<string, string>();

function loadSessions(): void {
  try {
    const data = JSON.parse(fs.readFileSync(SESSION_FILE, "utf-8"));
    for (const [k, v] of Object.entries(data)) { if (typeof v === "string") userSessions.set(k, v); }
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

// ── Session History ─────────────────────────────────────────────────────────

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

// ── Slash Commands ──────────────────────────────────────────────────────────

async function handleSlashCommand(
  senderId: string, replyTarget: string, cmd: string, contextToken: string,
): Promise<boolean> {
  const trimmed = cmd.trim();
  const lower = trimmed.toLowerCase();

  if (lower === "/new") {
    userAbortControllers.get(senderId)?.abort();
    userAbortControllers.delete(senderId);
    userQueues.delete(senderId);
    userSessions.delete(senderId);
    saveSessions();
    await sendTextMessage(activeAccount.baseUrl, activeAccount.token, replyTarget, "已开始新对话。旧对话可通过 /resume 恢复。", contextToken);
    return true;
  }

  if (lower === "/clear") {
    const sessionId = userSessions.get(senderId);
    if (!sessionId) {
      await sendTextMessage(activeAccount.baseUrl, activeAccount.token, replyTarget, "当前没有活跃的对话，无需清除。", contextToken);
      return true;
    }
    try {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), SLASH_CMD_TIMEOUT_MS);
      try {
        for await (const m of query({ prompt: "/clear", options: { model: getUserModel(senderId), resume: sessionId, permissionMode: "bypassPermissions", maxTurns: 1, thinking: getThinkingConfig(senderId), abortController: ac } })) {}
      } finally { clearTimeout(timer); }
      await sendTextMessage(activeAccount.baseUrl, activeAccount.token, replyTarget, "已清除对话上下文。", contextToken);
    } catch {
      await sendTextMessage(activeAccount.baseUrl, activeAccount.token, replyTarget, "清除上下文失败，请重试。", contextToken);
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
      await sendTextMessage(activeAccount.baseUrl, activeAccount.token, replyTarget, msg, contextToken);
    } else {
      await sendTextMessage(activeAccount.baseUrl, activeAccount.token, replyTarget, "当前没有正在执行的任务。", contextToken);
    }
    return true;
  }

  if (lower === "/cancel") {
    const controller = userAbortControllers.get(senderId);
    const queued = userQueues.get(senderId)?.length || 0;
    if (!controller && !queued) {
      await sendTextMessage(activeAccount.baseUrl, activeAccount.token, replyTarget, "当前没有正在执行或排队的任务。", contextToken);
      return true;
    }
    if (controller) { controller.abort(); userAbortControllers.delete(senderId); }
    userQueues.delete(senderId);
    const parts = [controller ? "已中止当前任务" : null, queued ? `已清空 ${queued} 条排队消息` : null].filter(Boolean);
    await sendTextMessage(activeAccount.baseUrl, activeAccount.token, replyTarget, `${parts.join("，")}。`, contextToken);
    return true;
  }

  if (lower === "/compact") {
    const sessionId = userSessions.get(senderId);
    if (!sessionId) {
      await sendTextMessage(activeAccount.baseUrl, activeAccount.token, replyTarget, "当前没有活跃的对话。", contextToken);
      return true;
    }
    await sendTextMessage(activeAccount.baseUrl, activeAccount.token, replyTarget, "正在压缩对话上下文...", contextToken);
    try {
      let result = "";
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), SLASH_CMD_TIMEOUT_MS);
      try {
        for await (const m of query({ prompt: "/compact", options: { model: getUserModel(senderId), resume: sessionId, permissionMode: "bypassPermissions", maxTurns: 1, thinking: getThinkingConfig(senderId), abortController: ac } })) {
          if ((m as any).type === "result") result = (m as any).result || "";
        }
      } finally { clearTimeout(timer); }
      await sendTextMessage(activeAccount.baseUrl, activeAccount.token, replyTarget, result || "对话已压缩。", contextToken);
    } catch (err) {
      await sendTextMessage(activeAccount.baseUrl, activeAccount.token, replyTarget, `压缩失败: ${String(err)}`, contextToken);
    }
    return true;
  }

  if (lower.startsWith("/resume")) {
    const arg = trimmed.slice(7).trim();
    if (!arg) {
      const sessions = listAllSessions();
      const currentId = userSessions.get(senderId);
      if (!sessions.length) { await sendTextMessage(activeAccount.baseUrl, activeAccount.token, replyTarget, "没有历史对话记录。", contextToken); return true; }
      const lines = sessions.slice(0, 10).map((s, i) => {
        const date = s.timestamp.slice(0, 16).replace("T", " ");
        const title = s.firstMessage || s.slug || "(无标题)";
        const current = s.id === currentId ? " [当前]" : "";
        return `${i + 1}. ${date}\n   ${title}${current}\n   /resume ${s.id.slice(0, 8)}`;
      });
      await sendTextMessage(activeAccount.baseUrl, activeAccount.token, replyTarget, `历史对话 (最近 ${Math.min(sessions.length, 10)} 个):\n\n${lines.join("\n\n")}`, contextToken);
      return true;
    }
    const match = listAllSessions().find((s) => s.id.startsWith(arg));
    if (!match) { await sendTextMessage(activeAccount.baseUrl, activeAccount.token, replyTarget, `未找到: ${arg}`, contextToken); return true; }
    userSessions.set(senderId, match.id);
    saveSessions();
    await sendTextMessage(activeAccount.baseUrl, activeAccount.token, replyTarget, `已恢复对话: ${match.firstMessage || match.slug || "(无标题)"}\n\n继续发消息即可。`, contextToken);
    return true;
  }

  if (lower.startsWith("/model")) {
    const arg = trimmed.slice(6).trim();
    if (!arg) {
      const current = getUserModel(senderId);
      await sendTextMessage(activeAccount.baseUrl, activeAccount.token, replyTarget,
        `当前模型: ${current}\n\n用法: /model <模型名>\n例如: /model auto\n      /model glm-5\n\n输入 /model default 恢复默认`, contextToken);
      return true;
    }
    const targetModel = arg === "default" ? DEFAULT_SDK_MODEL : arg;
    await sendTextMessage(activeAccount.baseUrl, activeAccount.token, replyTarget, `正在验证模型 ${targetModel}...`, contextToken);
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
        await sendTextMessage(activeAccount.baseUrl, activeAccount.token, replyTarget,
          `模型验证超时（${MODEL_VERIFY_TIMEOUT_MS / 1000}s）: ${targetModel} 可能不可用\n\n保持当前模型: ${getUserModel(senderId)}`, contextToken);
      } else if (verified) {
        if (arg === "default") { userModels.delete(senderId); } else { userModels.set(senderId, arg); }
        const info = modelUsed && modelUsed !== targetModel ? `${targetModel} (实际: ${modelUsed})` : targetModel;
        await sendTextMessage(activeAccount.baseUrl, activeAccount.token, replyTarget, `模型已切换为: ${info}\n\n如遇到兼容问题，发 /new 开始新对话后重试。`, contextToken);
      } else {
        const detail = resultMsg ? `\n${resultMsg.slice(0, 150)}` : "";
        await sendTextMessage(activeAccount.baseUrl, activeAccount.token, replyTarget, `模型验证失败: ${targetModel} 不可用${detail}\n\n保持当前模型: ${getUserModel(senderId)}`, contextToken);
      }
    } catch (err) {
      const errMsg = String(err).slice(0, 100);
      await sendTextMessage(activeAccount.baseUrl, activeAccount.token, replyTarget, `模型不可用: ${targetModel}\n${errMsg}\n\n保持当前模型: ${getUserModel(senderId)}`, contextToken);
    }
    log(`Model switched: user=${senderId} model=${getUserModel(senderId)}`);
    return true;
  }

  if (lower.startsWith("/thinking")) {
    const arg = trimmed.slice(9).trim().toLowerCase();
    if (!arg) {
      const status = userThinking.get(senderId) ? "开启" : "关闭";
      await sendTextMessage(activeAccount.baseUrl, activeAccount.token, replyTarget,
        `Thinking 模式: ${status}\n\n用法: /thinking on | off\n注意: 部分模型不支持 thinking，开启后若报错请发 /thinking off 关闭`, contextToken);
      return true;
    }
    if (arg === "on") {
      userThinking.set(senderId, true);
      await sendTextMessage(activeAccount.baseUrl, activeAccount.token, replyTarget, "已开启 Thinking 模式。如模型不支持导致报错，发 /thinking off 关闭。", contextToken);
    } else if (arg === "off") {
      userThinking.delete(senderId);
      await sendTextMessage(activeAccount.baseUrl, activeAccount.token, replyTarget, "已关闭 Thinking 模式。", contextToken);
    } else {
      await sendTextMessage(activeAccount.baseUrl, activeAccount.token, replyTarget, "用法: /thinking on | off", contextToken);
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
    await sendTextMessage(activeAccount.baseUrl, activeAccount.token, replyTarget, lines.join("\n"), contextToken);
    return true;
  }

  if (lower === "/help") {
    await sendTextMessage(activeAccount.baseUrl, activeAccount.token, replyTarget,
      "可用命令:\n/new - 开始新对话（旧对话保留，可 /resume）\n/clear - 清除当前对话上下文（保留 session）\n/stop - 中止当前任务\n/cancel - 中止当前任务并清空排队消息\n/model - 查看/切换模型\n/thinking - 查看/切换 Thinking 模式（默认关闭）\n/status - 查看当前状态\n/resume - 查看历史对话列表\n/resume <id> - 恢复指定对话\n/compact - 压缩当前对话上下文\n/help - 显示此帮助", contextToken);
    return true;
  }

  if (/^\/\w+$/.test(trimmed)) {
    await sendTextMessage(activeAccount.baseUrl, activeAccount.token, replyTarget, `未知命令: ${trimmed}\n输入 /help 查看可用命令`, contextToken);
    return true;
  }

  return false;
}

// ── Per-User Message Queue ──────────────────────────────────────────────────

interface QueuedMessage { content: ExtractedContent; contextToken: string; replyTarget: string }
const userQueues = new Map<string, QueuedMessage[]>();
const processingUsers = new Set<string>();
const userAbortControllers = new Map<string, AbortController>();

async function processQueue(senderId: string): Promise<void> {
  if (processingUsers.has(senderId)) return;
  processingUsers.add(senderId);
  try {
    while (true) {
      const queue = userQueues.get(senderId);
      if (!queue?.length) break;
      const msg = queue.shift()!;
      await processOneMessage(senderId, msg.replyTarget, msg.content, msg.contextToken);
    }
  } finally {
    processingUsers.delete(senderId);
    if (!userQueues.get(senderId)?.length) userQueues.delete(senderId);
  }
}

// ── Message Handler (SDK query) ─────────────────────────────────────────────

async function handleMessage(
  senderId: string, replyTarget: string, content: ExtractedContent, contextToken: string,
): Promise<void> {
  if (content?.kind === "text" && content.text.startsWith("/")) {
    const handled = await handleSlashCommand(senderId, replyTarget, content.text, contextToken);
    if (handled) return;
  }

  let queue = userQueues.get(senderId);
  if (!queue) { queue = []; userQueues.set(senderId, queue); }
  queue.push({ content, contextToken, replyTarget });

  if (processingUsers.has(senderId)) {
    try {
      await sendTextMessage(activeAccount.baseUrl, activeAccount.token, replyTarget, "消息已收到，前一条正在处理中，请稍候。", contextToken);
    } catch {}
  }

  processQueue(senderId).catch((err) => logError(`Queue processing error: ${String(err)}`));
}

async function processOneMessage(
  senderId: string, replyTarget: string, content: ExtractedContent, contextToken: string,
): Promise<void> {
  if (!content) return;
  const { baseUrl, token } = activeAccount;

  const abortController = new AbortController();
  userAbortControllers.set(senderId, abortController);

  try {
    fetchAndCacheTypingTicket(baseUrl, token, replyTarget, contextToken)
      .then(() => startTypingKeepalive(baseUrl, token, replyTarget))
      .catch(() => {});

    await sendTextMessage(baseUrl, token, replyTarget, "正在处理...", contextToken);

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
            command: "node",
            args: [TOOLS_SCRIPT_PATH],
            env: {
              WECHAT_SENDER_ID: replyTarget,
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

    stopTypingAndNotify(baseUrl, token, replyTarget);

    if (!result.trim()) result = "（无回复内容）";

    const chunks = splitTextIntoChunks(result);
    for (let i = 0; i < chunks.length; i++) {
      if (i > 0) await new Promise((r) => setTimeout(r, SPLIT_DELAY_MS));
      await sendTextMessage(baseUrl, token, replyTarget, chunks[i], contextToken);
    }
    log(`Reply sent: user=${senderId} length=${result.length}`);
  } catch (err) {
    userAbortControllers.delete(senderId);
    stopTypingAndNotify(baseUrl, token, replyTarget);
    if (abortController.signal.aborted) {
      log(`Task aborted: user=${senderId}`);
      return;
    }
    logError(`Processing failed: user=${senderId} ${String(err)}`);
    try { await sendTextMessage(baseUrl, token, replyTarget, `处理出错: ${String(err)}`, contextToken); } catch {}
  }
}

// ── Polling Loop ────────────────────────────────────────────────────────────

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
            activeAccount = newAccount;
            baseUrl = newAccount.baseUrl;
            token = newAccount.token;
            getUpdatesBuf = "";
            consecutiveFailures = 0;
            continue;
          } catch (err) {
            logError(`Re-login failed: ${String(err)}`);
            try { fs.unlinkSync(CREDENTIALS_FILE); } catch {}
            persistContextTokens();
            saveSessions();
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
        const sessionKey = isGroup ? `${senderId}@${msg.group_id}` : senderId;

        if (msg.context_token) cacheContextToken(replyTarget, msg.context_token);
        const ct = getCachedContextToken(replyTarget);
        if (!ct) { log(`Skipping message (no context_token): ${senderId}`); continue; }

        log(`Message received: from=${senderId} kind=${content.kind}${content.kind === "text" ? ` text=${content.text.slice(0, 50)}` : ""}...`);
        handleMessage(sessionKey, replyTarget, content, ct).catch((err) => logError(`handleMessage error: ${String(err)}`));
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
  initLogger("sdk-mode", path.join(CREDENTIALS_DIR, "sdk_debug.log"));
  initContextTokenStore("context_tokens.json");

  fs.mkdirSync(CREDENTIALS_DIR, { recursive: true });
  fs.mkdirSync(MEDIA_DIR, { recursive: true });
  clearLogFile();
  loadSessions();
  loadContextTokens();

  cleanupOldMedia();
  cleanupInterval = setInterval(() => {
    cleanupOldMedia();
    pruneContextTokens();
    pruneTypingTicketCache();
    persistContextTokens();
  }, MEDIA_CLEANUP_INTERVAL_MS);

  let account = loadCredentials();
  if (!account) {
    account = await doQRLogin(DEFAULT_BASE_URL);
    if (!account) { logError("Login failed, exiting"); process.exit(1); }
  } else {
    log(`Using saved account: ${account.accountId}`);
  }

  activeAccount = account;
  await startPolling(account);
}

function shutdown(): void {
  log("Shutting down...");
  if (cleanupInterval) clearInterval(cleanupInterval);
  clearPersistTimer();
  saveSessions();
  persistContextTokens();
  stopAllTyping();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
main().catch((err) => { logError(`Fatal: ${String(err)}`); persistContextTokens(); saveSessions(); process.exit(1); });
