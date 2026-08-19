import type {
  PlayerActionPresentation,
  PlayerMessagePresentation,
  PlayerPresentation,
  PlayerSpeakerPresentation,
  PlayerToolColumnState,
  PlayerToolDefinition,
  PlayerToolId,
} from "./model.js";

export interface PlayerRenderTargets {
  readonly player: HTMLElement;
  readonly transcript: HTMLElement;
  readonly actions: HTMLElement;
  readonly timerText: HTMLElement;
  readonly sceneMedia: HTMLImageElement;
}

export function renderPresentation(
  targets: PlayerRenderTargets,
  presentation: PlayerPresentation,
): void {
  targets.player.style.setProperty("--scene-ambient", presentation.media.ambientColor);
  targets.player.style.setProperty("--media-fit", presentation.media.fit);
  targets.player.dataset.mediaFit = presentation.media.fit;

  const progress = timerProgressPercent(presentation.timer.remainingSeconds, presentation.timer.totalSeconds);
  targets.player.style.setProperty("--timer-progress", `${progress}%`);
  targets.timerText.textContent = formatTimer(presentation.timer.remainingSeconds);

  targets.sceneMedia.alt = presentation.media.title;
  if (presentation.media.src.length === 0) {
    targets.sceneMedia.hidden = true;
    targets.sceneMedia.removeAttribute("src");
  } else {
    targets.sceneMedia.hidden = false;
    targets.sceneMedia.src = presentation.media.src;
  }

  targets.transcript.replaceChildren(
    ...presentation.messages.map((message) => createMessage(message, presentation.speakers)),
  );

  targets.actions.replaceChildren(
    ...presentation.actions.map(createActionButton),
  );
}

export function timerProgressPercent(
  remainingSeconds: number,
  totalSeconds: number,
): number {
  if (!Number.isFinite(remainingSeconds) || !Number.isFinite(totalSeconds) || totalSeconds <= 0) {
    return 0;
  }
  const remainingRatio = Math.min(1, Math.max(0, remainingSeconds / totalSeconds));
  return Math.round((1 - remainingRatio) * 100);
}

export function formatTimer(totalSeconds: number): string {
  const safeSeconds = Number.isFinite(totalSeconds) ? Math.max(0, Math.floor(totalSeconds)) : 0;
  const seconds = safeSeconds % 60;
  if (safeSeconds < 3600) {
    return `${Math.floor(safeSeconds / 60)}:${String(seconds).padStart(2, "0")}`;
  }

  const hours = Math.floor(safeSeconds / 3600);
  const minutes = Math.floor((safeSeconds % 3600) / 60);
  return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function createMessage(
  message: PlayerMessagePresentation,
  speakers: Readonly<Record<string, PlayerSpeakerPresentation>>,
): HTMLElement {
  const speaker = speakers[message.speakerId];
  if (speaker === undefined) {
    throw new Error(`Unknown demo speaker: ${message.speakerId}`);
  }

  const article = document.createElement("article");
  article.className = `message${message.speakerId === "user" ? " user" : ""}`;
  article.dataset.messageId = message.id;
  article.style.setProperty("--speaker-accent", speaker.accent);
  article.style.setProperty("--speaker-font", speaker.fontFamily);

  const row = document.createElement("div");
  row.className = "message-row";

  const avatar = document.createElement("div");
  avatar.className = "speaker-avatar";
  avatar.textContent = speaker.avatar;
  avatar.setAttribute("aria-hidden", "true");

  const copy = document.createElement("div");
  copy.className = "message-copy";

  const name = document.createElement("div");
  name.className = "speaker-name";
  name.textContent = speaker.name;

  const body = document.createElement("div");
  body.className = "message-body";
  body.textContent = message.text;

  copy.append(name, body);
  row.append(...(message.speakerId === "user" ? [copy, avatar] : [avatar, copy]));
  article.append(row);
  return article;
}

function createActionButton(action: PlayerActionPresentation): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "action-button";
  button.dataset.actionId = action.id;
  button.textContent = action.label;
  return button;
}


