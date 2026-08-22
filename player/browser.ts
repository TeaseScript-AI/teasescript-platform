import {
  DEFAULT_VISUAL_PREFERENCES,
  DEMO_FOREGROUND_PRESENTATIONS,
  DEMO_PRESENTATION,
  DEMO_TOOL_DEFINITIONS,
  INITIAL_TOOL_COLUMNS,
  MAX_DEMO_HISTORY_MESSAGES,
  createDemoHistoryMessages,
} from "./demo-session.js";
import type {
  LeftPanelMode,
  PlayerControlAvailability,
  PlayerForegroundFixtureKind,
  PlayerForegroundPresentation,
  PlayerMessagePresentation,
  PlayerMediaTransitionFixture,
  PlayerPacingFixture,
  PlayerRightControlPresentation,
  PlayerRightSelectPresentation,
  PlayerRightTogglePresentation,
  PlayerTimerKind,
  PlayerToolColumnState,
  PlayerToolId,
  RightPanelMode,
} from "./model.js";
import { createLayoutDebugController } from "./layout-debug.js";
import { canDockRightRail, toggleLeftPanelMode, toggleRightPanelMode } from "./panel-state.js";
import {
  matchForegroundChoiceByVisibleText,
  renderForegroundControls,
  renderPresentation,
  renderToolColumns,
} from "./render.js";
import {
  addToolColumn,
  closeToolColumn,
  selectToolColumn,
} from "./tool-columns.js";
import { createTranscriptController } from "./transcript-controller.js";
import { createRightRailLayoutController } from "./right-rail-layout.js";

const player = requiredElement<HTMLElement>("player", HTMLElement);
const leftToggle = requiredElement<HTMLButtonElement>("leftToggle", HTMLButtonElement);
const leftPanel = requiredElement<HTMLElement>("leftPanel", HTMLElement);
const leftScrim = requiredElement<HTMLElement>("leftScrim", HTMLElement);
const toolStrip = requiredElement<HTMLElement>("toolStrip", HTMLElement);
const toolStripScroll = requiredElement<HTMLElement>("toolStripScroll", HTMLElement);
const rightToggle = requiredElement<HTMLButtonElement>("rightToggle", HTMLButtonElement);
const rightZone = requiredElement<HTMLElement>("rightZone", HTMLElement);
const compactTimerHost = requiredElement<HTMLElement>("compactTimerHost", HTMLElement);
const timerWrap = requiredElement<HTMLElement>("timerWrap", HTMLElement);
const transcript = requiredElement<HTMLElement>("transcript", HTMLElement);
const returnToLatest = requiredElement<HTMLButtonElement>("returnToLatest", HTMLButtonElement);
const playerNotification = requiredElement<HTMLElement>("playerNotification", HTMLElement);
const foregroundControls = requiredElement<HTMLElement>("foregroundControls", HTMLElement);
const actions = requiredElement<HTMLElement>("actions", HTMLElement);
const timerList = requiredElement<HTMLElement>("timerList", HTMLElement);
const timerText = requiredElement<HTMLElement>("timerText", HTMLElement);
const sceneMedia = requiredElement<HTMLImageElement>("sceneMedia", HTMLImageElement);
const composer = requiredElement<HTMLElement>("composer", HTMLElement);
const composerForm = requiredElement<HTMLFormElement>("composerForm", HTMLFormElement);
const composerInput = requiredQuery<HTMLTextAreaElement>(composerForm, "textarea", HTMLTextAreaElement);
const sendButton = requiredQuery<HTMLButtonElement>(composerForm, ".send-button", HTMLButtonElement);
const composerFeedback = requiredElement<HTMLElement>("composerFeedback", HTMLElement);
const fullscreenToggle = requiredElement<HTMLButtonElement>("fullscreenToggle", HTMLButtonElement);

const narrowScreen = window.matchMedia("(max-width: 760px)");
const transcriptController = createTranscriptController(transcript, returnToLatest);
const rightRailLayout = createRightRailLayoutController({
  rightZone,
  compactTimerHost,
  timerWrap,
  timerList,
  actions,
});

let toolColumns: readonly PlayerToolColumnState[] = INITIAL_TOOL_COLUMNS;
let nextToolColumnNumber = 2;
let accentColor = DEFAULT_VISUAL_PREFERENCES.accentColor;
let ambientEnabled = DEFAULT_VISUAL_PREFERENCES.ambient;
let vignetteEnabled = DEFAULT_VISUAL_PREFERENCES.vignette;
let busyActionDemoStyle = "off";
let busyControlDemoTarget: "action" | "toggle" | "select" = "action";
let timerLabelDemoPlacement = "below";
let timerLabelContentDemo: "generic" | "authored" = "authored";
let timerCountDemo = 1;
let timerKindDemo: PlayerTimerKind = "visible";
let mediaTransitionDemo: PlayerMediaTransitionFixture = "direct";
let mediaContentDemo: "present" | "empty" = "present";
let foregroundDemoKind: PlayerForegroundFixtureKind = "choose";
let pacingGateDemo: PlayerPacingFixture = "off";
let controlAvailabilityDemo: PlayerControlAvailability = "enabled";
let historySizeDemo = DEMO_PRESENTATION.messages.length;
let presentation = DEMO_PRESENTATION;
let rightControlsDemo: readonly PlayerRightControlPresentation[] = DEMO_PRESENTATION.rightControls;
let rightControlsVisibleDemo = true;
let scriptUpdateDemoTarget: "toggle" | "select" = "toggle";
let scriptUpdateFeedbackDemo: ScriptUpdateFeedbackDemo = "toast-highlight";
let activityMessages: readonly PlayerMessagePresentation[] = [];
let pacingMessages: readonly PlayerMessagePresentation[] = [];
let pacingSequenceIndex = 0;
let pacingTimer: ReturnType<typeof setTimeout> | null = null;
let scriptUpdateFeedbackTimer: ReturnType<typeof setTimeout> | null = null;
let viewportSettleTimer: ReturnType<typeof setTimeout> | null = null;
let activitySequence = 1;
let layoutDebugActivated = false;
let carouselPresentationSyncQueued = false;
let rightCompositionSyncQueued = false;
let visibleForegroundHeight = 0;

