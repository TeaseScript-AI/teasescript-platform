import type { PlaceId, TypeTerm } from "../../graph.js";
import type { Admission } from "../admission.js";
import { joinSteps, keep, keepText, keptParts, keptSlice, keptSteps, keptText } from "../budget.js";
import { keptPath, keyOf, keyPath, type Definition, type Key } from "../definitions.js";
import {
  canonicalKey,
  type CanonicalKey,
  isKeyId,
  keptKeyAt,
  keptKeyBelowIn,
  keptKeyWalk,
  keyDepthIn,
  keyIdPath,
  keyWalk,
} from "../contract/key-ids.js";
import { withoutEmpty } from "../exact-path.js";
import { dictList } from "../method-categories.js";
import { propertyStep } from "../program.js";
import type { Structure } from "./model.js";

// The own structures of stored values and source keys (F2): their literals' fields and elements, depths, landings.

/**
 * A value's source key: the key a copy reads, a call's callee's result key (F20), a dict's `values` read as its
 * elements (r4.46 (2)); `null` for any other value and for a dict's `keys`, which hold text.
 */
export function sourceOf(admission: Admission, value: PlaceId): CanonicalKey | null {
  const { contract, program } = admission.pass;
  const found = contract.copiedKey(value) ?? contract.resultKey(value);
  if (found === null) return null;
  // (the source in its identity, as the structures and depths hold it: G3 stage 1)
  const key = canonicalKey(contract, found);
  // (G3 stage 1: a cursor with no built-in member on its path holds no dict's list step: itself, never walked)
  if (isKeyId(key) && contract.pathMembers[keyIdPath(key)] === 0) return key;
  const walk = keyWalk(contract, key);
  const path: string[] = [];
  for (const [index, step] of walk.path.entries()) {
    const list = dictList(step);
    if (list !== undefined) {
      program.work.charge("indexSteps");
      const owner = withoutEmpty(admission.run(contract.contractOf(walk.prefix(index))));
      if (owner.some((item) => item.tag === "dict")) {
        if (list === "keys") return null;
        continue;
      }
    }
    path.push(step);
  }
  return contract.keyAt(walk.place, path);
}

