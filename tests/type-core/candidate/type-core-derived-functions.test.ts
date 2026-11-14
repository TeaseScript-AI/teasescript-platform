// The derived oracle's author functions (`derived-functions.ts`, #2667 step 4a-0): on sources whose functions owe no check
// into an untyped parameter or result, the oracle's checked stores, its content and its runs are today's compiler's,
// which checks the written ones as V30 §10, §11 and §17 say; a check into an untyped one is underivable, and so is a run
// of another file's function that would read either file's entries by offset.

import assert from "node:assert/strict";
import test from "node:test";
import { compileProject } from "../../../src/compiler.js";
import { compactAnalysis, coreRequest } from "../../helpers/type-core-analysis.js";
import {
  assignments,
  derivedContent,
  derivedStores,
  planOfFile,
  plannedContent,
  plannedStores,
  runGlobals,
} from "../../helpers/type-core-route.js";
import { evaluateProject } from "../../helpers/type-core/derived/derived-transfers.js";
import { derive } from "../../helpers/type-core/derived/type-core-derived-checks.js";
import { transferStore } from "../../helpers/type-core/derived/derived-functions.js";
import {
  expressions,
  syntaxOf,
  Underivable,
} from "../../helpers/type-core/derived/type-core-derived.js";
import { OPTIONS } from "../../helpers/type-core/type-core-candidate-setup.js";

type Files = readonly { readonly path: string; readonly source: string }[];
const one = (source: string): Files => [{ path: "main.tease", source }];

/** Invented sources: each a function form, its places written where a value it does not know enters them. */
const CASES: readonly [string, Files][] = [
  [
    "an argument into a written parameter",
    one('function f(x: integer) {\n  say x\n}\nf(hostValue)\nsay "after"\nexit\n'),
  ],
  [
    "a named argument, inside a `let`",
    one('function f(x: integer) {\n  return "done"\n}\nlet y = f(x: hostValue)\nsay y\nexit\n'),
  ],
  [
    "a list argument into a written list",
    one("function f(xs: integer[]) {\n  for x in xs {\n    say x\n  }\n}\nf(hostValue)\nexit\n"),
  ],
  [
    "an argument holding a call of another function",
    one(
      "function g(v: integer) {\n  return v\n}\nfunction f(w: integer) {\n  say w\n}\nf(g(hostValue))\nexit\n",
    ),
  ],
  [
    "a call of a function inside its own argument",
    one("function f(x: integer) {\n  return x\n}\nsay f(f(hostValue))\nexit\n"),
  ],
  [
    "a written default, supplied and not",
    one("function f(x: integer = hostValue) {\n  say x\n}\nf(1)\nf()\nexit\n"),
  ],
  [
    "a written default holding the host value in a list",
    one(
      "function f(xs: integer?[] = [hostValue, null, 7]) {\n  for x in xs {\n    say x\n  }\n}\nf()\nexit\n",
    ),
  ],
  [
    "a returned list holding the host value",
    one("function f: integer[] {\n  return [hostValue]\n}\nfor x in f() {\n  say x\n}\nexit\n"),
  ],
  [
    "a returned value into a written result",
    one("function f: integer {\n  return hostValue\n}\nsay f()\nexit\n"),
  ],
  [
    "a bare return of an optional result",
    one(
      "function f: integer? {\n  if hostValue == null {\n    return\n  }\n  return 1\n}\nsay f()\nexit\n",
    ),
  ],
  ["a call before its function", one('say f("a")\nfunction f(v: string) {\n  return v\n}\nexit\n')],
  [
    "a parameter kept across a call of its own function",
    one(
      'function count(v: integer?) {\n  if v == null {\n    return "end"\n  }\n  say v\n  let inner = count(null)\n  say v\n  return inner\n}\nsay count(hostValue)\nexit\n',
    ),
  ],
  [
    "a return from inside a `while` and a `switch`",
    one(
      'function f(x: integer): integer? {\n  while true {\n    switch x {\n      case 1 {\n        return hostValue\n      }\n      default {\n        break\n      }\n    }\n  }\n  say "left"\n  return null\n}\nsay f(1)\nsay f(2)\nexit\n',
    ),
  ],
  // (the order of a call, V30 §10, §11: every argument evaluated before any is checked, the supplied ones checked before
  // an omitted default is evaluated, and the defaults evaluated in parameter order; each source's runs differ under
  // another order, by what they say or where they fail)
  [
    "an argument checked before an omitted default runs",
    one(
      "function f(a: integer = hostValue, b: integer = 1) {\n  say a\n  say b\n}\nf(b: hostValue)\nexit\n",
    ),
  ],
  [
    "every argument evaluated before the first is checked",
    one(
      'function later {\n  say "later"\n  return 1\n}\nfunction f(a: integer, b: integer) {\n  say a\n}\nf(hostValue, later())\nexit\n',
    ),
  ],
  [
    "omitted defaults evaluated in parameter order",
    one(
      "function mark(x: integer): integer {\n  say x\n  return x\n}\nfunction f(a: integer = mark(3), b: integer = mark(4), c: integer = mark(5)) {\n  say a\n  say b\n  say c\n}\nf()\nexit\n",
    ),
  ],
  [
    "a store into the file's variable from a function",
    one('let top = "a"\nfunction f(v: string) {\n  top = v\n}\nf(hostValue)\nsay top\nexit\n'),
  ],
  [
    "a store into a written parameter",
    one("function f(x: integer) {\n  x = hostValue\n  say x\n}\nf(1)\nexit\n"),
  ],
  [
    "an untyped parameter that only known values fill",
    one('function shown(v) {\n  say v\n}\nshown(1)\nshown("x")\nsay hostValue != null\nexit\n'),
  ],
  [
    "an untyped parameter returned into a written `let`",
    one("function keep(v) {\n  return v\n}\nlet n: integer = keep(hostValue)\nsay n\nexit\n"),
  ],
  [
    "a function that ends without a return",
    one("function f(x: integer) {\n  say x\n}\nlet r = f(hostValue)\nsay r == null\nexit\n"),
  ],
  [
    "a global function of another file",
    [
      { path: "main.tease", source: 'check(hostValue)\nsay "back"\nexit\n' },
      // (the function starts past every entry of the calling file, so its run reads none of them)
      {
        path: "helpers.tease",
        source: `// ${"-".repeat(40)}\nglobal function check(n: integer) {\n  say n\n}\n`,
      },
    ],
  ],
];

