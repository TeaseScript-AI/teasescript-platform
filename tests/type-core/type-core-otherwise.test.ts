import assert from "node:assert/strict";
import test from "node:test";

import type { TypeCheckResult } from "../../src/type-inference/backend.js";
import { CORE_BACKEND } from "../../src/type-inference/core/backend.js";
import { withTestAllowance } from "../../src/type-inference/core/budget.js";
import { analyzeTypes } from "../../src/type-inference/index.js";
import { compactAnalysis, coreRequest } from "../helpers/type-core-analysis.js";
import { MODES, inMode, stopSet } from "../helpers/type-core-oracles.js";
import type { WorkFamily } from "../helpers/type-core/type-core-families.js";
import { steepCounters } from "../helpers/type-core/type-core-work.js";

/** The parts of `stopSet`'s record the C10 stop rows read. */
interface StopRecord {
  readonly serialized: { readonly outcome: string };
  readonly diagnostics: readonly {
    readonly kind: string;
    readonly class: string;
    readonly site: { readonly start: number };
    readonly provenance?: { readonly context?: string | null };
  }[];
  readonly checks: readonly {
    readonly kind: string;
    readonly boundary?: boolean;
    readonly target: string;
    readonly against: readonly string[];
  }[];
}

// #1072 (A59 + A68), V30 §18: the fallbacks of `otherwise` from its first link whose left side is never `null` never
// run (TSV062), decided once from the core's answer at that left read, for the warning and the plan's ways alike.

const GLOBALS = ["hostValue"];

/** A source's TSV062 warnings, as code, span and message, and its `otherwise` ways, by the core and by the legacy. */
function analysed(source: string, mode: (typeof MODES)[number]) {
  const request = coreRequest([{ path: "main.tease", source }], GLOBALS);
  assert.ok(request !== null, source);
  const warnings = (checked: TypeCheckResult) =>
    checked.diagnostics
      .flat()
      .filter((d) => d.code === "TSV062")
      .map((d) => [d.severity, d.span.start.offset, d.span.end.offset, d.message].join(" "));
  const core = inMode(mode, () => CORE_BACKEND.analyze(request).checked);
  const legacy = analyzeTypes(request).checked;
  return { core, legacy, coreWarnings: warnings(core), legacyWarnings: warnings(legacy) };
}

test("a fallback after a value that is never null warns as the current checker does: its site, its sentence and its ways", () => {
  // (the gate's three named witnesses, then chains, parentheses and the read forms V30 §18 names; each a warning the
  // current checker gives, at the same site and in the same words, with the same ways for its fallbacks)
  const sources = [
    "let n = null\nn = 1\nrepeat (n otherwise 2) {}\nexit\n",
    "say (1 otherwise null)\nexit\n",
    "let n = 9\nsay n otherwise 2\nexit\n",
    "let a = 1\nlet x = a otherwise 2 otherwise 3\nsay x\nexit\n",
    'let nickname: string? = null\nlet x = nickname otherwise "pet" otherwise "x"\nsay x\nexit\n',
    "let a = 1\nlet x = (a otherwise 2) otherwise 3\nsay x\nexit\n",
    "let o = {p: 1}\nlet x = o.p otherwise 2\nsay x\nexit\n",
    "let xs = [1, 2]\nlet x = xs[0] otherwise 0\nsay x\nexit\n",
    'let t = "14" otherwise "bad"\nsay toInteger(t, default: 0)\nexit\n',
    // (a possible kind proves as a definite one: a `get` with a default gives a possible whole number)
    "let xs = [1]\nlet x = xs.get(0, default: 2) otherwise 3\nsay x\nexit\n",
  ];
  for (const mode of MODES)
    for (const source of sources) {
      const { core, legacy, coreWarnings, legacyWarnings } = analysed(source, mode);
      assert.ok(legacyWarnings.length > 0, `${source}: the current checker warns`);
      assert.deepEqual(coreWarnings, legacyWarnings, source);
      // (each way the core decides is the current checker's: the fallback never runs, the value always kept)
      for (const [place, ways] of core.ways.operands)
        assert.deepEqual(
          [...ways],
          [...(legacy.ways.operands.get(place) ?? [])],
          `${source}: ${place}`,
        );
      // (and every fallback the current checker finds never runs, the core finds so too)
      for (const [place, ways] of legacy.ways.operands)
        if (ways[0] === false)
          assert.deepEqual(
            [...(core.ways.operands.get(place) ?? [])],
            [...ways],
            `${source}: ${place}`,
          );
      assert.ok(core.ways.operands.size > 0, `${source}: a dead fallback's way`);
    }
});

