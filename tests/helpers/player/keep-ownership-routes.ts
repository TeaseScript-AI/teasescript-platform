/*
 * Continuation ownership's routes (`tests/player/player-keep-ownership.test.ts`): the fixtures, and each operation
 * driven on its route by the descriptor's variants (`VARIANT_DRIVERS`), with where a run is held.
 */

import assert from "node:assert/strict";
import { type TestContext } from "node:test";
import { type EffectScope } from "vue";
import { compilePlayerProject } from "../../../player/runtime/compile-project.js";
import { answerWith } from "./player-input.js";
import type { StorageBundle } from "../../../player/persistence/storage-transfer.js";
import {
  SAVED_DATA_SCRIPTS,
  type ImportedScript,
  POSTED,
  VARIANTS,
  type Move,
  type VariantName,
} from "./plan-json-family.js";
import type { PlayerBridge } from "../../../player/runtime/player-bridge.js";
import type { InstructionPlan } from "../../../src/index.js";
import { readForImport } from "./transfer-read.js";
import type { SessionTransfer } from "../../../player/persistence/session-transfer.js";
import {
  KeepHost,
  SCOPE,
  faults,
  held,
  prepareOn,
  page,
  mount,
  tasks,
  until,
  prepareAgain,
  ASKS_OTHER,
} from "./keep-host.js";
import { type RecordedCall, familyBrowser, type FamilyBrowser } from "./keep-ownership-recorder.js";

export const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
// A session with a photo only it uses, one that saves its photo, and one that saves two.
export const PHOTO_PLAN = compilePlayerProject(
  'let picture: string = askImage(hint: "Add an image")\nlet a = askText(hint: "One")\nsay "Got ${a}.", instant\nexit',
).plan!;
export const SAVED_PHOTO_PLAN = compilePlayerProject(
  'let picture: string = askImage(hint: "Add an image")\nsave picture as "photo"\nlet a = askText(hint: "One")\nsay "Got ${a}.", instant\nexit',
).plan!;
export const TWO_PHOTOS_PLAN = compilePlayerProject(
  'let first: string = askImage(hint: "First")\nsave first as "first"\nlet second: string = askImage(hint: "Second")\nsave second as "second"\nlet a = askText(hint: "One")\nsay "Got ${a}.", instant\nexit',
).plan!;

// Two photos only the session uses: a debug room's keep promotes both.
export const TWO_SESSION_PHOTOS_PLAN = compilePlayerProject(
  'let first: string = askImage(hint: "First")\nlet second: string = askImage(hint: "Second")\nlet a = askText(hint: "One")\nsay "Got ${a}.", instant\nexit',
).plan!;

/** Lets `host`'s session take a fixture photo at its question, then waits for its next one. */
async function answerPhoto(host: KeepHost): Promise<string> {
  await until(() => host.session.value?.state.status === "waiting", "the session did not ask");
  const stored = await host.images.store(new File([PNG], "photo.png"), { types: null, mime: null });
  assert.ok("reference" in stored, "the photo was not stored");
  // Chosen once the session asks for it: after an earlier photo, its next question comes a step later.
  await until(
    () => host.imageCapture.choose(stored.reference),
    "the session did not ask for a photo",
  );
  const used = await answerWith(host, host.imageCapture.answer("button"));
  assert.equal(used.outcome?.kind, "completed");
  return stored.reference;
}

/** Waits until `at` kept a session whose state uses every one of `references`, and its page is done with it. */
async function keptWith(at: FamilyBrowser, references: readonly string[]) {
  await until(
    () =>
      at.published.some((update) =>
        references.every((reference) => update.snapshotJson.includes(reference)),
      ),
    "the session was not kept with its photos",
  );
  for (let turn = 0; turn < 4; turn++) await tasks();
}

/** A page of `at` whose session of `plan` took its photos and asks its last question, kept with them. */
async function photoSession(
  context: TestContext,
  at: FamilyBrowser,
  plan: InstructionPlan = PHOTO_PLAN,
  photos = 1,
) {
  const opened = await page(context, at, plan);
  await opened.host.activate();
  const references: string[] = [];
  for (let photo = 0; photo < photos; photo++) references.push(await answerPhoto(opened.host));
  await keptWith(at, references);
  return { ...opened, references };
}

/** The transfer of a session of `plan` exported from a browser of its own, which then closes. */
async function exported(context: TestContext, plan: InstructionPlan, photos = 1) {
  const source = familyBrowser();
  const exporting = await photoSession(context, source, plan, photos);
  const { transfer } = await exporting.host.exportSession();
  exporting.scope.stop();
  await tasks();
  return transfer;
}

