import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { before } from "node:test";
import { effectScope, nextTick, reactive } from "vue";

import type * as CompileProject from "../../player/runtime/compile-project.js";
import type * as RuntimeAdapter from "../../player/runtime/runtime-adapter.js";
import type { RandomDrawView } from "../../src/index.js";
import { drawKey } from "../../player/debug/random-draw-identity.js";
import { coverageGaps, product } from "../helpers/family-coverage.js";
import { loadPlayerModule } from "../helpers/player-modules.js";

/*
 * L5i.4, final review F1's third sibling (C2's draw-identity family): every consumer of a draw's sameness derives it
 * from `useDebugRandom`'s `drawIdentity`, the picker component's key and state included (`drawKey`). The picker's state
 * of one draw (the typed value, a shuffle's order) starts anew exactly when the draw's identity differs: another
 * session's draw with the same ID does, the same draw shown again does not.
 */

interface PickerState {
  readonly typed: { value: string };
  readonly order: { value: number[] };
  move(position: number, direction: -1 | 1): void;
}
let useRandomDrawPickerState: (source: { drawKey: string; draw: RandomDrawView }) => PickerState;
let compiler: typeof CompileProject;
let adapter: typeof RuntimeAdapter;

before(async () => {
  const state = await loadPlayerModule("player/vue/src/debug/random/useRandomDrawPickerState.ts");
  assert.equal(typeof state.useRandomDrawPickerState, "function");
  // EVIDENCE: validation: Vite loaded the real source modules and the exports are callable; this is their tested API.
  useRandomDrawPickerState = state.useRandomDrawPickerState as typeof useRandomDrawPickerState;
  // EVIDENCE: validation: the bundle's compiler and adapter, from the same module graph.
  compiler = (await loadPlayerModule("player/runtime/compile-project.ts")) as typeof compiler;
  // EVIDENCE: validation: as above.
  adapter = (await loadPlayerModule("player/runtime/runtime-adapter.ts")) as typeof adapter;
});

// The family's axes, declared once.
/** How the picker's draw is replaced: by another session's draw with the same ID, the next draw, or itself again. */
const REPLACEMENTS = [
  "another session, same ID",
  "the same session's next draw",
  "the same draw again",
] as const;
/** What kind of draw it is, by the statement that draws, binding `name`. */
const KINDS = {
  chance: (name: string) => `let ${name} = chance(50)`,
  number: (name: string) => `let ${name} = random()`,
  shuffle: (name: string) => `let ${name} = ["a", "b", "c"]\n${name}.shuffle()`,
  list: (name: string) => `let ${name} = ["a", "b", "c"].random`,
} as const;
const KIND_NAMES = ["chance", "number", "shuffle", "list"] as const;
/** What the player did in the picker before the replacement. */
const STATES = ["typed", "reordered", "untouched"] as const;
const CASES = REPLACEMENTS.flatMap((replacement) =>
  KIND_NAMES.flatMap((kind) =>
    STATES.map((state) => ({
      replacement,
      kind,
      state,
      name: `${replacement}; ${kind}; ${state}`,
    })),
  ),
);

test("the picker-state family covers every replacement, draw kind and picker state", () => {
  const feasible = product({
    replacement: [...REPLACEMENTS],
    kind: [...KIND_NAMES],
    state: [...STATES],
  });
  const observed = CASES.map(({ replacement, kind, state }) => ({ replacement, kind, state }));
  assert.deepEqual(coverageGaps(feasible, observed, { tuples: true }), []);
  assert.equal(new Set(CASES.map((each) => each.name)).size, CASES.length);
  // The check fails a family that lacks a slice.
  const lacking = observed.filter(
    (each) => !(each.replacement === REPLACEMENTS[0] && each.kind === "shuffle"),
  );
  assert.ok(coverageGaps(feasible, lacking).some((gap) => gap.startsWith("missing pair")));
});

/** The draws a session of `statements` pauses at, in order, under a control that pauses at every draw. */
function draws(statements: string, count: number): RandomDrawView[] {
  const plan = compiler.compilePlayerProject(`${statements}\nshowButton "Done"\nexit`).plan;
  assert.ok(plan, "the fixture compiles");
  let session = adapter.createPlayerRuntimeSession(plan, { randomControl: {}, wallClockMs: 0 });
  const found: RandomDrawView[] = [];
  while (found.length < count) {
    const draw = session.state.randomDraw;
    assert.ok(draw, "the fixture pauses at its draw");
    found.push(draw);
    session = adapter.resumePlayerRuntimeRandomDraw(session, {
      drawId: draw.drawId,
      outcome: "natural",
    }).session;
  }
  return found;
}