type ScriptUpdateFeedbackDemo = "toast" | "highlight" | "badge" | "toast-highlight" | "toast-badge";

const PACING_MESSAGE_DELAY_MS = 1_500;
const SCRIPT_UPDATE_FEEDBACK_MS = 2_400;

const layoutDebug = createLayoutDebugController({
  player,
  toolStrip,
  toolStripScroll,
  titleControls: requiredElement<HTMLElement>("titleControls", HTMLElement),
  leftPanel,
  mediaArea: requiredElement<HTMLElement>("mediaArea", HTMLElement),
  transcript,
  composer,
  rightZone,
  actions,
  timerList,
});

renderCorePresentation();
renderTools();
resetVisualLab();
syncComposerInputSize();
syncPanelAccessibility();
syncLeftPreferredWidth();
syncLeftReserve();
syncOverlayChromeMode();
syncRightComposition();
syncFullscreenControl();
layoutDebug.sync();
void loadDemoMedia();

sceneMedia.addEventListener("error", () => {
  sceneMedia.hidden = true;
});

new ResizeObserver(() => {
  syncLeftReserve();
  queueRightCompositionSync();
}).observe(leftPanel);
new ResizeObserver(syncLeftPreferredWidth).observe(toolStrip);
new ResizeObserver(queueCarouselPresentationSync).observe(toolStripScroll);
new ResizeObserver(queueCarouselPresentationSync).observe(toolStrip);
new ResizeObserver(queueCarouselPresentationSync).observe(foregroundControls);
let composerInlineSize = -1;
new ResizeObserver(() => {
  const nextInlineSize = composer.clientWidth;
  if (nextInlineSize !== composerInlineSize) {
    composerInlineSize = nextInlineSize;
    syncComposerInputSize();
  }
  transcriptController.sync();
  layoutDebug.queueSync();
}).observe(composer);

leftToggle.addEventListener("click", () => {
  player.dataset.left = toggleLeftPanelMode(currentLeftMode(), usesWideDefaultLayout());
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
  player.dataset.right = toggleRightPanelMode(currentRightMode(), usesDockedRightComposition());
  syncRightComposition();
  syncPanelAccessibility();
});

fullscreenToggle.addEventListener("click", () => {
  void toggleFullscreen();
});

document.addEventListener("fullscreenchange", () => {
  syncFullscreenControl();
  syncOverlayChromeMode();
  layoutDebug.queueSync();
});

narrowScreen.addEventListener("change", () => {
  if (narrowScreen.matches && currentLeftMode() !== "closed") {
    player.dataset.left = leftPanel.contains(document.activeElement) ? "open" : "closed";
  } else if (!narrowScreen.matches && currentLeftMode() === "auto") {
    player.dataset.left = "closed";
  }
  syncPanelAccessibility();
  queueLeftReserveSync();
});

window.addEventListener("resize", () => {
  syncComposerInputSize();
  syncOverlayChromeMode();
  queueRightCompositionSync();
  queueCarouselPresentationSync();
});
window.visualViewport?.addEventListener("resize", () => {
  syncComposerInputSize();
  syncOverlayChromeMode();
  queueRightCompositionSync();
  queueCarouselPresentationSync();
});
window.visualViewport?.addEventListener("scroll", syncViewportTransition);
window.addEventListener("orientationchange", syncViewportTransition);

composerInput.addEventListener("focus", syncViewportTransition);
composerInput.addEventListener("blur", syncViewportTransition);
composerInput.addEventListener("input", () => {
  syncComposerInputSize();
  syncOverlayChromeMode();
});

player.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof Element)) return;
  if (isInteractiveTarget(target)) return;
  if (window.getSelection()?.toString().length) return;

  if (
    foregroundDemoKind === "none"
    && pacingGateDemo === "skippable"
    && hasPendingPacingMessage()
    && isPacingBackgroundTarget(target)
  ) {
    settlePacingGate();
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && closeLabOptionInfo()) return;
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

document.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof Element)) return;
  if (target.closest("[data-lab-option-copy]") === null) closeLabOptionInfo();
});

composerInput.addEventListener("keydown", (event) => {
  if (event.isComposing) return;

  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    composerForm.requestSubmit();
    return;
  }

  if (
    event.key === " "
    && composerInput.value.length === 0
    && composerInput.selectionStart === composerInput.selectionEnd
  ) {
    const foreground = currentForegroundPresentation();
    if (foreground?.kind === "show-button") {
      event.preventDefault();
      completeForeground(foreground.label);
      return;
    }
    if (foreground === null && pacingGateDemo === "skippable" && hasPendingPacingMessage()) {
      event.preventDefault();
      settlePacingGate();
    }
  }
});

composerForm.addEventListener("submit", (event) => {
  event.preventDefault();
  submitComposerValue();
});

foregroundControls.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const showButton = target.closest<HTMLButtonElement>("[data-foreground-button]");
  if (showButton !== null && !showButton.disabled) {
    completeForeground(showButton.textContent ?? "");
    return;
  }
  const choice = target.closest<HTMLButtonElement>("[data-foreground-choice]");
  if (choice !== null && !choice.disabled) {
    completeForeground(requiredDatasetValue(choice, "foregroundLabel"));
  }
});

actions.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const action = target.closest<HTMLButtonElement>("[data-action-id]");
  if (action === null || action.disabled) return;
  appendActivityMessage(action.dataset.controlLabel ?? action.textContent ?? "Action");
});

