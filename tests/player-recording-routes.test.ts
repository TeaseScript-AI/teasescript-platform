import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test, { before } from "node:test";
import { pathToFileURL } from "node:url";
import ts from "typescript";

/*
 * L5h.3b's static censuses, over the Player's code with the session-work census's reference walk
 * (`tools/session-work-census.mjs`'s `uses`):
 * - every begin of a recording converges on the recorder's one begin, from a route this file classifies;
 * - every host restart of the recorder is one of the routes the restart gate (`beforeRestart`) covers, and the gate's
 *   hook is read only by the rewind owner;
 * - the replies of the failure capture and of the export capture each reach one settle function, and nothing else;
 * - every route that publishes, stops or binds a session supplies the export observation, classified;
 * - every page sender of an activation's diagnostic work checks that activation's admission itself.
 * What they claim is the wiring. That a restart waits for the gate's settlement is the rewind lifecycle's runtime claim,
 * and that no stale capture shows is the export observation family's.
 */

interface Use {
  readonly target: string;
  readonly file: string;
  readonly path: string;
  readonly use: string;
}
interface Census {
  uses(targets: readonly { readonly file: string; readonly path: string }[]): readonly Use[];
}

let census: Census;
before(async () => {
  const tool = await import(
    pathToFileURL(resolve(process.cwd(), "tools/session-work-census.mjs")).href
  );
  // EVIDENCE: validation: the census module's documented API; its tests check `createSessionWorkCensus`.
  census = (tool.createSessionWorkCensus as (root: string) => Census)(process.cwd());
});

const ADAPTER = "player/runtime-adapter.ts";
const SESSION_OPS = "player/engine-bridge/ops/session.ts";

/** What reaches each target, as `target <- caller [use]`. */
function callers(targets: readonly { readonly file: string; readonly path: string }[]): string[] {
  return [
    ...new Set(census.uses(targets).map((each) => `${each.target} <- ${each.file} ${each.path}`)),
  ].sort();
}

/** Each place that begins a recording, by the begin route it serves (§21.2 "Recording provenance"). */
const BEGINS: Readonly<Record<string, string>> = {
  "player/debug-recorder.ts DebugRecorder > begin <- player/runtime-adapter.ts PlayerRuntimeEngine > beginRecording":
    "the one convergence: it records the engine and the begin's epoch",
  [`${ADAPTER} PlayerRuntimeEngine > beginRecording <- ${ADAPTER} createPlayerRuntimeSession`]:
    "a host Start, and `introduceNow` with an object or a factory",
  [`${ADAPTER} PlayerRuntimeEngine > beginRecording <- ${ADAPTER} restoredSession`]:
    "a raw restore and `restoreAt`, given a recorder",
  [`${ADAPTER} PlayerRuntimeEngine > beginRecording <- ${ADAPTER} beginPlayerRuntimeRecording`]:
    "the explicit begin, by `beginRecordingAt` only",
  [`${ADAPTER} beginPlayerRuntimeRecording <- ${SESSION_OPS} beginRecordingAt`]:
    "the host's begin at a held session",
  [`${SESSION_OPS} beginRecordingAt <- player/engine-bridge/in-process.ts beginRecordingNow`]:
    "`beginRecordingNow`, the in-process facade",
  [`${SESSION_OPS} beginRecordingAt <- player/engine-bridge/ops/history.ts historyOps > restartAt`]:
    "L5i.6's host restores: Back's and Forward's commit, Return, Debug-off's reinstatement",
  [`${SESSION_OPS} beginRecordingAt <- ${SESSION_OPS} sessionOps > beginRecording > sessionOp:callback#9.2`]:
    "the host `beginRecording` op: Continue",
};

test("every begin of a recording converges on the recorder's begin from a classified route", () => {
  const found = callers([
    { file: "player/debug-recorder.ts", path: "DebugRecorder > begin" },
    { file: ADAPTER, path: "PlayerRuntimeEngine > beginRecording" },
    { file: ADAPTER, path: "beginPlayerRuntimeRecording" },
    { file: SESSION_OPS, path: "beginRecordingAt" },
  ]);
  assert.deepEqual(found, Object.keys(BEGINS).sort(), "an unclassified or stale begin route");
});

