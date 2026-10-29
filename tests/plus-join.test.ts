import assert from "node:assert/strict";
import test from "node:test";

import { compileSource } from "../src/compiler.js";
import { createFreshRuntimeSession } from "../src/index.js";
import { withValidationTestStatistics } from "../src/validation-testing.js";
import { compileValidPlan } from "./helpers/compile-valid-plan.js";
import { assertRuntimeResumeEquivalent } from "./helpers/runtime-equivalence.js";
import { runValidSource } from "./helpers/run-valid-source.js";
import { sayTexts } from "./helpers/runtime-events.js";

function said(source: string): string[] {
  const result = runValidSource(source);
  assert.equal(result.snapshot.failure, null, source);
  return sayTexts(result);
}

function failure(source: string): [string | undefined, string | undefined] {
  const result = runValidSource(source);
  return [result.snapshot.failure?.code, result.snapshot.failure?.message];
}

function diagnostics(source: string): [string, string, string][] {
  return compileSource(source).diagnostics.map((diagnostic) => [
    diagnostic.code,
    diagnostic.message,
    source.slice(diagnostic.span.start.offset, diagnostic.span.end.offset),
  ]);
}

/** Hides a value's type from the compiler, as host data or untyped storage would. */
const DYNAMIC = "function dynamic(value) {\n    return value\n}\n";

test("+ joins two texts, and += appends text", () => {
  assert.deepEqual(
    said(
      [
        'let title = "Ann"',
        'let name = "Mistress " + title',
        'name += "!"',
        'say name + " " + "${1 + 2}"',
        "exit",
      ].join("\n"),
    ),
    ["Mistress Ann! 3"],
  );
});

test("+ gives a new list of both lists' elements, and += and addAll append in place", () => {
  assert.deepEqual(
    said(
      [
        'let options = ["Red", "Blue"]',
        'let menu = ["Back"] + options + ["Red"]',
        "say menu",
        "say options",
        // The new list holds copies, so changing an element leaves the operands unchanged.
        "let nested = [[1]]",
        "let doubled = nested + nested",
        "doubled[0].add(2)",
        "say nested",
        "say doubled",
        "let queue = [1]",
        "queue += [2]",
        "queue.addAll([3, 1])",
        "queue.addAll(queue)",
        "say queue",
        "exit",
      ].join("\n"),
    ),
    [
      '["Back", "Red", "Blue", "Red"]',
      '["Red", "Blue"]',
      "[[1]]",
      "[[1, 2], [1]]",
      "[1, 2, 3, 1, 1, 2, 3, 1]",
    ],
  );
});

test("+= on a list variable changes no copy or added list, and a join that does not fit changes nothing", () => {
  const result = runValidSource(
    [
      DYNAMIC,
      "let items: integer[] = [1]",
      "let copy = items",
      "items += [2]",
      "items = items + [3]",
      // Checked when the script runs, since the compiler cannot see the element type.
      "let more = dynamic([4])",
      "items += more",
      "let element = [5]",
      "let nested = [[0]]",
      "nested += [element]",
      "element.add(6)",
      "nested += nested",
      "nested[3].add(7)",
      "say items",
      "say copy",
      "say element",
      "say nested",
      'let mixed: (integer | string)[] = [5, "a"]',
      "let wrong = dynamic(mixed)",
      "items += wrong",
      "exit",
    ].join("\n"),
  );

  assert.deepEqual(sayTexts(result), ["[1, 2, 3, 4]", "[1]", "[5, 6]", "[[0], [5], [0], [5, 7]]"]);
  // The position counts the elements the list already holds.
  assert.deepEqual(
    [result.snapshot.failure?.code, result.snapshot.failure?.message],
    [
      "TSR058",
      `'items' holds a list (integer[]), so it cannot take a list with text (string) "a" at [5].`,
    ],
  );
  assert.deepEqual(
    result.snapshot.frames[0]!.bindings.find((binding) => binding.name === "items")?.value,
    { kind: "list", items: [1, 2, 3, 4] },
  );
});

