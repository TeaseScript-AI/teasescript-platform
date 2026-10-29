import type { PlaceId, TypeTerm } from "../../graph.js";
import type { Consumers } from "../consumers.js";
import { typeTags, writtenOf } from "../contract.js";
import { keptSlice } from "../budget.js";
import { KeyTrie, keyOf, type Definition } from "../definitions.js";
import { STOPPED } from "../items.js";
import { targetName } from "../result.js";
import { unrestricted } from "../admission/permitted.js";
import { storeMark } from "./fresh.js";
import { placeText, storeRoot, storeSteps, storeWarning } from "./warnings.js";

// The stores above a stopped decision (S3 §5, #1416): each one's obligation kept whole, or its value marked.

/**
 * A decision that stopped stands for its obligations (S3 §5), the stores' above its key among them: a whole store, an
 * argument or an add into the same place at a path above the key, whose value holds it, and whose own path's decision
 * checks nothing below that path. Each such store owes its check when the script runs, at its own site with the stop's
 * context: against its destination's complete type where that is known without new solving (`storeRequirement`: the
 * written type, or the one a copy decides it by), that type carried into the plan whole (`requirements`); else marked
 * with its type undecided (`storeMark`). A store at or below a stopped key is that key's own (#1275), a sibling's path no
 * store of the stop's. Found by one walk down each stopped path that no other stop lies above, through the stored keys'
 * trie (`Admission.stored`), each destination resolved once a pass whatever number of stops lie below it. Run after the
 * pass's decisions, in every pass that carries a stop: a restarted pass rebuilds it from the stopped set (TABLE r4.180),
 * the fresh pass from the written types alone (`freshStores`).
 */
export function enclosingStores(walk: Consumers): void {
  const { program, definitions, contract } = walk.pass;
  if (!contract.anyStopped) return;
  const stops = contract.stoppedKeys();
  const stopped = new KeyTrie(program.work, "checks", () =>
    stops.map(({ place, path }) => keyOf(place, path)),
  );
  for (const { place, path } of stops) {
    // (the nearest stop on the path, its own key the deepest: one above it stands for the stores above both)
    if (stopped.along(place, path, true)[0]!.depth < path.length) continue;
    for (const { key, depth } of walk.admission.stored.along(place, path, false)) {
      if (!walk.enclosed.has(key)) {
        walk.enclosed.add(key);
        resolve(walk, place, keptSlice(program.work, path, 0, depth), [
          ...(definitions.byKey.get(key) ?? []).filter((d) => d.kind === "whole"),
          ...(definitions.deadArguments.get(key) ?? []),
        ]);
      }
      // (an add stores at its receiver's element: above the stop where the path goes on below that element)
      if (path[depth] === "element" && depth + 1 < path.length && !walk.enclosedAdds.has(key)) {
        walk.enclosedAdds.add(key);
        resolve(
          walk,
          place,
          keptSlice(program.work, path, 0, depth + 1),
          (definitions.byKey.get(key) ?? []).filter((d) => d.kind === "add"),
        );
      }
    }
  }
}

/** The stores into `place` at `path` above a stop: their destination's complete type, or each one's mark. */
function resolve(
  walk: Consumers,
  place: PlaceId,
  path: readonly string[],
  stores: readonly Definition[],
): void {
  if (stores.length === 0) return;
  walk.pass.program.work.charge("checks", stores.length);
  const requirement = walk.admission.storeRequirement(place, path);
  // (an unrestricted written part, or a copy's, admits every value: no store owes it anything)
  if (requirement !== null && unrestricted(requirement)) return;
  if (requirement !== null) walk.requirements.set(keyOf(place, path), requirement);
  for (const d of stores)
    if (d.value === undefined) continue;
    else if (requirement === null) storeMark(walk, d, path);
    else requiredMark(walk, d, path, requirement);
}

/** A store above a stop checked when the script runs against its destination's complete type, once. */
function requiredMark(
  walk: Consumers,
  d: Definition,
  path: readonly string[],
  requirement: TypeTerm,
): void {
  if (walk.required.has(d.uid)) return;
  walk.required.add(d.uid);
  const { program } = walk.pass;
  const written = writtenOf(program.place(d.place).kind);
  const tags = [...new Set(typeTags(requirement))];
  storeWarning(
    walk,
    d.site,
    targetName(program.place(d.place).label, path),
    STOPPED[0]!,
    tags,
    {
      rule: "store",
      into: placeText(walk, d.place, path),
      type: tags,
      written: true,
      decider: null,
      brought: null,
      root: storeRoot(walk, d.place),
      steps: storeSteps(walk, d.place, path, written),
    },
    [],
  );
}
