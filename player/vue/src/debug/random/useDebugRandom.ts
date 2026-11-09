import { computed, ref, shallowRef, watch } from "vue";
import { tryOnScopeDispose } from "@vueuse/core";
import type { PlanMetadata } from "../../../../engine-bridge/player-ops.js";
import type { RandomOutcome, RandomSite } from "../../../../../src/index.js";
import type { CodeLine, DrawCode } from "./randomDrawPresentation";
import {
  drawIdentity,
  drawKey,
  sameDraw,
  type DrawIdentity,
} from "../../../../debug/random-draw-identity.js";
import type { PlayerSessionHost } from "../../session/usePlayerSession";

/** What a site does when it draws next: ask in the picker, go on naturally, or take its least-taken outcome. */
export type DebugRandomNext = "ask" | "random" | "untried";

/**
 * Debug's random draws (DEBUGGER.md "Random draws"), in the debug room while the Debug features run. With **Choose
 * outcomes** on, the session pauses at every random draw and the picker asks for its outcome, unless the draw's site is
 * set to go on by itself next time: **Random**, its natural outcome, or **Prefer untried**, the outcome the site took
 * least often while Debug chose them; **Least tried** in the picker does the same once. The engine's host decides and
 * keeps each site's outcomes (`random-decisions.ts`), the last `KEPT_OUTCOMES` of them with their numbers and how often
 * it took each, as long as the Debug features run; this keeps the settings and shows what the host replies.
 */
