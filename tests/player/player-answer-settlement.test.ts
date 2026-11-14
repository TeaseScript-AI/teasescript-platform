import assert from "node:assert/strict";
import { before, type TestContext } from "node:test";
import { effectScope, watch, type Ref } from "vue";

import {
  memoryKeptSessionStore,
  type KeptSessionStore,
} from "../../player/persistence/kept-sessions.js";
import type { OpArgs, SessionOp } from "../../player/engine-bridge/op-catalogue.js";
import type { PlayerBridge } from "../../player/runtime/player-bridge.js";
import type { PlayerRuntimeSessionOptions } from "../../player/runtime/runtime-adapter.js";
import {
  activePlayerRuntimeInteraction,
  playerRuntimeForeground,
  playerRuntimeForm,
  playerRuntimeInteractionActionIds,
  type PlayerSession,
} from "../../player/runtime/runtime-view.js";
import type {
  ComposerDescriptor,
  ComposerState,
  FormDraft,
} from "../../player/vue/src/interaction/useComposerState.js";
import type {
  AnswerSubmission,
  SessionTerminal,
} from "../../player/vue/src/interaction/useAnswerSubmission.js";
import type { FormUpdates } from "../../player/vue/src/interaction/useFormUpdates.js";
import type { InputSectionHost } from "../../player/vue/src/session/runtime-input.js";
import { loadPlayerModule } from "../helpers/player-modules.js";
import { sourceStart } from "../helpers/prepared-plan.js";
import {
  loadTopology,
  rerunRegistry,
  TOPOLOGIES,
  topologyConnections,
  until,
  type Topology,
} from "../helpers/player/worker-topology.js";

/*
 * How the session's end settles an answer under way (PLAYER-UI "Composer and foreground interactions"): by the answer's stage
 * at the event. Never posted, a stop or a lost connection undoes it by its origin, without a notice; posted, a stop
 * waits for the final publication, which releases it when it no longer presents the action and undoes it otherwise,
 * and a lost connection undoes it at once without sending it again. A Start of another chat and an unmount drop it,
 * writing nothing. The rows run the real composable and controllers on both topologies, with the post log.
 */

interface SessionHost {
  readonly session: Readonly<Ref<PlayerSession | null>>;
  readonly stopped: Readonly<Ref<boolean>>;
  readonly chat: Readonly<Ref<number>>;
  readonly terminal: Readonly<Ref<SessionTerminal>>;
  epoch(): number;
  inputEpoch(): number;
  onEpoch(work: () => void): () => void;
  readonly diagnostics: Readonly<
    Ref<readonly { readonly code: string; readonly message: string }[]>
  >;
  /** Adopts a state Debug's rewind restored before input, as `RuntimeInteraction` asks for it. */
  prepareInput(): true | Promise<boolean>;
  /** Shows `next` as the session from now on, in another chat. */
  showSession(next: PlayerSession): void;
  readonly hostError: Readonly<Ref<string | null>>;
  readonly bridge: Promise<PlayerBridge>;
  readonly inputSection: InputSectionHost;
  update(session: PlayerSession): void;
  observe(): Promise<PlayerSession | null>;
  reportHostError(error: unknown): void;
  prepare(create: {
    readonly plan: string;
    readonly options: () => PlayerRuntimeSessionOptions;
  }): void;
  activate(): Promise<void>;
}
let usePlayerSession: (options: {
  readonly bridge: Promise<PlayerBridge>;
  readonly debugHistorySpill: () => Promise<null>;
  readonly keptSessions?: KeptSessionStore;
}) => SessionHost;
let composerDescriptor: (shown: {
  readonly session: PlayerSession | null;
  readonly reset: number;
  readonly chat: number;
  readonly foreground: ReturnType<typeof playerRuntimeForeground>;
  readonly form: ReturnType<typeof playerRuntimeForm>;
  readonly lock: null;
  readonly consumed: number | null;
}) => ComposerDescriptor;
let descriptorKey: (next: ComposerDescriptor) => string;
let useComposerState: (host: {
  readonly draft: (draft: FormDraft) => Promise<boolean>;
  readonly holdDrafts: () => boolean;
  readonly fieldChanged: () => void;
}) => ComposerState;
let useAnswerSubmission: (host: {
  readonly composer: ComposerState;
  readonly forms: Pick<FormUpdates, "unacknowledged" | "commitField" | "stepField">;
  readonly session: () => PlayerSession | null;
  readonly stoppedSession: () => PlayerSession | null;
  readonly chat: () => number;
  readonly epoch: () => number;
  readonly inputEpoch: () => number;
  readonly onEpoch: (work: () => void) => () => void;
  readonly terminal: () => SessionTerminal;
  readonly inputSection: () => InputSectionHost | undefined;
  readonly prepareInput: () => true | Promise<boolean>;
  readonly publish: (session: PlayerSession) => void;
  readonly unansweredMessage: () => string;
  readonly submitLock: (password: string) => void;
  readonly nextFrame: () => Promise<void>;
}) => AnswerSubmission;
let useFormUpdates: (host: {
  readonly composer: ComposerState;
  readonly session: () => PlayerSession | null;
  readonly chat: () => number;
  readonly epoch: () => number;
  readonly closed: () => boolean;
  readonly inputSection: () => InputSectionHost | undefined;
  readonly run: AnswerSubmission["run"];
  readonly publish: (session: PlayerSession) => void;
  readonly showNotice: (message: string) => void;
  readonly clearNotice: () => void;
  readonly unansweredMessage: () => string;
}) => FormUpdates;
interface DebugRewind {
  readonly state: Readonly<
    Ref<{
      readonly history: number | null;
      readonly points: readonly { readonly id: number }[];
      readonly inspection: unknown;
    }>
  >;
  back(point: number): Promise<boolean>;
}
let useDebugRewind: (player: SessionHost) => DebugRewind;