/** An operation of a producer, prepared on its page; `start` begins it, in the operation's context. */
interface Operation {
  readonly host: KeepHost;
  readonly scope: EffectScope;
  readonly plan: InstructionPlan;
  start(): Promise<void>;
}
/** What a driver is given: the host's recorder, and the page's hiding. */
interface Fixture {
  readonly watchHost: (bridge: PlayerBridge) => void;
  readonly hide: () => void;
  readonly failHost: (op: string) => void;
}
type Driver = (context: TestContext, at: FamilyBrowser, fixture: Fixture) => Promise<Operation>;

/** A Continue's restore on a page of `at` of `plan`, which `at` keeps a session of. */
async function restoreOn(
  context: TestContext,
  at: FamilyBrowser,
  { watchHost }: Fixture,
  plan: InstructionPlan,
  room?: "debug",
): Promise<Operation> {
  const { host, scope } = await mount(context, at, undefined, room);
  watchHost(await host.bridge);
  const token = await held(host, plan);
  return {
    host,
    scope,
    plan,
    start: () =>
      host.prepareScript(token, {
        plan: token,
        options: () => ({ ...host.scriptStorageOptions(), ...host.temporalCapture() }),
      }),
  };
}

/** An import of `transfer` on a page of `at` of `plan`; `before` runs once it was reviewed. */
async function importOn(
  context: TestContext,
  at: FamilyBrowser,
  { watchHost }: Fixture,
  plan: InstructionPlan,
  transfer: SessionTransfer,
  before: () => void = () => {},
): Promise<Operation> {
  const { host, scope } = await page(context, at, plan);
  const stored = at.repository.size;
  const review = await host.reviewSessionImport(await readForImport(host, transfer));
  // The review stores no photo: the import's own calls do.
  assert.equal(at.repository.size, stored, "the review stored a photo");
  watchHost(await host.bridge);
  before();
  return { host, scope, plan, start: () => host.importSession(review) };
}

/** A first save of a session of `plan` with its photo, its earlier saves refused; `forget` cannot write its state. */
async function keepOn(
  context: TestContext,
  at: FamilyBrowser,
  { watchHost, hide }: Fixture,
  first: "first" | "incremental" | "forget",
  room?: "debug",
  plan: InstructionPlan = PHOTO_PLAN,
  photos = 1,
): Promise<Operation> {
  const { host, scope } = await page(context, at, plan);
  watchHost(await host.bridge);
  if (first !== "incremental") at.state.failing = Number.MAX_SAFE_INTEGER;
  await host.activate();
  const references: string[] = [];
  for (let photo = 0; photo < photos; photo++) references.push(await answerPhoto(host));
  await keptWith(at, references);
  if (room === "debug") {
    // Play goes on in the debug room, whose saves fail at their first step until the operation.
    at.state.roomsDiscardFailing = Number.MAX_SAFE_INTEGER;
    host.setDebugMode(true);
    await until(() => host.rooms.current.value === "debug", "the page did not open the debug room");
    hide();
    for (let turn = 0; turn < 8; turn++) await tasks();
    at.state.roomsDiscardFailing = 0;
  }
  at.state.failing = 0;
  return {
    host,
    scope,
    plan,
    start: async () => {
      if (first === "forget") faults.nextSnapshot = true;
      hide();
    },
  };
}

/** Another script of the browser, which a saved-data import may write. */
export const OTHER_SCOPE = "development-package:other";
/** An exported photo of a saved-data bundle, under the reference its values hold. */
const BUNDLE_PHOTO = "captured-media:11111111-1111-4111-8111-111111111111:1";
/** Saved data of `scopes` as an export of them holds it: each with a photo and a score. */
function bundleOf(scopes: readonly string[]): StorageBundle {
  return {
    scripts: scopes.map((scope) => ({
      scope,
      name: null,
      photos: [BUNDLE_PHOTO],
      entries: [
        { key: "photo", value: BUNDLE_PHOTO },
        { key: "score", value: 3 },
      ],
    })),
    images: [{ reference: BUNDLE_PHOTO, bytes: PNG }],
  };
}

