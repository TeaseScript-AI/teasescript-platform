import type { RandomSite } from "../../../src/playback.js";
import {
  loadSourceDebugSidecar,
  type SourceDebugFile,
  type SourceDebugSidecar,
} from "../../../src/runtime/debug/source-sidecar.js";
import type { DrawCode } from "../../vue/src/randomDrawPresentation.js";
import { exactly, isRecord, isStringArray } from "../argument-checks.js";
import type { PlayerOpsContext } from "../player-ops.js";
import type { BridgeOps } from "../worker-host.js";

/**
 * The ops of family L5i (the L5 series) for Debug's source views: the code of a random draw's file, and earlier outcomes
 * as code. Both are made here, in the Worker, from the source it compiled, so the Player's page holds no parser.
 */
export function debugOps(context: PlayerOpsContext): BridgeOps {
  // The sidecar text made from each plan's sources, once Debug asks; `null` for one it could not make. Keyed by the
  // sources themselves and the plans the connection holds, so what `teardown` drops the caches drop with it.
  const texts = new WeakMap<object, Promise<string | null>>();
  const textOf = (token: string): Promise<string | null> | null => {
    const files = context.sources.get(token);
    const plan = context.plans.get(token);
    if (files === undefined || plan === undefined) return null;
    let text = texts.get(files);
    if (text === undefined) {
      text = import("../../../src/index.js").then(
        ({ createSourceDebugSidecar }) => createSourceDebugSidecar(files, plan),
        () => null,
      );
      texts.set(files, text);
    }
    return text;
  };
  // The sidecar bound to each plan Debug asked about, once found.
  const bound = new WeakMap<object, SourceDebugSidecar>();
  /**
   * The sidecar for plan `token`, read as playback reads one: its own, or, for a plan the Worker did not compile itself,
   * such as a restored session's, one made for another plan; the loader accepts a sidecar only for the plan it is bound
   * to, so another plan's sources never show. A plan the connection no longer holds has none.
   */
  async function sidecarOf(token: string): Promise<SourceDebugSidecar | null> {
    const plan = context.plans.get(token);
    if (plan === undefined) return null;
    const known = bound.get(plan);
    if (known !== undefined) return known;
    const candidates = context.sources.has(token) ? [token] : [...context.sources.keys()];
    for (const candidate of candidates) {
      const text = await textOf(candidate);
      // A teardown while the sidecar was made leaves the plan nothing.
      if (context.plans.get(token) !== plan) return null;
      if (text === null) continue;
      const load = loadSourceDebugSidecar(text, plan);
      if (load.kind !== "valid") continue;
      bound.set(plan, load.sidecar);
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
        const sidecar = await sidecarOf(plan);
        const file: SourceDebugFile | undefined = sidecar?.files.find((each) => each.path === path);
        if (file === undefined) return { result: null };
        const { drawCode } = await import("../../random-draw-code.js");
        const code: DrawCode | null = drawCode(file, site);
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
        const { outcomeLines } = await import("../../random-draw-code.js");
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
