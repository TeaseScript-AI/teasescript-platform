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
 * How the session's end settles an answer under way (the owner's decisions of 2026-11-11/12, #2430): by the answer's stage
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
  readonly terminal: () => SessionTerminal;
  readonly inputSection: () => InputSectionHost | undefined;
  readonly prepareInput: () => true;
  readonly publish: (session: PlayerSession) => void;
  readonly unansweredMessage: () => string;
  readonly submitLock: (password: string) => void;
  readonly nextFrame: () => Promise<void>;
}) => AnswerSubmission;
let useFormUpdates: (host: {
  readonly composer: ComposerState;
  readonly session: () => PlayerSession | null;
  readonly chat: () => number;
  readonly terminal: () => SessionTerminal;
  readonly inputSection: () => InputSectionHost | undefined;
  readonly run: AnswerSubmission["run"];
  readonly publish: (session: PlayerSession) => void;
  readonly showNotice: (message: string) => void;
  readonly clearNotice: () => void;
  readonly unansweredMessage: () => string;
}) => FormUpdates;

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
async function page(context: TestContext, topology: Topology, script: string) {
  browser(context);
  const connections = await topologyConnections(context, topology);
  const connection = connections.first;
  const frame = frames();
  // The input section the answers use: what each run returned, and an act a row runs just before the answer's op is sent.
  const sections: { returned: (string | null)[]; beforeSend: (() => void) | null } = {
    returned: [],
    beforeSend: null,
  };
  const scope = effectScope();
  const made = scope.run(() => {
    const player = usePlayerSession({
      bridge: Promise.resolve(connection.bridge),
      debugHistorySpill: async () => null,
      keptSessions: memoryKeptSessionStore(),
    });
    const shown = () => (player.stopped.value ? null : player.session.value);
    const section: InputSectionHost = async (work, body) => {
      const result = await player.inputSection(work, (input, observed) =>
        body(
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
        ),
      );
      sections.returned.push(
        result !== null && typeof result === "object" && "kind" in result
          ? String(result.kind)
          : null,
      );
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
      terminal: () => player.terminal.value,
      inputSection: () => section,
      prepareInput: () => true,
      publish: (session) => player.update(session),
      unansweredMessage: () => "Nothing answers that.",
      submitLock: () => {},
      nextFrame: frame.next,
    });
    const forms: FormUpdates = useFormUpdates({
      composer,
      session: shown,
      chat: () => player.chat.value,
      terminal: () => player.terminal.value,
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
    return { player, composer, submission };
  })!;
  context.after(() => scope.stop());
  const { player } = made;
  player.prepare(await sourceStart(player.bridge, script, () => ({ wallClockMs: 0 })));
  await player.activate();
  await until(() => activeAction(player) !== undefined, "the question", "host");
  return { ...made, connection, connections, frame, scope, sections };
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
    assert.equal(submission.notice.value, "This interaction is no longer available.");
    assert.equal(connection.posts.filter((post) => post.op === ANSWER_OP).length, 0);
    return end();
  },
);
