import fs from "node:fs";
import { CREDENTIALS_DIR, CONTEXT_TOKEN_MAX_AGE_MS, CONTEXT_TOKEN_MAX_ENTRIES } from "./config.ts";
import type { ContextTokenEntry } from "./types.ts";
import { log, logError } from "./logger.ts";
import path from "node:path";

const contextTokenCache = new Map<string, ContextTokenEntry>();
let persistTimer: ReturnType<typeof setTimeout> | null = null;
let contextTokenFile = "";

export function initContextTokenStore(fileName: string = "context_tokens.json"): void {
  contextTokenFile = path.join(CREDENTIALS_DIR, fileName);
}

export function pruneContextTokens(): void {
  const now = Date.now();
  for (const [k, v] of contextTokenCache) {
    if (now - v.updatedAt > CONTEXT_TOKEN_MAX_AGE_MS) contextTokenCache.delete(k);
  }
  if (contextTokenCache.size > CONTEXT_TOKEN_MAX_ENTRIES) {
    const sorted = [...contextTokenCache.entries()].sort((a, b) => a[1].updatedAt - b[1].updatedAt);
    const toDrop = sorted.length - CONTEXT_TOKEN_MAX_ENTRIES;
    for (let i = 0; i < toDrop; i++) contextTokenCache.delete(sorted[i][0]);
  }
}

export function loadContextTokens(): void {
  if (!contextTokenFile) return;
  try {
    const data = JSON.parse(fs.readFileSync(contextTokenFile, "utf-8"));
    const now = Date.now();
    for (const [k, v] of Object.entries(data)) {
      if (typeof v === "string") {
        contextTokenCache.set(k, { token: v, updatedAt: now });
      } else if (v && typeof v === "object" && "token" in (v as any)) {
        contextTokenCache.set(k, v as ContextTokenEntry);
      }
    }
    pruneContextTokens();
    log(`Restored ${contextTokenCache.size} context tokens`);
  } catch (err) {
    if (contextTokenFile && fs.existsSync(contextTokenFile)) {
      logError(`Failed to load context tokens: ${String(err)}`);
    }
  }
}

export function persistContextTokens(): void {
  if (!contextTokenFile) return;
  try {
    fs.writeFileSync(contextTokenFile, JSON.stringify(Object.fromEntries(contextTokenCache), null, 2), "utf-8");
  } catch {}
}

export function schedulePersistContextTokens(): void {
  if (persistTimer) return;
  persistTimer = setTimeout(() => { persistTimer = null; persistContextTokens(); }, 5_000);
}

export function clearPersistTimer(): void {
  if (persistTimer) { clearTimeout(persistTimer); persistTimer = null; }
}

export function cacheContextToken(key: string, token: string): void {
  contextTokenCache.set(key, { token, updatedAt: Date.now() });
  schedulePersistContextTokens();
}

export function getCachedContextToken(key: string): string | undefined {
  return contextTokenCache.get(key)?.token;
}