export function renderToolColumns(
  strip: HTMLElement,
  columns: readonly PlayerToolColumnState[],
  tools: readonly PlayerToolDefinition[],
  presentation: PlayerPresentation,
): void {
  if (columns.length === 0) {
    const empty = document.createElement("p");
    empty.className = "tool-empty-state";
    empty.textContent = "No tool columns are open. Add one with + when you want another tool visible.";
    strip.replaceChildren(empty);
    return;
  }

  strip.replaceChildren(
    ...columns.map((column) => createToolColumn(column, tools, presentation)),
  );
}

function createToolColumn(
  column: PlayerToolColumnState,
  tools: readonly PlayerToolDefinition[],
  presentation: PlayerPresentation,
): HTMLElement {
  const section = document.createElement("section");
  section.className = "tool-column";
  section.dataset.toolColumnId = column.id;
  section.dataset.toolId = column.toolId ?? "";

  const header = document.createElement("header");
  header.className = "tool-column-header";

  const selector = document.createElement("select");
  selector.className = "tool-selector";
  selector.dataset.toolColumnSelect = "";
  selector.setAttribute("aria-label", "Tool shown in this column");

  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = "Choose tool…";
  placeholder.disabled = true;
  placeholder.selected = column.toolId === null;
  selector.append(placeholder);

  for (const tool of tools) {
    const option = document.createElement("option");
    option.value = tool.id;
    option.textContent = tool.label;
    option.selected = tool.id === column.toolId;
    selector.append(option);
  }

  const add = document.createElement("button");
  add.type = "button";
  add.className = "tool-column-add";
  add.dataset.toolColumnAdd = "";
  add.setAttribute("aria-label", "Add tool column");
  add.title = "Add tool column";
  add.textContent = "+";

  const close = document.createElement("button");
  close.type = "button";
  close.className = "tool-column-close";
  close.dataset.toolColumnClose = "";
  close.setAttribute("aria-label", "Close tool column");
  close.title = "Close tool column";
  close.textContent = "×";

  const body = document.createElement("div");
  body.className = "tool-column-body";
  body.dataset.toolBody = column.toolId ?? "";
  body.append(createToolBody(column.toolId, presentation));

  header.append(selector, add, close);
  section.append(header, body);
  return section;
}

function createToolBody(
  toolId: PlayerToolId | null,
  presentation: PlayerPresentation,
): Node {
  switch (toolId) {
    case null: {
      const placeholder = document.createElement("p");
      placeholder.className = "tool-placeholder";
      placeholder.textContent = "Choose a tool for this column.";
      return placeholder;
    }
    case "visuals":
      return createVisualTool();
    case "scene":
      return createSceneTool(presentation);
    case "layout-debug":
      return createLayoutDebugTool();
  }
}

