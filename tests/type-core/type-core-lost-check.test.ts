import assert from "node:assert/strict";
import test from "node:test";

import { compileSourceWithBackend } from "../../src/compiler.js";
import type { InstructionPlan, TypePlan } from "../../src/plan/model.js";
import { run } from "../../src/runtime/engine.js";
import type { RuntimeScriptStorageEntrySnapshot } from "../../src/runtime/host-data/script-storage.js";
import {
  createSerializableList as list,
  createSerializableObject,
  type SerializableRuntimeValue,
} from "../../src/runtime/values/serializable-values.js";
import { analyseCore, type Answers } from "../../src/type-inference/core/answers.js";
import { CandidateOutsideSlice, CORE_BACKEND } from "../../src/type-inference/core/backend.js";
import { narrower } from "../../src/type-inference/core/check-result/kept-checks.js";
import {
  withTestAllowance,
  withTestDemandAllowance,
} from "../../src/type-inference/core/budget.js";
import { createImmediatePacingRuntimeSnapshot } from "../helpers/immediate-pacing-runtime.js";
import { coreRequest } from "../helpers/type-core-analysis.js";
import { HELD_MODES } from "../helpers/type-core-held-host.js";
import { inMode, MODES } from "../helpers/type-core-oracles.js";
import { runGlobals } from "../helpers/type-core-route.js";

// #1526 decision 2, condition 1: while a required check is missing at a stop, the candidate publishes no
// plan that lets the invalid value through unchecked. Sol's #1645 and #1648 witnesses, at a settled decision stop.

const GLOBALS = ["hostValue", "hostOther"];
const LOST = "a store whose check was lost at the budget";
// (#1775's rule (R), which runs first: a typed parse's or load's default a stop left open declines before the gate)
const OPEN_BY_STOP = "a typed parse's or load's default that a stop left open";
const END = '\nsay "AFTER"\nexit\n';
const lines = (k: number, line: (at: number) => string): string =>
  Array.from({ length: k }, (_, at) => line(at)).join("\n");
const retarget = (k: number): string =>
  `let box = {first: {n: [[1]]}}\n${lines(k, (at) => `box = {first: {n: [[${at}]]}}`)}\nbox.first.n = hostValue`;
const reject = (k: number): string =>
  `let b = {f0: 1}\n${lines(k, (at) => `b = {f0: ${at}}`)}\nb = 5\nb.f0 = hostValue`;
const copied = (middle: string, tail: string): string =>
  `let b = {f: [[1]], first: {n: [[1]]}}\n${lines(16, (at) => `b = {f: [[${at}]], first: {n: [[${at}]]}}`)}\n${middle}\n${tail}`;
const object = (fields: Record<string, SerializableRuntimeValue>): SerializableRuntimeValue =>
  createSerializableObject(Object.entries(fields).map(([name, value]) => ({ name, value })));
const nested = (value: SerializableRuntimeValue): SerializableRuntimeValue => list([list([value])]);

/** A witness, the host values of its forbidden run, and the start of the stored value a decline names (unique). */
interface Witness {
  readonly name: string;
  readonly source: string;
  readonly forbidden: Readonly<Record<string, SerializableRuntimeValue>>;
  readonly at: string;
  readonly storage?: readonly RuntimeScriptStorageEntrySnapshot[];
}

const witness = (
  name: string,
  source: string,
  forbidden: Readonly<Record<string, SerializableRuntimeValue>> = {
    hostValue: nested("x"),
    hostOther: 3,
  },
  at = "hostValue",
  storage?: Witness["storage"],
): Witness => ({
  name,
  source: source + END,
  forbidden,
  at,
  ...(storage === undefined ? {} : { storage }),
});

/**
 * At demand 16 in four modes: a required check is Lost at a settled decision stop. Where a rejection or a retarget lost
 * the completion's results, the decline names the first stopped mark it lost, often the place's first literal, before the
 * host store (#2080 part 1).
 */
