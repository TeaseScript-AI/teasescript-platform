import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";

import { NO_MARKS, type HistoryMarks } from "../player/debug-history-marks.js";
import { BridgeRequestError } from "../player/engine-bridge/client.js";
import { introduceNow } from "../player/engine-bridge/in-process.js";
import type { PrepareResult } from "../player/engine-bridge/player-ops.js";
import type { PlayerBridge } from "../player/player-bridge.js";
import { serializeValidatedRuntimeJson } from "../src/runtime/snapshot/checkpoint-json.js";
import { compilePlayerProject, createPlayerRuntimeSession } from "../player/compile-project.js";
import { inProcessBridge } from "./helpers/in-process-bridge.js";

/*
 * L5i.6: a session's marks for a debug export are the host's (`HeldSession.marks`), given at its construction on every
 * route that makes one and carried by every publication. An applied storage edit changes them in its own host step; a
 * kept session's Continue brings its kept marks; malformed marks are refused on each route.
 */

const START = { wallClockMs: 0, scriptStorage: [], persistentScriptStorage: true };
const SCRIPT = 'let a = askChoice "A1", "A2"\nlet b = askChoice "B1", "B2"\nexit';
const KEPT: HistoryMarks = Object.freeze({
  editedWhileDebugging: Object.freeze({ firstEditSceneTimeMs: 1_000, editCount: 3 }),
  rewoundWhileDebugging: Object.freeze({ restoredSceneTimeMs: 500, rewindCount: 2 }),
});
const MALFORMED: readonly (readonly [string, unknown])[] = [
  ["not an object", 7],
  ["a missing field", { editedWhileDebugging: null }],
  ["an extra field", { ...NO_MARKS, more: 1 }],
  [
    "a negative count",
    {
      editedWhileDebugging: { firstEditSceneTimeMs: 0, editCount: -1 },
      rewoundWhileDebugging: null,
    },
  ],
];

async function prepared(bridge: PlayerBridge): Promise<string> {
  const plan = compilePlayerProject(SCRIPT).plan!;
  const reply = await bridge.client.request("prepare", {
    source: { kind: "plan", text: serializeValidatedRuntimeJson(plan) },
  });
  // EVIDENCE: validation: `prepare` replies from the same build with its result.
  const result = reply.result as PrepareResult;
  assert.equal(result.kind, "prepared");
  return result.kind === "prepared" ? result.plan : "";
}

test("a Start's session has no marks, and its publications carry the host's", async () => {
  const bridge = await inProcessBridge();
  const session = await bridge.start(await prepared(bridge), START, false);
  assert.deepEqual(session.marks, NO_MARKS);
});

test("an applied storage edit publishes its mark in its own host step: the edit's publication carries it", async () => {
  const bridge = await inProcessBridge();
  const session = await bridge.start(await prepared(bridge), START, false);
  await bridge.request(session, "observeTime", { atMs: 1_500, media: [] });
  const outcome = await bridge.request<{ readonly kind: string }>(session, "applyStorageEdit", {
    key: "k",
    value: 1,
  });
  assert.equal(outcome.kind, "applied");
  const edited = bridge.latest(session)!;
  assert.deepEqual(edited.marks.editedWhileDebugging, {
    firstEditSceneTimeMs: 1_500,
    editCount: 1,
  });
  await bridge.request(session, "observeTime", { atMs: 2_000, media: [] });
  await bridge.request(session, "applyStorageEdit", { key: "k", value: 2 });
  assert.deepEqual(bridge.latest(session)!.marks.editedWhileDebugging, {
    firstEditSceneTimeMs: 1_500,
    editCount: 2,
  });
});

test("a stop after the host applied a storage edit still publishes that edit with its mark", async () => {
  const bridge = await inProcessBridge();
  const session = await bridge.start(await prepared(bridge), START, false);
  await bridge.request(session, "observeTime", { atMs: 1_500, media: [] });
  const edit = bridge.request<{ readonly kind: string }>(session, "applyStorageEdit", {
    key: "k",
    value: 1,
  });
  await bridge.halt(session);
  assert.equal((await edit).kind, "applied");
  assert.ok(bridge.frozen(session));
  assert.deepEqual(bridge.latest(session)!.marks.editedWhileDebugging, {
    firstEditSceneTimeMs: 1_500,
    editCount: 1,
  });
});

