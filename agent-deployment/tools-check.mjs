import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { settings, childEnvironment, mailTools } from "./config.mjs";

// These checks use real tool processes, but never invoke the model or send email.
async function connected(
  config,
  entry,
  args,
  action,
  withMail = false,
  cwd = config.work,
) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry, ...args],
    cwd,
    env: childEnvironment(config, withMail),
    stderr: "pipe",
  });
  const client = new Client({
    name: "senpilot-deployment-preflight",
    version: "0.1.0",
  });
  // Do not print arbitrary bridge/browser stderr, credentials, or mailbox data.
  transport.stderr?.on("data", () => {});
  try {
    await client.connect(transport, { timeout: 30_000 });
    return await action(client);
  } finally {
    await client.close();
    await transport.close();
  }
}

async function browserCheck(config) {
  const directory = await mkdtemp(join(tmpdir(), "senpilot-browser-check-"));
  const expected = Buffer.from(
    "Senpilot completed-download capability check\n",
  );
  const server = createServer((request, response) => {
    if (request.url === "/download") {
      response.writeHead(200, {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": 'attachment; filename="probe.txt"',
      });
      response.end(expected);
    } else {
      response.writeHead(200, { "Content-Type": "text/html" });
      response.end(
        '<!doctype html><title>Capability check</title><a href="/download">Download probe</a>',
      );
    }
  });
  try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const destination = join(directory, "probe.txt");
    await connected(
      config,
      config.browserEntry,
      ["--headless", "--isolated", "--no-webmcp", "--output-dir", directory],
      async (client) => {
        const catalog = await client.listTools();
        for (const name of ["browser_navigate", "browser_close"])
          if (!catalog.tools.some((tool) => tool.name === name))
            throw new Error("Browser is missing required tools.");
        const runCode = catalog.tools.find((tool) =>
          ["browser_run_code", "browser_run_code_unsafe"].includes(tool.name),
        );
        if (!runCode)
          throw new Error(
            "Browser lacks the code tool needed for a download listener.",
          );
        const navigate = await client.callTool({
          name: "browser_navigate",
          arguments: { url: `http://127.0.0.1:${server.address().port}` },
        });
        if (navigate.isError)
          throw new Error(
            "Headless browser launch/navigation failed. Install the MCP browser revision.",
          );
        const download = await client.callTool({
          name: runCode.name,
          arguments: {
            code: `async (page) => { const pending = page.waitForEvent('download'); await page.getByRole('link', { name: 'Download probe' }).click(); const file = await pending; if (await file.failure()) throw new Error('download failed'); await file.saveAs(${JSON.stringify(destination)}); return { complete: true }; }`,
          },
        });
        if (download.isError || !(await readFile(destination)).equals(expected))
          throw new Error("Completed browser download bytes did not match.");
        await client.callTool({ name: "browser_close", arguments: {} });
      },
      false,
      directory,
    );
    console.log("PASS: headless browser MCP and completed download bytes.");
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
}

async function mailCheck(config) {
  if (!config.key)
    throw new Error("Set the separate key in .env before --mail.");
  await mkdir(config.attachments, { recursive: true, mode: 0o700 });
  await connected(
    config,
    config.mailEntry,
    ["--file-root", config.attachments, "--tools", mailTools.join(",")],
    async (client) => {
      const catalog = await client.listTools();
      for (const name of mailTools)
        if (!catalog.tools.some((tool) => tool.name === name))
          throw new Error("Mail MCP catalog lacks required tools.");
      const reply = catalog.tools.find(
        (tool) => tool.name === "reply_to_message",
      );
      if (
        !JSON.stringify(reply.inputSchema.properties?.attachments).includes(
          '"path"',
        )
      )
        throw new Error(
          "Mail reply tool does not expose local attachment paths.",
        );
    },
    true,
  );
  console.log(
    "PASS: authenticated mail MCP catalog and local attachment path schema. Sending remains untested.",
  );
}

process.umask(0o077);
try {
  if (process.argv.slice(2).some((arg) => arg !== "--mail"))
    throw new Error("Usage: npm run tools:check -- [--mail]");
  const config = settings();
  await browserCheck(config);
  if (process.argv.includes("--mail")) await mailCheck(config);
} catch {
  console.error(
    "Tool capability check failed. Verify dependencies, browser installation, and (for --mail) the inbox-scoped key. No email was sent.",
  );
  process.exitCode = 1;
}
