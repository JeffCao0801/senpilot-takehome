import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unzipSync, zipSync } from "fflate";
import {
  AgentMailClient,
  AgentMailHttpError,
  MAX_REMOTE_ATTACHMENT_BYTES,
  MAX_SEND_BYTES,
  SendUncertainError,
} from "../src/mail.js";
import type { IncomingMessage } from "../src/types.js";

const inboxId = "agent@agentmail.to";
const message: IncomingMessage = {
  inboxId,
  messageId: "<request@example.test>",
  threadId: "thread-1",
  from: "Gmail User <requester@example.test>",
  subject: "Request",
  text: "Collect exhibits",
  timestamp: "2026-10-25T12:00:00Z",
  labels: ["received"],
  headers: { "Reply-To": "attacker@example.test", cc: "copied@example.test" },
};
const raw = (
  id = message.messageId,
  overrides: Record<string, unknown> = {},
) => ({
  inbox_id: inboxId,
  message_id: id,
  thread_id: "thread-1",
  from: message.from,
  timestamp: message.timestamp,
  subject: message.subject,
  labels: ["received"],
  text: message.text,
  ...overrides,
});
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
const client = () =>
  new AgentMailClient({ apiKey: "unit-test-placeholder", inboxId });
const uploadUrl = "https://storage.example.test/upload?signature=upload-secret";
const downloadUrl =
  "https://storage.example.test/archive?signature=download-secret";
const hourFromNow = () => new Date(Date.now() + 60 * 60 * 1000).toISOString();
const driveUpload = (metadata: Record<string, unknown>) => ({
  method: "PUT",
  url: uploadUrl,
  expires_at: hourFromNow(),
  headers: {
    "Content-Length": String(metadata.size),
    "Content-Type": "application/zip",
    "If-None-Match": "*",
    "x-amz-checksum-sha256": metadata.sha256,
    "x-amz-tagging": "upload-state=pending",
  },
});
const driveFile = (
  metadata: Record<string, unknown>,
  status = "pending",
  overrides: Record<string, unknown> = {},
) => ({
  ...metadata,
  inbox_id: inboxId,
  file_id: "file-1",
  status,
  ...(status === "pending"
    ? { upload: driveUpload(metadata) }
    : { download_url: downloadUrl, download_expires_at: hourFromNow() }),
  ...overrides,
});
async function zipFixture(
  t: TestContext,
  size = 4_500_000,
): Promise<{ path: string; bytes: Buffer }> {
  const directory = await mkdtemp(join(tmpdir(), "mail-drive-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const bytes = Buffer.from(
    zipSync({ "exhibit.txt": new Uint8Array(size).fill(65) }, { level: 0 }),
  );
  const path = join(directory, "result.zip");
  await writeFile(path, bytes);
  return { path, bytes };
}

test("incoming scan paginates, hydrates HTML safely, retains identities, and excludes outgoing messages", async (t) => {
  const urls: URL[] = [];
  t.mock.method(
    globalThis,
    "fetch",
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      urls.push(url);
      assert.equal(init?.method, "GET");
      assert.ok(init?.signal);
      if (url.pathname.endsWith("/messages")) {
        assert.equal(url.searchParams.get("labels"), "received");
        assert.equal(url.searchParams.get("after"), "2026-10-24T00:00:00Z");
        return url.searchParams.has("page_token")
          ? json({ messages: [raw("older"), raw("outgoing")], count: 2 })
          : json({ messages: [raw()], count: 1, next_page_token: "next/&" });
      }
      const id = decodeURIComponent(url.pathname.split("/").at(-1)!);
      if (id === "older")
        return json(
          raw(id, {
            text: undefined,
            timestamp: "2026-10-24T12:00:00Z",
            html: '<style>hidden</style><script>fetch("https://evil.test")</script><p>Matter &amp; &#x31;23</p><img src="https://evil.test/track"><p>Exhibits</p>',
            headers: { "Auto-Submitted": "no" },
            in_reply_to: "prior-message",
          }),
        );
      if (id === "outgoing") return json(raw(id, { labels: ["sent"] }));
      return json(raw(id));
    },
  );
  const messages = await client().listIncoming({
    after: "2026-10-24T00:00:00Z",
  });
  assert.equal(messages.length, 2);
  assert.equal(messages[0]?.messageId, "older");
  assert.equal(messages[0]?.text, "Matter & 123\n\nExhibits");
  assert.equal(messages[0]?.inReplyTo, "prior-message");
  assert.equal(messages[0]?.headers?.["Auto-Submitted"], "no");
  assert.equal(messages[1]?.from, message.from);
  assert.equal(messages[1]?.inboxId, inboxId);
  assert.equal(messages[1]?.threadId, message.threadId);
  assert.equal(urls.length, 5);
  assert.ok(
    urls.some((url) => url.searchParams.get("page_token") === "next/&"),
  );
});