actions.addEventListener("change", (event) => {
  const target = event.target;
  if (target instanceof HTMLInputElement && target.matches("[data-right-toggle]") && !target.disabled) {
    rightControlsDemo = rightControlsDemo.map((control) => {
      if (control.kind !== "toggle" || control.id !== target.dataset.rightToggle) return control;
      return { ...control, value: target.checked };
    });
    const control = rightControlsDemo.find((item) => item.kind === "toggle" && item.id === target.dataset.rightToggle);
    if (control?.kind === "toggle" && control.recordUserHistory) {
      appendActivityMessage(`${control.label}: ${target.checked ? "on" : "off"}`);
    }
    renderRightControls();
    return;
  }

  if (target instanceof HTMLSelectElement && target.matches("[data-right-select]") && !target.disabled) {
    rightControlsDemo = rightControlsDemo.map((control) => {
      if (control.kind !== "select" || control.id !== target.dataset.rightSelect) return control;
      return { ...control, value: target.value };
    });
    const control = rightControlsDemo.find((item) => item.kind === "select" && item.id === target.dataset.rightSelect);
    if (control?.kind === "select" && control.recordUserHistory) {
      const label = control.options.find(([value]) => value === target.value)?.[1] ?? target.value;
      appendActivityMessage(`${control.label}: ${label}`);
    }
    renderRightControls();
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
    setVisualOption(requiredDatasetValue(target, "effect"), target.checked);
    return;
  }

  if (target instanceof HTMLInputElement && target.matches("[data-layout-debug-enabled]")) {
    layoutDebug.setEnabled(target.checked);
    return;
  }

  if (target instanceof HTMLInputElement && target.matches("[data-layout-debug]")) {
    layoutDebug.setOption(requiredDatasetValue(target, "layoutDebug"), target.checked);
    return;
  }

  if (target instanceof HTMLSelectElement && target.matches("[data-demo-select]")) {
    setPresentationDemoSelection(requiredDatasetValue(target, "demoSelect"), target.value);
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
    return;
  }
  if (target instanceof HTMLInputElement && target.matches("[data-demo-number]")) {
    applyDemoNumber(target);
  }
});

toolStrip.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof Element)) return;

  const infoTrigger = target.closest<HTMLButtonElement>("[data-lab-option-info-trigger]");
  if (infoTrigger !== null) {
    toggleLabOptionInfo(infoTrigger);
    return;
  }

  const infoCopy = target.closest<HTMLElement>("[data-lab-option-copy]");
  if (infoCopy !== null && target.closest(".lab-option-info") === null) {
    const trigger = infoCopy.querySelector<HTMLButtonElement>("[data-lab-option-info-trigger]");
    if (trigger === null) throw new Error("Visual Lab information copy is missing its trigger.");
    toggleLabOptionInfo(trigger);
    return;
  }

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

  if (target.closest("[data-simulate-script-update]") !== null) {
    simulateScriptUpdate();
    return;
  }

  if (target.closest("[data-replace-demo-media]") !== null) {
    void replaceDemoMedia();
    return;
  }

  if (target.closest("[data-reset-visuals]") !== null) resetVisualLab();
});

function currentRenderedPresentation(): typeof DEMO_PRESENTATION {
  return {
    ...presentation,
    media: mediaContentDemo === "present"
      ? presentation.media
      : { ...presentation.media, src: "", title: "Empty stage" },
    rightControls: rightControlsVisibleDemo ? rightControlsDemo : [],
  };
}

function renderCorePresentation(): void {
  renderPresentation(
    { player, rightControls: actions, timerText, sceneMedia },
    currentRenderedPresentation(),
  );
  syncTranscript();
  syncForegroundPresentation();
  syncDemoTimers();
  syncControlAvailability();
  rightRailLayout.queueSync();
}

function renderRightControls(): void {
  renderPresentation(
    { player, rightControls: actions, timerText, sceneMedia },
    currentRenderedPresentation(),
  );
  syncDemoTimers();
  syncControlAvailability();
  syncBusyAction();
  rightRailLayout.queueSync();
  layoutDebug.queueSync();
}

function syncTranscript(): void {
  transcriptController.setMessages(
    [...createDemoHistoryMessages(historySizeDemo), ...pacingMessages, ...activityMessages],
    presentation.speakers,
  );
}

function appendActivityMessage(text: string): void {
  const message: PlayerMessagePresentation = {
    id: `activity-${activitySequence}`,
    speakerId: "user",
    text,
  };
  activitySequence += 1;
  activityMessages = [...activityMessages, message];
  transcriptController.appendMessage(message, presentation.speakers);
}

function currentForegroundPresentation(): PlayerForegroundPresentation | null {
  return foregroundDemoKind === "none" ? null : DEMO_FOREGROUND_PRESENTATIONS[foregroundDemoKind];
}

function syncForegroundPresentation(): void {
  const foreground = currentForegroundPresentation();
  renderForegroundControls(foregroundControls, foreground);
  clearComposerFeedback();

  if (foreground?.kind === "ask-text" || foreground?.kind === "ask-number") {
    composerInput.placeholder = foreground.hint;
    composerInput.setAttribute("aria-label", foreground.accessibleName);
    if (foreground.kind === "ask-number") composerInput.inputMode = "decimal";
    else composerInput.removeAttribute("inputmode");
  } else {
    composerInput.placeholder = "Type your response…";
    composerInput.setAttribute("aria-label", "User input");
    composerInput.removeAttribute("inputmode");
  }

  syncControlAvailability();
  queueCarouselPresentationSync();
  syncOverlayChromeMode();
  layoutDebug.queueSync();
}

function syncControlAvailability(): void {
  const disabled = controlAvailabilityDemo === "disabled";
  const foregroundActive = currentForegroundPresentation() !== null;
  composerInput.disabled = disabled && !foregroundActive;
  sendButton.disabled = disabled && !foregroundActive;
  for (const control of foregroundControls.querySelectorAll<HTMLButtonElement>("button")) {
    control.disabled = false;
  }
  for (const control of actions.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLSelectElement>("button, input, select")) {
    control.disabled = disabled;
  }
}

function submitComposerValue(): void {
  if (composerInput.disabled) return;
  const raw = composerInput.value;
  const foreground = currentForegroundPresentation();

  if (foreground === null) {
    if (raw.trim().length === 0) {
      showComposerFeedback("Enter a response before sending.");
      return;
    }
    completeComposerSubmission(raw);
    return;
  }

  switch (foreground.kind) {
    case "ask-text":
      if (raw.trim().length === 0) {
        showComposerFeedback("Enter a text answer before sending.");
        return;
      }
      completeForeground(raw);
      return;
    case "ask-number":
      if (!isAcceptedNumberText(raw)) {
        showComposerFeedback("Enter a valid number before sending.");
        return;
      }
      completeForeground(raw.trim());
      return;
    case "show-button":
      if (raw !== foreground.label) {
        showComposerFeedback(`Type “${foreground.label}” exactly or use the button.`);
        return;
      }
      completeForeground(foreground.label);
      return;
    case "choose": {
      const option = matchForegroundChoiceByVisibleText(foreground.options, raw);
      if (option === null) {
        showComposerFeedback("Type one visible option exactly or use a rendered choice control.");
        return;
      }
      completeForeground(option.label);
      return;
    }
  }
}

