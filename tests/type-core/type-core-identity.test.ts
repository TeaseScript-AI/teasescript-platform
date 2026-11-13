// pins: listed parentheses-unwrapping sites | line /^ {4}\d+,$|^ {2}"[^"]+": \[\d+, "/u
// #2493: the type analysis reads a call of an identity function as its argument in parentheses (`identity-view.ts`).
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "../../src/parser.js";
import { identityView } from "../../src/type-inference/core/identity-view.js";
import { coreRequest, type SourceFile } from "../helpers/type-core-analysis.js";
import {
  analysisByLine,
  checkedByLine,
  compiledByLine,
  markedSource,
  MODES,
  type Mode,
} from "../helpers/type-core-oracles.js";

const main = (source: string): SourceFile[] => [{ path: "main.tease", source }];
const PASS = "global function pass(given) {\n  return given\n}\n";
const OWN_PASS = "function pass(given) {\n  return given\n}\n";

test("which calls the analysis reads as their argument", () => {
  // [form, files, calls read as their argument; null where the names fail before the analysis]
  const rows: readonly (readonly [string, readonly SourceFile[], number | null])[] = [
    ["a call", main(`${PASS}let a = pass(3)\nrepeat a {}\nexit`), 1],
    ["a file's own helper", main(`${OWN_PASS}let a = pass(3)\nrepeat a {}\nexit`), 1],
    [
      "a global helper, from another file",
      [
        { path: "main.tease", source: 'let a = pass(3)\nsay "${a}"\nexit' },
        { path: "other.tease", source: PASS },
      ],
      1,
    ],
    [
      "a parameter of the helper's name in another file",
      [
        { path: "main.tease", source: `${OWN_PASS}let a = pass(3)\nsay "\${a}"\nexit` },
        { path: "other.tease", source: "global function run(pass) {\n  return pass\n}\n" },
      ],
      1,
    ],
    [
      "a variable of the helper's name in another file",
      [
        { path: "main.tease", source: `${OWN_PASS}let a = pass(3)\nsay "\${a}"\nexit` },
        {
          path: "other.tease",
          source: "global function run {\n  let pass = [1]\n  return pass\n}\n",
        },
      ],
      1,
    ],
    ["a named argument", main(`${PASS}let a = pass(given: 3)\nrepeat a {}\nexit`), 0],
    ["a method of the helper's name", main(`${PASS}let xs = [1]\nlet a = xs.pass(3)\nexit`), 0],
    [
      "two files' own helpers of one name",
      [
        { path: "main.tease", source: `${OWN_PASS}let a = pass(3)\nsay "\${a}"\nexit` },
        {
          path: "other.tease",
          source: 'function pass(given) {\n  return [given]\n}\nlet b = pass(4)\nsay "${b}"\n',
        },
      ],
      0,
    ],
    [
      "a typed parameter",
      main('function pass(given: number) {\n  return given\n}\nsay "${pass(3)}"\nexit'),
      0,
    ],
    [
      "a parameter's default",
      main('function pass(given = 1) {\n  return given\n}\nsay "${pass(3)}"\nexit'),
      0,
    ],
    [
      "a result type",
      main('function pass(given): number {\n  return given\n}\nsay "${pass(3)}"\nexit'),
      0,
    ],
    [
      "two parameters",
      main('function pass(given, other) {\n  return given\n}\nsay "${pass(3, 4)}"\nexit'),
      0,
    ],
    [
      "a body that does more",
      main('function pass(given) {\n  say "x"\n  return given\n}\nsay "${pass(3)}"\nexit'),
      0,
    ],
    // the front end refuses a name that shadows a function, and a call through a value
    [
      "a parameter's call",
      main(`${PASS}global function run(pass) {\n  return pass(3)\n}\nsay "\${run(1)}"\nexit`),
      null,
    ],
    [
      "a variable's call",
      main(
        `${PASS}global function run {\n  let pass = 2\n  return pass(3)\n}\nsay "\${run}"\nexit`,
      ),
      null,
    ],
    ["a loop variable", main(`${PASS}for pass in [1, 2] {\n  say "\${pass}"\n}\nexit`), null],
    [
      "a nested function",
      main(
        `${PASS}function run {\n  function pass(given) {\n    return [given]\n  }\n  return pass(1)\n}\nsay "\${run}"\nexit`,
      ),
      null,
    ],
    ["a call through a value", main(`${PASS}let f = pass\nlet a = f(3)\nexit`), null],
    // a place slot keeps the call (its result is a copy); a value beside it does not
    [
      "a store's receiver, and its value",
      main(`${PASS}let box = {n: 1}\npass(box).n = pass(2)\nexit`),
      1,
    ],
    [
      "a store's receiver below a property and an element, in parentheses",
      main(`${PASS}let box = {a: [{n: 1}]}\n(pass(box)).a[pass(0)].n += 1\nexit`),
      1,
    ],
    [
      "a changing method's receiver, and its argument",
      main(`${PASS}let xs = [1]\npass(xs).add(pass(2))\nexit`),
      1,
    ],
    ["a reading method's receiver", main(`${PASS}let xs = [1]\nsay "\${pass(xs).count}"\nexit`), 1],
    [
      "a null test's and a comparison's operands (a test reads a value)",
      main(`${PASS}let a = hostValue\nif pass(a) != null and pass(a.n) < 2 {\n  say "x"\n}\nexit`),
      2,
    ],
    [
      "a type test's subject and a switch subject (a test reads a value)",
      main(
        `${PASS}let a = hostValue\nif pass(a) is string {\n  say "x"\n}\nswitch pass(a) {\n  case is string {\n    say "s"\n  }\n}\nexit`,
      ),
      2,
    ],
  ];
  for (const [form, files, calls] of rows) {
    const request = coreRequest(files);
    assert.equal(request === null ? null : identityView(request).calls, calls, form);
  }
});

