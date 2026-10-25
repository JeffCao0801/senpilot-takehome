import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { basename } from "node:path";
import type { IncomingMessage, SendReceipt } from "./types.js";

/** Entire UTF-8 JSON body, including base64, below AgentMail's 6 MB inline limit. */
export const MAX_SEND_BYTES = 5_800_000;
/** Conservative raw-byte ceiling below AgentMail's roughly 30 MB remote limit. */
export const MAX_REMOTE_ATTACHMENT_BYTES = 25_000_000;
const TIMEOUT_MS = 30_000;
const DRIVE_TTL_MS = 24 * 60 * 60 * 1000;
const URL_MARGIN_MS = 30_000;

/** Contains a signed URL in memory. Do not persist it; send immediately after markSending. */
export interface PreparedReply {
  send(): Promise<SendReceipt>;
}

export class SendUncertainError extends Error {
  constructor(
    message = "AgentMail send outcome is uncertain; reconcile sent messages before retrying.",
  ) {
    super(message);
    this.name = "SendUncertainError";
  }
}

export class AgentMailHttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly method: string,
    context = "AgentMail",
  ) {
    // Do not include response bodies: they can contain mailbox content or credentials.
    super(`${context} ${method} failed with HTTP ${status}.`);
    this.name = "AgentMailHttpError";
  }
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid AgentMail response object.");
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim())
    throw new Error(`Invalid AgentMail ${field}.`);
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function signedUrl(value: unknown): string {
  const input = requiredString(value, "file URL");
  // Never let a URL parser's exception expose the signed URL.
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error("Invalid AgentMail file URL.");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.hash)
    throw new Error("Invalid AgentMail file URL.");
  return input;
}

function futureTime(value: unknown, margin = 0): number {
  const time = typeof value === "string" ? Date.parse(value) : NaN;
  if (!Number.isFinite(time) || time <= Date.now() + margin)
    throw new Error(
      "AgentMail file or URL has expired or has invalid expiry. No email was sent.",
    );
  return time;
}

/** Extract one mailbox only; display names and embedded Reply-To/body text never select recipients. */
function senderAddress(from: string): string {
  if (/[\r\n\x00]/.test(from))
    throw new Error("Invalid source sender address.");
  const match = from.match(/^(?:[^<>]*<([^<>]+)>|([^<>]+))$/);
  const address = (match?.[1] ?? match?.[2] ?? "").trim();
  if (
    !/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(
      address,
    ) ||
    address.includes("..")
  )
    throw new Error("Source sender must contain exactly one valid mailbox.");
  return address;
}

