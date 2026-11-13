// The route rule on the candidate route (AD-1): where a run can bring a null unchecked, and the forms that discharge
// it.

import assert from "node:assert/strict";
import test from "node:test";
import { analyseCore } from "../../../src/type-inference/core/answers.js";
import { withTestDemandAllowance } from "../../../src/type-inference/core/budget.js";
import { compactAnalysis, coreRequest } from "../../helpers/type-core-analysis.js";
import { syntaxOf } from "../../helpers/type-core/derived/type-core-derived.js";
import { derive } from "../../helpers/type-core/derived/type-core-derived-checks.js";
import { evaluate } from "../../helpers/type-core/derived/type-core-derived-runs.js";
import { runGlobals } from "../../helpers/type-core-route.js";
import { candidate, inBothOrders } from "../../helpers/type-core/type-core-candidate-setup.js";

// (functions are outside the candidate's slice: the core's analysis answers)
const errs = (source: string): boolean => {
  const request = coreRequest([{ path: "main.tease", source }], ["hostValue"]);
  assert.ok(request !== null, source);
  return analyseCore(request).diagnostics.some((d) => d.class === "compile-error");
};

test("the route rule's error stands where a run can bring the null unchecked, and a check the compiler cannot keep warns (AD-1, #1073 PR 4)", () => {
  for (const [source, error] of [
    // (a loop's exit tests out the null: a check the compiler cannot keep, the warning; the other polarity is the error,
    // the fixture's `forms/while-false-exit`; Codex r1 F1 on #1937)
    [
      'let n = 1\nif askBoolean "Clear?" { n = null }\nwhile n == null { n = 1 }\nrepeat n {}\nexit\n',
      false,
    ],
    // (a test of the producer in the use's own condition before it, of the needed form; another comparison checks
    // nothing: Codex r1 F2, F5)
    [
      'function f { if askBoolean("f") { return null }\n return 1 }\nif f() != null and f() > 0 { say "yes" }\nexit\n',
      false,
    ],
    [
      'function f { if askBoolean("f") { return null }\n return 1 }\nif f() != 2 { repeat f() {} }\nexit\n',
      true,
    ],
    // (Codex r2 on #1937: a `not`, a later test of the same call, an `or`'s guard, a leaving guard, an optional type test
    // of a union, and an `else` arm of a non-null test)
    [
      'let n = 1\nif askBoolean "Clear?" { n = null }\nwhile not (n != null) { n = 1 }\nrepeat n {}\nexit\n',
      false,
    ],
    [
      'function f { if askBoolean("f") { return null }\n return 1 }\nif f() != null and f() > 0 and f() != null { say "y" }\nexit\n',
      false,
    ],
    [
      'function f { if askBoolean("f") { return null }\n return 1 }\nif f() == null or f() > 0 { say "y" }\nexit\n',
      false,
    ],
    [
      'function f { if askBoolean("f") { return null }\n return 1 }\nif f() == null { exit }\nrepeat f() {}\nexit\n',
      false,
    ],
    [
      'function f: integer | string { return "s" }\nif f() is integer? { repeat f() {} }\nexit\n',
      false,
    ],
    [
      'function f { if askBoolean("f") { return null }\n return 1 }\nif f() != null { say "y" } else { repeat f() {} }\nexit\n',
      true,
    ],
    // (Codex r3 on #1937: a guard that leaves through its `else` arm or its `then` arm beside an `else`, or with
    // `continue` in a loop, is a check on every route past it; one of the wrong form, one in a sibling block, or a
    // `while` a `break` leaves is not)
    [
      'function f { if askBoolean("f") { return null }\n return 1 }\nif f() != null { say "y" } else { exit }\nrepeat f() {}\nexit\n',
      false,
    ],
    [
      'function f { if askBoolean("f") { return null }\n return 1 }\nif f() == null { exit } else { say "y" }\nrepeat f() {}\nexit\n',
      false,
    ],
    [
      'function f { if askBoolean("f") { return null }\n return 1 }\nrepeat 2 { if f() == null { continue }\nrepeat f() {} }\nexit\n',
      false,
    ],
    [
      'function f { if askBoolean("f") { return null }\n return 1 }\nif f() == null { say "y" } else { exit }\nrepeat f() {}\nexit\n',
      true,
    ],
    [
      'function f { if askBoolean("f") { return null }\n return 1 }\nif askBoolean("b") { if f() == null { exit } }\nrepeat f() {}\nexit\n',
      true,
    ],
    [
      'let n = 1\nif askBoolean "Clear?" { n = null }\nwhile n == null { if askBoolean "b" { break }\nn = 1 }\nrepeat n {}\nexit\n',
      true,
    ],
    // (a called function's written union proves itself: Codex r1 F4)
    ['function f: integer | string { return "s" }\nrepeat f() {}\nexit\n', true],
    // (a parameter's default is selected only where some call omits the argument)
    ["function use(n = null) { repeat n {} }\nuse(2)\nexit\n", false],
    ["function use(n = null) { repeat n {} }\nuse()\nuse(2)\nexit\n", true],
    // (a call's result is its own producer; a test of the same call around it is a check the compiler cannot keep)
    [
      'function read { if askBoolean("v") { return null }\n return 2 }\nrepeat read() {}\nexit\n',
      true,
    ],
    [
      'function read { if askBoolean("v") { return null }\n return 2 }\nif read() != null { repeat read() {} }\nexit\n',
      false,
    ],
  ] as const)
    assert.equal(
      inBothOrders(() => errs(source)),
      error,
      source,
    );
  // (a written union's other kind the use does not take, made by a non-literal producer, certifies the union's route as
  // the member's does, #1073)
  const union =
    'let flagHost = askBoolean "f"\nlet d = dict{a: 1}\nlet value: boolean | string | null = d.get("x", default: null)\n' +
    'if flagHost { value = "w" }\nsay d.get(value, default: 0)\nexit\n';
  const request = coreRequest([{ path: "main.tease", source: union }], ["hostValue"]);
  assert.ok(request !== null);
  assert.ok(
    inBothOrders(() =>
      analyseCore(request).diagnostics.some(
        (d) =>
          d.class === "compile-error" &&
          d.kind !== "written-type" &&
          d.requiredCheck?.missingTests[0] === "if value is string",
      ),
    ),
  );
  // (S7: a method call's receiver that may be null is the runtime's check at the call, where a run fails: Codex r3 F6)
  for (const source of [
    "let xs = [null, [1]]\nxs[0].sort()\nexit\n",
    "let xs = [null, [1]]\n(xs[0]).sort()\nexit\n",
    'let xs = [null, ["a"]]\nsay xs[0].join(",")\nexit\n',
  ]) {
    const request = coreRequest([{ path: "main.tease", source }]);
    assert.ok(request !== null, source);
    const syntax = syntaxOf(source);
    const derived = derive(syntax, compactAnalysis(request));
    const failure = evaluate(syntax, derived.stores, {}, false, derived.content).run.failure;
    assert.ok(
      derived.discharges.some(
        (d) => d.by === "native" && d.what === "member" && `TSR016@${d.site}` === failure,
      ),
      `${source}: ${failure} ${JSON.stringify(derived.discharges)}`,
    );
  }
  // (S7: C1's check of a copied integer that may be null is its store's, and the predicted run fails where the plan's
  // does: Sol's classification F1 on #1937)
  const copied =
    "let t:integer=7\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet other={n:null,nest:{n:null,keep:1},spare:1}\n" +
    "let a=root\nif other != null { a=other }\nlet b=a\nrepeat b.n {}\nexit\n";
  const copiedRequest = coreRequest([{ path: "main.tease", source: copied }]);
  assert.ok(copiedRequest !== null);
  const syntax = syntaxOf(copied);
  const derived = derive(syntax, compactAnalysis(copiedRequest));
  assert.ok(
    derived.discharges.some((d) => d.by === "store"),
    JSON.stringify(derived.discharges),
  );
  const compiled = candidate(copied);
  assert.ok(compiled.plan !== null);
  assert.deepEqual(
    runGlobals(compiled.plan, {}),
    evaluate(syntax, derived.stores, {}, false, derived.content).run,
  );
});

