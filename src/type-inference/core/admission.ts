import type { PlaceId, SourceSite, TypeTerm } from "../graph.js";
import type { CorePass } from "./answers.js";
import { termAt, typeTags, writtenOf } from "./contract.js";
import {
  keyOf,
  keyPath,
  keyPlace,
  prefixesOf,
  sortCost,
  type Definition,
  type Key,
} from "./definitions.js";
import { withoutEmpty } from "./exact-path.js";
import type { FlowNode } from "./flow-graph.js";
import { REASON, writerKey, type IngressNode, type Item, type ItemTag } from "./items.js";
import { conversionCategory } from "./method-categories.js";
import { propertyStep } from "./program.js";
import { elementStep, type Obligation, type RequiredKind } from "./result.js";
import type { Work } from "./solver.js";

/*
 * Admission (checkpoint 9, TABLE §5) and the boundary checks of external data (C9). A place's type is decided once,
 * in source order, at a destination store, from the value that store transfers at its own node (§3): a written type
 * decides (A1, A9); a copy of a written binding is decided by its type (A4); otherwise the earliest definite
 * contribution in source order (A2), where a settled family needs no scan (A3); the candidates a decided type is checked
 * against are the direct stores and the whole stores of a prefix whose source holds an offending kind (A5). A definite
 * contribution that does not fit is an error at the store, which is rejected: its rejection takes effect in the next
 * pass, and the passes repeat until the rejected set is stable (A6, `analyseCore`). The consumers check each candidate
 * against the decided type (C1); here: the decision, the rejections, a literal's elements of one type (A8, ADR 1.3) and
 * where each boundary check of external data stands (C9: one per ingress store at its ingress expression, against the
 * destination's own admitted type; host data no store brought is checked at the consumer that reads it).
 */

/** The plain scalar kinds: an inferred root whose every store is of one family of them asks nothing. */
const SCALAR: ReadonlySet<ItemTag> = new Set(["integer", "number", "string", "boolean"]);
const NUMERIC: ReadonlySet<ItemTag> = new Set(["integer", "number"]);

/** The kinds that fit a destination of kind `ref` (C1, ADR 1.2): a whole number a number; an unknown anything. */
export function fits(tag: ItemTag, ref: ItemTag, written: boolean): boolean {
  return (
    tag === ref ||
    (tag === "integer" && ref === "number") ||
    (!written && tag === "number" && ref === "integer") ||
    tag === "unknown"
  );
}

export const concrete = (item: Item): boolean =>
  item.tag !== "null" && item.tag !== "unknown" && item.tag !== "empty";
export const isOpaque = (item: Item): boolean =>
  item.tag === "unknown" && (item.reasons & (REASON.opaque | REASON.missing | REASON.budget)) !== 0;
export const isExternal = (item: Item): boolean =>
  item.tag === "unknown" && (item.reasons & REASON.external) !== 0;
/** A value a store contributes to a place: an opaque or external unknown, never a source's missing field. */
export const contributes = (item: Item): boolean =>
  (isOpaque(item) || isExternal(item)) && item.reasons !== REASON.missing;
/** The items that decide (A2): definite, of a kind. */
export const deciding = (items: readonly Item[]): Item[] =>
  items.filter((item) => item.cert === "def" && concrete(item));

/** One family (A3): one kind, or whole numbers with numbers, with or without `null`. */
function family(tags: readonly ItemTag[]): boolean {
  const kinds = tags.filter((tag) => tag !== "null");
  return kinds.length > 0 && (new Set(kinds).size === 1 || kinds.every((tag) => NUMERIC.has(tag)));
}

/** A number the place admits: one an internal contribution gives, never one possible solely through external data. */
const admitsNumber = (item: Item): boolean => item.tag === "number" && item.extOnly !== true;

/** A candidate of a decided type: a store and the path below its destination it reaches the place at. */
export interface Candidate {
  readonly d: Definition;
  readonly at: readonly string[];
}

/** What decides a place (§5): the kinds, by a written type, a written copy's (A4) or the first definite store's. */
export interface Decision {
  readonly root: PlaceId;
  readonly path: readonly string[];
  readonly label: string;
  readonly tags: readonly ItemTag[];
  /** By a written type, at the place or of a copied binding (A4): no number of an integer fits there. */
  readonly written: boolean;
  /** Whether the place's own written type decides (A1), and whether it is a parameter's or a result's (A9, C7). */
  readonly own: boolean;
  readonly nullable: boolean;
  /** The store that decided (A2, A4), `null` for a written type. */
  readonly decider: Definition | null;
  /** The candidates in source order (A5). */
  readonly candidates: readonly Candidate[];
}

/** What admission asks of the consumers it runs beside: their solver runs, with each read's accounting. */
export interface AdmissionHost {
  run<T>(work: Work<T>): T;
}