test("an identity call keeps a narrowing as its argument in parentheses does, and ends what the argument ends", () => {
  // ADR 0021 rule 5.5 drops a check across "code that may run and change the path: a call"; the call of an identity
  // function runs its argument and nothing else
  const kept =
    'global data: string? = null\nglobal function change {\n  data = null\n  return 1\n}\nif hostValue {\n  data = "s"\n}\n' +
    'if data != null {\n  let other = ⟦5⟧\n  say "${data.length} ${other}"\n}\nlet x = change()\nexit';
  const ended =
    'global data: string? = "a"\nglobal function change {\n  data = null\n  return 1\n}\n' +
    'if data != null {\n  let other = ⟦change()⟧\n  say "${data.length} ${other}"\n}\nexit';
  for (const marked of [kept, ended]) {
    const files = (form: "pass" | "parentheses"): SourceFile[] => main(markedSource(marked, form));
    for (const mode of MODES)
      assert.equal(
        analysisByLine(files("pass"), mode),
        analysisByLine(files("parentheses"), mode),
        marked,
      );
  }
});

// Sources whose marked expressions pass through the helper: each gives what its twin gives, which declares the helper
// and calls it nowhere, in the analysis and in the finished compile and its run. Each row names what it reads across
// the view's boundary.
const WRAPPED: readonly (readonly [string, string])[] = [
  [
    "a run-time check of a typed variable's start value",
    'let xs: (integer | string)[] = [1, "s"]\nlet w: integer = ⟦xs[1]⟧\nsay "${w}"\nexit',
  ],
  [
    "a run-time check of a repeat count",
    'let xs: (integer | string)[] = [1, "s"]\nsay "before"\nrepeat ⟦xs[1]⟧ {\n  say "x"\n}\nexit',
  ],
  [
    "a written variable's start value (the front end's written variables)",
    'let text = ⟦"7,25"⟧\ntext = "  +7.25e1  "\nlet result = toNumber(text, default: 0.0)\nsay "${result}"\nexit',
  ],
  [
    "a function's sole return value",
    'global function ratio {\n  return ⟦3 / 2⟧\n}\nlet r = ratio()\nsay "${r}"\nexit',
  ],
  [
    // (a comparison's operand is a place slot, r4-452: the operands of its operand are values)
    "list elements and property values, a condition and the operands of a comparison's operand",
    "let point = {x: ⟦1⟧, ys: [⟦2⟧, ⟦2.5⟧]}\nif ⟦⟦point.x⟧ + ⟦1⟧ > 1⟧ {\n  repeat point.ys[0] {}\n}\nexit",
  ],
  // a test reads its subject's value: a test of the call's result narrows its argument (r4-452)
  [
    "a type test's subject",
    'let v = load("v", default: 4.5)\nif ⟦v⟧ is integer {\n  let whole: integer = v\n  say "${whole}"\n}\nexit',
  ],
  [
    "a switch subject",
    'let a: string? = "s"\nswitch ⟦a⟧ {\n  case is string {\n    let s: string = a\n    say s\n  }\n}\nexit',
  ],
  ["a comparison's operand", 'let a = "s"\nif ⟦a⟧ == "s" {\n  say a\n}\nexit'],
  [
    "a null test's subject changed inside the tested expression",
    "global data: integer? = 1\nglobal function clear {\n  data = null\n  return true\n}\nif ⟦data⟧ != null and clear() {\n  repeat data {}\n}\nexit",
  ],
  [
    "a tested path below the argument",
    'let box = {n: 1}\nif load("clear", default: true) {\n  box.n = null\n}\nif ⟦box⟧.n != null {\n  repeat box.n {}\n}\nexit',
  ],
  [
    "a null test's subject, changed before an asynchronous handler it encloses runs (the clock advanced)",
    "global data: integer? = 1\nif ⟦data⟧ != null {\n  timer async 1 s {\n    repeat data {}\n  }\n  data = null\n  wait 2 s\n}\nexit",
  ],
  [
    "a tested path below the argument, changed after the test",
    "let box = {n: 1}\nif ⟦box⟧.n != null {\n  box.n = null\n  repeat box.n {}\n}\nexit",
  ],
];

