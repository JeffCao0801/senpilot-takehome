import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve, join } from "node:path";
import { loadConfig } from "../src/config.js";

const root = resolve(".");
const config = loadConfig();
const unitDirectory = join(homedir(), ".config", "systemd", "user");
const quote = (s: string) =>
  `"${s.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%")}"`;
await mkdir(unitDirectory, { recursive: true });
const unit = `[Unit]
Description=Senpilot regulatory document email agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${quote(root)}
ExecStart=${quote(process.execPath)} ${quote(join(root, "node_modules", "tsx", "dist", "cli.mjs"))} ${quote(join(root, "src", "cli.ts"))} worker
Environment=${quote(`PATH=${process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin"}`)}
Environment=NODE_ENV=production
Restart=on-failure
RestartSec=15
TimeoutStopSec=390
KillMode=control-group
UMask=0077

[Install]
WantedBy=default.target
`;
const path = join(unitDirectory, "senpilot-agent.service");
await writeFile(path, unit, { mode: 0o600 });
console.log(
  `Created ${path}\nInbox: ${config.inboxId}\nRun: systemctl --user daemon-reload\nThen: systemctl --user enable --now senpilot-agent.service`,
);
