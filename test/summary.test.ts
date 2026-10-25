import test from "node:test";
import assert from "node:assert/strict";
import { renderReply } from "../src/summary.js";
import type { CollectionResult } from "../src/types.js";
const result: CollectionResult = {
  request: { matterNumber: "M12205", category: "Transcripts" },
  status: "empty",
  metadata: { matterNumber: "M12205", title: "Matter title" },
  counts: {
    Exhibits: 13,
    "Key Documents": 6,
    "Other Documents": 43,
    Transcripts: 0,
    Recordings: 0,
  },
  documents: [],
  failures: [],
  selectedDocumentIds: [],
  selectionOrder: "Website order",
  observedAt: "2026-10-25T00:00:00Z",
  runDirectory: "/private",
  warnings: [],
};
test("empty reply gives source counts without promising an attachment", () => {
  const text = renderReply(result);
  assert.match(text, /Total listed entries.*62/);
  assert.match(text, /no ZIP is attached/);
  assert.doesNotMatch(text, /ZIP attached to this reply/);
  assert.doesNotMatch(text, /\/private/);
});
test("delivery issue is explicit and cannot claim an attachment", () => {
  const text = renderReply(
    { ...result, status: "partial" },
    { attachment: false, deliveryIssue: "File too large" },
  );
  assert.match(text, /File too large/);
  assert.doesNotMatch(text, /ZIP attached to this reply/);
});
