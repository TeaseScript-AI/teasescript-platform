import assert from "node:assert/strict";
import test from "node:test";

import type { ProjectSourceFile } from "../src/compiler.js";
import {
  compileAndRunVariants,
  type FlowKnob,
  type FlowLockAnswer,
  type FlowRun,
} from "./helpers/flow-differential.js";

/*
 * The flow check of speaker properties against the runtime (V30 §37): for small scripts that store a property on some
 * ways and read it once, every way is run. Where the check reports the read, a run must fail there with TSR017; where
 * it accepts a custom property's read, no run may fail there. A built-in field is checked by the weaker rule, "no way
 * gives it", so where the check accepts its read, some run must read it, unless a case says that only a way it cannot
 * tell apart from the failing one gives it. A recursion counts as
 * assigning everything, so the cases with one only check that the read is accepted.
 *
 * The cases cover the constructs that order what runs: branches and switches, loops, labels and gotos, functions and
 * their defaults, the lazy operators and the `default:` of a `load` or a call, the parts of an ask, a say, a named
 * timer, timer blocks and the helpers they call, permanent buttons, waits, lock calls and their dialogs, and other
 * statements between a store and a read, compound assignment, exits, a fallback, and other files. A construct whose order the check gets wrong fails here. An
 * instruction kind without a case here is caught only by the type check of the plan helpers (`satisfies never`), so a
 * new kind that can stand between a store and a read needs a case.
 */

/** What a case stores and reads: a custom property, which every way must assign, or a built-in field. */
interface Kind {
  readonly head: string;
  readonly set: string;
  readonly expr: string;
  readonly rule: "every" | "some";
  /** The function `give`, which stores and returns `returns`. */
  readonly give: (returns: string) => string[];
}

interface Template {
  readonly name: string;
  /** The lines of `main.tease` after the speaker's declaration; the line of the read ends with `// READ`. */
  readonly main: (kind: Kind) => string[];
  readonly others?: (kind: Kind) => Record<string, string[]>;
  /** The knobs `k1`.. the script loads, `true` when present; a case may store another value. */
  readonly knobs?: readonly (SerializableKnob | undefined)[];
  /** The read is a part of an ask, where the run waits: reaching the ask means the read went well. */
  readonly ask?: boolean;
  /** For a built-in field: the check accepts the read for a way it cannot tell apart from one every run fails on. */
  readonly fieldMayFail?: boolean;
  /** The read is the right side of a lazy operator: a run that skips it says "after" without reading. */
  readonly skips?: boolean;
  /**
   * The check accepts the read by policy, since a recursion counts as assigning everything, so a run may fail at the
   * read: only the acceptance is checked.
   */
  readonly conservative?: boolean;
  /** The kinds the case fits; both by default. */
  readonly kinds?: readonly ("custom" | "field")[];
  /** A case about one property of its own, such as a duration or a number. */
  readonly custom?: Pick<Kind, "set" | "expr">;
  /** How the Player answers the case's lock steps; without it a run stops at the first. */
  readonly lock?: FlowLockAnswer;
}

type SerializableKnob = FlowKnob["value"];

const KNOB = (index: number): string => `let k${index} = load "k${index}", default: false`;

/** The one lock of the lock cases, which a written password opens. */
const LOCK = "bG9jaw==";

/**
 * A Player that locks into {@link LOCK} and opens it with a password or key, written or typed in a password field, or
 * else asks in its dialog, which is cancelled.
 */
const LOCKS: FlowLockAnswer = (action) => {
  if (action.phase === "ask")
    return action.passwordField === null ? { kind: "cancelled" } : { kind: "submitted" };
  if (action.call === "encryptText") return { kind: "locked", text: LOCK };
  return action.password !== null || action.key !== null || action.dialogActionId !== null
    ? { kind: "opened", text: "inside" }
    : { kind: "ask" };
};

const give =
  (set: string) =>
  (returns: string): string[] => ["function give {", `    ${set}`, `    return ${returns}`, "}"];

const KINDS: Record<"custom" | "field", Kind> = {
  custom: {
    head: 'speaker vera {\n    firstName: "Vera"\n}',
    set: 'vera.mood = "calm"',
    expr: "vera.mood",
    rule: "every",
    give: give('vera.mood = "calm"'),
  },
  field: {
    head: "",
    set: 'player.firstName = "Sam"',
    expr: "player.firstName",
    rule: "some",
    give: give('player.firstName = "Sam"'),
  },
};

