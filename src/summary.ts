import { CATEGORIES, type CollectionResult } from "./types.js";

export function renderReply(
  result: CollectionResult,
  options: { attachment?: boolean; deliveryIssue?: string } = {},
): string {
  const number = result.request.matterNumber;
  const lines: string[] = [];
  if (result.status === "not_found")
    return `I could not find matter ${number} in the Nova Scotia public documents database. Please check the matter number and try again.\n\nSource: https://uarb.novascotia.ca/fmi/webd/UARB15`;
  if (result.metadata) {
    const m = result.metadata;
    lines.push(`Matter ${number}: ${m.title}`, "");
    for (const [label, value] of [
      ["Status", m.status],
      ["Type", m.type],
      ["Category", m.category],
      ["Date received", m.dateReceived],
      ["Date final / decision date", m.dateFinal],
      ["Outcome", m.outcome],
    ]) {
      if (value) lines.push(`${label}: ${value}`);
    }
    lines.push(
      "Dates are shown as MM/DD/YYYY, as displayed by the database.",
      "",
    );
  } else lines.push(`Request: ${number}, ${result.request.category}`, "");
  if (result.counts) {
    lines.push("Document counts:");
    for (const category of CATEGORIES)
      lines.push(`${category}: ${result.counts[category]}`);
    lines.push(
      `Total listed entries across the five categories: ${CATEGORIES.reduce((sum, c) => sum + result.counts![c], 0)}.`,
    );
    lines.push(
      "This is the sum of the category counts, not a verified count of unique files across overlapping categories.",
      "",
    );
  }
  const available = result.counts?.[result.request.category];
  lines.push(
    `Downloaded ${result.documents.length}${available === undefined ? "" : ` of ${available}`} ${result.request.category} files.`,
  );
  if (options.attachment ?? Boolean(result.zipPath))
    lines.push(
      `The ZIP attached to this reply contains ${result.documents.length} verified document files.`,
    );
  else if (result.status === "empty")
    lines.push(
      "The requested category has no documents, so no ZIP is attached.",
    );
  else if (!result.documents.length)
    lines.push("No document files could be downloaded. No ZIP is attached.");
  if (result.documents.length) {
    lines.push(
      `Selection: ${result.selectionOrder}.`,
      "",
      "Included documents:",
    );
    for (const d of result.documents)
      lines.push(`${d.documentId}: ${d.title}${d.date ? ` (${d.date})` : ""}`);
  }
  if (result.failures.length) {
    lines.push("", "Problems encountered:");
    for (const f of result.failures)
      lines.push(`${f.documentId ? `${f.documentId}: ` : ""}${f.reason}`);
  }
  if (options.deliveryIssue)
    lines.push(
      "",
      `Attachment delivery issue: ${options.deliveryIssue}`,
      "The ZIP was not attached to this reply.",
    );
  for (const warning of [...new Set(result.warnings)]) lines.push("", warning);
  lines.push(
    "",
    `Data checked: ${result.observedAt}`,
    "Source: https://uarb.novascotia.ca/fmi/webd/UARB15",
  );
  return lines.join("\n");
}
