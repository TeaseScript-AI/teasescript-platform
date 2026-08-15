import { DEFAULT_VISUAL_PREFERENCES, DEMO_PRESENTATION } from "./demo-session.js";
import type { LeftPanelMode, RightPanelMode } from "./model.js";
import { toggleLeftPanelMode, toggleRightPanelMode } from "./panel-state.js";
import { renderPresentation } from "./render.js";

const player = requiredElement<HTMLElement>("player", HTMLElement);
const leftToggle = requiredElement<HTMLButtonElement>("leftToggle", HTMLButtonElement);
const leftScrim = requiredElement<HTMLElement>("leftScrim", HTMLElement);
const rightToggle = requiredElement<HTMLButtonElement>("rightToggle", HTMLButtonElement);
const transcript = requiredElement<HTMLElement>("transcript", HTMLElement);
const actions = requiredElement<HTMLElement>("actions", HTMLElement);
const timerText = requiredElement<HTMLElement>("timerText", HTMLElement);
const mediaFit = requiredElement<HTMLElement>("mediaFit", HTMLElement);
const mediaCaption = requiredElement<HTMLElement>("mediaCaption", HTMLElement);
const themeColor = requiredColourInput("themeColor");
const resetLab = requiredElement<HTMLButtonElement>("resetLab", HTMLButtonElement);
const composerForm = requiredElement<HTMLFormElement>("composerForm", HTMLFormElement);
const visualInputs = [...document.querySelectorAll<HTMLInputElement>("[data-effect]")];

const narrowScreen = window.matchMedia("(max-width: 760px)");

renderPresentation(
  { player, transcript, actions, timerText, mediaFit, mediaCaption },
  DEMO_PRESENTATION,
);
resetVisualLab();
syncPanelAccessibility();

leftToggle.addEventListener("click", () => {
  player.dataset.left = toggleLeftPanelMode(currentLeftMode(), usesWideDefaultLayout());
  syncPanelAccessibility();
});

leftScrim.addEventListener("click", () => {
  if (narrowScreen.matches && player.dataset.left === "open") {
    player.dataset.left = "closed";
    syncPanelAccessibility();
  }
});

rightToggle.addEventListener("click", () => {
  player.dataset.right = toggleRightPanelMode(currentRightMode(), usesWideDefaultLayout());
  syncPanelAccessibility();
});

narrowScreen.addEventListener("change", syncPanelAccessibility);

document.addEventListener("keydown", (event) => {
  if (
    event.key === "Escape"
    && narrowScreen.matches
    && player.dataset.left === "open"
  ) {
    player.dataset.left = "closed";
    syncPanelAccessibility();
    leftToggle.focus();
  }
});

themeColor.addEventListener("input", () => {
  applyAccentColour(themeColor.value);
});

for (const input of visualInputs) {
  input.addEventListener("change", () => {
    setVisualOption(input, input.checked);
  });
}

resetLab.addEventListener("click", resetVisualLab);
composerForm.addEventListener("submit", (event) => event.preventDefault());

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
}

function applyAccentColour(value: string): void {
  document.documentElement.style.setProperty("--theme-color", value);
  themeColor.value = value;
}

function setVisualOption(input: HTMLInputElement, enabled: boolean): void {
  input.checked = enabled;
  const effect = input.dataset.effect;
  if (effect === undefined || effect.length === 0) {
    throw new Error("Visual option is missing data-effect.");
  }
  player.classList.toggle(effect, enabled);
}

function resetVisualLab(): void {
  applyAccentColour(DEFAULT_VISUAL_PREFERENCES.accentColor);
  for (const input of visualInputs) {
    switch (input.dataset.effect) {
      case "fx-ambient":
        setVisualOption(input, DEFAULT_VISUAL_PREFERENCES.ambient);
        break;
      case "fx-vignette":
        setVisualOption(input, DEFAULT_VISUAL_PREFERENCES.vignette);
        break;
      default:
        throw new Error(`Unknown visual option: ${String(input.dataset.effect)}`);
    }
  }
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

function requiredColourInput(id: string): HTMLInputElement {
  const input = requiredElement<HTMLInputElement>(id, HTMLInputElement);
  if (input.type !== "color") {
    throw new Error(`Player element #${id} must be a colour input.`);
  }
  return input;
}
