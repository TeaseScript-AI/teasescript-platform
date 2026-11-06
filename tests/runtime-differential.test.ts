import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { SWEEP } from "./helpers/sweep.js";

import {
  compileSource,
  createFreshRuntimeSession,
  runtimeTimedWork,
  type FreshRuntimeOptions,
  type ProjectSourceFile,
  type SerializableRuntimeValue,
} from "../src/index.js";
import {
  differentialRun,
  thisBuild,
  type PipelineAdapter,
  type Stage,
  type DifferentialInput,
  type DifferentialReport,
  type HostDriver,
  type InjectionSite,
  type Route,
  type SideRecord,
} from "./helpers/runtime-differential.js";
import {
  canonicalDigest,
  canonicalText,
  compareStructures,
  deepList,
  deepSetChain,
  IDENTITY,
  mixedNest,
  renderPath,
  wideSet,
  type StructurePath,
} from "./helpers/runtime-state-comparison.js";

/*
 * The differential harness run against this build itself (docs/TESTING.md "Differential harness"): every retained
 * regression and a bounded seeded sample must be equivalent, every restore route included, and each control must fail
 * for its own reason at its own path.
 */

const checkout = fileURLToPath(new URL("../..", import.meta.url));
const tools = path.join(checkout, "tools", "runtime-differential");

interface GeneratedProgram {
  readonly id: string;
  readonly family: string;
  readonly tags: readonly string[];
  readonly runtimeSeed: number;
  readonly globals?: Record<string, SerializableRuntimeValue>;
  readonly project?: boolean;
  readonly sources: readonly ProjectSourceFile[];
}

interface Shrinker {
  shrink(
    source: string,
    preserves: (source: string) => boolean,
  ): { readonly source: string; readonly minimal: boolean };
}

// EVIDENCE: validation: the shrinker module exports `shrink` of this shape.
const { shrink } = (await import(path.join(tools, "shrink.mjs"))) as Shrinker;

interface Generator {
  readonly families: readonly string[];
  generate(seed: number, index: number, family?: string): GeneratedProgram;
}

// EVIDENCE: validation: the generator module exports `families` and `generate` of these shapes.
const generator = (await import(path.join(tools, "generate.mjs"))) as Generator;

interface RegressionIndex {
  readonly seeds: readonly number[];
  readonly entries: readonly {
    readonly name: string;
    readonly globals?: Record<string, SerializableRuntimeValue>;
    readonly expect?: {
      readonly said?: readonly string[];
      readonly status?: string;
      readonly diagnostic?: string;
    };
  }[];
}

// EVIDENCE: validation: the regression index is this shape, written once from the research corpus.
const regressions = JSON.parse(
  fs.readFileSync(path.join(tools, "regressions", "index.json"), "utf8"),
) as RegressionIndex;

const ROUTES: readonly Route[] = ["legacy", "core"];

/**
 * Cut points per run: in CI 8 (the mandatory cuts first, then evenly spaced ones), with `TEASESCRIPT_SWEEP=full` the
 * driver's 32. Every input, seed and restore route runs either way; only the non-mandatory cuts are fewer.
 */
const CUTS = { maxCuts: SWEEP ? 32 : 8 };

function single(name: string, source: string, fresh: FreshRuntimeOptions = {}): DifferentialInput {
  return { name, sources: [{ path: "main.tease", source }], fresh };
}

/** Equivalent, or on the core route not compared because the core does not support the program yet. */
function assertEquivalent(report: DifferentialReport): void {
  if (report.route === "core" && report.verdict.kind === "not-compared")
    assert.equal(report.verdict.because, "unsupported-route", report.name);
  else assert.deepEqual(report.verdict, { kind: "equivalent" }, report.name);
}