test("the tested-producer rule admits its closed set of forms over every axis, and anything else is the route rule's error (AD-1, #1073 PR 4)", () => {
  // (the open-set rule: the expected outcome comes from the rule's own table, never from the engine. A test removes the
  // offending kind where it holds (H) or where it fails (F); `not` swaps the two; a position takes H, F or neither; an
  // exit kind leaves for good. A use with a check on every route warns; any other is the error)
  const KINDS = {
    null: {
      declare: 'function f { if askBoolean("f") { return null }\n return 1 }\n',
      forms: [
        ["f() != null", true, false],
        ["f() == null", false, true],
        ["f() is integer", true, false],
        ["f() is integer?", false, true],
        ["f() != 2", false, false],
      ],
    },
    string: {
      declare: 'function f: integer | string { if askBoolean("f") { return "s" }\n return 1 }\n',
      forms: [
        ["f() is integer", true, false],
        ["f() is string", false, true],
        ["f() is not string", true, false],
        // (where `f() != null` fails, the value tested is null: not a string)
        ["f() != null", false, true],
        ["f() != 2", false, false],
      ],
    },
  } as const;
  type Proof = (holds: boolean, fails: boolean) => boolean;
  const USE = "repeat f() {}";
  const COMPARE = "f() > 0";
  const H: Proof = (holds) => holds;
  const F: Proof = (_, fails) => fails;
  const NEVER: Proof = () => false;
  // (each position: its source around a condition `C` and an exit `E`, what proves it, and the exit kinds it takes)
  const ANY = ["exit", "end", "return", "goto", "continue", "break"] as const;
  const TOP = ["exit", "end", "goto"] as const;
  const POSITIONS: readonly (readonly [
    string,
    (c: string, e: string) => string,
    Proof,
    readonly string[],
  ])[] = [
    ["then arm", (c) => `if ${c} { ${USE} }`, H, ["none"]],
    ["else arm", (c) => `if ${c} { say "n" } else { ${USE} }`, F, ["none"]],
    ["else-if arm", (c) => `if ${c} { say "n" } else if askBoolean("e") { ${USE} }`, F, ["none"]],
    ["nested in then arm", (c) => `if ${c} { if askBoolean("e") { ${USE} } }`, H, ["none"]],
    ["loop body", (c) => `while ${c} { ${USE}\nbreak }`, H, ["none"]],
    ["after an and", (c) => `if ${c} and ${COMPARE} { say "y" }`, H, ["none"]],
    ["after an or", (c) => `if ${c} or ${COMPARE} { say "y" }`, F, ["none"]],
    ["before an and", (c) => `if ${COMPARE} and ${c} { say "y" }`, NEVER, ["none"]],
    ["past a while", (c) => `while ${c} { say "w" }\n${USE}`, F, ["none"]],
    [
      "past a while a break leaves",
      (c) => `while ${c} { if askBoolean("b") { break } }\n${USE}`,
      NEVER,
      ["none"],
    ],
    ["past a leaving then arm", (c, e) => `if ${c} { ${e} }\n${USE}`, F, ANY],
    [
      "past a leaving then arm with an else",
      (c, e) => `if ${c} { ${e} } else { say "y" }\n${USE}`,
      F,
      ANY,
    ],
    ["past a leaving else arm", (c, e) => `if ${c} { say "y" } else { ${e} }\n${USE}`, H, ANY],
    [
      "past a guard in both arms",
      (c, e) => `if askBoolean("s") { if ${c} { ${e} } } else { if ${c} { ${e} } }\n${USE}`,
      F,
      ANY,
    ],
    [
      "past a guard in one arm",
      (c, e) => `if askBoolean("s") { if ${c} { ${e} } }\n${USE}`,
      NEVER,
      ANY,
    ],
    [
      "past a guard a label follows",
      (c, e) => `if askBoolean("g") { goto back }\nif ${c} { ${e} }\nlabel back\n${USE}`,
      NEVER,
      TOP,
    ],
    ["past a loop holding a guard", (c, e) => `repeat 2 { if ${c} { ${e} } }\n${USE}`, NEVER, ANY],
  ];
  // (an exit kind's frame: `return` in a function, `continue` and `break` in a loop, `goto` to a label after the use)
  const framed = (exit: string, body: string): string =>
    exit === "return"
      ? `function h {\n${body}\n}\nh()\n`
      : exit === "continue" || exit === "break"
        ? `repeat 2 {\n${body}\n}\n`
        : exit === "goto"
          ? `${body}\nlabel done\n`
          : `${body}\n`;
  const statement = (exit: string): string => (exit === "goto" ? "goto done" : exit);
  const covered = new Set<string>();
  const wrong: string[] = [];
  for (const [kind, { declare, forms }] of Object.entries(KINDS))
    for (const [test, holds, fails] of forms)
      for (const negated of [false, true])
        for (const [position, make, proof, exits] of POSITIONS)
          for (const exit of exits) {
            const condition = negated ? `not (${test})` : test;
            const source = declare + framed(exit, make(condition, statement(exit))) + "exit\n";
            const checked = negated ? proof(fails, holds) : proof(holds, fails);
            const request = coreRequest([{ path: "main.tease", source }]);
            assert.ok(request !== null, source);
            const error = inBothOrders(() =>
              analyseCore(request).diagnostics.some((d) => d.class === "compile-error"),
            );
            if (error === checked)
              wrong.push(`${checked ? "warning" : "error"} expected: ${source}`);
            covered.add([kind, test, negated, position, exit].join(" | "));
          }
  assert.deepEqual(wrong, []);
  // (the coverage check: every kind, form, polarity, position and exit kind it takes, each once)
  const expected = Object.values(KINDS).reduce(
    (sum, { forms }) =>
      sum + forms.length * 2 * POSITIONS.reduce((count, [, , , exits]) => count + exits.length, 0),
    0,
  );
  assert.equal(covered.size, expected);
});

