import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";

import { BridgeRequestError, connectBridge } from "../../player/engine-bridge/client.js";
import { createInProcessBackend } from "../../player/engine-bridge/in-process.js";
import { nodeWorkerPort } from "../../player/engine-bridge/node-client.js";
import { PlayerBridge } from "../../player/runtime/player-bridge.js";
import type { PlayerCriticalState } from "../../player/engine-bridge/session-protocol.js";
import { ADAPTER_OPS } from "../helpers/bridge/replay-harness.js";
import {
  CANDIDATE_OPS,
  candidatesFor,
  type Candidate,
  type CandidateOp,
} from "../gate/candidates.js";
import { driveTape, isComplete, type TapeRun } from "../gate/driver.js";
import { fixtureHost } from "../gate/hosts.js";
import { inventoryOf, MECHANISMS, POLICY_RESIDUALS } from "../gate/inventory.js";
import { judgeTape } from "../gate/oracle.js";
import { OUTCOMES } from "../gate/outcomes.js";
import { TAPE_START } from "../gate/start.js";
import { recordClient, replayTape, type TapeEntry } from "../gate/tape.js";
import { asMalformed, untypedBridge } from "../helpers/bridge/untyped.js";

/*
 * The K/F tape driver's claims (the L5 gate's tape plan §3, design round 1): the structural one, and bounded runtime
 * witnesses whose axes come from the engine's transitions and guards, not from the candidate table. Each state is built
 * from its axis value alone and named by it; it asserts the guard values the session shows at its point (before the
 * attempt after its `at`-th accepted input), then the accepted inputs and the tape's outcome, written from the axis
 * value. Every state is generated alone and behind a running timer, whose presence it asserts at the same point. Every
 * tape also agrees with the adapter oracle and replays unchanged in a Node Worker. The controls' mutants must each fail
 * for their reason.
 */

const BUILD = { commit: null, dirty: null, mode: null, appVersion: null };
const WORKER = new URL("../../player/engine-bridge/node-worker.js", import.meta.url);

const TIMER = 'timer async 1 s {\n say "tick", instant\n}\n';

type Candidates = typeof candidatesFor;
type Setup = (session: Parameters<Candidates>[0]) => Candidate[];

interface State {
  readonly axis: string;
  readonly state: string;
  readonly body: string;
  /** A fixed host or player request the table does not propose, tried before the table's own candidates. */
  readonly setup?: Setup;
  /** How many accepted inputs come before the point `shows` reads; 0, before the first attempt. */
  readonly at?: number;
  /** What the session shows at that point. */
  readonly shows: (state: PlayerCriticalState) => boolean;
  /** The ops accepted, in order, at the start of the tape; the declines it must record; and the tape's outcome. */
  readonly accepted: readonly string[];
  readonly declined?: Readonly<Record<string, number>>;
  readonly outcome: string;
  /** Behind the timer, when its tick changes what is accepted. */
  readonly timed?: { readonly accepted: readonly string[]; readonly outcome: string };
  /** Accepted inputs after which the tape is cut, when not the driver's own. */
  readonly cut?: number;
  /** Further facts the tape must show, read from its own entries. */
  readonly facts?: (run: TapeRun) => void;
}

type Interaction = Extract<PlayerCriticalState["foregroundAction"], { kind: "interaction" }>;
const interaction = (state: PlayerCriticalState): Interaction | null =>
  state.foregroundAction?.kind === "interaction" ? state.foregroundAction : null;
const lockAction = (state: PlayerCriticalState) =>
  state.foregroundAction?.kind === "lock" ? state.foregroundAction : null;
/** The form's only field and its answer so far, when the foreground is a form. */
const formField = (state: PlayerCriticalState) => {
  const action = interaction(state);
  if (action?.ui.kind !== "form" || action.form === undefined) return null;
  const [field] = action.ui.fields;
  return field === undefined || field.kind === "boolean" || field.kind === "cycle"
    ? null
    : { field, value: action.form.values[0] ?? null, editor: action.form.editor };
};
const imageSkip = (state: PlayerCriticalState) => {
  const ui = interaction(state)?.ui;
  return ui?.kind === "image" ? ui.allowSkip : null;
};
const media = (state: PlayerCriticalState) =>
  state.backgroundActions.flatMap((action) => (action.kind === "media" ? [action.media] : []))[0] ??
  null;
