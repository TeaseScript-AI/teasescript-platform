import { CheckpointError, createCheckpoint, deserializeCheckpoint, serializeCheckpoint, type InstructionPlan, type InterpreterEvent, type RuntimeSnapshot } from "../src/index.js";
import { checkpointStorageKey, exampleUrl, isPlaygroundExampleName, PLAYGROUND_EXAMPLES, type PlaygroundExampleName } from "./examples.js";
import { MAX_WORKSPACE_SOURCE_BYTES, compileWorkspaceSource, executeWorkspaceSnapshot, type WorkspaceResult } from "./workspace.js";

const DRAFT_KEY = "teasescript-playground-draft-v1";
const elements = {
  source: requiredTextarea("source-code"), sourceLines: requiredElement("source-lines"), sourcePanel: requiredElement("source-panel"), playerPanel: requiredElement("player-panel"), diagnostics: requiredElement("diagnostics"), transcript: requiredElement("transcript"), instructionPosition: requiredElement("instruction-position"), runtimeStatus: requiredElement("runtime-status"), eventLog: requiredElement("event-log"), instructionPlan: requiredElement("instruction-plan"), runtimeState: requiredElement("runtime-state"), actionStatus: requiredElement("action-status"), loadedExampleName: requiredElement("loaded-example-name"), sourceRevision: requiredElement("source-revision"), exampleSelect: requiredSelect("example-select"), compile: requiredButton("compile"), run: requiredButton("run"), step: requiredButton("step"), reset: requiredButton("reset"), saveCheckpoint: requiredButton("save-checkpoint"), restoreCheckpoint: requiredButton("restore-checkpoint"), clearCheckpoint: requiredButton("clear-checkpoint"), reloadExample: requiredButton("reload-example"), importSource: requiredButton("import-source"), exportSource: requiredButton("export-source"), refreshWorkspace: requiredButton("refresh-workspace"), sourceFile: requiredFile("source-file"),
};

let sourceRevision = 0;
let compiledRevision: number | null = null;
let plan: InstructionPlan | null = null;
let snapshot: RuntimeSnapshot | null = null;
let eventLog: InterpreterEvent[] = [];
let currentExample: PlaygroundExampleName = "main";

for (const [name, example] of Object.entries(PLAYGROUND_EXAMPLES)) { const option = document.createElement("option"); option.value = name; option.textContent = example.label; elements.exampleSelect.append(option); }
elements.exampleSelect.value = currentExample;
elements.compile.addEventListener("click", compileAndReset);
elements.run.addEventListener("click", () => execute("run"));
elements.step.addEventListener("click", () => execute("step"));
elements.reset.addEventListener("click", compileAndReset);
elements.saveCheckpoint.addEventListener("click", saveCheckpoint);
elements.restoreCheckpoint.addEventListener("click", restoreSavedCheckpoint);
elements.clearCheckpoint.addEventListener("click", clearSavedCheckpoint);
elements.reloadExample.addEventListener("click", () => void reloadExample());
elements.importSource.addEventListener("click", () => elements.sourceFile.click());
elements.sourceFile.addEventListener("change", () => void importSource());
elements.exportSource.addEventListener("click", exportSource);
elements.refreshWorkspace.addEventListener("click", () => void refreshAutomationWorkspace());
elements.exampleSelect.addEventListener("change", () => { if (isPlaygroundExampleName(elements.exampleSelect.value)) { currentExample = elements.exampleSelect.value; void reloadExample(); } });
elements.source.addEventListener("input", sourceEdited);
elements.source.addEventListener("scroll", () => { elements.sourceLines.scrollTop = elements.source.scrollTop; });
new ResizeObserver(() => { elements.playerPanel.style.height = `${elements.sourcePanel.offsetHeight}px`; }).observe(elements.sourcePanel);
void loadInitialSource();

async function loadInitialSource(): Promise<void> {
  const draft = safeStorageGet(DRAFT_KEY);
  if (draft !== null) { replaceSource(draft, "Local draft restored; compile it to create a current runtime.", "Local draft"); return; }
  await reloadExample();
}

async function reloadExample(): Promise<void> {
  setActionStatus(`Loading ${PLAYGROUND_EXAMPLES[currentExample].label}…`);
  try {
    const response = await fetch(exampleUrl(currentExample), { cache: "no-store" });
    if (!response.ok) throw new Error(`Example request failed with HTTP ${response.status}.`);
    safeStorageRemove(DRAFT_KEY);
    replaceSource(await response.text(), "Repository example loaded.", PLAYGROUND_EXAMPLES[currentExample].label);
    compileAndReset();
  } catch (error) { setActionStatus(errorMessage(error)); }
}

function replaceSource(value: string, message: string, label: string): void {
  elements.source.value = value; elements.loadedExampleName.textContent = label; sourceEdited(); setActionStatus(message);
}

