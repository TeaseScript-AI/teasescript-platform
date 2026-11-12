// pins: an integer rule's total and checks | line /^\s*assert\.deepEqual\(units, \[/u
// An operand's errors and checks on the candidate route: counts, indexes, range bounds, known arguments, integer-only
// uses, conversions, iterables.

import assert from "node:assert/strict";
import test from "node:test";

import { compileSource, type CompilationResult } from "../../../src/compiler.js";
import { REPEAT_COUNT_RULE } from "../../../src/loop-rules.js";
import {
  TEXT_METHODS,
  type TextParameterKind,
  type TextSignature,
} from "../../../src/text-operations.js";
import { createCapturedSerializableList } from "../../../src/runtime/values/serializable-values.js";
import { analyseCore } from "../../../src/type-inference/core/answers.js";
import { withTestAllowance } from "../../../src/type-inference/core/budget.js";
import { coreCheckResult } from "../../../src/type-inference/core/check-result/check-result.js";
import { nodeOf, SliceIndex } from "../../../src/type-inference/core/check-result/slice-index.js";
import { withoutSharing } from "../../../src/type-inference/core/sharing.js";
import { withValidationTestStatistics } from "../../../src/validation-testing.js";
import { compactAnalysis, coreRequest } from "../../helpers/type-core-analysis.js";
import { inMode, MODES } from "../../helpers/type-core-oracles.js";
import {
  OPTIONS,
  candidate,
  insideSlice,
  sited,
  inBothOrders,
  inBothOrdersAs,
  runWith,
  assertRuns,
  checksOf,
} from "../../helpers/type-core/type-core-candidate-setup.js";

test("C2's integer check warns with TSV011 at a count and TSV043 at a list index, and runs at the use", () => {
  const count = candidate(
    'let count = hostValue\nsay "ready"\nrepeat count {\n  say "turn"\n}\nexit\n',
  );
  assert.deepEqual(sited(count), ["warning TSV011@41"]);
  assert.ok(count.diagnostics[0]!.message.startsWith(REPEAT_COUNT_RULE));
  assert.ok(count.plan !== null);
  assert.deepEqual(checksOf(count.plan), []);
  assert.deepEqual(runWith(count.plan, 2), {
    status: "halted",
    says: ["ready", "turn", "turn"],
    failure: null,
  });
  assert.deepEqual(runWith(count.plan, 2.5), {
    status: "failed",
    says: ["ready"],
    failure: "TSR043@41:46",
  });
  assertRuns(count.plan, "the count", ["ready", "turn", "turn"], [["x", "TSR043@41:46"]]);

  const index = candidate("let rows = [10, 20]\nlet at = hostValue\nrepeat rows[at] {}\nexit\n");
  assert.deepEqual(sited(index), ["warning TSV043@51"]);
  assert.ok(index.plan !== null);
  assert.deepEqual(checksOf(index.plan), []);
  assertRuns(
    index.plan,
    "the index",
    [],
    [
      [1, null],
      [0.5, "TSR024@51:53"],
      [2, "TSR025@51:53"],
      ["x", "TSR024@51:53"],
    ],
  );

  // the proven cases stay errors under the same codes, a written `number` read among them (#1173)
  assert.deepEqual(sited(candidate("let count: number = hostValue\nrepeat count {}\nexit\n")), [
    "warning TSV041@20",
    "error TSV011@37",
  ]);
  assert.deepEqual(sited(candidate("let n = 2.5\nrepeat n {}\nexit\n")), ["error TSV011@19"]);
  assert.deepEqual(sited(candidate("let n: integer = 2.5\nexit\n")), ["error TSV041@17"]);
  assert.deepEqual(sited(candidate("let xs = [10, 20]\nlet i = 1.5\nrepeat xs[i] {}\nexit\n")), [
    "error TSV043@40",
  ]);
  // in parentheses the diagnostic stands at the content, once, and names the index's rule
  assert.deepEqual(sited(candidate("let n = 2.5\nrepeat (n) {}\nexit\n")), ["error TSV011@20"]);
  const parenthesized = candidate(
    "let rows = [10, 20]\nlet at = 0.5\nrepeat rows[(at)] {}\nexit\n",
  );
  assert.deepEqual(sited(parenthesized), ["error TSV043@46"]);
  assert.match(parenthesized.diagnostics[0]!.message, /^A list index must be a whole number/);
});

/**
 * #1242 (V30 §15, ADR 0021 §1.8, C12, C5b): an index or a key owes a list's whole number or a dict's text
 * only where the receiver may be a list or a dict, and a `removeAt`, `take` or `takeLast` argument only where it may
 * have the method; any other receiver gets its own error alone, as the current checker gives it: an object indexed by
 * text, a truth value or a number, read or stored, by `get`; a whole number, true or false, text. A list's index and a
 * dict's key keep their rules.
 */