/** Passive conversion only: no DOM execution, resource loading, or URL following. */
function htmlToText(html: string): string {
  const entities: Record<string, string> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " ",
  };
  return html
    .replace(/<!--[\s\S]*?(?:-->|$)/g, "")
    .replace(
      /<(script|style|iframe|object|template)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi,
      "",
    )
    .replace(/<\/?(?:p|div|br|li|tr|h[1-6]|blockquote)\b[^>]*>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(
      /&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi,
      (whole, entity: string) => {
        if (!entity.startsWith("#"))
          return entities[entity.toLowerCase()] ?? whole;
        const point =
          entity[1]?.toLowerCase() === "x"
            ? Number.parseInt(entity.slice(2), 16)
            : Number(entity.slice(1));
        return point > 0 &&
          point <= 0x10ffff &&
          !(point >= 0xd800 && point <= 0xdfff)
          ? String.fromCodePoint(point)
          : whole;
      },
    )
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function incoming(
  raw: Record<string, unknown>,
  inboxId: string,
  expectedMessageId: string,
): IncomingMessage {
  if (raw.inbox_id !== inboxId || raw.message_id !== expectedMessageId)
    throw new Error("AgentMail hydrated message identity mismatch.");
  const timestamp = requiredString(raw.timestamp, "timestamp");
  if (!Number.isFinite(Date.parse(timestamp)))
    throw new Error("Invalid AgentMail timestamp.");
  if (
    !Array.isArray(raw.labels) ||
    raw.labels.some((label) => typeof label !== "string")
  )
    throw new Error("Invalid AgentMail labels.");
  let headers: Record<string, string> | undefined;
  if (raw.headers !== undefined) {
    const values = object(raw.headers);
    headers = Object.fromEntries(
      Object.entries(values).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );
  }
  // Retain the whole body for forwarded requests; extraction can discard their content.
  const text = optionalString(raw.text)?.trim()
    ? (raw.text as string)
    : optionalString(raw.html)?.trim()
      ? htmlToText(raw.html as string)
      : (optionalString(raw.extracted_text) ??
        htmlToText(optionalString(raw.extracted_html) ?? ""));
  return {
    messageId: requiredString(raw.message_id, "message_id"),
    inboxId,
    threadId: optionalString(raw.thread_id),
    from: requiredString(raw.from, "from"),
    subject: optionalString(raw.subject) ?? "",
    text,
    timestamp,
    labels: raw.labels as string[],
    headers,
    inReplyTo: optionalString(raw.in_reply_to),
  };
}

/** REST contracts: docs.agentmail.to/{idempotency,attachments,api-reference/inboxes/{messages/reply,files/create,files/complete}}. */
export class AgentMailClient {
  private readonly apiKey: string;
  readonly inboxId: string;
  private readonly baseUrl: string;

  constructor(options: { apiKey: string; inboxId: string; baseUrl?: string }) {
    if (!options.apiKey.trim() || !options.inboxId.trim())
      throw new Error("AgentMail apiKey and inboxId are required.");
    const url = new URL(options.baseUrl ?? "https://api.agentmail.to/v0");
    if (url.username || url.password || url.search || url.hash)
      throw new Error("Invalid AgentMail base URL.");
    if (
      url.protocol !== "https:" &&
      !(
        url.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
      )
    ) {
      throw new Error(
        "AgentMail base URL must use HTTPS (except loopback tests).",
      );
    }
    this.apiKey = options.apiKey;
    this.inboxId = options.inboxId;
    this.baseUrl = url.href.replace(/\/$/, "");
  }

  private path(messageId?: string): string {
    return `/inboxes/${encodeURIComponent(this.inboxId)}/messages${messageId === undefined ? "" : `/${encodeURIComponent(messageId)}`}`;
  }

  private async request(
    path: string,
    body?: string,
    idempotencyKey?: string,
    sendMutation = false,
  ): Promise<Record<string, unknown>> {
    const method = body === undefined ? "GET" : "POST";
    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        method,
        redirect: "error",
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          Accept: "application/json",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
        },
        ...(body === undefined ? {} : { body }),
      });
      if (!response.ok) {
        // Server errors/timeouts may occur after acceptance. Never automatically resend.
        if (sendMutation && (response.status >= 500 || response.status === 408))
          throw new SendUncertainError();
        throw new AgentMailHttpError(response.status, method);
      }
      return object(await response.json());
    } catch (error) {
      if (
        error instanceof AgentMailHttpError ||
        error instanceof SendUncertainError
      )
        throw error;
      if (sendMutation) throw new SendUncertainError();
      // Avoid leaking fetch errors containing URLs, headers, or remote payloads.
      throw new Error(
        `AgentMail ${method === "GET" ? "read" : "file preparation"} failed or timed out. No email was sent.`,
      );
    }
  }

  /** Reads message scope only: inbox-scoped keys need not allow GET /inboxes/:id. */
  async verifyAccess(): Promise<{ messageCount: number }> {
    const page = await this.request(`${this.path()}?limit=1`);
    if (
      !Array.isArray(page.messages) ||
      typeof page.count !== "number" ||
      !Number.isSafeInteger(page.count) ||
      page.count < 0
    ) {
      throw new Error("Invalid AgentMail message listing.");
    }
    return { messageCount: page.count };
  }

  /** Paginate first, hydrate each received message, and return oldest first for durable processing. */
  async listIncoming({
    after,
    skipMessage,
  }: {
    after?: string;
    skipMessage?: (messageId: string) => boolean;
  } = {}): Promise<IncomingMessage[]> {
    if (after !== undefined && !Number.isFinite(Date.parse(after)))
      throw new Error("Invalid scan after timestamp.");
    const messages = new Map<string, IncomingMessage>();
    const seenPages = new Set<string>();
    let token: string | undefined;
    do {
      const query = new URLSearchParams({ limit: "100", labels: "received" });
      if (after !== undefined) query.set("after", after);
      if (token) query.set("page_token", token);
      const page = await this.request(`${this.path()}?${query}`);
      if (!Array.isArray(page.messages))
        throw new Error("Invalid AgentMail message listing.");
      for (const item of page.messages) {
        const summary = object(item);
        if (summary.inbox_id !== this.inboxId)
          throw new Error("AgentMail list inbox identity mismatch.");
        const id = requiredString(summary.message_id, "message_id");
        if (skipMessage?.(id)) continue;
        if (messages.has(id)) continue;
        const message = incoming(
          await this.request(this.path(id)),
          this.inboxId,
          id,
        );
        if (
          !message.labels.includes("received") ||
          message.labels.some((label) =>
            [
              "sent",
              "draft",
              "spam",
              "trash",
              "blocked",
              "unauthenticated",
            ].includes(label),
          )
        )
          continue;
        messages.set(id, message);
      }
      token = optionalString(page.next_page_token);
      if (
        page.next_page_token !== undefined &&
        page.next_page_token !== null &&
        token === undefined
      )
        throw new Error("Invalid AgentMail page token.");
      if (token && seenPages.has(token))
        throw new Error(
          "AgentMail repeated a pagination token; scan not complete.",
        );
      if (token) seenPages.add(token);
    } while (token);
    return [...messages.values()].sort(
      (a, b) =>
        Date.parse(a.timestamp) - Date.parse(b.timestamp) ||
        a.messageId.localeCompare(b.messageId),
    );
  }

  private filesPath(fileId?: string): string {
    return `/inboxes/${encodeURIComponent(this.inboxId)}/files${fileId === undefined ? "" : `/${encodeURIComponent(fileId)}`}`;
  }

  /** Uploads never share the authenticated API request helper or its headers. */
  private async stageZip(
    messageId: string,
    bytes: Buffer,
  ): Promise<{ url: string; expires: number }> {
    const digest = createHash("sha256").update(bytes).digest();
    const identity = createHash("sha256")
      .update(JSON.stringify([this.inboxId, messageId]))
      .digest("hex");
    const metadata = {
      path: `replies/${identity}/${digest.toString("hex")}.zip`,
      size: bytes.length,
      sha256: digest.toString("base64"),
      content_type: "application/zip",
    };
    const validate = (
      file: Record<string, unknown>,
      expectedId?: string,
    ): string => {
      if (
        file.inbox_id !== this.inboxId ||
        Object.entries(metadata).some(([key, value]) => file[key] !== value) ||
        (expectedId !== undefined && file.file_id !== expectedId) ||
        !["pending", "ready"].includes(String(file.status))
      )
        throw new Error(
          "AgentMail Drive file identity or ZIP metadata mismatch. No email was sent.",
        );
      futureTime(file.expires_at);
      return requiredString(file.file_id, "file_id");
    };
    let file: Record<string, unknown>;
    try {
      try {
        file = await this.request(
          this.filesPath(),
          JSON.stringify({
            ...metadata,
            expires_at: new Date(Date.now() + DRIVE_TTL_MS).toISOString(),
          }),
        );
      } catch (error) {
        if (!(error instanceof AgentMailHttpError) || error.status !== 409)
          throw error;
        // expires_at participates in create equality. Recover its original server-rounded
        // value after a restart instead of changing it or allocating another quota entry.
        const query = new URLSearchParams({
          path_prefix: metadata.path,
          limit: "1",
          ascending: "true",
        });
        const page = await this.request(`${this.filesPath()}?${query}`);
        if (!Array.isArray(page.files) || page.files.length !== 1)
          throw new Error(
            "Cannot recover existing AgentMail Drive file. No email was sent.",
          );
        const existing = object(page.files[0]);
        if (existing.path !== metadata.path)
          throw new Error("AgentMail Drive path conflict. No email was sent.");
        const id = requiredString(existing.file_id, "file_id");
        file = await this.request(this.filesPath(id));
        validate(file, id);
        if (file.status === "pending") {
          file = await this.request(
            this.filesPath(),
            JSON.stringify({ ...metadata, expires_at: file.expires_at }),
          );
          validate(file, id);
        }
      }
      const id = validate(file);
      if (file.status === "pending") {
        const upload = object(file.upload);
        if (upload.method !== "PUT")
          throw new Error(
            "Invalid AgentMail Drive upload method. No email was sent.",
          );
        const url = signedUrl(upload.url);
        futureTime(upload.expires_at, URL_MARGIN_MS);
        const values = object(upload.headers);
        if (Object.values(values).some((value) => typeof value !== "string"))
          throw new Error(
            "Invalid AgentMail Drive upload headers. No email was sent.",
          );
        const headers = values as Record<string, string>;
        let signed: Headers;
        try {
          signed = new Headers(headers);
        } catch {
          throw new Error(
            "Invalid AgentMail Drive signed upload headers. No email was sent.",
          );
        }
        if (
          signed.has("authorization") ||
          signed.has("proxy-authorization") ||
          signed.has("cookie") ||
          signed.get("content-length") !== String(bytes.length) ||
          signed.get("content-type") !== metadata.content_type ||
          signed.get("x-amz-checksum-sha256") !== metadata.sha256 ||
          signed.get("if-none-match") !== "*"
        ) {
          throw new Error(
            "Invalid AgentMail Drive signed upload headers. No email was sent.",
          );
        }
        let response: Response;
        try {
          response = await fetch(url, {
            method: "PUT",
            headers,
            body: new Uint8Array(bytes),
            credentials: "omit",
            redirect: "error",
            signal: AbortSignal.timeout(TIMEOUT_MS),
          });
        } catch {
          throw new Error(
            "AgentMail Drive upload failed or timed out. No email was sent.",
          );
        }
        // If-None-Match can report bytes already uploaded on a retry. Complete still
        // verifies their size and checksum before we accept the ready file.
        if (!response.ok && response.status !== 412)
          throw new Error(
            `AgentMail Drive upload failed with HTTP ${response.status}. No email was sent.`,
          );
        file = await this.request(`${this.filesPath(id)}/complete`, "{}");
        validate(file, id);
      }
      if (file.status !== "ready")
        throw new Error("AgentMail Drive ZIP is not ready. No email was sent.");
      if (
        typeof file.download_url !== "string" ||
        typeof file.download_expires_at !== "string" ||
        Date.parse(file.download_expires_at) <= Date.now() + URL_MARGIN_MS
      ) {
        file = await this.request(this.filesPath(id));
        validate(file, id);
      }
      if (file.status !== "ready")
        throw new Error("AgentMail Drive ZIP is not ready. No email was sent.");
      return {
        url: signedUrl(file.download_url),
        expires: Math.min(
          futureTime(file.download_expires_at, URL_MARGIN_MS),
          futureTime(file.expires_at, URL_MARGIN_MS),
        ),
      };
    } catch (error) {
      if (error instanceof AgentMailHttpError && error.status === 403) {
        throw new AgentMailHttpError(
          403,
          error.method,
          `Agent Drive attachment preparation unavailable (Labs, file permissions or quota); ZIP must fit the ${MAX_SEND_BYTES}-byte inline request limit without Drive. No email was sent. AgentMail`,
        );
      }
      throw error;
    }
  }

  /** Stage and validate before the durable worker marks sending; this never sends mail. */
  async prepareReply(
    message: IncomingMessage,
    text: string,
    zipPath?: string,
  ): Promise<PreparedReply> {
    if (message.inboxId !== this.inboxId)
      throw new Error("Cannot reply from a different inbox.");
    requiredString(message.messageId, "message_id");
    const to = senderAddress(message.from);
    if (to.toLowerCase() === this.inboxId.toLowerCase())
      throw new Error("Refusing to reply to the agent inbox itself.");
    const messageId = message.messageId;
    const threadId = message.threadId;
    const payload: Record<string, unknown> = {
      to: [to],
      reply_all: false,
      text,
    };
    const checkSize = (body: string): void => {
      const bytes = Buffer.byteLength(body, "utf8");
      if (bytes > MAX_SEND_BYTES)
        throw new Error(
          `Reply request is ${bytes} bytes; maximum is ${MAX_SEND_BYTES} bytes including attachment and body. No email was sent.`,
        );
    };
    checkSize(JSON.stringify(payload));
    let expires: number | undefined;
    if (zipPath) {
      const filename = basename(zipPath);
      if (!filename.toLowerCase().endsWith(".zip"))
        throw new Error("Reply attachment must be a ZIP file.");
      const info = await stat(zipPath);
      if (!info.isFile())
        throw new Error("Reply attachment must be a ZIP file.");
      const checkRawSize = (size: number): void => {
        if (size > MAX_REMOTE_ATTACHMENT_BYTES)
          throw new Error(
            `ZIP exceeds the ${MAX_REMOTE_ATTACHMENT_BYTES}-byte remote attachment limit. No email was sent.`,
          );
      };
      checkRawSize(info.size);
      const bytes = await readFile(zipPath);
      checkRawSize(bytes.length);
      const attachment = { filename, content_type: "application/zip" };
      payload.attachments = [
        { ...attachment, content: bytes.toString("base64") },
      ];
      if (Buffer.byteLength(JSON.stringify(payload), "utf8") > MAX_SEND_BYTES) {
        const staged = await this.stageZip(messageId, bytes);
        payload.attachments = [{ ...attachment, url: staged.url }];
        expires = staged.expires;
      }
    }
    const body = JSON.stringify(payload);
    checkSize(body);
    // Stable per inbound message. Keys expire after 24h; durable sending/uncertain states still gate retries.
    const key = createHash("sha256")
      .update(JSON.stringify([this.inboxId, messageId]))
      .digest("hex");
    return Object.freeze({
      send: async () => {
        if (expires !== undefined && expires <= Date.now() + URL_MARGIN_MS)
          throw new Error(
            "Prepared attachment URL expired. Prepare the reply again. No email was sent.",
          );
        return this.sendReply(messageId, threadId, body, key);
      },
    });
  }

  async reply(
    message: IncomingMessage,
    text: string,
    zipPath?: string,
  ): Promise<SendReceipt> {
    return (await this.prepareReply(message, text, zipPath)).send();
  }

  private async sendReply(
    messageId: string,
    threadId: string | undefined,
    body: string,
    key: string,
  ): Promise<SendReceipt> {
    const response = await this.request(
      `${this.path(messageId)}/reply`,
      body,
      key,
      true,
    );
    try {
      const receipt = {
        messageId: requiredString(
          response.message_id,
          "send receipt message_id",
        ),
        threadId: requiredString(response.thread_id, "send receipt thread_id"),
      };
      if (
        receipt.messageId === messageId ||
        (threadId && receipt.threadId !== threadId)
      )
        throw new Error("Receipt identity mismatch.");
      return receipt;
    } catch {
      throw new SendUncertainError(
        "AgentMail returned an invalid send receipt; reconcile sent messages before retrying.",
      );
    }
  }
}
