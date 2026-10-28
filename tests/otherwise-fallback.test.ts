import assert from "node:assert/strict";
import test from "node:test";

import { compileSource } from "../src/compiler.js";
import type { InstructionPlan } from "../src/plan/model.js";
import {
  createCheckpoint,
  deserializeCheckpoint,
  serializeCheckpoint,
} from "../src/runtime/snapshot/checkpoint.js";
import { run } from "../src/runtime/engine.js";
import type { InterpreterEvent } from "../src/runtime/events.js";
import { completeAction } from "../src/runtime/operations/complete-action.js";
import type { SerializableRuntimeValue } from "../src/runtime/values/serializable-values.js";
import type { RuntimeSnapshot } from "../src/runtime/snapshot/state.js";
import { compileValidPlan } from "./helpers/compile-valid-plan.js";
import { createImmediatePacingRuntimeSnapshot } from "./helpers/immediate-pacing-runtime.js";
import { assertRuntimeResumeEquivalent } from "./helpers/runtime-equivalence.js";
import { runValidSource } from "./helpers/run-valid-source.js";

// `a otherwise b` (V30 §18, #850) gives `a`, or `b` when `a` is null, and evaluates `b` only then.

/** Hides a value's type from the compiler, so that a variable declared with `?` may really hold null. */
const HIDE = "function hide(value) {\n    return value\n}\n";

function said(events: readonly InterpreterEvent[]): string[] {
  return events.flatMap((event) => (event.kind === "say" ? [event.text] : []));
}

function sayTexts(source: string): string[] {
  const result = runValidSource(source);
  assert.equal(result.snapshot.failure, null, JSON.stringify(result.snapshot.failure));
  return said(result.events);
}

function diagnostics(source: string): [string, string, string, string][] {
  return compileSource(source).diagnostics.map((diagnostic) => [
    diagnostic.severity,
    diagnostic.code,
    diagnostic.message,
    source.slice(diagnostic.span.start.offset, diagnostic.span.end.offset),
  ]);
}

test("otherwise gives the value unless it is null, and runs the fallback only then", () => {
  assert.deepEqual(
    sayTexts(
      `${HIDE}let calls = 0
function bump {
    calls += 1
    return 9
}
let missing: integer? = hide(null)
let found: integer? = hide(4)
say (null otherwise 1) == 1
say (found otherwise 1) == 4
say missing otherwise bump()
say found otherwise bump()
say calls
// A fallback evaluated in place, which would fail here, as one that runs as instructions.
let marks = hide([7])
say found otherwise marks[9]
say missing otherwise marks[0]
exit`,
    ),
    ["true", "true", "9", "4", "1", "4", "7"],
  );
});

test("a fallback that is not null makes the result not null", () => {
  // An integer? with a fallback is an integer, without a check; with a null fallback it stays optional.
  assert.deepEqual(
    sayTexts(
      `${HIDE}let lives: integer? = hide(null)
let left: integer = lives otherwise 3
say left + 1
say (lives otherwise 0) * 2
exit`,
    ),
    ["4", "0"],
  );
  assert.deepEqual(
    diagnostics(
      `${HIDE}let name: string? = hide(null)\nlet shown = name otherwise null\nsay shown + "!"\nexit`,
    ),
    [
      [
        "error",
        "TSV043",
        `'shown' may be null. Check it first: if shown != null { ... }, or give a fallback: shown otherwise ""`,
        "shown",
      ],
    ],
  );
  // A fallback of another type gives a union, which needs a test before an operation of one type.
  assert.deepEqual(
    diagnostics(
      `${HIDE}let name: string? = hide(null)\nlet shown = name otherwise 0\nsay shown + 1\nexit`,
    )[0]?.slice(1, 3),
    ["TSV043", "'shown' may be text (string). Check it first: if shown is integer { ... }"],
  );
});

/** What a script says, and the code and message of its failure, with values saved under keys before it runs. */
function outcome(
  source: string,
  storage: { key: string; value: SerializableRuntimeValue }[] = [],
): [string[], [string, string] | null] {
  const compiled = compileValidPlan(source);
  const result = run(
    compiled,
    createImmediatePacingRuntimeSnapshot(compiled, { scriptStorage: storage }),
  );
  const failure = result.snapshot.failure;
  return [said(result.events), failure === null ? null : [failure.code, failure.message]];
}