const TEMPLATES: readonly Template[] = [
  { name: "a read before the store", main: (k) => [`say ${k.expr} // READ`, k.set] },
  { name: "a store before the read", main: (k) => [k.set, `say ${k.expr} // READ`] },
  {
    name: "an if without else",
    knobs: [undefined],
    main: (k) => [KNOB(1), `if k1 { ${k.set} }`, `say ${k.expr} // READ`],
  },
  {
    name: "an if and its else that both store",
    knobs: [undefined],
    main: (k) => [KNOB(1), "if k1 {", k.set, "} else {", k.set, "}", `say ${k.expr} // READ`],
  },
  {
    name: "only the else stores",
    knobs: [undefined],
    main: (k) => [KNOB(1), 'if k1 { say "no" } else {', k.set, "}", `say ${k.expr} // READ`],
  },
  {
    name: "an else if chain",
    knobs: [undefined, undefined],
    main: (k) => [
      KNOB(1),
      KNOB(2),
      `if k1 { ${k.set} } else if k2 { ${k.set} } else { say "no" }`,
      `say ${k.expr} // READ`,
    ],
  },
  {
    name: "an if that is always false",
    main: (k) => [`if false { ${k.set} }`, `say ${k.expr} // READ`],
  },
  {
    name: "an if that is always true",
    main: (k) => [`if true { ${k.set} }`, `say ${k.expr} // READ`],
  },
  {
    name: "a switch over a boolean that lists both values",
    knobs: [undefined],
    main: (k) => [
      KNOB(1),
      "switch k1 {",
      `    case true { ${k.set} }`,
      `    case false { ${k.set} }`,
      "}",
      `say ${k.expr} // READ`,
    ],
  },
  {
    name: "a switch that misses a value",
    knobs: [undefined],
    main: (k) => [
      KNOB(1),
      "switch k1 {",
      `    case true { ${k.set} }`,
      "}",
      `say ${k.expr} // READ`,
    ],
  },
  {
    name: "a switch whose default stores",
    knobs: [undefined],
    main: (k) => [
      KNOB(1),
      "switch k1 {",
      '    case true { say "t" }',
      `    default { ${k.set} }`,
      "}",
      `say ${k.expr} // READ`,
    ],
  },
  {
    name: "a while loop",
    knobs: [undefined],
    main: (k) => [KNOB(1), "while k1 {", k.set, "    k1 = false", "}", `say ${k.expr} // READ`],
  },
  {
    name: "a while true left by break",
    main: (k) => ["while true {", k.set, "    break", "}", `say ${k.expr} // READ`],
  },
  {
    name: "a repeat of a count",
    knobs: [undefined],
    main: (k) => [
      KNOB(1),
      "let times = 0",
      "if k1 { times = 2 }",
      `repeat times { ${k.set} }`,
      `say ${k.expr} // READ`,
    ],
  },
  { name: "a repeat of 2", main: (k) => [`repeat 2 { ${k.set} }`, `say ${k.expr} // READ`] },
  { name: "a repeat of 0", main: (k) => [`repeat 0 { ${k.set} }`, `say ${k.expr} // READ`] },
  {
    name: "a for over a list",
    knobs: [undefined],
    main: (k) => [
      KNOB(1),
      "let items: number[] = []",
      "if k1 { items = [1] }",
      `for item in items { ${k.set} }`,
      `say ${k.expr} // READ`,
    ],
  },
  {
    name: "a for over a literal list",
    main: (k) => [`for item in [1, 2] { ${k.set} }`, `say ${k.expr} // READ`],
  },
  {
    name: "a read on the first run of a loop",
    fieldMayFail: true,
    main: (k) => ["repeat 2 {", `    say ${k.expr} // READ`, k.set, "}"],
  },
  {
    name: "a break before the store",
    knobs: [undefined],
    main: (k) => [
      KNOB(1),
      "repeat 2 {",
      "    if k1 { break }",
      k.set,
      "}",
      `say ${k.expr} // READ`,
    ],
  },
  {
    name: "a label the script runs into",
    knobs: [undefined],
    fieldMayFail: true,
    main: (k) => [
      KNOB(1),
      "label again",
      `say ${k.expr} // READ`,
      k.set,
      "if k1 {",
      "    k1 = false",
      "    goto again",
      "}",
    ],
  },
  {
    name: "a goto past the store",
    knobs: [undefined],
    main: (k) => [KNOB(1), "if k1 { goto skip }", k.set, "label skip", `say ${k.expr} // READ`],
  },
  {
    name: "a function that stores",
    main: (k) => ["function f {", k.set, "}", "f()", `say ${k.expr} // READ`],
  },
  {
    name: "a function that stores on some ways",
    knobs: [undefined],
    main: (k) => [
      KNOB(1),
      "function f {",
      `    if k1 { ${k.set} }`,
      "}",
      "f()",
      `say ${k.expr} // READ`,
    ],
  },
  {
    name: "a function called before and after the store",
    fieldMayFail: true,
    main: (k) => ["function f {", `    say ${k.expr} // READ`, "}", "f()", k.set, "f()"],
  },
  {
    name: "an omitted default that stores",
    main: (k) => [
      ...k.give("1"),
      "function f(x = give()) {",
      `    say ${k.expr} // READ`,
      "}",
      "f()",
    ],
  },
  {
    name: "a supplied argument whose default would store",
    main: (k) => [
      ...k.give("1"),
      "function f(x = give()) {",
      `    say ${k.expr} // READ`,
      "}",
      "f(1)",
    ],
  },
  {
    name: "a default that stores for the next default",
    main: (k) => [
      ...k.give("1"),
      `function f(a = give(), b = ${k.expr}) { // READ`,
      "    say b",
      "}",
      "f()",
    ],
  },
  {
    name: "a default read before the default that stores",
    main: (k) => [
      ...k.give("1"),
      `function f(a = ${k.expr}, b = give()) { // READ`,
      "    say b",
      "}",
      "f()",
    ],
  },
  {
    name: "a default that ends the session",
    main: (k) => [
      "function stop {",
      "    exit",
      "}",
      "function f(x = stop()) {",
      `    say ${k.expr} // READ`,
      "}",
      "f()",
      k.set,
    ],
  },
  {
    name: "a call in the right side of and",
    knobs: [undefined],
    main: (k) => [KNOB(1), ...k.give("true"), "let ok = k1 and give()", `say ${k.expr} // READ`],
  },
  {
    name: "false and a call",
    main: (k) => [...k.give("true"), "let ok = false and give()", `say ${k.expr} // READ`],
  },
  {
    name: "true and a call",
    main: (k) => [...k.give("true"), "let ok = true and give()", `say ${k.expr} // READ`],
  },
  {
    name: "a call in the right side of or",
    knobs: [undefined],
    main: (k) => [KNOB(1), ...k.give("true"), "let ok = k1 or give()", `say ${k.expr} // READ`],
  },
  {
    name: "true or a call",
    main: (k) => [...k.give("true"), "let ok = true or give()", `say ${k.expr} // READ`],
  },
  {
    name: "false or a call",
    main: (k) => [...k.give("true"), "let ok = false or give()", `say ${k.expr} // READ`],
  },
  {
    name: "a call after otherwise",
    knobs: [undefined],
    main: (k) => [
      KNOB(1),
      ...k.give('"given"'),
      "let maybe: string | null = null",
      'if k1 { maybe = "x" }',
      "let v = maybe otherwise give()",
      `say ${k.expr} // READ`,
    ],
  },
  {
    name: "a value that is never null before otherwise",
    main: (k) => [
      ...k.give('"given"'),
      'let v = "ready" otherwise give()',
      `say ${k.expr} // READ`,
    ],
  },
  {
    name: "a call in the default of a load",
    knobs: ["stored"],
    main: (k) => [
      ...k.give('"given"'),
      'let v = load "k1", default: give()',
      `say ${k.expr} // READ`,
    ],
  },
  {
    name: "a call in the default of a get",
    knobs: [undefined],
    main: (k) => [
      KNOB(1),
      ...k.give('"given"'),
      "let names: string[] = []",
      'if k1 { names.add("a") }',
      "let v = names.get(0, default: give())",
      `say ${k.expr} // READ`,
    ],
  },
  {
    name: "a call in the default of a conversion",
    knobs: ["5"],
    main: (k) => [
      ...k.give("0"),
      'let text = load "k1", default: "x"',
      "let v = toNumber(text, default: give())",
      `say ${k.expr} // READ`,
    ],
  },
  {
    name: "a call in the default of fromJson",
    knobs: ["1"],
    main: (k) => [
      ...k.give("0"),
      'let text = load "k1", default: "x"',
      "let v = fromJson(text, default: give())",
      `say ${k.expr} // READ`,
    ],
  },
  {
    name: "a store before a lock call",
    lock: LOCKS,
    main: (k) => [
      k.set,
      'let locked = encryptText("x", password: "p", publicKey: false, timeLock: false)',
      `say ${k.expr} // READ`,
    ],
  },
  {
    name: "a store after a lock call",
    lock: LOCKS,
    main: (k) => [
      `let opened = decryptText("${LOCK}", password: "p", default: null)`,
      k.set,
      `say ${k.expr} // READ`,
    ],
  },
  {
    name: "a call in the default of decryptText, which runs only when the lock does not open",
    knobs: [LOCK],
    lock: LOCKS,
    main: (k) => [
      ...k.give("null"),
      'let text = load "k1", default: "x"',
      'let opened = decryptText(text, password: "p", default: give())',
      `say ${k.expr} // READ`,
    ],
  },
  {
    name: "a timer block that stores during a lock dialog",
    lock: LOCKS,
    main: (k) => [
      `timer async 1 ms { ${k.set} }`,
      `let opened = decryptText("${LOCK}", default: null)`,
      `say ${k.expr} // READ`,
    ],
  },
  {
    name: "a timer block that stores during a lock call's password field",
    lock: LOCKS,
    main: (k) => [
      `timer async 1 ms { ${k.set} }`,
      `let opened = decryptText("${LOCK}", password: askPassword("Password"), default: null)`,
      `say ${k.expr} // READ`,
    ],
  },
  {
    name: "a read in the default of a get",
    knobs: [undefined],
    skips: true,
    main: (k) => [
      KNOB(1),
      "let names: string[] = []",
      'if k1 { names.add("a") }',
      `let v = names.get(0, default: ${k.expr}) // READ`,
      k.set,
    ],
  },
  {
    name: "a read in the right side of and",
    knobs: [undefined],
    skips: true,
    main: (k) => [KNOB(1), `let same = k1 and ${k.expr} == "x" // READ`, k.set],
  },
  {
    name: "a read after false and",
    skips: true,
    main: (k) => [`let same = false and ${k.expr} == "x" // READ`, k.set],
  },
  {
    name: "askText with prefill then hint",
    ask: true,
    main: (k) => [
      ...k.give('"p"'),
      `let a = askText "Q?", prefill: give(), hint: ${k.expr} // READ`,
    ],
  },
  {
    name: "askText with hint then prefill",
    ask: true,
    main: (k) => [
      ...k.give('"p"'),
      `let a = askText "Q?", hint: ${k.expr}, prefill: give() // READ`,
    ],
  },
  {
    name: "askNumber with prefill then hint",
    ask: true,
    main: (k) => [
      ...k.give("1"),
      `let a = askNumber "Q?", prefill: give(), hint: ${k.expr} // READ`,
    ],
  },
  {
    name: "askPassword with a call in its question then a read in its hint",
    ask: true,
    main: (k) => [...k.give('"Q?"'), `let a = askPassword give(), hint: ${k.expr} // READ`],
  },
  {
    name: "a lock call's password field with a call in its question then a read in its hint",
    ask: true,
    main: (k) => [
      ...k.give('"Q?"'),
      `let o = decryptText("${LOCK}", password: askPassword(give(), hint: ${k.expr}), default: null) // READ`,
    ],
  },
  {
    name: "askChoice with its buttons then the prefill",
    ask: true,
    main: (k) => [...k.give('"a"'), `let c = askChoice give(), "b", prefill: ${k.expr} // READ`],
  },
  {
    name: "askChoice with a button read before a button call",
    ask: true,
    main: (k) => [...k.give('"a"'), `let c = askChoice ${k.expr}, give() // READ`],
  },
  {
    name: "a say with a call before the read",
    main: (k) => [...k.give('"g"'), `say "\${give()} \${${k.expr}}" // READ`],
  },
  {
    name: "a say with the read before a call",
    main: (k) => [...k.give('"g"'), `say "\${${k.expr}} \${give()}" // READ`],
  },
  {
    name: "a timer with its label before its duration",
    kinds: ["custom"],
    custom: { set: "vera.delay = 1 ms", expr: "vera.delay" },
    main: (k) => [
      ...k.give('"L"'),
      `timer(label: give(), duration: ${k.expr}, async: true) // READ`,
    ],
  },
  {
    name: "a timer with its duration before its label",
    kinds: ["custom"],
    custom: { set: "vera.delay = 1 ms", expr: "vera.delay" },
    main: (k) => [
      ...k.give('"L"'),
      `timer(duration: ${k.expr}, label: give(), async: true) // READ`,
    ],
  },
  {
    name: "a compound assignment that reads before its call",
    kinds: ["custom"],
    custom: { set: "vera.count = 1", expr: "vera.count" },
    main: (k) => [...k.give("1"), `${k.expr} += give() // READ`],
  },
  {
    name: "a timer block that stores before a wait",
    main: (k) => [`timer async 1 ms { ${k.set} }`, "wait 2 ms", `say ${k.expr} // READ`],
  },
  {
    name: "a timer block that calls a helper which stores and ends the session",
    main: (k) => [
      "function give {",
      k.set,
      "    exit",
      "}",
      "timer async 1 ms { give() }",
      "wait 2 ms",
      `say ${k.expr} // READ`,
    ],
  },
  {
    name: "a timer block that calls a helper which stores and goes to a label",
    main: (k) => [
      "function give {",
      k.set,
      "    goto ready",
      "}",
      "timer async 1 ms { give() }",
      "wait 2 ms",
      "label ready",
      `say ${k.expr} // READ`,
    ],
  },
  {
    name: "a permanent button between the store and the read",
    main: (k) => [
      k.set,
      'showPermanentButton "Go" {',
      '    say "pressed"',
      "}",
      `say ${k.expr} // READ`,
    ],
  },
  {
    name: "a permanent button before a read that comes too early",
    main: (k) => [
      'showPermanentButton "Go" {',
      '    say "pressed"',
      "}",
      `say ${k.expr} // READ`,
      k.set,
    ],
  },
  {
    name: "statements between the store and the read",
    main: (k) => [k.set, "stopAudio", "wait 1 ms", `say ${k.expr} // READ`],
  },
  {
    name: "more statements between the store and the read",
    kinds: ["custom"],
    main: (k) => [
      k.set,
      "hideImage",
      "hideCamera",
      "speaker vera",
      "player.copyFrom(account)",
      `say ${k.expr} // READ`,
    ],
  },
  {
    name: "an image statement before a read that comes too early",
    main: (k) => ["hideImage", `say ${k.expr} // READ`, k.set],
  },
  {
    name: "a call with a call for an argument",
    main: (k) => [
      ...k.give("1"),
      "function f(n: number) {",
      "    say n",
      "}",
      "f(give())",
      `say ${k.expr} // READ`,
    ],
  },
  {
    name: "a wait before a read that comes too early",
    main: (k) => ["wait 1 ms", `say ${k.expr} // READ`, k.set],
  },
  {
    name: "a fallback that an end continues at after the store",
    main: (k) => ['fallback "room.tease"', k.set, "end"],
    others: (k) => ({ "room.tease": [`say ${k.expr} // READ`] }),
  },
  {
    name: "an exit on a branch",
    knobs: [undefined],
    main: (k) => [KNOB(1), "if k1 {", k.set, "    exit", "}", `say ${k.expr} // READ`],
  },
  {
    name: "a goto to a file after the store",
    main: (k) => [k.set, 'goto "room.tease"'],
    others: (k) => ({ "room.tease": [`say ${k.expr} // READ`] }),
  },
  {
    name: "a goto to a file before the store",
    knobs: [undefined],
    main: (k) => [KNOB(1), 'if k1 { goto "room.tease" }', k.set, 'goto "room.tease"'],
    others: (k) => ({ "room.tease": [`say ${k.expr} // READ`] }),
  },
  {
    name: "a call of a file that stores",
    main: (k) => ['call "setup.tease"', `say ${k.expr} // READ`],
    others: (k) => ({ "setup.tease": [k.set, "end"] }),
  },
  {
    name: "a file that calls itself once more before the store",
    main: (k) => ["global visited = false", 'call "setup.tease"', `say ${k.expr} // READ`],
    others: (k) => ({
      "setup.tease": [
        "if not visited {",
        "    visited = true",
        '    call "setup.tease"',
        "}",
        k.set,
        "end",
      ],
    }),
  },
  {
    name: "a called file that goes on to a computed file which stores",
    main: (k) => ['global target = "inner.tease"', 'call "hall.tease"', `say ${k.expr} // READ`],
    others: (k) => ({ "hall.tease": ["goto script(target)"], "inner.tease": [k.set, "end"] }),
  },
  {
    name: "a function that calls a file whose store follows a call that never returns",
    knobs: [undefined],
    main: (k) => [
      "function start {",
      '    call "setup.tease"',
      "}",
      "start()",
      `say ${k.expr} // READ`,
    ],
    others: (k) => ({
      "setup.tease": [
        "function stop { exit }",
        KNOB(1),
        "if k1 {",
        "    stop()",
        k.set,
        "}",
        "end",
      ],
    }),
  },
  {
    name: "a recursive function that calls a file whose store follows a call that never returns",
    knobs: [undefined, undefined],
    conservative: true,
    main: (k) => [
      KNOB(1),
      "function start {",
      "    if k1 {",
      "        k1 = false",
      "        start()",
      "    }",
      '    call "setup.tease"',
      "}",
      "start()",
      `say ${k.expr} // READ`,
    ],
    others: (k) => ({
      "setup.tease": [
        "function stop { exit }",
        KNOB(2),
        "if k2 {",
        "    stop()",
        k.set,
        "}",
        "end",
      ],
    }),
  },
  {
    name: "a global function of another file",
    main: (k) => ["greet()", `say ${k.expr} // READ`],
    others: (k) => ({ "room.tease": ["global function greet {", k.set, "}"] }),
  },
  {
    name: "a recursion that stores at its end",
    main: (k) => [
      "function f(n) {",
      "    if n > 0 {",
      "        f(n - 1)",
      "    } else {",
      k.set,
      "    }",
      "}",
      "f(2)",
      `say ${k.expr} // READ`,
    ],
  },
  {
    name: "a recursion whose base case creates a timer block that stores",
    main: (k) => [
      "function fill(n: number) {",
      "    if n > 0 {",
      "        fill(n - 1)",
      "    } else {",
      `        timer async 1 ms { ${k.set} }`,
      "    }",
      "}",
      "fill(1)",
      "wait 2 ms",
      `say ${k.expr} // READ`,
    ],
  },
  {
    name: "a recursion whose base case stores on some ways",
    knobs: [undefined],
    conservative: true,
    main: (k) => [
      KNOB(1),
      "function fill(n: number) {",
      "    if n > 0 {",
      "        fill(n - 1)",
      "    } else {",
      `        if k1 { ${k.set} }`,
      "    }",
      "}",
      "fill(1)",
      `say ${k.expr} // READ`,
    ],
  },
  {
    name: "a nested call that stores on some ways",
    knobs: [undefined],
    main: (k) => [
      KNOB(1),
      "function inner {",
      `    if k1 { ${k.set} }`,
      "}",
      "function outer {",
      "    inner()",
      "}",
      "outer()",
      `say ${k.expr} // READ`,
    ],
  },
];