const DECLINED: readonly Witness[] = [
  witness(
    "1645-whole-object",
    'let a = {f: [[1]], g: ["s"]}\nlet b = a\nsay "BEFORE"\nb = {f: hostValue, g: ["t"]}',
    undefined,
    '{f: hostValue, g: ["t"]}',
  ),
  witness(
    "1645-property-order",
    'let a = {z: [[1]], a: ["s"]}\nlet b = a\nsay "BEFORE"\nb = {a: hostOther, z: hostValue}',
    { hostValue: nested("x"), hostOther: list(["t"]) },
    "{a: hostOther, z: hostValue}",
  ),
  // (#2080: every completion result here is lost by the retarget, the stopped marks' too, so the program declines at its
  // first store, `let box`'s, which the gate reads before the host store)
  witness(
    "1648-retarget-exact",
    retarget(4),
    undefined,
    "{first: {n: [[1]]}}\nbox = {first: {n: [[0]]}}",
  ),
  witness(
    "1648-retarget-whole",
    retarget(16),
    undefined,
    "{first: {n: [[1]]}}\nbox = {first: {n: [[0]]}}",
  ),
  // (a rejection's lost obligation: the stopped plan fails at an earlier store, but its check at the host store is lost)
  witness("1648-rejection", reject(16), { hostValue: "x" }, "{f0: 1}\nb = {f0: 0}"),
  witness(
    "1648-rejection-projection",
    copied('b.f = "s"', "let c = b.f\nc = hostValue"),
    undefined,
    "{f: [[1]], first: {n: [[1]]}}\nb = {f: [[0]]",
  ),
  witness(
    "1648-rejection-wrapper",
    copied('b.f = "s"', "let c = {q: b}\nc.q = hostValue"),
    { hostValue: object({ f: nested("x"), first: object({ n: nested("x") }) }) },
    "{f: [[1]], first: {n: [[1]]}}\nb = {f: [[0]]",
  ),
  witness(
    "1648-r2-escaping-wrapper",
    "let b = {first: {n: null}}\nb.first.n = [[1]]\nlet c = {q: b}\nc.q = hostValue",
    { hostValue: object({ first: object({ n: nested("x") }) }) },
    "{first: {n: null}}",
  ),
  // (a store role's obligation, internal data: the natural compile rejects `combined={v:wide}`, the stop moves that to a
  // check against bare `unknown` at `let combined=base`; the rejection lost every completion result, so the decline
  // names `let base`'s, the first)
  witness(
    "store-role-moved-error",
    'let wide:number=53\nlet narrow:string="s"\nlet base={v:narrow}\nlet combined=base\ncombined={v:wide}\nlet outcome=[base,combined]',
    {},
    "{v:narrow}",
  ),
  // (Codex r1: a boundary the stop checks against bare `unknown`, no store, reader or part check carrying its contract)
  witness(
    "r1-get-default",
    "let a={n:[[1]]}\nlet b=a\nb.n=[hostValue].get(0,default:a.n)",
    { hostValue: nested("x") },
    "[hostValue]",
  ),
  witness(
    "r1-parse",
    "let a={n:[[1]]}\na=fromJson(hostValue,default:a,files:false)\nsay toJson(a)",
    { hostValue: '{"n":[["x"]]}' },
    "fromJson",
  ),
  witness("r1-load", 'let a={n:[[1]]}\nlet b=a\nb=load("k",default:a)\nsay toJson(b)', {}, "load", [
    { key: "k", value: object({ n: nested("x") }) },
  ]),
  // (Codex r2: a literal holding external data its natural store check types, no part check carrying it)
  witness(
    "r2-literal-get",
    "let a={n:null}\nlet b=a\nb={n:[hostValue].get(0,default:[[1]])}\nsay toJson(b)",
    { hostValue: nested("x") },
    "{n:[hostValue]",
  ),
  witness(
    "r2-literal-parse",
    "let a={f:[[1]]}\na={f:fromJson(hostValue,default:a.f,files:false)}\nsay toJson(a)",
    { hostValue: '[["x"]]' },
    "{f:fromJson",
  ),
  // (a typed parse's reader weaker than the completed contract, a listed property missing: `{}` against `{n: [[int]]}`)
  witness(
    "reader-property-missing",
    "let a={n:[[1]]}\nlet b=a\nb=fromJson(hostValue,default:{},files:false)\nsay toJson(b)",
    { hostValue: '{"n":[["x"]]}' },
    "fromJson",
  ),
  // (declined at the first Lost store in source order: the retarget's `let box`, before the independent store's)
  witness(
    "1648-independent-beside-retarget",
    `${retarget(4)}\nlet independent = {value: [[1]]}\nindependent.value = hostOther`,
    { hostValue: nested(2), hostOther: nested("x") },
    "{first: {n: [[1]]}}\nbox = {first: {n: [[0]]}}",
  ),
];