function isAcceptedNumberText(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length === 0 || /[\r\n]/u.test(trimmed)) return false;
  if (!/^[+-]?(?:(?:\d+(?:\.\d*)?)|(?:\.\d+))(?:[eE][+-]?\d+)?$/u.test(trimmed)) return false;
  return Number.isFinite(Number(trimmed));
}

function completeComposerSubmission(text: string): void {
  appendActivityMessage(text);
  clearComposerValue();
  clearComposerFeedback();
  restoreComposerFocus();
}

function completeForeground(text: string): void {
  appendActivityMessage(text);
  clearComposerValue();
  foregroundDemoKind = "none";
  syncForegroundPresentation();
  syncVisualControls();
  restoreComposerFocus();
}

function clearComposerValue(): void {
  composerInput.value = "";
  syncComposerInputSize();
  syncOverlayChromeMode();
}

function showComposerFeedback(message: string): void {
  composerFeedback.textContent = message;
  composerFeedback.hidden = false;
}

function clearComposerFeedback(): void {
  composerFeedback.textContent = "";
  composerFeedback.hidden = true;
}

function settlePacingGate(): void {
  if (pacingGateDemo !== "skippable" || !hasPendingPacingMessage()) return;
  cancelPacingTimer();
  revealNextPacingMessage();
}

function startPacingDemo(): void {
  cancelPacingTimer();
  pacingMessages = [];
  pacingSequenceIndex = 0;
  if (pacingGateDemo === "off") {
    syncTranscript();
    return;
  }

  historySizeDemo = 0;
  activityMessages = [];
  foregroundDemoKind = "none";
  syncForegroundPresentation();
  syncTranscript();
  revealNextPacingMessage();
}

function revealNextPacingMessage(): void {
  const source = createDemoHistoryMessages(DEMO_PRESENTATION.messages.length)[pacingSequenceIndex];
  if (source === undefined) {
    cancelPacingTimer();
    return;
  }

  const message = { ...source, id: `pacing-${pacingSequenceIndex + 1}` };
  pacingSequenceIndex += 1;
  pacingMessages = [...pacingMessages, message];
  transcriptController.appendMessage(message, presentation.speakers);
  if (hasPendingPacingMessage()) {
    pacingTimer = setTimeout(() => {
      pacingTimer = null;
      revealNextPacingMessage();
    }, PACING_MESSAGE_DELAY_MS);
  }
}

function hasPendingPacingMessage(): boolean {
  return pacingSequenceIndex < DEMO_PRESENTATION.messages.length;
}

function cancelPacingTimer(): void {
  if (pacingTimer === null) return;
  clearTimeout(pacingTimer);
  pacingTimer = null;
}

function isInteractiveTarget(target: Element): boolean {
  return target.closest("button, input, select, textarea, a, [role='button'], [contenteditable='true']") !== null;
}

function isPacingBackgroundTarget(target: Element): boolean {
  if (target === player || target === transcript || target.classList.contains("title-bg")) return true;
  const mediaSurface = target.closest(".media-surface");
  return mediaSurface !== null && target.closest(".media-content") === null;
}

function restoreComposerFocus(): void {
  if (!composerInput.disabled) composerInput.focus({ preventScroll: true });
}

function simulateScriptUpdate(): void {
  if (scriptUpdateDemoTarget === "toggle") {
    const toggle = rightControlsDemo.find((control): control is PlayerRightTogglePresentation => control.kind === "toggle");
    if (toggle === undefined) return;
    rightControlsDemo = rightControlsDemo.map((control) => control.id === toggle.id
      ? { ...toggle, value: !toggle.value }
      : control);
    renderRightControls();
    showScriptUpdateFeedback(toggle.id, `${toggle.label} changed by the script.`);
    return;
  }

  const select = rightControlsDemo.find((control): control is PlayerRightSelectPresentation => control.kind === "select");
  if (select === undefined) return;
  const currentIndex = Math.max(0, select.options.findIndex(([value]) => value === select.value));
  const next = select.options[(currentIndex + 1) % select.options.length];
  if (next === undefined) return;
  rightControlsDemo = rightControlsDemo.map((control) => control.id === select.id
    ? { ...select, value: next[0] }
    : control);
  renderRightControls();
  showScriptUpdateFeedback(select.id, `${select.label} changed by the script.`);
}

function showScriptUpdateFeedback(controlId: string, message: string): void {
  clearScriptUpdateFeedback();
  const showsToast = scriptUpdateFeedbackDemo === "toast"
    || scriptUpdateFeedbackDemo === "toast-highlight"
    || scriptUpdateFeedbackDemo === "toast-badge";
  const localPresentation = scriptUpdateFeedbackDemo === "highlight"
    || scriptUpdateFeedbackDemo === "toast-highlight"
      ? "highlight"
      : scriptUpdateFeedbackDemo === "badge" || scriptUpdateFeedbackDemo === "toast-badge"
        ? "badge"
        : null;

  playerNotification.hidden = false;
  playerNotification.textContent = message;
  playerNotification.dataset.visible = String(showsToast);
  const control = actions.querySelector<HTMLElement>(`[data-control-id="${CSS.escape(controlId)}"]`);
  if (control !== null && localPresentation !== null) {
    control.dataset.scriptUpdateFeedback = localPresentation;
  }
  scriptUpdateFeedbackTimer = setTimeout(clearScriptUpdateFeedback, SCRIPT_UPDATE_FEEDBACK_MS);
}

function clearScriptUpdateFeedback(): void {
  if (scriptUpdateFeedbackTimer !== null) {
    clearTimeout(scriptUpdateFeedbackTimer);
    scriptUpdateFeedbackTimer = null;
  }
  for (const control of actions.querySelectorAll<HTMLElement>("[data-script-update-feedback]")) {
    delete control.dataset.scriptUpdateFeedback;
  }
  playerNotification.textContent = "";
  playerNotification.hidden = true;
  delete playerNotification.dataset.visible;
}

