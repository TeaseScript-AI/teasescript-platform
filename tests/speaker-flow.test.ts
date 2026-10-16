import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { compileProject, type ProjectSourceFile } from "../src/compiler.js";
import type { InterpreterEvent } from "../src/runtime/events.js";
import { assertRuntimeResumeEquivalent } from "./helpers/runtime-equivalence.js";

/*
 * A speaker has a property only where a way to the read gave it one (V30 §37): a custom property on every way, a
 * built-in field, term, or name list on some way. What the compiler cannot follow stays a runtime error.
 */

const VERA = 'speaker vera {\n    firstName: "Vera"\n}';

const ACCOUNT = {
  firstName: "Sam",
  gender: "male",
  petNames: ["pup"],
  degradingNames: ["toy"],
  lovingNames: ["dear"],
};

function project(main: string, others: Record<string, string> = {}): ProjectSourceFile[] {
  return [
    { path: "main.tease", source: main },
    ...Object.entries(others).map(([path, source]) => ({ path, source })),
  ];
}

/** The diagnostics of a project as code, file and line, and message. */
function diagnostics(main: string, others: Record<string, string> = {}): string[][] {
  return compileProject(project(main, others)).diagnostics.map((diagnostic) => [
    diagnostic.code,
    `${diagnostic.path}:${diagnostic.span.start.line + 1}`,
    diagnostic.message,
  ]);
}

function outputs(events: readonly InterpreterEvent[]): string[] {
  return events.flatMap((event) =>
    event.kind === "say"
      ? [event.text]
      : event.kind === "runtimeFailure"
        ? [`failure ${event.code}`]
        : [],
  );
}

const START = (name: string): string =>
  `give it a start value, as in 'speaker vera { ${name}: ... }'`;

test("reading a custom property before anything assigns it is a compile error", () => {
  const early = (line: string, name = "mood"): string =>
    `Speaker 'vera' has no '${name}' yet here: nothing assigns it before this line runs. ${line} assigns it, but only later. Give it a start value, as in 'speaker vera { ${name}: ... }', or assign it before this line.`;
  assert.deepEqual(diagnostics(`${VERA}\nsay vera.mood\nvera.mood = "calm"\nexit`), [
    ["TSV043", "main.tease:4", early("Line 5")],
  ]);
  // As `speaker` where `as` names the speaker, by `+=`, and in a start value, which the session sets up first.
  assert.deepEqual(
    diagnostics(`${VERA}\nsay as vera "I am \${speaker.mood}."\nvera.mood = "calm"\nexit`),
    [["TSV043", "main.tease:4", early("Line 5")]],
  );
  assert.deepEqual(diagnostics(`${VERA}\nvera.count += 1\nvera.count = 0\nexit`), [
    ["TSV043", "main.tease:4", early("Line 5", "count")],
  ]);
  assert.deepEqual(
    diagnostics(`${VERA}\nglobal greeting = vera.mood\nvera.mood = "calm"\nsay greeting\nexit`),
    [["TSV043", "main.tease:4", early("Line 5")]],
  );
  // A start value of another file runs before main.tease, and a `load` default runs when the key is missing.
  assert.deepEqual(
    diagnostics(`${VERA}\nvera.mood = "calm"\nexit`, {
      "room.tease": "global greeting = vera.mood",
    }),
    [
      [
        "TSV043",
        "room.tease:1",
        "Speaker 'vera' has no 'mood' yet here: nothing assigns it before this line runs. Line 4 of 'main.tease' assigns it, but only later. Give it a start value, as in 'speaker vera { mood: ... }', or assign it before this line.",
      ],
    ],
  );
  assert.deepEqual(
    diagnostics(
      `${VERA}\nlet name = load "name", default: vera.mood\nvera.mood = "calm"\nsay name\nexit`,
    ),
    [["TSV043", "main.tease:4", early("Line 5")]],
  );
  // A file that a later `call` runs assigns it too late.
  assert.deepEqual(
    diagnostics(`${VERA}\nsay vera.mood\ncall "setup.tease"\nexit`, {
      "setup.tease": 'vera.mood = "calm"\nend',
    }),
    [["TSV043", "main.tease:4", early("Line 1 of 'setup.tease'")]],
  );
  // An assignment that no way runs gives nothing.
  assert.deepEqual(
    diagnostics(`${VERA}\nfunction later {\n    vera.mood = "calm"\n}\nsay vera.mood\nexit`),
    [
      [
        "TSV043",
        "main.tease:7",
        "Speaker 'vera' has no 'mood' yet here: nothing assigns it before this line runs. Line 5 assigns it, but that line never runs. Give it a start value, as in 'speaker vera { mood: ... }', or assign it before this line.",
      ],
    ],
  );
  // The player has no declaration to give it a start value.
  assert.deepEqual(diagnostics("say player.points\nplayer.points = 0\nexit"), [
    [
      "TSV043",
      "main.tease:1",
      "Speaker 'player' has no 'points' yet here: nothing assigns it before this line runs. Line 2 assigns it, but only later. Assign it before this line, as in 'player.points = ...'.",
    ],
  ]);
});

