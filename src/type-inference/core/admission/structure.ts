import type { PlaceId, TypeTerm } from "../../graph.js";
import type { Admission } from "../admission.js";
import { joinSteps, keepText, keptParts, keptSlice, keptSteps, keptText } from "../budget.js";
import {
  keptKey,
  keptKeyBelow,
  keptPath,
  keyOf,
  keyPath,
  keyPlace,
  type Definition,
  type Key,
} from "../definitions.js";
import { withoutEmpty } from "../exact-path.js";
import { dictList } from "../method-categories.js";
import { propertyStep } from "../program.js";
import type { Structure } from "./model.js";

// The own structures of stored values and source keys (F2): their literals' fields and elements, depths, landings.

/**
 * A value's source key: the key a copy reads, a call's callee's result key (F20), a dict's `values` read as its
 * elements (r4.46 (2)); `null` for any other value and for a dict's `keys`, which hold text.
 */
export function sourceOf(admission: Admission, value: PlaceId): Key | null {
  const { contract, program } = admission.pass;
  const key = contract.copiedKey(value) ?? contract.resultKey(value);
  if (key === null) return null;
  const path: string[] = [];
  for (const [index, step] of keyPath(key).entries()) {
    const list = dictList(step);
    if (list !== undefined) {
      program.work.charge("indexSteps");
      const owner = withoutEmpty(
        admission.run(contract.contractOf(keyOf(keyPlace(key), keyPath(key).slice(0, index)))),
      );
      if (owner.some((item) => item.tag === "dict")) {
        if (list === "keys") return null;
        continue;
      }
    }
    path.push(step);
  }
  return keyOf(keyPlace(key), path);
}

/** A stored value's own structure: its literals' fields and elements at every depth, and their sources (F2). */
export function valueStructure(admission: Admission, value: PlaceId): Structure {
  const id = `v${value}`;
  let structure = admission.structures.get(id);
  if (structure === undefined) {
    structure = collect(admission, [{ value, at: [], strip: [] }]);
    admission.structures.set(id, structure);
  }
  return structure;
}

/**
 * A source key's own structure (F2): the elements, at every depth, of the values stored at it or at a prefix of it (an
 * add's below its element), cut to the key's path, and of the keys below it with stores. A copied record's fields are
 * none of it: they are admitted at their first read (A2, TABLE q12).
 */
function keyStructure(admission: Admission, key: Key): Structure {
  const id = `k${key}`;
  const known = admission.structures.get(id);
  if (known !== undefined) return known;
  const { definitions, lists, program } = admission.pass;
  const place = keyPlace(key);
  // (its steps, which the roots' rests below keep, charged by the key's text)
  const path = keptPath(admission.work, key);
  const roots: { value: PlaceId; at: readonly string[]; strip: readonly string[] }[] = [];
  const levels: (readonly string[])[] = [];
  // a store's value standing at `below` (an add's below its element), read at `strip`: below the key, at its path or
  // above it (the rest of the path read into it), or beside it (none)
  const root = (d: Definition, below: readonly string[], strip: readonly string[]): void => {
    program.work.charge("indexSteps");
    if (!((d.kind === "whole" || d.kind === "add") && d.value !== undefined && lists.live(d)))
      return;
    const at =
      d.kind === "add" && d.how !== "elements"
        ? keptSteps(admission.work, below, ["element"])
        : below;
    for (let index = 0; index < at.length && index < strip.length; index += 1)
      if (at[index] !== strip[index]) return;
    // (a rest made here is charged as kept; a whole one is shared)
    roots.push(
      at.length > strip.length
        ? {
            value: d.value,
            at: strip.length === 0 ? at : keptSlice(admission.work, at, strip.length),
            strip: [],
          }
        : {
            value: d.value,
            at: [],
            strip: at.length === 0 ? strip : keptSlice(admission.work, strip, at.length),
          },
    );
  };
  for (let length = 0; length <= path.length; length += 1) {
    const stores = definitions.byKey.get(keyOf(place, path.slice(0, length))) ?? [];
    // (a prefix's stores share one rest of the key's path)
    const rest = stores.length === 0 ? [] : keptSlice(admission.work, path, length);
    for (const d of stores) root(d, [], rest);
  }
  for (const below of definitions.keysBelow(key)) {
    const at = keptSlice(admission.work, keptPath(admission.work, below), path.length);
    if (at.some((step) => step !== "element")) continue;
    levels.push(at);
    for (const d of definitions.byKey.get(below) ?? []) root(d, at, []);
  }
  const structure = collect(admission, roots, levels, true);
  keepText(admission.work, id.length);
  admission.structures.set(id, structure);
  return structure;
}

