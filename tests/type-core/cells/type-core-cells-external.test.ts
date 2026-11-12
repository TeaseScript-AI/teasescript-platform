// External data in the cells: checked at its store (C1, C9), the carrier table, ingress boundaries, the landing index.

import assert from "node:assert/strict";
import test from "node:test";
import { CARRIER_ROLES, operandsOf } from "../../../src/type-inference/core/carriers.js";
import { withConsumerOrder } from "../../../src/type-inference/core/consumers.js";
import { CoreProgram } from "../../../src/type-inference/core/program.js";
import { withSolverSeam } from "../../../src/type-inference/core/solver.js";
import { compactAnalysis, coreRequest } from "../../helpers/type-core-analysis.js";
import {
  recordDifferences,
  type CompactCheck,
  type CompactDiagnostic,
  type CompactRecord,
  type CompactSite,
} from "../../helpers/type-core-records.js";

test("external data a literal carries is warned and checked at its store where a type is admitted, read or not (C1, C9, the owner's F1)", () => {
  const after = '\nsay "AFTER"\nexit';
  // per program its outcome and its copy checks, as target, kinds, boundary (B) and site: C1's at the host expression
  // against the literal's decided elements, and C9's boundary there
  const at = (target: string, kinds: string, site: number): string[] => [
    `${target} [${kinds}] @${site}`,
    `${target} [${kinds}] B @${site}`,
  ];
  const programs: readonly (readonly [string, string, string, readonly string[]])[] = [
    [
      "a list",
      `let xs = [1, hostValue]${after}`,
      "warning-runtime-check",
      at("xs.element", "integer", 13),
    ],
    [
      "a list read nowhere live",
      `let xs = [1, hostValue]\nif false { repeat xs[0] {} }${after}`,
      "warning-runtime-check",
      at("xs.element", "integer", 13),
    ],
    [
      "a list, host data first",
      `let xs = [hostValue, 1]${after}`,
      "warning-runtime-check",
      at("xs.element", "integer", 10),
    ],
    [
      "a list of texts",
      `let xs = ["a", hostValue]${after}`,
      "warning-runtime-check",
      at("xs.element", "string", 15),
    ],
    [
      "a nested list",
      `let xs = [[1, hostValue]]${after}`,
      "warning-runtime-check",
      at("xs.element.element", "integer", 14),
    ],
    [
      "a nested list's later element",
      `let xs = [[1], [hostValue]]${after}`,
      "warning-runtime-check",
      at("xs.element.element", "integer", 16),
    ],
    [
      "a copied list",
      `let ys = [1, hostValue]\nlet xs = ys${after}`,
      "warning-runtime-check",
      at("ys.element", "integer", 13),
    ],
    [
      "a set",
      `let xs = set[1, hostValue]${after}`,
      "warning-runtime-check",
      at("xs.element", "integer", 16),
    ],
    [
      "a dict",
      `let xs = dict{a: 1, b: hostValue}${after}`,
      "warning-runtime-check",
      at("xs.entry", "integer", 23),
    ],
    [
      "a list of records",
      `let xs = [{n: 1}, {n: hostValue}]${after}`,
      "warning-runtime-check",
      ["xs.element.n [integer] @22", "xs.element [object] B @22"],
    ],
    [
      "a returned list",
      `function g {\n  return [1, hostValue]\n}\nlet xs = g()${after}`,
      "warning-runtime-check",
      at("g.result.element", "integer", 26),
    ],
    [
      "a passed list",
      `function f(p) {\n  say "x"\n}\nf([1, hostValue])${after}`,
      "warning-runtime-check",
      at("f.p.element", "integer", 34),
    ],
    // where no type is admitted, nothing is checked until a consumer asks
    ["a list of host data alone", `let xs = [hostValue, hostValue]${after}`, "valid", []],
    ["a record of host data alone", `let o = {n: hostValue}${after}`, "valid", []],
    ["a record of host data beside a number", `let r = {n: hostValue, m: 1}${after}`, "valid", []],
    [
      "a returned record of host data",
      `function packet {\n  return {amount: hostValue}\n}\nlet data = packet()${after}`,
      "valid",
      [],
    ],
  ];
  const differing: string[] = [];
  for (const [name, source, outcome, expected] of programs) {
    const request = coreRequest([{ path: "main.tease", source }]);
    assert.ok(request !== null, `${name}: its source parses and resolves`);
    for (const reversed of [false, true]) {
      const run = (): CompactRecord =>
        withSolverSeam({ reverseWorklist: reversed }, () => compactAnalysis(request));
      const record = reversed ? withConsumerOrder((list) => [...list].reverse(), run) : run();
      const copies = record.checks
        .filter((check) => check.kind === "copy-type")
        .map(
          (check) =>
            `${check.target} [${check.against.join(", ")}]${check.boundary ? " B" : ""} @${check.site.offset}`,
        )
        .sort();
      if (
        record.outcome !== outcome ||
        JSON.stringify(copies) !== JSON.stringify([...expected].sort())
      )
        differing.push(
          `${name}${reversed ? " reversed" : ""}: ${record.outcome}; ${copies.join("; ")}`,
        );
    }
  }
  assert.deepEqual(differing, []);
});

