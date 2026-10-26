import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  AgentRequest,
  CollectionResult,
  IncomingMessage,
  SendReceipt,
} from "./types.js";

export type JobState =
  | "pending"
  | "processing"
  | "retry"
  | "sending"
  | "complete"
  | "failed"
  | "uncertain";
export interface StoredError {
  name: string;
  message: string;
}
export interface StoredJob {
  id: number;
  inboxId: string;
  messageId: string;
  message: IncomingMessage;
  state: JobState;
  attempts: number;
  request?: AgentRequest;
  result?: CollectionResult;
  receipt?: SendReceipt;
  error?: StoredError;
  nextAttemptAt: string;
  createdAt: string;
  updatedAt: string;
}

function timestamp(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()))
    throw new Error("Invalid store timestamp.");
  return date.toISOString();
}

function serializeError(error: unknown): string {
  return JSON.stringify(
    error instanceof Error
      ? { name: error.name, message: error.message }
      : {
          name: "Error",
          message: typeof error === "string" ? error : "Unknown error",
        },
  );
}

/**
 * SQLite journal for a single worker (caller owns the process lock).
 *
 * enqueue(message) -> inserted boolean, get(inboxId,messageId) -> StoredJob|undefined.
 * recordScan(inboxId,messages,cursor) atomically inserts/dedupes the full scan and advances its cursor.
 * claimNext({dailyCap,now?}) -> StoredJob|undefined; each processing attempt consumes one UTC-day slot.
 * setRequest/saveResult retain structured evidence while processing. markSending MUST precede POST.
 * complete requires a verified receipt. retry only accepts processing; sending can never be retried.
 * recoverInterrupted explicitly requeues processing and quarantines sending as uncertain at startup.
 * Uncertain jobs require external reconciliation/manual handling, never automatic claiming.
 */