const hasTimer = (state: PlayerCriticalState) =>
  state.backgroundActions.some((action) => action.kind === "timer");

const integerForm = (field: string) => `let x = askForm fields: { n: { ${field} } }\nexit`;
const FORM_BOUNDED = integerForm('type: "integer", min: 10, max: 20');
/** The editor open on the form's field: the table's own "open field" step. */
const editorOpen = (state: PlayerCriticalState) => formField(state)?.editor?.fieldId === "n";

/** A permanent button whose block shows 25 buttons, behind 60 main buttons: pressed at 10, busy at 20 and 30, idle at 40. */
const BUSY = [
  'showPermanentButton "Help" {',
  ...Array.from({ length: 25 }, (_, index) => ` showButton "Handler ${index}"`),
  "}",
  ...Array.from({ length: 60 }, (_, index) => `showButton "Main ${index}"`),
  "exit",
].join("\n");

/**
 * Each permanent-button press the tape attempted: the button label the foreground showed just before it (a handler's
 * button while the block runs, a main one while it is idle) and the press's result kind.
 */
function presses(run: TapeRun): { readonly shown: string | null; readonly result: unknown }[] {
  let shown: string | null = null;
  const found = [];
  for (const entry of run.entries) {
    if (entry.op === "pressPermanentButton" && entry.reply.ok)
      found.push({ shown, result: resultKind(entry.reply.result) });
    // EVIDENCE: validation: a reply's view is a bridge publication, with the session's whole state.
    const view = (entry.reply.ok ? entry.reply.view : null) as {
      state?: PlayerCriticalState;
    } | null;
    const ui = view?.state === undefined ? undefined : interaction(view.state)?.ui;
    if (view?.state !== undefined) shown = ui?.kind === "button" ? ui.buttonLabel : null;
  }
  return found;
}

/** A reply result's `kind`, when it has one. */
const resultKind = (result: unknown) =>
  typeof result === "object" && result !== null && "kind" in result ? result.kind : undefined;

