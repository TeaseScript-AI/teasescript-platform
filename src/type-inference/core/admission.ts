import type { PlaceId, SourceSite, TypeTerm } from "../graph.js";
import type { CorePass } from "./answers.js";
import { choiceLabels, defaultOf, REFERENCE, termAt, typeTags, writtenOf } from "./contract.js";
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
import {
  conversionCategory,
  dictList,
  interactionCategory,
  methodCategory,
} from "./method-categories.js";
import { propertyStep, stepName } from "./program.js";
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

/** A contribution of a stored value at one path (`#stopsOf`): its order of evaluation, value and node, its written type. */
interface Stop {
  readonly order: number;
  readonly value: PlaceId;
  readonly node: FlowNode;
  /** A copy of a written binding's written type, else `null`. */
  readonly term: TypeTerm | null;
}

/** A stored value's contributions by path (`#stopsOf`): written copies, other whole values, and literals. */
interface Stops {
  readonly written: Map<string, Stop[]>;
  readonly values: Map<string, Stop[]>;
  readonly literals: Map<string, Stop[]>;
}

/** The values at one depth of a stored value's path, and the first of them no literal of it holds (`wholeBelow`). */
interface Level {
  readonly values: readonly PlaceId[];
  readonly whole: PlaceId | null;
}

/**
 * The known structure of a stored value or a source key (F2): the paths below it its literals and the stores below the
 * key give, and the source keys copied or called below it, each where it stands; below a source key, its elements only
 * (`#depthOf`).
 */