export function useDebugRandom(player: PlayerSessionHost) {
  const enabled = ref(false);
  // A host without a debug room, such as one without script storage, offers none of it.
  const available = computed(() => player.rooms.current.value === "debug");
  const on = computed(() => enabled.value && available.value);
  /** The sites set to something else than Ask, in the order they were set. */
  const settings = shallowRef<ReadonlyMap<string, Exclude<DebugRandomNext, "ask">>>(new Map());
  // Each change goes to the host as a whole, at once, so it comes before whatever the picker sends next in the session's
  // turn, as a change took effect at once when it was decided here: the host decides from what it was sent last.
  watch(
    [on, settings],
    ([active, sites]) => player.setRandomControl(active ? { sites: [...sites] } : null),
    { immediate: true, flush: "sync" },
  );
  tryOnScopeDispose(() => player.forgetRandomHistory());

  // The plan's random sites, from its host by the plan's token, which is unique only within its connection. A reply is
  // taken only while its connection and token still show.
  const sites = shallowRef<ReadonlyMap<string, RandomSite>>(new Map());
  watch(
    [() => player.session.value?.connection ?? null, () => player.session.value?.planToken ?? null],
    ([connection, plan]) => {
      sites.value = new Map();
      if (connection === null || plan === null) return;
      connection.client.request("planMetadata", { plan }).then(
        (reply) => {
          const shown = player.session.value;
          if (shown?.connection !== connection || shown.planToken !== plan) return;
          // EVIDENCE: validation: `planMetadata` replies from the same build with the plan's metadata, or null.
          const metadata = reply.result as PlanMetadata | null;
          sites.value = new Map((metadata?.randomSites ?? []).map((site) => [site.id, site]));
        },
        // A lost Worker gives no sites.
        () => {},
      );
    },
    { immediate: true },
  );
  /** The draw the picker asks about, while Choose outcomes is on. */
  const draw = computed(() => (on.value ? player.randomDraw.value : null));
  // The code the picker shows for the draw, and its site's earlier outcomes as code, made in the engine's Worker. A reply
  // is taken only while its draw, its plan and the outcomes it was made for still show.
  const code = shallowRef<DrawCode | null>(null);
  const historyLines = shallowRef<readonly CodeLine[]>([]);
  watch(
    [draw, sites, () => player.session.value?.planToken ?? null],
    ([current, known, plan]) => {
      code.value = null;
      const site = current === null ? undefined : known.get(current.site);
      const shown = player.session.value;
      if (site === undefined || plan === null || shown === null) return;
      shown.connection.client.request("drawCode", { plan, path: site.path, site }).then(
        (reply) => {
          if (draw.value !== current || player.session.value?.planToken !== plan) return;
          // EVIDENCE: validation: `drawCode` replies from the same build with the draw's code, or null.
          code.value = reply.result as DrawCode | null;
        },
        () => {},
      );
    },
    { immediate: true },
  );
  // What the draw's site took, as the host's history gave it: read again when another draw shows or the history changed.
  // Only the reply to the latest read shows, and only while its draw does (`sameDraw`); another draw shows nothing until
  // its own.
  const tried = shallowRef<{ readonly site: string; readonly tried: DebugRandomTried } | null>(
    null,
  );
  let reads = 0;
  // What was read last: the same draw at the same revision, shown again by a newer publication, reads nothing anew.
  let readFor: { readonly identity: DrawIdentity | null; readonly revision: number } | null = null;
  watch(
    [() => drawIdentity(draw.value, player.session.value), player.randomRevision],
    ([identity, revision]) => {
      if (readFor !== null && sameDraw(identity, readFor.identity) && revision === readFor.revision)
        return;
      if (!sameDraw(identity, readFor?.identity ?? null)) tried.value = null;
      readFor = { identity, revision };
      const read = ++reads;
      if (identity === null) return;
      void player.randomTried(identity.site).then((view) => {
        if (read !== reads || !sameDraw(drawIdentity(draw.value, player.session.value), identity))
          return;
        tried.value =
          view === null
            ? null
            : {
                site: identity.site,
                tried: { history: view.history, first: view.first, counts: new Map(view.counts) },
              };
      });
    },
    { immediate: true },
  );
  // The site's earlier outcomes as code, made in the engine's Worker, for the outcomes they were made for only.
  watch(
    tried,
    (known) => {
      historyLines.value = [];
      const shown = player.session.value;
      if (known === null || known.tried.history.length === 0 || shown === null) return;
      shown.connection.client
        .request("codeLines", { texts: known.tried.history, first: known.tried.first })
        .then(
          (reply) => {
            if (tried.value !== known) return;
            // EVIDENCE: validation: `codeLines` replies from the same build with the outcomes' code lines.
            historyLines.value = reply.result as readonly CodeLine[];
          },
          () => {},
        );
    },
    { immediate: true },
  );

  // The picker's resolutions in flight, each of one draw: a second click on that draw does nothing until the first is
  // answered, and each clears only its own when it ends. Another draw, such as a replacement session's with the same ID,
  // resolves meanwhile.
  const resolving = new Map<object, DrawIdentity>();
  /**
   * Resolves the paused draw in the host with `outcome`, naturally, or with its site's least-tried outcome (Least
   * tried); the outcome goes into the site's history. `false` when the engine did not take it.
   */
  async function resolve(outcome: RandomOutcome | "natural" | "untried"): Promise<boolean> {
    const identity = drawIdentity(draw.value, player.session.value);
    if (identity === null || [...resolving.values()].some((each) => sameDraw(each, identity)))
      return false;
    const token = {};
    resolving.set(token, identity);
    try {
      const result = await player.resolveRandomDraw(identity.drawId, outcome, true);
      return result?.kind === "resolved";
    } finally {
      resolving.delete(token);
    }
  }
  /** Resolves the paused draw once as Prefer untried would: Least tried. */
  const resolveLeastTried = () => resolve("untried");

  /**
   * What `site` took, as the host last gave it for the draw shown: its latest outcomes, oldest first, numbered from
   * `first`, the number of its first draw; and how often it took each outcome, by `outcomeKey`. Nothing until the host
   * answered.
   */
  function triedOf(site: string): DebugRandomTried {
    const known = tried.value;
    return known !== null && known.site === site ? known.tried : NOTHING_TRIED;
  }

  function setNext(site: string, next: DebugRandomNext) {
    const changed = new Map(settings.value);
    if (next === "ask") changed.delete(site);
    else changed.set(site, next);
    settings.value = changed;
  }

  return {
    /** Whether the debug room is shown, the only place the panel offers random draws. */
    available,
    /** The panel's Choose outcomes switch. */
    enabled,
    draw,
    sites,
    /** What `site` does next time it draws. */
    next: (site: string): DebugRandomNext => settings.value.get(site) ?? "ask",
    setNext,
    /** The sites set to Random or Prefer untried, in the order they were set. */
    settings: computed(() => [...settings.value].map(([site, next]) => ({ site, next }))),
    resolve,
    resolveLeastTried,
    /** What `site` took; see `triedOf`. */
    tried: triedOf,
    /** The shown draw's identity (`drawKey`), or `null` without one. */
    drawKey: computed(() => {
      const identity = drawIdentity(draw.value, player.session.value);
      return identity === null ? null : drawKey(identity);
    }),
    /** The code the picker shows for the draw: its file with the draw marked, or `null` without the file's source. */
    code,
    /** The draw's site's earlier outcomes as code lines, as `tried` gives them. */
    historyLines,
  };
}

export interface DebugRandomTried {
  readonly history: readonly string[];
  readonly first: number;
  readonly counts: ReadonlyMap<string, number>;
}

const NOTHING_TRIED: DebugRandomTried = Object.freeze({ history: [], first: 1, counts: new Map() });

export type DebugRandom = ReturnType<typeof useDebugRandom>;