test("verifyAccess uses message-read scope without GET inbox metadata", async (t) => {
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    assert.match(String(input), /\/messages\?limit=1$/);
    return json({ count: 1, messages: [raw()] });
  });
  assert.deepEqual(await client().verifyAccess(), { messageCount: 1 });
});

test("journaled message IDs are skipped before fetching their bodies", async (t) => {
  const requests: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    const url = String(input);
    requests.push(url);
    if (new URL(url).pathname.endsWith("/messages"))
      return json({ messages: [raw("known"), raw("new")], count: 2 });
    assert.ok(url.endsWith("/new"));
    return json(raw("new"));
  });
  const result = await client().listIncoming({
    skipMessage: (id) => id === "known",
  });
  assert.deepEqual(
    result.map((m) => m.messageId),
    ["new"],
  );
  assert.equal(requests.length, 2);
});

test("hydration identity mismatch and repeating pagination fail the whole scan", async (t) => {
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) =>
    String(input).includes("?")
      ? json({ messages: [raw()] })
      : json(raw("different")),
  );
  await assert.rejects(client().listIncoming(), /identity mismatch/);
  t.mock.restoreAll();
  t.mock.method(globalThis, "fetch", async () =>
    json({ messages: [], next_page_token: "same" }),
  );
  await assert.rejects(client().listIncoming(), /pagination token/);
});

test("reply targets only original sender, sets official idempotency header, and encodes exact ZIP bytes", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "mail-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const bytes = Buffer.from([0x50, 0x4b, 3, 4, 0, 255]);
  const path = join(directory, "result.zip");
  await writeFile(path, bytes);
  let idempotencyKey = "";
  let sends = 0;
  t.mock.method(
    globalThis,
    "fetch",
    async (input: string | URL | Request, init?: RequestInit) => {
      sends++;
      assert.match(String(input), /%3Crequest%40example.test%3E\/reply$/);
      assert.equal(init?.method, "POST");
      const headers = new Headers(init?.headers);
      const key = headers.get("Idempotency-Key")!;
      assert.match(key, /^[a-f0-9]{64}$/);
      if (idempotencyKey) assert.equal(key, idempotencyKey);
      idempotencyKey = key;
      const body = JSON.parse(init?.body as string);
      assert.deepEqual(Object.keys(body).sort(), [
        "attachments",
        "reply_all",
        "text",
        "to",
      ]);
      assert.deepEqual(body.to, ["requester@example.test"]);
      assert.equal(body.reply_all, false);
      assert.equal(body.text, "Reply to somebody else@example.test");
      assert.equal(body.attachments[0].content_type, "application/zip");
      assert.deepEqual(
        Buffer.from(body.attachments[0].content, "base64"),
        bytes,
      );
      assert.equal(body.attachments[0].filename, "result.zip");
      return json({ message_id: "sent-message", thread_id: "thread-1" });
    },
  );
  const mail = client();
  assert.deepEqual(
    await mail.reply(message, "Reply to somebody else@example.test", path),
    { messageId: "sent-message", threadId: "thread-1" },
  );
  // Explicit same logical call has stable key; the client itself never retries a POST.
  await mail.reply(message, "Reply to somebody else@example.test", path);
  assert.equal(sends, 2);
});