test("a value that may be null, of unknown type or unread after a stop gets no warning", () => {
  const sources = [
    "let n = null\nlet x = n otherwise 2\nsay x\nexit\n",
    "let x = hostValue otherwise 1\nsay x\nexit\n",
    "let xs = [1, null]\nlet x = xs[0] otherwise 2\nsay x\nexit\n",
  ];
  for (const mode of MODES)
    for (const source of sources) {
      const { core } = analysed(source, mode);
      assert.deepEqual(
        core.diagnostics.flat().filter((d) => d.code === "TSV062"),
        [],
        source,
      );
      assert.equal(core.ways.operands.size, 0, source);
    }
  // (a stopped read proves nothing: at a small allowance the analysis stops before the left side's answer)
  const stopped = "let n = 9\nsay n otherwise 2\nexit\n";
  const request = coreRequest([{ path: "main.tease", source: stopped }], GLOBALS);
  assert.ok(request !== null);
  for (const mode of MODES) {
    const checked = withTestAllowance(1, () =>
      inMode(mode, () => CORE_BACKEND.analyze(request).checked),
    );
    const codes = checked.diagnostics.flat().map((d) => d.code);
    assert.ok(codes.includes("TSV076"), `stopped: ${codes.join(" ")}`);
    assert.ok(!codes.includes("TSV062"), `stopped: ${codes.join(" ")}`);
  }
});

test("a fallback that never runs is still checked: its error stays (ADR 0021 1.8)", () => {
  // (a fallback of another type is a compile error, also where it never runs, V30 §18)
  for (const mode of MODES) {
    const { core } = analysed('let n = 1\nsay n otherwise "x"\nexit\n', mode);
    const codes = core.diagnostics.flat().map((d) => `${d.severity} ${d.code}`);
    assert.ok(
      codes.some((code) => code.startsWith("error")),
      codes.join(" "),
    );
  }
});

/** A source's record as one line: its outcome, its diagnostics (kind, start, error or warning) and its checks. */
function c10Record(source: string): string {
  const request = coreRequest([{ path: "main.tease", source }], GLOBALS);
  assert.ok(request !== null, source);
  const record = compactAnalysis(request);
  return [
    record.outcome,
    record.diagnostics
      .map((d) => `${d.kind}@${d.site.offset}:${d.class === "compile-error" ? "E" : "W"}`)
      .join(" "),
    record.checks
      .map((c) => `${c.kind}${c.boundary ? "B" : ""}:${c.target}[${c.against.join(",")}]`)
      .join(" "),
  ]
    .join(" | ")
    .trimEnd();
}