for (const { replacement, kind, state, name } of CASES)
  test(`the picker's state of a draw: ${name}`, async () => {
    // The picker's draw: the first of two of its kind in session `s1`.
    const sequence = draws(`${KINDS[kind]("x")}\n${KINDS[kind]("y")}`, 2);
    const [first, next] = [sequence[0]!, sequence[1]!];
    const elsewhere = draws(KINDS[kind]("x"), 1)[0]!;
    const shown = { session: "s1", draw: first };
    const replaced =
      replacement === "another session, same ID"
        ? { session: "s2", draw: elsewhere }
        : replacement === "the same session's next draw"
          ? { session: "s1", draw: next }
          : { session: "s1", draw: structuredClone(first) };
    if (replacement === "another session, same ID") assert.equal(elsewhere.drawId, first.drawId);
    const keyOf = (each: typeof shown) =>
      drawKey({ session: each.session, site: each.draw.site, drawId: each.draw.drawId });
    const source = reactive({ drawKey: keyOf(shown), draw: first });
    const scope = effectScope();
    const picker = scope.run(() => useRandomDrawPickerState(source))!;
    try {
      if (state === "typed") picker.typed.value = "0.75";
      if (state === "reordered") picker.move(0, 1);
      const before = { typed: picker.typed.value, order: [...picker.order.value] };
      source.draw = replaced.draw;
      source.drawKey = keyOf(replaced);
      await nextTick();
      // The oracle, independent of the composable: the state starts anew exactly when the identity differs.
      const differs =
        replaced.session !== shown.session ||
        replaced.draw.drawId !== shown.draw.drawId ||
        replaced.draw.site !== shown.draw.site;
      const items =
        replaced.draw.support.kind === "order"
          ? replaced.draw.support.items.map((_, index) => index)
          : [];
      if (differs)
        assert.deepEqual(
          { typed: picker.typed.value, order: picker.order.value },
          { typed: "", order: items },
          `${name}: another draw starts anew`,
        );
      else
        assert.deepEqual(
          { typed: picker.typed.value, order: picker.order.value },
          before,
          `${name}: the same draw keeps what the player did`,
        );
    } finally {
      scope.stop();
    }
  });

// Every reader of a draw's ID in the picker's modules goes through `drawIdentity` or `drawKey`: the parent's key and
// the picker's state take `drawKey`; only `random-draw-identity.ts` reads `drawId` itself, and `useDebugRandom` its
// identity's.
const PICKER_MODULES = {
  "player/vue/src/shell/PlayerApp.vue": [],
  "player/vue/src/debug/random/RandomDrawPicker.vue": [],
  "player/vue/src/debug/random/useRandomDrawPickerState.ts": [],
  "player/vue/src/debug/random/randomDrawPresentation.ts": [],
  "player/vue/src/debug/random/useDebugRandom.ts": [/identity\.drawId/u],
  "player/debug/random-draw-identity.ts": [
    /readonly drawId: number;/u,
    /drawId: draw\.drawId/u,
    /identity\.drawId/u,
  ],
} as const;

test("every reader of a draw's ID in the picker's modules goes through its identity", () => {
  for (const [file, allowed] of Object.entries(PICKER_MODULES)) {
    const source = readFileSync(new URL(`../../../${file}`, import.meta.url), "utf8");
    for (const line of source.split("\n").filter((each) => /\bdrawId\b/u.test(each)))
      assert.ok(
        allowed.some((pattern) => pattern.test(line)),
        `${file}: a draw's ID read outside its identity: ${line.trim()}`,
      );
  }
  const app = readFileSync(
    new URL("../../../player/vue/src/shell/PlayerApp.vue", import.meta.url),
    "utf8",
  );
  const picker = /<RandomDrawPicker\b[\s\S]*?\/>/u.exec(app)?.[0] ?? "";
  assert.match(picker, /:key="randomPicker\.random\.drawKey\.value \?\? ''"/u);
  assert.match(picker, /:draw-key="randomPicker\.random\.drawKey\.value \?\? ''"/u);
});
