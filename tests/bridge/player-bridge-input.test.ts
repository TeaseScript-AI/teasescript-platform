import assert from "node:assert/strict";
import test from "node:test";

import {
  compilePlayerProject,
  createPlayerRuntimeSession,
} from "../../player/runtime/compile-project.js";
import { BridgeRequestError, connectBridge } from "../../player/engine-bridge/client.js";
import { heldRecording } from "../../player/engine-bridge/in-process.js";
import { admissionOf, type HeldMedia } from "../../player/engine-bridge/held-media.js";
import { nodeWorkerPort } from "../../player/engine-bridge/node-client.js";
import type { PrepareResult } from "../../player/engine-bridge/player-ops.js";
import { DebugRecorder } from "../../player/debug/debug-recorder.js";
import { PlayerBridge } from "../../player/runtime/player-bridge.js";
import {
  activatePlayerRuntimeButton,
  answeredByPlayerInput,
  answerPlayerRuntimeImage,
  applyPlayerRuntimeStorageEdit,
  closePlayerRuntimeExport,
  closePlayerRuntimePopup,
  completePlayerRuntimeStorageWrite,
  draftPlayerRuntimeForm,
  openPlayerRuntimeUrl,
  pressPlayerRuntimePermanentButton,
  selectPlayerRuntimeChoice,
  skipPlayerRuntimeImage,
  stepPlayerRuntimeFormField,
  clearPlayerRuntimeFormField,
  dismissPlayerRuntimeFormField,
  cancelPlayerRuntimeForm,
  submitPlayerRuntimeComposer,
  submitPlayerRuntimeForm,
  type PlayerRuntimeSession,
} from "../../player/runtime/runtime-adapter.js";
import {
  activePlayerRuntimeInteraction,
  pendingPlayerRuntimeStorageWrite,
  playerRuntimeForeground,
  playerRuntimePermanentButtons,
  type PlayerSession,
  type PlayerSessionView,
} from "../../player/runtime/runtime-view.js";
import { serializeValidatedRuntimeJson } from "../../src/runtime/snapshot/checkpoint-json.js";
import { DEFAULT_TEMPORAL_CONTEXT } from "../../src/temporal.js";
import { viewCalls, viewed, withoutViews } from "../helpers/debug-readers.js";
import { inProcessBridge } from "../helpers/in-process-bridge.js";
import { untypedBridge } from "../helpers/bridge/untyped.js";

/*
 * L5c's bridge: the player's answers, the permanent buttons, and the storage write's acknowledgement and Debug's edit,
 * as ops of the engine's host. They give what today's adapter calls give, in-process and over a Worker, and refuse
 * malformed or stale input without effect.
 */

const BUILD = { commit: null, dirty: null, mode: null, appVersion: null };
const PLAYER_WORKER = new URL("../../player/engine-bridge/node-worker.js", import.meta.url);
// Persistent storage: a save waits for the host's acknowledgement.
const START = {
  wallClockMs: 0,
  temporalContext: DEFAULT_TEMPORAL_CONTEXT,
  scriptStorage: [],
  persistentScriptStorage: true,
};
const HELD: HeldMedia = [{ reference: "photo-1", kind: "image" }];

/** A script with every L5c input in turn, a permanent button, a save, and a value an edit changes. */
const SCRIPT = [
  'showPermanentButton "Tick" {',
  '    say "tick", instant',
  "}",
  'let name = askText "Name?"',
  'say "hi ${name}", instant',
  'let pick = askChoice "A", "B"',
  'showButton "Go"',
  'let answers = askForm fields: { first: { type: "text", text: "First" } }',
  'let maybe = askForm fields: { on: false }, cancel: "Back"',
  'let skipped = askImage("Skip", allowSkip: true)',
  'let picture = askImage("Picture")',
  'showPopup "Done"',
  'exportText("Plain")',
  'openUrl("https://example.com")',
  'save 1 as "kept"',
  'showButton "End"',
  'let edited: integer? = load "edited", default: null',
  'say "edited ${edited}", instant',
  'showButton "Last"',
  "exit",
].join("\n");

/** One step of the tape: an op and its arguments for the presented action, or `null` when the step does not apply. */
type Step = (
  shown: PlayerSessionView,
) => { readonly op: string; readonly args: Record<string, unknown> } | null;

