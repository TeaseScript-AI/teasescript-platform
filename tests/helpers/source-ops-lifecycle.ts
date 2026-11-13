import { registerHooks } from "node:module";

import type { HostSessions } from "../../player/engine-bridge/worker-host.js";
import {
  childCases,
  collect,
  heldBefore,
  markerOf,
  reach,
  snapshotForRetention,
  stillHeld,
} from "./retention-child.js";
import { deliveredRun } from "./bridge/delivered-run.js";

/*
 * The retention child of the lifecycle invariant in `player-bridge-debug-source.test.ts` (see `retention-witness.ts`):
 * each case it is given (`route/completion`) runs Debug's source ops on a connection of its own with its marked
 * project, and tears it down; `completion` pauses `drawCode` at an await and closes the connection there, as its
 * Worker's loss does (the host runs no other op while one is awaited). Module state carries from case to case, as the
 * Worker's does.
 */

// Where `drawCode` can be paused: after its sidecar's text arrives, and after the renderer loads.
const POINTS = {
  sidecar: "const text = await textOf(candidate);",
  renderer: 'const { drawCode, fileCode } = await import("../../debug/random-draw-code.js");',
};
let pause: {
  readonly point: string;
  readonly reached: () => void;
  readonly released: Promise<void>;
} | null = null;
Object.assign(globalThis, {
  __sourceOpsGate: async (point: string) => {
    const current = pause;
    if (current?.point !== point) return;
    pause = null;
    current.reached();
    await current.released;
  },
});
const sourceViewOps = new URL("../../player/engine-bridge/ops/source-views.js", import.meta.url)
  .href;
registerHooks({
  load(url, context, next) {
    const result = next(url, context);
    if (url !== sourceViewOps) return result;
    let source = String(result.source);
    for (const [point, anchor] of Object.entries(POINTS)) {
      if (!source.includes(anchor)) throw new Error(`The lifecycle anchor moved: ${anchor}`);
      source = source.replace(
        anchor,
        `${anchor} await globalThis.__sourceOpsGate(${JSON.stringify(point)});`,
      );
    }
    return { ...result, source };
  },
});

const { closeConnection, playerBridgeOps, playerOpsContext } =
  await import("../../player/engine-bridge/player-ops.js");
const { markedProject, planText } = await import("./bridge/source-ops-project.js");
const sessions: HostSessions = {
  get: () => undefined,
  add: () => {
    throw new Error("No session in these cases");
  },
  delete: () => {},
  clear: () => {},
};
const freshReach = reach(playerOpsContext()).size;

interface Site {
  readonly path: string;
}
// Every connection, its ops included, until the snapshot: what they still hold counts as held.
const connections: { readonly context: WeakKey; readonly ops: unknown }[] = [];

/** Runs every case; returns only what the parent reads, and what was held, as weak references. */
async function runCases() {
  const results = [];
  for (const { name, seed } of childCases()) {
    const [route, completion] = name.split("/");
    const context = playerOpsContext();
    const ops = playerBridgeOps(context);
    connections.push({ context, ops });
    const run = deliveredRun(context, ops, sessions);
    const project = markedProject(markerOf(seed));
    // The transport hands an op a copy of its arguments.
    const compiled = await run("prepare", {
      source: { kind: "source", script: structuredClone(project) },
    });
    const published = await run("prepare", { source: { kind: "plan", text: planText(project) } });
    // EVIDENCE: fixture: `prepare` of this project prepares.
    const source = (compiled.result as { plan: string }).plan;
    // EVIDENCE: fixture: `prepare` of this project's plan prepares.
    const restored = (published.result as { plan: string }).plan;
    const [asked, other] = route === "source" ? [source, restored] : [restored, source];
    const metadata = await run("planMetadata", { plan: asked });
    // EVIDENCE: fixture: `planMetadata` of a held plan gives its metadata.
    const sites = (metadata.result as { randomSites: readonly Site[] }).randomSites;
    await run("planMetadata", { plan: other });
    await run("codeLines", { texts: [`"outcome ${markerOf(seed)}"`], first: 1 });
    for (const site of sites) await run("drawCode", { plan: other, path: site.path, site });
    let late: "none" | "code" | "no code" = "none";
    let before: readonly WeakRef<WeakKey>[];
    if (completion === "settled") {
      for (const site of sites) await run("drawCode", { plan: asked, path: site.path, site });
      before = heldBefore(context);
      await run("teardown", null);
    } else {
      // The asked plan's first `drawCode`, paused at the await `completion` names, its connection closed there.
      let reached = () => {};
      let release = () => {};
      const atPoint = new Promise<void>((resolve) => (reached = resolve));
      const released = new Promise<void>((resolve) => (release = resolve));
      pause = { point: completion === "duringSidecar" ? "sidecar" : "renderer", reached, released };
      const pending = run("drawCode", { plan: asked, path: sites[0]!.path, site: sites[0] });
      await atPoint;
      before = heldBefore(context);
      closeConnection(context, sessions);
      release();
      // What the request does after the close stays for the witness to find; refused, it answers no code either.
      late = await pending.then(
        (outcome) => (outcome.result === null ? "no code" : "code"),
        () => "no code",
      );
    }
    // A torn-down connection reaches what a fresh one does: its containers, empty.
    results.push({ name, late, extra: reach(context).size - freshReach, before, context });
  }
  return results;
}

const results = await runCases();
await collect();
const report = results.map(({ name, late, extra, before, context }) => ({
  name,
  late,
  extra,
  held: stillHeld(before, context),
}));
process.stdout.write(JSON.stringify({ report, snapshot: await snapshotForRetention() }));
