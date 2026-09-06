import {
  CheckpointError,
  type InstructionPlan,
  type InterpreterEvent,
  type RuntimeSnapshot,
} from "../src/index.js";
import {
  checkpointStorageKey,
  exampleUrl,
  isPlaygroundExampleName,
  PLAYGROUND_EXAMPLES,
  type PlaygroundExampleName,
} from "./examples.js";
import {
  activateWorkspaceButton,
  compileWorkspaceSource,
  decodeWorkspaceSourceBytes,
  executeValidatedWorkspaceSnapshot,
  inspectWorkspacePlayerPresentation,
  restoreWorkspaceCheckpoint,
  selectWorkspaceChoice,
  serializeWorkspaceCheckpoint,
  skipWorkspacePacing,
  submitWorkspaceComposer,
  type WorkspaceControlResult,
  type WorkspacePlayerPresentation,
  type WorkspaceResult,
} from "./workspace/controller.js";

const DRAFT_KEY = "teasescript-playground-draft-v1";
const elements = {
  source: requiredTextarea("source-code"),
  sourceLines: requiredElement("source-lines"),
  sourcePanel: requiredElement("source-panel"),
  playerPanel: requiredElement("player-panel"),
  diagnostics: requiredElement("diagnostics"),
  transcript: requiredElement("transcript"),
  interactionRegion: requiredElement("interaction-region"),
  interactionControls: requiredElement("interaction-controls"),
  interactionFeedback: requiredElement("interaction-feedback"),
  composerForm: requiredForm("composer-form"),
  composerInput: requiredInput("composer-input"),
  composerSubmit: requiredButton("composer-submit"),
  composerHelp: requiredElement("composer-help"),
  instructionPosition: requiredElement("instruction-position"),
  runtimeStatus: requiredElement("runtime-status"),
  eventLog: requiredElement("event-log"),
  instructionPlan: requiredElement("instruction-plan"),
  runtimeState: requiredElement("runtime-state"),
  actionStatus: requiredElement("action-status"),
  loadedExampleName: requiredElement("loaded-example-name"),
  sourceRevision: requiredElement("source-revision"),
  exampleSelect: requiredSelect("example-select"),
  compile: requiredButton("compile"),
  run: requiredButton("run"),
  step: requiredButton("step"),
  reset: requiredButton("reset"),
  saveCheckpoint: requiredButton("save-checkpoint"),
  restoreCheckpoint: requiredButton("restore-checkpoint"),
  clearCheckpoint: requiredButton("clear-checkpoint"),
  reloadExample: requiredButton("reload-example"),
  importSource: requiredButton("import-source"),
  exportSource: requiredButton("export-source"),
  refreshWorkspace: requiredButton("refresh-workspace"),
  sourceFile: requiredFile("source-file"),
};

let sourceRevision = 0;
let compiledRevision: number | null = null;
let plan: InstructionPlan | null = null;
let snapshot: RuntimeSnapshot | null = null;
let eventLog: InterpreterEvent[] = [];
let currentExample: PlaygroundExampleName = "main";
let lastFocusedActionId: number | null = null;
let playerFeedback = "";
const checkpointEventLogs = new Map<
  string,
  Readonly<{ serialized: string; events: readonly InterpreterEvent[] }>
>();