before(async () => {
  const session = await loadPlayerModule("player/vue/src/session/usePlayerSession.ts");
  // EVIDENCE: validation: Vite loaded the real source module; this is its host API.
  usePlayerSession = session.usePlayerSession as typeof usePlayerSession;
  const composer = await loadPlayerModule("player/vue/src/interaction/useComposerState.ts");
  // EVIDENCE: validation: as above, the composer's controller.
  useComposerState = composer.useComposerState as typeof useComposerState;
  // EVIDENCE: validation: as above, the composer's descriptor and its identity.
  composerDescriptor = composer.composerDescriptor as typeof composerDescriptor;
  // EVIDENCE: validation: as above.
  descriptorKey = composer.descriptorKey as typeof descriptorKey;
  const submission = await loadPlayerModule("player/vue/src/interaction/useAnswerSubmission.ts");
  // EVIDENCE: validation: as above, the answers' controller.
  useAnswerSubmission = submission.useAnswerSubmission as typeof useAnswerSubmission;
  const forms = await loadPlayerModule("player/vue/src/interaction/useFormUpdates.ts");
  // EVIDENCE: validation: as above, the form updates' controller.
  useFormUpdates = forms.useFormUpdates as typeof useFormUpdates;
  const rewind = await loadPlayerModule("player/vue/src/debug/history/useDebugRewind.ts");
  // EVIDENCE: validation: as above, Debug's rewind.
  useDebugRewind = rewind.useDebugRewind as typeof useDebugRewind;
  await loadTopology();
});

/** The browser surface the composable uses: a page, and audio elements that never load. */
function browser(context: TestContext) {
  const surface = {
    document: Object.assign(new EventTarget(), { visibilityState: "visible" }),
    window: new EventTarget(),
    Audio: class extends EventTarget {
      src = "";
      preload = "";
      volume = 1;
      duration = 3;
      paused = true;
      ended = false;
      currentTime = 0;
      play = async () => {};
      pause() {}
      load() {}
      removeAttribute() {}
    },
  };
  for (const [name, value] of Object.entries(surface)) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, value });
    context.after(() => {
      if (previous) Object.defineProperty(globalThis, name, previous);
      else Reflect.deleteProperty(globalThis, name);
    });
  }
  // The Player's error stop logs the error for the developer.
  const log = console.error;
  console.error = () => {};
  context.after(() => void (console.error = log));
}

/** The painted frame before an answer is sent, which a row may hold to act while the answer is only accepted. */
function frames() {
  let held = false;
  const waiting: (() => void)[] = [];
  return {
    hold: () => void (held = true),
    next: () =>
      held ? new Promise<void>((resolve) => void waiting.push(resolve)) : Promise.resolve(),
    waiting: () => waiting.length,
    release() {
      held = false;
      for (const resolve of waiting.splice(0)) resolve();
    },
  };
}

/**
 * The real composable on `topology`, started on `script`, with the composer's and the answers' controllers over it as
 * `RuntimeInteraction` runs them: the composer shows the chat, or a password's slot.
 */
