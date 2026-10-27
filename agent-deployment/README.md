# Ubuntu preparation for the Markdown agent

This directory supplies deployment plumbing around the independent
[Markdown workflow](../agent-experiment/SENPILOT_AGENT.md). The agent still reads
the request, navigates the website, chooses/downloads/verifies files, builds the
ZIP, and replies using tools. This wrapper only checks the inbox, claims one
message, launches Codex, checks its send receipt, and schedules the next check.
It does not import the TypeScript worker or modify `agent-experiment/`.

**Status:** prepared and locally tested on macOS; Ubuntu installation, standalone
model/tool interaction, actual email delivery, and reboot/lid behavior still need
the acceptance steps below. Nothing here has enabled a service or sent email.

## Parallel deployment plan

| Resource               | Traditional implementation      | Markdown agent                               |
| ---------------------- | ------------------------------- | -------------------------------------------- |
| Inbox                  | `jeffcao@agentmail.to`          | `jeffcao-markdown@agentmail.to`              |
| Setup                  | `scripts/setup-ubuntu.sh`       | `agent-deployment/setup-ubuntu.sh`           |
| Secrets                | root `.env`                     | `agent-deployment/.env`                      |
| Credentials            | dedicated TypeScript Codex home | `agent-deployment/data/codex/`               |
| State                  | root `data/jobs.sqlite`         | `agent-deployment/data/state.json`           |
| Downloads and receipts | root `data/runs/`               | `agent-deployment/data/work/`                |
| Service                | `senpilot-agent.service`        | `senpilot-markdown-agent.service` + `.timer` |

1. Install both runtimes on Ubuntu, with separate inbox-scoped AgentMail keys
   and separate Codex logins. Use the same Node 24+ installation if desired.
2. Run local diagnostics and actual browser/download and mail-tool checks.
3. Process one specifically selected test message manually; verify the ZIP in
   the recipient inbox and compare it with the local archive.
4. Enable the Markdown timer only after manual acceptance. Then verify both
   inboxes concurrently, logout/reboot, and your intended lid/power settings.
5. Publish both inbox addresses and their supported limits in the submission.
   Do not advertise automatic availability before those tests pass.

Both approaches use your account's available Codex allowance. Separate login
directories avoid sharing refresh files; they do not create separate quotas.
No public server, tunnel, domain, or inbound network port is required.

## Install on Ubuntu

Clone the whole repository, including `agent-deployment/` and
`agent-experiment/`. Do not copy `node_modules/` from
macOS. Transfer keys and any existing receipts privately, outside Git. Stop any
old runner before moving its state. Install Node.js 24+, npm and Codex CLI first.
The existing TypeScript project was tested with Codex CLI 0.164.0; repeat the
doctor/tool tests if you change versions.

From the project root:

```sh
bash agent-deployment/setup-ubuntu.sh
cd agent-deployment
```

The installer installs `zip`, `unzip`, `file`, and `poppler-utils` using sudo;
installs the separately locked npm tools and their matching Chromium revision;
creates a mode-600 `.env`; and configures private runtime directories. It does
not log in, enable units, or send mail. It leaves the other worker alone.

Edit **this directory's** `.env` locally:

```dotenv
MARKDOWN_AGENT_API_KEY=YOUR_SEPARATE_INBOX_SCOPED_KEY
MARKDOWN_AGENT_INBOX=jeffcao-markdown@agentmail.to
MARKDOWN_AGENT_ALLOWED_SENDERS=YOUR_TEST_SENDER@example.com
MARKDOWN_AGENT_ENABLED=false
```

Use a key scoped only to the Markdown inbox, with message read/reply/send
permissions as required by AgentMail. Do not reuse a key that can access the
other worker's inbox. The wrapper rejects the traditional inbox address, but
the provider's key scope is the actual cross-inbox access control. Confirm key
expiry in AgentMail. Never paste key values into a chat, command argument, or
tracked file. The installer does not create/revoke provider keys or inboxes.

Sign in using the dedicated Codex home already configured for file storage:

```sh
node cli.mjs login
# If a normal browser callback is unavailable:
# node cli.mjs login --device-auth

npm run doctor -- --live
npm run tools:check -- --mail
```