async function replaceDemoMedia(): Promise<void> {
  const nextPresentation = await loadDemoPresentation();
  if (
    mediaTransitionDemo === "direct"
    || sceneMedia.hidden
    || window.matchMedia("(prefers-reduced-motion: reduce)").matches
  ) {
    presentation = nextPresentation;
    renderCorePresentation();
    renderTools();
    return;
  }

  const outgoing = sceneMedia.cloneNode(true) as HTMLImageElement;
  outgoing.removeAttribute("id");
  outgoing.classList.add("media-transition-outgoing");
  outgoing.setAttribute("aria-hidden", "true");
  outgoing.alt = "";
  sceneMedia.before(outgoing);
  sceneMedia.style.opacity = "0";

  presentation = nextPresentation;
  renderCorePresentation();
  renderTools();
  await waitForImageReady(sceneMedia);

  if (mediaTransitionDemo === "fade") {
    await outgoing.animate(
      [{ opacity: 1 }, { opacity: 0 }],
      { duration: 180, easing: "ease", fill: "forwards" },
    ).finished.catch(() => undefined);
    outgoing.remove();
    await sceneMedia.animate(
      [{ opacity: 0 }, { opacity: 1 }],
      { duration: 180, easing: "ease", fill: "forwards" },
    ).finished.catch(() => undefined);
  } else {
    await Promise.all([
      outgoing.animate(
        [{ opacity: 1 }, { opacity: 0 }],
        { duration: 320, easing: "ease", fill: "forwards" },
      ).finished.catch(() => undefined),
      sceneMedia.animate(
        [{ opacity: 0 }, { opacity: 1 }],
        { duration: 320, easing: "ease", fill: "forwards" },
      ).finished.catch(() => undefined),
    ]);
    outgoing.remove();
  }

  sceneMedia.style.removeProperty("opacity");
}

async function waitForImageReady(image: HTMLImageElement): Promise<void> {
  if (image.hidden || image.complete) {
    await image.decode().catch(() => undefined);
    return;
  }
  await new Promise<void>((resolve) => {
    image.addEventListener("load", () => resolve(), { once: true });
    image.addEventListener("error", () => resolve(), { once: true });
  });
  await image.decode().catch(() => undefined);
}

async function toggleFullscreen(): Promise<void> {
  try {
    if (document.fullscreenElement === player) await document.exitFullscreen();
    else await player.requestFullscreen();
  } catch {
    // Browser policy may deny fullscreen in the development harness.
  }
  syncFullscreenControl();
  syncOverlayChromeMode();
}

function syncFullscreenControl(): void {
  const active = document.fullscreenElement === player;
  fullscreenToggle.setAttribute("aria-pressed", String(active));
  fullscreenToggle.setAttribute("aria-label", active ? "Exit fullscreen" : "Enter fullscreen");
}

function syncOverlayChromeMode(): void {
  const usableHeight = window.visualViewport?.height ?? window.innerHeight;
  player.style.setProperty("--player-usable-height", `${Math.max(0, usableHeight)}px`);
  const compactTimers = usableHeight <= 600;
  const overlayChrome = document.fullscreenElement === player || usableHeight <= 768;
  player.dataset.chrome = overlayChrome ? "overlay" : "normal";
  player.dataset.compactTimers = compactTimers ? "true" : "false";
  player.dataset.heightComposition = usesComposerOnlyComposition(usableHeight) ? "composer-only" : "standard";
  rightRailLayout.sync(compactTimers);
  player.style.setProperty(
    "--media-height",
    usableViewportLength(overlayChrome ? "--media-height-overlay" : "--media-height-normal", usableHeight),
  );
  player.style.setProperty(
    "--composer-effective-viewport-height",
    usableViewportLength("--composer-max-viewport-height", usableHeight),
  );
  queueRightCompositionSync();
  layoutDebug.queueSync();
}

function syncViewportTransition(): void {
  syncComposerInputSize();
  syncOverlayChromeMode();
  queueCarouselPresentationSync();
  if (viewportSettleTimer !== null) clearTimeout(viewportSettleTimer);
  viewportSettleTimer = setTimeout(() => {
    viewportSettleTimer = null;
    syncComposerInputSize();
    syncOverlayChromeMode();
    queueCarouselPresentationSync();
  }, 300);
}

function syncComposerInputSize(): void {
  composerInput.style.blockSize = "auto";
  const borderSize = composerInput.offsetHeight - composerInput.clientHeight;
  composerInput.style.blockSize = `${composerInput.scrollHeight + borderSize}px`;
}

function usesComposerOnlyComposition(usableHeight: number): boolean {
  if (document.activeElement !== composerInput) return false;
  const stageHeight = Number.parseFloat(usableViewportLength("--media-height-overlay", usableHeight));
  const minimumConversationHeight = Number.parseFloat(getComputedStyle(player).fontSize) * 1.5;
  const measuredForegroundHeight = foregroundControls.getBoundingClientRect().height;
  if (measuredForegroundHeight > 0) visibleForegroundHeight = measuredForegroundHeight;
  const foregroundHeight = foregroundControls.hidden ? 0 : visibleForegroundHeight;
  return usableHeight < requiredComposerHeight() + foregroundHeight + stageHeight + minimumConversationHeight;
}

function requiredComposerHeight(): number {
  const style = getComputedStyle(composer);
  return composerForm.getBoundingClientRect().height
    + cssPixelValue(style, "padding-block-start")
    + cssPixelValue(style, "padding-block-end");
}

function usableViewportLength(property: string, usableHeight: number): string {
  const raw = getComputedStyle(player).getPropertyValue(property).trim();
  if (raw.endsWith("dvh")) {
    const percent = Number.parseFloat(raw);
    if (Number.isFinite(percent)) return `${Math.max(0, usableHeight * percent / 100)}px`;
  }
  return raw.length > 0 ? raw : "0px";
}

function syncLayoutDebugActivation(): void {
  if (layoutDebugActivated) return;
  if (!toolColumns.some((column) => column.toolId === "layout-debug")) return;
  layoutDebugActivated = true;
  layoutDebug.setEnabled(true);
}

