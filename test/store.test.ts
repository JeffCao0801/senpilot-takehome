import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JobStore } from "../src/store.js";
import { SendUncertainError } from "../src/mail.js";
import type { CollectionResult, IncomingMessage } from "../src/types.js";

const message = (
  id = "request-1",
  inboxId = "agent@agentmail.to",
): IncomingMessage => ({
  inboxId,
  messageId: id,
  threadId: "thread-1",
  from: "Gmail User <requester@example.test>",
  subject: "Fetch matter",
  text: "Exhibits for matter 123",
  timestamp: "2026-10-25T12:00:00Z",
  labels: ["received"],
});
const future = "2099-10-25T12:00:00Z";

test("a definitely rejected send can retry while an uncertain send cannot", (t) => {
  const store = new JobStore(":memory:");
  t.after(() => store.close());
  store.enqueue(message());
  const job = store.claimNext({ dailyCap: 5, now: future })!;
  store.markSending(job.id);
  store.retryRejectedSend(job.id, new Error("HTTP 429"), 1000, future);
  assert.equal(store.claimNext({ dailyCap: 5, now: future }), undefined);
  const retried = store.claimNext({
    dailyCap: 5,
    now: "2099-10-25T12:00:01Z",
  })!;
  assert.equal(retried.attempts, 2);
  store.markSending(job.id);
  store.markUncertain(job.id, new SendUncertainError());
  assert.throws(
    () => store.retryRejectedSend(job.id, new Error("unknown outcome")),
    /Invalid job transition/,
  );
});

test("duplicate request key is inbox plus message ID and retains original source content", (t) => {
  const store = new JobStore(":memory:");
  t.after(() => store.close());
  assert.equal(store.enqueue(message("quote' ; DROP TABLE jobs; --")), true);
  assert.equal(
    store.enqueue({
      ...message("quote' ; DROP TABLE jobs; --"),
      from: "changed@example.test",
    }),
    false,
  );
  assert.equal(
    store.enqueue(
      message("quote' ; DROP TABLE jobs; --", "other@agentmail.to"),
    ),
    true,
  );
  assert.equal(store.list().length, 2);
  assert.equal(
    store.has("agent@agentmail.to", "quote' ; DROP TABLE jobs; --"),
    true,
  );
  assert.equal(
    store.has("unrelated@agentmail.to", "quote' ; DROP TABLE jobs; --"),
    false,
  );
  assert.equal(store.has("agent@agentmail.to", "missing"), false);
  assert.equal(
    store.get("agent@agentmail.to", "quote' ; DROP TABLE jobs; --")?.message
      .from,
    message().from,
  );
});

test("recordScan persists messages and cursor atomically, dedupes overlap, and never moves cursor backwards", (t) => {
  const store = new JobStore(":memory:");
  t.after(() => store.close());
  const inboxId = message().inboxId;
  assert.equal(
    store.recordScan(
      inboxId,
      [message(), message("two")],
      "2026-10-25T13:00:00Z",
    ),
    2,
  );
  assert.equal(
    store.recordScan(
      inboxId,
      [message("two"), message("three")],
      "2026-10-25T12:00:00Z",
    ),
    1,
  );
  assert.equal(store.getCursor(inboxId), "2026-10-25T13:00:00.000Z");
  assert.throws(
    () =>
      store.recordScan(
        inboxId,
        [message("four"), message("bad", "other")],
        "2026-10-25T14:00:00Z",
      ),
    /inbox identity/,
  );
  assert.equal(store.get(inboxId, "four"), undefined);
  assert.throws(() =>
    store.recordScan(
      inboxId,
      [message("four"), { ...message("bad"), messageId: "" }],
      "2026-10-25T14:00:00Z",
    ),
  );
  assert.equal(store.get(inboxId, "four"), undefined);
  assert.equal(store.getCursor(inboxId), "2026-10-25T13:00:00.000Z");
});

test("claim and daily budget are atomic across store connections and reset on UTC day boundary", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "store-cap-test-"));
  const path = join(directory, "jobs.sqlite");
  const first = new JobStore(path);
  const second = new JobStore(path);
  t.after(async () => {
    first.close();
    second.close();
    await rm(directory, { recursive: true, force: true });
  });
  first.enqueue(message());
  first.enqueue(message("two"));
  first.enqueue(message("three"));
  const job = first.claimNext({ dailyCap: 1, now: future });
  assert.equal(job?.state, "processing");
  assert.equal(job?.attempts, 1);
  assert.equal(second.claimNext({ dailyCap: 1, now: future }), undefined);
  assert.equal(second.dailyCount("2099-10-25"), 1);
  assert.equal(
    second.claimNext({ dailyCap: 1, now: "2099-10-26T00:00:00Z" })?.messageId,
    "two",
  );
  assert.equal(first.dailyCount("2099-10-26"), 1);
  assert.throws(() => first.claimNext({ dailyCap: -1 }), /Daily cap/);
});