/**
 * The structure of values standing at paths below a value or key: each root's value standing at `at`, read below
 * `strip` (a key's path below a prefix's store, a carrier's step into its value): their literals' fields and elements,
 * walked as their literals nest (below a key its elements only), through the values they carry, and the source key of
 * each value no literal holds, with the levels of the keys below with stores.
 */
function collect(
  admission: Admission,
  roots: readonly { value: PlaceId; at: readonly string[]; strip: readonly string[] }[],
  levels: readonly (readonly string[])[] = [],
  elements = false,
): Structure {
  const { program, definitions } = admission.pass;
  const paths = new Map<string, readonly string[]>();
  const sources = new Map<string, { readonly below: readonly string[]; readonly key: Key }>();
  // (each path's text charged by its size before it is made, TABLE r4.58)
  const path = (at: readonly string[]): void => {
    if (at.length === 0) return;
    const text = keptText(admission.work, at);
    if (!paths.has(text)) paths.set(text, at);
  };
  for (const at of levels)
    for (let length = 1; length <= at.length; length += 1)
      path(keptSlice(admission.work, at, 0, length));
  const pending: (readonly [PlaceId, readonly string[], readonly string[]])[] = [];
  for (let index = roots.length - 1; index >= 0; index -= 1)
    pending.push([roots[index]!.value, roots[index]!.at, roots[index]!.strip]);
  while (pending.length > 0) {
    const [current, at, strip] = pending.pop()!;
    program.work.charge("indexSteps");
    if (!program.hasOf.has(current)) {
      // a source stands at `at`, read at the rest of the path (a source read at a path no key or read of the program
      // reaches is a recursion: cut); any other value through the values it carries
      const source = sourceOf(admission, current);
      if (source !== null) {
        // (read past the longest key, it is cut there, never dropped: whether a literal holds a source, and so which
        // obligations its paths owe, never depends on the keys elsewhere in the program, TABLE r4.67 (1))
        const room = Math.max(0, longestKey(admission) - keyPath(source).length);
        const key = keptKeyBelow(admission.work, source, strip.slice(0, room));
        sources.set(keptParts(admission.work, at, key), { below: at, key });
        continue;
      }
      const carried = admission.carriersOf(current, strip);
      for (let index = carried.length - 1; index >= 0; index -= 1)
        pending.push([carried[index]![0], at, carried[index]![1]]);
      continue;
    }
    // (its cells' tasks share one rest of the strip, charged as kept)
    let rest: readonly string[] | null = null;
    for (const has of program.hasOf.get(current)!) {
      // while reading into it only the field on the path (its literal's fields indexed once), then every field
      const on = strip.length > 0 ? admission.termAt(has.type, strip[0]!) : undefined;
      const fields: readonly (readonly [string, TypeTerm])[] =
        strip.length === 0 ? fieldsOf(has.type) : on === undefined ? [] : [[strip[0]!, on]];
      for (const [name, term] of fields) {
        program.work.charge("indexSteps");
        if (strip.length === 0 && elements && name !== "element") continue;
        const step = strip.length === 0 ? keptSteps(admission.work, at, [name]) : at;
        if (strip.length === 0) path(step);
        if (term.kind === "ref")
          for (const d of definitions.cellDefs.get(term.place) ?? []) {
            rest ??= strip.length === 0 ? strip : keptSlice(admission.work, strip, 1);
            pending.push([d.value!, step, rest]);
          }
      }
    }
  }
  return { paths: [...paths.values()], sources: [...sources.values()] };
}

