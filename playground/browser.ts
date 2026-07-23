import {
  CheckpointError,
  compileSource,
  createCheckpoint,
  createFreshRuntimeSnapshot,
  deserializeCheckpoint,
  run,
  serializeCheckpoint,
  stepToEvent,
  type Diagnostic,
  type InstructionPlan,
  type InterpreterEvent,
  type RuntimeOperationResult,
  type RuntimeSnapshot,
} from "../src/index.js";

const exampleUrl = "/examples/playground/main.tease";
const checkpointStorageKey = "teasescript-playground-checkpoint-v1";

const elements = {
  source: requiredElement("source-code"),
  diagnostics: requiredElement("diagnostics"),
  transcript: requiredElement("transcript"),
  instructionPosition: requiredElement("instruction-position"),
  runtimeStatus: requiredElement("runtime-status"),
  eventLog: requiredElement("event-log"),
  instructionPlan: requiredElement("instruction-plan"),
  runtimeState: requiredElement("runtime-state"),
  actionStatus: requiredElement("action-status"),
  run: requiredButton("run"),
  step: requiredButton("step"),
  reset: requiredButton("reset"),
  saveCheckpoint: requiredButton("save-checkpoint"),
  restoreCheckpoint: requiredButton("restore-checkpoint"),
  clearCheckpoint: requiredButton("clear-checkpoint"),
  reloadExample: requiredButton("reload-example"),
};

let source = "";
let plan: InstructionPlan | null = null;
let snapshot: RuntimeSnapshot | null = null;
let eventLog: InterpreterEvent[] = [];

elements.run.addEventListener("click", () => execute("run"));
elements.step.addEventListener("click", () => execute("step"));
elements.reset.addEventListener("click", resetRuntime);
elements.saveCheckpoint.addEventListener("click", saveCheckpoint);
elements.restoreCheckpoint.addEventListener("click", restoreSavedCheckpoint);
elements.clearCheckpoint.addEventListener("click", clearSavedCheckpoint);
elements.reloadExample.addEventListener("click", () => void reloadExample());

void reloadExample();

async function reloadExample(): Promise<void> {
  setActionStatus("Loading repository example…");
  try {
    const response = await fetch(exampleUrl, { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`Example request failed with HTTP ${response.status}.`);
    }
    source = await response.text();
    elements.source.textContent = source;
    compileAndReset();
    setActionStatus("Example loaded.");
  } catch (error) {
    plan = null;
    snapshot = null;
    renderDiagnostics([]);
    renderState();
    setActionStatus(errorMessage(error));
  }
}

function compileAndReset(): void {
  const compilation = compileSource(source);
  renderDiagnostics(compilation.diagnostics);
  plan = compilation.plan;
  snapshot = plan === null ? null : createFreshRuntimeSnapshot(plan);
  eventLog = [];
  elements.transcript.replaceChildren();
  renderState();
}

function resetRuntime(): void {
  compileAndReset();
  setActionStatus(plan === null ? "Compilation has errors." : "Runtime reset.");
}

function execute(mode: "run" | "step"): void {
  if (plan === null || snapshot === null) {
    setActionStatus("Compile the example successfully before execution.");
    return;
  }
  try {
    const operation =
      mode === "run"
        ? run(plan, snapshot, {}, { instructionBudget: 10_000 })
        : stepToEvent(plan, snapshot, {}, { instructionBudget: 10_000 });
    applyOperation(operation);
    setActionStatus(
      mode === "run"
        ? `Run executed ${operation.instructionsExecuted} instruction(s).`
        : `Step executed ${operation.instructionsExecuted} instruction(s).`,
    );
  } catch (error) {
    setActionStatus(errorMessage(error));
  }
}

function applyOperation(operation: RuntimeOperationResult): void {
  snapshot = operation.snapshot;
  for (const event of operation.events) {
    eventLog.push(event);
    renderTranscriptEvent(event);
  }
  renderState();
}