for (const [name, files] of CASES)
  test(`the derived oracle's functions: ${name}, as today's compiler checks and runs it`, () => {
    const today = compileProject(files, OPTIONS);
    assert.ok(today.plan !== null, name);
    const request = coreRequest(files);
    assert.ok(request !== null, name);
    const record = compactAnalysis(request);
    const project = request.files.map((file) => syntaxOf(file.source));
    const derived = request.files.map((file, index) => {
      const own = record.checks.filter((check) => check.site.file === file.path);
      return {
        path: file.path,
        syntax: project[index]!,
        ...derive(project[index]!, { ...record, checks: own }, project),
      };
    });
    for (const [index, file] of derived.entries()) {
      const plan = planOfFile(today.plan, file.path);
      assert.deepEqual(
        derivedStores(file.stores),
        plannedStores(plan),
        `${name}: the checked stores of ${file.path}`,
      );
      const source: string = request.files[index]!.source;
      assert.deepEqual(
        derivedContent(file.content, source),
        plannedContent(plan, source),
        `${name}: the content of ${file.path}`,
      );
    }
    for (const inputs of assignments(["hostValue"]))
      assert.deepEqual(
        evaluateProject(derived, inputs).run,
        runGlobals(today.plan, inputs),
        `${name} with ${JSON.stringify(inputs)}`,
      );
  });

test("an integer that may be null into a written parameter is a store into it, where an earlier argument may change it", () => {
  // (today's checker refuses the call, TSV041; the record warns, and its runtime check is the parameter's: AD-1)
  const source =
    "let n = 1\nfunction reset {\n  n = 2\n  return 0\n}\nfunction f(a: integer, b: integer) {\n  say b\n}\nif hostValue == null {\n  n = null\n}\nf(reset(), n)\nexit\n";
  const request = coreRequest(one(source));
  assert.ok(request !== null);
  const syntax = syntaxOf(source);
  const at = source.lastIndexOf("n)");
  assert.deepEqual(derivedStores(derive(syntax, compactAnalysis(request), [syntax]).stores), [
    `parameter 'b' of 'f' ${at}:${at + 1} ${at}:${at + 1} integer`,
  ]);
});