test("after a value of unknown type, otherwise and every null check compile as the if form does (#859)", () => {
  // Three ways a variable gets a value of unknown type while no value decided its type: a load of a computed key and a
  // function result without a type, each after 'let x = null', and a copy of an element of an empty list.
  const sources: ((
    value: number | string | null,
  ) => [string, { key: string; value: SerializableRuntimeValue }[]])[] = [
    (value) => [
      'let n = "a"\nlet x = null\nx = load "k.${n}", default: null',
      value === null ? [] : [{ key: "k.a", value }],
    ],
    (value) => [`${HIDE}let x = null\nx = hide(${JSON.stringify(value)})`, []],
    (value) => [
      `${HIDE}let items = []\nitems.add(hide(${JSON.stringify(value)}))\nlet x = items[0]`,
      [],
    ],
  ];
  const use = (value: string) => `say "\${${value} - 1}"`;
  // Each form with what it says for 5 and for null. Text fails when the script runs, in every form.
  const forms: [string, string[], string[]][] = [
    [`if x == null { x = 0 }\n${use("x")}`, ["4"], ["-1"]],
    [use("(x otherwise 0)"), ["4"], ["-1"]],
    [`let y = x otherwise 0\n${use("y")}`, ["4"], ["-1"]],
    [`x = x otherwise 0\n${use("x")}`, ["4"], ["-1"]],
    [`let y = x otherwise null otherwise 0\n${use("y")}`, ["4"], ["-1"]],
    [`if x != null {\n    ${use("x")}\n}`, ["4"], []],
    [`if x == null {\n    say "none"\n} else {\n    ${use("x")}\n}`, ["4"], ["none"]],
    ['if x == null or x - 1 > 0 {\n    say "yes"\n}', ["yes"], ["yes"]],
    ['if x != null and x - 1 > 0 {\n    say "yes"\n}', ["yes"], []],
    [`if x == null {\n    exit\n}\n${use("x")}`, ["4"], []],
  ];
  for (const source of sources)
    for (const [form, five, none] of forms) {
      const script = (
        value: number | string | null,
        check = form,
      ): [string, { key: string; value: SerializableRuntimeValue }[]] => {
        const [start, storage] = source(value);
        return [`${start}\n${check}\nexit`, storage];
      };
      const label = script(5)[0];
      assert.deepEqual(outcome(...script(5)), [five, null], label);
      assert.deepEqual(outcome(...script(null)), [none, null], label);
      assert.match(outcome(...script("t"))[1]?.[0] ?? "", /^TSR0(27|58)$/, label);
      // A typed place gets no value that nothing checked: text fails before it is kept there.
      const typed = form.replace(
        /say "\$\{(\w+|\(x otherwise 0\)) - 1\}"/,
        "let count: integer = $1\nsay count",
      );
      if (typed !== form) assert.equal(outcome(...script("t", typed))[1]?.[0], "TSR058", typed);
    }
  // The issue's script: the fallback decides 'x' as the if form's store does, so text fails at the load, as there.
  const loaded = (check: string) =>
    `let n = "a"\nlet x = null\nx = load "k.\${n}", default: null\n${check}\nsay "\${x - 1}"\nexit`;
  const text = [{ key: "k.a", value: "t" }];
  assert.deepEqual(outcome(loaded("x = x otherwise 0"), text), [
    [],
    ["TSR058", `'x' holds a whole number (integer) or null, so it cannot take text (string) "t".`],
  ]);
  assert.deepEqual(
    outcome(loaded("x = x otherwise 0"), text),
    outcome(loaded("if x == null { x = 0 }"), text),
  );
  // A parameter without a type, and a get with a null default on a list whose element type no value decided yet.
  assert.deepEqual(
    sayTexts(
      `${HIDE}function less(value) {\n    let known = value otherwise 0\n    return known - 1\n}\nlet items = []\nitems.add(hide(5))\nlet first = items.get(0, default: null) otherwise 0\nsay less(null)\nsay less(5)\nsay first - 1\nexit`,
    ),
    ["-1", "4", "4"],
  );
});

test("x = x otherwise d keeps what x held where it was not null, also in parentheses (#859)", () => {
  // The call in the fallback may run 'reset', which ends what is known about 'x', but 'x' was read before it.
  assert.deepEqual(
    sayTexts(
      `${HIDE}let x: integer | string | null = hide(null)\nfunction reset {\n    x = "a"\n}\nfunction chooseZero {\n    return 0\n}\nif x is integer? {\n    x = x otherwise chooseZero()\n    let z: integer = x\n    say z\n}\nexit`,
    ),
    ["0"],
  );
  assert.deepEqual(
    outcome(
      'let n = "a"\nlet x = null\nx = load "k.${n}", default: null\nx = (x otherwise null) otherwise 0\nlet z: integer = x\nsay z\nexit',
      [{ key: "k.a", value: 4 }],
    ),
    [["4"], null],
  );
});

test("a fallback keeps a value that held only null where a later value decides it after all (#859)", () => {
  // The list stored in 'x' has an element of unknown type, so no later check can start with 'x' decided.
  const loop = (body: string) =>
    `${HIDE}let items = []\nitems.add(hide(1))\nlet x = null\nrepeat 2 {\n    let y = x otherwise 0\n${body}\n    x = items\n}\nexit`;
  assert.deepEqual(
    diagnostics(loop("    say y + 1")).map(([, code, , text]) => [code, text]),
    [["TSV043", "y"]],
  );
  assert.deepEqual(
    outcome(
      loop('    if y is integer {\n        say "integer"\n    } else {\n        say "list"\n    }'),
    ),
    [["integer", "list"], null],
  );
});

