import assert from "node:assert/strict";
import { test } from "node:test";
import { isRecord } from "../src/ast.ts";
import { loadEngine, type Engine } from "../src/explorer.ts";
import { loadRuntime2, Runner, type Runtime2 } from "../src/explorer2/runner.ts";
import { DEFAULT_OPTIONS, explore2 } from "../src/explorer2/search.ts";

const loaded = await Promise.all([loadEngine(), loadRuntime2()]).then(
  ([engine, runtime]): { engine: Engine; runtime: Runtime2 } | { reason: string } => ({
    engine,
    runtime,
  }),
  (error: unknown) => ({ reason: error instanceof Error ? error.message : String(error) }),
);

/** Explorer V2 on one source file, until done or 30 seconds. */
function run(source: string, seed = 1) {
  assert.ok("engine" in loaded);
  const { plan } = loaded.engine.compileProject([{ path: "main.tease", source }], { builtins: [] });
  assert.ok(isRecord(plan));
  return explore2(loaded.engine, loaded.runtime, plan, {
    ...DEFAULT_OPTIONS,
    seed,
    budgetMs: 30_000,
    sources: new Map([["main.tease", source]]),
  });
}

test(
  "explorer V2 reaches code behind a combination its condition tells apart, whatever the seed: two dice that sum to 7, two toggles of a form, a pair of draws one guarding the other",
  { skip: "reason" in loaded ? loaded.reason : false },
  () => {
    const sources = {
      // Two dice in one step; only a pair summing to 7 says it.
      dice:
        'showButton "Roll"\nlet first = randomInteger(1..=6)\nlet second = randomInteger(1..=6)\n' +
        'if first + second == 7 {\n  say "Seven."\n} else {\n  say "Not seven."\n}\nexit\n',
      // Two toggles of twenty on and a third off: neither one toggle alone nor all of them on.
      toys:
        `let picked = askBooleans("Which toys?", texts: [${Array.from({ length: 20 }, (_, index) => `"Toy ${index}"`).join(", ")}], ` +
        `prefill: [${Array.from({ length: 20 }, () => "false").join(", ")}])\n` +
        'if picked[3] and picked[7] and not picked[5] {\n  say "Both."\n}\nexit\n',
      // The outer condition reads both draws: only x = y = 1 reaches the inner one.
      guarded:
        'showButton "Draw"\nlet x = randomInteger(0..=3)\nlet y = randomInteger(0..=3)\n' +
        'if x == y {\n  if y == 1 {\n    say "Both one."\n  }\n}\nexit\n',
    };
    for (const [name, source] of Object.entries(sources))
      for (const seed of [1, 2]) {
        const result = run(source, seed);
        assert.deepEqual(
          [result.search.stoppedBy, result.coverage.percent],
          ["exhausted", 100],
          `${name}, seed ${seed}`,
        );
      }
  },
);

test(
  "explorer V2 goes back to a menu answer once another answer changed what the menu's code reads, finds a choice read three menus later, starts a session at another time of day for a condition on the clock, and comes back for a later visit with a value an earlier one saved",
  { skip: "reason" in loaded ? loaded.reason : false },
  () => {
    const sources = {
      unlock:
        'let open = false\nwhile true {\n  let pick = askChoice check: "Check", unlock: "Unlock", leave: "Leave"\n' +
        '  if pick == "leave" {\n    exit\n  }\n  if pick == "unlock" {\n    open = true\n  }\n' +
        '  if pick == "check" and open {\n    say "It opens."\n  }\n}\n',
      later:
        'let color = askChoice red: "Red", blue: "Blue"\nshowButton "Next"\nshowButton "Next"\nshowButton "Next"\n' +
        'if color == "blue" {\n  say "Blue it is."\n}\nexit\n',
      // Only a session started before six in the morning says it.
      night: 'showButton "Start"\nif getDateTime().hour < 6 {\n  say "Up so late?"\n}\nexit\n',
      // Only a later visit, from a state the first one saved, says it.
      visit:
        'let level: number = load "level", default: 0\nif level == 2 {\n  say "Welcome back."\n}\n' +
        'showButton "Train"\nsave 1 as "level"\nshowButton "Again"\nsave 2 as "level"\nexit\n',
    };
    for (const [name, source] of Object.entries(sources)) {
      const result = run(source);
      assert.deepEqual(
        [result.search.stoppedBy, result.coverage.percent],
        ["exhausted", 100],
        name,
      );
    }
  },
);

test(
  "explorer V2 reports a loop with no way out with the play into it, and none for a menu that has a way out",
  { skip: "reason" in loaded ? loaded.reason : false },
  () => {
    const trapped = run(
      'while true {\n  let pick = askChoice stay: "Stay", leave: "Leave", quit: "Quit"\n  if pick == "quit" {\n' +
        '    exit\n  }\n  if pick == "leave" {\n    while true {\n      showButton "Again"\n    }\n  }\n}\n',
    );
    assert.deepEqual(
      trapped.traps.map((trap) => [
        trap.kind,
        trap.locations,
        trap.inputs.map((input) => input.kind),
      ]),
      [["loop", ["main.tease:8"], ["option"]]],
    );
    const open = run(
      'while true {\n  let pick = askChoice stay: "Stay", leave: "Leave"\n  if pick == "leave" {\n    exit\n  }\n}\n',
    );
    assert.deepEqual([open.search.stoppedBy, open.traps.length], ["exhausted", 0]);
  },
);

