import assert from "node:assert/strict";
import test, { before, type TestContext } from "node:test";
import { watch, type Ref } from "vue";
import { createPlayerRuntimeSession } from "../../player/runtime/compile-project.js";
import type { ScriptStorageProvider } from "../../player/persistence/script-storage.js";
import type { SerializableRuntimeValue } from "../../src/index.js";
import { coverageGaps, type Coordinates } from "../helpers/family-coverage.js";
import {
  ASKS,
  ASKS_OTHER,
  browser,
  mount,
  page,
  prepareAgain,
  prepareOn,
  SCOPE,
  stubBrowser,
  tasks,
  until,
  type KeepHost,
} from "../helpers/player/keep-host.js";
import {
  backTo,
  choose,
  chooseAt,
  createHost,
  memoryStorage,
  reportsInto,
  settle,
  start,
} from "../helpers/player/rewind-host.js";
import { readForImport } from "../helpers/player/transfer-read.js";
import { hostIntroduced, loadHostFacade } from "../helpers/player/host-sessions.js";

/*
 * The saved data's revision (`savedDataRevision`, `player/vue/src/session/persistence/useSavedValues.ts`) through the
 * real composable: it moves once each change this Player made to the shown route's values has resolved, whether or not
 * the work that issued it still owns the page, and never for a failed change. Debug's Storage tab re-reads the saved
 * values at each move (`DebugStorage.vue`); the tab here does the same, and every row asserts that it shows what is
 * stored. Each change is held until the work that issued it was overtaken (or was not, `owned`), over a store that
 * runs its operations in issue order, as the Player's provider does (`captured-media-persistence.ts`).
 *
 * The revision's moves, by row: a change moves it once; an owned import or session transfer moves it again at its
 * commit, whose fresh read takes in values another tab may have changed (`applyScriptStorage`); an owned adoption's
 * answer saves once more as the session runs on.
 */

before(loadHostFacade);

const MEMBERS = {
  "adoption replace": ["owned", "Continue", "loss", "host error", "failed"],
  "script write": ["owned", "Continue"],
  "saved-data import replace": ["owned", "retired"],
  "session import replace": ["owned", "retired"],
} as const;
type Member = keyof typeof MEMBERS;
type Outcome = (typeof MEMBERS)[Member][number];

/** How often the revision moves in each row, from its change's hold on (see the header). */
function expectedMoves(member: Member, outcome: Outcome): number {
  if (outcome === "failed") return 0;
  if (outcome !== "owned") return 1;
  return member === "script write" ? 1 : 2;
}

/** Debug's Storage tab: the saved values as last read, read at mount and again at each move of the revision. */
function storageTab(
  context: TestContext,
  host: {
    readonly savedDataRevision: Readonly<Ref<number>>;
    readSavedData(): Promise<readonly { readonly key: string; readonly value?: unknown }[]>;
  },
) {
  let shown: unknown = null;
  const read = async () => {
    shown = await host
      .readSavedData()
      .then((entries) => Object.fromEntries(entries.map((entry) => [entry.key, entry.value])))
      .catch(() => "unavailable");
  };
  const stop = watch(host.savedDataRevision, read);
  context.after(stop);
  return { read, shown: () => shown };
}

/** `provider` with its operations run in issue order, as the Player's provider runs them. */
function ordered(provider: ScriptStorageProvider): ScriptStorageProvider {
  let queue: Promise<unknown> = Promise.resolve();
  const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
    const next = queue.then(operation, operation);
    queue = next.catch(() => {});
    return next;
  };
  return {
    scope: provider.scope,
    load: () => enqueue(() => provider.load()),
    write: (key, value) => enqueue(() => provider.write(key, value)),
    replace: (entries) => enqueue(() => provider.replace(entries)),
    clear: () => enqueue(() => provider.clear()),
  };
}