test("a copy of a value of unknown type from a list or dict is of unknown type wherever it goes (#859)", () => {
  // The importer's reduction of a helper that fills a list from a parameter without a type and stores elements back.
  assert.deepEqual(
    diagnostics(`function sexscriptLegacyRandom(limit) {
  return 0
}
function shuffle(deck, ndeck) {
  let newdeckValue = []
  let i = 0
  while i < ndeck {
    if i < newdeckValue.length {
      newdeckValue.add(deck[i])
    }
    let j = sexscriptLegacyRandom(ndeck)
    let temp = newdeckValue[i]
    if j < newdeckValue.length {
      newdeckValue[j] = temp
      newdeckValue.add(temp)
    }
  }
  return newdeckValue
}
let imp: string[] = ["a", "b"]
imp = shuffle(imp, 2)
exit`),
    [],
  );
  /** What a script that compiles without errors says, and the code of its failure. */
  const ran = (source: string): [string[], string | null] => {
    const compiled = compileSource(source);
    const errors = compiled.diagnostics.filter((diagnostic) => diagnostic.severity === "error");
    assert.deepEqual(errors, [], source);
    const result = run(compiled.plan!, createImmediatePacingRuntimeSnapshot(compiled.plan!));
    return [said(result.events), result.snapshot.failure?.code ?? null];
  };
  // A copy of an element goes back twice, through a list literal, through a branch that may replace it, through a list
  // that text decides, and after a null check. A typed place checks what reaches it when the script runs: a number,
  // and null unless the null check replaced it.
  const holders = [
    {
      start: "let out = []\n    out.add(deck[0])\n    out.add(deck[1])",
      at: (index: number) => `out[${index}]`,
      result: "out",
    },
    {
      start: 'let out = dict{}\n    out["a"] = deck[0]\n    out["b"] = deck[1]',
      at: (index: number) => `out["${"ab"[index]}"]`,
      result: '[out["a"], out["b"]]',
    },
  ];
  const forms: [(at: (index: number) => string) => string, [string[], string | null]][] = [
    [(at) => `let temp = ${at(0)}\n    ${at(1)} = temp\n    ${at(0)} = temp`, [[], "TSR058"]],
    [
      (at) =>
        `let temp = ${at(0)}\n    let pair = [temp, temp]\n    ${at(1)} = pair[0]\n    ${at(0)} = pair[1]`,
      [[], "TSR058"],
    ],
    [
      (at) =>
        `let temp = ${at(0)}\n    if deck.length > 5 {\n        temp = ${at(1)}\n    }\n    ${at(1)} = temp\n    ${at(0)} = temp`,
      [[], "TSR058"],
    ],
    [
      (at) =>
        `let temp = ${at(0)}\n    let other = []\n    other.add(temp)\n    other.add("x")\n    ${at(1)} = other[0]\n    ${at(0)} = other[0]`,
      [[], "TSR058"],
    ],
    [
      (at) =>
        `let temp = ${at(0)}\n    if temp == null {\n        temp = "z"\n    }\n    ${at(1)} = temp\n    ${at(0)} = temp`,
      [["zz"], null],
    ],
  ];
  for (const holder of holders)
    for (const [form, none] of forms) {
      const script = (deck: string) =>
        `function helper(deck) {\n    ${holder.start}\n    ${form(holder.at)}\n    return ${holder.result}\n}\nlet imp: string[] = ["p", "q"]\nimp = helper(${deck})\nsay imp[0] + imp[1]\nexit`;
      const label = script('["a", "b"]');
      assert.deepEqual(ran(label), [["aa"], null], label);
      assert.deepEqual(ran(script("[1, 2]")), [[], "TSR058"], label);
      assert.deepEqual(ran(script("[null, null]")), none, label);
    }
  // A copy that the function returns, and copies that a known value replaces on one path only.
  const first = (deck: string) =>
    `function first(deck) {\n    let out = []\n    out.add(deck[0])\n    let temp = out[0]\n    return temp\n}\nlet name: string = first(${deck})\nsay name\nexit`;
  assert.deepEqual(ran(first('["a"]')), [["a"], null]);
  assert.deepEqual(ran(first("[null]")), [[], "TSR058"]);
  const named = (names: string) =>
    `function pick(names) {\n    let chosen = []\n    chosen.add(names[0])\n    let name = chosen[0]\n    if name == "" {\n        name = "anonymous"\n    }\n    return name\n}\nlet picked: string = pick(${names})\nsay picked\nexit`;
  assert.deepEqual(ran(named('["ann"]')), [["ann"], null]);
  assert.deepEqual(ran(named('[""]')), [["anonymous"], null]);
  assert.deepEqual(ran(named("[null]")), [[], "TSR058"]);
  const grown = (lists: string) =>
    `function grow(lists) {\n    let held = []\n    held.add(lists[0])\n    let items = held[0]\n    if items == null {\n        items = []\n    }\n    items.add(1)\n    return items.length\n}\nsay "\${grow(${lists})}"\nexit`;
  assert.deepEqual(ran(grown("[[5]]")), [["2"], null]);
  assert.deepEqual(ran(grown("[null]")), [["1"], null]);
});

