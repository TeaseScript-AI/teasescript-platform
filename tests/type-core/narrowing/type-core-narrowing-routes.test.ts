// N3's routes: a route without a check and the corridors the design closes, and every producer certified by its value
// (AD-1).

import assert from "node:assert/strict";
import test from "node:test";
import { type ItemTag } from "../../../src/type-inference/core/items.js";
import { routeAt } from "../../helpers/type-core/type-core-narrowing.js";
import {
  type Analysed,
  pass,
  read,
  type Case,
  check,
  REPEAT,
} from "../../helpers/type-core/type-core-narrowing-setup.js";

/** N3 at a read: the witness's source text, or `none`. */
function route(analysed: Analysed, marker: string, delta: number, tag: ItemTag = "null"): string {
  const witness = routeAt(analysed.pass, read(analysed, marker, delta), tag);
  return witness === null ? "none" : analysed.pass.program.textAt(witness.site);
}

test("N3 proves a route without a check, and refuses every corridor the design closes", () => {
  const restore = "function restore { n = 2 }";
  const clear = 'let clear = askBoolean "c"';
  const fork = 'let fork = askBoolean "f"';
  const choose = 'let pick = askBoolean "pick"';
  const nullable = [clear, "let n = 1", "if clear { n = null }"];
  const corridor = (
    name: string,
    lines: readonly string[],
    expected: string,
    marker = REPEAT,
    delta = 7,
  ): Case => [name, lines, marker, delta, expected];
  check(
    [
      corridor("absent", [...nullable, REPEAT], "null"),
      corridor(
        "an open implicit arm",
        [fork, ...nullable, restore, "if fork { restore() }", REPEAT],
        "null",
      ),
      corridor(
        "killed after it",
        [clear, "let n = 1", "if clear { n = null\n n = 2 }", REPEAT],
        "none",
      ),
      corridor(
        "killed in its block",
        [
          clear,
          'let r = askBoolean "r"',
          "let n = 1",
          "if clear { if r { n = null }\n n = 2 }",
          REPEAT,
        ],
        "none",
      ),
      corridor(
        "both arms kill",
        [
          'let r = askBoolean "r"',
          "let n = 1",
          "n = null",
          "if r { n = 2 } else { n = 3 }",
          REPEAT,
        ],
        "none",
      ),
      corridor(
        "a prefix replaced",
        [clear, "let box = {n: 1}", "if clear { box.n = null\n box = {n: 2} }", "repeat box.n {}"],
        "none",
        "repeat box.n",
        7,
      ),
      corridor(
        "the consumer side",
        [
          'let enter = askBoolean "e"',
          choose,
          ...nullable,
          "if enter { if pick { n = 2 } else { n = 3 }\n repeat n {} }",
        ],
        "none",
      ),
      corridor(
        "the mixed split",
        [choose, ...nullable, restore, "if pick { n = 2 } else { restore() }", REPEAT],
        "none",
      ),
      corridor(
        "both arms call",
        [fork, ...nullable, restore, "if fork { restore() } else { restore() }", REPEAT],
        "none",
      ),
      corridor("blocking assignment", [...nullable, "if n == null { n = 1 }", REPEAT], "none"),
      corridor("blocking exit", [...nullable, "if n == null { exit }", REPEAT], "none"),
      corridor(
        "blocking else",
        [...nullable, "if n != null { say n } else { n = 0 }", REPEAT],
        "none",
      ),
      corridor("an empty else", [...nullable, "if n != null { say n }", REPEAT], "null"),
      corridor("a closed prefix", [...nullable, restore, "if restore() { say 1 }", REPEAT], "none"),
      corridor("a header call", [...nullable, restore, "if restore() { repeat n {} }"], "none"),
      corridor("an earlier operand", [...nullable, restore, "say restore() + n"], "none", "+ n", 2),
      corridor("a later operand", [...nullable, restore, "say n + restore()"], "null", "say n", 4),
      corridor(
        "an argument",
        [clear, "let a = 1", "if clear { a = null }", "function use(n) { repeat n {} }", "use(a)"],
        "none",
      ),
      corridor("a `null` argument", ["function use(n) { repeat n {} }", "use(null)"], "none"),
      corridor("an omitted default", ["function use(n = null) { repeat n {} }", "use()"], "null"),
      corridor(
        "a member through a reference",
        [
          clear,
          "speaker s { rounds: 1 }",
          "let p = s",
          "if clear { p.rounds = null }",
          "repeat p.rounds {}",
        ],
        "none",
        "repeat p.rounds",
        7,
      ),
      corridor(
        "a sibling arm",
        [clear, "let n = 1", "if clear { n = null } else { repeat n {} }"],
        "none",
      ),
      corridor(
        "routes, not runs",
        ['let b = askBoolean "Clear?"', "let n = 1", "if b { n = null }", "if not b { say n + 1 }"],
        "null",
        "say n",
        4,
      ),
      corridor(
        "out of a loop",
        [clear, "let n = 1", "repeat 2 { repeat 2 { if clear { n = null } }\n repeat n {} }"],
        "null",
      ),
      corridor("a handler store", [...nullable, "timer async 1 s { n = 2 }", REPEAT], "none"),
    ],
    route,
  );
});

