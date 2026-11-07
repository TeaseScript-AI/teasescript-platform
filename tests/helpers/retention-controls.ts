import type { PlayerOpsContext } from "../../player/engine-bridge/player-ops.js";
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

/*
 * The retention child of the witness's positive controls (`retention-witness.test.ts`): each case
 * (`observation/holder/piece`) runs Debug's source ops on a connection of its own, tears it down, and then keeps one
 * piece of what the ops made in one kind of holder, so the witness must find it; `clean` keeps none.
 */

const { playerBridgeOps, playerOpsContext } =
  await import("../../player/engine-bridge/player-ops.js");
const { markedProject } = await import("./source-ops-project.js");
const sessions: HostSessions = {
  get: () => undefined,
  add: () => {
    throw new Error("No session in these cases");
  },
  delete: () => {},
  clear: () => {},
};
const freshReach = reach(playerOpsContext()).size;

/** What a holder keeps: a piece of what the ops made, a text or an object. */
type Piece = string | WeakKey;

/** A flat copy of `text`, sharing nothing with it. */
const copy = (text: string) => [...text].join("");

// The holders, each a different way for code to keep a value.
const moduleHeld: unknown[] = [];
const closures: (() => Piece)[] = [];
const weakKeys: object[] = [];
const weakValues = new WeakMap<object, unknown>();
const byToken = new Map<string, unknown>();
const inSet = new Set<unknown>();
const reactions: Promise<unknown>[] = [];
const keys: Record<string, true> = {};
const strings: string[] = [];
class Held {
  static readonly values: unknown[] = [];
}
type Holder = (piece: Piece, text: string, marker: string, name: string) => void;
const HOLDERS: Record<string, Holder> = {
  module: (piece) => void moduleHeld.push(piece),
  closure: (piece) =>
    void closures.push(
      (
        (kept) => () =>
          kept
      )(piece),
    ),
  global: (piece, _text, _marker, name) =>
    void Object.assign(globalThis, { [`retention ${name}`]: piece }),
  mapByToken: (piece, _text, _marker, name) => void byToken.set(name, piece),
  weakMapValue: (piece) => {
    const key = {};
    weakKeys.push(key);
    weakValues.set(key, piece);
  },
  set: (piece) => void inSet.add(piece),
  promiseReaction: (piece) => {
    // The reaction, and the piece with it, hangs on the pending promise.
    const pending = new Promise(() => {});
    void pending.then(() => piece);
    reactions.push(pending);
  },
  timer: (piece) => void setTimeout(() => void piece, 1e9).unref(),
  staticField: (piece) => void Held.values.push(piece),
  arrayElement: (piece) => void moduleHeld.push([[piece]]),
  // These keep strings: the piece's text, or what is made from it.
  propertyKey: (_piece, text) => void (keys[copy(text)] = true),
  slice: (_piece, text) => void strings.push(text.slice(1, Math.max(14, text.length - 1))),
  cons: (_piece, text) => void strings.push(`held: ${text}`),
  lineCopy: (_piece, text, marker) =>
    void strings.push(copy(text.split("\n").find((line) => line.includes(marker))!)),
  splitCons: (_piece, text, marker) => {
    // The marker split across the two leaves of a concatenated string.
    const cut = text.indexOf(marker) + 3;
    strings.push(copy(text.slice(0, cut)) + copy(text.slice(cut)));
  },
};

interface Site {
  readonly path: string;
}
// Every connection, its ops included, until the snapshot.
const connections: { readonly context: WeakKey; readonly ops: unknown }[] = [];

/** The piece `kind` of what the ops made for `token` on `context`. */
async function pieceOf(context: PlayerOpsContext, token: string, kind: string): Promise<Piece> {
  const sidecar = context.debug.sidecars.get(token)!;
  switch (kind) {
    case "sidecarText":
      return (await context.debug.texts.get(token))!;
    case "sidecarFile":
      return sidecar.files[0]!;
    case "renderedLines":
      return context.debug.latestFile!.lines;
    case "plan":
      return context.plans.get(token)!;
    case "sourceElement":
      return context.sources.get(token)![0]!;
    case "tokenArray":
      return sidecar.files[0]!.tokens;
    case "enclosingSpans":
      return sidecar.files[0]!.enclosing;
  }
  throw new Error(`No piece ${kind}`);
}

/** A piece's text: what a holder of strings keeps. */
function textOf(piece: Piece): string {
  if (typeof piece === "string") return piece;
  if (typeof piece === "object" && piece !== null && !Array.isArray(piece) && "source" in piece)
    return String(piece.source);
  return JSON.stringify(piece);
}

async function runCases() {
  const results = [];
  for (const { name, seed } of childCases()) {
    const [, holder, kind] = name.split("/");
    const marker = markerOf(seed);
    const context = playerOpsContext();
    const ops = playerBridgeOps(context);
    connections.push({ context, ops });
    const run = (op: string, args: unknown) => ops[op]!.run(args, sessions, null);
    const compiled = await run("prepare", {
      source: { kind: "source", script: structuredClone(markedProject(marker)) },
    });
    // EVIDENCE: fixture: `prepare` of this project prepares.
    const token = (compiled.result as { plan: string }).plan;
    const metadata = await run("planMetadata", { plan: token });
    // EVIDENCE: fixture: `planMetadata` of a held plan gives its metadata.
    for (const site of (metadata.result as { randomSites: readonly Site[] }).randomSites)
      await run("drawCode", { plan: token, path: site.path, site });
    await run("codeLines", { texts: [`"outcome ${marker}"`], first: 1 });
    const piece = kind === undefined ? null : await pieceOf(context, token, kind);
    const before = heldBefore(context);
    await run("teardown", null);
    if (piece !== null) HOLDERS[holder!]!(piece, textOf(piece), marker, name);
    results.push({ name, extra: reach(context).size - freshReach, before, context });
  }
  return results;
}

const results = await runCases();
await collect();
const report = results.map(({ name, extra, before, context }) => ({
  name,
  extra,
  held: stillHeld(before, context),
}));
process.stdout.write(JSON.stringify({ report, snapshot: await snapshotForRetention() }));
