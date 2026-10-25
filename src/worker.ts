import {
  mkdir,
  open,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import {
  AgentMailClient,
  AgentMailHttpError,
  SendUncertainError,
} from "./mail.js";
import { JobStore, type StoredJob } from "./store.js";
import { parseRequest } from "./parser.js";
import { collectDocuments } from "./collector.js";
import { renderReply } from "./summary.js";
import type { Config } from "./config.js";
import type { IncomingMessage } from "./types.js";

export const log = (event: Record<string, unknown>): void => {
  console.log(JSON.stringify({ at: new Date().toISOString(), ...event }));
};
const messageAddress = (message: IncomingMessage): string =>
  (message.from.match(/<([^<>]+)>/)?.[1] ?? message.from).trim().toLowerCase();

export function shouldProcess(
  message: IncomingMessage,
  config: Pick<Config, "inboxId" | "allowedSenders">,
): boolean {
  const from = messageAddress(message);
  if (from === config.inboxId.toLowerCase()) return false;
  if (config.allowedSenders.length && !config.allowedSenders.includes(from))
    return false;
  const headers = Object.fromEntries(
    Object.entries(message.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
  );
  if (
    headers["auto-submitted"] &&
    headers["auto-submitted"].toLowerCase() !== "no"
  )
    return false;
  if (/(?:bulk|list|junk)/i.test(headers.precedence ?? "")) return false;
  if (/^(?:mailer-daemon|postmaster|no-?reply)@/i.test(from)) return false;
  return true;
}

/** One worker owns the SQLite journal and browser sequence at a time. */
export async function acquireWorkerLock(
  directory: string,
): Promise<() => Promise<void>> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, "worker.lock");
  const token = randomUUID();
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const file = await open(path, "wx", 0o600);
      await file.writeFile(
        JSON.stringify({ pid: process.pid, host: hostname(), token }),
      );
      await file.close();
      return async () => {
        try {
          const current = JSON.parse(await readFile(path, "utf8"));
          if (current.token === token) await rm(path);
        } catch {}
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let old: { pid: number; host: string };
      try {
        old = JSON.parse(await readFile(path, "utf8"));
      } catch {
        throw new Error(
          "Worker lock is unreadable; inspect data/worker.lock before removing it",
        );
      }
      if (
        old.host !== hostname() ||
        !Number.isSafeInteger(old.pid) ||
        old.pid <= 0
      )
        throw new Error(
          "A worker lock from another host or invalid process exists",
        );
      try {
        process.kill(old.pid, 0);
        throw new Error(
          "Another worker is running against this data directory",
        );
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw e;
      }
      await rm(path);
    }
  }
  throw new Error("Could not acquire worker lock");
}