const SCOPE_OF: Readonly<Record<ImportedScript, string>> = { shown: SCOPE, other: OTHER_SCOPE };
/** The saved-data import `name` on a page of `at`: the scripts it declares, in the room its route names. */
const savedDataImportOf = (
  context: TestContext,
  at: FamilyBrowser,
  fixture: Fixture,
  name: keyof typeof SAVED_DATA_SCRIPTS,
) =>
  savedDataImportOn(
    context,
    at,
    fixture,
    SAVED_DATA_SCRIPTS[name].imports.map((script) => SCOPE_OF[script]),
    VARIANTS[name].route === "debug" ? "debug" : undefined,
  );

/** A saved-data import of `scopes` on a page of `at`, in its normal room or the debug room. */
async function savedDataImportOn(
  context: TestContext,
  at: FamilyBrowser,
  { watchHost }: Fixture,
  scopes: readonly string[],
  room?: "debug",
): Promise<Operation> {
  const { host, scope } = await mount(context, at, undefined, room);
  await prepareOn(host, PHOTO_PLAN);
  const review = await host.reviewSavedDataImport(bundleOf(scopes));
  watchHost(await host.bridge);
  return {
    host,
    scope,
    plan: PHOTO_PLAN,
    start: () => host.importSavedData(review, new Set(scopes)),
  };
}

/** Each variant of the descriptor on its real path, up to its start. */
export const VARIANT_DRIVERS: Record<VariantName, Driver> = {
  async "restoreKept captured sessionPhoto"(context, at, fixture) {
    (await photoSession(context, at)).scope.stop();
    await tasks();
    return restoreOn(context, at, fixture, PHOTO_PLAN);
  },
  async "restoreKept plain sessionPhoto"(context, at, fixture) {
    (await photoSession(context, at)).scope.stop();
    await tasks();
    return restoreOn(context, at, fixture, PHOTO_PLAN);
  },
  async "restoreKept debug sessionPhoto"(context, at, fixture) {
    // A session kept in the debug room: copied there, then saved by the debug room.
    const { host, scope } = await photoSession(context, at);
    host.setDebugMode(true);
    await until(() => host.rooms.current.value === "debug", "the page did not open the debug room");
    fixture.hide();
    await until(() => host.activation.value === null, "the debug session did not go on");
    for (let turn = 0; turn < 8; turn++) await tasks();
    assert.ok((await at.rooms.session(SCOPE)) !== null, "the debug room keeps a session");
    scope.stop();
    await tasks();
    return restoreOn(context, at, fixture, PHOTO_PLAN, "debug");
  },
  async "planText captured sessionPhoto"(context, at, fixture) {
    return importOn(context, at, fixture, PHOTO_PLAN, await exported(context, PHOTO_PLAN));
  },
  async "planText plain sessionPhoto"(context, at, fixture) {
    return importOn(context, at, fixture, PHOTO_PLAN, await exported(context, PHOTO_PLAN));
  },
  async "planText captured savedPhoto"(context, at, fixture) {
    return importOn(
      context,
      at,
      fixture,
      SAVED_PHOTO_PLAN,
      await exported(context, SAVED_PHOTO_PLAN),
    );
  },
  async "planText captured twoSavedPhotos"(context, at, fixture) {
    const transfer = await exported(context, TWO_PHOTOS_PLAN, 2);
    return importOn(context, at, fixture, TWO_PHOTOS_PLAN, transfer);
  },
  async "planText captured confirmedPhoto"(context, at, fixture) {
    const transfer = await exported(context, SAVED_PHOTO_PLAN);
    return importOn(context, at, fixture, SAVED_PHOTO_PLAN, transfer, () =>
      at.failing.add("repository.add:exists"),
    );
  },
  async "planText captured failedReplace"(context, at, fixture) {
    // The browser keeps saved values with a photo of an earlier import, which the importing page does not hold.
    const earlier = await importOn(
      context,
      at,
      { ...fixture, watchHost: () => {} },
      SAVED_PHOTO_PLAN,
      await exported(context, SAVED_PHOTO_PLAN),
    );
    await earlier.start();
    earlier.scope.stop();
    await tasks();
    const transfer = await exported(context, SAVED_PHOTO_PLAN);
    return importOn(context, at, fixture, SAVED_PHOTO_PLAN, transfer, () =>
      at.failing.add("provider.replace"),
    );
  },
  async "planText captured discardFails"(context, at, fixture) {
    // The browser keeps a session of its own, which the import cannot replace.
    (await photoSession(context, at)).scope.stop();
    await tasks();
    const transfer = await exported(context, PHOTO_PLAN);
    return importOn(context, at, fixture, PHOTO_PLAN, transfer, () =>
      at.failing.add("kept.discard"),
    );
  },
  async "planText captured photoAddFails"(context, at, fixture) {
    const transfer = await exported(context, PHOTO_PLAN);
    return importOn(context, at, fixture, PHOTO_PLAN, transfer, () =>
      at.failing.add("kept.media.add"),
    );
  },
  async "planText captured planTextFails"(context, at, fixture) {
    const transfer = await exported(context, PHOTO_PLAN);
    return importOn(context, at, fixture, PHOTO_PLAN, transfer, () => fixture.failHost("planText"));
  },
  async "planText captured publishFails"(context, at, fixture) {
    const transfer = await exported(context, PHOTO_PLAN);
    return importOn(context, at, fixture, PHOTO_PLAN, transfer, () => (at.state.failing = 1));
  },
  "captureKeep captured first": (context, at, fixture) => keepOn(context, at, fixture, "first"),
  "captureKeep captured incremental": (context, at, fixture) =>
    keepOn(context, at, fixture, "incremental"),
  "captureKeep captured forget": (context, at, fixture) => keepOn(context, at, fixture, "forget"),
  "captureKeep debug first": (context, at, fixture) =>
    keepOn(context, at, fixture, "first", "debug"),
  "captureKeep debug twoPhotos": (context, at, fixture) =>
    keepOn(context, at, fixture, "first", "debug", TWO_SESSION_PHOTOS_PLAN, 2),
  "savedDataImport captured shown": (context, at, fixture) =>
    savedDataImportOf(context, at, fixture, "savedDataImport captured shown"),
  "savedDataImport captured shownAndOther": (context, at, fixture) =>
    savedDataImportOf(context, at, fixture, "savedDataImport captured shownAndOther"),
  "savedDataImport debug ownScript": (context, at, fixture) =>
    savedDataImportOf(context, at, fixture, "savedDataImport debug ownScript"),
  "savedDataImport captured otherOnly": (context, at, fixture) =>
    savedDataImportOf(context, at, fixture, "savedDataImport captured otherOnly"),
  "savedDataImport plain photoNotStored": (context, at, fixture) =>
    savedDataImportOf(context, at, fixture, "savedDataImport plain photoNotStored"),
};

