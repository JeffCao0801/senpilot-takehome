import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { zipSync, unzipSync } from "fflate";
import type { DocumentFile } from "./types.js";

export function detectMediaExtension(bytes: Uint8Array): string | undefined {
  const b = Buffer.from(bytes.subarray(0, 32));
  if (b.subarray(0, 3).toString() === "ID3") return ".mp3";
  if (b[0] === 0xff && (b[1] & 0xe0) === 0xe0)
    return (b[1] & 0x06) === 0 ? ".aac" : ".mp3";
  if (
    b.subarray(0, 4).toString() === "RIFF" &&
    b.subarray(8, 12).toString() === "WAVE"
  )
    return ".wav";
  if (b.subarray(0, 4).toString() === "OggS") return ".ogg";
  if (b.subarray(4, 8).toString() === "ftyp")
    return /M4A|M4B/.test(b.subarray(8, 16).toString()) ? ".m4a" : ".mp4";
  if (b.subarray(0, 16).toString("hex") === "3026b2758e66cf11a6d900aa0062ce6c")
    return ".wma";
  if (b.subarray(0, 4).toString("hex") === "1a45dfa3") return ".webm";
  return undefined;
}

export function safeFilename(
  documentId: string,
  original: string,
  index = 0,
): string {
  const name = basename(original.replaceAll("\\", "/"))
    .replace(/[^a-zA-Z0-9._ -]/g, "_")
    .slice(0, 140);
  const id = documentId.replace(/[^a-zA-Z0-9_-]/g, "_");
  return `${id}${index ? `-${index + 1}` : ""}-${name || "document.bin"}`;
}

export function verifyDocument(bytes: Uint8Array, filename: string): void {
  if (!bytes.length) throw new Error("Downloaded file is empty");
  const start = Buffer.from(bytes.subarray(0, 1024))
    .toString("utf8")
    .trimStart();
  if (
    /^(?:<!doctype\s+html|<html|<head|<body|<\?xml[^>]*>\s*<html)/i.test(start)
  ) {
    throw new Error("Download returned an HTML page instead of a document");
  }
  const ext = extname(filename).toLowerCase();
  const isZip = bytes[0] === 0x50 && bytes[1] === 0x4b;
  if (
    ext === ".pdf" &&
    !Buffer.from(bytes.subarray(0, 1024)).includes(Buffer.from("%PDF-"))
  ) {
    throw new Error("Downloaded PDF has an invalid file signature");
  }
  if ([".zip", ".docx", ".xlsx", ".pptx"].includes(ext) && !isZip) {
    throw new Error("Downloaded ZIP/Office file has an invalid file signature");
  }
}

export const sha256 = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

export async function packageDocuments(
  documents: DocumentFile[],
  directory: string,
  name: string,
): Promise<{ path: string; bytes: number }> {
  if (!documents.length) throw new Error("Refusing to create an empty archive");
  if (documents.length > 10)
    throw new Error("An archive may contain at most 10 documents");
  const entries: Record<string, Uint8Array> = Object.create(null);
  let total = 0;
  for (const document of documents) {
    if (
      basename(document.filename) !== document.filename ||
      /[\\/]/.test(document.filename)
    )
      throw new Error("Unsafe archive filename");
    if (entries[document.filename])
      throw new Error("Duplicate archive filename");
    const bytes = await readFile(document.path);
    verifyDocument(bytes, document.filename);
    if (sha256(bytes) !== document.sha256 || bytes.length !== document.bytes)
      throw new Error("Document changed after verification");
    total += bytes.length;
    if (total > 50 * 1024 * 1024)
      throw new Error("Archive input exceeds the 50 MiB processing limit");
    entries[document.filename] = bytes;
  }
  const archive = zipSync(entries, { level: 6 });
  const decoded = unzipSync(archive);
  if (Object.keys(decoded).length !== documents.length)
    throw new Error("ZIP entry count does not match successful downloads");
  for (const document of documents) {
    if (
      !decoded[document.filename] ||
      sha256(decoded[document.filename]) !== document.sha256
    )
      throw new Error("ZIP integrity verification failed");
  }
  const path = join(directory, `${name.replace(/[^a-zA-Z0-9_-]/g, "_")}.zip`);
  await writeFile(path, archive, { mode: 0o600 });
  return { path, bytes: archive.length };
}