test("a parse into a function's written place reads that type, as a `let`'s: the plan's expected type there", () => {
  // (today's checker gives the parse no expected type there; the record of the cell that names it does, and the route
  // follows the record. A `null` default, whose own type is no expected type, shows that the type is the place's)
  const cases: readonly (readonly [string, readonly (readonly [string, string])[]])[] = [
    [
      "function f(n: integer? = fromJson(hostValue, default: null)) {\n  say n\n}\nf()\nf(fromJson(hostValue, default: 1))\nexit\n",
      [
        ["fromJson(hostValue, default: null)", "integer|null"],
        ["fromJson(hostValue, default: 1)", "integer|null"],
      ],
    ],
    [
      "function f: integer? {\n  return fromJson(hostValue, default: null)\n}\nsay f()\nexit\n",
      [["fromJson(hostValue, default: null)", "integer|null"]],
    ],
    [
      "function f(n: integer?) {\n  n = fromJson(hostValue, default: null)\n  say n\n}\nf(1)\nexit\n",
      [["fromJson(hostValue, default: null)", "integer|null"]],
    ],
  ];
  for (const [source, parses] of cases) {
    const request = coreRequest(one(source));
    assert.ok(request !== null, source);
    const syntax = syntaxOf(source);
    assert.deepEqual(
      derivedContent(derive(syntax, compactAnalysis(request), [syntax]).content, source),
      parses.map(([parse, type]) => {
        const at = source.indexOf(parse);
        return `expected ${at}:${at + parse.length} ${type}`;
      }),
      source,
    );
  }
});

test("the derived oracle refuses a check into an untyped parameter or result", () => {
  for (const source of [
    "function shown(v) {\n  say v\n}\nshown(1)\nshown(hostValue)\nexit\n",
    "function pick(b) {\n  if b == null {\n    return 1\n  }\n  return b\n}\nlet n = pick(hostValue)\nsay n\nexit\n",
    "function f(o) {\n  o.a = hostValue\n  say o.a\n}\nf({a: 1})\nexit\n",
  ]) {
    const request = coreRequest(one(source));
    assert.ok(request !== null);
    const record = compactAnalysis(request);
    const syntax = syntaxOf(source);
    assert.throws(
      () => derive(syntax, record, [syntax]),
      (error) => error instanceof Underivable && /without a written type/u.test(error.message),
      source,
    );
  }
});

test("another file's function: each file's stores are its own, and a run that would read entries by offset is underivable", () => {
  // a written result returned by another file's function, beside a store of the calling file; a body without checks
  // whose `let` lies at the offsets of a store of the calling file, at its span and at its start only; a parse in a type
  // test whose site is that of a parse the calling file's content holds, also with the calling file's store outside it;
  // a written result's check in a call from a file without entries
  for (const files of [
    [
      {
        path: "main.tease",
        source: "let a = 12345678901234\nlet m: integer = hostValue\nsay get()\nsay m\nexit\n",
      },
      { path: "helpers.tease", source: "global function get: integer {\n  return hostValue\n}\n" },
    ],
    [
      {
        path: "main.tease",
        source: "let a = 1\nlet b = 222222\nlet m: integer = hostValue\nshow()\nexit\n",
      },
      {
        path: "helpers.tease",
        source: 'global function show {\n  let n = "aaaaaaaaaaaaaaaa"\n  say n\n}\n',
      },
    ],
    [
      {
        path: "main.tease",
        source: `say "${"x".repeat(18)}"\nlet m: integer = hostValue\nshow()\nexit\n`,
      },
      { path: "helpers.tease", source: 'global function show {\n  let n = "x"\n  say n\n}\n' },
    ],
    [
      {
        path: "main.tease",
        source: `${" ".repeat(11)}let m: integer? = fromJson("2"${" ".repeat(6)}, default: null)\nshow()\nexit\n`,
      },
      {
        path: "helpers.tease",
        source: "global function show {\n  say fromJson(hostValue, default: null) is string\n}\n",
      },
    ],
    // (the same parse, the calling file's store now starting before the function: only its content entry is inside)
    [
      {
        path: "main.tease",
        source: 'let mmmmmmmmmmmmm: integer? = fromJson("2"      , default: null)\nshow()\nexit\n',
      },
      {
        path: "helpers.tease",
        source: "\nglobal function show {\n  say fromJson(hostValue, default: null) is string\n}\n",
      },
    ],
    // (a calling file without entries, and a written result's check inside the other file's function)
    [
      { path: "main.tease", source: "say get()\nexit\n" },
      { path: "helpers.tease", source: "global function get: integer {\n  return hostValue\n}\n" },
    ],
  ]) {
    const name = files[1]!.source;
    const today = compileProject(files, OPTIONS);
    assert.ok(today.plan !== null, name);
    const request = coreRequest(files);
    assert.ok(request !== null, name);
    const record = compactAnalysis(request);
    const project = request.files.map((file) => syntaxOf(file.source));
    const derived = request.files.map((file, index) => ({
      path: file.path,
      syntax: project[index]!,
      ...derive(
        project[index]!,
        { ...record, checks: record.checks.filter((check) => check.site.file === file.path) },
        project,
      ),
    }));
    for (const file of derived)
      assert.deepEqual(
        derivedStores(file.stores),
        plannedStores(planOfFile(today.plan, file.path)),
        `${name}: ${file.path}`,
      );
    assert.throws(
      () => evaluateProject(derived, { hostValue: 2 }),
      (error) => error instanceof Underivable && /another file's function/u.test(error.message),
      name,
    );
  }
});