const presented = (shown: PlayerSessionView) => {
  const actionId = activePlayerRuntimeInteraction(shown.state)?.actionId;
  assert.ok(
    actionId !== undefined,
    `an interaction is presented: ${playerRuntimeForeground(shown)?.kind}`,
  );
  return actionId;
};
const answer =
  (op: string, args: Record<string, unknown> = {}, input: string | null = "button"): Step =>
  (shown) => ({ op, args: { actionId: presented(shown), ...args, input } });

const TAPE: readonly (readonly [string, Step])[] = [
  ["composer", answer("submitComposer", { text: "Ann" }, "enter")],
  [
    "choice",
    (shown) => {
      const foreground = playerRuntimeForeground(shown);
      assert.ok(foreground?.kind === "choose");
      return answer("selectChoice", { optionId: foreground.options[1]!.id })(shown);
    },
  ],
  ["button", answer("activateButton", {}, "preselectedKey")],
  [
    "step",
    (shown) => ({
      op: "stepFormField",
      args: { actionId: presented(shown), fieldId: "first", draft: null },
    }),
  ],
  ["clear", (shown) => ({ op: "clearFormField", args: { actionId: presented(shown) } })],
  ["dismiss", (shown) => ({ op: "dismissFormField", args: { actionId: presented(shown) } })],
  [
    "step again",
    (shown) => ({
      op: "stepFormField",
      args: { actionId: presented(shown), fieldId: "first", draft: null },
    }),
  ],
  [
    "draft",
    (shown) => ({
      op: "draftForm",
      args: { actionId: presented(shown), fieldId: "first", text: "Bo" },
    }),
  ],
  ["form", answer("submitForm", { draft: "Bo" })],
  ["cancel", answer("cancelForm")],
  ["skip", answer("skipImage")],
  ["image", answer("answerImage", { reference: "photo-1", held: HELD })],
  ["popup", answer("closePopup")],
  ["export", answer("closeExport")],
  ["url", answer("openUrl", {}, null)],
  [
    "write",
    (shown) => {
      const write = pendingPlayerRuntimeStorageWrite(shown.state);
      assert.ok(write, "the save waits for the host");
      return { op: "completeStorageWrite", args: { actionId: write.actionId, stored: true } };
    },
  ],
  [
    "press",
    (shown) => ({
      op: "pressPermanentButton",
      args: { buttonId: playerRuntimePermanentButtons(shown.state)[0]!.buttonId },
    }),
  ],
  ["edit", () => ({ op: "applyStorageEdit", args: { key: "edited", value: 7 } })],
  ["end", answer("activateButton")],
  ["last", answer("activateButton")],
];

/** What a session shows, comparable across backends. */
const shown = (session: PlayerSessionView) => ({
  revision: session.revision,
  state: session.state,
  events: [...session.events],
  transcript: session.transcriptEntries.map((entry) => entry.text),
});

async function prepared(bridge: PlayerBridge): Promise<string> {
  const plan = compilePlayerProject(SCRIPT).plan;
  assert.ok(plan);
  const reply = await bridge.client.request("prepare", {
    source: { kind: "plan", text: serializeValidatedRuntimeJson(plan) },
  });
  // EVIDENCE: validation: `prepare` replies from the same build with its result.
  const result = reply.result as PrepareResult;
  assert.equal(result.kind, "prepared");
  return result.kind === "prepared" ? result.plan : "";
}

/**
 * The tape through `bridge`: each step's op, outcome, and the session it shows after it, with what Debug's readers give
 * for it (`viewed`), with the call view on (`calls`) or off.
 */
async function playTape(bridge: PlayerBridge, recording = false, calls = false) {
  let session: PlayerSession = await bridge.start(await prepared(bridge), START, recording);
  if (calls) session = await viewCalls(bridge, session, true);
  const seen = (current: PlayerSession) => ({ ...shown(current), viewed: viewed(current) });
  const steps: unknown[] = [seen(session)];
  for (const [name, step] of TAPE) {
    const sent = step(session);
    assert.ok(sent, name);
    // The tape's step picks its op at run time.
    const outcome = await untypedBridge(bridge).request(session, sent.op, sent.args);
    session = bridge.latest(session)!;
    steps.push({ name, op: sent.op, outcome, session: seen(session) });
  }
  return { steps, session };
}