test("named external data in a literal is warned and checked at its store where a type is decided, read or not (round 10 B1)", () => {
  const after = '\nsay "AFTER"\nexit';
  // per program its outcome and its copy checks, as target, kinds, boundary (B) and site: C1's at the named value
  // against the literal's decided elements, and the boundary of the store that brought the data in, against its own
  const programs: readonly (readonly [string, string, string, readonly string[]])[] = [
    [
      "a named host value",
      `let a = hostValue\nlet xs = [1, a]${after}`,
      "warning-runtime-check",
      ["a [unknown] B @8", "xs.element [integer] @27"],
    ],
    [
      "a named host value first",
      `let a = hostValue\nlet xs = [a, 1]${after}`,
      "warning-runtime-check",
      ["a [unknown] B @8", "xs.element [integer] @27"],
    ],
    [
      "a copy of a copy",
      `let a = hostValue\nlet c = a\nlet xs = [1, c]${after}`,
      "warning-runtime-check",
      ["a [unknown] B @8", "xs.element [integer] @37"],
    ],
    [
      "a set",
      `let a = hostValue\nlet xs = set[1, a]${after}`,
      "warning-runtime-check",
      ["a [unknown] B @8", "xs.element [integer] @27"],
    ],
    [
      "a dict",
      `let a = hostValue\nlet xs = dict{p: 1, q: a}${after}`,
      "warning-runtime-check",
      ["a [unknown] B @8", "xs.entry [integer] @27"],
    ],
    [
      "a returned host value",
      `function g {\n  return hostValue\n}\nlet xs = [1, g()]${after}`,
      "warning-runtime-check",
      ["g.result [unknown] B @22", "xs.element [integer] @43"],
    ],
    [
      "a named list of host data",
      `let a = [hostValue]\nlet xs = [a, [1]]${after}`,
      "warning-runtime-check",
      ["a.element [unknown] B @9", "xs.element.element [integer] @29"],
    ],
    // where nothing is decided, nothing is checked until a consumer asks
    [
      "named host values alone",
      `let a = hostValue\nlet b = hostValue\nlet xs = [a, b]${after}`,
      "valid",
      [],
    ],
    ["a record's named host field", `let a = hostValue\nlet r = {n: 1, m: a}${after}`, "valid", []],
    ["a named whole number", `let a = 2\nlet xs = [1, a]${after}`, "valid", []],
  ];
  const differing: string[] = [];
  for (const [name, source, outcome, expected] of programs) {
    const request = coreRequest([{ path: "main.tease", source }]);
    assert.ok(request !== null, `${name}: its source parses and resolves`);
    for (const reversed of [false, true]) {
      const run = (): CompactRecord =>
        withSolverSeam({ reverseWorklist: reversed }, () => compactAnalysis(request));
      const record = reversed ? withConsumerOrder((list) => [...list].reverse(), run) : run();
      const copies = record.checks
        .filter((check) => check.kind === "copy-type")
        .map(
          (check) =>
            `${check.target} [${check.against.join(", ")}]${check.boundary ? " B" : ""} @${check.site.offset}`,
        )
        .sort();
      if (
        record.outcome !== outcome ||
        JSON.stringify(copies) !== JSON.stringify([...expected].sort())
      )
        differing.push(
          `${name}${reversed ? " reversed" : ""}: ${record.outcome}; ${copies.join("; ")}`,
        );
    }
  }
  assert.deepEqual(differing, []);
});

