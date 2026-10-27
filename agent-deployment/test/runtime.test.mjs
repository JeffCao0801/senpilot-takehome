import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  settings,
  codexConfig,
  childEnvironment,
  deploymentDir,
} from "../config.mjs";
import {
  configure,
  withLock,
  loadState,
  processOne,
  jobKey,
  pending,
  api,
  verifyResult,
  executeAgent,
} from "../runtime.mjs";
import { serviceUnit, timerUnit } from "../cli.mjs";

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "senpilot-agent-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const config = {
    ...settings({}, directory),
    workflow: join(
      deploymentDir,
      "..",
      "agent-experiment",
      "SENPILOT_AGENT.md",
    ),
    enabled: true,
  };
  await configure(config);
  const message = {
    inbox_id: config.inbox,
    message_id: "<inbound@test>",
    thread_id: "thread-test",
    from: "Requester <requester@example.com>",
    labels: ["received"],
    timestamp: new Date().toISOString(),
  };
  return { config, message };
}

test("configuration separates inbox/state/auth and does not serialize secrets", () => {
  const config = settings({
    MARKDOWN_AGENT_API_KEY: "fixture-secret-never-real",
  });
  assert.equal(config.inbox, "jeffcao-markdown@agentmail.to");
  assert.equal(config.auth, join(deploymentDir, "data", "codex"));
  const rendered = codexConfig(config);
  assert.ok(!rendered.includes(config.key));
  assert.ok(rendered.includes('default_tools_approval_mode = "approve"'));
  assert.ok(!rendered.includes("send_message"));
  assert.ok(!rendered.includes("danger-full-access"));
  assert.throws(() =>
    settings({ MARKDOWN_AGENT_INBOX: "jeffcao@agentmail.to" }),
  );
  assert.throws(() =>
    settings({ MARKDOWN_AGENT_CODEX_HOME: "/tmp/shared-auth" }),
  );
  assert.throws(() => settings({ MARKDOWN_AGENT_STATE_DIR: "../data" }));
  assert.throws(() => settings({ MARKDOWN_AGENT_DAILY_LIMIT: "-1" }));
  assert.equal(childEnvironment(config, false).AGENTMAIL_API_KEY, undefined);
  assert.equal(childEnvironment(config).OPENAI_API_KEY, undefined);
});

test("configure preserves cutoff and receipts and serializes competing runs", async (t) => {
  const { config } = await fixture(t);
  const before = await loadState(config);
  await configure(config);
  assert.equal((await loadState(config)).startAfter, before.startAfter);
  await withLock(config, async () => {
    await assert.rejects(
      withLock(config, async () => {}),
      /Runner lock exists/,
    );
  });
  const mode = (await import("node:fs/promises")).stat;
  assert.equal(
    (await mode(join(config.state, "state.json"))).mode & 0o777,
    0o600,
  );
});

test("disabled and idle polling spend no model launches", async (t) => {
  const { config } = await fixture(t);
  const execute = () => assert.fail("Idle polling must not invoke the model");
  const request = async () => ({ messages: [] });
  assert.equal(
    await processOne(
      { ...config, enabled: false },
      { request: () => assert.fail("disabled must not read mail"), execute },
    ),
    "disabled",
  );
  assert.equal(await processOne(config, { request, execute }), "idle");
  assert.deepEqual((await loadState(config)).usage, {});
});

test("pending scans pages, excludes old/other recipients, and rejects foreign inbox results", async (t) => {
  const { config, message } = await fixture(t);
  const state = await loadState(config);
  let reads = 0;
  const result = await pending(
    { ...config, allowedSenders: ["requester@example.com"] },
    state,
    async () =>
      ++reads === 1
        ? {
            messages: [
              { ...message, from: config.inbox },
              { ...message, from: "unlisted@example.com" },
            ],
            next_page_token: "page2",
          }
        : {
            messages: [
              message,
              {
                ...message,
                message_id: "old",
                timestamp: "2000-01-01T00:00:00Z",
              },
            ],
          },
  );
  assert.equal(result.length, 1);
  assert.equal(reads, 2);
  await assert.rejects(
    pending(config, state, async () => ({
      messages: [{ ...message, inbox_id: "jeffcao@agentmail.to" }],
    })),
    /different inbox/,
  );
  await assert.rejects(
    pending(config, state, async () => ({
      messages: [],
      next_page_token: "same",
    })),
    /pagination/,
  );
});

test("agent failure consumes one launch and is never automatically retried", async (t) => {
  const { config, message } = await fixture(t);
  let calls = 0;
  const request = async () => message;
  const execute = async () => {
    calls++;
    throw new Error("Simulated uncertain send");
  };
  assert.equal(
    await processOne(config, {
      messageId: message.message_id,
      request,
      execute,
    }),
    "review_required",
  );
  assert.equal(
    await processOne(config, {
      messageId: message.message_id,
      request,
      execute,
    }),
    "already_claimed",
  );
  assert.equal(calls, 1);
  assert.equal(
    (await loadState(config)).jobs[jobKey(config, message.message_id)].status,
    "review_required",
  );
  assert.equal(
    await processOne({ ...config, dailyLimit: 1 }, { request, execute }),
    "daily_limit",
  );
});

