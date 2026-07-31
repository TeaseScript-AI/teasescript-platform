import { relative, resolve } from "node:path";
import { inspect } from "node:util";

const MAX_STDERR_BYTES = 16 * 1024;
const STDERR_HEAD_BYTES = MAX_STDERR_BYTES / 2;
const STDERR_TAIL_BYTES = MAX_STDERR_BYTES - STDERR_HEAD_BYTES;
const MAX_RETAINED_CONTEXT_BYTES = 16 * 1024;

const IGNORED_SUCCESS_EVENT_TYPES = new Set([
  "test:complete",
  "test:coverage",
  "test:dequeue",
  "test:enqueue",
  "test:pass",
  "test:plan",
  "test:start",
  "test:watch:drained",
]);

const SUMMARY_DIAGNOSTIC_PATTERN = /^(?:tests|suites|pass|fail|cancelled|skipped|todo|duration_ms)\s/;

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

function formatChildTermination(error) {
  const details = [];

  if (Number.isInteger(error?.exitCode)) {
    details.push(`child process exited with code ${error.exitCode}`);
  }
  if (typeof error?.signal === "string" && error.signal.length > 0) {
    details.push(`child process terminated by signal ${error.signal}`);
  }

  return details.join("\n");
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
    && typeof data.name === "string"
    && resolve(data.name) === resolve(data.file)
    && error?.failureType === "testCodeFailure"
    && error?.message === "test failed"
    && "exitCode" in error
    && "signal" in error
  );
}

function fileKey(file) {
  return typeof file === "string" ? resolve(file) : undefined;
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
  const key = fileKey(file);
  if (key === undefined || typeof message !== "string") return;

  const bytes = Buffer.from(message, "utf8");
  const previous = captures.get(key) ?? {
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

  captures.set(key, previous);
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

function truncateRetainedContext(text, maximumBytes) {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= maximumBytes) return text;

  const marker = Buffer.from(
    `\n... retained context truncated: retained ${maximumBytes} of ${bytes.length} bytes ...\n`,
    "utf8",
  );
  if (marker.length >= maximumBytes) {
    return truncateBufferStart(marker, maximumBytes).toString("utf8");
  }

  const retainedPayloadBytes = maximumBytes - marker.length;
  const headBytes = Math.floor(retainedPayloadBytes / 2);
  const tailBytes = retainedPayloadBytes - headBytes;
  return Buffer.concat([
    truncateBufferStart(bytes, headBytes),
    marker,
    truncateBufferEnd(bytes, tailBytes),
  ]).toString("utf8");
}

function isSummaryDiagnostic(data) {
  return (
    data.file === undefined
    && typeof data.message === "string"
    && SUMMARY_DIAGNOSTIC_PATTERN.test(data.message)
  );
}

function formatRetainedEvent(event) {
  if (event.type === "test:diagnostic") {
    return [
      `DIAGNOSTIC${formatLocation(event.data)}`,
      String(event.data.message),
      "",
    ].join("\n");
  }

  if (event.type === "test:stdout" || event.type === "test:stderr") {
    return [
      `${event.type === "test:stdout" ? "STDOUT" : "STDERR"}${formatLocation(event.data)}`,
      String(event.data.message).trimEnd(),
      "",
    ].join("\n");
  }

  return [
    `EVENT ${event.type}${formatLocation(event.data)}`,
    inspect(event.data, {
      colors: false,
      depth: 8,
      breakLength: 120,
      maxArrayLength: 100,
      maxStringLength: 8 * 1024,
    }),
    "",
  ].join("\n");
}

function formatFailure(data, stderrCapture) {
  const error = data.details?.error;
  const diagnostic = isGenericFileFailure(data)
    ? formatCapturedStderr(stderrCapture) || formatChildTermination(error)
    : "";
  return [
    `FAIL ${data.name}${formatLocation(data)}`,
    diagnostic || formatError(error),
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
  const retainedEvents = [];

  for await (const event of source) {
    if (event.type === "test:stderr") {
      appendStderr(stderrCaptures, event.data.file, event.data.message);
      retainedEvents.push(event);
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
    } else if (
      event.type === "test:diagnostic"
      && isSummaryDiagnostic(event.data)
    ) {
      // Node repeats the final totals as diagnostics. The compact summary below
      // is the one intentional success-output path.
    } else if (!IGNORED_SUCCESS_EVENT_TYPES.has(event.type)) {
      // Default to retaining unfamiliar events. They are emitted only when the
      // run fails, so new error-bearing event types are not silently discarded.
      retainedEvents.push(event);
    }
  }

  for (const failure of failures) {
    yield `${formatFailure(failure, stderrCaptures.get(fileKey(failure.file)))}\n`;
  }

  const summary = cumulativeSummary ?? lastSummary;
  const failed = failures.length > 0 || summary?.success === false;
  if (failed) {
    const failedFiles = new Set(
      failures.map((failure) => fileKey(failure.file)).filter(Boolean),
    );
    const consumedStderrFiles = new Set(
      failures
        .filter((failure) => (
          isGenericFileFailure(failure)
          && stderrCaptures.has(fileKey(failure.file))
        ))
        .map((failure) => fileKey(failure.file)),
    );
    let retainedBytes = 0;

    for (const event of retainedEvents) {
      const eventFile = fileKey(event.data.file);
      if (failedFiles.size > 0 && eventFile !== undefined && !failedFiles.has(eventFile)) {
        continue;
      }
      if (event.type === "test:stderr" && consumedStderrFiles.has(eventFile)) {
        continue;
      }

      const formatted = `${formatRetainedEvent(event)}\n`;
      const remainingBytes = MAX_RETAINED_CONTEXT_BYTES - retainedBytes;
      if (remainingBytes <= 0) break;

      const retained = truncateRetainedContext(formatted, remainingBytes);
      yield retained;
      retainedBytes += Buffer.byteLength(retained, "utf8");
      if (retained !== formatted) break;
    }
  }

  if (summary !== undefined) {
    yield `${formatSummary(summary)}\n`;
  }
}