/** The longest path of a key with stores or of a read's or a call's projections in the program. */
function longestKey(admission: Admission): number {
  if (admission.keyBound !== null) return admission.keyBound;
  const { program, definitions } = admission.pass;
  let longest = 0;
  for (const [key] of definitions.byKey) {
    program.work.charge("indexSteps");
    longest = Math.max(longest, keyPath(key).length);
  }
  const chains = new Map<PlaceId, number>();
  for (const [value] of program.projOf) {
    const way: PlaceId[] = [];
    let current = value;
    while (program.projOf.has(current) && !chains.has(current)) {
      program.work.charge("indexSteps");
      way.push(current);
      current = program.projOf.get(current)!.owner;
    }
    let length = chains.get(current) ?? 0;
    for (let index = way.length - 1; index >= 0; index -= 1) chains.set(way[index]!, (length += 1));
    longest = Math.max(longest, length);
  }
  return (admission.keyBound = longest);
}

/**
 * The element depth of a source key's known structure, its sources' followed (F2): once per key, a cycle of copies
 * (Tarjan's components) one turn of it for each of its keys, so the copies of one source share it and every order
 * gives one answer.
 */
export function depthOf(admission: Admission, key: Key): number {
  const known = admission.depths.get(key);
  if (known !== undefined) return known;
  const { program, contract } = admission.pass;
  const work = program.work;
  // (a key whose contract holds no collection has no elements to follow)
  const flat = (at: Key): boolean => {
    const none = !withoutEmpty(admission.run(contract.contractOf(at))).some(
      (item) => item.tag === "list" || item.tag === "set" || item.tag === "dict",
    );
    if (none) admission.depths.set(at, 0);
    return none;
  };
  if (flat(key)) return 0;
  const order = new Map<Key, number>();
  const low = new Map<Key, number>();
  const stack: Key[] = [];
  const open = new Set<Key>();
  const frames: { readonly key: Key; next: number }[] = [];
  const enter = (at: Key): void => {
    order.set(at, order.size);
    low.set(at, order.get(at)!);
    stack.push(at);
    open.add(at);
    frames.push({ key: at, next: 0 });
  };
  enter(key);
  while (frames.length > 0) {
    const frame = frames.at(-1)!;
    const { sources } = keyStructure(admission, frame.key);
    if (frame.next < sources.length) {
      const target = sources[frame.next++]!.key;
      work.charge("indexSteps");
      if (admission.depths.has(target)) continue;
      if (!order.has(target) && !flat(target)) enter(target);
      else if (open.has(target))
        low.set(frame.key, Math.min(low.get(frame.key)!, order.get(target)!));
      continue;
    }
    frames.pop();
    const parent = frames.at(-1);
    if (parent !== undefined)
      low.set(parent.key, Math.min(low.get(parent.key)!, low.get(frame.key)!));
    if (low.get(frame.key) !== order.get(frame.key)) continue;
    const members = new Set<Key>();
    for (let member = stack.pop()!; ; member = stack.pop()!) {
      open.delete(member);
      members.add(member);
      if (member === frame.key) break;
    }
    // the deepest own element and source's below the component; a source inside it once around
    let depth = 0;
    let turn = 0;
    for (const member of members) {
      const own = keyStructure(admission, member);
      for (const path of own.paths) depth = Math.max(depth, path.length);
      for (const source of own.sources) {
        work.charge("indexSteps");
        if (members.has(source.key)) turn = Math.max(turn, source.below.length);
        else depth = Math.max(depth, source.below.length + admission.depths.get(source.key)!);
      }
    }
    for (const member of members) admission.depths.set(member, depth + turn);
  }
  return admission.depths.get(key)!;
}