async function processJob(
  job: StoredJob,
  store: JobStore,
  mail: AgentMailClient,
  config: Config,
): Promise<void> {
  let sending = false;
  try {
    log({ stage: "job_started", jobId: job.id, attempt: job.attempts });
    let request = job.request;
    let clarification: string | undefined;
    if (!request) {
      // Body-first keeps rules-only mode usable with ordinary subject lines;
      // if it is incomplete, the subject can supply the missing request fields.
      const input =
        config.parserMode === "rules"
          ? job.message.text
          : `${job.message.subject}\n\n${job.message.text}`;
      let parsed = await parseRequest(input, {
        mode: config.parserMode,
        model: config.codexModel,
        codexPath: config.codexPath,
      });
      if (config.parserMode === "rules" && parsed.kind === "clarification")
        parsed = await parseRequest(
          `${job.message.subject}\n\n${job.message.text}`,
          { mode: "rules" },
        );
      if (parsed.kind === "clarification") {
        if (/^Codex\b/.test(parsed.message)) {
          log({
            stage: "parser_unavailable",
            jobId: job.id,
            message: parsed.message,
          });
          if (job.attempts < config.maxAttempts)
            throw new Error(parsed.message);
          clarification =
            "The document agent is temporarily unable to interpret your request. Please retry later. No documents were downloaded or attached.";
        } else clarification = parsed.message;
      } else {
        request = parsed.request;
        store.setRequest(job.id, request);
        log({
          stage: "parsed",
          jobId: job.id,
          source: parsed.source,
          matter: request.matterNumber,
          category: request.category,
        });
      }
    }
    let result = job.result;
    if (request && !result) {
      result = await collectDocuments(request, {
        headless: config.headless,
        outputDirectory: join(
          config.dataDirectory,
          "runs",
          `job-${job.id}-${Date.now()}`,
        ),
        log: (event) => log({ jobId: job.id, ...event }),
      });
      const retryable = result.failures.some(
        (f) =>
          !/(?:byte budget|size limit|unsupported file format|unknown media format|security is)/i.test(
            f.reason,
          ),
      );
      if (
        result.status === "failed" &&
        retryable &&
        job.attempts < config.maxAttempts
      )
        throw new Error(
          "Collection failed; retrying once before reporting the failure",
        );
      store.saveResult(job.id, result);
    }
    const text =
      clarification ??
      (result
        ? renderReply(result)
        : "Unable to process this request. Please provide a matter number and a document category.");
    let prepared;
    let attachedFiles = result?.documents.length ?? 0;
    try {
      prepared = await mail.prepareReply(job.message, text, result?.zipPath);
    } catch (error) {
      // Attachment rejection before provider submission is definite. An accurate
      // text-only response is preferable to a job with no explanation; it states
      // explicitly that attachment delivery failed.
      if (
        result?.zipPath &&
        !(error instanceof SendUncertainError) &&
        /(?:maximum|too large|Drive|file.*upload|attachment.*limit)/i.test(
          (error as Error).message,
        )
      ) {
        const issue =
          "The collected ZIP could not be attached within the configured provider limits. The job is retained locally for inspection.";
        result.warnings.push(issue);
        result.status = "partial";
        store.saveResult(job.id, result);
        prepared = await mail.prepareReply(
          job.message,
          renderReply(result, { attachment: false, deliveryIssue: issue }),
        );
        attachedFiles = 0;
      } else throw error;
    }
    store.markSending(job.id);
    sending = true;
    const receipt = await prepared.send();
    store.complete(job.id, receipt);
    log({
      stage: "reply_accepted",
      jobId: job.id,
      replyId: receipt.messageId,
      attachedFiles,
      collectionStatus: result?.status ?? "clarification",
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown processing error";
    if (sending) {
      if (error instanceof SendUncertainError)
        store.markUncertain(job.id, error);
      else if (
        error instanceof AgentMailHttpError &&
        error.status === 429 &&
        job.attempts < config.maxAttempts
      )
        store.retryRejectedSend(job.id, error, 60000);
      else store.fail(job.id, error);
    } else if (job.attempts < config.maxAttempts)
      store.retry(job.id, error, 30000);
    else store.fail(job.id, error);
    log({
      stage: "job_error",
      jobId: job.id,
      uncertain: error instanceof SendUncertainError,
      message,
    });
  }
}

async function cleanupRuns(
  directory: string,
  retentionDays: number,
  protectedJobIds: Set<number>,
): Promise<void> {
  const root = join(directory, "runs");
  await mkdir(root, { recursive: true });
  for (const name of await readdir(root)) {
    if (!/^job-\d+-\d+$/.test(name)) continue;
    if (protectedJobIds.has(Number(name.split("-")[1]))) continue;
    const path = join(root, name);
    const info = await stat(path);
    if (
      info.isDirectory() &&
      Date.now() - info.mtimeMs > retentionDays * 86400000
    )
      await rm(path, { recursive: true, force: true });
  }
}

export async function runWorker(
  config: Config,
  options: { once?: boolean; signal?: AbortSignal } = {},
): Promise<void> {
  const unlock = await acquireWorkerLock(config.dataDirectory);
  const store = new JobStore(join(config.dataDirectory, "jobs.sqlite"));
  const mail = new AgentMailClient({
    apiKey: config.apiKey,
    inboxId: config.inboxId,
    baseUrl: config.baseUrl,
  });
  try {
    const recovered = store.recoverInterrupted();
    log({
      stage: "worker_started",
      inbox: config.inboxId,
      parser: config.parserMode,
      dailyCap: config.dailyCap,
      recovered,
    });
    let lastCleanup = 0;
    do {
      try {
        if (Date.now() - lastCleanup > 86400000) {
          const protectedIds = new Set(
            store
              .list({ limit: 100000 })
              .filter((j) => !["complete", "failed"].includes(j.state))
              .map((j) => j.id),
          );
          await cleanupRuns(
            config.dataDirectory,
            config.retentionDays,
            protectedIds,
          );
          lastCleanup = Date.now();
        }
        const scannedAt = new Date().toISOString();
        const cursor = store.getCursor(config.inboxId);
        const after = scanAfter(cursor, config.startAfter);
        const incoming = (
          await mail.listIncoming({
            after,
            skipMessage: (id) => Boolean(store.get(config.inboxId, id)),
          })
        ).filter(
          (m) =>
            shouldProcess(m, config) &&
            (!config.startAfter ||
              Date.parse(m.timestamp) >= Date.parse(config.startAfter)),
        );
        const inserted = store.recordScan(config.inboxId, incoming, scannedAt);
        if (inserted) log({ stage: "mail_received", jobs: inserted });
        let job: StoredJob | undefined;
        while (
          !options.signal?.aborted &&
          (job = store.claimNext({ dailyCap: config.dailyCap }))
        )
          await processJob(job, store, mail, config);
        await writeFile(
          join(config.dataDirectory, "health.json"),
          JSON.stringify({
            at: new Date().toISOString(),
            inbox: config.inboxId,
            dailyUsed: store.dailyCount(),
            dailyCap: config.dailyCap,
            uncertainJobs: store.list({ state: "uncertain" }).length,
          }),
          { mode: 0o600 },
        );
      } catch (error) {
        log({
          stage: "poll_error",
          message:
            error instanceof Error ? error.message : "Mail polling failed",
        });
        if (options.once) throw error;
      }
      if (options.once || options.signal?.aborted) break;
      try {
        await delay(config.pollMs, undefined, { signal: options.signal });
      } catch {
        break;
      }
    } while (!options.signal?.aborted);
  } finally {
    store.close();
    await unlock();
    log({ stage: "worker_stopped" });
  }
}

export function scanAfter(
  cursor?: string,
  startAfter?: string,
): string | undefined {
  const overlap = cursor ? Date.parse(cursor) - 86400000 : undefined;
  const cutoff = startAfter ? Date.parse(startAfter) : undefined;
  if (overlap === undefined && cutoff === undefined) return undefined;
  return new Date(
    Math.max(overlap ?? -Infinity, cutoff ?? -Infinity),
  ).toISOString();
}
