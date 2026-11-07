import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { compilePlayerProject } from "../player/compile-project.js";
import { BridgeRequestError, connectBridge } from "../player/engine-bridge/client.js";
import { nodeWorkerPort } from "../player/engine-bridge/node-client.js";
import type { PrepareResult, PrepareSource } from "../player/engine-bridge/player-ops.js";
import { PlayerBridge } from "../player/player-bridge.js";
import { drawCode, fileCode, outcomeLines } from "../player/random-draw-code.js";
import { createSourceDebugSidecar, listRandomSites } from "../src/index.js";
import { loadSourceDebugSidecar } from "../src/runtime/debug/source-sidecar.js";
import { serializeValidatedRuntimeJson } from "../src/runtime/snapshot/checkpoint-json.js";
import { inProcessBridge } from "./helpers/in-process-bridge.js";

/*
 * L5i.2: Debug's random-draw picker gets its code from the engine's Worker. `drawCode` makes the excerpt from the
 * plan's source debug sidecar, which the Worker makes from the sources it compiled and reads back with L0's loader, so
 * a plan it did not compile gets the excerpt only when the sidecar is bound to it; `codeLines` classifies outcomes.
 */

const BUILD = { commit: null, dirty: null, mode: null, appVersion: null };
const WORKER = new URL("../player/engine-bridge/node-worker.js", import.meta.url);

/** Two files, a draw in each, the second inside a function. */
const PROJECT = {
  files: [
    {
      path: "rooms/dice.tease",
      source: [
        "// Dice.",
        "global function rollTwice {",
        "    let first = randomInteger(1..=6)",
        '    say "First: ${first}", instant',
        "}",
      ].join("\n"),
    },
    { path: "main.tease", source: 'let hit = chance(50)\nrollTwice()\nshowButton "Done"\nexit' },
  ],
};
const OTHER = 'let coin = chance(25)\nshowButton "Other"\nexit';

async function prepared(bridge: PlayerBridge, source: PrepareSource): Promise<string> {
  const reply = await bridge.client.request("prepare", { source });
  // EVIDENCE: validation: `prepare` replies from the same build with its result.
  const result = reply.result as PrepareResult;
  if (result.kind !== "prepared") throw new Error(`The script did not prepare: ${result.kind}`);
  return result.plan;
}
const asPlanText = (script: string | typeof PROJECT): PrepareSource => ({
  kind: "plan",
  text: serializeValidatedRuntimeJson(compilePlayerProject(script).plan!),
});

/** The oracle: each site's excerpt made from the sidecar of the project's own compilation. */
function oracle() {
  const plan = compilePlayerProject(PROJECT).plan!;
  const load = loadSourceDebugSidecar(createSourceDebugSidecar(PROJECT.files, plan), plan);
  assert.equal(load.kind, "valid");
  const files = load.kind === "valid" ? load.sidecar.files : [];
  return listRandomSites(plan).map((site) => ({
    site,
    code: drawCode(fileCode(files.find((file) => file.path === site.path)!), site),
  }));
}

/** What the ops answer on `bridge`, for a source plan, the same plan as text, another plan, and malformed arguments. */
async function tape(bridge: PlayerBridge) {
  const source = await prepared(bridge, { kind: "source", script: PROJECT });
  const sameAsText = await prepared(bridge, asPlanText(PROJECT));
  const other = await prepared(bridge, asPlanText(OTHER));
  const sites = oracle().map(({ site }) => site);
  const code = (plan: string, site: (typeof sites)[number]) =>
    bridge.client
      .request("drawCode", { plan, path: site.path, site })
      .then((reply) => reply.result);
  const steps = {
    source: await Promise.all(sites.map((site) => code(source, site))),
    // A restored session's plan: the same plan under another token, which the Worker did not compile.
    sameAsText: await Promise.all(sites.map((site) => code(sameAsText, site))),
    // Another plan: the sources the Worker holds are not its sources.
    other: await code(other, listRandomSites(compilePlayerProject(OTHER).plan!)[0]!),
    unknown: await code("p999", sites[0]!),
    lines: (
      await bridge.client.request("codeLines", { texts: ['["red", "blue"]', "true"], first: 4 })
    ).result,
  };
  for (const args of [
    { plan: source, path: "main.tease" },
    { plan: source, path: "main.tease", site: { ...sites[0]!, line: 0 } },
    { plan: 1, path: "main.tease", site: sites[0]! },
  ])
    await assert.rejects(
      bridge.client.request("drawCode", args),
      (error: unknown) => error instanceof BridgeRequestError && error.code === "arguments",
    );
  for (const args of [
    { texts: [1], first: 1 },
    { texts: ["x"], first: 1.5 },
  ])
    await assert.rejects(
      bridge.client.request("codeLines", args),
      (error: unknown) => error instanceof BridgeRequestError && error.code === "arguments",
    );
  // After `teardown` the connection holds no plan, so no plan's code, not even one asked about before.
  await bridge.client.request("teardown", null);
  const afterTeardown = await Promise.all([code(source, sites[0]!), code(sameAsText, sites[0]!)]);
  return { ...steps, afterTeardown };
}