test("the restart gate's hook is read only by the rewind owner, and the host restarts only on its routes", () => {
  assert.deepEqual(
    callers([
      {
        file: "player/vue/src/session/useFailureRecording.ts",
        path: "useFailureRecording > beforeRestart",
      },
      {
        file: "player/vue/src/usePlayerSession.ts",
        path: "usePlayerSession > beforeRewindRestart",
      },
    ]),
    [
      "player/vue/src/session/useFailureRecording.ts useFailureRecording > beforeRestart <- player/vue/src/usePlayerSession.ts usePlayerSession > beforeRewindRestart",
      // The rewind API's `beforeRestart`, which the rewind owner's gate reads before each host restart.
      "player/vue/src/usePlayerSession.ts usePlayerSession > beforeRewindRestart <- player/vue/src/usePlayerSession.ts usePlayerSession > beforeRestart",
    ],
  );
  const owner = readFileSync(resolve(process.cwd(), "player/vue/src/rewindOwner.ts"), "utf8");
  assert.equal(owner.match(/host\.beforeRestart\(\)/gu)?.length, 1, "one gate reads the hook");
  // The history ops that restart the recorder in the host (`restartAt`), each sent only by the lifecycle's actions
  // that follow its gate: the commit of Back or Forward, Return, and a reinstating close.
  const history = readFileSync(
    resolve(process.cwd(), "player/engine-bridge/ops/history.ts"),
    "utf8",
  );
  const restarting = [...history.matchAll(/^ {4}(\w+): \{[\s\S]*?^ {4}\},?$/gmu)]
    .filter(([body]) => body.includes("restartAt("))
    .map(([, op]) => op)
    .sort();
  assert.deepEqual(restarting, ["historyClose", "rewindCommit", "rewindReturn"]);
});

test("the failure capture's and the export capture's replies each reach one settle function only", () => {
  assert.deepEqual(
    callers([
      {
        file: "player/vue/src/session/useFailureRecording.ts",
        path: "useFailureRecording > settle",
      },
      { file: "player/player-bridge.ts", path: "PlayerBridge > captureExport" },
      {
        file: "player/vue/src/session/useExportCandidate.ts",
        path: "useExportCandidate > deliver",
      },
    ]),
    [
      "player/player-bridge.ts PlayerBridge > captureExport <- player/vue/src/session/useExportCandidate.ts useExportCandidate > debugExportCandidate > capture",
      "player/vue/src/session/useExportCandidate.ts useExportCandidate > deliver <- player/vue/src/session/useExportCandidate.ts useExportCandidate > debugExportCandidate > capture > captureExport:callback",
      "player/vue/src/session/useFailureRecording.ts useFailureRecording > settle <- player/vue/src/session/useFailureRecording.ts useFailureRecording > stopped > then:callback.1",
      "player/vue/src/session/useFailureRecording.ts useFailureRecording > settle <- player/vue/src/session/useFailureRecording.ts useFailureRecording > stopped > then:callback.2",
    ],
  );
  // Nothing is chained after the capture's settlement: its handlers only settle.
  const failure = readFileSync(
    resolve(process.cwd(), "player/vue/src/session/useFailureRecording.ts"),
    "utf8",
  );
  assert.match(
    failure,
    /\.read\(stopped, "captureRecording"\)\.then\(\s*\(reply\) => settle\(bridge, reply\),\s*\(\) => settle\(bridge, null\),\s*\);/u,
  );
});

