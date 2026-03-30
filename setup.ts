#!/usr/bin/env bun
/**
 * WeChat Channel Setup — standalone QR login tool.
 *
 * Usage:
 *   node dist/setup.js          — scan QR to login
 *   node dist/setup.js --force  — skip relogin confirmation
 *
 * Credentials path defaults to ~/.claude/channels/wechat/account.json,
 * or set WECHAT_CREDENTIALS_FILE env var to customize.
 *
 * Note: start.sh will auto-trigger QR login if no credentials exist,
 * so running setup manually is optional.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com";
const BOT_TYPE = "3";
const CREDENTIALS_FILE = process.env.WECHAT_CREDENTIALS_FILE
  ? path.resolve(process.env.WECHAT_CREDENTIALS_FILE)
  : path.join(os.homedir(), ".claude", "channels", "wechat", "account.json");
const CREDENTIALS_DIR = path.dirname(CREDENTIALS_FILE);

interface QRCodeResponse {
  qrcode: string;
  qrcode_img_content: string;
}

interface QRStatusResponse {
  status: "wait" | "scaned" | "confirmed" | "expired";
  bot_token?: string;
  ilink_bot_id?: string;
  baseurl?: string;
  ilink_user_id?: string;
}

async function fetchQRCode(baseUrl: string): Promise<QRCodeResponse> {
  const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  const url = `${base}ilink/bot/get_bot_qrcode?bot_type=${BOT_TYPE}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`QR fetch failed: ${res.status}`);
  return (await res.json()) as QRCodeResponse;
}

async function pollQRStatus(
  baseUrl: string,
  qrcode: string,
): Promise<QRStatusResponse> {
  const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  const url = `${base}ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 35_000);
  try {
    const res = await fetch(url, {
      headers: { "iLink-App-ClientVersion": "1" },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`QR status failed: ${res.status}`);
    return (await res.json()) as QRStatusResponse;
  } catch (err) {
    clearTimeout(timer);
    if (err instanceof Error && err.name === "AbortError") {
      return { status: "wait" };
    }
    throw err;
  }
}

async function main() {
  // Check existing credentials
  const forceRelogin = process.argv.includes("--force") || process.argv.includes("-f");
  if (fs.existsSync(CREDENTIALS_FILE) && !forceRelogin) {
    try {
      const existing = JSON.parse(fs.readFileSync(CREDENTIALS_FILE, "utf-8"));
      console.log(`Existing account found: ${existing.accountId}`);
      console.log(`Saved at: ${existing.savedAt}`);
      console.log();
      const readline = await import("node:readline");
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });
      const answer = await new Promise<string>((resolve) => {
        rl.question("Re-login? (y/N) ", resolve);
      });
      rl.close();
      if (answer.toLowerCase() !== "y") {
        console.log("Keeping existing credentials. Exiting.");
        process.exit(0);
      }
    } catch {
      // ignore
    }
  }

  console.log("Fetching WeChat login QR code...\n");
  const qrResp = await fetchQRCode(DEFAULT_BASE_URL);

  // Always print the URL first (terminal QR may be garbled in some environments)
  console.log(`QR code URL: ${qrResp.qrcode_img_content}\n`);

  // Display QR code in terminal (best-effort)
  try {
    const qrterm = await import("qrcode-terminal");
    await new Promise<void>((resolve) => {
      qrterm.default.generate(
        qrResp.qrcode_img_content,
        {},
        (qr: string) => {
          console.log(qr);
          resolve();
        },
      );
    });
  } catch {
    // QR rendering failed, URL already printed above
  }

  console.log("Scan the QR code above with WeChat...\n");

  const deadline = Date.now() + 480_000;
  let scannedPrinted = false;

  while (Date.now() < deadline) {
    const status = await pollQRStatus(DEFAULT_BASE_URL, qrResp.qrcode);

    switch (status.status) {
      case "wait":
        process.stdout.write(".");
        break;
      case "scaned":
        if (!scannedPrinted) {
          console.log("\nScanned! Please confirm in WeChat...");
          scannedPrinted = true;
        }
        break;
      case "expired":
        console.log("\nQR code expired. Please run setup again.");
        process.exit(1);
        break;
      case "confirmed": {
        if (!status.ilink_bot_id || !status.bot_token) {
          console.error("\nLogin failed: server returned incomplete data.");
          process.exit(1);
        }

        const account = {
          token: status.bot_token,
          baseUrl: status.baseurl || DEFAULT_BASE_URL,
          accountId: status.ilink_bot_id,
          userId: status.ilink_user_id,
          savedAt: new Date().toISOString(),
        };

        fs.mkdirSync(CREDENTIALS_DIR, { recursive: true });
        fs.writeFileSync(
          CREDENTIALS_FILE,
          JSON.stringify(account, null, 2),
          "utf-8",
        );
        try {
          fs.chmodSync(CREDENTIALS_FILE, 0o600);
        } catch {
          // best-effort
        }

        console.log(`\nWeChat connected!`);
        console.log(`   Account ID: ${account.accountId}`);
        console.log(`   User ID: ${account.userId}`);
        console.log(`   Credentials saved to: ${CREDENTIALS_FILE}`);
        console.log();
        console.log("You can now start the Claude Code channel:");
        console.log(
          "  claude --dangerously-load-development-channels server:wechat",
        );
        process.exit(0);
      }
    }
    await new Promise((r) => setTimeout(r, 1000));
  }

  console.log("\nLogin timed out. Please run again.");
  process.exit(1);
}

main().catch((err) => {
  console.error(`Error: ${err}`);
  process.exit(1);
});
