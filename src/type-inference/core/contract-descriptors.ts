import { compileChild, runCompileTask, type CompileTask } from "../../compile-continuation.js";
import type { TypePlan, TypePlanName, TypePropertyPlan } from "../../plan/model.js";
import {
  isScalarKind,
  NULL_TYPE,
  openType,
  union,
  UNKNOWN_TYPE,
  type StaticType,
} from "../../static-types.js";
import { typePlan } from "../../type-plans.js";
import { VALUE_KINDS, type PlainKind, type ValueKind } from "../../value-kinds.js";
import type { PlaceId, SourceSite } from "../graph.js";
import type { Closure, Unsettled } from "./admission/closure.js";
import { concrete } from "./admission/kinds.js";
import type { AdmittedType, CorePass } from "./answers.js";
import { REASON, type Item, type ItemTag } from "./items.js";
import { propertyStep, type CoreProgram } from "./program.js";
import { retainedModule } from "./retained/retained.js";

// The contract proof/descriptor service (#1526): a store's required contract, assembled level by
// level from the stable admission pass's proofs, as an immutable descriptor one per distinct contract, with whether its
// proof is complete, proved open or lost.

/**
 * The deepest nesting of collections whose element types the slice's facts follow: a place or a written type with a
 * collection at this depth is outside the slice (`backend.ts` rejects it), so no fact is cut short. The candidate's cut,
 * not a language rule: the facts' type keys, the plan's conversion and the backend's slice rule follow no deeper.
 */
export const SLICE_DEPTH = 256;

/**
 * One distinct contract: a plan type, frozen, one node per distinct contract in an analysis's table (`ContractTable`),
 * so equal contracts share it by reference. Where a store's check is made, the receiving place's name belongs to the
 * check (`TypeCheckPlan.place`), never to the contract.
 */
export type ContractRef = TypePlan;

/** Each analysis's passes so far, and each pass's number among them: the admission epoch its contracts belong to. */
const PASSES = retainedModule<CoreProgram, number>("contract-descriptors.PASSES", "weakMap");
const EPOCHS = retainedModule<CorePass, number>("contract-descriptors.EPOCHS", "weakMap");

/** Numbers a new admission pass of `program` (`createPass`), its contracts' epoch. */
export function newEpoch(program: CoreProgram, pass: CorePass): number {
  const epoch = (PASSES().get(program) ?? 0) + 1;
  PASSES().set(program, epoch);
  EPOCHS().set(pass, epoch);
  return epoch;
}

/** A pass's epoch (`newEpoch`); 0 for one no analysis numbered. */
export function epochOf(pass: CorePass): number {
  return EPOCHS().get(pass) ?? 0;
}

/** A level of a place: its root and the path below it. */
export interface ContractLevel {
  readonly place: PlaceId;
  readonly path: readonly string[];
}

/**
 * A store's required contract: complete (each level written, decided, or proved open), open (nothing constrains it), or
 * lost (a required level's proof is unfinished: the stop of the analysis or of a decision cut it; or, in a receiving
 * completion, a decision it read would reject a store or retarget a selecting store, #1526). A lost contract keeps
 * the part it holds (`partial`); it is never complete.
 */
export type ContractResult =
  | { readonly state: "complete"; readonly ref: ContractRef; readonly epoch: number }
  | {
      readonly state: "open";
      /** The level that proves it open, and by what (`null`: a written term of no place). */
      readonly proof: {
        readonly place: PlaceId | null;
        readonly path: readonly string[];
        readonly by: LevelProof["by"];
      };
      readonly epoch: number;
    }
  | {
      readonly state: "lost";
      readonly required: readonly ContractLevel[];
      /**
       * What cut it: the analysis's stop, a decision's stop at its allowance, a stop while it was captured, or a
       * completion decision it read that would reject a store (A6) or give a selecting store another target (#1275).
       */
      readonly cause: "stop" | "decision" | "extraction" | Unsettled;
      readonly partial: ContractRef | null;
    };

/** The plan type a result's check carries: a complete contract, a lost one's part, none for an open one. */
export function checkedType(result: ContractResult): ContractRef | null {
  return result.state === "complete" ? result.ref : result.state === "lost" ? result.partial : null;
}

/** What one level of a place proves (`ContractReader.level`). */
export interface LevelProof {
  readonly by: "written" | "decided" | "undecided";
  /** Its kinds: written or decided, else (admission decided nothing) its contract's. */
  readonly tags: readonly ItemTag[];
  /** Whether a copy of a written type decides it (A4): its properties are the written type's, not filled. */
  readonly inherited: boolean;
  /**
   * Whether its proof is unfinished: admission decided nothing while its contract holds a kind admission decides by
   * (without a stop every such level is decided, A2) or the unknown a stop leaves (`REASON.budget`).
   */
  readonly unfinished: boolean;
}