/** The paths below a literal's element its known structure gives (F2), and `also`, each once. */
export function pathsBelow(
  admission: Admission,
  value: PlaceId,
  also: readonly (readonly string[])[],
): (readonly string[])[] {
  const work = admission.pass.program.work;
  const out = new Map<string, readonly string[]>();
  const put = (path: readonly string[]): void => {
    work.charge("indexSteps");
    {
      const text = keptText(admission.work, path);
      if (!out.has(text)) out.set(text, path);
    }
  };
  const structure = valueStructure(admission, value);
  for (const path of structure.paths) put(path);
  for (const { below, key } of structure.sources) {
    let path = below;
    for (let depth = depthOf(admission, key); depth > 0; depth -= 1)
      put((path = keptSteps(admission.work, path, ["element"])));
  }
  for (const path of also) put(path);
  return [...out.values()];
}

/**
 * The paths below a collection literal's elements that its own literals give or admission decides where the literal
 * lands (a read's path, A2): there a named element's fields are compared too (TABLE q12: a field is copy-only until
 * a literal or a read reaches it); beside them, where copies land there and two elements may hold something
 * (`touchElements`).
 */
export function sharedPaths(
  admission: Admission,
  landing: Key | null,
  list: readonly Definition[],
): (readonly string[])[] {
  const { program } = admission.pass;
  const out = new Map<string, readonly string[]>();
  const put = (path: readonly string[]): void => {
    program.work.charge("indexSteps");
    {
      const text = path.length > 0 ? keptText(admission.work, path) : "";
      if (path.length > 0 && !out.has(text)) out.set(text, path);
    }
  };
  for (const d of list)
    if (d.value !== undefined)
      for (const path of valueStructure(admission, d.value).paths) put(path);
  if (landing !== null) for (const path of decidedBelow(admission, landing)) put(path);
  return [...out.values()];
}

/**
 * Where a collection literal's elements land: the store holding the literal, through the literals around it, at its
 * element step; `null` for a literal no store holds.
 */
export function literalLanding(admission: Admission, literal: PlaceId): Key | null {
  const { program, definitions } = admission.pass;
  const steps: string[] = [];
  for (let value = literal; ;) {
    program.work.charge("indexSteps");
    const d = (definitions.byValue.get(value) ?? []).find(
      (store) => store.kind === "whole" || store.kind === "add",
    );
    if (d === undefined) return null;
    if (program.cellOwner.has(d.place)) {
      const kind = program.place(d.place).kind;
      steps.push(kind.kind === "property" ? propertyStep(kind.name) : "element");
      value = program.cellOwner.get(d.place)!.owner;
      continue;
    }
    // (an `addAll`'s literal's elements are the destination's own elements)
    return keyOf(
      d.place,
      joinSteps(
        d.kind === "add" && d.how === "elements" ? d.path : admission.destPath(d),
        steps.reverse(),
        ["element"],
      ),
    );
  }
}

/** The paths admission decides (`groups`) below a key, indexed once by every prefix of each. */
function decidedBelow(admission: Admission, key: Key): readonly (readonly string[])[] {
  if (admission.below === null) {
    admission.below = new Map();
    for (const { root, path } of admission.groups())
      for (let length = 0; length < path.length; length += 1) {
        admission.pass.program.work.charge("indexSteps");
        const prefix = keptKey(admission.work, root, path.slice(0, length));
        const rest = keptSlice(admission.work, path, length);
        const paths = admission.below.get(prefix);
        if (paths === undefined) admission.below.set(prefix, [rest]);
        else paths.push(rest);
      }
  }
  return admission.below.get(key) ?? [];
}

/** A path below a store's destination: an `addAll`'s literal's elements are the destination's own elements. */
export function elementsBelow(d: Definition, path: readonly string[]): readonly string[] {
  return d.kind === "add" && d.how === "elements" && path[0] === "element" ? path.slice(1) : path;
}

/** The fields of a literal's type: an object's properties, a collection's element. */
export function fieldsOf(term: TypeTerm): readonly (readonly [string, TypeTerm])[] {
  if (term.kind === "object")
    return (term.properties ?? []).map(
      (property) => [propertyStep(property.name), property.type] as const,
    );
  if (term.kind === "list" || term.kind === "set" || term.kind === "dict")
    return [["element", term.element]];
  return [];
}
