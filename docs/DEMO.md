# Five-minute demo outline

Use your own words and show the actual running system. Record with Loom,
then test the final share link in an incognito window as the email requests.

1. **0:00–0:40 — Problem and design.** Email enters a dedicated AgentMail
   inbox; a TypeScript worker uses Codex to interpret it, navigates WebDirect,
   verifies downloads, builds a ZIP, and replies with current facts.
2. **0:40–2:30 — Real round trip.** Start the worker, send a request from a
   separate Gmail account, show safe job-stage logs, then open the reply and
   its ZIP. M12205 / Other Documents exercises the ten-file cap and larger
   attachment delivery. Hide secrets and unrelated inbox messages.
3. **2:30–3:20 — Evidence.** Show counts from the source page and the result
   manifest/ZIP contents. Explain that the assignment's sample counts have
   changed. Show a malformed request or zero-result reply briefly.
4. **3:20–4:20 — What was difficult.** FileMaker search blur/commit, different
   row layouts, virtual scrolling, verifying real download completion, the
   six-megabyte inline mail limit, and uncertain-send handling. Explain why
   the model does not control recipients or manufacture metadata.
5. **4:20–5:00 — Limitations and learning.** Local uptime, Codex allowance,
   key expiry and attachment limits. Explain actual AI assistance and time
   spent; describe what you would improve with more time.

Submission checklist: working agent address; accessible code link after you
push; Loom link that works signed out. The final submission to Paula remains
your action. The video should show your understanding and decisions, not
merely replay an agent transcript.