test("the draw's code comes from the sources the Worker compiled, the same in-process and in a Worker", async () => {
  const expected = oracle();
  const inProcess = await tape(await inProcessBridge());
  assert.deepEqual(
    inProcess.source,
    expected.map(({ code }) => code),
  );
  // The sidecar is bound to the plan, not to its token: the same plan restored gets its code.
  assert.deepEqual(inProcess.sameAsText, inProcess.source);
  // Another plan's draw gets none from these sources, nor an unknown plan.
  assert.deepEqual([inProcess.other, inProcess.unknown], [null, null]);
  assert.deepEqual(inProcess.lines, outcomeLines(['["red", "blue"]', "true"], 4));
  assert.deepEqual(inProcess.afterTeardown, [null, null]);
  const worker = new PlayerBridge(await connectBridge(nodeWorkerPort(WORKER, BUILD), BUILD));
  try {
    assert.deepEqual(await tape(worker), inProcess);
  } finally {
    worker.client.terminate();
  }
});

test("a published plan with no sources gives no code", async () => {
  const bridge = await inProcessBridge();
  const plan = await prepared(bridge, asPlanText(OTHER));
  const [site] = listRandomSites(compilePlayerProject(OTHER).plan!);
  const reply = await bridge.client.request("drawCode", { plan, path: site!.path, site });
  assert.equal(reply.result, null);
});

test("after teardown nothing the source ops touched stays held: no plan, its sources or a debug file", () => {
  const url = (path: string) => JSON.stringify(new URL(path, import.meta.url).href);
  // In a child with a forced collection: a weak reference to each value stored under a plan token, wherever its cache
  // is, and to each debug file the excerpt is made from, wherever it is kept.
  const script = [
    'import { registerHooks } from "node:module";',
    "const held = [];",
    "const keep = (kind, value) => held.push({ kind, ref: new WeakRef(value) });",
    "const set = Map.prototype.set;",
    "Map.prototype.set = function (key, value) {",
    '  if (typeof key === "string" && /^p[0-9]+$/.test(key) && typeof value === "object" && value !== null) keep(key, value);',
    "  return set.call(this, key, value);",
    "};",
    'globalThis.__keepFile = (file) => keep("file", file);',
    `const drawModule = ${url("../player/random-draw-code.js")};`,
    "registerHooks({ load(target, context, next) {",
    "  const result = next(target, context);",
    "  if (target !== drawModule) return result;",
    '  const anchor = "export function fileCode(file) {";',
    "  const source = String(result.source);",
    '  if (!source.includes(anchor)) throw new Error("fileCode moved");',
    '  return { ...result, source: source.replace(anchor, anchor + " globalThis.__keepFile(file);") };',
    "} });",
    `const { createInProcessBackend } = await import(${url("../player/engine-bridge/in-process.js")});`,
    "const { client } = createInProcessBackend({ commit: null, dirty: null, mode: null, appVersion: null });",
    `const project = ${JSON.stringify(PROJECT)};`,
    'const source = (await client.request("prepare", { source: { kind: "source", script: project } })).result;',
    `const text = ${JSON.stringify(serializeValidatedRuntimeJson(compilePlayerProject(PROJECT).plan!))};`,
    'const restored = (await client.request("prepare", { source: { kind: "plan", text } })).result;',
    "for (const { plan } of [source, restored]) {",
    '  const { randomSites } = (await client.request("planMetadata", { plan })).result;',
    "  for (const site of randomSites)",
    '    if ((await client.request("drawCode", { plan, path: site.path, site })).result === null) throw new Error("no code");',
    "}",
    'await client.request("codeLines", { texts: ["true"], first: 1 });',
    'await client.request("teardown", null);',
    "for (let round = 0; round < 8; round += 1) {",
    "  await new Promise((resolve) => setImmediate(resolve));",
    "  globalThis.gc();",
    "}",
    "const kinds = (list) => list.map(({ kind }) => kind);",
    "process.stdout.write(JSON.stringify({ touched: kinds(held), retained: kinds(held.filter(({ ref }) => ref.deref() !== undefined)) }));",
    "client.terminate();",
  ].join("\n");
  const child = spawnSync(process.execPath, ["--expose-gc", "--input-type=module", "-e", script], {
    encoding: "utf8",
    cwd: fileURLToPath(new URL(".", import.meta.url)),
  });
  assert.equal(child.status, 0, child.stderr);
  // EVIDENCE: fixture: the child script writes the JSON of what it touched and what stayed held.
  const { touched, retained } = JSON.parse(child.stdout) as {
    readonly touched: readonly string[];
    readonly retained: readonly string[];
  };
  // Both plans, the compiled one's sources, and the debug files the excerpts were made from were seen.
  assert.ok(touched.includes("p1") && touched.includes("p2"), touched.join());
  assert.ok(touched.filter((kind) => kind === "file").length >= 2, touched.join());
  assert.deepEqual(retained, []);
});
