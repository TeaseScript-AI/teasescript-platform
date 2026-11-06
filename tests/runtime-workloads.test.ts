// The #1797 workloads (F-work) through the differential harness (0b.1): each host tape and tail case runs on both
// sides of this build, every restore route included, and must be equivalent; the full sizes stay with
// `tools/benchmark-runtime.mjs`, whose cuts restore from checkpoint JSON. The tape cases feed the harness their
// tape, as the runner does, so both drivers settle actions and observe time at the same calls.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import type {
  ActionCompletionOptions,
  FreshRuntimeOptions,
  ProjectSourceFile,
} from "../src/index.js";
import {
  differentialRun,
  type DifferentialInput,
  type HostCall,
  type HostDriver,
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
interface ManifestCase {
  readonly name: string;
  readonly file?: string;
  readonly project?: string;
  readonly files?: readonly string[];
  readonly tape?: string;
  readonly fresh?: FreshRuntimeOptions;
}
interface Runner {
  loadTape(text: string, label: string): readonly TapeEntry[];
  recordedMedia(
    queries: readonly unknown[] | undefined,
  ): NonNullable<ActionCompletionOptions["capturedMedia"]>;
}
// EVIDENCE: `tools/benchmark-runtime.mjs` exports `loadTape` and `recordedMedia` with these signatures.
const runner = (await import(
  pathToFileURL(path.join(root, "tools", "benchmark-runtime.mjs")).href
)) as Runner;
// EVIDENCE: the runner checks the manifest's shape on every run of `tests/runtime-benchmark.test.ts`.
const manifest = JSON.parse(read("manifest.json")) as {
  readonly seed: number;
  readonly wallClockMs: number;
  readonly cases: readonly ManifestCase[];
};
const entry = (name: string): ManifestCase => manifest.cases.find((item) => item.name === name)!;

/** A case's input as the runner builds it: its source or ordered project, seed, clock, no pacing, its options. */
function input(
  name: string,
  rewrite: (source: string) => string = (source) => source,
): DifferentialInput {
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

/** One tape entry as the harness's host call; a `completeAction` gets its recorded media answers, in order. */
function hostCall(item: TapeEntry): HostCall {
  const [first, second] = item.args;
  switch (item.kind) {
    case "completeAction":
      return {
        kind: "completeAction",
        request: first,
        capturedMedia: runner.recordedMedia(item.admissionQueries),
      };
    case "updateInteraction":
      return { kind: "updateInteraction", request: first };
    case "observeTime":
      if (typeof first !== "number" || !(second === undefined || Array.isArray(second)))
        throw new Error("observeTime takes a time and a list of media reports");
      return { kind: "observeTime", nowMs: first, reports: second ?? [] };
    case "reportMediaLoad":
      return { kind: "reportMediaLoad", mediaId: first, report: second };
    case "pressPermanentButton":
      return { kind: "pressPermanentButton", buttonId: first };
    default:
      throw new Error(`no host call ${item.kind}`);
  }
}

type Rewrite = (source: string) => string;
type Cut = (tape: readonly TapeEntry[]) => readonly TapeEntry[];

/**
 * A host per run that gives the tape's next entry each time it is asked, and remembers how far each run got; `cut`
 * shortens the tape for a reduced source.
 */
function tapeHosts(
  name: string,
  cut: Cut,
): { host: () => HostDriver; used: { count: number }[]; length: number } {
  const tape = cut(runner.loadTape(read(entry(name).tape!), name));
  const used: { count: number }[] = [];
  return {
    length: tape.length,
    used,
    host() {
      const run = { count: 0 };
      used.push(run);
      return {
        next() {
          const next = tape[run.count];
          if (next === undefined) return null;
          run.count++;
          return hostCall(next);
        },
      };
    },
  };
}

/** `source` with its one line `from` replaced by `to`: a reduced size. */
function resize(source: string, from: string, to: string): string {
  assert.equal(source.split(from).length, 2, `one line ${from}`);
  return source.replace(from, to);
}

const same = <T>(value: T): T => value;
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

/**
 * The tape cases. `helper-input` asks its count 3 times instead of 6, 7 frames deep instead of 19 (the runner keeps the
 * full depth), with its tape's number answers up to the third accepted one, so the host's refusal stays in.
 */
const TAPE_CASES: [string, Rewrite, Cut][] = [
  [
    "helper-input",
    (source) => resize(resize(source, "repeat 6 {", "repeat 3 {"), "deeper(18)", "deeper(6)"),
    (tape) => {
      let accepted = 0;
      const kept = tape.filter((item) => {
        if (!answersNumber(item)) return true;
        if (accepted === 3) return false;
        if (item.unit) accepted++;
        return true;
      });
      // The asks that no longer happen took action IDs, so each later answer's ID moves down by those before it.
      const dropped = tape.filter((item) => !kept.includes(item)).map(actionId);
      return kept.map((item) => {
        const id = actionId(item);
        const before = dropped.filter((other) => other < id).length;
        return before === 0
          ? item
          : { ...item, args: [{ ...Object(item.args[0]), actionId: id - before }] };
      });
    },
  ],
  ["form-completion", same, same],
  ["storage-commit", same, same],
  ["storage-failed", same, same],
  ["file-store", same, same],
];

for (const [name, rewrite, cut] of TAPE_CASES)
  test(`${name}'s tape is equivalent on both sides and every restore route`, () => {
    const hosts = tapeHosts(name, cut);
    const report = differentialRun(input(name, rewrite), { host: hosts.host, maxCuts: 8 });
    assert.deepEqual(report.verdict, { kind: "equivalent" }, name);
    assert.deepEqual(report.outcomes.left, { kind: "completed" }, name);
    assert.ok(report.tailSteps > 0, name);
    // Each uninterrupted run, the cut probe's too, used the whole tape, as the runner requires.
    assert.ok(hosts.used.length >= 3, name);
    assert.deepEqual(
      hosts.used.map((run) => run.count),
      hosts.used.map(() => hosts.length),
      name,
    );
  });

// The project and the tails, made small by their size lines (101 chunks still reach the read at 63 and the rewrite at
// 100); their full sizes stay the runner's. The cooperative Battleship think stays the runner's alone: one placement
// already takes thousands of steps, and its rests are waits, which the runner restores at every cut.
const REDUCED: [string, Rewrite][] = [
  ["transfer-project", same],
  ["text-tail-64k", (source) => resize(source, "let chunks = 1024", "let chunks = 101")],
  [
    "collection-tail-10000",
    (source) =>
      resize(
        resize(source, "let size = 10000", "let size = 12"),
        "for target in 0..200 {",
        "for target in 0..3 {",
      ),
  ],
];

for (const [name, rewrite] of REDUCED)
  test(`${name}, reduced, is equivalent on both sides and every restore route`, () => {
    const report = differentialRun(input(name, rewrite), { maxCuts: 8 });
    assert.deepEqual(report.verdict, { kind: "equivalent" }, name);
    assert.deepEqual(report.outcomes.left, { kind: "completed" }, name);
    assert.ok(report.tailSteps > 0, name);
  });