test("+= on a property, element, or dict value appends, and with a call joins with the value read before it", () => {
  // `items += more` stores `items + more` with `items` read before a call in `more` runs (V30 §14), whatever the call
  // changes meanwhile.
  assert.deepEqual(
    said(
      [
        "let o = { items: [1], count: 0 }",
        'let d = dict{"a": [1]}',
        "let rows = [[0], [1]]",
        "let t = [1]",
        "function same(n) {\n    return n\n}",
        "function grows(n) {\n    t.add(99)\n    return n\n}",
        "function sets(n) {\n    t[0] = 50\n    return n\n}",
        "function joins(n) {\n    t += [same(n * 10)]\n    return n\n}",
        "function counts(n) {\n    o.count += 1\n    return n\n}",
        "function deep(n) {\n    rows[0].add(7)\n    return n\n}",
        "o.items += [1]",
        'd["a"] += [2]',
        "rows[1] += [5]",
        "t += [grows(2)]",
        "t += [sets(3)]",
        "t += [joins(4)]",
        // The element after the call changes the list when the join is evaluated, after its current value was read.
        "t += [same(5), t.removeLast()]",
        "o.items += [counts(6)]",
        "rows += [[deep(8)]]",
        "say o",
        "say d",
        "say rows",
        "say t",
        "exit",
      ].join("\n"),
    ),
    [
      "{ items: [1, 1, 6], count: 1 }",
      'dict{ "a": [1, 2] }',
      "[[0], [1, 5], [8]]",
      "[1, 2, 3, 4, 5, 4]",
    ],
  );
});

test("items = items + more, and += on a speaker's list through any name, join with the value read before a call", () => {
  // As for `+=` above (V30 §14). A speaker's list may change through another name for the speaker, or through a call
  // that gives the speaker.
  assert.deepEqual(
    said(
      [
        "speaker guide {",
        '    displayName: "Guide"',
        "    items: [1]",
        '    rows: [dict{"a": 1}]',
        "}",
        "let s = guide",
        "let t = [1]",
        "function same(n) {\n    return n\n}",
        "function getGuide {\n    return guide\n}",
        "function grows(n) {\n    t.add(99)\n    return n\n}",
        "function viaName(n) {\n    s.items.add(99)\n    return n\n}",
        "function viaCall(n) {\n    getGuide().items[0] = 50\n    return n\n}",
        "function appends(n) {\n    guide.items += [same(n * 10)]\n    return n\n}",
        'function addsKey(n) {\n    s.rows[0]["b"] = 2\n    return dict{"c": n}\n}',
        "t = t + [grows(2)]",
        "guide.items += [5]",
        "guide.items += [viaName(2)]",
        "s.items = s.items + [viaCall(3)]",
        "getGuide().items += [appends(4)]",
        "guide.rows += [addsKey(3)]",
        "say t",
        "say guide.items",
        "say guide.rows",
        "exit",
      ].join("\n"),
    ),
    ["[1, 2]", "[1, 5, 2, 3, 4]", '[dict{ "a": 1 }, dict{ "c": 3 }]'],
  );
});

test("items = items + more reads a place that selects anew, as .random does, on each side", () => {
  // Each `.random` draws (V30 §13: it is no stable path), so the target and the joined list may be different rows.
  // Adding an empty list changes neither the values nor the draws, but makes the left operand a join of its own.
  const run = (assignment: string): string[] =>
    sayTexts(
      runValidSource(
        [
          "let rows = [{ items: [10] }, { items: [20] }, { items: [30] }]",
          "function same(n) {\n    return n\n}",
          assignment,
          "say rows",
          "say randomInteger(1..=100)",
          "exit",
        ].join("\n"),
        0x12345678,
      ),
    );
  const joined = run("rows.random.items = (rows.random.items + []) + [same(99)]");
  assert.deepEqual(run("rows.random.items = rows.random.items + [same(99)]"), joined);
  // With this seed, reading the place once, as `+=` does, gives another result.
  assert.notDeepEqual(run("rows.random.items += [same(99)]"), joined);
});

