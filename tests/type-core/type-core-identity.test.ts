// #2493: the type analysis reads a call of an identity function as its argument in parentheses (`identity-view.ts`).
import assert from "node:assert/strict";
import test from "node:test";
import { identityView } from "../../src/type-inference/core/identity-view.js";
import { coreRequest, type SourceFile } from "../helpers/type-core-analysis.js";
import {
  analysisByLine,
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
    "list elements and property values, a condition and its operands",
    "let point = {x: ⟦1⟧, ys: [⟦2⟧, ⟦2.5⟧]}\nif ⟦point.x⟧ > ⟦0⟧ {\n  repeat point.ys[0] {}\n}\nexit",
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