export class Admission {
  /** The decider's kinds per key (§5). */
  readonly decided = new Map<Key, readonly ItemTag[]>();
  /** The stores rejected in this pass, by their definitions' order, with the places and paths they are rejected at (A6). */
  readonly newlyRejected = new Map<number, Set<Key>>();
  /** The boundary checks of the ingress stores, by the key each enters (C9), published after the consumers ran. */
  readonly boundaries = new Map<Key, Obligation[]>();
  /** The boundary checks no store into a place owes: host data read where it is consumed, an ingress read (C9, F18). */
  readonly readChecks: Obligation[] = [];
  readonly #rejectedKeys = new Set<Key>();
  readonly #a4Keys = new Set<Key>();
  readonly #copies = new Map<
    PlaceId,
    readonly { readonly path: readonly string[]; readonly term: TypeTerm }[]
  >();
  readonly #whole = new Map<string, Definition[]>();
  readonly #pending = new Map<number, Definition>();
  readonly #typed: Definition[] = [];
  readonly #readSeen = new Set<PlaceId>();
  readonly #hostSeen = new Set<string>();
  readonly #walked = new Set<IngressNode>();
  readonly #f18 = new Map<
    PlaceId,
    { readonly label: string; readonly tags: readonly ItemTag[] } | null
  >();
  #groups: { readonly root: PlaceId; readonly path: readonly string[] }[] | null = null;

  public constructor(
    readonly pass: CorePass,
    readonly host: AdmissionHost,
    /**
     * The stores rejected by the previous pass, each with the places and paths it was rejected at, and those a rejection
     * cycle changes (A6).
     */
    readonly rejected: ReadonlyMap<number, ReadonlySet<Key>>,
    readonly cycling: ReadonlySet<number>,
  ) {
    const { definitions } = pass;
    for (const list of definitions.byKey.values())
      for (const d of list) if (rejected.has(d.uid)) this.#rejectedKeys.add(d.key);
    for (const d of definitions.storeDefs)
      if (d.kind === "whole" && d.value !== undefined)
        for (const { path } of this.#writtenCopies(d.value))
          this.#a4Keys.add(keyOf(d.place, [...d.path, ...path]));
  }

  #run<T>(work: Work<T>): T {
    return this.host.run(work);
  }

  /**
   * A6: a definite contribution that does not fit at a place's path is rejected (a return or an argument stays: its
   * callee decides); in the next pass it is decided again there.
   */
  public reject(d: Definition, root: PlaceId, path: readonly string[]): void {
    if (d.how === "return" || d.how === "argument") return;
    let keys = this.newlyRejected.get(d.uid);
    if (keys === undefined) this.newlyRejected.set(d.uid, (keys = new Set()));
    keys.add(keyOf(root, path));
  }

  /** ADR 1.6: a start value comes first; a single-site parameter's is its argument (F21). */
  public sourceOrder(d: Definition): number {
    return d.how === "argument" && this.pass.lists.singleSite(d.fn)
      ? -1
      : d.site.file * 1e9 + d.site.start;
  }

