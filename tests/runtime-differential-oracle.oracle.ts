import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import type {
  FreshRuntimeOptions,
  ProjectSourceFile,
  RuntimeSession,
  RuntimeSessionOptions,
  SerializableRuntimeValue,
} from "../src/index.js";
import {
  differentialRun,
  thisBuild,
  type DifferentialInput,
  type DifferentialReport,
  type PipelineAdapter,
  type Route,
} from "./helpers/runtime-differential.js";
import { COLLIDING_A, COLLIDING_B } from "./helpers/colliding-texts.js";
import { firstDuplicate, holdsHandle, nestedSetFamily } from "./helpers/nested-set-family.js";
import {
  admitExternal,
  plainRecipe,
  remoteDifferentialRun,
  Runner,
  type Admission,
  type AdmissionRoute,
  type Recipe,
} from "./helpers/runtime-differential-remote.js";
import { checkout, scratch, sealedManifest } from "./helpers/runtime-oracle.js";
import {
  deepSetChain,
  IDENTITY,
  mixedNest,
  renderPath,
} from "./helpers/runtime-state-comparison.js";

// The oracle binding of the differential harness (docs/TESTING.md "Differential harness"): the lockstep driver over two
// roots' runners, the pinned oracle root (left) against this checkout's build (right), each in a process of its own
// behind 0a's guard. It runs in `npm run oracle:test` (CI's check-1), after the oracle root is materialized.

const tools = path.join(checkout, "tools");

/** The sealed manifest's fields this test reads. */
interface Manifest {
  readonly commit: string;
  readonly output: Record<string, string>;
}
interface Materialize {
  materialize(manifest: Manifest): string;
}
interface Closure {
  closure(root: string): { readonly output: Record<string, string> };
}
// EVIDENCE: validation: materialize.mjs and closure.mjs export these functions (tools/runtime-oracle).
const { materialize } = (await import(
  pathToFileURL(path.join(tools, "runtime-oracle", "materialize.mjs")).href
)) as Materialize;
// EVIDENCE: validation: as above.
const { closure } = (await import(
  pathToFileURL(path.join(tools, "runtime-oracle", "closure.mjs")).href
)) as Closure;

const manifest = sealedManifest<Manifest>();
const oracleRoot = materialize(manifest);
const oracleFiles = Object.keys(manifest.output);
const candidateFiles = Object.keys(closure(checkout).output);
const work = scratch();
const started: Runner[] = [];

/** A runner of `root`, ended when the file's tests end. */
function runner(
  label: string,
  root: string,
  files: readonly string[],
  replace: readonly string[] = [],
): Runner {
  const made = new Runner(label, root, files, work.directory, replace);
  started.push(made);
  return made;
}

const oracle = runner("oracle", oracleRoot, oracleFiles);
const candidate = runner("candidate", checkout, candidateFiles);

test.after(() => {
  for (const item of started) item.close();
  work.done();
});

const CUTS = { maxCuts: 8 };
const ROUTES: readonly Route[] = ["legacy", "core"];

function single(name: string, source: string, fresh: FreshRuntimeOptions = {}): DifferentialInput {
  return { name, sources: [{ path: "main.tease", source }], fresh };
}

/** A report without its CPU time, the one field that differs between two runs of the same pair. */
function stable(report: DifferentialReport): Omit<DifferentialReport, "cpuMs"> {
  const { cpuMs: _cpu, ...rest } = report;
  return rest;
}

/** Equivalent, or on the core route not compared because the core does not support the program yet. */
function assertEquivalent(report: DifferentialReport): void {
  if (report.route === "core" && report.verdict.kind === "not-compared")
    assert.equal(report.verdict.because, "unsupported-route", report.name);
  else
    assert.deepEqual(
      report.verdict,
      { kind: "equivalent" },
      `${report.name}: ${JSON.stringify(report.verdict)}`,
    );
}