function sourceEdited(): void {
  sourceRevision += 1;
  plan = null; snapshot = null; compiledRevision = null; eventLog = [];
  elements.transcript.replaceChildren(); safeStorageSet(DRAFT_KEY, elements.source.value); renderState();
  renderSourceLines();
}

function compileAndReset(): void {
  try {
    const result = compileWorkspaceSource(elements.source.value);
    applyResult(result, true); compiledRevision = result.plan === null ? null : sourceRevision;
    setActionStatus(result.plan === null ? "Compilation has errors." : "Compiled current source into a fresh runtime.");
  } catch (error) { setActionStatus(errorMessage(error)); }
}

function execute(mode: "run" | "step"): void {
  if (!runtimeIsCurrent()) { setActionStatus("Compile the current source before execution; the previous runtime is stale."); return; }
  try { applyResult(executeWorkspaceSnapshot(plan as InstructionPlan, snapshot as RuntimeSnapshot, mode), false); setActionStatus(`${mode === "run" ? "Run" : "Step"} executed.`); } catch (error) { setActionStatus(errorMessage(error)); }
}

function applyResult(result: WorkspaceResult, resetEvents: boolean): void {
  plan = result.plan; snapshot = result.snapshot;
  renderDiagnostics(result.diagnostics);
  if (resetEvents) { eventLog = []; elements.transcript.replaceChildren(); }
  for (const event of result.events) { eventLog.push(event); renderTranscriptEvent(event); }
  renderState();
}

function runtimeIsCurrent(): boolean { return plan !== null && snapshot !== null && compiledRevision === sourceRevision; }

function saveCheckpoint(): void {
  if (!runtimeIsCurrent()) { setActionStatus("Checkpoints require a current compiled runtime."); return; }
  try { localStorage.setItem(checkpointStorageKey(currentExample), serializeCheckpoint(createCheckpoint(plan as InstructionPlan, snapshot as RuntimeSnapshot))); setActionStatus("Checkpoint saved locally."); } catch (error) { setActionStatus(errorMessage(error)); }
}

function restoreSavedCheckpoint(): void {
  if (!runtimeIsCurrent()) { setActionStatus("Compile the current source before restoring a checkpoint."); return; }
  try { const serialized = localStorage.getItem(checkpointStorageKey(currentExample)); if (serialized === null) { setActionStatus("No saved checkpoint exists."); return; } const checkpoint = deserializeCheckpoint(serialized); if (JSON.stringify(plan) !== JSON.stringify(checkpoint.plan)) { setActionStatus("Checkpoint restore refused: its self-contained plan is incompatible with the current source runtime."); return; } snapshot = checkpoint.snapshot; eventLog = []; elements.transcript.replaceChildren(); renderState(); setActionStatus("Checkpoint restored; waiting state and pending action are retained."); } catch (error) { setActionStatus(error instanceof CheckpointError ? `${error.info.code}: ${error.info.message}` : errorMessage(error)); }
}

function clearSavedCheckpoint(): void { try { localStorage.removeItem(checkpointStorageKey(currentExample)); setActionStatus("Saved checkpoint cleared."); } catch (error) { setActionStatus(errorMessage(error)); } }

async function importSource(): Promise<void> {
  const file = elements.sourceFile.files?.[0]; elements.sourceFile.value = "";
  if (file === undefined) return;
  if (!file.name.toLowerCase().endsWith(".tease") || file.size > MAX_WORKSPACE_SOURCE_BYTES) { setActionStatus(`Import requires one .tease file no larger than ${MAX_WORKSPACE_SOURCE_BYTES} bytes.`); return; }
  try { const text = await file.text(); if (new TextEncoder().encode(text).byteLength > MAX_WORKSPACE_SOURCE_BYTES) throw new Error("Imported source is too large."); replaceSource(text, "Local file loaded; compile it to create a runtime.", file.name); } catch (error) { setActionStatus(`Import failed: ${errorMessage(error)}`); }
}

function exportSource(): void { const blob = new Blob([elements.source.value], { type: "text/plain;charset=utf-8" }); const link = document.createElement("a"); link.href = URL.createObjectURL(blob); link.download = "teasescript-workspace.tease"; link.click(); URL.revokeObjectURL(link.href); setActionStatus("Source exported as teasescript-workspace.tease."); }

async function refreshAutomationWorkspace(): Promise<void> {
  try { const response = await fetch("/api/workspace", { cache: "no-store" }); if (!response.ok) throw new Error(`Automation workspace request failed with HTTP ${response.status}.`); const data = await response.json() as { source: string; result: WorkspaceResult | null }; replaceSource(data.source, "Automation source loaded; compile or run locally to create a fresh browser runtime.", "Automation workspace"); if (data.result !== null) setActionStatus("Automation source loaded. Its result is shown only after recompiling locally to prevent stale state reuse."); } catch (error) { setActionStatus(errorMessage(error)); }
}

