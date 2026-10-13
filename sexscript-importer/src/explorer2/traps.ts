/**
 * Explorer V2's light trap detection (design section 5): the places plays asked the player, each in its relevant state,
 * and which place each answer led to. A loop with no way out is a set of such places that lead only to each other,
 * where every answer was tried and no play ended from inside. It is reported with the shortest play that came into it,
 * qualified: no way out was found, as far as the relevant state tells places apart.
 */
import type { Data, ExplorerInput, RandomChoice, StorageEntry } from "../explorer.ts";
import { withChosenDraws, type DrawEvent, type Played } from "./runner.ts";

/** What a trap's witness needs of a play: its inputs, the outcomes its draws had, and how its session started. */
interface Witness {
  readonly inputs: readonly ExplorerInput[];
  readonly draws: readonly DrawEvent[];
  readonly storage?: readonly StorageEntry[];
  readonly wallClockMs?: number;
}

/** A loop with no way out, as V2 reports it. */
export interface Trap {
  readonly kind: "loop";
  /** Places (in their relevant states) in the loops at these locations. */
  readonly states: number;
  /** Where the player is asked inside it, as `path:line`. */
  readonly locations: readonly string[];
  /**
   * The shortest play into it: its inputs up to the first place in the loop, the outcomes its draws had, and how its
   * session started (storage and wall clock, when not the usual).
   */
  readonly inputs: readonly ExplorerInput[];
  /** The outcomes its start drew that the play fixed (see `withChosenDraws`). */
  readonly random?: readonly RandomChoice[];
  readonly draws: readonly { occurrence: number; outcome: Data }[];
  readonly storage?: readonly StorageEntry[];
  readonly wallClockMs?: number;
}

interface Place {
  readonly instruction: number;
  readonly state: string;
  readonly options: readonly ExplorerInput[];
  readonly next: Set<string>;
  /** Whether a play ended (exited or failed) after an answer here. */
  exits: boolean;
  /**
   * Whether a condition that reads the clock ran, or a random draw was made, after an answer here: where the place
   * leads may then change as time passes or with another outcome, which the relevant state does not tell.
   */
  uncertain: boolean;
  /** The play that came here in the fewest steps, and its step here. */
  witness: Witness;
  step: number;
}

export class Places {
  readonly #places = new Map<string, Place>();

  /** Records the places a play asked at and where each answer led; `readsClock` tells a condition that reads the clock. */
  add(played: Played, readsClock: (instruction: number) => boolean): void {
    const uncertainSteps = new Set([
      ...played.decisions
        .filter((decision) => readsClock(decision.instruction))
        .map((decision) => decision.step),
      ...played.draws.map((draw) => draw.step),
    ]);
    const witness: Witness = {
      inputs: played.inputs,
      draws: played.draws,
      ...(played.path.storage === undefined ? {} : { storage: played.path.storage }),
      ...(played.path.wallClockMs === undefined ? {} : { wallClockMs: played.path.wallClockMs }),
    };
    let previous: Place | null = null;
    for (const [step, interaction] of played.interactions.entries()) {
      const key = `${interaction.instruction}|${interaction.state}`;
      let place = this.#places.get(key);
      if (place === undefined) {
        place = {
          instruction: interaction.instruction,
          state: interaction.state,
          options: interaction.options,
          next: new Set(),
          exits: false,
          uncertain: false,
          witness,
          step,
        };
        this.#places.set(key, place);
      } else if (step < place.step) {
        place.witness = witness;
        place.step = step;
      }
      previous?.next.add(key);
      // The answer here leads on through the decisions of the next step.
      if (step < played.inputs.length && uncertainSteps.has(step + 1)) place.uncertain = true;
      previous = step < played.inputs.length ? place : null;
    }
    if ((played.end === "exit" || played.end === "failed") && previous !== null)
      previous.exits = true;
  }

  /**
   * The loops with no way out: sets of places that lead only to each other (more than one place, or one that leads to
   * itself) without a condition on the clock or a random draw between them, where every answer offered was given
   * (`given` holds `instruction|answer|state` keys) and none is typed, and no play ended.
   */
  traps(given: ReadonlySet<string>, location: (instruction: number) => string): Trap[] {
    // A place that asks for a text or a form with typed fields is never done: the player may type anything else.
    const done = (place: Place) =>
      place.options.length > 0 &&
      place.options.every((option) => option.kind !== "text" && option.kind !== "form") &&
      !place.exits &&
      !place.uncertain &&
      place.options.every((option) =>
        given.has(`${place.instruction}|${JSON.stringify(option)}|${place.state}`),
      );
    // One trap per set of locations: loops at the same places in other relevant states are the same loop to a creator.
    const traps = new Map<string, Trap>();
    for (const component of components(this.#places)) {
      const inside = new Set(component);
      const places = component.map((key) => this.#places.get(key)!);
      const loops = component.length > 1 || places[0]!.next.has(component[0]!);
      if (!loops) continue;
      if (!places.every((place) => done(place) && [...place.next].every((key) => inside.has(key))))
        continue;
      const entry = places.reduce((best, place) => (place.step < best.step ? place : best));
      const locations = [...new Set(places.map((place) => location(place.instruction)))].sort();
      const key = locations.join(" ");
      const known = traps.get(key);
      if (known !== undefined && known.inputs.length <= entry.step) {
        traps.set(key, { ...known, states: known.states + places.length });
        continue;
      }
      traps.set(key, {
        kind: "loop",
        states: places.length + (known?.states ?? 0),
        locations,
        ...withChosenDraws(
          entry.witness.inputs.slice(0, entry.step),
          entry.witness.draws.filter((draw) => draw.step <= entry.step),
        ),
        // The outcomes of the draws made before it.
        draws: entry.witness.draws
          .filter((draw) => draw.step <= entry.step)
          .map((draw) => ({ occurrence: draw.occurrence, outcome: draw.outcome })),
        ...(entry.witness.storage === undefined ? {} : { storage: entry.witness.storage }),
        ...(entry.witness.wallClockMs === undefined
          ? {}
          : { wallClockMs: entry.witness.wallClockMs }),
      });
    }
    return [...traps.values()];
  }
}

/** The strongly connected components of the places' graph (Tarjan's algorithm, without recursion). */
function components(places: ReadonlyMap<string, Place>): string[][] {
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const found: string[][] = [];
  let counter = 0;
  for (const root of places.keys()) {
    if (index.has(root)) continue;
    const work: { key: string; next: Iterator<string> }[] = [];
    const open = (key: string) => {
      index.set(key, counter);
      low.set(key, counter);
      counter += 1;
      stack.push(key);
      onStack.add(key);
      work.push({ key, next: (places.get(key)?.next ?? new Set<string>()).values() });
    };
    open(root);
    while (work.length > 0) {
      const top = work[work.length - 1]!;
      const step = top.next.next();
      if (!step.done) {
        const next = step.value;
        if (!index.has(next)) open(next);
        else if (onStack.has(next)) low.set(top.key, Math.min(low.get(top.key)!, index.get(next)!));
        continue;
      }
      work.pop();
      if (work.length > 0) {
        const parent = work[work.length - 1]!.key;
        low.set(parent, Math.min(low.get(parent)!, low.get(top.key)!));
      }
      if (low.get(top.key) === index.get(top.key)) {
        const component: string[] = [];
        for (;;) {
          const key = stack.pop()!;
          onStack.delete(key);
          component.push(key);
          if (key === top.key) break;
        }
        found.push(component);
      }
    }
  }
  return found;
}
