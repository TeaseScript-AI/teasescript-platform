import type { PlaceId } from "../../graph.js";
import type { Admission } from "../admission.js";
import { keyOf, type Definition, type Key } from "../definitions.js";
import type { PathRef } from "../contract/key-ids.js";
import { withoutEmpty } from "../exact-path.js";
import type { Reads } from "../inherited/reads.js";
import { dictList } from "../method-categories.js";
import type { Candidate, Inputs } from "./model.js";

// #2378: a dict's list a statement changes in place, decided as its copy twin's list is: its inputs.

/**
 * A path's inputs with its owner's kind read (`freshRead`): below a dict's list, the statement's own stores and those
 * reaching the path from the list's own level down, after the list's read, their first definition; `null` where no
 * statement changes the list in place (a copy's store landing here is its copy's, decided there). Else the inputs as
 * they were.
 */
export function* freshInputs(admission: Admission, inputs: Inputs): Reads<Inputs | null> {
  const { fresh } = inputs;
  if (fresh === undefined) return inputs;
  admission.pass.program.work.charge("indexSteps");
  const owner = withoutEmpty(
    yield* admission.runRead(() => admission.pass.contract.contractOf(fresh.owner)),
  );
  if (!owner.some((item) => item.tag === "dict"))
    return { direct: inputs.direct, prefixes: inputs.prefixes };
  if (fresh.read === null) return { direct: inputs.direct, prefixes: inputs.prefixes };
  return {
    direct: inputs.direct.filter((candidate) => candidate.d.place === fresh.place),
    prefixes: inputs.prefixes.slice(fresh.prefixes),
    first: fresh.read,
  };
}

/**
 * #2378: a dict's `values` or `keys` is a new list each time it is read (V30), so a statement that changes
 * it in place changes a list nobody holds, as its copy twin (`let t = d.values` before it, `t` in its place) changes
 * `t`. Below that list's own level a path is decided as the twin's: the receiver's read is the list's first
 * definition (an initializer, the twin's declaration), the statement's stores into the list follow it, and nothing the
 * dict holds or stores above the list is a prefix of it; the read carries what the dict holds there. `null` for a
 * path with no list step above its last step; `read` `null` where no store of the place changes the list through a
 * read of it.
 */
export function freshRead(
  admission: Admission,
  root: PlaceId,
  path: readonly string[],
  direct: readonly Candidate[],
  prefixes: readonly { readonly key: Key; readonly rest: PathRef }[],
): NonNullable<Inputs["fresh"]> | null {
  const { program, definitions } = admission.pass;
  // (the innermost list by its spelling, its owner's kind read by `freshInputs`)
  let list = -1;
  for (let index = path.length - 2; index >= 0 && list < 0; index -= 1)
    if (dictList(path[index]!) !== undefined) list = index;
  if (list < 0) return null;
  const owner = keyOf(root, path.slice(0, list));
  // (the prefixes from the list's own level down: their rests no longer than the path below the list's step)
  let from = 0;
  while (from < prefixes.length && prefixes[from]!.rest.length > path.length - list - 1) from += 1;
  // (the read a store's target is a projection of: its `values` or `keys` occurrence; a store of the place's own,
  // never one a copy's alias lands here)
  const stores = [
    ...direct.map((candidate) => candidate.d),
    ...prefixes.slice(from).flatMap(({ key }) => definitions.byKey.get(key) ?? []),
  ];
  for (const d of stores)
    for (let into = d.place === root ? d.into : undefined; into !== undefined;) {
      const projection = program.projOf.get(into);
      if (projection === undefined) break;
      if (projection.step === path[list]) {
        const listPath = path.slice(0, list + 1);
        const read: Definition = {
          uid: -1 - into,
          kind: "whole",
          weak: false,
          key: keyOf(root, listPath),
          place: root,
          path: listPath,
          value: into,
          node: projection.node ?? d.node,
          how: "initializer",
          site: program.place(into).site ?? d.site,
          recv: null,
          prep: null,
        };
        return { owner, place: root, prefixes: from, read: { d: read, at: path.slice(list + 1) } };
      }
      into = projection.owner;
    }
  return { owner, place: root, prefixes: from, read: null };
}

/**
 * #2378: a store through a dict's list read in place (`freshRead`): the list's read is a store into it before this
 * one, as its copy twin's declaration is, so the store is never its list's only one.
 */
export function freshStore(admission: Admission, d: Definition): boolean {
  const { program, contract } = admission.pass;
  if (!d.path.some((step) => dictList(step) !== undefined)) return false;
  for (let into = d.into; into !== undefined;) {
    const projection = program.projOf.get(into);
    if (projection === undefined) return false;
    const list = dictList(projection.step);
    if (list !== undefined) {
      program.work.charge("indexSteps");
      const index = d.path.lastIndexOf(projection.step);
      if (index < 0) return false;
      const owner = withoutEmpty(
        admission.run(contract.contractOf(keyOf(d.place, d.path.slice(0, index)))),
      );
      return owner.some((item) => item.tag === "dict");
    }
    into = projection.owner;
  }
  return false;
}
