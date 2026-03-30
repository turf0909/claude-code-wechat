import crypto from "node:crypto";
import {
  API_TIMEOUT_MS, LONG_POLL_TIMEOUT_MS, BASE_INFO,
  MAX_MSG_LEN, MSG_TYPE_BOT, MSG_STATE_FINISH, MSG_ITEM_TEXT,
  MSG_ITEM_IMAGE, MSG_ITEM_VOICE, MSG_ITEM_FILE, MSG_ITEM_LINK,
} from "./config.ts";
import type { WeixinMessage, GetUpdatesResp, ExtractedContent } from "./types.ts";
import { log } from "./logger.ts";
import { apiFetch } from "./http.ts";

// ── Content Extraction ──────────────────────────────────────────────────────

export function extractContent(msg: WeixinMessage): ExtractedContent {
  if (!msg.item_list?.length) return null;
  for (const item of msg.item_list) {
    if (item.type === MSG_ITEM_TEXT && item.text_item?.text) {
      const text = item.text_item.text;
      const ref = item.ref_msg;
      if (ref?.title) return { kind: "text", text: `[引用: ${ref.title}]\n${text}` };
      return { kind: "text", text };
    }
    if (item.type === MSG_ITEM_VOICE) {
      if (item.voice_item?.text) return { kind: "text", text: item.voice_item.text };
      return { kind: "text", text: "[收到语音消息，但无法识别内容]" };
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
      return { kind: "text", text: `[分享链接: ${title} ${url}]` };
    }
    log(`Unknown message type=${item.type}, raw data: ${JSON.stringify(item)}`);
  }
  return null;
}

// ── Text Splitting ──────────────────────────────────────────────────────────

export function splitTextIntoChunks(text: string): string[] {
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

// ── Client ID ───────────────────────────────────────────────────────────────

export function generateClientId(): string {
  return `wechat:${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
}

// ── Send / Receive ──────────────────────────────────────────────────────────

export async function sendTextMessage(
  baseUrl: string, token: string, to: string, text: string, contextToken: string,
): Promise<string> {
  const clientId = generateClientId();
  await apiFetch({
    baseUrl, endpoint: "ilink/bot/sendmessage",
    body: JSON.stringify({
      msg: {
        from_user_id: "", to_user_id: to, client_id: clientId,
        message_type: MSG_TYPE_BOT, message_state: MSG_STATE_FINISH,
        item_list: [{ type: MSG_ITEM_TEXT, text_item: { text } }],
        context_token: contextToken,
      },
      base_info: BASE_INFO,
    }),
    token, timeoutMs: API_TIMEOUT_MS,
  });
  return clientId;
}

export async function getUpdates(
  baseUrl: string, token: string, getUpdatesBuf: string,
): Promise<GetUpdatesResp> {
  try {
    const raw = await apiFetch({
      baseUrl, endpoint: "ilink/bot/getupdates",
      body: JSON.stringify({
        get_updates_buf: getUpdatesBuf,
        base_info: BASE_INFO,
      }),
      token, timeoutMs: LONG_POLL_TIMEOUT_MS,
    });
    return JSON.parse(raw) as GetUpdatesResp;
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      return { ret: 0, msgs: [], get_updates_buf: getUpdatesBuf };
    }
    throw err;
  }
}