test("exact UTF-8 whole request size is checked before sending, including base64 overhead", async (t) => {
  let sentBytes = 0;
  t.mock.method(
    globalThis,
    "fetch",
    async (_input: string | URL | Request, init?: RequestInit) => {
      sentBytes = Buffer.byteLength(init?.body as string);
      return json({ message_id: "sent", thread_id: "thread-1" });
    },
  );
  const overhead = Buffer.byteLength(
    JSON.stringify({
      to: ["requester@example.test"],
      reply_all: false,
      text: "",
    }),
  );
  await client().reply(message, "x".repeat(MAX_SEND_BYTES - overhead));
  assert.equal(sentBytes, MAX_SEND_BYTES);
  sentBytes = 0;
  await assert.rejects(
    client().reply(
      message,
      "é".repeat(Math.ceil((MAX_SEND_BYTES - overhead) / 2) + 1),
    ),
    /No email was sent/,
  );
  assert.equal(sentBytes, 0);
});

test("large ZIP is staged as an actual remote email attachment with exact bytes, checksum and isolated headers", async (t) => {
  const { path, bytes } = await zipFixture(t, 10_360_603);
  let metadata: Record<string, unknown> = {};
  const requests: string[] = [];
  let sends = 0;
  const started = Date.now();
  t.mock.method(
    globalThis,
    "fetch",
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      requests.push(url);
      const headers = new Headers(init?.headers);
      assert.equal(init?.redirect, "error");
      assert.ok(init?.signal);
      if (url === uploadUrl) {
        assert.equal(init?.method, "PUT");
        assert.equal(init?.credentials, "omit");
        assert.deepEqual(init?.headers, driveUpload(metadata).headers);
        assert.equal(headers.has("authorization"), false);
        assert.equal(headers.has("idempotency-key"), false);
        assert.equal(headers.has("accept"), false);
        assert.deepEqual(Buffer.from(init?.body as Uint8Array), bytes);
        assert.equal(
          unzipSync(Buffer.from(init?.body as Uint8Array))["exhibit.txt"]
            ?.length,
          10_360_603,
        );
        return new Response(null, { status: 200 });
      }
      assert.equal(
        headers.get("authorization"),
        "Bearer unit-test-placeholder",
      );
      if (url.endsWith("/files")) {
        assert.equal(init?.method, "POST");
        assert.equal(headers.has("idempotency-key"), false);
        metadata = JSON.parse(init?.body as string);
        assert.deepEqual(Object.keys(metadata).sort(), [
          "content_type",
          "expires_at",
          "path",
          "sha256",
          "size",
        ]);
        assert.equal(metadata.size, bytes.length);
        assert.equal(
          metadata.sha256,
          createHash("sha256").update(bytes).digest("base64"),
        );
        const identity = createHash("sha256")
          .update(JSON.stringify([inboxId, message.messageId]))
          .digest("hex");
        assert.equal(
          metadata.path,
          `replies/${identity}/${createHash("sha256").update(bytes).digest("hex")}.zip`,
        );
        assert.ok(
          Math.abs(
            Date.parse(metadata.expires_at as string) - started - 86_400_000,
          ) < 10_000,
        );
        return json(driveFile(metadata), 201);
      }
      if (url.endsWith("/file-1/complete")) {
        assert.equal(init?.method, "POST");
        assert.equal(headers.has("idempotency-key"), false);
        assert.equal(init?.body, "{}");
        return json(driveFile(metadata, "ready"));
      }
      assert.match(url, /%3Crequest%40example.test%3E\/reply$/);
      sends++;
      const payload = JSON.parse(init?.body as string);
      assert.deepEqual(payload, {
        to: ["requester@example.test"],
        reply_all: false,
        text: "ZIP attached. Body says cc: ignored@example.test",
        attachments: [
          {
            filename: "result.zip",
            content_type: "application/zip",
            url: downloadUrl,
          },
        ],
      });
      assert.equal(
        headers.get("idempotency-key"),
        createHash("sha256")
          .update(JSON.stringify([inboxId, message.messageId]))
          .digest("hex"),
      );
      assert.ok(Buffer.byteLength(init?.body as string) < MAX_SEND_BYTES);
      return json({ message_id: "sent", thread_id: "thread-1" });
    },
  );
  const prepared = await client().prepareReply(
    message,
    "ZIP attached. Body says cc: ignored@example.test",
    path,
  );
  assert.equal(sends, 0);
  assert.equal(requests.length, 3);
  assert.equal(JSON.stringify(prepared), "{}"); // No signed URL exposed by normal object logging.
  assert.deepEqual(await prepared.send(), {
    messageId: "sent",
    threadId: "thread-1",
  });
  assert.equal(sends, 1);
  assert.equal(requests.length, 4);
});