test("L5c's ops give the same replies, publications and events in-process and in a Worker", async () => {
  const worker = new PlayerBridge(await connectBridge(nodeWorkerPort(PLAYER_WORKER, BUILD), BUILD));
  try {
    const local = await playTape(await inProcessBridge());
    const remote = await playTape(worker);
    assert.deepEqual(remote.steps, local.steps);
    // With the call view (L5f) the critical view is the same, and the full view equal across the backends.
    const full = await playTape(await inProcessBridge(), false, true);
    assert.deepEqual((await playTape(worker, false, true)).steps, full.steps);
    assert.deepEqual(withoutViews(full.steps), withoutViews(local.steps));
    // Every input of the tape answered, so the session ran to its end.
    assert.deepEqual(
      local.steps.slice(1).map((step) => {
        // EVIDENCE: fixture: `playTape` pushes these fields after the first entry.
        const { name, outcome } = step as { name: string; outcome: { kind: string } | null };
        return [name, outcome?.kind ?? null];
      }),
      [
        ["composer", "completed"],
        ["choice", "completed"],
        ["button", "completed"],
        ["step", "updated"],
        // A required field refuses to be cleared, on both backends alike.
        ["clear", "invalidPayload"],
        ["dismiss", "updated"],
        ["step again", "updated"],
        ["draft", "updated"],
        ["form", "completed"],
        ["cancel", "completed"],
        ["skip", "completed"],
        ["image", "completed"],
        ["popup", "completed"],
        ["export", "completed"],
        ["url", "completed"],
        ["write", "completed"],
        ["press", "pressed"],
        ["edit", "applied"],
        ["end", "completed"],
        ["last", "completed"],
      ],
    );
    assert.equal(local.session.state.status, "halted");
    const said = local.session.transcriptEntries.map((entry) => entry.text);
    assert.ok(
      said.includes("hi Ann") && said.includes("tick") && said.includes("edited 7"),
      said.join(" | "),
    );
  } finally {
    worker.client.terminate();
  }
});

/** Today's adapter call for an op of the tape, as the Player made it before L5c, with `input` as `answer()` gave it. */
function direct(session: PlayerRuntimeSession, op: string, args: Record<string, unknown>) {
  // EVIDENCE: fixture: the tape's own arguments, typed by the op that takes them.
  const a = args as {
    readonly actionId: number;
    readonly text: string;
    readonly optionId: string;
    readonly fieldId: string;
    readonly draft: string | null;
    readonly reference: string;
    readonly held: HeldMedia;
    readonly stored: boolean;
    readonly buttonId: number;
    readonly key: string;
    readonly value: number;
    readonly input?: "enter" | "send" | "button" | "preselectedKey" | null;
  };
  const call = (): { readonly session: PlayerRuntimeSession; readonly outcome: unknown } | null => {
    switch (op) {
      case "submitComposer":
        return submitPlayerRuntimeComposer(session, a.text);
      case "selectChoice":
        return selectPlayerRuntimeChoice(session, a.optionId);
      case "activateButton":
        return activatePlayerRuntimeButton(session);
      case "draftForm":
        return draftPlayerRuntimeForm(
          session,
          { actionId: a.actionId, fieldId: a.fieldId },
          a.text,
        );
      case "stepFormField":
        return stepPlayerRuntimeFormField(session, a.fieldId, a.draft ?? undefined);
      case "clearFormField":
        return clearPlayerRuntimeFormField(session);
      case "dismissFormField":
        return dismissPlayerRuntimeFormField(session);
      case "cancelForm":
        return cancelPlayerRuntimeForm(session);
      case "submitForm":
        return submitPlayerRuntimeForm(session, a.draft ?? undefined);
      case "skipImage":
        return skipPlayerRuntimeImage(session);
      case "answerImage":
        return answerPlayerRuntimeImage(session, a.reference, admissionOf(a.held));
      case "closePopup":
        return closePlayerRuntimePopup(session);
      case "closeExport":
        return closePlayerRuntimeExport(session);
      case "openUrl":
        return openPlayerRuntimeUrl(session);
      case "completeStorageWrite":
        return completePlayerRuntimeStorageWrite(session, a.actionId, a.stored);
      case "pressPermanentButton":
        return pressPlayerRuntimePermanentButton(session, a.buttonId);
      case "applyStorageEdit":
        return applyPlayerRuntimeStorageEdit(session, { key: a.key, value: a.value });
    }
    throw new Error(`no adapter call for ${op}`);
  };
  return a.input === undefined || a.input === null
    ? call()
    : answeredByPlayerInput(session, a.input, call);
}