test("a load's default passed through an identity function gives its twin's analysis", () => {
  // (the plan keeps the call: a default that is a call runs as instructions and its value is checked against the
  // load's type, `lowerLoadTask`, where a literal default stays inside the load)
  const marked = 'let n: integer = load("count", default: ⟦0⟧)\nsay "${n}"\nexit';
  for (const mode of MODES)
    assert.equal(
      analysisByLine(main(markedSource(marked, "pass")), mode),
      analysisByLine(main(markedSource(marked, "plain")), mode),
    );
});

test("a source whose values pass through an identity function gives what its twin gives, compiled and run past the syntax check that refuses a function", () => {
  for (const [what, marked] of WRAPPED) {
    const twin = main(markedSource(marked, "plain"));
    const wrapped = main(markedSource(marked, "pass"));
    for (const mode of MODES) {
      assert.equal(analysisByLine(wrapped, mode), analysisByLine(twin, mode), what);
      assert.deepEqual(compiledByLine(wrapped, mode), compiledByLine(twin, mode), what);
    }
  }
});

test("a widened identity result adds no run-time stop to its twin's run, past the syntax check that refuses a function", () => {
  // rule 1.2 makes `a` a number by the other calls, and its `repeat` a compile error the build does not give (#1173's
  // gap); the value is 3 when the script runs. A relation only: the route does not take a function yet.
  const marked = "let a = ⟦3⟧\nlet b = ⟦null⟧\nlet c = ⟦1.5⟧\nrepeat a {}\nexit";
  const stops = (form: "plain" | "pass", mode: Mode): readonly string[] | undefined =>
    compiledByLine(main(markedSource(marked, form)), mode).run?.filter((event) =>
      event.startsWith("TSR"),
    );
  for (const mode of MODES) assert.deepEqual(stops("pass", mode), stops("plain", mode));
});

const WITNESS_WHAT = "the receiver of a method whose callee is in parentheses";
const WITNESS = 'let xs = []\nlet held = xs\n(⟪xs⟫.add)(1)\nxs.add("s")\nsay "${xs[0]}"\nexit';