Doctor checks saved ChatGPT auth, commands, Codex config compatibility and
read-only inbox access. The tool check starts a real headless browser, downloads
a loopback fixture and compares its completed bytes, then discovers the
authenticated mail tools and local attachment schema. Neither makes a model
call or sends mail. A passing tool catalog check does not prove mail delivery.
The browser check uses only a temporary loopback HTTP listener; no public
server or ongoing listening service is installed.

Run no other Codex session against this agent's `data/codex/` while a job runs.
`configure` can be repeated when the timer is stopped; it preserves receipts and
the original first-scan cutoff, and refreshes the copied workflow/tool config.
Paths are generated for the current machine. Re-run configure after transferring
the source, and sign in on Ubuntu rather than copying another active auth file.

## Manual acceptance before automatic processing

Send a new message from your allowlisted test address to the Markdown inbox:

> Please send Key Documents for M12205.

Find that incoming message's ID in the AgentMail console. While automatic
processing is disabled, explicitly launch exactly that message:

```sh
node cli.mjs run --message-id '<THE_INCOMING_MESSAGE_ID>'
npm run status
```

This command **does authorize one real reply** to that message's trusted sender.
It consumes Codex allowance. It uses the Markdown workflow's browser/email tools,
not the TypeScript collector. Do not run it on an unrelated message.

Verify all of these before enabling the timer:

- The displayed matter is exactly M12205; source category counts and metadata
  match the reply. Every claimed download is complete and verified.
- The request receipt under `data/work/requests/` lists selected source IDs,
  files, hashes, archive entries, and the sending checkpoint/provider reply ID.
- The reply arrives in the sender's inbox in the expected thread with the ZIP.
  Download it, run `unzip -t`, compare entries/counts and SHA-256 with the local
  archive under `data/work/attachments/`. Provider acceptance alone is insufficient.
- Re-run the same `run --message-id` command: it must report `already_claimed`
  without another model launch or reply.
- Exercise an empty category and an ambiguous request. Neither should get an
  invented archive; the latter needs an accurate clarification.
- Exercise a larger request, such as M12205 Other Documents. The current bridge
  supports inline local attachments only: the agent must either deliver a
  verified leading prefix below the conservative limit with an explicit partial
  explanation, or record blocked delivery. Do not claim full ten-file parity.
- Interrupt a test run and inspect its claim/receipts before any retry. Check Sent
  mail after an uncertain send; never clear a claim merely to try sending again.

The runner verifies a claimed reply by reading its provider message and checking
inbox, reply ID, original message/thread, single original sender recipient, no
extra CC/BCC, and a nonempty ZIP attachment when files were claimed. Source file
identity, ZIP contents and factual reply quality are still verified by the agent
workflow and the recipient acceptance test; the wrapper does not turn model
output into independent proof of those facts.

## Enable automatic operation after acceptance

Set `MARKDOWN_AGENT_ENABLED=true` in `.env`. Adjust or clear the sender allowlist
when ready for other users. Install and start the separate timer:

```sh
npm run install:service
systemctl --user daemon-reload
systemctl --user enable --now senpilot-markdown-agent.timer
sudo loginctl enable-linger "$USER"
systemctl --user status senpilot-markdown-agent.timer
journalctl --user -u senpilot-markdown-agent.service -f
```

The timer runs a cheap inbox check one minute after the previous check/job ends.
Idle checks never call the model. Each invocation launches at most one agent job,
with a 15-minute deadline and 20 launches per UTC day by default. The cap counts
failed launches too; it is not an exact spending/token limit. There is no paid
API-key fallback. No automatic processing retry is provided in this initial
deployment wrapper. Both services can work simultaneously; each agent's browser
downloads remain sequential to avoid FileMaker dialog interference.

The first configure saves a cutoff timestamp. Automatic polling excludes earlier
mail but leaves new eligible mail pending after daily capacity is reached. An
explicit `run --message-id` can select an older message, still subject to the
allowlist, daily cap and existing claims. Polls page through received messages
after the cutoff; if pagination cannot complete, they fail instead of silently
skipping pages. This is appropriate for the take-home inbox scale, not an
unbounded long-term mail archive.

