import { registerHooks } from "node:module";

import type { HostSessions } from "../../player/engine-bridge/worker-host.js";

/*
 * The child of the lifecycle invariant in `player-bridge-debug-source.test.ts`, run with `--expose-gc`: every case its
 * argument names (`route/completion`) runs Debug's source ops on a fresh connection, tears it down, collects, and
 * reports what stayed held. Watched is every object reachable from a value the ops store under a plan token, in any map,
 * and every debug file an excerpt is made from; `completion` pauses `drawCode` at an await and tears down there. This
 * process's module state carries from case to case, as the Worker's does.
 */

interface Watched {
  readonly kind: string;
  readonly ref: WeakRef<WeakKey>;
}
let watched: Watched[] = [];
const seen = new WeakSet<WeakKey>();
function watch(kind: string, value: WeakKey): void {
  if (seen.has(value)) return;
  seen.add(value);
  watched.push({ kind, ref: new WeakRef(value) });
  for (const item of Object.values(value))
    if (typeof item === "object" && item !== null) watch(kind, item);
}
const set = Map.prototype.set;
Map.prototype.set = function <K, V>(this: Map<K, V>, key: K, value: V) {
  if (
    typeof key === "string" &&
    /^p[0-9]+$/.test(key) &&
    typeof value === "object" &&
    value !== null
  )
    watch(
      value instanceof Promise ? "text" : Array.isArray(value) ? "sources" : "plan or sidecar",
      value,
    );
  return set.call(this, key, value);
};

// Where `drawCode` can be paused: after its sidecar's text arrives, and after the renderer loads.
const POINTS = {
  sidecar: "const text = await textOf(candidate);",
  renderer: 'const { drawCode, fileCode } = await import("../../random-draw-code.js");',
};
let pause: {
  readonly point: string;
  readonly reached: () => void;
  readonly released: Promise<void>;
} | null = null;
const hooks = {
  // A debug file is watched as one even when reached before from its sidecar.
  watchFile: (file: WeakKey) => void watched.push({ kind: "file", ref: new WeakRef(file) }),
  gate: async (point: string) => {
    const current = pause;
    if (current?.point !== point) return;
    pause = null;
    current.reached();
    await current.released;
  },
};
Object.assign(globalThis, { __sourceOpsLifecycle: hooks });
const at = (name: string) => new URL(`../../player/${name}`, import.meta.url).href;
registerHooks({
  load(url, context, next) {
    const result = next(url, context);
    const edits: [string, string][] =
      url === at("engine-bridge/ops/debug.js")
        ? Object.entries(POINTS).map(([point, anchor]) => [
            anchor,
            `${anchor} await globalThis.__sourceOpsLifecycle.gate(${JSON.stringify(point)});`,
          ])
        : url === at("random-draw-code.js")
          ? [
              [
                "export function fileCode(file) {",
                "$& globalThis.__sourceOpsLifecycle.watchFile(file);",
              ],
            ]
          : [];
    if (edits.length === 0) return result;
    let source = String(result.source);
    for (const [anchor, edit] of edits) {
      if (!source.includes(anchor)) throw new Error(`The lifecycle anchor moved: ${anchor}`);
      source = source.replace(anchor, edit.replace("$&", anchor));
    }
    return { ...result, source };
  },
});

const { playerBridgeOps, playerOpsContext } =
  await import("../../player/engine-bridge/player-ops.js");
const { PROJECT, PROJECT_PLAN } = await import("./source-ops-project.js");
// EVIDENCE: fixture: the test passes its case names as a JSON array of strings.
const names = JSON.parse(process.argv[2]!) as string[];
const collect = globalThis.gc;
if (collect === undefined) throw new Error("Run with --expose-gc");
const sessions: HostSessions = {
  get: () => undefined,
  add: () => {
    throw new Error("No session in these cases");
  },
  delete: () => {},
  clear: () => {},
};

interface Site {
  readonly path: string;
}
const reports = [];
for (const name of names) {
  const [route, completion] = name.split("/");
  watched = [];
  const context = playerOpsContext();
  const ops = playerBridgeOps(context);
  const run = (op: string, args: unknown) => ops[op]!.run(args, sessions, null);
  // The transport hands an op a copy of its arguments, so none stays held by this module.
  const compiled = await run("prepare", {
    source: { kind: "source", script: structuredClone(PROJECT) },
  });
  const published = await run("prepare", { source: { kind: "plan", text: PROJECT_PLAN } });
  // EVIDENCE: fixture: `prepare` of this project prepares.
  const source = (compiled.result as { plan: string }).plan;
  // EVIDENCE: fixture: `prepare` of this project's plan prepares.
  const restored = (published.result as { plan: string }).plan;
  const [asked, other] = route === "source" ? [source, restored] : [restored, source];
  const metadata = await run("planMetadata", { plan: asked });
  // EVIDENCE: fixture: `planMetadata` of a held plan gives its metadata.
  const sites = (metadata.result as { randomSites: readonly Site[] }).randomSites;
  await run("planMetadata", { plan: other });
  await run("codeLines", { texts: ["true"], first: 1 });
  for (const site of sites) await run("drawCode", { plan: other, path: site.path, site });
  let late: "none" | "code" | "no code" = "none";
  if (completion === "settled") {
    for (const site of sites) await run("drawCode", { plan: asked, path: site.path, site });
    await run("teardown", null);
  } else {
    // The asked plan's first `drawCode`, paused at the await `completion` names, with the connection torn down there.
    let reached = () => {};
    let release = () => {};
    const atPoint = new Promise<void>((resolve) => (reached = resolve));
    const released = new Promise<void>((resolve) => (release = resolve));
    pause = { point: completion === "duringSidecar" ? "sidecar" : "renderer", reached, released };
    const pending = run("drawCode", { plan: asked, path: sites[0]!.path, site: sites[0] });
    await atPoint;
    await run("teardown", null);
    release();
    // What the request does after the one teardown stays for the collection to find.
    late = (await pending).result === null ? "no code" : "code";
  }
  for (let round = 0; round < 8; round += 1) {
    await new Promise((resolve) => setImmediate(resolve));
    collect();
  }
  const kinds = (list: readonly Watched[]) => [...new Set(list.map(({ kind }) => kind))].sort();
  reports.push({
    name,
    late,
    touched: kinds(watched),
    retained: kinds(watched.filter(({ ref }) => ref.deref() !== undefined)),
    // The connection itself stays referenced here, so what it still holds counts as held.
    context: context.plans.size,
  });
}
process.stdout.write(JSON.stringify(reports));