test("a read of a place that held only values of unknown type is of unknown type after an assignment and in a loop", () => {
  // As after 'let x = items[0]' (#859): the variable is of unknown type, so a null check or a fallback replaces null
  // and a use checks what is left when the script runs.
  const start = (value: string) =>
    `${HIDE}let items = []\nitems.add(hide(${value}))\nlet holder = { p: null }\nholder.p = hide(${value})\n`;
  const reads = [
    (check: string) => `let x = hide(null)\nx = items[0]\n${check}\nsay "\${x - 1}"`,
    (check: string) =>
      `let x = hide(null)\nx = items.get(0, default: null)\n${check}\nsay "\${x - 1}"`,
    (check: string) => `let x = hide(null)\nx = holder.p\n${check}\nsay "\${x - 1}"`,
    (check: string) =>
      `function less(x) {\n    x = items[0]\n    ${check}\n    say "\${x - 1}"\n}\nless(1)`,
  ];
  for (const read of reads)
    for (const check of ["if x == null { x = 0 }", "x = x otherwise 0"]) {
      const script = (value: string) => `${start(value)}${read(check)}\nexit`;
      assert.deepEqual(outcome(script("5")), [["4"], null], script("5"));
      assert.deepEqual(outcome(script("null")), [["-1"], null], script("null"));
      assert.equal(outcome(script('"t"'))[1]?.[0], "TSR027", script('"t"'));
    }
  // A loop variable is not decided by a later store either, so a null check of it is no constant test.
  const loops = [
    (value: string) =>
      `${HIDE}let items = []\nitems.add(hide(${value}))\nfor x in items {\n    if x == null { x = 0 }\n    say "\${x - 1}"\n}\nexit`,
    (value: string) =>
      `${HIDE}let d = dict{}\nd["a"] = hide(${value})\nfor k, x in d {\n    if x == null { x = 0 }\n    say "\${x - 1}"\n}\nexit`,
  ];
  for (const loop of loops) {
    assert.deepEqual(diagnostics(loop("null")), [], loop("null"));
    assert.deepEqual(outcome(loop("5")), [["4"], null]);
    assert.deepEqual(outcome(loop("null")), [["-1"], null]);
  }
  // An element that a method removes, where another element took null, is such a value too: a typed place or parameter
  // checks it when the script runs.
  const removed: [(value: string) => string, string][] = [
    [
      (value) =>
        `${HIDE}let items = []\nitems.add(hide(${value}))\nitems.add(null)\nlet kept: integer = items.removeFirst()\nsay kept\nexit`,
      "5",
    ],
    [
      (value) =>
        `${HIDE}function twice(n: integer) {\n    return n * 2\n}\nlet items = []\nitems.add(hide(${value}))\nitems.add(null)\nsay twice(items.removeFirst())\nexit`,
      "10",
    ],
    [
      (value) =>
        `${HIDE}let d = dict{}\nd["a"] = hide(${value})\nd["b"] = null\nlet kept: integer = d.remove("a")\nsay kept\nexit`,
      "5",
    ],
  ];
  for (const [script, said] of removed) {
    assert.deepEqual(outcome(script("5")), [[said], null], script("5"));
    assert.equal(outcome(script('"t"'))[1]?.[0], "TSR058", script('"t"'));
  }
  // A store that decides the elements later still decides them for the loop, which checks them when they are added.
  assert.deepEqual(
    diagnostics(
      `${HIDE}let bets = []\nfunction fill {\n    bets.add(hide(5))\n    for e in bets {\n        if e == null {\n            say "none"\n        }\n    }\n}\nfunction reset {\n    bets = [5, 10]\n}\nfill()\nreset()\nexit`,
    ).map(([, code, , text]) => [code, text]),
    [["TSV046", "e == null"]],
  );
});

test("a null check removes the null of a copy of a place that took null first", () => {
  // A copy, also of an element that a method gives, keeps that null as a value of its own, so after the check it holds
  // the text that replaced it, also where the list or dict it goes into was read before its first value, which a first
  // check decides for the next.
  const targets = [
    ["let other = []\nif other.length > 0 {\n    say other[0]\n}", "other.add(x)", "other[0]"],
    [
      'let other = dict{}\nif other.contains("a") {\n    say other["a"]\n}',
      'other["a"] = x',
      'other["a"]',
    ],
  ];
  for (const [target, store, read] of targets)
    for (const copy of [
      ...["out[0]", "out.get(0, default: null)", "out.removeLast()"].map(
        (value) => `let x = ${value}\nif x == null {\n    x = "z"\n}\n${target}\n${store}`,
      ),
      `${target}\nfor x in out {\n    if x == null {\n        x = "z"\n    }\n    ${store}\n}`,
    ]) {
      const source = `let out = []\nout.add(null)\n${copy}\nlet kept: string = ${read}\nsay kept\nexit`;
      assert.deepEqual(sayTexts(source), ["z"], source);
    }
  // Without the check, the copy may still be null.
  assert.deepEqual(
    diagnostics(
      'let out = []\nout.add(null)\nout.add("q")\nlet x = out[0]\nlet kept: string = x\nexit',
    ).map(([, code, , text]) => [code, text]),
    [["TSV041", "x"]],
  );
});

