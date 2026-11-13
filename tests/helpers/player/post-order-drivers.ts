import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import { effectScope, type Ref } from "vue";
import type { PlayerBridge } from "../../../player/runtime/player-bridge.js";
import {
  playerRuntimeForeground,
  type PlayerSession,
} from "../../../player/runtime/runtime-view.js";
import type { KeptSessionStore } from "../../../player/persistence/kept-sessions.js";
import type { ScriptStorageProvider } from "../../../player/persistence/script-storage.js";
import { loadPlayerModule } from "../player-modules.js";
import { sourceStart, type PlanStart } from "../prepared-plan.js";
import { browser, stubBrowser } from "./keep-host.js";
import { presentedAction, runtimeInput } from "./player-input.js";
import { loadTopology, topologyBridge, until, type TopologyBridge } from "./worker-topology.js";

/*
 * Named drivers of the real composable on the in-process host, each giving every request it posted in order (the
 * topology helper's post log): the production post order L5i.7's O1 compares base against head, and whose Start and
 * Continue lists `player-post-order.test.ts` keeps.
 */

/** The composable, as far as the drivers go. */
interface DriverPlayer {
  readonly session: Readonly<Ref<PlayerSession | null>>;
  readonly activation: Readonly<Ref<"start" | "continue" | null>>;
  readonly hostError: Readonly<Ref<string | null>>;
  readonly bridge: Promise<PlayerBridge>;
  readonly inputSection: unknown;
  loadScriptStorage(): Promise<void>;
  scriptStorageOptions(): object;
  prepare(create: PlanStart): void;
  activate(): Promise<void>;
}
interface DriverRewind {
  readonly state: Readonly<
    Ref<{ readonly points: readonly { readonly id: number }[]; readonly inspection: object | null }>
  >;
  back(point: number): Promise<boolean>;
  returnToSession(): Promise<boolean>;
}
let usePlayerSession: (options: {
  readonly bridge: Promise<PlayerBridge>;
  readonly scriptStorage: ScriptStorageProvider;
  readonly keptSessions: KeptSessionStore;
  readonly capturedMedia: { readonly repository: ReturnType<typeof browser>["repository"] };
}) => DriverPlayer;
let usePlayerDebug: (
  player: DriverPlayer,
  initial: { readonly menu: boolean; readonly autoSkip: boolean },
) => { readonly rewind: Readonly<Ref<DriverRewind | null>> };
let prepareHostedScript: (
  player: DriverPlayer,
  host: { load(): Promise<{ readonly project: string }> },
) => { readonly failure: Readonly<Ref<object | null>> };

/** Loads the bundle's composables: call it in a `before` hook. */
export async function loadDrivers(): Promise<void> {
  await loadTopology();
  const session = await loadPlayerModule("player/vue/src/session/usePlayerSession.ts");
  const debug = await loadPlayerModule("player/vue/src/debug/usePlayerDebug.ts");
  const hosted = await loadPlayerModule("player/vue/src/hostedScript.ts");
  assert.equal(typeof session.usePlayerSession, "function");
  assert.equal(typeof debug.usePlayerDebug, "function");
  assert.equal(typeof hosted.prepareHostedScript, "function");
  // EVIDENCE: validation: checked as functions above; Vite loaded the real source modules, and these are their APIs.
  usePlayerSession = session.usePlayerSession as typeof usePlayerSession;
  // EVIDENCE: validation: as above.
  usePlayerDebug = debug.usePlayerDebug as typeof usePlayerDebug;
  // EVIDENCE: validation: as above.
  prepareHostedScript = hosted.prepareHostedScript as typeof prepareHostedScript;
}

/** Two choices, the transcript between them. */
const SCRIPT = [
  'let first = askChoice "One", "Two"',
  'say "first ${first}", instant',
  'let second = askChoice "Red", "Blue"',
  "exit",
].join("\n");

/** One post as the drivers compare it: its op and the session it names. */
export type PostEntry = readonly [op: string, session: string | null];

/** A page of `at` on a new Worker, with Debug on (`usePlayerDebug`, both switches) when `debug`. */
async function page(context: TestContext, at: ReturnType<typeof browser>, debug: boolean) {
  const transport = await topologyBridge(context, "worker");
  const scope = effectScope();
  const player = scope.run(() =>
    usePlayerSession({
      bridge: Promise.resolve(transport.bridge),
      scriptStorage: at.provider,
      keptSessions: at.kept,
      capturedMedia: { repository: at.repository },
    }),
  )!;
  const debugScope = effectScope();
  const features = debug
    ? debugScope.run(() => usePlayerDebug(player, { menu: true, autoSkip: false }))!
    : null;
  const close = () => {
    debugScope.stop();
    scope.stop();
  };
  context.after(() => close());
  await player.bridge;
  await player.loadScriptStorage();
  return { player, transport, close, rewind: () => features!.rewind.value! };
}