/**
 * A level's proof from its admitted type and, where admission decided nothing, its contract's kinds (asked only then).
 */
export function levelProof(admitted: AdmittedType, contract: () => readonly Item[]): LevelProof {
  if (admitted.by !== "undecided")
    return {
      by: admitted.by,
      tags: [...admitted.kinds],
      inherited: admitted.by === "decided" && admitted.inherited,
      unfinished: false,
    };
  const kinds = contract();
  return {
    by: "undecided",
    tags: kinds.map((item) => item.tag),
    inherited: false,
    unfinished: kinds.some(
      (item) => concrete(item) || (item.tag === "unknown" && (item.reasons & REASON.budget) !== 0),
    ),
  };
}

/** The reader over the stable admission pass: each level's proof, and a decided object's property names. */
export interface ContractReader {
  level(place: PlaceId, path: readonly string[]): LevelProof;
  properties(place: PlaceId, path: readonly string[]): ReadonlySet<string>;
}

/** The literal records below a level, which give a decided object's properties their order. */
export interface RecordsBelow<R> {
  readonly elements: R;
  field(name: string): R;
  order(names: ReadonlySet<string>): readonly string[];
}

/**
 * A place's level walk, the one the store contracts and the facts share: the kinds at `path` and at each element step
 * below it, down to the first level that holds no collection. A collection at `limit` deep leaves the slice's facts
 * (`SLICE_DEPTH`).
 */
export function levelWalk(
  kindsAt: (path: readonly string[]) => readonly ItemTag[],
  path: readonly string[],
  limit = SLICE_DEPTH,
): (readonly ItemTag[])[] {
  const levels: (readonly ItemTag[])[] = [];
  for (let at = [...path]; ; at = [...at, "element"]) {
    const tags = kindsAt(at);
    levels.push(tags);
    if (!tags.some((tag) => COLLECTIONS.has(tag))) break;
    if (at.length + 1 >= limit) throw new SliceDepth();
  }
  return levels;
}

/** A place's collections nested deeper than the slice's facts follow (`levelWalk`). */
export class SliceDepth extends Error {
  public constructor() {
    super("A place of the slice holds collections deeper than its facts follow.");
  }
}

/** The type of a level walk, built from the deepest level up. */
export function typeOfLevels(levels: readonly (readonly ItemTag[])[]): StaticType {
  let type: StaticType = openType();
  for (let depth = levels.length - 1; depth >= 0; depth -= 1)
    type = typeOfKinds(levels[depth]!, type);
  return type;
}

/**
 * A type of these kinds for the facts: each kind's closed type (`closedType`), a collection's with `element` as its
 * element type; no kind is `?`. The slice's variables hold one kind or one numeric family, so one element type serves.
 */
export function typeOfKinds(tags: readonly ItemTag[], element: StaticType): StaticType {
  const kinds = [...new Set(tags)].filter((tag) => tag !== "empty");
  if (kinds.length === 0) return openType();
  return union(
    kinds.map((tag): StaticType =>
      tag === "list" || tag === "set" || tag === "dict"
        ? { kind: tag, element }
        : (closedType(tag) ?? UNKNOWN_TYPE),
    ),
  );
}

function isPlain(kind: ValueKind): kind is PlainKind {
  return VALUE_KINDS[kind].type === "kind";
}

/** An item's kind as a closed `StaticType` (the structure below it is asked through `project`). */
export function closedType(tag: ItemTag): StaticType | null {
  if (tag === "unknown" || tag === "empty") return null;
  if (tag === "null") return NULL_TYPE;
  if (isScalarKind(tag)) return { kind: "scalar", name: tag };
  if (tag === "list" || tag === "set" || tag === "dict")
    return { kind: tag, element: UNKNOWN_TYPE };
  if (tag === "object") return { kind: "object", properties: null };
  if (isPlain(tag)) return { kind: tag };
  return UNKNOWN_TYPE;
}

/** The kinds that hold elements. */
export const COLLECTIONS: ReadonlySet<ItemTag> = new Set(["list", "set", "dict"]);

/** A contract as far as it was built for one place and path, and the levels whose proof it lacks. */
interface Assembled {
  readonly plan: ContractRef | null;
  readonly lost: readonly ContractLevel[];
  readonly by: LevelProof["by"];
}