async function page(
  context: TestContext,
  topology: Topology,
  script: string,
  { rewind = false }: { readonly rewind?: boolean } = {},
) {
  browser(context);
  const connections = await topologyConnections(context, topology);
  const connection = connections.first;
  const frame = frames();
  // The input section the answers use: what each run returned, and an act a row runs in the same task just before the
  // section decides on the answer (`beforeBody`, ahead of its admission), just before its op is sent (`beforeSend`), or
  // as the section returns (`afterReturn`).
  const sections: {
    returned: (string | null)[];
    beforeBody: (() => void) | null;
    beforeSend: (() => void) | null;
    afterReturn: (() => void) | null;
  } = { returned: [], beforeBody: null, beforeSend: null, afterReturn: null };
  // Each level the answers' controller read, for a row that orders its reads against the session's changes.
  const terminalReads: SessionTerminal[] = [];
  // The work the answers' controller registered for the epoch's moves, and how often it ran.
  const epochWork = { registered: new Set<() => void>(), runs: 0 };
  const scope = effectScope();
  const made = scope.run(() => {
    const player = usePlayerSession({
      bridge: Promise.resolve(connection.bridge),
      debugHistorySpill: async () => null,
      keptSessions: memoryKeptSessionStore(),
    });
    const shown = () => (player.stopped.value ? null : player.session.value);
    const section: InputSectionHost = async (work, body) => {
      const result = await player.inputSection(work, (input, observed) => {
        const act = sections.beforeBody;
        sections.beforeBody = null;
        act?.();
        return body(
          {
            owned: () => input.owned(),
            send: <O extends SessionOp>(
              ...call: O extends unknown ? [op: O, args: OpArgs<O>] : never
            ) => {
              const act = sections.beforeSend;
              sections.beforeSend = null;
              act?.();
              return input.send<O>(...call);
            },
            get session() {
              return input.session;
            },
          },
          observed,
        );
      });
      sections.returned.push(
        result !== null && typeof result === "object" && "kind" in result
          ? String(result.kind)
          : null,
      );
      const after = sections.afterReturn;
      sections.afterReturn = null;
      after?.();
      return result;
    };
    const composer: ComposerState = useComposerState({
      draft: (draft) => forms.draft(draft),
      holdDrafts: () => false,
      fieldChanged: () => submission.clearNotice(),
    });
    const submission: AnswerSubmission = useAnswerSubmission({
      composer,
      forms: {
        unacknowledged: (id) => forms.unacknowledged(id),
        commitField: (action, input) => forms.commitField(action, input),
        stepField: (fieldId, typed) => forms.stepField(fieldId, typed),
      },
      session: shown,
      stoppedSession: () => (player.stopped.value ? player.session.value : null),
      chat: () => player.chat.value,
      epoch: player.epoch,
      inputEpoch: player.inputEpoch,
      // The real registry, counting each run of the work the controller registers.
      onEpoch: (work) => {
        const counted = () => {
          epochWork.runs += 1;
          work();
        };
        epochWork.registered.add(counted);
        const off = player.onEpoch(counted);
        return () => {
          epochWork.registered.delete(counted);
          off();
        };
      },
      terminal: () => {
        const level = player.terminal.value;
        terminalReads.push(level);
        return level;
      },
      inputSection: () => section,
      prepareInput: () => player.prepareInput(),
      publish: (session) => player.update(session),
      unansweredMessage: () => "Nothing answers that.",
      submitLock: () => {},
      nextFrame: frame.next,
    });
    const forms: FormUpdates = useFormUpdates({
      composer,
      session: shown,
      chat: () => player.chat.value,
      epoch: player.epoch,
      closed: () => submission.closed(),
      inputSection: () => player.inputSection,
      run: (id, intent) => submission.run(id, intent),
      publish: (session) => player.update(session),
      showNotice: (message) => submission.showNotice(message),
      clearNotice: () => submission.clearNotice(),
      unansweredMessage: () => "Nothing answers that.",
    });
    const descriptor = (): ComposerDescriptor => {
      const session = shown();
      return composerDescriptor({
        session,
        reset: 0,
        chat: player.chat.value,
        foreground: session ? playerRuntimeForeground(session) : null,
        form: session ? playerRuntimeForm(session) : null,
        lock: null,
        consumed: submission.consumed.value,
      });
    };
    watch(
      () => descriptorKey(descriptor()),
      () => composer.select(descriptor()),
      { immediate: true },
    );
    // Debug's rewind, as the Debug switch runs it, for a row that answers in an inspected state.
    const debug = rewind ? useDebugRewind(player) : null;
    return { player, composer, submission, forms, debug };
  })!;
  context.after(() => scope.stop());
  const { player, debug } = made;
  if (debug) await until(() => debug.state.value.history !== null, "the history's open", "host");
  player.prepare(await sourceStart(player.bridge, script, () => ({ wallClockMs: 0 })));
  await player.activate();
  await until(() => activeAction(player) !== undefined, "the question", "host");
  return { ...made, connection, connections, frame, scope, sections, terminalReads, epochWork };
}

const activeAction = (player: SessionHost) =>
  player.session.value
    ? activePlayerRuntimeInteraction(player.session.value.state)?.actionId
    : undefined;

/** Types `text` into the field the composer shows, as the player's edit of that field. */
function type(composer: ComposerState, text: string) {
  composer.edit(composer.token.value, text);
}

const CHOICE = 'let pick = askChoice "Go"\nsay "after", instant\nexit';
const PASSWORD = 'let code = askPassword "Code?"\nsay "after", instant\nexit';
const ANSWER_OP = "submitComposer";

type Stage = "accepted" | "fenced" | "posted";
type Event = "stop" | "loss" | "start" | "unmount";

const CASES = {
  "accepted, stop": TOPOLOGIES,
  "accepted, loss": TOPOLOGIES,
  "accepted, start": TOPOLOGIES,
  "accepted, unmount": TOPOLOGIES,
  "fenced, stop": TOPOLOGIES,
  "fenced, loss": TOPOLOGIES,
  "fenced, start": TOPOLOGIES,
  "fenced, unmount": TOPOLOGIES,
  "posted, stop": TOPOLOGIES,
  "posted, loss": TOPOLOGIES,
  "posted, start": TOPOLOGIES,
  "posted, unmount": TOPOLOGIES,
  "rowless, posted, stop": TOPOLOGIES,
  "posted, stop, still presented": TOPOLOGIES,
  "fenced, stop, then a preparation": TOPOLOGIES,
  "posted, stop, then a preparation": TOPOLOGIES,
  "a script failure after the answer": TOPOLOGIES,
  "the origin gone after the yield": TOPOLOGIES,
  "fenced, a stop and a preparation in one task": TOPOLOGIES,
  "posted, a stop and a preparation in one task": TOPOLOGIES,
  "fenced, a stop and a Start in one task": TOPOLOGIES,
  "posted, a stop and a Start in one task": TOPOLOGIES,
  "a chat change before the admission": TOPOLOGIES,
  "an answer in an inspected state": TOPOLOGIES,
  "a retired outcome while freezing": TOPOLOGIES,
  // In-process, an error stop with no request in flight commits at once (`stopAt`'s `frozen()`): no freeze to miss.
  "an outcome inside a missed freeze": TOPOLOGIES.filter((topology) => topology === "worker"),
  "a missed stop with nothing pending": TOPOLOGIES,
  "an answer after a missed stop": TOPOLOGIES,
  "a form update after a missed stop": TOPOLOGIES,
  "an update's outcome after a missed stop": TOPOLOGIES,
  "the epoch's work after an unmount": TOPOLOGIES,
  "a failing piece of the epoch's work": TOPOLOGIES,
  "the chat's text at a stop": TOPOLOGIES,
} as const;
const RERUN = rerunRegistry(CASES);