function appendToolColumn(): void {
  const id = `tool-column-${nextToolColumnNumber}`;
  nextToolColumnNumber += 1;
  toolColumns = addToolColumn(toolColumns, id, DEMO_TOOL_DEFINITIONS.map((tool) => tool.id));
  renderTools("end");
}

function renderTools(scrollMode: "preserve" | "end" = "preserve"): void {
  const previousScrollLeft = toolStripScroll.scrollLeft;
  renderToolColumns(toolStrip, toolColumns, DEMO_TOOL_DEFINITIONS, presentation);
  syncLayoutDebugActivation();
  syncVisualControls();
  layoutDebug.sync();

  requestAnimationFrame(() => {
    syncLeftPreferredWidth();
    if (scrollMode === "end") toolStripScroll.scrollLeft = toolStripScroll.scrollWidth;
    else {
      const maxScrollLeft = Math.max(0, toolStripScroll.scrollWidth - toolStripScroll.clientWidth);
      toolStripScroll.scrollLeft = Math.min(previousScrollLeft, maxScrollLeft);
    }
    syncLeftReserve();
    syncCarouselPresentation();
  });
}

async function loadDemoMedia(): Promise<void> {
  presentation = await loadDemoPresentation();
  renderCorePresentation();
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
    if (typeof media.id !== "string" || typeof media.src !== "string" || typeof media.title !== "string") {
      return DEMO_PRESENTATION;
    }
    return {
      ...DEMO_PRESENTATION,
      media: { ...DEMO_PRESENTATION.media, id: media.id, src: media.src, title: media.title },
    };
  } catch {
    return DEMO_PRESENTATION;
  }
}

function usesWideDefaultLayout(): boolean {
  return !narrowScreen.matches;
}

function usesDockedRightComposition(): boolean {
  return player.dataset.rightLayout === "rail";
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

  const rightDocked = player.dataset.rightBacking === "docked";
  rightToggle.setAttribute("aria-pressed", String(rightDocked));
  rightToggle.setAttribute("aria-label", rightDocked ? "Use overlay right panel background" : "Dock right panel background");
  layoutDebug.queueSync();
}

function queueRightCompositionSync(): void {
  if (rightCompositionSyncQueued) return;
  rightCompositionSyncQueued = true;
  requestAnimationFrame(() => {
    rightCompositionSyncQueued = false;
    syncRightComposition();
  });
}

function syncRightComposition(): void {
  const style = getComputedStyle(player);
  const rightWidth = cssPixelValue(style, "--right-controls-width");
  const conversationMinimum = cssPixelValue(style, "--conversation-min-width");
  const stageMinimum = cssPixelValue(style, "--media-height");
  const desiredLeftWidth = usesWideDefaultLayout() && currentLeftMode() !== "closed"
    ? cssPixelValue(style, "--left-preferred")
    : 0;
  const minimumMiddleWidth = Math.max(conversationMinimum, stageMinimum);
  const railFits = canDockRightRail(
    player.clientWidth,
    desiredLeftWidth,
    rightWidth,
    minimumMiddleWidth,
    narrowScreen.matches,
  );

  player.dataset.rightLayout = railFits ? "rail" : "stage";
  const rightMode = currentRightMode();
  const dockedBacking = rightMode === "docked" || (rightMode === "auto" && railFits);
  player.dataset.rightBacking = dockedBacking ? "docked" : "overlay";
  syncPanelAccessibility();
  layoutDebug.queueSync();
}

function cssPixelValue(style: CSSStyleDeclaration, property: string): number {
  const value = Number.parseFloat(style.getPropertyValue(property));
  return Number.isFinite(value) ? value : 0;
}

function queueLeftReserveSync(): void {
  requestAnimationFrame(() => {
    syncLeftPreferredWidth();
    syncLeftReserve();
  });
}

function syncLeftPreferredWidth(): void {
  const stripWidth = Math.ceil(toolStrip.getBoundingClientRect().width);
  const panelChromeWidth = Math.max(0, Math.ceil(leftPanel.getBoundingClientRect().width - toolStripScroll.clientWidth));
  player.style.setProperty("--left-preferred", `${stripWidth + panelChromeWidth}px`);
}

function queueCarouselPresentationSync(): void {
  if (carouselPresentationSyncQueued) return;
  carouselPresentationSyncQueued = true;
  requestAnimationFrame(() => {
    carouselPresentationSyncQueued = false;
    syncCarouselPresentation();
  });
}

function syncCarouselPresentation(): void {
  setHorizontalOverflowState(toolStripScroll);
  const foregroundCarousel = foregroundControls.querySelector<HTMLElement>("[data-foreground-choice-buttons]");
  if (foregroundCarousel !== null) setHorizontalOverflowState(foregroundCarousel);
}

function setHorizontalOverflowState(scroller: HTMLElement): void {
  scroller.dataset.overflow = String(scroller.scrollWidth > scroller.clientWidth + 1);
}

function toggleLabOptionInfo(trigger: HTMLButtonElement): void {
  const info = trigger.closest<HTMLElement>(".lab-option-info");
  if (info === null) throw new Error("Visual Lab information trigger is missing its owner.");
  const open = info.dataset.open !== "true";
  closeLabOptionInfo(info);
  if (open) info.dataset.open = "true";
  else delete info.dataset.open;
  trigger.setAttribute("aria-expanded", String(open));
}

function closeLabOptionInfo(except?: HTMLElement): boolean {
  let closed = false;
  for (const info of toolStrip.querySelectorAll<HTMLElement>('.lab-option-info[data-open="true"]')) {
    if (info === except) continue;
    delete info.dataset.open;
    const trigger = info.querySelector<HTMLButtonElement>("[data-lab-option-info-trigger]");
    trigger?.setAttribute("aria-expanded", "false");
    closed = true;
  }
  return closed;
}

function syncLeftReserve(): void {
  const reservesGridSpace = usesWideDefaultLayout() && currentLeftMode() !== "closed";
  player.style.setProperty("--left-reserve", `${reservesGridSpace ? leftPanel.getBoundingClientRect().width : 0}px`);
}

