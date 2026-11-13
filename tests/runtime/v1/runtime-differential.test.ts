import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { SWEEP } from "../../helpers/sweep.js";

import {
  compileSource,
  createFreshRuntimeSession,
  runtimeTimedWork,
  type FreshRuntimeOptions,
  type ProjectSourceFile,
  type RandomDecision,
  type RandomDrawView,
  type RuntimeDebugContext,
  type RuntimeSessionOptions,
  type RuntimeSession,
  type RuntimeSessionView,
  type SerializableRuntimeValue,
} from "../../../src/index.js";
import { Attribution } from "../../helpers/runtime/runtime-differential-side.js";
import {
  differentialRun,
  differentialRunOn,
  thisBuild,
  type DifferentialOptions,
  type DifferentialInput,
  type DifferentialReport,
  type HostDriver,
  type InjectionSite,
  type PipelineAdapter,
  type Route,
  type SideRecord,
  type Stage,
} from "../../helpers/runtime-differential.js";
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
} from "../../helpers/runtime-state-comparison.js";
import { withValidationTestStatistics } from "../../../src/validation-testing.js";

/*
 * The differential harness run against this build itself (docs/TESTING.md "Differential harness"): every retained
 * regression and a bounded seeded sample must be equivalent, every restore route included, and each control must fail
 * for its own reason at its own path.
 */

const checkout = fileURLToPath(new URL("../../../..", import.meta.url));
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

/** One pair as the suite runs it, at the CI cut cap, its report kept for the cost summary. */
function pair(input: DifferentialInput, options: DifferentialOptions = {}): DifferentialReport {
  const report = differentialRun(input, { ...CUTS, ...options });
  reports.push(report);
  return report;
}