for (const [name, example] of Object.entries(PLAYGROUND_EXAMPLES)) {
  const option = document.createElement("option");
  option.value = name;
  option.textContent = example.label;
  elements.exampleSelect.append(option);
}
elements.exampleSelect.value = currentExample;
elements.compile.addEventListener("click", compileAndReset);
elements.run.addEventListener("click", () => {
  execute("run");
});
elements.step.addEventListener("click", () => {
  execute("step");
});
elements.reset.addEventListener("click", compileAndReset);
elements.saveCheckpoint.addEventListener("click", saveCheckpoint);
elements.restoreCheckpoint.addEventListener("click", restoreSavedCheckpoint);
elements.clearCheckpoint.addEventListener("click", clearSavedCheckpoint);
elements.reloadExample.addEventListener("click", () => {
  void reloadExample();
});
elements.importSource.addEventListener("click", () => {
  elements.sourceFile.click();
});
elements.sourceFile.addEventListener("change", () => {
  void importSource();
});
elements.exportSource.addEventListener("click", exportSource);
elements.refreshWorkspace.addEventListener("click", () => {
  void refreshAutomationWorkspace();
});
elements.exampleSelect.addEventListener("change", () => {
  if (isPlaygroundExampleName(elements.exampleSelect.value)) {
    currentExample = elements.exampleSelect.value;
    void reloadExample();
  }
});
elements.source.addEventListener("input", () => {
  sourceEdited();
});
elements.source.addEventListener("scroll", () => {
  elements.sourceLines.scrollTop = elements.source.scrollTop;
});
elements.composerForm.addEventListener("submit", (event) => {
  event.preventDefault();
  submitComposer();
});
elements.composerInput.addEventListener("keydown", (event) => {
  handleComposerKeydown(event);
});
elements.playerPanel.addEventListener("pointerup", (event) => {
  handlePlayerPointer(event);
});
new ResizeObserver(() => {
  elements.playerPanel.style.height = `${elements.sourcePanel.offsetHeight}px`;
  updateChoicePresentation();
}).observe(elements.sourcePanel);
new ResizeObserver(updateChoicePresentation).observe(elements.playerPanel);
void loadInitialSource();

async function loadInitialSource(): Promise<void> {
  const draft = safeStorageGet(DRAFT_KEY);
  if (draft !== null) {
    replaceSource(
      draft,
      "Local draft restored; compile it to create a current runtime.",
      "Local draft",
    );
    return;
  }
  await reloadExample();
}

async function reloadExample(): Promise<void> {
  setActionStatus(`Loading ${PLAYGROUND_EXAMPLES[currentExample].label}…`);
  try {
    const response = await fetch(exampleUrl(currentExample), { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`Example request failed with HTTP ${response.status}.`);
    }
    replaceSource(
      await response.text(),
      "Repository example loaded.",
      PLAYGROUND_EXAMPLES[currentExample].label,
      false,
    );
    safeStorageRemove(DRAFT_KEY);
    compileAndReset();
  } catch (error) {
    setActionStatus(errorMessage(error));
  }
}

function replaceSource(value: string, message: string, label: string, saveDraft = true): void {
  elements.source.value = value;
  elements.loadedExampleName.textContent = label;
  sourceEdited(saveDraft);
  setActionStatus(message);
}

function sourceEdited(saveDraft = true): void {
  sourceRevision += 1;
  plan = null;
  snapshot = null;
  compiledRevision = null;
  eventLog = [];
  lastFocusedActionId = null;
  clearPlayerFeedback();
  elements.transcript.replaceChildren();
  if (saveDraft) {
    safeStorageSet(DRAFT_KEY, elements.source.value);
  }
  renderState();
  renderSourceLines();
}

function compileAndReset(): void {
  try {
    const result = compileWorkspaceSource(elements.source.value);
    compiledRevision = result.plan === null ? null : sourceRevision;
    applyResult(result, true);
    setActionStatus(
      result.plan === null
        ? "Compilation has errors."
        : "Compiled current source into a fresh runtime.",
    );
  } catch (error) {
    setActionStatus(errorMessage(error));
  }
}

function execute(mode: "run" | "step"): void {
  if (!runtimeIsCurrent()) {
    setActionStatus("Compile the current source before execution; the previous runtime is stale.");
    return;
  }
  try {
    // EVIDENCE: invariant: runtimeIsCurrent checked both retained values and the source revision synchronously.
    const result = executeValidatedWorkspaceSnapshot(
      plan as InstructionPlan,
      snapshot as RuntimeSnapshot,
      mode,
    );
    applyResult(result, false);
    setActionStatus(`${mode === "run" ? "Run" : "Step"} executed.`);
  } catch (error) {
    setActionStatus(errorMessage(error));
  }
}