/** At demand 16 in four modes: every required check published with its contract; forbidden input fails before AFTER. */
const PUBLISHED: readonly Witness[] = [
  witness(
    "1645-spine",
    'let root={f:[[1]], extra:42}\nlet w0={entry:root}\nlet w1={shell:w0}\nlet w2={entry:w1}\nlet old=w2.entry.shell.entry\nsay "BEFORE"\nw2.entry.shell.entry.f=hostValue',
  ),
  witness("1645-copy", 'let a = {f: [[1]]}\nlet b = a\nsay "BEFORE"\nb.f = hostValue'),
  witness("1645-open", "let a = {f: []}\nlet b = a\nb.f = hostValue", { hostValue: 5 }),
];

function compiled(
  source: string,
  demand: number | null,
): ReturnType<typeof compileSourceWithBackend> {
  const once = () => compileSourceWithBackend(source, { globals: GLOBALS }, CORE_BACKEND);
  return demand === null ? once() : withTestDemandAllowance(demand, once);
}

const said = (run: ReturnType<typeof runGlobals>): boolean =>
  run.said.some((at) => at.text === "AFTER");
// (forbidden input passes when the run reaches AFTER, and where the witness shows its value, shows the forbidden text:
// a typed parse or load that rejects its input takes its default and goes on)
const passes = (source: string, run: ReturnType<typeof runGlobals>): boolean =>
  said(run) && (!source.includes("toJson") || run.said.some((at) => at.text.includes('"x"')));

test("a program whose required check a settled stop lost is declined at its store, in four modes (#1526 decision 2, condition 1)", () => {
  for (const mode of MODES)
    for (const { name, source, forbidden, at, storage } of DECLINED) {
      const where = `${name} (mode ${JSON.stringify(mode)})`;
      // (natural: no stop, no registry, nothing declined; the natural compile or its plan rejects the forbidden input)
      const natural = inMode(mode, () => compiled(source, null));
      if (natural.plan !== null)
        assert.equal(
          passes(source, runGlobals(natural.plan, forbidden, storage)),
          false,
          `${where}: the natural plan rejects`,
        );
      assert.throws(
        () => inMode(mode, () => compiled(source, 16)),
        // (the gate at the store's value; rule (R) at the typed call inside it)
        (error) =>
          error instanceof CandidateOutsideSlice &&
          source.indexOf(at) === source.lastIndexOf(at) &&
          (error.what === LOST
            ? error.site.start === source.indexOf(at)
            : error.what === OPEN_BY_STOP && error.site.start >= source.indexOf(at)),
        where,
      );
    }
});

test("a stopped program whose required checks are all published with their contracts compiles and rejects forbidden input", () => {
  for (const mode of MODES)
    for (const { name, source, forbidden } of PUBLISHED) {
      const where = `${name} (mode ${JSON.stringify(mode)})`;
      const stopped = inMode(mode, () => compiled(source, 16));
      assert.ok(stopped.plan !== null, where);
      assert.equal(said(runGlobals(stopped.plan, forbidden)), false, `${where}: the check stands`);
    }
});

test("a stopped program whose checks its complete store check or a typed reader keeps compiles (#1526 decision 2, condition 1)", () => {
  // (from the set: a typed parse whose reader carries its default's contract, at demand 16)
  const kept: readonly (readonly [string, number, readonly (typeof MODES)[number][]])[] = [
    ['let x = fromJson("{}", default: {n: 1})\nsay x\nexit\n', 16, MODES],
  ];
  for (const [source, demand, modes] of kept)
    for (const mode of modes)
      assert.ok(inMode(mode, () => compiled(source, demand)).plan !== null, JSON.stringify(mode));
});

test("a stopped mark whose completion result was lost or is absent is kept by a complete store check that carries it: the plan publishes and fails at the store (#2080)", () => {
  // (in source order with sharing, demands 1 and 22: the completion's results are lost, and `t`'s complete store checks,
  // from the written type `t` copies, carry them; the plan publishes and rejects `[["bad"]]` at its store, Codex r2)
  const source =
    'let seed: integer[][] = [[1]]\nlet t = seed\nsay "BEFORE"\nt = [["bad"]]\nsay "AFTER"\nexit\n';
  for (const demand of [1, 22]) {
    const stopped = inMode(MODES[0]!, () => compiled(source, demand));
    assert.ok(stopped.plan !== null, `demand ${demand}`);
    const run = runGlobals(stopped.plan, {});
    assert.equal(said(run), false, `demand ${demand}`);
    const at = source.indexOf('[["bad"]]');
    assert.equal(run.failure, `TSR058@${at}:${at + '[["bad"]]'.length}`, `demand ${demand}`);
  }
  // (at this work allowance the completion is capped and keeps no result: the stopped marks have none, and the same store
  // checks carry them; Codex r3)
  const stopped = inMode(MODES[0]!, () => withTestAllowance(1536, () => compiled(source, 1)));
  assert.ok(stopped.plan !== null);
  const run = runGlobals(stopped.plan, {});
  assert.equal(said(run), false);
  const at = source.indexOf('[["bad"]]');
  assert.equal(run.failure, `TSR058@${at}:${at + '[["bad"]]'.length}`);
});