/** Waits until `transport` has posted nothing for ten short turns. */
async function quiet(transport: TopologyBridge): Promise<void> {
  let calm = 0;
  let seen = transport.posts.length;
  while (calm < 10) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    calm = transport.posts.length === seen ? calm + 1 : 0;
    seen = transport.posts.length;
  }
}

const posts = (transport: TopologyBridge): PostEntry[] =>
  transport.posts.map((post) => [post.op, post.session]);

const atChoice = (player: DriverPlayer) => () =>
  player.session.value !== null && playerRuntimeForeground(player.session.value) !== null;

/** Answers the shown choice with its first option, as its button does. */
async function answerFirst(player: DriverPlayer): Promise<void> {
  const input = await runtimeInput();
  const shown = player.session.value!;
  const foreground = playerRuntimeForeground(shown);
  assert.ok(foreground?.kind === "choose");
  const result = await input.runInput(
    player.inputSection,
    presentedAction(shown),
    presentedAction,
    input.intents.choice(foreground.options[0]!.id, "button"),
  );
  assert.equal(result.kind, "answered");
}

async function plainStart(player: DriverPlayer): Promise<void> {
  player.prepare(
    await sourceStart(player.bridge, SCRIPT, () => ({
      ...player.scriptStorageOptions(),
      wallClockMs: 0,
    })),
  );
  await player.activate();
  await until(atChoice(player), "the first choice", "step");
}

/** A hosted script's Start offered (`prepareHostedScript`): Continue instead when the browser keeps its session. */
async function offered(player: DriverPlayer, activation: "start" | "continue"): Promise<void> {
  const prepared = prepareHostedScript(player, { load: async () => ({ project: SCRIPT }) });
  await until(() => player.activation.value === activation, `${activation} offered`, "step");
  assert.equal(prepared.failure.value, null);
}

/** A hosted script's Start, with Debug off or on, up to its first choice. */
async function hostedStart(context: TestContext, debug: boolean): Promise<PostEntry[]> {
  stubBrowser(context);
  const { player, transport } = await page(context, browser(), debug);
  await offered(player, "start");
  await player.activate();
  await until(atChoice(player), "the first choice", "step");
  await quiet(transport);
  assert.equal(player.hostError.value, null);
  return posts(transport);
}

/** A hosted script's Start, its first choice answered, and the session kept as the page hides. */
async function keptAfterInput(context: TestContext) {
  const { hide } = stubBrowser(context);
  const at = browser();
  const { player, transport, close } = await page(context, at, false);
  await offered(player, "start");
  await player.activate();
  await until(atChoice(player), "the first choice", "step");
  await answerFirst(player);
  await until(atChoice(player), "the second choice", "step");
  hide();
  await until(
    () => at.published.some((kept) => kept.snapshotJson.includes('"Red"')),
    "the session kept after its input",
    "step",
  ).catch((error: unknown) => {
    const kept = at.published.map((update) => update.snapshotJson.length);
    const sent = transport.posts.map((post) => post.op).join(", ");
    throw new Error(
      `${String(error)}; kept snapshots' lengths [${kept.join(", ")}]; host error ${player.hostError.value}; posted ${sent}`,
    );
  });
  await quiet(transport);
  assert.equal(player.hostError.value, null);
  return { at, close, posts: posts(transport) };
}

async function startInputKeep(context: TestContext): Promise<PostEntry[]> {
  return (await keptAfterInput(context)).posts;
}

/** Continue of the session `startInputKeep` kept, on a new page of the same browser, up to its choice. */
async function continueKept(context: TestContext): Promise<PostEntry[]> {
  const { at, close } = await keptAfterInput(context);
  // The page that kept it is gone, as after a reload.
  close();
  const { player, transport } = await page(context, at, false);
  await offered(player, "continue");
  await player.activate();
  await until(atChoice(player), "the kept choice", "step");
  await quiet(transport);
  assert.equal(player.hostError.value, null);
  return posts(transport);
}

/** With Debug on, a Start, its first choice answered, Back to the first point, and Return. */
async function rewindBackReturn(context: TestContext): Promise<PostEntry[]> {
  stubBrowser(context);
  const { player, transport, rewind } = await page(context, browser(), true);
  await plainStart(player);
  await until(() => rewind().state.value.points.length === 1, "the first point", "step");
  await answerFirst(player);
  await until(() => rewind().state.value.points.length === 2, "the second point", "step");
  assert.equal(await rewind().back(rewind().state.value.points[0]!.id), true, "Back");
  assert.equal(await rewind().returnToSession(), true, "Return");
  await until(() => rewind().state.value.inspection === null, "the inspection's end", "step");
  await quiet(transport);
  assert.equal(player.hostError.value, null);
  return posts(transport);
}

/** The named drivers: each gives every request its run posted, in order. */
export const DRIVERS = {
  "hosted Start, Debug off": (context) => hostedStart(context, false),
  "hosted Start, Debug on": (context) => hostedStart(context, true),
  "Start, input, keep": startInputKeep,
  "Continue of a kept session": continueKept,
  "rewind Back and Return": rewindBackReturn,
} satisfies Record<string, (context: TestContext) => Promise<PostEntry[]>>;
