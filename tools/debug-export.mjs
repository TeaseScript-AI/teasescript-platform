// Reads a Player debug export (`.teasedebug.json.gz` or `.teasedebug.json`) as untrusted data, after
// `npm run build:typescript`:
//   node tools/debug-export.mjs inspect <file> [--values] [--max-mib <n>]
//   node tools/debug-export.mjs replay <file> [--timeout <seconds>] [--max-mib <n>]
// `inspect` summarizes the export without runtime values unless `--values` is given. `replay` runs the recorded engine
// calls again in a worker and reports whether they reproduce the recording. Exit codes: 0 reproduced (or inspected),
// 1 diverged, 2 incomplete, 3 unsupported version, 4 invalid export, 5 replay timed out, 64 usage.
import { readFile } from "node:fs/promises";
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";
import { gunzipSync } from "node:zlib";

const exports = await import(new URL("../dist/player/debug-export.js", import.meta.url).href);
const { DEBUG_EXPORT_MAX_JSON_BYTES, DebugExportError, parseDebugExport, replayDebugExport } =
  exports;

const EXIT = {
  reproduced: 0,
  diverged: 1,
  incomplete: 2,
  unsupported: 3,
  invalid: 4,
  timeout: 5,
  usage: 64,
};

if (!isMainThread) {
  // The worker replays the JSON it is given; the main thread enforces the time limit.
  try {
    parentPort.postMessage({ result: replayDebugExport(parseDebugExport(workerData.json)) });
  } catch (error) {
    parentPort.postMessage({ error: errorReport(error) });
  }
} else {
  process.exitCode = await main(process.argv.slice(2));
}

async function main(args) {
  const [command, file, ...rest] = args;
  const options = parseOptions(rest);
  if ((command !== "inspect" && command !== "replay") || file === undefined || options === null) {
    console.error(
      "Usage: node tools/debug-export.mjs inspect <file> [--values] [--max-mib <n>]\n" +
        "       node tools/debug-export.mjs replay <file> [--timeout <seconds>] [--max-mib <n>]",
    );
    return EXIT.usage;
  }
  let json;
  try {
    json = decode(await readFile(file), options.maxBytes);
  } catch (error) {
    console.log(`invalid export: ${error.message}`);
    return EXIT.invalid;
  }
  if (command === "inspect") {
    try {
      console.log(describe(parseDebugExport(json), options.values));
      return EXIT.reproduced;
    } catch (error) {
      return reportError(errorReport(error));
    }
  }
  const outcome = await replayInWorker(json, options.timeoutMs);
  if (outcome.timeout) {
    console.log(`replay timed out after ${options.timeoutMs / 1000} s`);
    return EXIT.timeout;
  }
  if (outcome.error) return reportError(outcome.error);
  return reportReplay(outcome.result);
}

function parseOptions(args) {
  const options = { values: false, timeoutMs: 60_000, maxBytes: DEBUG_EXPORT_MAX_JSON_BYTES };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--values") options.values = true;
    else if (arg === "--timeout" || arg === "--max-mib") {
      const number = Number(args[++index]);
      if (!Number.isFinite(number) || number <= 0) return null;
      if (arg === "--timeout") options.timeoutMs = number * 1000;
      else options.maxBytes = Math.floor(number * 1024 * 1024);
    } else return null;
  }
  return options;
}

/** The export's JSON text: gzip is recognized by its first bytes, and neither form may exceed `maxBytes`. */
function decode(bytes, maxBytes) {
  let text = bytes;
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
    try {
      text = gunzipSync(bytes, { maxOutputLength: maxBytes });
    } catch (error) {
      if (error.code === "ERR_BUFFER_TOO_LARGE")
        throw new Error(`it expands beyond ${maxBytes} bytes`, { cause: error });
      throw new Error("the gzip data is damaged or incomplete", { cause: error });
    }
  } else if (bytes.length > maxBytes) throw new Error(`it is larger than ${maxBytes} bytes`);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(text);
  } catch {
    throw new Error("it is not UTF-8 text");
  }
}

function replayInWorker(json, timeoutMs) {
  return new Promise((resolve) => {
    const worker = new Worker(new URL(import.meta.url), { workerData: { json } });
    const timer = setTimeout(() => {
      void worker.terminate();
      resolve({ timeout: true });
    }, timeoutMs);
    worker.once("message", (message) => {
      clearTimeout(timer);
      void worker.terminate();
      resolve(message);
    });
    worker.once("error", (error) => {
      clearTimeout(timer);
      resolve({ error: errorReport(error) });
    });
  });
}