interface RegressionIndex {
  readonly seeds: readonly number[];
  readonly entries: readonly {
    readonly name: string;
    readonly globals?: Record<string, SerializableRuntimeValue>;
  }[];
}
interface GeneratedProgram {
  readonly id: string;
  readonly tags: readonly string[];
  readonly runtimeSeed: number;
  readonly globals?: Record<string, SerializableRuntimeValue>;
  readonly project?: boolean;
  readonly sources: readonly ProjectSourceFile[];
}
interface Generator {
  readonly families: readonly string[];
  generate(seed: number, index: number, family?: string): GeneratedProgram;
}
const differentialTools = path.join(tools, "runtime-differential");
// EVIDENCE: validation: the regression index is this shape, written once from the research corpus.
const regressions = JSON.parse(
  fs.readFileSync(path.join(differentialTools, "regressions", "index.json"), "utf8"),
) as RegressionIndex;
// EVIDENCE: validation: generate.mjs exports the families and `generate`.
const generator = (await import(
  pathToFileURL(path.join(differentialTools, "generate.mjs")).href
)) as Generator;

function regressionInputs(seeds: readonly number[]): DifferentialInput[] {
  return regressions.entries.flatMap((entry) => {
    const source = fs.readFileSync(
      path.join(differentialTools, "regressions", `${entry.name}.tease`),
      "utf8",
    );
    return seeds.map((seed) =>
      single(entry.name, source, { seed, ...(entry.globals ? { globals: entry.globals } : {}) }),
    );
  });
}

function programInput(
  program: GeneratedProgram,
  random?: "natural" | "choose-natural",
): DifferentialInput {
  return {
    name: program.id,
    sources: program.sources,
    project: program.project === true,
    ...(random === undefined ? {} : { random }),
    fresh: { seed: program.runtimeSeed, ...(program.globals ? { globals: program.globals } : {}) },
  };
}

/** The 0b.1 suite's bounded sample: each family once, then the first indices of seed 1; random modes alternate. */
function sampleInputs(): DifferentialInput[] {
  const programs = [...new Set(generator.families)].map((family, index) =>
    generator.generate(7, index, family),
  );
  for (let index = 0; programs.length < 40; index += 1) programs.push(generator.generate(1, index));
  const random = programs.filter((program) => program.tags.includes("rng"));
  return programs.map((program) =>
    programInput(
      program,
      program.tags.includes("rng")
        ? random.indexOf(program) % 2 === 1
          ? "choose-natural"
          : "natural"
        : undefined,
    ),
  );
}

test("the pinned oracle and this build, each in its root's runner, are equivalent on every regression and the sample", () => {
  for (const input of [...regressionInputs(regressions.seeds), ...sampleInputs()])
    for (const route of ROUTES)
      assertEquivalent(
        remoteDifferentialRun({ left: oracle, right: candidate }, input, { ...CUTS, route }),
      );
});

/*
 * The construction witnesses (A1 (b)–(e)): sessions that diverge, throw in a callback, or end early, on one side or
 * the other. Each wrapper is one module, loaded in this process for the in-process run and, through a candidate whose
 * `createFreshRuntimeSession` it wraps, in a runner for the cross-process one; the two reports must be equal.
 */