test("named external data a carrier stores into a place published with a kind owes its check there (C9)", () => {
  // per carrier outside the candidate's slice (its plan and its run wait for the slice): the warning where the named
  // data is read, with a `copy-type` check against the published kind; a source decided at its own stores (a list whose
  // element `1` decides) keeps its check there only; a member of host data owes C5's obligation on the receiver and,
  // beside it, the destination's own check, where the member is read (F15)
  const programs: readonly (readonly [string, string, string | null])[] = [
    ["otherwise", "let raw = hostValue\nlet out = raw otherwise 1\nexit", "raw otherwise"],
    ["get's default", "let raw = hostValue\nlet out = [raw].get(0, default: 1)\nexit", "raw]"],
    ["get's receiver", "let raw = hostValue\nlet out = [1, raw].get(1, default: 1)\nexit", "raw]"],
    ["first", "let raw = hostValue\nlet out = [1, raw].first\nexit", "raw]"],
    // (the literal is the written integer, strict, its host element deciding nothing: the data leaves through the
    // store of the read that copies the cell's element, which owes the check, #2289)
    [
      "a written element beside",
      "let typed: integer = 1\nlet raw = hostValue\nlet out = [typed, raw][1]\nexit",
      "[typed, raw][1]",
    ],
    ["a decided source", "let raw = hostValue\nlet xs = [1, raw]\nlet out = xs[1]\nexit", null],
    [
      "a member of host data",
      'let parcel = hostValue\nlet out = parcel.get("count", default: 0)\nexit',
      "parcel.get",
    ],
  ];
  const differing: string[] = [];
  for (const [name, source, read] of programs) {
    const request = coreRequest([{ path: "main.tease", source }]);
    assert.ok(request !== null, `${name}: its source parses and resolves`);
    const at = read === null ? -1 : source.indexOf(read, source.indexOf("let out"));
    const want = read === null ? [] : [`copy-type out @${at}`];
    for (const reversed of [false, true]) {
      const run = (): CompactRecord =>
        withSolverSeam({ reverseWorklist: reversed }, () => compactAnalysis(request));
      const record = reversed ? withConsumerOrder((list) => [...list].reverse(), run) : run();
      const got = record.checks
        .filter((check) => check.kind === "copy-type" && check.target === "out" && !check.boundary)
        .map((check) => `${check.kind} ${check.target} @${check.site.offset}`);
      if (JSON.stringify(got) !== JSON.stringify(want))
        differing.push(`${name}${reversed ? " reversed" : ""}: ${got.join(" ")}`);
    }
  }
  assert.deepEqual(differing, []);
});

/**
 * S6-CARRIERS: the carrier table names each operand's role and its evaluation position among the carrier's
 * operands, and every role of `CARRIER_ROLES` is some row's: a `get`'s receiver 0 and default 2 (its key is 1), an
 * `otherwise`'s operand 0 and fallback 1, a `load`'s and a parse's default 1, a list's `+` and a choice by operand.
 */
test("the carrier table names each operand's role and evaluation position (S6-CARRIERS)", () => {
  const source = [
    "let xs = [1, 2]",
    "let d = dict{a: 1}",
    "let o = {f: 1}",
    "let a = xs[0]",
    "let b = o.f",
    "let c = d.values",
    'for item in xs { say "x" }',
    "let e = hostValue otherwise 1",
    "let f = xs.get(0, default: 3)",
    'let g = load("k", default: 4)',
    'let h = fromJson("1", default: 5)',
    "let i = xs.take(1)",
    "let j = xs.removeFirst()",
    "let k = xs + [3] + [4]",
    'let l = askChoice 1, [2], {text: "t", value: 3}',
    "exit",
  ].join("\n");
  const request = coreRequest([{ path: "main.tease", source }]);
  assert.ok(request !== null);
  const program = new CoreProgram(request);
  program.index();
  const rows = new Set<string>();
  for (const value of [...program.projOf.keys(), ...program.opOf.keys()])
    for (const { kind, role, position } of operandsOf(program, value)) {
      assert.ok(role.startsWith(`${kind}/`), `${role} is a ${kind}'s`);
      rows.add(`${role} ${position}`);
    }
  assert.deepEqual(
    new Set([...rows].map((row) => row.slice(0, row.lastIndexOf(" ")))),
    new Set(CARRIER_ROLES),
  );
  for (const row of [
    "get/receiver 0",
    "get/default 2",
    "otherwise/operand 0",
    "otherwise/fallback 1",
    "load default/default 1",
    "parse default/default 1",
    "concatenation/operand 0",
    "concatenation/operand 1",
    "choice/option value 0",
    "choice/option element value 1",
    "choice/option text 2",
  ])
    assert.ok(rows.has(row), row);
});

