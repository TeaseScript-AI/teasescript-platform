import type {
  PlayerForegroundPresentation,
  PlayerForegroundOptionPresentation,
  PlayerMessagePresentation,
  PlayerPresentation,
  PlayerRightControlPresentation,
  PlayerSpeakerPresentation,
  PlayerTranscriptEntryPresentation,
  PlayerToolColumnState,
  PlayerToolDefinition,
  PlayerToolId,
} from "./model.js";

let nextLabOptionInfoId = 1;

export interface PlayerRenderTargets {
  readonly player: HTMLElement;
  readonly rightControls: HTMLElement;
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

  targets.rightControls.replaceChildren(
    ...orderRightControls(presentation.rightControls).map(createRightControl),
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

export function createMessageElement(
  message: PlayerMessagePresentation,
  speakers: Readonly<Record<string, PlayerSpeakerPresentation>>,
): HTMLElement {
  const speaker = speakers[message.speakerId];
  if (speaker === undefined) {
    throw new Error(`Unknown demo speaker: ${message.speakerId}`);
  }

  const article = document.createElement("article");
  article.className = `message${message.speakerId === "user" ? " user" : ""}`;
  article.dataset.transcriptEntryId = message.id;
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

export function createTranscriptEntryElement(
  entry: PlayerTranscriptEntryPresentation,
  speakers: Readonly<Record<string, PlayerSpeakerPresentation>>,
): HTMLElement {
  if (entry.kind === "message") return createMessageElement(entry, speakers);

  const event = document.createElement("article");
  event.className = "session-event";
  event.dataset.transcriptEntryId = entry.id;

  const text = document.createElement("span");
  text.className = "session-event-text";
  text.textContent = entry.text;
  event.append(text);
  return event;
}

export function renderForegroundControls(
  container: HTMLElement,
  presentation: PlayerForegroundPresentation | null,
): void {
  container.replaceChildren();
  if (presentation === null || presentation.kind === "ask-text" || presentation.kind === "ask-number") {
    container.hidden = true;
    delete container.dataset.foregroundKind;
    return;
  }

  container.hidden = false;
  container.dataset.foregroundKind = presentation.kind;

  const shell = document.createElement("div");
  shell.className = "foreground-shell";

  if (presentation.kind === "show-button") {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "foreground-button";
    button.dataset.foregroundButton = "";
    button.setAttribute("aria-label", presentation.accessibleName);
    button.textContent = presentation.label;
    if (presentation.authoredFill !== undefined) applyAuthoredControlFill(button, presentation.authoredFill);
    shell.append(button);
  } else {
    const group = document.createElement("div");
    group.className = "foreground-choice-buttons";
    group.dataset.foregroundChoiceButtons = "";
    group.setAttribute("role", "group");
    group.setAttribute("aria-label", presentation.accessibleName);

    for (const option of presentation.options) {
      const item = document.createElement("span");
      item.className = "foreground-choice-item";

      const button = document.createElement("button");
      button.type = "button";
      button.className = "foreground-button";
      button.dataset.foregroundChoice = option.id;
      button.dataset.foregroundLabel = option.label;
      button.textContent = option.label;
      if (option.authoredFill !== undefined) applyAuthoredControlFill(button, option.authoredFill);
      item.append(button);
      group.append(item);
    }
    shell.append(group);
  }

  container.append(shell);
}

export function matchForegroundChoiceByVisibleText(
  options: readonly PlayerForegroundOptionPresentation[],
  submittedText: string,
): PlayerForegroundOptionPresentation | null {
  const matches = options.filter((option) => option.label === submittedText);
  return matches.length === 1 ? (matches[0] ?? null) : null;
}

export function orderRightControls(
  controls: readonly PlayerRightControlPresentation[],
): readonly PlayerRightControlPresentation[] {
  return controls
    .map((control, index) => ({ control, index }))
    .sort((left, right) => {
      const leftHasPriority = left.control.priority !== undefined;
      const rightHasPriority = right.control.priority !== undefined;
      if (leftHasPriority !== rightHasPriority) return leftHasPriority ? -1 : 1;
      if (leftHasPriority && rightHasPriority) {
        const priorityDifference = (left.control.priority ?? 0) - (right.control.priority ?? 0);
        if (priorityDifference !== 0) return priorityDifference;
      }
      return left.index - right.index;
    })
    .map(({ control }) => control);
}

export function readableControlText(fill: string): "#000000" | "#ffffff" {
  const match = /^#(?<red>[0-9a-f]{2})(?<green>[0-9a-f]{2})(?<blue>[0-9a-f]{2})$/iu.exec(fill);
  if (match?.groups === undefined) throw new Error(`Unsupported authored control fill: ${fill}`);

  const channels = [match.groups.red, match.groups.green, match.groups.blue].map((channel) => {
    const encoded = Number.parseInt(channel ?? "00", 16) / 255;
    return encoded <= 0.04045 ? encoded / 12.92 : ((encoded + 0.055) / 1.055) ** 2.4;
  });
  const luminance = (channels[0] ?? 0) * 0.2126 + (channels[1] ?? 0) * 0.7152 + (channels[2] ?? 0) * 0.0722;
  const blackContrast = (luminance + 0.05) / 0.05;
  const whiteContrast = 1.05 / (luminance + 0.05);
  return blackContrast >= whiteContrast ? "#000000" : "#ffffff";
}

function createRightControl(control: PlayerRightControlPresentation): HTMLElement {
  switch (control.kind) {
    case "action": {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "action-button right-control";
      button.dataset.actionId = control.id;
      button.dataset.controlLabel = control.label;
      button.textContent = control.label;
      if (control.authoredFill !== undefined) applyAuthoredControlFill(button, control.authoredFill);
      return button;
    }
    case "toggle": {
      const label = document.createElement("label");
      label.className = "right-control right-toggle-control";
      label.dataset.controlId = control.id;
      label.dataset.controlLabel = control.label;
      label.dataset.recordUserHistory = String(control.recordUserHistory);

      const copy = document.createElement("span");
      copy.className = "right-control-label";
      copy.textContent = control.label;

      const input = document.createElement("input");
      input.type = "checkbox";
      input.setAttribute("role", "switch");
      input.checked = control.value;
      input.dataset.rightToggle = control.id;
      input.setAttribute("aria-label", control.label);

      const switchUi = document.createElement("span");
      switchUi.className = "right-switch-ui";
      switchUi.setAttribute("aria-hidden", "true");

      label.append(copy, input, switchUi);
      return label;
    }
    case "select": {
      const label = document.createElement("label");
      label.className = "right-control right-select-control";
      label.dataset.controlId = control.id;
      label.dataset.controlLabel = control.label;
      label.dataset.recordUserHistory = String(control.recordUserHistory);

      const copy = document.createElement("span");
      copy.className = "right-control-label";
      copy.textContent = control.label;

      const select = document.createElement("select");
      select.dataset.rightSelect = control.id;
      select.setAttribute("aria-label", control.label);
      for (const [value, text] of control.options) {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = text;
        option.selected = value === control.value;
        select.append(option);
      }

      label.append(copy, select);
      return label;
    }
    case "status": {
      const item = document.createElement("div");
      item.className = "right-control right-status";
      item.dataset.controlId = control.id;
      item.setAttribute("role", "status");

      const heading = document.createElement("span");
      heading.className = "right-control-label";
      heading.textContent = control.label;

      const detail = document.createElement("span");
      detail.className = "right-status-detail";
      detail.textContent = control.detail;

      item.append(heading, detail);
      if (control.progress !== undefined) {
        const progress = document.createElement("progress");
        progress.className = "right-status-progress";
        progress.max = 1;
        progress.value = Math.max(0, Math.min(1, control.progress));
        progress.setAttribute("aria-label", `${control.label} progress`);
        item.append(progress);
      }
      return item;
    }
  }
}

function applyAuthoredControlFill(element: HTMLElement, fill: string): void {
  element.dataset.authoredFill = "";
  element.style.setProperty("--authored-control-fill", fill);
  element.style.setProperty("--authored-control-hover", `color-mix(in oklab, ${fill} 88%, black)`);
  element.style.setProperty("--authored-control-pressed", `color-mix(in oklab, ${fill} 76%, black)`);
  element.style.setProperty("--authored-control-text", readableControlText(fill));
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
  const content = document.createElement("form");
  content.className = "lab-content";
  content.autocomplete = "off";
  content.addEventListener("submit", (event) => event.preventDefault());

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
      "Busy control target",
      "Apply the selected busy-in-place cue to each interactive right-rail control family.",
      "busy-target",
      [
        ["action", "Action"],
        ["toggle", "Toggle"],
        ["select", "Select"],
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
    createSelectOption(
      "Timer label content",
      "Exercise generic visible-order labels and an authored visible timer label.",
      "timer-label-content",
      [
        ["generic", "Generic"],
        ["authored", "Authored first timer"],
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
      "Media transition",
      "Exercise direct replacement and accepted fade/crossfade presentation without runtime media wiring.",
      "media-transition",
      [
        ["direct", "Direct"],
        ["fade", "Fade"],
        ["crossfade", "Crossfade"],
      ],
    ),
    createSelectOption(
      "Stage content",
      "Exercise populated and intentionally empty stage presentation without changing stage geometry.",
      "media-content",
      [
        ["present", "Media"],
        ["empty", "Empty"],
      ],
    ),
    createSelectOption(
      "Foreground interaction",
      "Exercise required foreground-control presentation without runtime wiring.",
      "foreground-fixture",
      [
        ["none", "None"],
        ["show-button", "showButton"],
        ["choose", "choose"],
        ["ask-text", "askText"],
        ["ask-number", "askNumber"],
      ],
    ),
    createSelectOption(
      "Timer presentation",
      "Exercise visible, mystery, and hidden timer presentation.",
      "timer-kind",
      [
        ["visible", "Visible"],
        ["mystery", "Mystery"],
        ["hidden", "Hidden"],
      ],
    ),
    createSelectOption(
      "Pacing gate",
      "Exercise Player click/Space skip presentation precedence.",
      "pacing-gate",
      [
        ["off", "Off"],
        ["skippable", "Skippable"],
        ["unskippable", "Unskippable"],
      ],
    ),
    createSelectOption(
      "Ordinary control availability",
      "Exercise Player-owned disabled styling without disabling mandatory foreground interactions.",
      "control-availability",
      [
        ["enabled", "Enabled"],
        ["disabled", "Disabled"],
      ],
    ),
    createSelectOption(
      "Script update target",
      "Exercise recognizable programmatic updates on each persistent value-control family.",
      "script-update-target",
      [
        ["toggle", "Toggle"],
        ["select", "Select"],
      ],
    ),
    createSelectOption(
      "Script update feedback",
      "Compare transient global, local, and combined programmatic-update feedback without changing control geometry.",
      "script-update-feedback",
      [
        ["toast", "Toast"],
        ["highlight", "Control highlight"],
        ["toast-highlight", "Toast + highlight"],
      ],
    ),
    createSelectOption(
      "Right-rail controls",
      "Hide fixture controls without changing backing/reservation so the empty-rail contract can be exercised.",
      "right-controls-visibility",
      [
        ["visible", "Visible"],
        ["none", "None"],
      ],
    ),
    createDemoNumberOption(
      "History messages",
      "Retained-history fixture for smart-follow and DOM-windowing tests.",
      "history-size",
      0,
      1,
      10_000,
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
    createTuningInput("Composer text", "Typing-field font size", "--composer-font-size", "rem", 0.125),
    createTuningInput("Composer lines", "Line-height cap", "--composer-max-lines", "lh", 1),
    createTuningInput("Composer viewport", "Viewport-height cap", "--composer-max-viewport-height", "dvh", 1),
  );

  const scriptUpdate = document.createElement("button");
  scriptUpdate.type = "button";
  scriptUpdate.className = "lab-reset";
  scriptUpdate.dataset.simulateScriptUpdate = "";
  scriptUpdate.textContent = "Simulate script update";

  const mediaReplacement = document.createElement("button");
  mediaReplacement.type = "button";
  mediaReplacement.className = "lab-reset";
  mediaReplacement.dataset.replaceDemoMedia = "";
  mediaReplacement.textContent = "Replace demo media";

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

  content.append(picker, options, tuning, scriptUpdate, mediaReplacement, note, fixed, reset);
  return content;
}

function createTuningInput(
  title: string,
  note: string,
  property: string,
  unit: string,
  step: number,
): HTMLElement {
  const row = document.createElement("div");
  row.className = "lab-tuning-row";
  const copy = createLabOptionCopy(title, note);

  const field = document.createElement("span");
  field.className = "lab-tuning-field";

  const input = document.createElement("input");
  input.type = "number";
  input.className = "lab-tuning-input";
  input.dataset.tuningProperty = property;
  input.dataset.tuningUnit = unit;
  input.step = String(step);
  input.autocomplete = "off";
  input.inputMode = "decimal";
  input.setAttribute("aria-label", `${title} (${unit})`);

  const unitElement = document.createElement("span");
  unitElement.className = "lab-tuning-unit";
  unitElement.textContent = unit;
  field.append(input, unitElement);

  row.append(copy, field);
  return row;
}

function createToggleOption(
  title: string,
  note: string,
  effect: string,
): HTMLElement {
  const row = document.createElement("div");
  row.className = "lab-option";
  const copy = createLabOptionCopy(title, note);

  const switchElement = document.createElement("label");
  switchElement.className = "switch";

  const input = document.createElement("input");
  input.type = "checkbox";
  input.dataset.effect = effect;
  input.setAttribute("aria-label", title);

  const switchUi = document.createElement("span");
  switchUi.className = "switch-ui";
  switchElement.append(input, switchUi);

  row.append(copy, switchElement);
  return row;
}

function createSelectOption(
  title: string,
  note: string,
  key: string,
  options: readonly (readonly [value: string, label: string])[],
): HTMLElement {
  const row = document.createElement("div");
  row.className = "lab-option";
  const copy = createLabOptionCopy(title, note);

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
  max?: number,
): HTMLElement {
  const row = document.createElement("div");
  row.className = "lab-option";
  const copy = createLabOptionCopy(title, note);

  const input = document.createElement("input");
  input.type = "number";
  input.className = "lab-tuning-input";
  input.dataset.demoNumber = key;
  input.min = String(min);
  input.step = String(step);
  input.autocomplete = "off";
  input.inputMode = "numeric";
  if (max !== undefined) input.max = String(max);
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
    createLayoutDebugModeToggle(),
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
      ["Right rail", "right-rail-scroll"],
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

function createLayoutDebugModeToggle(): HTMLElement {
  const row = document.createElement("div");
  row.className = "lab-option";
  const copy = createLabOptionCopy(
    "Debug mode",
    "Show or hide the selected layout diagnostics without clearing them.",
  );

  const switchElement = document.createElement("label");
  switchElement.className = "switch";

  const input = document.createElement("input");
  input.type = "checkbox";
  input.dataset.layoutDebugEnabled = "";
  input.setAttribute("aria-label", "Debug mode");

  const switchUi = document.createElement("span");
  switchUi.className = "switch-ui";
  switchElement.append(input, switchUi);

  row.append(copy, switchElement);
  return row;
}

function createLayoutDebugToggle(
  title: string,
  note: string,
  key: string,
): HTMLElement {
  const row = document.createElement("div");
  row.className = "lab-option";
  const copy = createLabOptionCopy(title, note);

  const switchElement = document.createElement("label");
  switchElement.className = "switch";

  const input = document.createElement("input");
  input.type = "checkbox";
  input.dataset.layoutDebug = key;
  input.setAttribute("aria-label", title);

  const switchUi = document.createElement("span");
  switchUi.className = "switch-ui";
  switchElement.append(input, switchUi);

  row.append(copy, switchElement);
  return row;
}

function createLabOptionCopy(title: string, note: string): HTMLElement {
  const copy = document.createElement("span");
  copy.className = "lab-option-copy";
  copy.dataset.labOptionCopy = "";

  const titleElement = document.createElement("span");
  titleElement.className = "lab-option-title";
  titleElement.textContent = title;

  const disclosure = document.createElement("span");
  disclosure.className = "lab-option-info";

  const trigger = document.createElement("button");
  trigger.type = "button";
  trigger.className = "lab-option-info-trigger";
  trigger.dataset.labOptionInfoTrigger = "";
  trigger.setAttribute("aria-label", `About ${title}`);
  trigger.setAttribute("aria-expanded", "false");
  trigger.textContent = "i";

  const noteElement = document.createElement("span");
  noteElement.className = "lab-option-note";
  noteElement.id = `lab-option-info-${nextLabOptionInfoId}`;
  nextLabOptionInfoId += 1;
  noteElement.setAttribute("role", "tooltip");
  noteElement.textContent = note;
  trigger.setAttribute("aria-describedby", noteElement.id);
  disclosure.append(trigger, noteElement);
  copy.append(titleElement, disclosure);
  return copy;
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