/**
 * Sources whose `⟪argument⟫` stands in a place slot, as `pass(argument)` or as `held`, a copy of the argument that the
 * line before declares in both forms: the call stays a call, its result a copy (#2493, r4-452).
 */
const PLACES: readonly (readonly [string, string])[] = [
  [
    "a store's receiver",
    'let box = {n: null}\nlet held = box\n⟪box⟫.n = 1\nlet whole: integer = box.n\nsay "${whole}"\nexit',
  ],
  [
    "a compound store's receiver",
    'let box = {n: 1}\nlet held = box\n⟪box⟫.n += 0.5\nlet whole: integer = box.n\nsay "${whole}"\nexit',
  ],
  [
    "an element store's receiver",
    'let xs = [null, 2]\nlet held = xs\n⟪xs⟫[0] = 1\nlet first: integer = xs[0]\nsay "${first}"\nexit',
  ],
  [
    "a store's receiver below a property",
    'let box = {a: {n: null}}\nlet held = box\n⟪box⟫.a.n = 1\nlet whole: integer = box.a.n\nsay "${whole}"\nexit',
  ],
  [
    "the receiver of `add`",
    'let xs = [1]\nlet held = xs\n⟪xs⟫.add(null)\nfor x in xs {\n  let v: integer = x\n  say "${v}"\n}\nexit',
  ],
  [
    "the receiver of `addAll`",
    'let xs = [1]\nlet held = xs\n⟪xs⟫.addAll([null])\nfor x in xs {\n  let v: integer = x\n  say "${v}"\n}\nexit',
  ],
  [
    "the receiver of a list method that changes it",
    'let xs = [null, 2]\nlet held = xs\nlet gone = ⟪xs⟫.removeAt(0)\nlet first: integer = xs[0]\nsay "${first} ${gone}"\nexit',
  ],
  [
    "the receiver of a dict method that changes it",
    'let d = dict{"a": null, "b": 2}\nlet held = d\nlet gone = ⟪d⟫.remove("a")\nfor k, v in d {\n  let w: integer = v\n  say "${k} ${w} ${gone}"\n}\nexit',
  ],
  [
    "the receiver of a changing method below an element",
    'let rows = [[1]]\nlet held = rows\n⟪rows⟫[0].add(null)\nfor x in rows[0] {\n  let v: integer = x\n  say "${v}"\n}\nexit',
  ],
  // the final re-check's witness (#2537): the collector reads a method through the parentheses around its callee
  [WITNESS_WHAT, WITNESS],
];

const placeForm = (marked: string, form: "pass" | "copy"): SourceFile[] =>
  main(
    PASS +
      marked.replace(/⟪([^⟫]*)⟫/gu, (_, argument: string) =>
        form === "pass" ? `pass(${argument})` : "held",
      ),
  );

/** `found` less each member of `kept`, as many times as `kept` holds it. */
const less = (found: readonly string[], kept: readonly string[]): string[] => {
  const left = [...kept];
  return found.filter((member) => {
    const at = left.indexOf(member);
    if (at >= 0) left.splice(at, 1);
    return at < 0;
  });
};

/**
 * `source` with parentheses, once and doubled, around each expression on the way from its statement to each call of
 * `pass` (the call, each receiver and callee above it, a method's call), one place per source (R49).
 */