/**
 * S6-CARRIERS (the first design review's B3): an identity holding an ingress occurrence is fresh, so two equal
 * computations over host data stay two contract entries and each keeps its leaf: a consumer that meets either
 * payload brings each store's boundary, at each host value. The whole record, in both orders.
 */
test("two equal computations over host data keep each ingress's boundary (S6-CARRIERS)", () => {
  const source =
    'let flagHost = askBoolean "flag"\nlet box = {payload: hostValue otherwise null}\n' +
    "if flagHost { box = {payload: hostValue otherwise null} }\nlet count: integer = box.payload\nexit\n";
  const request = coreRequest([{ path: "main.tease", source }]);
  assert.ok(request !== null);
  const at = (offset: number, end: number) => ({ file: "main.tease", offset, end });
  const expected: CompactRecord = {
    outcome: "warning-runtime-check",
    diagnostics: [
      { kind: "written-target", class: "warning-runtime-check", site: at(158, 169), context: null },
      { kind: "written-target", class: "warning-runtime-check", site: at(158, 169), context: null },
    ],
    checks: [
      {
        kind: "copy-type",
        target: "count",
        against: ["integer"],
        boundary: false,
        site: at(158, 169),
      },
      {
        kind: "null-check",
        target: "count",
        against: ["integer"],
        boundary: false,
        site: at(158, 169),
      },
      { kind: "copy-type", target: "box", against: ["object"], boundary: true, site: at(53, 62) },
      { kind: "copy-type", target: "box", against: ["object"], boundary: true, site: at(109, 118) },
    ],
  };
  const forward = compactAnalysis(request);
  const reversed = withSolverSeam({ reverseWorklist: true }, () =>
    withConsumerOrder(
      (list) => [...list].reverse(),
      () => compactAnalysis(request),
    ),
  );
  assert.deepEqual(recordDifferences(expected, forward), []);
  assert.deepEqual(recordDifferences(expected, reversed), []);
});

/**
 * S6-CARRIERS with the guard's mark (Codex r20 B1): literals grouped by the structure they hold at a path share an answer only
 * where their reads are marked alike. A read under a test of its path, or of a path below it, inside a computed child (a
 * `get`, a projection of a literal, an index, an `otherwise`) keeps its mark, so the definite fraction a guarded copy
 * also holds is the warning with its check, never the error. The whole record, in both orders.
 */
