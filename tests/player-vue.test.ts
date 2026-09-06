import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import { DEMO_PRESENTATION } from "../player/demo-session.js";
import { createPlayerCoreState, reducePlayerCoreState } from "../player/vue/src/state.js";

test("Vue Player core keeps foreground submission deterministic", () => {
  const initial = createPlayerCoreState(DEMO_PRESENTATION);
  const invalid = reducePlayerCoreState(
    reducePlayerCoreState(initial, { type: "set-composer", value: "continue steadily" }),
    { type: "submit-composer" },
  );
  assert.match(invalid.composerFeedback, /visible option exactly/u);
  assert.equal(invalid.foreground?.kind, "choose");

  const completed = reducePlayerCoreState(
    reducePlayerCoreState(invalid, { type: "set-composer", value: "Continue steadily" }),
    { type: "submit-composer" },
  );
  assert.equal(completed.foreground, null);
  assert.equal(completed.composerValue, "");
  assert.equal(completed.transcriptEntries.at(-1)?.kind, "message");
  assert.equal(completed.transcriptEntries.at(-1)?.text, "Continue steadily");
});

test("Vue Player core records only controls that request user history", () => {
  const initial = createPlayerCoreState(DEMO_PRESENTATION);
  const toggled = reducePlayerCoreState(initial, {
    type: "change-right-toggle",
    checked: false,
    controlId: "strict-mode",
  });
  assert.equal(toggled.transcriptEntries.at(-1)?.kind, "session-event");
  assert.equal(toggled.transcriptEntries.at(-1)?.text, "You changed Strict mode to off.");

  const selected = reducePlayerCoreState(toggled, {
    type: "change-right-select",
    controlId: "intensity",
    value: "gentle",
  });
  assert.equal(selected.transcriptEntries.length, toggled.transcriptEntries.length);
  const intensity = selected.rightControls.find((control) => control.id === "intensity");
  assert.equal(intensity?.kind, "select");
  if (intensity?.kind === "select") assert.equal(intensity.value, "gentle");
});

test("Vue Player core appends action and ordinary composer responses", () => {
  let state = createPlayerCoreState({
    ...DEMO_PRESENTATION,
    foreground: { kind: "ask-text", accessibleName: "Text answer", hint: "Type your answer…" },
  });
  state = reducePlayerCoreState(state, { type: "set-composer", value: "A considered answer" });
  state = reducePlayerCoreState(state, { type: "submit-composer" });
  state = reducePlayerCoreState(state, { type: "activate-right-action", controlId: "continue" });
  assert.deepEqual(
    state.transcriptEntries.slice(-2).map((entry) => entry.text),
    ["A considered answer", "Continue"],
  );
});

test("Vue parity route has one component owner and excludes development fixtures", async () => {
  const root = process.cwd();
  const [core, main, index] = await Promise.all([
    readFile(resolve(root, "player/vue/src/PlayerCore.vue"), "utf8"),
    readFile(resolve(root, "player/vue/src/main.ts"), "utf8"),
    readFile(resolve(root, "player/vue/index.html"), "utf8"),
  ]);

  assert.match(core, /<PlayerTranscript/u);
  assert.match(core, /<PlayerForeground/u);
  assert.match(core, /<PlayerComposer/u);
  assert.match(core, /<PlayerRightRail/u);
  assert.match(main, /createApp\(App\)\.mount\("#app"\)/u);
  assert.doesNotMatch(main, /components-visual-lab|components-layout-debug/u);
  assert.doesNotMatch(core, /Visual Lab|Layout Debug/u);
  assert.doesNotMatch(index, /browser\.js/u);
});