/** What the event leaves: the answer undone into the chat, released with its line, or dropped. */
const EXPECTED: Record<Stage, Record<Event, "undone" | "released" | "dropped">> = {
  accepted: { stop: "undone", loss: "undone", start: "dropped", unmount: "dropped" },
  fenced: { stop: "undone", loss: "undone", start: "dropped", unmount: "dropped" },
  // The host ran the posted answer before the stop: the final publication no longer presents it.
  posted: { stop: "released", loss: "undone", start: "dropped", unmount: "dropped" },
};

for (const stage of ["accepted", "fenced", "posted"] as const)
  for (const event of ["stop", "loss", "start", "unmount"] as const)
    RERUN.rows(
      `${stage}, ${event}`,
      `an answer ${stage} at a ${event} is ${EXPECTED[stage][event]}`,
      async (context, topology, end) => {
        const { player, composer, submission, connection, frame, scope } = await page(
          context,
          topology,
          CHOICE,
        );
        const actionId = activeAction(player)!;
        // The other chat's Start is prepared before the hold, which would hold its preparation's reply too.
        const other =
          event === "start"
            ? await sourceStart(player.bridge, 'say "other", instant\nexit', () => ({
                wallClockMs: 0,
              }))
            : null;
        type(composer, "Go");
        if (stage === "accepted") frame.hold();
        else connection.hold(stage === "fenced" ? "observeInput" : ANSWER_OP);
        submission.send("input");
        const record = submission.pending.value;
        assert.ok(record, "the answer is pending");
        assert.equal(composer.chatText.value, "", "the sent text left the chat");
        if (stage === "accepted") await until(() => frame.waiting() === 1, "the frame", "step");
        else await connection.held();
        assert.equal(record.stage, stage);
        const chatBefore = player.chat.value;
        let started: Promise<void> | null = null;
        if (event === "stop") {
          player.reportHostError(new TypeError("a component failed"));
          // The error stop halts the session until the host acknowledges it, behind the reply a row holds; with nothing
          // in flight an in-process host acknowledges it at once.
          if (stage !== "accepted") assert.equal(player.terminal.value, "freezing");
        } else if (event === "loss") await connection.lose();
        else if (event === "start") {
          player.prepare(other!);
          started = player.activate();
        } else scope.stop();
        frame.release();
        connection.release();
        await started;
        const expected = EXPECTED[stage][event];
        await until(() => record.stage === "settled", "the answer settled", "host");
        if (event === "stop")
          await until(() => player.terminal.value === "stopped", "the final publication", "host");
        // Undone: the text is back in the chat, without a notice. Released: the chat stays empty and the stopped
        // session holds the answer. Dropped: nothing is written, to another chat or after the unmount.
        assert.equal(composer.chatText.value, expected === "undone" ? "Go" : "");
        assert.equal(submission.notice.value, "");
        assert.equal(submission.pending.value, null);
        const answers = connection.posts.filter((post) => post.op === ANSWER_OP).length;
        assert.equal(answers, stage === "posted" ? 1 : 0, "posted once at most, never again");
        if (event === "start") assert.notEqual(player.chat.value, chatBefore, "another chat");
        if (expected === "released") {
          const frozen = player.session.value!;
          assert.ok(!playerRuntimeInteractionActionIds(frozen.state).includes(actionId));
          assert.ok(frozen.transcriptEntries.some((entry) => entry.text === "Go"));
        }
        return end();
      },
    );

RERUN.rows(
  "rowless, posted, stop",
  "a password posted at a stop is released once the final publication no longer presents it",
  async (context, topology, end) => {
    const { player, composer, submission, connection } = await page(context, topology, PASSWORD);
    const actionId = activeAction(player)!;
    assert.equal(composer.tenant.value.kind, "password");
    type(composer, "secret");
    connection.hold(ANSWER_OP);
    submission.send("input");
    const record = submission.pending.value!;
    assert.equal(record.row, null, "a password has no line");
    assert.equal(composer.displayed.value, "", "the password is erased at the send");
    await connection.held();
    assert.equal(record.stage, "posted");
    player.reportHostError(new TypeError("a component failed"));
    assert.equal(player.terminal.value, "freezing");
    // Kept through the freeze: the final publication decides.
    assert.equal(record.stage, "posted");
    connection.release();
    await until(() => player.terminal.value === "stopped", "the final publication", "host");
    assert.equal(record.stage, "settled");
    const frozen = player.session.value!;
    assert.ok(!playerRuntimeInteractionActionIds(frozen.state).includes(actionId), "answered");
    assert.equal(composer.chatText.value, "", "nothing is written to the chat");
    assert.equal(submission.notice.value, "");
    assert.equal(connection.posts.filter((post) => post.op === ANSWER_OP).length, 1);
    return end();
  },
);

RERUN.rows(
  "posted, stop, still presented",
  "an answer the stop overtook as it was sent is undone once the final publication still presents its action",
  async (context, topology, end) => {
    const { player, composer, submission, connection, sections } = await page(
      context,
      topology,
      CHOICE,
    );
    const actionId = activeAction(player)!;
    type(composer, "Go");
    // The stop comes after the answer's admission, before its op reaches the host.
    sections.beforeSend = () => player.reportHostError(new TypeError("a component failed"));
    submission.send("input");
    const record = submission.pending.value!;
    await until(() => player.terminal.value === "stopped", "the final publication", "host");
    await until(() => record.stage === "settled", "the answer settled", "host");
    const frozen = player.session.value!;
    assert.ok(playerRuntimeInteractionActionIds(frozen.state).includes(actionId), "not taken");
    assert.equal(connection.posts.filter((post) => post.op === ANSWER_OP).length, 0, "never sent");
    assert.equal(composer.chatText.value, "Go", "undone");
    assert.equal(submission.notice.value, "");
    assert.equal(submission.pending.value, null);
    return end();
  },
);