/** What `input` says and how it ends, run on its own with `run`, independent of the driver. */
function saidAndStatus(input: DifferentialInput): { said: string[]; status: string } {
  const compiled = compileSource(input.sources[0]!.source, {
    globals: Object.keys(input.fresh?.globals ?? {}),
  });
  assert.ok(compiled.plan !== null, input.name);
  const session = createFreshRuntimeSession(compiled.plan, input.fresh ?? {});
  const said: string[] = [];
  for (let guard = 0; guard < 1_000; guard += 1) {
    for (const event of session.run().events) if (event.kind === "say") said.push(event.text);
    const view = session.view();
    if (view.status !== "waiting") return { said, status: view.status };
    const work = runtimeTimedWork(view);
    if (work.length === 0) return { said, status: view.status };
    for (const event of session.observeTime(Math.min(...work.map((item) => item.deadlineMs)))
      .events)
      if (event.kind === "say") said.push(event.text);
  }
  assert.fail(`${input.name} did not end`);
}

const reports: DifferentialReport[] = [];

test("every retained regression is equivalent on both routes and keeps its independent expectation", () => {
  for (const entry of regressions.entries) {
    const source = fs.readFileSync(path.join(tools, "regressions", `${entry.name}.tease`), "utf8");
    for (const seed of regressions.seeds) {
      const input = single(entry.name, source, {
        seed,
        ...(entry.globals ? { globals: entry.globals } : {}),
      });
      for (const route of ROUTES) {
        const report = differentialRun(input, { ...CUTS, route });
        reports.push(report);
        assertEquivalent(report);
      }
      const expect = entry.expect;
      if (expect?.diagnostic !== undefined) {
        const codes = compileSource(source).diagnostics.map((item) => item.code);
        assert.ok(codes.includes(expect.diagnostic), `${entry.name}: ${codes.join(", ")}`);
        continue;
      }
      if (expect === undefined) continue;
      const run = saidAndStatus(input);
      if (expect.said !== undefined) assert.deepEqual(run.said, expect.said, entry.name);
      if (expect.status !== undefined) assert.equal(run.status, expect.status, entry.name);
    }
  }
});

/** Each family once, then the first indices of seed 1: about 40 programs that cover every feature tag. */
function sample(): GeneratedProgram[] {
  const programs = [...new Set(generator.families)].map((family, index) =>
    generator.generate(7, index, family),
  );
  for (let index = 0; programs.length < 40; index += 1) programs.push(generator.generate(1, index));
  return programs;
}

test("a bounded seeded sample of generated programs is equivalent on both routes", () => {
  const programs = sample();
  const tags = new Set(programs.flatMap((program) => program.tags));
  const everyTag = new Set(
    [...new Set(generator.families)].flatMap((family) => generator.generate(7, 0, family).tags),
  );
  for (const tag of everyTag) assert.ok(tags.has(tag), `the sample covers ${tag}`);
  assert.ok(tags.has("project"), "the sample has a project");
  let randomPrograms = 0;
  for (const program of programs) {
    // Random programs alternate between the harness's two decision modes, whose logs and receipts are compared.
    const random = program.tags.includes("rng")
      ? (randomPrograms += 1) % 2 === 0
        ? "choose"
        : "natural"
      : undefined;
    const input: DifferentialInput = {
      name: program.id,
      sources: program.sources,
      project: program.project === true,
      ...(random === undefined ? {} : { random }),
      fresh: {
        seed: program.runtimeSeed,
        ...(program.globals ? { globals: program.globals } : {}),
      },
    };
    for (const route of ROUTES) {
      const report = differentialRun(input, { ...CUTS, route });
      reports.push(report);
      // A generated program the compiler rejects is classified, not patched in: both sides reject it alike.
      assertEquivalent(report);
    }
  }
});

const DEPTH = 10_000;
const DEEP_SOURCE = 'let copy = hostValue\nwait 1 ms\nsay "done", instant\nexit\n';

/** The path of the innermost list's leaf in a binding's `deepList` value, and that leaf's holder. */
function deepLeaf(value: unknown, depth: number): { path: (string | number)[]; holder: unknown[] } {
  const path: (string | number)[] = [];
  let at = value;
  for (let level = 0; level < depth; level += 1) {
    path.push("items", 0);
    // EVIDENCE: validation: `deepList` builds a list of one item at every level.
    const items = (at as { items: unknown[] }).items;
    if (level === depth - 1) return { path, holder: items };
    at = items[0];
  }
  throw new Error("unreachable");
}

