import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { compileProject, compileProjectWithBackend, compileSource } from "../../../src/compiler.js";
import type { TypeAnalysisRequest, TypeCheckResult } from "../../../src/type-inference/backend.js";
import { analyseCore } from "../../../src/type-inference/core/answers.js";
import { CandidateOutsideSlice, CORE_BACKEND } from "../../../src/type-inference/core/backend.js";
import { withTestAllowance } from "../../../src/type-inference/core/budget.js";
import { checkedResult } from "../../../src/type-inference/core/check-result/check-result.js";
import { coreRecord } from "../../../src/type-inference/core/result.js";
import { type CoreAnalysisRequest } from "../../../src/type-inference/core/program.js";
import { analyzeTypes } from "../../../src/type-inference/index.js";
import { toMonacoMarkers } from "../../../src/editor/monaco-mapping.js";
import { coreRequest } from "../../helpers/type-core-analysis.js";
import { readFixture } from "../../helpers/type-core/type-core-fixture.js";
import { inMode, MODES } from "../../helpers/type-core-oracles.js";
import {
  OPTIONS,
  candidate,
  insideSlice,
  sited,
  inBothOrders,
  inBothOrdersAs,
  runWith,
  checksOf,
} from "../../helpers/type-core/type-core-candidate-setup.js";

// The coarse core on the test-only candidate route (the port plan's S5): source, candidate compile, plan, runtime.

/** The plain gate's decline (#2080 part 2): a stop before admission settled left a store's check undecided. */
const UNDECIDED = "a store whose check was left undecided at the budget";

test("the candidate hears of each file it walks, as the production default does", () => {
  const request = coreRequest([
    { path: "main.tease", source: "let first = 1\nexit\n" },
    { path: "other.tease", source: "let other = 2\nexit\n" },
  ]);
  assert.ok(request !== null);
  const heard = (backend?: typeof CORE_BACKEND): number[] => {
    const files: number[] = [];
    analyzeTypes({ ...request, onFile: (file) => files.push(file) }, backend);
    return files;
  };
  assert.deepEqual(heard(), [0, 1]);
  assert.deepEqual(heard(CORE_BACKEND), [0, 1]);
});

test("a program outside the slice throws at its first construct outside it", () => {
  for (const [source, offset] of [
    // a statement outside the slice
    ["let total = 0\nwhile false {\n  total = 1\n}\nexit\n", 14],
    // another consumer: a condition that is no boolean (C3)
    ['if 1 {\n  say "never"\n}\nexit\n', 3],
    // lists nested as deep as the facts' walk (256 levels), inferred or written
    [
      `let a = ${"[".repeat(256)}1${"]".repeat(256)}\na = ${"[".repeat(256)}"bad"${"]".repeat(256)}\nexit\n`,
      4,
    ],
    [`let a: integer${"[]".repeat(256)} = []\nexit\n`, 7],
  ] as const) {
    assert.throws(
      () => candidate(source),
      (error) =>
        error instanceof CandidateOutsideSlice &&
        error.path === "main.tease" &&
        error.site.file === 0 &&
        error.site.start === offset,
      source,
    );
  }
});

test("the candidate's side outputs follow the flow graph's literal facts and the kept checks", () => {
  const source =
    'if true {\n  say "a"\n} else {\n  say "b"\n}\nrepeat 0 {\n  say "c"\n}\nrepeat 1 {\n  exit\n}\nsay "d"\nexit\n';
  const request = coreRequest([{ path: "main.tease", source }]);
  assert.ok(request !== null);
  const checked: TypeCheckResult = CORE_BACKEND.analyze(request).checked;
  assert.deepEqual(
    [...checked.ways.paths].map(([statement, ways]) => [statement.span.start.offset, ...ways]),
    [
      [0, true, false],
      [41, false, true],
      [64, true, false],
    ],
  );
  assert.deepEqual(
    [...checked.unreachable]
      .map((statement) => `${statement.kind}@${statement.span.start.offset}`)
      .sort(),
    ["exitStatement@92", "sayStatement@31", "sayStatement@54", "sayStatement@84"],
  );
  // the checks after the plan read them as they read the production default's: the same warnings
  assert.deepEqual(sited(candidate(source)), sited(compileSource(source, OPTIONS)));

  // the kept checks the slice reaches: a known repeat count the runtime cannot count, a message's markup colour
  const large = candidate("let n = 9007199254740992\nrepeat n {}\nexit\n");
  assert.deepEqual(sited(large), ["error TSV011@32"]);
  assert.match(large.diagnostics[0]!.message, /Use a smaller count\.$/);
  assert.deepEqual(sited(candidate('say "[color=bad]x[/color]"\nexit\n')), ["error TSC008@4"]);
});