test("a stopped mark is kept by its part checks only where each carries the completed contract there: a weaker element declines (#2080)", () => {
  // (in source order with sharing, demand 16: the completion completes `{f: list<integer>, g: string}` at the store and
  // owes it there, and the published part checks are `.f` against an open list and `.g` against `string`; the weaker one
  // carries nothing, so the program declines at the store, where accepting any one part would run `["x"]` through)
  const source = 'let a = {f: [1], g: "s"}\na = {f: hostValue, g: hostOther}\nsay "AFTER"\nexit\n';
  const forbidden = { hostValue: list(["x"]), hostOther: "t" };
  const natural = inMode(MODES[0]!, () => compiled(source, null));
  assert.equal(said(runGlobals(natural.plan!, forbidden)), false);
  assert.throws(
    () => inMode(MODES[0]!, () => compiled(source, 16)),
    (error) =>
      error instanceof CandidateOutsideSlice &&
      error.what === LOST &&
      error.site.start === source.indexOf("{f: hostValue"),
  );
});

test("a stopped mark whose completion result a rejection lost declines at its store: a typed-copy cycle (#2080)", () => {
  // (at demand 64 in source order without sharing, every completion result is lost by the rejection, the stopped marks'
  // too, and none of them has a complete store check: the program declines at its first, `m1`'s literal; a certificate
  // that a copy of a checked place owes nothing would let it publish, #2131)
  const source =
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vs,g:0}\nlet m1={f:vi,g:0}\nlet m2={f:vi,g:0}\nm1=m0\nm2=m1\nm0=m2\nlet final=[m0,m1]\nexit\n';
  assert.throws(
    () => inMode(MODES[1]!, () => compiled(source, 64)),
    (error) =>
      error instanceof CandidateOutsideSlice &&
      error.what === LOST &&
      error.site.start === source.indexOf("{f:vi,g:0}"),
  );
});

test("a program whose receiving completion reached its allowance keeps a check only by its complete store check (Codex r2)", () => {
  // (in source order with sharing, demand 16: the completion caps and keeps no result; the plan is the settled pass's,
  // which checks the host store against nothing where the natural plan checks every field)
  const source = `let pad={f0:1}\n${lines(16, (at) => `pad={f${at}:${at}}`)}\npad=hostOther${END}`;
  const forbidden = { hostOther: object({ f0: "x" }) };
  const natural = compiled(source, null);
  assert.equal(said(runGlobals(natural.plan!, forbidden)), false);
  assert.throws(
    () => inMode(MODES[0]!, () => compiled(source, 16)),
    (error) => error instanceof CandidateOutsideSlice && error.what === LOST,
  );
});

test("a check published against nothing where the natural plan checks a domain is lost: the open control at demand 32 (#1526)", () => {
  // (the natural plan checks `b.f` against `list`, so `5` fails there; at demand 32 in source order the stopped plan
  // would carry no check at the store, and the program is declined)
  const { source } = PUBLISHED.find((entry) => entry.name === "1645-open")!;
  for (const mode of MODES.filter((each) => !each.reversed)) {
    const natural = inMode(mode, () => compiled(source, null));
    assert.notEqual(runGlobals(natural.plan!, { hostValue: 5 }).failure, null);
    assert.throws(
      () => inMode(mode, () => compiled(source, 32)),
      (error) => error instanceof CandidateOutsideSlice && error.what === LOST,
      JSON.stringify(mode),
    );
  }
});

test("a program the analysis rejects is rejected, not declined, whatever check a stop lost", () => {
  const source = `let z: integer = "s"\n${DECLINED[0]!.source}`;
  for (const mode of MODES) {
    const stopped = inMode(mode, () => compiled(source, 16));
    assert.equal(stopped.plan, null, JSON.stringify(mode));
    assert.ok(
      stopped.diagnostics.some((diagnostic) => diagnostic.severity === "error"),
      JSON.stringify(mode),
    );
  }
});

