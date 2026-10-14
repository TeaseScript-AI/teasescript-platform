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
  "explorer V2 goes back to a menu answer once another answer changed what the menu's code reads, finds a choice read three menus later, starts a session at another time of day for a condition on the clock, types the codes conditions compare an answer with, and comes back for a later visit with a value an earlier one saved",
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
      // A second phase a week after the first, which answered the toy question: a later visit with the toy needs the
      // stored start of the first phase and a clock past the week too.
      phase:
        'let started: number? = load "phase", default: null\n' +
        'if started != null and getAbsoluteDateTime().toSeconds() - started < 7 * 24 * 3600 {\n  say "Later."\n  exit\n}\n' +
        "if started == null {\n" +
        '  let answers = askForm "What do you have?", fields: dict{ "toys.camera": { value: false, text: "camera" } }\n' +
        "  for key in answers {\n    save answers[key] as key\n  }\n" +
        '  save getAbsoluteDateTime().toSeconds() as "phase"\n  showButton "Done"\n  exit\n}\n' +
        'showButton "Again"\nif load("toys.camera", default: false) == true {\n  say "Camera."\n}\nexit\n',
      // Codes typed at one ask, each compared further on: the solver types the ones the conditions compare with.
      codes:
        'let q = askInteger prefill: 0\nif q == 523174 {\n  say "First code."\n}\nif q == 10000000 {\n' +
        '  say "Second code."\n}\nif q == 85685614 {\n  say "Third code."\n}\nexit\n',
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
      // A draw of a thousand outcomes whose condition compares a value made from it: several rounds of candidates.
      rounds:
        'showButton "Roll"\nlet n = randomInteger(0..=1000)\nif n * 2 == 1234 {\n  say "Reached."\n}\nexit\n',
      // A helper given another helper's result, given the text to look for.
      nested:
        "global function containsAt(text, token) {\n  return text.contains(token)\n}\n" +
        'global function pass(value) {\n  return value\n}\nlet text = askText "Text?"\n' +
        'if pass(containsAt(text, "@")) {\n  say "Reached."\n}\nexit\n',
      // One draw of a thousand outcomes among others: the number its condition compares it with is tried first.
      thousand:
        "let a = randomInteger(0..=1000)\nlet b = randomInteger(0..=1000)\nlet n = randomInteger(0..=1000)\n" +
        'if n == 617 {\n  say "Reachable."\n}\nexit\n',
      // A helper checks the typed answer character by character: the texts its conditions compare with make one.
      digits:
        'global function isNumber(text) {\n  for character in text.split("") {\n' +
        '    if not (character >= "0" and character <= "9") {\n      return false\n    }\n  }\n  return text != ""\n}\n' +
        'let guess = askText "Your guess?"\nif isNumber(guess) == true {\n  say "A number."\n}\nexit\n',
      // Each `and` reads its right side only once its left side holds.
      rare: 'showButton "Roll"\nif chance(1) and chance(1) and chance(1) {\n  say "Rare."\n}\nexit\n',
      // The last round's reward needs a count that only rounds bring, and a helper's gate that a draw must pass then (a
      // helper called on both of the gate's ways does not join them).
      gate:
        "global function noop(value) {\n}\nglobal function gate(r) {\n  if r != 999 {\n    noop(0)\n    exit\n  }\n}\n" +
        'let n = 0\nrepeat 8 {\n  let unused = askChoice a: "A", b: "B", c: "C", d: "D", e: "E"\n  let r = 999\n' +
        '  if n >= 7 {\n    r = randomInteger(0..=1000)\n  }\n  gate(r)\n  noop(0)\n  if n >= 7 {\n    say "Reward"\n  }\n' +
        "  n += 1\n}\nexit\n",
      // An opened address and a closed export dialog go on to the code after them.
      dialogs:
        'openUrl("https://example.com")\nexportText("hello", fileName: "x.txt")\nlet again = askBoolean "Again?"\n' +
        'if again {\n  say "Yes."\n}\nexit\n',
      // A helper called three times in one step: the middle call is the one a draw can make it take its other way at.
      middle:
        'global function check(n) {\n  if n == 617 {\n    say "Reward"\n  }\n}\nlet a = randomInteger(0..=1)\n' +
        "let b = randomInteger(0..=1000)\nlet c = randomInteger(0..=1)\ncheck(a + 10000)\ncheck(b)\ncheck(c + 10000)\nexit\n",
      // A helper called in each of seven rounds: only the last round's call can take its other way.
      last:
        'global function check(n) {\n  if n == 617 {\n    say "Reward"\n  }\n}\nlet n = 0\nrepeat 7 {\n' +
        "  let r = randomInteger(0..=1000)\n  check(r + (6 - n) * 10000)\n  n += 1\n}\nexit\n",
      // A helper's later call, behind a guard on two toggles on and a third off, is the one that can take its other way.
      later:
        'global function check(n) {\n  if n {\n    say "Reward"\n  }\n}\nlet picked = askBooleans("Which toys?", ' +
        `texts: [${Array.from({ length: 20 }, (_, index) => `"Toy ${index}"`).join(", ")}], ` +
        `prefill: [${Array.from({ length: 20 }, () => "false").join(", ")}])\n` +
        "check(picked[0] == (not picked[0]))\nif picked[3] == picked[7] and not picked[5] {\n  check(picked[7])\n}\nexit\n",
    };
    for (const [name, source] of Object.entries(complete))
      for (const seed of [1, 2]) {
        const result = run(source, seed);
        assert.deepEqual(
          [
            result.search.stoppedBy,
            result.search.audit.result,
            result.coverage.percent,
            result.traps.length,
          ],
          ["exhausted", "complete", 100, 0],
          `${name}, seed ${seed}`,
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
    // Its later visit starts with what a first one saved: the report shows that visit first, and the six its roll needs.
    assert.equal(witness.earlier?.length, 1);
    assert.equal(witness.earlier[0]!.storage, undefined);
    assert.deepEqual(
      witness.inputs.at(-1)?.random?.map((choice) => choice.outcome),
      [{ kind: "number", value: 6 }],
    );
    // A condition on a value the script sets itself says so, not that its setter was not reached.
    const fixed = run('let x = 2\nshowButton "Go"\nif x == 3 {\n  say "Three."\n}\nexit\n');
    assert.deepEqual(
      fixed.coverage.unvisitedBranches.map((branch) => branch.reason),
      ["no answer, random outcome, or saved data changes what it reads"],
    );
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
    // A play that measures a condition's distance where it runs keeps a whole run's behaviour: the decisions it records,
    // and the failure at the instruction budget, also in a run after a wait.
    const loops = [
      'showButton "Go"\nlet i = 0\nwhile i < 500 {\n  i += 1\n}\nif i == 5 {\n  say "Five."\n}\nexit\n',
      'showButton "Go"\nlet i = 0\nrepeat 20 {\n  i += 1\n}\nwait 1 s\nwhile i < 500 {\n  i += 1\n}\n' +
        'if i == 5 {\n  say "Five."\n}\nexit\n',
    ];
    for (const [index, loop] of loops.entries()) {
      const looping = loaded.engine.compileProject([{ path: "main.tease", source: loop }], {
        builtins: [],
      }).plan;
      assert.ok(isRecord(looping));
      const at = (Array.isArray(looping.instructions) ? looping.instructions : []).findIndex(
        (instruction) =>
          isRecord(instruction) &&
          instruction.kind === "jumpIfFalse" &&
          isRecord(instruction.condition) &&
          instruction.condition.operator === "==",
      );
      const button = {
        inputs: [{ kind: "button" as const, label: "Go" }],
        draws: new Map(),
        inherited: [],
      };
      for (const budget of [1_000_000, 100]) {
        const runner = new Runner(loaded.runtime, loaded.engine, looping, 1);
        const plain = runner.play(button, {
          maxSteps: 1,
          maxStepInstructions: budget,
          origins: false,
        });
        const measuring = runner.play(button, {
          maxSteps: 1,
          maxStepInstructions: budget,
          origins: false,
          measure: {
            at: 1,
            instruction: at,
            read: (snapshot) => {
              const i = (Array.isArray(snapshot.globals) ? snapshot.globals : [])
                .concat(
                  ...(Array.isArray(snapshot.frames) ? snapshot.frames : []).map((frame) =>
                    isRecord(frame) && Array.isArray(frame.bindings) ? frame.bindings : [],
                  ),
                )
                .find((binding) => isRecord(binding) && binding.name === "i");
              const value = isRecord(i) && typeof i.value === "number" ? i.value : NaN;
              return { distance: Math.abs(value - 5), values: [value] };
            },
          },
        });
        const shape = (each: typeof plain) => [
          each.end,
          each.failure?.code,
          each.decisions.map((decision) => `${decision.instruction}:${decision.way}`),
        ];
        assert.deepEqual(shape(measuring), shape(plain), `loop ${index}, budget ${budget}`);
        if (budget > 100) assert.equal(measuring.measured?.distance, 495);
      }
    }
    // A traced replay knows the scope of each name across calls: after a function left for another file by `goto` and
    // a timer block returned, a condition there reads its own file's answer.
    const files = [
      {
        path: "main.tease",
        source:
          'let x = askInteger prefill: 1\nif x == 1 {\n  say "before", instant\n}\n' +
          'function leave {\n  goto "other.tease"\n}\nleave()\nexit\n',
      },
      {
        path: "other.tease",
        source:
          'let x = askInteger prefill: 2\ntimer async 0 s {}\nwait 1 s\nif x == 2 {\n  say "after", instant\n}\nexit\n',
      },
    ];
    const both = loaded.engine.compileProject(files, { builtins: [] }).plan;
    assert.ok(isRecord(both));
    const traced = new Runner(loaded.runtime, loaded.engine, both, 1).play(
      {
        inputs: [
          { kind: "text", text: "1" },
          { kind: "text", text: "2" },
        ],
        draws: new Map(),
        inherited: [],
      },
      { maxSteps: 2, maxStepInstructions: 10_000, origins: true },
    );
    const after = traced.decisions.at(-1);
    assert.deepEqual([...(after?.origins ?? [])], ["i1"]);
  },
);
