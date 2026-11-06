import assert from "node:assert/strict";
import test from "node:test";

import { compilePlayerProject, createPlayerRuntimeSession } from "../player/compile-project.js";
import { BridgeRequestError, connectBridge } from "../player/engine-bridge/client.js";
import { heldRecording } from "../player/engine-bridge/in-process.js";
import { admissionOf, type HeldMedia } from "../player/engine-bridge/held-media.js";
import { nodeWorkerPort } from "../player/engine-bridge/node-client.js";
import type { PrepareResult } from "../player/engine-bridge/player-ops.js";
import { DebugRecorder } from "../player/debug-recorder.js";
import { PlayerBridge } from "../player/player-bridge.js";
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
  submitPlayerRuntimeComposer,
  submitPlayerRuntimeForm,
  type PlayerRuntimeSession,
} from "../player/runtime-adapter.js";
import {
  activePlayerRuntimeInteraction,
  pendingPlayerRuntimeStorageWrite,
  playerRuntimeForeground,
  playerRuntimePermanentButtons,
  type PlayerSession,
  type PlayerSessionView,
} from "../player/runtime-view.js";
import { serializeValidatedRuntimeJson } from "../src/runtime/snapshot/checkpoint-json.js";
import { DEFAULT_TEMPORAL_CONTEXT } from "../src/temporal.js";
import { inProcessBridge } from "./helpers/in-process-bridge.js";

/*
 * L5c's bridge: the player's answers, the permanent buttons, and the storage write's acknowledgement and Debug's edit,
 * as ops of the engine's host. They give what today's adapter calls give, in-process and over a Worker, and refuse
 * malformed or stale input without effect.
 */

const BUILD = { commit: null, dirty: null, mode: null, appVersion: null };
const PLAYER_WORKER = new URL("../player/engine-bridge/node-worker.js", import.meta.url);
const START = { wallClockMs: 0, temporalContext: DEFAULT_TEMPORAL_CONTEXT };
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
  'let skipped = askImage("Skip", allowSkip: true)',
  'let picture = askImage("Picture")',
  'showPopup "Done"',
  'exportText("Plain")',
  'openUrl("https://example.com")',
  'save 1 as "kept"',
  'showButton "End"',
  'let edited: int? = load "edited", default: null',
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
    "draft",
    (shown) => ({
      op: "draftForm",
      args: { actionId: presented(shown), fieldId: "first", text: "Bo" },
    }),
  ],
  ["form", answer("submitForm", { draft: null })],
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

/** The tape through `bridge`: each step's op, outcome, and the session it shows after it. */
async function playTape(bridge: PlayerBridge, recording = false) {
  let session: PlayerSession = await bridge.start(await prepared(bridge), START, recording);
  const steps: unknown[] = [shown(session)];
  for (const [name, step] of TAPE) {
    const sent = step(session);
    assert.ok(sent, name);
    const outcome = await bridge.request<{ readonly kind: string } | null>(
      session,
      sent.op,
      sent.args,
    );
    session = bridge.latest(session)!;
    steps.push({ name, op: sent.op, outcome, session: shown(session) });
  }
  return { steps, session };
}

test("L5c's ops give the same replies, publications and events in-process and in a Worker", async () => {
  const worker = new PlayerBridge(await connectBridge(nodeWorkerPort(PLAYER_WORKER, BUILD), BUILD));
  try {
    const local = await playTape(await inProcessBridge());
    const remote = await playTape(worker);
    assert.deepEqual(remote.steps, local.steps);
    console.log(
      JSON.stringify(
        local.steps.slice(1).map((step) => {
          // EVIDENCE: fixture: `playTape` pushes these fields after the first entry.
          const { name, outcome } = step as { name: string; outcome: { kind: string } | null };
          return [name, outcome?.kind ?? null];
        }),
      ),
    );
    console.log(JSON.stringify(local.session.transcriptEntries.map((entry) => entry.text)));
    console.log(local.session.state.status);
  } finally {
    worker.client.terminate();
  }
});
