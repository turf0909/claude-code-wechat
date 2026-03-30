import {
  BASE_INFO,
  TYPING_KEEPALIVE_MS, TYPING_TICKET_STALE_MS, TYPING_MAX_LIFETIME_MS,
  TYPING_CONFIG_TIMEOUT_MS, TYPING_SEND_TIMEOUT_MS,
  CONFIG_CACHE_TTL_MS, CONFIG_CACHE_INITIAL_RETRY_MS, CONFIG_CACHE_MAX_RETRY_MS,
} from "./config.ts";
import type { TicketCacheEntry } from "./types.ts";
import { log } from "./logger.ts";
import { apiFetch } from "./http.ts";

const typingTicketCache = new Map<string, TicketCacheEntry>();
const typingTimers = new Map<string, { interval: ReturnType<typeof setInterval>; safety: ReturnType<typeof setTimeout> }>();

export function pruneTypingTicketCache(): void {
  const staleThreshold = Date.now() - TYPING_TICKET_STALE_MS;
  for (const [userId, entry] of typingTicketCache) {
    if (entry.nextFetchAt < staleThreshold) {
      typingTicketCache.delete(userId);
    }
  }
}

export async function fetchAndCacheTypingTicket(
  baseUrl: string, token: string, userId: string, contextToken: string,
): Promise<string | undefined> {
  const now = Date.now();
  const entry = typingTicketCache.get(userId);
  if (entry && now < entry.nextFetchAt) return entry.ticket || undefined;

  try {
    const raw = await apiFetch({
      baseUrl, endpoint: "ilink/bot/getconfig",
      body: JSON.stringify({
        ilink_user_id: userId, context_token: contextToken,
        base_info: BASE_INFO,
      }),
      token, timeoutMs: TYPING_CONFIG_TIMEOUT_MS,
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
      ticket: "", nextFetchAt: now + CONFIG_CACHE_INITIAL_RETRY_MS,
      retryDelayMs: CONFIG_CACHE_INITIAL_RETRY_MS,
    });
  }
  return entry?.ticket || undefined;
}

export async function sendTypingIndicator(
  baseUrl: string, token: string, userId: string, status: 1 | 2 = 1,
): Promise<void> {
  const entry = typingTicketCache.get(userId);
  if (!entry?.ticket) return;
  try {
    await apiFetch({
      baseUrl, endpoint: "ilink/bot/sendtyping",
      body: JSON.stringify({
        ilink_user_id: userId, typing_ticket: entry.ticket, status,
        base_info: BASE_INFO,
      }),
      token, timeoutMs: TYPING_SEND_TIMEOUT_MS,
    });
  } catch {}
}

export function startTypingKeepalive(baseUrl: string, token: string, userId: string): void {
  stopTypingKeepalive(userId);
  sendTypingIndicator(baseUrl, token, userId).catch(() => {});
  const interval = setInterval(() => {
    sendTypingIndicator(baseUrl, token, userId).catch(() => {});
  }, TYPING_KEEPALIVE_MS);
  const safety = setTimeout(() => stopTypingKeepalive(userId), TYPING_MAX_LIFETIME_MS);
  typingTimers.set(userId, { interval, safety });
}

export function stopTypingKeepalive(userId: string): void {
  const entry = typingTimers.get(userId);
  if (entry) {
    clearInterval(entry.interval);
    clearTimeout(entry.safety);
    typingTimers.delete(userId);
  }
}

export function stopTypingAndNotify(baseUrl: string, token: string, userId: string): void {
  stopTypingKeepalive(userId);
  sendTypingIndicator(baseUrl, token, userId, 2).catch(() => {});
}

export function stopAllTyping(): void {
  for (const userId of [...typingTimers.keys()]) {
    stopTypingKeepalive(userId);
  }
}
