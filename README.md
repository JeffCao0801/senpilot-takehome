# Senpilot regulatory document agent

Email a matter number and document category to **jeffcao@agentmail.to**. The
TypeScript worker interprets the request using a local Codex ChatGPT login,
collects current filings from Nova Scotia's public database, and replies in
the same email thread with metadata, category counts, and a ZIP of up to ten
verified files.

Example request:

> Please send Other Documents for M12205.

Categories: **Exhibits**, **Key Documents**, **Other Documents**,
**Transcripts**, and **Recordings**. Missing or conflicting details receive
a clarification. The model is used only to interpret the request; metadata,
counts, filenames, downloads, archive contents, and recipients are checked by
application code.

Source assignment: [Co-op Technical Assignment — Winter 2027](https://docs.google.com/document/d/1p1fvottZnA9DEtIor3byp75sD3AGQJWP-0_IcrlBm8A/edit).
Source website: [Nova Scotia public documents database](https://uarb.novascotia.ca/fmi/webd/UARB15).

## Run locally

Requires **Node.js 24+**, npm, Chromium via Playwright, and Codex CLI with a
file-backed ChatGPT login. Tested CLI version: **0.164.0**.

```sh
npm ci
npx playwright install chromium
cp .env.example .env
chmod 600 .env
```

Set `AGENTMAIL_API_KEY` and `AGENTMAIL_INBOX_ID` in `.env`. The configured
inbox key needs only `message_read`, `message_send`, `message_reply`,
`file_read`, and `file_create`. Large attachments use Agent Drive, which
requires opting into AgentMail Labs. The current worker key expires
**November 1, 2026**. No key or Codex credential belongs in Git.

```sh
codex login
npm run doctor -- --live-parser
npm start
```

For unattended operation, use a dedicated Codex login directory and user
service: **[Ubuntu setup and operation](docs/UBUNTU.md)**. The laptop needs
outbound internet and must stay awake. There is no hosted backend or public
HTTP endpoint to deploy.

## Commands

```sh
# Collect without sending mail; result.json, screenshots, files and ZIP go to data/runs/
npm run collect -- --matter M12205 --category "Other Documents"

# Process currently available messages once and exit
npm start -- --once

# Review durable job states and verified send receipts
npm run dev -- status

# Model/request-parser check (consumes one Codex inference)
npm run dev -- parse --text "Please get the exhibits for M12383"

npm run check
npm test
npm run build
```

`PARSER_MODE=codex` is the default and forces a bounded Codex call for
otherwise valid requests. `PARSER_MODE=auto` avoids model latency/usage for
simple canonical requests and uses Codex for other wording. Both email subject
and body are checked for conflicting instructions before either path.
`PARSER_MODE=rules` supports simple canonical
requests without model usage. Missing/multiple matter numbers or categories
can be rejected before an inference call. An optional `CODEX_MODEL` selects
a model available to your Codex account.

The collector retrieves up to ten files in the website's default order.
Requests for a custom count, date range or sorting receive a clarification;
they are not silently treated as the default selection.

## Design and tradeoffs

- **Email:** AgentMail REST polling over outbound HTTPS, every 20 seconds.
  The first scan reads eligible inbox history unless `START_AFTER` is set.
  Subsequent scans overlap by one day to tolerate delayed mail; known message
  IDs are skipped before fetching bodies. No webhook server is needed.
  Duplicate checks use an indexed existence query without decoding old jobs.
- **Interpretation:** a fresh, isolated `codex exec` with a structured output
  schema and disabled tools, plugins, MCP, hooks and project guidance. Only
  ChatGPT auth is copied into the subprocess; mailbox secrets are excluded.
  Replies never reflect arbitrary model-generated text or use body-supplied
  recipient addresses. The returned category must be supported by the request.
- **Collection:** a fresh Playwright browser context per job. WebDirect commits
  search fields on blur. Document layouts differ by category: numeric IDs,
  exhibit labels and date/format rows are handled explicitly. The collector
  selects source rows in the website's default order and scrolls when needed.
- **Evidence:** source metadata/counts, selected rows, SHA-256 hashes, verified
  download sizes, screenshots and a result manifest. ZIP entries are read back
  and compared with the manifest. The ZIP itself contains only document files.
- **Delivery:** small ZIPs are base64 attachments. Larger ZIPs are uploaded to
  Agent Drive, then its short-lived signed URL is supplied as an attachment
  source to AgentMail. The user receives a regular ZIP attachment, not a link.
  Staged files expire after 24 hours.
  Inline size is calculated before base64 encoding, avoiding large throwaway
  strings for ZIPs that need Drive.
- **Persistence:** SQLite journals jobs by inbox + incoming message ID. A
  process lock prevents competing workers. Processing may retry once; sending
  is journaled before the provider call and uncertain sends are quarantined
  for inspection. A stable provider idempotency key adds protection.
- **Usage:** one sequential job, 20 processing attempts per UTC day by default,
  60-second parser timeout, five-minute collection deadline, and bounded
  downloads. These control activity, not an exact Codex credit/dollar budget.
  API billing is not used as a fallback. See `.env.example` for configuration.

The matter-wide total is explicitly labeled as the **sum of five category
counts**. It is not represented as a verified unique file count, because
category lists may overlap. Dates retain the site's MM/DD/YYYY format.

## Validation and limitations

See **[test evidence](docs/TESTING.md)** for actual automated and live checks.
See **[improvement measurements](docs/IMPROVEMENTS.md)** for the later efficiency
and response-quality pass.
The 10-document M12205 ZIP was received in Gmail, downloaded, and verified
byte-for-byte against the sent archive. This is recipient-side evidence,
separate from AgentMail accepting a send.

- Normal provider/network, file-security and size constraints still apply.
  The app never bypasses restricted documents or executes downloads.
- Limits: ten attached files, 25 MB ZIP, 25 MiB per file, 50 MiB archive inputs.
  Multi-attachment source records share the ten-file cap. If a ZIP cannot be
  attached, the reply says so explicitly; the local evidence is retained.
- A parser authentication/quota failure retries once, then sends an accurate
  temporary-unavailable response. Restore the service's login/allowance before
  asking the user to retry.
- Preserve `data/jobs.sqlite` across restarts/machine transfers. Clearing it
  loses duplicate protection. An uncertain send requires inspecting Sent mail;
  the app deliberately avoids guessing whether to resend.
- The Ubuntu script/unit are supplied for local installation. Real Ubuntu
  power, logout/lid and reboot behavior must be verified on that laptop.
- There is no external uptime guarantee for a locally hosted laptop worker.

## Project layout

`src/` contains the application, `test/` the deterministic tests, `scripts/`
the Ubuntu setup helpers, and `docs/` operating/test/demo notes. `.env`,
`data/` and `artifacts/` are excluded from Git.

The independent alternative approach remains untouched at
`agent-experiment/SENPILOT_AGENT.md`. It is not part of this worker.

## Development disclosure

This project was developed with Codex, including delegated implementation and
review tasks. Planning/exploration, implementation, live tests, discovered
limitations and repairs are documented in [the work log](docs/WORK_LOG.md).
The applicant should understand and explain the implementation, actual time
spent, AI assistance, and remaining limitations in the demo. No repository
has been pushed and no submission email has been sent.
