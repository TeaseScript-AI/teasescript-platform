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
  // The sidecar text of each plan the Worker compiled, made once Debug asks; `null` for one it could not make.
  const texts = new Map<string, Promise<string | null>>();
  const textOf = (token: string): Promise<string | null> => {
    let text = texts.get(token);
    if (text === undefined) {
      const files = context.sources.get(token)!;
      const plan = context.plans.get(token)!;
      text = import("../../../src/index.js").then(
        ({ createSourceDebugSidecar }) => createSourceDebugSidecar(files, plan),
        () => null,
      );
      texts.set(token, text);
    }
    return text;
  };
  // The loaded sidecar of each plan Debug asked about.
  const loaded = new Map<string, Promise<SourceDebugSidecar | null>>();
  /**
   * The sidecar for plan `token`, read as playback reads one: its own, or, for a plan the Worker did not compile itself,
   * such as a restored session's, one made for another plan; the loader accepts a sidecar only for the plan it is bound
   * to, so another plan's sources never show.
   */
  async function bound(token: string): Promise<SourceDebugSidecar | null> {
    const plan = context.plans.get(token);
    if (plan === undefined) return null;
    const candidates = context.sources.has(token) ? [token] : [...context.sources.keys()];
    for (const candidate of candidates) {
      const text = await textOf(candidate);
      if (text === null) continue;
      const load = loadSourceDebugSidecar(text, plan);
      if (load.kind === "valid") return load.sidecar;
    }
    return null;
  }
  const sidecarOf = (token: string): Promise<SourceDebugSidecar | null> => {
    let sidecar = loaded.get(token);
    if (sidecar === undefined) loaded.set(token, (sidecar = bound(token)));
    return sidecar;
  };
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
