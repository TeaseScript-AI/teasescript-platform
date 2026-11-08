import assert from "node:assert/strict";
import test from "node:test";

import { connectBridge } from "../player/engine-bridge/client.js";
import { createInProcessBackend } from "../player/engine-bridge/in-process.js";
import { nodeWorkerPort } from "../player/engine-bridge/node-client.js";
import { PlayerBridge } from "../player/player-bridge.js";
import type { PlayerCriticalState } from "../player/engine-bridge/session-protocol.js";
import { ADAPTER_OPS } from "./helpers/replay-harness.js";
import { CANDIDATE_OPS, candidatesFor, type Candidate } from "./gate/candidates.js";
import { driveTape, isComplete, type TapeRun } from "./gate/driver.js";
import { judgeTape } from "./gate/oracle.js";
import { OUTCOMES } from "./gate/outcomes.js";
import { TAPE_START } from "./gate/start.js";
import { replayTape, type TapeEntry } from "./gate/tape.js";

/*
 * A lock whose work the host answers unavailable fails the script, so the lock cases end `failed` (an engine failure,
 * a complete prefix).
 *
 * The K/F tape driver's claims (the L5 gate's tape plan §3, design round 1): the structural one, and bounded runtime
 * witnesses whose axes come from the engine's transitions and guards, not from the candidate table. Each case is built
 * from its axis values alone and named by them; it asserts the state the session shows before the first attempt, then
 * the accepted inputs and the tape's outcome, written from the axis values. Every tape also replays unchanged in a Node
 * Worker and agrees with the adapter oracle. The controls' mutants must each fail for their reason.
 */

const BUILD = { commit: null, dirty: null, mode: null, appVersion: null };
const WORKER = new URL("../player/engine-bridge/node-worker.js", import.meta.url);

/** A foreground state and the background-timer composition, or a host/time state alone. */
const TIMER = 'timer async 1 s {\n say "tick", instant\n}\n';

interface Case {
  readonly axis: string;
  readonly state: string;
  readonly source: string;
  /** What the session shows before the first attempt, read from its Start publication. */
  readonly shows: (state: PlayerCriticalState) => boolean;
  /** The ops accepted, in order, at the start of the tape; and the tape's outcome. */
  readonly accepted: readonly string[];
  readonly outcome: string;
  readonly cut?: number;
}

const interactionKind = (state: PlayerCriticalState) =>
  state.foregroundAction?.kind === "interaction" ? state.foregroundAction.ui.kind : null;

