import assert from "node:assert/strict";
import test from "node:test";

import { compileProject, compileSource, type CompileOptions } from "../src/compiler.js";

const NO_WAY_OUT =
  "If this loop starts, it has no way to stop. Add a condition with `break` to leave the loop, or use `exit` to finish the session.";

/** A start that can end the session, so the loop after it is the only thing to report. */
const QUIT = 'let answer = choose "Play", "Quit"\nif answer == "Quit" { exit }\n';

/** Each diagnostic as `line severity code`, and whether the source compiled to a plan. */
function report(
  source: string,
  options?: CompileOptions,
): { diagnostics: string[]; plan: boolean } {
  const result = compileSource(source, options);
  return {
    diagnostics: result.diagnostics.map(
      (diagnostic) => `${diagnostic.span.start.line + 1} ${diagnostic.severity} ${diagnostic.code}`,
    ),
    plan: result.plan !== null,
  };
}

/** Each diagnostic of a project as `path:line code`. */
function projectReport(files: Readonly<Record<string, string>>): string[] {
  return compileProject(
    Object.entries(files).map(([path, source]) => ({ path, source })),
  ).diagnostics.map(
    (diagnostic) => `${diagnostic.path}:${diagnostic.span.start.line + 1} ${diagnostic.code}`,
  );
}

test("a while true or label loop with no way out is a warning, which does not prevent a plan", () => {
  const [warning] = compileSource("while true { wait 1 s }\nexit").diagnostics;
  assert.deepEqual(
    [warning?.severity, warning?.code, warning?.message],
    ["warning", "TSV058", NO_WAY_OUT],
  );
  // The exit after the loop never runs, which is the separate ending error.
  assert.deepEqual(report("while true { wait 1 s }\nexit").diagnostics, [
    "1 warning TSV058",
    "2 error TSV053",
  ]);
  assert.deepEqual(report('label again\nsay "Again", instant\nwait 1 s\ngoto again').diagnostics, [
    "4 warning TSV058",
    "4 error TSV053",
  ]);
  // On a path that otherwise ends, the warning on `while true` or the `goto` back is all there is.
  for (const [loop, line] of [
    ["while true { wait 1 s }", 3],
    ["while (true) {\n    wait 1 s\n}", 3],
    ['label again\nsay "Again", instant\nwait 1 s\ngoto again', 6],
    // Asking, showing, and engine functions that only compute a value are no way out.
    ['while true {\n    let mood = choose "Good", "Bad"\n    say mood\n}', 3],
    ['while true {\n    say "You rolled ${randomInteger(1..6)}", instant\n    wait 1 s\n}', 3],
    // A timer block without a way out does not end the loop.
    ['timer async 5 s { say "Hurry" }\nwhile true { wait 1 s }', 4],
    ["function idle {\n    while true { wait 1 s }\n}\nidle()\nexit", 4],
  ] as const)
    assert.deepEqual(report(QUIT + loop), { diagnostics: [`${line} warning TSV058`], plan: true });
  // The warning marks the loop's first line, `while (true)`.
  const parenthesized = compileSource(QUIT + "while (true) {\n    wait 1 s\n}").diagnostics[0]!
    .span;
  assert.deepEqual(
    [parenthesized.start.column, parenthesized.end.line, parenthesized.end.column],
    [0, 2, 12],
  );
  // A loop that never runs is not reported, as one after a loop that never ends, or the `goto` back after it.
  assert.deepEqual(
    report(QUIT + "label again\nwhile true { wait 1 s }\nwhile true { wait 2 s }\ngoto again")
      .diagnostics,
    ["4 warning TSV058"],
  );
});

test("a way out anywhere in the loop, also nested or in a branch never taken, silences the warning", () => {
  for (const [source, options] of [
    [
      'while true {\n    let answer = choose "Continue", "Stop"\n    if answer == "Stop" { break }\n}\nexit',
      {},
    ],
    [
      'while true {\n    let answer = choose "Continue", "Stop"\n    if answer == "Stop" { goto done }\n    wait 1 s\n}\nlabel done\nexit',
      {},
    ],
    [
      'label again\nsay "Again"\nlet answer = choose "Again", "Stop"\nif answer == "Stop" { exit }\nwait 1 s\ngoto again',
      {},
    ],
    [`${QUIT}while true {\n    if false { break }\n    wait 1 s\n}`, {}],
    [
      `${QUIT}while true {\n    for n in 1..3 {\n        switch n {\n            case 2 { if answer == "Play" { exit } }\n        }\n    }\n}`,
      {},
    ],
    [`${QUIT}while true {\n    if answer == "Play" { end }\n}`, {}],
    ["function wander {\n    while true { return }\n}\nwander()\nexit", {}],
    // A call of an author, host, or library function may end the session.
    [`function rest { wait 1 s }\n${QUIT}while true { rest() }`, {}],
    [`${QUIT}while true { vibrate() }`, { builtins: ["vibrate"] }],
    [`${QUIT}while true { say escapeMarkup(answer) }`, {}],
    // Recursion is not one of the loops checked.
    ["function spin { spin() }\nspin()\nexit", {}],
  ] as const)
    assert.deepEqual(report(source, options), { diagnostics: [], plan: true }, source);
  assert.deepEqual(
    projectReport({
      "main.tease": `${QUIT}while true { call "chapter.tease" }`,
      "chapter.tease": "wait 1 s\nend",
    }),
    [],
  );
});

test("a label loop is an unconditional top-level goto back to an earlier label", () => {
  for (const source of [
    `${QUIT}label again\nsay "Again"\nif answer == "Play" { goto again }\nexit`,
    `${QUIT}label again\nsay "Again"\nrepeat 2 { goto again }`,
    `${QUIT}goto later\nlabel later\nwait 1 s\nexit`,
  ])
    assert.deepEqual(report(source), { diagnostics: [], plan: true }, source);
});

test("a timer or media block with a way out silences the warning in every file of the project", () => {
  for (const block of [
    "timer async 2 s { exit }",
    'playAudio async "song.mp3" {\n    finish { exit }\n}',
    "function stop { exit }\ntimer async 2 s { stop() }",
  ])
    assert.deepEqual(
      report(`${block}\n${QUIT}while true { wait 1 s }`),
      { diagnostics: [], plan: true },
      block,
    );
  const closed = {
    "main.tease": `${QUIT}call "chapter.tease"\nwhile true { wait 1 s }`,
    "chapter.tease": "label again\nwait 1 s\ngoto again",
  };
  assert.deepEqual(
    projectReport({
      ...closed,
      "timers.tease": 'function hurry {\n    timer async 5 s { say "Hurry" }\n}',
    }),
    ["main.tease:4 TSV058", "chapter.tease:3 TSV058"],
  );
  assert.deepEqual(
    projectReport({
      ...closed,
      "timers.tease": "function limit {\n    timer async 5 s { exit }\n}",
    }),
    [],
  );
});
