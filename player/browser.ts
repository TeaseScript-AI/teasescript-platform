import {
  DEFAULT_VISUAL_PREFERENCES,
  DEMO_PRESENTATION,
  DEMO_TOOL_DEFINITIONS,
  INITIAL_TOOL_COLUMNS,
} from "./demo-session.js";
import type {
  LeftPanelMode,
  PlayerToolColumnState,
  PlayerToolId,
  RightPanelMode,
} from "./model.js";
import { toggleLeftPanelMode, toggleRightPanelMode } from "./panel-state.js";
import { renderPresentation, renderToolColumns } from "./render.js";
import {
  addToolColumn,
  closeToolColumn,
  selectToolColumn,
} from "./tool-columns.js";

const player = requiredElement<HTMLElement>("player", HTMLElement);
const leftToggle = requiredElement<HTMLButtonElement>("leftToggle", HTMLButtonElement);
const leftPanel = requiredElement<HTMLElement>("leftPanel", HTMLElement);
const leftScrim = requiredElement<HTMLElement>("leftScrim", HTMLElement);
const toolStrip = requiredElement<HTMLElement>("toolStrip", HTMLElement);
const toolStripScroll = requiredElement<HTMLElement>("toolStripScroll", HTMLElement);
const rightToggle = requiredElement<HTMLButtonElement>("rightToggle", HTMLButtonElement);
const transcript = requiredElement<HTMLElement>("transcript", HTMLElement);
const actions = requiredElement<HTMLElement>("actions", HTMLElement);
const timerText = requiredElement<HTMLElement>("timerText", HTMLElement);
const timerLabel = requiredElement<HTMLElement>("timerLabel", HTMLElement);
const sceneMedia = requiredElement<HTMLImageElement>("sceneMedia", HTMLImageElement);
const composerForm = requiredElement<HTMLFormElement>("composerForm", HTMLFormElement);

const narrowScreen = window.matchMedia("(max-width: 760px)");

let toolColumns: readonly PlayerToolColumnState[] = INITIAL_TOOL_COLUMNS;
let nextToolColumnNumber = 2;
let accentColor = DEFAULT_VISUAL_PREFERENCES.accentColor;
let ambientEnabled = DEFAULT_VISUAL_PREFERENCES.ambient;
let vignetteEnabled = DEFAULT_VISUAL_PREFERENCES.vignette;
let busyActionDemoEnabled = false;
let timerLabelDemoEnabled = false;
let presentation = DEMO_PRESENTATION;

renderPresentation(
  { player, transcript, actions, timerText, sceneMedia },
  presentation,
);
renderTools();
resetVisualLab();
syncPanelAccessibility();
syncLeftPreferredWidth();
syncLeftReserve();
void loadDemoMedia();

sceneMedia.addEventListener("error", () => {
  sceneMedia.hidden = true;
});

const leftPanelObserver = new ResizeObserver(syncLeftReserve);
leftPanelObserver.observe(leftPanel);

const toolStripObserver = new ResizeObserver(syncLeftPreferredWidth);
toolStripObserver.observe(toolStrip);

leftToggle.addEventListener("click", () => {
  const nextMode = toggleLeftPanelMode(currentLeftMode(), usesWideDefaultLayout());
  player.dataset.left = nextMode;
  syncPanelAccessibility();
  queueLeftReserveSync();
});

leftScrim.addEventListener("click", () => {
  if (narrowScreen.matches && player.dataset.left === "open") {
    player.dataset.left = "closed";
    syncPanelAccessibility();
    queueLeftReserveSync();
  }
});

rightToggle.addEventListener("click", () => {
  player.dataset.right = toggleRightPanelMode(currentRightMode(), usesWideDefaultLayout());
  syncPanelAccessibility();
});

narrowScreen.addEventListener("change", () => {
  player.dataset.left = "auto";
  player.dataset.right = "auto";
  syncPanelAccessibility();
  queueLeftReserveSync();
});

document.addEventListener("keydown", (event) => {
  if (
    event.key === "Escape"
    && narrowScreen.matches
    && player.dataset.left === "open"
  ) {
    player.dataset.left = "closed";
    syncPanelAccessibility();
    queueLeftReserveSync();
    leftToggle.focus();
  }
});

toolStrip.addEventListener("change", (event) => {
  const target = event.target;
  if (target instanceof HTMLSelectElement && target.matches("[data-tool-column-select]")) {
    const column = target.closest<HTMLElement>("[data-tool-column-id]");
    if (column === null) throw new Error("Tool selector is not inside a tool column.");
    if (!isPlayerToolId(target.value)) throw new Error(`Unknown Player tool: ${target.value}`);
    toolColumns = selectToolColumn(toolColumns, requiredDatasetValue(column, "toolColumnId"), target.value);
    renderTools();
    return;
  }

  if (target instanceof HTMLInputElement && target.matches("[data-effect]")) {
    const effect = requiredDatasetValue(target, "effect");
    setVisualOption(effect, target.checked);
    return;
  }

  if (target instanceof HTMLInputElement && target.matches("[data-demo-state]")) {
    const state = requiredDatasetValue(target, "demoState");
    setPresentationDemoState(state, target.checked);
  }
});

