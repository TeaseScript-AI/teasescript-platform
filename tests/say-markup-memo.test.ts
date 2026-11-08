import assert from "node:assert/strict";
import test from "node:test";

import { compileSource } from "../src/compiler.js";
import { run } from "../src/runtime/engine.js";
import { createFreshRuntimeSnapshot } from "../src/runtime/snapshot/snapshot-construction.js";
import { runRetentionChild } from "./helpers/retention-witness.js";

/*
 * The say markup memo (`src/runtime/instructions/say.ts`): it keeps the markup of a say whose text is a literal of the
 * plan, keyed by the plan's instruction, and never a text a session computed. Through the real engine: a say that
 * interpolates a session's saved value leaves nothing of that text once the session's result is gone while its plan
 * lives (the retention witness), and a literal say still shares its markup from session to session.
 */

test("a say that interpolates a session's data keeps nothing of it once the session is gone, while its plan lives", () => {
  const { report, hits } = runRetentionChild(
    new URL("./helpers/say-memo-retention-child.js", import.meta.url),
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

test("a literal say shares its parsed markup from session to session; an interpolated one parses its own", () => {
  const [literalFirst, literalSecond] = sayContents('say "Hello", instant\nexit', "x");
  assert.equal(literalFirst, literalSecond, "the literal say's markup is the memo's");
  const [interpolatedFirst, interpolatedSecond] = sayContents(
    'let probe = load "probe", default: ""\nsay "${probe}", instant\nexit',
    "x",
  );
  assert.notEqual(interpolatedFirst, interpolatedSecond, "an interpolated say keeps no memo");
  assert.deepEqual(interpolatedFirst, interpolatedSecond);
});