/** The files of a case, with "after" said once the read went well, and the file and 1-based line of the read. */
function caseFiles(
  template: Template,
  kind: Kind,
): { readonly files: ProjectSourceFile[]; readonly marked: number; readonly readLine: number } {
  const files: ProjectSourceFile[] = [
    {
      path: "main.tease",
      source: [kind.head, ...template.main(kind)].filter((line) => line !== "").join("\n"),
    },
    ...Object.entries(template.others?.(kind) ?? {}).map(([path, lines]) => ({
      path,
      source: lines.join("\n"),
    })),
  ];
  const marked = files.findIndex((file) => file.source.includes("// READ"));
  assert.notEqual(marked, -1, template.name);
  files[marked] = { ...files[marked]!, source: `${files[marked]!.source}\nsay "after"\nexit` };
  const readLine =
    files[marked]!.source.split("\n").findIndex((line) => line.endsWith("// READ")) + 1;
  return { files, marked, readLine };
}

/**
 * The case with its read through a variable, which the check does not follow, so that the runtime can take the way
 * the check names. The variable stands at the top of the read's file, which moves the read down one line.
 */
function throughVariable(
  files: readonly ProjectSourceFile[],
  marked: number,
  kind: Kind,
): ProjectSourceFile[] {
  const dot = kind.expr.indexOf(".");
  const speaker = kind.expr.slice(0, dot);
  const property = kind.expr.slice(dot + 1);
  return files.map((file, index) => {
    if (index !== marked) return file;
    const lines = file.source.split("\n");
    const read = lines.findIndex((line) => line.endsWith("// READ"));
    lines[read] = lines[read]!.replaceAll(kind.expr, `viaVariable.${property}`);
    const head = index === 0 && kind.head !== "" ? kind.head.split("\n").length : 0;
    lines.splice(head, 0, `let viaVariable = ${speaker}`);
    return { ...file, source: lines.join("\n") };
  });
}

