import assert from "node:assert/strict";
import test from "node:test";

import { compileSource } from "../src/compiler.js";
import { runValidSource } from "./helpers/run-valid-source.js";
import { assertRuntimeResumeEquivalent } from "./helpers/runtime-equivalence.js";
import { sayTexts } from "./helpers/runtime-events.js";

/*
 * `range.toList()` (V30 §6): the whole numbers of a range as a new list, and the fixes that name it where a range is
 * given in place of a list.
 */

// A parameter without a type or default is unknown, so `pick(...)` gives a value the compiler cannot know.
const PICK = "function pick(value) {\n    return value\n}\n";

/** `maybe(flag)` gives a range or null. */
const MAYBE =
  "function maybe(flag: boolean): range? {\n    if flag {\n        return 1..=3\n    }\n    return null\n}\n";

function said(...lines: string[]): string[] {
  const result = runValidSource([...lines, "exit"].join("\n"));
  assert.equal(result.snapshot.failure, null, lines.join("\n"));
  return sayTexts(result);
}

/** The diagnostics of `source` as code, message, and the source text they mark. */
function diagnostics(source: string): [string, string, string][] {
  return compileSource(source).diagnostics.map((diagnostic) => [
    diagnostic.code,
    diagnostic.message,
    source.slice(diagnostic.span.start.offset, diagnostic.span.end.offset),
  ]);
}

/** The runtime failure of a valid program as code, message, and the source its span covers. */
function failure(source: string): [string, string, string] | null {
  const fault = runValidSource(source).snapshot.failure;
  return fault === null
    ? null
    : [fault.code, fault.message, source.slice(fault.span.start.offset, fault.span.end.offset)];
}

test("toList gives the whole numbers of a range in order, as for goes through them", () => {
  assert.deepEqual(
    said(
      "say (1..=5).toList()\nsay (1..5).toList()\nsay (-2..=1).toList()",
      // An empty or reversed range gives no numbers, as a for loop over it runs no times.
      "say (1..1).toList()\nsay (5..=1).toList()\nsay (3..=3).toList()",
      // A range kept in a variable, or in a list, has it too.
      "let r = 2..=4",
      "let ranges = [r]",
      "say r.toList()\nsay ranges[0].toList().length",
      // The list is new, of whole numbers, and changes without changing the range.
      "let numbers = r.toList()",
      "numbers.add(9)",
      "let more: integer[] = (1..=2).toList()",
      "more += r.toList()",
      "say numbers\nsay r.toList()\nsay more",
    ),
    [
      "[1, 2, 3, 4, 5]",
      "[1, 2, 3, 4]",
      "[-2, -1, 0, 1]",
      "[]",
      "[]",
      "[3]",
      "[2, 3, 4]",
      "3",
      "[2, 3, 4, 9]",
      "[2, 3, 4]",
      "[1, 2, 2, 3, 4]",
    ],
  );
  assert.deepEqual(diagnostics('let numbers = (1..=3).toList()\nnumbers.add("x")\nexit'), [
    [
      "TSV041",
      "'numbers' holds integer values (integer[]), so it cannot contain text (string). To allow both, declare it as 'let numbers: (integer | string)[] = ...'.",
      '"x"',
    ],
  ]);
  assertRuntimeResumeEquivalent(
    "let r = 1..=3\nlet numbers = r.toList()\nnumbers.add(4)\nsay numbers\nexit",
  );
});

test("toList needs whole-number bounds, checked when the script compiles where it can and otherwise when it runs", () => {
  assert.deepEqual(
    [
      "let n = 7 / 2\nlet numbers = (1..=n).toList()\nexit",
      "let numbers = (0.5..3).toList()\nexit",
      "let r = 1..=3\nlet numbers = r.toList(1)\nexit",
      "let r = 1..=3\nlet n = r.count(1)\nexit",
    ].map((source) => diagnostics(source)),
    [
      [
        [
          "TSV043",
          "A toList range bound must be a whole number (integer), but this is a number. Round it with floor(...), round(...), or ceil(...).",
          "n",
        ],
      ],
      [
        [
          "TSV043",
          "A toList range bound must be a whole number (integer), but this is a number. Round it with floor(...), round(...), or ceil(...).",
          "0.5",
        ],
      ],
      [["TSV020", "toList() takes no arguments, received 1.", "r.toList(1)"]],
      [["TSV043", "A range has no method 'count'.", "count"]],
    ],
  );
  // A range kept in a variable, or with bounds the compiler cannot know, is checked when toList runs.
  assert.deepEqual(failure("let r = 1..2.5\nsay r.toList()\nexit"), [
    "TSR045",
    "toList() needs a range of whole numbers, but this range is 1..2.5. Round its bounds with floor(...), round(...), or ceil(...) first.",
    "r.toList()",
  ]);
  assert.deepEqual(failure(`${PICK}say (1..=pick(2.5)).toList()\nexit`), [
    "TSR045",
    "toList() needs a range of whole numbers, but this range is 1..=2.5. Round its bounds with floor(...), round(...), or ceil(...) first.",
    "(1..=pick(2.5)).toList()",
  ]);
  assert.deepEqual(failure("let r = 0..=9007199254740993\nsay r.toList()\nexit"), [
    "TSR045",
    "toList() needs a range of whole numbers, but the bounds of 0..=9007199254740992 are too large. Use bounds closer to 0.",
    "r.toList()",
  ]);
});

