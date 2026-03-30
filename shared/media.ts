import fs from "node:fs";
import path from "node:path";
import { MEDIA_DIR, MEDIA_MAX_AGE_MS } from "./config.ts";
import { log } from "./logger.ts";

export function cleanupOldMedia(): void {
  try {
    const now = Date.now();
    for (const file of fs.readdirSync(MEDIA_DIR)) {
      try {
        const filePath = path.join(MEDIA_DIR, file);
        const stat = fs.statSync(filePath);
        if (now - stat.mtimeMs > MEDIA_MAX_AGE_MS) {
          fs.unlinkSync(filePath);
          log(`Cleaned up expired file: ${file}`);
        }
      } catch {}
    }
  } catch {}
}