function parenthesized(source: string): string[] {
  type Tree = { readonly [member: string]: unknown };
  const isTree = (value: unknown): value is Tree => value !== null && typeof value === "object";
  const text = (value: unknown, member: string): string => {
    const found = isTree(value) ? value[member] : undefined;
    return typeof found === "string" ? found : "";
  };
  const offset = (value: Tree, edge: "start" | "end"): number | null => {
    const span = value["span"];
    const at = isTree(span) ? span[edge] : undefined;
    const found = isTree(at) ? at["offset"] : undefined;
    return typeof found === "number" ? found : null;
  };
  const holders = new Map<Tree, { readonly holder: Tree; readonly key: string }>();
  const calls: Tree[] = [];
  const stack: [unknown, Tree | null, string][] = [[parse(source).program, null, ""]];
  for (let at = stack.pop(); at !== undefined; at = stack.pop()) {
    const [value, holder, key] = at;
    if (!isTree(value)) continue;
    if (holder !== null) holders.set(value, { holder, key });
    if (text(value, "kind") === "callExpression" && text(value["callee"], "name") === "pass")
      calls.push(value);
    for (const [member, child] of Object.entries(value))
      if (member !== "span") stack.push([child, value, member]);
  }
  const out: string[] = [];
  for (const call of calls)
    for (
      let node: Tree = call, up = holders.get(node);
      up !== undefined && !text(node, "kind").endsWith("Statement");
      node = up.holder, up = holders.get(node)
    ) {
      // (an assignment's target is no expression of its own, nor a statement's call in parentheses a statement; a list
      // holds an argument, no expression)
      const target =
        (text(up.holder, "kind") === "assignmentStatement" && up.key === "target") ||
        text(up.holder, "kind") === "expressionStatement";
      const [start, end] = [offset(node, "start"), offset(node, "end")];
      if (target || !text(node, "kind").endsWith("Expression") || start === null || end === null)
        continue;
      for (const [open, close] of [
        ["(", ")"],
        ["((", "))"],
      ])
        out.push(
          source.slice(0, start) + open + source.slice(start, end) + close + source.slice(end),
        );
    }
  return out;
}

test("parentheses on the way from the statement to a call in a place slot leave the analysis as it is (#2493)", () => {
  for (const [what, marked] of PLACES) {
    const files = placeForm(marked, "pass");
    const variants = parenthesized(files[0]!.source);
    assert.ok(variants.length >= 2, what);
    assert.deepEqual(
      variants.filter((source) => coreRequest(main(source)) === null),
      [],
      `${what}: each form parses and resolves`,
    );
    for (const source of variants) {
      assert.equal(identityView(coreRequest(main(source))!).calls, 0, source);
      for (const mode of MODES)
        assert.equal(analysisByLine(main(source), mode), analysisByLine(files, mode), source);
    }
  }
});

test("the re-check's witness, compiled and run past the answers' refusals: its copy twin's plan and run (#2493)", () => {
  // (the slice refuses an author function's list argument, on main as here: `answers: "past"` reads past it)
  for (const mode of MODES) {
    const called = compiledByLine(placeForm(WITNESS, "pass"), mode, undefined, "past");
    const copied = compiledByLine(placeForm(WITNESS, "copy"), mode, undefined, "past");
    const at = JSON.stringify(mode);
    assert.deepEqual(called.diagnostics, copied.diagnostics, at);
    assert.deepEqual(less(copied.checks, called.checks), [], at);
    assert.deepEqual(called.run, copied.run, at);
  }
});

test("a call in a place slot stays a call: no error its copy does not give, every run-time check its copy has (#2493)", () => {
  for (const [what, marked] of PLACES) {
    assert.equal(identityView(coreRequest(placeForm(marked, "pass"))!).calls, 0, what);
    for (const mode of MODES) {
      const called = checkedByLine(placeForm(marked, "pass"), mode)!;
      const copied = checkedByLine(placeForm(marked, "copy"), mode)!;
      assert.deepEqual(less(called.errors, copied.errors), [], `${what}: ${JSON.stringify(mode)}`);
      assert.deepEqual(less(copied.checks, called.checks), [], `${what}: ${JSON.stringify(mode)}`);
    }
  }
});

/**
 * Every reader of the analysis that unwraps parentheses (#2493, R41), by file: its mentions of a parenthesized
 * expression and its calls of the helpers that unwrap one (`unwrap`, `unwrapped`, `peel`), and the place slots among
 * them, the slots through which a write reaches (P1 a store's receiver chain, P2 a changing method's receiver), which the
 * view keeps as calls (`placeSlots`); every other reads a value, which a call's copy shares when it runs, a test's
 * subject too (it writes nothing). A new reader that names the kind or one of these helpers fails here until it is
 * classed; the count resolves no binding, so a helper imported under another name is not found.
 */