test("a guarded read inside a computed child keeps its mark where literals share a level (Codex r20 B1)", () => {
  const branch = (kind: CompactDiagnostic["kind"], site: CompactSite): CompactDiagnostic => ({
    kind,
    class: "warning-runtime-check",
    site,
    context: "branch",
  });
  const check = (
    kind: CompactCheck["kind"],
    target: string,
    against: string,
    site: CompactSite,
  ): CompactCheck => ({ kind, target, against: [against], boundary: false, site });
  const cases: readonly { readonly data: string; readonly guard: string; readonly own?: true }[] = [
    { data: "[root].get(0, default: root)", guard: "root != null" },
    { data: "({inner: root}).inner", guard: "root != null" },
    { data: "[root][0]", guard: "root != null" },
    { data: "(root otherwise null)", guard: "root.n is integer", own: true },
  ];
  for (const { data, guard, own } of cases) {
    const source =
      `let root = {n: 2.0}\nlet box = {noise: 0, data: ${data}}\n` +
      `if ${guard} { box = {noise: 1.5, data: ${data}} }\nrepeat box.data.n {}\nexit\n`;
    const read = source.indexOf("box.data.n");
    const at = (end: number): CompactSite => ({ file: "main.tease", offset: read, end });
    // (an `otherwise` may give its fallback, `null`: the member read's own check before the integer's)
    const expected: CompactRecord = {
      outcome: "warning-runtime-check",
      diagnostics: [
        // (#1072, V30 §18: `root` is never null, so each `otherwise null` is never used)
        ...(own
          ? [...source.matchAll(/otherwise null\)/g)].map((found): CompactDiagnostic => ({
              kind: "static",
              class: "warning",
              site: { file: "main.tease", offset: found.index, end: found.index + 14 },
              context: null,
            }))
          : []),
        ...(own ? [branch("member-read", at(read + 10))] : []),
        branch("integer-use", at(read + 10)),
      ],
      checks: [
        ...(own ? [check("null-check", "box.data", "non-null", at(read + 10))] : []),
        check("integer-check", "box.data.n", "integer", at(read + 10)),
      ],
    };
    const request = coreRequest([{ path: "main.tease", source }]);
    assert.ok(request !== null, source);
    const forward = compactAnalysis(request);
    const reversed = withSolverSeam({ reverseWorklist: true }, () =>
      withConsumerOrder(
        (list) => [...list].reverse(),
        () => compactAnalysis(request),
      ),
    );
    assert.deepEqual(recordDifferences(expected, forward), [], source);
    assert.deepEqual(recordDifferences(expected, reversed), [], `${source} reversed`);
  }
});

/**
 * S6-CARRIERS (Codex r20 B6, N1, N2), from the landing index: a typed `load` or `fromJson`
 * no store brings, its property never stored or its text only displayed, keeps F18's own check where it runs; a
 * member of host data owes C1 at the member read and C9 at the host value; and a surely measured length is derived
 * (F14), never the external data of the ingress it measures. The whole record, in both orders.
 */
test("the landing index keeps F18's own check, sites a member's C1 at its read and derives a known length (Codex r20 B6, N1, N2)", () => {
  const at = (offset: number, end: number): CompactSite => ({ file: "main.tease", offset, end });
  const boundary = (target: string, against: string, site: CompactSite): CompactCheck => ({
    kind: "copy-type",
    target,
    against: [against],
    boundary: true,
    site,
  });
  const valid = (...checks: CompactCheck[]): CompactRecord => ({
    outcome: "valid",
    diagnostics: [],
    checks,
  });
  const cases: readonly (readonly [string, CompactRecord])[] = [
    [
      'let out = {unused: load("x", default: 0), kept: 1}.kept\nsay "AFTER"\n',
      valid(boundary("load.result", "integer", at(19, 40))),
    ],
    [
      'let out = {unused: fromJson("1", default: 0, files: false), kept: 1}.kept\nsay "AFTER"\n',
      valid(boundary("fromJson.result", "integer", at(19, 58))),
    ],
    [
      'let out = askChoice {text: load("x", default: "one"), value: "two"}\nsay "AFTER"\n',
      valid(boundary("load.result", "string", at(27, 52))),
    ],
    [
      'let rows = [1]\nrows.add(hostValue.field)\nsay "AFTER"\n',
      {
        outcome: "warning-runtime-check",
        diagnostics: [
          {
            kind: "written-target",
            class: "warning-runtime-check",
            site: at(24, 39),
            context: "unknown",
          },
          {
            kind: "member-read",
            class: "warning-runtime-check",
            site: at(24, 39),
            context: "unknown",
          },
        ],
        checks: [
          {
            kind: "copy-type",
            target: "rows.element",
            against: ["integer"],
            boundary: false,
            site: at(24, 39),
          },
          {
            kind: "null-check",
            target: "hostValue",
            against: ["non-null"],
            boundary: false,
            site: at(24, 39),
          },
          boundary("rows.element", "integer", at(24, 33)),
        ],
      },
    ],
    [
      'let out = load("x", default: [1]).length\nsay "AFTER"\n',
      valid(boundary("load.result", "list", at(10, 33))),
    ],
  ];
  for (const [source, expected] of cases) {
    const request = coreRequest([{ path: "main.tease", source }]);
    assert.ok(request !== null, source);
    const forward = compactAnalysis(request);
    const reversed = withSolverSeam({ reverseWorklist: true }, () =>
      withConsumerOrder(
        (list) => [...list].reverse(),
        () => compactAnalysis(request),
      ),
    );
    assert.deepEqual(recordDifferences(expected, forward), [], source);
    assert.deepEqual(recordDifferences(expected, reversed), [], `${source} reversed`);
  }
});

