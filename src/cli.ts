#!/usr/bin/env node
import { parseArgs } from "node:util";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { chromium } from "playwright";
import { CATEGORIES, type Category } from "./types.js";
import { loadConfig } from "./config.js";
import { collectDocuments } from "./collector.js";
import { AgentMailClient } from "./mail.js";
import { JobStore } from "./store.js";
import { parseRequest } from "./parser.js";
import { renderReply } from "./summary.js";
import { log, runWorker } from "./worker.js";

async function main(): Promise<void> {
  const args = parseArgs({
    allowPositionals: true,
    options: {
      matter: { type: "string" },
      category: { type: "string" },
      output: { type: "string" },
      limit: { type: "string" },
      headed: { type: "boolean" },
      once: { type: "boolean" },
      "live-parser": { type: "boolean" },
      text: { type: "string" },
      help: { type: "boolean" },
    },
  });
  const command = args.positionals[0] ?? "help";
  if (args.values.help || command === "help") {
    console.log(
      `Senpilot regulatory document agent\n\nCommands:\n  npm run doctor [-- --live-parser]\n  npm run collect -- --matter M12205 --category "Other Documents" [--limit 10] [--headed]\n  npm start [-- --once]\n  npm run dev -- status\n  npm run dev -- parse --text "Please send Exhibits for M12205"\n\nUse .env for local configuration. See README.md for Ubuntu operation.`,
    );
    return;
  }
  const config = loadConfig(["worker", "doctor", "inbox"].includes(command));
  if (command === "collect") {
    const matterNumber = args.values.matter?.toUpperCase();
    const category = args.values.category;
    if (
      !matterNumber ||
      !category ||
      !CATEGORIES.includes(category as Category)
    )
      throw new Error(
        "Provide --matter M12345 and --category using an exact category name",
      );
    const result = await collectDocuments(
      { matterNumber, category: category as Category },
      {
        limit: Number(args.values.limit ?? 10),
        outputDirectory: args.values.output,
        headless: !args.values.headed,
        log,
      },
    );
    await writeFile(
      join(result.runDirectory, "reply-preview.txt"),
      renderReply(result),
    );
    console.log(
      JSON.stringify(
        {
          status: result.status,
          matter: result.request.matterNumber,
          files: result.documents.length,
          zipBytes: result.zipBytes,
          runDirectory: result.runDirectory,
          failures: result.failures,
        },
        null,
        2,
      ),
    );
    if (["failed", "partial"].includes(result.status)) process.exitCode = 1;
  } else if (command === "worker") {
    const controller = new AbortController();
    process.once("SIGINT", () => controller.abort());
    process.once("SIGTERM", () => controller.abort());
    await runWorker(config, {
      once: args.values.once,
      signal: controller.signal,
    });
  } else if (command === "doctor") {
    const mail = new AgentMailClient({
      apiKey: config.apiKey,
      inboxId: config.inboxId,
      baseUrl: config.baseUrl,
    });
    const access = await mail.verifyAccess();
    console.log(
      JSON.stringify({
        node: process.version,
        inbox: config.inboxId,
        mailReadAccess: true,
        messageCount: access.messageCount,
        browserInstalled: existsSync(chromium.executablePath()),
        parser: config.parserMode,
        dailyRequestLimit: config.dailyCap,
      }),
    );
    const auth = await promisify(execFile)(
      config.codexPath,
      ["login", "status"],
      {
        timeout: 10000,
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          CODEX_HOME:
            process.env.SENPILOT_CODEX_AUTH_HOME || process.env.CODEX_HOME,
        },
      },
    );
    console.log((auth.stdout + auth.stderr).trim());
    if (args.values["live-parser"]) {
      const result = await parseRequest(
        "Could you fetch Other Documents for matter M12205? Thanks.",
        {
          mode: "codex",
          model: config.codexModel,
          codexPath: config.codexPath,
        },
      );
      console.log(JSON.stringify({ liveParser: result }));
      if (result.kind !== "request" || result.source !== "codex")
        process.exitCode = 1;
    }
  } else if (command === "status") {
    await mkdir(config.dataDirectory, { recursive: true });
    const store = new JobStore(join(config.dataDirectory, "jobs.sqlite"));
    try {
      console.log(
        JSON.stringify(
          {
            dailyUsed: store.dailyCount(),
            jobs: store.list({ limit: 200 }).map((j) => ({
              id: j.id,
              state: j.state,
              attempts: j.attempts,
              request: j.request,
              receipt: j.receipt,
              error: j.error,
            })),
          },
          null,
          2,
        ),
      );
    } finally {
      store.close();
    }
  } else if (command === "parse") {
    const result = await parseRequest(args.values.text ?? "", {
      mode: config.parserMode,
      model: config.codexModel,
      codexPath: config.codexPath,
    });
    console.log(JSON.stringify(result, null, 2));
  } else if (command === "inbox") {
    const mail = new AgentMailClient({
      apiKey: config.apiKey,
      inboxId: config.inboxId,
      baseUrl: config.baseUrl,
    });
    console.log(
      JSON.stringify(
        (await mail.listIncoming()).map((m) => ({
          messageId: m.messageId,
          subject: m.subject,
          from: m.from,
          timestamp: m.timestamp,
        })),
        null,
        2,
      ),
    );
  } else throw new Error(`Unknown command: ${command}`);
}
main().catch((error) => {
  console.error(
    JSON.stringify({
      error: error instanceof Error ? error.message : "Unknown error",
    }),
  );
  process.exitCode = 1;
});
