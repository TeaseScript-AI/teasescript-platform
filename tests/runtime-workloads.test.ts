// The #1797 workloads (F-work) through the differential harness (0b.1): each host tape and tail case runs on both
// sides of this build, every restore route included, and must be equivalent, and its uninterrupted run must say what
// its independent reference says. The full sizes stay with `tools/benchmark-runtime.mjs`, whose cuts restore from
// checkpoint JSON. A tape is run by the runner's own `tapeRun`, the one owner of the tape rule, so both drivers make
// the same host calls at the same points.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import type { FreshRuntimeOptions, ProjectSourceFile } from "../src/index.js";
import {
  differentialRun,
  type DifferentialInput,
  type HostCall,
  type HostDriver,
  type SideRecord,
} from "./helpers/runtime-differential.js";

// The compiled test runs from dist/tests; the benchmark lives at the checkout root.
const root = fileURLToPath(new URL("../../", import.meta.url));
const benchmark = path.join(root, "benchmarks", "runtime");
const read = (file: string): string => fs.readFileSync(path.join(benchmark, file), "utf8");

interface TapeEntry {
  readonly kind: string;
  readonly args: readonly unknown[];
  readonly admissionQueries?: readonly unknown[];
  readonly unit?: true;
}
interface TapeRun {
  next(where?: string): TapeEntry | null;
  call(entry: TapeEntry): HostCall;
  settled(entry: TapeEntry, outcome: string | undefined): void;
  end(status: string): readonly string[];
}
interface Runner {
  loadTape(text: string, label: string): readonly TapeEntry[];
  tapeRun(tape: readonly TapeEntry[], label: string): TapeRun;
  checkStated(
    statement: { readonly name: string; readonly said: readonly string[] },
    record: {
      readonly said: readonly string[];
      readonly instructions: number;
      readonly observed: { readonly failure: null; readonly tapeProblems: readonly string[] };
    },
  ): readonly string[];
}
interface References {
  helperInput(tape: readonly TapeEntry[]): readonly string[];
  formCompletion(tape: readonly TapeEntry[]): readonly string[];
  storage(tape: readonly TapeEntry[]): readonly string[];
  fileStore(tape: readonly TapeEntry[]): readonly string[];
  transferProject(lastVisit: number): readonly string[];
  textTail(chunks: number): readonly string[];
  collectionTail(size: number, targets: number): readonly string[];
}
// `tapeRun` makes its host calls with `tapeHostCall`, whose kinds and fields are 0b.1's `HostCall`.
// EVIDENCE: `tools/benchmark-runtime.mjs` exports `loadTape`, `tapeRun` and `checkStated` with these signatures.
const runner = (await import(
  pathToFileURL(path.join(root, "tools", "benchmark-runtime.mjs")).href
)) as Runner;
// EVIDENCE: `benchmarks/runtime/references.mjs` exports these functions; `tools/benchmark-runtime.test.mjs` checks them.
const references = (await import(
  pathToFileURL(path.join(benchmark, "references.mjs")).href
)) as References;

interface ManifestCase {
  readonly name: string;
  readonly file?: string;
  readonly project?: string;
  readonly files?: readonly string[];
  readonly tape?: string;
  readonly fresh?: FreshRuntimeOptions;
}
// EVIDENCE: the runner checks the manifest's shape on every run of `tests/runtime-benchmark.test.ts`.
const manifest = JSON.parse(read("manifest.json")) as {
  readonly seed: number;
  readonly wallClockMs: number;
  readonly cases: readonly ManifestCase[];
};
const entry = (name: string): ManifestCase => manifest.cases.find((item) => item.name === name)!;
const tapeOf = (name: string): readonly TapeEntry[] =>
  runner.loadTape(read(entry(name).tape!), name);

/** A case's input as the runner builds it: its source or ordered project, seed, clock, no pacing, its options. */
function input(name: string, rewrite: (source: string) => string): DifferentialInput {
  const item = entry(name);
  const sources: ProjectSourceFile[] = item.project
    ? item.files!.map((file) => ({ path: file, source: read(path.join(item.project!, file)) }))
    : [{ path: "main.tease", source: rewrite(read(item.file!)) }];
  return {
    name,
    sources,
    project: item.project !== undefined,
    fresh: {
      seed: manifest.seed,
      wallClockMs: manifest.wallClockMs,
      baseDelayMs: 0,
      delayPerWordMs: 0,
      delayPerCharacterMs: 0,
      ...item.fresh,
    },
  };
}