test("a receiver without an index gets its own error alone, never a list index's (#1242)", () => {
  const original = inBothOrders(() =>
    candidate('let door = {name: "hall"}\nsay door["name"]\nexit\n'),
  );
  assert.deepEqual(sited(original), ["error TSV043@30"]);
  assert.match(original.diagnostics[0]!.message, /^An object has no elements, so 'door\["name"\]'/);
  const rules = (source: string): string[] => {
    const request = coreRequest([{ path: "main.tease", source }]);
    assert.ok(request !== null, source);
    return analyseCore(request).diagnostics.map((diagnostic) =>
      // (a stop's warning has no rule: its kind, as a written type's error)
      diagnostic.kind === "written-type" || diagnostic.kind === "budget"
        ? diagnostic.kind
        : `${diagnostic.class} ${diagnostic.rule.rule} ${source.slice(diagnostic.site.start, diagnostic.site.end)}`,
    );
  };
  for (const [source, expected] of [
    ['let box = {n: 1}\nbox["n"] = 2\nexit\n', 'member box["n"]'],
    ["let a = {n: 1}\nsay a[true]\nexit\n", "member a[true]"],
    ["let a = {n: 1}\nsay a[1.5]\nexit\n", "member a[1.5]"],
    ['let a = {n: 1}\nsay a.get("n", default: 0)\nexit\n', 'member a.get("n", default: 0)'],
    ['let a = 1\nsay a["n"]\nexit\n', 'member a["n"]'],
    ["let a = true\na[false] = 2\nexit\n", "member a[false]"],
    ['let t = "abc"\nsay t["n"]\nexit\n', 'member t["n"]'],
    ['let a = {n: 1}\na.removeAt("x")\nexit\n', 'member a.removeAt("x")'],
    ['let t = "abc"\nsay t.take("x")\nexit\n', 'member t.take("x")'],
    ['let a = [1]\nsay a["n"]\nexit\n', 'count "n"'],
    ["let a = dict{n: 1}\nsay a[0]\nexit\n", "key 0"],
    ['let xs = [1, 2]\nsay xs.take("x")\nexit\n', 'count "x"'],
  ] as const)
    assert.deepEqual(rules(source), [`compile-error ${expected}`], source);
});

/**
 * V30 §8 (#1701): a method of text's argument that is visibly out of range, empty, or names a group the regex lacks is a
 * compile error, the runtime's sentence at the argument (TSV043), where its values are known; a fitting call plans and
 * runs; an unknown argument keeps its runtime check. The issue's witnesses, their controls and a host argument, in the
 * four modes.
 */
test("a known text argument a method's domain rejects is a compile error with the runtime's sentence (V30 §8, #1701)", () => {
  const errors = [
    [
      'say "abc".substring(4)\nsay "AFTER"\nexit\n',
      20,
      "substring() needs 'start' from 0 through 3 (the length of the text), not 4.",
    ],
    [
      'say "abc".padStart(5, "")\nsay "AFTER"\nexit\n',
      22,
      "padStart() needs non-empty text for 'fill'.",
    ],
    [
      'say "a".replace(/(a)/, "$2")\nsay "AFTER"\nexit\n',
      23,
      "'$2' in the replacement refers to group 2, but this regex has 1 group. Write '$0' for the whole match or '$1' " +
        "for its group, or '$$' for a '$'.",
    ],
    [
      'let t = "abc"\nsay t.substring(4)\nexit\n',
      30,
      "substring() needs 'start' from 0 through 3 (the length of the text), not 4.",
    ],
  ] as const;
  for (const [source, at, message] of errors)
    for (const sharing of [<T>(run: () => T): T => run(), withoutSharing]) {
      const result = inBothOrders(() => sharing(() => candidate(source)));
      assert.deepEqual(sited(result), [`error TSV043@${at}`], source);
      assert.equal(result.diagnostics[0]!.message, message, source);
      assert.equal(result.plan, null, source);
    }
  // (Codex r1: a written `string` that holds host data is text, its fill known empty; an argument the analysis
  // rejects is read by no domain, in parentheses too; a domain's error inside parentheses stands at the content)
  for (const [source, sitedAs] of [
    [
      'let t: string = hostValue\nsay t.padStart(5, "")\nexit\n',
      ["warning TSV041@16", "error TSV043@44"],
    ],
    // (Codex r3: an admitted text element is text, `empty` ignored; a receiver that may be null keeps its own check
    // first, the fill unread; host data unwritten is no proof of text, for `count` as for any method)
    [
      'let xs: string[] = hostValue\nsay xs[0].padStart(5, "")\nexit\n',
      ["warning TSV041@19", "warning TSV041@19", "error TSV043@51"],
    ],
    [
      'let t: string? = hostValue\nsay t.padStart(5, "")\nexit\n',
      ["warning TSV041@17", "warning TSV043@31"],
    ],
    ['say hostValue.count("")\nexit\n', ["warning TSV043@4"]],
    ['say "abc".substring(1.5, 1)\nexit\n', ["error TSV043@20"]],
    ['say "abc".substring((4.5))\nexit\n', ["error TSV043@21"]],
    ['say "abc".substring((4))\nexit\n', ["error TSV043@21"]],
  ] as const)
    for (const sharing of [<T>(run: () => T): T => run(), withoutSharing])
      assert.deepEqual(
        sited(inBothOrders(() => sharing(() => candidate(source)))),
        sitedAs,
        source,
      );
  for (const [source, says] of [
    ['say "abc".substring(1)\nexit\n', "bc"],
    ['say "abc".padStart(5, "-")\nexit\n', "--abc"],
    ['say "a".replace(/(a)/, "$1")\nexit\n', "a"],
  ] as const) {
    const result = inBothOrders(() => candidate(source));
    assert.deepEqual(sited(result), [], source);
    assert.ok(result.plan !== null, source);
    assertRuns(result.plan, source, [says], [[null, null]]);
  }
  const host = candidate('say "abc".substring(hostValue)\nexit\n');
  assert.deepEqual(sited(host), ["warning TSV043@20"]);
  assert.ok(host.plan !== null);
  assertRuns(
    host.plan,
    "a host argument",
    ["c"],
    [
      [2, null],
      [4, "TSV043@4:30"],
    ],
  );
});

