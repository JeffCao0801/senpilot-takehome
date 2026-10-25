# Validation record

Verified on October 25, 2026, on the development Mac with Node 26.12.1,
Codex CLI 0.164.0 and Playwright Chromium. This records observed results;
it is not a guarantee that the public website or providers will stay unchanged.

## Automated checks

```sh
npm run check
RUN_CODEX_INTEGRATION=1 BROWSER_INTEGRATION=1 npm test
npm run build
npm run format:check
bash -n scripts/setup-ubuntu.sh
```

Final result: **58 passed, zero failed, zero skipped**. Type checking, build,
formatting and shell syntax checks passed. The default `npm test` skips the
opt-in live inference and browser checks. Live inference consumes Codex usage.

Coverage includes request validation and ambiguity, isolated model execution,
auth refresh persistence, source row identity, metadata and category counts,
download signatures and ZIP hashes, sender-only replies, inline request size,
Drive staging and header isolation, durable job transitions, cutoff boundaries,
duplicate prevention, daily caps, process locking and definite HTTP 429 retry.
A browser integration test downloads a deliberately slow local file and
verifies cancellation before the complete oversized response is transferred.

## Real email acceptance

Five new requests were sent from the authorized Gmail account to the AgentMail
inbox. The worker handled them without manual guidance after receipt.

| Request                   | Observed result                                                                                 |
| ------------------------- | ----------------------------------------------------------------------------------------------- |
| M12205 / Other Documents  | Ten documents; 10,360,603-byte ZIP delivered as a Gmail attachment through Agent Drive staging. |
| M12205 / Key Documents    | Six documents; 988,825-byte ZIP delivered through the inline attachment path.                   |
| M12205 / Transcripts      | Correct zero-document response without an attachment.                                           |
| M12205 without a category | Clarification reply without an attachment.                                                      |
| M99999 / Exhibits         | Matter-not-found reply without an attachment.                                                   |

Both received ZIPs were downloaded from Gmail and compared with the sent
archives and their verified entries. The ten-document archive SHA-256 was
`a658a2a7762ae62042bab5482a8bc46953dd422beda199ca4feda32e8a2a624c`.
Recipient-side download verification is stronger evidence than the provider's
send acceptance receipt alone.

After a graceful stop, a one-shot restart retained the same five completed
jobs and daily attempt count of five, with no duplicate reply.

## Additional source collection checks

| Source request       | Observed result                                                                                                                                                               |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M12383 / Exhibits    | All six files, including exhibit identifiers with spacing variants; verified ZIP of 6,268,172 bytes.                                                                          |
| M10431 / Transcripts | All ten transcripts, including distinct sessions sharing a date; verified ZIP of 7,246,384 bytes.                                                                             |
| M10431 / Recordings  | Export dialog reached for the first ten source rows. Every tested recording exceeded the 25 MiB file budget and was cancelled. Zero files collected; explicit failure result. |

The recordings test verifies export navigation and oversized-transfer handling.
It does **not** establish successful live delivery of a small recording. Media
signature detection is covered by fixtures. The assignment cannot be fulfilled
with an email attachment for arbitrarily large recordings; the app reports
that limitation instead of claiming success or silently substituting a link.

M12205 currently showed category counts of 13 exhibits, 6 key documents,
43 other documents, 0 transcripts and 0 recordings. Counts can change. Their
sum is described as listed category entries, not a unique-document count.

## Local evidence and remaining checks

Private runtime evidence is intentionally excluded from Git:

- `artifacts/acceptance/final-tests.txt`: final test output.
- `artifacts/acceptance/delivery-verification.json` and
  `inline-delivery-verification.json`: recipient archive verification.
- `artifacts/acceptance/gmail-delivered.png`: delivered ZIP screenshot.
- `artifacts/acceptance/M10431-Transcripts-ten/` and
  `M10431-Recordings-batch/`: source manifests, screenshots and results.
- `data/jobs.sqlite`: durable receipts for the five email tests.

Two independent delegated review rounds found issues that were repaired and
regression-tested: initial cutoff widening, rules-mode subject handling,
download promise rejection, limits applied too late, repeated message hydration,
retention only at startup, doctor using the wrong auth directory, and terminal
handling of definite send rate limits. Operating instructions also now explain
parser outages and the exclusive auth-directory requirement.

The Ubuntu setup script and generated systemd unit have not run on the target
laptop. Verify browser dependencies, login, service restart, logout/lid behavior,
reboot and a fresh email round trip there using [the Ubuntu guide](UBUNTU.md).
Long-term free-tier API sustainability and external service uptime remain
unverified. No repository push, Loom recording or submission email was made.