test("a variable of unknown type holds null after a copy of a place that held only null", () => {
  // As after 'let x = out[0]': a null check or a fallback replaces the null, also where a method, a member, a dict, an
  // object, or a function gives the copy, and in a parameter without a type.
  const reads: [string, string][] = [
    ["let out = [null]", "out[0]"],
    ["let out = [null]", "out.get(0, default: null)"],
    ["let out = [null]", "out.removeLast()"],
    ["let out = [null]", "out.last"],
    ["let d = dict{ a: null }", 'd["a"]'],
    ["let p = { v: null }", "p.v"],
    ["let out = [null]\nfunction first {\n    return out[0]\n}", "first()"],
  ];
  for (const check of ['if x == null {\n    x = "z"\n}', 'x = x otherwise "z"']) {
    const sources = [
      ...reads.map(
        ([start, read]) =>
          `${HIDE}${start}\nlet x = hide(null)\nx = ${read}\n${check}\nsay x + "!"\nexit`,
      ),
      `let out = [null]\nfunction shout(x) {\n    x = out[0]\n    ${check}\n    return x + "!"\n}\nsay shout(1)\nexit`,
    ];
    for (const source of sources) assert.deepEqual(sayTexts(source), ["z!"], source);
  }
  // Without a check it is null, and a later store that decides the place decides what the copy holds.
  const start = `${HIDE}let out = [null]\nlet x = hide(null)\nx = out[0]\n`;
  for (const [source, message] of [
    [
      `${start}say x + "!"\nexit`,
      `'+' joins text only with other text, not with null. Put the value in the text instead, as in "\${x}!".`,
    ],
    [
      `${start}if x == null {\n    x = "z"\n}\nsay x + "!"\nout.add(5)\nexit`,
      "'x' may be a whole number (integer). Check it first: if x is string { ... }",
    ],
  ] as const)
    assert.deepEqual(
      diagnostics(source).map(([, code, text]) => [code, text]),
      [["TSV043", message]],
      source,
    );
  // Where the next check cannot start with what decided the place, here a list with an element of unknown type, the
  // variable keeps the copy, so a use that needs a number is still checked.
  const loop = (use: string) =>
    `${HIDE}let items = []\nitems.add(hide(1))\nlet x = null\nlet y = hide(null)\nrepeat 2 {\n    y = x\n    if y == null {\n        y = 0\n    }\n${use}\n    x = items\n}\nexit`;
  assert.deepEqual(
    diagnostics(loop("    say y + 1")).map(([, code, , text]) => [code, text]),
    [["TSV043", "y"]],
  );
  assert.deepEqual(
    sayTexts(
      loop('    if y is integer {\n        say "integer"\n    } else {\n        say "list"\n    }'),
    ),
    ["integer", "list"],
  );
});

test("a fallback that may run ends a narrowing that it may change, and one that never runs ends none", () => {
  const source = (value: string) =>
    `${HIDE}let count: integer? = hide(1)
let other: integer? = hide(null)
function reset {
    count = null
    return 0
}
if count != null {
    let result = ${value} otherwise reset()
    say count + 1
}
exit`;
  assert.deepEqual(
    diagnostics(source("other")).map((diagnostic) => diagnostic.slice(1, 3)),
    [
      [
        "TSV043",
        "'count' may be null. Check it first: if count != null { ... }, or give a fallback: count otherwise 0",
      ],
    ],
  );
  assert.deepEqual(
    diagnostics(source("count")).map((diagnostic) => diagnostic[1]),
    ["TSV062"],
  );
});

test("a chain gives the first value that is not null, from left to right", () => {
  const source = (nickname: string, saved: string) =>
    `${HIDE}let tried = []
function note(given, step) {
    tried.add(step)
    return given
}
let nickname: string? = hide(${nickname})
let saved: string? = hide(${saved})
let name = note(nickname, 1) otherwise note(saved, 2) otherwise note("pet", 3)
say "\${name} \${tried.join("")}"
exit`;
  assert.deepEqual(sayTexts(source('"Bo"', '"Al"')), ["Bo 1"]);
  assert.deepEqual(sayTexts(source("null", '"Al"')), ["Al 12"]);
  assert.deepEqual(sayTexts(source("null", "null")), ["pet 123"]);
});