/**
 * #1701 over every method of text (`TEXT_METHODS`): the current checker is the reference. Each method is called on known
 * text, and on a list, with every combination of known arguments of its parameters' kinds (empty and other text, a regex with one group,
 * replacements naming groups 1 and 2, positions inside and past the text, end before start); the candidate's errors at
 * the arguments, code and sentence, are the current checker's, in the source order.
 */
test("every method of text's known-argument errors are the current checker's (#1701)", () => {
  const byKind: Record<TextParameterKind, readonly string[]> = {
    text: ['""', '"b"', '"$1"', '"$2"'],
    regex: ["/(b)/"],
    textOrRegex: ['""', '"b"', "/(b)/"],
    position: ["0", "2", "4"],
    count: ["0", "2"],
  };
  let compared = 0;
  for (const entry of Object.values(TEXT_METHODS)) {
    const method: TextSignature = entry;
    const name = method.name;
    let calls: string[][] = [[]];
    for (const parameter of method.parameters) {
      const next = calls.flatMap((call) => byKind[parameter.kind].map((value) => [...call, value]));
      calls = parameter.optional === true ? [...calls, ...next] : next;
    }
    // (a list receiver too: a list's method of the same name takes no text domain)
    for (const receiver of ['"abc"', '["abc"]'])
      for (const call of calls) {
        const source = `say ${receiver}.${name}(${call.join(", ")})\nexit\n`;
        // (the errors at the arguments, where a domain's stands: a receiver without the method is its member check's)
        const opening = source.indexOf("(");
        const atArguments = (result: CompilationResult) =>
          result.diagnostics
            .filter((d) => d.severity === "error" && d.span.start.offset > opening)
            .map((d) => `${d.code}@${d.span.start.offset}: ${d.message}`);
        const current = atArguments(compileSource(source, OPTIONS));
        const found = insideSlice(() => atArguments(candidate(source)));
        if (found === null) continue;
        compared += 1;
        assert.deepEqual(found, current, source);
      }
  }
  assert.ok(compared >= 75, `${compared} calls compared`);
});

/**
 * V30 §6 (#1173): a range a `for` loop goes through as written has whole-number bounds. A bound the core knows to be a
 * number or text is a compile error at the bound (TSV010, as the current checker gives); a whole one is quiet; one
 * from outside the script warns and keeps the runtime's check of the range.
 */
test("a for loop's range bound that is a number or text is an error at the bound, its host bound checked when it runs (V30 §6, #1173)", () => {
  const errors = [
    [
      "for i in 1..2.0 { say i }\nexit\n",
      12,
      "'2.0' is a number that can have decimals. Round the number with the floor, round or ceil function first.",
    ],
    [
      "for i in 1.0..2 { say i }\nexit\n",
      9,
      "'1.0' is a number that can have decimals. Round the number with the floor, round or ceil function first.",
    ],
    [
      "let x = 2.5\nfor i in 1..x { say i }\nexit\n",
      24,
      "'x' is a number that can have decimals. Round the number with the floor, round or ceil function first.",
    ],
    [
      'let t = "a"\nfor i in 1..t.trim() { say i }\nexit\n',
      24,
      "'t.trim()' is text (string). Use a whole number here.",
    ],
  ] as const;
  for (const [source, at, cause] of errors) {
    const result = inBothOrders(() => candidate(source));
    assert.deepEqual(sited(result), [`error TSV010@${at}`], source);
    assert.equal(
      result.diagnostics[0]!.message,
      `A 'for' loop needs a range of whole numbers, but ${cause}`,
      source,
    );
    assert.equal(result.plan, null, source);
  }
  const whole = candidate('let x: integer = 2\nfor i in x..=3 {\n  say "turn"\n}\nexit\n');
  assert.deepEqual(sited(whole), []);
  assert.ok(whole.plan !== null);
  assertRuns(whole.plan, "a whole range", ["turn", "turn"], [[null, null]]);
  const host = inBothOrders(() => candidate('for i in 1..=hostValue {\n  say "turn"\n}\nexit\n'));
  assert.deepEqual(sited(host), ["warning TSV010@13"]);
  assert.ok(host.plan !== null);
  assertRuns(
    host.plan,
    "a host bound",
    ["turn", "turn"],
    [
      [2, null],
      [2.5, "TSR045@9:22"],
    ],
  );
});