function createVisualTool(): HTMLElement {
  const content = document.createElement("div");
  content.className = "lab-content";

  const picker = document.createElement("label");
  picker.className = "theme-picker";
  picker.append("Accent");

  const colour = document.createElement("input");
  colour.type = "color";
  colour.dataset.themeColor = "";
  colour.setAttribute("aria-label", "Player accent colour");
  picker.append(colour);

  const options = document.createElement("div");
  options.className = "lab-options";
  options.append(
    createToggleOption(
      "Ambient media colour",
      "Weak scene colour bleed around media.",
      "fx-ambient",
    ),
    createToggleOption(
      "Vignette",
      "Universal edge darkening for any media content.",
      "fx-vignette",
    ),
    createSelectOption(
      "Busy Action",
      "Compare low-distraction in-place activity cues.",
      "busy-style",
      [
        ["off", "Off"],
        ["pulse", "Soft pulse"],
        ["sweep", "Slow sweep"],
        ["dots", "Three dots"],
        ["corner-dot", "Corner pulse"],
        ["spinner", "Corner spinner"],
        ["wash", "Soft wash"],
      ],
    ),
    createSelectOption(
      "Timer label",
      "Compare generic visible-order label placement.",
      "timer-label",
      [
        ["off", "Off"],
        ["above", "Inside · above"],
        ["below", "Inside · below"],
      ],
    ),
    createDemoNumberOption(
      "Timer count",
      "Presentation fixture for label and rail-pressure testing.",
      "timer-count",
      1,
      1,
    ),
    createSelectOption(
      "Action alignment",
      "Compare current flow with viewport-centred Actions.",
      "action-alignment",
      [
        ["current", "Current"],
        ["viewport-center", "Viewport centre"],
      ],
    ),
  );

  const tuning = document.createElement("div");
  tuning.className = "lab-tuning";
  tuning.append(
    createTuningInput("Stage height", "Normal composition", "--media-height-normal", "dvh", 1),
    createTuningInput("Overlay stage", "Low-height/fullscreen composition", "--media-height-overlay", "dvh", 1),
    createTuningInput("Wide tool width", "Drawer remains viewport-bounded", "--tool-column-width", "px", 1),
    createTuningInput("Conversation max", "Readable width cap", "--conversation-max-width", "px", 1),
    createTuningInput("Conversation min", "Protected width floor", "--conversation-min-width", "px", 1),
    createTuningInput("Composer text", "Typing-field font size", "--composer-font-size", "px", 1),
    createTuningInput("Composer lines", "Line-height cap", "--composer-max-lines", "lh", 1),
    createTuningInput("Composer viewport", "Viewport-height cap", "--composer-max-viewport-height", "dvh", 1),
  );

  const note = document.createElement("p");
  note.className = "lab-note";
  note.textContent = "POC tuning only. Reset restores the maintained baseline values.";

  const fixed = document.createElement("div");
  fixed.className = "lab-fixed-note";

  const fixedTitle = document.createElement("span");
  fixedTitle.className = "lab-fixed-note-title";
  fixedTitle.textContent = "Always on";

  const fixedCopy = document.createElement("span");
  fixedCopy.className = "lab-fixed-note-copy";
  fixedCopy.textContent = "accent · timer ring · refined controls · surface depth · speaker identity · speaker typography · micro-motion · transcript fade";

  fixed.append(fixedTitle, fixedCopy);

  const reset = document.createElement("button");
  reset.type = "button";
  reset.className = "lab-reset";
  reset.dataset.resetVisuals = "";
  reset.textContent = "Reset visual tests";

  content.append(picker, options, tuning, note, fixed, reset);
  return content;
}

function createTuningInput(
  title: string,
  note: string,
  property: string,
  unit: string,
  step: number,
): HTMLLabelElement {
  const label = document.createElement("label");
  label.className = "lab-tuning-row";

  const copy = document.createElement("span");
  copy.className = "lab-option-copy";

  const titleElement = document.createElement("span");
  titleElement.className = "lab-option-title";
  titleElement.textContent = title;

  const noteElement = document.createElement("span");
  noteElement.className = "lab-option-note";
  noteElement.textContent = note;
  copy.append(titleElement, noteElement);

  const field = document.createElement("span");
  field.className = "lab-tuning-field";

  const input = document.createElement("input");
  input.type = "number";
  input.className = "lab-tuning-input";
  input.dataset.tuningProperty = property;
  input.dataset.tuningUnit = unit;
  input.step = String(step);
  input.setAttribute("aria-label", `${title} (${unit})`);

  const unitElement = document.createElement("span");
  unitElement.className = "lab-tuning-unit";
  unitElement.textContent = unit;
  field.append(input, unitElement);

  label.append(copy, field);
  return label;
}

function createToggleOption(
  title: string,
  note: string,
  effect: string,
): HTMLLabelElement {
  const label = document.createElement("label");
  label.className = "lab-option";

  const copy = document.createElement("span");
  copy.className = "lab-option-copy";

  const titleElement = document.createElement("span");
  titleElement.className = "lab-option-title";
  titleElement.textContent = title;

  const noteElement = document.createElement("span");
  noteElement.className = "lab-option-note";
  noteElement.textContent = note;
  copy.append(titleElement, noteElement);

  const switchElement = document.createElement("span");
  switchElement.className = "switch";

  const input = document.createElement("input");
  input.type = "checkbox";
  input.dataset.effect = effect;

  const switchUi = document.createElement("span");
  switchUi.className = "switch-ui";
  switchElement.append(input, switchUi);

  label.append(copy, switchElement);
  return label;
}