function applyAccentColour(value: string): void {
  accentColor = value;
  document.documentElement.style.setProperty("--package-accent", value);
  syncVisualControls();
}

function setVisualOption(effect: string, enabled: boolean): void {
  switch (effect) {
    case "fx-ambient": ambientEnabled = enabled; break;
    case "fx-vignette": vignetteEnabled = enabled; break;
    default: throw new Error(`Unknown visual option: ${effect}`);
  }
  player.classList.toggle(effect, enabled);
  syncVisualControls();
}

function resetVisualLab(): void {
  cancelPacingTimer();
  clearScriptUpdateFeedback();
  accentColor = DEFAULT_VISUAL_PREFERENCES.accentColor;
  ambientEnabled = DEFAULT_VISUAL_PREFERENCES.ambient;
  vignetteEnabled = DEFAULT_VISUAL_PREFERENCES.vignette;
  busyActionDemoStyle = "off";
  busyControlDemoTarget = "action";
  timerLabelDemoPlacement = "below";
  timerLabelContentDemo = "authored";
  timerCountDemo = 1;
  timerKindDemo = "visible";
  mediaTransitionDemo = "direct";
  mediaContentDemo = "present";
  foregroundDemoKind = "choose";
  pacingGateDemo = "off";
  controlAvailabilityDemo = "enabled";
  historySizeDemo = DEMO_PRESENTATION.messages.length;
  rightControlsDemo = DEMO_PRESENTATION.rightControls;
  rightControlsVisibleDemo = true;
  scriptUpdateDemoTarget = "toggle";
  scriptUpdateFeedbackDemo = "toast-highlight";
  activityMessages = [];
  pacingMessages = [];
  pacingSequenceIndex = 0;
  document.documentElement.style.setProperty("--package-accent", accentColor);
  player.classList.toggle("fx-ambient", ambientEnabled);
  player.classList.toggle("fx-vignette", vignetteEnabled);

  for (const input of toolStrip.querySelectorAll<HTMLInputElement>("[data-tuning-property]")) {
    player.style.removeProperty(requiredDatasetValue(input, "tuningProperty"));
  }
  renderRightControls();
  syncTranscript();
  syncForegroundPresentation();
  syncVisualControls();
}

function setPresentationDemoSelection(key: string, value: string): void {
  switch (key) {
    case "busy-style":
      if (!["off", "pulse", "sweep", "dots", "corner-dot", "spinner", "wash"].includes(value)) throw new Error(`Unknown busy Action style: ${value}`);
      busyActionDemoStyle = value;
      break;
    case "busy-target":
      if (!["action", "toggle", "select"].includes(value)) throw new Error(`Unknown busy control target: ${value}`);
      busyControlDemoTarget = value as "action" | "toggle" | "select";
      break;
    case "timer-label":
      if (!["off", "above", "below"].includes(value)) throw new Error(`Unknown timer label placement: ${value}`);
      timerLabelDemoPlacement = value;
      break;
    case "timer-label-content":
      if (!["generic", "authored"].includes(value)) throw new Error(`Unknown timer label content: ${value}`);
      timerLabelContentDemo = value as "generic" | "authored";
      break;
    case "media-transition":
      if (!["direct", "fade", "crossfade"].includes(value)) throw new Error(`Unknown media transition fixture: ${value}`);
      mediaTransitionDemo = value as PlayerMediaTransitionFixture;
      break;
    case "media-content":
      if (!["present", "empty"].includes(value)) throw new Error(`Unknown media content fixture: ${value}`);
      mediaContentDemo = value as "present" | "empty";
      renderCorePresentation();
      break;
    case "foreground-fixture":
      if (!["none", "show-button", "choose", "ask-text", "ask-number"].includes(value)) throw new Error(`Unknown foreground fixture: ${value}`);
      foregroundDemoKind = value as PlayerForegroundFixtureKind;
      syncForegroundPresentation();
      break;
    case "timer-kind":
      if (!["visible", "mystery", "hidden"].includes(value)) throw new Error(`Unknown timer presentation: ${value}`);
      timerKindDemo = value as PlayerTimerKind;
      break;
    case "pacing-gate":
      if (!["off", "skippable", "unskippable"].includes(value)) throw new Error(`Unknown pacing fixture: ${value}`);
      pacingGateDemo = value as PlayerPacingFixture;
      startPacingDemo();
      break;
    case "control-availability":
      if (!["enabled", "disabled"].includes(value)) throw new Error(`Unknown control availability: ${value}`);
      controlAvailabilityDemo = value as PlayerControlAvailability;
      break;
    case "script-update-target":
      if (!["toggle", "select"].includes(value)) throw new Error(`Unknown script-update target: ${value}`);
      scriptUpdateDemoTarget = value as "toggle" | "select";
      break;
    case "script-update-feedback":
      if (!["toast", "highlight", "badge", "toast-highlight", "toast-badge"].includes(value)) throw new Error(`Unknown script-update feedback: ${value}`);
      scriptUpdateFeedbackDemo = value as ScriptUpdateFeedbackDemo;
      clearScriptUpdateFeedback();
      break;
    case "right-controls-visibility":
      if (!["visible", "none"].includes(value)) throw new Error(`Unknown right-control visibility fixture: ${value}`);
      rightControlsVisibleDemo = value === "visible";
      renderRightControls();
      break;
    default:
      throw new Error(`Unknown presentation demo selection: ${key}`);
  }
  syncVisualControls();
}

function applyDemoNumber(input: HTMLInputElement): void {
  if (!Number.isFinite(input.valueAsNumber)) return;
  const key = requiredDatasetValue(input, "demoNumber");
  const value = Math.trunc(input.valueAsNumber);
  switch (key) {
    case "timer-count":
      if (value < 1) return;
      timerCountDemo = value;
      break;
    case "history-size":
      if (value < 0) return;
      historySizeDemo = Math.min(value, MAX_DEMO_HISTORY_MESSAGES);
      syncTranscript();
      break;
    default:
      throw new Error(`Unknown presentation demo number: ${key}`);
  }
  syncVisualControls();
}