/**
 * C9, C1 (Codex r21 B3, N1): named host data a store brings beside inline host data owes the
 * destination's check at its read and keeps its source's boundary, the inline value its boundary at the store; what a
 * receiver's operation (a copy) reads of host data that an add or an `addAll` brings owes C1 at that operation, C9 at
 * the host value. The whole record, in both orders.
 */
test("named data beside inline host data keeps its check and boundary, and an add's C1 sits at its copy (Codex r21 B3, N1)", () => {
  const at = (offset: number, end: number): CompactSite => ({ file: "main.tease", offset, end });
  const check = (target: string, against: string, boundary: boolean, site: CompactSite) =>
    ({ kind: "copy-type", target, against: [against], boundary, site }) as const;
  const warned = (
    diagnostics: readonly (readonly [CompactDiagnostic["kind"], CompactSite])[],
    checks: readonly CompactCheck[],
  ): CompactRecord => ({
    outcome: "warning-runtime-check",
    diagnostics: diagnostics.map(([kind, site]) => ({
      kind,
      class: "warning-runtime-check",
      site,
      context: "unknown",
    })),
    checks,
  });
  const nonNull = (site: CompactSite): CompactCheck => ({
    kind: "null-check",
    target: "hostValue",
    against: ["non-null"],
    boundary: false,
    site,
  });
  const cases: readonly (readonly [string, CompactRecord])[] = [
    [
      'let raw = hostValue\nlet out = [1, hostValue, raw][2]\nsay "AFTER"\n',
      warned(
        [["written-target", at(45, 48)]],
        [
          check("out", "integer", false, at(45, 48)),
          check("raw", "unknown", true, at(10, 19)),
          check("out", "integer", true, at(34, 43)),
        ],
      ),
    ],
    [
      'let xs = [[1]]\nxs.add(hostValue.toList())\nsay "AFTER"\n',
      warned(
        [
          ["written-target", at(22, 40)],
          ["member-read", at(22, 40)],
        ],
        [
          check("xs.element.element", "integer", false, at(22, 40)),
          nonNull(at(22, 40)),
          check("xs.element", "list", true, at(22, 31)),
        ],
      ),
    ],
    [
      'let xs = [1]\nxs.addAll(hostValue.toList())\nsay "AFTER"\n',
      warned(
        [
          ["written-target", at(23, 41)],
          ["member-read", at(23, 41)],
        ],
        [
          check("xs.element", "integer", false, at(23, 41)),
          nonNull(at(23, 41)),
          check("xs.element", "integer", true, at(23, 32)),
        ],
      ),
    ],
  ];
  for (const [source, expected] of cases) {
    const request = coreRequest([{ path: "main.tease", source: `${source}exit\n` }]);
    assert.ok(request !== null, source);
    const forward = compactAnalysis(request);
    const reversed = withSolverSeam({ reverseWorklist: true }, () =>
      withConsumerOrder(
        (list) => [...list].reverse(),
        () => compactAnalysis(request),
      ),
    );
    assert.deepEqual(recordDifferences(expected, forward), [], source);
    assert.deepEqual(recordDifferences(expected, reversed), [], `${source} reversed`);
  }
});

/**
 * S6-CARRIERS: copies of one source with equal signatures are one class, and the class decides through its
 * earliest member no test of the read's path holds (a guard marks a read possible, so it decides nothing): an unguarded
 * copy decides whether a guarded one comes before it or after it, the add of text then the misfit (A6); without a
 * written type a guarded copy decides nothing (the trace: the add decides, the unguarded copy is the misfit); with
 * one, the class's earliest copy decides by it, guarded or not (A4, Astra's third round B1). The whole record, in both
 * orders.
 */