test("a 10,000-level host list runs, restores and compares on the supported path, without the harness's own failure", () => {
  const input = single("deep-host-list", DEEP_SOURCE, {
    seed: 1,
    globals: { hostValue: deepList(DEPTH) },
  });
  const report = differentialRun(input, CUTS);
  reports.push(report);
  assert.deepEqual(report.verdict, { kind: "equivalent" });
  assert.deepEqual(report.outcomes.left, { kind: "completed" });
  assert.ok(report.cuts.length > 0 && report.tailSteps > 0);

  // A detached copy with one deep leaf changed differs at that path only, and the original stays as it was.
  const compiled = compileSource(DEEP_SOURCE, { globals: ["hostValue"] });
  const session = createFreshRuntimeSession(compiled.plan!, input.fresh!);
  const snapshot = session.exportTrustedSnapshot();
  const before = canonicalText(snapshot);
  // EVIDENCE: validation: `canonicalText` writes JSON, which `JSON.parse` reads back as plain data.
  const copy = JSON.parse(before) as typeof snapshot;
  const index = copy.globals.findIndex((binding) => binding.name === "hostValue");
  const leaf = deepLeaf(copy.globals[index]!.value, DEPTH);
  leaf.holder[0] = 1;
  const comparison = compareStructures(snapshot, copy);
  const expected: StructurePath = ["globals", index, "value", ...leaf.path];
  assert.equal(comparison.mismatches.length, 1);
  assert.deepEqual(comparison.mismatches[0], { path: expected, oracle: "0", candidate: "1" });
  assert.equal(canonicalText(snapshot), before);

  // Writing keeps property and array order and every occurrence; a reordering is a mismatch.
  const ordered = { value: mixedNest(9), set: wideSet(10, 3), chain: deepSetChain(64), z: 1, a: 2 };
  assert.ok(compareStructures(ordered, JSON.parse(canonicalText(ordered))).equal);
  const reordered = compareStructures(ordered, {
    value: ordered.value,
    set: ordered.set,
    chain: ordered.chain,
    a: 2,
    z: 1,
  });
  assert.deepEqual(
    reordered.mismatches.map((item) => item.path),
    [[]],
  );

  // An array compares by its length and every position, also a sparse one.
  assert.ok(!compareStructures(new Array(1), new Array(2)).equal);

  // Signed zero survives writing and hashing, where native JSON loses it.
  const zero = deepList(DEPTH, 0);
  const negative = deepList(DEPTH, -0);
  assert.equal(JSON.stringify(-0), "0");
  assert.notEqual(canonicalDigest(zero), canonicalDigest(negative));
  assert.ok(Object.is(JSON.parse(canonicalText(-0)), -0));
});

const CHOICES =
  'let first = askChoice "left", "right"\nwait 1 s\nlet second = askChoice "up", "down"\nsay "${first} ${second}", instant\nexit\n';

/** A host that answers each choice with `option` and observes each delay's deadline. */
function choosingHost(option: number): HostDriver {
  return {
    next(view) {
      const action = view.foregroundAction;
      if (action?.kind === "interaction")
        return {
          kind: "completeAction",
          request: {
            actionId: action.actionId,
            actionKind: "interaction",
            interactionKind: "choice",
            payload: { kind: "selectedOption", optionIndex: option },
          },
        };
      const work = runtimeTimedWork(view);
      return work.length === 0
        ? null
        : { kind: "observeTime", nowMs: Math.min(...work.map((item) => item.deadlineMs)) };
    },
  };
}