/** The states, one per value of each axis; a foreground state is also generated behind a running timer. */
type State = Omit<Case, "source"> & { readonly body: string; readonly composes: boolean };
const STATES: readonly State[] = [
  {
    axis: "lock",
    state: "work",
    body: 'let x = encryptText("x", password: "p", publicKey: false, timeLock: false)\nexit',
    composes: true,
    shows: (s) => s.foregroundAction?.kind === "lock" && s.foregroundAction.phase === "work",
    accepted: ["answerLock"],
    outcome: "failed",
  },
  {
    axis: "lock",
    state: "ask without cancel",
    body: 'let x = encryptText("x")\nexit',
    composes: true,
    shows: (s) => s.foregroundAction?.kind === "lock" && s.foregroundAction.phase === "ask",
    accepted: ["answerLock", "answerLock"],
    outcome: "failed",
  },
  {
    axis: "form",
    state: "required unbounded",
    body: 'let x = askForm fields: { n: { type: "integer" } }\nexit',
    composes: true,
    shows: (s) => interactionKind(s) === "form",
    accepted: ["stepFormField", "submitForm"],
    outcome: "halted",
  },
  {
    axis: "form",
    state: "bounded 10-20",
    body: 'let x = askForm fields: { n: { type: "integer", min: 10, max: 20 } }\nexit',
    composes: true,
    shows: (s) => interactionKind(s) === "form",
    accepted: ["stepFormField", "submitForm"],
    outcome: "halted",
  },
  {
    axis: "form",
    state: "bounded 40-50",
    body: 'let x = askForm fields: { n: { type: "integer", min: 40, max: 50 } }\nexit',
    composes: true,
    shows: (s) => interactionKind(s) === "form",
    accepted: ["stepFormField", "submitForm"],
    outcome: "halted",
  },
  {
    axis: "form",
    state: "optional only",
    body: 'let x = askForm fields: { n: { type: "integer", optional: true } }\nexit',
    composes: true,
    shows: (s) => interactionKind(s) === "form",
    accepted: ["submitForm"],
    outcome: "halted",
  },
  {
    axis: "image",
    state: "skippable",
    body: 'let x = askImage("Image", allowSkip: true) otherwise "x.png"\nexit',
    composes: true,
    shows: (s) => interactionKind(s) === "image",
    accepted: ["skipImage"],
    outcome: "halted",
  },
  {
    axis: "image",
    state: "mandatory",
    body: 'let x = askImage("Image")\nexit',
    composes: false,
    shows: (s) => interactionKind(s) === "image",
    accepted: [],
    outcome: "unsupported",
  },
  {
    axis: "media",
    state: "awaiting load",
    body: 'playAudio "a.mp3"\nexit',
    composes: false,
    shows: (s) => s.backgroundActions.some((a) => a.kind === "media" && !a.media.loaded),
    accepted: ["reportMediaLoad", "stepTime"],
    outcome: "halted",
  },
  {
    axis: "time",
    state: "delay",
    body: "wait 1 s\nexit",
    composes: false,
    shows: (s) => s.foregroundAction?.kind === "delay",
    accepted: ["stepTime"],
    outcome: "halted",
  },
  {
    axis: "time",
    state: "pacing gate",
    body: 'say "A paced message"\nexit',
    composes: false,
    shows: (s) => s.foregroundAction?.kind === "chatPacingGate",
    accepted: ["stepTime"],
    outcome: "halted",
  },
  {
    axis: "host",
    state: "storage write behind a delay",
    body: 'timer async 1 s {\n save 1 as "k"\n}\nwait 2 s\nexit',
    composes: false,
    shows: (s) => s.foregroundAction?.kind === "delay",
    accepted: ["stepTime", "completeStorageWrite"],
    outcome: "halted",
  },
];

/** Pairs that cannot exist, with their reason. */
const EXCLUDED: Readonly<Record<string, string>> = {
  "lock/ask with cancel":
    "a cancellable decrypt dialog needs the host's work -> ask transition, which no candidate proposes (a named coverage residual)",
  "image/mandatory + timer": "its outcome is unsupported before any time step",
  "media/awaiting load + timer": "the timer is the time row itself",
  "time/delay + timer": "the timer is the time row itself",
  "time/pacing gate + timer": "the timer is the time row itself",
  "host/storage write behind a delay + timer": "the timer is the host work itself",
};

const CASES: readonly Case[] = STATES.flatMap(({ body, composes, ...state }) => [
  { ...state, source: body },
  ...(composes ? [{ ...state, state: `${state.state} + timer`, source: TIMER + body }] : []),
]);
const name = (axisCase: { axis: string; state: string }) => `${axisCase.axis}/${axisCase.state}`;

const inProcess = () => createInProcessBackend(BUILD);
const inWorker = async () =>
  new PlayerBridge(await connectBridge(nodeWorkerPort(WORKER, BUILD), BUILD));
const project = (source: string) => ({ files: [{ path: "main.tease", source }] });

async function record(
  source: string,
  options: Parameters<typeof driveTape>[3] = {},
): Promise<TapeRun> {
  const bridge = inProcess();
  try {
    return await driveTape(
      bridge,
      { kind: "source", script: project(source) },
      TAPE_START,
      options,
    );
  } finally {
    bridge.client.terminate();
  }
}

const startState = (run: TapeRun) => {
  const start = run.entries.find((entry) => entry.op === "start");
  assert.ok(start?.reply.ok, "the tape has a Start");
  // EVIDENCE: validation: a Start's reply view is its introduction, with the session's state.
  return (start.reply as { view: { state: PlayerCriticalState } }).view.state;
};
const acceptedOps = (run: TapeRun) =>
  run.entries
    .filter(
      (entry) => entry.op !== "prepare" && entry.op !== "start" && entry.op !== "captureCheckpoint",
    )
    .filter((entry) => {
      // EVIDENCE: validation: every other op a tape sends is a candidate op (`CANDIDATE_OPS`).
      const op = entry.op as Candidate["op"];
      return entry.reply.ok && OUTCOMES[op](entry.reply.result).accepted;
    })
    .map((entry) => entry.op);

