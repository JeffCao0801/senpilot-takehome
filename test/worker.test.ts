import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  shouldProcess,
  acquireWorkerLock,
  scanAfter,
  runWorker,
} from "../src/worker.js";
import { JobStore } from "../src/store.js";
import type { Config } from "../src/config.js";
import type { IncomingMessage } from "../src/types.js";
import { chromium } from "playwright";
const message: IncomingMessage = {
  messageId: "m",
  inboxId: "agent@agentmail.to",
  from: "User <user@example.com>",
  subject: "request",
  text: "M12205 Exhibits",
  timestamp: "2026-10-25T00:00:00Z",
  labels: ["received"],
};

test("email worker clarifies conflicting subjects instead of collecting the body's request", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "senpilot-conflict-"));
  const sent: string[] = [];
  const rows = [
    { ...message, message_id: "matter-conflict", subject: "M54321 Exhibits" },
    {
      ...message,
      message_id: "category-conflict",
      subject: "M12205 Transcripts",
    },
  ].map((value) => ({
    ...value,
    inbox_id: message.inboxId,
    thread_id: value.message_id,
    timestamp: new Date().toISOString(),
  }));
  const browser = t.mock.method(chromium, "launch", async () => {
    throw new Error("Unexpected browser launch");
  });
  t.mock.method(
    globalThis,
    "fetch",
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if (init?.method === "POST") {
        sent.push(JSON.parse(init.body as string).text);
        const id = url.pathname.split("/").at(-2)!;
        return new Response(
          JSON.stringify({ message_id: `sent-${id}`, thread_id: id }),
        );
      }
      return new Response(
        JSON.stringify(
          url.pathname.endsWith("/messages")
            ? { messages: rows, count: 2 }
            : rows.find((row) => url.pathname.endsWith(row.message_id)),
        ),
      );
    },
  );
  try {
    await runWorker(
      {
        apiKey: "test-placeholder",
        inboxId: message.inboxId,
        baseUrl: "https://api.agentmail.to/v0",
        dataDirectory: directory,
        pollMs: 5000,
        dailyCap: 5,
        parserMode: "rules",
        codexPath: "/never/start/codex",
        allowedSenders: [],
        headless: true,
        maxAttempts: 2,
        retentionDays: 7,
      },
      { once: true },
    );
    assert.equal(browser.mock.callCount(), 0);
    assert.equal(sent.length, 2);
    assert.ok(sent.some((text) => /one matter/.test(text)));
    assert.ok(sent.some((text) => /one document category/.test(text)));
    const store = new JobStore(join(directory, "jobs.sqlite"));
    try {
      assert.ok(
        store.list().every((job) => job.state === "complete" && !job.request),
      );
    } finally {
      store.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("worker retries an explicit send rate-limit rejection without re-sending immediately", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "senpilot-send-retry-"));
  let sends = 0;
  const raw = {
    inbox_id: message.inboxId,
    message_id: message.messageId,
    thread_id: "thread",
    from: message.from,
    subject: "Missing details",
    text: "Please help",
    timestamp: new Date().toISOString(),
    labels: ["received"],
  };
  t.mock.method(
    globalThis,
    "fetch",
    async (input: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "POST") {
        sends++;
        return new Response("{}", { status: 429 });
      }
      return new Response(
        JSON.stringify(
          new URL(String(input)).pathname.endsWith("/messages")
            ? { messages: [raw], count: 1 }
            : raw,
        ),
        { headers: { "Content-Type": "application/json" } },
      );
    },
  );
  const config: Config = {
    apiKey: "test-placeholder",
    inboxId: message.inboxId,
    baseUrl: "https://api.agentmail.to/v0",
    dataDirectory: directory,
    pollMs: 5000,
    dailyCap: 5,
    parserMode: "rules",
    codexPath: "codex",
    allowedSenders: [],
    headless: true,
    maxAttempts: 2,
    retentionDays: 7,
  };
  try {
    await runWorker(config, { once: true });
    const store = new JobStore(join(directory, "jobs.sqlite"));
    try {
      assert.equal(store.list()[0].state, "retry");
      assert.equal(store.list()[0].attempts, 1);
      assert.equal(sends, 1);
    } finally {
      store.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test("worker excludes automatic replies, the agent itself, and non-allowed test senders", () => {
  const config = {
    inboxId: "agent@agentmail.to",
    allowedSenders: ["user@example.com"],
  };
  assert.equal(shouldProcess(message, config), true);
  assert.equal(
    shouldProcess({ ...message, from: "elsewhere@example.com" }, config),
    false,
  );
  assert.equal(
    shouldProcess({ ...message, from: "agent@agentmail.to" }, config),
    false,
  );
  assert.equal(
    shouldProcess(
      { ...message, headers: { "Auto-Submitted": "auto-replied" } },
      config,
    ),
    false,
  );
});
test("two workers cannot run against the same data directory", async () => {
  const directory = await mkdtemp(join(tmpdir(), "senpilot-lock-"));
  try {
    const release = await acquireWorkerLock(directory);
    await assert.rejects(acquireWorkerLock(directory), /Another worker/);
    await release();
    const releaseAgain = await acquireWorkerLock(directory);
    await releaseAgain();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test("scan overlap never widens the initial configured cutoff", () => {
  assert.equal(
    scanAfter(undefined, "2026-10-25T00:00:00Z"),
    "2026-10-25T00:00:00.000Z",
  );
  assert.equal(
    scanAfter("2026-10-25T12:00:00Z", "2026-10-25T00:00:00Z"),
    "2026-10-25T00:00:00.000Z",
  );
  assert.equal(
    scanAfter("2026-10-27T12:00:00Z", "2026-10-25T00:00:00Z"),
    "2026-10-26T12:00:00.000Z",
  );
  assert.equal(scanAfter(), undefined);
});