test("retry-safe create can return ready without a PUT or complete", async (t) => {
  const { path } = await zipFixture(t);
  let creates = 0;
  t.mock.method(
    globalThis,
    "fetch",
    async (input: string | URL | Request, init?: RequestInit) => {
      assert.match(String(input), /\/files$/);
      creates++;
      return json(driveFile(JSON.parse(init?.body as string), "ready"));
    },
  );
  const mail = client();
  await mail.prepareReply(message, "body", path);
  await mail.prepareReply(message, "body", path);
  assert.equal(creates, 2);
});

test("stable path conflicts recover existing ready file or retry pending create using original rounded expiry", async (t) => {
  const { path } = await zipFixture(t);
  for (const status of ["ready", "pending", "uploaded"]) {
    let original: Record<string, unknown> = {};
    let creates = 0;
    let gets = 0;
    let puts = 0;
    const oldExpiry = new Date(Date.now() + 23 * 60 * 60 * 1000)
      .toISOString()
      .replace(/\.\d{3}Z$/, ".000Z");
    t.mock.method(
      globalThis,
      "fetch",
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(String(input));
        assert.ok(!url.pathname.endsWith("/reply"));
        if (url.pathname.endsWith("/files") && init?.method === "POST") {
          const payload = JSON.parse(init?.body as string);
          creates++;
          if (creates === 1) {
            original = { ...payload, expires_at: oldExpiry };
            return json({}, 409);
          }
          assert.deepEqual(payload, original);
          return json(
            driveFile(original, status === "uploaded" ? "ready" : "pending"),
          );
        }
        if (url.pathname.endsWith("/files")) {
          assert.equal(url.searchParams.get("path_prefix"), original.path);
          assert.equal(url.searchParams.get("ascending"), "true");
          return json({ files: [{ path: original.path, file_id: "file-1" }] });
        }
        if (String(input) === uploadUrl) {
          puts++;
          return new Response(null, { status: 200 });
        }
        if (url.pathname.endsWith("/complete"))
          return json(driveFile(original, "ready"));
        assert.match(url.pathname, /\/files\/file-1$/);
        gets++;
        return json(
          driveFile(original, status === "uploaded" ? "pending" : status),
        );
      },
    );
    await client().prepareReply(message, "body", path);
    assert.equal(creates, status === "ready" ? 1 : 2);
    assert.equal(gets, 1);
    assert.equal(puts, status === "pending" ? 1 : 0);
    t.mock.restoreAll();
  }
});

test("storage PUT 412 completes and verifies already uploaded ZIP before send", async (t) => {
  const { path } = await zipFixture(t);
  let metadata: Record<string, unknown> = {};
  const steps: string[] = [];
  t.mock.method(
    globalThis,
    "fetch",
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/files")) {
        steps.push("create");
        metadata = JSON.parse(init?.body as string);
        return json(driveFile(metadata));
      }
      if (url === uploadUrl) {
        steps.push("upload");
        return new Response(null, { status: 412 });
      }
      if (url.endsWith("/complete")) {
        steps.push("complete");
        return json(driveFile(metadata, "ready"));
      }
      assert.match(url, /\/reply$/);
      steps.push("send");
      return json({ message_id: "sent", thread_id: "thread-1" });
    },
  );
  await client().reply(message, "body", path);
  assert.deepEqual(steps, ["create", "upload", "complete", "send"]);
});