// (Sol's F2 on #1937, the lead's default (Codex r6, r7), narrowed by #1938: the expected outcome from
// the rule's own table, never the engine's. A writer of a possible null; an `if` whose one arm overwrites the key; its
// test of `other` gives an arm no run enters where `other` holds no kind that arm's entry narrowing keeps. The route
// past the `if` takes the arm without the overwrite: the use errs where a run enters that arm, and keeps the warning
// where none does. Unknown forms count as runs)
const FEASIBILITY = {
  // (`other` may be an object, null or text: every arm of every form is entered on some run)
  feasible:
    'let other = {k: 1}\nif askBoolean("o") { other = null }\nif askBoolean("p") { other = "s" }\n',
  // (`other` is an object on every run)
  "infeasible by entry narrowing": "let other = {k: 1}\n",
  // (a comparison, not N1's form: the guard proves nothing, and the arm counts as a run, #1938's residual)
  unknown: "let other = {k: 1}\n",
} as const;
// (each form: whether its truth, and its falsity, leaves an object no kind)
const FORMS: readonly (readonly [string, boolean, boolean])[] = [
  ["other != null", false, true],
  ["other == null", true, false],
  ["other is string", true, false],
];

// (the default's siblings, each the warning: a whole copy, nesting, `else if`, a loop's body, a second callable, a
// callable reached through another; and a program whose arms are all entered keeps the error)
const writer = 'let c = askBoolean "c"\nlet n = 1\nif c { n = null }\nlet other = {k: 1}\n';
const SIBLINGS: readonly (readonly [string, string, boolean])[] = [
  [
    "a whole copy",
    "let t:integer?=null\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet other={n:8,nest:{n:8,keep:1},spare:1}\n" +
      "let a=root\nif other != null { a=other }\nlet b=a\nrepeat b.n {}\nexit\n",
    false,
  ],
  [
    "a nested if",
    `${writer}if other != null { if other != null { n = 1 } }\nrepeat n {}\nexit\n`,
    false,
  ],
  [
    "an else if",
    `${writer}if askBoolean("e") { n = 1 } else if other != null { n = 1 }\nrepeat n {}\nexit\n`,
    false,
  ],
  ["a loop's body", `${writer}repeat 2 { if other != null { n = 1 } }\nrepeat n {}\nexit\n`, false],
  [
    "a second callable",
    "function g {\n  let o = {k: 1}\n  let r = null\n  if o != null { r = 1 }\n  return r\n}\nlet n = g()\nrepeat n {}\nexit\n",
    false,
  ],
  // (Codex r7: a callable whose result or default reaches the use through another callable)
  [
    "two callees",
    "function g {\n let other = {k:1}\n let r = null\n if other != null { r = 1 }\n return r\n}\nfunction h { return g() }\nrepeat h() {}\nexit\n",
    false,
  ],
  [
    "two callees through a store",
    "function g {\n let other = {k:1}\n let r = null\n if other != null { r = 1 }\n return r\n}\nfunction h { return g() }\nlet n=h()\nrepeat n {}\nexit\n",
    false,
  ],
  [
    "two callees through a fallback",
    "function g {\n let other = {k:1}\n let r = null\n if other != null { r = 1 }\n return r\n}\nfunction h { return null otherwise g() }\nrepeat h() {}\nexit\n",
    false,
  ],
  [
    "a field copied from a callee",
    "function g {\n let other = {k:1}\n let r = null\n if other != null { r = 1 }\n return r\n}\nlet a={n:g()}\nlet b=a\nrepeat b.n {}\nexit\n",
    false,
  ],
  [
    "a default through two callees",
    "function g {\n let other = {k:1}\n let r = null\n if other != null { r = 1 }\n return r\n}\nfunction h { return g() }\nfunction f(n=h()) { repeat n {} }\nf()\nf(1)\nexit\n",
    false,
  ],
  [
    "a second callable whose arms are entered",
    'function g {\n  if askBoolean("g") { return null }\n  return 1\n}\nlet n = g()\nrepeat n {}\nexit\n',
    true,
  ],
];