test("a class decides through its earliest member no guard of the path holds, in both orders", () => {
  type Diagnostic = readonly [
    CompactDiagnostic["kind"],
    CompactDiagnostic["class"],
    number,
    number,
    CompactDiagnostic["context"],
  ];
  type Check = readonly [CompactCheck["kind"], string, string, boolean, number, number];
  const record = (
    outcome: CompactRecord["outcome"],
    diagnostics: readonly Diagnostic[],
    checks: readonly Check[],
  ): CompactRecord => ({
    outcome,
    diagnostics: diagnostics.map(([kind, cls, offset, end, context]) => ({
      kind,
      class: cls,
      site: { file: "main.tease", offset, end },
      context,
    })),
    checks: checks.map(([kind, target, against, boundary, offset, end]) => ({
      kind,
      target,
      against: [against],
      boundary,
      site: { file: "main.tease", offset, end },
    })),
  });
  const after = 'box.add("word")\nrepeat box[0] {}\nexit\n';
  const cases: readonly (readonly [string, CompactRecord])[] = [
    [
      `let root = [1]\nlet box = [null]\nif root != null {\n  box = root\n}\nbox = root\n${after}`,
      record("compile-error", [["written-target", "compile-error", 84, 90, null]], []),
    ],
    [
      `let root = [1]\nlet box = [null]\nbox = root\nif root != null {\n  box = root\n}\n${after}`,
      record(
        "compile-error",
        [
          ["written-target", "compile-error", 84, 90, null],
          ["integer-use", "warning-runtime-check", 99, 105, "member"],
        ],
        [["null-check", "box.element", "integer", false, 99, 105]],
      ),
    ],
    [
      'let raw = hostValue\nraw = 1\nlet root = [raw]\nlet box = [null]\nif root != null {\n  box = root\n}\nbox.add("word")\nbox = root\nrepeat box[0] {}\nexit\n',
      record(
        "compile-error",
        [
          ["written-target", "warning-runtime-check", 10, 19, "later"],
          ["written-target", "warning-runtime-check", 88, 92, "later"],
          ["written-target", "compile-error", 117, 121, null],
          ["integer-use", "warning-runtime-check", 129, 135, "member"],
          ["integer-use", "warning-runtime-check", 129, 135, "unknown"],
          ["integer-use", "warning-runtime-check", 129, 135, "member"],
        ],
        [
          ["copy-type", "raw", "integer", false, 10, 19],
          ["copy-type", "box.element", "string", false, 88, 92],
          ["null-check", "box.element", "integer", false, 129, 135],
          ["integer-check", "box.element", "integer", false, 129, 135],
          ["integer-check", "box.element", "integer", false, 129, 135],
          ["copy-type", "raw", "integer", true, 10, 19],
        ],
      ),
    ],
    [
      `let root: integer[] = [1]\nlet box = [null]\nif root != null {\n  box = root\n}\nbox.add("word")\nbox = root\nrepeat box[0] {}\nexit\n`,
      record("compile-error", [["written-target", "compile-error", 84, 90, null]], []),
    ],
    [
      `let root: integer[] = [1]\nlet box = [null]\nbox = root\nif root != null {\n  box = root\n}\n${after}`,
      record(
        "compile-error",
        [
          ["written-target", "compile-error", 95, 101, null],
          ["integer-use", "warning-runtime-check", 110, 116, "member"],
        ],
        [["null-check", "box.element", "integer", false, 110, 116]],
      ),
    ],
  ];
  for (const [source, expected] of cases) {
    const request = coreRequest([{ path: "main.tease", source }]);
    assert.ok(request !== null, source);
    const forward = compactAnalysis(request);
    const reversed = withSolverSeam({ reverseWorklist: true }, () =>
      withConsumerOrder(
        (list) => [...list].reverse(),
        () => compactAnalysis(request),
      ),
    );
    assert.deepEqual(recordDifferences(expected, forward), [], source);
    assert.deepEqual(recordDifferences(expected, reversed), [], `${source} reversed`);
  }
});
