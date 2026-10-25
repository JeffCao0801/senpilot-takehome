import { loadEnvFile } from "node:process";
import { resolve } from "node:path";
import { existsSync } from "node:fs";

export interface Config {
  apiKey: string;
  inboxId: string;
  baseUrl: string;
  dataDirectory: string;
  pollMs: number;
  dailyCap: number;
  parserMode: "codex" | "rules";
  codexModel?: string;
  codexPath: string;
  allowedSenders: string[];
  startAfter?: string;
  headless: boolean;
  maxAttempts: number;
  retentionDays: number;
}
export function loadConfig(requireMail = true): Config {
  if (existsSync(".env")) loadEnvFile(".env");
  const e = process.env;
  const integer = (key: string, fallback: number, min: number, max: number) => {
    const value = e[key] === undefined ? fallback : Number(e[key]);
    if (!Number.isInteger(value) || value < min || value > max)
      throw new Error(`${key} must be an integer between ${min} and ${max}`);
    return value;
  };
  if (requireMail && (!e.AGENTMAIL_API_KEY || !e.AGENTMAIL_INBOX_ID))
    throw new Error(
      "Set AGENTMAIL_API_KEY and AGENTMAIL_INBOX_ID in the local .env file",
    );
  const base = new URL(e.AGENTMAIL_API_BASE_URL ?? "https://api.agentmail.to");
  if (
    base.protocol !== "https:" ||
    !["api.agentmail.to", "api.agentmail.eu"].includes(base.hostname) ||
    base.username ||
    base.password ||
    base.search ||
    base.hash
  )
    throw new Error(
      "AgentMail base URL must be an official HTTPS API endpoint",
    );
  const parserMode = e.PARSER_MODE ?? "codex";
  if (parserMode !== "codex" && parserMode !== "rules")
    throw new Error("PARSER_MODE must be codex or rules");
  if (e.START_AFTER && !Number.isFinite(Date.parse(e.START_AFTER)))
    throw new Error("START_AFTER must be an ISO timestamp");
  return {
    apiKey: e.AGENTMAIL_API_KEY ?? "",
    inboxId: e.AGENTMAIL_INBOX_ID ?? "",
    baseUrl: base.origin + "/v0",
    dataDirectory: resolve(e.DATA_DIR ?? "data"),
    pollMs: integer("POLL_SECONDS", 20, 5, 3600) * 1000,
    dailyCap: integer("DAILY_REQUEST_LIMIT", 20, 0, 100),
    parserMode,
    codexModel: e.CODEX_MODEL || undefined,
    codexPath: e.CODEX_PATH ?? "codex",
    allowedSenders: (e.ALLOWED_SENDERS ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
    startAfter: e.START_AFTER,
    headless: e.HEADLESS !== "false",
    maxAttempts: integer("MAX_JOB_ATTEMPTS", 2, 1, 3),
    retentionDays: integer("RETENTION_DAYS", 7, 1, 90),
  };
}