test("otherwise beside any other operator needs parentheses, and one error names both readings", () => {
  const cases: [string, string, string][] = [];
  for (const operator of ["+", "-", "*", "/", "%"])
    cases.push(
      [
        `a otherwise 3 ${operator} 2`,
        `(a otherwise 3) ${operator} 2`,
        `a otherwise (3 ${operator} 2)`,
      ],
      [
        `3 ${operator} a otherwise 2`,
        `3 ${operator} (a otherwise 2)`,
        `(3 ${operator} a) otherwise 2`,
      ],
    );
  cases.push(
    ["-a otherwise 2", "-(a otherwise 2)", "(-a) otherwise 2"],
    ["+a otherwise 2", "+(a otherwise 2)", "(+a) otherwise 2"],
    ["a otherwise 1..=3", "(a otherwise 1)..=3", "a otherwise (1..=3)"],
    ["1..a otherwise 3", "1..(a otherwise 3)", "(1..a) otherwise 3"],
    // The operators that bind more loosely: a comparison on either side, a type test, `not`, `and`, and `or`.
    ["a otherwise 3 == 2", "(a otherwise 3) == 2", "a otherwise (3 == 2)"],
    ["3 <= a otherwise 2", "3 <= (a otherwise 2)", "(3 <= a) otherwise 2"],
    ["a otherwise 3 is integer", "(a otherwise 3) is integer", "a otherwise (3 is integer)"],
    ["not c otherwise true", "not (c otherwise true)", "(not c) otherwise true"],
    ["c otherwise false and true", "(c otherwise false) and true", "c otherwise (false and true)"],
    ["true or c otherwise false", "true or (c otherwise false)", "(true or c) otherwise false"],
    ['"${a otherwise 3 != 2}"', "(a otherwise 3) != 2", "a otherwise (3 != 2)"],
    // Both sides, a chain, and the issue's own example: the error quotes what was written.
    ["2 * a otherwise 3 + 1", "2 * (a otherwise 3) + 1", "(2 * a) otherwise (3 + 1)"],
    [
      "a otherwise b otherwise 3 + 1",
      "(a otherwise b otherwise 3) + 1",
      "a otherwise b otherwise (3 + 1)",
    ],
    [
      "a otherwise b otherwise 3 > 1",
      "(a otherwise b otherwise 3) > 1",
      "a otherwise b otherwise (3 > 1)",
    ],
    [
      'path.lastIndexOf("/") otherwise -1 + 1',
      '(path.lastIndexOf("/") otherwise -1) + 1',
      'path.lastIndexOf("/") otherwise (-1 + 1)',
    ],
  );
  for (const [written, nearest, all] of cases)
    assert.deepEqual(
      diagnostics(
        `${HIDE}let a: integer? = hide(null)\nlet b: integer? = hide(null)\nlet c: boolean? = hide(null)\nlet path = "a/b"\nsay ${written}\nexit`,
      ),
      [
        [
          "error",
          "TSP041",
          `Put parentheses around what 'otherwise' belongs to: '${nearest}' or '${all}'.`,
          "otherwise",
        ],
      ],
      written,
    );
  // A reading too long to quote is named by an example.
  assert.deepEqual(
    diagnostics(
      'let a: string? = null\nsay a otherwise "a fallback long enough to need a generic text" + "!"\nexit',
    ).map((diagnostic) => diagnostic[2]),
    [
      "Put parentheses around what 'otherwise' belongs to, as in '(count otherwise 0) + 1' or 'count otherwise (0 + 1)'.",
    ],
  );
});

test("otherwise needs no parentheses in a chain, in an interpolation, and before a sign or a unit", () => {
  assert.deepEqual(
    sayTexts(
      `${HIDE}let path = "a/b/c"
let count: integer? = hide(null)
let nickname: string? = hide(null)
let delay: duration? = hide(null)
say path.lastIndexOf("/") otherwise -1
say "abc".lastIndexOf("/") otherwise -1
say (delay otherwise 5 s) == 5 s
say nickname otherwise count otherwise "you"
say "\${nickname otherwise "you"} \${count otherwise 0}"
exit`,
    ),
    ["3", "-1", "true", "you", "you 0"],
  );
});

test("with parentheses, either reading compiles and runs as written", () => {
  assert.deepEqual(
    sayTexts(
      `${HIDE}let five: integer? = hide(5)
let known = hide(4)
let none = hide(null)
say (five otherwise 3) + 2
say five otherwise (3 + 2)
say (five otherwise 3) / 2
say five otherwise (3 / 2)
say 2 * (known otherwise 5)
say (2 * known) otherwise 5
say -(none otherwise 1)
say (-known) otherwise 1
let off: boolean? = hide(false)
say (off otherwise true) == false
say off otherwise (true == false)
let total = 0
for step in (none otherwise 1)..=3 {
    total += step
}
for step in none otherwise (1..=2) {
    total += step * 10
}
say total
exit`,
    ),
    ["7", "5", "2.5", "5", "8", "8", "-1", "-4", "true", "false", "36"],
  );
});

