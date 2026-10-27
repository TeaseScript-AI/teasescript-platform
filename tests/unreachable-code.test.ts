import assert from "node:assert/strict";
import test from "node:test";

import { compileProject, compileSource } from "../src/compiler.js";
import { assertRuntimeResumeEquivalent } from "./helpers/runtime-equivalence.js";

/** Each diagnostic as `line code message`. */
function report(source: string): string[] {
  return compileSource(source).diagnostics.map(
    (diagnostic) => `${diagnostic.span.start.line + 1} ${diagnostic.code} ${diagnostic.message}`,
  );
}

/** Each diagnostic as `line code`. */
function codes(source: string): string[] {
  return compileSource(source).diagnostics.map(
    (diagnostic) => `${diagnostic.span.start.line + 1} ${diagnostic.code}`,
  );
}

const KNOB = 'let k = load "k", default: false\n';

test("code that never runs is a warning that says why, and the script still compiles", () => {
  for (const [source, message] of [
    [
      'say "a"\nexit\nsay "never"\nexit',
      "3 TSV065 This code never runs, because the 'exit' on line 2 always ends the session first. Remove it, or move it before the 'exit'.",
    ],
    [
      'goto done\nsay "never"\nlabel done\nexit',
      "2 TSV065 This code never runs, because the 'goto' on line 1 always jumps away first. Remove it, or move it before the 'goto'.",
    ],
    [
      'function f {\n    return\n    say "never"\n}\nf()\nexit',
      "3 TSV065 This code never runs, because the 'return' on line 2 always leaves the function first. Remove it, or move it before the 'return'.",
    ],
    [
      'repeat 2 {\n    break\n    say "never"\n}\nexit',
      "3 TSV065 This code never runs, because the 'break' on line 2 always leaves the loop first. Remove it, or move it before the 'break'.",
    ],
    [
      'repeat 2 {\n    continue\n    say "never"\n}\nexit',
      "3 TSV065 This code never runs, because the 'continue' on line 2 always starts the next round of the loop first. Remove it, or move it before the 'continue'.",
    ],
    [
      `${KNOB}if k {\n    exit\n} else {\n    goto done\n}\nsay "never"\nlabel done\nexit`,
      "7 TSV065 This code never runs, because no way through the 'if' on line 2 continues after it. Remove it, or move it into the branch of the 'if' that should run it.",
    ],
    [
      `${KNOB}while true {\n    if k { exit }\n    wait 1 s\n}\nsay "never"`,
      "6 TSV065 This code never runs, because no way through the 'while' on line 2 continues after it. Remove it, or add a 'break' where the loop should end.",
    ],
    [
      'if false {\n    say "never"\n}\nexit',
      "2 TSV065 This code never runs, because the condition on line 1 is never true. Remove it, or change the condition.",
    ],
    [
      'if true {\n    say "yes"\n} else {\n    say "never"\n}\nexit',
      "4 TSV065 This code never runs, because the condition on line 1 is always true. Remove it, or change the condition.",
    ],
    [
      'while false {\n    say "never"\n}\nexit',
      "2 TSV065 This code never runs, because the condition on line 1 is never true. Remove it, or change the condition.",
    ],
    [
      'repeat 0 {\n    say "never"\n}\nexit',
      "2 TSV065 This code never runs, because the 'repeat' on line 1 runs its body no time. Remove it, or change the count.",
    ],
    [
      'for item in [] {\n    say "never"\n}\nexit',
      "2 TSV065 This code never runs, because the 'for' on line 1 runs its body no time. Remove it, or change what the loop goes through.",
    ],
    [
      `${KNOB}switch k {\n    case true { say "yes" }\n    case false { say "no" }\n    default { say "never" }\n}\nexit`,
      "5 TSV065 This code never runs, because the cases of the 'switch' on line 2 take every value. Remove the 'default', or change the cases.",
    ],
  ] as const) {
    const compiled = compileSource(source);
    assert.deepEqual(report(source), [message], source);
    assert.notEqual(compiled.plan, null, source);
  }
});

test("an exit that never runs is a warning of its own, also in a branch that never runs", () => {
  assert.deepEqual(report('say "a"\ngoto done\nexit\nlabel done\nexit'), [
    "3 TSV066 This exit never runs, because the 'goto' on line 2 always jumps away first. Remove it, or move it to where the session should finish.",
  ]);
  assert.deepEqual(report("if false {\n    exit\n}\nexit"), [
    "2 TSV066 This exit never runs, because the condition on line 1 is never true. Remove it, or change the condition.",
  ]);
});

test("a run of code that never runs is reported once, on its first statement", () => {
  // The rest of the run, and what is nested in it, has no warning of its own, also an exit in it.
  assert.deepEqual(
    codes('exit\nsay "a"\nif true {\n    say "b"\n}\nexit\nrepeat 0 {\n    say "c"\n}'),
    ["2 TSV065"],
  );
  // A label that a goto leads to ends the run; declarations, which run nothing where they stand, do not.
  assert.deepEqual(
    codes(
      'goto later\nfunction f { say "f" }\nspeaker vera {}\nsay "a"\nlabel later\nsay "b"\nexit\nsay "c"',
    ),
    ["4 TSV065", "8 TSV065"],
  );
  // A call counts as returning, also of a function that never returns (ADR 0022 §4.3).
  assert.deepEqual(codes('function stop { exit }\nstop()\nsay "after"\nexit'), []);
});