function applyResult(result: WorkspaceResult, resetEvents: boolean): void {
  plan = result.plan;
  snapshot = result.snapshot;
  renderDiagnostics(result.diagnostics);
  if (resetEvents) {
    eventLog = [];
    lastFocusedActionId = null;
    clearPlayerFeedback();
    elements.transcript.replaceChildren();
  }
  for (const event of result.events) {
    eventLog.push(event);
    renderTranscriptEvent(event);
  }
  renderState();
}

function runtimeIsCurrent(): boolean {
  return plan !== null && snapshot !== null && compiledRevision === sourceRevision;
}

function saveCheckpoint(): void {
  if (!runtimeIsCurrent()) {
    setActionStatus("Checkpoints require a current compiled runtime.");
    return;
  }
  try {
    // EVIDENCE: invariant: runtimeIsCurrent checked the retained plan and snapshot before this synchronous save.
    const checkpoint = serializeWorkspaceCheckpoint(
      plan as InstructionPlan,
      snapshot as RuntimeSnapshot,
    );
    const storageKey = checkpointStorageKey(currentExample);
    localStorage.setItem(storageKey, checkpoint.outcome.json);
    checkpointEventLogs.set(
      storageKey,
      Object.freeze({ serialized: checkpoint.outcome.json, events: Object.freeze([...eventLog]) }),
    );
    setActionStatus("Checkpoint saved locally.");
  } catch (error) {
    setActionStatus(errorMessage(error));
  }
}

function restoreSavedCheckpoint(): void {
  if (!runtimeIsCurrent()) {
    setActionStatus("Compile the current source before restoring a checkpoint.");
    return;
  }
  try {
    const storageKey = checkpointStorageKey(currentExample);
    const serialized = localStorage.getItem(storageKey);
    if (serialized === null) {
      setActionStatus("No saved checkpoint exists.");
      return;
    }

    const restored = restoreWorkspaceCheckpoint(serialized);
    if (JSON.stringify(plan) !== JSON.stringify(restored.outcome.plan)) {
      setActionStatus(
        "Checkpoint restore refused: its self-contained plan is incompatible with the current source runtime.",
      );
      return;
    }

    snapshot = restored.snapshot;
    const cached = checkpointEventLogs.get(storageKey);
    eventLog = cached?.serialized === serialized ? [...cached.events] : [];
    lastFocusedActionId = null;
    clearPlayerFeedback();
    elements.transcript.replaceChildren();
    for (const event of eventLog) renderTranscriptEvent(event);
    renderState();
    setActionStatus("Checkpoint restored; waiting state and pending action are retained.");
  } catch (error) {
    setActionStatus(
      error instanceof CheckpointError
        ? `${error.info.code}: ${error.info.message}`
        : errorMessage(error),
    );
  }
}

function clearSavedCheckpoint(): void {
  try {
    const storageKey = checkpointStorageKey(currentExample);
    localStorage.removeItem(storageKey);
    checkpointEventLogs.delete(storageKey);
    setActionStatus("Saved checkpoint cleared.");
  } catch (error) {
    setActionStatus(errorMessage(error));
  }
}

async function importSource(): Promise<void> {
  const file = elements.sourceFile.files?.[0];
  elements.sourceFile.value = "";
  if (file === undefined) {
    return;
  }
  if (!file.name.toLowerCase().endsWith(".tease")) {
    setActionStatus("Import requires one .tease file.");
    return;
  }
  try {
    const text = decodeWorkspaceSourceBytes(await file.arrayBuffer());
    replaceSource(text, "Local file loaded; compile it to create a runtime.", file.name);
  } catch (error) {
    setActionStatus(`Import failed: ${errorMessage(error)}`);
  }
}