  /** A store's value at the path below its destination, by §3 at its node. */
  public valueAt(d: Definition, at: readonly string[]): Item[] {
    this.pass.program.work.charge("checks");
    if (d.kind === "const") return at.length === 0 ? [...(d.items ?? [])] : [];
    return withoutEmpty(this.#run(this.pass.values.valueItems(d.value!, d.node, at)));
  }

  /** A place's path in the contract's vocabulary: an element step below a dict is its `entry`. */
  public pathLabel(place: PlaceId, path: readonly string[]): string {
    const { program, contract } = this.pass;
    let label = program.place(place).label;
    path.forEach((step, index) => {
      if (step !== "element") label = `${label}.${step}`;
      else {
        const kinds = withoutEmpty(
          this.#run(contract.contractOf(keyOf(place, path.slice(0, index)))),
        );
        label = `${label}.${elementStep(kinds.map((item) => item.tag))}`;
      }
    });
    return label;
  }

  // ------------------------------------------------------------------------------------------- the decision

  /** Every place and path admission decides: the keys with definitions, below them a literal's structure, written elements. */
  public groups(): readonly { readonly root: PlaceId; readonly path: readonly string[] }[] {
    if (this.#groups !== null) return this.#groups;
    const { program, definitions } = this.pass;
    const work = program.work;
    const tracked = new Set<Key>([...definitions.byKey.keys(), ...definitions.candidates.keys()]);
    for (const c of program.constraints)
      if (c.kind === "project") {
        const target = program.targetRoot(c.into);
        if (!program.cellOwner.has(target.root) && !program.hasOf.has(target.root))
          tracked.add(keyOf(target.root, target.path));
      }
    for (const [, binding] of program.occurrenceOf) tracked.add(keyOf(binding, []));
    const stores = new Map<Key, number>();
    for (const d of definitions.storeDefs)
      if (d.kind === "whole" || d.kind === "add")
        for (const key of [d.key, ...prefixesOf(d.key)]) {
          work.charge("indexSteps");
          stores.set(key, (stores.get(key) ?? 0) + 1);
        }
    // a literal's structure where another store or add reaches the place or below it
    for (const d of definitions.storeDefs)
      if ((d.kind === "whole" || d.kind === "add") && (stores.get(d.key) ?? 0) > 1)
        for (const path of this.literalPaths(d.value!))
          tracked.add(
            keyOf(d.place, [
              ...d.path,
              ...(d.kind === "add" && d.how !== "elements" ? ["element"] : []),
              ...path,
            ]),
          );
    for (const key of [...tracked])
      for (const prefix of prefixesOf(key)) {
        work.charge("indexSteps");
        tracked.add(prefix);
      }
    work.charge(
      "checks",
      tracked.size +
        program.places.length +
        program.constraints.length +
        definitions.storeDefs.length,
    );
    const roots = new Map<PlaceId, Set<string>>();
    for (const key of tracked) {
      let paths = roots.get(keyPlace(key));
      if (paths === undefined) roots.set(keyPlace(key), (paths = new Set()));
      paths.add(keyPath(key).join("."));
    }
    // A1, A8: a written collection's elements at every depth
    for (const place of program.places) {
      const written = writtenOf(place.kind);
      const paths = roots.get(place.id);
      if (written === null || paths === undefined) continue;
      for (let path = ["element"]; termAt(written, path) !== null; path = [...path, "element"])
        paths.add(path.join("."));
    }
    const groups: { readonly root: PlaceId; readonly path: readonly string[] }[] = [];
    for (const [root, paths] of roots)
      for (const path of paths) groups.push({ root, path: path === "" ? [] : path.split(".") });
    this.#groups = groups;
    return groups;
  }

  /**
   * The decision of one place at one path (§5), or `null` where nothing is checked: no store reaches it, it lies below
   * a reference (F19a), a settled family needs no scan (A3), or nothing decides. The decision is recorded for the
   * boundary checks' `against` (C9).
   */
  public decide(root: PlaceId, path: readonly string[]): Decision | null {
    const { program, definitions, lists, contract } = this.pass;
    const work = program.work;
    const place = program.place(root);
    if (
      place.kind.kind === "cell" ||
      place.kind.kind === "property" ||
      program.cellOwner.has(root) ||
      program.hasOf.has(root)
    )
      return null;
    const key = keyOf(root, path);
    const direct = definitions.candidates.get(key) ?? [];
    const prefixes: { readonly key: Key; readonly rest: readonly string[] }[] = [];
    for (let length = 0; length < path.length; length += 1) {
      work.charge("checks");
      const prefix = keyOf(root, path.slice(0, length));
      if ((definitions.byKey.get(prefix) ?? []).some((d) => d.kind === "whole" || d.kind === "add"))
        prefixes.push({ key: prefix, rest: path.slice(length) });
    }
    if (direct.length === 0 && prefixes.length === 0) return null;
    const written = writtenOf(place.kind);
    const term = written === null ? null : termAt(written, path);
    // A9, C7: every argument and return into a written parameter or result is a candidate
    const transfer =
      term !== null && (place.kind.kind === "parameter" || place.kind.kind === "result");
    // F19a: below a reference nothing is admitted
    if (path.length > 0 && this.#run(contract.refReceiver(key))) {
      work.charge("checksSkipped");
      return null;
    }
    if (path.length > 0 && term === null) {
      // A3: a settled family needs no scan, where no store on the path was rejected
      const clean = this.#clean(root, path);
      const kinds = clean ? withoutEmpty(this.#run(contract.contractOf(key))) : [];
      if (
        clean &&
        kinds.every((item) => item.tag !== "unknown") &&
        family(kinds.map((item) => item.tag))
      ) {
        work.charge("checksSkipped");
        return null;
      }
    }
    const writtenTags = term === null ? null : typeTags(term);
    let nullable = writtenTags === null ? true : writtenTags.includes("null");
    let tags: ItemTag[] | null =
      writtenTags === null ? null : writtenTags.filter((tag) => tag !== "null");
    let byWritten = writtenTags !== null;
    let decider: Definition | null = null;
    // an inferred root whose every store's contract is plain scalar kinds of one family accepts every store
    if (tags === null && path.length === 0 && !this.#a4Keys.has(keyOf(root, []))) {
      let plain = true;
      const all: ItemTag[] = [];
      for (const { d, at } of direct) {
        // a multi-site argument decides nothing (F21); a single-site one is the parameter's start value
        if (d.how === "argument" && !lists.singleSite(d.fn)) continue;
        const kinds = at.length === 0 ? this.#quietKinds(d.value) : null;
        if (kinds === null || !kinds.every((tag) => SCALAR.has(tag) || tag === "null")) {
          plain = false;
          break;
        }
        all.push(...kinds);
      }
      if (plain && family(all)) {
        work.charge("checksSkipped");
        return null;
      }
    }
    const seen = new Map<string, Item[]>();
    const evaluate = (d: Definition, at: readonly string[]): Item[] => {
      const memoKey = `${d.uid}|${at.join(".")}`;
      let items = seen.get(memoKey);
      if (items === undefined) seen.set(memoKey, (items = this.valueAt(d, at)));
      return items;
    };
    // A2: a path whose contract holds no kind (an unknown, a null) has no definite contribution to decide it, and no
    // store needs a scan (the contract holds every live store's kinds); a copy of a written binding on the path still
    // decides (A4), and a store rejected there is decided again (A6)
    if (
      tags === null &&
      this.#clean(root, path) &&
      !withoutEmpty(this.#run(contract.contractOf(key))).some((item) => concrete(item))
    ) {
      work.charge("checksSkipped");
      return null;
    }
    if (tags === null) {
      // A2: the earliest definite contribution in source order decides, a lazy merge of the direct stores and the
      // prefixes' whole stores and adds; A4: a copy of a written binding is decided by its type
      const lists_: Candidate[][] = [
        direct
          .filter(
            (candidate) =>
              ((candidate.d.how !== "argument" || lists.singleSite(candidate.d.fn)) &&
                candidate.d.kind !== "add") ||
              candidate.at.length === 0,
          )
          .map((candidate) => ({ d: candidate.d, at: candidate.at }))
          .sort((a, b) => this.sourceOrder(a.d) - this.sourceOrder(b.d)),
        ...prefixes.map(({ key: prefix, rest }) =>
          this.#wholeOf(prefix, false).map((d) => ({ d, at: rest })),
        ),
        ...prefixes
          .filter(({ rest }) => rest[0] === "element")
          .map(({ key: prefix, rest }) =>
            this.#wholeOf(prefix, true).map((d) => ({
              d,
              at: d.how !== "elements" ? rest.slice(1) : rest,
            })),
          ),
      ];
      const positions = lists_.map(() => 0);
      let sawNull = false;
      for (;;) {
        let best = -1;
        for (let index = 0; index < lists_.length; index += 1)
          if (
            positions[index]! < lists_[index]!.length &&
            (best < 0 ||
              this.sourceOrder(lists_[index]![positions[index]!]!.d) <
                this.sourceOrder(lists_[best]![positions[best]!]!.d))
          )
            best = index;
        if (best < 0) break;
        const { d, at } = lists_[best]![positions[best]!++]!;
        work.charge("checks");
        const copied = d.value === undefined ? null : this.#writtenCopyAt(d.value, at);
        if (copied !== null) {
          const copiedTags = typeTags(copied);
          tags = copiedTags.filter((tag) => tag !== "null");
          nullable = sawNull || copiedTags.includes("null");
          byWritten = true;
          decider = d;
          break;
        }
        // an unknown beside a kind does not decide; a null beside one does (A8)
        const items = evaluate(d, at);
        const definite = items.some((item) => item.tag === "unknown") ? [] : deciding(items);
        sawNull ||= items.some((item) => item.tag === "null");
        if (definite.length > 0) {
          tags = [...new Set(definite.map((item) => item.tag))];
          decider = d;
          break;
        }
      }
    }
    if (tags === null) return null;
    // the decided family (ADR 1.2): an integer decider with a number admitted at the path decides numbers (r4.28); a
    // number possible solely through external data admits nothing (r4.36)
    if (
      !byWritten &&
      tags.includes("integer") &&
      withoutEmpty(this.#run(contract.contractOf(key))).some(admitsNumber)
    )
      tags = [...new Set(tags.map((tag) => (tag === "integer" ? "number" : tag)))];
    this.decided.set(key, tags);
    const decidedTags = tags;
    const offends = (items: readonly Item[]): boolean =>
      items.some((item) =>
        item.tag === "null"
          ? !nullable
          : item.tag === "unknown"
            ? contributes(item)
            : item.tag !== "empty" && !decidedTags.some((tag) => fits(item.tag, tag, byWritten)),
      );
    // A5: the direct stores, and the prefixes' whole stores whose source's contract at the path holds an offending kind
    const candidates = new Map<string, Candidate>();
    for (const candidate of direct)
      if (candidate.d.how !== "argument" || transfer || lists.singleSite(candidate.d.fn))
        candidates.set(`${candidate.d.uid}|${candidate.at.join(".")}`, candidate);
    if (transfer && path.length > 0)
      for (const d of definitions.byKey.get(keyOf(root, [])) ?? [])
        if (lists.live(d) && d.kind === "whole")
          candidates.set(`${d.uid}|${path.join(".")}`, { d, at: path });
    for (const { key: prefix, rest } of prefixes) {
      const stored = contract.prefixStores(prefix);
      // (a read of a host value below its store owes nothing at a decided type: A7's whole-store exception leaves it the
      // boundary check its own path's candidate owes, C9, and it holds no kind and no `null`; a written type checks it)
      const take = (list: Iterable<Definition | null>, again: boolean): void => {
        for (const d of list)
          if (
            d !== null &&
            (byWritten || !this.#hostRead(d.value)) &&
            (again || lists.live(d)) &&
            (d.kind === "whole" || (d.kind === "add" && rest[0] === "element")) &&
            (again ||
              (d.how !== "parameter default" &&
                d.how !== "return" &&
                (d.how !== "argument" || lists.singleSite(d.fn))))
          ) {
            const at = d.kind === "add" && d.how !== "elements" ? rest.slice(1) : rest;
            candidates.set(`${d.uid}|${at.join(".")}`, { d, at });
          }
      };
      for (const entry of stored.list)
        if (offends(this.#run(contract.entryAt(entry, rest)))) take(entry.ds, false);
      for (const sub of contract.relevantSubs(stored, rest))
        if (offends(this.#run(contract.subAt(sub.key, rest)))) take(sub.defs, false);
      // A6: a rejected store is decided again in every pass, where it was rejected
      take(
        (definitions.byKey.get(prefix) ?? []).filter(
          (d) => this.rejected.get(d.uid)?.has(key) === true,
        ),
        true,
      );
    }
    const ordered = [...candidates.values()].sort(
      (a, b) => this.sourceOrder(a.d) - this.sourceOrder(b.d),
    );
    work.charge("checks", ordered.length + sortCost(ordered.length));
    return {
      root,
      path,
      label: this.pathLabel(root, path),
      tags: decidedTags,
      written: byWritten,
      own: writtenTags !== null,
      nullable,
      decider,
      candidates: ordered,
    };
  }

  /**
   * C9 r4.12 (A1–A7): a destination's admitted type: the written type (its null included), else the decider's kinds (a
   * place admission never decided: its contract's kinds, one family), an integer decider widened by an admitted number,
   * with `null` where a null contribution is admitted; never the raw union of contributions.
   */
  public admitted(place: PlaceId, path: readonly string[]): ItemTag[] {
    const { program, contract } = this.pass;
    const written = writtenOf(program.place(place).kind);
    const term = written === null ? null : termAt(written, path);
    if (term !== null) return [...new Set(typeTags(term).filter((tag) => tag !== "unknown"))];
    const kinds = withoutEmpty(this.#run(contract.contractOf(keyOf(place, path))));
    let tags = [
      ...(this.decided.get(keyOf(place, path)) ??
        new Set(kinds.filter((item) => concrete(item)).map((item) => item.tag))),
    ];
    if (tags.includes("integer") && kinds.some(admitsNumber))
      tags = [...new Set(tags.map((tag) => (tag === "integer" ? "number" : tag)))];
    return tags.length > 0 && kinds.some((item) => item.tag === "null") ? [...tags, "null"] : tags;
  }

  /** Whether no store on the path or a prefix of it was rejected (A6) or copies a written binding (A4). */
  #clean(root: PlaceId, path: readonly string[]): boolean {
    for (let length = 0; length <= path.length; length += 1) {
      this.pass.program.work.charge("checks");
      const at = keyOf(root, path.slice(0, length));
      if (this.#rejectedKeys.has(at) || this.#a4Keys.has(at)) return false;
    }
    return true;
  }

  /**
   * A prefix's whole stores in source order (A2's lazy scan), or its adds; a single-site parameter starts as its argument.
   * A read of a host value decides no path below it (external data, no kind and no `null`), so the scan passes none.
   */
  #wholeOf(key: Key, add: boolean): Definition[] {
    const memoKey = `${key}|${add}`;
    let list = this.#whole.get(memoKey);
    if (list === undefined) {
      const { definitions, lists, program } = this.pass;
      list = (definitions.byKey.get(key) ?? []).filter(
        (d) =>
          lists.live(d) &&
          !this.#hostRead(d.value) &&
          (add
            ? d.kind === "add"
            : d.kind === "whole" &&
              d.how !== "parameter default" &&
              d.how !== "return" &&
              (d.how !== "argument" || lists.singleSite(d.fn))),
      );
      program.work.charge("checks", sortCost(list.length));
      list.sort((a, b) => this.sourceOrder(a) - this.sourceOrder(b));
      this.#whole.set(memoKey, list);
    }
    return list;
  }

  /** Whether a value is a read of a host value: external data, with no kind and no `null` at any path. */
  #hostRead(value: PlaceId | undefined): boolean {
    const { program } = this.pass;
    const binding = value === undefined ? undefined : program.occurrenceOf.get(value);
    return binding !== undefined && program.isHost(binding);
  }

  /** §3.3: a value's contract kinds, `null` with an unknown. */
  #quietKinds(value: PlaceId | undefined): ItemTag[] | null {
    if (value === undefined) return null;
    const items = withoutEmpty(this.#run(this.pass.contract.contractOfValueAt(value, [])));
    return items.length === 0 || items.some((item) => item.tag === "unknown")
      ? null
      : items.map((item) => item.tag);
  }

  // ------------------------------------------------------------------------------------------- literals

  /** The paths a literal's structure contributes: its objects' fields and its collections' elements, at every depth. */
  public literalPaths(value: PlaceId): string[][] {
    const { program, definitions } = this.pass;
    const out: string[][] = [];
    const pending: [PlaceId, string[]][] = [[value, []]];
    while (pending.length > 0) {
      const [current, path] = pending.pop()!;
      for (const has of program.hasOf.get(current) ?? [])
        for (const [name, term] of fieldsOf(has.type)) {
          program.work.charge("indexSteps");
          const below = [...path, name];
          out.push(below);
          if (term.kind === "ref" && below.length < 256)
            for (const d of definitions.cellDefs.get(term.place) ?? [])
              pending.push([d.value!, below]);
        }
    }
    return out;
  }

  /** A literal value's stores at one step, in evaluation order: a property's one store, a collection's every element. */
  public literalChildren(value: PlaceId, step: string): Definition[] {
    const { program, definitions } = this.pass;
    const out: Definition[] = [];
    for (const has of program.hasOf.get(value) ?? []) {
      const term =
        has.type.kind === "object"
          ? (has.type.properties ?? []).find((property) => propertyStep(property.name) === step)
              ?.type
          : step === "element" &&
              (has.type.kind === "list" || has.type.kind === "set" || has.type.kind === "dict")
            ? has.type.element
            : undefined;
      if (term?.kind === "ref") out.push(...(definitions.cellDefs.get(term.place) ?? []));
    }
    program.work.charge("checks", sortCost(out.length));
    return out.sort(
      (a, b) =>
        (program.places[a.value!]?.site?.start ?? 0) - (program.places[b.value!]?.site?.start ?? 0),
    );
  }

  /**
   * r4.35: an error for a contribution inside literals sits at the innermost offending expression: the stored value
   * walked along the path through record fields, collection elements and dict values, in evaluation order, to the first
   * value at the path's end whose own items offend.
   */
  public offendingAt(
    d: Definition,
    at: readonly string[],
    leaf: (items: readonly Item[]) => boolean,
  ): Definition | null {
    const pending: [PlaceId, FlowNode, number][] = [[d.value!, d.node, 0]];
    while (pending.length > 0) {
      const [value, node, index] = pending.pop()!;
      const children = this.literalChildren(value, at[index]!);
      if (index + 1 === at.length) {
        for (const child of children) {
          this.pass.program.work.charge("checks");
          if (
            leaf(
              withoutEmpty(
                this.#run(this.pass.values.valueItems(child.value!, child.node ?? node, [])),
              ),
            )
          )
            return child;
        }
      } else
        for (let position = children.length - 1; position >= 0; position -= 1)
          pending.push([children[position]!.value!, children[position]!.node ?? node, index + 1]);
    }
    return null;
  }

  /** The site of an error for a store's contribution: the innermost offending expression inside literals, else the store's. */
  public siteAt(
    d: Definition,
    at: readonly string[],
    leaf: (items: readonly Item[]) => boolean,
  ): SourceSite {
    const found = at.length > 0 && d.kind === "whole" ? this.offendingAt(d, at, leaf) : null;
    return found === null ? d.site : (this.pass.program.place(found.value!).site ?? d.site);
  }

  /** A literal value's stores at one step: a property's one store, a collection's every element. */
  #storesAt(value: PlaceId, step: string): readonly Definition[] {
    const { program, definitions } = this.pass;
    for (const has of program.hasOf.get(value) ?? []) {
      const at = termPlace(has.type, step);
      if (at !== null) return definitions.cellDefs.get(at) ?? [];
    }
    return [];
  }

  /**
   * A4: the copies of written bindings a stored value holds, with their paths, directly or through the literals that
   * hold them, in element order; once per value.
   */
  #writtenCopies(
    value: PlaceId,
  ): readonly { readonly path: readonly string[]; readonly term: TypeTerm }[] {
    const known = this.#copies.get(value);
    if (known !== undefined) return known;
    const { program, definitions } = this.pass;
    const out: { path: readonly string[]; term: TypeTerm }[] = [];
    const pending: [PlaceId, readonly string[]][] = [[value, []]];
    while (pending.length > 0) {
      const [current, path] = pending.pop()!;
      program.work.charge("indexSteps");
      const binding = program.occurrenceOf.get(current);
      if (binding !== undefined) {
        const term = writtenOf(program.place(binding).kind);
        if (term !== null) out.push({ path, term });
        continue;
      }
      if (path.length >= 256) continue;
      const next: [PlaceId, readonly string[]][] = [];
      for (const has of program.hasOf.get(current) ?? [])
        for (const [name, term] of fieldsOf(has.type))
          if (term.kind === "ref")
            for (const d of definitions.cellDefs.get(term.place) ?? [])
              next.push([d.value!, [...path, name]]);
      for (let index = next.length - 1; index >= 0; index -= 1) pending.push(next[index]!);
    }
    this.#copies.set(value, out);
    return out;
  }

  /** The written type at a path of the first copy of a written binding on the way, at the rest of the path (A4). */
  #writtenCopyAt(value: PlaceId, at: readonly string[]): TypeTerm | null {
    for (const { path, term } of this.#writtenCopies(value))
      if (path.length <= at.length && path.every((step, index) => at[index] === step)) {
        const found = termAt(term, at.slice(path.length));
        if (found !== null) return found;
      }
    return null;
  }

  /**
   * The whole value a stored value's path lies below (a copy, external data, an operation), not a field or element of
   * one of its literals, or `null`.
   */
  public wholeBelow(value: PlaceId, at: readonly string[]): PlaceId | null {
    const { program } = this.pass;
    let values: readonly PlaceId[] = [value];
    for (let index = 0; index < at.length; index += 1) {
      const whole = values.find((current) => !program.hasOf.has(current));
      if (whole !== undefined) return whole;
      values = values.flatMap((current) =>
        this.#storesAt(current, at[index]!).map((d) => d.value!),
      );
      program.work.charge("checks", values.length);
    }
    return null;
  }

  /**
   * ADR 1.3, A8: a list's, set's or dict's literal elements (values) have one type, the earliest element's, unless the
   * literal lands directly in a written place, whose type then checks them (A1). An error at the element of another.
   */
  public literalElements(
    order: <T>(list: readonly T[]) => T[],
    error: (site: SourceSite) => void,
  ): void {
    const { program, definitions, contract } = this.pass;
    for (const [cell, list] of order([...definitions.cellDefs])) {
      const owner = program.cellOwner.get(cell);
      if (owner?.kind !== "cell" || list.length < 2 || contract.landsIn(owner.owner, []) !== null)
        continue;
      const first = new Map<string, ItemTag>();
      for (const d of list) {
        if (d.value === undefined) continue;
        for (const path of [[], ...this.literalPaths(d.value)]) {
          const kinds = [
            ...new Set(
              deciding(this.valueAt(d, path)).map((item) =>
                NUMERIC.has(item.tag) ? "number" : item.tag,
              ),
            ),
          ];
          if (kinds.length !== 1) continue;
          const at = path.join(".");
          const earlier = first.get(at);
          if (earlier === undefined) first.set(at, kinds[0]!);
          else if (kinds[0] !== earlier) error(d.site);
        }
      }
    }
  }

  // ------------------------------------------------------------------------------------------- C9

  /** A store's destination: the stored value's path; an added value's the collection's element (C9 r4.6). */
  #destPath(d: Definition): readonly string[] {
    return d.kind === "add" ? [...d.path, "element"] : d.path;
  }

  #token(d: Definition): string {
    return writerKey(this.pass.program.writer(d.how, d.site));
  }

  /** An admission's destination: the store's, below it where its ingress stands inside a literal (A8, C9). */
  #admissionPath(d: Definition): readonly string[] {
    const below = this.pass.definitions.ingressSuffix.get(this.#token(d)) ?? [];
    // (an `addAll`'s literal's elements are the destination's own elements)
    return [
      ...this.#destPath(d),
      ...(d.kind === "add" && d.how === "elements" ? below.slice(1) : below),
    ];
  }

  /**
   * The site of a store's check of data that a literal or a choice carried into it (C9 r4.29): the earliest ingress
   * expression where the item came in by this store, else `site`.
   */
  public cellSited(site: SourceSite, item: Item, d: Definition): SourceSite {
    if (item.ingress === undefined) return site;
    const own = this.#token(d);
    const carried = this.pass.definitions.cellSiteOf.get(own);
    if (carried === undefined) return site;
    return this.#tokens(item.ingress).has(own) ? carried : site;
  }

  #tokens(node: IngressNode): Set<string> {
    const tokens = new Set<string>();
    const seen = new Set<IngressNode>();
    const pending = [node];
    while (pending.length > 0) {
      const current = pending.pop()!;
      if (seen.has(current)) continue;
      seen.add(current);
      this.pass.program.work.charge("checks");
      if ("store" in current) tokens.add(writerKey(current.store));
      else if ("parts" in current) pending.push(...current.parts);
      else if (current.contents !== null) pending.push(current.contents);
    }
    return tokens;
  }

  /** C9: the boundary check of an ingress store, once, against its destination's admitted type when it is published. */
  public boundaryAt(d: Definition): void {
    this.#pending.set(d.uid, d);
  }

  /** C10, C9: host data in a fallback or a default is checked at its own read, against its own unknown contract. */
  #boundaryAtRead(value: PlaceId): void {
    if (this.#readSeen.has(value)) return;
    this.#readSeen.add(value);
    const operation = this.pass.program.opOf.get(value);
    // (F18's own check is the boundary)
    if (operation !== undefined && this.#f18Admission(operation) !== null) return;
    const site = this.pass.program.place(value).site;
    if (site === null) return;
    const label = this.pass.program.textAt(site);
    this.readChecks.push(
      boundaryCheck(
        site,
        label,
        ["unknown"],
        `validate external data entering ${label} against its own unknown contract`,
      ),
    );
  }

  /**
   * C9: an external item a consumer meets brings the boundary check of each ingress store it came in by, whichever
   * consumer asks first; host data that no ingress store brought is checked at the consumer (`here`) against `unknown`
   * (r4.10: the kinds the consumer needs are its own obligation).
   */
  public boundaryFor(item: Item, here: Obligation | null): void {
    if (!isExternal(item)) return;
    const { definitions, program } = this.pass;
    if (item.ingress !== undefined) {
      const pending = [item.ingress];
      while (pending.length > 0) {
        const node = pending.pop()!;
        if (this.#walked.has(node)) continue;
        this.#walked.add(node);
        program.work.charge("checks");
        if ("parts" in node) pending.push(...node.parts);
        else if (!("store" in node)) {
          if (node.contents !== null) pending.push(node.contents);
        } else {
          const token = writerKey(node.store);
          const d = definitions.storeByToken.get(token);
          if (d !== undefined) this.boundaryAt(d);
          else {
            const read = definitions.readIngress.get(token);
            if (read !== undefined) this.#boundaryAtRead(read);
          }
        }
      }
      if (item.loose !== true) return;
    }
    if (here === null) return;
    const at = `${here.target}|${here.site.file}:${here.site.start}`;
    if (this.#hostSeen.has(at)) return;
    this.#hostSeen.add(at);
    this.readChecks.push({
      ...here,
      kind: "copy-type",
      against: ["unknown"],
      on: `validate external data ${here.target}`,
      boundary: true,
    });
  }

  public boundariesAt(items: readonly Item[], here: Obligation | null): void {
    for (const item of items) this.boundaryFor(item, here);
  }

  /** F18: a load or `fromJson` with an expected type that no store takes in is checked where it runs, against that type. */
  #f18Admission(
    c: CorePass["program"]["constraints"][number],
  ): { readonly label: string; readonly tags: readonly ItemTag[] } | null {
    if (!("result" in c)) return null;
    const token = this.pass.definitions.ingressStore.get(c.result);
    return token === undefined || this.pass.definitions.readIngress.has(writerKey(token))
      ? this.#f18Kinds(c)
      : null;
  }

  #f18Kinds(
    c: CorePass["program"]["constraints"][number],
  ): { readonly label: string; readonly tags: readonly ItemTag[] } | null {
    if (!("result" in c)) return null;
    const known = this.#f18.get(c.result);
    if (known !== undefined) return known;
    const { program, contract, values } = this.pass;
    const parses =
      c.kind === "operation" &&
      c.contract.family === "conversion" &&
      conversionCategory(c.contract.name)?.kind === "parses";
    let found: { readonly label: string; readonly tags: readonly ItemTag[] } | null = null;
    const node = c.kind === "load" || parses ? program.exprAt(c.site) : null;
    if (node !== null && program.live(node)) {
      const items = withoutEmpty(this.#run(values.valueItems(c.result, node, [])));
      const tags: ItemTag[] = [
        ...new Set(items.filter((item) => concrete(item)).map((item) => item.tag)),
      ];
      // the admitted domain keeps its null: a nullable written type, or an untyped place's `default: null`
      const written = (c.kind === "load" ? c.receiver : null) ?? contract.landsIn(c.result, []);
      const term = written === null ? null : termAt(written, []);
      if (
        tags.length > 0 &&
        items.some((item) => item.tag === "null") &&
        (term === null || typeTags(term).includes("null"))
      )
        tags.push("null");
      if (tags.length > 0) found = { label: `${parses ? "fromJson" : "load"}.result`, tags };
    }
    this.#f18.set(c.result, found);
    return found;
  }

  /**
   * F18, C9: the checks of loads and `fromJson` calls that no store takes in; and the stores of a typed ingress or of an
   * ingress value into a place with an admitted type (a parameter default too, r4.28; an argument or a return that
   * carries a typed load or `fromJson`, Sol M3 r8), checked when the boundaries are published.
   */
  public ingressStores(): void {
    const { program, definitions, lists } = this.pass;
    for (const c of program.constraints) {
      const found = this.#f18Admission(c);
      if (found === null) continue;
      this.readChecks.push(
        boundaryCheck(
          c.site,
          found.label,
          found.tags.map(requiredKind),
          `validate external data entering ${found.label} against ${found.tags.join("|")}`,
        ),
      );
    }
    const typed = new Set<string>();
    for (const [value, token] of definitions.ingressStore) {
      program.work.charge("checks");
      const operation = program.opOf.get(value);
      if (
        !definitions.readIngress.has(writerKey(token)) &&
        operation !== undefined &&
        this.#f18Kinds(operation) !== null
      )
        typed.add(writerKey(token));
    }
    for (const d of [
      ...definitions.storeDefs,
      ...definitions.transferDefs.filter(
        (found) =>
          found.how === "parameter default" ||
          ((found.how === "argument" || found.how === "return") && typed.has(this.#token(found))),
      ),
    ])
      if (
        d.kind === "whole" &&
        lists.live(d) &&
        d.value !== undefined &&
        (definitions.ingress.has(d.value) || typed.has(this.#token(d))) &&
        program.live(d.node)
      )
        this.#typed.push(d);
  }

  /** The boundary checks of the ingress stores, published once every place is decided. */
  public publish(): void {
    for (const d of this.#typed)
      if (this.admitted(d.place, this.#destPath(d)).length > 0) this.boundaryAt(d);
    const { definitions } = this.pass;
    for (const d of [...this.#pending.values()].sort((a, b) => a.uid - b.uid)) {
      const path = this.#admissionPath(d);
      const tags = this.admitted(d.place, path);
      const label = this.pathLabel(d.place, path);
      const against: RequiredKind[] = tags.length > 0 ? tags.map(requiredKind) : ["unknown"];
      const site = definitions.cellSiteOf.get(this.#token(d)) ?? d.site;
      const key = keyOf(d.place, path);
      const check = boundaryCheck(
        site,
        label,
        against,
        `validate external data entering ${label} against ${against.join("|")}`,
      );
      const list = this.boundaries.get(key);
      if (list === undefined) this.boundaries.set(key, [check]);
      else list.push(check);
    }
  }
}

/** A boundary check (C9): `copy-type` against the destination's own contract. */
function boundaryCheck(
  site: SourceSite,
  target: string,
  against: readonly RequiredKind[],
  on: string,
): Obligation {
  return {
    kind: "copy-type",
    target,
    against,
    on,
    site: { file: site.file, start: site.start, end: site.end },
    boundary: true,
  };
}

/** A required kind as an obligation names it. */
export function requiredKind(tag: ItemTag): RequiredKind {
  if (tag === "empty") throw new Error("The emptiness mark is no kind a check requires.");
  return tag;
}

/** The fields of a literal's type: an object's properties, a collection's element. */
function fieldsOf(term: TypeTerm): readonly (readonly [string, TypeTerm])[] {
  if (term.kind === "object")
    return (term.properties ?? []).map(
      (property) => [propertyStep(property.name), property.type] as const,
    );
  if (term.kind === "list" || term.kind === "set" || term.kind === "dict")
    return [["element", term.element]];
  return [];
}

/** The cell or property place of a literal type at one step, or `null`. */
function termPlace(term: TypeTerm, step: string): PlaceId | null {
  const at =
    term.kind === "object"
      ? (term.properties ?? []).find((property) => propertyStep(property.name) === step)?.type
      : step === "element" && (term.kind === "list" || term.kind === "set" || term.kind === "dict")
        ? term.element
        : undefined;
  return at?.kind === "ref" ? at.place : null;
}