/**
 * #1173 (the owner's option C): an integer-only use is checked against the type of the place it reads, a place written
 * `number` an error whatever value it holds (a copy of one, and a place widened by a later store, rule 1.2, are #1173's
 * next part). The current checker is the reference here: over every integer-only use the candidate route reaches (a
 * repeat count, a list index, a `for` range's start and end, `take`, a text method's position, count or length) and the
 * places a use reads (written `number`, `number?`, `integer` or none, a whole or fractional start value, host data into
 * a `number`), the candidate's errors are the current checker's, in the four modes. A `number` narrowed by `is integer`
 * is quiet (`narrowing/type-core-narrowing-reads.test.ts`).
 */
test("an integer-only use of a written number place is the current checker's error at every use, in the four modes (#1173)", () => {
  const uses = [
    (read: string) => `repeat ${read} { say "x" }`,
    (read: string) => `let xs = [1, 2]\nsay xs[${read}]`,
    (read: string) => `for i in ${read}..3 { say i }`,
    (read: string) => `for i in 1..${read} { say i }`,
    (read: string) => `let ys = [1, 2, 3]\nsay ys.take(${read})`,
    // (a text method's whole-number argument: its position, count or length, Astra r1)
    (read: string) => `say "abc".substring(${read})`,
    (read: string) => `say "abc".substring(0, ${read})`,
    (read: string) => `say "abc".repeat(${read})`,
    (read: string) => `say "abc".padStart(${read}, "x")`,
    (read: string) => `say "abc".padEnd(${read}, "x")`,
  ];
  const programs = (use: (read: string) => string): readonly string[] => [
    use("1"),
    use("1.5"),
    // (a `get` result reads its receiver's element: Codex r1 B1)
    `let ps: number[] = [1]\n${use("ps.get(0, default: 0)")}`,
    `let ps: integer[] = [1]\n${use("ps.get(0, default: 0)")}`,
    // (every read form that gives a part of a written place, composed too: Codex r2)
    `let ps: number[][] = [[1]]\n${use("ps.get(0, default: [0])[0]")}`,
    `let ps: number[][] = [[1]]\n${use("ps.get(0, default: [0]).get(0, default: 0)")}`,
    `let ps: integer[][] = [[1]]\n${use("ps.get(0, default: [0])[0]")}`,
    // (a call's result reads its function's written result type, through `analyseCore`: functions are outside the
    // candidate route's slice)
    `function f: number {\n  return 1\n}\n${use("f()")}`,
    `function f: integer {\n  return 1\n}\n${use("f()")}`,
    `function f: number[] {\n  return [1]\n}\n${use("f().get(0, default: 0)")}`,
    `function f: integer[] {\n  return [1]\n}\n${use("f().get(0, default: 0)")}`,
    // (a `remove` gives a dict's value, a list's `null`; composed with an index and from a call's result: Codex r4)
    `let ps: number dict = dict{a: 1}\n${use('ps.remove("a")')}`,
    `let ps: integer dict = dict{a: 1}\n${use('ps.remove("a")')}`,
    `let ps: number[] = [1, 2]\n${use("ps.remove(1)")}`,
    `let ps: number[][] = [[1], [2]]\n${use("ps.removeFirst()[0]")}`,
    `function f: number dict {\n  return dict{a: 1}\n}\n${use('f().remove("a")')}`,
    // (a removal per member of an optional receiver, composed too; a written union of a collection beside another type
    // is TSV075's error, so `?` is the union a receiver has: Codex r5)
    `let ps: (number dict)? = dict{a: 1}\n${use('ps.remove("a")')}`,
    `let ps: (integer dict)? = dict{a: 1}\n${use('ps.remove("a")')}`,
    `let ps: number dict[] = [dict{a: 1}]\n${use('ps[0].remove("a")')}`,
    `let ps: integer dict[] = [dict{a: 1}]\n${use('ps[0].remove("a")')}`,
    `let ps: (number[])? = [1, 2]\n${use("ps.removeFirst()")}`,

    ...["removeFirst()", "removeLast()", "removeAt(0)"].flatMap((removal) => [
      `let ps: number[] = [1, 2]\n${use(`ps.${removal}`)}`,
      `let ps: integer[] = [1, 2]\n${use(`ps.${removal}`)}`,
    ]),
    ...[
      "let p: number = 1",
      "let p: number = 1.5",
      "let p: number? = 1",
      "let p: integer = 1",
      "let p = 1",
      "let p = 1.5",
      "let p: number = hostValue",
    ].map((declaration) => `${declaration}\n${use("p")}`),
  ];
  // (the candidate's errors, or, for a use the candidate route does not lower yet (`take`), the core analysis's)
  const errors = (result: CompilationResult) =>
    result.diagnostics
      .filter((d) => d.severity === "error")
      .map((d) => `${d.code}@${d.span.start.offset}`);
  const coreErrors = (source: string): string[] => {
    const inside = insideSlice(() => errors(candidate(source)));
    if (inside !== null) return inside;
    const request = coreRequest([{ path: "main.tease", source }], ["hostValue"]);
    assert.ok(request !== null, source);
    return analyseCore(request)
      .diagnostics.filter((d) => d.class === "compile-error")
      .map((d) => `${d.code}@${d.site.start}`);
  };
  for (const use of uses)
    for (const program of programs(use)) {
      const source = `${program}\nexit\n`;
      const current = errors(compileSource(source, OPTIONS));
      assert.deepEqual(
        inBothOrders(() => coreErrors(source)),
        current,
        source,
      );
      assert.deepEqual(
        inBothOrders(() => withoutSharing(() => coreErrors(source))),
        current,
        `${source} (unshared)`,
      );
    }
  // (a receiver that may be null: the current checker reports the receiver's null where the core reports the use, both
  // an error at that site, the null contributing nothing to the removed value; since AD-1 the core also reports the
  // receiver's null there, the route rule's error, so the sites are compared once each)
  for (const use of uses)
    for (const program of [
      `let ps: (number dict)?[] = [dict{a: 1}]\n${use('ps[0].remove("a")')}`,
      `function f: (number dict)? {\n  return dict{a: 1}\n}\n${use('f().remove("a")')}`,
    ]) {
      const source = `${program}\nexit\n`;
      const sites = (found: readonly string[]) => [
        ...new Set(found.map((error) => error.split("@")[1])),
      ];
      const current = sites(errors(compileSource(source, OPTIONS)));
      assert.ok(current.length > 0, source);
      assert.deepEqual(
        inBothOrders(() => sites(coreErrors(source))),
        current,
        source,
      );
    }
  // (a set's `remove` gives `null`, no element: its error names the null, not a number, Codex r3)
  const removed = coreRequest([
    {
      path: "main.tease",
      source: 'let ps: number set = set[1]\nrepeat ps.remove(1) { say "X" }\nexit\n',
    },
  ]);
  assert.ok(removed !== null);
  assert.deepEqual(
    analyseCore(removed)
      .diagnostics.filter((d) => d.kind === "integer-use")
      .map((d) => ("kinds" in d ? d.kinds : null)),
    [["null"]],
  );
  // (a written type without `number` asks no key for the rule: main's counters, so no stop moves, Codex r1 B2)
  const integer = coreRequest([
    { path: "main.tease", source: 'let p: integer = 1\nrepeat p { say "X" }\nexit\n' },
  ]);
  assert.ok(integer !== null);
  for (const mode of MODES) {
    const units = inMode(mode, (): [number, number | undefined] => {
      const { budget } = analyseCore(integer);
      return [budget.total, budget.counts.get("checks")];
    });
    assert.deepEqual(units, [194, 17], JSON.stringify(mode));
  }
});