const WITNESS_MODULE = `// Test-only session wrappers (tests/runtime-differential-oracle.oracle.ts).
import fs, { appendFileSync } from "node:fs";
const unreadable = () => new Proxy({}, { get: () => { throw new Error("unreadable draw"); } });
const throwCallback = (options) => { options?.randomControl?.decide?.(unreadable()); };
function counted(session, each) {
  let steps = 0;
  const execute = session.executeInstruction.bind(session);
  session.executeInstruction = (traced) => { steps += 1; return each(steps, () => execute(traced)); };
  return () => steps;
}
/** Replaces this runner's next reply line by \`forged(reply)\`, as a candidate that writes to its pipe could. */
const forgeNextReply = (forged) => {
  const write = fs.writeSync;
  fs.writeSync = function (fd, data, ...rest) {
    let reply;
    try { reply = typeof data === "string" ? JSON.parse(data) : undefined; } catch {}
    if (!Number.isInteger(reply?.seq)) return write.call(this, fd, data, ...rest);
    fs.writeSync = write;
    return write.call(this, fd, JSON.stringify(forged(reply)) + "\\n", ...rest);
  };
};
const diverging = (session, options, extra) => {
  counted(session, (steps, run) => {
    if (extra && steps === 4) throwCallback(options);
    const result = run();
    return steps === 2 ? { ...result, events: [...result.events, { kind: "say", text: "diverged" }] } : result;
  });
  return session;
};
export const wraps = {
  "b-right": (session, options) => diverging(session, options, true),
  "c-left": (session, options) => diverging(session, options, false),
  "c-right": (session, options) => {
    counted(session, (steps, run) => { if (steps === 4) throwCallback(options); return run(); });
    return session;
  },
  "d-right": (session) => {
    const steps = counted(session, (_, run) => run());
    const view = session.view.bind(session);
    session.view = () => { const seen = view(); return steps() >= 3 ? { ...seen, status: "halted" } : seen; };
    return session;
  },
  "e-right": (session) => {
    counted(session, (steps, run) => {
      if (steps === 1) throw new Error("failure before divergence");
      const result = run();
      return steps === 3 ? { ...result, events: [] } : result;
    });
    return session;
  },
  "exit-right": (session) => {
    counted(session, (steps, run) => { if (steps === 2) process.exit(3); return run(); });
    return session;
  },
  "two-answers-right": (session) => {
    forgeNextReply((reply) => ({ ...reply, stop: { verdict: { kind: "equivalent" }, outcome: null } }));
    return session;
  },
  "foreign-stop-right": (session) => {
    forgeNextReply(({ seq }) => ({ seq, stop: { verdict: { kind: "equivalent" }, outcome: null } }));
    return session;
  },
  "null-reply-right": (session) => {
    forgeNextReply(() => null);
    return session;
  },
  "hidden-global": (session) => {
    const exported = session.exportTrustedSnapshot.bind(session);
    session.exportTrustedSnapshot = () => ({ ...exported(), globals: [] });
    return session;
  },
  "malformed-right": (session) => {
    counted(session, (steps, run) => {
      if (steps === 2) appendFileSync(process.argv[3], "not a reply\\n");
      return run();
    });
    return session;
  },
};
`;
const witnessFile = "dist/src/runtime/differential-witness.differential-mutant.js";
type Wrap = (session: RuntimeSession, options: RuntimeSessionOptions | undefined) => RuntimeSession;

/** Writes the witness module and a `session.js` per wrapper into this checkout's build; removes them after. */
function withWitnesses(body: (wraps: Readonly<Record<string, Wrap>>) => Promise<void> | void) {
  return async () => {
    const written = [path.join(checkout, witnessFile)];
    fs.writeFileSync(written[0]!, WITNESS_MODULE);
    try {
      // EVIDENCE: validation: the module written just above exports `wraps`, one wrapper per key.
      const { wraps } = (await import(pathToFileURL(written[0]!).href)) as {
        wraps: Record<string, Wrap>;
      };
      const session = fs.readFileSync(path.join(checkout, "dist/src/runtime/session.js"), "utf8");
      for (const key of Object.keys(wraps)) {
        const file = path.join(checkout, `dist/src/runtime/session.${key}.differential-mutant.js`);
        written.push(file);
        fs.writeFileSync(
          file,
          `import { wraps as witnessWraps } from "./differential-witness.differential-mutant.js";\n${session}\n` +
            `{\n  const original = createFreshRuntimeSession;\n  createFreshRuntimeSession = (plan, fresh, options) =>\n` +
            `    witnessWraps[${JSON.stringify(key)}](original(plan, fresh, options), options);\n}\n`,
        );
      }
      await body(wraps);
    } finally {
      for (const file of written) fs.rmSync(file, { force: true });
    }
  };
}

/** This build's adapter, its fresh sessions wrapped by `wrap`. */
function wrapped(label: string, wrap: Wrap | undefined): PipelineAdapter {
  const build = thisBuild(label);
  if (wrap === undefined) return build;
  return {
    ...build,
    sessions: {
      ...build.sessions,
      createFreshRuntimeSession: (plan, fresh, options) =>
        wrap(build.sessions.createFreshRuntimeSession(plan, fresh, options), options),
    },
  };
}

/** A candidate runner whose fresh sessions `key` wraps, or the plain candidate. */
function witnessRunner(key: string | undefined): Runner {
  if (key === undefined) return runner("witness-plain", checkout, candidateFiles);
  return runner(
    `witness-${key}`,
    checkout,
    [...candidateFiles, witnessFile],
    [
      `dist/src/runtime/session.js=${path.join(checkout, `dist/src/runtime/session.${key}.differential-mutant.js`)}`,
    ],
  );
}