test("a custom property that only some ways assign is a compile error that names a way without it", () => {
  const some = (way: string, fix: string, name = "mood"): string =>
    `Speaker 'vera' may have no '${name}' here: ${way}, nothing assigns it before this line. Assign it ${fix}, or ${START(name)}.`;
  const cases: [string, string, Record<string, string>, string[]][] = [
    [
      "if without else",
      'if chance(0.5) { vera.mood = "calm" }\nsay vera.mood',
      {},
      [
        "main.tease:5",
        some("when the 'if' on line 4 is false", "on that way too, as in an 'else'"),
      ],
    ],
    [
      "only the else assigns",
      'if chance(0.5) {\n    say "no"\n} else {\n    vera.mood = "calm"\n}\nsay vera.mood',
      {},
      ["main.tease:9", some("when the 'if' on line 4 is true", "on that way too")],
    ],
    [
      "only the then assigns",
      'if chance(0.5) {\n    vera.mood = "calm"\n} else {\n    say "no"\n}\nsay vera.mood',
      {},
      ["main.tease:9", some("through the 'else' of the 'if' on line 4", "on that way too")],
    ],
    [
      "a case without it",
      'switch randomInteger(1..3) {\n    case 1 { vera.mood = "calm" }\n    case 2 { say "two" }\n    default { vera.mood = "calm" }\n}\nsay vera.mood',
      {},
      ["main.tease:9", some("through the 'case' on line 6", "on that way too")],
    ],
    [
      "no case matches",
      'switch randomInteger(1..3) {\n    case 1 { vera.mood = "calm" }\n    case 2 { vera.mood = "calm" }\n}\nsay vera.mood',
      {},
      [
        "main.tease:8",
        some(
          "when no 'case' of the 'switch' on line 4 matches",
          "on that way too, as in a 'default'",
        ),
      ],
    ],
    [
      "cases that miss a button value",
      'let pick = askChoice "a", "b", "c"\nswitch pick {\n    case "a" { vera.mood = "calm" }\n    case "b" { vera.mood = "calm" }\n}\nsay vera.mood',
      {},
      [
        "main.tease:9",
        some(
          "when no 'case' of the 'switch' on line 5 matches",
          "on that way too, as in a 'default'",
        ),
      ],
    ],
    [
      "the default without it",
      'switch randomInteger(1..3) {\n    case 1 { vera.mood = "calm" }\n    default { say "other" }\n}\nsay vera.mood',
      {},
      ["main.tease:8", some("through the 'default' on line 6", "on that way too")],
    ],
    [
      "a repeat that may not run",
      'let times = randomInteger(0..2)\nrepeat times { vera.mood = "calm" }\nsay vera.mood',
      {},
      ["main.tease:6", some("when the loop on line 5 does not run", "before the loop")],
    ],
    [
      "a for loop over a list that may be empty",
      'let items = [1]\nfor item in items { vera.mood = "calm" }\nsay vera.mood',
      {},
      ["main.tease:6", some("when the loop on line 5 does not run", "before the loop")],
    ],
    [
      "a while loop",
      'while chance(0.5) { vera.mood = "calm" }\nsay vera.mood',
      {},
      ["main.tease:5", some("when the loop on line 4 does not run", "before the loop")],
    ],
    [
      "the first run of a loop",
      'repeat 2 {\n    say vera.mood\n    vera.mood = "calm"\n}',
      {},
      ["main.tease:5", some("on the first run of the loop on line 4", "before the loop")],
    ],
    [
      "a label that the script runs into",
      'label again\nsay vera.mood\nvera.mood = "calm"\nif chance(0.5) { goto again }',
      {},
      [
        "main.tease:5",
        some(
          "when the script runs into 'label again' from the line before it",
          "before 'label again'",
        ),
      ],
    ],
    [
      "a goto past the assignment",
      'if chance(0.5) { goto skip }\nvera.mood = "calm"\nlabel skip\nsay vera.mood',
      {},
      ["main.tease:7", some("after the 'goto' on line 4", "before that 'goto'")],
    ],
    [
      "a goto from another file",
      'if chance(0.5) { goto "room.tease" }\nvera.mood = "calm"\ngoto "room.tease"',
      { "room.tease": "say vera.mood\nexit" },
      ["room.tease:1", some("after the 'goto' on line 4 of 'main.tease'", "before that 'goto'")],
    ],
    [
      "a call of another file",
      'if chance(0.5) { call "room.tease" }\nvera.mood = "calm"\ncall "room.tease"',
      { "room.tease": "say vera.mood\nend" },
      ["room.tease:1", some("through the 'call' on line 4 of 'main.tease'", "before that 'call'")],
    ],
    [
      "a function called before the assignment",
      'function show {\n    say vera.mood\n}\nshow()\nvera.mood = "calm"\nshow()',
      {},
      ["main.tease:5", some("when line 7 calls 'show'", "before that call")],
    ],
  ];
  for (const [name, body, others, expected] of cases) {
    const main = `${VERA}\n${body}\nexit`;
    assert.deepEqual(diagnostics(main, others), [["TSV043", ...expected]], name);
  }
  // A call counts for what every way through the function assigns.
  assert.deepEqual(
    diagnostics(
      `${VERA}\nfunction maybe {\n    if chance(0.5) { vera.mood = "calm" }\n}\nmaybe()\nsay vera.mood\nexit`,
    ),
    [
      [
        "TSV043",
        "main.tease:8",
        `Speaker 'vera' may have no 'mood' here: line 7 calls 'maybe', which assigns it on only some of its ways. Assign it on every way through 'maybe', or ${START("mood")}.`,
      ],
    ],
  );
  // The right side of `and` runs only on some ways.
  assert.deepEqual(
    diagnostics(
      `${VERA}\nfunction give {\n    vera.mood = "calm"\n    return true\n}\nlet given = chance(0.5) and give()\nsay vera.mood\nexit`,
    ),
    [
      [
        "TSV043",
        "main.tease:9",
        `Speaker 'vera' may have no 'mood' here: when the right side of the 'and' on line 8 does not run, nothing assigns it before this line. Assign it on every way to this line, or ${START("mood")}.`,
      ],
    ],
  );
  assert.deepEqual(diagnostics("if chance(0.5) { player.points = 1 }\nsay player.points\nexit"), [
    [
      "TSV043",
      "main.tease:2",
      "Speaker 'player' may have no 'points' here: when the 'if' on line 1 is false, nothing assigns it before this line. Assign it on that way too, as in an 'else'.",
    ],
  ]);
});