test("retry waits until eligible, counts attempts, and sending cannot be retried", (t) => {
  const store = new JobStore(":memory:");
  t.after(() => store.close());
  store.enqueue(message());
  const job = store.claimNext({ dailyCap: 5, now: future })!;
  store.retry(
    job.id,
    new Error("Transient collection failure"),
    60_000,
    future,
  );
  assert.equal(
    store.claimNext({ dailyCap: 5, now: "2099-10-25T12:00:59Z" }),
    undefined,
  );
  const retried = store.claimNext({
    dailyCap: 5,
    now: "2099-10-25T12:01:00Z",
  })!;
  assert.equal(retried.id, job.id);
  assert.equal(retried.attempts, 2);
  assert.equal(retried.error?.message, "Transient collection failure");
  store.markSending(job.id);
  assert.throws(
    () => store.retry(job.id, "unsafe resend"),
    /Invalid job transition/,
  );
  store.markUncertain(job.id, new SendUncertainError());
  assert.equal(store.getById(job.id)?.state, "uncertain");
  assert.equal(store.claimNext({ dailyCap: 100, now: future }), undefined);
});

test("restart preserves request/result/receipt/error and quarantines interrupted sends", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "store-restart-test-"));
  const path = join(directory, "jobs.sqlite");
  t.after(() => rm(directory, { recursive: true, force: true }));
  let store = new JobStore(path);
  store.enqueue(message("completed"));
  store.enqueue(message("collecting"));
  store.enqueue(message("sending"));
  store.enqueue(message("failed"));
  const done = store.claimNext({ dailyCap: 10, now: future })!;
  const request = { matterNumber: "123", category: "Exhibits" as const };
  const result: CollectionResult = {
    request,
    status: "empty",
    documents: [],
    failures: [],
    selectedDocumentIds: [],
    selectionOrder: "source order",
    observedAt: future,
    runDirectory: "/local/runtime",
    warnings: [],
  };
  store.setRequest(done.id, request);
  store.saveResult(done.id, result);
  store.markSending(done.id);
  store.complete(done.id, { messageId: "outgoing", threadId: "thread-1" });
  const collecting = store.claimNext({ dailyCap: 10, now: future })!;
  const sending = store.claimNext({ dailyCap: 10, now: future })!;
  store.markSending(sending.id);
  const failed = store.claimNext({ dailyCap: 10, now: future })!;
  store.fail(failed.id, new TypeError("Definite validation error"));
  store.close();
  store = new JobStore(path);
  try {
    assert.equal(store.getById(sending.id)?.state, "sending");
    assert.equal(store.claimNext({ dailyCap: 10, now: future }), undefined);
    assert.deepEqual(store.recoverInterrupted(), { processing: 1, sending: 1 });
    assert.equal(store.getById(collecting.id)?.state, "retry");
    assert.equal(store.getById(sending.id)?.state, "uncertain");
    assert.deepEqual(store.getById(done.id)?.request, request);
    assert.deepEqual(store.getById(done.id)?.result, result);
    assert.deepEqual(store.getById(done.id)?.receipt, {
      messageId: "outgoing",
      threadId: "thread-1",
    });
    assert.deepEqual(store.getById(failed.id)?.error, {
      name: "TypeError",
      message: "Definite validation error",
    });
    assert.equal(
      store.claimNext({ dailyCap: 10, now: future })?.id,
      collecting.id,
    );
    assert.deepEqual(store.recoverInterrupted(), { processing: 1, sending: 0 });
    // Receipt from explicit external reconciliation is the only supported uncertain -> complete path.
    store.complete(sending.id, {
      messageId: "reconciled",
      threadId: "thread-1",
    });
    assert.equal(store.getById(sending.id)?.state, "complete");
  } finally {
    store.close();
  }
});

test("completion requires sending state and a receipt; terminal requests never claim again", (t) => {
  const store = new JobStore(":memory:");
  t.after(() => store.close());
  store.enqueue(message());
  const job = store.get(message().inboxId, message().messageId)!;
  assert.throws(
    () => store.complete(job.id, { messageId: "outgoing" }),
    /Invalid job transition/,
  );
  store.claimNext({ dailyCap: 1, now: future });
  store.markSending(job.id);
  assert.throws(
    () => store.complete(job.id, { messageId: "" }),
    /verified send receipt/,
  );
  store.complete(job.id, { messageId: "outgoing" });
  assert.equal(store.enqueue(message()), false);
  assert.equal(store.claimNext({ dailyCap: 10, now: future }), undefined);
});