function applyTuningValue(input: HTMLInputElement): void {
  if (!Number.isFinite(input.valueAsNumber)) return;
  player.style.setProperty(requiredDatasetValue(input, "tuningProperty"), `${input.valueAsNumber}${requiredDatasetValue(input, "tuningUnit")}`);
  syncVisualControls();
}

function syncVisualControls(): void {
  for (const input of toolStrip.querySelectorAll<HTMLInputElement>("[data-theme-color]")) input.value = accentColor;
  for (const input of toolStrip.querySelectorAll<HTMLInputElement>("[data-effect]")) {
    if (input.dataset.effect === "fx-ambient") input.checked = ambientEnabled;
    else if (input.dataset.effect === "fx-vignette") input.checked = vignetteEnabled;
    else throw new Error(`Unknown visual option: ${String(input.dataset.effect)}`);
  }

  for (const select of toolStrip.querySelectorAll<HTMLSelectElement>("[data-demo-select]")) {
    switch (select.dataset.demoSelect) {
      case "busy-style": select.value = busyActionDemoStyle; break;
      case "busy-target": select.value = busyControlDemoTarget; break;
      case "timer-label": select.value = timerLabelDemoPlacement; break;
      case "timer-label-content": select.value = timerLabelContentDemo; break;
      case "media-transition": select.value = mediaTransitionDemo; break;
      case "media-content": select.value = mediaContentDemo; break;
      case "foreground-fixture": select.value = foregroundDemoKind; break;
      case "timer-kind": select.value = timerKindDemo; break;
      case "pacing-gate": select.value = pacingGateDemo; break;
      case "control-availability": select.value = controlAvailabilityDemo; break;
      case "script-update-target": select.value = scriptUpdateDemoTarget; break;
      case "script-update-feedback": select.value = scriptUpdateFeedbackDemo; break;
      case "right-controls-visibility": select.value = rightControlsVisibleDemo ? "visible" : "none"; break;
      default: throw new Error(`Unknown presentation demo selection: ${String(select.dataset.demoSelect)}`);
    }
  }

  for (const input of toolStrip.querySelectorAll<HTMLInputElement>("[data-demo-number]")) {
    if (input.dataset.demoNumber === "timer-count") input.value = String(timerCountDemo);
    else if (input.dataset.demoNumber === "history-size") input.value = String(historySizeDemo);
    else throw new Error(`Unknown presentation demo number: ${String(input.dataset.demoNumber)}`);
  }

  syncDemoTimers();
  syncBusyAction();
  syncControlAvailability();
  syncOverlayChromeMode();

  const computed = getComputedStyle(player);
  for (const input of toolStrip.querySelectorAll<HTMLInputElement>("[data-tuning-property]")) {
    const value = Number.parseFloat(computed.getPropertyValue(requiredDatasetValue(input, "tuningProperty")));
    if (Number.isFinite(value)) input.value = String(value);
  }
  layoutDebug.queueSync();
}

function syncBusyAction(): void {
  const interactiveControls = actions.querySelectorAll<HTMLElement>(
    ".action-button, .right-toggle-control, .right-select-control",
  );
  for (const control of interactiveControls) {
    control.removeAttribute("aria-busy");
    delete control.dataset.busyStyle;
  }
  if (busyActionDemoStyle === "off") return;

  const selector = busyControlDemoTarget === "action"
    ? ".action-button"
    : busyControlDemoTarget === "toggle"
      ? ".right-toggle-control"
      : ".right-select-control";
  const target = actions.querySelector<HTMLElement>(selector);
  target?.setAttribute("aria-busy", "true");
  if (target !== null) target.dataset.busyStyle = busyActionDemoStyle;
}

function syncDemoTimers(): void {
  timerList.replaceChildren();
  player.dataset.timerKind = timerKindDemo;
  player.dataset.demoTimerCount = String(timerCountDemo);

  if (timerKindDemo === "hidden") {
    rightRailLayout.queueSync();
    layoutDebug.queueSync();
    return;
  }

  for (let index = 1; index <= timerCountDemo; index += 1) timerList.append(createDemoTimer(index));
  rightRailLayout.queueSync();
  layoutDebug.queueSync();
}

function createDemoTimer(index: number): HTMLElement {
  const element = document.createElement("div");
  element.className = "timer";
  element.dataset.demoTimer = "";
  element.dataset.timerKind = timerKindDemo;
  const visibleLabel = timerLabelContentDemo === "authored" && index === 1 ? "Hold position" : `Timer ${index}`;
  element.setAttribute(
    "aria-label",
    timerKindDemo === "mystery" ? `Mystery timer · ${visibleLabel}` : visibleLabel,
  );
  element.style.setProperty("--timer-progress", `${Math.min(84, 22 + (index * 17))}%`);

  const label = document.createElement("span");
  label.className = "timer-label";
  label.textContent = visibleLabel;
  label.hidden = timerLabelDemoPlacement === "off";
  if (timerLabelDemoPlacement !== "off") element.dataset.labelPlacement = timerLabelDemoPlacement;

  const text = document.createElement("span");
  text.className = "timer-text";
  text.textContent = timerKindDemo === "mystery" ? "?" : demoTimerText(index);
  element.append(label, text);
  return element;
}

function isPlayerToolId(value: string): value is PlayerToolId {
  return DEMO_TOOL_DEFINITIONS.some((tool) => tool.id === value);
}

function requiredDatasetValue(element: HTMLElement, key: string): string {
  const value = element.dataset[key];
  if (value === undefined || value.length === 0) throw new Error(`Player element is missing data-${key}.`);
  return value;
}

function demoTimerText(index: number): string {
  const fixtures = [161, 97, 54, 21];
  const seconds = fixtures[index - 1] ?? (35 + ((index * 29) % 145));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function requiredElement<T extends Element>(id: string, constructor: { new (...args: never[]): T }): T {
  const element = document.getElementById(id);
  if (!(element instanceof constructor)) throw new Error(`Missing or invalid Player element #${id}.`);
  return element;
}

function requiredQuery<T extends Element>(
  root: ParentNode,
  selector: string,
  constructor: { new (...args: never[]): T },
): T {
  const element = root.querySelector(selector);
  if (!(element instanceof constructor)) throw new Error(`Missing Player element ${selector}.`);
  return element;
}