test("a host drives both sides through interactions, and both must make the same host calls", () => {
  const input = single("choices", CHOICES, { seed: 3 });
  const hosted = differentialRun(input, { ...CUTS, host: () => choosingHost(1) });
  reports.push(hosted);
  assert.deepEqual(hosted.verdict, { kind: "equivalent" });
  assert.deepEqual(hosted.outcomes.left, { kind: "completed" });
  assert.ok(hosted.tailSteps > 0);
  // A host may reuse its call objects: each call is recorded as it was made (Sol r1 #1).
  const reusing = (): HostDriver => {
    const call = { kind: "observeTime" as const, nowMs: 0 };
    return {
      next(view) {
        const work = runtimeTimedWork(view);
        if (work.length === 0) return null;
        call.nowMs = Math.min(...work.map((item) => item.deadlineMs));
        return call;
      },
    };
  };
  assert.deepEqual(
    differentialRun(single("waits", "wait 1 ms\nwait 1 ms\nexit\n", { seed: 3 }), {
      ...CUTS,
      host: reusing,
    }).verdict,
    { kind: "equivalent" },
  );
  // Without a host, the driver's own settles delays only, so the run waits at the first choice.
  assert.deepEqual(differentialRun(input, CUTS).outcomes.left, { kind: "waiting" });
  // A right side whose host answers otherwise differs at the host call itself.
  const differing = differentialRun(input, {
    ...CUTS,
    host: (side) => choosingHost(side === "left" ? 1 : 0),
  });
  assertDiscrepancyAt(differing, ["state", "host"]);
});

const STORES = 'let letters = fileFromBase64("YWJj", default: "")\nsay "kept", instant\nexit\n';

/**
 * A host with a file store: it keeps each stored file under a new reference, and its captured-media admission vouches
 * for each reference once, so that it is used up as it answers, as a recorded Player's is. `vouches` false answers no.
 */
function storingHost(vouches = true): HostDriver {
  let next = 1;
  return {
    next(view) {
      const action = view.foregroundAction;
      if (action?.kind === "fileStore" && action.operation === "store") {
        const references = action.files.map(() => `stored:${next++}`);
        const pending = new Set(references);
        return {
          kind: "completeAction",
          request: {
            actionId: action.actionId,
            actionKind: "fileStore",
            payload: { kind: "stored", references },
          },
          capturedMedia: { holds: (reference) => vouches && pending.delete(reference) },
        };
      }
      const work = runtimeTimedWork(view);
      return work.length === 0
        ? null
        : { kind: "observeTime", nowMs: Math.min(...work.map((item) => item.deadlineMs)) };
    },
  };
}

test("a captured-media admission is replayed on every restore route from what it answered, not reused", () => {
  const input = single("stores", STORES, { seed: 3 });
  const stored = differentialRun(input, { ...CUTS, host: () => storingHost() });
  reports.push(stored);
  assert.deepEqual(stored.verdict, { kind: "equivalent" });
  assert.deepEqual(stored.outcomes.left, { kind: "completed" });
  assert.ok(stored.tailSteps > 0);
  // A right side whose admission vouches for nothing differs at the host call's recorded answers.
  const refused = differentialRun(input, { ...CUTS, host: (side) => storingHost(side === "left") });
  assertDiscrepancyAt(refused, ["state", "host"]);
});

/** A copy of `record` with `change` applied, the injection's only effect. */
function changed(record: SideRecord, change: (copy: SideRecord) => void): SideRecord {
  // EVIDENCE: validation: `canonicalText` writes JSON, which `JSON.parse` reads back as plain data.
  const copy = JSON.parse(canonicalText(record)) as SideRecord;
  change(copy);
  return copy;
}

/** The snapshot of a written record copy, which the harness exported as a runtime snapshot. */
function snapshotOf(
  record: SideRecord,
): Record<string, unknown> & {
  frames: { bindings: { name: string; value: unknown }[] }[];
  globals: { name: string; value: unknown }[];
  rng: number;
  status: string;
} {
  // EVIDENCE: validation: every record's `state.snapshot` is the side's trusted snapshot export.
  return record.state.snapshot as ReturnType<typeof snapshotOf>;
}

const SENSITIVE =
  "let x = randomInteger(0..3)\nlet computed = x + 1\nsay computed, instant\nwait 1 ms\nexit\n";