test("a null check also names a fallback of the value's type, but not for a value that is changed", () => {
  const messages = (source: string) =>
    compileSource(`${HIDE}${source}\nexit`).diagnostics.map((diagnostic) => diagnostic.message);
  const check = (name: string, fallback?: string) =>
    `'${name}' may be null. Check it first: if ${name} != null { ... }${fallback === undefined ? "" : `, or give a fallback: ${name} otherwise ${fallback}`}`;
  for (const [declared, use, fallback] of [
    ["integer", "say n + 1", "0"],
    ["number", "say n * 2", "0"],
    ["string", 'say n + "!"', '""'],
    // Text reverse() gives a new text, so unlike a list's, it changes nothing.
    ["string", "say n.reverse()", '""'],
    ["boolean", "if n {\n    say 1\n}", "false"],
    ["duration", "wait n", "..."],
    ["integer[]", "say n.count()", "..."],
  ] as const)
    assert.deepEqual(
      messages(`let n: ${declared}? = hide(null)\n${use}`),
      [check("n", fallback)],
      use,
    );
  // A value that is not a variable, and a store into a narrower place.
  assert.deepEqual(messages('say "a/b".lastIndexOf("/") + 1'), [
    "This value may be null. Keep it in a variable and check it first, as in: if value != null { ... }, or give a fallback: value otherwise 0",
  ]);
  assert.deepEqual(messages("let n: integer? = hide(null)\nlet m: integer = n"), [
    "'m' is declared as integer, so it cannot start as a whole number (integer) or null. Check it first: if n != null { ... }, or give a fallback: n otherwise 0",
  ]);
  // A fallback would be a copy, so a value that an assignment or a method changes gets only the check, and so does a
  // handle, for which no fallback can be written.
  for (const source of [
    'let p: object? = hide({ name: "a" })\np.name = "b"',
    "let n: integer[]? = hide([1])\nn[0] = 2",
    "let n: integer? = hide(1)\nn += 1",
    "let n: integer[]? = hide([1])\nn.add(2)",
    "let n: integer[]? = hide([1])\nn.sort()",
    "let n: integer[]? = hide([1])\nn.reverse()",
    // Also a value that the changed place is part of.
    "let n: object? = hide({ toys: [1] })\nn.toys.add(2)",
    "let n: object? = hide({ toys: [1] })\n(n).toys.add(2)",
    'let n: object? = hide({ toy: { name: "a" } })\nn.toy.name = "b"',
    "let n: integer[][]? = hide([[1]])\nn[0][0] = 3",
    'let n = null\nlet x = true\nif x {\n    n = playAudio async "a.mp3"\n}\nn.stop()',
  ])
    assert.deepEqual(messages(source), [check(source.includes("p.name") ? "p" : "n")], source);
  // A read still gets a fallback, also the index of an element that is set.
  assert.deepEqual(
    messages(
      "let n: object? = hide({ toys: [1] })\nsay n.toys\nlet i: integer? = hide(0)\nlet toys = [1]\ntoys[i] = 2",
    ),
    [check("n", "..."), check("i", "0")],
  );
});

test("a fallback that asks waits only for a null value, also across a checkpoint and restore", () => {
  const source = (nickname: string) =>
    `${HIDE}let nickname: string? = hide(${nickname})
let name = nickname otherwise askText "Name?"
say "Hi \${name}"
exit`;
  assert.deepEqual(sayTexts(source('"Bo"')), ["Hi Bo"]);

  const plan = compileValidPlan(source("null"));
  const answer = (snapshot: RuntimeSnapshot, plan: InstructionPlan) => {
    const action = snapshot.foregroundAction;
    assert.ok(action?.kind === "interaction");
    const completed = completeAction(plan, snapshot, {
      actionId: action.actionId,
      actionKind: "interaction",
      interactionKind: action.interactionKind,
      payload: { kind: "submittedText", submittedText: "Alex" },
    });
    assert.equal(completed.outcome.kind, "completed");
    const finished = run(plan, completed.snapshot);
    assert.equal(finished.snapshot.status, "halted");
    return [...completed.events, ...finished.events];
  };
  const asking = run(plan, createImmediatePacingRuntimeSnapshot(plan));
  assert.equal(asking.snapshot.foregroundAction?.kind, "interaction");
  const uninterrupted = answer(asking.snapshot, plan);
  const restored = deserializeCheckpoint(
    serializeCheckpoint(createCheckpoint(plan, asking.snapshot)),
  );
  assert.deepEqual(restored.snapshot, asking.snapshot);
  const resumed = answer(restored.snapshot, restored.plan);
  assert.deepEqual(resumed, uninterrupted);
  assert.deepEqual(said([...asking.events, ...resumed]), ["Name?", "Hi Alex"]);
});

test("a fallback that runs as instructions resumes at every boundary", () => {
  for (const missing of ["null", "2"])
    assertRuntimeResumeEquivalent(
      `${HIDE}function twice(n) {
    return n * 2
}
let count: integer? = hide(${missing})
let result = count otherwise twice(4)
say result
exit`,
    );
});