// (the unavailable axis, Sol's final F1 on #1937 and the lead's ruling: a tested read whose answer is missing blocks
// promotion, at a demand allowance that stops its decision and at the natural one; external data's answer does not)
const realRoute = "let n = 1\nif hostValue is boolean { n = null }\n";
const UNAVAILABLE: readonly (readonly [string, string, number | null, boolean])[] = [
  [
    "a stopped tested read",
    "function g { let o = {k: 1}\nlet r = null\nif o != null { r = 1 }\nreturn r }\nfunction h { return g() }\nrepeat h() {}\nexit\n",
    64,
    false,
  ],
  [
    "a stopped tested read, natural allowance",
    "function g { let o = {k: 1}\nlet r = null\nif o != null { r = 1 }\nreturn r }\nfunction h { return g() }\nrepeat h() {}\nexit\n",
    null,
    false,
  ],
  [
    "a tested read admission has no items for (#2009)",
    `${realRoute}let box = {first: {k: 1}}\nif box.first != null { say "y" }\nrepeat n {}\nexit\n`,
    null,
    false,
  ],
  [
    "a tested read with an empty answer (Codex r9)",
    `${realRoute}let xs = []\nlet q = xs[0].k\nif q != null { say "y" }\nrepeat n {}\nexit\n`,
    null,
    false,
  ],
  [
    "a tested read of external data, the control",
    `${realRoute}if hostValue != null { say "y" }\nrepeat n {}\nexit\n`,
    null,
    true,
  ],
];

