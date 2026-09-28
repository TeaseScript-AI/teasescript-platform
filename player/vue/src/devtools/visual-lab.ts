export type VisualLabControlValue = boolean | number | string;

interface VisualLabControlBase {
  readonly id: string;
  readonly label: string;
  readonly description: string;
}

interface VisualLabValueControlBase<T extends VisualLabControlValue> extends VisualLabControlBase {
  readonly defaultValue: T;
}

export interface VisualLabToggleControl extends VisualLabValueControlBase<boolean> {
  readonly kind: "toggle";
}

export interface VisualLabSelectOption {
  readonly label: string;
  readonly value: string;
}

export interface VisualLabSelectControl extends VisualLabValueControlBase<string> {
  readonly kind: "select";
  readonly options: readonly VisualLabSelectOption[];
}

interface VisualLabBoundedNumberControl extends VisualLabValueControlBase<number> {
  readonly min: number;
  readonly max: number;
  readonly step: number;
}

export interface VisualLabNumericControl extends VisualLabBoundedNumberControl {
  readonly kind: "numeric";
}

export interface VisualLabRangeControl extends VisualLabBoundedNumberControl {
  readonly kind: "range";
}

export interface VisualLabTuningControl extends VisualLabBoundedNumberControl {
  readonly kind: "tuning";
  readonly cssProperty: `--${string}`;
  readonly unit: "dvh" | "lh" | "px" | "rem";
}

export type VisualLabRuntimeScenarioId =
  "ask-number" | "ask-text" | "choose" | "show-button" | "skippable-pacing" | "unskippable-pacing";

export type VisualLabActionTarget =
  | { readonly kind: "replace-demo-media" }
  | { readonly kind: "reset-visual-tests" }
  | { readonly kind: "simulate-script-update" }
  | { readonly kind: "runtime-scenario"; readonly scenarioId: VisualLabRuntimeScenarioId };

export interface VisualLabActionControl extends VisualLabControlBase {
  readonly kind: "action";
  readonly target: VisualLabActionTarget;
}

export type VisualLabValueControl =
  | VisualLabNumericControl
  | VisualLabRangeControl
  | VisualLabSelectControl
  | VisualLabToggleControl
  | VisualLabTuningControl;

export type VisualLabControl = VisualLabActionControl | VisualLabValueControl;
export type VisualLabRegistry = readonly VisualLabControl[];
export type VisualLabBaseline = Readonly<Record<string, VisualLabControlValue>>;

export interface VisualLabState {
  readonly baseline: VisualLabBaseline;
  readonly values: Readonly<Record<string, VisualLabControlValue>>;
}

export function defineVisualLabRegistry(controls: readonly VisualLabControl[]): VisualLabRegistry {
  const ids = new Set<string>();
  return Object.freeze(
    controls.map((control) => {
      if (control.id.length === 0) throw new Error("Visual Lab control IDs must not be empty.");
      if (ids.has(control.id)) throw new Error(`Duplicate Visual Lab control ID: ${control.id}`);
      ids.add(control.id);
      validateControl(control);
      return freezeControl(control);
    }),
  );
}

export function createVisualLabState(
  registry: VisualLabRegistry,
  branchBaseline: VisualLabBaseline = {},
): VisualLabState {
  const baseline: Record<string, VisualLabControlValue> = {};
  const knownIds = new Set(registry.map((control) => control.id));
  for (const id of Object.keys(branchBaseline)) {
    if (!knownIds.has(id)) throw new Error(`Unknown Visual Lab baseline control: ${id}`);
  }
  for (const control of registry) {
    if (control.kind === "action") continue;
    const value = branchBaseline[control.id] ?? control.defaultValue;
    validateControlValue(control, value);
    baseline[control.id] = value;
  }
  const frozenBaseline = Object.freeze(baseline);
  return Object.freeze({ baseline: frozenBaseline, values: frozenBaseline });
}

export function updateVisualLabControl(
  registry: VisualLabRegistry,
  state: VisualLabState,
  controlId: string,
  value: VisualLabControlValue,
): VisualLabState {
  const control = registry.find((candidate) => candidate.id === controlId);
  if (control === undefined) throw new Error(`Unknown Visual Lab control: ${controlId}`);
  if (control.kind === "action") {
    throw new Error(`Visual Lab action controls do not retain a value: ${controlId}`);
  }
  validateControlValue(control, value);
  if (state.values[controlId] === value) return state;
  return Object.freeze({
    baseline: state.baseline,
    values: Object.freeze({ ...state.values, [controlId]: value }),
  });
}

export function resetVisualLabState(state: VisualLabState): VisualLabState {
  if (state.values === state.baseline) return state;
  return Object.freeze({ baseline: state.baseline, values: state.baseline });
}

