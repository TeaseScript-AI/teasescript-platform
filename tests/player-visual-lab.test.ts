import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import {
  createVisualLabState,
  defineVisualLabRegistry,
  resetVisualLabState,
  updateVisualLabControl,
  VISUAL_LAB_CONTROLS,
  type VisualLabControl,
} from "../player/vue/src/devtools/visual-lab.js";

test("Visual Lab registry exposes every reusable control kind with unique valid defaults", () => {
  const ids = VISUAL_LAB_CONTROLS.map((control) => control.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual(
    new Set(VISUAL_LAB_CONTROLS.map((control) => control.kind)),
    new Set(["toggle", "select", "numeric", "range", "action", "tuning"]),
  );

  const state = createVisualLabState(VISUAL_LAB_CONTROLS);
  for (const control of VISUAL_LAB_CONTROLS) {
    if (control.kind === "action") {
      assert.equal(state.values[control.id], undefined);
    } else {
      assert.equal(state.values[control.id], control.defaultValue, control.id);
    }
  }
  assert.ok(Object.isFrozen(VISUAL_LAB_CONTROLS));
  assert.ok(Object.isFrozen(state));
  assert.ok(Object.isFrozen(state.values));
});

test("Visual Lab registry describes retained controls and excludes resolved experiments", () => {
  const labels = VISUAL_LAB_CONTROLS.map((control) => control.label);
  for (const retained of [
    "Accent",
    "Busy Action",
    "Busy control target",
    "Timer count",
    "Media transition",
    "Replace demo media",
    "Stage content",
    "Timer presentation",
    "Ordinary control availability",
    "Script update target",
    "Simulate script update",
    "Script update feedback",
    "Right-rail controls",
    "History messages",
    "Reset visual tests",
  ]) {
    assert.ok(labels.includes(retained), retained);
  }
  for (const obsolete of [
    "Ambient media colour",
    "Vignette",
    "Timer label placement",
    "Timer label content",
    "Always on",
  ]) {
    assert.ok(!labels.includes(obsolete), obsolete);
  }
  assert.equal(VISUAL_LAB_CONTROLS.filter((control) => control.kind === "tuning").length, 8);
  assert.deepEqual(
    VISUAL_LAB_CONTROLS.flatMap((control) =>
      control.kind === "action" && control.target.kind === "runtime-scenario"
        ? [control.target.scenarioId]
        : [],
    ),
    ["show-button", "choose", "ask-text", "ask-number", "skippable-pacing", "unskippable-pacing"],
  );
});

test("Visual Lab updates are immutable and reset to the supplied branch baseline", () => {
  const initial = createVisualLabState(VISUAL_LAB_CONTROLS, { accent: "teal", "stage-height": 60 });
  const selected = updateVisualLabControl(VISUAL_LAB_CONTROLS, initial, "accent", "plum");
  const tuned = updateVisualLabControl(VISUAL_LAB_CONTROLS, selected, "stage-height", 72);
  const ranged = updateVisualLabControl(VISUAL_LAB_CONTROLS, tuned, "history-messages", 120);

  assert.equal(initial.values.accent, "teal");
  assert.equal(initial.values["stage-height"], 60);
  assert.equal(ranged.values.accent, "plum");
  assert.equal(ranged.values["stage-height"], 72);
  assert.equal(ranged.values["history-messages"], 120);
  assert.notEqual(ranged.values, initial.values);

  const reset = resetVisualLabState(ranged);
  assert.equal(reset.values, initial.baseline);
  assert.equal(reset.values.accent, "teal");
  assert.equal(reset.values["stage-height"], 60);
  assert.equal(reset.values["history-messages"], 0);

  assert.throws(
    () => updateVisualLabControl(VISUAL_LAB_CONTROLS, reset, "timer-count", 0),
    /Invalid Visual Lab value/u,
  );
  assert.throws(
    () => updateVisualLabControl(VISUAL_LAB_CONTROLS, reset, "replace-demo-media", true),
    /do not retain a value/u,
  );
});

test("Visual Lab accepts a temporary comparison control without framework changes", () => {
  const temporary: VisualLabControl = {
    kind: "toggle",
    id: "temporary-shadow-treatment",
    label: "Temporary shadow treatment",
    description: "Compare a disposable Phase 2 treatment.",
    defaultValue: false,
  };
  const extended = defineVisualLabRegistry([...VISUAL_LAB_CONTROLS, temporary]);
  const initial = createVisualLabState(extended);
  const changed = updateVisualLabControl(extended, initial, "temporary-shadow-treatment", true);
  assert.equal(changed.values["temporary-shadow-treatment"], true);

  assert.throws(
    () => defineVisualLabRegistry([...VISUAL_LAB_CONTROLS, temporary, temporary]),
    /Duplicate Visual Lab control ID/u,
  );
});

test("Visual Lab component renders registry entries and emits typed integration events", async () => {
  const component = await readFile(
    resolve(process.cwd(), "player/vue/src/components/VisualLabTool.vue"),
    "utf8",
  );
  assert.match(component, /v-for="control in registry\.filter/u);
  assert.match(component, /action: \[controlId: string, target: VisualLabActionTarget\]/u);
  assert.match(component, /change: \[controlId: string, value: VisualLabControlValue\]/u);
  assert.match(component, /:aria-label="control\.label"/u);
  assert.doesNotMatch(
    component,
    /Ambient media colour|Vignette|Timer label placement|Timer label content|Always on/u,
  );
});