// Design round r2's page half: every place the page sends an activation's diagnostic work (its error halt's and its
// incident's stop arguments, its incident, its failure capture) checks that activation's admission there itself, and
// only an activation's begin and the Player's disposal begin or retire a record. Wiring only: that a retired
// activation sends nothing is the completion-lifetime family's runtime claim (`player-session-rewind.test.ts`).
test("the page's diagnostic senders each check their activation's admission, and only Start and disposal change it", () => {
  const SESSION = "player/vue/src/usePlayerSession.ts usePlayerSession";
  const OWNER = "player/vue/src/session/useActivationRun.ts";
  const senders = callers([
    { file: "player/player-bridge.ts", path: "PlayerBridge > commitIncident" },
    { file: OWNER, path: "stopArguments" },
    {
      file: "player/vue/src/session/useFailureRecording.ts",
      path: "useFailureRecording > stopped",
    },
  ]);
  assert.deepEqual(senders, [
    `player/player-bridge.ts PlayerBridge > commitIncident <- ${SESSION} > reportHostError > incident`,
    `${OWNER} stopArguments <- ${SESSION} > reportHostError > incident`,
    `${OWNER} stopArguments <- ${SESSION} > stopAt`,
    `player/vue/src/session/useFailureRecording.ts useFailureRecording > stopped <- ${SESSION} > stopAt`,
  ]);
  const admitting = new Set(
    callers([{ file: OWNER, path: "useActivationRun > admits" }]).map(
      (each) => each.split(" <- ")[1],
    ),
  );
  for (const sender of senders) {
    const caller = sender.split(" <- ")[1]!;
    assert.ok(admitting.has(caller), `${caller} checks its activation's admission`);
  }
  assert.deepEqual(
    callers([
      { file: OWNER, path: "useActivationRun > begin" },
      { file: OWNER, path: "useActivationRun > retire" },
    ]),
    [
      `${OWNER} useActivationRun > begin <- ${SESSION} > startFrom`,
      `${OWNER} useActivationRun > retire <- ${SESSION} > tryOnScopeDispose:callback#1`,
    ],
  );
});

const HELD = "player/engine-bridge/ops/session.ts";

/**
 * Each route that supplies the export observation its facts (§21.4 family 1), by the observation it supplies: every
 * publication passes `publish`, every Player error stop the host's halt, and every session binds its run as it is made
 * or handed over. An unclassified or stale route fails.
 */
const OBSERVATION_ROUTES: Readonly<Record<string, string>> = {
  [`${HELD} HeldSession > publish <- ${HELD} HeldSession > introduce`]:
    "an introduction's first publication",
  [`${HELD} HeldSession > publish <- ${HELD} HeldSession > adoptResult > view`]:
    "an op's new revision (`adoptResult`)",
  [`${HELD} HeldSession > publish <- ${HELD} sessionOps > adoptCatchUp > sessionOp:callback#5.2`]:
    "a catch-up's adoption",
  [`${HELD} HeldSession > publish <- player/engine-bridge/in-process.ts hatch > adopt`]:
    "the in-process facade's adoption",
  [`${HELD} HeldSession > stopRequested <- player/engine-bridge/worker-host.ts startBridgeHost > halt`]:
    "a halt with stop arguments, on receipt",
  [`${HELD} HeldSession > atStop <- player/engine-bridge/worker-host.ts startBridgeHost > stopPayload`]:
    "the halt's acknowledgement, once the work running at the stop settled",
  [`${HELD} HeldSession > bindRun <- ${HELD} HeldSession > constructor`]:
    "every route that makes a session, before it publishes",
  [`${HELD} HeldSession > bindRun <- ${HELD} sessionOps > beginRecording > sessionOp:callback#9.2`]:
    "Continue's handoff of a session the Player held already",
};

