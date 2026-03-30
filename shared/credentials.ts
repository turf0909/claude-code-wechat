import fs from "node:fs";
import { CREDENTIALS_FILE, CREDENTIALS_DIR } from "./config.ts";
import type { AccountData } from "./types.ts";

export function loadCredentials(): AccountData | null {
  try {
    return JSON.parse(fs.readFileSync(CREDENTIALS_FILE, "utf-8"));
  } catch {
    return null;
  }
}

export function saveCredentials(data: AccountData): void {
  fs.mkdirSync(CREDENTIALS_DIR, { recursive: true });
  fs.writeFileSync(CREDENTIALS_FILE, JSON.stringify(data, null, 2), "utf-8");
  try {
    fs.chmodSync(CREDENTIALS_FILE, 0o600);
  } catch {}
}
