import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import { DEMO_PRESENTATION } from "../player/demo-session.js";
import { createPlayerCoreState, reducePlayerCoreState } from "../player/vue/src/state.js";
import {
  isLeftPanelOpen,
  resolveLeftPanelModeOnNarrowTransition,
} from "../player/vue/src/composables/usePlayerLayout.js";

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

test("Vue Player tools prefer unused columns, allow duplicates, and retain the final column", () => {
  const initial = createPlayerCoreState(DEMO_PRESENTATION, ["scene", "visuals"]);
  assert.deepEqual(initial.toolColumns, [{ id: "tool-column-1", toolId: "scene" }]);

  const withSecond = reducePlayerCoreState(initial, { type: "add-tool-column" });
  assert.deepEqual(withSecond.toolColumns, [
    { id: "tool-column-1", toolId: "scene" },
    { id: "tool-column-2", toolId: "visuals" },
  ]);

  const withBlank = reducePlayerCoreState(withSecond, { type: "add-tool-column" });
  assert.deepEqual(withBlank.toolColumns.at(-1), { id: "tool-column-3", toolId: null });

  const duplicated = reducePlayerCoreState(withBlank, {
    type: "select-tool-column",
    id: "tool-column-3",
    toolId: "scene",
  });
  const withoutSecond = reducePlayerCoreState(duplicated, {
    type: "close-tool-column",
    id: "tool-column-2",
  });
  assert.deepEqual(withoutSecond.toolColumns, [
    { id: "tool-column-1", toolId: "scene" },
    { id: "tool-column-3", toolId: "scene" },
  ]);

  const retainedFinal = reducePlayerCoreState(withoutSecond, {
    type: "close-tool-column",
    id: "tool-column-1",
  });
  assert.deepEqual(retainedFinal.toolColumns, [{ id: "tool-column-3", toolId: "scene" }]);

  const closingLast = reducePlayerCoreState(retainedFinal, {
    type: "close-tool-column",
    id: "tool-column-3",
  });
  assert.deepEqual(closingLast.toolColumns, retainedFinal.toolColumns);
});

test("Vue panel mode keeps auto responsive while preserving explicit and focused intent", () => {
  const initialNarrowMode = resolveLeftPanelModeOnNarrowTransition("auto", true, false);
  assert.equal(initialNarrowMode, "auto");
  assert.equal(isLeftPanelOpen(initialNarrowMode, true), false);
  assert.equal(isLeftPanelOpen(initialNarrowMode, false), true);

  assert.equal(resolveLeftPanelModeOnNarrowTransition("closed", true, false), "closed");
  assert.equal(resolveLeftPanelModeOnNarrowTransition("closed", false, true), "closed");
  assert.equal(resolveLeftPanelModeOnNarrowTransition("auto", true, true), "open");
  assert.equal(resolveLeftPanelModeOnNarrowTransition("open", true, true), "open");
  assert.equal(resolveLeftPanelModeOnNarrowTransition("open", true, false), "closed");
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

test("Vue transcript uses TanStack's single virtual scroll and anchor owner", async () => {
  const root = process.cwd();
  const [transcript, styles, app, fixture] = await Promise.all([
    readFile(resolve(root, "player/vue/src/components/PlayerTranscript.vue"), "utf8"),
    readFile(resolve(root, "player/styles/components-transcript.css"), "utf8"),
    readFile(resolve(root, "player/vue/src/App.vue"), "utf8"),
    readFile(resolve(root, "player/vue/src/components/TranscriptStressFixture.vue"), "utf8"),
  ]);

  assert.match(transcript, /useVirtualizer/u);
  assert.match(transcript, /anchorTo: "end"/u);
  assert.match(transcript, /followOnAppend: true/u);
  assert.match(transcript, /getItemKey/u);
  assert.match(transcript, /:ref="measureElement"/u);
  assert.match(transcript, /scrollToEnd/u);
  assert.match(transcript, /isAtEnd/u);
  assert.match(transcript, /setPointerCapture/u);
  assert.match(transcript, /lostpointercapture/u);
  assert.match(transcript, /role="log"/u);
  assert.doesNotMatch(transcript, /column-reverse|scrollTop\s*\+=|scrollHeight\s*-/u);
  assert.match(styles, /\.transcript-virtualizer\s*\{/u);
  assert.match(styles, /inset-block-start:\s*0/u);
  assert.match(app, /transcriptStressFixture[\s\S]*transcript-stress/u);
  assert.match(fixture, /INITIAL_HISTORY_SIZE = 2_000/u);
  assert.match(fixture, /data-transcript-fixture="stress"/u);
});