export const VISUAL_LAB_CONTROLS = defineVisualLabRegistry([
  select("accent", "Accent", "Compare the live package accent.", "rose", [
    ["rose", "Rose"],
    ["plum", "Plum"],
    ["teal", "Teal"],
  ]),
  select("busy-action", "Busy Action", "Compare in-place activity treatments.", "off", [
    ["off", "Off"],
    ["pulse", "Soft pulse"],
    ["sweep", "Slow sweep"],
    ["dots", "Three dots"],
    ["corner-dot", "Corner pulse"],
    ["spinner", "Corner spinner"],
    ["wash", "Soft wash"],
  ]),
  select(
    "busy-control-target",
    "Busy control target",
    "Exercise action, toggle, and select control families.",
    "action",
    [
      ["action", "Action"],
      ["toggle", "Toggle"],
      ["select", "Select"],
    ],
  ),
  numeric("timer-count", "Timer count", "Generate timers for layout pressure.", 1, 1, 24, 1),
  select(
    "media-transition",
    "Media transition",
    "Compare direct, fade, and crossfade media replacement.",
    "direct",
    [
      ["direct", "Direct"],
      ["fade", "Fade"],
      ["crossfade", "Crossfade"],
    ],
  ),
  action(
    "replace-demo-media",
    "Replace demo media",
    "Force another demo-media item so transitions can be repeated.",
    { kind: "replace-demo-media" },
  ),
  select(
    "stage-content",
    "Stage content",
    "Exercise populated and intentionally empty stage presentation.",
    "media",
    [
      ["media", "Media"],
      ["empty", "Empty"],
    ],
  ),
  select(
    "timer-presentation",
    "Timer presentation",
    "Exercise visible, mystery, and hidden timers.",
    "visible",
    [
      ["visible", "Visible"],
      ["mystery", "Mystery"],
      ["hidden", "Hidden"],
    ],
  ),
  select(
    "ordinary-control-availability",
    "Ordinary control availability",
    "Compare enabled and disabled ordinary controls.",
    "enabled",
    [
      ["enabled", "Enabled"],
      ["disabled", "Disabled"],
    ],
  ),
  select(
    "script-update-target",
    "Script update target",
    "Choose the persistent control family changed by the scenario.",
    "toggle",
    [
      ["toggle", "Toggle"],
      ["select", "Select"],
    ],
  ),
  action(
    "simulate-script-update",
    "Simulate script update",
    "Trigger the selected script-driven control update.",
    { kind: "simulate-script-update" },
  ),
  select(
    "script-update-feedback",
    "Script update feedback",
    "Compare toast, local highlight, and their combination.",
    "toast-highlight",
    [
      ["toast", "Toast"],
      ["highlight", "Control highlight"],
      ["toast-highlight", "Toast + highlight"],
    ],
  ),
  toggle(
    "right-rail-controls",
    "Right-rail controls",
    "Exercise populated and empty right-rail control presentation.",
    true,
  ),
  range(
    "history-messages",
    "History messages",
    "Adjust transcript pressure through the Vue transcript path.",
    0,
    0,
    10_000,
    1,
  ),
  runtimeScenario("scenario-show-button", "Run showButton scenario", "show-button"),
  runtimeScenario("scenario-choose", "Run choose scenario", "choose"),
  runtimeScenario("scenario-ask-text", "Run askText scenario", "ask-text"),
  runtimeScenario("scenario-ask-number", "Run askNumber scenario", "ask-number"),
  runtimeScenario("scenario-skippable-pacing", "Run skippable pacing scenario", "skippable-pacing"),
  runtimeScenario(
    "scenario-unskippable-pacing",
    "Run unskippable pacing scenario",
    "unskippable-pacing",
  ),
  tuning(
    "stage-height",
    "Stage height",
    "Tune the normal-composition stage baseline.",
    "--media-height-normal",
    "dvh",
    55,
    0,
    100,
    1,
  ),
  tuning(
    "overlay-stage-height",
    "Overlay stage height",
    "Tune fullscreen and low-height composition.",
    "--media-height-overlay",
    "dvh",
    64,
    0,
    100,
    1,
  ),
  tuning(
    "wide-tool-width",
    "Wide tool width",
    "Tune tool-column and overflow pressure.",
    "--tool-column-width",
    "px",
    300,
    160,
    640,
    1,
  ),
  tuning(
    "conversation-maximum-width",
    "Conversation maximum width",
    "Tune the readability cap.",
    "--conversation-max-width",
    "px",
    900,
    240,
    1_600,
    1,
  ),
  tuning(
    "conversation-minimum-width",
    "Conversation minimum width",
    "Tune responsive-pressure protection.",
    "--conversation-min-width",
    "px",
    380,
    160,
    900,
    1,
  ),
  tuning(
    "composer-text-size",
    "Composer text size",
    "Compare owner-facing composer typography.",
    "--composer-font-size",
    "rem",
    1,
    0.5,
    3,
    0.125,
  ),
  tuning(
    "composer-line-limit",
    "Composer line limit",
    "Tune composer growth and internal scrolling.",
    "--composer-max-lines",
    "lh",
    6,
    1,
    20,
    1,
  ),
  tuning(
    "composer-viewport-height-limit",
    "Composer viewport-height limit",
    "Tune low-height and software-keyboard pressure.",
    "--composer-max-viewport-height",
    "dvh",
    20,
    5,
    80,
    1,
  ),
  action("reset-visual-tests", "Reset visual tests", "Restore the current branch baseline.", {
    kind: "reset-visual-tests",
  }),
]);

