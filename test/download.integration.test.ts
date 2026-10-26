import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import {
  waitForBoundedDownload,
  waitForDocumentRowsChange,
} from "../src/collector.js";

test(
  "virtual row wait ignores unchanged headers and waits for delayed source rows",
  { skip: process.env.BROWSER_INTEGRATION !== "1" },
  async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.setContent(
        '<table><tr role="row"><th>Header</th></tr><tr role="row"><td></td></tr><tr role="row"><td class="fm-textarea"><span class="text">First document</span></td></tr></table>',
      );
      await waitForDocumentRowsChange(page, () =>
        page.evaluate(() => {
          setTimeout(() => {
            document.querySelector(".text")!.textContent = "Second document";
          }, 200);
        }),
      );
      assert.equal(
        await page.locator(".text").textContent(),
        "Second document",
      );
      await assert.rejects(
        waitForDocumentRowsChange(page, async () => {}, 100),
        /Timeout/,
      );
    } finally {
      await browser.close();
    }
  },
);

test(
  "browser cancels a slow transfer before the advertised full file is received",
  { skip: process.env.BROWSER_INTEGRATION !== "1" },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "senpilot-transfer-"));
    let sent = 0;
    const server = createServer((request, response) => {
      if (request.url !== "/file") {
        response.end('<a href="/file">Download</a>');
        return;
      }
      response.writeHead(200, {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": 'attachment; filename="large.bin"',
        "Content-Length": "10000000",
      });
      const timer = setInterval(() => {
        sent += 16384;
        response.write(Buffer.alloc(16384));
      }, 20);
      response.on("close", () => clearInterval(timer));
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const browser = await chromium.launch({
      headless: true,
      downloadsPath: directory,
    });
    try {
      const address = server.address() as { port: number };
      const page = await browser.newPage();
      await page.goto(`http://127.0.0.1:${address.port}`);
      const [download] = await Promise.all([
        page.waitForEvent("download"),
        page.getByRole("link", { name: "Download" }).click(),
      ]);
      await assert.rejects(
        waitForBoundedDownload(download, directory, 65536),
        /byte budget/,
      );
      assert.ok(
        sent < 10000000,
        "The transfer should stop before the full response is downloaded",
      );
    } finally {
      await browser.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  },
);