const LONG =
  'let a = 1\nlet b = 2\nlet c = 3\nlet d = 4\nsay "${a}", instant\nwait 1 ms\nlet e = 5\nlet f = 6\nexit\n';

test(
  "each construction witness gives the same report in-process and across processes",
  withWitnesses((wraps) => {
    const witnesses: readonly {
      readonly input: DifferentialInput;
      readonly left?: string;
      readonly right?: string;
      readonly verdict: string;
    }[] = [
      {
        input: { ...single("b", LONG, { seed: 5 }), random: "natural" },
        right: "b-right",
        verdict: "discrepancy",
      },
      {
        input: { ...single("c", LONG, { seed: 5 }), random: "natural" },
        left: "c-left",
        right: "c-right",
        verdict: "discrepancy",
      },
      { input: single("d", LONG, { seed: 5 }), right: "d-right", verdict: "discrepancy" },
      { input: single("e", LONG, { seed: 5 }), right: "e-right", verdict: "not-compared" },
    ];
    for (const witness of witnesses) {
      const local = differentialRun(witness.input, {
        ...CUTS,
        left: wrapped("left", witness.left === undefined ? undefined : wraps[witness.left]),
        right: wrapped("right", witness.right === undefined ? undefined : wraps[witness.right]),
      });
      const remote = remoteDifferentialRun(
        { left: witnessRunner(witness.left), right: witnessRunner(witness.right) },
        witness.input,
        CUTS,
      );
      assert.equal(
        local.verdict.kind,
        witness.verdict,
        `${witness.input.name}: ${JSON.stringify(local.verdict)}`,
      );
      assert.deepEqual(stable(remote), stable(local), witness.input.name);
    }
  }),
);

test(
  "a runner that exits or writes a malformed line or reply mid-run is that side's harness failure",
  withWitnesses(() => {
    for (const [key, reason] of [
      ["exit-right", /closed its pipe|cannot be written to/u],
      ["malformed-right", /malformed line/u],
      // The true answer with an `equivalent` stop beside it, an `equivalent` stop alone, and a reply that is no object.
      ["two-answers-right", /malformed reply/u],
      ["foreign-stop-right", /malformed reply/u],
      ["null-reply-right", /out of order/u],
    ] as const) {
      const report = remoteDifferentialRun(
        { left: witnessRunner(undefined), right: witnessRunner(key) },
        single(key, LONG, { seed: 5 }),
        CUTS,
      );
      assert.deepEqual(
        report.verdict,
        { kind: "not-compared", side: "right", because: "harness-failure" },
        key,
      );
      const outcome = report.outcomes.right;
      assert.ok(outcome?.kind === "harness-failure", key);
      assert.match(outcome.member, /^runner\./u, key);
      assert.match(outcome.error, reason, key);
    }
  }),
);

/** Runs `body` with a mutant of the candidate's built `original`, `edit` applied to its text, beside it. */
function withMutant(
  original: string,
  edit: (text: string) => string,
  body: (replace: string) => void,
): void {
  const file = path.join(checkout, original);
  const mutant = file.replace(/\.js$/u, ".differential-mutant.js");
  const text = fs.readFileSync(file, "utf8");
  const edited = edit(text);
  assert.notEqual(edited, text, `the mutation of ${original} applies`);
  fs.writeFileSync(mutant, edited);
  try {
    body(`${original}=${mutant}`);
  } finally {
    fs.rmSync(mutant, { force: true });
  }
}

