export const CATEGORIES = [
  "Exhibits",
  "Key Documents",
  "Other Documents",
  "Transcripts",
  "Recordings",
] as const;
export type Category = (typeof CATEGORIES)[number];
export type Counts = Record<Category, number>;
export interface AgentRequest {
  matterNumber: string;
  category: Category;
}
export type ParseResult =
  | { kind: "request"; request: AgentRequest; source: "codex" | "rules" }
  | { kind: "clarification"; message: string };
export interface MatterMetadata {
  matterNumber: string;
  title: string;
  status?: string;
  type?: string;
  category?: string;
  dateReceived?: string;
  dateFinal?: string;
  outcome?: string;
}
export interface DocumentFile {
  documentId: string;
  title: string;
  date?: string;
  security?: string;
  filename: string;
  path: string;
  bytes: number;
  sha256: string;
}
export interface CollectionResult {
  request: AgentRequest;
  status: "complete" | "partial" | "empty" | "not_found" | "failed";
  metadata?: MatterMetadata;
  counts?: Counts;
  documents: DocumentFile[];
  failures: Array<{ documentId?: string; reason: string }>;
  selectedDocumentIds: string[];
  selectionOrder: string;
  observedAt: string;
  runDirectory: string;
  zipPath?: string;
  zipBytes?: number;
  warnings: string[];
}
export interface IncomingMessage {
  messageId: string;
  inboxId: string;
  threadId?: string;
  from: string;
  subject: string;
  text: string;
  timestamp: string;
  labels: string[];
  headers?: Record<string, string>;
  inReplyTo?: string;
}
export interface SendReceipt {
  messageId: string;
  threadId?: string;
}
