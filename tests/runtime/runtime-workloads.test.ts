// The #1797 workloads (F-work) through the differential harness (0b.1): each host tape and tail case runs on both
// sides of this build, every restore route included, and must be equivalent, and its uninterrupted run must say what
// its independent reference says. The full sizes stay with `tools/benchmark-runtime.mjs`, whose cuts restore from
// checkpoint JSON. Every session the harness makes, fresh, restored or forked, receives its host calls through the
// runner's guard (`checkedHostSession`), which checks each against the tape at the call, as the runner's own runs do.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import type { FreshRuntimeOptions, ProjectSourceFile } from "../../src/index.js";
import {
  differentialRun,
  type DifferentialInput,
  type HostCall,
  type HostDriver,
  type PipelineAdapter,
  type SideRecord,
  thisBuild,
} from "../helpers/runtime-differential.js";

// The compiled test runs from dist/tests; the benchmark lives at the checkout root.
const root = fileURLToPath(new URL("../../../", import.meta.url));
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
  problems(): readonly string[];
}
interface Guard {
  place(position: number): void;
}
interface Guards {
  start(position: number | null): Guard;
  problems(status: string): readonly string[];
}
/** The receipts a tape asks for, as the runner prepares them. */
interface Expected {
  readonly length: number;
}
interface Runner {
  loadTape(text: string, label: string): readonly TapeEntry[];
  tapeRun(tape: readonly TapeEntry[], label: string): TapeRun;
  prepareTape(tape: readonly TapeEntry[]): Expected;
  tapeGuards(expected: Expected, label: string): Guards;
  checkedHostSession<T extends object>(session: T, guard: Guard): T;
  checkStated(
    statement: { readonly name: string; readonly said?: readonly string[] },
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
// EVIDENCE: the runner checks the manifest's shape on every run of `tests/runtime/runtime-benchmark.test.ts`.
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
 * This build's pipeline for one side, each session it makes guarded: a fresh one from the tape's start, a restored one
 * placed at its cut once the harness writes its opening record (`place`), and a fork, by the guard, where its parent
 * stood.
 */
function guardedBuild(
  side: "left" | "right",
  guards: Guards,
  pending: Map<string, Guard>,
): PipelineAdapter {
  const base = thisBuild(side);
  const made = base.sessions;
  const restored = <T extends object>(session: T): T => {
    const guard = guards.start(null);
    pending.set(side, guard);
    return runner.checkedHostSession(session, guard);
  };
  return {
    ...base,
    sessions: {
      ...made,
      createFreshRuntimeSession: (...args) =>
        runner.checkedHostSession(made.createFreshRuntimeSession(...args), guards.start(0)),
      createRuntimeSession: (...args) => restored(made.createRuntimeSession(...args)),
      createTaggedRuntimeSession: (...args) => restored(made.createTaggedRuntimeSession(...args)),
      restoreRuntimeSession: (...args) => restored(made.restoreRuntimeSession(...args)),
      deserializeRuntimeSession: (...args) => restored(made.deserializeRuntimeSession(...args)),
    },
  };
}

/**
 * Runs `workload` through the harness and gives its report with every problem: the interpreter's, every guard's on both
 * sides (each host call checked against the tape at the call, its media answers and units), and the runner's statement
 * check of what the left side's uninterrupted records say.
 */
function runWorkload(workload: Workload) {
  const tape = workload.tape;
  const interpreters: TapeRun[] = [];
  const host = (side: "left" | "right"): HostDriver => {
    const run = runner.tapeRun(tape ?? [], `${workload.name} (${side})`);
    interpreters.push(run);
    return {
      next() {
        const next = run.next();
        return next === null ? null : run.call(next);
      },
    };
  };
  const expected = runner.prepareTape(tape ?? []);
  const guards = {
    left: runner.tapeGuards(expected, `${workload.name} (left)`),
    right: runner.tapeGuards(expected, `${workload.name} (right)`),
  };
  const pending = new Map<string, Guard>();
  // Each side's uninterrupted host-call states, from which a restored session's place at its cut follows.
  const hostStates = { left: new Set<number>(), right: new Set<number>() };
  const uninterrupted = new Map<number, SideRecord>();
  const report = differentialRun(input(workload.name, workload.rewrite), {
    maxCuts: 8,
    ...(tape
      ? {
          host,
          left: guardedBuild("left", guards.left, pending),
          right: guardedBuild("right", guards.right, pending),
        }
      : {}),
    inject(record, at) {
      if (at.tail === "uninterrupted") {
        if (record.state.host !== null) hostStates[at.side].add(at.state);
        if (at.side === "left") uninterrupted.set(at.state, record);
      } else if (record.state.operation === "restore" && at.tail !== "fork") {
        const guard = pending.get(at.side);
        pending.delete(at.side);
        const cut = at.cut ?? 0;
        guard?.place([...hostStates[at.side]].filter((state) => state <= cut).length);
      }
      return record;
    },
  });
  const records = [...uninterrupted.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, record]) => record);
  const problems: string[] = [];
  if (tape) {
    for (const run of interpreters) problems.push(...run.problems());
    problems.push(...guards.left.problems("halted"), ...guards.right.problems("halted"));
  }
  const said = records.flatMap((record) => resultOf(record).says);
  problems.push(
    ...runner.checkStated(
      { name: workload.name, said: workload.said },
      { said, instructions: 0, observed: { failure: null, tapeProblems: [] } },
    ),
  );
  return { report, problems, interpreters: interpreters.length };
}

for (const workload of WORKLOADS)
  test(`${workload.name} is equivalent on every restore route and says its reference`, () => {
    const { report, problems, interpreters } = runWorkload(workload);
    assert.deepEqual(report.verdict, { kind: "equivalent" }, workload.name);
    assert.deepEqual(report.outcomes.left, { kind: "completed" }, workload.name);
    assert.ok(report.tailSteps > 0, workload.name);
    assert.deepEqual(problems, [], workload.name);
    // The cut probe's run and both sides' runs each had their own interpreter.
    if (workload.tape) assert.ok(interpreters >= 3, workload.name);
  });
