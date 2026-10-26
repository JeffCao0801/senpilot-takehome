import { CATEGORIES, type CollectionResult } from "./types.js";

function publicFailure(reason: string): string {
  if (/byte budget|size limit/i.test(reason))
    return "The file exceeded the configured download size limit.";
  if (/security is (Confidential|Restricted|Private|Sealed)/i.test(reason))
    return "The source marks this document as non-public; it was skipped.";
  if (
    /format|signature|HTML page|empty|verification|changed after verification/i.test(
      reason,
    )
  )
    return "The downloaded file could not be verified as a supported document.";
  if (/enumerate|scrolling list/i.test(reason))
    return "The source list did not finish loading all selected entries.";
  if (/matter number does not match|row changed|identity/i.test(reason))
    return "The source page changed, so its identity could not be verified.";
  return "The source website did not complete this download. Please try again later.";
}

export function renderReply(
  result: CollectionResult,
  options: { attachment?: boolean; deliveryIssue?: string } = {},
): string {
  const number = result.request.matterNumber;
  const lines: string[] = [];
  if (result.status === "not_found")
    return `I could not find matter ${number} in the Nova Scotia public documents database. Please check the matter number and try again.\n\nSource: https://uarb.novascotia.ca/fmi/webd/UARB15`;
  const attached = Boolean(
    result.zipPath &&
    result.documents.length &&
    options.attachment !== false &&
    !options.deliveryIssue,
  );
  if (attached)
    lines.push(
      `${result.status === "partial" ? "Partial result: attached" : "Attached"} ${result.documents.length} verified files for ${number} — ${result.request.category}.`,
    );
  else if (result.status === "empty")
    lines.push(
      `No ${result.request.category} are listed for ${number}. No ZIP is attached.`,
    );
  else if (result.documents.length)
    lines.push(
      `Downloaded ${result.documents.length} verified files for ${number}, but no ZIP is attached to this reply.`,
    );
  else
    lines.push(
      `I could not download verified ${result.request.category} for ${number}. No ZIP is attached.`,
    );
  lines.push("");
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
    if (m.dateReceived || m.dateFinal)
      lines.push(
        "Dates are shown as MM/DD/YYYY, as displayed by the database.",
      );
    lines.push("");
  } else lines.push(`Request: ${number}, ${result.request.category}`, "");
  if (result.counts) {
    lines.push("Document counts (source entries):");
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
  if (result.selectedDocumentIds.length)
    lines.push(
      `Selected ${result.selectedDocumentIds.length}${available === undefined ? "" : ` of ${available}`} source entries in ${result.request.category}; downloaded ${result.documents.length} verified files.`,
      `Selection: ${result.selectionOrder}.`,
    );
  if (result.documents.length) {
    lines.push(
      "",
      attached
        ? "Files in the attached ZIP:"
        : "Files downloaded locally (not attached):",
    );
    for (const d of result.documents)
      lines.push(
        `- ${d.filename}\n  ${d.documentId}: ${d.title}${d.date && d.date !== d.documentId ? ` (${d.date})` : ""}`,
      );
  }
  if (result.failures.length) {
    lines.push("", "Problems encountered:");
    for (const f of result.failures)
      lines.push(
        `${f.documentId ? `${f.documentId}: ` : ""}${publicFailure(f.reason)}`,
      );
  }
  if (options.deliveryIssue)
    lines.push(
      "",
      `Attachment delivery issue: ${options.deliveryIssue}`,
      "The ZIP was not attached to this reply.",
    );
  for (const warning of [...new Set(result.warnings)])
    if (warning !== options.deliveryIssue) lines.push("", warning);
  lines.push(
    "",
    `Data checked: ${result.observedAt}`,
    "Source: https://uarb.novascotia.ca/fmi/webd/UARB15",
  );
  return lines.join("\n");
}