test("every publication, stop and binding route of the export observation is classified", () => {
  const found = callers([
    { file: HELD, path: "HeldSession > publish" },
    { file: HELD, path: "HeldSession > stopRequested" },
    { file: HELD, path: "HeldSession > atStop" },
    { file: HELD, path: "HeldSession > bindRun" },
  ]);
  assert.deepEqual(found, Object.keys(OBSERVATION_ROUTES).sort(), "an unclassified or stale route");
  // The routes that make a session, each binding inside the constructor: Start, an introduction, a kept restore, and a
  // history restore.
  const made = ["in-process.ts", "ops/persistence.ts", "ops/session.ts", "ops/history.ts"].map(
    (file) => {
      const text = readFileSync(resolve(process.cwd(), "player/engine-bridge", file), "utf8");
      return [file, text.match(/new HeldSession\(/gu)?.length ?? 0] as const;
    },
  );
  assert.deepEqual(made, [
    ["in-process.ts", 1],
    ["ops/persistence.ts", 1],
    ["ops/session.ts", 1],
    ["ops/history.ts", 1],
  ]);
});

/*
 * The second final review's sweep (B2-L-C-D-E), and its scoped round's: every wait in the page code that acts for an
 * activation, each `await` and each `.then`, `.catch` and `.finally` continuation, in the activation bodies and in every
 * function of the file they call, transitively, either re-admits the activation it began in before its next request or further work,
 * or is listed with why it needs none. A wait this table does not list fails, and so does a listed re-admission that
 * no longer comes before the next request. Wiring only: that retired work does nothing is the runtime families' claim.
 */
/** The Player's session composable and the owner modules it is composed of, which `reachable` follows as one. */
const SESSION_FILES: readonly string[] = [
  "player/vue/src/usePlayerSession.ts",
  "player/vue/src/session/useRandomControl.ts",
  "player/vue/src/session/useDebugModeAndTrace.ts",
  "player/vue/src/session/useSessionMedia.ts",
  "player/vue/src/session/useSessionRewind.ts",
  "player/vue/src/session/persistence/useStorageRoute.ts",
];
const ACTIVATION_FILES = [
  ...SESSION_FILES,
  "player/vue/src/session/useExportCandidate.ts",
  "player/vue/src/session/useFailureRecording.ts",
  "player/vue/src/session/useActivationRun.ts",
  "player/vue/src/useDebugExport.ts",
  // `ownedSection`'s member call `clock.section`, followed into the clock's section and its observation (#1983).
  "player/vue/src/useRuntimeSceneClock.ts",
] as const;
/** In the clock, the section that `ownedSection` opens and its observation; the clock's own scheduling acts for none. */
const CLOCK_SECTION = ["useRuntimeSceneClock > section", "useRuntimeSceneClock > observeIn"];
/**
 * In the session composable's files, the functions that act for an activation: its begin, its completions and its error
 * stop, and every function of those files they call, transitively (`reachable`).
 */
const SESSION_ACTIVATION = [
  "activate",
  "startFrom",
  "startedSession",
  "prepareStart",
  "prepareRestore",
  "reportHostError",
  "stopAt",
];
const READMITS = "re-admits before its next request or further work";
const KEPT_SESSION =
  "the kept session's persistence, under its own operation ownership (`persistenceOwnership`), which retires on a change of room, store or preparation; it sends no activation's diagnostic work";
const SAVED_DATA =
  "reads the page's saved data, before an activation's record begins or for the page; it acts for no activation";
const ACTIVATION_WAITS: Readonly<Record<string, string>> = {
  "useExportCandidate.ts: useExportCandidate > debugExportCandidate: await origin.failure.selection":
    READMITS,
  "useExportCandidate.ts: useExportCandidate > debugExportCandidate: await capture": READMITS,
  "useExportCandidate.ts: useExportCandidate > debugExportCandidate: await stopShown": READMITS,
  "useExportCandidate.ts: useExportCandidate > debugExportCandidate: await options.readPhoto":
    READMITS,
  "useExportCandidate.ts: useExportCandidate > debugExportCandidate > read: await record.data.arrayBuffer":
    "a photo's bytes, read by the dialog's candidate once handed over: a handed-over export stays valid",
  "useFailureRecording.ts: useFailureRecording > stopped: then bridge.read":
    "the capture's settlement, which releases what lands after retirement (`settle`) and acts for nothing else",
  "useFailureRecording.ts: useFailureRecording > selection: await state.settled":
    "reads the settled outcome only; its caller re-admits after it (`debugExportCandidate`)",
  "useDebugExport.ts: useDebugExport > watch:callback: await player.debugExportCandidate":
    "the dialog's: what it gets is handed over, or `null`; a later opening releases it",
  "useDebugExport.ts: useDebugExport > watch:callback: await assembleDebugExport":
    "assembles a handed-over candidate, which stays valid",
  "useDebugExport.ts: useDebugExport > watch:callback: await measuredDebugExportFile": "as above",
  "usePlayerSession.ts: usePlayerSession > activate: await begunInFlight":
    "before the activation's record begins (`startFrom`); the click's token decides",
  "usePlayerSession.ts: usePlayerSession > activate: await startFrom": "the activation itself",
  "usePlayerSession.ts: usePlayerSession > activate: await camera.open":
    "before the activation's record begins; the click's token decides",
  "usePlayerSession.ts: usePlayerSession > activate: await loadScriptStorage":
    "before the activation's record begins; the click's token decides",
  "usePlayerSession.ts: usePlayerSession > startFrom: then bridgeReady":
    "before the activation's record begins; the click's token decides",
  "usePlayerSession.ts: usePlayerSession > startFrom: then begun": READMITS,
  "usePlayerSession.ts: usePlayerSession > prepareRestore > begin: await host.request": READMITS,
  "usePlayerSession.ts: usePlayerSession > prepareRestore > begin: catch host.request":
    "the trace restart's rejection, which reports with the Continue's own activation, admitted there (`reportHostError`)",
  "usePlayerSession.ts: usePlayerSession > prepareRestore > begin: catch host.client.request":
    "drops the random release's refusal; nothing follows",
  "usePlayerSession.ts: usePlayerSession > reportHostError > incident: catch origin.bridge.commitIncident":
    "drops the incident's refusal; nothing follows",
  "useActivationRun.ts: useActivationRun > retire: catch ended.bridge.retireRun":
    "drops the retirement's refusal: the record retired already, and nothing follows",
  "useExportCandidate.ts: useExportCandidate > deliver > release: catch host.releaseRecording":
    "drops a release's refusal; nothing follows",
  "useFailureRecording.ts: useFailureRecording > retire: catch state.bridge.releaseRecording":
    "drops a release's refusal; nothing follows",
  "useFailureRecording.ts: useFailureRecording > settle: catch bridge.releaseRecording":
    "drops a release's refusal; nothing follows",
  "usePlayerSession.ts: usePlayerSession > reportHostError: then starting": READMITS,
  "usePlayerSession.ts: usePlayerSession > stopAt: then acknowledged": READMITS,
  // Reached from the activation bodies through the functions they call.
  "useRandomControl.ts: useRandomControl > sendRandomRequest: then host.client.request": READMITS,
  // The clock's section (#1983): its observation, then the caller's body, which re-admits first (checked below).
  "useRuntimeSceneClock.ts: useRuntimeSceneClock > section > bridgeOf(current).section:callback: await observeIn":
    "the section's observation, before the caller's body: the activation work's body re-admits as it begins (`resolveRandomDraw`, checked below)",
  "useRuntimeSceneClock.ts: useRuntimeSceneClock > observeIn: await opened.send":
    "the section's observation, which shows only its own session's publication (`owned`); the body that acts for an activation re-admits first (`resolveRandomDraw`)",
  "useRandomControl.ts: useRandomControl > resolveRandomDraw > ownedSection:callback: await section.send":
    READMITS,
  "useRandomControl.ts: useRandomControl > resolveRandomDraw: catch ownedSection": READMITS,
  "usePlayerSession.ts: usePlayerSession > startFrom: finally settled":
    "clears the in-flight markers it set, only while they are still its own",
  "useDebugModeAndTrace.ts: useDebugModeAndTrace > applyDebugMode: finally bridgeOf.request":
    "clears the Debug mode asked, only while it is still this request's",
  "useDebugModeAndTrace.ts: useDebugModeAndTrace > applyDebugMode: then bridgeOf.request.finally":
    READMITS,
  "useSessionMedia.ts: useSessionMedia > primeAudio: catch element.play":
    "drops a blocked play; nothing follows",
  "usePlayerSession.ts: usePlayerSession > settlePlanJson: catch bridge.client.request":
    "drops the plan JSON's refusal; nothing follows",
  "usePlayerSession.ts: usePlayerSession > loadScriptStorage: await readScriptStorage": SAVED_DATA,
  "usePlayerSession.ts: usePlayerSession > readScriptStorage: await values.load": SAVED_DATA,
  "usePlayerSession.ts: usePlayerSession > readScriptStorage: await capturedMedia.knownReferences.catch":
    SAVED_DATA,
  "usePlayerSession.ts: usePlayerSession > readScriptStorage: catch capturedMedia.knownReferences":
    SAVED_DATA,
  "usePlayerSession.ts: usePlayerSession > keepSessionLater: await Promise.resolve": KEPT_SESSION,
  "usePlayerSession.ts: usePlayerSession > keepSessionLater: await keepOnce": KEPT_SESSION,
  "usePlayerSession.ts: usePlayerSession > keepOnce: await owned": KEPT_SESSION,
  "usePlayerSession.ts: usePlayerSession > owned: await operation": KEPT_SESSION,
  "usePlayerSession.ts: usePlayerSession > keepIn: await capturedMedia.promote": KEPT_SESSION,
  "usePlayerSession.ts: usePlayerSession > keepIn: await ctx.admit": KEPT_SESSION,
  "usePlayerSession.ts: usePlayerSession > keepIn: await discardKeptSession": KEPT_SESSION,
  "usePlayerSession.ts: usePlayerSession > keepIn: await forgetKeptSession": KEPT_SESSION,
  "usePlayerSession.ts: usePlayerSession > keepIn: await insertOrAcceptExisting": KEPT_SESSION,
  "usePlayerSession.ts: usePlayerSession > keepIn: await route.storageRouteNow": KEPT_SESSION,
  "usePlayerSession.ts: usePlayerSession > keepIn: await store.publish": KEPT_SESSION,
  "usePlayerSession.ts: usePlayerSession > forgetKeptSession: await discardKeptSession.then":
    KEPT_SESSION,
  "usePlayerSession.ts: usePlayerSession > forgetKeptSession: then discardKeptSession":
    KEPT_SESSION,
};
/** Calls that re-admit an activation, and calls that request or act for one. */
const ADMITS = /^(?:goesOn|lives|owned|activationRun\.admits)$/u;
const ACTS =
  /^(?:capture|options\.readPhoto|host\.request|host\.halt|stopAt|started|startedSession|reportHostError|origin\.bridge\.commitIncident|origin\.failure\.stopped|host\.captureExport|incident)$/u;

/** Each wait of `file`'s functions within `scope`, with what follows it there. */
function waitsOf(file: string, scope: (path: string) => boolean) {
  const source = ts.createSourceFile(
    file,
    readFileSync(resolve(process.cwd(), file), "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const named = (node: ts.Node): string | null => {
    if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node))
      return node.name?.getText(source) ?? null;
    if (
      (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) &&
      (ts.isVariableDeclaration(node.parent) || ts.isPropertyAssignment(node.parent))
    )
      return node.parent.name.getText(source);
    if (
      (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) &&
      ts.isCallExpression(node.parent)
    )
      return `${node.parent.expression.getText(source)}:callback`;
    return null;
  };
  const waits: { key: string; at: number; after: ts.Node; continuations?: readonly ts.Node[] }[] =
    [];
  // The file's functions held by a name, as `const commit = () => …`.
  const declared = new Map<string, ts.Node>();
  source.forEachChild(function collect(node): void {
    if (
      ts.isVariableDeclaration(node) &&
      node.initializer !== undefined &&
      (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
    )
      declared.set(node.name.getText(source), node.initializer);
    node.forEachChild(collect);
  });
  /** A call chain's names without its arguments, as `bridgeOf.request.finally`. */
  const chain = (node: ts.Node): string =>
    ts.isCallExpression(node)
      ? chain(node.expression)
      : ts.isPropertyAccessExpression(node)
        ? `${chain(node.expression)}.${node.name.text}`
        : ts.isIdentifier(node) || node.kind === ts.SyntaxKind.ThisKeyword
          ? node.getText(source)
          : ts.SyntaxKind[node.kind];
  const visit = (node: ts.Node, path: string[], fn: ts.Node | null): void => {
    const name = named(node);
    const inner = name === null ? path : [...path, name];
    const owner = name === null ? fn : node;
    const where = inner.join(" > ");
    if (scope(where) && owner !== null) {
      const base = `${file.split("/").at(-1)}: ${where}`;
      if (ts.isAwaitExpression(node)) {
        waits.push({ key: `${base}: await ${chain(node.expression)}`, at: node.end, after: owner });
      }
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        ["then", "catch", "finally"].includes(node.expression.name.text)
      ) {
        waits.push({
          key: `${base}: ${node.expression.name.text} ${chain(node.expression.expression)}`,
          at: node.expression.end,
          // A continuation named by its function is checked in that function's body.
          after: node,
          continuations: node.arguments.map((argument) =>
            ts.isIdentifier(argument) ? (declared.get(argument.text) ?? argument) : argument,
          ),
        });
      }
    }
    node.forEachChild((child) => visit(child, inner, owner));
  };
  visit(source, [], null);
  /** Whether a re-admission follows `at` in `within` before the next request, further work or wait. */
  const readmits = (at: number, within: ts.Node): boolean => {
    let admission = Infinity;
    let next = Infinity;
    within.forEachChild(function walk(node): void {
      if (node.pos >= at) {
        if (ts.isCallExpression(node)) {
          const callee = node.expression.getText(source);
          if (ADMITS.test(callee)) admission = Math.min(admission, node.pos);
          else if (ACTS.test(callee)) next = Math.min(next, node.pos);
        }
        if (ts.isAwaitExpression(node)) next = Math.min(next, node.pos);
      }
      node.forEachChild(walk);
    });
    return admission < next;
  };
  return waits.map(({ key, at, after, continuations }) => ({
    key,
    readmits:
      continuations === undefined
        ? readmits(at, after)
        : continuations.every((each) => readmits(each.pos, each)),
  }));
}