export class JobStore {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:")
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS jobs (
        id INTEGER PRIMARY KEY,
        inbox_id TEXT NOT NULL, message_id TEXT NOT NULL, message_json TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('pending','processing','retry','sending','complete','failed','uncertain')),
        attempts INTEGER NOT NULL DEFAULT 0,
        request_json TEXT, result_json TEXT, receipt_json TEXT, error_json TEXT,
        next_attempt_at TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        UNIQUE(inbox_id, message_id)
      );
      CREATE INDEX IF NOT EXISTS jobs_ready ON jobs(state, next_attempt_at, id);
      CREATE TABLE IF NOT EXISTS scan_cursors (inbox_id TEXT PRIMARY KEY, cursor TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS daily_usage (day TEXT PRIMARY KEY, count INTEGER NOT NULL CHECK (count >= 0));
      PRAGMA user_version = 1;
    `);
  }

  close(): void {
    this.db.close();
  }

  private transaction<T>(work: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private decode(
    row: Record<string, unknown> | undefined,
  ): StoredJob | undefined {
    if (!row) return undefined;
    const json = <T>(value: unknown): T | undefined =>
      typeof value === "string" ? (JSON.parse(value) as T) : undefined;
    return {
      id: Number(row.id),
      inboxId: row.inbox_id as string,
      messageId: row.message_id as string,
      message: json<IncomingMessage>(row.message_json)!,
      state: row.state as JobState,
      attempts: Number(row.attempts),
      request: json<AgentRequest>(row.request_json),
      result: json<CollectionResult>(row.result_json),
      receipt: json<SendReceipt>(row.receipt_json),
      error: json<StoredError>(row.error_json),
      nextAttemptAt: row.next_attempt_at as string,
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
    };
  }

  enqueue(message: IncomingMessage): boolean {
    if (!message.inboxId || !message.messageId)
      throw new Error("Message inboxId and messageId are required.");
    const now = new Date().toISOString();
    return (
      Number(
        this.db
          .prepare(
            `INSERT INTO jobs
      (inbox_id,message_id,message_json,state,next_attempt_at,created_at,updated_at)
      VALUES (?,?,?,'pending',?,?,?) ON CONFLICT(inbox_id,message_id) DO NOTHING`,
          )
          .run(
            message.inboxId,
            message.messageId,
            JSON.stringify(message),
            now,
            now,
            now,
          ).changes,
      ) === 1
    );
  }

  /** Indexed duplicate check without loading or decoding stored mailbox/result JSON. */
  has(inboxId: string, messageId: string): boolean {
    return Boolean(
      this.db
        .prepare("SELECT 1 FROM jobs WHERE inbox_id=? AND message_id=?")
        .get(inboxId, messageId),
    );
  }

  get(inboxId: string, messageId: string): StoredJob | undefined {
    return this.decode(
      this.db
        .prepare("SELECT * FROM jobs WHERE inbox_id=? AND message_id=?")
        .get(inboxId, messageId),
    );
  }

  getById(id: number): StoredJob | undefined {
    return this.decode(
      this.db.prepare("SELECT * FROM jobs WHERE id=?").get(id),
    );
  }

  list({
    state,
    limit = 100,
  }: { state?: JobState; limit?: number } = {}): StoredJob[] {
    if (!Number.isSafeInteger(limit) || limit < 1)
      throw new Error("Invalid job list limit.");
    const rows = state
      ? this.db
          .prepare("SELECT * FROM jobs WHERE state=? ORDER BY id LIMIT ?")
          .all(state, limit)
      : this.db.prepare("SELECT * FROM jobs ORDER BY id LIMIT ?").all(limit);
    return rows.map((row) => this.decode(row)!);
  }

  getCursor(inboxId: string): string | undefined {
    return this.db
      .prepare("SELECT cursor FROM scan_cursors WHERE inbox_id=?")
      .get(inboxId)?.cursor as string | undefined;
  }

  /** Use recordScan for regular scans, so a crash cannot advance beyond unpersisted messages. */
  setCursor(inboxId: string, cursor: string): void {
    const normalized = timestamp(cursor);
    this.db
      .prepare(
        `INSERT INTO scan_cursors (inbox_id,cursor) VALUES (?,?)
      ON CONFLICT(inbox_id) DO UPDATE SET cursor=MAX(scan_cursors.cursor,excluded.cursor)`,
      )
      .run(inboxId, normalized);
  }

  recordScan(
    inboxId: string,
    messages: IncomingMessage[],
    cursor: string,
  ): number {
    const normalized = timestamp(cursor);
    if (messages.some((message) => message.inboxId !== inboxId))
      throw new Error("Scan inbox identity mismatch.");
    return this.transaction(() => {
      let inserted = 0;
      for (const message of messages) if (this.enqueue(message)) inserted++;
      this.setCursor(inboxId, normalized);
      return inserted;
    });
  }

  dailyCount(day = new Date().toISOString().slice(0, 10)): number {
    return Number(
      this.db.prepare("SELECT count FROM daily_usage WHERE day=?").get(day)
        ?.count ?? 0,
    );
  }

  claimNext({
    dailyCap,
    now = new Date().toISOString(),
  }: {
    dailyCap: number;
    now?: string;
  }): StoredJob | undefined {
    if (!Number.isSafeInteger(dailyCap) || dailyCap < 0)
      throw new Error("Daily cap must be a nonnegative integer.");
    const normalized = timestamp(now);
    const day = normalized.slice(0, 10);
    return this.transaction(() => {
      if (this.dailyCount(day) >= dailyCap) return undefined;
      const job = this.decode(
        this.db
          .prepare(
            `SELECT * FROM jobs WHERE state IN ('pending','retry')
        AND next_attempt_at <= ? ORDER BY id LIMIT 1`,
          )
          .get(normalized),
      );
      if (!job) return undefined;
      this.db
        .prepare(
          `INSERT INTO daily_usage (day,count) VALUES (?,1)
        ON CONFLICT(day) DO UPDATE SET count=count+1`,
        )
        .run(day);
      this.db
        .prepare(
          `UPDATE jobs SET state='processing',attempts=attempts+1,updated_at=? WHERE id=?`,
        )
        .run(normalized, job.id);
      return this.getById(job.id);
    });
  }

  private update(
    id: number,
    allowed: JobState[],
    sql: string,
    parameters: Array<string | number | null>,
  ): void {
    const result = this.db
      .prepare(
        `UPDATE jobs SET ${sql}, updated_at=? WHERE id=? AND state IN (${allowed.map(() => "?").join(",")})`,
      )
      .run(...parameters, new Date().toISOString(), id, ...allowed);
    if (Number(result.changes) !== 1)
      throw new Error(
        `Invalid job transition for job ${id}; expected ${allowed.join("/")}.`,
      );
  }

  setRequest(id: number, request: AgentRequest): void {
    this.update(id, ["processing"], "request_json=?", [
      JSON.stringify(request),
    ]);
  }

  saveResult(id: number, result: CollectionResult): void {
    this.update(id, ["processing"], "result_json=?", [JSON.stringify(result)]);
  }

  markSending(id: number): void {
    this.update(id, ["processing"], "state='sending', error_json=NULL", []);
  }

  complete(id: number, receipt: SendReceipt): void {
    if (!receipt.messageId.trim())
      throw new Error("A verified send receipt is required.");
    this.update(
      id,
      ["sending", "uncertain"],
      "state='complete',receipt_json=?,error_json=NULL",
      [JSON.stringify(receipt)],
    );
  }

  retry(
    id: number,
    error: unknown,
    delayMs = 60_000,
    now = new Date().toISOString(),
  ): void {
    if (!Number.isSafeInteger(delayMs) || delayMs < 0)
      throw new Error("Retry delay must be a nonnegative integer.");
    const next = new Date(
      new Date(timestamp(now)).getTime() + delayMs,
    ).toISOString();
    this.update(
      id,
      ["processing"],
      "state='retry',error_json=?,next_attempt_at=?",
      [serializeError(error), next],
    );
  }

  /** Only for an explicit provider rejection (e.g. HTTP 429), never a timeout/unknown send. */
  retryRejectedSend(
    id: number,
    error: unknown,
    delayMs = 60_000,
    now = new Date().toISOString(),
  ): void {
    if (!Number.isSafeInteger(delayMs) || delayMs < 0)
      throw new Error("Retry delay must be a nonnegative integer.");
    const next = new Date(
      new Date(timestamp(now)).getTime() + delayMs,
    ).toISOString();
    this.update(
      id,
      ["sending"],
      "state='retry',error_json=?,next_attempt_at=?",
      [serializeError(error), next],
    );
  }

  /** Use for definite pre-send failures/rejections only, never an unknown POST outcome. */
  fail(id: number, error: unknown): void {
    this.update(
      id,
      ["pending", "processing", "retry", "sending"],
      "state='failed',error_json=?",
      [serializeError(error)],
    );
  }

  markUncertain(id: number, error: unknown): void {
    this.update(id, ["sending"], "state='uncertain',error_json=?", [
      serializeError(error),
    ]);
  }

  recoverInterrupted(): { processing: number; sending: number } {
    const now = new Date().toISOString();
    return this.transaction(() => {
      const processing = Number(
        this.db
          .prepare(
            `UPDATE jobs SET state='retry',next_attempt_at=?,updated_at=?,error_json=? WHERE state='processing'`,
          )
          .run(
            now,
            now,
            serializeError(
              new Error(
                "Worker stopped during processing; safe to collect again.",
              ),
            ),
          ).changes,
      );
      const sending = Number(
        this.db
          .prepare(
            `UPDATE jobs SET state='uncertain',updated_at=?,error_json=? WHERE state='sending'`,
          )
          .run(
            now,
            serializeError(
              new Error(
                "Worker stopped during sending; reconcile sent messages before any resend.",
              ),
            ),
          ).changes,
      );
      return { processing, sending };
    });
  }
}