/** Saved values of `scope` in memory, in issue order, whose next replacement can be held. */
function heldStore(scope: string, seed: Readonly<Record<string, SerializableRuntimeValue>>) {
  const entries = new Map<string, SerializableRuntimeValue>(Object.entries(seed));
  let hold: { gate: Promise<void>; reached: boolean } | null = null;
  const raw: ScriptStorageProvider = {
    scope,
    load: async () => [...entries].map(([key, value]) => ({ key, value })),
    write: async (key, value) => {
      if (value === null) entries.delete(key);
      else entries.set(key, value);
    },
    replace: async (replacement) => {
      const held = hold;
      hold = null;
      if (held !== null) {
        held.reached = true;
        await held.gate;
      }
      entries.clear();
      for (const entry of replacement) entries.set(entry.key, entry.value);
    },
    clear: async () => entries.clear(),
  };
  return {
    provider: ordered(raw),
    saved: () => Object.fromEntries(entries),
    set: (key: string, value: SerializableRuntimeValue) => void entries.set(key, value),
    /** Holds the next replacement until `release`; `reached` says whether it arrived. */
    holdNextReplace() {
      let release!: () => void;
      const held = { gate: new Promise<void>((resolve) => (release = resolve)), reached: false };
      hold = held;
      return { release: () => release(), reached: () => held.reached };
    },
  };
}

/** A row's record: what the tab shows against what is stored, and how often the revision moved. */
interface RowRecord {
  readonly tab: unknown;
  readonly stored: unknown;
  readonly moves: number;
}

/** A rewind adoption whose replacement is held while the page moves on as `outcome` says. */
async function adoption(context: TestContext, outcome: Outcome): Promise<RowRecord> {
  reportsInto(context, []);
  const storage = memoryStorage();
  if (outcome === "failed") storage.failNextReplace();
  const made = createHost(context, ordered(storage.provider), { lossy: outcome === "loss" });
  const { host, rewind } = made;
  const revisioned = host;
  await start(context, host);
  await choose(context, host, "One");
  await choose(context, host, "Red");
  const tab = storageTab(context, revisioned);
  await tab.read();
  assert.equal(await backTo(rewind, 0), true);
  await settle(context);
  const release = storage.holdReplaces();
  const from = revisioned.savedDataRevision.value;
  const chosen = chooseAt(host, 1);
  await settle(context);
  assert.ok(release.reached(), "the adoption's replacement is held");
  if (outcome === "Continue") {
    // A kept session at an ask, which writes nothing as it continues.
    host.prepareRestore(
      hostIntroduced(
        await host.bridge,
        createPlayerRuntimeSession('let x = askChoice "X", "Y"\nexit', host.scriptStorageOptions()),
      ),
    );
    host.activate();
  } else if (outcome === "loss") made.lose!();
  else if (outcome === "host error") host.reportHostError(new Error("A host failure meanwhile."));
  await settle(context);
  release();
  await chosen;
  for (let round = 0; round < 3; round += 1) await settle(context);
  return {
    tab: tab.shown(),
    stored: storage.saved(),
    moves: revisioned.savedDataRevision.value - from,
  };
}

/** A script's save whose write is held while the page moves on as `outcome` says. */
async function scriptWrite(context: TestContext, outcome: Outcome): Promise<RowRecord> {
  const storage = memoryStorage();
  const { host } = createHost(context, ordered(storage.provider));
  const revisioned = host;
  await start(context, host);
  const tab = storageTab(context, revisioned);
  await tab.read();
  const release = storage.holdWrites();
  const chosen = chooseAt(host, 0);
  await settle(context);
  const from = revisioned.savedDataRevision.value;
  if (outcome === "Continue") {
    host.prepareRestore(
      hostIntroduced(
        await host.bridge,
        createPlayerRuntimeSession('let x = askChoice "X", "Y"\nexit', host.scriptStorageOptions()),
      ),
    );
    host.activate();
    await settle(context);
  }
  release();
  await chosen;
  for (let round = 0; round < 3; round += 1) await settle(context);
  return {
    tab: tab.shown(),
    stored: storage.saved(),
    moves: revisioned.savedDataRevision.value - from,
  };
}