/**
 * #1173's narrowing exception: a read under a test of its key (`if p is integer`) is left to its items, so the use is
 * no error there, as in the current checker; the same read untested is one. The core's own analysis (a type test is
 * outside the candidate route's slice), in both orders.
 */
test("a written number read that 'is integer' narrows is no integer-use error, untested it is one (#1173)", () => {
  const uses = [
    (read: string) => `repeat ${read} { say "x" }`,
    (read: string) => `let xs = [1, 2]\nsay xs[${read}]`,
    (read: string) => `for i in ${read}..3 { say i }`,
    (read: string) => `for i in 1..${read} { say i }`,
  ];
  const errors = (source: string): number => {
    const request = coreRequest([{ path: "main.tease", source }], ["hostValue"]);
    assert.ok(request !== null, source);
    return inBothOrders(
      () =>
        analyseCore(request).diagnostics.filter(
          (diagnostic) => diagnostic.kind === "integer-use" && diagnostic.class === "compile-error",
        ).length,
    );
  };
  for (const use of uses) {
    const narrowed = `let p: number = hostValue\nif p is integer {\n${use("p")}\n}\nexit\n`;
    assert.equal(errors(narrowed), 0, narrowed);
    assert.deepEqual(
      sited(compileSource(narrowed, OPTIONS)).filter((d) => d.startsWith("error")),
      [],
      narrowed,
    );
    const untested = `let p: number = hostValue\n${use("p")}\nexit\n`;
    assert.equal(errors(untested), 1, untested);
  }
});