toolStrip.addEventListener("input", (event) => {
  const target = event.target;
  if (target instanceof HTMLInputElement && target.matches("[data-theme-color]")) {
    applyAccentColour(target.value);
    return;
  }

  if (target instanceof HTMLInputElement && target.matches("[data-tuning-property]")) {
    applyTuningValue(target);
  }
});

toolStrip.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof Element)) return;

  if (target.closest("[data-tool-column-add]") !== null) {
    appendToolColumn();
    return;
  }

  const close = target.closest<HTMLButtonElement>("[data-tool-column-close]");
  if (close !== null) {
    const column = close.closest<HTMLElement>("[data-tool-column-id]");
    if (column === null) throw new Error("Tool close button is not inside a tool column.");
    if (toolColumns.length === 1) {
      player.dataset.left = "closed";
      syncPanelAccessibility();
      queueLeftReserveSync();
      return;
    }
    toolColumns = closeToolColumn(toolColumns, requiredDatasetValue(column, "toolColumnId"));
    renderTools();
    return;
  }

  if (target.closest("[data-reset-visuals]") !== null) {
    resetVisualLab();
  }
});

composerForm.addEventListener("submit", (event) => event.preventDefault());

function appendToolColumn(): void {
  const id = `tool-column-${nextToolColumnNumber}`;
  nextToolColumnNumber += 1;
  toolColumns = addToolColumn(
    toolColumns,
    id,
    DEMO_TOOL_DEFINITIONS.map((tool) => tool.id),
  );
  renderTools("end");
}

function renderTools(scrollMode: "preserve" | "end" = "preserve"): void {
  const previousScrollLeft = toolStripScroll.scrollLeft;
  renderToolColumns(toolStrip, toolColumns, DEMO_TOOL_DEFINITIONS, presentation);
  syncVisualControls();

  requestAnimationFrame(() => {
    syncLeftPreferredWidth();
    if (scrollMode === "end") {
      toolStripScroll.scrollLeft = toolStripScroll.scrollWidth;
    } else {
      const maxScrollLeft = Math.max(0, toolStripScroll.scrollWidth - toolStripScroll.clientWidth);
      toolStripScroll.scrollLeft = Math.min(previousScrollLeft, maxScrollLeft);
    }
    syncLeftReserve();
  });
}

async function loadDemoMedia(): Promise<void> {
  presentation = await loadDemoPresentation();
  renderPresentation(
    { player, transcript, actions, timerText, sceneMedia },
    presentation,
  );
  renderTools();
}

interface DemoMediaResponse {
  readonly id: string;
  readonly src: string;
  readonly title: string;
}

async function loadDemoPresentation(): Promise<typeof DEMO_PRESENTATION> {
  try {
    const response = await fetch("/player/demo-media/random", { cache: "no-store" });
    if (!response.ok) return DEMO_PRESENTATION;
    const media = await response.json() as DemoMediaResponse;
    if (
      typeof media.id !== "string"
      || typeof media.src !== "string"
      || typeof media.title !== "string"
    ) {
      return DEMO_PRESENTATION;
    }

    return {
      ...DEMO_PRESENTATION,
      media: {
        ...DEMO_PRESENTATION.media,
        id: media.id,
        src: media.src,
        title: media.title,
      },
    };
  } catch {
    return DEMO_PRESENTATION;
  }
}

function usesWideDefaultLayout(): boolean {
  return !narrowScreen.matches;
}

function currentLeftMode(): LeftPanelMode {
  const value = player.dataset.left;
  if (value === "auto" || value === "open" || value === "closed") return value;
  throw new Error(`Invalid left panel mode: ${String(value)}`);
}

function currentRightMode(): RightPanelMode {
  const value = player.dataset.right;
  if (value === "auto" || value === "docked" || value === "overlay") return value;
  throw new Error(`Invalid right panel mode: ${String(value)}`);
}

function syncPanelAccessibility(): void {
  const wideDefault = usesWideDefaultLayout();

  const leftMode = currentLeftMode();
  const leftOpen = leftMode === "open" || (leftMode === "auto" && wideDefault);
  leftToggle.setAttribute("aria-expanded", String(leftOpen));

  const rightMode = currentRightMode();
  const rightDocked = rightMode === "docked" || (rightMode === "auto" && wideDefault);
  rightToggle.setAttribute("aria-pressed", String(rightDocked));
  rightToggle.setAttribute(
    "aria-label",
    rightDocked ? "Use overlay right panel background" : "Dock right panel background",
  );
}

function queueLeftReserveSync(): void {
  requestAnimationFrame(() => {
    syncLeftPreferredWidth();
    syncLeftReserve();
  });
}

