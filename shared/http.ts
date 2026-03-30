import crypto from "node:crypto";
import { SESSION_EXPIRED_ERRCODE } from "./config.ts";

export function randomWechatUin(): string {
  const uint32 = crypto.randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(uint32), "utf-8").toString("base64");
}

export function buildHeaders(token?: string, body?: string): Record<string, string> {
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

export async function fetchWithTimeout(
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

export function normalizeBaseUrl(url: string): string {
  return url.endsWith("/") ? url : `${url}/`;
}

export async function apiFetch(params: {
  baseUrl: string;
  endpoint: string;
  body: string;
  token?: string;
  timeoutMs: number;
}): Promise<string> {
  const base = normalizeBaseUrl(params.baseUrl);
  const url = new URL(params.endpoint, base).toString();
  const headers = buildHeaders(params.token, params.body);
  const res = await fetchWithTimeout(
    url,
    { method: "POST", headers, body: params.body },
    params.timeoutMs,
  );
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
