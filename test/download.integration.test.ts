import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { waitForBoundedDownload } from "../src/collector.js";

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
