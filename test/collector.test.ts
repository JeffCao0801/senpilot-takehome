import test from "node:test";
import assert from "node:assert/strict";
import {
  parseCategoryCounts,
  parseDocumentFields,
  collectDocuments,
} from "../src/collector.js";
test("reads all category counts from current tab labels", () => {
  assert.deepEqual(
    parseCategoryCounts([
      "Exhibits - 1,234",
      "Key Documents - 2",
      "Other Documents - 5",
      "Transcripts - 0",
      "Recordings - 0",
    ]),
    {
      Exhibits: 1234,
      "Key Documents": 2,
      "Other Documents": 5,
      Transcripts: 0,
      Recordings: 0,
    },
  );
  assert.throws(() => parseCategoryCounts(["Exhibits - 13"]), /Key Documents/);
});
test("invalid inputs are rejected before launching a browser", async () => {
  await assert.rejects(
    collectDocuments({ matterNumber: "../../file", category: "Exhibits" }),
    /Invalid/,
  );
  await assert.rejects(
    collectDocuments(
      { matterNumber: "M12205", category: "Exhibits" },
      { limit: 11 },
    ),
    /between 1 and 10/,
  );
});
test("extracts document identity from both observed WebDirect row layouts", () => {
  assert.deepEqual(
    parseDocumentFields([
      "102674",
      "Board Order",
      "07/08/2026",
      "Public",
      ".pdf",
    ]),
    {
      documentId: "102674",
      title: "Board Order",
      date: "07/08/2026",
      security: "Public",
      extension: ".pdf",
    },
  );
  assert.deepEqual(
    parseDocumentFields([
      "Notice of Paper Hearing",
      "04/11/2025",
      "Public",
      "97289",
      ".pdf",
    ]),
    {
      documentId: "97289",
      title: "Notice of Paper Hearing",
      date: "04/11/2025",
      security: "Public",
      extension: ".pdf",
    },
  );
  assert.equal(parseDocumentFields(["No matching records"]), undefined);
  assert.deepEqual(
    parseDocumentFields(
      ["Application", "07/10/2025", "Public", "A-1", ".pdf"],
      "A-1",
    ),
    {
      documentId: "A-1",
      title: "Application",
      date: "07/10/2025",
      security: "Public",
      extension: ".pdf",
    },
  );
  assert.equal(
    parseDocumentFields(
      ["Affidavit", "08/18/2025", "Public", "A -5", ".pdf"],
      "A -5",
    )?.documentId,
    "A -5",
  );
  assert.deepEqual(
    parseDocumentFields(
      [
        "09/12/2022",
        "September 12, 2022",
        "Evening Session",
        "Pdf",
        "",
        "Public",
      ],
      "09/12/2022",
    ),
    {
      documentId: "09/12/2022",
      title: "September 12, 2022 — Evening Session",
      date: "09/12/2022",
      security: "Public",
      extension: ".pdf",
    },
  );
});
