import type { RandomSite } from "../../../src/playback.js";
import {
  loadSourceDebugSidecar,
  type SourceDebugFile,
  type SourceDebugSidecar,
} from "../../../src/runtime/debug/source-sidecar.js";
import type { FileCode } from "../../debug/random-draw-code.js";
import type { DrawCode } from "../../debug/draw-code.js";
import { exactly, isRecord, isStringArray } from "../argument-checks.js";
import type { PlayerOpsContext } from "../player-ops.js";
import { type DeliveryOwner, OwnedCell, OwnedMap } from "../delivery.js";
import type { BridgeOps } from "../worker-host.js";

/*
 * The ops of family L5i (the L5 series) for Debug's source views: the code of a random draw's file, and earlier outcomes
 * as code. Both are made here, in the Worker, from the source it compiled, so the Player's page holds no parser. Debug's
 * trace and its script Debug mode are the trace ops' (`ops/trace.ts`).
 */
/**
 * What the source-view ops keep between requests: every one of the connection's, owned by its ops context, which clears
 * them on `teardown`. Nothing else holds a plan, its sources or its debug files.
 */
export class SourceViewCaches {
  /** The sidecar text made from each compiled plan's sources, by token; `null` for one it could not make. */
  readonly texts: OwnedMap<string, Promise<string | null>>;
  /** The sidecar bound to each plan Debug asked about, by token, once found. */
  readonly sidecars: OwnedMap<string, SourceDebugSidecar>;
  /** The file of the latest draw: a file's draws often follow each other, as in a loop. */
  readonly latestFile: OwnedCell<FileCode>;

  /** Caches owned by the connection's deliveries (`delivery.ts`). */
  constructor(owner: DeliveryOwner) {
    this.texts = new OwnedMap(owner);
    this.sidecars = new OwnedMap(owner);
    this.latestFile = new OwnedCell(owner);
  }

  clear(): void {
    this.texts.clear();
    this.sidecars.clear();
    this.latestFile.clear();
  }
}

export function sourceViewOps(context: PlayerOpsContext): BridgeOps {
  const caches = context.sourceViews;
  const textOf = (token: string): Promise<string | null> | null => {
    const files = context.sources.get(token);
    const plan = context.plans.get(token);
    if (files === undefined || plan === undefined) return null;
    let text = caches.texts.get(token);
    if (text === undefined) {
      const made = import("../../../src/index.js").then(
        ({ createSourceDebugSidecar }) => createSourceDebugSidecar(files, plan),
        () => null,
      );
      caches.texts.set(token, made);
      text = made;
    }
    return text;
  };
  /**
   * The sidecar for plan `token`, read as playback reads one: its own, or, for a plan the Worker did not compile itself,
   * such as a restored session's, one made for another plan; the loader accepts a sidecar only for the plan it is bound
   * to, so another plan's sources never show. A plan the connection no longer holds has none.
   */
  async function sidecarOf(token: string): Promise<SourceDebugSidecar | null> {
    const plan = context.plans.get(token);
    if (plan === undefined) return null;
    const known = caches.sidecars.get(token);
    if (known !== undefined) return known;
    const candidates = context.sources.has(token) ? [token] : [...context.sources.keys()];
    for (const candidate of candidates) {
      const text = await textOf(candidate);
      // A teardown while the sidecar was made leaves the plan nothing.
      if (context.plans.get(token) !== plan) return null;
      if (text === null) continue;
      const load = loadSourceDebugSidecar(text, plan);
      if (load.kind !== "valid") continue;
      caches.sidecars.set(token, load.sidecar);
      return load.sidecar;
    }
    return null;
  }
  return {
    drawCode: {
      session: "none",
      checkArguments: (args) =>
        isRecord(args) &&
        exactly(args, ["plan", "path", "site"]) &&
        typeof args.plan === "string" &&
        typeof args.path === "string" &&
        isSite(args.site),
      run: async (args) => {
        // EVIDENCE: validation: checkArguments accepted these arguments before run.
        const { plan, path, site } = args as {
          readonly plan: string;
          readonly path: string;
          readonly site: RandomSite;
        };
        const held = context.plans.get(plan);
        const sidecar = await sidecarOf(plan);
        const file: SourceDebugFile | undefined = sidecar?.files.find((each) => each.path === path);
        if (file === undefined) return { result: null };
        const { drawCode, fileCode } = await import("../../debug/random-draw-code.js");
        // A teardown during the import leaves nothing to keep.
        if (context.plans.get(plan) !== held) return { result: null };
        if (caches.latestFile.value?.file !== file) caches.latestFile.set(fileCode(file));
        const code: DrawCode | null = drawCode(caches.latestFile.value!, site);
        return { result: code };
      },
    },
    codeLines: {
      session: "none",
      checkArguments: (args) =>
        isRecord(args) &&
        exactly(args, ["texts", "first"]) &&
        isStringArray(args.texts) &&
        typeof args.first === "number" &&
        Number.isSafeInteger(args.first),
      run: async (args) => {
        // EVIDENCE: validation: checkArguments accepted these arguments before run.
        const { texts, first } = args as {
          readonly texts: readonly string[];
          readonly first: number;
        };
        // Nothing to classify loads no tooling.
        if (texts.length === 0) return { result: [] };
        const { outcomeLines } = await import("../../debug/random-draw-code.js");
        return { result: outcomeLines(texts, first) };
      },
    },
  };
}

const isPosition = (value: unknown) =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
/** A random site's place in its file, as `PlanMetadata.randomSites` gives it: the fields the code reads. */
const isSite = (value: unknown): boolean =>
  isRecord(value) &&
  ["line", "column", "endLine", "endColumn"].every((key) => isPosition(value[key]));