/** The names of the functions of `files` that `roots` call by name, transitively, the roots included. */
function reachable(files: readonly string[], roots: readonly string[]): ReadonlySet<string> {
  const functions = new Map<string, ts.Node[]>();
  for (const file of files) {
    const source = ts.createSourceFile(
      file,
      readFileSync(resolve(process.cwd(), file), "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    source.forEachChild(function collect(node): void {
      const add = (name: string, body: ts.Node) =>
        functions.set(name, [...(functions.get(name) ?? []), body]);
      if (ts.isFunctionDeclaration(node) && node.name !== undefined) add(node.name.text, node);
      if (
        ts.isVariableDeclaration(node) &&
        node.initializer !== undefined &&
        (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
      )
        add(node.name.getText(source), node.initializer);
      node.forEachChild(collect);
    });
  }
  const seen = new Set(roots);
  const queue = [...roots];
  for (let name = queue.shift(); name !== undefined; name = queue.shift())
    for (const body of functions.get(name) ?? [])
      body.forEachChild(function walk(node): void {
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
          const callee = node.expression.text;
          if (functions.has(callee) && !seen.has(callee)) {
            seen.add(callee);
            queue.push(callee);
          }
        }
        node.forEachChild(walk);
      });
  return seen;
}

test("every wait of the page's activation work re-admits its activation, or is listed with why it needs none", () => {
  const session = reachable(SESSION_FILES, SESSION_ACTIVATION);
  const found = ACTIVATION_FILES.flatMap((file) =>
    waitsOf(
      file,
      SESSION_FILES.includes(file)
        ? (path) =>
            path
              .split(" > ")
              .slice(1)
              .some((each) => session.has(each))
        : file.endsWith("useRuntimeSceneClock.ts")
          ? (path) => CLOCK_SECTION.some((each) => path === each || path.startsWith(`${each} >`))
          : () => true,
    ),
  );
  assert.deepEqual(
    [...new Set(found.map((each) => each.key))].sort(),
    Object.keys(ACTIVATION_WAITS).sort(),
    "an unlisted or stale wait",
  );
  for (const { key, readmits } of found)
    if (ACTIVATION_WAITS[key] === READMITS) assert.ok(readmits, `${key} re-admits first`);
  // The clock runs a section's observation before its body: a body of the activation work re-admits as it begins.
  // Each `ownedSection` call counts under its innermost named function, in the forms `reachable` follows: a
  // declaration, or an arrow or function expression a variable holds. A body that is not an inline block cannot
  // re-admit first, so it counts as one that does not.
  const bodies: string[] = [];
  for (const file of SESSION_FILES) {
    const source = ts.createSourceFile(
      file,
      readFileSync(resolve(process.cwd(), file), "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    source.forEachChild(function visit(node: ts.Node, owner?: string): void {
      if (ts.isFunctionDeclaration(node) && node.name !== undefined) owner = node.name.text;
      if (
        ts.isVariableDeclaration(node) &&
        node.initializer !== undefined &&
        (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
      )
        owner = node.name.getText(source);
      if (
        ts.isCallExpression(node) &&
        node.expression.getText(source) === "ownedSection" &&
        owner !== undefined &&
        owner !== "ownedSection" &&
        session.has(owner)
      ) {
        const body = node.arguments[2];
        const first =
          body !== undefined &&
          (ts.isArrowFunction(body) || ts.isFunctionExpression(body)) &&
          ts.isBlock(body.body)
            ? (body.body.statements[0]?.getText(source) ?? "")
            : "";
        bodies.push(`${owner}: ${/activationRun\.admits\(/u.test(first)}`);
      }
      node.forEachChild((child) => visit(child, owner));
    });
  }
  assert.deepEqual(bodies, ["resolveRandomDraw: true"], "each section body re-admits first");
});