interface Structure {
  readonly paths: readonly (readonly string[])[];
  readonly sources: readonly { readonly below: readonly string[]; readonly key: Key }[];
}

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
  /** The previous pass's rejected stores by the place and path each was rejected at (A6). */
  readonly #retaken = new Map<Key, Definition[]>();
  readonly #a4Keys = new Set<Key>();
  /** The parameters with a default (ADR 0021 1.5). */
  readonly #defaulted = new Set<PlaceId>();
  readonly #a4Copies: {
    readonly place: PlaceId;
    readonly path: readonly string[];
    readonly term: TypeTerm;
  }[] = [];
  /** Whether each decision admits `null` (a copy of a written type without one does not, A4). */
  readonly #nullable = new Map<Key, boolean>();
  /** The site of the contribution each decision took (S3 §1's admitted answer), `null` for a written type. */
  readonly #deciderSites = new Map<Key, SourceSite | null>();
  readonly #copies = new Map<
    PlaceId,
    readonly { readonly path: readonly string[]; readonly term: TypeTerm }[]
  >();
  readonly #whole = new Map<string, Definition[]>();
  readonly #fields = new WeakMap<TypeTerm, Map<string, TypeTerm>>();
  readonly #stops = new Map<PlaceId, Stops>();
  /** The own structure of each stored value (`v`) and source key (`k`), and each source key's element depth, F2. */
  readonly #structures = new Map<string, Structure>();
  readonly #depths = new Map<Key, number>();
  #keyBound: number | null = null;
  #below: Map<Key, (readonly string[])[]> | null = null;
  readonly #takeables = new WeakMap<
    ReadonlySet<Definition | null>,
    { readonly wholes: readonly Definition[]; readonly adds: readonly Definition[] }[]
  >();
  /** `wholeBelow`'s values per stored value and path prefix. */
  readonly #levels = new Map<string, Level>();
  readonly #pending = new Map<number, Definition>();
  readonly #typed: Definition[] = [];
  readonly #carried: Definition[] = [];
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
    const { definitions, program } = pass;
    for (const list of definitions.byKey.values()) {
      program.work.charge("indexSteps", list.length);
      for (const d of list) {
        const keys = rejected.get(d.uid);
        if (keys === undefined) continue;
        this.#rejectedKeys.add(d.key);
        for (const key of keys) {
          const retaken = this.#retaken.get(key);
          if (retaken === undefined) this.#retaken.set(key, [d]);
          else retaken.push(d);
        }
      }
    }
    for (const d of definitions.transferDefs)
      if (d.how === "parameter default") this.#defaulted.add(d.place);
    // A4: the copies of written bindings the stores, adds, returns, parameter defaults and single-site arguments bring
    // (a multi-site argument decides nothing, F21), where they land
    for (const d of [...definitions.storeDefs, ...definitions.transferDefs])
      if (
        (d.kind === "whole" || d.kind === "add") &&
        d.value !== undefined &&
        (d.how !== "argument" || pass.lists.singleSite(d.fn)) &&
        !this.#besideDefault(d)
      )
        for (const { path, term } of this.#writtenCopies(d.value)) {
          const at = [
            ...d.path,
            ...(d.kind === "add" && d.how !== "elements" ? ["element"] : []),
            ...path,
          ];
          this.#a4Keys.add(keyOf(d.place, at));
          this.#a4Copies.push({ place: d.place, path: at, term });
        }
  }

  #run<T>(work: Work<T>): T {
    return this.host.run(work);
  }

  /**
   * A6: a definite contribution that does not fit at a place's path is rejected, a return against its own result's
   * decision too (F23), so it leaves the result's contract (an argument stays: the parameter is its callee's); in the
   * next pass it is decided again there.
   */
  public reject(d: Definition, root: PlaceId, path: readonly string[]): void {
    if (d.how === "argument") return;
    let keys = this.newlyRejected.get(d.uid);
    if (keys === undefined) this.newlyRejected.set(d.uid, (keys = new Set()));
    keys.add(keyOf(root, path));
  }

  /**
   * ADR 0021 1.6: source order, in which a declaration's start value comes before every other store into its place; a
   * single-site parameter's is its argument (F21).
   */
  public sourceOrder(d: Definition): number {
    return d.how === "initializer" || (d.how === "argument" && this.pass.lists.singleSite(d.fn))
      ? -1
      : d.site.file * 1e9 + d.site.start;
  }

  /**
   * F21, ADR 0021 1.5: an argument for an unannotated parameter with a default. Each call types such a parameter from
   * its argument, and the default is the parameter's start value, checked once at the function against the body: the
   * argument decides nothing and is no candidate, so the two never constrain each other. Without a default a single-site
   * argument is the start value (F21); a written parameter checks every argument (A9, C7).
   */
  #besideDefault(d: Definition): boolean {
    return (
      d.how === "argument" &&
      this.#defaulted.has(d.place) &&
      writtenOf(this.pass.program.place(d.place).kind) === null
    );
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
    const { program, definitions, lists } = this.pass;
    const work = program.work;
    const tracked = new Set<Key>([...definitions.byKey.keys(), ...definitions.candidates.keys()]);
    for (const c of program.constraints)
      if (c.kind === "project") {
        const target = program.targetRoot(c.into);
        if (!program.cellOwner.has(target.root) && !program.hasOf.has(target.root))
          tracked.add(keyOf(target.root, target.path));
      }
    for (const [, binding] of program.occurrenceOf) tracked.add(keyOf(binding, []));
    // the stores, adds, returns, parameter defaults and single-site arguments into each key (a multi-site argument
    // decides nothing, F21)
    const reaching = [...definitions.storeDefs, ...definitions.transferDefs].filter(
      (d) =>
        (d.kind === "whole" || d.kind === "add") &&
        (d.how !== "argument" || lists.singleSite(d.fn)) &&
        !this.#besideDefault(d),
    );
    const stores = new Map<Key, number>();
    for (const d of reaching)
      for (const key of [d.key, ...prefixesOf(d.key)]) {
        work.charge("indexSteps");
        stores.set(key, (stores.get(key) ?? 0) + 1);
      }
    // a stored value's structure where another store or add reaches the place or below it: its literals', and below a
    // copy or a call its source's elements (F2), the deepest once per path it lands at (its prefixes follow below)
    const deepest = new Map<Key, number>();
    for (const d of reaching)
      if ((stores.get(d.key) ?? 0) > 1) {
        const base = [...d.path, ...(d.kind === "add" && d.how !== "elements" ? ["element"] : [])];
        const structure = this.#valueStructure(d.value!);
        for (const path of structure.paths) tracked.add(keyOf(d.place, [...base, ...path]));
        for (const { below, key } of structure.sources) {
          work.charge("indexSteps");
          const landing = keyOf(d.place, [...base, ...below]);
          const depth = this.#depthOf(key);
          if (depth <= (deepest.get(landing) ?? 0)) continue;
          deepest.set(landing, depth);
          tracked.add(keyOf(d.place, [...base, ...below, ...Array<string>(depth).fill("element")]));
        }
      }
    // a literal holding a named value (a copy, a call, what an operation carries of either) decides the paths its own
    // structure gives with its store, read or not, so the named value's uncertain contents meet C1 there (the owner's
    // F1, round 10 B1)
    for (const d of reaching)
      if ((stores.get(d.key) ?? 0) === 1) {
        const structure = this.#valueStructure(d.value!);
        if (structure.sources.length === 0) continue;
        const base = [...d.path, ...(d.kind === "add" && d.how !== "elements" ? ["element"] : [])];
        for (const path of structure.paths) {
          work.charge("indexSteps");
          tracked.add(keyOf(d.place, [...base, ...path]));
        }
      }
    // C9: where each ingress store's external data stands below its destination, decided with the store whether a
    // consumer reads the place or not (the owner's F1)
    for (const [token, d] of definitions.storeByToken) {
      if (!lists.live(d)) continue;
      for (const way of definitions.ingressWays.get(token)?.values() ?? []) {
        work.charge("indexSteps");
        // (an `addAll`'s literal's elements are the destination's own elements)
        const below = d.kind === "add" && d.how === "elements" ? way.slice(1) : way;
        if (below.length > 0) tracked.add(keyOf(d.place, [...this.#destPath(d), ...below]));
      }
    }
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
    // A1, A8: a written collection's elements at every depth; A4: a copied written type's paths, where the copy lands
    // and below, whether a read asks for them or not
    for (const place of program.places) {
      const written = writtenOf(place.kind);
      const paths = roots.get(place.id);
      if (written === null || paths === undefined) continue;
      for (let path = ["element"]; termAt(written, path) !== null; path = [...path, "element"])
        paths.add(path.join("."));
    }
    const copied = new Map<Key, Set<TypeTerm>>();
    for (const { place, path, term } of this.#a4Copies) {
      // (once per landing path and written type: k copies of one binding into one literal are one)
      const at = keyOf(place, path);
      let terms = copied.get(at);
      if (terms === undefined) copied.set(at, (terms = new Set()));
      work.charge("indexSteps");
      if (terms.has(term)) continue;
      terms.add(term);
      let paths = roots.get(place);
      if (paths === undefined) roots.set(place, (paths = new Set()));
      paths.add(path.join("."));
      for (let below = ["element"]; termAt(term, below) !== null; below = [...below, "element"]) {
        work.charge("indexSteps");
        paths.add([...path, ...below].join("."));
      }
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
    const direct = (definitions.candidates.get(key) ?? []).filter(
      (candidate) => !this.#besideDefault(candidate.d),
    );
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
    let deciderSite: SourceSite | null = null;
    // an inferred root whose every store's contract is plain scalar kinds of one family accepts every store
    if (tags === null && path.length === 0 && !this.#a4Keys.has(keyOf(root, []))) {
      let plain = true;
      const all: ItemTag[] = [];
      for (const { d, at } of direct) {
        work.charge("checks");
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
      // (each list is in source order and read only as far as the scan goes: a prefix's stores are listed once per pass)
      const own = direct.filter(
        (candidate) =>
          ((candidate.d.how !== "argument" || lists.singleSite(candidate.d.fn)) &&
            candidate.d.kind !== "add") ||
          candidate.at.length === 0,
      );
      own.sort((a, b) => this.sourceOrder(a.d) - this.sourceOrder(b.d));
      work.charge("checks", direct.length + sortCost(own.length));
      const scans: {
        readonly ds: readonly Definition[];
        readonly at: (index: number) => readonly string[];
      }[] = [{ ds: own.map((candidate) => candidate.d), at: (index) => own[index]!.at }];
      for (const { key: prefix, rest } of prefixes)
        scans.push({ ds: this.#wholeOf(prefix, false), at: () => rest });
      for (const { key: prefix, rest } of prefixes)
        if (rest[0] === "element") {
          const adds = this.#wholeOf(prefix, true);
          scans.push({
            ds: adds,
            at: (index) => (adds[index]!.how !== "elements" ? rest.slice(1) : rest),
          });
        }
      const positions = scans.map(() => 0);
      let sawNull = false;
      for (;;) {
        let best = -1;
        for (let index = 0; index < scans.length; index += 1)
          if (
            positions[index]! < scans[index]!.ds.length &&
            (best < 0 ||
              this.sourceOrder(scans[index]!.ds[positions[index]!]!) <
                this.sourceOrder(scans[best]!.ds[positions[best]!]!))
          )
            best = index;
        if (best < 0) break;
        const position = positions[best]!++;
        const d = scans[best]!.ds[position]!;
        const at = scans[best]!.at(position);
        work.charge("checks", scans.length);
        const first = d.value === undefined ? null : this.#earliestDecider(d.value, d.node, at);
        const copied = first?.term ?? null;
        if (copied !== null) {
          // (its type stays strict, but a literal's `null` elements beside the copy make the place optional, ADR 0021
          // 1.3, A8)
          const copiedTags = typeTags(copied);
          tags = copiedTags.filter((tag) => tag !== "null");
          nullable =
            sawNull ||
            copiedTags.includes("null") ||
            (this.pass.program.hasOf.has(d.value!) &&
              evaluate(d, at).some((item) => item.tag === "null"));
          byWritten = true;
          decider = d;
          deciderSite = first?.site ?? d.site;
          break;
        }
        // an unknown beside a kind does not decide, unless a literal's own element decides beside it; a null beside one
        // does (A8)
        const items = evaluate(d, at);
        const definite =
          first === null && items.some((item) => item.tag === "unknown") ? [] : deciding(items);
        sawNull ||= items.some((item) => item.tag === "null");
        if (definite.length > 0) {
          tags = [...new Set(definite.map((item) => item.tag))];
          decider = d;
          deciderSite = first?.site ?? d.site;
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
    this.#nullable.set(key, nullable);
    this.#deciderSites.set(key, deciderSite);
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
    work.charge("checks", direct.length);
    for (const candidate of direct)
      if (candidate.d.how !== "argument" || transfer || lists.singleSite(candidate.d.fn))
        candidates.set(`${candidate.d.uid}|${candidate.at.join(".")}`, candidate);
    if (transfer && path.length > 0)
      for (const d of definitions.byKey.get(keyOf(root, [])) ?? [])
        if (lists.live(d) && d.kind === "whole")
          candidates.set(`${d.uid}|${path.join(".")}`, { d, at: path });
    for (const { key: prefix, rest } of prefixes) {
      const stored = contract.prefixStores(prefix);
      const take = (d: Definition): void => {
        const at = d.kind === "add" && d.how !== "elements" ? rest.slice(1) : rest;
        candidates.set(`${d.uid}|${at.join(".")}`, { d, at });
      };
      const takeAll = (stores: ReadonlySet<Definition | null>): void => {
        const { wholes, adds } = this.#takeable(stores, byWritten);
        work.charge("checks", wholes.length);
        for (const d of wholes) take(d);
        if (rest[0] !== "element") return;
        work.charge("checks", adds.length);
        for (const d of adds) take(d);
      };
      for (const entry of stored.list) {
        work.charge("checks");
        if (offends(this.#run(contract.entryAt(entry, rest)))) takeAll(entry.ds);
      }
      for (const sub of contract.relevantSubs(stored, rest)) {
        work.charge("checks");
        if (offends(this.#run(contract.subAt(sub.key, rest)))) takeAll(sub.defs);
      }
      // A6: a rejected store is decided again in every pass, where it was rejected
      const retaken = this.#retaken.get(key) ?? [];
      work.charge("checks", retaken.length);
      for (const d of retaken)
        if (
          d.key === prefix &&
          (byWritten || !this.#hostRead(d.value)) &&
          (d.kind === "whole" || (d.kind === "add" && rest[0] === "element"))
        )
          take(d);
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
   * C9 r4.12 (A1–A7): a destination's admitted type: the written type (its null included), else the decided kinds (an
   * integer decider already widened by an admitted number, a copy of a written integer never: A4), else, where
   * admission decided nothing, the contract's kinds, one family, an integer widened by an admitted number; with `null`
   * where a null contribution is admitted and the decision admits one (a copy of a written type without it does not);
   * never the raw union of contributions.
   */
  public admitted(place: PlaceId, path: readonly string[]): ItemTag[] {
    const { program, contract } = this.pass;
    const written = writtenOf(program.place(place).kind);
    const term = written === null ? null : termAt(written, path);
    if (term !== null) return [...new Set(typeTags(term).filter((tag) => tag !== "unknown"))];
    const kinds = withoutEmpty(this.#run(contract.contractOf(keyOf(place, path))));
    const key = keyOf(place, path);
    const decided = this.decided.get(key);
    let tags = [
      ...(decided ?? new Set(kinds.filter((item) => concrete(item)).map((item) => item.tag))),
    ];
    if (decided === undefined && tags.includes("integer") && kinds.some(admitsNumber))
      tags = [...new Set(tags.map((tag) => (tag === "integer" ? "number" : tag)))];
    return tags.length > 0 &&
      this.#nullable.get(key) !== false &&
      kinds.some((item) => item.tag === "null")
      ? [...tags, "null"]
      : tags;
  }

  /**
   * The site of the contribution that decided a place's path (A2's earliest definite one, A4's copy), `null` where no
   * store decided it (a written type, or the contract's kinds, C9 r4.12).
   */
  public deciderAt(place: PlaceId, path: readonly string[]): SourceSite | null {
    return this.#deciderSites.get(keyOf(place, path)) ?? null;
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
   * A prefix's whole stores in source order (A2's lazy scan), returns, parameter defaults and single-site arguments among
   * them (a single-site parameter starts as its argument), or its adds. A read of a host value decides no path below it
   * (external data, no kind and no `null`), so the scan passes none.
   */
  #wholeOf(key: Key, add: boolean): Definition[] {
    const memoKey = `${key}|${add}`;
    let list = this.#whole.get(memoKey);
    if (list === undefined) {
      const { definitions, lists, program } = this.pass;
      const stores = definitions.byKey.get(key) ?? [];
      program.work.charge("indexSteps", stores.length);
      list = stores.filter(
        (d) =>
          lists.live(d) &&
          !this.#hostRead(d.value) &&
          (add
            ? d.kind === "add"
            : d.kind === "whole" &&
              (d.how !== "argument" || lists.singleSite(d.fn)) &&
              !this.#besideDefault(d)),
      );
      program.work.charge("checks", sortCost(list.length));
      list.sort((a, b) => this.sourceOrder(a) - this.sourceOrder(b));
      this.#whole.set(memoKey, list);
    }
    return list;
  }

  /**
   * A5: the stores that brought a prefix's source, as candidates: live, no multi-site argument (F21) (a return, a
   * parameter default and a single-site argument are stores into the result or the parameter, F20–F23), and a read of
   * a host value only against a written type (a read of one below its store owes nothing
   * at a decided type: A7's whole-store exception leaves it the boundary check its own path's candidate owes, C9, and it
   * holds no kind and no `null`); the whole stores and the adds, once per set of stores.
   */
  #takeable(
    stores: ReadonlySet<Definition | null>,
    byWritten: boolean,
  ): { readonly wholes: readonly Definition[]; readonly adds: readonly Definition[] } {
    let known = this.#takeables.get(stores);
    if (known === undefined) this.#takeables.set(stores, (known = []));
    const index = byWritten ? 1 : 0;
    const found = known[index];
    if (found !== undefined) return found;
    const { lists, program } = this.pass;
    program.work.charge("indexSteps", stores.size);
    const wholes: Definition[] = [];
    const adds: Definition[] = [];
    for (const d of stores)
      if (
        d !== null &&
        (byWritten || !this.#hostRead(d.value)) &&
        lists.live(d) &&
        (d.how !== "argument" || lists.singleSite(d.fn)) &&
        !this.#besideDefault(d)
      )
        if (d.kind === "whole") wholes.push(d);
        else if (d.kind === "add") adds.push(d);
    return (known[index] = { wholes, adds });
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

  /**
   * A value's source key: the key a copy reads, a call's callee's result key (F20), a dict's `values` read as its
   * elements (r4.46 (2)); `null` for any other value and for a dict's `keys`, which hold text.
   */
  #sourceOf(value: PlaceId): Key | null {
    const { contract, program } = this.pass;
    const key = contract.copiedKey(value) ?? contract.resultKey(value);
    if (key === null) return null;
    const path: string[] = [];
    for (const [index, step] of keyPath(key).entries()) {
      const list = dictList(step);
      if (list !== undefined) {
        program.work.charge("indexSteps");
        const owner = withoutEmpty(
          this.#run(contract.contractOf(keyOf(keyPlace(key), keyPath(key).slice(0, index)))),
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

  /**
   * The values a value carries, each with the path into it the value is (the walk of `answers.ts` `#propertyNames`):
   * a projection its owner at its step (a loop variable a list's or a set's element, a dict's `values` its elements, its
   * `keys` none, F12, F27, r4.46 (2)), `otherwise` both sides, `get` its receiver's element and its default (F17b), a
   * load's and a parse's default (C10), a copy of a collection's elements its receiver (F10: `take`, `takeLast`,
   * `toList`, `toSet`), a removal its receiver's element (F7), a list's `+` its operands, `askChoice` its unlabelled
   * options' values (V30 §19); `strip` is the path below the value still to read.
   */
  #carriersOf(
    value: PlaceId,
    strip: readonly string[],
  ): readonly (readonly [PlaceId, readonly string[]])[] {
    const { program, contract } = this.pass;
    const kinds = (of: PlaceId): ReadonlySet<ItemTag> =>
      new Set(this.#run(contract.contractOfValue(of)).map((item) => item.tag));
    // (a copy of the elements and a `+` give their operands' elements, nothing else of them)
    const elements = strip.length === 0 || strip[0] === "element";
    const projection = program.projOf.get(value);
    if (projection !== undefined) {
      const { owner, step } = projection;
      if (step === "iteration") {
        const of = kinds(owner);
        return of.has("list") || of.has("set") ? [[owner, ["element", ...strip]]] : [];
      }
      const list = dictList(step);
      if (list === undefined) return [[owner, [stepName(step), ...strip]]];
      const of = kinds(owner);
      if ([...of].some((tag) => REFERENCE.has(tag))) return [];
      const out: (readonly [PlaceId, readonly string[]])[] = [];
      if (of.has("object")) out.push([owner, [step, ...strip]]);
      if (of.has("dict") && list === "values" && elements) out.push([owner, strip]);
      return out;
    }
    const c = program.opOf.get(value);
    if (c === undefined) return [];
    if (c.kind === "fallback")
      return [
        [c.left, strip],
        [c.right, strip],
      ];
    if (c.kind === "get")
      return [
        [c.receiver, ["element", ...strip]],
        [c.fallback, strip],
      ];
    if (c.kind === "load") return c.fallback === null ? [] : [[c.fallback, strip]];
    if (c.kind !== "operation") return [];
    const { family, name } = c.contract;
    if (family === "conversion" && conversionCategory(name)?.kind === "parses") {
      const fallback = defaultOf(c);
      return fallback === undefined ? [] : [[fallback, strip]];
    }
    if (family === "method" && c.receiver !== null) {
      const gives = methodCategory(name)?.gives;
      if (gives?.kind === "copy" && elements) return [[c.receiver, strip]];
      if (
        gives?.kind === "removed" &&
        (gives.fromList === "element" || kinds(c.receiver).has("dict"))
      )
        return [[c.receiver, ["element", ...strip]]];
      return [];
    }
    if (family === "operator" && name === "+" && elements)
      return c.arguments.map((argument) => [argument, strip] as const);
    if (family === "interaction" && interactionCategory(name)?.kind === "options") {
      const labels = choiceLabels(c);
      return c.arguments.flatMap((argument, index) =>
        labels[index] === undefined
          ? [
              [argument, ["value", ...strip]] as const,
              [argument, ["element", "value", ...strip]] as const,
            ]
          : [],
      );
    }
    return [];
  }

  /** A stored value's own structure: its literals' fields and elements at every depth, and their sources (F2). */
  #valueStructure(value: PlaceId): Structure {
    const id = `v${value}`;
    let structure = this.#structures.get(id);
    if (structure === undefined) {
      structure = this.#collect([{ value, at: [], strip: [] }]);
      this.#structures.set(id, structure);
    }
    return structure;
  }

  /**
   * A source key's own structure (F2): the elements, at every depth, of the values stored at it or at a prefix of it (an
   * add's below its element), cut to the key's path, and of the keys below it with stores. A copied record's fields are
   * none of it: they are admitted at their first read (A2, TABLE q12).
   */
  #keyStructure(key: Key): Structure {
    const id = `k${key}`;
    const known = this.#structures.get(id);
    if (known !== undefined) return known;
    const { definitions, lists, program } = this.pass;
    const place = keyPlace(key);
    const path = keyPath(key);
    const roots: { value: PlaceId; at: readonly string[]; strip: readonly string[] }[] = [];
    const levels: (readonly string[])[] = [];
    // a store's value standing at `below` (an add's below its element), read at `strip`: below the key, at its path or
    // above it (the rest of the path read into it), or beside it (none)
    const root = (d: Definition, below: readonly string[], strip: readonly string[]): void => {
      program.work.charge("indexSteps");
      if (!((d.kind === "whole" || d.kind === "add") && d.value !== undefined && lists.live(d)))
        return;
      const at = d.kind === "add" && d.how !== "elements" ? [...below, "element"] : below;
      for (let index = 0; index < at.length && index < strip.length; index += 1)
        if (at[index] !== strip[index]) return;
      roots.push(
        at.length > strip.length
          ? { value: d.value, at: at.slice(strip.length), strip: [] }
          : { value: d.value, at: [], strip: strip.slice(at.length) },
      );
    };
    for (let length = 0; length <= path.length; length += 1)
      for (const d of definitions.byKey.get(keyOf(place, path.slice(0, length))) ?? [])
        root(d, [], path.slice(length));
    for (const below of definitions.keysBelow(key)) {
      const at = keyPath(below).slice(path.length);
      if (at.some((step) => step !== "element")) continue;
      levels.push(at);
      for (const d of definitions.byKey.get(below) ?? []) root(d, at, []);
    }
    const structure = this.#collect(roots, levels, true);
    this.#structures.set(id, structure);
    return structure;
  }

  /**
   * The structure of values standing at paths below a value or key: each root's value standing at `at`, read below
   * `strip` (a key's path below a prefix's store, a carrier's step into its value): their literals' fields and elements,
   * walked as their literals nest (below a key its elements only), through the values they carry, and the source key of
   * each value no literal holds, with the levels of the keys below with stores.
   */
  #collect(
    roots: readonly { value: PlaceId; at: readonly string[]; strip: readonly string[] }[],
    levels: readonly (readonly string[])[] = [],
    elements = false,
  ): Structure {
    const { program, definitions } = this.pass;
    const paths = new Map<string, readonly string[]>();
    const sources = new Map<string, { readonly below: readonly string[]; readonly key: Key }>();
    const path = (at: readonly string[]): void => {
      if (at.length > 0 && !paths.has(at.join("."))) paths.set(at.join("."), at);
    };
    for (const at of levels)
      for (let length = 1; length <= at.length; length += 1) path(at.slice(0, length));
    const pending: (readonly [PlaceId, readonly string[], readonly string[]])[] = [];
    for (let index = roots.length - 1; index >= 0; index -= 1)
      pending.push([roots[index]!.value, roots[index]!.at, roots[index]!.strip]);
    while (pending.length > 0) {
      const [current, at, strip] = pending.pop()!;
      program.work.charge("indexSteps");
      if (!program.hasOf.has(current)) {
        // a source stands at `at`, read at the rest of the path (a source read at a path no key or read of the program
        // reaches is a recursion: cut); any other value through the values it carries
        const source = this.#sourceOf(current);
        if (source !== null) {
          if (strip.length > 0 && keyPath(source).length + strip.length > this.#longestKey())
            continue;
          const key = keyOf(keyPlace(source), [...keyPath(source), ...strip]);
          sources.set(`${at.join(".")}|${key}`, { below: at, key });
          continue;
        }
        const carried = this.#carriersOf(current, strip);
        for (let index = carried.length - 1; index >= 0; index -= 1)
          pending.push([carried[index]![0], at, carried[index]![1]]);
        continue;
      }
      for (const has of program.hasOf.get(current)!) {
        // while reading into it only the field on the path (its literal's fields indexed once), then every field
        const on = strip.length > 0 ? this.#termAt(has.type, strip[0]!) : undefined;
        const fields: readonly (readonly [string, TypeTerm])[] =
          strip.length === 0 ? fieldsOf(has.type) : on === undefined ? [] : [[strip[0]!, on]];
        for (const [name, term] of fields) {
          program.work.charge("indexSteps");
          if (strip.length === 0 && elements && name !== "element") continue;
          const step = strip.length === 0 ? [...at, name] : at;
          if (strip.length === 0) path(step);
          if (term.kind === "ref")
            for (const d of definitions.cellDefs.get(term.place) ?? [])
              pending.push([d.value!, step, strip.slice(1)]);
        }
      }
    }
    return { paths: [...paths.values()], sources: [...sources.values()] };
  }

  /** The longest path of a key with stores or of a read's or a call's projections in the program. */
  #longestKey(): number {
    if (this.#keyBound !== null) return this.#keyBound;
    const { program, definitions } = this.pass;
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
      for (let index = way.length - 1; index >= 0; index -= 1)
        chains.set(way[index]!, (length += 1));
      longest = Math.max(longest, length);
    }
    return (this.#keyBound = longest);
  }

  /**
   * The element depth of a source key's known structure, its sources' followed (F2): once per key, a cycle of copies
   * (Tarjan's components) one turn of it for each of its keys, so the copies of one source share it and every order
   * gives one answer.
   */
  #depthOf(key: Key): number {
    const known = this.#depths.get(key);
    if (known !== undefined) return known;
    const { program, contract } = this.pass;
    const work = program.work;
    // (a key whose contract holds no collection has no elements to follow)
    const flat = (at: Key): boolean => {
      const none = !withoutEmpty(this.#run(contract.contractOf(at))).some(
        (item) => item.tag === "list" || item.tag === "set" || item.tag === "dict",
      );
      if (none) this.#depths.set(at, 0);
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
      const { sources } = this.#keyStructure(frame.key);
      if (frame.next < sources.length) {
        const target = sources[frame.next++]!.key;
        work.charge("indexSteps");
        if (this.#depths.has(target)) continue;
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
        const own = this.#keyStructure(member);
        for (const path of own.paths) depth = Math.max(depth, path.length);
        for (const source of own.sources) {
          work.charge("indexSteps");
          if (members.has(source.key)) turn = Math.max(turn, source.below.length);
          else depth = Math.max(depth, source.below.length + this.#depths.get(source.key)!);
        }
      }
      for (const member of members) this.#depths.set(member, depth + turn);
    }
    return this.#depths.get(key)!;
  }

  /**
   * A cell element's value as the cell holds it, for sharing a literal's verdicts (F2): a literal holding no source by
   * its structure (the contract's signature), a copy by the definition its read reaches there (its exact path), through
   * the copies that definition stores; `null` for any other, whose value may differ from cell to cell.
   */
  #held(d: Definition): string | null {
    const { contract, exact, program } = this.pass;
    if (d.value === undefined) return "";
    if (program.hasOf.has(d.value))
      return this.#valueStructure(d.value).sources.length === 0
        ? contract.identityOf(d.value).id
        : null;
    let key = contract.copiedKey(d.value);
    let node = d.node;
    const seen = new Set<string>();
    while (key !== null && !seen.has(`${key}|${node.id}`)) {
      program.work.charge("indexSteps");
      seen.add(`${key}|${node.id}`);
      const answer = exact.exactPath(key, node);
      if (!("def" in answer)) return null;
      const { def, rest } = answer;
      const copied =
        def.kind === "whole" && def.value !== undefined ? contract.copiedKey(def.value) : null;
      if (copied === null) return `${def.uid}@${rest.join(".")}`;
      key = keyOf(keyPlace(copied), [...keyPath(copied), ...rest]);
      node = def.node;
    }
    return null;
  }

  /** The paths below a literal's element its known structure gives (F2), and `also`, each once. */
  #pathsBelow(value: PlaceId, also: readonly (readonly string[])[]): (readonly string[])[] {
    const work = this.pass.program.work;
    const out = new Map<string, readonly string[]>();
    const put = (path: readonly string[]): void => {
      work.charge("indexSteps");
      if (!out.has(path.join("."))) out.set(path.join("."), path);
    };
    const structure = this.#valueStructure(value);
    for (const path of structure.paths) put(path);
    for (const { below, key } of structure.sources) {
      let path = below;
      for (let depth = this.#depthOf(key); depth > 0; depth -= 1)
        put((path = [...path, "element"]));
    }
    for (const path of also) put(path);
    return [...out.values()];
  }

  /**
   * The paths below a collection literal's elements that its own literals give or admission decides where the literal
   * lands (a read's path, A2): there a named element's fields are compared too (TABLE q12: a field is copy-only until
   * a literal or a read reaches it).
   */
  #sharedPaths(landing: Key | null, list: readonly Definition[]): (readonly string[])[] {
    const { program } = this.pass;
    const out = new Map<string, readonly string[]>();
    const put = (path: readonly string[]): void => {
      program.work.charge("indexSteps");
      if (path.length > 0 && !out.has(path.join("."))) out.set(path.join("."), path);
    };
    for (const d of list)
      if (d.value !== undefined) for (const path of this.#valueStructure(d.value).paths) put(path);
    if (landing !== null) for (const path of this.#decidedBelow(landing)) put(path);
    return [...out.values()];
  }

  /**
   * Where a collection literal's elements land: the store holding the literal, through the literals around it, at its
   * element step; `null` for a literal no store holds.
   */
  #landing(literal: PlaceId): Key | null {
    const { program, definitions } = this.pass;
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
      return keyOf(d.place, [
        ...(d.kind === "add" && d.how === "elements" ? d.path : this.#destPath(d)),
        ...steps.reverse(),
        "element",
      ]);
    }
  }

  /** The paths admission decides (`groups`) below a key, indexed once by every prefix of each. */
  #decidedBelow(key: Key): readonly (readonly string[])[] {
    if (this.#below === null) {
      this.#below = new Map();
      for (const { root, path } of this.groups())
        for (let length = 0; length < path.length; length += 1) {
          this.pass.program.work.charge("indexSteps");
          const prefix = keyOf(root, path.slice(0, length));
          const paths = this.#below.get(prefix);
          if (paths === undefined) this.#below.set(prefix, [path.slice(length)]);
          else paths.push(path.slice(length));
        }
    }
    return this.#below.get(key) ?? [];
  }

  /** A literal's term at one step: an object's property by its step, a collection's element; built once per literal. */
  #termAt(term: TypeTerm, step: string): TypeTerm | undefined {
    const { work } = this.pass.program;
    work.charge("checks");
    if (term.kind === "list" || term.kind === "set" || term.kind === "dict")
      return step === "element" ? term.element : undefined;
    if (term.kind !== "object") return undefined;
    let fields = this.#fields.get(term);
    if (fields === undefined) {
      fields = new Map();
      for (const property of term.properties ?? []) {
        work.charge("indexSteps");
        const at = propertyStep(property.name);
        if (!fields.has(at)) fields.set(at, property.type);
      }
      this.#fields.set(term, fields);
    }
    return fields.get(step);
  }

  /** A literal value's stores at one step, in evaluation order: a property's one store, a collection's every element. */
  public literalChildren(value: PlaceId, step: string): Definition[] {
    const { program, definitions } = this.pass;
    const out: Definition[] = [];
    for (const has of program.hasOf.get(value) ?? []) {
      const term = this.#termAt(has.type, step);
      if (term?.kind === "ref")
        for (const d of definitions.cellDefs.get(term.place) ?? []) out.push(d);
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
  public storesAt(value: PlaceId, step: string): readonly Definition[] {
    const { program, definitions } = this.pass;
    for (const has of program.hasOf.get(value) ?? []) {
      const at = this.#termAt(has.type, step);
      if (at?.kind === "ref") return definitions.cellDefs.get(at.place) ?? [];
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

  /**
   * A stored value's contributions by the path they stand at, in evaluation order: the copies of written bindings
   * (A4), the other values no literal of it holds (a read, a call, external data), and its literals, whose fields and
   * elements stand below them; once per value.
   */
  #stopsOf(value: PlaceId, node: FlowNode): Stops {
    const known = this.#stops.get(value);
    if (known !== undefined) return known;
    const { program, definitions, contract } = this.pass;
    const stops: Stops = { written: new Map(), values: new Map(), literals: new Map() };
    const sources = new Set<string>();
    const pending: [PlaceId, FlowNode, readonly string[]][] = [[value, node, []]];
    for (let order = 0; pending.length > 0; order += 1) {
      const [current, at, path] = pending.pop()!;
      program.work.charge("indexSteps");
      const binding = program.occurrenceOf.get(current);
      const term = binding === undefined ? null : writtenOf(program.place(binding).kind);
      const literal = term === null && program.hasOf.has(current);
      const map = term !== null ? stops.written : literal ? stops.literals : stops.values;
      const key = path.join(".");
      // (a later copy or call of one source identity at a path holds what the first holds: one stop, F2)
      if (path.length > 0 && map === stops.values && this.#sourceOf(current) !== null) {
        const identity = `${key}|${contract.identityOf(current).id}`;
        if (sources.has(identity)) continue;
        sources.add(identity);
      }
      const stop: Stop = { order, value: current, node: at, term };
      const list = map.get(key);
      if (list === undefined) map.set(key, [stop]);
      else list.push(stop);
      if (!literal) continue;
      const next: (readonly [Definition, string])[] = [];
      for (const has of program.hasOf.get(current) ?? [])
        for (const [name, field] of fieldsOf(has.type))
          if (field.kind === "ref")
            for (const d of definitions.cellDefs.get(field.place) ?? []) next.push([d, name]);
      program.work.charge("checks", sortCost(next.length));
      next.sort(
        ([x], [y]) =>
          (program.places[x.value!]?.site?.start ?? 0) -
          (program.places[y.value!]?.site?.start ?? 0),
      );
      for (let index = next.length - 1; index >= 0; index -= 1) {
        const [d, step] = next[index]!;
        pending.push([d.value!, d.node ?? at, [...path, step]]);
      }
    }
    this.#stops.set(value, stops);
    return stops;
  }

  /**
   * A2, A4, A8 (ADR 0021 1.1–1.3): the earliest contribution in evaluation order that decides a stored value's path: a
   * copy of a written binding (its written type at the rest of the path), or a value whose items there are of definite
   * kinds; a `null` or an unknown decides nothing, and a value an unknown may stand beside (a read, a copy, a call)
   * neither, while a literal's other elements still may (A8: `[1, hostValue]`'s elements are whole numbers, Sol's
   * records for the owner's F1); a later copy never comes before an earlier definite element. The place's decision and
   * the literal's own elements (`literalElements`) both take it, so they cannot pick opposite deciders. `null` where
   * nothing on the path decides.
   */
  #earliestDecider(
    value: PlaceId,
    node: FlowNode,
    at: readonly string[],
  ): { readonly term: TypeTerm | null; readonly site: SourceSite | null } | null {
    const { program, values } = this.pass;
    const stops = this.#stopsOf(value, node);
    const siteOf = (stop: Stop): SourceSite | null => program.places[stop.value]?.site ?? null;
    // the earliest copy whose written type reaches the rest of the path
    let copy: { readonly order: number; readonly term: TypeTerm; readonly stop: Stop } | null =
      null;
    for (let length = 0; length <= at.length; length += 1) {
      program.work.charge("checks");
      for (const stop of stops.written.get(at.slice(0, length).join(".")) ?? []) {
        program.work.charge("checks");
        if (copy !== null && stop.order > copy.order) break;
        const term = termAt(stop.term!, at.slice(length));
        if (term !== null) copy = { order: stop.order, term, stop };
      }
    }
    // the values in evaluation order, those standing above the path's end with its rest, the literals at its end
    const lists: { readonly list: readonly Stop[]; readonly length: number }[] = [];
    for (let length = 0; length <= at.length; length += 1) {
      const list = stops.values.get(at.slice(0, length).join("."));
      if (list !== undefined) lists.push({ list, length });
    }
    const literals = stops.literals.get(at.join("."));
    if (literals !== undefined) lists.push({ list: literals, length: at.length });
    const positions = lists.map(() => 0);
    for (;;) {
      let best = -1;
      for (let index = 0; index < lists.length; index += 1)
        if (
          positions[index]! < lists[index]!.list.length &&
          (best < 0 ||
            lists[index]!.list[positions[index]!]!.order <
              lists[best]!.list[positions[best]!]!.order)
        )
          best = index;
      const next = best < 0 ? null : lists[best]!.list[positions[best]!]!;
      if (next === null || (copy !== null && copy.order < next.order))
        return copy === null ? null : { term: copy.term, site: siteOf(copy.stop) };
      program.work.charge("checks", lists.length);
      positions[best]! += 1;
      const items = withoutEmpty(
        this.#run(values.valueItems(next.value, next.node, at.slice(lists[best]!.length))),
      );
      if (!items.some((item) => item.tag === "unknown") && deciding(items).length > 0)
        return { term: null, site: siteOf(next) };
    }
  }

  /**
   * The whole value a stored value's path lies below (a copy, external data, an operation), not a field or element of
   * one of its literals, or `null`.
   */
  public wholeBelow(value: PlaceId, at: readonly string[]): PlaceId | null {
    const { program } = this.pass;
    // the values at each depth of the path, and the first whole one there, once per value and path prefix: the paths
    // of a stored value share their prefixes (each field of a list's elements its element step)
    let level: Level = { values: [value], whole: program.hasOf.has(value) ? null : value };
    let key = `${value}`;
    for (let index = 0; index + 1 < at.length && level.whole === null; index += 1) {
      key = `${key}.${at[index]!}`;
      let next = this.#levels.get(key);
      if (next === undefined) {
        const values: PlaceId[] = [];
        for (const current of level.values)
          for (const d of this.storesAt(current, at[index]!)) values.push(d.value!);
        program.work.charge("checks", values.length + 1);
        next = { values, whole: values.find((current) => !program.hasOf.has(current)) ?? null };
        this.#levels.set(key, next);
      }
      level = next;
    }
    return at.length > 0 ? level.whole : null;
  }

  /**
   * ADR 0021 1.3, A8: a list's, set's or dict's literal elements (values), and the properties its objects share, have
   * one type at every path their known structure gives, a copy's or a call's its source's (F2): the earliest element's,
   * or a copy of a written binding's written type (A4), unless the literal lands directly in a written place, whose
   * type then checks them (A1). A definite element of another type is an error at the innermost offending expression
   * (r4.35) and is rejected: later uses see the earliest element's type (A6).
   */
  public literalElements(
    order: <T>(list: readonly T[]) => T[],
    error: (site: SourceSite) => void,
  ): void {
    const { program, definitions, contract } = this.pass;
    const family = (tag: ItemTag): ItemTag => (NUMERIC.has(tag) ? "number" : tag);
    type Decided = Map<string, { readonly tags: readonly ItemTag[]; readonly written: boolean }>;
    // per landing and its elements' values as their cells hold them, a cell's deciders and offending elements and paths
    // (F2): a cell of the same values landing there decides and offends as it does, each at its own elements' sites
    const cells = new Map<
      string,
      { readonly first: Decided; readonly verdicts: (readonly [number, readonly string[]])[] }
    >();
    // a named element: one whose structure holds a source (a copy, a call)
    const named = (d: Definition): boolean =>
      d.value !== undefined && this.#valueStructure(d.value).sources.length > 0;
    for (const [cell, list] of order([...definitions.cellDefs])) {
      const owner = program.cellOwner.get(cell);
      if (owner?.kind !== "cell" || list.length < 2 || contract.landsIn(owner.owner, []) !== null)
        continue;
      const landing = list.some(named) ? this.#landing(owner.owner) : null;
      const held = landing === null ? [] : list.map((d) => this.#held(d));
      const memo = landing === null || held.includes(null) ? null : `${landing}|${held.join(",")}`;
      const cached = memo === null ? undefined : cells.get(memo);
      const first: Decided = cached?.first ?? new Map();
      // an element of one family offends where none of its kinds fits: a written type by the kinds themselves (a whole
      // number fits a written integer, a fraction does not), an earliest element's by their family
      const offends = (at: string, tags: readonly ItemTag[]): boolean => {
        const decided = first.get(at)!;
        const families = [...new Set(tags.map(family))];
        return (
          families.length === 1 &&
          (decided.written ? tags : families).every(
            (tag) => !decided.tags.some((ref) => fits(tag, ref, decided.written)),
          )
        );
      };
      // the error at the innermost offending expression (r4.35), the element rejected (A6)
      const offended = (d: Definition, path: readonly string[]): void => {
        const at = path.join(".");
        const inner =
          path.length > 0
            ? this.offendingAt(d, path, (items) =>
                offends(at, [...new Set(deciding(items).map((item) => item.tag))]),
              )
            : null;
        error(inner === null ? d.site : (program.place(inner.value!).site ?? d.site));
        this.reject(d, cell, path);
      };
      if (cached !== undefined) {
        for (const [index, path] of cached.verdicts) offended(list[index]!, path);
        continue;
      }
      const verdicts: (readonly [number, readonly string[]])[] = [];
      if (memo !== null) cells.set(memo, { first, verdicts });
      // a named element's paths: its source's elements, and a record's fields where the literal's own records or a read
      // decide them, never copy-only (A2, TABLE q12); per source identity (the contract's: k copies or k wrappers of one
      // record are one), the paths below its first element where it offends, where each later one offends too (F2)
      const shared = list.some(named) ? this.#sharedPaths(landing, list) : [];
      const offending = new Map<string, (readonly string[])[]>();
      for (const [index, d] of list.entries()) {
        if (d.value === undefined) continue;
        const identity = named(d) ? contract.identityOf(d.value).id : null;
        const known = identity === null ? undefined : offending.get(identity);
        const found: (readonly string[])[] = [];
        if (identity !== null && known === undefined) offending.set(identity, found);
        const below =
          known !== undefined ? [] : this.#pathsBelow(d.value, identity !== null ? shared : []);
        for (const path of [[], ...below]) {
          const at = path.join(".");
          const own = [...new Set(deciding(this.valueAt(d, path)).map((item) => item.tag))];
          if (!first.has(at)) {
            // A4: a copy of a written binding gives its written type, whatever it holds now, where it is the earliest
            // decider on the path
            const copied = this.#earliestDecider(d.value, d.node, path)?.term ?? null;
            const kinds = [...new Set(own.map(family))];
            if (copied !== null)
              first.set(at, {
                tags: typeTags(copied).filter((tag) => tag !== "null" && tag !== "unknown"),
                written: true,
              });
            else if (kinds.length === 1) first.set(at, { tags: kinds, written: false });
            continue;
          }
          if (!offends(at, own)) continue;
          offended(d, path);
          verdicts.push([index, path]);
          if (path.length > 0) found.push(path);
        }
        for (const path of known ?? []) {
          offended(d, path);
          verdicts.push([index, path]);
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
      else if ("parts" in current) for (const part of current.parts) pending.push(part);
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
        if ("parts" in node) for (const part of node.parts) pending.push(part);
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
   * carries a typed load or `fromJson`, Sol M3 r8), and every other ingress store, checked when the boundaries are
   * published where they are owed.
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
    // every other ingress store, a literal, a read or a choice carrying the data, where a type is admitted, whether a
    // consumer reads the place or not (the owner's F1)
    const scheduled = new Set(this.#typed);
    for (const d of definitions.storeByToken.values()) {
      program.work.charge("checks");
      if (!scheduled.has(d) && lists.live(d) && program.live(d.node)) this.#carried.push(d);
    }
  }

  /**
   * The kinds an ingress store's boundary check is against: the destination's admitted type; for an argument beside an
   * unannotated parameter's default, which that default's decision never constrains (F21, ADR 0021 1.5), the
   * argument's own kinds at the boundary's path (a record carrying the ingress its record, a typed ingress its expected
   * kinds, F18, with their `null`), none for external data alone (`unknown`: the runtime's validation of it).
   */
  #againstOf(d: Definition, path: readonly string[]): ItemTag[] {
    if (!this.#besideDefault(d)) return this.admitted(d.place, path);
    const items = this.valueAt(d, path);
    const tags: ItemTag[] = [
      ...new Set(items.filter((item) => concrete(item)).map((item) => item.tag)),
    ];
    return tags.length > 0 && items.some((item) => item.tag === "null") ? [...tags, "null"] : tags;
  }

  /** Whether a store owes its boundary check: some ingress it carries stands where a type is admitted (F1). */
  #owed(d: Definition): boolean {
    const { definitions, program } = this.pass;
    const destination = this.#destPath(d);
    for (const way of definitions.ingressWays.get(this.#token(d))?.values() ?? []) {
      program.work.charge("checks");
      // (an `addAll`'s literal's elements are the destination's own elements)
      const below = d.kind === "add" && d.how === "elements" ? way.slice(1) : way;
      if (this.#againstOf(d, [...destination, ...below]).length > 0) return true;
    }
    return false;
  }

  /** The boundary checks of the ingress stores, published once every place is decided. */
  public publish(): void {
    for (const d of this.#typed)
      if (this.#againstOf(d, this.#destPath(d)).length > 0) this.boundaryAt(d);
    for (const d of this.#carried) if (this.#owed(d)) this.boundaryAt(d);
    const { definitions } = this.pass;
    for (const d of [...this.#pending.values()].sort((a, b) => a.uid - b.uid)) {
      const path = this.#admissionPath(d);
      const tags = this.#againstOf(d, path);
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