/**
 * An import of the shown script's saved data, or of a session, whose replacement is held while the page prepares
 * another script, which retires the import (`retired`), or does not (`owned`).
 */
async function importing(
  context: TestContext,
  member: "saved-data import replace" | "session import replace",
  outcome: Outcome,
): Promise<RowRecord> {
  stubBrowser(context);
  const store = heldStore(SCOPE, { seed: 1 });
  const at = { ...browser(), provider: store.provider };
  let begin: () => Promise<void>;
  let host: KeepHost;
  if (member === "saved-data import replace") {
    ({ host } = await mount(context, at));
    await prepareOn(host, ASKS);
    const review = await host.reviewSavedDataImport({
      scripts: [{ scope: SCOPE, name: null, photos: [], entries: [{ key: "score", value: 3 }] }],
      images: [],
    });
    const shown = host;
    begin = () => shown.importSavedData(review, new Set([SCOPE]));
  } else {
    // The session exported from a first page, with the values it read; the second page reads another value since.
    const first = await page(context, at, ASKS);
    await first.host.activate();
    await until(() => first.host.session.value !== null, "the first page's session did not start");
    const { transfer } = await first.host.exportSession();
    first.scope.stop();
    await tasks();
    store.set("later", 2);
    ({ host } = await page(context, at, ASKS));
    const review = await host.reviewSessionImport(await readForImport(host, transfer));
    const shown = host;
    begin = () => shown.importSession(review);
  }
  const tab = storageTab(context, host);
  await tab.read();
  const hold = store.holdNextReplace();
  const from = host.savedDataRevision.value;
  const imported = begin().catch(() => {});
  await until(hold.reached, "the import's replacement is not held");
  if (outcome === "retired") await prepareAgain(host, ASKS_OTHER);
  hold.release();
  await imported;
  await tasks();
  await tasks();
  return { tab: tab.shown(), stored: store.saved(), moves: host.savedDataRevision.value - from };
}

// Each member with each of its outcomes, from the declaration above.
const FEASIBLE: Coordinates[] = Object.entries(MEMBERS).flatMap(([member, outcomes]) =>
  outcomes.map((outcome) => ({ member, outcome })),
);

const completed: Coordinates[] = [];
for (const coordinates of FEASIBLE) {
  // EVIDENCE: invariant: `FEASIBLE` holds `MEMBERS`' keys and their own outcomes.
  const { member, outcome } = coordinates as { member: Member; outcome: Outcome };
  test(`the saved data's revision: ${member}, ${outcome}`, async (context) => {
    const record =
      member === "adoption replace"
        ? await adoption(context, outcome)
        : member === "script write"
          ? await scriptWrite(context, outcome)
          : await importing(context, member, outcome);
    assert.deepEqual(record.tab, record.stored, "Debug's Storage tab shows what is stored");
    assert.equal(record.moves, expectedMoves(member, outcome), "the revision's moves");
    completed.push(coordinates);
  });
}

test("the saved data's revision family ran every member's outcomes, and nothing else", () => {
  assert.deepEqual(coverageGaps(FEASIBLE, completed, { tuples: true }), []);
  assert.equal(FEASIBLE.length, 11);
});

// Nothing after the Player's unmount moves the revision: a Start whose read of the saved values completes after it.
test("the saved data's revision: a Start read that completes after unmount moves nothing", async (context) => {
  stubBrowser(context);
  const at = browser();
  let holdNext = false;
  let reached = false;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const provider: ScriptStorageProvider = {
    ...at.provider,
    load: async () => {
      if (holdNext) {
        holdNext = false;
        reached = true;
        await gate;
      }
      return [];
    },
  };
  const { host, scope } = await page(context, { ...at, provider }, ASKS);
  const before = host.savedDataRevision.value;
  holdNext = true;
  const activating = host.activate();
  await until(() => reached, "the Start's read is not held");
  scope.stop();
  release();
  await activating;
  await tasks();
  assert.equal(host.session.value, null, "the unmounted Start began no session");
  assert.equal(host.savedDataRevision.value, before, "the revision did not move");
});
