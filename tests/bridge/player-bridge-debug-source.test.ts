import assert from "node:assert/strict";
import test from "node:test";

import { compilePlayerProject } from "../../player/runtime/compile-project.js";
import { BridgeRequestError, connectBridge } from "../../player/engine-bridge/client.js";
import { nodeWorkerPort } from "../../player/engine-bridge/node-client.js";
import type { PrepareResult, PrepareSource } from "../../player/engine-bridge/player-ops.js";
import { PlayerBridge } from "../../player/runtime/player-bridge.js";
import { drawCode, fileCode, outcomeLines } from "../../player/debug/random-draw-code.js";
import { createSourceDebugSidecar, listRandomSites } from "../../src/index.js";
import { loadSourceDebugSidecar } from "../../src/runtime/debug/source-sidecar.js";
import { serializeValidatedRuntimeJson } from "../../src/runtime/snapshot/checkpoint-json.js";
import { inProcessBridge } from "../helpers/in-process-bridge.js";
import { runRetentionChild } from "../helpers/retention-witness.js";
import { PROJECT } from "../helpers/bridge/source-ops-project.js";
import { asMalformed } from "../helpers/bridge/untyped.js";

/*
 * L5i.2: Debug's random-draw picker gets its code from the engine's Worker. `drawCode` makes the excerpt from the
 * plan's source debug sidecar, which the Worker makes from the sources it compiled and reads back with L0's loader, so
 * a plan it did not compile gets the excerpt only when the sidecar is bound to it; `codeLines` classifies outcomes.
 */

const BUILD = { commit: null, dirty: null, mode: null, appVersion: null };
const WORKER = new URL("../../player/engine-bridge/node-worker.js", import.meta.url);

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
    // Malformed on purpose, as the rows below: the host refuses them.
    await assert.rejects(
      bridge.client.request("drawCode", asMalformed(args)),
      (error: unknown) => error instanceof BridgeRequestError && error.code === "arguments",
    );
  for (const args of [
    { texts: [1], first: 1 },
    { texts: ["x"], first: 1.5 },
  ])
    await assert.rejects(
      bridge.client.request("codeLines", asMalformed(args)),
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
  const reply = await bridge.client.request("drawCode", { plan, path: site!.path, site: site! });
  assert.equal(reply.result, null);
});

/*
 * Session data held beyond teardown, as an invariant over a generated family: every route a plan's code comes by, and
 * every point a `drawCode` can complete at, against a teardown. Through the retention witness: no string with the
 * case's marker stays anywhere, the torn-down connection reaches no more than a fresh one, and nothing it reached
 * before stays alive elsewhere.
 */
const AXES = {
  route: ["source", "restored"],
  completion: ["settled", "duringSidecar", "duringRenderer"],
} as const;
const CASES = AXES.route.flatMap((route) =>
  AXES.completion.map((completion) => `${route}/${completion}`),
);

test("after teardown nothing the source ops touched stays held, however a request completes", () => {
  const { report, hits } = runRetentionChild(
    new URL("../helpers/source-ops-lifecycle.js", import.meta.url),
    CASES,
  );
  // EVIDENCE: fixture: the child reports one entry per case it was given.
  const reports = report as readonly {
    readonly name: string;
    readonly late: "none" | "code" | "no code";
    readonly extra: number;
    readonly held: number;
  }[];
  // Coverage, from the names the child reports: every axis value, and every pair of them.
  const names = reports.map(({ name }) => name.split("/"));
  for (const [axis, values] of Object.values(AXES).entries())
    for (const value of values)
      assert.ok(
        names.some((name) => name[axis] === value),
        value,
      );
  for (const route of AXES.route)
    for (const completion of AXES.completion)
      assert.ok(
        names.some(([r, c]) => r === route && c === completion),
        `${route}/${completion}`,
      );
  for (const { name, late, extra, held } of reports) {
    assert.deepEqual(hits.get(name), [], `${name}: no string with its marker stays`);
    assert.equal(extra, 0, `${name}: the torn-down connection reaches what a fresh one does`);
    assert.equal(held, 0, `${name}: nothing the connection reached stays alive`);
    // A request torn down under it answers no code.
    assert.equal(late, name.endsWith("/settled") ? "none" : "no code", name);
  }
});