function saveCheckpoint(): void {
  if (plan === null || snapshot === null) {
    setActionStatus("There is no runtime checkpoint to save.");
    return;
  }
  try {
    localStorage.setItem(
      checkpointStorageKey,
      serializeCheckpoint(createCheckpoint(plan, snapshot)),
    );
    setActionStatus("Checkpoint saved in localStorage.");
  } catch (error) {
    setActionStatus(errorMessage(error));
  }
}

function restoreSavedCheckpoint(): void {
  try {
    const serialized = localStorage.getItem(checkpointStorageKey);
    if (serialized === null) {
      setActionStatus("No saved checkpoint exists.");
      return;
    }
    const checkpoint = deserializeCheckpoint(serialized);
    plan = checkpoint.plan;
    snapshot = checkpoint.snapshot;
    eventLog = [];
    elements.transcript.replaceChildren();
    renderState();
    setActionStatus("Checkpoint restored. Transcript UI was cleared.");
  } catch (error) {
    const message =
      error instanceof CheckpointError
        ? `${error.info.code}: ${error.info.message}`
        : errorMessage(error);
    setActionStatus(message);
  }
}

function clearSavedCheckpoint(): void {
  try {
    localStorage.removeItem(checkpointStorageKey);
    setActionStatus("Saved checkpoint cleared.");
  } catch (error) {
    setActionStatus(errorMessage(error));
  }
}

function renderDiagnostics(diagnostics: readonly Diagnostic[]): void {
  elements.diagnostics.replaceChildren();
  if (diagnostics.length === 0) {
    const item = document.createElement("li");
    item.className = "diagnostic-ok";
    item.textContent = "No parser or semantic diagnostics.";
    elements.diagnostics.append(item);
    return;
  }
  for (const diagnostic of diagnostics) {
    const item = document.createElement("li");
    const line = diagnostic.span.start.line + 1;
    const column = diagnostic.span.start.column + 1;
    item.textContent = `${diagnostic.code} (${line}:${column}) ${diagnostic.message}`;
    elements.diagnostics.append(item);
  }
}

function renderTranscriptEvent(event: InterpreterEvent): void {
  const item = document.createElement("li");
  const meta = document.createElement("span");
  meta.className = "event-meta";
  meta.textContent = `Event #${event.sequence}`;

  if (event.kind === "say") {
    const speaker = document.createElement("span");
    speaker.className = "event-speaker";
    speaker.textContent = event.speaker?.displayName ?? "Narrator";
    const text = document.createElement("span");
    text.textContent = event.text;
    item.append(speaker, text, document.createElement("br"), meta);
  } else if (event.kind === "developerWarning") {
    item.classList.add("event-warning");
    item.append(document.createTextNode(`${event.code}: ${event.message}`), document.createElement("br"), meta);
  } else if (event.kind === "runtimeFailure") {
    item.classList.add("event-failure");
    item.append(document.createTextNode(`${event.code}: ${event.message}`), document.createElement("br"), meta);
  } else {
    item.classList.add("event-complete");
    item.append(
      document.createTextNode(event.kind === "exit" ? "Session exited." : "Plan completed."),
      document.createElement("br"),
      meta,
    );
  }
  elements.transcript.append(item);
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
    snapshot?.status ?? (plan === null ? "compile error" : "uninitialized");
}

function setActionStatus(message: string): void {
  elements.actionStatus.textContent = message;
}

function prettyJson(value: unknown): string {
  return JSON.stringify(value, null, 2) ?? "null";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function requiredElement(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (element === null) throw new Error(`Missing playground element #${id}.`);
  return element;
}

function requiredButton(id: string): HTMLButtonElement {
  const element = requiredElement(id);
  if (!(element instanceof HTMLButtonElement)) {
    throw new Error(`Playground element #${id} is not a button.`);
  }
  return element;
}
