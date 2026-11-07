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
 * The retention child of the witness's positive controls (`retention-witness.test.ts`). A `scan/holder/piece` or
 * `object/holder/piece` case runs Debug's source ops on a connection of its own, tears it down, and then keeps one
 * piece of what the ops made in the holder it names, each holder with a container of its own, so the parent can find
 * that holder on the piece's path. An `object` case also releases its piece, which must then be collected: so that
 * holder alone kept it. A `string/representation/cut` case keeps its marked path in the representation it names,
 * with the marker split at `cut`. `clean` keeps nothing.
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
const PAD = "#".repeat(16);
const keep = () => {};

// The holders' containers, one each, named as the parent finds them on a path.
const moduleHeld: Piece[] = [];
const closures: (() => Piece)[] = [];
const weakKeys: object[] = [];
const weakValues = new WeakMap<object, Piece>();
const byToken = new Map<string, Piece>();
const inSet = new Set<Piece>();
const reactions: Promise<void>[] = [];
const nested: Piece[][][] = [];
// In dictionary mode, so a key is the object's own, not a hidden class's transition.
const keys: Record<string, true> = { mode: true };
Reflect.deleteProperty(keys, "mode");
const slices: string[] = [];
const conses: string[] = [];
const lineCopies: string[] = [];
const splitConses: string[] = [];
const representations: string[] = [];
class Held {
  static readonly values: Piece[] = [];
}
const drop = <T>(list: T[], item: T) => void list.splice(list.indexOf(item), 1);

/** Keeps `piece` in one kind of holder; returns what lets it go again. */
type Holder = (piece: Piece, text: string, marker: string, name: string) => () => void;
const HOLDERS: Record<string, Holder> = {
  module: (piece) => {
    moduleHeld.push(piece);
    return () => drop(moduleHeld, piece);
  },
  closure: (piece) => {
    const read = (
      (kept) => () =>
        kept
    )(piece);
    closures.push(read);
    return () => drop(closures, read);
  },
  global: (piece, _text, _marker, name) => {
    Object.assign(globalThis, { [`retention ${name}`]: piece });
    return () => void Reflect.deleteProperty(globalThis, `retention ${name}`);
  },
  mapByToken: (piece, _text, _marker, name) => {
    byToken.set(name, piece);
    return () => void byToken.delete(name);
  },
  weakMapValue: (piece) => {
    const key = {};
    weakKeys.push(key);
    weakValues.set(key, piece);
    return () => drop(weakKeys, key);
  },
  set: (piece) => {
    inSet.add(piece);
    return () => void inSet.delete(piece);
  },
  promiseReaction: (piece) => {
    // The reaction, and the piece with it, hangs on the pending promise until it settles.
    let settle = () => {};
    const pending = new Promise<void>((resolve) => (settle = resolve));
    void pending.then(() => piece);
    reactions.push(pending);
    return () => {
      settle();
      drop(reactions, pending);
    };
  },
  timer: (piece) => {
    const timer = setTimeout(() => void piece, 1e9).unref();
    return () => clearTimeout(timer);
  },
  staticField: (piece) => {
    Held.values.push(piece);
    return () => drop(Held.values, piece);
  },
  arrayElement: (piece) => {
    const element = [[piece]];
    nested.push(element);
    return () => drop(nested, element);
  },
  // These keep strings: the piece's text, or what is made from it.
  propertyKey: (_piece, text) => {
    keys[copy(text)] = true;
    return keep;
  },
  slice: (_piece, text) => {
    slices.push(text.slice(1, Math.max(14, text.length - 1)));
    return keep;
  },
  cons: (_piece, text) => {
    conses.push(`held: ${text}`);
    return keep;
  },
  lineCopy: (_piece, text, marker) => {
    lineCopies.push(copy(text.split("\n").find((line) => line.includes(marker))!));
    return keep;
  },
  splitCons: (_piece, text, marker) => {
    // The marker split across the two leaves of a concatenated string.
    const cut = text.indexOf(marker) + 3;
    splitConses.push(copy(text.slice(0, cut)) + copy(text.slice(cut)));
    return keep;
  },
};

/**
 * A text split in two at the marker's cut, held as one flat string; two leaves; two leaves, the first itself two; a
 * slice of a longer string; two leaves, the first or the second a slice of a longer string; or one flat string so long
 * that only a snapshot without a string limit keeps its marker.
 */
const REPRESENTATIONS: Record<string, (left: string, right: string) => string> = {
  flat: (left, right) => copy(left + right),
  cons: (left, right) => copy(left) + copy(right),
  nestedCons: (left, right) => copy("nested/") + copy(left) + copy(right),
  slice: (left, right) => copy(PAD + left + right + PAD).slice(PAD.length, -PAD.length),
  sliceInConsLeft: (left, right) => copy(PAD + left + PAD).slice(0, -PAD.length) + copy(right),
  sliceInConsRight: (left, right) => copy(left) + copy(PAD + right + PAD).slice(PAD.length),
  long: (left, right) => copy("x".repeat(70_000) + left + right),
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
  if (typeof piece === "object" && !Array.isArray(piece) && "source" in piece)
    return String(piece.source);
  return JSON.stringify(piece);
}

async function runCases() {
  const results = [];
  const releases: (() => void)[] = [];
  for (const { name, seed } of childCases()) {
    const [observation, holder, kind] = name.split("/");
    const marker = markerOf(seed);
    if (observation === "string") {
      // The project's marked path, held in the representation the case names.
      const { path } = markedProject(marker).files[0]!;
      const cut = path.indexOf(marker) + Number(kind);
      representations.push(REPRESENTATIONS[holder!]!(path.slice(0, cut), path.slice(cut)));
      results.push({ name, extra: 0, before: [], context: {}, releases: false });
      continue;
    }
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
    if (piece !== null) {
      const release = HOLDERS[holder!]!(piece, textOf(piece), marker, name);
      if (observation === "object") releases.push(release);
    }
    results.push({
      name,
      extra: reach(context).size - freshReach,
      before,
      context,
      releases: observation === "object",
    });
  }
  return { results, releases };
}

/** Calls each release in a frame of its own, which keeps none of them once it returns. */
function letGo(releases: (() => void)[]): void {
  for (const release of releases.splice(0)) release();
}

const { results, releases } = await runCases();
await collect();
const held = results.map(({ before, context }) => stillHeld(before, context));
// Each object case's holder lets its piece go: then it must be collected.
letGo(releases);
await collect();
const report = results.map(({ name, extra, before, context, releases: let_go }, index) => ({
  name,
  extra,
  held: held[index]!,
  released: let_go ? stillHeld(before, context) : 0,
}));
process.stdout.write(JSON.stringify({ report, snapshot: await snapshotForRetention() }));
