import type { DrawResolution, ResolveDrawResult } from "../../../../../engine-bridge/ops/random.js";
import type { Origin } from "../useActivationRun.js";

/*
 * The draw's resolution (session split S2): letting the random draw the session is paused at go on, for the activation
 * that shows it, in one section of the session. The section is a bound facade: its send and its publication admit the
 * origin at their action, and its revision, publication and clock rebase happen only while the origin lives.
 */

/** The section a draw resolves in, as the work holds it. */
export interface DrawSection {
  /** The draw the observed session is paused at, or `null` (no session, a stopped one, none paused). */
  readonly drawId: number | null;
  /** Resolves the draw in the host. */
  send(resolution: {
    readonly drawId: number;
    readonly outcome: DrawResolution;
    readonly record: { readonly resetAt: number } | null;
  }): Promise<ResolveDrawResult>;
  /** Whether the section's session still owns the UI. */
  owned(): boolean;
  /** Shows the section's session; `false` when it no longer owns the UI. */
  publish(): boolean;
}

/** What the draw's resolution needs from the random control's owner. */
export interface DrawPage {
  readonly admits: (origin: Origin) => boolean;
  /** Runs `body` in a section of the shown session, which admits `origin` before it begins. */
  readonly section: (
    body: (section: DrawSection) => Promise<ResolveDrawResult["outcome"] | null>,
  ) => Promise<ResolveDrawResult["outcome"] | null>;
  readonly inspecting: () => boolean;
  readonly disposed: () => boolean;
  /** Takes the history's revision. */
  readonly revision: (revision: number) => void;
  /** The session's clock goes on from the time it paused at. */
  readonly rebase: () => void;
  /** Whether a failure is no error stop (it ends quietly, is a refusal, or the Player was unmounted). */
  readonly quiet: (error: unknown) => boolean;
  /** The activation error-stop sink, which admits `origin`. */
  readonly report: (origin: Origin, error: unknown) => void;
}

/** Resolves draw `drawId` with `outcome` (into the history with `record`) for `origin`: the outcome, or `null`. */
export function resolveDrawFor(
  drawId: number,
  outcome: DrawResolution,
  record: { readonly resetAt: number } | null,
  origin: Origin,
  page: DrawPage,
): Promise<ResolveDrawResult["outcome"] | null> {
  const resolved = page.section(async (section) => {
    // Paused at the draw, the session observes no time; a stopped session gives none.
    if (section.drawId !== drawId || page.inspecting()) return null;
    const result = await section.send({ drawId, outcome, record });
    if (page.disposed() || !page.admits(origin)) return null;
    page.revision(result.revision);
    if (!section.owned() || !section.publish()) return null;
    page.rebase();
    return result.outcome;
  });
  return resolved.catch((error: unknown) => {
    if (page.quiet(error)) return null;
    page.report(origin, error);
    return null;
  });
}