test("Drive 403 reports inline fallback limitation and never sends an email", async (t) => {
  const { path } = await zipFixture(t);
  const stub = t.mock.method(
    globalThis,
    "fetch",
    async (input: string | URL | Request) => {
      assert.match(String(input), /\/files$/);
      return json({ message: `not enabled ${downloadUrl} sensitive` }, 403);
    },
  );
  await assert.rejects(
    client().reply(message, "body", path),
    (error: unknown) => {
      assert.ok(error instanceof AgentMailHttpError);
      assert.equal(error.status, 403);
      assert.match(error.message, /5800000-byte inline request limit/);
      assert.match(error.message, /No email was sent/);
      assert.doesNotMatch(error.message, /signature|sensitive/);
      return true;
    },
  );
  assert.equal(stub.mock.callCount(), 1);
});

test("ZIP above conservative 25 MB raw limit and an oversized body fail before Drive or sending", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "mail-oversize-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "too-large.zip");
  await writeFile(path, Buffer.alloc(MAX_REMOTE_ATTACHMENT_BYTES + 1));
  const stub = t.mock.method(globalThis, "fetch", async () => {
    throw new Error("Unexpected network");
  });
  await assert.rejects(
    client().reply(message, "body", path),
    /25000000-byte remote attachment limit.*No email was sent/,
  );
  await assert.rejects(
    client().reply(message, "x".repeat(MAX_SEND_BYTES), path),
    /maximum is 5800000/,
  );
  assert.equal(stub.mock.callCount(), 0);
});

test("Drive and storage failures are definite preparation failures, never sending a partial ZIP", async (t) => {
  const { path } = await zipFixture(t);
  for (const failure of [
    "create-network",
    "create-503",
    "create-408",
    "create-json",
    "put-network",
    "put-503",
    "complete-503",
    "complete-json",
    "complete-409",
    "complete-pending",
    "wrong-checksum",
    "already-uploaded-mismatch",
    "wrong-file-id",
    "missing-download",
    "injected-auth",
    "invalid-header",
    "bad-url",
  ]) {
    let metadata: Record<string, unknown> = {};
    let sends = 0;
    t.mock.method(
      globalThis,
      "fetch",
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/reply")) {
          sends++;
          return json({ message_id: "sent", thread_id: "thread-1" });
        }
        if (url.endsWith("/files")) {
          metadata = JSON.parse(init?.body as string);
          if (failure === "create-network")
            throw new Error(`socket ${uploadUrl}`);
          if (failure === "create-503")
            return json({ sensitive: downloadUrl }, 503);
          if (failure === "create-408") return json({}, 408);
          if (failure === "create-json")
            return new Response(`invalid ${downloadUrl}`);
          const upload = driveUpload(metadata);
          const file = driveFile(metadata, "pending", { upload });
          if (failure === "injected-auth")
            Object.assign(upload.headers, {
              Authorization: "Bearer unit-test-placeholder",
            });
          if (failure === "invalid-header")
            Object.assign(upload.headers, {
              "invalid signed-url-secret": "unit-test-placeholder",
            });
          if (failure === "bad-url") upload.url = "invalid signed-url-secret";
          return json(file);
        }
        if (url === uploadUrl) {
          if (failure === "put-network") throw new Error(`socket ${uploadUrl}`);
          return new Response(null, {
            status:
              failure === "put-503"
                ? 503
                : failure === "already-uploaded-mismatch"
                  ? 412
                  : 200,
          });
        }
        if (url.endsWith("/complete")) {
          if (failure === "complete-503") return json({}, 503);
          if (failure === "complete-json")
            return new Response(`invalid ${downloadUrl}`);
          if (
            failure === "complete-409" ||
            failure === "already-uploaded-mismatch"
          )
            return json({}, 409);
          return json(
            driveFile(
              metadata,
              failure === "complete-pending" ? "pending" : "ready",
              {
                ...(failure === "wrong-checksum"
                  ? { sha256: "incorrect" }
                  : {}),
                ...(failure === "wrong-file-id"
                  ? { file_id: "different" }
                  : {}),
                ...(failure === "missing-download"
                  ? { download_url: undefined }
                  : {}),
              },
            ),
          );
        }
        assert.match(url, /\/files\/file-1$/);
        return json(driveFile(metadata, "ready", { download_url: undefined }));
      },
    );
    await assert.rejects(
      client().reply(message, "body", path),
      (error: unknown) => {
        assert.ok(error instanceof Error, failure);
        assert.ok(!(error instanceof SendUncertainError), failure);
        assert.doesNotMatch(
          error.message,
          /signature|upload-secret|download-secret|signed-url-secret|unit-test-placeholder/,
        );
        return true;
      },
    );
    assert.equal(sends, 0, failure);
    t.mock.restoreAll();
  }
});