test("each candidate mutation is a discrepancy in the uninterrupted run against the oracle, which equals the unchanged build", () => {
  const controls: readonly {
    readonly name: string;
    readonly file: string;
    readonly edit: (text: string) => string;
    readonly input: DifferentialInput;
    readonly route: Route;
    readonly path: RegExp;
  }[] = [
    {
      name: "an emitted instruction dropped",
      file: "dist/src/compiler/lowering/say.js",
      edit: (text) =>
        text.replaceAll(
          /compiler\.instructions\.push\(\{(\s*)kind: "say",/gu,
          'void ({$1kind: "say",',
        ),
      input: single("dropped", 'let a = 1\nsay "A", instant\nlet b = 2\nexit\n', { seed: 1 }),
      route: "legacy",
      path: /events|result|nextInstruction/u,
    },
    {
      name: "a whole type check deleted",
      file: "dist/src/runtime/values/value-types.js",
      edit: (text) =>
        text.replace(
          "const mismatch = findTypeMismatch(value, check.type);",
          "const mismatch = null;",
        ),
      input: single("type-check", 'let v: integer = hostValue\nsay "AFTER", instant\nexit\n', {
        seed: 1,
        globals: { hostValue: 1.5 },
      }),
      route: "legacy",
      path: /status|failure|result/u,
    },
    {
      name: "the core integer[] part check deleted",
      file: "dist/src/type-inference/core/check-result/runtime-plan.js",
      edit: (text) =>
        text.replace(/if \(parts\.length > 0\)\s*core\.partChecks\.set\(store, parts\);/u, ""),
      input: single(
        "part-check",
        'let seed: integer = 7\nlet copy = hostInit\ncopy.xs = [seed]\ncopy = hostValue\nsay "REACHED"\nexit\n',
        {
          seed: 1,
          globals: {
            hostInit: {
              kind: "object",
              properties: [{ name: "xs", value: { kind: "list", items: [1] } }],
            },
            hostValue: {
              kind: "object",
              properties: [{ name: "xs", value: { kind: "list", items: [1.5] } }],
            },
          },
        },
      ),
      route: "core",
      path: /status|failure|result/u,
    },
    {
      name: "a successor changed",
      file: "dist/src/compiler/lowering/control-flow.js",
      edit: (text) =>
        text.replace(
          "compiler.instructions[jump] = { ...jumpInstruction, target: compiler.instructions.length };",
          "compiler.instructions[jump] = { ...jumpInstruction, target: compiler.instructions.length + 1 };",
        ),
      input: single(
        "successor",
        'let x = 1\nif x == 1 {\n  say "A", instant\n} else {\n  say "B", instant\n}\nlet y = 2\nsay "C", instant\nexit\n',
        { seed: 1 },
      ),
      route: "legacy",
      path: /nextInstruction|frames|events/u,
    },
  ];
  for (const control of controls) {
    // The oracle reproduces: the unchanged build equals it on the control's own input.
    assert.deepEqual(
      remoteDifferentialRun({ left: oracle, right: candidate }, control.input, {
        ...CUTS,
        route: control.route,
      }).verdict,
      { kind: "equivalent" },
      control.name,
    );
    withMutant(control.file, control.edit, (replace) => {
      const mutant = runner(`mutant-${control.input.name}`, checkout, candidateFiles, [replace]);
      const report = remoteDifferentialRun({ left: oracle, right: mutant }, control.input, {
        ...CUTS,
        route: control.route,
      });
      const verdict = report.verdict;
      assert.equal(verdict.kind, "discrepancy", `${control.name}: ${JSON.stringify(verdict)}`);
      if (verdict.kind !== "discrepancy") return;
      // The lockstep run stops at the first state that differs, in the uninterrupted run, against the other side.
      assert.equal(verdict.at.tail, "uninterrupted", control.name);
      assert.equal(verdict.at.against, "other-side", control.name);
      assert.ok(verdict.at.state >= 1, control.name);
      assert.match(renderPath(verdict.mismatches[0]?.path ?? []), control.path, control.name);
    });
  }
});

test("a candidate that imports outside its inventory is its side's harness failure, and a mapping failure stays one", () => {
  withMutant(
    "dist/src/runtime/values/value-types.js",
    (text) => `import "../../../../tools/runtime-oracle/admission.mjs";\n${text}`,
    (replace) => {
      const broken = runner("broken-import", checkout, candidateFiles, [replace]);
      const report = remoteDifferentialRun(
        { left: oracle, right: broken },
        single("broken", "exit\n"),
        CUTS,
      );
      assert.deepEqual(report.verdict, {
        kind: "not-compared",
        side: "right",
        because: "harness-failure",
      });
      const outcome = report.outcomes.right;
      assert.ok(outcome?.kind === "harness-failure");
      assert.match(outcome.error, /outside the root's inventory/u);
    },
  );
  const unknown = remoteDifferentialRun(
    { left: oracle, right: candidate },
    single(
      "sensitivity",
      "let x = randomInteger(0..3)\nlet computed = x + 1\nsay computed, instant\nwait 1 ms\nexit\n",
      { seed: 5 },
    ),
    {
      ...CUTS,
      correspondence: {
        ...IDENTITY,
        identity: false,
        instruction: (index) => (index === 0 ? undefined : index),
      },
    },
  );
  assert.equal(unknown.verdict.kind, "mapping-failure", JSON.stringify(unknown.verdict));
});

test(
  "each admission route accepts its control on both roots alike, a defect is the root's own rejection, and an envelope failure is never one",
  withWitnesses(() => {
    const routes: readonly AdmissionRoute[] = ["global", "storage", "checkpoint"];
    for (const route of routes) {
      const control = { builder: "mixedNest", depth: 6 } as const;
      const left = admitExternal(oracle, control, route);
      const right = admitExternal(candidate, control, route);
      assert.equal(left.accepted, true, `${route}: ${JSON.stringify(left)}`);
      assert.deepEqual(right, left, route);
    }
    for (const route of ["global", "checkpoint"] as const) {
      const defect = admitExternal(oracle, { builder: "cycleAt", depth: 3 }, route);
      assert.equal(defect.accepted, false, route);
      if (!defect.accepted) assert.notEqual(defect.error.message, "", route);
      assert.deepEqual(
        admitExternal(candidate, { builder: "cycleAt", depth: 3 }, route),
        defect,
        route,
      );
    }
    // The admission succeeds, then the envelope cannot read the admitted value: the harness's failure, not a rejection.
    assert.throws(
      () =>
        admitExternal(witnessRunner("hidden-global"), { builder: "mixedNest", depth: 6 }, "global"),
      /closed its pipe|cannot be written to/u,
    );
  }),
);

/*
 * Nested-set admission against the frozen boundary (#1904, plan-r4's R-setdepth): the pinned root validates sets with
 * the per-member key the candidate replaced by bottom-up prints, so equal admissions on both are the same admission.
 * Each case declares its outcome first, so two roots that reject alike never pass for an accepted value. Frozen depths
 * stay at 1,024 levels or less: deeper, the pinned root's validator itself grows with the square of the depth.
 */
const ACCEPTANCE = process.env.FUZZ_ACCEPTANCE === "1";
const ADMISSION_ROUTES: readonly AdmissionRoute[] = ["global", "storage", "checkpoint"];

/** Both roots' admission of `recipe` by `route`, `accepted` as declared on the oracle, and equal on the candidate. */
function admittedAlike(
  label: string,
  recipe: Recipe,
  route: AdmissionRoute,
  accepted: boolean,
): Admission {
  const left = admitExternal(oracle, recipe, route);
  const shown = left.accepted ? "accepted" : `${left.error.name}: ${left.error.message}`;
  assert.equal(left.accepted, accepted, `${label} on ${route}, oracle: ${shown}`);
  assert.deepEqual(admitExternal(candidate, recipe, route), left, `${label} on ${route}`);
  return left;
}

const list = (...items: SerializableRuntimeValue[]): SerializableRuntimeValue => ({
  kind: "list",
  items,
});
const set = (...items: SerializableRuntimeValue[]): SerializableRuntimeValue => ({
  kind: "set",
  items,
});
const object = (...parts: [string, SerializableRuntimeValue][]): SerializableRuntimeValue => ({
  kind: "object",
  properties: parts.map(([name, value]) => ({ name, value })),
});
const dict = (...parts: [string, SerializableRuntimeValue][]): SerializableRuntimeValue => ({
  kind: "dict",
  entries: parts.map(([key, value]) => ({ key, value })),
});

test("a seeded nested-set family is admitted on host globals by both roots as an independent oracle expects", () => {
  let duplicates = 0;
  let identities = 0;
  let accepted = 0;
  for (const value of nestedSetFamily(1904, ACCEPTANCE ? 20_000 : 200)) {
    const duplicate = firstDuplicate(value, "globals.hostValue");
    const handle = duplicate === null && holdsHandle(value);
    const admission = admittedAlike(
      "family",
      plainRecipe(value),
      "global",
      duplicate === null && !handle,
    );
    if (admission.accepted) accepted += 1;
    else if (duplicate !== null) {
      duplicates += 1;
      assert.equal(admission.error.message, duplicate);
    } else {
      identities += 1;
      assert.match(admission.error.message, /only the runtime creates/u);
    }
  }
  // Every outcome is represented.
  assert.ok(
    duplicates > 0 && identities > 0 && accepted > 0,
    `${duplicates}/${identities}/${accepted}`,
  );
});

test("collisions, precedence, == classes and recipes are admitted alike on every route", () => {
  const unsupported: SerializableRuntimeValue = JSON.parse('{"kind":"unsupported"}');
  const wrapped = [
    (text: string) => list(text),
    (text: string) => set(text),
    (text: string) => object(["v", text]),
    (text: string) => dict(["k", text]),
  ];
  const plain: [string, SerializableRuntimeValue, boolean][] = [
    // Members whose prints collide are compared whole.
    ...wrapped.flatMap((wrap, index): [string, SerializableRuntimeValue, boolean][] => [
      [`collision ${index}`, set(wrap(COLLIDING_A), wrap(COLLIDING_B)), true],
      [
        `colliding duplicate ${index}`,
        set(wrap(COLLIDING_A), wrap(COLLIDING_B), wrap(COLLIDING_A)),
        false,
      ],
    ]),
    ["nested collision", set(set(list(COLLIDING_A)), set(list(COLLIDING_B))), true],
    // Every member is validated before the set compares them, and inner sets before outer ones.
    ["malformed after a duplicate", set(list(0), list(0), unsupported), false],
    ["inner duplicate", set(set(0, 0), set(0, 0)), false],
    ["nested duplicate", list(set(list(1)), set(list(2), list(2))), false],
    // Equal by ==: sets, objects and dicts in any order, -0 and 0.
    ["reordered set", set(set(1, 2), set(2, 1)), false],
    ["reordered object", set(object(["a", 1], ["b", 2]), object(["b", 2], ["a", 1])), false],
    ["reordered dict", set(dict(["a", 1], ["b", 2]), dict(["b", 2], ["a", 1])), false],
    ["signed zero", set(list(0), list(-0)), false],
    // Unequal: kinds of scalars, list order, an object and a dict, empty collections.
    ["scalar kinds", set(list(1), list("1"), list(true), list(null)), true],
    ["list order", set(list(1, 2), list(2, 1)), true],
    ["object and dict", set(object(["a", 1]), dict(["a", 1]), list(set()), list(list())), true],
  ];
  const recipes: [string, Recipe, boolean][] = [
    ...[1, 64, 256].flatMap((depth): [string, Recipe, boolean][] => [
      [`mixedNest ${depth}`, { builder: "mixedNest", depth }, true],
      [`deepSetChain ${depth}`, { builder: "deepSetChain", depth }, true],
    ]),
    ...[3, 1000].flatMap((width): [string, Recipe, boolean][] => [
      [`wideSet ${width}`, { builder: "wideSet", width }, true],
      ...[0, Math.floor(width / 2), width - 1].map((duplicateAt): [string, Recipe, boolean] => [
        `wideSet ${width} duplicate ${duplicateAt}`,
        { builder: "wideSet", width, duplicateAt },
        false,
      ]),
    ]),
    ...(["accessorAt", "cycleAt", "holeAt", "prototypeAt", "nonFiniteAt"] as const).flatMap(
      (builder) =>
        [1, 256].map((depth): [string, Recipe, boolean] => [
          `${builder} ${depth}`,
          { builder, depth },
          false,
        ]),
    ),
  ];
  for (const route of ADMISSION_ROUTES) {
    for (const [label, value, accepted] of plain)
      admittedAlike(label, plainRecipe(value), route, accepted);
    for (const [label, recipe, accepted] of recipes) admittedAlike(label, recipe, route, accepted);
  }
  for (const builder of ["mixedNest", "deepSetChain"] as const)
    admittedAlike(`${builder} 1024`, { builder, depth: 1024 }, "global", true);

  // A text that does not parse ends its runner: the harness's failure, never a root's rejection.
  assert.throws(
    () =>
      admitExternal(
        runner("plain-unparsed", checkout, candidateFiles),
        { builder: "plain", text: "{" },
        "global",
      ),
    /closed its pipe|cannot be written to/u,
  );
});

test("a nested host value runs, restores and compares alike on both roots", () => {
  const source = 'let copy = hostValue\nwait 1 ms\nsay "done", instant\nexit\n';
  const values: [string, SerializableRuntimeValue][] = [["mixedNest 64", mixedNest(64)]];
  // On demand: a chain of sets, where the pinned root's 65 validations cost about 14 s.
  if (ACCEPTANCE) values.push(["deepSetChain 1024", deepSetChain(1024)]);
  for (const [name, hostValue] of values) {
    const report = remoteDifferentialRun(
      { left: oracle, right: candidate },
      single(name, source, { seed: 1, globals: { hostValue } }),
      CUTS,
    );
    assert.deepEqual(report.verdict, { kind: "equivalent" }, name);
    assert.deepEqual(report.outcomes.left, { kind: "completed" }, name);
  }
});

test("a source of multibyte characters longer than one pipe read crosses both pipes intact", () => {
  const input = single("multibyte", `say "${"€".repeat(24_000)}", instant\nexit\n`, { seed: 1 });
  const local = differentialRun(input, CUTS);
  assert.deepEqual(local.verdict, { kind: "equivalent" });
  const remote = remoteDifferentialRun(
    {
      left: runner("multibyte-left", checkout, candidateFiles),
      right: runner("multibyte-right", checkout, candidateFiles),
    },
    input,
    CUTS,
  );
  assert.deepEqual(stable(remote), stable(local));
});

test("the campaign CLI's oracle mode runs both roots and names them on every line", () => {
  const ran = spawnSync(
    process.execPath,
    [path.join(differentialTools, "run.mjs"), "--oracle", "--seed", "3", "--count", "2"],
    { encoding: "utf8" },
  );
  assert.equal(ran.status, 0, ran.stderr);
  const lines = ran.stdout
    .trim()
    .split("\n")
    .map((line) => {
      // EVIDENCE: validation: the CLI writes one JSON object per line, with these fields in oracle mode.
      const parsed = JSON.parse(line) as { oracle?: string; candidate?: string };
      return parsed;
    });
  assert.equal(lines.length, 2);
  for (const line of lines) {
    assert.equal(line.oracle, manifest.commit);
    assert.match(line.candidate ?? "", /^[0-9a-f]{64}$/u);
  }
});

/*
 * FUZZ_ACCEPTANCE=1: the predeclared acceptance list (tools/runtime-differential/acceptance.json), every pair of which
 * must be equivalent against the oracle. Programs outside it run in research mode, through the CLI.
 */
interface Acceptance {
  readonly regressions: { readonly seeds: readonly number[]; readonly routes: readonly Route[] };
  readonly generated: readonly {
    readonly seed: number;
    readonly from: number;
    readonly count: number;
    readonly route: Route;
  }[];
  readonly inputs: readonly (DifferentialInput & { readonly route: Route })[];
}

test(
  "every pair of the acceptance list is equivalent against the oracle",
  {
    skip:
      process.env.FUZZ_ACCEPTANCE === "1" ? false : "FUZZ_ACCEPTANCE=1 runs the acceptance list",
  },
  () => {
    // EVIDENCE: validation: acceptance.json is this predeclared shape.
    const acceptance = JSON.parse(
      fs.readFileSync(path.join(differentialTools, "acceptance.json"), "utf8"),
    ) as Acceptance;
    const pairs: [DifferentialInput, Route][] = [
      ...regressionInputs(acceptance.regressions.seeds).flatMap((input) =>
        acceptance.regressions.routes.map((route): [DifferentialInput, Route] => [input, route]),
      ),
      ...acceptance.generated.flatMap(({ seed, from, count, route }) =>
        Array.from({ length: count }, (_, offset): [DifferentialInput, Route] => [
          programInput(generator.generate(seed, from + offset)),
          route,
        ]),
      ),
      ...acceptance.inputs.map(({ route, ...input }): [DifferentialInput, Route] => [input, route]),
    ];
    for (const [input, route] of pairs) {
      const report = remoteDifferentialRun({ left: oracle, right: candidate }, input, {
        ...CUTS,
        route,
      });
      assert.deepEqual(
        report.verdict,
        { kind: "equivalent" },
        `${input.name}/${route}: ${JSON.stringify(report.verdict)}`,
      );
    }
  },
);