/** `source` with its one line `from` replaced by `to`: a reduced size. */
function resize(source: string, from: string, to: string): string {
  assert.equal(source.split(from).length, 2, `one line ${from}`);
  return source.replace(from, to);
}

/** A record's result as data: the texts its `say` events show and, for a host call, its outcome's kind. */
function resultOf(record: SideRecord): {
  readonly says: string[];
  readonly outcome: string | undefined;
} {
  const result = record.state.result;
  const says: string[] = [];
  let outcome: string | undefined;
  if (typeof result === "object" && result !== null) {
    if ("events" in result && Array.isArray(result.events))
      for (const event of result.events)
        if (typeof event === "object" && event !== null && "kind" in event && event.kind === "say")
          says.push("text" in event ? String(event.text) : "");
    if ("outcome" in result && typeof result.outcome === "object" && result.outcome !== null)
      outcome = "kind" in result.outcome ? String(result.outcome.kind) : undefined;
  }
  return { says, outcome };
}

/** A tape entry's action ID. */
function actionId(item: TapeEntry): number {
  const request = item.args[0];
  if (
    typeof request !== "object" ||
    request === null ||
    !("actionId" in request) ||
    typeof request.actionId !== "number"
  )
    throw new Error("a tape answer names its action");
  return request.actionId;
}

/** Whether a tape entry answers a number ask. */
function answersNumber(item: TapeEntry): boolean {
  const request = item.args[0];
  return (
    typeof request === "object" &&
    request !== null &&
    "interactionKind" in request &&
    request.interactionKind === "number"
  );
}

/** `item` with its request's fields changed. */
const withRequest = (item: TapeEntry, fields: Record<string, unknown>): TapeEntry => ({
  ...item,
  args: [{ ...Object(item.args[0]), ...fields }],
});

/**
 * `helper-input`'s tape for 3 rounds: its number answers up to the third accepted one, so the host's refusal stays in.
 * The asks that no longer happen took action IDs, so each later answer's ID moves down by those before it.
 */
function threeRounds(tape: readonly TapeEntry[]): readonly TapeEntry[] {
  let accepted = 0;
  const kept = tape.filter((item) => {
    if (!answersNumber(item)) return true;
    if (accepted === 3) return false;
    if (item.unit) accepted++;
    return true;
  });
  const dropped = tape.filter((item) => !kept.includes(item)).map(actionId);
  return kept.map((item) => {
    const before = dropped.filter((other) => other < actionId(item)).length;
    return before === 0 ? item : withRequest(item, { actionId: actionId(item) - before });
  });
}

/** A case of this test: its reduced source, its tape (or none) and what its uninterrupted run must say. */
interface Workload {
  readonly name: string;
  readonly rewrite: (source: string) => string;
  readonly tape: readonly TapeEntry[] | null;
  readonly said: readonly string[];
}

const same = (source: string): string => source;
const helperTape = threeRounds(tapeOf("helper-input"));
const tapeCase = (
  name: string,
  said: (tape: readonly TapeEntry[]) => readonly string[],
): Workload => ({ name, rewrite: same, tape: tapeOf(name), said: said(tapeOf(name)) });

/**
 * The tape cases, then the project and the tails at reduced sizes, each rewritten from its one size line; the runner
 * keeps the full sizes. `helper-input` runs 3 rounds instead of 6, 7 frames deep instead of 19. 101 chunks still
 * reach the text's read at 63 and its rewrite at 100. The cooperative Battleship think stays the runner's alone: one
 * placement already takes thousands of steps, and its rests are waits, which the runner restores at every cut. The
 * product budget stays the runner's too, since this harness steps one instruction at a time.
 */
const WORKLOADS: readonly Workload[] = [
  {
    name: "helper-input",
    rewrite: (source) =>
      resize(resize(source, "repeat 6 {", "repeat 3 {"), "deeper(18)", "deeper(6)"),
    tape: helperTape,
    said: references.helperInput(helperTape),
  },
  tapeCase("form-completion", references.formCompletion),
  tapeCase("storage-commit", references.storage),
  tapeCase("storage-failed", references.storage),
  tapeCase("file-store", references.fileStore),
  { name: "transfer-project", rewrite: same, tape: null, said: references.transferProject(7) },
  {
    name: "text-tail-64k",
    rewrite: (source) => resize(source, "let chunks = 1024", "let chunks = 101"),
    tape: null,
    said: references.textTail(101),
  },
  {
    name: "collection-tail-10000",
    rewrite: (source) =>
      resize(
        resize(source, "let size = 10000", "let size = 12"),
        "for target in 0..200 {",
        "for target in 0..3 {",
      ),
    tape: null,
    said: references.collectionTail(12, 3),
  },
];