test("+= and items = items + more on any list place, also with a call or an ask on the right, copy no whole list", () => {
  // Diagnostic scale evidence, not a capacity contract (#1186, #1197): four additions copy as many list items, whatever
  // the length of the list they add to.
  const copied = (length: number, addition: string): number => {
    const plan = compileValidPlan(
      [
        'speaker guide {\n    displayName: "Guide"\n    items: [0]\n}',
        "let s = guide",
        "let o = { items: [0] }",
        'let d = dict{"a": [0]}',
        "let rows = [[0]]",
        "let t = [0]",
        'let words = ["a"]',
        "function same(n) {\n    return n\n}",
        `repeat ${length} {`,
        '    o.items.add(0)\n    d["a"].add(0)\n    rows[0].add(0)\n    t.add(0)\n    words.add("a")\n    guide.items.add(0)',
        "}",
        `repeat 4 {\n    ${addition}\n}`,
        "exit",
      ].join("\n"),
    );
    const session = createFreshRuntimeSession(plan, {
      baseDelayMs: 0,
      delayPerWordMs: 0,
      delayPerCharacterMs: 0,
    });
    return withValidationTestStatistics((statistics) => {
      session.run();
      for (
        let action = session.view().foregroundAction;
        action?.kind === "interaction";
        action = session.view().foregroundAction
      ) {
        session.completeAction({
          actionId: action.actionId,
          actionKind: "interaction",
          interactionKind: "text",
          payload: { kind: "submittedText", submittedText: "b" },
        });
        session.run();
      }
      assert.equal(session.view().status, "halted", addition);
      return statistics().counts.copiedListItems ?? 0;
    });
  };
  for (const addition of [
    "o.items += [1]",
    "o.items = o.items + [1]",
    'd["a"] += [1]',
    "rows[0] += [1]",
    "t += [same(1)]",
    "o.items += [same(1)]",
    'words += [askText "Word?"]',
    "t = t + [same(1)]",
    "guide.items += [1]",
    "s.items += [same(1)]",
  ])
    assert.equal(copied(2_000, addition), copied(4, addition), addition);
});

test("joined and appended elements keep the list's element type", () => {
  // Integers and numbers together are numbers, and a list declared with a union type takes both members.
  assert.deepEqual(
    said(
      [
        "let whole = [1]",
        "let mixed = whole + [2.5]",
        "mixed.add(0.5)",
        "let values: (integer | string)[] = [1]",
        'values += ["a"]',
        'values.addAll([2, "b"])',
        'say "${mixed.join()} ${values.join()}"',
        "exit",
      ].join("\n"),
    ),
    ["1, 2.5, 0.5 1, a, 2, b"],
  );
  // A list without a written type holds one type, as a list literal of both would.
  assert.deepEqual(
    diagnostics('let numbers = [1]\nlet words = ["a"]\nlet both = numbers + words\nexit'),
    [
      [
        "TSV044",
        "'+' would mix a whole number (integer) and text (string). A list holds one type. To keep both, declare a union type, as in 'let numbers: (integer | string)[] = ...'.",
        "numbers + words",
      ],
    ],
  );
  assert.deepEqual(diagnostics('let numbers = [1]\nnumbers += ["a"]\nexit'), [
    [
      "TSV044",
      "'+=' would mix a whole number (integer) and text (string). A list holds one type. To keep both, declare a union type, as in 'let numbers: (integer | string)[] = ...'.",
      '["a"]',
    ],
  ]);
  assert.deepEqual(diagnostics('let numbers = [1]\nnumbers.addAll([2, "a"])\nexit'), [
    [
      "TSV041",
      "'numbers' holds integer values (integer[]), so it cannot contain text (string). To allow both, declare it as 'let numbers: (integer | string)[] = ...'.",
      '"a"',
    ],
  ]);
  // A list whose elements may not fit is tested as a whole list first.
  const either = 'let target: integer[] = []\nlet more: (integer | string)[] = [1, "x"]\n';
  assert.deepEqual(diagnostics(`${either}target.addAll(more)\nexit`), [
    [
      "TSV041",
      "'target' holds integer values (integer[]), so it cannot contain a whole number (integer) or text (string). Check it first: if more is integer[] { ... }",
      "more",
    ],
  ]);
  assert.deepEqual(
    diagnostics(`${either}if more is integer[] {\n    target.addAll(more)\n}\nexit`),
    [],
  );
  // A non-whole number makes an integer list without a written type a number list, as add does.
  assert.deepEqual(
    diagnostics("let counts = [1]\ncounts += [2.5]\nlet first: integer = counts[0]\nexit").map(
      ([code, , text]) => [code, text],
    ),
    [["TSV041", "counts[0]"]],
  );
  // The first elements joined into an empty list decide its element type.
  for (const append of ['queue += ["a"]', 'queue.addAll(["a"])'])
    assert.deepEqual(
      diagnostics(`let queue = []\n${append}\nqueue.add(1)\nexit`).map(([code, , text]) => [
        code,
        text,
      ]),
      [["TSV041", "1"]],
      append,
    );
});