/**
 * The lead's decision 3 on #1072 (Astra's G3): a check that owes the runtime nothing is a diagnostic of its own kind,
 * published in the core's record with its site alone and no obligation, its sentence composed from its rule, and read
 * alike by the record and the compiler: the record's every diagnostic is the compiler's, at the same span and severity,
 * with the sentence `coreMessage` gives it; a warning with a runtime check beside it keeps its obligation and its check.
 */
test("a check that owes the runtime nothing is published in the record and by the compiler alike, with no obligation (decision 3 on #1072)", () => {
  const source =
    'let n = toInteger("-2", default: 0)\nlet m: integer = hostValue\nrepeat n {}\nsay toNumber("1,5", default: m)\nexit\n';
  const request = coreRequest([{ path: "main.tease", source }], ["hostValue"]);
  assert.ok(request !== null);
  const { record, compiled } = inBothOrdersAs(
    () => ({
      record: coreRecord(checkedResult(analyseCore(request), request), ["main.tease"]),
      compiled: candidate(source),
    }),
    ({ record, compiled }) => ({
      record,
      compiled: compiled.diagnostics.map((d) => [
        d.severity,
        d.code,
        d.span.start.offset,
        d.span.end.offset,
      ]),
    }),
  )[1];
  const at = (text: string, from = 0): readonly [number, number] => {
    const start = source.indexOf(text, from);
    return [start, start + text.length];
  };
  assert.equal(record.outcome, "compile-error");
  assert.deepEqual(
    record.diagnostics.map((d) => [d.class, d.kind, d.site.offset, d.site.end, "obligation" in d]),
    [
      // (the analysis's own diagnostics first, then the checks that owe nothing, each in its source order)
      ["warning-runtime-check", "written-target", ...at("hostValue"), true],
      ["compile-error", "static", ...at("n", source.indexOf("repeat")), false],
      ["compile-error", "static", ...at('"1,5"'), false],
    ],
  );
  // the warning's check and the boundary's, nothing for the checks that owe nothing
  assert.deepEqual(
    record.runtimeChecks.map((check) => [
      check.kind,
      check.target,
      check.boundary === true,
      check.site.offset,
    ]),
    [
      ["copy-type", "m", false, source.indexOf("hostValue")],
      ["copy-type", "m", true, source.indexOf("hostValue")],
    ],
  );
  // the compiler reports each at the record's span and severity
  assert.deepEqual(compiled, [
    ["warning", "TSV041", ...at("hostValue")],
    ["error", "TSV011", ...at("n", source.indexOf("repeat"))],
    ["error", "TSV043", ...at('"1,5"')],
  ]);
  const messages = candidate(source).diagnostics.map((d) => d.message);
  assert.equal(
    messages[1],
    "A repeat count must be a whole number (integer) of at least 0, but this is -2. Check that it is at least 0 first.",
  );
  assert.match(
    messages[2]!,
    /^toNumber\(\.\.\.\) cannot convert text \(string\) "1,5" to a number/,
  );
});

/**
 * The seam's ordinary warning (decision 3 on #1072): a check that owes the runtime nothing but warns, here V30 §6's
 * written range that holds no number, is a warning in the record and the compiler alike, the outcome `warning` alone and
 * a runtime check's warning beside it the worse; it owes no check, so the plan's checks are the other warning's, and the
 * editor marks it a warning as any other.
 */