test("a reader keeps a contract it is at least as strict as, never one it is weaker than on any dimension", () => {
  // (on the public route a reader weaker in an element or a union member comes with the store's complete check, which
  // keeps the obligation; the reader's own comparison is pinned here)
  const int = { kind: "integer" } as const;
  const listOf = (element: TypePlan | null): TypePlan => ({ kind: "list", element });
  const objectOf = (properties: Record<string, TypePlan>): TypePlan => ({
    kind: "object",
    properties: Object.entries(properties).map(([name, type]) => ({ name, type })),
  });
  const anyOrNull: TypePlan = {
    kind: "union",
    members: [int, { kind: "string" }, { kind: "null" }],
  };
  for (const [reader, contract, kept] of [
    [objectOf({ n: listOf(int), m: int }), objectOf({ n: listOf(int) }), true],
    [objectOf({ n: int }), objectOf({}), true],
    [listOf(int), listOf(null), true],
    [int, { kind: "union", members: [int, { kind: "null" }] }, true],
    // (a listed property missing, an element untyped, a union member that does not fit)
    [objectOf({}), objectOf({ n: listOf(int) }), false],
    [listOf(null), listOf(listOf(int)), false],
    [objectOf({ n: anyOrNull }), objectOf({ n: int }), false],
  ] as const)
    assert.equal(
      narrower(reader, contract),
      kept,
      `${JSON.stringify(reader)} against ${JSON.stringify(contract)}`,
    );
});

test("a settled stop's check from the receiving completion lists an object's properties by the store's own records, so a value with several misfits reads the natural message at every stopped allowance (#2215)", () => {
  // (Sol round 13's witness on #2116: five whole stores into `root`, reads that pay for their decisions under a host
  // condition false when the script runs, then the host value stored whole, the first store to ask for `root`'s contract.
  // At each demand in held mode 0 a decision stops and the analysis settles. Where the store's check takes the receiving
  // completion's contract, whose listings found `root`'s properties last first (main reads `.f4.n` at 4 to 45), it lists
  // them by the store's own records, then as the program first writes them, `f1` first, as the natural check does. The
  // runtime names, shows and advises on the first property that does not fit: `.f1`'s text, not `.f4.n`'s.)
  const source = [
    "let value:integer=1",
    "let u={f1:{n:value}}",
    'u={g:"s"}',
    "let root={f0:{n:value}}",
    ...[1, 2, 3, 4].map((at) => `root={f${at}:{n:value}}`),
    "if hostOther is integer {",
    ...Array.from({ length: 10 }, (_, at) => `let r${at}=root.f${at % 5}.n`),
    "}",
    "root=hostValue",
    'say "accepted"',
    "exit",
  ].join("\n");
  const fields: readonly SerializableRuntimeValue[] = [
    null,
    "s",
    true,
    1,
    createSerializableObject([{ name: "n", value: "2" }]),
  ];
  const globals = {
    hostValue: createSerializableObject(fields.map((value, at) => ({ name: `f${at}`, value }))),
    hostOther: false,
  };
  const held = HELD_MODES[0]!;
  const compiled = (demand: number | null) =>
    held.run(() =>
      demand === null
        ? compileSourceWithBackend(source, { globals: GLOBALS }, CORE_BACKEND)
        : withTestDemandAllowance(demand, () =>
            compileSourceWithBackend(source, { globals: GLOBALS }, CORE_BACKEND),
          ),
    );
  const failure = (plan: InstructionPlan | null) => {
    assert.ok(plan !== null);
    const result = run(plan, createImmediatePacingRuntimeSnapshot(plan, { globals }));
    const failed = result.events.find((event) => event.kind === "runtimeFailure");
    return failed?.kind === "runtimeFailure"
      ? [failed.code, failed.span.start.offset, failed.span.end.offset, failed.message]
      : null;
  };
  const natural = failure(compiled(null).plan);
  assert.equal(natural?.[0], "TSR058");
  for (const demand of [4, 20, 36, 45, 133]) {
    const { budget } = held.run(() =>
      withTestDemandAllowance(demand, () =>
        analyseCore(coreRequest([{ path: "main.tease", source }], GLOBALS)!),
      ),
    );
    assert.equal(budget.settled, true, `demand ${demand}`);
    assert.ok(
      budget.decisions.some((decision) => decision.stopped),
      `demand ${demand}`,
    );
    assert.deepEqual(failure(compiled(demand).plan), natural, `demand ${demand}`);
  }
});

