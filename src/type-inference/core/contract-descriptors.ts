import { compileChild, runCompileTask, type CompileTask } from "../../compiler/continuation.js";
import type { TypePlan, TypePlanName, TypePropertyPlan } from "../../plan/model.js";
import { openType, union, UNKNOWN_TYPE, type StaticType } from "../../static-types.js";
import { typePlan } from "../../type-plans.js";
import type { PlaceId } from "../graph.js";
import { concrete } from "./admission/kinds.js";
import { closedType, type PlaceAnswer } from "./answers.js";
import { REASON, type ItemTag } from "./items.js";
import { propertyStep } from "./program.js";

// The contract proof/descriptor service (#1526 phase A, TABLE r4.278): a store's required contract, assembled level by
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

/** A level of a place: its root and the path below it. */
export interface ContractLevel {
  readonly place: PlaceId;
  readonly path: readonly string[];
}

/**
 * A store's required contract: complete (each level written, decided, or proved open), open (nothing constrains it), or
 * lost (a required level's proof is unfinished: the stop of the analysis or of a decision cut it). A lost contract keeps
 * the part it holds (`partial`), which the plan carries until decision 2 (TABLE r4.269, r4.275); it is never complete.
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
      readonly cause: "stop" | "decision";
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

/** A level's proof from the place's answer at it. */
export function levelProof(answer: PlaceAnswer): LevelProof {
  const { admitted, contract } = answer;
  if (admitted.by !== "undecided")
    return {
      by: admitted.by,
      tags: [...admitted.kinds],
      inherited: admitted.by === "decided" && admitted.inherited,
      unfinished: false,
    };
  return {
    by: "undecided",
    tags: contract.kinds.map((item) => item.tag),
    inherited: false,
    unfinished: contract.kinds.some(
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
    if (at.length + 1 >= limit)
      throw new Error("A place of the slice holds collections deeper than its facts follow.");
  }
  return levels;
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
  ) {}

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
    if (known !== undefined) return known;
    const lost: ContractLevel[] = [];
    let by: LevelProof["by"] | null = null;
    const levels = levelWalk(
      (at) => {
        const proof = this.reader.level(place, at);
        by ??= proof.by;
        if (proof.unfinished) lost.push({ place, path: at });
        return proof.tags;
      },
      path,
      this.limit,
    );
    const admitted = typePlan(typeOfLevels(levels));
    const plan =
      admitted === null
        ? null
        : yield* compileChild(this.#fill(place, path, admitted, records, outside, lost));
    const assembled: Assembled = { plan, lost, by: by! };
    this.#known.set(key, assembled);
    return assembled;
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
