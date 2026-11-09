import type { RandomDecision, RandomDrawView, RandomOutcome } from "../../src/index.js";
import { randomDrawAlternatives } from "../../src/runtime/random/random-alternatives.js";
import { outcomeKey, randomOutcomeLabel } from "./random-outcomes.js";

/*
 * Debug's random decisions (DEBUGGER.md "Random draws"), in the engine's host: what each site does next, and what each
 * site took while Debug decided its draws or the picker resolved them. The Player sends the settings; the history is
 * the host's own, made from the draws the host saw.
 */

/** What a site does when it draws next, other than ask: go on naturally, or take its least-taken outcome. */
export type RandomNext = "random" | "untried";

/** How many outcomes of a site the history keeps for the picker's Earlier outcomes; diagnostic tuning, not a limit. */
const KEPT_OUTCOMES = 1000;

/** What a site took: its latest outcomes, oldest first, numbered from `first`; and how often it took each, by key. */
export interface RandomTried {
  readonly history: readonly string[];
  readonly first: number;
  readonly counts: readonly (readonly [string, number])[];
}

interface SiteHistory {
  readonly counts: Map<string, number>;
  readonly labels: string[];
  dropped: number;
}

/** Each site's outcomes, as the picker shows them, with a revision that every change raises. */
export class RandomHistory {
  readonly #sites = new Map<string, SiteHistory>();
  #revision = 0;

  get revision(): number {
    return this.#revision;
  }

  /**
   * Records that the draw's site took `outcome`. The returned rollback restores the history exactly as it was, with its
   * revision and without a site this record made; it is for a record nothing changed after, as a refused resolution.
   */
  record(draw: RandomDrawView, outcome: RandomOutcome): () => void {
    // Whole or nothing: what can throw is computed before anything changes.
    const key = outcomeKey(outcome);
    const label = randomOutcomeLabel(draw, outcome);
    const revision = this.#revision;
    let site = this.#sites.get(draw.site);
    const made = site === undefined;
    if (site === undefined)
      this.#sites.set(draw.site, (site = { counts: new Map(), labels: [], dropped: 0 }));
    const taken = site;
    taken.counts.set(key, (taken.counts.get(key) ?? 0) + 1);
    taken.labels.push(label);
    const dropped = taken.labels.length > KEPT_OUTCOMES ? taken.labels.shift() : undefined;
    if (dropped !== undefined) taken.dropped += 1;
    this.#revision += 1;
    return () => {
      this.#revision = revision;
      if (made) return void this.#sites.delete(draw.site);
      const count = taken.counts.get(key)! - 1;
      if (count === 0) taken.counts.delete(key);
      else taken.counts.set(key, count);
      taken.labels.pop();
      if (dropped !== undefined) {
        taken.labels.unshift(dropped);
        taken.dropped -= 1;
      }
    };
  }

  /** Forgets every site, as when the Debug features end. */
  clear(): void {
    this.#sites.clear();
    this.#revision += 1;
  }

  /** What `site` took. */
  tried(site: string): RandomTried {
    const taken = this.#sites.get(site);
    return {
      history: taken === undefined ? [] : [...taken.labels],
      first: (taken?.dropped ?? 0) + 1,
      counts: taken === undefined ? [] : [...taken.counts],
    };
  }

  /**
   * The outcome the site took least often: of every outcome when the draw has few, the natural one first on a tie;
   * otherwise of its representative alternatives, as a natural continuous value hardly ever repeats.
   */
  leastTried(draw: RandomDrawView): RandomOutcome | null {
    const { support } = draw;
    const limit =
      support.kind === "candidates" || support.kind === "weighted"
        ? support.candidates.length
        : undefined;
    const { alternatives, complete } = randomDrawAlternatives(draw, limit);
    const natural = draw.natural.kind === "failure" ? null : draw.natural;
    const pool = complete && natural !== null ? [natural, ...alternatives] : alternatives;
    const counts = this.#sites.get(draw.site)?.counts;
    let least: RandomOutcome | null = null;
    let leastCount = Infinity;
    for (const outcome of pool) {
      const times = counts?.get(outcomeKey(outcome)) ?? 0;
      if (times < leastCount) [least, leastCount] = [outcome, times];
    }
    return least;
  }
}

/**
 * Decides a draw as its site's setting says: ask (pause), go on naturally, or take its least-tried outcome; a draw it
 * decides is recorded.
 */
export function decideDraw(
  settings: ReadonlyMap<string, RandomNext>,
  history: RandomHistory,
  draw: RandomDrawView,
): RandomDecision {
  const next = settings.get(draw.site);
  if (next === undefined) return { kind: "suspend" };
  const natural = draw.natural.kind === "failure" ? null : draw.natural;
  const outcome = next === "untried" ? history.leastTried(draw) : natural;
  if (outcome === null || outcome === natural) {
    if (natural !== null) history.record(draw, natural);
    return { kind: "natural" };
  }
  history.record(draw, outcome);
  return { kind: "choose", outcome };
}