/**
 * The service: each place's contract at a path assembled once (the first asker's records give its properties' order),
 * level by level on a task stack, so a deep contract does not deepen the native stack. A level's kinds are its proof's
 * (`levelWalk`); a collection's elements are filled below it, and an object's properties where admission decided the
 * object and no written type gives it, each by its own contract, an undecided one left out. Asks the reader nothing a
 * contract's levels do not need, in the order the levels are filled.
 */
export class ContractDescriptors<R> {
  readonly #table = new ContractTable();
  readonly #known = new Map<string, Assembled>();

  public constructor(
    private readonly reader: ContractReader,
    private readonly below: (records: R) => RecordsBelow<R>,
    /** The admission pass the proofs are read from. */
    private readonly epoch: number,
    /** Whether the analysis stopped (a lost level's cause), else a decision did. */
    private readonly stopped: boolean,
    private readonly limit = SLICE_DEPTH,
    /**
     * The receiving closure of a pass that completes frozen proofs (#1526): each place's contract assembled at
     * a path is its cell (an extent), its kept assembly a read of it, and an assembly the closure invalidated goes
     * (`forget`), so the next read assembles it anew.
     */
    private readonly cells: Closure | null = null,
  ) {}

  /** The assembly of `place|path` goes (the closure invalidated it): its next read assembles it anew. */
  public forget(key: string): void {
    this.#known.delete(key);
  }

  /** A written type's or a retained copy's term as a contract: complete, or open where it constrains nothing. */
  public written(
    plan: TypePlan | null,
    place: PlaceId | null,
    path: readonly string[],
  ): ContractResult {
    if (plan !== null)
      return { state: "complete", ref: this.#table.intern(plan), epoch: this.epoch };
    return { state: "open", proof: { place, path, by: "written" }, epoch: this.epoch };
  }

  /** The contract of `place` at `path`; `outside` leaves the slice where a level lies `limit` deep. */
  public result(
    place: PlaceId,
    path: readonly string[],
    records: R,
    outside: () => never,
  ): ContractResult {
    const { plan, lost, by } = runCompileTask(this.#contract(place, path, records, outside));
    if (lost.length > 0)
      return {
        state: "lost",
        required: [...new Set(lost)],
        cause: this.stopped ? "stop" : "decision",
        partial: plan,
      };
    if (plan === null) return { state: "open", proof: { place, path, by }, epoch: this.epoch };
    return { state: "complete", ref: plan, epoch: this.epoch };
  }

  *#contract(
    place: PlaceId,
    path: readonly string[],
    records: R,
    outside: () => never,
  ): CompileTask<Assembled> {
    const key = `${place}|${path.join(".")}`;
    const known = this.#known.get(key);
    if (known !== undefined) {
      this.cells?.took("extent", key);
      return known;
    }
    // (an extent cell of the receiving closure's where a completion pass assembles it, #1526)
    const entered = this.cells?.enter("extent", key) ?? false;
    try {
      const lost: ContractLevel[] = [];
      let by: LevelProof["by"] | null = null;
      let levels: (readonly ItemTag[])[];
      try {
        levels = levelWalk(
          (at) => {
            const proof = this.reader.level(place, at);
            by ??= proof.by;
            if (proof.unfinished) lost.push({ place, path: at });
            return proof.tags;
          },
          path,
          this.limit,
        );
      } catch (error) {
        // (collections nested deeper than the slice follows: the program leaves the slice there, as at an object's or a
        // collection's depth below, never with the walk's own error; `a.f=[a.f]` failed the compile so, #1646)
        if (!(error instanceof SliceDepth)) throw error;
        outside();
      }
      const admitted = typePlan(typeOfLevels(levels));
      const plan =
        admitted === null
          ? null
          : yield* compileChild(this.#fill(place, path, admitted, records, outside, lost));
      const assembled: Assembled = { plan, lost, by: by! };
      this.#known.set(key, assembled);
      return assembled;
    } finally {
      this.cells?.leave(entered);
    }
  }

  *#fill(
    place: PlaceId,
    path: readonly string[],
    plan: TypePlan,
    records: R,
    outside: () => never,
    lost: ContractLevel[],
  ): CompileTask<ContractRef> {
    switch (plan.kind) {
      case "union": {
        const members: ContractRef[] = [];
        for (const member of plan.members)
          members.push(
            yield* compileChild(this.#fill(place, path, member, records, outside, lost)),
          );
        return this.#table.union(members);
      }
      case "list":
      case "set":
      case "dict":
        if (plan.element === null) return this.#table.intern(plan);
        if (path.length + 1 >= this.limit) outside();
        return this.#table.collection(
          plan.kind,
          yield* compileChild(
            this.#fill(
              place,
              [...path, "element"],
              plan.element,
              this.below(records).elements,
              outside,
              lost,
            ),
          ),
        );
      case "object": {
        const level = this.reader.level(place, path);
        if (plan.properties.length > 0 || level.by !== "decided" || level.inherited)
          return this.#table.intern(plan);
        if (path.length + 1 >= this.limit) outside();
        const properties: TypePropertyPlan[] = [];
        const below = this.below(records);
        for (const name of below.order(this.reader.properties(place, path))) {
          const step = [...path, propertyStep(name)];
          const proof = this.reader.level(place, step);
          if (proof.by === "undecided") {
            if (proof.unfinished) lost.push({ place, path: step });
            continue;
          }
          const child = yield* compileChild(
            this.#contract(place, step, below.field(name), outside),
          );
          for (const level of child.lost) lost.push(level);
          if (child.plan !== null) properties.push({ name, type: child.plan });
        }
        return this.#table.object(properties);
      }
      default:
        return this.#table.intern(plan);
    }
  }
}