const UNWRAPPING: Readonly<Record<string, readonly [number, string]>> = {
  "collector.ts": [
    11,
    "places: parentheses' own place (`#expression`), stored into only as a store's receiver (P1, `#assignment`) or a changing method's (P2, `#call`); `#mutate` (P1, P2); `#speakerName` (P1, P2's `copyFrom`, else a speaker's read); `label` (P2's receiver, named); the rest values",
  ],
  "core/admission/classes.ts": [1, "an index's value"],
  "core/check-result/check-result.ts": [
    5,
    "places: a store's target chain (P1, the written variable's root); the rest values: a count, an argument, an expression's type",
  ],
  "core/check-result/kept-checks.ts": [4, "values: a store's value and its literal data"],
  "core/check-result/runtime-plan.ts": [5, "values: a load's key, a selected literal"],
  "core/check-result/slice-index.ts": [
    5,
    "values: an operand's sites, a count's or an index's role, a node's site; `unwrap` itself",
  ],
  "core/check-result/store-contracts.ts": [7, "values: literal data, a value's provenance"],
  "core/consumers/diagnostics.ts": [
    4,
    "values: a receiver's and an operand's value, a kind present",
  ],
  "core/consumers/otherwise.ts": [4, "values: a fallback's read and its literals"],
  "core/flow-graph.ts": [1, "a value: a snapshot's literal data"],
  "core/flow-graph/expressions.ts": [5, "values: a callee, literals, an index, a key"],
  "core/flow-graph/statements.ts": [
    7,
    "values: a condition, a count, a range, an index, a subject's value",
  ],
  "core/identity-view.ts": [
    4,
    "the view: its parentheses, a place slot's chain, and a method's callee read through parentheses with the collector's `unwrap` and its parentheses counted (`placeSlots`)",
  ],
  "core/indexes/guards.ts": [4, "values: a test's operands and their receiver chains"],
  "core/messages/causes.ts": [1, "a value a message names"],
  "core/messages/site.ts": [7, "values: what a message names and where"],
  "core/messages/words.ts": [1, "a kind a message names"],
  "core/narrowing/narrowings.ts": [
    15,
    "places: a stable path's receiver chain as a store's root (`stablePath`, P1); the rest values: a test's subject (`testForm`, `define`), a read's or a tested path, an index it reads, a condition's own parentheses; `peel` itself",
  ],
  "core/narrowing/route-entries.ts": [7, "values: a read's root, literals, a transfer's script"],
  "core/narrowing/route-holding.ts": [3, "places: a store's target chain (P1); a callee's value"],
  "core/narrowing/route-tests.ts": [2, "values: a test's subject; a condition's own parentheses"],
  "core/narrowing/routes.ts": [1, "a value: its producer"],
  "core/slice-syntax.ts": [7, "values: the syntax check's literals, on the source"],
  "effects.ts": [3, "the legacy backend's, on the source"],
  "legacy-rounds.ts": [3, "the legacy backend's, on the source"],
  "narrowing-shapes.ts": [3, "values: a test's subject (`conditionShape`); its operand's literal"],
  "syntax-evidence.ts": [7, "values: a selection's and an interaction's literal data"],
};

test("every reader of the analysis that unwraps parentheses is classed, its place slots the view's (#2493)", () => {
  const root = new URL("../../../src/type-inference/", import.meta.url);
  const found: Record<string, number> = {};
  for (const file of readdirSync(root, { encoding: "utf8", recursive: true }).sort()) {
    if (!file.endsWith(".ts")) continue;
    const count = [
      ...readFileSync(new URL(file, root), "utf8").matchAll(
        /\b(?:unwrap|unwrapped|peel)\(|"parenthesizedExpression"/gu,
      ),
    ].length;
    if (count > 0) found[file] = count;
  }
  assert.deepEqual(
    found,
    Object.fromEntries(Object.entries(UNWRAPPING).map(([file, [count]]) => [file, count])),
  );
});
