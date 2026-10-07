import assert from "node:assert/strict";
import test from "node:test";

import { compileProject } from "../src/compiler.js";
import type { InstructionPlan } from "../src/plan/model.js";
import { randomDrawAlternatives } from "../src/runtime/random-alternatives.js";
import {
  replayRandomChoices,
  type RandomChoiceReceipt,
  type RandomDrawKind,
  type RandomDrawView,
  type RandomOutcome,
} from "../src/runtime/random-control.js";
import { createFreshRuntimeSession, type RuntimeSession } from "../src/runtime/session.js";

/*
 * An explorer of random branches through the public session API (docs/RUNTIME.md#controlled-randomness): it pauses at
 * the draws it branches on, tries the natural result and every alternative on a fork each, and keeps each path as the
 * outcomes it chose, which replay with replayRandomChoices.
 */

function plan(source: string): InstructionPlan {
  const compiled = compileProject([{ path: "main.tease", source }]);
  assert.deepEqual(compiled.diagnostics, []);
  return compiled.plan!;
}

const BRANCHES = plan(
  [
    'let items = ["a", "b", "c"]',
    "if chance(25) {",
    '  say "hit"',
    "}",
    "let roll = randomInteger(1..=3)",
    'say "roll ${roll}"',
    'say "pick ${items.random}"',
    "items.shuffle()",
    'say items.join(" ")',
    "exit",
  ].join("\n"),
);

interface Path {
  readonly said: readonly string[];
  readonly choices: readonly RandomChoiceReceipt[];
}

/** Runs to the end or to the next paused draw, collecting what the session says. */
function advance(session: RuntimeSession, said: string[], choices: RandomChoiceReceipt[]): void {
  for (let rounds = 0; rounds < 100; rounds += 1) {
    const ran = session.run();
    said.push(...ran.events.flatMap((event) => (event.kind === "say" ? [event.text] : [])));
    choices.push(...(ran.randomChoices ?? []));
    if (session.view().randomDraw !== null) return;
    if (session.view().status !== "waiting") return;
    const observed = session.observeTime(session.view().currentSessionTimeMs + 60_000);
    said.push(...observed.events.flatMap((event) => (event.kind === "say" ? [event.text] : [])));
  }
}

/** Every path through the draws the filter selects: natural first, then each alternative, on forks. */
function explore(root: RuntimeSession): Path[] {
  const paths: Path[] = [];
  const pending: { session: RuntimeSession; said: string[]; choices: RandomChoiceReceipt[] }[] = [
    { session: root, said: [], choices: [] },
  ];
  while (pending.length > 0) {
    const { session, said, choices } = pending.pop()!;
    advance(session, said, choices);
    const draw = session.view().randomDraw;
    if (draw === null) {
      paths.push({ said, choices });
      continue;
    }
    const { alternatives, complete } = randomDrawAlternatives(draw);
    assert.ok(complete, `${draw.kind} is finite here`);
    for (const outcome of ["natural" as const, ...alternatives]) {
      const branch = session.fork();
      const resumed = branch.resumeRandomDraw({ drawId: draw.drawId, outcome });
      assert.equal(resumed.outcome.kind, "resolved");
      const branchSaid = [
        ...said,
        ...resumed.events.flatMap((event) => (event.kind === "say" ? [event.text] : [])),
      ];
      pending.push({
        session: branch,
        said: branchSaid,
        choices: [...choices, ...(resumed.randomChoices ?? [])],
      });
    }
  }
  return paths;
}

test("forks at paused draws reach every combination of outcomes, and each path replays from its choices", () => {
  const paths = explore(createFreshRuntimeSession(BRANCHES, { seed: 5 }, { randomControl: {} }));
  // chance: 2, randomInteger: 3, items.random: 3, shuffle of 3: 6.
  assert.equal(paths.length, 2 * 3 * 3 * 6);
  const endings = new Set(paths.map((path) => path.said.join(" | ")));
  assert.equal(endings.size, paths.length, "every path says something different");
  assert.ok(paths.some((path) => path.said.includes("hit")));
  assert.ok(paths.some((path) => !path.said.includes("hit")));
  for (const roll of [1, 2, 3]) assert.ok(paths.some((path) => path.said.includes(`roll ${roll}`)));
  // A path is its chosen outcomes: replaying them with the same seed says the same.
  for (const path of paths.slice(0, 12)) {
    const replayed = createFreshRuntimeSession(
      BRANCHES,
      { seed: 5 },
      { randomControl: replayRandomChoices(path.choices) },
    );
    const said: string[] = [];
    const chosen: RandomChoiceReceipt[] = [];
    advance(replayed, said, chosen);
    assert.deepEqual(said, path.said);
    assert.deepEqual(chosen, path.choices);
  }
});