/** A Start shown over the stopped session (`prepare`), whose preparation retires the stop while it still shows. */
async function otherStart(player: SessionHost) {
  return sourceStart(player.bridge, 'say "other", instant\nexit', () => ({ wallClockMs: 0 }));
}

RERUN.rows(
  "fenced, stop, then a preparation",
  "an answer a stop undid before it was sent is never sent when another Start's preparation retires that stop",
  async (context, topology, end) => {
    const { player, composer, submission, connection, sections } = await page(
      context,
      topology,
      CHOICE,
    );
    const other = await otherStart(player);
    type(composer, "Go");
    connection.hold("observeInput");
    submission.send("input");
    const record = submission.pending.value!;
    await connection.held();
    assert.equal(record.stage, "fenced");
    player.reportHostError(new TypeError("a component failed"));
    await until(() => record.stage === "settled", "undone at the stop", "step");
    assert.equal(composer.chatText.value, "Go");
    // The held observation comes back once the stop is retired, while the stopped session still shows.
    player.prepare(other);
    assert.equal(player.terminal.value, null);
    connection.release();
    await until(() => sections.returned.length === 1, "the answer's section returned", "host");
    assert.equal(sections.returned[0], "retired");
    assert.equal(composer.chatText.value, "Go", "undone once");
    assert.equal(connection.posts.filter((post) => post.op === ANSWER_OP).length, 0, "never sent");
    assert.equal(submission.notice.value, "");
    assert.equal(submission.pending.value, null);
    return end();
  },
);

RERUN.rows(
  "posted, stop, then a preparation",
  "an answer posted before a stop is undone, without a notice or a resend, when another Start's preparation retires the stop before its final publication",
  async (context, topology, end) => {
    const { player, composer, submission, connection, sections } = await page(
      context,
      topology,
      CHOICE,
    );
    const other = await otherStart(player);
    // The stop's halt settles only once the row lets it.
    let halted = () => {};
    const halt = new Promise<void>((resolve) => (halted = resolve));
    const bridgeHalt = connection.bridge.halt.bind(connection.bridge);
    context.mock.method(
      connection.bridge,
      "halt",
      async (...args: Parameters<typeof bridgeHalt>) => {
        await bridgeHalt(...args);
        await halt;
      },
    );
    type(composer, "Go");
    connection.hold(ANSWER_OP);
    submission.send("input");
    const record = submission.pending.value!;
    await connection.held();
    player.reportHostError(new TypeError("a component failed"));
    assert.equal(player.terminal.value, "freezing");
    connection.release();
    await until(() => sections.returned.length === 1, "the answer's section returned", "host");
    assert.equal(sections.returned[0], "retired");
    assert.equal(record.stage, "posted", "kept through the freeze");
    player.prepare(other);
    await until(() => record.stage === "settled", "the answer settled", "step");
    assert.equal(player.terminal.value, null);
    assert.equal(composer.chatText.value, "Go", "undone: the outcome is unknown");
    assert.equal(submission.notice.value, "");
    assert.equal(submission.pending.value, null);
    halted();
    assert.equal(
      connection.posts.filter((post) => post.op === ANSWER_OP).length,
      1,
      "never sent again",
    );
    return end();
  },
);

RERUN.rows(
  "a script failure after the answer",
  "a script failure the answer's continuation publishes is no stop: the answer is released by its outcome",
  async (context, topology, end) => {
    const { player, composer, submission } = await page(
      context,
      topology,
      'let pick = askChoice "Go"\nlet zero = dynamic(0)\nlet result = 1 / zero\nexit\nfunction dynamic(value) {\n    return value\n}',
    );
    type(composer, "Go");
    submission.send("input");
    const record = submission.pending.value!;
    await until(() => record.stage === "settled", "the answer settled", "host");
    assert.equal(player.session.value?.state.status, "failed");
    assert.equal(player.terminal.value, null, "a published failure is no stop");
    assert.equal(composer.chatText.value, "", "released: the text stays sent");
    assert.equal(submission.notice.value, "");
    return end();
  },
);

RERUN.rows(
  "the origin gone after the yield",
  "a block that takes the screen during the answer's painted frame refuses it before it is sent: it is undone with the notice",
  async (context, topology, end) => {
    const { player, composer, submission, connection, frame } = await page(
      context,
      topology,
      'timer async 60 s {\n  showButton "Back"\n}\nlet pick = askChoice "Go"\nsay "after", instant\nexit',
    );
    type(composer, "Go");
    frame.hold();
    submission.send("input");
    const record = submission.pending.value!;
    await until(() => frame.waiting() === 1, "the frame", "step");
    // The scene clock's wake runs the due block while the answer waits for its frame.
    const now = performance.now() + 61_000;
    context.mock.method(performance, "now", () => now);
    await player.observe();
    assert.equal(record.stage, "accepted");
    frame.release();
    await until(() => record.stage === "settled", "the answer settled", "host");
    assert.equal(composer.chatText.value, "Go");
    assert.equal(
      submission.notice.value,
      "The question was gone before your answer arrived. Your text is back in the field.",
    );
    assert.equal(connection.posts.filter((post) => post.op === ANSWER_OP).length, 0);
    return end();
  },
);

// The answer's token: a stop, a loss or a replacement takes a new epoch, so an answer accepted before it is never posted
// after it, and one posted before it settles by the token even when the terminal level went back before anything looked.

