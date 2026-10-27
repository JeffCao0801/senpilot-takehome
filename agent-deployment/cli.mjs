import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { settings, childEnvironment } from "./config.mjs";
import { api, configure, loadState, processOne } from "./runtime.mjs";

export function unitQuote(value) {
  if (/[\n\r\0]/.test(value))
    throw new Error("Unsupported newline in service path.");
  return (
    '"' +
    value
      .replaceAll("\\", "\\\\")
      .replaceAll('"', '\\"')
      .replaceAll("%", "%%")
      .replaceAll("$", "$$") +
    '"'
  );
}

export function serviceUnit(config) {
  return `[Unit]
Description=Senpilot Markdown agent inbox poll
Wants=network-online.target
After=network-online.target

[Service]
Type=oneshot
WorkingDirectory=${unitQuote(config.directory)}
ExecStart=${unitQuote(process.execPath)} ${unitQuote(join(config.directory, "cli.mjs"))} poll
Environment=${unitQuote(`PATH=${process.env.PATH || "/usr/local/bin:/usr/bin:/bin"}`)}
UMask=0077
TimeoutStartSec=${Math.ceil(config.timeout / 1000) + 120}
TimeoutStopSec=20
KillMode=control-group
`;
}

export const timerUnit = `[Unit]
Description=Check the separate Markdown agent inbox every minute

[Timer]
OnBootSec=90s
OnUnitInactiveSec=60s
Unit=senpilot-markdown-agent.service

[Install]
WantedBy=timers.target
`;

async function doctor(config, live) {
  await loadState(config);
  for (const entry of [config.browserEntry, config.mailEntry])
    await stat(entry);
  const auth = JSON.parse(
    await readFile(join(config.auth, "auth.json"), "utf8"),
  );
  if (
    auth.auth_mode !== "chatgpt" ||
    !auth.tokens?.access_token ||
    !auth.tokens?.refresh_token
  )
    throw new Error(
      "Dedicated file-backed ChatGPT login is missing. Run node cli.mjs login.",
    );
  if (!config.key)
    throw new Error(
      "Set the separate inbox-scoped key in agent-deployment/.env.",
    );
  for (const [command, args] of [
    [config.codex, ["--version"]],
    ["zip", ["-v"]],
    ["unzip", ["-v"]],
    ["file", ["--version"]],
    ["pdfinfo", ["-v"]],
  ]) {
    const result = spawnSync(command, args, {
      env: childEnvironment(config, false),
      encoding: "utf8",
      timeout: 10_000,
    });
    if (result.status !== 0)
      throw new Error(
        "A required command is unavailable; check Codex, zip, unzip, file and pdfinfo.",
      );
  }
  // Enumerate the private config without running a model or initializing mail tools.
  const parsed = spawnSync(config.codex, ["mcp", "list", "--json"], {
    env: childEnvironment(config),
    encoding: "utf8",
    timeout: 15_000,
  });
  if (parsed.status !== 0)
    throw new Error(
      "Codex rejected the generated config; check its version/config compatibility.",
    );
  const servers = JSON.parse(parsed.stdout);
  if (
    !Array.isArray(servers) ||
    servers.length !== 2 ||
    !["browser", "agentmail"].every((name) =>
      servers.some((server) => server.name === name),
    )
  )
    throw new Error(
      "Dedicated Codex config did not load exactly the browser and mail servers.",
    );
  if (live) {
    const page = await api(config, "?limit=1");
    if (
      !Array.isArray(page.messages) ||
      page.messages.some((message) => message.inbox_id !== config.inbox)
    )
      throw new Error("Inbox read/identity check failed.");
  }
  console.log(
    `Doctor passed (${live ? "including inbox read" : "local checks only"}). No model call or email send performed.`,
  );
  console.log(
    "Run npm run tools:check and the Ubuntu acceptance checklist before enabling the timer.",
  );
}

export async function main(argv = process.argv.slice(2)) {
  process.umask(0o077);
  const config = settings();
  const [command, ...rest] = argv;
  if (command === "configure") {
    await configure(config);
    console.log(
      `Prepared separate runtime for ${config.inbox}. Old inbox history is excluded by the saved first-setup cutoff.`,
    );
    console.log(
      `Use node cli.mjs login next. Enabled setting preserved (${config.enabled}); no service was started.`,
    );
  } else if (command === "login") {
    await loadState(config);
    const result = spawnSync(config.codex, ["login", ...rest], {
      env: childEnvironment(config, false),
      stdio: "inherit",
    });
    if (result.status !== 0)
      throw new Error("Dedicated Codex login did not complete.");
  } else if (command === "doctor") {
    if (rest.some((arg) => arg !== "--live"))
      throw new Error("Usage: node cli.mjs doctor [--live]");
    await doctor(config, rest.includes("--live"));
  } else if (command === "poll" || command === "run") {
    let messageId;
    if (command === "run") {
      if (
        rest.length !== 2 ||
        rest[0] !== "--message-id" ||
        !rest[1] ||
        rest[1].length >= 1000
      )
        throw new Error(
          "Usage: node cli.mjs run --message-id <incoming-message-id>",
        );
      messageId = rest[1];
    } else if (rest.length) throw new Error("poll takes no arguments.");
    const status = await processOne(config, { messageId });
    console.log(`Markdown agent: ${status}.`);
    if (status === "review_required") process.exitCode = 1;
  } else if (command === "status") {
    const state = await loadState(config);
    const counts = {};
    for (const job of Object.values(state.jobs))
      counts[job.status] = (counts[job.status] || 0) + 1;
    console.log(
      JSON.stringify(
        {
          inbox: config.inbox,
          enabled: config.enabled,
          startAfter: state.startAfter,
          todayLaunches:
            state.usage[new Date().toISOString().slice(0, 10)] || 0,
          dailyLimit: config.dailyLimit,
          jobs: counts,
        },
        null,
        2,
      ),
    );
  } else if (command === "install-service") {
    if (process.platform !== "linux")
      throw new Error("Install these user units on Ubuntu.");
    await loadState(config);
    const directory = join(homedir(), ".config", "systemd", "user");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(
      join(directory, "senpilot-markdown-agent.service"),
      serviceUnit(config),
      { mode: 0o600 },
    );
    await writeFile(
      join(directory, "senpilot-markdown-agent.timer"),
      timerUnit,
      { mode: 0o600 },
    );
    console.log(
      "Wrote senpilot-markdown-agent.service and .timer. Neither was enabled or started.",
    );
  } else {
    throw new Error(
      "Commands: configure, login [--device-auth], doctor [--live], poll, run --message-id <id>, status, install-service.",
    );
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    // Only our bounded errors are public. OS/parser errors can include private paths or data.
    const safe =
      error?.code || error instanceof SyntaxError
        ? "Local file/config operation failed; check the private runtime and setup guide."
        : error.message;
    console.error(safe);
    process.exitCode = 1;
  });
}