test("reading a built-in field, term, or name list where no way gave it one is a compile error", () => {
  const copyFix = (field: string): string =>
    `Copy the account before this line, as in 'player.copyFrom(account)' at the start of the script, or assign ${field} first.`;
  assert.deepEqual(diagnostics('say "Hello ${player.firstName}"\nplayer.copyFrom(account)\nexit'), [
    [
      "TSV043",
      "main.tease:1",
      `Speaker 'player' has no 'firstName' yet here: nothing copies the account or assigns 'firstName' before this line runs. The copy on line 2 comes only later. ${copyFix("'player.firstName'")}`,
    ],
  ]);
  // In a function that a call runs before the copy.
  assert.deepEqual(
    diagnostics(
      'function greet {\n    say "Hi ${player.firstName}"\n}\ngreet()\nplayer.copyFrom(account)\nexit',
    ),
    [
      [
        "TSV043",
        "main.tease:2",
        `Speaker 'player' has no 'firstName' yet here: nothing copies the account or assigns 'firstName' before this line runs. The copy on line 5 comes only later. ${copyFix("'player.firstName'")}`,
      ],
    ],
  );
  assert.deepEqual(diagnostics('say player.heShe\nplayer.gender = "female"\nexit'), [
    [
      "TSV043",
      "main.tease:1",
      `Speaker 'player' has no 'heShe' yet here: nothing copies the account or assigns 'heShe' or 'gender' before this line runs. Line 2 assigns 'gender', but only later. ${copyFix("'player.gender' or 'player.heShe'")}`,
    ],
  ]);
  // An assignment on a way that ends before the read, or one that no way runs, gives nothing there.
  assert.deepEqual(
    diagnostics(
      'if chance(0.5) {\n    player.firstName = "Sam"\n    exit\n}\nsay player.firstName\nexit',
    ),
    [
      [
        "TSV043",
        "main.tease:5",
        `Speaker 'player' has no 'firstName' yet here: nothing copies the account or assigns 'firstName' before this line runs. Line 2 assigns it, but only on a way that does not reach this line. ${copyFix("'player.firstName'")}`,
      ],
    ],
  );
  assert.deepEqual(
    diagnostics(
      'function give {\n    return\n    player.firstName = "Sam"\n}\ngive()\nsay player.firstName\nexit',
    ),
    [
      [
        "TSV043",
        "main.tease:6",
        `Speaker 'player' has no 'firstName' yet here: nothing copies the account or assigns 'firstName' before this line runs. Line 3 assigns it, but that line never runs. ${copyFix("'player.firstName'")}`,
      ],
    ],
  );
  // A declared speaker: `gender` counts for a term, the titles for each other, and the parts of the name for
  // `displayName`.
  const speaker = 'speaker vera {\n    color: "white"\n}';
  assert.deepEqual(
    diagnostics(
      `${speaker}\nsay vera.displayName\nvera.lastName = "Black"\nsay "\${vera.heShe} is here."\nvera.gender = "female"\nsay vera.title\nvera.shortTitle = "Miss"\nsay vera.petNames\nvera.petNames = ["pet"]\nexit`,
    ),
    [
      [
        "TSV043",
        "main.tease:4",
        "Speaker 'vera' has no 'displayName' yet here: nothing assigns 'displayName', 'title', 'shortTitle', 'firstName', or 'lastName' before this line runs. Line 5 assigns 'lastName', but only later. Give it a start value, as in 'speaker vera { displayName: ... }', or assign it before this line.",
      ],
      [
        "TSV043",
        "main.tease:6",
        `Speaker 'vera' has no 'heShe' yet here: nothing assigns 'heShe' or 'gender' before this line runs. Line 7 assigns 'gender', but only later. Give it a gender, as in 'speaker vera { gender: "female" }', or assign it before this line.`,
      ],
      [
        "TSV043",
        "main.tease:8",
        "Speaker 'vera' has no 'title' yet here: nothing assigns 'title' or 'shortTitle' before this line runs. Line 9 assigns 'shortTitle', but only later. Give it a start value, as in 'speaker vera { title: ... }', or assign it before this line.",
      ],
      [
        "TSV043",
        "main.tease:10",
        "Speaker 'vera' has no 'petNames' yet here: nothing assigns 'petNames' before this line runs. Line 11 assigns it, but only later. Give it a start value, as in 'speaker vera { petNames: ... }', or assign it before this line.",
      ],
    ],
  );
});