test("another file's default is never the calling file's store, at whatever offsets it lies", () => {
  // the calling file's argument `[1, hostValue]` and the other file's default `hostValue` hold the same offsets: a check
  // there into `check.n` is the argument's, the calling file's own store
  const main = syntaxOf(`say "${"x".repeat(20)}"\ncheck([1, hostValue])\nexit\n`);
  const helpers = syntaxOf("global function check(n: integer[] = hostValue) {\n  say n\n}\n");
  const start = 37;
  const store = transferStore(
    { start, end: start + "hostValue".length, target: "check.n.element" },
    main,
    expressions(main.statements),
    [main, helpers],
  );
  assert.deepEqual(store === null ? null : [store.so, store.eo], [33, 47]);
});

test("a parse or a load stored by a function reads its own scope's written type, never another function's (V30 §14)", () => {
  // (today's checker reads no expected type for a parse stored by an assignment and drops a load's `null`, at a file's
  // top level too; the record and the route read the place's written type, here `integer?`, never the `string?` of
  // `unused`'s local of the same name)
  const unused = "function unused {\n  let n: string? = null\n}\n";
  for (const [source, read] of [
    [
      `${unused}function f {\n  let n: integer? = null\n  n = fromJson(hostValue, default: null)\n  say n\n}\nf()\nexit\n`,
      "expected",
    ],
    [
      `${unused}function f(n: integer?) {\n  n = fromJson(hostValue, default: null)\n  say n\n}\nf(1)\nexit\n`,
      "expected",
    ],
    [
      `${unused}function f {\n  let n: integer? = null\n  n = load("n", default: hostValue)\n  say n\n}\nf()\nexit\n`,
      "load",
    ],
    [
      `${unused}function f(n: integer?) {\n  n = load("n", default: hostValue)\n  say n\n}\nf(1)\nexit\n`,
      "load",
    ],
  ] as const) {
    const files = one(source);
    const request = coreRequest(files);
    assert.ok(request !== null, source);
    const syntax = syntaxOf(source);
    const derived = {
      path: "main.tease",
      syntax,
      ...derive(syntax, compactAnalysis(request), [syntax]),
    };
    const parse =
      read === "load" ? 'load("n", default: hostValue)' : "fromJson(hostValue, default: null)";
    const at = source.indexOf(parse);
    assert.deepEqual(
      derivedContent(derived.content, source),
      [`${read} ${at}:${at + parse.length} integer|null${read === "load" ? " repair=false" : ""}`],
      source,
    );
    const today = compileProject(files, OPTIONS);
    assert.ok(today.plan !== null, source);
    for (const inputs of assignments(["hostValue"]))
      assert.deepEqual(
        evaluateProject([derived], inputs).run,
        runGlobals(today.plan, inputs),
        `${source} with ${JSON.stringify(inputs)}`,
      );
  }
});