function exportSource(): void {
  const blob = new Blob([elements.source.value], { type: "text/plain;charset=utf-8" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = "teasescript-workspace.tease";
  link.click();
  URL.revokeObjectURL(link.href);
  setActionStatus("Source exported as teasescript-workspace.tease.");
}

async function refreshAutomationWorkspace(): Promise<void> {
  try {
    const response = await fetch("/api/workspace", { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`Automation workspace request failed with HTTP ${response.status}.`);
    }

    /* EVIDENCE: boundary: this same-origin development server returns workspaceView; results are display-only until recompilation. */
    const data = (await response.json()) as {
      source: string;
      resultRevision: number | null;
      result: WorkspaceResult | null;
    };
    replaceSource(
      data.source,
      "Automation source loaded; local execution is stale until compiled.",
      "Automation workspace",
    );
    if (data.result !== null) {
      applyResult(data.result, true);
      compiledRevision = null;
      renderState();
      setActionStatus(
        `Automation result revision ${data.resultRevision ?? "unknown"} is displayed as view-only; compile before local execution.`,
      );
    }
  } catch (error) {
    setActionStatus(errorMessage(error));
  }
}

function submitComposer(): void {
  if (!runtimeIsCurrent()) return;
  const presentation = currentPlayerPresentation();
  const interaction = presentation.activeInteraction;
  if (
    interaction === null ||
    (interaction.interactionKind !== "text" &&
      interaction.interactionKind !== "number" &&
      interaction.interactionKind !== "choice")
  ) {
    setPlayerFeedback("Free chat is unavailable while no scripted text answer is active.");
    renderPlayerControls(presentation);
    return;
  }
  // EVIDENCE: runtimeIsCurrent above synchronously proved both retained values are present and current.
  applyWorkspaceControl(
    submitWorkspaceComposer(
      plan as InstructionPlan,
      snapshot as RuntimeSnapshot,
      elements.composerInput.value,
    ),
  );
}

function activateButton(): void {
  if (!runtimeIsCurrent()) return;
  // EVIDENCE: runtimeIsCurrent above synchronously proved both retained values are present and current.
  applyWorkspaceControl(
    activateWorkspaceButton(plan as InstructionPlan, snapshot as RuntimeSnapshot),
  );
}

function selectChoice(
  selection: { kind: "label"; value: string | number } | { kind: "text"; value: string },
): void {
  if (!runtimeIsCurrent()) return;
  // EVIDENCE: runtimeIsCurrent above synchronously proved both retained values are present and current.
  applyWorkspaceControl(
    selectWorkspaceChoice(plan as InstructionPlan, snapshot as RuntimeSnapshot, selection),
  );
}

function skipPacing(): void {
  if (!runtimeIsCurrent()) return;
  // EVIDENCE: runtimeIsCurrent above synchronously proved both retained values are present and current.
  applyWorkspaceControl(skipWorkspacePacing(plan as InstructionPlan, snapshot as RuntimeSnapshot));
}

function applyWorkspaceControl(result: WorkspaceControlResult): void {
  snapshot = result.snapshot;
  for (const event of result.events) {
    eventLog.push(event);
    renderTranscriptEvent(event);
  }
  const outcome = result.outcome;
  if (outcome.kind === "completed") {
    elements.composerInput.value = "";
    clearPlayerFeedback();
    renderState();
    execute("run");
    return;
  }
  setPlayerFeedback(controlOutcomeMessage(outcome));
  renderState();
}

function controlOutcomeMessage(outcome: WorkspaceControlResult["outcome"]): string {
  if (outcome.kind === "invalidPayload" || outcome.kind === "localRejection") {
    return outcome.message;
  }
  if (outcome.kind === "wrongActionKind") return "The active Player control changed; try again.";
  if (outcome.kind === "alreadySettled") return "That Player action was already completed.";
  if (outcome.kind === "staleAction" || outcome.kind === "unknownAction") {
    return "That Player action is no longer active.";
  }
  if (outcome.kind === "notDue") return "That timed action is not due yet.";
  if (outcome.kind === "invalidObservation") return outcome.message;
  return "The Player operation completed.";
}

function handlePlayerPointer(event: PointerEvent): void {
  if (
    event.button !== 0 ||
    !event.isPrimary ||
    interactiveEventTarget(event.target) ||
    relevantPlayerTextSelection()
  )
    return;
  if (currentPlayerPresentation().pacingGate === null) return;
  skipPacing();
}

function relevantPlayerTextSelection(): boolean {
  const selection = document.getSelection();
  return (
    selection !== null &&
    !selection.isCollapsed &&
    (elements.playerPanel.contains(selection.anchorNode) ||
      elements.playerPanel.contains(selection.focusNode))
  );
}

function handleComposerKeydown(event: KeyboardEvent): void {
  if (
    event.key !== " " ||
    event.isComposing ||
    elements.composerInput.value !== "" ||
    elements.composerInput.selectionStart !== elements.composerInput.selectionEnd ||
    document.activeElement !== elements.composerInput ||
    currentPlayerPresentation().pacingGate === null
  ) {
    return;
  }
  event.preventDefault();
  skipPacing();
}

function interactiveEventTarget(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    target.closest("button, input, select, textarea, a, [role='button']") !== null
  );
}

function currentPlayerPresentation(): WorkspacePlayerPresentation {
  return snapshot === null
    ? Object.freeze({ activeInteraction: null, pacingGate: null })
    : inspectWorkspacePlayerPresentation(snapshot);
}

function renderPlayerControls(presentation: WorkspacePlayerPresentation): void {
  const interaction = presentation.activeInteraction;
  elements.interactionControls.replaceChildren();
  elements.interactionRegion.hidden = interaction === null && playerFeedback.length === 0;
  elements.interactionFeedback.textContent = playerFeedback;
  elements.composerInput.setAttribute("aria-invalid", playerFeedback.length > 0 ? "true" : "false");
  elements.composerInput.placeholder = "";
  elements.composerInput.inputMode = "text";

  const current = runtimeIsCurrent();
  const acceptsTypedAnswer =
    interaction !== null &&
    (interaction.interactionKind === "text" ||
      interaction.interactionKind === "number" ||
      interaction.interactionKind === "choice");
  elements.composerInput.disabled =
    !current || (interaction === null && presentation.pacingGate === null);
  elements.composerSubmit.disabled = !current || !acceptsTypedAnswer;

  if (interaction === null) {
    elements.composerInput.setAttribute("aria-label", "Chat composer");
    elements.composerHelp.textContent =
      presentation.pacingGate === null
        ? "Run the script to start the Player."
        : "Press Space while this empty composer is focused, or tap the Player background, to skip pacing.";
    if (presentation.pacingGate !== null) {
      focusNewInteraction(presentation.pacingGate.actionId, elements.composerInput);
    }
    return;
  }

  const accessibleName = interactionAccessibleName(interaction.ui.accessibleName);
  if (interaction.ui.kind === "button") {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = interaction.ui.buttonLabel;
    button.setAttribute("aria-label", accessibleName);
    button.addEventListener("click", activateButton);
    elements.interactionControls.append(button);
    elements.composerInput.setAttribute("aria-label", "Chat composer");
    elements.composerHelp.textContent = "Activate the scripted button above to continue.";
    focusNewInteraction(interaction.actionId, button);
    return;
  }

  elements.composerInput.setAttribute("aria-label", accessibleName);
  if (interaction.ui.kind === "text" || interaction.ui.kind === "number") {
    elements.composerInput.placeholder = interaction.ui.hint ?? "";
    elements.composerInput.inputMode = interaction.ui.kind === "number" ? "decimal" : "text";
    elements.composerHelp.textContent =
      interaction.ui.kind === "number"
        ? "Enter the scripted number answer. Engine validation is shown above."
        : "Enter the scripted text answer. Engine validation is shown above.";
    focusNewInteraction(interaction.actionId, elements.composerInput);
    return;
  }

  renderChoiceControls(accessibleName, interaction.ui);
  elements.composerHelp.textContent = "Type one exact visible option or select a rendered control.";
  focusNewInteraction(interaction.actionId, elements.composerInput);
}

function renderChoiceControls(
  accessibleName: string,
  choice: Extract<
    NonNullable<WorkspacePlayerPresentation["activeInteraction"]>["ui"],
    { kind: "choice" }
  >,
): void {
  const group = document.createElement("fieldset");
  const legend = document.createElement("legend");
  legend.textContent = accessibleName;
  const buttons = document.createElement("div");
  buttons.className = "choice-buttons";
  const select = document.createElement("select");
  select.className = "choice-select";
  select.setAttribute("aria-label", accessibleName);
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = accessibleName;
  placeholder.disabled = true;
  placeholder.selected = true;
  select.append(placeholder);

  choice.options.forEach((option, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = option.text;
    if (option.text.length === 0)
      button.setAttribute("aria-label", `${accessibleName} ${index + 1}`);
    button.addEventListener("click", () => {
      selectChoice(
        option.label === null
          ? { kind: "text", value: option.text }
          : { kind: "label", value: option.label },
      );
    });
    buttons.append(button);
    const selectOption = document.createElement("option");
    selectOption.value = String(index + 1);
    selectOption.textContent = option.text;
    if (option.text.length === 0)
      selectOption.setAttribute("aria-label", `${accessibleName} ${index + 1}`);
    select.append(selectOption);
  });
  select.addEventListener("change", () => {
    const option = choice.options[Number(select.value) - 1];
    if (option === undefined) return;
    selectChoice(
      option.label === null
        ? { kind: "text", value: option.text }
        : { kind: "label", value: option.label },
    );
  });
  group.append(legend, buttons, select);
  elements.interactionControls.append(group);
  updateChoicePresentation();
}

function updateChoicePresentation(): void {
  const choiceGroup = elements.interactionControls.querySelector("fieldset");
  if (choiceGroup === null) return;
  choiceGroup.classList.remove("choice-compact");
  if (elements.playerPanel.scrollHeight > elements.playerPanel.clientHeight) {
    choiceGroup.classList.add("choice-compact");
  }
}

function interactionAccessibleName(
  value: NonNullable<WorkspacePlayerPresentation["activeInteraction"]>["ui"]["accessibleName"],
): string {
  if (value.kind === "text") return value.text;
  return {
    answer: "Answer",
    number: "Number",
    chooseOption: "Choose an option",
    continue: "Continue",
  }[value.key];
}

function focusNewInteraction(actionId: number, target: HTMLElement): void {
  if (lastFocusedActionId === actionId) return;
  lastFocusedActionId = actionId;
  target.focus();
}

function setPlayerFeedback(message: string): void {
  playerFeedback = message;
}

function clearPlayerFeedback(): void {
  playerFeedback = "";
}

function renderDiagnostics(
  diagnostics: readonly {
    code: string;
    message: string;
    line: number;
    column: number;
    length: number;
  }[],
): void {
  elements.diagnostics.replaceChildren();
  if (diagnostics.length === 0) {
    const item = document.createElement("li");
    item.className = "diagnostic-ok";
    item.textContent = "No parser or semantic diagnostics.";
    elements.diagnostics.append(item);
    return;
  }

  for (const diagnostic of diagnostics) {
    const button = document.createElement("button");
    button.className = "diagnostic-button";
    button.textContent = `${diagnostic.code} (${diagnostic.line}:${diagnostic.column}) ${diagnostic.message}`;
    button.addEventListener("click", () => {
      const start = offsetAt(elements.source.value, diagnostic.line, diagnostic.column);
      elements.source.focus();
      elements.source.setSelectionRange(start, start + Math.max(1, diagnostic.length));
    });
    const item = document.createElement("li");
    item.append(button);
    elements.diagnostics.append(item);
  }
}

function renderTranscriptEvent(event: InterpreterEvent): void {
  if (event.kind !== "say" && event.kind !== "playerTranscript") return;
  const item = document.createElement("li");
  const meta = document.createElement("span");
  meta.className = "event-meta";
  meta.textContent = `Event #${event.sequence}`;

  if (event.kind === "say") {
    const speaker = document.createElement("span");
    speaker.className = "event-speaker";
    speaker.textContent = event.speaker?.displayName ?? "Narrator";
    item.append(speaker, document.createTextNode(event.text), document.createElement("br"), meta);
  } else {
    item.classList.add("event-player");
    const speaker = document.createElement("span");
    speaker.className = "event-speaker";
    speaker.textContent = "You";
    item.append(speaker, document.createTextNode(event.text), document.createElement("br"), meta);
  }

  elements.transcript.append(item);
  elements.transcript.scrollTop = elements.transcript.scrollHeight;
}

function renderState(): void {
  elements.instructionPlan.textContent = prettyJson(plan);
  elements.runtimeState.textContent = prettyJson(snapshot);
  elements.eventLog.textContent = prettyJson(eventLog);
  elements.instructionPosition.textContent =
    plan === null || snapshot === null
      ? "—"
      : `${snapshot.nextInstruction} / ${plan.instructions.length}`;
  elements.runtimeStatus.textContent =
    snapshot?.status ?? (plan === null ? "compile/stale" : "uninitialized");

  const current = runtimeIsCurrent();
  elements.sourceRevision.textContent = `Source revision ${sourceRevision}; ${
    current ? `runtime revision ${compiledRevision} is current` : "runtime is stale or uncompiled"
  }.`;
  elements.run.disabled = !current;
  elements.step.disabled = !current;
  elements.saveCheckpoint.disabled = !current;
  elements.restoreCheckpoint.disabled = !current;
  renderPlayerControls(currentPlayerPresentation());
}

function renderSourceLines(): void {
  const lineCount = elements.source.value.split("\n").length;
  elements.sourceLines.textContent = Array.from({ length: lineCount }, (_, index) =>
    String(index + 1),
  ).join("\n");
  elements.sourceLines.scrollTop = elements.source.scrollTop;
}

function offsetAt(source: string, line: number, column: number): number {
  const lines = source.split("\n");
  const prefixLength = lines
    .slice(0, line - 1)
    .reduce((total, value) => total + value.length + 1, 0);
  return prefixLength + column - 1;
}
function safeStorageGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    setActionStatus("Local draft persistence is unavailable in this browser.");
    return null;
  }
}

function safeStorageSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    setActionStatus("Local draft could not be saved in this browser.");
  }
}

function safeStorageRemove(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    setActionStatus("Local draft could not be cleared in this browser.");
  }
}
function setActionStatus(message: string): void {
  elements.actionStatus.textContent = message;
}

function prettyJson(value: unknown): string {
  return JSON.stringify(value, null, 2) ?? "null";
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function requiredElement(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (element === null) {
    throw new Error(`Missing playground element #${id}.`);
  }
  return element;
}

function requiredButton(id: string): HTMLButtonElement {
  const element = requiredElement(id);
  if (!(element instanceof HTMLButtonElement)) {
    throw new Error(`Playground element #${id} is not a button.`);
  }
  return element;
}

function requiredForm(id: string): HTMLFormElement {
  const element = requiredElement(id);
  if (!(element instanceof HTMLFormElement)) {
    throw new Error(`Playground element #${id} is not a form.`);
  }
  return element;
}

function requiredInput(id: string): HTMLInputElement {
  const element = requiredElement(id);
  if (!(element instanceof HTMLInputElement)) {
    throw new Error(`Playground element #${id} is not an input.`);
  }
  return element;
}

function requiredSelect(id: string): HTMLSelectElement {
  const element = requiredElement(id);
  if (!(element instanceof HTMLSelectElement)) {
    throw new Error(`Playground element #${id} is not a select.`);
  }
  return element;
}

function requiredTextarea(id: string): HTMLTextAreaElement {
  const element = requiredElement(id);
  if (!(element instanceof HTMLTextAreaElement)) {
    throw new Error(`Playground element #${id} is not a textarea.`);
  }
  return element;
}

function requiredFile(id: string): HTMLInputElement {
  const element = requiredElement(id);
  if (!(element instanceof HTMLInputElement) || element.type !== "file") {
    throw new Error(`Playground element #${id} is not a file input.`);
  }
  return element;
}