Keep the laptop awake on AC power. Send new requests to both inboxes at once;
verify both responses and attachments, then repeat after logout, reboot and
your intended lid behavior. Ubuntu suspend behavior has not been tested here.

## Inspect, stop and recover

```sh
npm run status
systemctl --user stop senpilot-markdown-agent.timer
systemctl --user stop senpilot-markdown-agent.service
```

Stopping the timer alone does not stop an active job. Private agent transcripts
are in `data/work/requests/<claim>/agent.log`; the receipt and final result are in
that request directory. They can contain mailbox content and must stay out of
Git. `state.json` retains claims and daily launch counts. Preserve the whole
`data/` directory across restarts and moves, with both old and new runners stopped.

Failed, interrupted, or unverified jobs remain `review_required` or `running` and
are skipped. A crash can leave `data/runner.lock`; the next check refuses to run.
First stop the units, confirm no agent/browser/mail bridge is still running,
inspect the request receipt and provider Sent thread, then remove only the stale
lock if safe. This initial version intentionally has no automatic claim-reset
command. Reconcile provider acceptance manually; ask the sender for a new request
only after establishing what happened. Never delete `state.json` to retry.

If `configure` reports the state belongs to another inbox, do not overwrite it.
Use a separate copy of the deployment folder and a separate key instead.
Defaults put state, downloads and auth under this directory's ignored `data/`.
No cleanup deletes receipts or downloads automatically; monitor disk use and
archive completed artifacts privately as needed, retaining claims/uncertain jobs.

## Remaining work and limits

- Complete the Ubuntu manual and automatic acceptance checks above. A successful
  Codex process exit is not a verified successful document retrieval or delivery.
- Test a configured larger-file transport before promising complete large ZIPs.
  The selected bridge Base64-encodes local files internally. The workflow uses
  a conservative raw ZIP ceiling below 4,000,000 bytes for the whole-request
  inline limit; the bridge's own decoded-size ceiling is not a promise that a
  larger inline JSON request will fit.
- Inbox/key separation is enforced by provider scope; workspace-write controls
  shell writes, not a complete security boundary around MCP or filesystem reads.
  Use a dedicated Ubuntu account and an inbox-scoped key, and keep unrelated
  personal secrets out of that account. The shell environment excludes mail
  credentials; the bridge receives its key through an allowed environment variable.
- Browser/mail MCP schemas may change. Dependencies are locked, but the bridge
  discovers the hosted mail catalog at runtime. Repeat diagnostics after upgrades.

## Sources and local checks

- [OpenAI non-interactive execution](https://learn.chatgpt.com/docs/non-interactive-mode):
  bounded `codex exec` jobs with explicit workspace-write permissions.
- [OpenAI MCP configuration](https://learn.chatgpt.com/docs/extend/mcp?surface=cli):
  required stdio servers, environment forwarding, tool allowlists and approval policy.
- [AgentMail MCP](https://docs.agentmail.to/integrations/mcp) and its linked
  [official bridge](https://github.com/agentmail-to/agentmail-mcp): local attachment
  paths are a bridge feature, not a hosted-server filesystem capability.
- [AgentMail attachments](https://docs.agentmail.to/attachments): inline JSON
  includes Base64 overhead; URL-backed delivery is a separate route.
- [Microsoft Playwright MCP](https://github.com/microsoft/playwright-mcp): headless
  browser tools, isolated contexts and output-directory configuration.

Local checks: `npm test`, `npm run tools:check`, and Codex MCP config loading
with CLI 0.164.0. These do not exercise a model or send a real email. The repository
root's `npm run check` and `npm test` also remain required for the existing worker.

On October 26, 2026: all 10 deployment tests passed, including a real launcher
invocation against a fixture CLI; the real headless MCP download check passed;
and Codex loaded both generated MCP entries. The existing worker's typecheck
passed, with 63 tests passed and 3 opt-in checks skipped. Authenticated mail MCP,
live model execution and Ubuntu service behavior were not exercised here.
