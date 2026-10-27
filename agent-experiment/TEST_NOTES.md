# Workflow evidence and next checks

## October 25, 2026 — original manual run

An existing Codex session followed SENPILOT_AGENT.md using browser tools and
shell commands. No application code, tool installation, local credentials, or
background service was created for this experiment.

- Request: jeffcao0801@gmail.com → jeffcao-markdown@agentmail.to;
  M12205, up to 10 Other Documents.
- Live counts: 13 Exhibits, 6 Key Documents, 43 Other Documents,
  0 Transcripts, 0 Recordings; sum 62, not a proven unique-file count.
- Downloaded 10 files with different source IDs; all identified as PDFs. The
  full ZIP passed integrity checks and was approximately 9.9 MiB.
- The console rejected it with "An unexpected response was received from the
  server." No HTTP status was captured; attribution to the documented inline
  request limit is an inference.
- A ZIP of the first eight files was sent with that limitation explained.
  Gmail received it; a downloaded copy matched the original byte for byte.
- Evidence: `../artifacts/markdown-test-20261025/receipt.json`, archives,
  source files, and `gmail-received.jpg`. These are Git-ignored.

The run proves file transport and partial delivery. It does not establish
unique contents or semantic row-to-file matching for all downloaded files.

## October 25, 2026 — correctness and efficiency audit

Hash review found two pairs of identical payloads under different source IDs:

- 102329 / 102330: SHA-256
  `c79d5718376f45d86a6277a0baacca8b6f797622f300f734b07ff2710d948c65`.
- 102197 / 102202: SHA-256
  `d42573f5f9e64d462105001da4c30ebef04b0009f2f357e76c8aad3cb9ef761e`.

A newly opened filing-site session downloaded 102330 first, then 102329,
then 102202. Each expected dialog filename, download completion, and dialog
dismissal was checked. Hashes reproduced the original files. This supports
shared content at the source, but does not prove the site associates correct
contents with every row. Check previews and expected titles/dates before
claiming unique documents or treating the matching hashes as an agent error.
Fresh copies and hashes are saved in `../artifacts/markdown-audit-20261025/`.

The empty-category fast path was also rechecked live: selecting Transcripts
with a displayed count of 0 opened "No Matching Records" / "Click Ok to return
to Matter". No download or empty archive is needed for that case.

Updated instructions cover compact observations, condition-based waits,
visible rows, actual download paths, resume receipts, identity checks,
attachment preflight, explicit partial outcomes, and concise replies. Historical
evidence is separate so it need not be loaded on every request.

No new email was sent in this audit. No speedup has been measured. The revised
workflow has not had a full end-to-end rerun. No installations or local service
configuration were performed.

## Next acceptance checks

1. Compare identical requests with equivalent tools: elapsed time, browser
   calls, snapshot volume, retries, and correctness. Keep identity checks.
2. Compare suspicious file pairs with source previews/title/date evidence.
3. Verify full ZIP delivery using an already authorized larger attachment
   route. Do not assume MCP uploads local files or SMTP bypasses size limits.
4. Exercise the empty-category email reply, missing matter, malformed request,
   restricted file, duplicate event, interrupted collection, and uncertain send.
5. Test standalone CLI and Ubuntu independently. Set up an unattended trigger
   only when authorized.

## Sources checked October 25, 2026

- [AgentMail attachments](https://docs.agentmail.to/attachments): 6 MB whole
  inline request including Base64; URL-backed attachments around 30 MB.
- [AgentMail SMTP](https://docs.agentmail.to/imap-smtp): 10 MB whole-message limit.
- [AgentMail MCP](https://docs.agentmail.to/integrations/mcp): email tools exist;
  retrieval support alone does not establish local-file upload support.
- [Official OpenAI prompting guidance](https://learn.chatgpt.com/docs/prompting):
  specify goal, relevant context, boundaries, output, and verification.
