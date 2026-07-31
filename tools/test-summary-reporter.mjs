import { relative } from "node:path";
import { inspect } from "node:util";

const MAX_STDERR_BYTES = 16 * 1024;
const STDERR_HEAD_BYTES = MAX_STDERR_BYTES / 2;
const STDERR_TAIL_BYTES = MAX_STDERR_BYTES - STDERR_HEAD_BYTES;

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

function isExpectedFailure(data) {
  return data.todo !== undefined || data.skip !== undefined;
}

function isAggregateFailure(data) {
  return data.details?.error?.failureType === "subtestsFailed";
}

function isGenericFileFailure(data) {
  const error = data.details?.error;
  return (
    typeof data.file === "string"
    && data.name === data.file
    && error?.failureType === "testCodeFailure"
    && error?.message === "test failed"
  );
}

function truncateBufferStart(buffer, maximumBytes) {
  if (buffer.length <= maximumBytes) return buffer;
  return buffer.subarray(0, maximumBytes);
}

function truncateBufferEnd(buffer, maximumBytes) {
  if (buffer.length <= maximumBytes) return buffer;
  return buffer.subarray(buffer.length - maximumBytes);
}

function appendStderr(captures, file, message) {
  if (typeof file !== "string" || typeof message !== "string") return;

  const bytes = Buffer.from(message, "utf8");
  const previous = captures.get(file) ?? {
    totalBytes: 0,
    complete: Buffer.alloc(0),
    head: Buffer.alloc(0),
    tail: Buffer.alloc(0),
    truncated: false,
  };
  previous.totalBytes += bytes.length;

  if (!previous.truncated) {
    const combined = Buffer.concat([previous.complete, bytes]);
    if (combined.length <= MAX_STDERR_BYTES) {
      previous.complete = combined;
    } else {
      previous.truncated = true;
      previous.head = truncateBufferStart(combined, STDERR_HEAD_BYTES);
      previous.tail = truncateBufferEnd(combined, STDERR_TAIL_BYTES);
      previous.complete = Buffer.alloc(0);
    }
  } else {
    previous.tail = truncateBufferEnd(
      Buffer.concat([previous.tail, bytes]),
      STDERR_TAIL_BYTES,
    );
  }

  captures.set(file, previous);
}

function formatCapturedStderr(capture) {
  if (capture === undefined) return "";
  if (!capture.truncated) return capture.complete.toString("utf8").trimEnd();

  return [
    capture.head.toString("utf8").trimEnd(),
    `... stderr truncated: retained ${MAX_STDERR_BYTES} of ${capture.totalBytes} bytes ...`,
    capture.tail.toString("utf8").trimStart().trimEnd(),
  ].filter((part) => part.length > 0).join("\n");
}

function formatFailure(data, stderrCapture) {
  const diagnostic = isGenericFileFailure(data)
    ? formatCapturedStderr(stderrCapture)
    : "";
  return [
    `FAIL ${data.name}${formatLocation(data)}`,
    diagnostic || formatError(data.details?.error),
    "",
  ].join("\n");
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
  const failures = [];
  const stderrCaptures = new Map();

  for await (const event of source) {
    if (event.type === "test:stderr") {
      appendStderr(stderrCaptures, event.data.file, event.data.message);
    } else if (
      event.type === "test:fail"
      && !isExpectedFailure(event.data)
      && !isAggregateFailure(event.data)
    ) {
      failures.push(event.data);
    } else if (event.type === "test:summary") {
      lastSummary = event.data;
      if (event.data.file === undefined) {
        cumulativeSummary = event.data;
      }
    }
  }

  for (const failure of failures) {
    yield `${formatFailure(failure, stderrCaptures.get(failure.file))}\n`;
  }

  const summary = cumulativeSummary ?? lastSummary;
  if (summary !== undefined) {
    yield `${formatSummary(summary)}\n`;
  }
}
