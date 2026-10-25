import {
  chromium,
  type Browser,
  type Download,
  type Locator,
  type Page,
} from "playwright";
import {
  mkdir,
  readFile,
  readdir,
  stat,
  writeFile,
  rm,
  rename,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import {
  CATEGORIES,
  type AgentRequest,
  type CollectionResult,
  type Counts,
  type MatterMetadata,
} from "./types.js";
import {
  packageDocuments,
  safeFilename,
  sha256,
  verifyDocument,
  detectMediaExtension,
} from "./archive.js";

export interface CollectorOptions {
  outputDirectory?: string;
  headless?: boolean;
  limit?: number;
  timeoutMs?: number;
  maxFileBytes?: number;
  log?: (event: Record<string, unknown>) => void;
}
const DATABASE_URL = "https://uarb.novascotia.ca/fmi/webd/UARB15";
const clean = (s: string): string => s.replace(/\u00a0/g, " ").trim();
const errorText = (e: unknown): string =>
  e instanceof Error ? e.message.split("\n")[0] : String(e);

export async function waitForBoundedDownload(
  download: Download,
  directory: string,
  maxBytes: number,
): Promise<void> {
  let tooLarge = false;
  let monitoring = false;
  let monitorWork = Promise.resolve();
  const monitor = setInterval(() => {
    if (monitoring) return;
    monitoring = true;
    monitorWork = (async () => {
      try {
        const sizes = await Promise.all(
          (await readdir(directory)).map((name) =>
            stat(join(directory, name))
              .then((s) => s.size)
              .catch(() => 0),
          ),
        );
        if (sizes.reduce((sum, size) => sum + size, 0) > maxBytes) {
          tooLarge = true;
          await download.cancel();
        }
      } finally {
        monitoring = false;
      }
    })().catch(() => {});
  }, 100);
  let failure: string | null;
  try {
    failure = await download.failure();
  } finally {
    clearInterval(monitor);
    await monitorWork;
  }
  if (tooLarge || failure) await download.delete().catch(() => {});
  if (tooLarge)
    throw new Error(
      "Download was cancelled after exceeding the configured byte budget",
    );
  if (failure) throw new Error(`Browser download failed: ${failure}`);
}

export function parseCategoryCounts(names: string[]): Counts {
  const counts = {} as Counts;
  for (const category of CATEGORIES) {
    const line = names.find((n) => n.startsWith(category + " -"));
    const match = line?.match(/-\s*([\d,]+)\s*$/);
    if (!match)
      throw new Error(`Could not read ${category} count from the website`);
    counts[category] = Number(match[1].replaceAll(",", ""));
  }
  return counts;
}

async function readMetadata(
  page: Page,
  expected: string,
): Promise<MatterMetadata> {
  const fields = await page.locator(".fm-textarea").evaluateAll((elements) =>
    elements.map((el) => ({
      text: (el.querySelector(".text")?.textContent ?? "").trim(),
      x: el.getBoundingClientRect().x,
      y: el.getBoundingClientRect().y,
    })),
  );
  const matter = fields.find((f) => /^M\d{5}$/.test(f.text));
  if (!matter || matter.text !== expected)
    throw new Error("Displayed matter number does not match the request");
  const right = fields
    .filter((f) => f.x > 400)
    .sort((a, b) => a.x - b.x || a.y - b.y);
  const category = right.find(
    (f) => f.x < 715 && Math.abs(f.y - matter.y) < 12,
  )?.text;
  const type = right.find((f) => f.x < 715 && f.y > matter.y + 15)?.text;
  const dates = right
    .filter((f) => /^\d{2}\/\d{2}\/\d{4}$/.test(f.text))
    .sort((a, b) => a.x - b.x);
  const status = fields.find((f) => f.x < 100 && f.y > matter.y + 15)?.text;
  const outcome = right.find((f) => f.x > 900)?.text;
  const titles = await page.locator(".v-label").evaluateAll((elements) =>
    elements.map((el) => ({
      text: (el.textContent ?? "").trim(),
      x: el.getBoundingClientRect().x,
      y: el.getBoundingClientRect().y,
    })),
  );
  const title = titles.find(
    (f) => f.x > 100 && f.x < 520 && Math.abs(f.y - matter.y) < 16,
  )?.text;
  if (!title) throw new Error("Could not identify the matter title");
  return {
    matterNumber: expected,
    title,
    status,
    type,
    category,
    dateReceived: dates[0]?.text,
    dateFinal: dates[1]?.text,
    outcome,
  };
}

async function searchMatter(
  page: Page,
  number: string,
  timeout: number,
): Promise<boolean> {
  await page.goto(DATABASE_URL, { waitUntil: "domcontentloaded", timeout });
  await page
    .getByText("Go Directly to Matter", { exact: true })
    .waitFor({ timeout });
  const field = page.locator(".fm-textarea").filter({
    has: page.locator(".placeholder").filter({ hasText: "eg M01234" }),
  });
  await field.locator(".text").click();
  await field.locator('.text[contenteditable="true"]').waitFor({ timeout });
  await field.locator(".text").fill(number);
  // WebDirect commits the field to its server on blur. A direct click can read
  // the previous value if the field update and search script race.
  await field.locator(".text").press("Tab");
  const fieldBox = await field.boundingBox();
  let clicked = false;
  for (const button of await page
    .getByRole("button", { name: "Search", exact: true })
    .all()) {
    const box = await button.boundingBox();
    if (box && fieldBox && Math.abs(box.y - fieldBox.y) < 20) {
      await button.click();
      clicked = true;
      break;
    }
  }
  if (!clicked)
    throw new Error("Could not locate the direct-matter Search button");
  await page.waitForFunction(
    () => {
      const buttons = Array.from(document.querySelectorAll("button")).map(
        (e) => e.textContent ?? "",
      );
      return (
        buttons.some((t) => /^Exhibits\s*-/.test(t.trim())) ||
        Array.from(document.querySelectorAll('[role="dialog"]')).some((e) =>
          /No Matching|not found|No records/i.test(e.textContent ?? ""),
        )
      );
    },
    undefined,
    { timeout },
  );
  return (await page.getByRole("button", { name: /^Exhibits -/ }).count()) > 0;
}

interface RowData {
  documentId: string;
  title: string;
  date?: string;
  security?: string;
  extension?: string;
}
interface SourceRow extends RowData {
  key: string;
  fieldId: string;
}
export function parseDocumentFields(
  fields: string[],
  explicitId?: string,
): RowData | undefined {
  const identifier = /^(?:[A-Za-z][A-Za-z0-9]*[ .-]*)?\d+(?:[.-]\d+)*$/;
  // Exhibits may use A-1 / A -5; transcripts and recordings use a date as
  // their clickable identifier. Prefer the actual identity field in the DOM.
  const documentId =
    explicitId && explicitId.length <= 120 && !/[\x00-\x1f]/.test(explicitId)
      ? explicitId
      : fields.find((f) => identifier.test(f));
  if (!documentId) return undefined;
  const date = fields.find((f) => /^\d{2}\/\d{2}\/\d{4}$/.test(f));
  const format = fields.find((f) =>
    /^(?:pdf|mp3|wav|mp4|doc|docx|txt|rtf|xls|xlsx|zip|wmv|m4a)$/i.test(f),
  );
  const extension =
    fields.find((f) => /^\.[a-zA-Z0-9]+$/.test(f)) ??
    (format ? "." + format.toLowerCase() : undefined);
  const security = fields.find((f) =>
    /^(?:Public|Confidential|Restricted|Private|Sealed)$/i.test(f),
  );
  const title = fields
    .filter(
      (f) =>
        f &&
        f !== documentId &&
        f !== date &&
        f !== extension &&
        f !== security &&
        f !== format,
    )
    .join(" — ");
  if (!title) return undefined;
  return { documentId, title, date, security, extension };
}
async function rowsOnPage(page: Page): Promise<SourceRow[]> {
  const rows = await page.getByRole("row").evaluateAll((rows) =>
    rows.map((row) => ({
      fields: Array.from(row.querySelectorAll(".fm-textarea .text")).map((e) =>
        (e.textContent ?? "").trim(),
      ),
      id: row
        .querySelector(".fm-textarea.hand-cursor .text")
        ?.textContent?.trim(),
      fieldId: row.querySelector(".fm-textarea.hand-cursor")?.id,
    })),
  );
  return rows.flatMap((row) => {
    const parsed = parseDocumentFields(row.fields, row.id);
    return parsed && row.fieldId
      ? [{ ...parsed, key: JSON.stringify(row.fields), fieldId: row.fieldId }]
      : [];
  });
}

async function closeDownloadDialog(page: Page): Promise<void> {
  const dialog = page.getByRole("dialog", {
    name: "Download Files",
    exact: true,
  });
  if (await dialog.count()) {
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
    await dialog.waitFor({ state: "hidden", timeout: 10000 });
  }
  const exporting = page.getByRole("dialog", {
    name: "Export Field to File",
    exact: true,
  });
  if (await exporting.count()) {
    await exporting
      .getByRole("button", { name: "Cancel", exact: true })
      .click();
    await exporting.waitFor({ state: "hidden", timeout: 10000 });
  }
}

export async function collectDocuments(
  request: AgentRequest,
  options: CollectorOptions = {},
): Promise<CollectionResult> {
  if (
    !/^M\d{5}$/.test(request.matterNumber) ||
    !CATEGORIES.includes(request.category)
  )
    throw new Error("Invalid collector request");
  const limit = options.limit ?? 10;
  if (!Number.isInteger(limit) || limit < 1 || limit > 10)
    throw new Error("Download limit must be between 1 and 10");
  const timeout = options.timeoutMs ?? 30000;
  const directory = resolve(
    options.outputDirectory ??
      join(
        "data",
        "runs",
        `${request.matterNumber}-${Date.now()}-${randomUUID().slice(0, 8)}`,
      ),
  );
  await mkdir(join(directory, "documents"), { recursive: true, mode: 0o700 });
  const result: CollectionResult = {
    request,
    status: "failed",
    documents: [],
    failures: [],
    selectedDocumentIds: [],
    selectionOrder:
      "First documents in the website default order (no sorting applied)",
    observedAt: new Date().toISOString(),
    runDirectory: directory,
    warnings: [],
  };
  let browser: Browser | undefined;
  let page: Page | undefined;
  let deadline: NodeJS.Timeout | undefined;
  const pendingDirectory = join(directory, "pending-downloads");
  await mkdir(pendingDirectory, { mode: 0o700, recursive: true });
  const log = (event: Record<string, unknown>) =>
    options.log?.({ at: new Date().toISOString(), ...event });
  try {
    browser = await chromium.launch({
      headless: options.headless ?? true,
      downloadsPath: pendingDirectory,
    });
    deadline = setTimeout(
      () => {
        void browser?.close();
      },
      5 * 60 * 1000,
    );
    const context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      acceptDownloads: true,
    });
    page = await context.newPage();
    page.setDefaultTimeout(timeout);
    log({ stage: "lookup", matter: request.matterNumber });
    if (!(await searchMatter(page, request.matterNumber, timeout))) {
      result.status = "not_found";
      return result;
    }
    result.metadata = await readMetadata(page, request.matterNumber);
    result.counts = parseCategoryCounts(
      await page.getByRole("button").allTextContents(),
    );
    await writeFile(
      join(directory, "matter.json"),
      JSON.stringify(
        {
          metadata: result.metadata,
          counts: result.counts,
          observedAt: result.observedAt,
        },
        null,
        2,
      ),
    );
    await page.screenshot({ path: join(directory, "matter.png") });
    const available = result.counts[request.category];
    if (available === 0) {
      result.status = "empty";
      return result;
    }
    await page
      .getByRole("button", { name: new RegExp(`^${request.category} -`) })
      .click();
    await page
      .getByRole("button", { name: "GO GET IT", exact: true })
      .first()
      .waitFor({ timeout });
    const seen = new Set<string>();
    let stagnant = 0;
    let totalBytes = 0;
    let scrollAttempts = 0;
    while (
      result.documents.length < limit &&
      seen.size < Math.min(available, limit)
    ) {
      const rows = await rowsOnPage(page);
      const next = rows.find((r) => !seen.has(r.key));
      if (!next) {
        if (++scrollAttempts > 20) break;
        const scroller = page.locator(".v-grid-scroller-vertical");
        if (!(await scroller.count())) break;
        const before = JSON.stringify(rows.map((r) => r.key));
        await scroller.evaluate((el) => {
          el.scrollTop += Math.max(150, el.clientHeight - 140);
        });
        try {
          await page.waitForFunction(
            (before) =>
              JSON.stringify(
                Array.from(document.querySelectorAll('[role="row"]')).map(
                  (row) =>
                    JSON.stringify(
                      Array.from(
                        row.querySelectorAll(".fm-textarea .text"),
                      ).map((e) => (e.textContent ?? "").trim()),
                    ),
                ),
              ) !== before,
            before,
            { timeout: 4000 },
          );
          stagnant = 0;
        } catch {
          if (++stagnant >= 2) break;
        }
        continue;
      }
      seen.add(next.key);
      result.selectedDocumentIds.push(next.documentId);
      if (next.security && !/^public$/i.test(next.security)) {
        result.failures.push({
          documentId: next.documentId,
          reason: `Document security is ${next.security}; download skipped`,
        });
        continue;
      }
      let downloaded = false;
      for (let attempt = 0; attempt < 2 && !downloaded; attempt++) {
        let action = "close previous download dialog";
        try {
          await closeDownloadDialog(page);
          // Scope the action to the source row, not a stale virtualized index.
          if (!/^[a-zA-Z0-9_-]+$/.test(next.fieldId))
            throw new Error("Unexpected source row identity");
          const row: Locator = page
            .locator(`#${next.fieldId}`)
            .locator("xpath=ancestor::tr");
          const currentFields = await row
            .locator(".fm-textarea .text")
            .allTextContents();
          if (JSON.stringify(currentFields.map(clean)) !== next.key)
            throw new Error("Document row changed before its download action");
          action = "open source row";
          await row
            .getByRole("button", { name: "GO GET IT", exact: true })
            .click();
          action = "wait for download dialog";
          await page
            .getByRole("dialog", {
              name: /^(?:Download Files|Export Field to File)$/,
            })
            .waitFor({ timeout });
          const exportDialog = page.getByRole("dialog", {
            name: "Export Field to File",
            exact: true,
          });
          if (await exportDialog.count()) {
            const extension =
              next.extension ??
              (request.category === "Transcripts"
                ? ".pdf"
                : request.category === "Recordings"
                  ? ".bin"
                  : undefined);
            if (!extension)
              throw new Error(
                "Source export did not specify a supported file format",
              );
            const exportName = safeFilename(
              request.matterNumber,
              `${next.documentId.replace(/[^a-zA-Z0-9_.-]/g, "_")}-${sha256(Buffer.from(next.key)).slice(0, 6)}${extension}`,
            );
            await exportDialog.getByRole("textbox").fill(exportName);
            await exportDialog
              .getByRole("button", { name: "OK", exact: true })
              .click();
          }
          const dialog = page.getByRole("dialog", {
            name: "Download Files",
            exact: true,
          });
          await dialog.waitFor({ timeout });
          const filenames = (await dialog.getByRole("button").allTextContents())
            .map(clean)
            .filter((n) => n && n !== "Close");
          if (!filenames.length)
            throw new Error("No file buttons appeared in the download dialog");
          if (filenames.length > 1)
            result.warnings.push(
              `Document ${next.documentId} has ${filenames.length} attachments; the 10-file cap still applies.`,
            );
          for (
            let index = 0;
            index < filenames.length && result.documents.length < limit;
            index++
          ) {
            const original = filenames[index];
            let filename = safeFilename(
              `${next.documentId}-${sha256(Buffer.from(next.key)).slice(0, 6)}`,
              original,
              index,
            );
            if (result.documents.some((d) => d.filename === filename)) continue;
            log({
              stage: "download",
              documentId: next.documentId,
              attempt: attempt + 1,
            });
            const [download] = await Promise.all([
              page.waitForEvent("download", { timeout }),
              dialog
                .getByRole("button", { name: original, exact: true })
                .click(),
            ]);
            const maxBytes = Math.min(
              options.maxFileBytes ?? 25 * 1024 * 1024,
              50 * 1024 * 1024 - totalBytes,
            );
            // Chromium writes partial transfers here. Check them while the browser
            // is still receiving, so a recording cannot grow without a disk bound.
            await waitForBoundedDownload(download, pendingDirectory, maxBytes);
            let path = join(directory, "documents", filename);
            await download.saveAs(path);
            await download.delete();
            const size = (await stat(path)).size;
            if (
              size > (options.maxFileBytes ?? 25 * 1024 * 1024) ||
              totalBytes + size > 50 * 1024 * 1024
            ) {
              await rm(path);
              throw new Error(
                "Document exceeds the configured download size limit",
              );
            }
            const bytes = await readFile(path);
            if (
              request.category === "Recordings" &&
              filename.endsWith(".bin")
            ) {
              const extension = detectMediaExtension(bytes);
              if (!extension)
                throw new Error(
                  "Downloaded recording has an unknown media format",
                );
              filename = filename.slice(0, -4) + extension;
              const renamed = join(directory, "documents", filename);
              await rename(path, renamed);
              path = renamed;
            }
            verifyDocument(bytes, filename);
            const { key, fieldId, ...documentMetadata } = next;
            result.documents.push({
              ...documentMetadata,
              filename,
              path,
              bytes: bytes.length,
              sha256: sha256(bytes),
            });
            totalBytes += bytes.length;
          }
          downloaded = true;
          await closeDownloadDialog(page);
        } catch (error) {
          log({
            stage: "download_failed",
            documentId: next.documentId,
            action,
            reason: errorText(error),
          });
          await writeFile(
            join(directory, "download-error.txt"),
            error instanceof Error
              ? (error.stack ?? error.message)
              : String(error),
          );
          await closeDownloadDialog(page).catch(() => {});
          if (
            /(?:byte budget|size limit|file signature|HTML page)/i.test(
              errorText(error),
            )
          ) {
            result.failures.push({
              documentId: next.documentId,
              reason: errorText(error),
            });
            break;
          }
          if (attempt === 1)
            result.failures.push({
              documentId: next.documentId,
              reason: errorText(error),
            });
        }
      }
      await writeFile(
        join(directory, "progress.json"),
        JSON.stringify(result, null, 2),
      );
    }
    if (
      seen.size < Math.min(available, limit) &&
      result.documents.length < limit
    )
      result.failures.push({
        reason:
          "Could not enumerate all selected document rows in the scrolling list",
      });
    if (result.documents.length) {
      const zip = await packageDocuments(
        result.documents,
        directory,
        `${request.matterNumber}-${request.category}`,
      );
      result.zipPath = zip.path;
      result.zipBytes = zip.bytes;
    }
    result.status = result.failures.length ? "partial" : "complete";
    if (!result.documents.length) result.status = "failed";
    await page.screenshot({ path: join(directory, "documents.png") });
    log({
      stage: "complete",
      status: result.status,
      downloaded: result.documents.length,
      zipBytes: result.zipBytes,
    });
    return result;
  } catch (error) {
    result.failures.push({ reason: errorText(error) });
    if (page) {
      await page
        .screenshot({ path: join(directory, "failure.png") })
        .catch(() => {});
      await writeFile(
        join(directory, "failure.txt"),
        await page
          .locator("body")
          .innerText()
          .catch(() => ""),
      );
    }
    // Preserve verified successes even when a later navigation fails.
    if (result.documents.length && !result.zipPath) {
      try {
        const zip = await packageDocuments(
          result.documents,
          directory,
          `${request.matterNumber}-${request.category}`,
        );
        result.zipPath = zip.path;
        result.zipBytes = zip.bytes;
        result.status = "partial";
      } catch {}
    }
    return result;
  } finally {
    if (deadline) clearTimeout(deadline);
    await writeFile(
      join(directory, "result.json"),
      JSON.stringify(result, null, 2),
      { mode: 0o600 },
    );
    await browser?.close();
  }
}
