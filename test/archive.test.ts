import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unzipSync } from "fflate";
import {
  safeFilename,
  verifyDocument,
  sha256,
  packageDocuments,
  detectMediaExtension,
} from "../src/archive.js";

test("recording extension is inferred from file bytes when the source omits it", () => {
  assert.equal(detectMediaExtension(Buffer.from("ID3\x04\x00test")), ".mp3");
  assert.equal(detectMediaExtension(Buffer.from("RIFF0000WAVEfmt ")), ".wav");
  assert.equal(
    detectMediaExtension(
      Buffer.from("3026b2758e66cf11a6d900aa0062ce6c", "hex"),
    ),
    ".wma",
  );
  assert.equal(
    detectMediaExtension(Buffer.from("<html>error</html>")),
    undefined,
  );
});

test("rejects error pages and invalid PDF signatures", () => {
  assert.throws(
    () => verifyDocument(Buffer.from("<html>expired</html>"), "sample.pdf"),
    /HTML/,
  );
  assert.throws(
    () => verifyDocument(Buffer.from("failure"), "sample.pdf"),
    /signature/,
  );
  assert.throws(() => verifyDocument(new Uint8Array(), "sample.pdf"), /empty/);
  verifyDocument(Buffer.from("%PDF-1.4\nfixture"), "sample.pdf");
  assert.equal(safeFilename("12", "../../outside.pdf"), "12-outside.pdf");
});

test("archive matches verified documents and detects changes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "senpilot-archive-"));
  try {
    const bytes = Buffer.from("%PDF-1.4\nfixture");
    const path = join(directory, "42.pdf");
    await writeFile(path, bytes);
    const document = {
      documentId: "42",
      title: "Fixture",
      filename: "42.pdf",
      path,
      bytes: bytes.length,
      sha256: sha256(bytes),
    };
    const zipped = await packageDocuments([document], directory, "M12205");
    assert.deepEqual(Object.keys(unzipSync(await readFile(zipped.path))), [
      "42.pdf",
    ]);
    await writeFile(path, Buffer.from("%PDF-1.4\nmodified"));
    await assert.rejects(
      packageDocuments([document], directory, "changed"),
      /changed/,
    );
    await assert.rejects(packageDocuments([], directory, "empty"), /empty/);
    await assert.rejects(
      packageDocuments(Array(11).fill(document), directory, "many"),
      /at most 10/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