function syncLeftPreferredWidth(): void {
  // Measure only intrinsic preferred width; CSS owns final allocation and content protection.
  const stripWidth = Math.ceil(toolStrip.getBoundingClientRect().width);
  const panelChromeWidth = Math.max(
    0,
    Math.ceil(leftPanel.getBoundingClientRect().width - toolStripScroll.clientWidth),
  );
  player.style.setProperty("--left-preferred", `${stripWidth + panelChromeWidth}px`);
}

function syncLeftReserve(): void {
  const reservesGridSpace = usesWideDefaultLayout() && currentLeftMode() !== "closed";
  const reserve = reservesGridSpace ? leftPanel.getBoundingClientRect().width : 0;
  player.style.setProperty("--left-reserve", `${reserve}px`);
}

function applyAccentColour(value: string): void {
  accentColor = value;
  document.documentElement.style.setProperty("--package-accent", value);
  syncVisualControls();
}

function setVisualOption(effect: string, enabled: boolean): void {
  switch (effect) {
    case "fx-ambient":
      ambientEnabled = enabled;
      break;
    case "fx-vignette":
      vignetteEnabled = enabled;
      break;
    default:
      throw new Error(`Unknown visual option: ${effect}`);
  }

  player.classList.toggle(effect, enabled);
  syncVisualControls();
}

function resetVisualLab(): void {
  accentColor = DEFAULT_VISUAL_PREFERENCES.accentColor;
  ambientEnabled = DEFAULT_VISUAL_PREFERENCES.ambient;
  vignetteEnabled = DEFAULT_VISUAL_PREFERENCES.vignette;
  busyActionDemoEnabled = false;
  timerLabelDemoEnabled = false;
  document.documentElement.style.setProperty("--package-accent", accentColor);
  player.classList.toggle("fx-ambient", ambientEnabled);
  player.classList.toggle("fx-vignette", vignetteEnabled);

  for (const input of toolStrip.querySelectorAll<HTMLInputElement>("[data-tuning-property]")) {
    player.style.removeProperty(requiredDatasetValue(input, "tuningProperty"));
  }

  syncVisualControls();
}

function setPresentationDemoState(state: string, enabled: boolean): void {
  switch (state) {
    case "busy-action":
      busyActionDemoEnabled = enabled;
      break;
    case "timer-label":
      timerLabelDemoEnabled = enabled;
      break;
    default:
      throw new Error(`Unknown presentation demo state: ${state}`);
  }

  syncVisualControls();
}

function applyTuningValue(input: HTMLInputElement): void {
  if (!Number.isFinite(input.valueAsNumber)) return;

  const property = requiredDatasetValue(input, "tuningProperty");
  const unit = requiredDatasetValue(input, "tuningUnit");
  player.style.setProperty(property, `${input.valueAsNumber}${unit}`);
  syncVisualControls();
}

function syncVisualControls(): void {
  for (const input of toolStrip.querySelectorAll<HTMLInputElement>("[data-theme-color]")) {
    input.value = accentColor;
  }

  for (const input of toolStrip.querySelectorAll<HTMLInputElement>("[data-effect]")) {
    switch (input.dataset.effect) {
      case "fx-ambient":
        input.checked = ambientEnabled;
        break;
      case "fx-vignette":
        input.checked = vignetteEnabled;
        break;
      default:
        throw new Error(`Unknown visual option: ${String(input.dataset.effect)}`);
    }
  }

  for (const input of toolStrip.querySelectorAll<HTMLInputElement>("[data-demo-state]")) {
    switch (input.dataset.demoState) {
      case "busy-action":
        input.checked = busyActionDemoEnabled;
        break;
      case "timer-label":
        input.checked = timerLabelDemoEnabled;
        break;
      default:
        throw new Error(`Unknown presentation demo state: ${String(input.dataset.demoState)}`);
    }
  }

  timerLabel.hidden = !timerLabelDemoEnabled;
  const firstAction = actions.querySelector<HTMLButtonElement>(".action-button");
  if (busyActionDemoEnabled) {
    firstAction?.setAttribute("aria-busy", "true");
  } else {
    firstAction?.removeAttribute("aria-busy");
  }

  const computed = getComputedStyle(player);
  for (const input of toolStrip.querySelectorAll<HTMLInputElement>("[data-tuning-property]")) {
    const property = requiredDatasetValue(input, "tuningProperty");
    const value = Number.parseFloat(computed.getPropertyValue(property));
    if (Number.isFinite(value)) input.value = String(value);
  }
}

function isPlayerToolId(value: string): value is PlayerToolId {
  return DEMO_TOOL_DEFINITIONS.some((tool) => tool.id === value);
}

function requiredDatasetValue(element: HTMLElement, key: string): string {
  const value = element.dataset[key];
  if (value === undefined || value.length === 0) {
    throw new Error(`Player element is missing data-${key}.`);
  }
  return value;
}

function requiredElement<T extends Element>(
  id: string,
  constructor: { new (...args: never[]): T },
): T {
  const element = document.getElementById(id);
  if (!(element instanceof constructor)) {
    throw new Error(`Missing or invalid Player element #${id}.`);
  }
  return element;
}