async function replayedInWorker(entries: readonly TapeEntry[]) {
  const bridge = await inWorker();
  try {
    return await replayTape(bridge.client, entries);
  } finally {
    bridge.client.terminate();
  }
}

test("the table, the outcomes and the oracle cover the same ops", () => {
  assert.deepEqual(Object.keys(OUTCOMES).sort(), [...CANDIDATE_OPS].sort());
  for (const op of CANDIDATE_OPS)
    assert.ok(Object.hasOwn(ADAPTER_OPS, op), `'${op}' has no oracle path`);
});

test("the witnesses cover every axis value and composition, or name why not", () => {
  const names = new Set(CASES.map(name));
  for (const state of STATES) {
    assert.ok(names.has(name(state)), name(state));
    const composed = `${name(state)} + timer`;
    assert.ok(
      names.has(composed) || Object.hasOwn(EXCLUDED, composed),
      `${composed} is neither generated nor excluded`,
    );
  }
  for (const excluded of Object.keys(EXCLUDED))
    assert.ok(!names.has(excluded), `${excluded} is both generated and excluded`);
});

for (const axisCase of CASES)
  test(`witness ${name(axisCase)}`, async () => {
    const run = await record(
      axisCase.source,
      axisCase.cut === undefined ? {} : { cut: axisCase.cut },
    );
    assert.ok(
      axisCase.shows(startState(run)),
      "the session shows the intended state before the first attempt",
    );
    assert.deepEqual(acceptedOps(run).slice(0, axisCase.accepted.length), axisCase.accepted);
    assert.equal(run.outcome.kind, axisCase.outcome, JSON.stringify(run.outcome));
    assert.equal(judgeTape(project(axisCase.source), TAPE_START, run.entries), null);
    assert.equal(await replayedInWorker(run.entries), null);
  });

/** A reply result's `kind`, when it has one. */
const resultKind = (result: unknown) =>
  typeof result === "object" && result !== null && "kind" in result ? result.kind : undefined;

const formSource = (min: number, max: number) =>
  `let x = askForm fields: { n: { type: "integer", min: ${min}, max: ${max} } }\nexit`;
const BUSY = [
  'showPermanentButton "Help" {',
  ...Array.from({ length: 30 }, (_, index) => ` showButton "Handler ${index}"`),
  "}",
  ...Array.from({ length: 30 }, (_, index) => `showButton "Main ${index}"`),
  "exit",
].join("\n");
const without =
  (rows: (row: string) => boolean): typeof candidatesFor =>
  (session, accepted) =>
    candidatesFor(session, accepted).filter((candidate) => !rows(candidate.row));

test("control r3 bounded form (D2): the refusal and its draft publication are kept, 10 completes", async () => {
  const run = await record(formSource(10, 20));
  const refused = run.entries.filter(
    (entry) =>
      entry.op === "submitForm" &&
      entry.reply.ok &&
      resultKind(entry.reply.result) === "invalidPayload",
  );
  assert.ok(
    refused.some((entry) => entry.reply.ok && entry.reply.view !== null),
    "a refusal published its draft",
  );
  assert.equal(run.census.rows["form:answer"], 1, "the ordinary answer 10 completes it");
  // Mutant: drop the refusals' publications → the oracle's trace fails.
  const dropped = run.entries.map((entry) =>
    refused.includes(entry) && entry.reply.ok
      ? { ...entry, reply: { ...entry.reply, view: null } }
      : entry,
  );
  assert.notEqual(judgeTape(project(formSource(10, 20)), TAPE_START, dropped), null);
  // Mutant: count the refusal as acceptance → the counters differ.
  const lenient = await record(formSource(10, 20), {
    outcomes: {
      ...OUTCOMES,
      submitForm: (result) => (result !== null ? { accepted: true } : OUTCOMES.submitForm(result)),
    },
  });
  assert.notEqual(lenient.census.accepted["submitForm"], run.census.accepted["submitForm"]);
});

