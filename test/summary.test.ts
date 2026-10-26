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
  assert.match(text, /No ZIP is attached/);
  assert.doesNotMatch(text, /ZIP attached to this reply/);
  assert.doesNotMatch(text, /\/private/);
});

const downloaded: CollectionResult = {
  ...result,
  status: "complete",
  request: { matterNumber: "M12205", category: "Exhibits" },
  counts: { ...result.counts!, Exhibits: 1 },
  selectedDocumentIds: ["A-1"],
  zipPath: "/private/archive.zip",
  documents: ["primary.pdf", "appendix.pdf"].map((filename) => ({
    documentId: "A-1",
    title: "Application",
    filename,
    path: `/private/${filename}`,
    bytes: 100,
    sha256: "test-hash",
  })),
};

test("reply leads with delivery and distinguishes files from multi-attachment source entries", () => {
  const text = renderReply(downloaded);
  assert.match(text, /^Attached 2 verified files for M12205 — Exhibits/);
  assert.match(
    text,
    /Selected 1 of 1 source entries.*downloaded 2 verified files/,
  );
  assert.match(text, /Files in the attached ZIP/);
  assert.match(text, /primary\.pdf/);
  assert.doesNotMatch(text, /2 of 1.*files|\/private/);
});

test("unattached verified files and packaging failures never appear included in a ZIP", () => {
  for (const value of [{ ...downloaded, zipPath: undefined }, downloaded]) {
    const text = renderReply(value, { attachment: false });
    assert.match(text, /no ZIP is attached/);
    assert.match(text, /downloaded locally \(not attached\)/);
    assert.doesNotMatch(text, /Files in the attached ZIP|Included documents/);
  }
  assert.match(
    renderReply({ ...downloaded, zipPath: undefined }, { attachment: true }),
    /no ZIP is attached/,
  );
});

test("partial replies explain failures without browser internals or duplicate delivery warnings", () => {
  const issue = "The ZIP could not be attached.";
  const text = renderReply(
    {
      ...downloaded,
      status: "partial",
      failures: [
        {
          documentId: "A-2",
          reason: "locator.click: Timeout 30000ms exceeded at /private/profile",
        },
        {
          documentId: "A-3",
          reason:
            "Download was cancelled after exceeding the configured byte budget",
        },
      ],
      warnings: [issue, issue],
    },
    { attachment: false, deliveryIssue: issue },
  );
  assert.match(text, /source website did not complete this download/);
  assert.match(text, /configured download size limit/);
  assert.doesNotMatch(text, /locator\.click|30000|\/private/);
  assert.equal(text.split(issue).length - 1, 1);
});
test("delivery issue is explicit and cannot claim an attachment", () => {
  const text = renderReply(
    { ...result, status: "partial" },
    { attachment: false, deliveryIssue: "File too large" },
  );
  assert.match(text, /File too large/);
  assert.doesNotMatch(text, /ZIP attached to this reply/);
});
