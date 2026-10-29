import type { PlaceId, TypeTerm } from "../../graph.js";
import type { Consumers } from "../consumers.js";
import { termAt, typeTags, writtenOf } from "../contract.js";
import { keep, keptSlice, type WorkLedger } from "../budget.js";
import { keptKey, keptKeyBelow, sortCost, type Definition, type Key } from "../definitions.js";
import { STOPPED } from "../items.js";
import { propertyName } from "../program.js";
import type { StoreStep } from "../result.js";
import { unrestricted } from "../admission/permitted.js";
import { markNames, storeMark, type MarkNames } from "./fresh.js";
import { storeWarning } from "./warnings.js";

// The stores at, below and above a stopped decision (S3 §5, #1416, #1440): each one's obligation kept whole, or its
// value marked.

/**
 * A decision that stopped stands for its obligations (S3 §5), the stores' above its key among them: a whole store, an
 * argument or an add into the same place at a path above the key, whose value holds it, and whose own path's decision
 * checks nothing below that path. Each such store owes its check when the script runs, at its own site with the stop's
 * context, as `requiredStores` resolves it. A store at or below a stopped key is that key's own (#1275,
 * `stoppedStores`, resolved alike), a sibling's path no store of the stop's. Found by one walk down each stopped path
 * that no other stop lies above (`outermost`), through the stored keys' trie (`Admission.stored`), each destination
 * resolved once a pass whatever number of stops lie below it. Run after the pass's decisions, in every pass that
 * carries a stop: a restarted pass rebuilds it from the stopped set (TABLE r4.180), the fresh pass from the written
 * types alone (`freshStores`).
 */
export function enclosingStores(walk: Consumers): void {
  const { program, definitions, contract } = walk.pass;
  if (!contract.anyStopped) return;
  const work = program.work;
  // (shortest first, so each meets every stop above it among those placed before it)
  const stops = [...contract.stoppedKeys()].sort((a, b) => a.path.length - b.path.length);
  work.charge("checks", stops.length + sortCost(stops.length));
  const placed = new Map<PlaceId, StopNode>();
  for (const { place, path } of stops) {
    // (a stop below another stands under the other's stores)
    if (!outermost(work, placed, place, path)) continue;
    for (const { key, depth } of walk.admission.stored.along(place, path, false)) {
      if (!walk.enclosed.has(key)) {
        walk.enclosed.add(key);
        requiredStores(walk, place, keptSlice(work, path, 0, depth), false, [
          ...(definitions.byKey.get(key) ?? []).filter((d) => d.kind === "whole"),
          ...(definitions.deadArguments.get(key) ?? []),
        ]);
      }
      // (an add stores at its receiver's element: above the stop where the path goes on below that element)
      if (path[depth] === "element" && depth + 1 < path.length && !walk.enclosedAdds.has(key)) {
        walk.enclosedAdds.add(key);
        requiredStores(
          walk,
          place,
          keptSlice(work, path, 0, depth + 1),
          false,
          (definitions.byKey.get(key) ?? []).filter((d) => d.kind === "add"),
        );
      }
    }
  }
}

/** A step of the stopped paths placed so far (`outermost`): its steps below, and whether a stop's path ends there. */
interface StopNode {
  readonly below: Map<string, StopNode>;
  stop: boolean;
}

/**
 * Places a stop's path among those placed before it (none longer): `false` where one of them lies at or above it, found
 * by walking its steps as far as it reaches such a stop, so a stop below another costs the steps to that one alone.
 */
function outermost(
  work: WorkLedger,
  placed: Map<PlaceId, StopNode>,
  place: PlaceId,
  path: readonly string[],
): boolean {
  let node = placed.get(place);
  if (node === undefined) placed.set(place, (node = { below: new Map(), stop: false }));
  for (const step of path) {
    work.charge("checks");
    if (node.stop) return false;
    let next = node.below.get(step);
    if (next === undefined) {
      keep(work, 2);
      node.below.set(step, (next = { below: new Map(), stop: false }));
    }
    node = next;
  }
  if (node.stop) return false;
  node.stop = true;
  return true;
}

