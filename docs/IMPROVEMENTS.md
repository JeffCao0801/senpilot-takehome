# Efficiency and response improvements

Follow-up work on October 26, 2026, compared the initial implementation at
`1ae5b3f` with the revised code. Two read-only delegated reviews supplied
additional findings. Changes preserve sequential browser/email processing and
the default forced-Codex parsing mode.

## Measured changes

| Local benchmark                                                        |    Before |    After |
| ---------------------------------------------------------------------- | --------: | -------: |
| Prepare a 25,000,000-byte attachment fixture for mocked Drive (median) |  27.41 ms |  9.70 ms |
| Peak process RSS for that isolated benchmark                           | 191.5 MiB | 85.0 MiB |
| 2,000 known-message checks with 32 KiB stored bodies (median)          |  36.80 ms |  4.55 ms |

The attachment benchmark ran in separate Node processes with garbage collection
between calls, one warmup and seven measured calls per implementation. It mocked
Drive creation with a definite 403 before any upload/send, exercising the same
file read, branch selection and checksum path without contacting a provider.
The fixture was synthetic bytes named `.zip`; this benchmark measures mail
preparation, not archive construction or validity. Valid ZIP handling is
verified separately by archive tests and the live transcript collection.
The process also created its synthetic input file. RSS is whole-process peak
memory, not a per-request allocation figure. The journal benchmark used an
in-memory SQLite store with twenty synthetic messages and seven measured passes.

These are development-Mac measurements, not Ubuntu measurements or end-to-end
delivery timings. Network and website delays still dominate real collection.
The useful resource saving is avoiding large temporary base64/JSON strings:
Drive selection now computes the exact encoded size from the JSON scaffold and
base64 length before allocating those strings. Boundary tests compare the
decision with actual UTF-8 serialization, including escaped/unicode text and
base64 padding. Duplicate checks now use `SELECT 1` rather than decoding stored
mail and collection results on every poll.

An optional `PARSER_MODE=auto` uses rules for simple, unambiguous canonical
requests and Codex for other wording. A canonical auto-mode regression took
under a millisecond without a subprocess; the separate live Codex test took
about 5.6 seconds. Those are different test inputs and do not establish a general
speed ratio. `codex` remains the default. No local credential setting changed.

## More useful replies

- The opening sentence states attached, partial, empty or unattached status.
- Source-entry counts are separate from file counts. One entry with two
  attachments can now report “Selected 1 of 1 source entries; downloaded 2
  verified files,” instead of “2 of 1 files.”
- Attached filenames map to source identifiers and titles. Downloaded files
  without a ZIP are explicitly labeled local and unattached.
- Common download failures receive a readable explanation. Browser locators,
  timeouts and private filesystem paths remain in local diagnostics.
- Attachment failure warnings are not repeated.
- Subject and body are parsed together so a body fast path cannot hide a
  conflicting matter/category in the subject.
- Requested counts, dates or sort orders are clarified rather than silently
  discarded. The collector still selects up to ten files in source default order.

## Collection reliability and verification

Virtual scrolling now compares the same raw DOM fields before and after a
scroll. Previously headers/empty rows could make a mismatched comparison finish
before the virtual list updated. A real Chromium regression exercises a delayed
row update with headers and empty rows. Unknown/unsupported file formats no
longer trigger a second deterministic download attempt, and files rejected by
validation are removed from disk.

**66 tests passed with no skips**, including live Codex inference and browser
regressions. Type checking and build passed. A fresh live M10431 / Transcripts
collection verified all ten files and its 7,246,384-byte ZIP. Doctor confirmed
mailbox read access, installed browser and ChatGPT login. No live email was
sent during this pass; the original Gmail delivery evidence remains in TESTING.md.

Ignored local evidence lives in `artifacts/improvements/` (benchmark script,
raw measurements, transcript manifest/ZIP/reply preview) and
`artifacts/acceptance/improvement-live-tests.txt`. Credentials, mailbox state
and downloads remain excluded from Git. The worker remains stopped for the
planned Ubuntu transfer; `agent-experiment/` was not edited.
