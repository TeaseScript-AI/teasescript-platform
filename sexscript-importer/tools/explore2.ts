/**
 * Explorer V2 (concolic playtester) on unit folders: writes `<out>/<unit>.json` with the same coverage and crash fields as
 * V1 (`tools/explore.ts`) and V2's own search figures. V1 stays the default explorer; see `src/explorer2/`.
 *
 * Usage: node tools/explore2.ts [--seed N] [--budget-seconds N] [--max-steps N] [--max-heap-mb N] <unit-dir>... --out <dir>
 * (`--max-heap-mb`: the heap in use at which the search stops, by default 60% of the heap limit, as for V1).
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { execFileSync } from "node:child_process";
import { getHeapStatistics, setFlagsFromString } from "node:v8";
import { isRecord } from "../src/ast.ts";
import { loadRepositoryPackageScanner } from "../src/compile-check.ts";
import { loadEngine } from "../src/explorer.ts";
import { DEFAULT_OPTIONS, explore2 } from "../src/explorer2/search.ts";
import { loadRuntime2 } from "../src/explorer2/runner.ts";

/** The V8 flag that sets how much the heap grows after a collection. */
const HEAP_GROWING = "--heap-growing-percent";
// As V1 does: V8 lets its heap grow to up to four times what a collection keeps, so that the heap in use (which the heap
// cap reads) is mostly garbage; growing it by a fifth at a time keeps it close to what the run holds.
if (execFileSync(process.execPath, ["--v8-options"], { encoding: "utf8" }).includes(HEAP_GROWING))
  setFlagsFromString(`${HEAP_GROWING}=20`);
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    seed: { type: "string", default: "1" },
    "budget-seconds": { type: "string", default: "60" },
    "max-steps": { type: "string" },
    "max-heap-mb": { type: "string" },
    out: { type: "string" },
  },
});
const maxHeapMb =
  values["max-heap-mb"] === undefined
    ? Math.floor((getHeapStatistics().heap_size_limit * 0.6) / 1024 ** 2)
    : Number(values["max-heap-mb"]);
if (
  values.out === undefined ||
  positionals.length === 0 ||
  !(Number.isSafeInteger(maxHeapMb) && maxHeapMb >= 1)
) {
  process.stderr.write(
    "usage: node tools/explore2.ts [--seed N] [--budget-seconds N] [--max-steps N] [--max-heap-mb N] <unit-dir>... --out <dir>\n",
  );
  process.exit(2);
}
const engine = await loadEngine();
const runtime = await loadRuntime2();
const scan = await loadRepositoryPackageScanner();
await mkdir(values.out, { recursive: true });
for (const dir of positionals) {
  const unit = path.basename(path.resolve(dir));
  const folder = await scan(dir);
  const compiled = engine.compileProject(folder.sources, { builtins: [], images: folder.images });
  const errors = (Array.isArray(compiled.diagnostics) ? compiled.diagnostics : []).filter(
    (entry) => isRecord(entry) && entry.severity === "error",
  );
  const base = { unit, dir: path.resolve(dir), explorer: "v2", seed: Number(values.seed) };
  const plan = compiled.plan;
  if (!isRecord(plan) || errors.length > 0) {
    process.stderr.write(`${unit}: does not compile\n`);
    await writeFile(
      path.join(values.out, `${unit}.json`),
      `${JSON.stringify({ ...base, compile: { ok: false, errors: errors.map((entry) => JSON.stringify(entry)) } })}\n`,
    );
    continue;
  }
  const result = explore2(engine, runtime, plan, {
    ...DEFAULT_OPTIONS,
    seed: Number(values.seed),
    budgetMs: Number(values["budget-seconds"]) * 1000,
    maxHeapBytes: maxHeapMb * 1024 ** 2,
    ...(values["max-steps"] === undefined ? {} : { maxSteps: Number(values["max-steps"]) }),
    sources: new Map(
      folder.sources.map((source: { path: string; source: string }) => [
        source.path,
        source.source,
      ]),
    ),
  });
  const search = result.search;
  process.stderr.write(
    `${unit}: ${result.coverage.percent}% of ${result.coverage.coverableLines} lines, ${search.stoppedBy} (${search.audit.result}), ` +
      `${search.plays} plays, ${search.checks} checks, ${search.solved} solved, unsolved ${JSON.stringify(search.unsolved)}, ` +
      `${result.crashes.length} crashes, ${search.operations} instructions, ${Math.round(search.elapsedMs / 1000)} s\n`,
  );
  await writeFile(
    path.join(values.out, `${unit}.json`),
    `${JSON.stringify({ ...base, compile: { ok: true }, ...result })}\n`,
  );
}