/** The stop's halt, held until the row lets it settle. */
function holdHalt(context: TestContext, connection: { readonly bridge: PlayerBridge }) {
  let halted = () => {};
  const halt = new Promise<void>((resolve) => (halted = resolve));
  const bridgeHalt = connection.bridge.halt.bind(connection.bridge);
  context.mock.method(connection.bridge, "halt", async (...args: Parameters<typeof bridgeHalt>) => {
    await bridgeHalt(...args);
    await halt;
  });
  return () => halted();
}

const answerPosts = (connection: { readonly posts: readonly { readonly op: string }[] }) =>
  connection.posts.filter((post) => post.op === ANSWER_OP).length;

for (const stage of ["fenced", "posted"] as const)
  for (const then of ["preparation", "Start"] as const)
    RERUN.rows(
      `${stage}, a stop and a ${then} in one task`,
      `an answer ${stage} when a stop and another ${then === "Start" ? "chat's Start" : "Start's preparation"} come in one task, with no flush between, is ${stage === "posted" ? "undone once, never sent again" : "never sent"}`,
      async (context, topology, end) => {
        const { player, composer, submission, connection, sections } = await page(
          context,
          topology,
          CHOICE,
        );
        const other = await otherStart(player);
        const chat = player.chat.value;
        let started: Promise<void> | null = null;
        const replace = () => {
          player.reportHostError(new TypeError("a component failed"));
          player.prepare(other);
          if (then === "Start") started = player.activate();
        };
        type(composer, "Go");
        // Never posted: the stop and its replacement come as the section decides, ahead of the admission.
        if (stage === "fenced") sections.beforeBody = replace;
        else connection.hold(ANSWER_OP);
        submission.send("input");
        const record = submission.pending.value!;
        if (stage === "posted") {
          await connection.held();
          assert.equal(record.stage, "posted");
          replace();
          connection.release();
        }
        await until(() => record.stage === "settled", "the answer settled", "host");
        if (then === "Start") {
          await until(() => started !== null, "the Start", "step");
          await started;
        }
        await until(() => sections.returned.length === 1, "the answer's section returned", "host");
        if (stage === "fenced")
          assert.equal(sections.returned[0], "retired", "refused at admission");
        assert.equal(
          answerPosts(connection),
          stage === "posted" ? 1 : 0,
          "never sent after the stop",
        );
        assert.equal(submission.notice.value, "");
        assert.equal(submission.pending.value, null);
        // Undone into its own chat; another chat's Start shows its own, empty.
        if (then === "Start") {
          await until(() => player.chat.value !== chat, "the other chat", "host");
          assert.equal(composer.chatText.value, "");
        } else assert.equal(composer.chatText.value, "Go", "undone: the outcome is unknown");
        return end();
      },
    );

RERUN.rows(
  "a chat change before the admission",
  "an answer whose chat another replaced, with no flush between, is refused at admission and dropped",
  async (context, topology, end) => {
    const { player, composer, submission, connection, sections } = await page(
      context,
      topology,
      CHOICE,
    );
    const chat = player.chat.value;
    const epoch = player.epoch();
    type(composer, "Go");
    // A chat change alone: the session shown again in a new chat, as the rewind shows its states; no epoch moves.
    sections.beforeBody = () => player.showSession(player.session.value!);
    submission.send("input");
    const record = submission.pending.value!;
    await until(() => record.stage === "settled", "the answer settled", "host");
    await until(() => sections.returned.length === 1, "the answer's section returned", "host");
    assert.notEqual(player.chat.value, chat, "another chat");
    assert.equal(player.epoch(), epoch, "the same epoch");
    assert.equal(sections.returned[0], "retired");
    assert.equal(answerPosts(connection), 0, "never sent");
    assert.equal(composer.chatText.value, "", "dropped: nothing written to the new chat");
    assert.equal(submission.notice.value, "");
    return end();
  },
);

RERUN.rows(
  "an answer in an inspected state",
  "an answer in a state Debug's rewind restored adopts it and is sent once and released, as any answer",
  async (context, topology, end) => {
    const { player, composer, submission, connection, debug } = await page(
      context,
      topology,
      'let first = askChoice "Red", "Blue"\nsay "First: ${first}.", instant\nlet second = askChoice "Left", "Right"\nsay "Second: ${second}.", instant\nexit',
      { rewind: true },
    );
    const rewind = debug!;
    type(composer, "Red");
    submission.send("input");
    const first = submission.pending.value!;
    await until(() => first.stage === "settled", "the first answer", "host");
    await until(() => rewind.state.value.points.length === 2, "the second point", "host");
    assert.equal(await rewind.back(rewind.state.value.points[0]!.id), true, "Back");
    await until(() => rewind.state.value.inspection !== null, "the inspection", "host");
    const posts = answerPosts(connection);
    type(composer, "Blue");
    submission.send("input");
    const record = submission.pending.value!;
    await until(() => record.stage === "settled", "the answer settled", "host");
    assert.equal(answerPosts(connection), posts + 1, "sent once");
    assert.equal(rewind.state.value.inspection, null, "the state adopted");
    assert.equal(composer.chatText.value, "", "released: nothing put back");
    assert.equal(submission.notice.value, "");
    assert.ok(
      player.session.value!.transcriptEntries.some((entry) => entry.text === "First: Blue."),
      "the adopted state ran the answer",
    );
    return end();
  },
);