/**
 * The stores into `place` at `path`, a stop at or above the path (`stopped`, #1440: `Consumers.stoppedStores`) or
 * below it: each checked against its destination's complete type where admission proves it apart from the stopped
 * decisions (`storeRequirement`), that type carried into the plan whole (`requirements`), else marked with its type
 * undecided; a store the pass rejected keeps its error alone. Once a destination and pass, by its callers.
 */
export function requiredStores(
  walk: Consumers,
  place: PlaceId,
  path: readonly string[],
  stopped: boolean,
  stores: readonly Definition[],
): void {
  if (stores.length === 0) return;
  walk.pass.program.work.charge("checks", stores.length);
  // (the fresh pass after a stop before admission settled decides no inferred place: TABLE r4.135)
  const requirement = walk.admission.storeRequirement(
    place,
    path,
    stopped,
    !walk.finishing || walk.settled,
  );
  // (an unrestricted written part, or a copy's, admits every value: no store owes it anything)
  if (requirement !== null && unrestricted(requirement)) return;
  if (requirement !== null)
    walk.requirements.set(keptKey(walk.pass.program.work, place, path), requirement);
  // (what the marks name, the destination's, made once for all its stores: Codex r1's N1 on #1434)
  let names: MarkNames | undefined;
  const named = (): MarkNames =>
    (names ??= markNames(walk, place, path, stepsOf(walk, place, path)));
  for (const d of stores)
    // (a store this pass rejected has its error, which stands: A6)
    if (d.value === undefined || walk.admission.refused.has(d.uid)) continue;
    else if (requirement === null) storeMark(walk, d, path, named);
    else requiredMark(walk, d, requirement, named);
}

/**
 * A destination's steps (`StoreStep`) by one walk down its path, asking no contract (Astra's B1 and Codex r2's
 * blocker on #1434: a contract question per prefix decodes and formats each whole prefix again): a property by its
 * name, an element step by the collection the written type there holds, its place's own or the copy's that the first
 * prefix a copy decides retained (A4: the copied type is the place's below it), else by the kinds this pass decided or
 * A3 settled the prefix by, else labelled a list, conservatively, where this pass retains no collection name for it
 * (its contract may hold a set or a dict there, Codex r3: the label names no type and changes no message). Each
 * prefix's key is made once, one step longer than the one before, only while no written type names the steps. An
 * exact target's prefixes may be stopped (`stoppedStores`): their element steps are named alike, a label only.
 */
function stepsOf(walk: Consumers, place: PlaceId, path: readonly string[]): StoreStep[] {
  const work = walk.pass.program.work;
  let term = writtenOf(walk.pass.program.place(place).kind);
  let key: Key | null = null;
  const steps: StoreStep[] = [];
  for (let index = 0; index < path.length; index += 1) {
    const step = path[index]!;
    work.charge("checks");
    if (term === null) {
      key = key === null ? keptKey(work, place, keptSlice(work, path, 0, index)) : key;
      term = walk.admission.copiedAt(key);
    }
    const above = term;
    if (step === "entry") steps.push({ collection: "dict" });
    else if (step !== "element") steps.push({ property: propertyName(step) });
    else {
      const kinds = above !== null ? typeTags(above) : (walk.admission.kindsAt(key!) ?? []);
      steps.push({
        collection: kinds.includes("dict") ? "dict" : kinds.includes("set") ? "set" : "list",
      });
    }
    term = above === null ? null : termAt(above, [step]);
    // (the next prefix's key from this one, while no written type names the steps below)
    key = term === null && key !== null ? keptKeyBelow(work, key, [step]) : null;
  }
  return steps;
}

/** A store above a stop checked when the script runs against its destination's complete type, once. */
function requiredMark(
  walk: Consumers,
  d: Definition,
  requirement: TypeTerm,
  names: () => MarkNames,
): void {
  if (walk.required.has(d.uid)) return;
  walk.required.add(d.uid);
  const { label, into, root, steps } = names();
  const tags = [...new Set(typeTags(requirement))];
  storeWarning(
    walk,
    d.site,
    label,
    STOPPED[0]!,
    tags,
    { rule: "store", into, type: tags, written: true, decider: null, brought: null, root, steps },
    [],
  );
}