test("reads that every followed way prepares compile and run", () => {
  // Each silent form runs to its end without a runtime error.
  const runs = (main: string, others: Record<string, string> = {}): string[] =>
    outputs(assertRuntimeResumeEquivalent(project(main, others), { account: ACCOUNT }).events);
  const declared = 'speaker vera {\n    firstName: "Vera"\n    mood: "calm"\n}';
  // Declared in the block, assigned on every branch, by loops that run, or by a function that always assigns.
  assert.deepEqual(
    runs(
      [
        declared,
        "say vera.mood",
        'if chance(0.5) { vera.a = "a" } else { vera.a = "a" }',
        "switch randomInteger(1..2) {",
        '    case 1 { vera.b = "b" }',
        '    default { vera.b = "b" }',
        "}",
        "switch chance(0.5) {",
        '    case true { vera.bool = "" }',
        '    case false { vera.bool = "" }',
        "}",
        'let value: string | number = "x"',
        "if chance(0.5) { value = 3 }",
        "switch value {",
        '    case is string { vera.c = "c" }',
        '    case is number { vera.c = "c" }',
        "}",
        "while true {",
        '    vera.d = "d"',
        "    break",
        "}",
        'repeat 2 { vera.e = "e" }',
        'for item in [1, 2] { vera.f = "f" }',
        'function setG { vera.g = "g" }',
        "setG()",
        "function countdown(n) {",
        "    if n > 0 {",
        "        countdown(n - 1)",
        "    } else {",
        '        vera.h = "h"',
        "    }",
        "}",
        "countdown(2)",
        "function stop {",
        "    exit",
        "}",
        'if load("stop", default: false) { stop() } else { vera.i = "i" }',
        'say "${vera.a}${vera.b}${vera.bool}${vera.c}${vera.d}${vera.e}${vera.f}${vera.g}${vera.h}${vera.i}"',
        "exit",
      ].join("\n"),
    ),
    ["calm", "abcdefghi"],
  );
  // Cases that list every button value of an `askChoice` leave no other way.
  for (const choice of ['"a", "b"', 'open: "Open", leave: "Leave"', "5, 10"]) {
    const values = choice.includes(":") ? ['"open"', '"leave"'] : choice.split(", ");
    assert.deepEqual(
      diagnostics(
        `${VERA}\nlet pick = askChoice ${choice}\nswitch pick {\n${values.map((value) => `    case ${value} { vera.mood = "calm" }`).join("\n")}\n}\nsay vera.mood\nexit`,
      ),
      [],
      choice,
    );
  }
  // A side of `and` or `or` that never runs, and a parameter default that a call does not use.
  assert.deepEqual(
    runs(
      [
        VERA,
        'let early = false and vera.mood == "calm"',
        'let other = true or vera.mood == "calm"',
        "function show {",
        "    say vera.mood",
        "    return 1",
        "}",
        "function optional(value = show()) {",
        "    say value",
        "}",
        "optional(0)",
        'vera.mood = "calm"',
        "say vera.mood",
        "exit",
      ].join("\n"),
    ),
    ["0", "calm"],
  );
  // A function read after the assignment, a label reached only once it is assigned, a block that may have run, a store
  // through an alias or a parameter, and the player's fields after a copy.
  assert.deepEqual(
    runs(
      [
        VERA,
        'vera.mood = "calm"',
        "function show { say vera.mood }",
        "show()",
        "let rounds = 0",
        "label again",
        "say vera.mood",
        "rounds += 1",
        "if rounds < 2 { goto again }",
        'timer async 1 s { vera.late = "late" }',
        "wait 2 s",
        "say vera.late",
        "let current = vera",
        'current.alias = "V"',
        "say vera.alias",
        "function nameIt(someone: speaker) {",
        '    someone.extra = "extra"',
        "}",
        "nameIt(vera)",
        "say vera.extra",
        "player.copyFrom(account)",
        'say "${player.firstName} ${player.heShe}"',
        "exit",
      ].join("\n"),
    ),
    ["calm", "calm", "calm", "late", "V", "extra", "Sam he"],
  );
  // Across files: a goto after the assignment, a file that a `call` runs, and a global function.
  assert.deepEqual(
    runs(
      [VERA, 'vera.mood = "calm"', 'call "setup.tease"', "greet()", 'goto "room.tease"'].join("\n"),
      {
        "setup.tease": 'vera.place = "hall"\nend',
        "room.tease": "global function greet { say vera.mood }\nsay vera.place\ngreet()\nexit",
      },
    ),
    ["calm", "hall", "calm"],
  );
});