test("&&, ||, !, and ?? each give one error that names the word, and parsing goes on with the word", () => {
  const symbol = (word: string, written: string, example: string) => [
    "error",
    "TSP037",
    `TeaseScript writes '${word}' instead of '${written}': ${example}`,
    written,
  ];
  const and = symbol("and", "&&", "if a and b { ... }");
  const or = symbol("or", "||", "if a or b { ... }");
  const not = symbol("not", "!", "if not a { ... }");
  const otherwise = symbol("otherwise", "??", 'let name = nickname otherwise "pet"');
  for (const [source, expected] of [
    ['let a = true\nlet b = false\nif a && b { say "x" }\nexit', [and]],
    ['let a = true\nif a || false { say "x" }\nexit', [or]],
    ['let a = true\nif !a { say "x" }\nexit', [not]],
    [`${HIDE}let a: integer? = hide(null)\nlet b = a ?? 0\nexit`, [otherwise]],
    // Beside arithmetic, a sign, or a range, `??` needs parentheses too, which its one error leaves for later.
    [
      `${HIDE}let a: integer? = hide(null)\nsay a ?? 0 + 1\nsay -a ?? 0\nsay a ?? 1..=3\nsay a ??\n    0 * 2\nexit`,
      [otherwise, otherwise, otherwise, otherwise],
    ],
    // In an interpolation, a quote after the symbol starts a string, as after the word.
    [
      `${HIDE}let a: string? = hide(null)\nsay "\${a ?? "pet"} \${a || "x"} \${a && "y"} \${!a}"\nexit`,
      [otherwise, or, and, not],
    ],
    // `!=` stays the comparison, and `?` stays the optional type next to `??`.
    [
      `${HIDE}let a: string? = hide(null)\nlet b: string? = a ?? "x"\nsay a != b\nexit`,
      [otherwise],
    ],
    // Wherever the word may stand: a command's operand, a negated type test, and a line continued after the symbol.
    ["let answer = askText !true\nsay !answer\nexit", [not, not]],
    ['let value = 1\nif value is !string { say "whole" }\nexit', [not]],
    [
      'let value: integer | string = 1\nswitch value {\n    case is !string { say "whole" }\n    default { say "text" }\n}\nexit',
      [not],
    ],
    [
      'playAudio "song.mp3" {\n    at null ??\n        1 s { say "cue" }\n    at 1 s &&\n        2 s { say "cue" }\n}\nexit',
      [otherwise, and],
    ],
  ] as const)
    assert.deepEqual(diagnostics(source), expected, source);
});

test("a value the compiler knows is never null gets TSV062, which names the fallback to remove", () => {
  const unused = (subject: string, fix: string, plural = false) =>
    `${subject} is never null here, so ${plural ? "the fallbacks after 'otherwise' are" : "the fallback after 'otherwise' is"} never used. ${fix}`;
  assert.deepEqual(diagnostics("let count = 5\nsay count otherwise 0\nexit"), [
    ["warning", "TSV062", unused("'count'", "Remove 'otherwise 0'."), "otherwise 0"],
  ]);
  // A value narrowed by a check counts as not null.
  assert.deepEqual(
    diagnostics(
      'let pos = "a/b".lastIndexOf("/")\nif pos != null {\n    say pos otherwise 0\n}\nexit',
    ),
    [["warning", "TSV062", unused("'pos'", "Remove 'otherwise 0'."), "otherwise 0"]],
  );
  // In a chain, the first 'otherwise' whose left side can no longer be null, with every fallback after it.
  assert.deepEqual(
    diagnostics(
      `${HIDE}let nickname: string? = hide(null)\nsay nickname otherwise "pet" otherwise "x" otherwise false\nexit`,
    ),
    [
      [
        "warning",
        "TSV062",
        unused(`'nickname otherwise "pet"'`, `Remove 'otherwise "x" otherwise false'.`, true),
        'otherwise "x" otherwise false',
      ],
    ],
  );
  // A fallback that the message cannot quote is named by its place.
  assert.deepEqual(
    diagnostics('let count = 5\nsay count otherwise "${count} is not a fallback"\nexit')[0]?.[2],
    unused("'count'", "Remove 'otherwise' and the fallback after it."),
  );
  // An element read by index fails instead of giving null, so the warning names get with a default.
  assert.deepEqual(
    diagnostics(
      'let items = [1, 2]\nlet toys = dict{ a: "rope" }\nlet key = "b"\nsay items[5] otherwise 0\nsay toys[key] otherwise "none"\nexit',
    ).map((diagnostic) => diagnostic[2]),
    [
      unused(
        "'items[5]'",
        "Reading a position the list does not have is an error, not null. For a fallback there, write 'items.get(5, default: 0)'.",
      ),
      unused(
        "'toys[key]'",
        `Reading a key the dict does not have is an error, not null. For a fallback there, write 'toys.get(key, default: "none")'.`,
      ),
    ],
  );
});

test("a value that may be null, or whose type the compiler cannot know, gets no TSV062", () => {
  for (const source of [
    `${HIDE}let count: integer? = hide(null)\nsay count otherwise 0`,
    // A parameter without a type, a loaded value without one, and an undecided element.
    "function shown(value) {\n    return value otherwise 0\n}\nsay shown(null)",
    'let key = "lvl"\nsay load(key, default: 1) otherwise 0',
    "let empty = []\nsay empty[0] otherwise 0",
    // A list whose elements may be null.
    "let marks: (integer?)[] = [1, null]\nsay marks[1] otherwise 0",
  ])
    assert.deepEqual(diagnostics(`${source}\nexit`), [], source);
});

test("otherwise is a keyword that cannot name a variable but still names a property", () => {
  assert.deepEqual(
    diagnostics("let otherwise = 1\nexit").map((diagnostic) => diagnostic[1]),
    ["TSV001"],
  );
  assert.deepEqual(sayTexts("let choice = { otherwise: 2 }\nsay choice.otherwise\nexit"), ["2"]);
});