test("code that another warning already reports as never running gets no second warning", () => {
  // The condition that TSV046 reports as always false, also through an operand that decides it, or the case it reports
  // as never matching. A TSV046 in the condition that does not decide it so says nothing about the branch.
  assert.deepEqual(
    codes('let name: string? = "Ann"\nif name == null {\n    say "never"\n}\nexit'),
    ["2 TSV046"],
  );
  assert.deepEqual(
    codes(
      `${KNOB}let name: string? = "Ann"\nif (name == null and k) or not (name != null) {\n    say "never"\n}\nexit`,
    ),
    ["3 TSV046", "3 TSV046"],
  );
  assert.deepEqual(codes('let x = 1\nif x != null and false {\n    say "never"\n}\nexit'), [
    "2 TSV046",
    "3 TSV065",
  ]);
  assert.deepEqual(
    codes(
      'let count = 1\nswitch count {\n    case is string { say "never" }\n    default { say "one" }\n}\nexit',
    ),
    ["3 TSV046"],
  );
  assert.deepEqual(codes('for value in 4..1 {\n    say "never"\n}\nexit'), ["1 TSV046"]);
  // What follows a loop that TSV058 reports as having no way out.
  assert.deepEqual(codes(`${KNOB}if k {\n    while true { wait 1 s }\n    say "never"\n}\nexit`), [
    "3 TSV058",
  ]);
  // A function that no call which can run reaches, and a block that no code which can run creates: the code that
  // would run them is reported instead, or nothing is, for a function that nothing calls.
  assert.deepEqual(
    codes(
      'function f {\n    exit\n    say "never"\n}\nif false {\n    f()\n    timer async 1 s {\n        exit\n        say "never"\n    }\n}\nexit',
    ),
    ["6 TSV065"],
  );
  assert.deepEqual(codes('function unused {\n    exit\n    say "never"\n}\nexit'), []);
});

test("the endings follow which code can run", () => {
  // A switch whose cases take every value and all end needs nothing after it.
  assert.deepEqual(
    codes(
      `${KNOB}switch k {\n    case true {\n        exit\n    }\n    case false {\n        exit\n    }\n}`,
    ),
    [],
  );
  // An exit that no way reaches does not end the session: one in a function that nothing calls, or in a block that
  // code which never runs creates.
  for (const source of [
    'function finish {\n    exit\n}\nsay "a"\ngoto "main.tease"',
    "if false {\n    timer async 1 s { exit }\n}\nwhile true {\n    wait 1 s\n}",
  ])
    assert.ok(
      codes(source).some((code) => code.endsWith(" TSV053")),
      source,
    );
  // Across files: a file that a transfer enters can run, and one that nothing enters never runs but still says how it
  // ends.
  assert.deepEqual(
    compileProject([
      { path: "main.tease", source: 'goto "end.tease"' },
      { path: "end.tease", source: "exit" },
      { path: "other.tease", source: 'say "other"' },
    ]).diagnostics.map((diagnostic) => `${diagnostic.path} ${diagnostic.code}`),
    ["other.tease TSV065", "other.tease TSV052"],
  );
});

test("the code of a file that no goto or call which can run starts never runs", () => {
  const tagged = (tag: string, source: string) => `---\ntags: "${tag}"\n---\n${source}`;
  const files = Object.entries({
    "main.tease": [
      'call "path.tease"',
      'call "rooms/*.tease"',
      'call tagged "picked"',
      'let next = [script("computed.tease")]',
      "call (next[0])",
      "help()",
      'if false {\n    call "dead.tease"\n}',
      "exit",
    ].join("\n"),
    "path.tease": 'say "path"\nend',
    "rooms/glob.tease": 'say "glob"\nend',
    "picked.tease": tagged("picked", 'say "picked"\nend'),
    "skipped.tease": tagged("skipped", 'say "skipped"\nend'),
    "computed.tease": 'say "computed"\nend',
    "helpers.tease": 'global function help {\n    say "help"\n}',
    // Only code that never runs starts these, and a start value runs at the start of the session.
    "dead.tease": 'say "dead"\ncall "chained.tease"\nend',
    "chained.tease": 'say "chained"\nend',
    "never.tease": 'global start = 1\nsay "never ${start}"\nend',
  }).map(([path, source]) => ({ path, source }));
  assert.deepEqual(
    compileProject(files).diagnostics.map(
      (diagnostic) => `${diagnostic.path}:${diagnostic.span.start.line + 1} ${diagnostic.code}`,
    ),
    [
      "main.tease:8 TSV065",
      "chained.tease:1 TSV065",
      "dead.tease:1 TSV065",
      "never.tease:2 TSV065",
      "skipped.tease:4 TSV065",
    ],
  );
  assert.equal(
    compileProject(files).diagnostics.find((diagnostic) => diagnostic.path === "dead.tease")
      ?.message,
    "The code of 'dead.tease' never runs, because no 'goto' or 'call' that can run starts the file. Remove the file, or start the file with a 'goto' or 'call'.",
  );
  // As the session runs: each file that may start runs, and none of the others.
  const said = assertRuntimeResumeEquivalent(files, {
    warnings: ["TSV065", "TSV065", "TSV065", "TSV065", "TSV065"],
  }).events.flatMap((event) => (event.kind === "say" ? [event.text] : []));
  assert.deepEqual(said, ["path", "glob", "picked", "computed", "help"]);
});