/**
 * Runs `workload` through the harness, `mapCall` changing each host call (the identity, but for a control), and gives
 * its report with every problem: each tape run's, its units' completion in the left side's uninterrupted records, and
 * the runner's statement check of what those records say.
 */
function runWorkload(workload: Workload, mapCall: (call: HostCall) => HostCall = (call) => call) {
  const tape = workload.tape;
  const runs: TapeRun[] = [];
  const host = (side: "left" | "right"): HostDriver => {
    const run = runner.tapeRun(tape ?? [], `${workload.name} (${side})`);
    runs.push(run);
    return {
      next() {
        const next = run.next();
        return next === null ? null : mapCall(run.call(next));
      },
    };
  };
  const uninterrupted = new Map<number, SideRecord>();
  const report = differentialRun(input(workload.name, workload.rewrite), {
    maxCuts: 8,
    ...(tape ? { host } : {}),
    inject(record, at) {
      if (at.side === "left" && at.tail === "uninterrupted") uninterrupted.set(at.state, record);
      return record;
    },
  });
  const records = [...uninterrupted.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, record]) => record);
  const problems: string[] = [];
  if (tape) {
    // The uninterrupted run's host calls, in order, are the tape's entries: each unit must complete.
    const check = runner.tapeRun(tape, `${workload.name} (left, uninterrupted)`);
    for (const record of records)
      if (record.state.host !== null) {
        const next = check.next();
        if (next !== null) check.settled(next, resultOf(record).outcome);
      }
    problems.push(...check.end("halted"));
    for (const run of runs) problems.push(...run.end("halted"));
  }
  const said = records.flatMap((record) => resultOf(record).says);
  problems.push(
    ...runner.checkStated(
      { name: workload.name, said: workload.said },
      { said, instructions: 0, observed: { failure: null, tapeProblems: [] } },
    ),
  );
  return { report, problems, runs: runs.length };
}

for (const workload of WORKLOADS)
  test(`${workload.name} is equivalent on every restore route and says its reference`, () => {
    const { report, problems, runs } = runWorkload(workload);
    assert.deepEqual(report.verdict, { kind: "equivalent" }, workload.name);
    assert.deepEqual(report.outcomes.left, { kind: "completed" }, workload.name);
    assert.ok(report.tailSteps > 0, workload.name);
    assert.deepEqual(problems, [], workload.name);
    // The cut probe's run and both sides' runs each had their own tape run.
    if (workload.tape) assert.ok(runs >= 3, workload.name);
  });

const byName = (name: string): Workload => WORKLOADS.find((item) => item.name === name)!;
const changed = (name: string, change: (item: TapeEntry) => TapeEntry): Workload => ({
  ...byName(name),
  tape: byName(name).tape!.map(change),
});

// Each tape fault must fail the test's own checks, though both sides, misled alike, stay equivalent.
test("a stale form edit, failed storage acknowledgements, a surplus media answer or a wrong host call fails", () => {
  const faults: [string, Workload, RegExp][] = [
    [
      "stale form edits",
      changed("form-completion", (item) =>
        item.kind === "updateInteraction" ? withRequest(item, { actionId: -1 }) : item,
      ),
      /form-completion: says/,
    ],
    [
      "failed storage acknowledgements",
      changed("storage-commit", (item) => withRequest(item, { payload: { kind: "failed" } })),
      /storage-commit: says/,
    ],
    [
      "a surplus media answer",
      changed("file-store", (item) =>
        item.admissionQueries === undefined
          ? item
          : {
              ...item,
              admissionQueries: [
                ...item.admissionQueries,
                { reference: "extra", kind: "file", result: true },
              ],
            },
      ),
      /recorded media answers were not asked for/,
    ],
  ];
  for (const [fault, workload, expected] of faults)
    assert.match(runWorkload(workload).problems.join("\n"), expected, fault);
  // A wrong mapping of tape entries to host calls, in the differential run only: each form edit sent as a submit.
  const wrong = runWorkload(byName("form-completion"), (call) =>
    call.kind === "updateInteraction"
      ? {
          kind: "completeAction",
          request: { ...Object(call.request), payload: { kind: "submit" } },
        }
      : call,
  );
  assert.notDeepEqual(wrong.problems, [], "a wrong host call mapping");
});