test("+ does not convert: text or a list with another kind is a compile error that names the fix", () => {
  const message = (source: string) => diagnostics(`${source}\nexit`).map(([, text]) => text);
  assert.deepEqual(message('let score = 5\nlet line = "Score: " + score'), [
    "'+' joins text only with other text, not with a whole number (integer). Put the value in the text instead, as in \"Score: ${score}\".",
  ]);
  assert.deepEqual(message('let name = "Ann"\nname += 5'), [
    "'name' holds text (string), so a whole number (integer) cannot be added to it. Put the value in the text instead, as in 'name += \"${5}\"'.",
  ]);
  assert.deepEqual(message('let names = ["Ann"]\nlet more = names + "Bo"'), [
    "'+' joins a list only with another list, not with text (string). To add one element, use 'names.add(\"Bo\")', or write 'names + [\"Bo\"]' for a new list.",
  ]);
  assert.deepEqual(message("let counts = [1]\nlet more = 0 + counts"), [
    "'+' joins a list only with another list, not with a whole number (integer). Write '[0] + counts' for a new list.",
  ]);
  assert.deepEqual(message("let counts = [1]\ncounts += 2"), [
    "'counts' holds a list (integer[]), so a whole number (integer) cannot be added to it. To add one element, use 'counts.add(2)'.",
  ]);
  assert.deepEqual(message("let counts = [1]\ncounts.addAll(2)"), [
    "addAll() needs a list, not a whole number (integer).",
  ]);
  assert.deepEqual(message("let counts = [1]\ncounts.addAll(set[2])"), [
    "addAll() needs a list, not a set. Copy a set into a list with toList() first.",
  ]);
  assert.deepEqual(message("let seen = set[1]\nseen.addAll([2])"), [
    "Sets have no method 'addAll'.",
  ]);
  assert.deepEqual(message("let seen = set[1]\nlet all = [0] + seen"), [
    "'+' joins two texts or two lists, not a list (integer[]) and a set (integer set). Join sets with union(), or copy a set into a list with toList() first.",
  ]);
});

