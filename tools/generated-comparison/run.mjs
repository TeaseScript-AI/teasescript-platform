// Compares generated code with today's engine for each program given (README.md). Runs from a built checkout.
// node tools/generated-comparison/run.mjs [--play first|last|seed:N] [--timeout-ms N] PATH...
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

if (isMainThread) await main();
else parentPort.postMessage(await compareOne(workerData.program, workerData.play));

async function main() {
  const args = process.argv.slice(2);
  let play = "first";
  let timeoutMs = 600_000;
  const programs = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--play") play = parsePlay(args[++index]);
    else if (args[index] === "--timeout-ms") timeoutMs = Number(args[++index]);
    else programs.push(args[index]);
  }
  // `setTimeout` takes at most this delay; a longer one fires at once.
  if (
    programs.length === 0 ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 2_147_483_647
  ) {
    console.error(
      "usage: node tools/generated-comparison/run.mjs [--play first|last|seed:N] [--timeout-ms N] PATH...\n" +
        "--timeout-ms takes an integer from 1 to 2147483647.",
    );
    process.exit(2);
  }
  const counts = {};
  for (const program of programs) {
    // One worker per program, so its module cache is freed when it exits and memory is bounded by the largest program.
    const verdict = await inWorker(program, play, timeoutMs);
    counts[verdict.kind] = (counts[verdict.kind] ?? 0) + 1;
    console.log(JSON.stringify({ program, play, verdict }));
  }
  console.log(JSON.stringify({ counts }));
}

function parsePlay(text) {
  if (text === "first" || text === "last") return text;
  const seed = /^seed:(\d+)$/u.exec(text ?? "");
  if (seed === null) throw new Error(`--play takes first, last or seed:N, not ${text}`);
  return { seed: Number(seed[1]) };
}

function inWorker(program, play, timeoutMs) {
  return new Promise((resolve) => {
    const worker = new Worker(fileURLToPath(import.meta.url), { workerData: { program, play } });
    const timer = setTimeout(() => {
      void worker.terminate();
      resolve({ kind: "timeout", ms: timeoutMs });
    }, timeoutMs);
    const settle = (verdict) => {
      clearTimeout(timer);
      resolve(verdict);
    };
    worker.once("message", settle);
    worker.once("error", (error) =>
      settle({ kind: "error", message: String(error?.stack ?? error) }),
    );
    worker.once("exit", (code) => settle({ kind: "error", message: `worker exited with ${code}` }));
  });
}

async function compareOne(program, play) {
  const { compileProject, compileSource } = await import(
    pathToFileURL(path.join(root, "dist/src/index.js")).href
  );
  const { compareGenerated } = await import(
    pathToFileURL(path.join(root, "dist/tests/helpers/generated-comparison/compare.js")).href
  );
  const result = fs.statSync(program).isDirectory()
    ? compileProject(packageFiles(program))
    : compileSource(fs.readFileSync(program, "utf8"));
  if (!result.plan)
    return { kind: "notCompiled", codes: result.diagnostics.map((item) => item.code) };
  return compareGenerated({ plan: result.plan, play });
}

/** A package directory's `.tease` files, `main.tease` first, by their paths within it. */
function packageFiles(directory) {
  const paths = [];
  const walk = (folder) => {
    for (const entry of fs
      .readdirSync(folder, { withFileTypes: true })
      .sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const full = path.join(folder, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".tease"))
        paths.push(path.relative(directory, full).split(path.sep).join("/"));
    }
  };
  walk(directory);
  const ordered = [
    ...paths.filter((name) => name === "main.tease"),
    ...paths.filter((name) => name !== "main.tease"),
  ];
  return ordered.map((name) => ({
    path: name,
    source: fs.readFileSync(path.join(directory, name), "utf8"),
  }));
}