function createSelectOption(
  title: string,
  note: string,
  key: string,
  options: readonly (readonly [value: string, label: string])[],
): HTMLLabelElement {
  const row = document.createElement("label");
  row.className = "lab-option";

  const copy = document.createElement("span");
  copy.className = "lab-option-copy";

  const titleElement = document.createElement("span");
  titleElement.className = "lab-option-title";
  titleElement.textContent = title;

  const noteElement = document.createElement("span");
  noteElement.className = "lab-option-note";
  noteElement.textContent = note;
  copy.append(titleElement, noteElement);

  const select = document.createElement("select");
  select.className = "lab-select";
  select.dataset.demoSelect = key;
  select.setAttribute("aria-label", title);

  for (const [value, label] of options) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    select.append(option);
  }

  row.append(copy, select);
  return row;
}

function createDemoNumberOption(
  title: string,
  note: string,
  key: string,
  min: number,
  step: number,
): HTMLLabelElement {
  const row = document.createElement("label");
  row.className = "lab-option";

  const copy = document.createElement("span");
  copy.className = "lab-option-copy";

  const titleElement = document.createElement("span");
  titleElement.className = "lab-option-title";
  titleElement.textContent = title;

  const noteElement = document.createElement("span");
  noteElement.className = "lab-option-note";
  noteElement.textContent = note;
  copy.append(titleElement, noteElement);

  const input = document.createElement("input");
  input.type = "number";
  input.className = "lab-tuning-input";
  input.dataset.demoNumber = key;
  input.min = String(min);
  input.step = String(step);
  input.setAttribute("aria-label", title);

  row.append(copy, input);
  return row;
}

function createLayoutDebugTool(): HTMLElement {
  const content = document.createElement("div");
  content.className = "lab-content layout-debug-content";

  const options = document.createElement("div");
  options.className = "lab-options";
  options.append(
    createLayoutDebugToggle(
      "Grid tracks",
      "Show resolved Player grid boundaries and tracks.",
      "grid",
    ),
    createLayoutDebugToggle(
      "Region bounds",
      "Outline title, tools, stage, transcript, foreground controls, composer, and right rail.",
      "regions",
    ),
    createLayoutDebugToggle(
      "Reserved regions",
      "Shade left/right grid reservation and conversation overlay reserve.",
      "reserves",
    ),
    createLayoutDebugToggle(
      "Safe areas",
      "Shade the resolved device safe-area insets.",
      "safe-areas",
    ),
    createLayoutDebugToggle(
      "Overflow / scroll",
      "Highlight overflowing scroll owners and show their live scroll range.",
      "overflow",
    ),
    createLayoutDebugToggle(
      "Constraint vs measured",
      "Compare active layout constraints with the resulting measured geometry.",
      "constraints",
    ),
    createLayoutDebugToggle(
      "Visual viewport offsets",
      "Show visual-viewport offset and page-origin values for keyboard, zoom, and browser chrome diagnosis.",
      "viewport-offsets",
    ),
  );

  const conditions = createLayoutDebugReadout(
    "Active layout",
    [
      ["Composition", "composition"],
      ["Chrome", "chrome"],
      ["Orientation", "orientation"],
      ["Tools", "left-panel"],
      ["Right rail", "right-panel"],
      ["Fullscreen", "fullscreen"],
      ["Visual viewport", "visual-viewport"],
      ["Action layout", "action-layout"],
    ],
  );

  const measurements = createLayoutDebugReadout(
    "Measurements",
    [
      ["Viewport", "viewport"],
      ["Visual viewport", "visual-viewport-size"],
      ["Grid columns", "grid-columns"],
      ["Grid rows", "grid-rows"],
      ["Stage", "stage"],
      ["Transcript", "transcript"],
      ["Foreground", "foreground"],
      ["Composer", "composer"],
      ["Tools", "tools"],
      ["Right rail", "right-zone"],
      ["Reserves", "reserves"],
      ["Safe area", "safe-area"],
    ],
  );

  const overflow = createLayoutDebugReadout(
    "Overflow / scroll",
    [
      ["Player shell", "player-scroll"],
      ["Transcript", "transcript-scroll"],
      ["Tool strip", "tool-strip-scroll"],
      ["Tool bodies", "tool-bodies-scroll"],
      ["Composer input", "composer-scroll"],
      ["Actions", "actions-scroll"],
    ],
    "overflow",
  );

  const constraints = createLayoutDebugReadout(
    "Constraint vs measured",
    [
      ["Stage height", "constraint-stage"],
      ["Tool column", "constraint-tool-column"],
      ["Conversation", "constraint-conversation"],
      ["Composer input", "constraint-composer"],
      ["Right rail", "constraint-right-rail"],
    ],
    "constraints",
  );

  const viewportOffsets = createLayoutDebugReadout(
    "Visual viewport offsets",
    [
      ["Offset", "visual-offset"],
      ["Page origin", "visual-page-origin"],
    ],
    "viewport-offsets",
  );

  const note = document.createElement("p");
  note.className = "lab-note";
  note.textContent = "Development-only inspection. Layout Debug never changes Player geometry.";

  content.append(options, conditions, measurements, overflow, constraints, viewportOffsets, note);
  return content;
}