/** Runs the sensitivity program with one injection on the right side, applied once where `where` first holds. */
function injected(
  where: (record: SideRecord, at: InjectionSite) => boolean,
  change: (copy: SideRecord) => void,
  input: DifferentialInput = single("sensitivity", SENSITIVE, { seed: 5 }),
): DifferentialReport {
  let applied = false;
  const report = differentialRun(input, {
    ...CUTS,
    inject: (record, at) => {
      if (applied || at.side !== "right" || !where(record, at)) return record;
      applied = true;
      return changed(record, change);
    },
  });
  assert.ok(applied, "the injection applied");
  return report;
}

function assertDiscrepancyAt(
  report: DifferentialReport,
  prefix: StructurePath,
  tail = "uninterrupted",
): void {
  const verdict = report.verdict;
  assert.equal(verdict.kind, "discrepancy", JSON.stringify(verdict));
  if (verdict.kind !== "discrepancy") return;
  assert.equal(verdict.at.tail, tail);
  assert.equal(verdict.at.against, "other-side");
  const first = verdict.mismatches[0]!.path;
  assert.deepEqual(first.slice(0, prefix.length), prefix, renderPath(first));
}

const uninterrupted = (at: InjectionSite) => at.tail === "uninterrupted";
const eventsOf = (record: SideRecord) => {
  // EVIDENCE: validation: a step record's result holds the operation's events; an opening record's result is `null`.
  const result = record.state.result as { events: unknown[] } | null;
  return result?.events ?? [];
};
const binding = (record: SideRecord, name: string) =>
  snapshotOf(record)
    .frames.flatMap((frame) => frame.bindings)
    .find((item) => item.name === name);

test("each of the five sensitivity injections is a discrepancy at its own path", () => {
  assert.deepEqual(differentialRun(single("sensitivity", SENSITIVE, { seed: 5 }), CUTS).verdict, {
    kind: "equivalent",
  });
  // A value: `computed` one more on the candidate.
  assertDiscrepancyAt(
    injected(
      (record, at) => uninterrupted(at) && binding(record, "computed") !== undefined,
      (copy) => {
        const item = binding(copy, "computed")!;
        // EVIDENCE: validation: `computed` holds an integer, `x + 1`.
        item.value = (item.value as number) + 1;
      },
    ),
    ["state", "snapshot", "frames"],
  );
  // The RNG state.
  assertDiscrepancyAt(
    injected(
      (_, at) => uninterrupted(at) && at.state === 1,
      (copy) => {
        snapshotOf(copy).rng ^= 1;
      },
    ),
    ["state", "snapshot", "rng"],
  );
  // An event: the message the step said, dropped.
  assertDiscrepancyAt(
    injected(
      (record, at) => uninterrupted(at) && eventsOf(record).length > 0,
      (copy) => {
        eventsOf(copy).length = 0;
      },
    ),
    ["state", "result", "events"],
  );
  // The status at the end.
  assertDiscrepancyAt(
    injected(
      (record, at) => uninterrupted(at) && snapshotOf(record).status === "halted",
      (copy) => {
        snapshotOf(copy).status = "running";
      },
    ),
    ["state", "snapshot", "status"],
  );
  // A restore: the RNG of the state a checkpoint's text restored.
  assertDiscrepancyAt(
    injected(
      (_, at) => at.tail === "checkpoint-json",
      (copy) => {
        snapshotOf(copy).rng ^= 1;
      },
    ),
    ["state", "snapshot", "rng"],
    "checkpoint-json",
  );
});