RERUN.rows(
  "a retired outcome while freezing",
  "a posted answer whose input returns while its stop freezes waits for the final publication, which releases it or undoes it once",
  async (context, topology, end) => {
    for (const each of [
      { script: CHOICE, text: "Go", taken: true },
      { script: PASSWORD, text: "secret", taken: true },
      { script: CHOICE, text: "Go", taken: false },
    ]) {
      const { player, composer, submission, connection, sections, scope } = await page(
        context,
        topology,
        each.script,
      );
      const actionId = activeAction(player)!;
      const halted = holdHalt(context, connection);
      type(composer, each.text);
      const stop = () => player.reportHostError(new TypeError("a component failed"));
      // Taken: the host runs the answer before the stop. Not taken: the stop comes as it is sent, so it is not.
      if (each.taken) connection.hold(ANSWER_OP);
      else sections.beforeSend = stop;
      submission.send("input");
      const record = submission.pending.value!;
      if (each.taken) {
        await connection.held();
        stop();
        connection.release();
      }
      await until(() => sections.returned.length === 1, "the answer's section returned", "host");
      assert.equal(sections.returned[0], "retired");
      // In-process, a stop with no request in flight commits at once (`stopAt`'s `frozen()`); otherwise it freezes.
      if (each.taken || topology === "worker") {
        assert.equal(player.terminal.value, "freezing");
        assert.equal(record.stage, "posted", "waits through the freeze");
      } else assert.equal(player.terminal.value, "stopped");
      halted();
      await until(() => player.terminal.value === "stopped", "the final publication", "host");
      await until(() => record.stage === "settled", "the answer settled", "host");
      const presented = playerRuntimeInteractionActionIds(player.session.value!.state).includes(
        actionId,
      );
      assert.equal(presented, !each.taken);
      const undone = !each.taken && each.script === CHOICE;
      assert.equal(composer.chatText.value, undone ? "Go" : "", `${each.text}: once`);
      assert.equal(answerPosts(connection), each.taken ? 1 : 0, "never sent again");
      assert.equal(submission.notice.value, "");
      scope.stop();
    }
    return end();
  },
);

/** Runs `act` after `depth` microtasks. */
function afterMicrotasks(depth: number, act: () => void) {
  if (depth === 0) return act();
  queueMicrotask(() => afterMicrotasks(depth - 1, act));
}

RERUN.rows(
  "an outcome inside a missed freeze",
  "a posted answer whose outcome reads a stop that a preparation retires before any flush is undone once by its token",
  async (context, topology, end) => {
    // The order: the stop, then the answer's outcome reading `freezing`, then the preparation, all before Vue's flush.
    // Which microtask the outcome resumes in depends on the engine's promise hops, so the row steps the stop through
    // them until the outcome reads `freezing` with no flush between the stop and the preparation.
    for (let depth = 0; depth < 32; depth += 1) {
      const made = await page(context, topology, CHOICE);
      const { player, composer, submission, connection, sections, terminalReads, scope } = made;
      const other = await otherStart(player);
      const halted = holdHalt(context, connection);
      let flushes = 0;
      const flushed = watch(
        () => [player.terminal.value],
        () => void (flushes += 1),
      );
      context.after(flushed);
      type(composer, "Go");
      connection.hold(ANSWER_OP);
      submission.send("input");
      const record = submission.pending.value!;
      await connection.held();
      let missed = false;
      sections.afterReturn = () =>
        afterMicrotasks(depth, () => {
          const reads = terminalReads.length;
          const before = flushes;
          queueMicrotask(() => {
            missed =
              terminalReads.slice(reads).includes("freezing") &&
              flushes === before &&
              record.stage === "posted";
            player.prepare(other);
          });
          player.reportHostError(new TypeError("a component failed"));
        });
      connection.release();
      await until(() => record.stage === "settled", "the answer settled", "host");
      if (!missed) {
        halted();
        scope.stop();
        continue;
      }
      assert.equal(player.terminal.value, null);
      assert.equal(submission.pending.value, null);
      assert.equal(composer.chatText.value, "Go", "undone: the outcome is unknown");
      assert.equal(submission.notice.value, "");
      assert.equal(answerPosts(connection), 1, "the original post only");
      // The retired stop's halt settles: nothing changes.
      halted();
      for (let turn = 0; turn < 4; turn += 1)
        await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(player.terminal.value, null);
      assert.equal(composer.chatText.value, "Go");
      assert.equal(submission.notice.value, "");
      assert.equal(answerPosts(connection), 1);
      return end();
    }
    assert.fail("no microtask depth put the outcome inside the missed freeze");
  },
);

// The epoch's boundary: what must happen as a stop, a loss or a replacement takes a new token happens inside that move,
// and input asked on a session shown under an older token is refused, also when the stop went back before any flush.

const FORM = 'let answers = askForm fields: { name: "Ada" }\nsay "${answers.name}", instant\nexit';
const opPosts = (connection: { readonly posts: readonly { readonly op: string }[] }, op: string) =>
  connection.posts.filter((post) => post.op === op).length;
/** An error stop and another Start's preparation in one task: no flush between, so no watch saw the stop. */
function missedStop(player: SessionHost, other: Awaited<ReturnType<typeof otherStart>>) {
  player.reportHostError(new TypeError("a component failed"));
  player.prepare(other);
}

