# Run the agent on your Ubuntu laptop

This is a local worker. It needs outbound internet, power, and an awake laptop.
It does not require SSH, a public web server, a tunnel, or inbound ports.
The application polls AgentMail over HTTPS and runs Chromium locally.

To run the independent Markdown agent alongside this worker, use the separate
[agent deployment guide](../agent-deployment/README.md). It has its own inbox,
key, Codex login, state and timer; do not point either worker at the other's
inbox or runtime files.

## 1. Copy the project

Copy the source and lockfile to Ubuntu. Install Node.js **24 or newer**, npm,
and Codex CLI. Development was verified with Node 26 and Codex CLI **0.164.0**.
The parser uses CLI feature/config controls, so run the live doctor after any
CLI update. The project does not bundle or publish your Codex login.

Run from the project directory:

```sh
bash scripts/setup-ubuntu.sh
```

Playwright's `--with-deps` option may ask for sudo to install Ubuntu browser
dependencies. Keep your AgentMail key only in the local `.env` (mode 600).
Transfer it privately from your password manager or enter it locally. `.env`
is excluded from Git. The created worker key expires **November 1, 2026**;
replace it in AgentMail if evaluation continues beyond then.

## 2. Give the service its own Codex login

Use a dedicated auth directory so the service can persist token refreshes
without racing another Codex session. Sign in interactively as your own user:

```sh
mkdir -p "$HOME/.local/share/senpilot-codex"
chmod 700 "$HOME/.local/share/senpilot-codex"
CODEX_HOME="$HOME/.local/share/senpilot-codex" codex login
```

Complete the normal browser login yourself. Set the following in `.env`, using
your **actual absolute path** (environment files do not expand `$HOME`):

```dotenv
SENPILOT_CODEX_AUTH_HOME=/home/YOUR_USER/.local/share/senpilot-codex
```

The parser requires file-backed ChatGPT auth. If your environment uses an OS
keyring, configure `cli_auth_credentials_store = "file"` in this dedicated
Codex directory before login. Protect `auth.json` like a password. Never put
it in the project, share it, or commit it. Run no other Codex process using
this dedicated auth directory while the service is running.

The isolated parser copies only auth into a temporary private directory and
disables tools, MCP, browser use, hooks, plugins, skills and project guidance.
It persists refreshed ChatGPT tokens back to the dedicated auth file.
Mail credentials are not passed to the model subprocess.

## 3. Verify before starting

```sh
npm run check
npm test
npm run doctor -- --live-parser
npm run collect -- --matter M12205 --category "Key Documents"
```

The live parser check consumes one Codex inference. Doctor verifies mailbox
read access and installed browser, and reports parser status. To test actual
delivery, send a new email from a separate address to the agent inbox, then run:

```sh
npm start -- --once
npm run dev -- status
```

Check your sender inbox for the response and attached ZIP. A `complete` job
means AgentMail accepted a reply, while recipient-side delivery is verified
separately. `--once` processes currently eligible jobs and exits; it does not
wait for delayed retries.

## 4. Install a user service

```sh
npx tsx scripts/install-service.ts
systemctl --user daemon-reload
systemctl --user enable --now senpilot-agent.service
systemctl --user status senpilot-agent.service
journalctl --user -u senpilot-agent.service -f
```

For the user service to survive logout, enable lingering once:

```sh
sudo loginctl enable-linger "$USER"
```

Keep the laptop plugged in and configure Ubuntu's power settings to stay
awake on AC power, including the lid behavior you intend to use. Test this
by logging out/closing the lid, sending another email, and checking delivery.
These laptop-specific settings have not been changed or tested from the Mac.

## Operation and limits

- Default: one sequential browser job, poll every 20 seconds, 20 job attempts
  per UTC day, at most two processing attempts per message. A retry consumes
  another daily slot. `DAILY_REQUEST_LIMIT=0` pauses job processing.
- `PARSER_MODE=auto` is an optional latency/usage optimization: simple canonical
  requests use validated rules; other wording uses Codex. `codex` remains the
  default for demonstrating model interpretation. Custom counts, date ranges
  and sorting are clarified because collection uses the website's default order.
- Change `ALLOWED_SENDERS` to a comma-separated list during testing, or leave
  it empty so Senpilot can email the inbox. Automated mail/self replies are ignored.
- Codex uses your ChatGPT/Codex allowance and applicable credits. There is no
  exact dollar cap here. The daily job cap, one bounded parsing call per new
  attempt and 60-second parser timeout limit activity. No paid API fallback.
  Authentication/quota parsing failures retry once, then receive an honest
  temporary-unavailable email. Restore the service login/allowance before
  asking the requester to retry. Definite HTTP 429 send rejections can retry;
  ambiguous send outcomes remain quarantined.
- ZIPs above the inline limit use Agent Drive with a 24-hour expiry and a
  signed URL passed to AgentMail as an actual attachment. The recipient gets
  the ZIP in the email; its attachment does not expire with the staging URL.
  Requires Labs and `file_create`/`file_read`, in addition to mail permissions.
- Conservative limits: 25 MB ZIP attachment, 25 MiB per downloaded file,
  50 MiB total archive inputs, five-minute browser collection deadline.
  Oversized requests receive an explicit limitation response, not a link
  substituted for the required ZIP.
- Raw request/job receipts live in `data/jobs.sqlite`. Downloads/screenshots
  live under `data/runs/`; run directories older than `RETENTION_DAYS` (7 by
  default) are cleaned at startup and daily thereafter. Artifacts for unfinished or
  uncertain jobs are protected. Receipts remain for deduplication.
- `data/health.json` records the last successful poll. Watch the journal for
  `poll_error`, `job_error`, exhausted quota, expired keys, or `uncertain` jobs.
- Do not run two copies with the same data directory. The worker lock prevents it.
  Preserve `data/jobs.sqlite` when restarting or moving the service to retain
  duplicate protection. Stop the old worker before transferring the data.

## Stop and inspect

```sh
systemctl --user stop senpilot-agent.service
npm run dev -- status
```

Interrupted processing can retry. An interrupted/uncertain email send is
quarantined rather than resent automatically; inspect the AgentMail Sent
thread before taking further action. The application also sends a stable
provider idempotency key, but its provider retention is only 24 hours.
Keep the service stopped while manually editing or restoring job state.

To uninstall the service (retain project files and job receipts):

```sh
systemctl --user disable --now senpilot-agent.service
rm "$HOME/.config/systemd/user/senpilot-agent.service"
systemctl --user daemon-reload
```