test("C10 takes a fallback's family from its value's domain where the read cannot (r4.150)", () => {
  // (each cell's record in the four modes; the first group errs at the fallback where main ran it at runtime: a written
  // or retained `T?` of one non-null family, as for `= 1`, at a root, an element, a dict's value, a nested literal, a
  // parameter, a copy and an `otherwise` chain, and `get`'s default; the second group: the controls r4.150 keeps)
  const cells: readonly (readonly [string, string, string])[] = [
    [
      "otherwise/host-one-family",
      'let input: integer? = hostValue\nlet result = input otherwise "bad"\nsay result',
      "compile-error | written-target@22:W written-target@61:E | copy-type:input[integer,null] copy-typeB:input[integer,null]",
    ],
    [
      "otherwise/host-number-wrong",
      'let input: number? = hostValue\nlet result = input otherwise "bad"\nsay result',
      "compile-error | written-target@21:W written-target@60:E | copy-type:input[number,null] copy-typeB:input[number,null]",
    ],
    [
      "otherwise/non-null-written",
      'let input: integer = hostValue\nlet result = input otherwise "bad"\nsay result',
      "compile-error | written-target@21:W written-target@60:E | copy-type:input[integer] copy-typeB:input[integer]",
    ],
    [
      "otherwise/copy-retained",
      'let a: integer? = hostValue\nlet b = a\nlet result = b otherwise "bad"\nsay result',
      "compile-error | written-target@18:W written-target@63:E | copy-type:a[integer,null] copy-typeB:a[integer,null]",
    ],
    [
      "otherwise/mixed-known-host",
      'let choice = askBoolean "?"\nlet input: integer? = 1\nif choice { input = hostValue }\nlet result = input otherwise "bad"\nsay result',
      "compile-error | written-target@72:W written-target@113:E | copy-type:input[integer,null] copy-typeB:input[integer,null]",
    ],
    [
      "otherwise/element",
      'let xs: integer?[] = hostValue\nlet result = xs[0] otherwise "bad"\nsay result',
      "compile-error | written-target@21:W written-target@21:W written-target@60:E | copy-type:xs[list] copy-type:xs.element[integer,null] copy-typeB:xs[list]",
    ],
    [
      "otherwise/dict-value",
      'let d: integer? dict = hostValue\nlet result = d["a"] otherwise "bad"\nsay result',
      'compile-error | written-target@23:W written-target@23:W integer-use@48:W written-target@63:E | copy-type:d[dict] copy-type:d.entry[integer,null] copy-typeB:d[dict] integer-check:"a"[integer]',
    ],
    [
      "otherwise/nested-literal",
      'let input: integer[]? = hostValue\nlet result = input otherwise ["bad"]\nsay result',
      "compile-error | written-target@24:W written-target@24:W written-target@47:W written-target@47:W written-target@64:E | copy-type:input[list,null] copy-type:input.element[integer] copy-typeB:input[list,null] copy-type:result.element[integer] copy-type:result.element[integer]",
    ],
    [
      "otherwise/parameter",
      'function use(input: integer?) { say input otherwise "bad" }\nuse(hostValue)',
      "compile-error | written-target@52:E written-target@64:W | copy-type:use.input[integer,null] copy-typeB:use.input[integer,null]",
    ],
    [
      "otherwise/chain",
      'let a: integer? = hostValue\nlet b: integer? = hostValue\nlet result = a otherwise b otherwise "bad"\nsay result',
      "compile-error | written-target@18:W written-target@46:W written-target@93:E | copy-type:a[integer,null] copy-typeB:a[integer,null] copy-type:b[integer,null] copy-typeB:b[integer,null]",
    ],
    [
      "otherwise/call-result",
      'function f(v): integer? {\n  return v\n}\nlet result = f(hostValue) otherwise "bad"\nsay result',
      "compile-error | written-target@35:W written-target@75:E | copy-type:f.result[integer,null] copy-typeB:f.v[unknown]",
    ],
    [
      "narrowed/not-null",
      'let n: integer? = hostValue\nif n != null { say n otherwise "bad" }',
      "compile-error | written-target@18:W written-target@59:E | copy-type:n[integer,null] copy-typeB:n[integer,null]",
    ],
    // (a `null` read has no element: it contributes no family, so the list's still decides, Codex r4 on #1824)
    [
      "chain/null-read-first",
      'let a = null\nlet b: integer[]? = hostValue\nsay a otherwise b otherwise ["bad"]',
      "compile-error | written-target@33:W written-target@33:W written-target@72:E | copy-type:b[list,null] copy-type:b.element[integer] copy-typeB:b[list,null]",
    ],
    [
      "chain/three",
      'let a: integer? = hostValue\nlet b: integer? = hostValue\nlet c: integer? = hostValue\nlet result = a otherwise b otherwise c otherwise "bad"\nsay result',
      "compile-error | written-target@18:W written-target@46:W written-target@74:W written-target@133:E | copy-type:a[integer,null] copy-typeB:a[integer,null] copy-type:b[integer,null] copy-typeB:b[integer,null] copy-type:c[integer,null] copy-typeB:c[integer,null]",
    ],
    [
      "chain/null-only-link",
      'let a: integer? = hostValue\nlet b: integer? = null\nlet result = a otherwise b otherwise "bad"\nsay result',
      "compile-error | written-target@18:W written-target@88:E | copy-type:a[integer,null] copy-typeB:a[integer,null]",
    ],
    [
      "chain/null-link",
      'let a: integer? = hostValue\nlet result = a otherwise null otherwise "bad"\nsay result',
      "compile-error | written-target@18:W written-target@68:E | copy-type:a[integer,null] copy-typeB:a[integer,null]",
    ],
    [
      "chain/known-link",
      'let a: integer? = hostValue\nlet result = a otherwise 1 otherwise "bad"\nsay result',
      "compile-error | written-target@18:W written-target@65:E | copy-type:a[integer,null] copy-typeB:a[integer,null]",
    ],
    [
      "get/host-element",
      'let xs: integer[] = hostValue\nlet result = xs.get(0, default: "bad")\nsay result',
      "compile-error | written-target@20:W written-target@20:W integer-use@50:W operator@50:W written-target@62:E | copy-type:xs[list] copy-type:xs.element[integer] copy-typeB:xs[list] integer-check:0[integer] operand:0[string]",
    ],
    [
      "otherwise/host-fitting",
      "let input: integer? = hostValue\nlet result = input otherwise 2\nsay result",
      "warning-runtime-check | written-target@22:W | copy-type:input[integer,null] copy-typeB:input[integer,null]",
    ],
    [
      "otherwise/host-number-family",
      "let input: number? = hostValue\nlet result = input otherwise 1\nsay result",
      "warning-runtime-check | written-target@21:W | copy-type:input[number,null] copy-typeB:input[number,null]",
    ],
    [
      "otherwise/known-only-null",
      'let input: integer? = null\nlet result = input otherwise "bad"\nsay result',
      "valid |  |",
    ],
    [
      "otherwise/known-integer",
      'let input: integer? = 1\nlet result = input otherwise "bad"\nsay result',
      "compile-error | static@43:W written-target@53:E |",
    ],
    [
      "otherwise/parameter-known",
      'function use(input: integer?) { say input otherwise "bad" }\nuse(1)',
      "compile-error | static@42:W written-target@52:E |",
    ],
    [
      "otherwise/receiving-union",
      'let input: integer? = hostValue\nlet result: integer | string = input otherwise "bad"\nsay result',
      "warning-runtime-check | written-target@22:W | copy-type:input[integer,null] copy-typeB:input[integer,null]",
    ],
    [
      "otherwise/two-families",
      "let input: integer | string | null = hostValue\nlet result = input otherwise true\nsay result",
      "warning-runtime-check | written-target@37:W | copy-type:input[integer,string,null] copy-typeB:input[integer,string,null]",
    ],
    [
      "otherwise/unwritten",
      'let input = hostValue\nlet result = input otherwise "bad"\nsay result',
      "warning-runtime-check | written-target@35:W | copy-typeB:input[unknown] copy-type:result[string]",
    ],
    // (Codex r1's N1 on #1824: a read the test proves only `null` takes no family, r4.106)
    [
      "narrowed/is-null",
      'let n: integer? = hostValue\nif n is null { say n otherwise "bad" }',
      "warning-runtime-check | written-target@18:W | copy-type:n[integer,null] copy-typeB:n[integer,null]",
    ],
    [
      "otherwise/call-result-fitting",
      "function f(v): integer? {\n  return v\n}\nlet result = f(hostValue) otherwise 2\nsay result",
      "warning-runtime-check | written-target@35:W | copy-type:f.result[integer,null] copy-typeB:f.v[unknown]",
    ],
    [
      "chain/null-read-first-fitting",
      "let a = null\nlet b: integer[]? = hostValue\nsay a otherwise b otherwise [2]",
      "warning-runtime-check | written-target@33:W written-target@33:W | copy-type:b[list,null] copy-type:b.element[integer] copy-typeB:b[list,null]",
    ],
    // (a known value that may be null, unwritten: its own possible kinds decide, a warning; asking a domain here would
    // make the requirement definite, the eligibility guard keeps it possible, Astra r2's N1 on #1824)
    [
      "otherwise/known-or-null",
      'let choice = askBoolean "?"\nlet a = 1\nif choice { a = null }\nsay a otherwise "bad"',
      'warning-runtime-check | written-target@77:W | copy-type:"bad"[integer,number]',
    ],
    [
      "chain/unknown-link",
      'let a: integer? = hostValue\nlet b = hostValue\nlet result = a otherwise b otherwise "bad"\nsay result',
      "warning-runtime-check | written-target@18:W written-target@59:W written-target@71:W | copy-type:a[integer,null] copy-typeB:a[integer,null] copy-typeB:b[unknown] copy-type:result[integer,string] copy-type:b[integer,number]",
    ],
    [
      "chain/two-family-links",
      "let a: integer? = hostValue\nlet b: string? = hostValue\nlet result = a otherwise b otherwise true\nsay result",
      "warning-runtime-check | written-target@18:W written-target@45:W written-target@80:W | copy-type:a[integer,null] copy-typeB:a[integer,null] copy-type:b[string,null] copy-typeB:b[string,null] copy-type:b[integer,number]",
    ],
    [
      "chain/fitting",
      "let a: integer? = hostValue\nlet b: integer? = hostValue\nlet result = a otherwise b otherwise 3\nsay result",
      "warning-runtime-check | written-target@18:W written-target@46:W | copy-type:a[integer,null] copy-typeB:a[integer,null] copy-type:b[integer,null] copy-typeB:b[integer,null]",
    ],
    [
      "get/host-fitting",
      "let xs: integer[] = hostValue\nlet result = xs.get(0, default: 2)\nsay result",
      "warning-runtime-check | written-target@20:W written-target@20:W integer-use@50:W operator@50:W | copy-type:xs[list] copy-type:xs.element[integer] copy-typeB:xs[list] integer-check:0[integer] operand:0[string]",
    ],
    [
      "get/unwritten",
      'let xs = hostValue\nlet result = xs.get(0, default: "bad")\nsay result',
      "warning-runtime-check | written-target@32:W member-read@32:W integer-use@39:W operator@39:W | copy-typeB:xs[unknown] copy-type:result[string] null-check:xs[non-null] integer-check:0[integer] operand:0[string]",
    ],
    [
      "get/known",
      'let xs = [1, 2]\nlet result = xs.get(0, default: "bad")\nsay result',
      "compile-error | written-target@48:E |",
    ],
    [
      "load/default",
      'let input: integer = load("x", default: "bad")\nsay input',
      "compile-error | written-target@40:E | copy-typeB:input[integer]",
    ],
    [
      "parse/default",
      'let input: integer = fromJson("1", default: "bad")\nsay input',
      "compile-error | written-target@44:E | copy-typeB:input[integer]",
    ],
  ];
  for (const mode of MODES)
    for (const [name, body, expected] of cells)
      assert.equal(
        inMode(mode, () => c10Record(`${body}\nexit\n`)),
        expected,
        `${name} ${JSON.stringify(mode)}`,
      );
  // a stopped read keeps r4.100's warning against its contract (`budget`), never the domain's error; unstopped, the error
  const stops: readonly (readonly [string, string, number, string, boolean?])[] = [
    [
      "otherwise/host-one-family",
      'let input: integer? = hostValue\nlet result = input otherwise "bad"\nsay result',
      1,
      'warning-runtime-check | written-target@22:W:unknown written-target@45:W:budget written-target@61:W:budget | copy-type:input[integer,null] copy-typeB:input[integer,null] copy-type:result[unknown] copy-type:"bad"[unknown]',
    ],
    [
      "otherwise/host-one-family",
      'let input: integer? = hostValue\nlet result = input otherwise "bad"\nsay result',
      64,
      "compile-error | written-target@22:W:unknown written-target@45:W:budget written-target@61:E: | copy-type:input[integer,null] copy-typeB:input[integer,null] copy-type:result[unknown]",
    ],
    [
      "otherwise/chain",
      'let a: integer? = hostValue\nlet b: integer? = hostValue\nlet result = a otherwise b otherwise "bad"\nsay result',
      1,
      'warning-runtime-check | written-target@18:W:unknown written-target@46:W:unknown written-target@69:W:budget written-target@81:W:budget written-target@93:W:budget | copy-type:a[integer,null] copy-typeB:a[integer,null] copy-type:b[integer,null] copy-typeB:b[integer,null] copy-type:result[unknown] copy-type:b[unknown] copy-type:"bad"[unknown]',
    ],
    [
      "otherwise/chain",
      'let a: integer? = hostValue\nlet b: integer? = hostValue\nlet result = a otherwise b otherwise "bad"\nsay result',
      64,
      "compile-error | written-target@18:W:unknown written-target@46:W:unknown written-target@69:W:budget written-target@93:E: | copy-type:a[integer,null] copy-typeB:a[integer,null] copy-type:b[integer,null] copy-typeB:b[integer,null] copy-type:result[unknown]",
    ],
    [
      "get/host-element",
      'let xs: integer[] = hostValue\nlet result = xs.get(0, default: "bad")\nsay result',
      1,
      'warning-runtime-check | written-target@20:W:budget written-target@20:W:unknown written-target@43:W:budget member-read@43:W:budget integer-use@50:W:budget operator@50:W:budget written-target@62:W:budget | copy-type:xs[list] copy-type:xs[list] copy-typeB:xs[list] copy-type:result[unknown] null-check:xs[non-null] integer-check:0[integer] operand:0[string] copy-type:"bad"[unknown]',
    ],
    [
      "get/host-element",
      'let xs: integer[] = hostValue\nlet result = xs.get(0, default: "bad")\nsay result',
      64,
      "compile-error | written-target@20:W:unknown written-target@20:W:unknown written-target@43:W:budget integer-use@50:W:unknown operator@50:W:unknown written-target@62:E: | copy-type:xs[list] copy-type:xs.element[integer] copy-typeB:xs[list] copy-type:result[unknown] integer-check:0[integer] operand:0[string]",
    ],
    // (a stop at the chain's left read after its contract settled: in source order at 8 the read is stopped and keeps
    // the warning, never the domain's error)
    [
      "otherwise/chain",
      'let a: integer? = hostValue\nlet b: integer? = hostValue\nlet result = a otherwise b otherwise "bad"\nsay result',
      8,
      'warning-runtime-check | written-target@18:W:unknown written-target@46:W:unknown written-target@69:W:budget written-target@93:W:budget | copy-type:a[integer,null] copy-typeB:a[integer,null] copy-type:b[integer,null] copy-typeB:b[integer,null] copy-type:result[unknown] copy-type:"bad"[unknown]',
      true,
    ],
  ];
  for (const mode of MODES)
    for (const [name, body, allowance, expected, sourceOrder] of stops) {
      if (sourceOrder === true && mode.reversed) continue;
      // EVIDENCE: `stoppedRecord` serializes the answers' diagnostics and checks and the serialized record's outcome.
      const record = JSON.parse(
        stopSet([{ path: "main.tease", source: `${body}\nexit\n` }], mode, GLOBALS, allowance)!
          .record,
      ) as StopRecord;
      assert.equal(
        [
          record.serialized.outcome,
          record.diagnostics
            .map(
              (d) =>
                `${d.kind}@${d.site.start}:${d.class === "compile-error" ? "E" : "W"}:${d.provenance?.context ?? ""}`,
            )
            .join(" "),
          record.checks
            .map((c) => `${c.kind}${c.boundary ? "B" : ""}:${c.target}[${c.against.join(",")}]`)
            .join(" "),
        ]
          .join(" | ")
          .trimEnd(),
        expected,
        `${name} at ${allowance} ${JSON.stringify(mode)}`,
      );
    }
});

