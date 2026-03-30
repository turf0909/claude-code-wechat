import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  WECHAT_CDN_BASE, API_TIMEOUT_MS, BASE_INFO,
  CDN_DOWNLOAD_TIMEOUT_MS, CDN_DOWNLOAD_MAX_RETRIES, CDN_DOWNLOAD_RETRY_DELAY_MS,
  CDN_UPLOAD_TIMEOUT_MS, CDN_UPLOAD_MAX_RETRIES, CDN_UPLOAD_RETRY_DELAY_MS,
  MSG_ITEM_IMAGE, MSG_ITEM_FILE, MSG_TYPE_BOT, MSG_STATE_FINISH,
  UPLOAD_MEDIA_TYPE, MEDIA_DIR,
} from "./config.ts";
import type { ImageItem, FileItem } from "./types.ts";
import { log, logError } from "./logger.ts";
import { fetchWithTimeout, apiFetch } from "./http.ts";
import { parseAesKey, decryptAesEcb, encryptAesEcb, aesEcbPaddedSize } from "./crypto.ts";
import { generateClientId } from "./message.ts";

// ── CDN Download ────────────────────────────────────────────────────────────

export async function downloadAndDecryptCdn(
  encryptQueryParam: string, aesKeyBase64: string, label: string,
): Promise<Buffer | null> {
  const cdnUrl = `${WECHAT_CDN_BASE}/download?encrypted_query_param=${encodeURIComponent(encryptQueryParam)}`;
  log(`${label} CDN download: ${cdnUrl.slice(0, 150)}...`);
  const key = parseAesKey(aesKeyBase64);
  for (let attempt = 1; attempt <= CDN_DOWNLOAD_MAX_RETRIES; attempt++) {
    try {
      const res = await fetchWithTimeout(cdnUrl, {}, CDN_DOWNLOAD_TIMEOUT_MS);
      if (!res.ok) {
        logError(`${label} CDN download failed: HTTP ${res.status}`);
        if (attempt < CDN_DOWNLOAD_MAX_RETRIES) {
          log(`${label} CDN download retry ${attempt}/${CDN_DOWNLOAD_MAX_RETRIES}...`);
          await new Promise((r) => setTimeout(r, CDN_DOWNLOAD_RETRY_DELAY_MS));
          continue;
        }
        return null;
      }
      const encrypted = Buffer.from(await res.arrayBuffer());
      const decrypted = decryptAesEcb(encrypted, key);
      log(`${label} decrypted successfully: ${decrypted.length} bytes`);
      return decrypted;
    } catch (err) {
      logError(`${label} download/decrypt error: ${String(err)}`);
      if (attempt < CDN_DOWNLOAD_MAX_RETRIES) {
        log(`${label} CDN download retry ${attempt}/${CDN_DOWNLOAD_MAX_RETRIES}...`);
        await new Promise((r) => setTimeout(r, CDN_DOWNLOAD_RETRY_DELAY_MS));
        continue;
      }
      return null;
    }
  }
  return null;
}

export function detectImageMimeType(buf: Buffer): string {
  if (buf[0] === 0x89 && buf[1] === 0x50) return "image/png";
  if (buf[0] === 0x47 && buf[1] === 0x49) return "image/gif";
  if (buf.length >= 12 && buf.subarray(0, 4).toString("ascii") === "RIFF" && buf.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  return "image/jpeg";
}

export function mimeToExt(mimeType: string): string {
  if (mimeType.includes("png")) return "png";
  if (mimeType.includes("gif")) return "gif";
  if (mimeType.includes("webp")) return "webp";
  return "jpg";
}

export async function downloadWechatImage(imageItem: ImageItem): Promise<{ buf: Buffer; mimeType: string } | null> {
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

export async function downloadWechatFile(fileItem: FileItem, fileName: string): Promise<string | null> {
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

// ── CDN Upload ──────────────────────────────────────────────────────────────

export async function getUploadUrl(
  baseUrl: string, token: string,
  params: {
    filekey: string; media_type: number; to_user_id: string;
    rawsize: number; rawfilemd5: string; filesize: number;
    no_need_thumb: boolean; aeskey: string;
  },
): Promise<{ upload_param?: string }> {
  const raw = await apiFetch({
    baseUrl, endpoint: "ilink/bot/getuploadurl",
    body: JSON.stringify({ ...params, base_info: BASE_INFO }),
    token, timeoutMs: API_TIMEOUT_MS,
  });
  try { return JSON.parse(raw); } catch { throw new Error(`getUploadUrl: invalid response: ${raw.slice(0, 200)}`); }
}

export async function uploadBufferToCdn(params: {
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
      if (!res.ok) {
        const errMsg = res.headers.get("x-error-message") ?? `status ${res.status}`;
        if (res.status >= 400 && res.status < 500) throw new Error(`CDN upload failed (4xx, no retry): ${errMsg}`);
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

export async function uploadAndSendMedia(
  baseUrl: string, token: string, to: string, filePath: string,
  contextToken: string, sendTextFn: (text: string) => Promise<void>, caption?: string,
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

  log(`Uploading file: ${fileName} size=${rawsize} type=${isImage ? "image" : "file"}`);

  const uploadResp = await getUploadUrl(baseUrl, token, {
    filekey, media_type: mediaType, to_user_id: to,
    rawsize, rawfilemd5, filesize, no_need_thumb: true,
    aeskey: aeskey.toString("hex"),
  });
  if (!uploadResp.upload_param) throw new Error("getUploadUrl returned no upload_param");

  const downloadParam = await uploadBufferToCdn({
    buf: plaintext, uploadParam: uploadResp.upload_param, filekey, aeskey,
  });
  log(`CDN upload successful: filekey=${filekey}`);

  const aesKeyBase64 = Buffer.from(aeskey.toString("hex")).toString("base64");
  const media = { encrypt_query_param: downloadParam, aes_key: aesKeyBase64, encrypt_type: 1 };

  if (caption) await sendTextFn(caption);

  const clientId = generateClientId();
  const item = isImage
    ? { type: MSG_ITEM_IMAGE, image_item: { media, mid_size: filesize } }
    : { type: MSG_ITEM_FILE, file_item: { media, file_name: fileName, len: String(rawsize) } };

  await apiFetch({
    baseUrl, endpoint: "ilink/bot/sendmessage",
    body: JSON.stringify({
      msg: {
        from_user_id: "", to_user_id: to, client_id: clientId,
        message_type: MSG_TYPE_BOT, message_state: MSG_STATE_FINISH,
        item_list: [item], context_token: contextToken,
      },
      base_info: BASE_INFO,
    }),
    token, timeoutMs: API_TIMEOUT_MS,
  });
  log(`Media message sent: ${fileName}`);
}

