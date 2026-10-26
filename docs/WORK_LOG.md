# Development work log

This implementation used Codex for planning, coding, delegated implementation,
review and live acceptance testing. It should be presented as AI-assisted work.
The applicant should explain the design and decisions in their own words.

## Scope and time

The employer's brief suggests a three-hour exercise. The applicant explicitly
asked to discard that development timebox and authorized an extended autonomous
session. This repository must not be represented as a three-hour implementation.
No reliable stopwatch total was retained; report actual personal time separately
from autonomous agent time rather than inventing a precise duration.

The selected approach is TypeScript, local Playwright, AgentMail and Codex CLI
using the applicant's ChatGPT login. The final host is the applicant's Ubuntu
laptop, installed locally by the applicant. No remote repository or hosted
deployment was requested. The independent approach at
`agent-experiment/SENPILOT_AGENT.md` was left untouched.

## Implementation and investigation

1. Read the recruiting email and assignment, explored the public FileMaker
   WebDirect database and initialized local Git. Chose outbound email polling
   so the laptop needs no public server or inbound network configuration.
2. Built collection and archive verification. Live exploration exposed search
   field commit-on-blur behavior, category-specific row layouts, virtual lists,
   exhibit identifier spacing, and transcript/recording export dialogs.
   Repaired those paths and reran real source requests.
3. Delegated bounded pieces: AgentMail plus durable storage, isolated request
   parsing, large-attachment staging, and safe login-refresh persistence.
   Integrated them with sequential job processing, source-backed summaries,
   resource limits and operational commands.
4. With explicit approval, created an expiring inbox-scoped AgentMail worker
   key, restricted it to mail read/send/reply and file read/create permissions,
   and enabled the free Labs Drive capability. No paid API fallback was added.
5. Ran two delegated reliability reviews. Fixed all reported findings and added
   relevant regressions. In particular, uncertain sends remain quarantined,
   while definite rate-limit rejections can retry with bounded backoff.
6. Sent five authorized Gmail requests through the running worker, checked
   replies in Gmail and downloaded both ZIPs for byte and entry verification.
   Restarted the worker to check durable deduplication. Independently collected
   six exhibits and all ten transcripts on other matters.
7. Tested recording exports and found the selected real recordings exceeded
   the file budget. Added/verified early cancellation and honest limitation
   reporting. This remains a documented capability limit, not a successful
   recording-delivery claim.
8. Supplied Ubuntu installation and service helpers, operating instructions,
   test evidence and a five-minute demo outline. Final automated validation
   passed 58 tests with both live test flags enabled.

## Handoff

On October 26 the applicant requested exploration of efficiency and response
quality. Two read-only delegated reviews informed a focused improvement pass:
avoid throwaway base64 allocation for large ZIPs, use indexed existence queries
for deduplication, wait for actual virtual-row changes, remove rejected downloads,
and avoid retries for deterministic file-format failures. Replies now distinguish
source entries, downloaded files and attached files, map filenames to sources,
and explain failures without browser internals. Parsing checks subject and body
together and clarifies unsupported selection constraints. An opt-in `auto` mode
uses the existing safe rules path to avoid unnecessary model calls; the default
remains `codex`. Measurements and follow-up validation are in `IMPROVEMENTS.md`.

The code and documentation are prepared locally. Runtime credentials, downloaded
documents and mailbox evidence are excluded from Git. The worker is stopped at
handoff so the applicant can transfer its journal and start one service on Ubuntu.
The configured worker key expires November 1, 2026.

Remaining applicant actions: follow `UBUNTU.md`, verify an actual Ubuntu email
round trip and awake/reboot behavior, understand and rehearse the implementation,
push to their account, record an honest Loom demonstration, test its share link
signed out, and submit the code link, video and agent address.
