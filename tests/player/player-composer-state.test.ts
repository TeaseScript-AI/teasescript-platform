import assert from "node:assert/strict";
import test, { before, type TestContext } from "node:test";
import { effectScope, watch, type Ref } from "vue";

import type { LockDialog, LockDialogInput } from "../../player/encryption/lock-service.js";
import {
  memoryKeptSessionStore,
  type KeptSessionStore,
} from "../../player/persistence/kept-sessions.js";
import type { PlayerBridge } from "../../player/runtime/player-bridge.js";
import type { PlayerRuntimeSessionOptions } from "../../player/runtime/runtime-adapter.js";
import {
  activePlayerRuntimeInteraction,
  playerRuntimeForeground,
  playerRuntimeForm,
  type PlayerSession,
} from "../../player/runtime/runtime-view.js";
import type {
  AnswerSubmission,
  SessionTerminal,
} from "../../player/vue/src/interaction/useAnswerSubmission.js";
import type {
  ComposerDescriptor,
  ComposerState,
  FormDraft,
} from "../../player/vue/src/interaction/useComposerState.js";
import type { PlayerTranscriptEntryPresentation } from "../../player/presentation/model.js";
import type { FormUpdates } from "../../player/vue/src/interaction/useFormUpdates.js";
import type { InputSectionHost } from "../../player/vue/src/session/runtime-input.js";
import { normalizeColor } from "../../src/color.js";
import { loadPlayerModule } from "../helpers/player-modules.js";
import { sourceStart } from "../helpers/prepared-plan.js";
import {
  checkpointSnapshot,
  loadTopology,
  rerunRegistry,
  TOPOLOGIES,
  topologyConnections,
  until,
  type Topology,
} from "../helpers/player/worker-topology.js";

/*
 * The composer's controllers as `RuntimeInteraction` wires them (the owner's decisions of 2026-11-11/12, #2430): the
 * slots of the composer's one field, the answers checked at once and settled by the runtime, and a form's updates.
 * Each row runs the real controllers over the real `usePlayerSession`, its lock service and input sections, on both
 * topologies, with the post log. A block wins by controlled time: `performance.now` stands past its timer, no automatic
 * wake runs, and the answer's own observation runs the block first.
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
  readonly bridge: Promise<PlayerBridge>;
  readonly inputSection: InputSectionHost;
  readonly lock: {
    readonly dialog: Readonly<Ref<{ readonly dialog: LockDialog; readonly busy: boolean } | null>>;
    readonly submit: (input: LockDialogInput) => void;
  };
  update(session: PlayerSession): void;
  observe(): Promise<PlayerSession | null>;
  prepare(create: {
    readonly plan: string;
    readonly options: () => PlayerRuntimeSessionOptions;
  }): void;
  activate(): Promise<void>;
}
type Modules = {
  usePlayerSession: (options: {
    readonly bridge: Promise<PlayerBridge>;
    readonly debugHistorySpill: () => Promise<null>;
    readonly keptSessions?: KeptSessionStore;
  }) => SessionHost;
  useComposerState: (host: {
    readonly draft: (draft: FormDraft) => Promise<boolean>;
    readonly holdDrafts: () => boolean;
    readonly fieldChanged: () => void;
  }) => ComposerState;
  composerDescriptor: (shown: {
    readonly session: PlayerSession | null;
    readonly reset: number;
    readonly chat: number;
    readonly foreground: ReturnType<typeof playerRuntimeForeground>;
    readonly form: ReturnType<typeof playerRuntimeForm>;
    readonly lock: { readonly key: string; readonly repeat: boolean } | null;
    readonly consumed: number | null;
  }) => ComposerDescriptor;
  descriptorKey: (next: ComposerDescriptor) => string;
  displayedList: () => (
    entries: readonly PlayerTranscriptEntryPresentation[],
    pending: PlayerTranscriptEntryPresentation | null,
  ) => readonly PlayerTranscriptEntryPresentation[];
  rowKey: (entry: PlayerTranscriptEntryPresentation) => string;
  useAnswerSubmission: (host: {
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
    readonly prepareInput: () => true;
    readonly publish: (session: PlayerSession) => void;
    readonly unansweredMessage: () => string;
    readonly submitLock: (password: string) => void;
    readonly nextFrame: () => Promise<void>;
  }) => AnswerSubmission;
  useFormUpdates: (host: {
    readonly composer: ComposerState;
    readonly session: () => PlayerSession | null;
    readonly chat: () => number;
    readonly epoch: () => number;
    readonly inputEpoch: () => number;
    readonly terminal: () => SessionTerminal;
    readonly inputSection: () => InputSectionHost | undefined;
    readonly run: AnswerSubmission["run"];
    readonly publish: (session: PlayerSession) => void;
    readonly showNotice: (message: string) => void;
    readonly clearNotice: () => void;
    readonly unansweredMessage: () => string;
  }) => FormUpdates;
};
let modules: Modules;
let intents: typeof import("../../player/vue/src/session/runtime-input.js").intents;

before(async () => {
  const session = await loadPlayerModule("player/vue/src/session/usePlayerSession.ts");
  const composer = await loadPlayerModule("player/vue/src/interaction/useComposerState.ts");
  const submission = await loadPlayerModule("player/vue/src/interaction/useAnswerSubmission.ts");
  const forms = await loadPlayerModule("player/vue/src/interaction/useFormUpdates.ts");
  const input = await loadPlayerModule("player/vue/src/session/runtime-input.ts");
  const list = await loadPlayerModule("player/vue/src/transcript/displayedList.ts");
  // EVIDENCE: validation: Vite loaded the real source modules; these are their exports.
  modules = {
    usePlayerSession: session.usePlayerSession,
    useComposerState: composer.useComposerState,
    composerDescriptor: composer.composerDescriptor,
    descriptorKey: composer.descriptorKey,
    useAnswerSubmission: submission.useAnswerSubmission,
    useFormUpdates: forms.useFormUpdates,
    displayedList: list.displayedList,
    rowKey: list.rowKey,
  } as Modules;
  // EVIDENCE: validation: as above, the input sections' intents.
  intents = input.intents as typeof intents;
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
}

/** The painted frame before an answer is sent, which a row may hold to type while the answer is only accepted. */
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
 * The real composable on `topology`, started on `script`, with the composer's, the answers' and the form updates'
 * controllers over it as `RuntimeInteraction` wires them, its descriptor included. Drafts are stored while `drafts.held`
 * is false.
 */