test("+ on values known only when the script runs joins them or fails with the fix", () => {
  assert.deepEqual(
    said(`${DYNAMIC}say dynamic("a") + dynamic("b")\nsay dynamic([1]) + dynamic([2])\nexit`),
    ["ab", "[1, 2]"],
  );
  assert.deepEqual(failure(`${DYNAMIC}say "Score: " + dynamic(5)\nexit`), [
    "TSR009",
    "'+' joins two texts or two lists and adds numbers or durations, but these are text (string) and a whole number (integer). Put the value in the text instead.",
  ]);
  assert.deepEqual(failure(`${DYNAMIC}let items = [1]\nsay items + dynamic(2)\nexit`), [
    "TSR009",
    "'+' joins two texts or two lists and adds numbers or durations, but these are a list and a whole number (integer). To add one element, put the element in brackets for a new list, or call the add method on a line of its own.",
  ]);
  assert.deepEqual(failure(`${DYNAMIC}let items = [1]\nitems.addAll(dynamic(2))\nexit`), [
    "TSV043",
    "addAll() needs a list, not a whole number (integer).",
  ]);
  // Elements of unknown type are checked against the list's element type.
  assert.deepEqual(
    failure(
      `${DYNAMIC}let items: integer[] = [1]\nitems.addAll(dynamic([2]))\nitems.addAll(dynamic(["a"]))\nexit`,
    ),
    [
      "TSR058",
      `An element of 'items' holds a whole number (integer), so it cannot take text (string) "a".`,
    ],
  );
  assert.equal(
    failure(`${DYNAMIC}let items: integer[] = [1]\nitems += dynamic(["a"])\nexit`)[0],
    "TSR058",
  );
});

test("text and lists joined with += and addAll resume from every checkpoint", () => {
  assertRuntimeResumeEquivalent(
    [
      'let name = "Ann"',
      'let queue = ["a"]',
      'name += "!"',
      "say name",
      'queue += ["b"]',
      "say queue",
      "queue.addAll(queue)",
      'say name + " " + queue.join()',
      "exit",
    ].join("\n"),
  );
});

test("a fix that the runtime gives for '+' says it in words, as it knows the values but not how the source writes them", () => {
  const base = "'+' joins two texts or two lists and adds numbers or durations, but these are";
  const values = {
    text: 'dynamic("a")',
    number: "dynamic(5)",
    list: "dynamic([1])",
    range: "dynamic(1..3)",
    set: "dynamic(set[1])",
  } as const;
  const fixes = {
    text: " Put the value in the text instead.",
    listFirst:
      " To add one element, put the element in brackets for a new list, or call the add method on a line of its own.",
    listLast: " Put the element in brackets for a new list.",
    range: " To add the numbers of a range to the list, convert the range with toList() first.",
    set: " Join sets with union(), or copy a set into a list with toList() first.",
  };
  // Each pair in both orders.
  for (const [left, right, fix] of [
    ["text", "number", fixes.text],
    ["number", "text", fixes.text],
    ["list", "number", fixes.listFirst],
    ["number", "list", fixes.listLast],
    ["list", "range", fixes.range],
    ["range", "list", fixes.range],
    ["list", "set", fixes.set],
    ["set", "list", fixes.set],
  ] as const) {
    const source = `${DYNAMIC}say ${values[left]} + ${values[right]}\nexit`;
    const [code, message] = failure(source);
    assert.equal(code, "TSR009", source);
    assert.ok(message?.startsWith(base) && message.endsWith(fix), `${source}\n${message}`);
  }
  // A date and time that moves by elapsed time, and an absolute one that moves by calendar units.
  assert.deepEqual(failure(`${DYNAMIC}say dynamic(toDateTime("2026-09-07T16:45")) + 3 h\nexit`), [
    "TSR009",
    "A date and time has no time zone, so it cannot move by elapsed time. Convert the value with toAbsoluteDateTime() first and the result back with toDateTime(), or use calendar units to keep the clock time.",
  ]);
  assert.deepEqual(
    failure(
      `${DYNAMIC}say dynamic(toAbsoluteDateTime("2026-10-04T12:00:00Z")) + 1 calendar day\nexit`,
    ),
    [
      "TSR009",
      "An absolute date and time has no calendar. Convert the value with toDateTime() first and the result back with toAbsoluteDateTime().",
    ],
  );
});
