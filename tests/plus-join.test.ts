import assert from "node:assert/strict";
import test from "node:test";

import { compileSource } from "../src/compiler.js";
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
    "addAll() needs a list, but this is a whole number (integer).",
  ]);
  assert.deepEqual(message("let counts = [1]\ncounts.addAll(set[2])"), [
    "addAll() needs a list, but this is a set (integer set). Copy a set into a list with toList() first.",
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
    "'+' joins two texts or two lists and adds numbers or durations, but these are text (string) and a number. Put the value in the text instead, as in \"${first}${second}\".",
  ]);
  assert.deepEqual(failure(`${DYNAMIC}let items = [1]\nsay items + dynamic(2)\nexit`), [
    "TSR009",
    "'+' joins two texts or two lists and adds numbers or durations, but these are a list and a number. To add one element, use add(value), or write list + [value] for a new list.",
  ]);
  assert.deepEqual(failure(`${DYNAMIC}let items = [1]\nitems.addAll(dynamic(2))\nexit`), [
    "TSR060",
    "addAll() needs a list, not a number.",
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