test("every retained regression is equivalent on both routes and keeps its independent expectation", () => {
  for (const entry of regressions.entries) {
    const source = fs.readFileSync(path.join(tools, "regressions", `${entry.name}.tease`), "utf8");
    for (const seed of regressions.seeds) {
      const input = single(entry.name, source, {
        seed,
        ...(entry.globals ? { globals: entry.globals } : {}),
      });
      for (const route of ROUTES) {
        assertEquivalent(pair(input, { route }));
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
  const randomMode = (program: GeneratedProgram) =>
    program.tags.includes("rng")
      ? programs.filter((item) => item.tags.includes("rng")).indexOf(program) % 2 === 1
        ? "choose-natural"
        : "natural"
      : undefined;
  for (const program of programs) {
    // Random programs alternate between the harness's two decision modes, whose logs and receipts are compared.
    const random = randomMode(program);
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
      // A generated program the compiler rejects is classified, not patched in: both sides reject it alike.
      assertEquivalent(pair(input, { route }));
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
  const report = pair(input);
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

test("10,000-level host values that nest sets run, restore and compare, with no exact-key fallback", () => {
  // In CI lists, objects, dicts and sets in turn; on demand also a chain of two-member sets (about 26 s).
  const values: [string, SerializableRuntimeValue][] = [["deep-host-nest", mixedNest(DEPTH)]];
  if (process.env.FUZZ_ACCEPTANCE === "1")
    values.push(["deep-host-set-chain", deepSetChain(DEPTH)]);
  for (const [name, hostValue] of values) {
    const { report, counts } = withValidationTestStatistics((finish) => ({
      report: pair(single(name, DEEP_SOURCE, { seed: 1, globals: { hostValue } })),
      counts: finish().counts,
    }));
    assert.deepEqual(report.verdict, { kind: "equivalent" }, name);
    assert.deepEqual(report.outcomes.left, { kind: "completed" }, name);
    // Every validation printed the sets' members, and none fell back to a whole key.
    assert.ok((counts.setValidationPrints ?? 0) > 0, name);
    assert.equal(counts.setValidationExactKeys, undefined, name);
  }

  // A detached copy with the leaf inside the innermost set changed differs at that path only.
  const compiled = compileSource(DEEP_SOURCE, { globals: ["hostValue"] });
  const snapshot = createFreshRuntimeSession(compiled.plan!, {
    seed: 1,
    globals: { hostValue: mixedNest(DEPTH) },
  }).exportTrustedSnapshot();
  // EVIDENCE: validation: `canonicalText` writes JSON, which `JSON.parse` reads back as plain data.
  const copy = JSON.parse(canonicalText(snapshot)) as typeof snapshot;
  const index = copy.globals.findIndex((binding) => binding.name === "hostValue");
  const path: (string | number)[] = ["globals", index, "value"];
  let at = copy.globals[index]!.value;
  let replace = (_value: SerializableRuntimeValue): void => {};
  let sets = 0;
  // `mixedNest` holds one part at every level: a list's or set's item, an object's or dict's value.
  while (typeof at === "object" && at !== null) {
    const node = at;
    if (node.kind === "list" || node.kind === "set") {
      if (node.kind === "set") sets += 1;
      path.push("items", 0);
      replace = (value) => {
        node.items[0] = value;
      };
      at = node.items[0]!;
    } else if (node.kind === "object" || node.kind === "dict") {
      const part = node.kind === "object" ? node.properties[0]! : node.entries[0]!;
      path.push(node.kind === "object" ? "properties" : "entries", 0, "value");
      replace = (value) => {
        part.value = value;
      };
      at = part.value;
    } else break;
  }
  assert.equal(sets, DEPTH / 4);
  replace(1);
  const comparison = compareStructures(snapshot, copy);
  assert.equal(comparison.mismatches.length, 1);
  assert.deepEqual(comparison.mismatches[0], { path, oracle: "0", candidate: "1" });
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
  const hosted = pair(input, { host: () => choosingHost(1) });
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
  const stored = pair(input, { host: () => storingHost() });
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
  options: DifferentialOptions = {},
): DifferentialReport {
  let applied = false;
  const report = differentialRun(input, {
    ...CUTS,
    ...options,
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

/*
 * The injected-fault family: faults placed on a side's own objects, independent of the driver's attribution. A fixture
 * adapter counts each use of each member of the objects it hands out (the adapter, its sessions functions, the sessions
 * and debug contexts they make, and a host) by side, origin, member and kind (`access` of the member, `invocation` of
 * it, or its `result`), and throws at one chosen use. The rows are every counted use, at its first and its last
 * occurrence, and the oracle decides from the row alone.
 */

type SideName = "left" | "right";
type FaultKind = "access" | "invocation" | "result";
interface Placement {
  readonly side: SideName;
  /** `adapter`, `sessions`, `context`, `host`, or the call that made the session: `fresh`, `fork`, or a restore call. */
  readonly origin: string;
  readonly member: string;
  readonly kind: FaultKind;
}
interface Fault extends Placement {
  readonly occurrence: number;
}

const keyOf = (placement: Placement) =>
  `${placement.side} ${placement.origin} ${placement.member} ${placement.kind}`;

const SESSION_MEMBERS = [
  "view",
  "executeInstruction",
  "observeTime",
  "exportTrustedSnapshot",
  "exportCheckpoint",
  "exportSnapshot",
  "exportTaggedSnapshot",
  "fork",
] as const;
/** The session members whose returned object the harness reads, and the field a result fault throws at. */
const RESULT_MEMBERS = new Set(["view", "executeInstruction"]);

/**
 * A callable as the fixture hands it out: it refuses a call without its own `receiver`, and any read of its `call`,
 * `apply` or `bind`, so that the driver's one `invoke` is shown to keep receivers and to read nothing of a callable.
 */
function strict<A extends unknown[], T>(
  receiver: RuntimeSession | PipelineAdapter | PipelineAdapter["sessions"] | HostDriver,
  body: (...args: A) => T,
): (...args: A) => T {
  const callable = function (this: unknown, ...args: A): T {
    if (this !== receiver) throw new Error("test-only: a callable was called without its receiver");
    return body(...args);
  };
  for (const key of ["call", "apply", "bind"])
    Object.defineProperty(callable, key, {
      get: () => {
        throw new Error(`test-only: the driver read ${key} of a callable`);
      },
    });
  return callable;
}

/** This build, its objects counting each use and throwing at `fault`'s. */
class Fixture {
  public readonly counts = new Map<string, number>();
  public fired = 0;

  public constructor(private readonly fault: Fault | null) {}

  /** Counts one use, and says whether it is the fault's. */
  public tick(placement: Placement): boolean {
    const key = keyOf(placement);
    const count = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, count);
    const fires =
      this.fault !== null && keyOf(this.fault) === key && this.fault.occurrence === count;
    if (fires) this.fired += 1;
    return fires;
  }

  /** Counts one use, and throws when it is the fault's. */
  public use(side: SideName, origin: string, member: string, kind: FaultKind): void {
    if (this.tick({ side, origin, member, kind }))
      throw new Error(`test-only fault at ${keyOf({ side, origin, member, kind })}`);
  }

  /** A returned object, or one whose every read throws when this use is the fault's. */
  public result<T extends object>(side: SideName, origin: string, member: string, value: T): T {
    if (!this.tick({ side, origin, member, kind: "result" })) return value;
    return new Proxy(value, {
      get: () => {
        throw new Error(`test-only fault at ${side} ${origin} ${member} result`);
      },
    });
  }

  /** A session of `side` made by `origin`, its members counted on the instance itself, its receiver kept. */
  public session(side: SideName, origin: string, session: RuntimeSession): RuntimeSession {
    // EVIDENCE: validation: the session's prototype is the engine's `RuntimeSession` class, whose methods these are.
    const prototype = Object.getPrototypeOf(session) as Record<
      string,
      (...args: unknown[]) => object
    >;
    for (const member of SESSION_MEMBERS) {
      const method = prototype[member]!;
      Object.defineProperty(session, member, {
        configurable: true,
        get: () => {
          this.use(side, origin, member, "access");
          return strict(session, (...args: unknown[]) => {
            this.use(side, origin, member, "invocation");
            const value = method.call(session, ...args);
            if (member === "fork")
              // EVIDENCE: validation: `fork` returns a session of the same engine.
              return this.session(side, "fork", value as RuntimeSession);
            return RESULT_MEMBERS.has(member) ? this.result(side, origin, member, value) : value;
          });
        },
      });
    }
    return session;
  }

  /** This build's adapter for `side`, every object it hands out counted. */
  public adapter(side: SideName): PipelineAdapter {
    const build = thisBuild(side);
    const real = build.sessions;
    // oxlint-disable-next-line typescript/no-this-alias -- EVIDENCE: fixture: the adapter's getters and methods, whose own `this` is the adapter, reach the fixture through it.
    const fixture = this;
    const use = (origin: string, member: string, kind: FaultKind) =>
      fixture.use(side, origin, member, kind);
    class Context extends real.RuntimeDebugContext {
      public override reset(origin: "start" | "restore"): void {
        use("context", "reset", "invocation");
        super.reset(origin);
      }
      public override status(): ReturnType<RuntimeDebugContext["status"]> {
        use("context", "status", "invocation");
        return super.status();
      }
      public override record(id: number): ReturnType<RuntimeDebugContext["record"]> {
        use("context", "record", "invocation");
        return super.record(id);
      }
    }
    const sessions: PipelineAdapter["sessions"] = {
      get createFreshRuntimeSession() {
        use("sessions", "createFreshRuntimeSession", "access");
        return strict(sessions, (...args: Parameters<typeof real.createFreshRuntimeSession>) => {
          use("sessions", "createFreshRuntimeSession", "invocation");
          return fixture.session(side, "fresh", real.createFreshRuntimeSession(...args));
        });
      },
      get createRuntimeSession() {
        use("sessions", "createRuntimeSession", "access");
        return strict(sessions, (...args: Parameters<typeof real.createRuntimeSession>) => {
          use("sessions", "createRuntimeSession", "invocation");
          return fixture.session(side, "createRuntimeSession", real.createRuntimeSession(...args));
        });
      },
      get createTaggedRuntimeSession() {
        use("sessions", "createTaggedRuntimeSession", "access");
        return strict(sessions, (...args: Parameters<typeof real.createTaggedRuntimeSession>) => {
          use("sessions", "createTaggedRuntimeSession", "invocation");
          return fixture.session(
            side,
            "createTaggedRuntimeSession",
            real.createTaggedRuntimeSession(...args),
          );
        });
      },
      get restoreRuntimeSession() {
        use("sessions", "restoreRuntimeSession", "access");
        return strict(sessions, (...args: Parameters<typeof real.restoreRuntimeSession>) => {
          use("sessions", "restoreRuntimeSession", "invocation");
          return fixture.session(
            side,
            "restoreRuntimeSession",
            real.restoreRuntimeSession(...args),
          );
        });
      },
      get deserializeRuntimeSession() {
        use("sessions", "deserializeRuntimeSession", "access");
        return strict(sessions, (...args: Parameters<typeof real.deserializeRuntimeSession>) => {
          use("sessions", "deserializeRuntimeSession", "invocation");
          return fixture.session(
            side,
            "deserializeRuntimeSession",
            real.deserializeRuntimeSession(...args),
          );
        });
      },
      get serializeCheckpoint() {
        use("sessions", "serializeCheckpoint", "access");
        return strict(sessions, (...args: Parameters<typeof real.serializeCheckpoint>) => {
          use("sessions", "serializeCheckpoint", "invocation");
          return real.serializeCheckpoint(...args);
        });
      },
      get runtimeTimedWork() {
        use("sessions", "runtimeTimedWork", "access");
        return strict(sessions, (...args: Parameters<typeof real.runtimeTimedWork>) => {
          use("sessions", "runtimeTimedWork", "invocation");
          return real.runtimeTimedWork(...args);
        });
      },
      get RuntimeDebugContext() {
        use("sessions", "RuntimeDebugContext", "access");
        return Context;
      },
    };
    const adapter: PipelineAdapter = {
      label: side,
      get compile() {
        use("adapter", "compile", "access");
        return strict(adapter, (input: DifferentialInput, route: Route) => {
          use("adapter", "compile", "invocation");
          return build.compile(input, route);
        });
      },
      get sessions() {
        use("adapter", "sessions", "access");
        return sessions;
      },
    };
    return adapter;
  }

  /** A host that observes each delay's deadline, its factory, `next` and returned calls counted. */
  public host(side: SideName): HostDriver {
    // oxlint-disable-next-line typescript/no-this-alias -- EVIDENCE: fixture: the host's `next` getter, whose own `this` is the host, reaches the fixture through it.
    const fixture = this;
    fixture.use(side, "host", "factory", "invocation");
    const host: HostDriver = {
      get next() {
        fixture.use(side, "host", "next", "access");
        return strict(host, (view: RuntimeSessionView) => {
          fixture.use(side, "host", "next", "invocation");
          const work = runtimeTimedWork(view);
          if (work.length === 0) return null;
          return fixture.result(side, "host", "next", {
            kind: "observeTime" as const,
            nowMs: Math.min(...work.map((item) => item.deadlineMs)),
          });
        });
      },
    };
    return host;
  }
}

const FAULT_INPUT = single("sensitivity", SENSITIVE, { seed: 5 });

/** Runs the fault input with a fixture on both sides, and a fixture host when `hosted`. */
function faulted(fixture: Fixture, hosted: boolean): DifferentialReport {
  return differentialRun(FAULT_INPUT, {
    ...CUTS,
    left: fixture.adapter("left"),
    right: fixture.adapter("right"),
    ...(hosted ? { host: (side: SideName) => fixture.host(side) } : {}),
  });
}

/** The clean runs' verdicts, which the inventory test requires to be `equivalent`. */
const CLEAN_VERDICTS: DifferentialReport["verdict"][] = [];

/** The fault rows: every use the clean runs count, at its first and last occurrence, and whether it needs the host. */
const FAULT_ROWS = (() => {
  const rows: { readonly fault: Fault; readonly hosted: boolean }[] = [];
  for (const hosted of [false, true]) {
    const clean = new Fixture(null);
    CLEAN_VERDICTS.push(faulted(clean, hosted).verdict);
    for (const [key, count] of clean.counts) {
      // EVIDENCE: validation: `keyOf` joins a side, an origin, a member and a kind, none of which has a space.
      const [side, origin, member, kind] = key.split(" ") as [SideName, string, string, FaultKind];
      // The host's own uses come from the hosted run; every other use from the run without a host.
      if ((origin === "host") !== hosted) continue;
      for (const occurrence of new Set([1, count]))
        rows.push({ fault: { side, origin, member, kind, occurrence }, hosted });
    }
  }
  return rows;
})();

/** The members the family must reach on each side, from the public adapter, session, context and host APIs. */
const INVENTORY: readonly Omit<Placement, "side">[] = [
  { origin: "adapter", member: "compile", kind: "access" },
  { origin: "adapter", member: "compile", kind: "invocation" },
  { origin: "adapter", member: "sessions", kind: "access" },
  ...[
    "createFreshRuntimeSession",
    "createRuntimeSession",
    "createTaggedRuntimeSession",
    "restoreRuntimeSession",
    "deserializeRuntimeSession",
    "serializeCheckpoint",
    "runtimeTimedWork",
  ].flatMap((member) =>
    (["access", "invocation"] as const).map((kind) => ({ origin: "sessions", member, kind })),
  ),
  { origin: "sessions", member: "RuntimeDebugContext", kind: "access" },
  ...["reset", "status", "record"].map((member) => ({
    origin: "context",
    member,
    kind: "invocation" as const,
  })),
  ...SESSION_MEMBERS.flatMap((member) =>
    (["access", "invocation"] as const).map((kind) => ({ origin: "fresh", member, kind })),
  ),
  ...[
    "fork",
    "createRuntimeSession",
    "createTaggedRuntimeSession",
    "restoreRuntimeSession",
    "deserializeRuntimeSession",
  ].flatMap((origin) =>
    ["view", "executeInstruction", "observeTime", "exportTrustedSnapshot"].flatMap((member) =>
      (["access", "invocation"] as const).map((kind) => ({ origin, member, kind })),
    ),
  ),
  ...[
    "fresh",
    "fork",
    "createRuntimeSession",
    "createTaggedRuntimeSession",
    "restoreRuntimeSession",
    "deserializeRuntimeSession",
  ].flatMap((origin) =>
    [...RESULT_MEMBERS].map((member) => ({ origin, member, kind: "result" as const })),
  ),
  { origin: "host", member: "factory", kind: "invocation" },
  { origin: "host", member: "next", kind: "access" },
  { origin: "host", member: "next", kind: "invocation" },
  { origin: "host", member: "next", kind: "result" },
];

/** The restore routes each public restore invocation serves; its own exception is that route's restored state. */
const ENGINE_INVOCATIONS: Readonly<Record<string, readonly string[] | "admission">> = {
  "sessions createFreshRuntimeSession": "admission",
  "sessions createRuntimeSession": ["checked-snapshot", "trusted-snapshot"],
  "sessions createTaggedRuntimeSession": ["tagged-snapshot"],
  "sessions restoreRuntimeSession": ["checkpoint"],
  "sessions deserializeRuntimeSession": ["checkpoint-json"],
  "fresh fork": ["fork"],
};

const RESTORE_ORIGINS = new Set([
  "fork",
  "createRuntimeSession",
  "createTaggedRuntimeSession",
  "restoreRuntimeSession",
  "deserializeRuntimeSession",
]);

/**
 * The independent oracle, from the row alone: a public engine invocation is the engine's own behaviour (a fresh
 * session's admission refused, or a discrepancy on its restore route); any other fault is that side's harness failure,
 * named by the member the driver reports and in a stage where that member is used.
 */
function expectation(
  fault: Fault,
):
  | { readonly kind: "admission-rejected" }
  | { readonly kind: "discrepancy"; readonly routes: readonly string[] }
  | {
      readonly kind: "harness-failure";
      readonly member: string;
      readonly stages: readonly Stage[];
    } {
  const engine =
    fault.kind === "invocation" ? ENGINE_INVOCATIONS[`${fault.origin} ${fault.member}`] : undefined;
  if (engine === "admission") return { kind: "admission-rejected" };
  if (engine !== undefined) return { kind: "discrepancy", routes: engine };
  const { origin, member } = fault;
  if (origin === "adapter")
    return member === "compile"
      ? { kind: "harness-failure", member: "compile", stages: ["compile"] }
      : {
          kind: "harness-failure",
          member: "sessions",
          stages: ["probe", "setup", "step", "capture", "restore"],
        };
  if (origin === "sessions") {
    const stages: Readonly<Record<string, readonly Stage[]>> = {
      createFreshRuntimeSession: ["probe", "setup"],
      serializeCheckpoint: ["capture"],
      runtimeTimedWork: ["probe", "step"],
      RuntimeDebugContext: ["setup", "restore"],
    };
    return { kind: "harness-failure", member, stages: stages[member] ?? ["restore"] };
  }
  if (origin === "context")
    return {
      kind: "harness-failure",
      member: `RuntimeDebugContext.${member}`,
      stages: ["setup", "opening", "step", "restore"],
    };
  if (origin === "host")
    return member === "factory"
      ? { kind: "harness-failure", member: "host", stages: ["probe", "setup"] }
      : { kind: "harness-failure", member: "host.next", stages: ["probe", "step"] };
  if (RESTORE_ORIGINS.has(origin))
    return { kind: "harness-failure", member: `RuntimeSession.${member}`, stages: ["restore"] };
  const fresh: Readonly<Record<string, readonly Stage[]>> = {
    view: ["probe", "step"],
    executeInstruction: ["probe", "step"],
    observeTime: ["probe", "step"],
    exportTrustedSnapshot: ["opening", "step"],
  };
  return {
    kind: "harness-failure",
    member: `RuntimeSession.${member}`,
    stages: fresh[member] ?? ["capture"],
  };
}

test("the injected-fault family reaches every member of the public APIs on both sides", () => {
  // Every callable the fixture hands out refuses a call without its receiver and a read of its own members, so these
  // clean runs show that every call into a side keeps its receiver and reads nothing of the callable.
  assert.deepEqual(CLEAN_VERDICTS, [{ kind: "equivalent" }, { kind: "equivalent" }]);
  const counted = new Set(FAULT_ROWS.map((row) => keyOf(row.fault)));
  for (const side of ["left", "right"] as const)
    for (const placement of INVENTORY)
      assert.ok(counted.has(keyOf({ side, ...placement })), keyOf({ side, ...placement }));
  // Each public engine invocation is faulted, `fork` at a restore point included.
  for (const engine of Object.keys(ENGINE_INVOCATIONS))
    assert.ok(
      FAULT_ROWS.some(
        (row) =>
          `${row.fault.origin} ${row.fault.member}` === engine && row.fault.kind === "invocation",
      ),
      engine,
    );
});

for (const { fault, hosted } of FAULT_ROWS)
  test(`fault/side=${fault.side}/origin=${fault.origin}/member=${fault.member}/kind=${fault.kind}/occurrence=${fault.occurrence}`, () => {
    const fixture = new Fixture(fault);
    const report = faulted(fixture, hosted);
    assert.equal(fixture.fired, 1, "the fault fired once");
    const expected = expectation(fault);
    const verdict = report.verdict;
    if (expected.kind === "discrepancy") {
      assert.equal(verdict.kind, "discrepancy", JSON.stringify(verdict));
      if (verdict.kind === "discrepancy")
        assert.ok(expected.routes.includes(verdict.at.tail), verdict.at.tail);
      return;
    }
    assert.deepEqual(verdict, { kind: "not-compared", side: fault.side, because: expected.kind });
    if (expected.kind !== "harness-failure") return;
    const outcome = report.outcomes[fault.side];
    assert.equal(outcome?.kind, "harness-failure");
    if (outcome?.kind !== "harness-failure") return;
    assert.equal(outcome.member, expected.member);
    assert.ok(
      expected.stages.includes(outcome.stage),
      `${outcome.stage} of ${expected.stages.join(", ")}`,
    );
  });

test("a callback failure the engine swallows is still that side's harness failure, never equivalent", () => {
  // The right side's engine calls the harness's decision callback with a draw it cannot read, and swallows the throw.
  const build = thisBuild("right");
  const right: PipelineAdapter = {
    ...build,
    sessions: {
      ...build.sessions,
      createFreshRuntimeSession: (plan, fresh, options) => {
        const session = build.sessions.createFreshRuntimeSession(plan, fresh, options);
        const decide = options?.randomControl?.decide;
        const execute = session.executeInstruction.bind(session);
        session.executeInstruction = (traced) => {
          try {
            decide?.(
              // EVIDENCE: validation: a test-only draw whose every read throws, as an engine bug might hand one over.
              new Proxy(
                {},
                {
                  get: () => {
                    throw new Error("test-only unreadable draw");
                  },
                },
              ) as RandomDrawView,
            );
          } catch {
            // The engine swallows it.
          }
          return execute(traced);
        };
        return session;
      },
    },
  };
  const report = differentialRun({ ...FAULT_INPUT, random: "natural" }, { ...CUTS, right });
  assert.deepEqual(report.verdict, {
    kind: "not-compared",
    side: "right",
    because: "harness-failure",
  });
  const outcome = report.outcomes.right;
  assert.equal(
    outcome?.kind === "harness-failure" ? outcome.member : outcome?.kind,
    "decision.decide",
  );
});

test("a callback failure inside a public restore call is the side's harness failure, never a restore that threw", () => {
  // The right side's restore asks the harness's decision callback about a draw it cannot read, and swallows the throw.
  const build = thisBuild("right");
  const right: PipelineAdapter = {
    ...build,
    sessions: {
      ...build.sessions,
      createRuntimeSession: (plan, snapshot, options) => {
        try {
          options?.randomControl?.decide?.(
            // EVIDENCE: validation: a test-only draw whose every read throws, as an engine bug might hand one over.
            new Proxy(
              {},
              {
                get: () => {
                  throw new Error("test-only unreadable draw");
                },
              },
            ) as RandomDrawView,
          );
        } catch {
          // The engine swallows it.
        }
        return build.sessions.createRuntimeSession(plan, snapshot, options);
      },
    },
  };
  const report = differentialRun({ ...FAULT_INPUT, random: "natural" }, { ...CUTS, right });
  assert.deepEqual(report.verdict, {
    kind: "not-compared",
    side: "right",
    because: "harness-failure",
  });
  const outcome = report.outcomes.right;
  assert.deepEqual(
    outcome?.kind === "harness-failure" ? [outcome.member, outcome.stage] : outcome,
    ["decision.decide", "restore"],
  );
});

/** A test-only draw whose every read throws, as an engine bug might hand one over. */
const unreadableDraw = (): RandomDrawView =>
  // EVIDENCE: validation: the proxy stands in for a draw; the harness's decision callback reads it and fails.
  new Proxy(
    {},
    {
      get: () => {
        throw new Error("test-only unreadable draw");
      },
    },
  ) as RandomDrawView;

type Decide = (draw: RandomDrawView) => RandomDecision;

/** Calls `decide` with an unreadable draw and swallows what it throws, as a buggy engine might. */
const swallow = (decide: Decide) => {
  try {
    decide(unreadableDraw());
  } catch {
    // Swallowed.
  }
};

/**
 * This build on the right side, the `view` of its fresh sessions (or of the sessions its checkpoint JSON restores)
 * replaced by `view`, given the real view and the harness's decision callback.
 */
function rightWithView(
  view: (real: RuntimeSessionView, decide: Decide) => RuntimeSessionView,
  origin: "fresh" | "deserialize" = "fresh",
): PipelineAdapter {
  const build = thisBuild("right");
  const wrap = (session: RuntimeSession, decide: Decide) => {
    const real = session.view.bind(session);
    session.view = () => view(real(), decide);
    return session;
  };
  const decideOf = (options?: RuntimeSessionOptions): Decide =>
    options?.randomControl?.decide ?? ((): RandomDecision => ({ kind: "natural" }));
  const sessions: PipelineAdapter["sessions"] =
    origin === "fresh"
      ? {
          ...build.sessions,
          createFreshRuntimeSession: (plan, fresh, options) =>
            wrap(build.sessions.createFreshRuntimeSession(plan, fresh, options), decideOf(options)),
        }
      : {
          ...build.sessions,
          deserializeRuntimeSession: (json, options) =>
            wrap(build.sessions.deserializeRuntimeSession(json, options), decideOf(options)),
        };
  return { ...build, sessions };
}

test("a callback failure swallowed while a returned view is read is the side's harness failure, never a discrepancy", () => {
  // The right side's terminal view says it failed, and its `status` read swallows a decision-callback failure.
  const right = rightWithView((real, decide) => {
    if (real.status !== "halted") return real;
    return {
      ...real,
      get status() {
        swallow(decide);
        return "failed" as const;
      },
    };
  });
  const report = differentialRun({ ...FAULT_INPUT, random: "natural" }, { ...CUTS, right });
  assert.deepEqual(report.verdict, {
    kind: "not-compared",
    side: "right",
    because: "harness-failure",
  });
  const outcome = report.outcomes.right;
  assert.equal(
    outcome?.kind === "harness-failure" ? outcome.member : outcome?.kind,
    "decision.decide",
  );
});

test("a callback failure swallowed during a comparison takes priority over the discrepancy it is compared into", () => {
  // The right side's first emitted event reads differently from the left's, and its second read, during comparison
  // and outside any operation, swallows a decision-callback failure.
  const build = thisBuild("right");
  let changed = false;
  const right: PipelineAdapter = {
    ...build,
    sessions: {
      ...build.sessions,
      createFreshRuntimeSession: (plan, fresh, options) => {
        const session = build.sessions.createFreshRuntimeSession(plan, fresh, options);
        const decide: Decide =
          options?.randomControl?.decide ?? ((): RandomDecision => ({ kind: "natural" }));
        const execute = session.executeInstruction.bind(session);
        session.executeInstruction = (traced) => {
          const result = execute(traced);
          if (changed || result.events.length === 0) return result;
          changed = true;
          const event = { ...result.events[0]! };
          let reads = 0;
          Object.defineProperty(event, "text", {
            enumerable: true,
            get: () => {
              reads += 1;
              if (reads === 2) swallow(decide);
              return "changed";
            },
          });
          // EVIDENCE: validation: a test-only result whose first event is a changed copy of the engine's own.
          return { ...result, events: [event, ...result.events.slice(1)] } as typeof result;
        };
        return session;
      },
    },
  };
  const report = differentialRun({ ...FAULT_INPUT, random: "natural" }, { ...CUTS, right });
  assert.equal(changed, true);
  assert.deepEqual(report.verdict, {
    kind: "not-compared",
    side: "right",
    because: "harness-failure",
  });
  const outcome = report.outcomes.right;
  assert.equal(
    outcome?.kind === "harness-failure" ? outcome.member : outcome?.kind,
    "decision.decide",
  );
});

test("a callback failure in the last restore of a run is the side's harness failure, never equivalent", () => {
  // One cut, so the checkpoint JSON route's restored session is the run's last; its terminal view swallows a failure.
  const right = rightWithView((real, decide) => {
    if (real.status === "halted") swallow(decide);
    return real;
  }, "deserialize");
  const report = differentialRun(
    { ...single("exit", "exit\n", { seed: 5 }), random: "natural" },
    { ...CUTS, right },
  );
  assert.deepEqual(report.cuts, [0]);
  assert.deepEqual(report.verdict, {
    kind: "not-compared",
    side: "right",
    because: "harness-failure",
  });
  const outcome = report.outcomes.right;
  assert.deepEqual(
    outcome?.kind === "harness-failure" ? [outcome.member, outcome.stage] : outcome,
    ["decision.decide", "restore"],
  );
});

test("a callback failure swallowed while the report itself is built takes priority over its verdict", () => {
  // The input's name, which only the report reads, swallows a failure of the right side's decision callback.
  let decide: Decide | null = null;
  const build = thisBuild("right");
  const right: PipelineAdapter = {
    ...build,
    sessions: {
      ...build.sessions,
      createFreshRuntimeSession: (plan, fresh, options) => {
        decide = options?.randomControl?.decide ?? null;
        return build.sessions.createFreshRuntimeSession(plan, fresh, options);
      },
    },
  };
  const named = (): DifferentialInput => ({
    ...single("exit", "exit\n", { seed: 5 }),
    random: "natural",
    get name() {
      if (decide !== null) swallow(decide);
      return "exit";
    },
  });
  // Both an equal pair and one that differs (through an injection) report the swallowed failure instead.
  for (const inject of [
    undefined,
    (record: SideRecord, at: InjectionSite) =>
      at.side === "right" && at.state === 0
        ? changed(record, (copy) => (snapshotOf(copy).rng ^= 1))
        : record,
  ]) {
    decide = null;
    const report = differentialRun(named(), {
      ...CUTS,
      right,
      ...(inject === undefined ? {} : { inject }),
    });
    assert.deepEqual(report.verdict, {
      kind: "not-compared",
      side: "right",
      because: "harness-failure",
    });
    const outcome = report.outcomes.right;
    assert.equal(
      outcome?.kind === "harness-failure" ? outcome.member : outcome?.kind,
      "decision.decide",
    );
  }
});

test("a throwing injection is that side's harness failure at the injection", () => {
  const report = differentialRun(FAULT_INPUT, {
    ...CUTS,
    inject: (record, at) => {
      if (at.side === "right" && at.state === 1) throw new Error("test-only injection fault");
      return record;
    },
  });
  assert.deepEqual(report.verdict, {
    kind: "not-compared",
    side: "right",
    because: "harness-failure",
  });
  const outcome = report.outcomes.right;
  assert.equal(outcome?.kind === "harness-failure" ? outcome.member : outcome?.kind, "inject");
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
  verdictCounts(reports: readonly Pick<DifferentialReport, "verdict">[]): Record<string, number>;
}
// EVIDENCE: validation: the CLI's exit module exports `exitStatus` and `verdictCounts` of this shape.
const { exitStatus, verdictCounts } = (await import(path.join(tools, "exit.mjs"))) as Exits;

test("the campaign CLI's decision: 0 identity, an unsupported route or censored, 1 a difference, 2 a failure", () => {
  const verdict = (kind: string, because?: string) => ({
    // EVIDENCE: validation: each kind and reason given below is a verdict the decision must handle, a made-up one included.
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
  // Censored is equal up to the step limit, a sampling bound; a one-sided rejection is a difference between builds.
  assert.equal(exitStatus([verdict("not-compared", "censored")]), 0);
  assert.equal(exitStatus([verdict("not-compared", "compile-rejected")]), 1);
  assert.equal(exitStatus([verdict("not-compared", "admission-rejected")]), 1);
  assert.equal(exitStatus([verdict("not-compared", "admission-rejected"), verdict("surprise")]), 2);
  assert.equal(exitStatus([verdict("surprise")]), 2);
  // The summary counts an unsupported route by the side the verdict names, so a refusal on one side alone shows.
  const refused = (side: "left" | "right") => ({
    verdict: { kind: "not-compared", side, because: "unsupported-route" } as const,
  });
  assert.deepEqual(
    verdictCounts([
      refused("left"),
      refused("right"),
      refused("right"),
      verdict("not-compared", "censored"),
    ]),
    {
      "not-compared:unsupported-route:left": 1,
      "not-compared:unsupported-route:right": 2,
      "not-compared:censored": 1,
    },
  );
});

/**
 * A test-only harness build for the CLI (through `RUNTIME_DIFFERENTIAL_DIST`, which only this test sets): it marks the
 * phases it is used in, outside the CLI's own failure handling (`L` when it loads, `R` when it runs), and then behaves
 * as its mode says.
 */
const CLI_FIXTURE = `import fs from "node:fs";
const mark = (letter) => fs.appendFileSync(process.env.CLI_MARKS, letter);
const mode = process.env.CLI_MODE;
mark("L");
if (mode === "load") throw new Error("test-only load fault");
const verdicts = {
  identity: { kind: "equivalent" },
  difference: { kind: "discrepancy", at: { tail: "uninterrupted", cut: null, state: 0, against: "other-side" }, mismatches: [] },
  unknown: { kind: "surprise" },
  censored: { kind: "not-compared", side: "left", because: "censored" },
  "one-sided": { kind: "not-compared", side: "right", because: "compile-rejected" },
};
export function differentialRun(input, options) {
  mark("R");
  if (mode === "run") throw new Error("test-only run fault");
  if (mode === "late") queueMicrotask(() => Promise.reject(new Error("test-only late rejection")));
  if (mode === "exit") process.on("exit", () => { throw new Error("test-only exit-time throw"); });
  if (mode === "uncaught") queueMicrotask(() => { throw new Error("test-only uncaught exception"); });
  if (mode === "finish") process.stdout.once("finish", () => Promise.reject(new Error("test-only rejection at finish")));
  if (mode === "stderr-finish") process.stderr.once("finish", () => Promise.reject(new Error("test-only rejection at the summary's finish")));
  if (mode === "before-exit") process.once("beforeExit", () => { throw new Error("test-only throw before exit"); });
  // A stream whose end never completes: the run never reaches its decision.
  if (mode === "stdout-incomplete") process.stdout.end = function () { return this; };
  if (mode === "stderr-incomplete") process.stderr.end = function () { return this; };
  return { name: input.name, route: options.route, outcomes: { left: null, right: null }, verdict: verdicts[mode] ?? verdicts.identity, plans: { left: null, right: null }, steps: 0, cuts: [], cutsOverCap: false, tailSteps: 0, cpuMs: 0 };
}
`;

test("the campaign CLI runs its phases in order, and any phase's failure exits 2 with no later phase run", () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-differential-cli-"));
  try {
    fs.writeFileSync(path.join(work, "runtime-differential.js"), CLI_FIXTURE);
    fs.writeFileSync(
      path.join(work, "runtime-state-comparison.js"),
      'export const canonicalDigest = () => "digest";\nexport const renderPath = () => "$";\n',
    );
    const cli = (
      mode: string,
      args: readonly string[],
      full: "stdout" | "stderr" | null = null,
    ) => {
      const marks = path.join(work, `marks-${mode}-${full}`);
      fs.writeFileSync(marks, "");
      const sink = full === null ? null : fs.openSync("/dev/full", "w");
      try {
        const ran = spawnSync(process.execPath, [path.join(tools, "run.mjs"), ...args], {
          encoding: "utf8",
          env: {
            ...process.env,
            RUNTIME_DIFFERENTIAL_DIST: work,
            CLI_MODE: mode,
            CLI_MARKS: marks,
          },
          stdio: [
            "ignore",
            full === "stdout" && sink !== null ? sink : "pipe",
            full === "stderr" && sink !== null ? sink : "pipe",
          ],
        });
        return {
          status: ran.status,
          stdout: ran.stdout ?? "",
          stderr: ran.stderr,
          marks: fs.readFileSync(marks, "utf8"),
        };
      } finally {
        if (sink !== null) fs.closeSync(sink);
      }
    };
    const args = ["--seed", "3", "--count", "1"];
    // One fault per phase: usage, load, run, output, decide.
    const usage = cli("identity", ["--seed", "3", "--count", "nonsense"]);
    assert.deepEqual([usage.status, usage.marks], [2, ""]);
    assert.match(usage.stderr, /--count must be a whole number/u);
    assert.deepEqual([cli("load", args).status, cli("load", args).marks], [2, "L"]);
    assert.deepEqual([cli("run", args).status, cli("run", args).marks], [2, "LR"]);
    // Output: either stream failing is a failed output, and the decision waits for both.
    for (const stream of ["stdout", "stderr"] as const) {
      const output = cli("identity", args, stream);
      assert.deepEqual([output.status, output.marks], [2, "LR"], stream);
    }
    const decide = cli("unknown", args);
    assert.deepEqual([decide.status, decide.marks], [2, "LR"]);
    assert.equal(decide.stdout.trim().split("\n").length, 1, "the decision comes after the output");
    // Controls, and failures after the run: a late rejection and an exit-time throw.
    assert.equal(cli("identity", args).status, 0);
    assert.equal(cli("difference", args).status, 1);
    const censored = cli("censored", args);
    assert.equal(censored.status, 0);
    assert.match(
      censored.stderr,
      /"not-compared:censored":1/u,
      "the summary counts the censored pair",
    );
    assert.equal(cli("one-sided", args).status, 1);
    assert.equal(cli("late", args).status, 2);
    assert.equal(cli("exit", args).status, 2);
    assert.equal(cli("uncaught", args).status, 2);
    assert.equal(cli("finish", args).status, 2, "a rejection raised when stdout finishes");
    // After the decision: the process ends on its own, so what is still pending reaches the handlers.
    assert.equal(
      cli("stderr-finish", args).status,
      2,
      "a rejection raised when the summary finishes",
    );
    assert.equal(cli("before-exit", args).status, 2, "a throw as the process is about to exit");
    // A stream that never finishes: the run ends without a decision, which fails closed.
    for (const mode of ["stdout-incomplete", "stderr-incomplete"])
      assert.equal(cli(mode, args).status, 2, mode);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
  // The real build, end to end.
  const ran = spawnSync(
    process.execPath,
    [path.join(tools, "run.mjs"), "--seed", "3", "--count", "1"],
    { encoding: "utf8" },
  );
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
  const counting = new Fixture(null);
  const below = differentialRun(single("sensitivity", SENSITIVE, { seed: 5 }), {
    ...CUTS,
    right: counting.adapter("right"),
    maxSteps: unlimited.steps - 1,
  });
  assert.equal(below.outcomes.left?.kind, "censored");
  // No operation runs past the limit: the right side applied exactly the steps it was allowed.
  const applied = ["executeInstruction", "observeTime"].reduce(
    (sum, member) => sum + (counting.counts.get(`right fresh ${member} invocation`) ?? 0),
    0,
  );
  assert.equal(applied, unlimited.steps - 1);

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

test("a mismatch limit is a positive safe integer, and any other is refused before either side's run starts", () => {
  // The admitted limits, each with the mismatches a comparison of twelve differing values reports under it.
  const admitted: [label: string, limit: number | undefined, reported: number][] = [
    ["absent, so 10", undefined, 10],
    ["one", 1, 1],
    ["ten", 10, 10],
    ["the largest safe integer", Number.MAX_SAFE_INTEGER, 12],
  ];
  const twelve = Array.from({ length: 12 }, (_, index) => index);
  const otherTwelve = twelve.map((index) => -index - 1);
  for (const [label, limit, reported] of admitted) {
    const options = limit === undefined ? {} : { limit };
    // A limit only bounds what a discrepancy reports: equal values stay equal, on every restore route.
    assert.equal(compareStructures({ a: [1] }, { a: [1] }, options).equal, true, label);
    assert.deepEqual(
      differentialRun(FAULT_INPUT, { ...CUTS, ...options }).verdict,
      { kind: "equivalent" },
      label,
    );
    const capped = compareStructures(twelve, otherTwelve, options);
    assert.deepEqual(
      [capped.equal, capped.mismatches.length, capped.truncated],
      [false, reported, reported < 12],
      label,
    );
  }
  // The driver passes its limit on: two changed bindings are one mismatch under limit 1, and two by default.
  const bothBindings = (options: DifferentialOptions) =>
    injected(
      (record, at) => uninterrupted(at) && binding(record, "computed") !== undefined,
      (copy) => {
        for (const name of ["x", "computed"]) {
          const item = binding(copy, name)!;
          // EVIDENCE: validation: `x` and `computed` hold integers.
          item.value = (item.value as number) + 1;
        }
      },
      undefined,
      options,
    ).verdict;
  for (const [options, reported] of [
    [{ limit: 1 }, 1],
    [{}, 2],
  ] as const) {
    const verdict = bothBindings(options);
    assert.equal(verdict.kind, "discrepancy", JSON.stringify(verdict));
    if (verdict.kind === "discrepancy") assert.equal(verdict.mismatches.length, reported);
  }

  for (const [label, limit] of [
    ["zero", 0],
    ["negative", -1],
    ["a fraction", 1.5],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["-Infinity", Number.NEGATIVE_INFINITY],
    ["2^53", 2 ** 53],
  ] as const) {
    assert.throws(() => compareStructures(1, 1, { limit }), RangeError, label);
    let ports = 0;
    assert.throws(
      () =>
        differentialRunOn(
          new Attribution(),
          () => {
            ports += 1;
            throw new Error("no side may start");
          },
          FAULT_INPUT,
          { ...CUTS, limit },
        ),
      RangeError,
      label,
    );
    assert.equal(ports, 0, `${label}: no side's run started`);
    assert.throws(() => differentialRun(FAULT_INPUT, { ...CUTS, limit }), RangeError, label);
  }
});