test("what the compiler cannot follow stays a runtime error", () => {
  // Each compiles without diagnostics and fails with TSR017 when it runs.
  const fails = (main: string, others: Record<string, string> = {}): string[] =>
    outputs(
      assertRuntimeResumeEquivalent(project(main, others), { account: {}, ending: "failed" })
        .events,
    );
  const cases: [string, string, Record<string, string>][] = [
    ["an alias", `${VERA}\nlet current = vera\nsay current.mood\nvera.mood = "calm"\nexit`, {}],
    [
      "a parameter",
      `${VERA}\nfunction show(someone: speaker) {\n    say someone.mood\n}\nshow(vera)\nvera.mood = "calm"\nexit`,
      {},
    ],
    [
      "the default speaker",
      `${VERA}\nspeaker vera\nsay "\${speaker.mood}"\nvera.mood = "calm"\nexit`,
      {},
    ],
    [
      "a block that runs later",
      `${VERA}\ntimer async 1 s { say vera.mood }\nwait 2 s\nvera.mood = "calm"\nexit`,
      {},
    ],
    [
      "a computed target",
      `${VERA}\nlet next = script("room.tease")\ngoto (next)`,
      { "room.tease": 'say vera.mood\nvera.mood = "calm"\nexit' },
    ],
    [
      "a called file that assigns on some ways",
      `${VERA}\ncall "setup.tease"\nsay vera.mood\nexit`,
      { "setup.tease": 'if load("set", default: false) { vera.mood = "calm" }\nend' },
    ],
    [
      "a copy inside a branch",
      'if load("copy", default: false) { player.copyFrom(account) }\nsay player.firstName\nexit',
      {},
    ],
  ];
  for (const [name, main, others] of cases)
    assert.deepEqual(fails(main, others), ["failure TSR017"], name);
});