test("receipt validation requires provider-side thread, recipient and nonempty ZIP evidence", async (t) => {
  const { config, message } = await fixture(t);
  const result = {
    outcome: "sent",
    reply_message_id: "<reply@test>",
    attached_count: 2,
  };
  const reply = {
    inbox_id: config.inbox,
    message_id: result.reply_message_id,
    thread_id: message.thread_id,
    in_reply_to: message.message_id,
    labels: ["sent"],
    to: ["requester@example.com"],
    attachments: [{ filename: "result.zip", size: 100 }],
  };
  assert.equal(
    await verifyResult(config, message, result, async () => reply),
    "provider_accepted",
  );
  for (const changed of [
    { to: ["attacker@example.com"] },
    { thread_id: "other" },
    { in_reply_to: "other" },
    { attachments: [] },
    { attachments: [{ filename: "result.zip", size: 0 }] },
    { cc: ["extra@example.com"] },
  ])
    await assert.rejects(
      verifyResult(config, message, result, async () => ({
        ...reply,
        ...changed,
      })),
    );
  assert.equal(
    await verifyResult(config, message, {
      outcome: "blocked",
      reply_message_id: null,
      attached_count: 0,
    }),
    "review_required",
  );
});

test("a validated reply is claimed persistently and not sent twice", async (t) => {
  const { config, message } = await fixture(t);
  const result = {
    outcome: "partial",
    reply_message_id: "reply",
    attached_count: 1,
  };
  const request = async (_config, path) =>
    path.endsWith("/reply")
      ? {
          inbox_id: config.inbox,
          message_id: "reply",
          thread_id: message.thread_id,
          in_reply_to: message.message_id,
          labels: ["sent"],
          to: ["requester@example.com"],
          attachments: [{ filename: "result.zip", size: 100 }],
        }
      : message;
  const execute = async () => result;
  assert.equal(
    await processOne(config, {
      messageId: message.message_id,
      request,
      execute,
    }),
    "partial_provider_accepted",
  );
  assert.equal(
    await processOne(config, {
      messageId: message.message_id,
      request,
      execute: () => assert.fail("duplicate launch"),
    }),
    "already_claimed",
  );
});

test("read helper never includes provider payloads or credentials in errors", async () => {
  const config = settings({
    MARKDOWN_AGENT_API_KEY: "fixture-secret-never-real",
  });
  await assert.rejects(
    api(config, "", async () => {
      throw new Error(config.key);
    }),
    (error) => !error.message.includes(config.key),
  );
  await assert.rejects(
    api(config, "", async () => ({ ok: false, status: 403 })),
    /HTTP 403/,
  );
});

test("unit uses a distinct service and does not embed credentials", () => {
  const config = settings({
    MARKDOWN_AGENT_API_KEY: "fixture-secret-never-real",
  });
  const unit = serviceUnit(config);
  assert.ok(!unit.includes(config.key));
  assert.ok(unit.includes("KillMode=control-group"));
  assert.ok(timerUnit.includes("Unit=senpilot-markdown-agent.service"));
  assert.ok(!timerUnit.includes("Unit=senpilot-agent.service"));
});

test("real launcher uses stdin, dedicated auth/workspace and private logs without a real inference", async (t) => {
  const { config, message } = await fixture(t);
  const fakeCli = join(config.directory, "fake-codex");
  await writeFile(
    fakeCli,
    `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
let prompt = '';
process.stdin.on('data', chunk => prompt += chunk);
process.stdin.on('end', () => {
  if (!prompt.includes('SENPILOT_AGENT.md') || !prompt.includes('reply_to_message') ||
      !args.includes('workspace-write') || !args.includes('--ephemeral') ||
      !process.cwd().endsWith('/data/work') || !process.env.CODEX_HOME.endsWith('/data/codex') ||
      process.env.OPENAI_API_KEY || args.some(arg => arg.includes('fixture-secret-never-real')))
    process.exit(2);
  fs.writeFileSync(args[args.indexOf('--output-last-message') + 1], JSON.stringify({outcome:'blocked',reply_message_id:null,attached_count:0}));
  console.log('private fixture transcript');
});
`,
    { mode: 0o700 },
  );
  const result = await executeAgent(
    { ...config, codex: fakeCli, key: "fixture-secret-never-real" },
    message.message_id,
    jobKey(config, message.message_id),
  );
  assert.equal(result.outcome, "blocked");
  const log = await readFile(
    join(
      config.work,
      "requests",
      jobKey(config, message.message_id),
      "agent.log",
    ),
    "utf8",
  );
  assert.equal(log.trim(), "private fixture transcript");
});