const STATES: readonly State[] = [
  {
    axis: "lock",
    state: "work",
    body: 'let x = encryptText("x", password: "p", publicKey: false, timeLock: false)\nexit',
    shows: (s) => lockAction(s)?.phase === "work" && lockAction(s)?.password === "p",
    accepted: ["answerLock"],
    // A lock whose work the host answers unavailable fails the script: an engine failure, a complete prefix.
    outcome: "failed",
  },
  {
    axis: "lock",
    state: "ask without cancel",
    body: 'let x = encryptText("x")\nexit',
    // An encrypt dialog has no Cancel.
    shows: (s) => lockAction(s)?.phase === "ask" && lockAction(s)?.call === "encryptText",
    accepted: ["answerLock", "answerLock"],
    outcome: "failed",
  },
  {
    axis: "lock",
    state: "ask with cancel",
    body: 'let x = decryptText("eA==", default: "none")\nexit',
    // The host's work step asks the player: the unlock dialog, which has Cancel (a decrypt without a password field).
    setup: (session) => {
      const lock = lockAction(session.state);
      return lock?.phase === "work" && lock.dialogActionId === null
        ? [
            {
              op: "answerLock",
              args: { actionId: lock.actionId, answer: { kind: "ask" }, held: null },
              group: "host",
              row: "setup:ask",
            },
          ]
        : [];
    },
    at: 1,
    shows: (s) =>
      lockAction(s)?.phase === "ask" &&
      lockAction(s)?.call === "decryptText" &&
      lockAction(s)?.passwordField === null,
    accepted: ["answerLock", "answerLock", "answerLock"],
    outcome: "failed",
  },
  {
    axis: "form",
    state: "required unbounded",
    body: integerForm('type: "integer"'),
    shows: (s) => {
      const form = formField(s);
      return (
        form?.field.optional === false &&
        form.field.min === null &&
        form.field.max === null &&
        form.value === null &&
        form.editor === null
      );
    },
    accepted: ["stepFormField", "submitForm"],
    outcome: "halted",
  },
  {
    axis: "form",
    state: "bounded 10-20",
    body: FORM_BOUNDED,
    shows: (s) =>
      formField(s)?.field.min === 10 &&
      formField(s)?.field.max === 20 &&
      formField(s)?.value === null,
    accepted: ["stepFormField", "submitForm"],
    outcome: "halted",
  },
  {
    axis: "form",
    state: "editor open",
    body: FORM_BOUNDED,
    at: 1,
    shows: editorOpen,
    accepted: ["stepFormField", "submitForm"],
    outcome: "halted",
  },
  {
    axis: "form",
    state: "unchanged edit",
    body: FORM_BOUNDED,
    // Opening the field the editor already holds changes nothing.
    setup: (session) => {
      const action = interaction(session.state);
      return action !== null && editorOpen(session.state)
        ? [
            {
              op: "stepFormField",
              args: { actionId: action.actionId, fieldId: "n", draft: null },
              group: "foreground",
              row: "setup:reopen",
            },
          ]
        : [];
    },
    at: 1,
    shows: editorOpen,
    accepted: ["stepFormField", "submitForm"],
    declined: { "stepFormField:unchanged": 1 },
    outcome: "halted",
  },
  {
    axis: "form",
    state: "prefilled",
    body: integerForm('value: 15, type: "integer", min: 10, max: 20'),
    shows: (s) => formField(s)?.value === 15,
    accepted: ["submitForm"],
    outcome: "halted",
  },
  {
    axis: "form",
    state: "bounded 40-50",
    body: integerForm('type: "integer", min: 40, max: 50'),
    shows: (s) => formField(s)?.field.min === 40 && formField(s)?.field.max === 50,
    accepted: ["stepFormField", "submitForm"],
    outcome: "halted",
  },
  {
    axis: "form",
    state: "optional only",
    body: integerForm('type: "integer", optional: true'),
    shows: (s) => formField(s)?.field.optional === true && formField(s)?.value === null,
    accepted: ["submitForm"],
    outcome: "halted",
  },
  {
    axis: "image",
    state: "skippable",
    body: 'let x = askImage("Image", allowSkip: true) otherwise "x.png"\nexit',
    shows: (s) => imageSkip(s) === true,
    accepted: ["skipImage"],
    outcome: "halted",
  },
  {
    axis: "image",
    state: "mandatory",
    body: 'let x = askImage("Image")\nexit',
    shows: (s) => imageSkip(s) === false,
    accepted: [],
    outcome: "unsupported",
    // The tick is a time step before the policy finds no answer.
    timed: { accepted: ["stepTime"], outcome: "unsupported" },
  },
  {
    axis: "media",
    state: "awaiting load",
    body: 'playAudio "a.mp3"\nexit',
    shows: (s) => media(s)?.loaded === false,
    accepted: ["reportMediaLoad", "stepTime"],
    outcome: "halted",
  },
  {
    axis: "media",
    state: "playing",
    body: 'playAudio "a.mp3"\nexit',
    at: 1,
    shows: (s) => media(s)?.loaded === true && media(s)?.state === "running",
    accepted: ["reportMediaLoad", "stepTime"],
    outcome: "halted",
  },
  {
    axis: "time",
    state: "delay",
    body: "wait 1 s\nexit",
    shows: (s) => s.foregroundAction?.kind === "delay",
    accepted: ["stepTime"],
    outcome: "halted",
  },
  {
    axis: "time",
    state: "pacing gate",
    body: 'say "A paced message"\nexit',
    shows: (s) => s.foregroundAction?.kind === "chatPacingGate",
    accepted: ["stepTime"],
    outcome: "halted",
  },
  {
    axis: "host",
    state: "storage write during a delay",
    body: 'timer async 1 s {\n save 1 as "k"\n}\nwait 2 s\nexit',
    at: 1,
    // The timer's write takes the foreground from the delay until the host completes it.
    shows: (s) => s.foregroundAction?.kind === "storageWrite",
    accepted: ["stepTime", "completeStorageWrite"],
    outcome: "halted",
  },
  {
    axis: "permanent button",
    state: "idle → busy → idle",
    body: BUSY,
    cut: 42,
    shows: (s) =>
      s.backgroundActions.some((action) => action.kind === "permanentButton") &&
      interaction(s)?.ui.kind === "button",
    accepted: [...Array.from({ length: 10 }, () => "activateButton"), "pressPermanentButton"],
    declined: { "pressPermanentButton:busy": 2 },
    outcome: "cut",
    // Busy exactly while the block's buttons show, pressed while a main button shows.
    facts: (run) =>
      assert.deepEqual(
        presses(run).map(({ shown, result }) => [shown?.split(" ")[0], result]),
        [
          ["Main", "pressed"],
          ["Handler", "busy"],
          ["Handler", "busy"],
          ["Main", "pressed"],
        ],
      ),
  },
];

