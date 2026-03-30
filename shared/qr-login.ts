import {
  BOT_TYPE, API_TIMEOUT_MS, LONG_POLL_TIMEOUT_MS,
  QR_LOGIN_TIMEOUT_MS, QR_POLL_DELAY_MS, QR_RELOGIN_MAX_ATTEMPTS,
} from "./config.ts";
import type { AccountData, QRCodeResponse, QRStatusResponse } from "./types.ts";
import { log, logError } from "./logger.ts";
import { fetchWithTimeout, normalizeBaseUrl } from "./http.ts";
import { saveCredentials } from "./credentials.ts";

export async function fetchQRCode(baseUrl: string): Promise<QRCodeResponse> {
  const base = normalizeBaseUrl(baseUrl);
  const url = new URL(
    `ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(BOT_TYPE)}`, base,
  );
  const res = await fetchWithTimeout(url.toString(), {}, API_TIMEOUT_MS);
  if (!res.ok) throw new Error(`QR fetch failed: ${res.status}`);
  return (await res.json()) as QRCodeResponse;
}

export async function pollQRStatus(baseUrl: string, qrcode: string): Promise<QRStatusResponse> {
  const base = normalizeBaseUrl(baseUrl);
  const url = new URL(
    `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`, base,
  );
  try {
    const res = await fetchWithTimeout(
      url.toString(),
      { headers: { "iLink-App-ClientVersion": "1" } },
      LONG_POLL_TIMEOUT_MS,
    );
    if (!res.ok) throw new Error(`QR status failed: ${res.status}`);
    return (await res.json()) as QRStatusResponse;
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") return { status: "wait" };
    throw err;
  }
}

export type QRNotifyCallback = (message: string) => Promise<void>;

export async function doQRLogin(
  baseUrl: string,
  onQRUrl?: QRNotifyCallback,
): Promise<AccountData | null> {
  log("Fetching WeChat login QR code...");
  const qrResp = await fetchQRCode(baseUrl);
  const qrUrl = qrResp.qrcode_img_content;
  log(`QR scan link: ${qrUrl}`);

  if (onQRUrl) {
    try { await onQRUrl(`请扫码登录微信: ${qrUrl}`); } catch {}
  }

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
      case "wait": break;
      case "scaned":
        if (!scannedPrinted) { log("QR scanned, please confirm in WeChat..."); scannedPrinted = true; }
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

export async function doQRReLogin(
  oldAccount: AccountData,
  onNotify?: QRNotifyCallback,
): Promise<AccountData> {
  log("Token expired, starting re-login...");
  for (let attempt = 1; attempt <= QR_RELOGIN_MAX_ATTEMPTS; attempt++) {
    log(`Re-login attempt (${attempt}/${QR_RELOGIN_MAX_ATTEMPTS})...`);
    const qrResp = await fetchQRCode(oldAccount.baseUrl);
    const qrUrl = qrResp.qrcode_img_content;
    log(`Please scan QR to re-login: ${qrUrl}`);

    if (onNotify) {
      try { await onNotify(`⚠️ 微信 Token 已过期，请扫码重新登录: ${qrUrl}`); } catch {}
    }

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
        if (onNotify) {
          try { await onNotify("✅ 微信重新登录成功，恢复消息监听。"); } catch {}
        }
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