test(
  "explorer V2 completes only what it covered and reports witnesses that replay: decisions behind repeated code, guards already covered both ways, fields a guard reads, paths longer than one play, and a loop that ends",
  { skip: "reason" in loaded ? loaded.reason : false },
  () => {
    const toggles = (condition: string) =>
      `let picked = askBooleans("Which toys?", texts: [${Array.from({ length: 20 }, (_, index) => `"Toy ${index}"`).join(", ")}], ` +
      `prefill: [${Array.from({ length: 20 }, () => "false").join(", ")}])\n${condition}exit\n`;
    const complete = {
      // A decision after a loop whose condition ran many times, behind a draw.
      repeated:
        'showButton "Roll"\nlet first = randomInteger(1..=6)\nrepeat 20 {\n  say "Before."\n}\nif first == 6 {\n' +
        '  let second = randomInteger(1..=6)\n  if second == 6 {\n    say "Double six."\n  }\n}\nexit\n',
      // The guard `picked[3] == picked[7]` holds at first; the inner line needs both on and the third off.
      guardFields: toggles(
        'if picked[3] == picked[7] and not picked[5] {\n  if picked[7] {\n    say "Both, no third."\n  }\n}\n',
      ),
      // More buttons than one play goes on for.
      long:
        Array.from({ length: 45 }, (_, index) => `showButton "Next ${index}"\n`).join("") +
        'say "The end."\nexit\n',
      // Loops that end, after rounds or after time: no trap.
      finite: 'repeat 50 {\n  showButton "Next"\n}\nsay "Reached the end."\nexit\n',
      timed:
        'let started = getAbsoluteDateTime()\nwhile getAbsoluteDateTime() - started < 50 s {\n  showButton "Next"\n' +
        '  wait 1 s\n}\nsay "Reached."\nexit\n',
      // An hour later, and only with the draw that makes the limit 60 minutes: both changes, the draw's before the
      // interaction where the player continues later.
      laterDraw:
        "let started = getAbsoluteDateTime()\nlet n = randomInteger(0..=1)\nlet limit = 65 - n * 5\n" +
        'let a = askChoice next: "Next"\nif getAbsoluteDateTime() - started == limit * 1 min {\n  say "Reached."\n}\nexit\n',
      // Each `and` reads its right side only once its left side holds.
      rare: 'showButton "Roll"\nif chance(1) and chance(1) and chance(1) {\n  say "Rare."\n}\nexit\n',
    };
    for (const [name, source] of Object.entries(complete)) {
      const result = run(source);
      assert.deepEqual(
        [
          result.search.stoppedBy,
          result.search.audit.result,
          result.coverage.percent,
          result.traps.length,
        ],
        ["exhausted", "complete", 100, 0],
        name,
      );
    }
    // With this seed, both ways of the outer `x == y` are covered before the inner target is: its origins still count.
    const guarded =
      'showButton "Draw"\nlet x = randomInteger(0..=3)\nlet y = randomInteger(0..=3)\n' +
      'if x == y {\n  if y == 1 {\n    say "Both one."\n  }\n}\nexit\n';
    assert.equal(run(guarded, 12_345_678).coverage.percent, 100);
    // A crash only a later visit with a six reaches: its witness (inputs, draw outcomes, storage) replays to it.
    assert.ok("engine" in loaded);
    const crash =
      'let level: number = load "level", default: 0\nshowButton "Roll"\nlet dice = randomInteger(1..=6)\n' +
      'if level == 2 and dice == 6 {\n  say "${1 / (level - 2)}"\n}\nsave 2 as "level"\nexit\n';
    const found = run(crash).crashes;
    assert.equal(found.length, 1);
    const { plan } = loaded.engine.compileProject([{ path: "main.tease", source: crash }], {
      builtins: [],
    });
    assert.ok(isRecord(plan));
    const witness = found[0]!;
    const replayed = new Runner(loaded.runtime, loaded.engine, plan, 1).play(
      {
        inputs: witness.inputs,
        draws: new Map(witness.draws.map((draw) => [draw.occurrence, draw.outcome])),
        inherited: [],
        ...(witness.storage === undefined ? {} : { storage: witness.storage }),
      },
      { maxSteps: witness.inputs.length, maxStepInstructions: 1_000_000, origins: false },
    );
    assert.deepEqual([replayed.end, replayed.failure?.code], ["failed", witness.code]);
    // An outcome a path fixed that the draw can no longer have (`chance(0)` after another answer) is not forced.
    const never =
      'let pick = askChoice always: "Always", never: "Never"\nlet p = 100\nif pick == "never" {\n  p = 0\n}\n' +
      'let flip = chance(p)\nsay "${flip}"\nexit\n';
    const compiled = loaded.engine.compileProject([{ path: "main.tease", source: never }], {
      builtins: [],
    }).plan;
    assert.ok(isRecord(compiled));
    const played = new Runner(loaded.runtime, loaded.engine, compiled, 1).play(
      {
        inputs: [{ kind: "option", index: 1, label: "Never" }],
        draws: new Map([[0, { kind: "boolean", value: true }]]),
        inherited: [],
      },
      { maxSteps: 1, maxStepInstructions: 1_000_000, origins: false },
    );
    assert.equal(played.end, "exit");
  },
);
