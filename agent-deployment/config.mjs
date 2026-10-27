import { parseEnv } from "node:util";
import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve, join, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

export const deploymentDir = dirname(fileURLToPath(import.meta.url));
export const mailTools = [
  "list_messages",
  "get_message",
  "get_thread",
  "reply_to_message",
];

export function settings(env = process.env, directory = deploymentDir) {
  const local = existsSync(join(directory, ".env"))
    ? parseEnv(readFileSync(join(directory, ".env"), "utf8"))
    : {};
  const values = { ...local, ...env };
  const inbox = values.MARKDOWN_AGENT_INBOX || "jeffcao-markdown@agentmail.to";
  if (
    !/^[a-zA-Z0-9._+-]+@agentmail\.to$/.test(inbox) ||
    inbox.toLowerCase() === "jeffcao@agentmail.to"
  )
    throw new Error(
      "Use a separate valid AgentMail inbox, never the TypeScript worker inbox.",
    );
  const state = resolve(directory, values.MARKDOWN_AGENT_STATE_DIR || "data");
  // Keep runtime writes out of the source tree and the other worker's data.
  if (state !== join(directory, "data"))
    throw new Error(
      "Keep MARKDOWN_AGENT_STATE_DIR unset or use this deployment folder's absolute data path.",
    );
  const auth = values.MARKDOWN_AGENT_CODEX_HOME || join(state, "codex");
  if (!isAbsolute(auth) || resolve(auth) !== join(state, "codex"))
    throw new Error(
      "Use the dedicated data/codex directory for this agent login.",
    );
  const integer = (key, fallback, min, max) => {
    const raw = values[key] || String(fallback);
    if (!/^\d+$/.test(raw) || Number(raw) < min || Number(raw) > max)
      throw new Error(`Invalid ${key}.`);
    return Number(raw);
  };
  const enabled = values.MARKDOWN_AGENT_ENABLED || "false";
  if (!["true", "false"].includes(enabled))
    throw new Error("MARKDOWN_AGENT_ENABLED must be true or false.");
  const model = values.MARKDOWN_AGENT_MODEL || "";
  if (model && !/^[a-zA-Z0-9._:-]{1,128}$/.test(model))
    throw new Error("Invalid model name.");
  return {
    directory,
    state,
    auth,
    inbox,
    model,
    key: values.MARKDOWN_AGENT_API_KEY || "",
    codex: values.MARKDOWN_AGENT_CODEX_PATH || "codex",
    enabled: enabled === "true",
    dailyLimit: integer("MARKDOWN_AGENT_DAILY_LIMIT", 20, 0, 1000),
    timeout: integer("MARKDOWN_AGENT_TIMEOUT_SECONDS", 900, 30, 3600) * 1000,
    allowedSenders: (values.MARKDOWN_AGENT_ALLOWED_SENDERS || "")
      .toLowerCase()
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean),
    work: join(state, "work"),
    attachments: join(state, "work", "attachments"),
    workflow: join(dirname(directory), "agent-experiment", "SENPILOT_AGENT.md"),
    browserEntry: join(
      directory,
      "node_modules",
      "@playwright",
      "mcp",
      "cli.js",
    ),
    mailEntry: join(
      directory,
      "node_modules",
      "agentmail-mcp",
      "build",
      "index.js",
    ),
  };
}

export function childEnvironment(config, withMail = true) {
  // Do not inherit the other project's secrets, API-key auth, NODE_OPTIONS, or MCP settings.
  const env = {
    PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin",
    HOME: process.env.HOME,
    CODEX_HOME: config.auth,
    LANG: "C.UTF-8",
    NO_COLOR: "1",
  };
  for (const key of ["SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS"])
    if (process.env[key]) env[key] = process.env[key];
  if (withMail) env.AGENTMAIL_API_KEY = config.key;
  return env;
}

export function codexConfig(config) {
  const quoted = JSON.stringify;
  return `# Generated for the Markdown agent only. Contains paths, never credentials.
approval_policy = "never"
sandbox_mode = "workspace-write"
forced_login_method = "chatgpt"
cli_auth_credentials_store = "file"
project_doc_max_bytes = 0
web_search = "disabled"
allow_login_shell = false
history.persistence = "none"
shell_environment_policy.inherit = "core"
shell_environment_policy.ignore_default_excludes = false
shell_environment_policy.include_only = ["PATH", "HOME", "LANG", "TMPDIR"]

[mcp_servers.browser]
command = ${quoted(process.execPath)}
args = ${quoted([config.browserEntry, "--headless", "--isolated", "--no-webmcp", "--output-dir", join(config.work, "downloads")])}
cwd = ${quoted(config.work)}
required = true
startup_timeout_sec = 60
tool_timeout_sec = 90
default_tools_approval_mode = "approve"

[mcp_servers.agentmail]
command = ${quoted(process.execPath)}
args = ${quoted([config.mailEntry, "--file-root", config.attachments, "--tools", mailTools.join(",")])}
cwd = ${quoted(config.work)}
env_vars = ["AGENTMAIL_API_KEY"]
required = true
startup_timeout_sec = 60
tool_timeout_sec = 90
enabled_tools = ${quoted(mailTools)}
default_tools_approval_mode = "approve"
`;
}