test("the check follows deep and wide sources without native recursion", () => {
  const api = new URL("../src/index.js", import.meta.url).href;
  const script = String.raw`
    import assert from 'node:assert/strict';
    import {compileSource} from ${JSON.stringify(api)};
    const head='speaker vera {\n    firstName: "Vera"\n}\n';
    const kinds=['if true {\n','repeat 1 {\n','for item {\n','while true {\n'];
    let prefix='',suffix='';
    for (let level=0;level<1024;level++) {
      const kind=kinds[level%4];
      prefix+=kind.replace('item','item'+level+' in [1]');
      suffix=(kind.startsWith('while')?'break\n}\n':'}\n')+suffix;
    }
    const lines=source=>compileSource(source).diagnostics.map(d=>d.code+':'+(d.span.start.line+1));
    assert.deepEqual(lines(head+prefix+'say vera.mood\nvera.mood = "x"\n'+suffix+'exit'),['TSV043:1028']);
    assert.deepEqual(lines(head+'if false {} else '.repeat(1024)+'{\nsay vera.mood\n}\nvera.mood = "x"\nexit'),['TSV043:5']);
    assert.deepEqual(lines(head+'let value = '+'('.repeat(2000)+'vera.mood'+')'.repeat(2000)+'\nvera.mood = "x"\nexit'),['TSV043:4']);
    assert.deepEqual(lines(head+'vera.mood = "x"\nlet value = '+'not '.repeat(10000)+'(vera.mood == "x")\nexit'),[]);
    assert.deepEqual(lines(head+'vera.mood = "x"\n'+'say "a"\n'.repeat(40000)+'say vera.mood\nexit'),[]);
    console.log('deep speaker reads checked');
  `;
  const child = spawnSync(
    process.execPath,
    ["--stack-size=256", "--input-type=module", "--eval", script],
    { encoding: "utf8", timeout: 60_000, maxBuffer: 256 * 1024 },
  );
  assert.equal(child.error, undefined);
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout.trim(), "deep speaker reads checked");
});