test("parentheses answer for their content: a parenthesised count and index read as bare ones (S3 3.4)", () => {
  // the flow graph's node of a parenthesised expression is its content's, the value the parentheses hold
  const source = "let n = 2\nrepeat ((n)) {}\nlet xs = [1, 2]\nlet y = xs[(n)]\nexit\n";
  const request = coreRequest([{ path: "main.tease", source }]);
  assert.ok(request !== null);
  const answers = analyseCore(request);
  const index = new SliceIndex(request.files.map((file) => file.program));
  for (const expression of index.expressions)
    if (expression.kind === "parenthesizedExpression")
      assert.deepEqual(
        answers.at(nodeOf(answers, index, expression))?.items.map((item) => item.tag),
        ["integer"],
        source.slice(expression.span.start.offset, expression.span.end.offset),
      );
  // on the candidate route: the content's site, the kinds the core names, and the check at the content
  const count = inBothOrders(() => candidate("repeat ((2.5)) {}\nexit\n").diagnostics);
  assert.deepEqual(sited({ diagnostics: count }), ["error TSV011@9"]);
  assert.equal(
    count[0]!.message,
    "A repeat count must be a whole number (integer) of at least 0, but '2.5' is a number that can have decimals. Round the number with " +
      "the floor, round or ceil function first.",
  );
  const listed = inBothOrders(
    () => candidate("let xs = [1, 2]\nlet y = xs[(0.5)]\nexit\n").diagnostics,
  );
  assert.deepEqual(sited({ diagnostics: listed }), ["error TSV043@28"]);
  assert.equal(
    listed[0]!.message,
    "A list index must be a whole number (integer), but '0.5' is a number that can have decimals. Round the number with the floor, round " +
      "or ceil function first.",
  );
  const host = candidate("repeat ((hostValue)) {}\nexit\n");
  assert.deepEqual(sited(host), ["warning TSV011@9"]);
  assert.ok(host.plan !== null);
  assertRuns(
    host.plan,
    "the parenthesised count",
    [],
    [
      [2, null],
      [1.5, "TSR043@9:18"],
    ],
  );
  const hostIndex = candidate("let xs = [1, 2]\nlet y = xs[(hostValue)]\nexit\n");
  assert.deepEqual(sited(hostIndex), ["warning TSV043@28"]);
  assert.ok(hostIndex.plan !== null);
  assertRuns(
    hostIndex.plan,
    "the parenthesised index",
    [],
    [
      [1, null],
      [0.5, "TSR024@28:37"],
    ],
  );
});

/**
 * The owner's #1104 point 1: `min` and `max` compare the property `by:` names in one list of objects, and calendar
 * durations of one family (months and years, or days and weeks), as the current checker does. The analysis gives them no
 * diagnostic; the route leaves the list functions to S9b, which brings their results (F25) and argument checks (C13).
 */
test("min and max with by: and with calendar durations of one family have no diagnostic (#1104 point 1)", () => {
  for (const source of [
    'say min([{ count: 2 }, { count: 1 }], by: "count")\nexit\n',
    'say max([{ count: 2 }, { count: 1 }], by: "count")\nexit\n',
    "say min(1 calendar month, 2 calendar months)\nexit\n",
    "say max(1 calendar day, 2 calendar weeks)\nexit\n",
  ]) {
    const request = coreRequest([{ path: "main.tease", source }]);
    assert.ok(request !== null, source);
    const answers = analyseCore(request);
    assert.deepEqual([answers.outcome, answers.diagnostics], ["valid", []], source);
  }
});

/**
 * C13's iterable: an operand of the loop at its iterable, against the domain it tests, a list, set,
 * dict or range, a pair loop's a dict: an error where no run can go through it; else a warning whose operand check is
 * the runtime's own check of the loop's source (TSR044), at the iterable before the body runs, so the plan holds none.
 */