test("a range given where a list is needed names toList in the fix", () => {
  assert.deepEqual(
    [
      "let x = [0]\nx += 1..=3\nexit",
      "let x = [0]\nlet r = 1..3\nx += r\nexit",
      `${MAYBE}let x = [0]\nlet r = maybe(true)\nlet backup = 4..=5\nx += r otherwise backup\nexit`,
      "let x = [0]\nlet y = x + (1..3)\nexit",
      "let x = [0]\nlet y = (1..3) + x\nexit",
      "let x = [0]\nx.addAll(1..=3)\nexit",
      "let x = [0]\nlet y = x.union(1..=3)\nexit",
      "let total = sum(1..=3)\nexit",
    ].map((source) => diagnostics(source).map(([code, message]) => [code, message])),
    [
      [
        [
          "TSV041",
          "'x' holds a list (integer[]), so a range cannot be added to it. To add the numbers of a range, use 'x += (1..=3).toList()'.",
        ],
      ],
      [
        [
          "TSV041",
          "'x' holds a list (integer[]), so a range cannot be added to it. To add the numbers of a range, use 'x += r.toList()'.",
        ],
      ],
      [
        [
          "TSV041",
          "'x' holds a list (integer[]), so a range cannot be added to it. To add the numbers of a range, use 'x += (r otherwise backup).toList()'.",
        ],
      ],
      [
        [
          "TSV043",
          "'+' joins a list only with another list, not with a range. To add the numbers of a range, write 'x + (1..3).toList()'.",
        ],
      ],
      [
        [
          "TSV043",
          "'+' joins a list only with another list, not with a range. To add the numbers of a range, write '(1..3).toList() + x'.",
        ],
      ],
      [
        [
          "TSV043",
          "addAll() needs a list, but this is a range. Make a list of its numbers with toList() first.",
        ],
      ],
      [
        [
          "TSV043",
          "union() needs a list or a set, not a range. Make a list of its numbers with toList() first.",
        ],
      ],
      [
        [
          "TSV043",
          "sum(...) needs a list, not a range. Make a list of its numbers with toList() first.",
        ],
      ],
    ],
  );
  // The fix runs as written, also where the range is the result of an operator.
  assert.deepEqual(
    runValidSource(
      `${MAYBE}let x = [0]\nlet r = maybe(true)\nlet backup = 4..=5\nx += (r otherwise backup).toList()\nsay x\nexit`,
    ).snapshot.failure,
    null,
  );
  // A range the compiler cannot see fails with the same fix when the script runs.
  const join =
    "'+' joins two texts or two lists and adds numbers or durations, but these are a list and a range. To add the numbers of a range, write list + range.toList().";
  assert.deepEqual(failure(`${PICK}let x = [0]\nx += pick(1..=3)\nexit`)?.slice(0, 2), [
    "TSR009",
    join,
  ]);
  assert.deepEqual(failure(`${PICK}say [0] + pick(1..=3)\nexit`)?.slice(0, 2), ["TSR009", join]);
  assert.deepEqual(failure(`${PICK}say pick(1..=3) + [0]\nexit`)?.slice(0, 2), [
    "TSR009",
    "'+' joins two texts or two lists and adds numbers or durations, but these are a range and a list. To add the numbers of a range, write range.toList() + list.",
  ]);
  assert.deepEqual(failure(`${PICK}let x = [0]\nx.addAll(pick(1..=3))\nexit`)?.slice(0, 2), [
    "TSR060",
    "addAll() needs a list, not a range. Make a list of its numbers with toList() first.",
  ]);
  assert.deepEqual(failure(`${PICK}say [0].union(pick(1..=3))\nexit`)?.slice(0, 2), [
    "TSR060",
    "union() needs a list or a set, not a range. Make a list of its numbers with toList() first.",
  ]);
  assert.deepEqual(failure(`${PICK}say sum(pick(1..=3))\nexit`)?.slice(0, 2), [
    "TSR059",
    "sum(...) needs a list, not a range. Make a list of its numbers with toList() first.",
  ]);
});