/** A trie node of `ContractTable`: the node its path of keys ends at, and the steps below. */
interface Trie {
  node: ContractRef | undefined;
  readonly next: Map<unknown, Trie>;
}

function trie(): Trie {
  return { node: undefined, next: new Map() };
}

/** The node a path of keys ends at in `root`, made by `make` the first time. */
function at(root: Trie, keys: readonly unknown[], make: () => ContractRef): ContractRef {
  let node = root;
  for (const key of keys) {
    let next = node.next.get(key);
    if (next === undefined) node.next.set(key, (next = trie()));
    node = next;
  }
  return (node.node ??= make());
}

/**
 * The distinct contracts of one analysis, each one frozen node: a kind by its name, a collection by its element's node,
 * an object by its properties' names and nodes in order, a union by its members' nodes in order. Keyed by its parts'
 * nodes, never by a text of the whole.
 */
class ContractTable {
  readonly #made = new WeakSet<object>();
  readonly #names = new Map<string, ContractRef>();
  readonly #collections = new Map<string, Map<ContractRef | null, ContractRef>>();
  readonly #objects = trie();
  readonly #extra = trie();
  readonly #unions = trie();

  #frozen(node: ContractRef): ContractRef {
    if (node.kind === "object") {
      for (const property of node.properties) Object.freeze(property);
      Object.freeze(node.properties);
    } else if (node.kind === "union") Object.freeze(node.members);
    this.#made.add(Object.freeze(node));
    return node;
  }

  public collection(kind: "list" | "set" | "dict", element: ContractRef | null): ContractRef {
    let byElement = this.#collections.get(kind);
    if (byElement === undefined) this.#collections.set(kind, (byElement = new Map()));
    let node = byElement.get(element);
    if (node === undefined) byElement.set(element, (node = this.#frozen({ kind, element })));
    return node;
  }

  public object(properties: readonly TypePropertyPlan[], keepExtra = false): ContractRef {
    return at(
      keepExtra ? this.#extra : this.#objects,
      properties.flatMap((property) => [property.name, property.type]),
      () =>
        this.#frozen(
          keepExtra
            ? { kind: "object", properties: properties.map((p) => ({ ...p })), keepExtra: true }
            : { kind: "object", properties: properties.map((p) => ({ ...p })) },
        ),
    );
  }

  public union(members: readonly ContractRef[]): ContractRef {
    return at(this.#unions, members, () => this.#frozen({ kind: "union", members: [...members] }));
  }

  /** A plan type's node, each part made a node first (from the deepest up, on an explicit stack). */
  public intern(plan: TypePlan): ContractRef {
    if (this.#made.has(plan)) return plan;
    const done = new Map<TypePlan, ContractRef>();
    const node = (part: TypePlan): ContractRef => (this.#made.has(part) ? part : done.get(part)!);
    const pending: { readonly plan: TypePlan; expanded: boolean }[] = [{ plan, expanded: false }];
    while (pending.length > 0) {
      const top = pending.at(-1)!;
      if (this.#made.has(top.plan) || done.has(top.plan)) {
        pending.pop();
        continue;
      }
      if (!top.expanded) {
        top.expanded = true;
        for (const part of parts(top.plan)) pending.push({ plan: part, expanded: false });
        continue;
      }
      pending.pop();
      const at = top.plan;
      done.set(
        at,
        at.kind === "list" || at.kind === "set" || at.kind === "dict"
          ? this.collection(at.kind, at.element === null ? null : node(at.element))
          : at.kind === "object"
            ? this.object(
                at.properties.map((property) => ({
                  name: property.name,
                  type: node(property.type),
                })),
                at.keepExtra === true,
              )
            : at.kind === "union"
              ? this.union(at.members.map(node))
              : this.#leaf(at.kind),
      );
    }
    return done.get(plan)!;
  }

  #leaf(kind: TypePlanName): ContractRef {
    let node = this.#names.get(kind);
    if (node === undefined) this.#names.set(kind, (node = this.#frozen({ kind })));
    return node;
  }
}

/** A plan type's parts: a collection's element, an object's properties' types, a union's members. */
function parts(plan: TypePlan): readonly TypePlan[] {
  if (plan.kind === "list" || plan.kind === "set" || plan.kind === "dict")
    return plan.element === null ? [] : [plan.element];
  if (plan.kind === "object") return plan.properties.map((property) => property.type);
  return plan.kind === "union" ? plan.members : [];
}

/** A check's required contract: the store's site and the destination it stores into, the place and the path below it. */
export interface ContractRequest {
  readonly site: SourceSite;
  readonly place: PlaceId;
  readonly path: readonly string[];
}

/** A request's contract as captured (`captureContracts`). */
export interface CapturedContract extends ContractRequest {
  readonly result: ContractResult;
}

/** No literal records below a level: a captured contract's properties take the order their names are found in. */
const NO_RECORDS: RecordsBelow<null> = {
  elements: null,
  field: () => null,
  order: (names) => [...names],
};

/**
 * One request's contract from `descriptors` (`ContractDescriptors.result`), `null` where it lies deeper than the slice
 * follows: left to the check, where the program leaves the slice.
 */
export function extractContract(
  descriptors: ContractDescriptors<null>,
  place: PlaceId,
  path: readonly string[],
): ContractResult | null {
  try {
    return descriptors.result(place, path, null, () => {
      throw new SliceDepth();
    });
  } catch (error) {
    if (!(error instanceof SliceDepth)) throw error;
    return null;
  }
}

/** A capture's descriptor service: no literal records below a level, so properties take the order found. */
export function captureDescriptors(
  reader: ContractReader,
  epoch: number,
  cells: Closure | null = null,
): ContractDescriptors<null> {
  return new ContractDescriptors<null>(reader, () => NO_RECORDS, epoch, false, SLICE_DEPTH, cells);
}

/**
 * The capture of the contracts the stores owing a check require (#1526): each request's contract
 * from `reader` over the settled admission pass, in order, kept in `into`, its levels decided and their contracts
 * solved while nothing stops the solver, so a later stop finds them retained. The first request deeper than the slice
 * follows ends the capture: the program has left the slice there, as the lowering's check of that store leaves it and
 * requests nothing more, so that request and every later one stay unrecorded, as outside the slice's syntax (no `Lost`,
 * no diagnostic; the second half of the one gate, `slice-syntax.ts` the first). A stop while it runs (`isStop`;
 * `charge` the work of finding the requests, charged first) leaves the request it cut and every later one lost with the
 * cause `extraction`, and is thrown on: nothing is reclassified. The request at which the program left the slice, or
 * `null`.
 */
export function captureContracts(
  requests: readonly ContractRequest[],
  reader: ContractReader,
  epoch: number,
  into: CapturedContract[],
  isStop: (error: unknown) => boolean,
  charge: () => void,
): ContractRequest | null {
  const descriptors = new ContractDescriptors<null>(reader, () => NO_RECORDS, epoch, false);
  let next = 0;
  try {
    // (finding the requests is the capture's work too: a stop there cuts every one of them)
    charge();
    for (; next < requests.length; next += 1) {
      const request = requests[next]!;
      try {
        const result = descriptors.result(request.place, request.path, null, () => {
          throw new SliceDepth();
        });
        into.push({ ...request, result });
      } catch (error) {
        if (!(error instanceof SliceDepth)) throw error;
        // (the program has left the slice: nothing more to capture)
        return request;
      }
    }
    return null;
  } catch (error) {
    if (isStop(error))
      for (; next < requests.length; next += 1) {
        const { place, path } = requests[next]!;
        into.push({
          ...requests[next]!,
          result: {
            state: "lost",
            required: [{ place, path }],
            cause: "extraction",
            partial: null,
          },
        });
      }
    throw error;
  }
}