function createLayoutDebugToggle(
  title: string,
  note: string,
  key: string,
): HTMLLabelElement {
  const label = document.createElement("label");
  label.className = "lab-option";

  const copy = document.createElement("span");
  copy.className = "lab-option-copy";

  const titleElement = document.createElement("span");
  titleElement.className = "lab-option-title";
  titleElement.textContent = title;

  const noteElement = document.createElement("span");
  noteElement.className = "lab-option-note";
  noteElement.textContent = note;
  copy.append(titleElement, noteElement);

  const switchElement = document.createElement("span");
  switchElement.className = "switch";

  const input = document.createElement("input");
  input.type = "checkbox";
  input.dataset.layoutDebug = key;

  const switchUi = document.createElement("span");
  switchUi.className = "switch-ui";
  switchElement.append(input, switchUi);

  label.append(copy, switchElement);
  return label;
}

function createLayoutDebugReadout(
  title: string,
  rows: readonly (readonly [label: string, key: string])[],
  optionKey?: string,
): HTMLElement {
  const section = document.createElement("section");
  section.className = "layout-debug-readout-section";
  if (optionKey !== undefined) section.dataset.layoutDebugSection = optionKey;

  const heading = document.createElement("h3");
  heading.className = "layout-debug-heading";
  heading.textContent = title;

  const list = document.createElement("dl");
  list.className = "layout-debug-readout";

  for (const [label, key] of rows) {
    const term = document.createElement("dt");
    term.textContent = label;

    const value = document.createElement("dd");
    value.dataset.layoutDebugValue = key;
    value.textContent = "—";

    list.append(term, value);
  }

  section.append(heading, list);
  return section;
}

function createSceneTool(presentation: PlayerPresentation): HTMLElement {
  const section = document.createElement("section");
  section.className = "tool-section";

  const list = document.createElement("dl");
  list.className = "tool-kv";
  appendKeyValue(list, "Scene", presentation.media.title);
  appendKeyValue(list, "Media file", presentation.media.id);
  appendKeyValue(list, "Fit", presentation.media.fit);
  appendKeyValue(list, "Timer", formatTimer(presentation.timer.remainingSeconds));

  section.append(list);
  return section;
}

function appendKeyValue(list: HTMLDListElement, key: string, value: string): void {
  const term = document.createElement("dt");
  term.textContent = key;
  const description = document.createElement("dd");
  description.textContent = value;
  list.append(term, description);
}