function errorReport(error) {
  if (error instanceof DebugExportError) return { kind: error.kind, message: error.message };
  return {
    kind: "crash",
    message: error instanceof Error ? (error.stack ?? error.message) : String(error),
  };
}

function reportError(error) {
  if (error.kind === "unsupported") {
    console.log(`unsupported version: ${error.message}`);
    return EXIT.unsupported;
  }
  if (error.kind === "invalid") {
    console.log(`invalid export: ${error.message}`);
    return EXIT.invalid;
  }
  throw new Error(error.message);
}

function reportReplay(result) {
  if (result.kind === "incomplete") {
    console.log(`incomplete, not replayable: ${result.reason}`);
    return EXIT.incomplete;
  }
  if (result.kind === "diverged") {
    console.log(`diverged: ${result.reason}`);
    if (result.location) console.log(`  at ${place(result.location)}`);
    return EXIT.diverged;
  }
  if (result.failure === null)
    console.log(`reproduced: ${result.operations} recorded call(s) reach the exported state`);
  else console.log(`reproduced engine failure ${result.failure.code} at ${place(result.failure)}`);
  return EXIT.reproduced;
}

function place(location) {
  const calls = location.calls.length > 0 ? ` (in ${location.calls.join(" > ")})` : "";
  return `${location.path}:${location.line}:${location.column}${calls}`;
}

/** A summary of the export; runtime values, recorded arguments, and readable sections only with `values`. */
function describe(exported, values) {
  const { build, incident, selection, checkpoint, replay, photos, sections } = exported;
  const lines = [`TeaseScript debug export, version ${exported.version}`];
  const dirty =
    build.dirty === null ? "unknown changes" : build.dirty ? "uncommitted changes" : "clean";
  lines.push(
    `build: ${build.commit ?? "unknown commit"} (${dirty}), mode ${build.mode ?? "unknown"}, app ${build.appVersion ?? "unknown"}; checkpoint ${build.checkpointVersion}, plan ${build.planVersion}, snapshot ${build.snapshotVersion}`,
  );
  lines.push(
    `package: ${exported.package.id ?? "unknown"}, version ${exported.package.version ?? "unknown"}, content ${exported.package.contentHash ?? "unknown"}`,
  );
  const at =
    incident.path === null
      ? ""
      : ` at ${incident.path}:${incident.line ?? "?"}:${incident.column ?? "?"}`;
  lines.push(
    `incident: ${incident.kind}${incident.code ? ` ${incident.code}` : ""}${incident.hostError ? ` ${incident.hostError}` : ""}${at}`,
  );
  lines.push(
    `selected: ${Object.entries(selection)
      .map(([name, on]) => `${name} ${on ? "on" : "off"}`)
      .join(", ")}`,
  );
  lines.push(
    checkpoint === null
      ? "checkpoint: none"
      : `checkpoint: ${exported.checkpointRole}, status ${checkpoint.snapshot.status}, ${checkpoint.plan.files.length} file(s)`,
  );
  if (replay === null) lines.push("replay: none");
  else {
    const kinds = new Map();
    for (const operation of replay.operations)
      kinds.set(operation.kind, (kinds.get(operation.kind) ?? 0) + 1);
    lines.push(
      `replay: ${replay.operations.length} call(s) [${[...kinds].map(([kind, n]) => `${kind} ${n}`).join(", ")}], ${replay.complete ? "complete" : `incomplete: ${replay.reason ?? "no reason given"}`}`,
    );
  }
  lines.push(
    `photos: ${photos.length}, ${photos.filter((photo) => photo.data !== null).length} with their bytes`,
  );
  for (const photo of photos)
    lines.push(
      `  ${photo.reference} ${photo.mimeType} ${photo.byteLength} bytes, used by ${photo.usedBy.map((use) => `${use.relation}${use.operation === null ? "" : ` call ${use.operation}`}${use.actionId === null ? "" : ` action ${use.actionId}`}`).join("; ") || "nothing recorded"}`,
    );
  lines.push(`sections: ${Object.keys(sections).join(", ") || "none"}`);
  for (const omission of exported.omissions) lines.push(`omitted: ${omission}`);
  if (values) {
    if (replay !== null)
      for (const operation of replay.operations)
        lines.push(
          `call ${operation.seq} ${operation.kind} ${JSON.stringify(operation.args)} -> ${operation.outcome ?? `threw ${operation.thrown}`}`,
        );
    for (const [name, section] of Object.entries(sections))
      lines.push(`${name}: ${JSON.stringify(section, null, 2)}`);
  }
  return lines.join("\n");
}