test("a different debug-trace record or observer log is a discrepancy with equal snapshots and results", () => {
  const debugOf = (record: SideRecord) => {
    // EVIDENCE: validation: a record's `traces.debug` is the side's debug status and its new records.
    const debug = record.traces.debug as { records: { preview: string | null }[] } | null;
    return debug;
  };
  assertDiscrepancyAt(
    injected(
      (record, at) => uninterrupted(at) && (debugOf(record)?.records.length ?? 0) > 0,
      (copy) => {
        debugOf(copy)!.records[0]!.preview = "changed";
      },
    ),
    ["traces", "debug", "records", 0, "preview"],
  );
  const observerOf = (record: SideRecord) => {
    // EVIDENCE: validation: a record's observer log holds the hooks' calls with their arguments.
    const log = record.traces.observer as { hook: string; call: number }[];
    return log;
  };
  const withAfter = (record: SideRecord, at: InjectionSite) =>
    uninterrupted(at) && observerOf(record).some((item) => item.hook === "after");
  // One `after` dropped.
  assertDiscrepancyAt(
    injected(withAfter, (copy) => {
      const log = observerOf(copy);
      log.splice(
        log.findIndex((item) => item.hook === "after"),
        1,
      );
    }),
    ["traces", "observer"],
  );
  // A call-frame ID altered.
  assertDiscrepancyAt(
    injected(withAfter, (copy) => {
      observerOf(copy)[0]!.call += 1;
    }),
    ["traces", "observer", 0, "call"],
  );
});

test("-0 against 0 at a deep leaf is a discrepancy through the harness's writing", () => {
  const input = single("deep-signed-zero", DEEP_SOURCE, {
    seed: 1,
    globals: { hostValue: deepList(DEPTH) },
  });
  const report = injected(
    (_, at) => uninterrupted(at) && at.state === 0,
    (copy) => {
      deepLeaf(
        snapshotOf(copy).globals.find((item) => item.name === "hostValue")!.value,
        DEPTH,
      ).holder[0] = -0;
    },
    input,
  );
  const verdict = report.verdict;
  assert.equal(verdict.kind, "discrepancy");
  if (verdict.kind !== "discrepancy") return;
  assert.equal(verdict.mismatches.length, 1);
  const mismatch = verdict.mismatches[0]!;
  assert.deepEqual(mismatch.path.slice(0, 3), ["state", "snapshot", "globals"]);
  assert.equal(mismatch.path.length, 5 + 2 * DEPTH);
  assert.deepEqual(
    { oracle: mismatch.oracle, candidate: mismatch.candidate },
    { oracle: "0", candidate: "-0" },
  );
});

test("the shrinker reduces every positive integer literal above 1, also one that starts with 1", () => {
  const reduced = shrink("say 10, instant\nexit\n", (source) =>
    /^say \d+, instant\nexit\n$/u.test(source),
  );
  assert.equal(reduced.source, "say 1, instant\nexit\n");
});

/** This build with one session method of each fresh session throwing: a harness's own failure at that step. */
function throwingIn(method: "executeInstruction" | "exportTaggedSnapshot"): PipelineAdapter {
  const build = thisBuild("faulty");
  const fault = () => {
    throw new Error(`test-only ${method} fault`);
  };
  const fresh: typeof build.sessions.createFreshRuntimeSession = (...args) => {
    const session = build.sessions.createFreshRuntimeSession(...args);
    if (method === "executeInstruction") session.executeInstruction = fault;
    else session.exportTaggedSnapshot = fault;
    return session;
  };
  return { ...build, sessions: { ...build.sessions, createFreshRuntimeSession: fresh } };
}

/** This build whose debug context cannot start a restored epoch: a failure in a restore route's setup. */
function restoreSetupFault(): PipelineAdapter {
  const build = thisBuild("faulty");
  class Context extends build.sessions.RuntimeDebugContext {
    public override reset(origin: "start" | "restore"): void {
      if (origin === "restore") throw new Error("test-only restore setup fault");
      super.reset(origin);
    }
  }
  return { ...build, sessions: { ...build.sessions, RuntimeDebugContext: Context } };
}

/**
 * Each stage's own fault, with the side it is on and the class it must have: every stage passes through one boundary,
 * so its failure is reported as that stage's and that side's, never escapes, and never counts as a discrepancy.
 */