function validateControl(control: VisualLabControl): void {
  if (control.kind === "action") return;
  if (control.kind === "toggle") {
    validateControlValue(control, control.defaultValue);
    return;
  }
  if (control.kind === "select") {
    if (control.options.length === 0) {
      throw new Error(`Visual Lab select must have options: ${control.id}`);
    }
    const optionValues = new Set(control.options.map((option) => option.value));
    if (optionValues.size !== control.options.length) {
      throw new Error(`Visual Lab select has duplicate options: ${control.id}`);
    }
    validateControlValue(control, control.defaultValue);
    return;
  }
  if (
    !Number.isFinite(control.min) ||
    !Number.isFinite(control.max) ||
    !Number.isFinite(control.step) ||
    control.min > control.max ||
    control.step <= 0
  ) {
    throw new Error(`Visual Lab numeric bounds are invalid: ${control.id}`);
  }
  validateControlValue(control, control.defaultValue);
}

function validateControlValue(control: VisualLabValueControl, value: VisualLabControlValue): void {
  if (control.kind === "toggle") {
    if (typeof value !== "boolean") throw invalidValue(control.id);
    return;
  }
  if (control.kind === "select") {
    if (typeof value !== "string" || !control.options.some((option) => option.value === value)) {
      throw invalidValue(control.id);
    }
    return;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) throw invalidValue(control.id);
  if (value < control.min || value > control.max) throw invalidValue(control.id);
  const steps = (value - control.min) / control.step;
  if (Math.abs(steps - Math.round(steps)) > 1e-8) throw invalidValue(control.id);
}

function invalidValue(controlId: string): Error {
  return new Error(`Invalid Visual Lab value for control: ${controlId}`);
}

function freezeControl(control: VisualLabControl): VisualLabControl {
  if (control.kind === "action") {
    return Object.freeze({ ...control, target: Object.freeze({ ...control.target }) });
  }
  if (control.kind === "select") {
    return Object.freeze({
      ...control,
      options: Object.freeze(control.options.map((option) => Object.freeze({ ...option }))),
    });
  }
  return Object.freeze({ ...control });
}

function select(
  id: string,
  label: string,
  description: string,
  defaultValue: string,
  options: readonly (readonly [value: string, label: string])[],
): VisualLabSelectControl {
  return {
    kind: "select",
    id,
    label,
    description,
    defaultValue,
    options: options.map(([value, optionLabel]) => ({ value, label: optionLabel })),
  };
}

function numeric(
  id: string,
  label: string,
  description: string,
  defaultValue: number,
  min: number,
  max: number,
  step: number,
): VisualLabNumericControl {
  return { kind: "numeric", id, label, description, defaultValue, min, max, step };
}

function toggle(
  id: string,
  label: string,
  description: string,
  defaultValue: boolean,
): VisualLabToggleControl {
  return { kind: "toggle", id, label, description, defaultValue };
}

function range(
  id: string,
  label: string,
  description: string,
  defaultValue: number,
  min: number,
  max: number,
  step: number,
): VisualLabRangeControl {
  return { kind: "range", id, label, description, defaultValue, min, max, step };
}

function tuning(
  id: string,
  label: string,
  description: string,
  cssProperty: `--${string}`,
  unit: VisualLabTuningControl["unit"],
  defaultValue: number,
  min: number,
  max: number,
  step: number,
): VisualLabTuningControl {
  return {
    kind: "tuning",
    id,
    label,
    description,
    cssProperty,
    unit,
    defaultValue,
    min,
    max,
    step,
  };
}

function action(
  id: string,
  label: string,
  description: string,
  target: VisualLabActionTarget,
): VisualLabActionControl {
  return { kind: "action", id, label, description, target };
}

function runtimeScenario(
  id: string,
  label: string,
  scenarioId: VisualLabRuntimeScenarioId,
): VisualLabActionControl {
  return action(id, label, "Run this scenario through the runtime adapter.", {
    kind: "runtime-scenario",
    scenarioId,
  });
}