async function page(context: TestContext, topology: Topology, script: string) {
  browser(context);
  const connections = await topologyConnections(context, topology);
  const connection = connections.first;
  const frame = frames();
  const drafts = { held: false };
  const scope = effectScope();
  const made = scope.run(() => {
    const player = modules.usePlayerSession({
      bridge: Promise.resolve(connection.bridge),
      debugHistorySpill: async () => null,
      keptSessions: memoryKeptSessionStore(),
    });
    const shown = () => (player.stopped.value ? null : player.session.value);
    const composer: ComposerState = modules.useComposerState({
      draft: (draft) => forms.draft(draft),
      holdDrafts: () => drafts.held,
      fieldChanged: () => submission.clearNotice(),
    });
    const submission: AnswerSubmission = modules.useAnswerSubmission({
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
      onEpoch: player.onEpoch,
      terminal: () => player.terminal.value,
      inputSection: () => player.inputSection,
      prepareInput: () => true,
      publish: (session) => player.update(session),
      unansweredMessage: () => "Nothing answers that.",
      submitLock: (password) => player.lock.submit({ password, timeLockMs: null }),
      nextFrame: frame.next,
    });
    const forms: FormUpdates = modules.useFormUpdates({
      composer,
      session: shown,
      chat: () => player.chat.value,
      epoch: player.epoch,
      inputEpoch: player.inputEpoch,
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
      const lock = player.lock.dialog.value;
      return modules.composerDescriptor({
        session,
        reset: 0,
        chat: player.chat.value,
        foreground: session ? playerRuntimeForeground(session) : null,
        form: session ? playerRuntimeForm(session) : null,
        lock: lock?.dialog.kind === "password" ? lock.dialog : null,
        consumed: submission.consumed.value,
      });
    };
    watch(
      () => modules.descriptorKey(descriptor()),
      () => composer.select(descriptor()),
      { immediate: true },
    );
    return { player, composer, submission, forms };
  })!;
  context.after(() => scope.stop());
  const { player } = made;
  player.prepare(await sourceStart(player.bridge, script, () => ({ wallClockMs: 0 })));
  await player.activate();
  await until(() => player.session.value !== null, "the session", "host");
  await settled();
  return { ...made, connection, frame, drafts, scope };
}
type Page = Awaited<ReturnType<typeof page>>;

/** Lets the publication's watchers run, the composer's selection among them. */
const settled = () => new Promise((resolve) => setImmediate(resolve));

const action = (page: Page) =>
  page.player.session.value
    ? activePlayerRuntimeInteraction(page.player.session.value.state)
    : null;

/** Types `text` into the field the composer shows, as the player's edit of that field. */
function type(composer: ComposerState, text: string) {
  composer.edit(composer.token.value, text);
}

/** Stands time past every block's timer below (60 s), as a player who waits; no automatic wake runs before input. */
function due(context: TestContext) {
  const now = performance.now() + 61_000;
  context.mock.method(performance, "now", () => now);
}

/** Waits until the composer shows `kind`, after the publication's selection. */
const shows = (page: Page, kind: string, what = kind) =>
  until(() => page.composer.tenant.value.kind === kind, what, "host");

const said = (page: Page) =>
  page.player.session.value?.transcriptEntries.map((entry) => entry.text) ?? [];
const ops = (page: Page, op: string) => page.connection.posts.filter((post) => post.op === op);

/** Sends what the composer shows and waits until the answer settled. */
async function sendSettled(page: Page) {
  page.submission.send("input");
  const record = page.submission.pending.value;
  if (record !== null) await until(() => record.stage === "settled", "the answer settled", "host");
  await settled();
  return record;
}

/** Enters `password` twice in the lock's password, on its one line. */
async function enterLock(page: Page, password: string) {
  await shows(page, "lock", "the lock's password");
  type(page.composer, password);
  page.submission.send("input");
  assert.equal(page.composer.lockPhase.value, "repeat");
  type(page.composer, password);
  page.submission.send("input");
}

/** Waits until the presented form's editor holds `text` canonically, as the checkpoint keeps it. */
async function canonicalEditor(page: Page, text: string) {
  await until(
    () => {
      const session = page.player.session.value;
      return session !== null && playerRuntimeForm(session)?.editor?.text === text;
    },
    `the form's editor holds ${text}`,
    "host",
  );
  const checkpoint = await checkpointSnapshot(page.connection.bridge, page.player.session.value!);
  assert.ok(JSON.stringify(checkpoint).includes(JSON.stringify(text)), "the checkpoint holds it");
}

const LOCK =
  'let note = encryptText("Note", password: askPassword("Code"), publicKey: false, timeLock: false)';
const LOCK_BLOCK = `timer async 60 s {\n  ${LOCK}\n}`;
const BUTTON_BLOCK = 'timer async 60 s {\n  showButton "Back"\n}';
const SAY_BLOCK = 'timer async 60 s {\n  say "tick", instant\n}';
const NAME_FORM = 'let answers = askForm fields: { name: "Ada" }\nsay "${answers.name}", instant';
const END = 'showButton "End"\nexit';
const script = (...lines: string[]) => [...lines, END].join("\n");

const CASES = {
  "N1 resume without typing": TOPOLOGIES,
  "N1 refused draft": TOPOLOGIES,
  "N1 older acknowledgment": TOPOLOGIES,
  "N2 an answer opens an editor": TOPOLOGIES,
  "N2 a typed label after another chat": TOPOLOGIES,
  "N3 untouched prefill": TOPOLOGIES,
  "N3 deleted prefill": TOPOLOGIES,
  "N3 occupied, then empty on return": TOPOLOGIES,
  "N3 a block's own prefill": TOPOLOGIES,
  "N3 a refusal over a suggestion": TOPOLOGIES,
  "N4 password over chat": TOPOLOGIES,
  "N4 lock phases": TOPOLOGIES,
  "N4 a retired token": TOPOLOGIES,
  "N4 no slot for a popup": TOPOLOGIES,
  "N5 chat": TOPOLOGIES,
  "N5 date": TOPOLOGIES,
  "N5 form submit": TOPOLOGIES,
  "N5 unchecked form submit": TOPOLOGIES,
  "N5 choice": TOPOLOGIES,
  "N5 password": TOPOLOGIES,
  "N5 popup": TOPOLOGIES,
  "N6 local and runtime agree": TOPOLOGIES,
  "N6 the predicted line is the runtime's": TOPOLOGIES,
  "N6 a continuation of more than 64 rows": TOPOLOGIES,
  "N7 commit": TOPOLOGIES,
  "N7 refused commit": TOPOLOGIES,
  "N7 a block that returns at once": TOPOLOGIES,
  "N7 a lock inside the window": TOPOLOGIES,
  "N8 rowless, then an answer": TOPOLOGIES,
  "N8 automatic URL after an answer": TOPOLOGIES,
  "N8 blocked automatic tab": TOPOLOGIES,
  "N8 a waiting URL crosses a Start": TOPOLOGIES,
  "N8 an unmount while a URL waits": TOPOLOGIES,
  "N8 a URL behind a refused answer": TOPOLOGIES,
  "N8 a URL behind a lost answer": TOPOLOGIES,
  "N9 year 0000": TOPOLOGIES,
  "N11 two quick toggles": TOPOLOGIES,
  "N12 a toggle, then Submit": TOPOLOGIES,
  "notice clearers": TOPOLOGIES,
} as const;
const RERUN = rerunRegistry(CASES);

// N1: a lock interrupts an edited form field; the draft reaches the form after the return, without typing.

RERUN.rows(
  "N1 resume without typing",
  "a lock before the draft timer keeps the edited field, and the return stores it without another edit",
  async (context, topology, end) => {
    const p = await page(context, topology, script(LOCK_BLOCK, NAME_FORM));
    p.forms.stepField("name");
    await shows(p, "form", "the name field's editor");
    assert.equal(p.composer.displayed.value, "Ada");
    p.drafts.held = true;
    type(p.composer, "Bea");
    due(context);
    await p.player.observe();
    await enterLock(p, "pw");
    p.drafts.held = false;
    await shows(p, "form", "the field again");
    assert.equal(p.composer.displayed.value, "Bea", "the edited field, kept");
    assert.equal(p.composer.chatText.value, "");
    await canonicalEditor(p, "Bea");
    return end();
  },
);

RERUN.rows(
  "N1 refused draft",
  "a draft the suspended form refused stays dirty, and the return stores it",
  async (context, topology, end) => {
    const p = await page(context, topology, script(LOCK_BLOCK, NAME_FORM));
    p.forms.stepField("name");
    await shows(p, "form", "the name field's editor");
    due(context);
    p.connection.hold("observeTime");
    const observed = p.player.observe();
    await p.connection.held();
    // The draft waits behind the observation, which presents the lock first.
    type(p.composer, "Bea");
    await until(
      () => p.forms.unacknowledged(action(p)!.actionId) === 1,
      "the draft queued",
      "host",
    );
    p.connection.release();
    await observed;
    await enterLock(p, "pw");
    await shows(p, "form", "the field again");
    await canonicalEditor(p, "Bea");
    assert.equal(ops(p, "draftForm").length, 2, "refused once, then stored on the return");
    return end();
  },
);

RERUN.rows(
  "N1 older acknowledgment",
  "an acknowledgment of an older draft leaves a newer edit dirty",
  async (context, topology, end) => {
    const p = await page(context, topology, script(LOCK_BLOCK, NAME_FORM));
    p.forms.stepField("name");
    await shows(p, "form", "the name field's editor");
    p.connection.hold("draftForm");
    type(p.composer, "Bea");
    await p.connection.held();
    p.drafts.held = true;
    type(p.composer, "Bec");
    due(context);
    const observed = p.player.observe();
    p.connection.release();
    await observed;
    await enterLock(p, "pw");
    p.drafts.held = false;
    await shows(p, "form", "the field again");
    assert.equal(p.composer.displayed.value, "Bec");
    await canonicalEditor(p, "Bec");
    return end();
  },
);

// N2: an answer whose publication opens a field's editor: only the text typed after it waits behind the editor.

RERUN.rows(
  "N2 an answer opens an editor",
  "typing a field's label opens its editor; the text typed meanwhile stays in the chat",
  async (context, topology, end) => {
    const p = await page(context, topology, script(NAME_FORM));
    type(p.composer, "name");
    p.connection.hold("stepFormField");
    p.submission.send("input");
    assert.equal(p.composer.chatText.value, "", "the label left the chat");
    await p.connection.held();
    type(p.composer, "TAIL");
    p.connection.release();
    await shows(p, "form", "the editor");
    assert.equal(p.composer.displayed.value, "Ada");
    assert.equal(p.composer.chatText.value, "TAIL");
    return end();
  },
);

RERUN.rows(
  "N2 a typed label after another chat",
  "a typed field label the old session never took writes nothing into another chat",
  async (context, topology, end) => {
    const p = await page(context, topology, script(NAME_FORM));
    // The other chat's Start is prepared before the hold, which would hold its preparation's reply too.
    const other = await sourceStart(p.player.bridge, script('let a = askText "A?"'), () => ({
      wallClockMs: 0,
    }));
    type(p.composer, "name");
    p.connection.hold("stepFormField");
    p.submission.send("input");
    await p.connection.held();
    const chat = p.player.chat.value;
    p.player.prepare(other);
    const started = p.player.activate();
    p.connection.release();
    await started;
    await until(
      () => p.player.chat.value !== chat && action(p)?.ui.kind === "text",
      "the other chat",
      "host",
    );
    await settled();
    await settled();
    assert.equal(p.composer.chatText.value, "", "nothing written into the other chat");
    return end();
  },
);

test("a new session in the same chat keeps the composer's text; another chat starts it empty", () => {
  const composer = modules.useComposerState({
    draft: async () => false,
    holdDrafts: () => false,
    fieldChanged: () => {},
  });
  const at = (session: string, chat: number): ComposerDescriptor => ({
    session,
    chat,
    tenant: { kind: "chat" },
    actionId: 1,
    answered: false,
    liveActions: [1],
    prefill: null,
    editorText: null,
    editorField: null,
    temporalPrefill: null,
  });
  composer.select(at("plan:0", 1));
  type(composer, "TAIL");
  // Continue after a lost connection: a new session of the same chat.
  composer.select(at("plan:1", 1));
  assert.equal(composer.chatText.value, "TAIL");
  composer.select(at("plan:2", 2));
  assert.equal(composer.chatText.value, "");
  composer.dispose();
});

// N3: a prefill is the question's suggestion (decision 3).

const PREFILLED = 'let name = askText "Name?", prefill: "Ada"\nsay "${name}", instant';

/** Lets the block's button answer, so the question the block interrupted returns. */
async function back(p: Page) {
  await until(() => action(p)?.ui.kind === "button", "the block's button", "host");
  p.submission.choose(null);
  await until(() => p.submission.pending.value === null, "the button settled", "host");
  await until(() => action(p)?.ui.kind === "text", "the question again", "host");
  await settled();
}

RERUN.rows(
  "N3 untouched prefill",
  "an untouched prefill leaves with its question and is there again when it returns",
  async (context, topology, end) => {
    const p = await page(context, topology, script(BUTTON_BLOCK, PREFILLED));
    assert.equal(p.composer.displayed.value, "Ada");
    due(context);
    await p.player.observe();
    await until(() => action(p)?.ui.kind === "button", "the block", "host");
    await settled();
    assert.equal(p.composer.chatText.value, "", "gone with its question");
    await back(p);
    assert.equal(p.composer.displayed.value, "Ada");
    return end();
  },
);

RERUN.rows(
  "N3 deleted prefill",
  "a prefill the player deleted stays deleted",
  async (context, topology, end) => {
    const p = await page(context, topology, script(BUTTON_BLOCK, PREFILLED));
    type(p.composer, "");
    due(context);
    await p.player.observe();
    await back(p);
    assert.equal(p.composer.displayed.value, "");
    return end();
  },
);

RERUN.rows(
  "N3 occupied, then empty on return",
  "a prefill never fills an occupied chat while its question stays, and fills it empty on its return",
  async (context, topology, end) => {
    const p = await page(context, topology, script('showButton "Go"', BUTTON_BLOCK, PREFILLED));
    type(p.composer, "CHAT");
    p.submission.choose(null);
    await until(() => action(p)?.ui.kind === "text", "the question", "host");
    await settled();
    assert.equal(p.composer.displayed.value, "CHAT", "not filled");
    type(p.composer, "");
    await settled();
    assert.equal(p.composer.displayed.value, "", "not filled while its question stays");
    due(context);
    await p.player.observe();
    await back(p);
    assert.equal(p.composer.displayed.value, "Ada", "filled on its return into an empty chat");
    return end();
  },
);

RERUN.rows(
  "N3 a block's own prefill",
  "a block's question offers its own prefill; the first question's returns after it",
  async (context, topology, end) => {
    const p = await page(
      context,
      topology,
      script('timer async 60 s {\n  let b = askText "B?", prefill: "Bob"\n}', PREFILLED),
    );
    const first = action(p)!.actionId;
    due(context);
    await p.player.observe();
    await until(() => said(p).includes("B?"), "the block's question", "host");
    await settled();
    assert.equal(p.composer.displayed.value, "Bob");
    const record = await sendSettled(p);
    assert.equal(record?.row?.text, "Bob");
    await until(() => action(p)?.actionId === first, "the first question again", "host");
    await settled();
    assert.equal(p.composer.displayed.value, "Ada");
    return end();
  },
);

RERUN.rows(
  "N3 a refusal over a suggestion",
  "a refused text comes back alone: the block's untouched suggestion leaves first",
  async (context, topology, end) => {
    const p = await page(
      context,
      topology,
      script(
        'timer async 60 s {\n  let b = askText "B?", prefill: "Bob"\n}',
        'let name = askText "Name?"',
      ),
    );
    type(p.composer, "SENT");
    due(context);
    const record = await sendSettled(p);
    assert.equal(record?.stage, "settled");
    assert.ok(said(p).includes("B?"), "the block took the screen");
    assert.equal(p.composer.chatText.value, "SENT");
    assert.notEqual(p.submission.notice.value, "");
    assert.equal(
      ops(p, "submitComposer").length,
      0,
      "the observation refused it before it was sent",
    );
    return end();
  },
);

// N4: secrets.

RERUN.rows(
  "N4 password over chat",
  "a half-typed password is gone when a block interrupts it; the chat waits unchanged",
  async (context, topology, end) => {
    const p = await page(
      context,
      topology,
      script('showButton "Go"', SAY_BLOCK, 'let code = askPassword "Code?"'),
    );
    type(p.composer, "CHAT");
    p.submission.choose(null);
    await shows(p, "password");
    assert.equal(p.composer.displayed.value, "");
    type(p.composer, "half");
    due(context);
    await p.player.observe();
    await until(() => said(p).includes("tick"), "the block ran", "host");
    await settled();
    assert.equal(p.composer.tenant.value.kind, "password");
    assert.equal(p.composer.displayed.value, "", "presented anew, empty");
    assert.equal(p.composer.chatText.value, "CHAT");
    return end();
  },
);

RERUN.rows(
  "N4 lock phases",
  "the lock asks twice on one line: a mismatch and Back start again, a match locks; the chat waits",
  async (context, topology, end) => {
    const p = await page(
      context,
      topology,
      script('showButton "Go"', LOCK, 'say "locked", instant'),
    );
    type(p.composer, "CHAT");
    p.submission.choose(null);
    await shows(p, "lock");
    type(p.composer, "one");
    p.submission.send("input");
    assert.equal(p.composer.lockPhase.value, "repeat");
    assert.equal(p.composer.displayed.value, "", "the same line, empty");
    type(p.composer, "two");
    p.submission.send("input");
    assert.equal(p.composer.lockPhase.value, "first", "a mismatch starts again");
    assert.match(p.submission.notice.value, /do not match/);
    assert.equal(p.composer.displayed.value, "");
    type(p.composer, "one");
    p.submission.send("input");
    type(p.composer, "o");
    p.composer.restartLock();
    assert.equal(p.composer.lockPhase.value, "first", "Back starts again");
    assert.equal(p.composer.displayed.value, "");
    await enterLock(p, "one");
    await until(() => said(p).includes("locked"), "the lock went on", "host");
    await settled();
    assert.equal(p.composer.chatText.value, "CHAT");
    return end();
  },
);

RERUN.rows(
  "N4 a retired token",
  "an edit under the token of a field that gave way changes nothing",
  async (context, topology, end) => {
    const p = await page(
      context,
      topology,
      script('showButton "Go"', 'let code = askPassword "Code?"'),
    );
    const chatToken = p.composer.token.value;
    p.submission.choose(null);
    await shows(p, "password");
    p.composer.edit(chatToken, "late");
    assert.equal(p.composer.displayed.value, "");
    assert.equal(p.composer.chatText.value, "");
    return end();
  },
);

RERUN.rows(
  "N4 no slot for a popup",
  "a popup gives the field no slot: an edit then writes nothing, and the chat's text is back unchanged after it",
  async (context, topology, end) => {
    const p = await page(
      context,
      topology,
      script('showButton "Go"', 'showPopup "Hello"', 'let name = askText "Name?"'),
    );
    type(p.composer, "CHAT");
    p.submission.choose(null);
    await shows(p, "none", "the popup's");
    p.composer.edit(p.composer.token.value, "typed at the popup");
    assert.equal(p.composer.chatText.value, "CHAT", "nothing written");
    p.submission.closePopup();
    await shows(p, "chat", "the question after the popup");
    assert.equal(p.composer.displayed.value, "CHAT");
    return end();
  },
);

// N5: a refusal undoes the answer by its origin. The block wins: the answer's own observation runs it first.

RERUN.rows(
  "N5 chat",
  "a refused text comes back before what was typed meanwhile, with the notice",
  async (context, topology, end) => {
    const p = await page(context, topology, script(BUTTON_BLOCK, 'let name = askText "Name?"'));
    type(p.composer, "SENT");
    due(context);
    p.frame.hold();
    p.submission.send("input");
    const record = p.submission.pending.value!;
    assert.equal(record.row?.text, "SENT", "the line shows at once");
    type(p.composer, "TAIL");
    p.submission.send("input");
    assert.equal(
      p.submission.pending.value,
      record,
      "Enter while an answer is pending sends nothing",
    );
    assert.equal(p.composer.chatText.value, "TAIL", "and the text stays");
    p.frame.release();
    await until(() => record.stage === "settled", "the answer settled", "host");
    assert.equal(p.composer.chatText.value, "SENTTAIL");
    assert.equal(p.submission.notice.value, "This interaction is no longer available.");
    assert.equal(p.submission.consumed.value, null);
    return end();
  },
);

RERUN.rows(
  "N5 date",
  "a refused date writes nothing to the chat; its field shows it again on its return",
  async (context, topology, end) => {
    const p = await page(context, topology, script(BUTTON_BLOCK, 'let day = askDate "Day?"'));
    await shows(p, "temporal");
    type(p.composer, "2026-10-04");
    due(context);
    await sendSettled(p);
    assert.equal(p.composer.chatText.value, "", "nothing written to the chat");
    assert.notEqual(p.submission.notice.value, "");
    await until(() => action(p)?.ui.kind === "button", "the block's button", "host");
    p.submission.choose(null);
    await shows(p, "temporal", "the date again");
    assert.equal(p.composer.displayed.value, "2026-10-04");
    return end();
  },
);

RERUN.rows(
  "N5 form submit",
  "a refused Submit keeps the field's text: the form's slot waits while its answer is under way",
  async (context, topology, end) => {
    const p = await page(context, topology, script(BUTTON_BLOCK, NAME_FORM));
    p.forms.stepField("name");
    await shows(p, "form", "the editor");
    p.drafts.held = true;
    type(p.composer, "Bea");
    due(context);
    p.frame.hold();
    p.submission.submitForm();
    assert.equal(p.submission.pending.value?.row?.responseKind, "form");
    await shows(p, "chat", "the chat while the answer is under way");
    p.frame.release();
    await until(() => p.submission.pending.value === null, "refused", "host");
    p.submission.choose(null);
    await shows(p, "form", "the editor again");
    assert.equal(p.composer.displayed.value, "Bea", "the field's own text");
    return end();
  },
);

RERUN.rows(
  "N5 unchecked form submit",
  "a Submit after an unanswered update goes unchecked; the runtime's refusal shows the field again with the notice",
  async (context, topology, end) => {
    const p = await page(context, topology, script(NAME_FORM));
    p.forms.stepField("name");
    await shows(p, "form", "the editor");
    p.connection.hold("draftForm");
    type(p.composer, "");
    await p.connection.held();
    p.submission.submitForm();
    const record = p.submission.pending.value!;
    assert.equal(record.row, null, "no line predicted");
    await shows(p, "chat", "the chat while the answer is under way");
    p.connection.release();
    await until(() => record.stage === "settled", "refused", "host");
    await shows(p, "form", "the field again");
    assert.equal(p.composer.displayed.value, "");
    assert.notEqual(
      p.submission.notice.value,
      "",
      "the notice stays with the field it came back to",
    );
    return end();
  },
);

RERUN.rows(
  "N5 choice",
  "a refused choice shows its buttons again with the notice",
  async (context, topology, end) => {
    const p = await page(context, topology, script(BUTTON_BLOCK, 'let pick = askChoice "A", "B"'));
    due(context);
    p.frame.hold();
    const optionId = playerRuntimeForeground(p.player.session.value!)!;
    assert.equal(optionId.kind, "choose");
    p.submission.choose(optionId.kind === "choose" ? optionId.options[0]!.id : null);
    assert.equal(p.submission.consumed.value, action(p)!.actionId, "its buttons go at once");
    p.frame.release();
    await until(() => p.submission.pending.value === null, "refused", "host");
    assert.equal(p.submission.consumed.value, null);
    assert.notEqual(p.submission.notice.value, "");
    return end();
  },
);

RERUN.rows(
  "N5 password",
  "a refused password writes nothing back: its field is empty and editable again",
  async (context, topology, end) => {
    const p = await page(context, topology, script(BUTTON_BLOCK, 'let code = askPassword "Code?"'));
    await shows(p, "password");
    type(p.composer, "secret");
    due(context);
    await sendSettled(p);
    assert.equal(p.submission.pending.value, null);
    assert.equal(p.composer.chatText.value, "");
    assert.notEqual(p.submission.notice.value, "");
    p.submission.choose(null);
    await shows(p, "password", "the password again");
    assert.equal(p.composer.displayed.value, "");
    return end();
  },
);

RERUN.rows(
  "N5 popup",
  "a refused popup close shows its dialog again",
  async (context, topology, end) => {
    const p = await page(context, topology, script(BUTTON_BLOCK, 'showPopup "Done"'));
    due(context);
    p.frame.hold();
    p.submission.closePopup();
    assert.equal(p.submission.consumed.value, action(p)!.actionId, "the dialog goes at once");
    p.frame.release();
    await until(() => p.submission.pending.value === null, "refused", "host");
    assert.equal(p.submission.consumed.value, null);
    assert.equal(ops(p, "closePopup").length, 0);
    return end();
  },
);

// N6: the local check and the runtime agree, and the predicted line is the runtime's.

const AGREEMENT: readonly {
  readonly ask: string;
  readonly text: string;
  readonly row: string | null;
}[] = [
  { ask: 'let a = askText "A?"', text: "a\r\nb", row: "a\nb" },
  { ask: 'let a = askText "A?"', text: "   ", row: null },
  { ask: 'let a = askNumber "A?"', text: "2.5", row: "2.5" },
  { ask: 'let a = askNumber "A?"', text: "1e3", row: "1e3" },
  { ask: 'let a = askInteger "A?"', text: "+02", row: "+02" },
  { ask: 'let a = askInteger "A?"', text: "2.0", row: null },
  { ask: 'let a = askInteger "A?"', text: "1e3", row: null },
  { ask: 'let a = askChoice "Red", "Blue"', text: "Blue", row: "Blue" },
  { ask: 'let a = askDate "A?"', text: "2026-10-04", row: "2026-10-04" },
];

RERUN.rows(
  "N6 local and runtime agree",
  "each answer the local check takes, the runtime takes with the same line; each it refuses, the runtime refuses",
  async (context, topology, end) => {
    for (const { ask, text, row } of AGREEMENT) {
      const p = await page(context, topology, script(ask));
      type(p.composer, text);
      const id = action(p)!.actionId;
      const record = await sendSettled(p);
      if (row === null && record === null) {
        assert.notEqual(
          p.submission.notice.value,
          "",
          `${ask} ${JSON.stringify(text)}: refused at once`,
        );
        const runtime = await p.submission.run(id, intents.composer(text, "enter"));
        assert.equal(runtime.kind, "answered");
        assert.equal(
          runtime.kind === "answered" && runtime.outcome.kind,
          "invalidPayload",
          `${ask} ${text}`,
        );
        continue;
      }
      assert.ok(record, `${ask} ${JSON.stringify(text)}: taken`);
      const canonical = said(p).at(-1);
      if (record.row !== null) assert.equal(record.row.text, canonical, `${ask}: the same line`);
      if (row !== null) assert.equal(canonical, row, `${ask} ${JSON.stringify(text)}`);
      assert.equal(p.submission.pending.value, null);
      p.scope.stop();
    }
    // A password has no line, and its completion releases it.
    const p = await page(
      context,
      topology,
      script('let code = askPassword "Code?"', 'let a = askText "A?"'),
    );
    type(p.composer, "secret");
    const record = await sendSettled(p);
    assert.equal(record?.row, null);
    assert.equal(p.submission.pending.value, null);
    return end();
  },
);

RERUN.rows(
  "N6 a continuation of more than 64 rows",
  "the answer's runtime row takes its row over also when the answer's continuation adds more than 64 rows at once",
  async (context, topology, end) => {
    const p = await page(
      context,
      topology,
      script(
        'let go = askText "Go?"',
        'repeat 100 {\n    say "A line of the continuation.", instant\n}',
        'let next = askChoice "On"',
      ),
    );
    const list = modules.displayedList();
    // Each publication while the answer is pending, listed as `Transcript` lists it. The adapter appends to one entries
    // array, so each publication is a new session, not a new array, and its listing is copied as it was then.
    const shown: (readonly PlayerTranscriptEntryPresentation[])[] = [];
    const stop = watch(
      () => p.player.session.value,
      (session) => {
        const pending = p.submission.predicted.value;
        if (session && pending) shown.push([...list(session.transcriptEntries, pending)]);
      },
      { flush: "sync" },
    );
    context.after(stop);
    type(p.composer, "Go");
    p.submission.send("input");
    const record = p.submission.pending.value!;
    const answer = record.entry!;
    assert.equal(answer.kind, "message", "the answer has a predicted row");
    await until(() => record.stage === "settled", "settled", "host");
    const arrived = shown.filter((rows) =>
      rows.some((row) => row !== answer && modules.rowKey(row) === modules.rowKey(answer)),
    );
    assert.ok(
      arrived.length > 0,
      "a publication with the runtime's row while the answer was pending",
    );
    for (const rows of arrived) {
      assert.equal(
        new Set(rows.map(modules.rowKey)).size,
        rows.length,
        "one row per key: the pending row is not listed beside its runtime row",
      );
      assert.ok(!rows.includes(answer), "the runtime's row replaced the pending one");
    }
    assert.ok(
      p.player.session.value!.transcriptEntries.length > 64 + 1,
      "the continuation is longer than 64 rows",
    );
    return end();
  },
);

RERUN.rows(
  "N6 the predicted line is the runtime's",
  "the line shown before the reply is the runtime's own: its row key, text, style, kind and form lines",
  async (context, topology, end) => {
    const p = await page(
      context,
      topology,
      script(
        'player.color = "#777777"',
        'let pick = askChoice "Red", "Blue"',
        "let answers = askForm fields: {",
        '  pace: { text: "Pace", options: [{ value: 1, text: "Slow" }, { value: 1, text: "Fast" }] }, rope: true',
        "}",
      ),
    );
    // The style the player's answer has now is published with the session: plain data, kept in no checkpoint.
    const presentation = p.player.session.value!.state.answerPresentation;
    assert.equal(presentation.color, normalizeColor("#777777"));
    assert.deepEqual(JSON.parse(JSON.stringify(presentation)), presentation);
    const checkpoint = await checkpointSnapshot(p.connection.bridge, p.player.session.value!);
    assert.ok(!JSON.stringify(checkpoint).includes("answerPresentation"));
    const answers: (() => void)[] = [
      () => {
        type(p.composer, "Blue");
        p.submission.send("input");
      },
      () => p.submission.submitForm(),
    ];
    for (const answer of answers) {
      await until(
        () => p.forms.unacknowledged(action(p)!.actionId) === 0,
        "no update unanswered",
        "host",
      );
      if (
        action(p)?.ui.kind === "form" &&
        playerRuntimeForm(p.player.session.value!)?.fields[0]?.state === "Slow"
      ) {
        p.forms.stepField("pace");
        await until(
          () => p.forms.unacknowledged(action(p)!.actionId) === 0,
          "the step answered",
          "host",
        );
      }
      answer();
      const record = p.submission.pending.value!;
      const predicted = record.entry!;
      assert.equal(predicted.kind, "message");
      await until(() => record.stage === "settled", "settled", "host");
      const canonical = p.player.session.value!.transcriptEntries.find(
        (entry) => entry.kind === "message" && entry.renderKey === predicted.renderKey,
      );
      assert.ok(
        canonical?.kind === "message" && predicted.kind === "message",
        "the runtime's row has its key",
      );
      assert.deepEqual(
        [predicted.text, predicted.presentation, predicted.responseKind, predicted.formSummary],
        [canonical.text, canonical.presentation, canonical.responseKind, canonical.formSummary],
      );
    }
    return end();
  },
);

// N7: Enter in a typed form field: its field stays, read-only, until the form took the commit.

RERUN.rows(
  "N7 commit",
  "a commit holds its field until the form took it; Enter meanwhile sends nothing; then the editor closes",
  async (context, topology, end) => {
    const p = await page(context, topology, script(NAME_FORM));
    p.forms.stepField("name");
    await shows(p, "form", "the editor");
    p.drafts.held = true;
    type(p.composer, "Bea");
    p.connection.hold("submitComposer");
    p.submission.send("input");
    assert.ok(p.forms.commitWindow.value, "the commit's window");
    assert.equal(p.composer.tenant.value.kind, "form", "the field stays");
    await p.connection.held();
    p.submission.send("input");
    p.connection.release();
    await until(() => p.forms.commitWindow.value === null, "the window ends", "host");
    await shows(p, "chat", "the field closed");
    assert.equal(ops(p, "submitComposer").length, 1, "Enter in the window sent nothing");
    assert.deepEqual(p.composer.closedField(), { actionId: action(p)!.actionId, fieldId: "name" });
    assert.equal(playerRuntimeForm(p.player.session.value!)?.fields[0]?.state, "Bea");
    return end();
  },
);

RERUN.rows(
  "N7 refused commit",
  "a commit a block refused ends its window; the field keeps its text and shows it again on its return",
  async (context, topology, end) => {
    const p = await page(context, topology, script(BUTTON_BLOCK, NAME_FORM));
    p.forms.stepField("name");
    await shows(p, "form", "the editor");
    p.drafts.held = true;
    type(p.composer, "Bea");
    due(context);
    p.submission.send("input");
    await until(() => p.forms.commitWindow.value === null, "the window ends", "host");
    assert.notEqual(p.submission.notice.value, "");
    await until(() => action(p)?.ui.kind === "button", "the block", "host");
    p.submission.choose(null);
    await shows(p, "form", "the field again");
    assert.equal(p.composer.displayed.value, "Bea");
    return end();
  },
);

RERUN.rows(
  "N7 a block that returns at once",
  "a block that returns within the commit's observation leaves the commit to succeed",
  async (context, topology, end) => {
    const p = await page(context, topology, script(SAY_BLOCK, NAME_FORM));
    p.forms.stepField("name");
    await shows(p, "form", "the editor");
    p.drafts.held = true;
    type(p.composer, "Bea");
    due(context);
    p.submission.send("input");
    await until(() => p.forms.commitWindow.value === null, "the window ends", "host");
    await shows(p, "chat", "the field closed");
    assert.ok(said(p).includes("tick"));
    assert.equal(p.submission.notice.value, "");
    assert.equal(playerRuntimeForm(p.player.session.value!)?.fields[0]?.state, "Bea");
    return end();
  },
);

RERUN.rows(
  "N7 a lock inside the window",
  "a lock that refuses a commit takes the field; the form's field returns with its text, and no button takes focus",
  async (context, topology, end) => {
    const p = await page(context, topology, script(LOCK_BLOCK, NAME_FORM));
    p.forms.stepField("name");
    await shows(p, "form", "the editor");
    p.drafts.held = true;
    type(p.composer, "Bea");
    due(context);
    p.submission.send("input");
    await until(() => p.forms.commitWindow.value === null, "the window ends", "host");
    await enterLock(p, "pw");
    await shows(p, "form", "the field again");
    assert.equal(p.composer.displayed.value, "Bea");
    return end();
  },
);

// N8: an answer without a line, then the next answer.

RERUN.rows(
  "N8 rowless, then an answer",
  "a password, a popup, an export and a URL each settle without a line, and the next question takes its answer",
  async (context, topology, end) => {
    const p = await page(
      context,
      topology,
      script(
        'let code = askPassword "Code?"',
        'let a = askText "A?"',
        'showPopup "Done"',
        'let b = askText "B?"',
        'exportText("Plain")',
        'let c = askText "C?"',
        'openUrl("https://example.com")',
        'let d = askText "D?"',
      ),
    );
    const opened: string[] = [];
    for (const [origin, answer] of [
      ["password", () => (type(p.composer, "secret"), p.submission.send("input"))],
      ["popup", () => p.submission.closePopup()],
      ["export", () => p.submission.closeExport()],
      ["url", () => p.submission.openUrl(() => (opened.push("tab"), true), false)],
    ] as const) {
      await until(() => action(p)?.ui.kind === origin, `the ${origin}`, "host");
      await settled();
      answer();
      const record = p.submission.pending.value!;
      assert.equal(record.origin, origin);
      assert.equal(record.row, null, `${origin}: no line`);
      await until(() => record.stage === "settled", `${origin} settled`, "host");
      await until(() => action(p)?.ui.kind === "text", "the next question", "host");
      await settled();
      type(p.composer, origin);
      const next = await sendSettled(p);
      assert.equal(next?.row?.text, origin);
      assert.equal(said(p).at(-1), origin);
    }
    assert.deepEqual(opened, ["tab"]);
    return end();
  },
);

RERUN.rows(
  "N8 automatic URL after an answer",
  "an automatic URL presented while the answer that led to it is pending waits for it, then opens once",
  async (context, topology, end) => {
    const p = await page(
      context,
      topology,
      script('let a = askText "A?"', 'openUrl("https://example.com")', 'let b = askText "B?"'),
    );
    const opened: string[] = [];
    const open = () => (opened.push("tab"), true);
    p.submission.urlOpener(open);
    // As `RuntimeInteraction`'s watcher: the publication presents the URL before the answer's promise returns.
    let pendingAtRequest: boolean | null = null;
    p.scope.run(() =>
      watch(
        () => p.player.session.value && playerRuntimeForeground(p.player.session.value)?.kind,
        (kind) => {
          if (kind !== "open-url" || pendingAtRequest !== null) return;
          pendingAtRequest = p.submission.pending.value !== null;
          p.submission.openUrl(open, true);
        },
        { flush: "sync" },
      ),
    );
    type(p.composer, "a");
    await sendSettled(p);
    await until(
      () => action(p)?.ui.kind === "text" && said(p).at(-1) === "B?",
      "the next question",
      "host",
    );
    assert.equal(pendingAtRequest, true, "the URL came while the answer was pending");
    assert.deepEqual(opened, ["tab"], "opened once, after the answer settled");
    assert.equal(ops(p, "openUrl").length, 1);
    return end();
  },
);

RERUN.rows(
  "N8 blocked automatic tab",
  "a blocked automatic tab keeps the URL's button, and is not tried again by itself",
  async (context, topology, end) => {
    const p = await page(context, topology, script('openUrl("https://example.com")'));
    let tries = 0;
    const blocked = () => (tries++, false);
    p.submission.openUrl(blocked, true);
    const record = p.submission.pending.value!;
    await until(() => record.stage === "settled", "settled", "host");
    assert.equal(p.submission.consumed.value, null, "its button shows again");
    assert.equal(action(p)?.ui.kind, "url");
    p.submission.openUrl(blocked, true);
    assert.equal(p.submission.pending.value, null, "not tried again by itself");
    assert.equal(tries, 1);
    return end();
  },
);

const URL_BLOCK = 'timer async 60 s {\n  openUrl("https://example.com/block")\n}';

/**
 * Sends `SENT` with its painted frame held, then lets the block's URL take the screen and asks for it at once, as
 * `RuntimeInteraction`'s watcher does: it waits behind the pending answer. Returns that answer and the tabs opened.
 */
async function waitBehindAnswer(context: TestContext, p: Page) {
  const opened: string[] = [];
  const open = () => (opened.push("tab"), true);
  p.submission.urlOpener(open);
  p.frame.hold();
  type(p.composer, "SENT");
  p.submission.send("input");
  const answer = p.submission.pending.value!;
  due(context);
  await p.player.observe();
  assert.equal(action(p)?.ui.kind, "url");
  p.submission.openUrl(open, true);
  assert.equal(p.submission.pending.value, answer, "the URL waits");
  return { answer, opened };
}

RERUN.rows(
  "N8 a waiting URL crosses a Start",
  "a URL waiting behind an answer is not admitted in the next chat, even for an action with its number",
  async (context, topology, end) => {
    const p = await page(context, topology, script(URL_BLOCK, 'let a = askText "A?"'));
    const { answer, opened } = await waitBehindAnswer(context, p);
    const waited = action(p)!.actionId;
    // Another Start whose own URL has the same number, one the Player never opens by itself.
    const timers = Array.from(
      { length: waited - 1 },
      () => 'timer async 600 s {\n  say "later", instant\n}',
    );
    const other = await sourceStart(
      p.player.bridge,
      [...timers, 'openUrl("https://example.com/new", alwaysButton: true)', "exit"].join("\n"),
      () => ({ wallClockMs: 0 }),
    );
    p.player.prepare(other);
    await p.player.activate();
    await until(() => answer.stage === "settled", "the answer dropped", "host");
    assert.equal(action(p)?.actionId, waited, "the same number");
    p.submission.openUrl(() => (opened.push("own"), true), true);
    assert.equal(p.submission.pending.value, null, "its own URL is never opened by itself");
    p.frame.release();
    await settled();
    assert.equal(p.submission.pending.value, null);
    assert.deepEqual(opened, []);
    assert.equal(ops(p, "openUrl").length, 0);
    return end();
  },
);

RERUN.rows(
  "N8 an unmount while a URL waits",
  "an unmount drops the answer and the URL waiting behind it, and admits nothing",
  async (context, topology, end) => {
    const p = await page(context, topology, script(URL_BLOCK, 'let a = askText "A?"'));
    const { answer, opened } = await waitBehindAnswer(context, p);
    p.scope.stop();
    assert.equal(answer.stage, "settled");
    assert.equal(p.submission.pending.value, null, "nothing admitted");
    p.frame.release();
    await settled();
    assert.equal(p.submission.pending.value, null);
    assert.deepEqual(opened, []);
    return end();
  },
);

RERUN.rows(
  "N8 a URL behind a refused answer",
  "a URL that took the screen from the answer it waited behind opens once by its own right when that answer is refused",
  async (context, topology, end) => {
    const p = await page(context, topology, script(URL_BLOCK, 'let a = askText "A?"'));
    const { answer, opened } = await waitBehindAnswer(context, p);
    p.frame.release();
    await until(() => answer.stage === "settled", "the answer refused", "host");
    assert.equal(p.composer.chatText.value, "SENT", "undone");
    await until(() => p.submission.pending.value === null, "the URL settled", "host");
    assert.deepEqual(opened, ["tab"]);
    assert.equal(ops(p, "openUrl").length, 1);
    return end();
  },
);

RERUN.rows(
  "N8 a URL behind a lost answer",
  "a URL waiting behind an answer the connection's loss undid is not admitted",
  async (context, topology, end) => {
    const p = await page(context, topology, script(URL_BLOCK, 'let a = askText "A?"'));
    const { answer, opened } = await waitBehindAnswer(context, p);
    await p.connection.lose();
    await until(() => answer.stage === "settled", "the answer undone", "host");
    assert.equal(p.composer.chatText.value, "SENT");
    assert.equal(p.submission.pending.value, null, "nothing admitted");
    p.frame.release();
    await settled();
    assert.deepEqual(opened, []);
    return end();
  },
);

// N9: a year-0000 default is edited as ISO text in the date's own slot.

RERUN.rows(
  "N9 year 0000",
  "a year-0000 date or datetime is edited as text in its own slot, across a block, and answered",
  async (context, topology, end) => {
    for (const [ask, prefill, edited] of [
      ['let day = askDate prefill: toDate("0000-01-02")', "0000-01-02", "0000-02-03"],
      [
        'let when = askDateTime prefill: toDateTime("0000-01-02T03:04")',
        "0000-01-02T03:04",
        "0000-02-03T04:05",
      ],
    ] as const) {
      const p = await page(context, topology, script('showButton "Go"', BUTTON_BLOCK, ask));
      type(p.composer, "CHAT");
      p.submission.choose(null);
      await shows(p, "temporal", "the date's slot");
      assert.equal(p.composer.displayed.value, prefill);
      type(p.composer, edited);
      due(context);
      await p.player.observe();
      await shows(p, "chat", "the block");
      assert.equal(p.composer.displayed.value, "CHAT", "the chat, unchanged");
      p.submission.choose(null);
      await shows(p, "temporal", "the date again");
      assert.equal(p.composer.displayed.value, edited, "the edited value, not its default");
      const record = await sendSettled(p);
      assert.equal(record?.row?.text, said(p).at(-1));
      assert.equal(p.composer.chatText.value, "CHAT");
      p.scope.stop();
      context.mock.restoreAll();
    }
    return end();
  },
);

// N11 and N12: form updates go in order and are no answers.

const TOGGLE_FORM = 'let answers = askForm fields: { rope: false }\nsay "${answers.rope}", instant';

RERUN.rows(
  "N11 two quick toggles",
  "two quick clicks of a toggle both apply, in order",
  async (context, topology, end) => {
    const p = await page(context, topology, script(TOGGLE_FORM));
    const id = action(p)!.actionId;
    p.forms.stepField("rope");
    p.forms.stepField("rope");
    assert.equal(p.forms.unacknowledged(id), 2);
    await until(() => p.forms.unacknowledged(id) === 0, "both answered", "host");
    assert.equal(ops(p, "stepFormField").length, 2);
    assert.equal(playerRuntimeForm(p.player.session.value!)?.fields[0]?.pressed, false);
    assert.equal(p.submission.notice.value, "");
    return end();
  },
);

RERUN.rows(
  "N12 a toggle, then Submit",
  "Submit right after a toggle predicts no line; the runtime's summary shows the toggle",
  async (context, topology, end) => {
    const p = await page(context, topology, script(TOGGLE_FORM));
    p.forms.stepField("rope");
    p.submission.submitForm();
    const record = p.submission.pending.value!;
    assert.equal(record.row, null);
    await until(() => record.stage === "settled", "settled", "host");
    assert.ok(said(p).includes("true"), "the toggle applied before the Submit");
    return end();
  },
);

// The notice (HEAD 0 r2 section 5): an edit, another field and another chat clear it, as its timer does.

RERUN.rows(
  "notice clearers",
  "the notice goes with an edit of the field, another field, another chat, and its timer",
  async (context, topology, end) => {
    const p = await page(
      context,
      topology,
      script('let n = askInteger "N?"', 'let day = askDate "Day?"'),
    );
    type(p.composer, "x");
    p.submission.send("input");
    assert.notEqual(p.submission.notice.value, "", "refused at once");
    assert.equal(p.composer.chatText.value, "x", "the text stays");
    type(p.composer, "xy");
    assert.equal(p.submission.notice.value, "", "an edit clears it");
    p.submission.send("input");
    assert.notEqual(p.submission.notice.value, "");
    type(p.composer, "4");
    p.connection.hold("submitComposer");
    p.submission.send("input");
    await p.connection.held();
    p.submission.showNotice("shown");
    p.connection.release();
    // The answer published the next question; its field is another slot.
    await shows(p, "temporal", "the date's field");
    assert.equal(p.submission.notice.value, "", "another field clears it");
    p.submission.showNotice("shown");
    p.player.prepare(
      await sourceStart(p.player.bridge, script('let a = askText "A?"'), () => ({
        wallClockMs: 0,
      })),
    );
    await p.player.activate();
    await shows(p, "chat", "another chat");
    assert.equal(p.submission.notice.value, "", "another chat clears it");
    context.mock.timers.enable({ apis: ["setTimeout"] });
    p.submission.showNotice("shown");
    context.mock.timers.tick(5_999);
    assert.equal(p.submission.notice.value, "shown");
    context.mock.timers.tick(1);
    assert.equal(p.submission.notice.value, "", "its timer clears it");
    context.mock.timers.reset();
    return end();
  },
);