test("an ordinary warning owes no check: its record, its compile, its plan and its editor marker (decision 3 on #1072)", () => {
  const alone = "for i in 3..1 {\n  say i\n}\nexit\n";
  const request = coreRequest([{ path: "main.tease", source: alone }]);
  assert.ok(request !== null);
  const record = coreRecord(checkedResult(analyseCore(request), request), ["main.tease"]);
  assert.deepEqual(record, {
    outcome: "warning",
    diagnostics: [
      { class: "warning", kind: "static", site: { file: "main.tease", offset: 9, end: 13 } },
    ],
    runtimeChecks: [],
  });
  const beside = `${alone.replace("exit\n", "")}let m: integer = hostValue\nsay "after"\nexit\n`;
  const besideRequest = coreRequest([{ path: "main.tease", source: beside }]);
  assert.ok(besideRequest !== null);
  const both = coreRecord(checkedResult(analyseCore(besideRequest), besideRequest), ["main.tease"]);
  assert.equal(both.outcome, "warning-runtime-check");
  assert.deepEqual(
    both.runtimeChecks.map((check) => `${check.kind} ${check.target}`),
    ["copy-type m", "copy-type m"],
  );
  const compiled = inBothOrders(() => candidate(beside));
  assert.deepEqual(sited(compiled), [
    "warning TSV046@9",
    `warning TSV041@${beside.indexOf("hostValue")}`,
  ]);
  assert.equal(
    compiled.diagnostics[0]!.message,
    "This range contains no numbers, so the loop never runs: a range never counts down. Write '1..3' to count up.",
  );
  assert.deepEqual(checksOf(compiled.plan!), [
    `${beside.indexOf("let m")}:${beside.indexOf("\nsay")} integer`,
  ]);
  assert.deepEqual(runWith(compiled.plan!, 2), {
    status: "halted",
    says: ["after"],
    failure: null,
  });
  assert.deepEqual(
    toMonacoMarkers(compiled.diagnostics, { Error: 8, Warning: 4, Info: 2 }).map(
      (marker) => `${marker.code} ${marker.severity}`,
    ),
    ["TSV046 4", "TSV041 4"],
  );
});

test("the candidate's facts list every binding, read and value of the program with the core's types", () => {
  const request = coreRequest([
    {
      path: "main.tease",
      source: "let n: integer = 1\nlet xs = [1, 2.5]\nrepeat xs[0] {}\nexit\n",
    },
  ]);
  assert.ok(request !== null);
  const facts = CORE_BACKEND.analyze(request).facts();
  const at = (start: number, end: number) => ({ file: 0, start, end });
  assert.deepEqual(facts.bindings, [
    { site: at(0, 18), kind: "letStatement", name: "n", type: "integer" },
    // A3: the settled family of the elements
    { site: at(19, 36), kind: "letStatement", name: "xs", type: "list<number>" },
  ]);
  assert.deepEqual(facts.reads, [{ site: at(44, 46), name: "xs", binding: at(19, 36) }]);
  assert.deepEqual(
    facts.values.map((value) => [value.site.start, value.kind, value.type]),
    [
      [17, "numberLiteral", "integer"],
      [28, "listLiteral", "list<number>"],
      [29, "numberLiteral", "integer"],
      [32, "numberLiteral", "number"],
      [44, "identifier", "list<number>"],
      // F12: an element read takes the element's contract, the family of both
      [44, "indexExpression", "number"],
      [47, "numberLiteral", "integer"],
    ],
  );
  assert.deepEqual(
    [facts.functions, facts.speakers, facts.uncheckedProperties, facts.storage],
    [[], [], [], []],
  );

  // one level less than the walk: complete to the element kind
  const deep = coreRequest([
    { path: "main.tease", source: `let a = ${"[".repeat(255)}1${"]".repeat(255)}\nexit\n` },
  ]);
  assert.ok(deep !== null);
  assert.equal(
    CORE_BACKEND.analyze(deep).facts().bindings[0]!.type,
    `${"list<".repeat(255)}integer${">".repeat(255)}`,
  );

  // parentheses, nested element reads and a kind without parts keep their whole types
  const shapes = coreRequest([
    {
      path: "main.tease",
      source:
        "let a = (1)\nlet b = [(2)]\nlet c = [[[[3]]]][0]\nlet r: range = hostValue\nlet q: range = r\nexit\n",
    },
  ]);
  assert.ok(shapes !== null);
  const shaped = CORE_BACKEND.analyze(shapes);
  assert.deepEqual(sited({ diagnostics: shaped.checked.diagnostics.flat() }), [
    "warning TSV041@62",
  ]);
  const typed = shaped.facts();
  assert.deepEqual(
    typed.bindings.map((binding) => `${binding.name}: ${binding.type}`),
    ["a: integer", "b: list<integer>", "c: list<list<list<integer>>>", "r: range", "q: range"],
  );
  assert.deepEqual(
    typed.values
      .filter((value) =>
        ["parenthesizedExpression", "indexExpression", "identifier"].includes(value.kind),
      )
      .map((value) => `${value.site.start} ${value.kind} ${value.type}`),
    [
      "8 parenthesizedExpression integer",
      "21 parenthesizedExpression integer",
      "34 indexExpression list<list<list<integer>>>",
      "62 identifier unknown",
      "87 identifier range",
    ],
  );
});