// (the default narrowed (#1938 and its design round): beside an arm no run enters, only a certificate its
// own value proves promotes, through arms runs enter and loops they leave. The round's sources, each the warning where
// no run reaches the use with null, and the under-offers the narrowing releases, each the error)
const gate = "let n=1\nif hostValue is boolean { n=null }\n";
const merged = "let a = null\nlet other = { k: 1 }\nif other != null { a = 1 }\n";
const pasted = (save: string) =>
  'let keyA = "alpha"\nlet keyB = "beta"\nlet raw = 1\nraw = load(keyA, default: null)\n' +
  'if askBoolean("Second ingress?") { raw = load(keyB, default: null) }\n' +
  'if askBoolean("Opaque source?") { let value = player.firstName\nif value is integer { raw = value } }\n' +
  `${save}repeat raw {}\nexit\n`;
const NARROWED: readonly (readonly [string, string, boolean])[] = [
  [
    "an inline fallback whose left side is merged",
    `${merged}repeat (a otherwise null) {}\nexit\n`,
    false,
  ],
  [
    "an inline fallback of a copy",
    `${merged}let b = a\nrepeat (b otherwise null) {}\nexit\n`,
    false,
  ],
  [
    "an inline fallback behind a nested overwrite",
    "let a = null\nlet other = { k: 1 }\nif other != null { if other != null { a = 1 } }\n" +
      "repeat (a otherwise null) {}\nexit\n",
    false,
  ],
  [
    "a lookup's default where the element exists",
    'let data = [1]\nlet other = { k: 1 }\nif other != null { say "ok" }\nrepeat data.get(0, default: null) {}\nexit\n',
    false,
  ],
  [
    "a stored fallback whose left side is merged",
    `${merged}let n = a otherwise null\nrepeat n {}\nexit\n`,
    false,
  ],
  [
    "a loop only an infeasible break leaves",
    `${gate}let other = {k: 1}\nwhile true { if other == null { break } }\nrepeat n {}\nexit\n`,
    false,
  ],
  [
    "an unrelated guard before the use",
    `${gate}let o={k:1}\nif o != null { say "guard" }\nrepeat n {}\nexit\n`,
    true,
  ],
  [
    "an unrelated guard after the use",
    `${gate}repeat n {}\nlet o={k:1}\nif o != null { say "guard" }\nexit\n`,
    true,
  ],
  [
    "a loop whose header no run leaves",
    `${gate}let o = {k: 1}\nif o != null { say "guard" }\nwhile o != null {}\nrepeat n {}\nexit\n`,
    false,
  ],
  [
    "a loop whose header a run leaves, beside an arm no run enters (the claim's residual)",
    `${gate}let o = {k: 1}\nif o != null { say "guard" }\nwhile hostValue != null { say "w" }\nrepeat n {}\nexit\n`,
    false,
  ],
  ...[
    "while o != null or p != null {}",
    "while o != null and p != null {}",
    "while not (o == null and p == null) {}",
  ].map((loop): readonly [string, string, boolean] => [
    `a compound header no run leaves: ${loop}`,
    `${gate}let o = {k: 1}\nif o != null { say "guard" }\nlet p = {k: 2}\n${loop}\nrepeat n {}\nexit\n`,
    false,
  ]),
  [
    "an inline load after a loop no run leaves",
    'let declared: integer? = load("k", default: 1)\nlet o = {k: 1}\nif o != null { say "guard" }\n' +
      'while o != null {}\nrepeat load("k", default: null) {}\nexit\n',
    false,
  ],
  [
    "a stored writer after a loop no run leaves",
    'let o = {k: 1}\nif o != null { say "guard" }\nwhile o != null {}\n' +
      "let n=1\nif hostValue is boolean { n=null }\nrepeat n {}\nexit\n",
    false,
  ],
  [
    "a function whose only call is in an arm no run enters",
    "let o = {k: 1}\nfunction f { let n = 1\nif hostValue is boolean { n = null }\nrepeat n {} }\n" +
      "if o == null { f() }\nexit\n",
    false,
  ],
  [
    "a label between the writer and the use",
    `${gate}let o = {k: 1}\nif o != null { say "guard" }\nlabel again\nrepeat n {}\nexit\n`,
    false,
  ],
  [
    "a goto past the use",
    `${gate}let o = {k: 1}\nif o == null { goto skip }\nrepeat n {}\nlabel skip\nexit\n`,
    false,
  ],
  [
    "a backward goto around the use",
    `${gate}let o = {k: 1}\nlabel top\nif o != null { say "guard" }\nrepeat n {}\nif o == null { goto top }\nexit\n`,
    false,
  ],
  [
    "a call in the condition of the arm holding the use",
    `${gate}function stop {\n  let box = {k: 1}\n  if box != null { exit }\n  return true\n}\nif stop() { repeat n {} }\nexit\n`,
    false,
  ],
  [
    "a handler declared in the condition of the arm holding the use",
    `${gate}let o = {k: 1}\nif o != null { say "guard" }\nif (timer async 1 ms { exit }) != null {\nwait 2 ms\nrepeat n {}\n}\nexit\n`,
    false,
  ],
  [
    "a call in the subject of the switch holding the use",
    `${gate}let o = {k: 1}\nif o != null { say "guard" }\nfunction pick {\n  let box = {k: 1}\n  if box != null { exit }\n  return 1\n}\nswitch pick() { case 2 { say "two" } default { repeat n {} } }\nexit\n`,
    false,
  ],
  [
    "a call in the condition of the arm holding the writer",
    'let n=1\nlet o = {k: 1}\nif o != null { say "guard" }\nfunction stop {\n  let box = {k: 1}\n  if box != null { exit }\n  return true\n}\nif stop() { n=null }\nrepeat n {}\nexit\n',
    false,
  ],
  [
    "a conditional exit before the use",
    `${gate}let o = {k: 1}\nif o != null { say "guard" }\nif askBoolean("q") { exit }\nrepeat n {}\nexit\n`,
    false,
  ],
  [
    "a timer declared before the use",
    `${gate}let o = {k: 1}\nif o != null { say "guard" }\ntimer async 1 ms { exit }\nwait 2 ms\nrepeat n {}\nexit\n`,
    false,
  ],
  [
    "a writer in a loop whose header no run leaves",
    'let n=1\nlet o = {k: 1}\nif o != null { say "guard" }\nwhile o != null { if hostValue is boolean { n=null } }\nrepeat n {}\nexit\n',
    false,
  ],
  [
    "a use in a loop body no run enters",
    `${gate}let o = {k: 1}\nif o != null { say "guard" }\nwhile o == null { repeat n {} }\nexit\n`,
    false,
  ],
  [
    "a use in an arm no run enters",
    `${gate}let o = {k: 1}\nif o == null { repeat n {} }\nexit\n`,
    false,
  ],
  [
    "a writer in an arm no run enters",
    "let n=1\nlet o = {k: 1}\nif o == null { n=null }\nrepeat n {}\nexit\n",
    false,
  ],
  [
    "a scalar copy of a literal's witness",
    `${gate}let o = {k: 1}\nif o != null { say "guard" }\nlet m = n\nrepeat m {}\nexit\n`,
    true,
  ],
  [
    "a stored fallback whose left side's own null reaches it",
    'let a = null\nif hostValue is boolean { a = 1 }\nlet o = {k: 1}\nif o != null { say "guard" }\n' +
      "let m = a otherwise null\nrepeat m {}\nexit\n",
    true,
  ],
  [
    "an inline load in an arm no run enters",
    'let declared: integer? = load("k", default: 1)\nlet o = {k: 1}\nif o != null { say "guard" }\n' +
      'if o == null { repeat load("k", default: null) {} }\nexit\n',
    false,
  ],
  [
    "an inline load in an unavailable arm",
    'let box = {first: {k: 1}}\nif box.first != null { repeat load("k", default: null) {} }\nexit\n',
    false,
  ],
  [
    "an inline load in an entered arm",
    'let declared: integer? = load("k", default: 1)\nlet o = {k: 1}\nif o != null { say "guard" }\n' +
      'if o != null { repeat load("k", default: null) {} }\nexit\n',
    true,
  ],
  ["a load's literal default beside an unavailable arm", pasted(""), true],
  [
    "a load's literal default where the program saves its key",
    pasted('if askBoolean("Keep?") { save 2 as "beta" }\n'),
    false,
  ],
  [
    "a load's literal default where a function saves its key",
    pasted('function keep { save 2 as "beta" }\nif askBoolean("Keep?") { keep() }\n'),
    false,
  ],
  [
    "a load's literal default where a timer saves its key",
    pasted('timer async 1 s { save 2 as "beta" }\n'),
    false,
  ],
  [
    "a load's literal default where the program saves under a computed key",
    pasted('let which = "be" + "ta"\nif askBoolean("Keep?") { save 2 as which }\n'),
    false,
  ],
];