test("L5c's ops give what today's adapter calls give, and the recording keeps how each answer was given", async () => {
  const bridge = await inProcessBridge();
  const viaOps = await playTape(bridge, true);
  const recorder = new DebugRecorder();
  let session = createPlayerRuntimeSession(SCRIPT, { ...START, recorder });
  const steps: unknown[] = [];
  for (const [name, step] of TAPE) {
    const sent = step(session)!;
    const result = direct(session, sent.op, sent.args);
    if (result !== null) session = result.session;
    // A publication carries the critical view: the state without its active calls (L5f).
    const { calls: _calls, ...critical } = session.state;
    steps.push({
      name,
      outcome: result?.outcome ?? null,
      state: critical,
      events: [...session.events],
    });
  }
  assert.deepEqual(
    viaOps.steps.slice(1).map((step) => {
      // EVIDENCE: fixture: `playTape` pushes these fields after the first entry.
      const {
        name,
        outcome,
        session: shownAfter,
      } = step as { name: string; outcome: unknown; session: ReturnType<typeof shown> };
      return { name, outcome, state: shownAfter.state, events: shownAfter.events };
    }),
    steps,
  );
  const recorded = (operations: readonly { readonly kind: string; readonly input?: unknown }[]) =>
    operations.map(({ kind, input }) => [kind, input ?? null]);
  assert.deepEqual(
    recorded(heldRecording(bridge)!.operations),
    recorded(recorder.recording()!.operations),
  );
});

const refused = (code: string) => (error: unknown) =>
  error instanceof BridgeRequestError && error.kind === "bridge" && error.code === code;

test("L5c's ops refuse malformed arguments, and a stale action, a released or a stopped session, without effect", async () => {
  const bridge = await inProcessBridge();
  const session = await bridge.start(await prepared(bridge), START, false);
  const actionId = presented(session);
  for (const [op, args] of [
    ["submitComposer", { actionId, text: 1, input: "enter" }],
    ["submitComposer", { actionId, text: "x", input: "tap" }],
    ["submitComposer", { actionId, text: "x" }],
    ["selectChoice", { actionId: "1", optionId: "a", input: null }],
    [
      "answerImage",
      { actionId, reference: "r", held: [{ reference: "r", kind: "sticker" }], input: null },
    ],
    ["answerImage", { actionId, reference: "r", held: {}, input: null }],
    ["stepFormField", { actionId, fieldId: "f", draft: 3 }],
    ["pressPermanentButton", { buttonId: "1" }],
    ["completeStorageWrite", { actionId, stored: "yes" }],
    ["applyStorageEdit", { key: 1, value: 2 }],
    ["applyStorageEdit", { key: "k" }],
  ] as const)
    await assert.rejects(
      // Malformed on purpose: the host refuses them.
      untypedBridge(bridge).request(session, op, args),
      refused("arguments"),
      `${op} ${JSON.stringify(args)}`,
    );
  // An answer to another action than the presented one changes nothing.
  const before = bridge.latest(session)!;
  const stale = await bridge.request(session, "submitComposer", {
    actionId: actionId + 1,
    text: "Ann",
    input: "enter",
  });
  assert.deepEqual(stale, { kind: "staleAction", actionId: actionId + 1 });
  assert.equal(bridge.latest(session), before);
  // A stopped session takes no answer, and a released one is unknown.
  await bridge.halt(session);
  await assert.rejects(
    bridge.request(session, "submitComposer", { actionId, text: "Ann", input: "enter" }),
    refused("halted"),
  );
  const other = await bridge.start(await prepared(bridge), START, false);
  bridge.release(other);
  await assert.rejects(
    bridge.client.request(
      "submitComposer",
      { actionId, text: "Ann", input: "enter" },
      { session: other.id },
    ),
    refused("session"),
  );
});
