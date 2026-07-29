import { relative } from "node:path";
import { inspect } from "node:util";

function formatLocation(data) {
  if (typeof data.file !== "string" || data.file.length === 0) {
    return "";
  }

  const relativeFile = relative(process.cwd(), data.file);
  const file = relativeFile && !relativeFile.startsWith("..")
    ? relativeFile
    : data.file;
  const line = Number.isInteger(data.line) ? `:${data.line}` : "";
  const column = Number.isInteger(data.column) ? `:${data.column}` : "";
  return ` (${file}${line}${column})`;
}

function formatError(error) {
  const displayed = error?.cause instanceof Error ? error.cause : error;

  if (displayed instanceof Error) {
    return displayed.stack ?? `${displayed.name}: ${displayed.message}`;
  }

  return inspect(displayed, {
    colors: false,
    depth: 8,
    breakLength: 120,
  });
}

function formatFailure(data) {
  return [
    `FAIL ${data.name}${formatLocation(data)}`,
    formatError(data.details?.error),
    "",
  ].join("\n");
}

function isExpectedFailure(data) {
  return data.todo !== undefined || data.skip !== undefined;
}

function formatSummary(data) {
  const counts = data.counts;
  const optionalCounts = [];

  if (counts.cancelled > 0) optionalCounts.push(`cancelled ${counts.cancelled}`);
  if (counts.skipped > 0) optionalCounts.push(`skipped ${counts.skipped}`);
  if (counts.todo > 0) optionalCounts.push(`todo ${counts.todo}`);

  return [
    `tests ${counts.tests}`,
    `pass ${counts.passed}`,
    `fail ${counts.failed}`,
    ...optionalCounts,
    `duration ${Math.round(data.duration_ms)} ms`,
  ].join(" | ");
}

export default async function* summaryReporter(source) {
  let lastSummary;
  let cumulativeSummary;

  for await (const event of source) {
    if (
      event.type === "test:fail"
      && !isExpectedFailure(event.data)
    ) {
      yield `${formatFailure(event.data)}\n`;
    } else if (event.type === "test:summary") {
      lastSummary = event.data;
      if (event.data.file === undefined) {
        cumulativeSummary = event.data;
      }
    }
  }

  const summary = cumulativeSummary ?? lastSummary;
  if (summary !== undefined) {
    yield `${formatSummary(summary)}\n`;
  }
}