const STAGE_FAULTS: readonly {
  readonly stage: Stage;
  readonly side: "left" | "right";
  readonly options: () => Parameters<typeof differentialRun>[1];
}[] = [
  {
    stage: "compile",
    side: "right",
    options: () => ({
      right: {
        ...thisBuild("faulty"),
        compile: () => {
          throw new Error("test-only compile fault");
        },
      },
    }),
  },
  { stage: "probe", side: "left", options: () => ({ left: throwingIn("executeInstruction") }) },
  {
    stage: "host",
    side: "right",
    options: () => ({
      host: (side) => ({
        next: (view) => {
          if (side === "right") throw new Error("test-only host fault");
          const work = runtimeTimedWork(view);
          return work.length === 0
            ? null
            : { kind: "observeTime", nowMs: Math.min(...work.map((item) => item.deadlineMs)) };
        },
      }),
    }),
  },
  { stage: "step", side: "right", options: () => ({ right: throwingIn("executeInstruction") }) },
  {
    stage: "capture",
    side: "right",
    options: () => ({ right: throwingIn("exportTaggedSnapshot") }),
  },
  { stage: "restore", side: "right", options: () => ({ right: restoreSetupFault() }) },
  {
    stage: "write",
    side: "right",
    options: () => ({
      inject: (record, at) => {
        if (at.side === "right" && at.state === 1) throw new Error("test-only write fault");
        return record;
      },
    }),
  },
];

for (const { stage, side, options } of STAGE_FAULTS)
  test(`a fault at the ${stage} stage is that side's harness failure, never an escape or a discrepancy`, () => {
    const report = differentialRun(single("sensitivity", SENSITIVE, { seed: 5 }), {
      ...CUTS,
      ...options(),
    });
    assert.deepEqual(report.verdict, { kind: "not-compared", side, because: "harness-failure" });
    const outcome = report.outcomes[side];
    assert.equal(outcome?.kind === "harness-failure" ? outcome.stage : outcome?.kind, stage);
  });

test("a public restore call that throws is the engine's own behaviour, a discrepancy on that route", () => {
  const build = thisBuild("faulty");
  const report = differentialRun(single("sensitivity", SENSITIVE, { seed: 5 }), {
    ...CUTS,
    right: {
      ...build,
      sessions: {
        ...build.sessions,
        deserializeRuntimeSession: () => {
          throw new Error("test-only restore refusal");
        },
      },
    },
  });
  assert.equal(report.verdict.kind, "discrepancy");
  if (report.verdict.kind === "discrepancy")
    assert.equal(report.verdict.at.tail, "checkpoint-json");
});

/** The restore routes, listed here independently of the driver's own list. */
const ROUTES_TO_RESTORE = [
  "fork",
  "checked-snapshot",
  "trusted-snapshot",
  "tagged-snapshot",
  "checkpoint",
  "checkpoint-json",
] as const;

for (const route of ROUTES_TO_RESTORE)
  test(`a restored state that both sides corrupt alike on the ${route} route still differs from the uninterrupted run`, () => {
    const applied = new Set<string>();
    const report = differentialRun(single("sensitivity", SENSITIVE, { seed: 5 }), {
      ...CUTS,
      inject: (record, at) => {
        if (at.tail !== route || at.state !== at.cut || applied.has(at.side)) return record;
        applied.add(at.side);
        return changed(record, (copy) => {
          snapshotOf(copy).rng ^= 1;
        });
      },
    });
    assert.deepEqual([...applied].sort(), ["left", "right"]);
    const verdict = report.verdict;
    assert.equal(verdict.kind, "discrepancy", JSON.stringify(verdict));
    if (verdict.kind !== "discrepancy") return;
    assert.deepEqual(
      { tail: verdict.at.tail, against: verdict.at.against },
      { tail: route, against: "uninterrupted" },
    );
    assert.deepEqual(verdict.mismatches[0]!.path.slice(0, 3), ["state", "snapshot", "rng"]);
  });

interface Exits {
  exitStatus(reports: readonly Pick<DifferentialReport, "verdict">[]): number;
}
// EVIDENCE: validation: the CLI's exit module exports `exitStatus` of this shape.
const { exitStatus } = (await import(path.join(tools, "exit.mjs"))) as Exits;