test("every storage edit a held session takes passes the edit's mark: one adapter call, in the op that marks it", () => {
  // The calls that apply an external storage edit, by file: the adapter's (only `applyStorageEdit` makes it, and marks
  // the session when it applied), the engine's below the adapter, and a debug export's replay, which no held session runs.
  const root = new URL("../../player/", import.meta.url);
  const calls: string[] = [];
  const walk = (folder: URL, prefix: string) => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(new URL(`${entry.name}/`, folder), `${prefix}${entry.name}/`);
      else if (/\.(ts|vue)$/u.test(entry.name))
        for (const line of readFileSync(new URL(entry.name, folder), "utf8").split("\n"))
          if (
            /\b(applyPlayerRuntimeStorageEdit|applyExternalStorageEdit)\(/u.test(line) &&
            !/function /u.test(line)
          )
            calls.push(`${prefix}${entry.name}: ${line.trim()}`);
    }
  };
  walk(root, "player/");
  assert.deepEqual(calls.sort(), [
    "player/debug-export.ts: return settled(session.applyExternalStorageEdit(first));",
    "player/debug-export.ts: return withOutcome(applyExternalStorageEdit(plan, snapshot, first));",
    "player/engine-bridge/ops/input.ts: const result = applyPlayerRuntimeStorageEdit(held.sessionForOperation(), edit);",
    "player/runtime-adapter.ts: runtime.applyExternalStorageEdit(edit, traceOptions(session.debugTrace)),",
  ]);
  const input = readFileSync(new URL("engine-bridge/ops/input.ts", root), "utf8");
  assert.match(input, /if \(result\.outcome\.kind === "applied"\) held\.marksEdited\(\);/u);
});

test("the main side writes no marks: the composable's views of them are computed from the shown session", () => {
  const folder = new URL("../../player/vue/src/", import.meta.url);
  const writers: string[] = [];
  const files = readdirSync(folder, { recursive: true })
    .map(String)
    .filter((name) => /\.(ts|vue)$/u.test(name));
  // A move that takes the composable out of the scan fails here instead of reading nothing.
  assert.ok(
    files.includes("session/usePlayerSession.ts"),
    "the scan reads session/usePlayerSession.ts",
  );
  for (const file of files)
    for (const [index, line] of readFileSync(new URL(file, folder), "utf8").split("\n").entries())
      if (/\b(debugEdits|rewound)\.value\s*(=[^=]|\?\?=|\|\|=|&&=)/u.test(line))
        writers.push(`${file}:${index + 1}: ${line.trim()}`);
  assert.deepEqual(writers, []);
});

test("every publication passes the connection's history, on publish's one return path", () => {
  const source = readFileSync(
    new URL("../../player/engine-bridge/ops/session.ts", import.meta.url),
    "utf8",
  );
  const start = source.indexOf("  publish(next: PlayerRuntimeSession): Publication {");
  assert.notEqual(start, -1);
  const body = source.slice(start, source.indexOf("\n  }\n", start));
  const observed = body.indexOf("this.#connection.history.observePublication(this, next)");
  assert.notEqual(observed, -1);
  assert.deepEqual(
    [...body.matchAll(/\breturn\b/gu)].map((match) => match.index > observed),
    [true],
  );
});

test("a kept session's Continue brings its kept marks; malformed kept marks are refused", async () => {
  const bridge = await inProcessBridge();
  const plan = await prepared(bridge);
  const session = await bridge.start(plan, START, false);
  const keep = await bridge.read(session, "captureKeep", { plan });
  if (keep.kind !== "captured") assert.fail(`The capture gave ${keep.kind}.`);
  const events = bridge.latest(session)!.events.slice(0, keep.eventsThrough);
  const restored = await bridge.restoreKept(plan, keep.planJson!, keep.snapshotJson, events, KEPT);
  assert.ok(typeof restored === "object");
  assert.deepEqual(restored.marks, KEPT);
  for (const [name, value] of MALFORMED) {
    // EVIDENCE: fixture: a malformed value where the host expects marks, which is what this case checks.
    const marks = value as HistoryMarks;
    const refused: unknown = await bridge
      .restoreKept(plan, keep.planJson!, keep.snapshotJson, events, marks)
      .catch((error: unknown) => error);
    assert.ok(refused instanceof BridgeRequestError, name);
    assert.equal(refused.kind, "bridge", name);
  }
});

test("a restore registered through the facade takes the marks it is given; malformed ones throw", async () => {
  const bridge = await inProcessBridge();
  const restored = introduceNow(bridge, () => createPlayerRuntimeSession(SCRIPT), KEPT);
  assert.deepEqual(restored.marks, KEPT);
  for (const [name, value] of MALFORMED) {
    // EVIDENCE: fixture: as above.
    const marks = value as HistoryMarks;
    assert.throws(
      () => introduceNow(bridge, () => createPlayerRuntimeSession(SCRIPT), marks),
      /marks|editedWhileDebugging|must/u,
      name,
    );
  }
});
