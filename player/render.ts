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
  readonly mediaFit: HTMLElement;
  readonly mediaCaption: HTMLElement;
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

  targets.mediaFit.textContent = presentation.media.fit;
  targets.mediaCaption.textContent = presentation.media.caption;

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
  const minutes = Math.floor(safeSeconds / 60);
  const seconds = safeSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
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

  header.append(selector, close);
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
    createVisualOption(
      "Ambient media colour",
      "Weak scene colour bleed around media.",
      "fx-ambient",
    ),
    createVisualOption(
      "Vignette",
      "Universal edge darkening for any media content.",
      "fx-vignette",
    ),
  );

  const note = document.createElement("p");
  note.className = "lab-note";
  note.textContent = "Cosmetic experiments only. Text wraps; tool sizing stays bounded.";

  const fixed = document.createElement("div");
  fixed.className = "lab-fixed-note";
  fixed.textContent = "Always on: accent · timer ring · refined controls · surface depth · speaker identity · speaker typography · micro-motion · transcript fade";

  const reset = document.createElement("button");
  reset.type = "button";
  reset.className = "lab-reset";
  reset.dataset.resetVisuals = "";
  reset.textContent = "Reset visual tests";

  content.append(picker, options, note, fixed, reset);
  return content;
}

function createVisualOption(
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

function createSceneTool(presentation: PlayerPresentation): HTMLElement {
  const section = document.createElement("section");
  section.className = "tool-section";

  const list = document.createElement("dl");
  list.className = "tool-kv";
  appendKeyValue(list, "Media", presentation.media.id);
  appendKeyValue(list, "Fit", presentation.media.fit);
  appendKeyValue(list, "Caption", presentation.media.caption);
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