test("a program the work allowance stops, in its analysis or after it, compiles with the stop's warning and its checks (D4 a′)", () => {
  // (its stores all written: a stop before admission settled leaves no store's check undecided, #2080 part 2)
  const source =
    "let xs: integer?[] = [hostValue, null, 7]\nlet n: integer = 1\nrepeat n {}\nexit\n";
  const request = coreRequest([{ path: "main.tease", source }]);
  assert.ok(request !== null);
  const ends = new Set<string>();
  for (let allowance = 20; allowance <= 4_000; allowance += 20) {
    const outcome = insideSlice(() =>
      withTestAllowance(allowance, () => CORE_BACKEND.analyze(request)),
    );
    assert.ok(outcome !== null, `${allowance}: never outside the slice for its size`);
    assert.doesNotThrow(() => outcome.facts(), String(allowance));
    const codes = outcome.checked.diagnostics.flat().map((d) => `${d.severity} ${d.code}`);
    assert.ok(!codes.some((code) => code.startsWith("error")), `${allowance}: no compile error`);
    ends.add(codes.includes("warning TSV076") ? "stopped" : "analysed");
    // the written store's check, the warning's or the stop's
    assert.ok(
      [...outcome.checked.runtimeChecks.keys()].some(
        (site) => site.kind === "letStatement" && site.name.name === "xs",
      ),
      `${allowance}: the check of 'xs'`,
    );
  }
  assert.deepEqual([...ends].sort(), ["analysed", "stopped"]);
  // the same program with `n` inferred: a stop before admission settled leaves its store's check undecided, and the
  // plain gate declines it there and nowhere else (#2080 part 2)
  const inferredRequest = coreRequest([
    { path: "main.tease", source: source.replace("n: integer", "n") },
  ]);
  assert.ok(inferredRequest !== null);
  const inferred: CoreAnalysisRequest = inferredRequest;
  let declined = 0;
  for (let allowance = 20; allowance <= 4_000; allowance += 20) {
    const { exhausted, settled } = withTestAllowance(allowance, () => analyseCore(inferred)).budget;
    let what: string | null = null;
    try {
      withTestAllowance(allowance, () => CORE_BACKEND.analyze(inferred));
    } catch (error) {
      if (!(error instanceof CandidateOutsideSlice)) throw error;
      what = error.what;
    }
    const unsettled = exhausted !== null && !settled;
    assert.equal(what, unsettled ? UNDECIDED : null, String(allowance));
    if (unsettled) declined += 1;
  }
  assert.ok(declined > 0, `${declined} declined`);
});

/** A type check result as JSON-safe data, its syntax keys by their spans. */
function checkedData(checked: TypeCheckResult): string {
  const span = (node: {
    readonly span: { readonly start: { offset: number }; readonly end: { offset: number } };
  }): string => `${node.span.start.offset}:${node.span.end.offset}`;
  return JSON.stringify({
    diagnostics: checked.diagnostics,
    runtimeChecks: [...checked.runtimeChecks].map(([site, plan]) => [span(site), plan]),
    formShapes: [...checked.formShapes].map(([site, shape]) => [span(site), shape]),
    paths: [...checked.ways.paths].map(([site, ways]) => [span(site), ways]),
    operands: [...checked.ways.operands],
    unreachable: [...checked.unreachable].map(span),
    speakerFlow: [[...checked.speakerFlow.reads], [...checked.speakerFlow.stores]],
    storageTypes: checked.storageTypes,
  });
}

test("the legacy analysis gives the same result with and without each file's source and picks", () => {
  let compared = 0;
  for (const [position, record] of readFixture().entries()) {
    if (position % 4 !== 0) continue;
    // separate parses, so that nothing one analysis keeps on the syntax reaches the other
    const withInput = coreRequest(record.files);
    const without = coreRequest(record.files);
    if (withInput === null || without === null) continue;
    const plain: TypeAnalysisRequest = {
      ...without,
      files: without.files.map(({ path, program }) => ({ path, program })),
    };
    const full = analyzeTypes(withInput);
    const bare = analyzeTypes(plain);
    assert.equal(checkedData(full.checked), checkedData(bare.checked), record.name);
    assert.equal(JSON.stringify(full.facts()), JSON.stringify(bare.facts()), record.name);
    compared += 1;
  }
  assert.ok(compared > 300, `${compared} records compared`);
});