test("a decision callback leaves cosmetic draws natural and branches only at the sites it targets", () => {
  const source = plan(
    [
      'let mood = ["calm", "bright", "dark"].random',
      "let total = 0",
      "repeat 50 {",
      "  total += randomInteger(1..=6)",
      "}",
      "if chance(10) {",
      '  say "rare"',
      "} else {",
      '  say "common"',
      "}",
      "exit",
    ].join("\n"),
  );
  let decided = 0;
  const session = createFreshRuntimeSession(
    source,
    { seed: 9 },
    {
      randomControl: {
        filter: { kinds: ["chance"] },
        decide: () => {
          decided += 1;
          return { kind: "suspend" };
        },
      },
    },
  );
  const paths = explore(session);
  assert.deepEqual(paths.map((path) => path.said).sort(), [["common"], ["rare"]]);
  assert.equal(decided, 1, "only the targeted draw reached the callback");
});

/** A paused draw of `kind` in `source`. */
function pausedDraw(source: string, kind: RandomDrawKind): RandomDrawView {
  const session = createFreshRuntimeSession(
    plan(source),
    {},
    { randomControl: { filter: { kinds: [kind] } } },
  );
  session.run();
  const draw = session.view().randomDraw;
  assert.ok(draw !== null && draw.kind === kind);
  return draw;
}

test("alternatives are outcomes the draw admits, complete only for a finite support", () => {
  const cases: [string, RandomDrawKind, boolean][] = [
    ["let x = random()\nexit", "random", false],
    ["let x = chance(0)\nexit", "chance", true],
    ["let x = chance(40)\nexit", "chance", true],
    ["let x = randomInteger(1..=4)\nexit", "randomInteger", true],
    ["let x = randomInteger(1..=1000)\nexit", "randomInteger", false],
    ['let x = randomWeighted(dict{ "a": 1, "b": 0, "c": 2 })\nexit', "randomWeighted", true],
    ["let x = randomNormal(5, 0)\nexit", "randomNormal", true],
    ["let x = randomNormal(5, 2)\nexit", "randomNormal", false],
    ["let x = randomBeta(2, 3)\nexit", "randomBeta", false],
    ["let x = randomPert(1, 1, 1)\nexit", "randomPert", true],
    ["let x = randomPert(1, 2, 4)\nexit", "randomPert", false],
    ["let xs = [1, 2, 3, 4]\nxs.shuffle()\nexit", "shuffle", false],
    ["let xs = [1, 2, 3]\nxs.shuffle()\nexit", "shuffle", true],
  ];
  for (const [source, kind, complete] of cases) {
    const draw = pausedDraw(source, kind);
    const found = randomDrawAlternatives(draw);
    assert.equal(found.complete, complete, source);
    const keys = found.alternatives.map((outcome) => JSON.stringify(outcome));
    assert.equal(new Set(keys).size, keys.length, `${source}: distinct`);
    assert.ok(!keys.includes(JSON.stringify(draw.natural)), `${source}: natural left out`);
    for (const outcome of found.alternatives) assertAdmitted(source, kind, outcome);
  }
  const weighted = randomDrawAlternatives(
    pausedDraw('let x = randomWeighted(dict{ "a": 1, "b": 0, "c": 2 })\nexit', "randomWeighted"),
  );
  assert.ok(
    weighted.alternatives.every((outcome) => outcome.kind === "index" && outcome.index !== 1),
    "weight 0 is never an alternative",
  );
  assert.equal(
    randomDrawAlternatives(pausedDraw("let xs = [1, 2, 3, 4]\nxs.shuffle()\nexit", "shuffle"), 100)
      .complete,
    true,
  );
  assert.throws(
    () => randomDrawAlternatives(pausedDraw("let x = random()\nexit", "random"), -1),
    RangeError,
  );
});

/** Resuming the same paused draw with `outcome` is accepted. */
function assertAdmitted(source: string, kind: RandomDrawKind, outcome: RandomOutcome): void {
  const session = createFreshRuntimeSession(
    plan(source),
    {},
    { randomControl: { filter: { kinds: [kind] } } },
  );
  session.run();
  const draw = session.view().randomDraw!;
  assert.equal(
    session.resumeRandomDraw({ drawId: draw.drawId, outcome }).outcome.kind,
    "resolved",
    `${source}: ${JSON.stringify(outcome)}`,
  );
}

test("alternatives respect a limit of 0 and list a narrow interval completely", () => {
  const chance = randomDrawAlternatives(pausedDraw("let x = chance(40)\nexit", "chance"), 0);
  assert.deepEqual(chance, { alternatives: [], complete: false });
  // 1 and the next representable number are the whole support of this PERT.
  const narrow = pausedDraw("let x = randomPert(1, 1, 1.0000000000000002)\nexit", "randomPert");
  const found = randomDrawAlternatives(narrow);
  assert.equal(found.complete, true);
  assert.equal(found.alternatives.length, 1);
  for (const outcome of found.alternatives)
    assertAdmitted("let x = randomPert(1, 1, 1.0000000000000002)\nexit", "randomPert", outcome);
  const subnormal = randomDrawAlternatives(
    pausedDraw("let x = randomPert(0, 0, 5e-324)\nexit", "randomPert"),
  );
  assert.equal(subnormal.complete, true);
});