test("control bounds fallback (40-50): only the field's min completes it, and without the bounds branch it stalls", async () => {
  const run = await record(formSource(40, 50));
  assert.equal(run.census.rows["form:bound"], 1, "the field's min completes it");
  assert.equal(run.outcome.kind, "halted");
  const mutant = await record(formSource(40, 50), {
    candidates: without((row) => row === "form:bound"),
  });
  assert.equal(isComplete(mutant.outcome), false, JSON.stringify(mutant.outcome));
});

test("control r3 lock: the work answer in ask is refused, submitted reaches work, and without an ask candidate it stalls", async () => {
  const source = 'let x = encryptText("x")\nexit';
  // The negative probe: the fixed work-style answer first, then the table's own candidates.
  const probe = await record(source, {
    candidates: (session, accepted) => {
      const listed = candidatesFor(session, accepted);
      const lock = listed.find((candidate) => candidate.row === "lock:ask submitted");
      return lock === undefined
        ? listed
        : [
            {
              ...lock,
              row: "probe:work in ask",
              args: { ...lock.args, answer: { kind: "failed", reason: "unavailable" } },
            },
            ...listed,
          ];
    },
  });
  assert.equal(probe.census.declined["answerLock:invalidPayload"], 1);
  // The work phase's unavailable lock fails the script: an engine failure, a complete prefix.
  assert.equal(probe.outcome.kind, "failed");
  const mutant = await record(source, { candidates: without((row) => row.startsWith("lock:ask")) });
  assert.equal(isComplete(mutant.outcome), false, JSON.stringify(mutant.outcome));
});

test("control r4 busy button (D3): busy is a recorded decline, the sweep goes on to the handler's button", async () => {
  const run = await record(BUSY, { cut: 22 });
  assert.equal(
    run.census.accepted["pressPermanentButton"],
    1,
    "pressed once, at the tenth accepted input",
  );
  assert.equal(run.census.declined["pressPermanentButton:busy"], 1, "busy at the twentieth");
  assert.equal(run.outcome.kind, "cut");
  assert.equal(judgeTape(project(BUSY), TAPE_START, run.entries), null);
  // Mutant: drop the busy reply → the replay differs from the tape.
  const busy = run.entries.findIndex(
    (entry) =>
      entry.op === "pressPermanentButton" &&
      entry.reply.ok &&
      resultKind(entry.reply.result) === "busy",
  );
  assert.notEqual(await replayedInWorker(run.entries.filter((_, index) => index !== busy)), null);
  // Mutant: read busy as acceptance → the counters differ.
  const lenient = await record(BUSY, {
    cut: 22,
    outcomes: { ...OUTCOMES, pressPermanentButton: () => ({ accepted: true }) },
  });
  assert.notEqual(
    lenient.census.accepted["pressPermanentButton"],
    run.census.accepted["pressPermanentButton"],
  );
});

test("control null decline: a mandatory image's skip is a recorded null, and the oracle keeps it", async () => {
  const source = 'let x = askImage("Image")\nexit';
  const production = await record(source);
  assert.equal(production.outcome.kind, "unsupported");
  // The negative probe: a fixed skip the table never proposes for a mandatory image.
  const probe = await record(source, {
    candidates: (session, accepted) => {
      const action = session.state.foregroundAction;
      const skip: Candidate[] =
        action?.kind === "interaction"
          ? [
              {
                op: "skipImage",
                args: { actionId: action.actionId, input: null },
                group: "foreground",
                row: "probe:skip",
              },
            ]
          : [];
      return [...skip, ...candidatesFor(session, accepted)];
    },
  });
  const skipped = probe.entries.find((entry) => entry.op === "skipImage");
  assert.ok(skipped?.reply.ok && skipped.reply.result === null && skipped.reply.view === null);
  assert.equal(probe.outcome.kind, "stalled");
  assert.equal(judgeTape(project(source), TAPE_START, probe.entries), null);
  // Mutant: the bridge answering where the adapter did nothing → the oracle fails.
  const answered = probe.entries.map((entry) =>
    entry === skipped && entry.reply.ok
      ? { ...entry, reply: { ...entry.reply, result: {} } }
      : entry,
  );
  assert.notEqual(judgeTape(project(source), TAPE_START, answered), null);
});