test("the campaign CLI exits 0 identical, 1 differences, 2 usage or harness failure", () => {
  const verdict = (kind: string, because?: string) => ({
    // EVIDENCE: validation: each kind and reason given below is one of the verdicts the driver reports.
    verdict: (because === undefined
      ? { kind }
      : { kind, side: "right", because }) as DifferentialReport["verdict"],
  });
  assert.equal(
    exitStatus([verdict("equivalent"), verdict("not-compared", "unsupported-route")]),
    0,
  );
  assert.equal(exitStatus([verdict("equivalent"), verdict("discrepancy")]), 1);
  assert.equal(exitStatus([verdict("mapping-failure")]), 1);
  assert.equal(exitStatus([verdict("discrepancy"), verdict("not-compared", "harness-failure")]), 2);
  assert.equal(exitStatus([verdict("not-compared", "serializer-failure")]), 2);
  const cli = (...args: string[]) =>
    spawnSync(process.execPath, [path.join(tools, "run.mjs"), ...args], { encoding: "utf8" });
  for (const args of [
    ["--count", "1"],
    ["--seed", "1", "--count", "nonsense"],
    ["--seed", "1", "--from", "nope"],
    ["--seed", "1", "--count", "0"],
    ["--seed", "1", "--route", "other"],
  ])
    assert.equal(cli(...args).status, 2, args.join(" "));
  const ran = cli("--seed", "3", "--count", "1");
  assert.equal(ran.status, 0, ran.stderr);
  assert.equal(ran.stdout.trim().split("\n").length, 1);
});

test("a writing failure and an unanswered correspondence stay harness classifications, never discrepancies", () => {
  // A record the harness cannot write: a test-only value whose property throws when read.
  const throwing = injected(
    (_, at) => uninterrupted(at) && at.state === 1,
    (copy) => {
      Object.defineProperty(copy.state, "result", {
        enumerable: true,
        get: () => {
          throw new Error("test-only throwing value");
        },
      });
    },
  );
  assert.deepEqual(throwing.verdict, {
    kind: "not-compared",
    side: "right",
    because: "serializer-failure",
  });
  assert.equal(throwing.outcomes.right?.kind, "serializer-failure");

  // A correspondence that does not know the first instruction.
  // A run that ends exactly at the step limit completed; one step fewer is censored.
  const unlimited = differentialRun(single("sensitivity", SENSITIVE, { seed: 5 }), CUTS);
  const atLimit = differentialRun(single("sensitivity", SENSITIVE, { seed: 5 }), {
    ...CUTS,
    maxSteps: unlimited.steps,
  });
  assert.deepEqual(atLimit.outcomes.left, { kind: "completed" });
  assert.equal(atLimit.steps, unlimited.steps);
  const below = differentialRun(single("sensitivity", SENSITIVE, { seed: 5 }), {
    ...CUTS,
    maxSteps: unlimited.steps - 1,
  });
  assert.equal(below.outcomes.left?.kind, "censored");

  const unknown = differentialRun(single("sensitivity", SENSITIVE, { seed: 5 }), {
    ...CUTS,
    correspondence: {
      ...IDENTITY,
      identity: false,
      instruction: (index) => (index === 0 ? undefined : index),
    },
  });
  assert.equal(unknown.verdict.kind, "mapping-failure", JSON.stringify(unknown.verdict));
});

// The harness's cost on these pairs, for the pull request's record: it describes only, and never decides.
test.after(() => {
  const count = <T>(items: readonly T[], key: (item: T) => string) => {
    const counts: Record<string, number> = {};
    for (const item of items) counts[key(item)] = (counts[key(item)] ?? 0) + 1;
    return counts;
  };
  const summary = ROUTES.map((route) => {
    const items = reports.filter((report) => report.route === route);
    return {
      route,
      pairs: items.length,
      verdicts: count(items, (item) => item.verdict.kind),
      steps: items.reduce((sum, item) => sum + item.steps, 0),
      tailSteps: items.reduce((sum, item) => sum + item.tailSteps, 0),
      cpuMs: items.reduce((sum, item) => sum + item.cpuMs, 0),
    };
  });
  console.log(JSON.stringify({ differentialCost: summary }));
});