test("the flow check of speaker properties agrees with the runtime on every way through each construct", () => {
  for (const template of TEMPLATES)
    for (const name of template.kinds ?? (["custom", "field"] as const)) {
      const base = KINDS[name];
      const kind: Kind =
        template.custom === undefined || name !== "custom"
          ? base
          : { ...base, ...template.custom, give: give(template.custom.set) };
      const { files, marked, readLine } = caseFiles(template, kind);
      const path = files[marked]!.path;
      const knobs: FlowKnob[] = (template.knobs ?? []).map((value, index) => ({
        key: `k${index + 1}`,
        ...(value === undefined ? {} : { value }),
      }));
      const label = `${template.name} (${name})`;
      const failedAtRead =
        (line: number) =>
        (run: FlowRun): boolean =>
          run.failure?.code === "TSR017" && run.failure.path === path && run.failure.line === line;
      const readOk = (run: FlowRun): boolean =>
        template.ask === true
          ? run.status === "waiting" && run.failure === null
          : run.says.includes("after");
      const noOtherFailure = (
        runs: readonly FlowRun[],
        atRead: (run: FlowRun) => boolean,
      ): void => {
        for (const run of runs)
          if (run.failure !== null && !atRead(run))
            assert.fail(
              `${label}: ${run.present.join(",") || "no knobs"} failed with ${run.failure.code} at ${run.failure.path}:${run.failure.line}`,
            );
      };
      const lock = template.lock ?? null;
      const { diagnostics, runs } = compileAndRunVariants(files, knobs, {}, null, lock);
      const errors = diagnostics
        .filter((diagnostic) => diagnostic.severity === "error")
        .map((diagnostic) => [
          diagnostic.code,
          `${diagnostic.path}:${diagnostic.span.start.line + 1}`,
        ]);
      // The check reports the read, or nothing; the project compiles otherwise.
      assert.deepEqual(
        errors,
        errors.length === 0 ? [] : [["TSV043", `${path}:${readLine}`]],
        label,
      );
      if (template.conservative === true) {
        assert.deepEqual(errors, [], label);
        continue;
      }
      if (errors.length > 0) {
        // The runtime takes the way the check names: some run fails at the read, and for a built-in field every run
        // that reaches it.
        const taken = compileAndRunVariants(
          throughVariable(files, marked, kind),
          knobs,
          {},
          null,
          lock,
        );
        assert.deepEqual(
          taken.diagnostics.filter((diagnostic) => diagnostic.severity === "error"),
          [],
          `${label}: the read through a variable`,
        );
        const atRead = failedAtRead(readLine + 1);
        noOtherFailure(taken.runs, atRead);
        assert.ok(taken.runs.some(atRead), `${label}: reported, but no run fails at the read`);
        if (kind.rule === "some" && template.skips !== true)
          assert.deepEqual(
            taken.runs.filter(readOk).map((run) => run.present),
            [],
            `${label}: reported, but a run reads the field`,
          );
        continue;
      }
      assert.notEqual(runs.length, 0, label);
      const atRead = failedAtRead(readLine);
      noOtherFailure(runs, atRead);
      if (kind.rule === "every")
        assert.deepEqual(
          runs.filter(atRead).map((run) => run.present),
          [],
          `${label}: accepted, but a run fails at the read`,
        );
      else if (template.fieldMayFail !== true)
        assert.ok(
          runs.some(readOk) || !runs.some(atRead),
          `${label}: accepted, but no run reads it`,
        );
    }
});