RERUN.rows(
  "a missed stop with nothing pending",
  "a stop a preparation retires in the same task still erases the secret, drops the notice and stores no form draft that was waiting",
  async (context, topology, end) => {
    {
      const { player, composer, submission } = await page(context, topology, PASSWORD);
      const other = await otherStart(player);
      assert.equal(composer.tenant.value.kind, "password");
      type(composer, "unsent-secret");
      submission.showNotice("A notice.");
      missedStop(player, other);
      assert.equal(composer.displayed.value, "", "the secret is gone at once");
      assert.equal(submission.notice.value, "", "the notice is gone");
      assert.equal(submission.pending.value, null);
    }
    // A preparation alone, and a lost connection alone, each move the token and do the same.
    {
      const { player, composer } = await page(context, topology, PASSWORD);
      const other = await otherStart(player);
      type(composer, "unsent-secret");
      player.prepare(other);
      assert.equal(composer.displayed.value, "", "the secret is gone at the preparation");
    }
    {
      const { player, composer, connection } = await page(context, topology, PASSWORD);
      type(composer, "unsent-secret");
      // Read inside the loss's own move of the token, after the controller's work and before the field leaves.
      let atLoss: string | null = null;
      context.after(player.onEpoch(() => void (atLoss = composer.displayed.value)));
      await connection.lose();
      assert.equal(atLoss, "", "the secret is gone at the loss");
    }
    {
      const { player, composer, forms, connection } = await page(context, topology, FORM);
      const other = await otherStart(player);
      forms.stepField("name");
      await until(() => composer.tenant.value.kind === "form", "the name field's editor", "host");
      type(composer, "Bea");
      missedStop(player, other);
      // The draft would be stored 400 ms after the edit.
      await new Promise((resolve) => setTimeout(resolve, 800));
      assert.equal(opPosts(connection, "draftForm"), 0, "no draft stored after the stop");
    }
    return end();
  },
);

RERUN.rows(
  "an answer after a missed stop",
  "an answer to the question a retired stop left on screen shows nothing, sends nothing and keeps its text",
  async (context, topology, end) => {
    const { player, composer, submission, connection } = await page(context, topology, CHOICE);
    const other = await otherStart(player);
    missedStop(player, other);
    assert.notEqual(
      player.inputEpoch(),
      player.epoch(),
      "the shown session belongs to an older epoch",
    );
    type(composer, "Go");
    submission.send("input");
    submission.choose(null);
    assert.equal(submission.pending.value, null, "not taken");
    assert.equal(composer.chatText.value, "Go", "the text stays");
    assert.equal(submission.notice.value, "", "no notice");
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(answerPosts(connection), 0, "never sent");
    return end();
  },
);

RERUN.rows(
  "a form update after a missed stop",
  "a form's field step asked after a retired stop sends nothing, and a typed label stays in the chat",
  async (context, topology, end) => {
    const { player, composer, forms, connection } = await page(context, topology, FORM);
    const other = await otherStart(player);
    missedStop(player, other);
    // A typed label sent to the form: refused as it is asked, so the chat keeps it.
    type(composer, "name");
    forms.stepField("name", true);
    assert.equal(composer.chatText.value, "name", "the label stays in the chat");
    forms.stepField("name");
    forms.clearField();
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(opPosts(connection, "stepFormField"), 0);
    assert.equal(opPosts(connection, "clearFormField"), 0);
    return end();
  },
);

RERUN.rows(
  "an update's outcome after a missed stop",
  "a typed field label whose step returns after a stop and its preparation shows no notice, and the label is back in the chat",
  async (context, topology, end) => {
    const { player, composer, submission, connection } = await page(context, topology, FORM);
    const other = await otherStart(player);
    type(composer, "name");
    connection.hold("stepFormField");
    submission.send("input");
    await connection.held();
    assert.equal(composer.chatText.value, "", "the label left the chat");
    missedStop(player, other);
    connection.release();
    await until(() => composer.chatText.value === "name", "the label back in the chat", "host");
    assert.equal(submission.notice.value, "", "no notice");
    return end();
  },
);

RERUN.rows(
  "the epoch's work after an unmount",
  "an unmounted interaction's work is no longer registered and does not run at a later stop",
  async (context, topology, end) => {
    const { player, scope, epochWork } = await page(context, topology, CHOICE);
    assert.equal(epochWork.registered.size, 1, "registered while mounted");
    scope.stop();
    assert.equal(epochWork.registered.size, 0, "removed at the unmount");
    const runs = epochWork.runs;
    player.reportHostError(new TypeError("a component failed"));
    assert.equal(epochWork.runs, runs, "nothing ran for the unmounted interaction");
    return end();
  },
);

RERUN.rows(
  "a failing piece of the epoch's work",
  "a piece of work that throws neither aborts the stop nor keeps the others from running, and its failure is a diagnostic",
  async (context, topology, end) => {
    const { player, composer } = await page(context, topology, PASSWORD);
    let after = 0;
    const offFailing = player.onEpoch(() => {
      throw new Error("work failed");
    });
    const offAfter = player.onEpoch(() => void (after += 1));
    context.after(() => {
      offFailing();
      offAfter();
    });
    type(composer, "unsent-secret");
    player.reportHostError(new TypeError("a component failed"));
    assert.notEqual(player.terminal.value, null, "the stop went on");
    assert.equal(composer.displayed.value, "", "the controller's work ran");
    assert.equal(after, 1, "the work after the failing one ran");
    assert.deepEqual(
      player.diagnostics.value.map((diagnostic) => [diagnostic.code, diagnostic.message]),
      [["epoch-work-failed", "work failed"]],
    );
    return end();
  },
);

RERUN.rows(
  "the chat's text at a stop",
  "a stop, retired by a preparation in the same task or not, leaves the chat's unsent text as it was",
  async (context, topology, end) => {
    for (const retired of [false, true]) {
      const { player, composer, scope } = await page(context, topology, CHOICE);
      const other = await otherStart(player);
      type(composer, "Unsent words");
      if (retired) missedStop(player, other);
      else player.reportHostError(new TypeError("a component failed"));
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(composer.chatText.value, "Unsent words", `retired: ${retired}`);
      scope.stop();
    }
    return end();
  },
);