/** The TypeScript, JavaScript and Vue sources under `directory`, without built or installed code. */
function sourcesUnder(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    if (name === "node_modules" || name === "dist") return [];
    const path = join(directory, name);
    if (statSync(path).isDirectory()) return sourcesUnder(path);
    return /\.(ts|mts|js|mjs|vue)$/.test(name) ? [path] : [];
  });
}

test("the route ends at the refusal its capture establishes, at the store whose contract leaves the slice's depth, and a deep program still plans (#1073)", () => {
  // (graph/251 of the corpus behind a store whose contract the capture finds first: the capture's second request leaves
  // the slice's depth at the store `a=b`, where the route now refuses, about 28 million units in, before the walk; the
  // lowering would have refused at `let b=foreign`'s read after the whole analysis, about 58 million. In the first mode
  // alone in CI: every mode is the PR's queue evidence)
  const source =
    'let n:integer=1\nn=hostValue\nlet typed:object={x:1}\nlet num:integer=1\nlet text:string="x"\nlet root={f:typed,g:num}\nlet foreign={f:hostValue,g:text}\nlet a=root\nlet b=foreign\nlet c=root\na.q=b\nif hostValue is integer {a=b}\nb=a\nb=a\nlet out={p:c}\nexit\n';
  assert.throws(
    () => candidate(source),
    (error) =>
      error instanceof CandidateOutsideSlice &&
      error.what === "a value whose structure the slice does not follow" &&
      error.site.start === source.indexOf("a=b}") + 2,
  );
  // (no refusal at a work count: Sol's deep control, 169 syntax nodes, plans at about 1.4 million units, far past any
  // proportional cap of its size, in source order. In reverse order the work allowance stops it before admission
  // settled: the plain gate declines its inferred copy `out`, #2080 part 2, a decline for size that rule 1.10's
  // re-assessment decides; with `out` written it plans there with its stop's warning)
  const deep = `if hostValue is integer {}\nlet typed:integer${"[]".repeat(128)}=hostValue\nlet out=typed\n${"out=typed\n".repeat(8)}out=hostValue\nexit\n`;
  const written = deep.replace("let out=", `let out:integer${"[]".repeat(128)}=`);
  for (const mode of MODES)
    if (!mode.reversed)
      assert.notEqual(inMode(mode, () => candidate(deep)).plan, null, JSON.stringify(mode));
    else {
      assert.throws(
        () => inMode(mode, () => candidate(deep)),
        (error) => error instanceof CandidateOutsideSlice && error.what === UNDECIDED,
        JSON.stringify(mode),
      );
      const compiled = inMode(mode, () => candidate(written));
      assert.notEqual(compiled.plan, null, JSON.stringify(mode));
      assert.ok(
        compiled.diagnostics.some((d) => d.code === "TSV076" && d.severity === "warning"),
        JSON.stringify(mode),
      );
    }
});

test("no production code selects the core: only tests reach the candidate entry", () => {
  const root = process.cwd();
  for (const directory of ["src", "playground", "player", "tools"])
    for (const file of sourcesUnder(join(root, directory))) {
      const relative = file.slice(root.length + 1);
      // The runtime pipeline oracle is test tooling, never shipped, run on demand outside CI: its runner compiles on
      // both routes of a frozen build (docs/TESTING.md "Runtime pipeline oracle"; its core-route call: #2680).
      if (relative.startsWith("tools/runtime-oracle/")) continue;
      const text = readFileSync(file, "utf8");
      if (relative !== "src/compiler.ts")
        assert.ok(!/compile(Source|Project)WithBackend\s*\(/.test(text), relative);
      if (!relative.startsWith("src/type-inference/core/"))
        assert.ok(!/core\/backend\.js|CORE_BACKEND/.test(text), relative);
    }
  // the root compilers pass no backend: their result is the production default's
  const project = [{ path: "main.tease", source: "let n: integer = hostValue\nexit\n" }];
  assert.deepEqual(sited(compileProject(project, OPTIONS)), []);
  assert.deepEqual(sited(compileProjectWithBackend(project, OPTIONS, CORE_BACKEND)), [
    "warning TSV041@17",
  ]);
});
