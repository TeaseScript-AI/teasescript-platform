import assert from "node:assert/strict";
import test from "node:test";

import { compileSource } from "../../src/compiler.js";
import { run } from "../../src/runtime/engine.js";
import { createFreshRuntimeSession } from "../../src/runtime/session.js";
import { createFreshRuntimeSnapshot } from "../../src/runtime/snapshot/snapshot-construction.js";
import { runRetentionChild } from "../helpers/retention-witness.js";

/*
 * The say markup memos (`src/runtime/instructions/say.ts`): a literal say's markup is kept by the plan's instruction, for
 * every session of the plan; a computed text's markup only by its own session, for as long as that session lives.
 * Through the real engine: a session that repeats an interpolated text over several operations parses it once; a say
 * that interpolates a session's saved value leaves nothing of that text once the session is gone while its plan lives
 * (the retention witness); and a literal say shares its markup from session to session.
 */

test("a say that interpolates a session's data keeps nothing of it once the session is gone, while its plan lives", () => {
  const { report, hits } = runRetentionChild(
    new URL("../helpers/say-memo-retention-child.js", import.meta.url),
    ["ended", "kept"],
  );
  assert.deepEqual(report, { plans: 2, kept: 1 });
  assert.deepEqual(hits.get("ended"), [], "the ended session's text is held");
  assert.ok(hits.get("kept")!.length > 0, "the kept result's text is found");
});

/** The markup objects of the says of a session of `plan` whose saved value is `value`. */
function sayContents(source: string, value: string): readonly unknown[] {
  const plan = compileSource(source).plan!;
  const contents = (each: string) =>
    run(
      plan,
      createFreshRuntimeSnapshot(plan, { scriptStorage: [{ key: "probe", value: each }] }),
    ).events.flatMap((event) => (event.kind === "say" ? [event.content] : []));
  return [contents(value), contents(value)].map((says) => says[0]);
}

test("a session that repeats an interpolated text over several operations parses it once", () => {
  const plan = compileSource(
    'let probe = load "probe", default: ""\nfor i in 1..=3 {\n    say "Same: ${probe}", 1 s\n}\nexit',
  ).plan!;
  const session = createFreshRuntimeSession(plan, {
    baseDelayMs: 0,
    delayPerWordMs: 0,
    delayPerCharacterMs: 0,
    scriptStorage: [{ key: "probe", value: "value" }],
  });
  const contents: unknown[] = [];
  let operations = 0;
  const take = (events: readonly { readonly kind: string; readonly content?: unknown }[]) => {
    operations += 1;
    for (const event of events) if (event.kind === "say") contents.push(event.content);
  };
  for (;;) {
    take(session.run().events);
    const gate = session.view().foregroundAction;
    if (gate?.kind !== "chatPacingGate") break;
    take(session.observeTime(gate.deadlineMs).events);
  }
  assert.ok(operations > 2, "the says ran over several operations");
  assert.equal(contents.length, 3);
  assert.equal(contents[1], contents[0], "the second say reused the first's markup");
  assert.equal(contents[2], contents[0]);
});

test("a literal say shares its parsed markup from session to session; an interpolated one, by session", () => {
  const [literalFirst, literalSecond] = sayContents('say "Hello", instant\nexit', "x");
  assert.equal(literalFirst, literalSecond, "the literal say's markup is the memo's");
  const [interpolatedFirst, interpolatedSecond] = sayContents(
    'let probe = load "probe", default: ""\nsay "${probe}", instant\nexit',
    "x",
  );
  assert.notEqual(interpolatedFirst, interpolatedSecond, "another session parses its own");
  assert.deepEqual(interpolatedFirst, interpolatedSecond);
});