test("prepared signed URL expires before send and a fresh ready file URL can be recovered", async (t) => {
  const { path } = await zipFixture(t);
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  let metadata: Record<string, unknown> = {};
  const urls: string[] = [];
  t.mock.method(
    globalThis,
    "fetch",
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      urls.push(url);
      if (url.endsWith("/files")) {
        metadata = JSON.parse(init?.body as string);
        return json(
          driveFile(metadata, "ready", {
            download_expires_at: new Date(now - 1000).toISOString(),
          }),
        );
      }
      assert.match(url, /\/files\/file-1$/);
      return json(driveFile(metadata, "ready"));
    },
  );
  const prepared = await client().prepareReply(message, "body", path);
  assert.equal(urls.length, 2);
  now += 60 * 60 * 1000;
  await assert.rejects(prepared.send(), /Prepared attachment URL expired/);
  assert.equal(urls.length, 2);
});

test("invalid or multiple source senders and cross-inbox replies fail without network access", async (t) => {
  const stub = t.mock.method(globalThis, "fetch", async () => {
    throw new Error("Unexpected network");
  });
  for (const from of [
    "one@example.test,two@example.test",
    "User <one@example.test> <two@example.test>",
    "one@example.test\r\nBcc: other@example.test",
    inboxId,
  ]) {
    await assert.rejects(client().reply({ ...message, from }, "body"));
  }
  await assert.rejects(
    client().reply({ ...message, inboxId: "other@agentmail.to" }, "body"),
    /different inbox/,
  );
  assert.equal(stub.mock.callCount(), 0);
});

test("network errors, server failures, and invalid send receipts are uncertain and never retried", async (t) => {
  for (const outcome of [
    "network",
    "server",
    "invalid-json",
    "missing-id",
    "wrong-thread",
    "same-id",
  ]) {
    const stub = t.mock.method(globalThis, "fetch", async () => {
      if (outcome === "network") throw new TypeError("socket closed");
      if (outcome === "server") return json({}, 503);
      if (outcome === "invalid-json") return new Response("not JSON");
      if (outcome === "missing-id") return json({ thread_id: "thread-1" });
      return json({
        message_id: outcome === "same-id" ? message.messageId : "sent",
        thread_id: outcome === "wrong-thread" ? "wrong-thread" : "thread-1",
      });
    });
    await assert.rejects(client().reply(message, "body"), SendUncertainError);
    assert.equal(stub.mock.callCount(), 1);
    t.mock.restoreAll();
  }
});

test("explicit API rejection is definite and does not expose response content", async (t) => {
  t.mock.method(globalThis, "fetch", async () =>
    json({ message: "sensitive mailbox data" }, 403),
  );
  await assert.rejects(client().reply(message, "body"), (error: unknown) => {
    assert.ok(error instanceof AgentMailHttpError);
    assert.equal(error.status, 403);
    assert.doesNotMatch(error.message, /sensitive/);
    return true;
  });
});