test("a for loop's iterable is an operand of the loop: an error, or a warning the loop's own check discharges at the iterable (C13)", () => {
  for (const [source, operand] of [
    ["for n in 1 {}\nexit\n", "1"],
    ["for k, v in [1] {}\nexit\n", "[1]"],
    ['let xs = ["a"]\nfor k, v in xs {}\nexit\n', "xs"],
  ] as const) {
    const result = inBothOrders(() => candidate(source));
    assert.equal(result.plan, null, source);
    assert.deepEqual(sited(result), [`error TSV012@${source.indexOf(operand, 5)}`], source);
  }
  for (const [source, against] of [
    ['for n in hostValue {\n  say "in"\n}\nsay "after"\nexit\n', ["list", "set", "dict", "range"]],
    ['for k, v in hostValue {\n  say "in"\n}\nsay "after"\nexit\n', ["dict"]],
  ] as const) {
    const request = coreRequest([{ path: "main.tease", source }]);
    assert.ok(request !== null);
    const record = inBothOrders(() => compactAnalysis(request));
    const at = source.indexOf("hostValue");
    assert.deepEqual(
      record.diagnostics.map((d) => [d.kind, d.class, d.site.offset]),
      [["operator", "warning-runtime-check", at]],
    );
    assert.deepEqual(
      record.checks.filter((check) => !check.boundary).map((check) => [check.kind, check.against]),
      [["operand", against]],
    );
    const result = inBothOrders(() => candidate(source));
    assert.deepEqual(sited(result), [`warning TSV012@${at}`]);
    // (the loop's own check: a value it cannot go through stops the run at the iterable, before the body)
    assert.deepEqual(runWith(result.plan!, 1), {
      status: "failed",
      says: [],
      failure: `TSR044@${at}:${at + "hostValue".length}`,
    });
  }
  const list = createCapturedSerializableList([1, 2]);
  const loop = inBothOrders(() =>
    candidate('for n in hostValue {\n  say "in"\n}\nsay "after"\nexit\n'),
  );
  assert.deepEqual(runWith(loop.plan!, list), {
    status: "halted",
    says: ["in", "in", "after"],
    failure: null,
  });
  // the controls: what a loop goes through is quiet
  for (const source of [
    'let xs = [1, 2]\nfor n in xs {\n  say "in"\n}\nexit\n',
    "let xs: integer[] = [1]\nfor n in xs {}\nexit\n",
  ])
    assert.deepEqual(sited(inBothOrders(() => candidate(source))), [], source);
});

/**
 * V30 §13 (#1105): a conversion the compiler can prove invalid is a compile error, also with a `default:`, which would
 * hide the text. The check reads the argument's known value through its view, so a known text gets the written
 * literal's error and sentence, as the production checker gives them for the literal.
 */
test("a conversion of known text that does not convert is the written literal's compile error, also with a default, in both orders (#1105, V30 §13)", () => {
  const converted = (result: Pick<CompilationResult, "diagnostics">): string[] =>
    result.diagnostics
      .filter((diagnostic) => diagnostic.code === "TSV043")
      .map((diagnostic) => `${diagnostic.span.start.offset} ${diagnostic.message}`);
  // each conversion that reads text, through a copy of a copy, with a default the slice takes
  for (const [name, text, fallback] of [
    ["toNumber", "12a", "0.5"],
    ["toInteger", "12a", "0"],
    ["toBoolean", "True", "false"],
    ["toDate", "2026-02-30", "hostValue"],
    ["toTime", "25:61", "hostValue"],
    ["toDateTime", "2026-02-30T12:30", "hostValue"],
    ["toAbsoluteDateTime", "2026-02-30T12:30:00Z", "hostValue"],
  ] as const) {
    const call = (operand: string) =>
      `let value = ${name}(${operand}, default: ${fallback})\nexit\n`;
    const [literal] = converted(compileSource(call(JSON.stringify(text)), OPTIONS));
    assert.ok(literal !== undefined, `${name}: the literal's error`);
    const sentence = literal.slice(literal.indexOf(" ") + 1);
    const source = `let seed = ${JSON.stringify(text)}\nlet text = seed\n${call("text")}`;
    const result = inBothOrders(() => candidate(source));
    assert.equal(result.plan, null, source);
    assert.deepEqual(converted(result), [`${source.indexOf("text,")} ${sentence}`], source);
  }
  // the literal itself, a variable, a written type and parentheses
  const sentence =
    'toInteger(...) cannot convert text (string) "12a" to a whole number (integer). The text must be a number such as 2.5 or -3.';
  for (const [source, operand] of [
    ['say toInteger("12a", default: 0)\nexit\n', '"12a"'],
    ['let text = "12a"\nsay toInteger(text, default: 0)\nexit\n', "text,"],
    ['let text: string = "12a"\nsay toInteger(text, default: 0)\nexit\n', "text,"],
    ['let text = "12a"\nsay toInteger((text), default: 0)\nexit\n', "(text)"],
  ] as const)
    assert.deepEqual(
      converted(inBothOrders(() => candidate(source))),
      [`${source.indexOf(operand, source.indexOf("toInteger("))} ${sentence}`],
      source,
    );
  // the forms the route's slice does not take yet (S9b), through the bridge: a concatenation, a two-step constant and
  // calls without a default
  for (const [source, operand] of [
    ['say toInteger("12" + "a", default: 0)\nexit\n', '"12" + "a"'],
    ['let first = "12"\nlet text = first + "a"\nsay toInteger(text, default: 0)\nexit\n', "text,"],
    ['let seed = "12a"\nlet text = seed\nsay toInteger(text)\nexit\n', "text)"],
    ['say toInteger("12" + "a")\nexit\n', '"12" + "a"'],
  ] as const) {
    const request = coreRequest([{ path: "main.tease", source }]);
    assert.ok(request !== null, source);
    const [, bridged] = inBothOrdersAs(
      () =>
        coreCheckResult(
          analyseCore(request),
          new SliceIndex(request.files.map((file) => file.program)),
          request,
        ),
      (checked) => converted({ diagnostics: checked.diagnostics.flat() }),
    );
    assert.deepEqual(bridged, [`${source.lastIndexOf(operand)} ${sentence}`], source);
  }
});