function renderDiagnostics(diagnostics: readonly { code: string; message: string; line: number; column: number; length: number }[]): void { elements.diagnostics.replaceChildren(); if (diagnostics.length === 0) { const item = document.createElement("li"); item.className = "diagnostic-ok"; item.textContent = "No parser or semantic diagnostics."; elements.diagnostics.append(item); return; } for (const diagnostic of diagnostics) { const button = document.createElement("button"); button.className = "diagnostic-button"; button.textContent = `${diagnostic.code} (${diagnostic.line}:${diagnostic.column}) ${diagnostic.message}`; button.addEventListener("click", () => { const start = offsetAt(elements.source.value, diagnostic.line, diagnostic.column); elements.source.focus(); elements.source.setSelectionRange(start, start + Math.max(1, diagnostic.length)); }); const item = document.createElement("li"); item.append(button); elements.diagnostics.append(item); } }
function renderTranscriptEvent(event: InterpreterEvent): void { const item = document.createElement("li"); const meta = document.createElement("span"); meta.className = "event-meta"; meta.textContent = `Event #${event.sequence}`; if (event.kind === "say") { const speaker = document.createElement("span"); speaker.className = "event-speaker"; speaker.textContent = event.speaker?.displayName ?? "Narrator"; item.append(speaker, document.createTextNode(event.text), document.createElement("br"), meta); } else if (event.kind === "developerWarning" || event.kind === "runtimeFailure") { item.classList.add(event.kind === "developerWarning" ? "event-warning" : "event-failure"); item.append(document.createTextNode(`${event.code}: ${event.message}`), document.createElement("br"), meta); } else if (event.kind === "actionRequested") { item.classList.add("event-action"); item.append(document.createTextNode(`Action requested: ${event.action.kind} #${event.action.actionId}; runtime is waiting.`), document.createElement("br"), meta); } else if (event.kind === "actionCompleted") { item.classList.add("event-action"); item.append(document.createTextNode(`Action completed: ${event.settlement.actionKind} #${event.settlement.actionId}.`), document.createElement("br"), meta); } else { item.classList.add("event-complete"); item.append(document.createTextNode(event.kind === "exit" ? "Session exited." : "Plan completed."), document.createElement("br"), meta); } elements.transcript.append(item); }
function renderState(): void { elements.instructionPlan.textContent = prettyJson(plan); elements.runtimeState.textContent = prettyJson(snapshot); elements.eventLog.textContent = prettyJson(eventLog); elements.instructionPosition.textContent = plan === null || snapshot === null ? "—" : `${snapshot.nextInstruction} / ${plan.instructions.length}`; elements.runtimeStatus.textContent = snapshot?.status ?? (plan === null ? "compile/stale" : "uninitialized"); const current = runtimeIsCurrent(); elements.sourceRevision.textContent = `Source revision ${sourceRevision}; ${current ? `runtime revision ${compiledRevision} is current` : "runtime is stale or uncompiled"}.`; elements.run.disabled = !current; elements.step.disabled = !current; elements.saveCheckpoint.disabled = !current; elements.restoreCheckpoint.disabled = !current; }
function renderSourceLines(): void { elements.sourceLines.textContent = Array.from({ length: elements.source.value.split("\n").length }, (_, index) => String(index + 1)).join("\n"); elements.sourceLines.scrollTop = elements.source.scrollTop; }
function offsetAt(source: string, line: number, column: number): number { const lines = source.split("\n"); return lines.slice(0, line - 1).reduce((total, value) => total + value.length + 1, 0) + column - 1; }
function safeStorageGet(key: string): string | null { try { return localStorage.getItem(key); } catch { setActionStatus("Local draft persistence is unavailable in this browser."); return null; } }
function safeStorageSet(key: string, value: string): void { try { localStorage.setItem(key, value); } catch { setActionStatus("Local draft could not be saved in this browser."); } }
function safeStorageRemove(key: string): void { try { localStorage.removeItem(key); } catch { setActionStatus("Local draft could not be cleared in this browser."); } }
function setActionStatus(message: string): void { elements.actionStatus.textContent = message; }
function prettyJson(value: unknown): string { return JSON.stringify(value, null, 2) ?? "null"; }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function requiredElement(id: string): HTMLElement { const element = document.getElementById(id); if (element === null) throw new Error(`Missing playground element #${id}.`); return element; }
function requiredButton(id: string): HTMLButtonElement { const element = requiredElement(id); if (!(element instanceof HTMLButtonElement)) throw new Error(`Playground element #${id} is not a button.`); return element; }
function requiredSelect(id: string): HTMLSelectElement { const element = requiredElement(id); if (!(element instanceof HTMLSelectElement)) throw new Error(`Playground element #${id} is not a select.`); return element; }
function requiredTextarea(id: string): HTMLTextAreaElement { const element = requiredElement(id); if (!(element instanceof HTMLTextAreaElement)) throw new Error(`Playground element #${id} is not a textarea.`); return element; }
function requiredFile(id: string): HTMLInputElement { const element = requiredElement(id); if (!(element instanceof HTMLInputElement) || element.type !== "file") throw new Error(`Playground element #${id} is not a file input.`); return element; }