test("a route through an arm its entry narrowing leaves no kind does not promote, and a route around it does (AD-1, #1938)", () => {
  const covered = new Set<string>();
  const wrong: string[] = [];
  for (const [feasibility, declare] of Object.entries(FEASIBILITY))
    for (const [test, holds, fails] of FORMS)
      for (const negated of [false, true])
        for (const killIn of ["then", "else"] as const) {
          const plain = feasibility === "unknown" ? "other.k == 1" : test;
          const condition = negated ? `not (${plain})` : plain;
          const kill = "n = 1";
          const statement =
            killIn === "then"
              ? `if ${condition} { ${kill} }`
              : `if ${condition} { say "y" } else { ${kill} }`;
          const source =
            'let c = askBoolean "c"\nlet n = 1\nif c { n = null }\n' +
            declare +
            statement +
            "\nrepeat n {}\nexit\n";
          // (the route takes the `else` arm or the way past where the overwrite is in `then`, the `then` arm otherwise; an
          // object leaves an arm no kind where its side of the form removes it, and `not` swaps the sides)
          const thenDead = negated ? fails : holds;
          const elseDead = negated ? holds : fails;
          const routeArmDead =
            feasibility === "infeasible by entry narrowing" &&
            (killIn === "then" ? elseDead : thenDead);
          const request = coreRequest([{ path: "main.tease", source }]);
          assert.ok(request !== null, source);
          const [error, warning] = inBothOrders(() => {
            const diagnostics = analyseCore(request).diagnostics;
            return [
              diagnostics.some((d) => d.class === "compile-error"),
              diagnostics.some((d) => d.class === "warning-runtime-check"),
            ] as const;
          });
          if (error === routeArmDead || (routeArmDead && !warning))
            wrong.push(`${routeArmDead ? "warning" : "error"} expected: ${source}`);
          covered.add([feasibility, test, negated, killIn].join(" | "));
        }
  for (const [name, source, expected] of SIBLINGS) {
    const request = coreRequest([{ path: "main.tease", source }]);
    assert.ok(request !== null, source);
    const [error, warning] = inBothOrders(() => {
      const diagnostics = analyseCore(request).diagnostics;
      return [
        diagnostics.some((d) => d.class === "compile-error"),
        diagnostics.some((d) => d.class === "warning-runtime-check"),
      ] as const;
    });
    if (error !== expected || (!expected && !warning))
      wrong.push(`${expected ? "error" : "warning"} expected (${name}): ${source}`);
    covered.add(`sibling | ${name}`);
  }
  for (const [name, source, allowance, expected] of UNAVAILABLE) {
    const request = coreRequest([{ path: "main.tease", source }]);
    assert.ok(request !== null, source);
    const [error, warning] = inBothOrders(() => {
      const run = () => analyseCore(request).diagnostics;
      const diagnostics = allowance === null ? run() : withTestDemandAllowance(allowance, run);
      return [
        diagnostics.some((d) => d.class === "compile-error"),
        diagnostics.some((d) => d.class === "warning-runtime-check"),
      ] as const;
    });
    if (error !== expected || (!expected && !warning))
      wrong.push(`${expected ? "error" : "warning"} expected (${name}): ${source}`);
    covered.add(`unavailable | ${name}`);
  }
  for (const [name, source, expected] of NARROWED) {
    const request = coreRequest([{ path: "main.tease", source }]);
    assert.ok(request !== null, source);
    const [error, warning] = inBothOrders(() => {
      const diagnostics = analyseCore(request).diagnostics;
      return [
        diagnostics.some((d) => d.class === "compile-error"),
        diagnostics.some((d) => d.class === "warning-runtime-check"),
      ] as const;
    });
    if (error !== expected || (!expected && !warning))
      wrong.push(`${expected ? "error" : "warning"} expected (${name}): ${source}`);
    covered.add(`narrowed | ${name}`);
  }
  // (an unconditional exit before the use: no run reaches it, so it is never the route rule's error, #1938)
  {
    const request = coreRequest([
      {
        path: "main.tease",
        source: `${gate}let o = {k: 1}\nif o != null { say "guard" }\nexit\nrepeat n {}\nexit\n`,
      },
    ]);
    assert.ok(request !== null, "the unconditional exit's program");
    const error = inBothOrders(() =>
      analyseCore(request).diagnostics.some((d) => d.class === "compile-error"),
    );
    if (error) wrong.push("no error expected (an unconditional exit before the use)");
    covered.add("narrowed | an unconditional exit before the use");
  }
  // (a called file's top level is entered by its `call`, here only in an arm no run enters, #1938)
  const calledFile = [
    { path: "main.tease", source: 'let o = {k: 1}\nif o == null { call "part.tease" }\nexit\n' },
    {
      path: "part.tease",
      source: "let n = 1\nif hostValue is boolean { n = null }\nrepeat n {}\n",
    },
  ];
  {
    const request = coreRequest(calledFile);
    assert.ok(request !== null, "the called file's project");
    const [error, warning] = inBothOrders(() => {
      const diagnostics = analyseCore(request).diagnostics;
      return [
        diagnostics.some((d) => d.class === "compile-error"),
        diagnostics.some((d) => d.class === "warning-runtime-check"),
      ] as const;
    });
    if (error || !warning)
      wrong.push("warning expected (a file called only in an arm no run enters)");
    covered.add("narrowed | a file called only in an arm no run enters");
  }
  assert.deepEqual(wrong, []);
  // (the coverage check: every feasibility, form, polarity and position, every sibling, every unavailable cell and every
  // case of the narrowed default)
  assert.equal(
    covered.size,
    Object.keys(FEASIBILITY).length * FORMS.length * 2 * 2 +
      SIBLINGS.length +
      UNAVAILABLE.length +
      NARROWED.length +
      2,
  );
});