/** What each failing import says when it is current, and what it offers then. */
export const CURRENT_FAILURES: Partial<
  Record<VariantName, { message: RegExp; offers: "start" | "continue" }>
> = {
  "planText captured failedReplace": { message: /Nothing was imported/, offers: "continue" },
  "planText captured discardFails": {
    message: /could not replace the session it kept/,
    offers: "continue",
  },
  "planText captured photoAddFails": { message: /could not keep the session/, offers: "start" },
  "planText captured planTextFails": { message: /could not keep the session/, offers: "start" },
  "planText captured publishFails": { message: /could not keep the session/, offers: "start" },
  "savedDataImport plain photoNotStored": {
    message: /its photos could not be stored/,
    offers: "start",
  },
};

/** The page of `operation` moves on as `move` says. */
export async function moveOn(operation: Operation, move: Move) {
  if (move === "otherPlan") await prepareAgain(operation.host, ASKS_OTHER);
  else if (move === "samePlan") await prepareAgain(operation.host, operation.plan);
  else if (move === "room") {
    operation.host.setDebugMode(true);
    await until(
      () => operation.host.rooms.current.value === "debug",
      "the page did not open the debug room",
    );
  } else operation.scope.stop();
}

/** The occurrences of `trace` a row can hold: each call that is not posted, with how many of its name come before. */
export function holdable(trace: readonly string[]) {
  return trace.flatMap((name, index) =>
    Object.hasOwn(POSTED, name)
      ? []
      : [{ index, name, skip: trace.slice(0, index).filter((made) => made === name).length }],
  );
}

/** Waits until `reached`, the held call `name`, arrives; fails with the calls made so far when it does not. */
export async function reachedWithin(
  reached: Promise<void>,
  name: string,
  calls: readonly RecordedCall[],
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<"missed">(
    (resolve) => (timer = setTimeout(resolve, 2_000, "missed")),
  );
  const arrived = await Promise.race([reached, deadline]);
  clearTimeout(timer);
  assert.notEqual(
    arrived,
    "missed",
    `${name} was not reached; the calls: ${calls
      .slice(-12)
      .map((made) => `${made.by ?? "-"}:${made.name}`)
      .join(" ")}`,
  );
}