/**
 * #1105's controls: a value merged across branches is not known, so its text gives the default when the script runs;
 * a known text, number or true or false that converts converts; a parse keeps its fallback for text it cannot read.
 */
test("a conversion of a value that converts, that is unknown, or that a parse cannot read compiles and runs as before, in both orders (#1105)", () => {
  for (const [source, says] of [
    [
      'let text = "12a"\nif load("flag", default: false) {\n  text = "12a"\n}\nsay toInteger(text, default: 0)\nexit\n',
      ["0"],
    ],
    ['let seed = "12"\nlet text = seed\nsay toInteger(text, default: 0)\nexit\n', ["12"]],
    ["let amount = 2.5\nlet copy = amount\nsay toInteger(copy, default: 0)\nexit\n", ["2"]],
    ["let flag = true\nlet copy = flag\nsay toBoolean(copy, default: false)\nexit\n", ["true"]],
    ['let text = "{"\nsay fromJson(text, default: null)\nexit\n', ["null"]],
  ] as const) {
    const result = inBothOrders(() => candidate(source));
    assert.deepEqual(sited(result), [], source);
    assert.deepEqual(runWith(result.plan!, null).says, says, source);
  }
});

test("the known values the conversions' checks read are folded once, however many conversions read them, at one doubling, in both orders (#1105)", () => {
  // a chain of `size` copies of one text and `size` conversions of its last copy: a fold per check grows with the
  // square of the size
  const folds = (size: number): number => {
    const lines = ['let v0 = "12"'];
    for (let at = 1; at <= size; at += 1) lines.push(`let v${at} = v${at - 1}`);
    for (let at = 1; at <= size; at += 1)
      lines.push(`let n${at} = toInteger(v${size}, default: 0)`);
    const source = `${lines.join("\n")}\nexit\n`;
    return inBothOrders(() =>
      withValidationTestStatistics((finish) => {
        assert.notEqual(candidate(source).plan, null, `${size}: a plan`);
        return finish().counts.staticFolds ?? 0;
      }),
    );
  };
  const [small, large] = [folds(32), folds(64)];
  assert.ok(large <= 2.15 * small, `folds at 32 and 64: ${small}, ${large}`);
});

test("a known value under a test reads the branch's narrowing, and a long copy chain's value is still found iteratively (#1073 PR 2 phase 2)", () => {
  // (a dead branch is no static error: the narrowing admits no kind of the value there; a live one keeps it)
  for (const [source, plans] of [
    ["let n = 1.5\nif n is integer { repeat n {} }\nexit\n", true],
    ["let n = 1\nif n == null { repeat n {} }\nexit\n", true],
    ["let n = 1.5\nif n is number { repeat n {} }\nexit\n", false],
    ["let n = 1.5\nlet m = n\nif m is integer { repeat m {} }\nexit\n", true],
    // (an operand's read too, Codex r2 on #1884: the copy inside the fallback never runs with 1.5)
    [
      'let n = 1.5\nlet m = n\nif m is integer { repeat (m otherwise 0) { say "BODY" } }\nsay "AFTER"\nexit\n',
      true,
    ],
  ] as const)
    assert.equal(inBothOrders(() => candidate(source)).plan !== null, plans, source);
  // (Codex r1 on #1884: the filter applies after the evaluator's own iterative walk, so 8,192 copies take no native frame
  // each, and the known count still plans and runs)
  const chain =
    Array.from({ length: 8192 }, (_, i) => `let n${i} = ${i === 0 ? "1" : `n${i - 1}`}`).join(
      "\n",
    ) + '\nrepeat n8191 { say "AFTER" }\nexit\n';
  // (a stopped read says nothing of its kinds, `unknown`: its known value stands, and so does its static error)
  for (const allowance of [1, 4])
    assert.ok(
      withTestAllowance(allowance, () => candidate("let n = 1.5\nrepeat n {}\nexit\n"))
        .diagnostics.map((diagnostic) => diagnostic.code)
        .includes("TSV011"),
      `stopped at ${allowance}`,
    );
  const compiled = inBothOrders(() => candidate(chain));
  assert.notEqual(compiled.plan, null);
  assert.deepEqual(
    compiled.diagnostics.map((diagnostic) => diagnostic.code),
    [],
  );
});