const c = 'let c = askBoolean "c"';
const cases: readonly (readonly [string, readonly string[], string, number, ItemTag, string])[] = [
  [
    "load default",
    ['let n = load("n", default: null)', REPEAT],
    REPEAT,
    7,
    "null",
    'load("n", default: null)',
  ],
  [
    "lookup default",
    ["let values = [3]", "let n = values.get(0, default: null)", REPEAT],
    REPEAT,
    7,
    "null",
    "values.get(0, default: null)",
  ],
  [
    "parsing default",
    ['let n = fromJson("4", default: null)', REPEAT],
    REPEAT,
    7,
    "null",
    'fromJson("4", default: null)',
  ],
  [
    "void exit",
    [
      "function rounds(enabled: boolean) { if enabled { return 3 } }",
      "let n = rounds(true)",
      REPEAT,
    ],
    REPEAT,
    7,
    "null",
    "rounds(true)",
  ],
  // (AD-1, #1073: a lookup's, a parse's and a void exit's `null` certify as a literal's does; a fallback never
  // selected certifies nothing)
  ["dead fallback", ["let n = 1 otherwise null", REPEAT], REPEAT, 7, "null", "none"],
  [
    "certified otherwise",
    ['let a = load("a", default: null)', "let n = a otherwise null", REPEAT],
    REPEAT,
    7,
    "null",
    "a otherwise null",
  ],
  [
    "otherwise after a literal null",
    [c, "let n: integer? = 5", "if c { n = null otherwise null }", REPEAT],
    REPEAT,
    7,
    "null",
    "null otherwise null",
  ],
  [
    "otherwise after a literal null, a union member",
    [c, "let n: integer | string = 5", 'if c { n = null otherwise "bad" }', REPEAT],
    REPEAT,
    7,
    "string",
    'null otherwise "bad"',
  ],
  [
    "otherwise after a literal null, another kind",
    [c, "let n: integer? = 5", "if c { n = null otherwise 3 }", REPEAT],
    REPEAT,
    7,
    "null",
    "none",
  ],
  [
    "otherwise after an uncertified null",
    [
      c,
      "let n: integer? = 5",
      "let values = [3]",
      "if c { n = values.get(0, default: null) otherwise null }",
      REPEAT,
    ],
    REPEAT,
    7,
    "null",
    "values.get(0, default: null) otherwise null",
  ],
  [
    "an omitted default after a literal null",
    ["function use(n: integer? = null otherwise null) { repeat n {} }", "use()"],
    REPEAT,
    7,
    "null",
    "null otherwise null",
  ],
  [
    "a supplied default after a literal null",
    ["function use(n: integer? = null otherwise null) { repeat n {} }", "use(4)"],
    REPEAT,
    7,
    "null",
    "none",
  ],
  [
    "copy",
    [c, "let source = 1", "if c { source = null }", "let saved = source", "repeat saved {}"],
    "repeat saved",
    7,
    "null",
    "source",
  ],
  [
    "copy, closed",
    [
      c,
      "let source = 1",
      "if c { source = null\n source = 2 }",
      "let saved = source",
      "repeat saved {}",
    ],
    "repeat saved",
    7,
    "null",
    "none",
  ],
  [
    "union member",
    ['let n: integer | string = load("n", default: "bad")', REPEAT],
    REPEAT,
    7,
    "string",
    'load("n", default: "bad")',
  ],
  [
    "whole store",
    [c, "let box = {n: 1}", "if c { box = {n: null} }", "repeat box.n {}"],
    "repeat box.n",
    7,
    "null",
    "{n: null}",
  ],
  [
    "whole store, read field",
    [c, "let a = null", "let box = {n: 1}", "if c { box = {n: a} }", "repeat box.n {}"],
    "repeat box.n",
    7,
    "null",
    "{n: a}",
  ],
];

test("N3 certifies every producer by what its value holds (AD-1), a certified `otherwise` and scalar copies; refuses a default no run selects", () => {
  for (const [name, lines, marker, delta, tag, expected] of cases)
    assert.equal(route(pass(...lines), marker, delta, tag), expected, name);
});