/** A stored value's own structure: its literals' fields and elements at every depth, and their sources (F2). */
export function valueStructure(admission: Admission, value: PlaceId): Structure {
  const id = `v${value}`;
  let structure = admission.structures.get(id);
  if (structure === undefined) {
    const own = composed(admission, value, [], false);
    structure = own.listed ?? collect(admission, [{ value, at: [], strip: [] }]);
    if (!own.empty) own.listed = structure;
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
  const { definitions, lists, program, contract } = admission.pass;
  // (its steps, which the roots' rests below keep, charged by the key's text; a cursor's through the charged boundary)
  const walk = keptKeyWalk(contract, key);
  const path = walk.path;
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
    // (a cursor's prefixes below its root are in no definition index: its family's shape requires it)
    const stores = definitions.byKey.get(walk.prefix(length)) ?? [];
    // (a prefix's stores share one rest of the key's path)
    const rest = stores.length === 0 ? [] : keptSlice(admission.work, path, length);
    for (const d of stores) root(d, [], rest);
  }
  for (const below of isKeyId(key) ? [] : definitions.keysBelow(key)) {
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
 * `strip` (a key's path below a prefix's store, a carrier's step into its value), with the levels of the keys below
 * with stores, each root's from its own value's (`composed`), in order, each path and source once.
 */
function collect(
  admission: Admission,
  roots: readonly { value: PlaceId; at: readonly string[]; strip: readonly string[] }[],
  levels: readonly (readonly string[])[] = [],
  elements = false,
): Structure {
  const paths = new Map<string, readonly string[]>();
  const sources = new Map<
    string,
    { readonly below: readonly string[]; readonly key: CanonicalKey }
  >();
  // (each path's text charged by its size before it is made, TABLE r4.58)
  for (const at of levels)
    for (let length = 1; length <= at.length; length += 1) {
      const path = keptSlice(admission.work, at, 0, length);
      const text = keptText(admission.work, path);
      if (!paths.has(text)) paths.set(text, path);
    }
  for (const { value, at, strip } of roots)
    joinInto(admission, paths, sources, composed(admission, value, strip, elements), at);
  return { paths: [...paths.values()], sources: [...sources.values()] };
}

/**
 * A value's own structure at its path, read below a strip (`composed`): its own paths and sources below that path, and
 * its parts' structures where each stands, by reference, in the walk's order; listed at the root that asks it
 * (`joinInto`), never copied into each value around it, and kept listed where a value's own structure asked it
 * (`valueStructure`), so a value around it takes that list instead of walking its parts again.
 */
export interface Composed {
  readonly entries: readonly (
    | { readonly path: readonly string[] }
    | { readonly source: { readonly below: readonly string[]; readonly key: CanonicalKey } }
    | { readonly part: Composed; readonly at: readonly string[] }
  )[];
  readonly empty: boolean;
  listed: Structure | null;
}

const NO_STRUCTURE: Composed = { entries: [], empty: true, listed: null };

/**
 * A composed structure's paths and sources below `at`, put in `paths` and `sources` where they are not yet, in the
 * walk's order (on an explicit stack; a part met again at the same place lists nothing new).
 */
function joinInto(
  admission: Admission,
  paths: Map<string, readonly string[]>,
  sources: Map<string, { readonly below: readonly string[]; readonly key: CanonicalKey }>,
  from: Composed,
  at: readonly string[],
): void {
  const work = admission.pass.program.work;
  const visited = new Map<Composed, Set<readonly string[]>>();
  const stack: { readonly node: Composed; readonly at: readonly string[]; next: number }[] = [
    { node: from, at, next: 0 },
  ];
  while (stack.length > 0) {
    const frame = stack.at(-1)!;
    if (frame.next >= frame.node.entries.length) {
      stack.pop();
      continue;
    }
    const entry = frame.node.entries[frame.next++]!;
    work.charge("checks");
    if ("path" in entry) {
      const below =
        frame.at.length === 0 ? entry.path : keptSteps(admission.work, frame.at, entry.path);
      const name = keptText(admission.work, below);
      if (!paths.has(name)) paths.set(name, below);
    } else if ("source" in entry) {
      const { below: within, key } = entry.source;
      const below = frame.at.length === 0 ? within : keptSteps(admission.work, frame.at, within);
      const name = keptParts(admission.work, below, key);
      if (!sources.has(name)) sources.set(name, { below, key });
    } else if (!entry.part.empty) {
      const below =
        entry.at.length === 0
          ? frame.at
          : frame.at.length === 0
            ? entry.at
            : keptSteps(admission.work, frame.at, entry.at);
      let seen = visited.get(entry.part);
      if (seen === undefined) visited.set(entry.part, (seen = new Set()));
      if (seen.has(below)) continue;
      seen.add(below);
      const listed = entry.part.listed;
      if (listed === null) {
        stack.push({ node: entry.part, at: below, next: 0 });
        continue;
      }
      for (const path of listed.paths) {
        work.charge("checks");
        const at = below.length === 0 ? path : keptSteps(admission.work, below, path);
        const name = keptText(admission.work, at);
        if (!paths.has(name)) paths.set(name, at);
      }
      for (const { below: within, key } of listed.sources) {
        work.charge("checks");
        const at = below.length === 0 ? within : keptSteps(admission.work, below, within);
        const name = keptParts(admission.work, at, key);
        if (!sources.has(name)) sources.set(name, { below: at, key });
      }
    }
  }
}

/**
 * The structure of one value standing at a path and read below `strip`, relative to that path (F2), once per value,
 * strip and side (`elements`: below a key its elements only), from its parts' (G3 2c: a carrier nested in carriers is
 * walked once, never again for each value around it). A literal read whole is walked with the literals nested in it as
 * cells, each one's fields as it is met, its cells after them, the last cell first; a literal read into by its cells
 * on the path; a value no literal holds through the values it carries, or the source key it reads (a source read at a
 * path no key or read of the program reaches is a recursion: cut). Each part's structure, any other value a literal
 * holds among them, joins in the walk's order where it stands.
 */
function composed(
  admission: Admission,
  value: PlaceId,
  strip: readonly string[],
  elements: boolean,
): Composed {
  const { program, definitions } = admission.pass;
  const work = program.work;
  const name = (of: PlaceId, at: readonly string[]): string =>
    keptParts(admission.work, of, elements, at);
  const root = name(value, strip);
  const known = admission.structureParts.get(root);
  if (known !== undefined) return known;
  type Entry =
    | { readonly path: readonly string[] }
    | { readonly source: { readonly below: readonly string[]; readonly key: CanonicalKey } }
    | { readonly part: number; readonly at: readonly string[] };
  interface Frame {
    readonly name: string;
    /** Its own paths, its source and its parts where each stands, in the walk's order. */
    readonly entries: readonly Entry[];
    readonly parts: readonly {
      readonly name: string;
      readonly value: PlaceId;
      readonly strip: readonly string[];
    }[];
    next: number;
  }
  const open = (of: PlaceId, below: readonly string[], key: string): Frame => {
    work.charge("indexSteps");
    const entries: Entry[] = [];
    const parts: Frame["parts"][number][] = [];
    const part = (at: readonly string[], carried: PlaceId, rest: readonly string[]): void => {
      entries.push({ part: parts.length, at });
      parts.push({ name: name(carried, rest), value: carried, strip: rest });
    };
    if (!program.hasOf.has(of)) {
      const source = sourceOf(admission, of);
      if (source !== null) {
        // (read past the longest key, it is cut there, never dropped: whether a literal holds a source, and so which
        // obligations its paths owe, never depends on the keys elsewhere in the program, TABLE r4.67 (1))
        const room = Math.max(
          0,
          longestKey(admission) - keyDepthIn(admission.pass.contract, source),
        );
        const read = keptKeyBelowIn(admission.pass.contract, source, below.slice(0, room));
        entries.push({ source: { below: [], key: read } });
      } else for (const [carried, rest] of admission.carriersOf(of, below)) part([], carried, rest);
      return { name: key, entries, parts, next: 0 };
    }
    if (below.length > 0) {
      // (read into, only the field on the path, its literal's fields indexed once; its cells' tasks share one rest of
      // the strip, charged as kept)
      const cells: PlaceId[] = [];
      for (const has of program.hasOf.get(of)!) {
        const on = admission.termAt(has.type, below[0]!);
        work.charge("indexSteps");
        if (on?.kind === "ref")
          for (const d of definitions.cellDefs.get(on.place) ?? []) cells.push(d.value!);
      }
      const rest = cells.length === 0 ? below : keptSlice(admission.work, below, 1);
      for (let index = cells.length - 1; index >= 0; index -= 1) part([], cells[index]!, rest);
      return { name: key, entries, parts, next: 0 };
    }
    // (read whole: its fields, then its cells, the last first, a literal among them walked here too)
    const pending: (readonly [PlaceId, readonly string[]])[] = [[of, []]];
    while (pending.length > 0) {
      const [current, at] = pending.pop()!;
      if (!program.hasOf.has(current)) {
        part(at, current, []);
        continue;
      }
      if (current !== of) work.charge("indexSteps");
      const cells: (readonly [PlaceId, readonly string[]])[] = [];
      for (const has of program.hasOf.get(current)!)
        for (const [field, term] of fieldsOf(has.type)) {
          work.charge("indexSteps");
          if (elements && field !== "element") continue;
          const step = keptSteps(admission.work, at, [field]);
          entries.push({ path: step });
          if (term.kind === "ref")
            for (const d of definitions.cellDefs.get(term.place) ?? [])
              cells.push([d.value!, step]);
        }
      for (const cell of cells) pending.push(cell);
    }
    return { name: key, entries, parts, next: 0 };
  };
  // (each value after its parts, on an explicit stack: a nest of any depth never deepens the native one)
  const stack: Frame[] = [open(value, strip, root)];
  while (stack.length > 0) {
    const frame = stack.at(-1)!;
    if (frame.next < frame.parts.length) {
      const part = frame.parts[frame.next++]!;
      if (!admission.structureParts.has(part.name))
        stack.push(open(part.value, part.strip, part.name));
      continue;
    }
    stack.pop();
    // (one part's structure at the value's own path, the value adding nothing: taken whole)
    const entries: Composed["entries"][number][] = [];
    for (const entry of frame.entries)
      if (!("part" in entry)) entries.push(entry);
      else {
        const part = admission.structureParts.get(frame.parts[entry.part]!.name)!;
        if (!part.empty) entries.push({ part, at: entry.at });
      }
    let made: Composed;
    const [lone] = entries;
    if (entries.length === 0) made = NO_STRUCTURE;
    else if (entries.length === 1 && "part" in lone! && lone.at.length === 0) made = lone.part;
    else {
      keep(admission.work, 1 + entries.length);
      made = { entries, empty: false, listed: null };
    }
    admission.structureParts.set(frame.name, made);
  }
  return admission.structureParts.get(root)!;
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
export function depthOf(admission: Admission, asked: Key): number {
  const { program, contract } = admission.pass;
  // (a key in its identity, as the depths hold it: G3 stage 1)
  const key = canonicalKey(contract, asked);
  const known = admission.depths.get(key);
  if (known !== undefined) return known;
  const work = program.work;
  // (a key whose contract holds no collection has no elements to follow)
  const flat = (at: CanonicalKey): boolean => {
    const none = !withoutEmpty(admission.run(contract.contractOf(at))).some(
      (item) => item.tag === "list" || item.tag === "set" || item.tag === "dict",
    );
    if (none) admission.depths.set(at, 0);
    return none;
  };
  if (flat(key)) return 0;
  const order = new Map<CanonicalKey, number>();
  const low = new Map<CanonicalKey, number>();
  const stack: CanonicalKey[] = [];
  const open = new Set<CanonicalKey>();
  const frames: { readonly key: CanonicalKey; next: number }[] = [];
  const enter = (at: CanonicalKey): void => {
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
    const members = new Set<CanonicalKey>();
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
function decidedBelow(admission: Admission, asked: Key): readonly (readonly string[])[] {
  if (admission.below === null) {
    admission.below = new Map();
    for (const group of admission.groups()) {
      // (a cursor's steps made through the charged boundary, its prefixes its ancestors: G3 stage 1)
      const path = admission.stepsAt(group);
      const walk = group.key === undefined ? null : keyWalk(admission.pass.contract, group.key);
      for (let length = 0; length < path.length; length += 1) {
        admission.pass.program.work.charge("indexSteps");
        const prefix =
          walk === null
            ? keptKeyAt(admission.pass.contract, group.root, path.slice(0, length))
            : walk.prefix(length);
        const rest = keptSlice(admission.work, path, length);
        const paths = admission.below.get(prefix);
        if (paths === undefined) admission.below.set(prefix, [rest]);
        else paths.push(rest);
      }
    }
  }
  // (a key in its identity, as the groups' prefixes hold it: G3 stage 1)
  return admission.below.get(canonicalKey(admission.pass.contract, asked)) ?? [];
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
