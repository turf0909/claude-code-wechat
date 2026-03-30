import fs from "node:fs";

let _prefix = "wechat";
let _logFile = "";
let _logOldFile = "";
const LOG_MAX_BYTES = 10 * 1024 * 1024; // 10 MB
let logWriteCount = 0;

export function initLogger(prefix: string, logFile: string): void {
  _prefix = prefix;
  _logFile = logFile;
  _logOldFile = `${logFile}.old`;
}

function rotateLogIfNeeded(): void {
  try {
    const stat = fs.statSync(_logFile);
    if (stat.size > LOG_MAX_BYTES) {
      try { fs.unlinkSync(_logOldFile); } catch {}
      fs.renameSync(_logFile, _logOldFile);
    }
  } catch {}
}

function appendLog(line: string): void {
  if (!_logFile) return;
  try {
    fs.appendFileSync(_logFile, line);
    if (++logWriteCount % 500 === 0) rotateLogIfNeeded();
  } catch {}
}

export function log(msg: string): void {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  process.stderr.write(`[${_prefix}] ${msg}\n`);
  appendLog(line);
}

export function logError(msg: string): void {
  const line = `[${new Date().toISOString()}] ERROR: ${msg}\n`;
  process.stderr.write(`[${_prefix}] ERROR: ${msg}\n`);
  appendLog(line);
}

export function clearLogFile(): void {
  if (_logFile) {
    try { fs.writeFileSync(_logFile, "", "utf-8"); } catch {}
  }
}