// #2080 part 2, the owner's decision (no inference after the stop): before admission settled, each own mark the stop left
// against `unknown` owes a check no completion decided, and the first that no complete store check carries declines the
// program at its store.
const UNDECIDED = "a store whose check was left undecided at the budget";

/** A compile of `source` at program allowance 1, where the analysis stops before admission settles, in `mode`. */
const atFirstUnit = (source: string, mode: (typeof MODES)[number]) =>
  inMode(mode, () =>
    withTestAllowance(1, () =>
      compileSourceWithBackend(source, { globals: GLOBALS }, CORE_BACKEND),
    ),
  );

test("before admission settled a store into an inferred place declines at its store, where the natural plan rejects the forbidden value it would run (#2080 part 2)", () => {
  const source = `let n = 1\nn = hostValue${END}`;
  const request = coreRequest([{ path: "main.tease", source }], GLOBALS);
  assert.ok(request !== null);
  for (const mode of MODES) {
    const where = JSON.stringify(mode);
    const natural = inMode(mode, () => compiled(source, null));
    assert.ok(natural.plan !== null, where);
    assert.equal(said(runGlobals(natural.plan, { hostValue: "bad" })), false, where);
    const stopped: Answers = inMode(mode, (): Answers =>
      withTestAllowance(1, () => analyseCore(request)),
    );
    const { budget } = stopped;
    assert.deepEqual([budget.exhausted, budget.settled], ["work", false], where);
    assert.throws(
      () => atFirstUnit(source, mode),
      (error) =>
        error instanceof CandidateOutsideSlice &&
        error.what === UNDECIDED &&
        error.limit &&
        error.site.start === source.indexOf("1"),
      where,
    );
  }
});

test("before admission settled a program whose stores are all into written places publishes, its checks and a host read's boundary rejecting forbidden input (#2080 part 2)", () => {
  for (const [source, fitting, forbidden] of [
    [`let n: integer = 1\nn = hostValue${END}`, { hostValue: 2 }, { hostValue: "bad" }],
    [
      `say hostValue\nlet n: integer = hostOther${END}`,
      { hostValue: 2, hostOther: 2 },
      { hostValue: 2, hostOther: "bad" },
    ],
  ] as const)
    for (const mode of MODES) {
      const where = `${source} (mode ${JSON.stringify(mode)})`;
      const { plan } = atFirstUnit(source, mode);
      assert.ok(plan !== null, where);
      assert.equal(said(runGlobals(plan, fitting)), true, where);
      assert.equal(said(runGlobals(plan, forbidden)), false, where);
    }
});

/**
 * The limit marker (the owner's go, 2026-11-10): a decline the budget causes carries `limit`, one the slice does not cover
 * yet does not. A compile for each reason a compile reaches; "a store whose required checks could not be established at
 * the budget" has none (`Answers.gated()` gives `null` only at a settled stop with no seed, which admission saves before
 * anything of it can stop), so its marker is read off the error as the route builds it.
 */
test("a decline the budget causes carries the limit marker, one the slice does not cover yet does not (#2080 part 2)", () => {
  const mode = MODES[0]!;
  const reasonOf = (make: () => unknown): CandidateOutsideSlice => {
    try {
      make();
    } catch (error) {
      assert.ok(error instanceof CandidateOutsideSlice, String(error));
      return error;
    }
    assert.fail("published");
  };
  const typed = `let d = {m: 1}\nlet result = fromJson(hostValue, default: {n: d}, files: false)\nsay result.n.m${END}`;
  const lost = DECLINED.find((each) => each.name === "1645-whole-object")!.source;
  for (const [what, error] of [
    [OPEN_BY_STOP, reasonOf(() => atFirstUnit(typed, mode))],
    [LOST, reasonOf(() => inMode(mode, () => compiled(lost, 16)))],
    [UNDECIDED, reasonOf(() => atFirstUnit(`let n = 1\nn = hostValue${END}`, mode))],
    [
      "a store whose required checks could not be established at the budget",
      new CandidateOutsideSlice(
        "main.tease",
        { file: 0, start: 0, end: 1 },
        "a store whose required checks could not be established at the budget",
      ),
    ],
  ] as const)
    assert.deepEqual([error.what, error.limit], [what, true]);
  const outside = reasonOf(() => compiled(`function f {\n  say 1\n}\nf()${END}`, null));
  assert.equal(outside.limit, false, outside.what);
});
