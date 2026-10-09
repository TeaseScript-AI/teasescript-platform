import { computed, ref, shallowRef, watch } from "vue";
import { tryOnScopeDispose } from "@vueuse/core";
import {
  listRandomSites,
  randomDrawAlternatives,
  type RandomControlOptions,
  type RandomDecision,
  type RandomDrawView,
  type RandomOutcome,
  type RandomSite,
} from "../../../src/index.js";
import { randomOutcomeLabel } from "./randomDrawPresentation";
import type { PlayerSessionHost } from "./usePlayerSession";

/** What a site does when it draws next: ask in the picker, go on naturally, or take its least-taken outcome. */
export type DebugRandomNext = "ask" | "random" | "untried";

/**
 * Debug's random draws (DEBUGGER.md "Random draws"), in the debug room while the Debug features run. With **Choose
 * outcomes** on, the session pauses at every random draw and the picker asks for its outcome, unless the draw's site is
 * set to go on by itself next time: **Random**, its natural outcome, or **Prefer untried**, the outcome the site took
 * least often while Debug chose them; **Least tried** in the picker does the same once. The settings and each site's
 * outcomes, the last `KEPT_OUTCOMES` of them with their numbers and how often it took each, last as long as the Debug
 * features run.
 */
export function useDebugRandom(player: PlayerSessionHost) {
  const enabled = ref(false);
  // A host without a debug room, such as one without script storage, offers none of it.
  const available = computed(() => player.rooms.current.value === "debug");
  const on = computed(() => enabled.value && available.value);
  /** The sites set to something else than Ask, in the order they were set. */
  const settings = shallowRef<ReadonlyMap<string, Exclude<DebugRandomNext, "ask">>>(new Map());
  // Each site's outcomes while Debug decided its draws or the picker resolved them: how often it took each, by key, and
  // the latest as the picker showed them then, since a list's items may change between draws, with how many came
  // before.
  const history = new Map<
    string,
    { readonly counts: Map<string, number>; readonly labels: string[]; dropped: number }
  >();
  const historyRevision = ref(0);
  // What each site took, as `tried` gave it since the history last changed: the same object until then, so the picker,
  // with all its outcomes, renders again only when the history changes.
  let triedRevision = -1;
  const triedSites = new Map<string, DebugRandomTried>();

  /** Records that the draw's site took `outcome`; the returned function takes the record back. */
  function record(draw: RandomDrawView, outcome: RandomOutcome): () => void {
    let site = history.get(draw.site);
    if (site === undefined)
      history.set(draw.site, (site = { counts: new Map(), labels: [], dropped: 0 }));
    const taken = site;
    const key = outcomeKey(outcome);
    taken.counts.set(key, (taken.counts.get(key) ?? 0) + 1);
    taken.labels.push(randomOutcomeLabel(draw, outcome));
    const dropped = taken.labels.length > KEPT_OUTCOMES ? taken.labels.shift() : undefined;
    if (dropped !== undefined) taken.dropped += 1;
    historyRevision.value += 1;
    return () => {
      const count = taken.counts.get(key)! - 1;
      if (count === 0) taken.counts.delete(key);
      else taken.counts.set(key, count);
      taken.labels.pop();
      if (dropped !== undefined) {
        taken.labels.unshift(dropped);
        taken.dropped -= 1;
      }
      historyRevision.value += 1;
    };
  }

  /**
   * The outcome the site took least often: of every outcome when the draw has few, the natural one first on a tie;
   * otherwise of its representative alternatives, as a natural continuous value hardly ever repeats.
   */
  function leastTried(draw: RandomDrawView): RandomOutcome | null {
    const { support } = draw;
    const limit =
      support.kind === "candidates" || support.kind === "weighted"
        ? support.candidates.length
        : undefined;
    const { alternatives, complete } = randomDrawAlternatives(draw, limit);
    const natural = draw.natural.kind === "failure" ? null : draw.natural;
    const pool = complete && natural !== null ? [natural, ...alternatives] : alternatives;
    const counts = history.get(draw.site)?.counts;
    let least: RandomOutcome | null = null;
    let leastCount = Infinity;
    for (const outcome of pool) {
      const times = counts?.get(outcomeKey(outcome)) ?? 0;
      if (times < leastCount) [least, leastCount] = [outcome, times];
    }
    return least;
  }

  function decide(draw: RandomDrawView): RandomDecision {
    const next = settings.value.get(draw.site) ?? "ask";
    if (next === "ask") return { kind: "suspend" };
    const natural = draw.natural.kind === "failure" ? null : draw.natural;
    const outcome = next === "untried" ? leastTried(draw) : natural;
    if (outcome === null || outcome === natural) {
      if (natural !== null) record(draw, natural);
      return { kind: "natural" };
    }
    record(draw, outcome);
    return { kind: "choose", outcome };
  }
  const control: RandomControlOptions = Object.freeze({ decide });
  watch(on, (active) => player.setRandomControl(active ? control : null), { immediate: true });
  tryOnScopeDispose(() => player.setRandomControl(null));

  const plan = computed(() => player.session.value?.plan ?? null);
  const sites = computed(
    () =>
      new Map<string, RandomSite>(
        plan.value === null ? [] : listRandomSites(plan.value).map((site) => [site.id, site]),
      ),
  );
  /** The draw the picker asks about, while Choose outcomes is on. */
  const draw = computed(() => (on.value ? player.randomDraw.value : null));

  /** Resolves the paused draw with `outcome`, or naturally; `false` when the engine did not take it. */
  function resolve(outcome: RandomOutcome | "natural"): boolean {
    const current = draw.value;
    if (current === null) return false;
    // Recorded first: the session goes on at once, and the draws it meets next decide from it.
    const resolved = outcome === "natural" ? current.natural : outcome;
    const undo = resolved.kind === "failure" ? null : record(current, resolved);
    const result = player.resolveRandomDraw(current.drawId, outcome);
    if (result?.kind === "resolved") return true;
    undo?.();
    return false;
  }
  /** Resolves the paused draw once as Prefer untried would: Least tried. */
  function resolveLeastTried(): boolean {
    const current = draw.value;
    if (current === null) return false;
    const outcome = leastTried(current);
    return resolve(outcome === null || outcome === current.natural ? "natural" : outcome);
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
    /**
     * What `site` took: its latest outcomes, oldest first, numbered from `first`, the number of its first draw; and how
     * often it took each outcome, by `outcomeKey`.
     */
    tried(site: string): DebugRandomTried {
      if (triedRevision !== historyRevision.value) {
        triedSites.clear();
        triedRevision = historyRevision.value;
      }
      let tried = triedSites.get(site);
      if (tried === undefined) {
        const taken = history.get(site);
        tried = {
          history: taken === undefined ? [] : [...taken.labels],
          first: (taken?.dropped ?? 0) + 1,
          counts: new Map(taken?.counts),
        };
        triedSites.set(site, tried);
      }
      return tried;
    },
  };
}

/** How many outcomes of a site the picker keeps for its Earlier outcomes; diagnostic tuning, not a script limit. */
const KEPT_OUTCOMES = 1000;

export interface DebugRandomTried {
  readonly history: readonly string[];
  readonly first: number;
  readonly counts: ReadonlyMap<string, number>;
}

/** An outcome's identity: the same value, index, or order is the same outcome. */
export function outcomeKey(outcome: RandomOutcome): string {
  return JSON.stringify(outcome);
}

export type DebugRandom = ReturnType<typeof useDebugRandom>;