/** k typed host declarations and one `otherwise` chain of them, with its last fallback (`#1824`'s C10 chains). */
function chainFamily(
  name: string,
  type: string,
  initial: (i: number) => string,
  last: string,
  right = false,
): WorkFamily {
  return {
    name,
    measures: "C10's domain of each link of an `otherwise` chain, at its root and below it",
    program: (k) => [
      {
        path: "main.tease",
        source: [
          ...Array.from({ length: k }, (_, i) => `let v${i}: ${type} = ${initial(i)}`),
          right
            ? `say ${Array.from({ length: k }, (_, i) => `v${i} otherwise (`).join("")}${last}${")".repeat(k)}`
            : `say ${Array.from({ length: k }, (_, i) => `v${i}`).join(" otherwise ")} otherwise ${last}`,
          "exit",
          "",
        ].join("\n"),
      },
    ],
  };
}

test("C10's domain of an otherwise chain is each link's, once per value and path: its work linear (Astra r1 on #1824)", () => {
  // (a chain of nullable lists or dicts descends into the element, where each link's domain at that path was its whole
  // earlier chain's: 4k² + 73k + 2 more units than main; beside it the scalar chain and the known-list control)
  const families: readonly WorkFamily[] = [
    chainFamily("c10-chain-scalar", "integer?", () => "hostValue", "0"),
    chainFamily("c10-chain-list", "integer[]?", () => "hostValue", "[0]"),
    chainFamily("c10-chain-dict", "integer dict?", () => "hostValue", 'dict{"a": 0}'),
    chainFamily("c10-chain-list-known", "integer[]?", (i) => `[${i}]`, "[0]"),
    // (and nested on the right, `v0 otherwise (v1 otherwise (…))`: the fallback's own kinds a chain too, Codex r4)
    chainFamily("c10-chain-list-right", "integer[]?", () => "hostValue", "[0]", true),
    chainFamily("c10-chain-dict-right", "integer dict?", () => "hostValue", 'dict{"a": 0}', true),
    // (nested collections on the right, and a chain interleaved with `get` defaults, Codex r5: the contract answers a
    // fallback's or a `get`'s result at a path once per value and path)
    chainFamily("c10-chain-rows-right", "integer[][]?", () => "hostValue", "[[0]]", true),
    {
      name: "c10-chain-get-interleaved",
      measures: "C10's domain of a chain interleaved with `get` defaults, below its root",
      program: (k) => [
        {
          path: "main.tease",
          source: [
            ...Array.from({ length: k }, (_, i) => `let v${i}: integer[]? = hostValue`),
            "let outer: integer[]?[] = hostValue",
            `say ${Array.from({ length: k }, (_, i) => `v${i} otherwise (outer.get(0, default: (`).join("")}[0]${")))".repeat(k)}`,
            "exit",
            "",
          ].join("\n"),
        },
      ],
    },
  ];
  const steep: string[] = [];
  for (const sizes of [
    [16, 32],
    [32, 64],
    [64, 128],
  ] as const)
    for (const unshared of [false, true])
      steep.push(...steepCounters(families, unshared, undefined, sizes));
  assert.deepEqual(steep, []);
});