/** The witness axes and their values, declared apart from the states: the family is exactly these, each composed. */
const AXES: Readonly<Record<string, readonly string[]>> = {
  lock: ["work", "ask without cancel", "ask with cancel"],
  form: [
    "required unbounded",
    "bounded 10-20",
    "editor open",
    "unchanged edit",
    "prefilled",
    "bounded 40-50",
    "optional only",
  ],
  image: ["skippable", "mandatory"],
  media: ["awaiting load", "playing"],
  time: ["delay", "pacing gate"],
  host: ["storage write during a delay"],
  "permanent button": ["idle → busy → idle"],
};
const COMPOSITIONS = ["", " + timer"];

interface Case extends State {
  readonly source: string;
  readonly timer: boolean;
}
const CASES: readonly Case[] = STATES.flatMap((state) => [
  { ...state, source: state.body, timer: false },
  {
    ...state,
    ...state.timed,
    state: `${state.state} + timer`,
    source: TIMER + state.body,
    timer: true,
  },
]);
const name = (axisCase: { axis: string; state: string }) => `${axisCase.axis}/${axisCase.state}`;

const inProcess = () => createInProcessBackend(BUILD);
const inWorker = async () =>
  new PlayerBridge(await connectBridge(nodeWorkerPort(WORKER, BUILD), BUILD));
const project = (source: string) => ({ files: [{ path: "main.tease", source }] });
const withSetup =
  (setup: Setup): Candidates =>
  (session, accepted) => [...setup(session), ...candidatesFor(session, accepted)];

