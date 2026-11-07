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

import * as runtime from "../src/index.js";
import type { FreshRuntimeOptions, InstructionPlan, ProjectSourceFile } from "../src/index.js";
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
    statement: { readonly name: string; readonly said?: readonly string[] },
    record: {
      readonly said: readonly string[];
      readonly instructions: number;
      readonly observed: {
        readonly failure: string | null;
        readonly tapeProblems: readonly string[];
      };
    },
  ): readonly string[];
  canonicalJson(value: unknown): string;
  loadCases(
    directory: string,
    options: { readonly select: readonly string[] },
  ): readonly BenchmarkCase[];
  compileCase(api: typeof runtime, testCase: BenchmarkCase): InstructionPlan;
  recordCase(
    api: typeof runtime,
    testCase: BenchmarkCase,
    options: { readonly plan: InstructionPlan },
  ): CaseRecord;
  compareRecords(expected: unknown, actual: CaseRecord): readonly string[];
}
/** A manifest case as the runner loads it; this test only replaces its source or tape. */
interface BenchmarkCase {
  readonly name: string;
  readonly source: string;
  readonly tape?: readonly TapeEntry[];
  readonly said?: readonly string[];
}
/** A case's record as `recordCase` gives it. */
interface CaseRecord {
  readonly said: readonly string[];
  readonly instructions: number;
  readonly cuts: readonly { readonly kind: string; readonly outcome?: string | null }[];
  readonly observed: { readonly failure: string | null; readonly tapeProblems: readonly string[] };
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
// EVIDENCE: `tools/benchmark-runtime.mjs` exports these functions with these signatures.
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

/** A tape entry as the host call it asks for, as plain data, built from the tape's fields alone. */
function entryText(item: TapeEntry): string {
  const [first, second] = item.args;
  const args =
    item.kind === "observeTime"
      ? [first, second ?? []]
      : item.kind === "reportMediaLoad"
        ? [first, second]
        : [first];
  const media = item.kind === "completeAction" ? (item.admissionQueries ?? []) : null;
  return runner.canonicalJson({ kind: item.kind, args, media });
}

/** A host call as 0b.1 recorded it, in `entryText`'s form: read back field by field, independent of `tapeHostCall`. */
function recordText(host: unknown): string {
  if (typeof host !== "object" || host === null || !("kind" in host))
    return runner.canonicalJson({ unreadable: host });
  const args =
    host.kind === "observeTime"
      ? ["nowMs" in host ? host.nowMs : undefined, "reports" in host ? host.reports : []]
      : host.kind === "reportMediaLoad"
        ? ["mediaId" in host ? host.mediaId : undefined, "report" in host ? host.report : undefined]
        : host.kind === "pressPermanentButton"
          ? ["buttonId" in host ? host.buttonId : undefined]
          : ["request" in host ? host.request : undefined];
  const media =
    host.kind === "completeAction"
      ? "capturedMedia" in host && host.capturedMedia !== null
        ? host.capturedMedia
        : []
      : null;
  return runner.canonicalJson({ kind: host.kind, args, media });
}

/** How a host call of the differential run is misapplied: one entry's call changed, left out or made twice. */
interface Misapplied {
  readonly at: number;
  readonly fault: Fault;
}

/**
 * Runs `workload` through the harness, `misapplied` changing one host call (none but for the generated family), and
 * gives its report with every problem: each tape run's; each host call the left side's uninterrupted records hold
 * against its tape entry; each unit's completion in those records; and the runner's statement check of what they say.
 */
function runWorkload(
  workload: Workload,
  { misapplied, maxCuts = 8 }: { misapplied?: Misapplied; maxCuts?: number } = {},
) {
  const tape = workload.tape;
  const runs: TapeRun[] = [];
  const host = (side: "left" | "right"): HostDriver => {
    const run = runner.tapeRun(tape ?? [], `${workload.name} (${side})`);
    runs.push(run);
    let index = 0;
    let again: TapeEntry | null = null;
    return {
      next() {
        if (again !== null) {
          const twice = again;
          again = null;
          return run.call(twice);
        }
        let next = run.next();
        if (next !== null && misapplied?.at === index && misapplied.fault === "drop") {
          index++;
          next = run.next();
        }
        if (next === null) return null;
        const at = index++;
        if (misapplied?.at !== at) return run.call(next);
        if (misapplied.fault === "repeat") {
          again = next;
          return run.call(next);
        }
        return run.call(faulted(next, misapplied.fault));
      },
    };
  };
  const uninterrupted = new Map<number, SideRecord>();
  const report = differentialRun(input(workload.name, workload.rewrite), {
    maxCuts,
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
    const calls = records.filter((record) => record.state.host !== null);
    // Each host call made is its tape entry's, in order.
    const made = calls.map((record) => recordText(record.state.host));
    const asked = tape.map(entryText);
    const differs = Math.max(made.length, asked.length);
    for (let index = 0; index < differs; index++)
      if (made[index] !== asked[index]) {
        problems.push(
          `${workload.name}: host call ${index + 1} is ${made[index]}, its tape entry ${asked[index]}`,
        );
        break;
      }
    // Each unit completed.
    const check = runner.tapeRun(tape, `${workload.name} (left, uninterrupted)`);
    for (const record of calls) {
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

// The generated family of misapplied tapes (the tape-invariant family's closing invariant, Codex r4): every fault at
// every position of every tape case, in each driver, must fail that driver's own checks, though both sides of the
// differential run, misled alike, stay equivalent. The axes are declared once; a case's name is its axis values.
const AXES = {
  driver: ["runner", "differential"],
  tape: ["helper-input", "form-completion", "storage-commit", "storage-failed", "file-store"],
  fault: ["action", "actionKind", "payload", "failed", "kind", "drop", "repeat", "media"],
  position: ["first", "refused", "last"],
} as const;
type Axis = keyof typeof AXES;
const AXIS_NAMES: readonly Axis[] = ["driver", "tape", "fault", "position"];
type Fault = (typeof AXES.fault)[number];
type Position = (typeof AXES.position)[number];
interface Combination {
  readonly driver: (typeof AXES.driver)[number];
  readonly tape: (typeof AXES.tape)[number];
  readonly fault: Fault;
  readonly position: Position;
}
const nameOf = (combination: Combination): string =>
  `${combination.driver}/${combination.tape}/${combination.fault}/${combination.position}`;

/** `item` with `fault` applied, for the faults that change one call rather than leave it out or repeat it. */
function faulted(item: TapeEntry, fault: Fault): TapeEntry {
  switch (fault) {
    case "action":
      return withRequest(item, { actionId: -1 });
    case "actionKind":
      return withRequest(item, { actionKind: "lock" });
    case "payload":
      return withRequest(
        item,
        item.kind === "completeAction"
          ? { payload: { kind: "bogus" } }
          : { update: { kind: "bogus" } },
      );
    case "failed":
      return withRequest(item, { payload: { kind: "failed" } });
    case "kind":
      return {
        ...item,
        kind: item.kind === "completeAction" ? "updateInteraction" : "completeAction",
      };
    case "media":
      return {
        ...item,
        admissionQueries: [
          ...(item.admissionQueries ?? []),
          { reference: "extra", kind: "file", result: true },
        ],
      };
    case "drop":
    case "repeat":
      throw new Error(`${fault} changes the sequence, not a call`);
  }
}

/** `tape` with `fault` at `at`: the tape a runner whose interpreter misapplied it would run. */
function faultedTape(tape: readonly TapeEntry[], fault: Fault, at: number): readonly TapeEntry[] {
  if (fault === "drop") return tape.filter((_, index) => index !== at);
  if (fault === "repeat") return [...tape.slice(0, at + 1), ...tape.slice(at)];
  return tape.map((item, index) => (index === at ? faulted(item, fault) : item));
}

const benchmarkCase = (name: string): BenchmarkCase =>
  runner.loadCases(benchmark, { select: [name] })[0]!;
// EVIDENCE: `baseline.json` is the runner's own baseline, which `tests/runtime-benchmark.test.ts` checks.
const baseline = JSON.parse(read("baseline.json")) as { readonly cases: Record<string, unknown> };

/**
 * The tape each driver runs for a tape case, and where its positions are: the first entry, the last, and the first
 * the engine refused (an outcome other than `completed` or `updated`), from the runner's own run of that tape.
 */
function positionsOf(combination: Pick<Combination, "driver" | "tape">) {
  const workload = byName(combination.tape);
  const full = benchmarkCase(combination.tape);
  const testCase: BenchmarkCase =
    combination.driver === "runner"
      ? full
      : { ...full, source: workload.rewrite(full.source), tape: workload.tape! };
  const tape = testCase.tape!;
  const record = runner.recordCase(runtime, testCase, {
    plan: runner.compileCase(runtime, testCase),
  });
  const outcomes = record.cuts.filter((cut) => cut.kind === "host").map((cut) => cut.outcome);
  const refused = outcomes.findIndex((outcome) => outcome !== "completed" && outcome !== "updated");
  const at: Record<Position, number | null> = {
    first: 0,
    refused: refused < 0 ? null : refused,
    last: tape.length - 1,
  };
  return { testCase, tape, at };
}

const byName = (name: string): Workload => WORKLOADS.find((item) => item.name === name)!;
const positions = new Map(
  AXES.driver.flatMap((driver) =>
    AXES.tape.map((tape) => [`${driver}/${tape}`, positionsOf({ driver, tape })] as const),
  ),
);
const placed = (combination: Combination) =>
  positions.get(`${combination.driver}/${combination.tape}`)!;

/**
 * Whether a combination is a fault at all: its position exists, and a failed answer or a surplus media answer needs a
 * `completeAction`.
 */
function valid(combination: Combination): boolean {
  const { tape, at } = placed(combination);
  const index = at[combination.position];
  if (index === null) return false;
  const needsCompletion = combination.fault === "media" || combination.fault === "failed";
  return !needsCompletion || tape[index]!.kind === "completeAction";
}

const every: Combination[] = AXES.driver.flatMap((driver) =>
  AXES.tape.flatMap((tape) =>
    AXES.fault.flatMap((fault) =>
      AXES.position.map((position) => ({ driver, tape, fault, position })),
    ),
  ),
);
const VALID = every.filter(valid);

/** The pairs of axis values a set of combinations holds, as `axis=value|axis=value`. */
function pairs(combinations: readonly Combination[]): Set<string> {
  const axes = AXIS_NAMES;
  const found = new Set<string>();
  for (const combination of combinations)
    for (const [i, a] of axes.entries())
      for (const b of axes.slice(i + 1)) found.add(`${a}=${combination[a]}|${b}=${combination[b]}`);
  return found;
}

/**
 * The generated cases: every valid runner combination (each takes milliseconds), and the fewest differential ones, in
 * order, that still hold every pair the valid combinations hold; each differential run takes about a second.
 */
const GENERATED: Combination[] = (() => {
  const chosen = VALID.filter((combination) => combination.driver === "runner");
  const needed = pairs(VALID);
  const covered = pairs(chosen);
  const candidates = VALID.filter((combination) => combination.driver === "differential");
  for (;;) {
    let best: Combination | null = null;
    let gain = 0;
    for (const candidate of candidates) {
      const added = [...pairs([candidate])].filter(
        (pair) => needed.has(pair) && !covered.has(pair),
      ).length;
      if (added > gain) {
        best = candidate;
        gain = added;
      }
    }
    if (best === null) return chosen;
    chosen.push(best);
    for (const pair of pairs([best])) covered.add(pair);
  }
})();

test("the generated misapplied tapes cover every axis value and every pair of the valid combinations", () => {
  const generated = GENERATED.map(nameOf).map((name) => {
    const [driver, tape, fault, position] = name.split("/");
    // EVIDENCE: `nameOf` joins exactly the four axis values, in `AXES`'s order, none of which holds a slash.
    return { driver, tape, fault, position } as Combination;
  });
  assert.deepEqual([...AXIS_NAMES].sort(), Object.keys(AXES).sort());
  const covered = pairs(generated);
  for (const pair of pairs(VALID)) assert.ok(covered.has(pair), pair);
  for (const axis of AXIS_NAMES)
    for (const value of AXES[axis])
      assert.ok(
        generated.some((combination) => combination[axis] === value),
        `${axis}=${value}`,
      );
});

test("every generated misapplied tape fails its driver's own checks", () => {
  const missed: string[] = [];
  for (const combination of GENERATED) {
    const { testCase, tape, at } = placed(combination);
    const index = at[combination.position]!;
    let problems: readonly string[];
    if (combination.driver === "runner") {
      const misapplied = { ...testCase, tape: faultedTape(tape, combination.fault, index) };
      try {
        const record = runner.recordCase(runtime, misapplied, {
          plan: runner.compileCase(runtime, misapplied),
        });
        problems = [
          ...runner.compareRecords(baseline.cases[combination.tape], record),
          ...runner.checkStated(testCase, record),
        ];
      } catch (error) {
        problems = [String(error)];
      }
    } else
      problems = runWorkload(byName(combination.tape), {
        misapplied: { at: index, fault: combination.fault },
        maxCuts: 1,
      }).problems;
    if (problems.length === 0) missed.push(nameOf(combination));
  }
  assert.deepEqual(missed, []);
});