async function record(
  source: string,
  options: Parameters<typeof driveTape>[3] = {},
  inject: (bridge: PlayerBridge) => void = () => {},
): Promise<TapeRun> {
  const bridge = inProcess();
  inject(bridge);
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

const isAttempt = (entry: TapeEntry) =>
  entry.op !== "prepare" && entry.op !== "start" && entry.op !== "captureCheckpoint";
const isAccepted = (entry: TapeEntry) => {
  // EVIDENCE: validation: every other op a tape sends is a candidate op (`CANDIDATE_OPS`).
  const op = entry.op as Candidate["op"];
  return isAttempt(entry) && entry.reply.ok && OUTCOMES[op](entry.reply.result).accepted;
};
/** The state the session showed before the first attempt after `at` accepted inputs (or at the tape's end). */
function stateAt(run: TapeRun, at: number): PlayerCriticalState {
  let state: PlayerCriticalState | null = null;
  let accepted = 0;
  for (const entry of run.entries) {
    if (isAttempt(entry) && accepted === at) break;
    if (isAccepted(entry)) accepted += 1;
    // EVIDENCE: validation: a reply's view is a bridge publication, with the session's whole state.
    const view = (entry.reply.ok ? entry.reply.view : null) as {
      state?: PlayerCriticalState;
    } | null;
    if (view?.state !== undefined) state = view.state;
  }
  assert.ok(state !== null, "the tape published a state");
  return state;
}
const acceptedOps = (run: TapeRun) => run.entries.filter(isAccepted).map((entry) => entry.op);

async function replayedInWorker(entries: readonly TapeEntry[]) {
  const bridge = await inWorker();
  try {
    return await replayTape(bridge.client, entries);
  } finally {
    bridge.client.terminate();
  }
}
/** The oracle agrees with `run` and it replays unchanged in a Node Worker. */
async function assertJudged(source: string, run: TapeRun) {
  assert.equal(
    judgeTape(project(source), TAPE_START, run.entries, { complete: isComplete(run.outcome) }),
    null,
  );
  assert.equal(await replayedInWorker(run.entries), null);
}

test("the outcomes read exactly the table's candidate ops, and the oracle has a path for each", () => {
  assert.deepEqual(Object.keys(OUTCOMES).sort(), [...CANDIDATE_OPS].sort());
  const oracle: Readonly<Record<CandidateOp, unknown>> = ADAPTER_OPS;
  for (const op of CANDIDATE_OPS)
    assert.ok(Object.hasOwn(oracle, op), `'${op}' has no oracle path`);
  for (const residual of Object.keys(POLICY_RESIDUALS))
    assert.ok(MECHANISMS.includes(residual), `the residual '${residual}' is no inventory key`);
});

test("every gate fixture names a known host or none", () => {
  const folder = new URL("../../../tests/gate/fixtures/", import.meta.url);
  const fixtures = readdirSync(folder).filter((name) => name.endsWith(".tease"));
  assert.ok(fixtures.length > 0);
  for (const name of fixtures) fixtureHost(readFileSync(new URL(name, folder), "utf8"));
  assert.throws(() => fixtureHost("// gate-host: nobody\nexit"), /unknown host/u);
});

test("the witnesses are exactly the declared axis values, each alone and behind a timer", () => {
  const declared = Object.entries(AXES).flatMap(([axis, values]) =>
    values.flatMap((value) => COMPOSITIONS.map((composition) => `${axis}/${value}${composition}`)),
  );
  assert.deepEqual(CASES.map(name).sort(), declared.sort());
});

for (const axisCase of CASES)
  test(`witness ${name(axisCase)}`, async () => {
    const run = await record(axisCase.source, {
      ...(axisCase.setup === undefined ? {} : { candidates: withSetup(axisCase.setup) }),
      ...(axisCase.cut === undefined ? {} : { cut: axisCase.cut }),
    });
    const shown = stateAt(run, axisCase.at ?? 0);
    assert.ok(axisCase.shows(shown), "the session shows the intended state at its point");
    assert.equal(
      hasTimer(stateAt(run, 0)),
      axisCase.timer || axisCase.axis === "host",
      "a timer runs exactly when composed",
    );
    assert.deepEqual(acceptedOps(run).slice(0, axisCase.accepted.length), axisCase.accepted);
    for (const [key, times] of Object.entries(axisCase.declined ?? {}))
      assert.equal(run.census.declined[key], times, key);
    assert.equal(run.outcome.kind, axisCase.outcome, JSON.stringify(run.outcome));
    axisCase.facts?.(run);
    await assertJudged(axisCase.source, run);
    for (const key of inventoryOf(run.entries))
      assert.ok(MECHANISMS.includes(key), `${key} is not in the inventory's list`);
  });

const formSource = (min: number, max: number) =>
  integerForm(`type: "integer", min: ${min}, max: ${max}`);
const without =
  (rows: (row: string) => boolean): Candidates =>
  (session, accepted) =>
    candidatesFor(session, accepted).filter((candidate) => !rows(candidate.row));
/** `entries` with the reply at `index` replaced. */
type Published = TapeEntry["reply"] & { readonly ok: true };
/** `entries` with the published reply at `index` replaced. */
function mutated(
  entries: readonly TapeEntry[],
  index: number,
  reply: (reply: Published) => Published,
): TapeEntry[] {
  const original = entries[index]?.reply;
  assert.ok(original?.ok, "the mutated entry was published");
  return entries.map((entry, at) => (at === index ? { ...entry, reply: reply(original) } : entry));
}
/** The oracle's reason for rejecting `entries`, or `null`. */
const oracleOn = (source: string, entries: readonly TapeEntry[]) =>
  judgeTape(project(source), TAPE_START, entries)?.what ?? null;

test("control r3 bounded form (D2): the refusal and its draft publication are kept, 10 completes", async () => {
  const source = formSource(10, 20);
  const run = await record(source);
  const refused = run.entries.findIndex(
    (entry) =>
      entry.op === "submitForm" &&
      entry.reply.ok &&
      resultKind(entry.reply.result) === "invalidPayload",
  );
  assert.ok(
    refused >= 0 && run.entries[refused]?.reply.ok && run.entries[refused].reply.view !== null,
    "a refusal published its draft",
  );
  assert.equal(run.census.rows["form:answer"], 1, "the ordinary answer 10 completes it");
  await assertJudged(source, run);
  // Mutant: drop the refusal's publication → the oracle's publication check fails.
  assert.equal(
    oracleOn(
      source,
      mutated(run.entries, refused, (reply) => ({ ...reply, view: null })),
    ),
    "the adapter changed the session but the bridge published nothing",
  );
  // Mutant: count the refusal as acceptance → the counters differ.
  const lenient = await record(source, {
    outcomes: {
      ...OUTCOMES,
      submitForm: (result) => (result !== null ? { accepted: true } : OUTCOMES.submitForm(result)),
    },
  });
  assert.notEqual(lenient.census.accepted["submitForm"], run.census.accepted["submitForm"]);
});

test("control bounds fallback (40-50): only the field's min completes it, and without the bounds branch it stalls", async () => {
  const source = formSource(40, 50);
  const run = await record(source);
  assert.equal(run.census.rows["form:bound"], 1, "the field's min completes it");
  assert.equal(run.outcome.kind, "halted");
  await assertJudged(source, run);
  const mutant = await record(source, { candidates: without((row) => row === "form:bound") });
  assert.equal(mutant.outcome.kind, "stalled", JSON.stringify(mutant.outcome));
  await assertJudged(source, mutant);
});

test("control r3 lock: the work answer in ask is refused, submitted reaches work, and without an ask candidate it stalls", async () => {
  const source = 'let x = encryptText("x")\nexit';
  // The negative probe: the fixed work-style answer first, then the table's own candidates.
  const probe = await record(source, {
    candidates: withSetup((session) => {
      const lock = lockAction(session.state);
      return lock?.phase === "ask"
        ? [
            {
              op: "answerLock",
              args: {
                actionId: lock.actionId,
                answer: { kind: "failed", reason: "unavailable" },
                held: null,
              },
              group: "host",
              row: "probe:work in ask",
            },
          ]
        : [];
    }),
  });
  assert.equal(probe.census.declined["answerLock:invalidPayload"], 1);
  // The work phase's unavailable lock fails the script: an engine failure, a complete prefix.
  assert.equal(probe.outcome.kind, "failed");
  await assertJudged(source, probe);
  const mutant = await record(source, { candidates: without((row) => row.startsWith("lock:ask")) });
  assert.equal(mutant.outcome.kind, "stalled", JSON.stringify(mutant.outcome));
  await assertJudged(source, mutant);
});

test("control lock cancel: the unlock dialog's Cancel gives the default", async () => {
  const source = 'let x = decryptText("eA==", default: "none")\nsay x, instant\nexit';
  const askState = STATES.find((state) => state.state === "ask with cancel");
  assert.ok(askState?.setup !== undefined);
  const setup = askState.setup;
  const run = await record(source, {
    candidates: (session, accepted) => [
      ...setup(session),
      ...candidatesFor(session, accepted).filter(
        (candidate) => candidate.row !== "lock:ask submitted",
      ),
    ],
  });
  assert.equal(run.census.rows["lock:ask cancelled"], 1);
  assert.equal(run.outcome.kind, "halted");
  await assertJudged(source, run);
});

test("control r4 busy button (D3): busy is a recorded decline, the sweep goes on, and once idle it presses again", async () => {
  const run = await record(BUSY, { cut: 42 });
  assert.equal(
    run.census.accepted["pressPermanentButton"],
    2,
    "pressed at the tenth accepted input and again once idle",
  );
  assert.equal(
    run.census.declined["pressPermanentButton:busy"],
    2,
    "busy at the twentieth and thirtieth",
  );
  assert.equal(run.outcome.kind, "cut");
  await assertJudged(BUSY, run);
  // Mutant: drop the first busy reply → the replay differs from the tape.
  const busy = run.entries.findIndex(
    (entry) =>
      entry.op === "pressPermanentButton" &&
      entry.reply.ok &&
      resultKind(entry.reply.result) === "busy",
  );
  assert.notEqual(await replayedInWorker(run.entries.filter((_, index) => index !== busy)), null);
  // Mutant: read busy as acceptance → the counters differ.
  const lenient = await record(BUSY, {
    cut: 42,
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
  await assertJudged(source, production);
  // The negative probe: a fixed skip the table never proposes for a mandatory image.
  const probe = await record(source, {
    candidates: withSetup((session) => {
      const action = interaction(session.state);
      return action === null
        ? []
        : [
            {
              op: "skipImage",
              args: { actionId: action.actionId, input: null },
              group: "foreground",
              row: "probe:skip",
            },
          ];
    }),
  });
  const skipped = probe.entries.findIndex((entry) => entry.op === "skipImage");
  const reply = probe.entries[skipped]?.reply;
  assert.ok(reply?.ok && reply.result === null && reply.view === null);
  assert.equal(probe.outcome.kind, "stalled");
  await assertJudged(source, probe);
  // Mutants: the bridge answering, or publishing, where the adapter did nothing → the oracle fails.
  assert.equal(
    oracleOn(
      source,
      mutated(probe.entries, skipped, (r) => ({ ...r, result: {} })),
    ),
    "its result differs from the adapter's",
  );
  const start = probe.entries.find((entry) => entry.op === "start")?.reply;
  assert.ok(start?.ok);
  assert.equal(
    oracleOn(
      source,
      mutated(probe.entries, skipped, (r) => ({ ...r, view: start.view })),
    ),
    "the adapter changed nothing but the bridge published, or at another revision",
  );
});

test("control publication: dropped events, a shifted start, another revision, a lost capture and a session-free reply with an envelope each fail the oracle", async () => {
  const source =
    'say "One", instant\nshowButton "Go"\nsay "Two", instant\nsay "Three", instant\nshowButton "End"\nexit';
  const run = await record(source);
  await assertJudged(source, run);
  interface View {
    readonly from: number;
    readonly events: readonly unknown[];
  }
  const viewOf = (reply: TapeEntry["reply"]): View | null => {
    if (!reply.ok) return null;
    // EVIDENCE: validation: a published reply's view is the bridge's publication shape.
    return reply.view as View | null;
  };
  const pressed = run.entries.findIndex(
    (entry) => entry.op === "activateButton" && (viewOf(entry.reply)?.events.length ?? 0) > 1,
  );
  assert.ok(pressed >= 0, "a press published several events");
  const pressedReply = run.entries[pressed]?.reply;
  assert.ok(pressedReply !== undefined);
  const view = viewOf(pressedReply);
  assert.ok(view !== null);
  assert.equal(
    oracleOn(
      source,
      mutated(run.entries, pressed, (r) => ({
        ...r,
        view: { ...view, events: [], from: view.from + view.events.length },
      })),
    ),
    "the publication's events start elsewhere than the oracle's cursor",
  );
  assert.equal(
    oracleOn(
      source,
      mutated(run.entries, pressed, (r) => ({
        ...r,
        view: { ...view, events: view.events.slice(1) },
      })),
    ),
    "the publication's events differ from the adapter's",
  );
  const started = run.entries.findIndex((entry) => entry.op === "start");
  assert.match(
    oracleOn(
      source,
      mutated(run.entries, started, (r) => ({ ...r, revision: (r.revision ?? 0) + 100 })),
    ) ?? "",
    /revision differs/,
  );
  assert.equal(
    judgeTape(project(source), TAPE_START, run.entries.slice(0, -1), { complete: true })?.what,
    "a complete tape without its final capture",
  );
  // The session-free replies (prepare, the final capture) carry no session envelope or publication.
  const startReply = run.entries[started]?.reply;
  assert.ok(startReply?.ok);
  const capture = run.entries.length - 1;
  const prepare = run.entries.findIndex((entry) => entry.op === "prepare");
  for (const [index, change, what] of [
    [capture, { revision: 100 }, "the final capture's"],
    [capture, { eventsThrough: 100 }, "the final capture's"],
    [capture, { view: startReply.view }, "the final capture's"],
    [prepare, { view: startReply.view }, "prepare's"],
  ] as const)
    assert.equal(
      oracleOn(
        source,
        mutated(run.entries, index, (r) => ({ ...r, ...change })),
      ),
      `${what} reply carries a session envelope or publication`,
    );
});

test("control preparation: a false notCompiled fails the oracle; a real compile failure agrees and replays", async () => {
  const source = 'showButton "Go"\nexit';
  const run = await record(source);
  const prepare = run.entries.findIndex((entry) => entry.op === "prepare");
  assert.equal(
    oracleOn(
      source,
      mutated(run.entries, prepare, (r) => ({
        ...r,
        result: { kind: "notCompiled", diagnostics: [] },
      })),
    ),
    "prepare's result differs from the oracle's compile",
  );
  const broken = 'showButton "Go"\nlet = \nexit';
  const notPrepared = await record(broken);
  assert.equal(notPrepared.outcome.kind, "notPrepared");
  await assertJudged(broken, notPrepared);
});

test("control action ID: a choice answered for another action fails the oracle", async () => {
  const source = 'let x = askChoice "a", "b"\nexit';
  const run = await record(source);
  await assertJudged(source, run);
  const chosen = run.entries.findIndex((entry) => entry.op === "selectChoice");
  assert.ok(chosen >= 0);
  const choice = run.entries[chosen];
  assert.ok(choice !== undefined);
  // EVIDENCE: validation: `selectChoice`'s arguments are an object carrying the action ID it answers.
  const args = choice.args as Record<string, unknown>;
  const moved = run.entries.map((entry, index) =>
    index === chosen ? { ...entry, args: { ...args, actionId: 1001 } } : entry,
  );
  assert.equal(oracleOn(source, moved), "its result differs from the adapter's");
});

test("control outcomes: a thrown request that ended the session and a failed capture are incomplete", async () => {
  const source = 'showButton "Go"\nexit';
  const thrown = await record(source, {}, (bridge) => {
    // The wrapper forwards each op as it is sent, whatever it is.
    const untyped = untypedBridge(bridge);
    const request = untyped.request.bind(bridge);
    untyped.request = async (session, op, args) => {
      if (op === "activateButton")
        throw new BridgeRequestError({
          kind: "engine",
          class: "TypeError",
          code: null,
          message: "injected",
          ended: true,
        });
      return await request(session, op, args);
    };
  });
  assert.equal(thrown.outcome.kind, "thrown");
  assert.equal(isComplete(thrown.outcome), false);
  const lost = await record(source, {}, (bridge) => {
    bridge.read = async () => {
      throw new Error("injected");
    };
  });
  assert.equal(lost.outcome.kind, "captureFailed");
  assert.equal(isComplete(lost.outcome), false);
});

test("control refusal details: a refusal whose details differ fails the replay", async () => {
  /** A real client whose every request refuses with `detail` in its details. */
  const refusing = (detail: number) => {
    const { client } = inProcess();
    Object.defineProperty(client, "request", {
      value: async () => {
        throw new BridgeRequestError({
          kind: "bridge",
          class: "BridgeRequestError",
          code: "X",
          message: "refused",
          info: { detail },
          ended: false,
        });
      },
    });
    return client;
  };
  const [client, same, other] = [refusing(1), refusing(1), refusing(2)];
  const recorder = recordClient(client);
  await assert.rejects(client.request("prepare", asMalformed({})));
  recorder.stop();
  assert.equal(await replayTape(same, recorder.entries), null);
  assert.notEqual(await replayTape(other, recorder.entries), null);
  for (const refused of [client, same, other]) refused.terminate();
});
