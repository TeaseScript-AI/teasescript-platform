// The contracts the plan's checks read a value as (`Contracts`): each store's, a typed parse's or load's, and a
// fallback's, from the analysis's answers and the written types; and the type-plan helpers they are made of.
import type {
  Expression,
  LetStatement,
  CallExpression,
  LoadExpression,
  BinaryExpression,
} from "../../../ast.js";
import { type TypePlan, type TypeCheckPlan, type TypePropertyPlan } from "../../../plan/model.js";
import { runCompileTask, type CompileTask, compileChild } from "../../../compile-continuation.js";
import { type StaticType, UNKNOWN_TYPE, union } from "../../../static-types.js";
import { typeFromAnnotation } from "../../../static-types/annotations.js";
import { typePlan } from "../../../type-plans.js";
import { lazyDefaultArgument } from "../../../lazy-defaults.js";
import { type ValueKind, VALUE_KIND_NAMES } from "../../../value-kinds.js";
import type { PlaceId, TypeTerm } from "../../graph.js";
import { type Answers, type ValueAnswer, type AdmittedType, closedType } from "../answers.js";
import { joinSteps } from "../budget.js";
import {
  ContractDescriptors,
  type ContractResult,
  levelProof,
  checkedType,
  SLICE_DEPTH,
} from "../contract-descriptors.js";
import { typedDefault as defaultKinds } from "../contract.js";
import { leftOutCompletion } from "../consumers.js";
import { type FlowNode } from "../flow-graph.js";
import { type ItemTag, REASON, type Item } from "../items.js";
import { propertyName, propertyStep } from "../program.js";
import { type RequiredKind } from "../result.js";
import {
  OPEN_BY_STOP,
  OutsideContract,
  SliceIndex,
  type Store,
  declarationOf,
  nodeOf,
  outsideStructure,
  unwrap,
} from "./slice-index.js";

/** The plan of the kinds an obligation requires: each kind, a collection's elements and an object's properties left open. */
export function kindsPlan(kinds: readonly (ItemTag | RequiredKind)[]): TypePlan | null {
  const members = [...new Set(kinds)].flatMap((kind): TypePlan[] =>
    kind === "non-null" || kind === "unknown" || kind === "empty" ? [] : [kindPlan(kind)],
  );
  if (kinds.includes("unknown") || members.length === 0) return null;
  return members.length === 1 ? members[0]! : { kind: "union", members };
}

/** A kind's plan with its parts left open. */
function kindPlan(kind: ValueKind): TypePlan {
  if (kind === "list" || kind === "set" || kind === "dict") return { kind, element: null };
  if (kind === "object") return { kind: "object", properties: [] };
  return { kind };
}

/**
 * Every value: the plan of a level below a typed parse's or load's value whose type nothing settles (an unknown, or a
 * `null` in its default, ADR 0021 2.6), which a record must still have, so that a missing field takes the default's.
 */
const ANY_VALUE: TypePlan = { kind: "union", members: VALUE_KIND_NAMES.map(kindPlan) };

/** Where a value lands directly: the place a store brings it into, and the path below the place's root. */
interface Landing {
  readonly id: PlaceId;
  readonly path: readonly string[];
}

/**
 * The contracts the plan content of one program carries, each read from the core's answers, never rebuilt from the
 * source: a place's contract at a path, objects with their decided properties; the type a typed parse or load reads its
 * value as, the core's own answer at the call; where a fallback lands, for whether its elements may be `null`. Built
 * on one task stack, so deep values do not deepen the native stack.
 */
export class Contracts {
  readonly #landings = new Map<Expression, Landing | null>();
  readonly #literals = new Map<Expression, Expression | null>();
  /** The stores' contracts (`ContractDescriptors`), read through the answers' places. */
  readonly #descriptors: ContractDescriptors<readonly Expression[]>;
  /** Each store's contract result, written by `stored` alone (`results`). */
  readonly #results = new Map<Store, ContractResult>();
  /** Each store's label of the place it stores into (`destination`), once. */
  readonly #destinations = new Map<Store, string | undefined>();

  /**
   * Each store's contract result, recorded by `stored` as it is asked, where it makes one: only the stores
   * `runtimeChecks` asks `stored` about have one. The lost-check gate reads it as the published contracts.
   */
  public get results(): ReadonlyMap<Store, ContractResult> {
    return this.#results;
  }

  public constructor(
    private readonly answers: Answers,
    private readonly index: SliceIndex,
    private readonly lets: ReadonlyMap<PlaceId, LetStatement>,
  ) {
    this.#descriptors = new ContractDescriptors(
      {
        level: (id, path) => {
          const place = answers.place(id, path);
          return levelProof(place.admitted, () => place.contract.kinds);
        },
        properties: (id, path) => answers.placeProperties(id, path),
      },
      (records) => {
        const below = recordsBelow(records, this.#literalOf);
        return {
          elements: below.elements,
          field: (name) => below.fields.get(name) ?? [],
          order: (names) => fieldOrder(names, below, index),
        };
      },
      answers.epoch,
      // (statements nested past the limit stop nothing: a decision's stop is the cause there)
      answers.budget.exhausted !== null && answers.budget.exhausted !== "nesting",
    );
  }

  /**
   * The check of a store: the destination's written type, else the complete type a stop below its path left it to check
   * whole (`Answers.requirement`, #1416), else its contract at the stored path: a complete one's, a lost one's part, none
   * for an open one. It records the store's contract result in `results`, and throws `OutsideContract` for a value
   * whose contract is deeper than the slice follows (`outsideStructure`).
   */
  public stored(store: Store): TypeCheckPlan | null {
    const declaration = declarationOf(this.answers, this.index, this.lets, store);
    const value = store.kind === "letStatement" ? store.initializer : store.value;
    const whole = store.kind === "letStatement" || store.target.kind === "identifier";
    const place = this.answers.at(nodeOf(this.answers, this.index, store))?.place ?? null;
    const required = place === null ? null : this.answers.requirement(place.id, place.path);
    this.destination(store);
    const settled =
      place === null || (whole && declaration.typeAnnotation !== null) || required !== null
        ? null
        : this.#descriptors.result(place.id, place.path, [value], () => outsideStructure(value));
    const result =
      whole && declaration.typeAnnotation !== null
        ? this.#descriptors.written(
            typePlan(typeFromAnnotation(declaration.typeAnnotation)),
            place?.id ?? null,
            place?.path ?? [],
          )
        : required !== null
          ? this.#descriptors.written(
              typePlan(runCompileTask(termTask(required))),
              place!.id,
              place!.path,
            )
          : place === null || settled === null
            ? null
            : this.#completed(place.id, place.path, settled);
    if (result !== null) this.#results.set(store, result);
    const checked = result === null ? null : checkedType(result);
    if (checked === null) return null;
    // (where a stop left the settled pass's contract incomplete, the receiving completion's lists each object's
    // properties as its listings found them: the check lists them by the store's own records, then as the program writes
    // them (#2215). The settled pass's own lists them by the first asker's records: where another store asked first, with
    // records that rank them otherwise, the two differ (#2218). The recorded result, which the lost-check gate reads,
    // keeps the completion's order.)
    const type =
      settled !== null && result !== settled ? this.#inRecordOrder(checked, [value]) : checked;
    const name = [
      declaration.name.name,
      ...(whole ? [] : (place?.path ?? []).map(propertyName)),
    ].join(".");
    return { type, place: `'${name}'` };
  }

  /**
   * The label of the place a store stores into (its variable, then the core's steps), as `stored` reads it, once per
   * store; `undefined` where the answers name no place there. It reads no value and asks for no contract, so a store
   * whose only owed checks are the receiving completion's is asked nothing (#1682).
   */
  public destination(store: Store): string | undefined {
    if (this.#destinations.has(store)) return this.#destinations.get(store);
    const place = this.answers.storedPlace(nodeOf(this.answers, this.index, store));
    const declaration =
      store.kind === "letStatement" ? store : place === null ? undefined : this.lets.get(place.id);
    const label =
      place === null || declaration === undefined
        ? undefined
        : [declaration.name.name, ...place.path].join(".");
    this.#destinations.set(store, label);
    return label;
  }

  /** Whether the receiving completion completed the contract at a store's destination (`#completed`). */
  public completes(store: Store): boolean {
    const place = this.answers.at(nodeOf(this.answers, this.index, store))?.place ?? null;
    return place !== null && this.answers.received(place.id, place.path) !== null;
  }

  /**
   * A store's contract where the settled pass's own is not complete (a decision on its path stopped): the receiving
   * completion's complete contract there (`Answers.received`), else the settled pass's (a lost one's part). A
   * completion's lost result never stands in, so nothing is widened.
   */
  #completed(id: PlaceId, path: readonly string[], settled: ContractResult): ContractResult {
    if (settled.state === "complete" || leftOutCompletion()) return settled;
    return this.answers.received(id, path) ?? settled;
  }

  /**
   * A completion's checked type with each object's properties by `fieldOrder` over the literal records below the store's
   * value, level by level, as `ContractDescriptors` fills a decided object from its first asker's records (#2215). A
   * contract lists properties only where it filled a decided object, so nothing more is asked.
   */
  #inRecordOrder(type: TypePlan, records: readonly Expression[]): TypePlan {
    switch (type.kind) {
      case "union":
        return {
          kind: "union",
          members: type.members.map((member) => this.#inRecordOrder(member, records)),
        };
      case "list":
      case "set":
      case "dict":
        return type.element === null
          ? type
          : {
              kind: type.kind,
              element: this.#inRecordOrder(
                type.element,
                recordsBelow(records, this.#literalOf).elements,
              ),
            };
      case "object": {
        const below = recordsBelow(records, this.#literalOf);
        const byName = new Map(type.properties.map((property) => [property.name, property]));
        const properties = fieldOrder(byName.keys(), below, this.index).map((name) => {
          // EVIDENCE: `fieldOrder` returns `byName`'s own keys, in another order.
          const property = byName.get(name)!;
          return { name, type: this.#inRecordOrder(property.type, below.fields.get(name) ?? []) };
        });
        return type.keepExtra === true
          ? { kind: "object", properties, keepExtra: true }
          : { kind: "object", properties };
      }
      default:
        return type;
    }
  }

  /**
   * The type a typed load or `fromJson` reads its value as: the core's own answer at the call, level by level
   * (`#answerTask`); `null` where the call's kinds hold an unknown or no kind, or a load's key is computed. It throws
   * `OutsideContract`, so the program leaves the slice, where a stop left a level of the answer open (#1767), also one
   * that would otherwise give `null`, where the plan cannot carry the answer exactly (`#answerTask`'s cases), for a
   * typed parse or load into a copy of a written type, and, after a stop before admission settled, for a default that
   * reads a place, unless the call lands in a written scalar destination.
   */
  public expected(call: CallExpression | LoadExpression): TypePlan | null {
    if (call.kind === "loadExpression" && unwrap(call.key).kind !== "stringLiteral") return null;
    // (after a stop only literal data proves a default, by its own syntax at every level (#1460): below a read the
    // answer is the value side's, which the stop left unproven (the stores admission rejects are not settled), so
    // the program leaves the slice rather than read what the natural plan may not, #1526 condition 1, #1767)
    const fallback = call.kind === "loadExpression" ? call.defaultValue : defaultOf(call);
    const landing = this.#landing(call);
    // (a written scalar destination is the reader type itself, whatever its default reads; asked only after such a
    // stop, so an unstopped compile asks nothing more)
    const scalar = (): boolean => {
      const written =
        landing === null ? null : this.answers.place(landing.id, landing.path).admitted;
      return (
        written !== null &&
        written.by === "written" &&
        written.kinds.length > 0 &&
        written.kinds.every((kind) => !STRUCTURED.has(kind))
      );
    };
    if (fallback !== null && stoppedAnalysis(this.answers) && readsPlace(fallback) && !scalar())
      throw new OutsideContract(call, OPEN_BY_STOP);
    const expected = runCompileTask(
      this.#answerTask(
        { node: nodeOf(this.answers, this.index, call), call, landing, keeps: false },
        [],
        [call],
      ),
    );
    // a copy of a written type inherits its source's written type as the typed call's receiving type, at every level
    // the call's value reaches, but the core answers the call by its default there while its later facts follow that
    // answer: the lowering cannot widen it alone
    if (
      landing !== null &&
      expected !== null &&
      levelsOf(expected).some((level) => {
        const admitted = this.answers.place(landing.id, [...landing.path, ...level]).admitted;
        return admitted.by === "decided" && admitted.inherited;
      })
    )
      throw new OutsideContract(call, "a typed parse or load into a copy of a written type");
    return expected;
  }

  /**
   * The literal data a value is at its level, whose records give a record's fields their order (`fieldOrder`): itself,
   * through parentheses and a typed parse's or load's default, each typed call's once (a chain of nested defaults is
   * followed once), `null` for a typed one without a default.
   */
  readonly #literalOf = (value: Expression): Expression | null => {
    const chain: Expression[] = [];
    let found: Expression | null = null;
    for (let node: Expression | null = unwrap(value); node !== null;) {
      const known = this.#literals.get(node);
      if (known !== undefined) {
        found = known;
        break;
      }
      const inner = typedDefault(node);
      if (inner === undefined) {
        found = node;
        break;
      }
      chain.push(node);
      node = inner === null ? null : unwrap(inner);
    }
    for (const call of chain) this.#literals.set(call, found);
    return found;
  };

  /**
   * The complete contract of the value a fallback stands in for at `steps` below it (ADR 0021 7.2): a `get`'s value,
   * an `otherwise`'s left one without `null`, as `#provenanceOf` finds it; `null` for another owner. It throws
   * `OutsideContract` where the plan cannot carry that contract: a join of different written types that no place admits,
   * or a value whose structure the slice does not follow.
   */
  public direct(
    owner: BinaryExpression | CallExpression,
    steps: readonly string[],
  ): TypePlan | null {
    const value =
      owner.kind === "binaryExpression" ? owner.left : getReceiver(owner) === null ? null : owner;
    if (value === null) return null;
    // (a contract's path names a dict's value its element, as every key does)
    const below = steps.map(() => "element");
    const landing = this.#landing(owner);
    const { contract, written } = this.#provenanceOf(
      value,
      below,
      landing === null ? null : { id: landing.id, path: joinSteps(landing.path, below) },
    );
    // a written level, or one a copy inherits from a written type (ADR 0021 1.3), keeps its type; any other is checked
    // in the fallback rule's family, whole numbers with numbers (ADR 0021 1.2, 7.2): never stricter than the fallback
    // rule for the same default written out (#1539)
    const checked = contract === null ? null : numberFamily(contract, (levels) => !written(levels));
    return checked === null || owner.kind === "callExpression" || steps.length > 0
      ? checked
      : withoutNull(checked);
  }

  /**
   * The value an expression gives at `path` below it as the core answers for it, with the provenance of each level below
   * that: the fallback completion's one lookup. Parentheses give their content's value, as `nodeOf` reads them. A
   * place's value has its place's contract, each level written where the core answers its domain as written or as
   * inherited from a written type. A `get`'s value is its receiver's element. An `otherwise` chain's value joins its
   * operands' as the core admits a join: a level is written where any operand that brings a collection (a `null` or
   * a scalar brings none) is written there; the contract is theirs where they agree, else the core's admitted contract
   * of the place the value at `path` lands in (`landing`, the one its receiving check is against), and none where it
   * lands in none or an operand's is open. Any other value is the core's answer for it by its own text (a literal, an
   * operation, another call), unwritten.
   */
  #provenanceOf(value: Expression, path: readonly string[], landing: Landing | null): Provenance {
    const read = unwrap(value);
    const node = nodeOf(this.answers, this.index, read);
    const place = this.answers.at(node)?.place ?? null;
    if (place !== null) {
      const at = joinSteps(place.path, path);
      return {
        contract: this.#contract(place.id, at, read),
        written: (levels) =>
          writtenDomain(this.answers.place(place.id, joinSteps(at, levels)).admitted),
      };
    }
    const receiver = getReceiver(read);
    if (receiver !== null)
      return this.#provenanceOf(receiver, joinSteps(["element"], path), landing);
    if (read.kind === "binaryExpression" && read.operator === "otherwise") {
      const joined = [read.left, read.right]
        .filter((operand) =>
          bringsCollection(this.answers.valueAt(nodeOf(this.answers, this.index, operand), [])),
        )
        .map((operand) => this.#provenanceOf(operand, path, landing));
      const contract = joined[0]?.contract ?? null;
      if (joined.some((part) => part.contract === null))
        return { contract: null, written: () => false };
      if (contract !== null && joined.every((part) => samePlan(part.contract!, contract)))
        return { contract, written: (levels) => joined.some((part) => part.written(levels)) };
      if (contract !== null) {
        // (operands of written types that differ: the core admits the join where it lands, by its copies)
        if (landing === null)
          throw new OutsideContract(read, "a join of different written types that no place admits");
        return {
          contract: this.#contract(landing.id, landing.path, read),
          written: (levels) =>
            writtenDomain(this.answers.place(landing.id, joinSteps(landing.path, levels)).admitted),
        };
      }
    }
    return { contract: runCompileTask(this.#answeredTask(node, path, read)), written: () => false };
  }

  /**
   * The core's answer at `path` below a value no place holds, as a plan: its kinds, whole numbers among numbers as
   * numbers, a collection's elements by the same rule, an object open; open (`null`) where it may hold an unknown or holds
   * nothing.
   */
  *#answeredTask(
    node: FlowNode,
    path: readonly string[],
    at: Expression,
  ): CompileTask<TypePlan | null> {
    const held = new Set<ItemTag>();
    for (const item of this.answers.valueAt(node, path).items)
      if (item.tag !== "empty") held.add(item.tag);
    if (held.has("unknown") || held.size === 0) return null;
    if (path.length + 1 >= SLICE_DEPTH)
      throw new OutsideContract(at, "a value whose structure the slice does not follow");
    if (held.has("number")) held.delete("integer");
    const collection = held.has("list") || held.has("set") || held.has("dict");
    const element = collection
      ? yield* compileChild(this.#answeredTask(node, joinSteps(path, ["element"]), at))
      : null;
    const members = [...held]
      .filter((kind): kind is ValueKind => kind !== "unknown" && kind !== "empty")
      .map((kind) =>
        kind === "list" || kind === "set" || kind === "dict" ? { kind, element } : kindPlan(kind),
      );
    return members.length === 1 ? members[0]! : { kind: "union", members };
  }

  /**
   * Whether an element of a fallback at `steps` below it may be `null`: unless the fallback lands directly in a
   * written place whose type there excludes it.
   */
  public takesNull(owner: Expression, steps: readonly string[]): boolean {
    const landing = this.#landing(owner);
    if (landing === null) return true;
    const admitted = this.answers.place(landing.id, [...landing.path, ...steps]).admitted;
    return admitted.by !== "written" || admitted.kinds.includes("null");
  }

  /**
   * Where `value` lands directly (ADR 0021 rule 7.3): through parentheses, either operand of `otherwise`, the `default:`
   * of a call or a load, a list's or set's element and an object's property, to the value a store brings into a place;
   * `null` where it lands in none.
   */
  #landing(value: Expression): Landing | null {
    const climbed: [Expression, readonly string[]][] = [];
    let base: Landing | null = null;
    for (let node = value; ;) {
      const known = this.#landings.get(node);
      if (known !== undefined) {
        base = known;
        break;
      }
      const parent = this.index.parentOf(node);
      if (parent === undefined) {
        const store = this.index.storeOf(node);
        const place =
          store === undefined ||
          (store.kind === "letStatement" ? store.initializer : store.value) !== node
            ? null
            : (this.answers.at(nodeOf(this.answers, this.index, store))?.place ?? null);
        base = place === null ? null : { id: place.id, path: place.path };
        this.#landings.set(node, base);
        break;
      }
      const step = landingStep(parent, node, this.index);
      if (step === null) {
        this.#landings.set(node, null);
        break;
      }
      climbed.push([node, step]);
      node = parent;
    }
    // the values climbed through land below their parent, from the outermost down
    for (let at = climbed.length - 1; at >= 0; at -= 1) {
      const [node, step] = climbed[at]!;
      base = base === null ? null : { id: base.id, path: [...base.path, ...step] };
      this.#landings.set(node, base);
    }
    return base;
  }

  /** A place's contract at a path as the plan's check carries it (`ContractDescriptors`), for a value read from it. */
  #contract(id: PlaceId, path: readonly string[], at: Expression): TypePlan | null {
    return checkedType(this.#descriptors.result(id, path, [], () => outsideStructure(at)));
  }

  /**
   * The core's answer at `path` below a call's value as a plan: its kinds (a written target's, else the default's),
   * integers among numbers as numbers (the decided family, ADR 0021 1.2), a collection's elements and an object's
   * properties below by the same rule. At the call itself an unknown or no kind gives no plan; below it such a level
   * takes every value (ADR 0021 2.6: `[]` leaves the element type open, a `null` in the default stays unknown). A
   * record's field that some of its sources lack (`missing`) has the kinds the others give, and a missing one is the
   * default's. The program leaves the slice (`OutsideContract`) where the plan cannot carry the core's answer exactly:
   * where a stop left a level open (#1767), where the place the call lands in types such an open level (the core
   * answers the call and the place differently there), where records of a list a parse reads lack fields no default
   * supplies, and deeper than the slice follows.
   */
  *#answerTask(
    at: AnsweredCall,
    path: readonly string[],
    records: readonly Expression[],
  ): CompileTask<TypePlan | null> {
    const found = this.answers.valueAt(at.node, path);
    // below a written `object` the default's own answer, as a typed call takes its default's kinds (`contract.ts`'s
    // `typedDefault`): a `null` field stays open there too
    const decision = at.keeps ? defaultKinds(path, false) : null;
    const answer =
      decision === null
        ? found
        : { ...found, items: decision.answer(decision.choose(found.items), found.items) };
    const held = new Set<ItemTag>();
    let lacking = false;
    for (const item of answer.items) {
      if (item.tag === "unknown" && (item.reasons & REASON.missing) !== 0) {
        lacking = true;
        if (item.reasons !== REASON.missing) held.add("unknown");
      } else if (item.tag !== "empty") held.add(item.tag);
    }
    // (a load's stored reader takes a listed field of an element where the element has it, `matchesValueType`, so a
    // field its elements may lack is the plan's as it is; JSON's requires every listed field: #1458)
    if (lacking && path.includes("element") && at.call.kind !== "loadExpression")
      throw new OutsideContract(at.call, "a value whose structure the slice does not follow");
    // (a level a stop left open is no open level: the plan would read every value there, the natural one its type, so
    // the program leaves the slice rather than publish a check less, #1526 condition 1, #1767)
    if (answer.items.some(stoppedItem)) throw new OutsideContract(at.call, OPEN_BY_STOP);
    if (held.has("number")) held.delete("integer");
    // an unknown, or an empty collection's elements, is open; a known `null` is the `null` type
    if (held.has("unknown") || held.size === 0) {
      if (path.length === 0) return null;
      if (at.landing !== null) {
        // (a level the place admits every kind at, an unrestricted part, V30 §13, types nothing)
        const { admitted } = this.answers.place(at.landing.id, [...at.landing.path, ...path]);
        if (admitted.by !== "undecided" && !admitted.kinds.includes("unknown"))
          throw new OutsideContract(
            at.call,
            "an open part of a typed parse's or load's default that its destination types",
          );
      }
      return ANY_VALUE;
    }
    if (path.length + 1 >= SLICE_DEPTH)
      throw new OutsideContract(at.call, "a value whose structure the slice does not follow");
    const members: TypePlan[] = [];
    const structured =
      held.has("list") || held.has("set") || held.has("dict") || held.has("object");
    const below = structured ? recordsBelow(records, this.#literalOf) : null;
    for (const tag of VALUE_KIND_NAMES.filter((kind) => held.has(kind)))
      if (tag === "list" || tag === "set" || tag === "dict") {
        const element = yield* compileChild(
          this.#answerTask(at, [...path, "element"], below?.elements ?? []),
        );
        // elements that take every value leave the collection open, as a store's check has it
        members.push({ kind: tag, element: element === ANY_VALUE ? null : element });
      } else if (tag === "object") {
        // a level the place's written type leaves any object (`object`), and every level below one, keeps every key of
        // the value; its properties are the default's, each by the literal data's own answer, as the call's below a
        // written `object` takes every value (#1223)
        const opens = !at.keeps && this.#writtenObject(at.landing, path);
        const literal = opens ? this.#literalOf(at.call) : null;
        const inner =
          literal === null
            ? at
            : { ...at, node: nodeOf(this.answers, this.index, literal), keeps: true };
        const own = opens && inner !== at ? this.answers.valueAt(inner.node, path) : null;
        // (below a written `object` the default's own answer, whose names the plan keeps: a level of it a stop left
        // open is no open level either, #1767)
        if (own !== null && own.items.some(stoppedItem))
          throw new OutsideContract(at.call, OPEN_BY_STOP);
        const names = !opens ? answer.properties : own === null ? [] : own.properties;
        const properties: TypePropertyPlan[] = [];
        for (const name of fieldOrder(names, below ?? NO_RECORDS, this.index))
          properties.push({
            name,
            // EVIDENCE: invariant: below the call a level always has a plan (`ANY_VALUE` at the least).
            type: (yield* compileChild(
              this.#answerTask(inner, [...path, propertyStep(name)], below?.fields.get(name) ?? []),
            ))!,
          });
        members.push(
          opens || at.keeps
            ? { kind: "object", properties, keepExtra: true }
            : { kind: "object", properties },
        );
      } else members.push(kindPlan(tag));
    return unionOf(members);
  }

  /** Whether the place a call lands in admits any object at `path` below it by its written type (`object`). */
  #writtenObject(landing: Landing | null, path: readonly string[]): boolean {
    if (landing === null) return false;
    const { admitted } = this.answers.place(landing.id, joinSteps(landing.path, path));
    return admitted.by === "written" && admitted.kinds.includes("object");
  }
}

/**
 * A typed parse or load whose expected type `Contracts.#answerTask` reads: the node it answers by, where it lands, and
 * whether the level is below a written `object`, where the node is its default's literal data (`#literalOf`).
 */
interface AnsweredCall {
  readonly node: FlowNode;
  readonly call: Expression;
  readonly landing: Landing | null;
  readonly keeps: boolean;
}

/**
 * A typed parse's or load's default, which its value is where it gives one: `null` for a typed one without a default,
 * `undefined` for any other expression.
 */
function typedDefault(node: Expression): Expression | null | undefined {
  if (node.kind === "loadExpression") return node.defaultValue;
  return node.kind === "callExpression" &&
    node.callee.kind === "identifier" &&
    node.callee.name === "fromJson"
    ? defaultOf(node)
    : undefined;
}

/**
 * The literal data one step below `values`, found once per level: a list's or set's elements, and each record field's
 * values by name, the names in the order the records first write them.
 */
interface RecordsBelow {
  readonly elements: readonly Expression[];
  readonly fields: ReadonlyMap<string, readonly Expression[]>;
}

/** No literal data below a level. */
const NO_RECORDS: RecordsBelow = { elements: [], fields: new Map() };

function recordsBelow(
  values: readonly Expression[],
  literalOf: (value: Expression) => Expression | null,
): RecordsBelow {
  const elements: Expression[] = [];
  const fields = new Map<string, Expression[]>();
  // element by element: a literal has as many as its source writes, more than a call takes as arguments
  for (const value of values) {
    const node = literalOf(value);
    if (node === null) continue;
    if (node.kind === "listLiteral" || node.kind === "setLiteral")
      for (const element of node.elements) elements.push(element);
    else if (node.kind === "objectLiteral")
      for (const property of node.properties) {
        const found = fields.get(property.name.name);
        if (found === undefined) fields.set(property.name.name, [property.value]);
        else found.push(property.value);
      }
  }
  return { elements, fields };
}

/**
 * A record's field names in the order its own literal records at this level write them, so that a repair's warnings and
 * a parsed record's fields follow its source; names they do not write follow, as the program first writes them.
 */
function fieldOrder(names: Iterable<string>, below: RecordsBelow, index: SliceIndex): string[] {
  const all = new Set(names);
  return [
    ...[...below.fields.keys()].filter((name) => all.has(name)),
    ...index.inWrittenOrder([...all].filter((name) => !below.fields.has(name))),
  ];
}

/** The `default:` a call's value falls back on, or `null`. */
function defaultOf(call: CallExpression): Expression | null {
  return (
    call.arguments.find(
      (argument) => argument.kind === "namedArgument" && argument.name.name === "default",
    )?.value ?? null
  );
}

/** The kinds whose levels below a typed call's answer its default answers (#1767). */
const STRUCTURED: ReadonlySet<ItemTag> = new Set(["list", "set", "dict", "object", "unknown"]);

/**
 * Whether a default reads anything but literal data at any level: a variable, a property or an element of one, any
 * operation but a typed parse or load, or one whose own default does (#1755's test, read after a stop alone and through
 * nested typed calls, #1767). A projection of a literal is the literal data it selects (`projectedLiteral`), where no
 * object literal stands at any level below it: #1460's syntax route proves its items, not an object's names below a
 * projection (#1775: `({n: 0}).n`, `[0][i]` and `({p: [load("k", default: 0)]}).p` are literal data, `({p: {n: 0}}).p`
 * and `[{n: 0}][0]` are not).
 */
function readsPlace(fallback: Expression): boolean {
  const pending: { at: Expression; projected: boolean }[] = [{ at: fallback, projected: false }];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const { at, projected } = next;
    switch (at.kind) {
      case "numberLiteral":
      case "booleanLiteral":
      case "nullLiteral":
        break;
      case "stringLiteral":
        if (at.parts.some((part) => part.kind !== "stringText")) return true;
        break;
      case "parenthesizedExpression":
        pending.push({ at: at.expression, projected });
        break;
      case "listLiteral":
      case "setLiteral":
        for (const element of at.elements) pending.push({ at: element, projected });
        break;
      case "objectLiteral":
        if (projected) return true;
        for (const property of at.properties) pending.push({ at: property.value, projected });
        break;
      case "propertyAccessExpression":
      case "indexExpression": {
        const selected = projectedLiteral(at);
        if (selected === undefined) return true;
        for (const value of selected) pending.push({ at: value, projected: true });
        break;
      }
      // a typed parse or load inside the default answers by its own default, which the outer call reads through,
      // whatever its key
      case "loadExpression":
        if (at.defaultValue !== null) pending.push({ at: at.defaultValue, projected });
        break;
      case "callExpression": {
        const inner = defaultOf(at);
        if (at.callee.kind !== "identifier" || at.callee.name !== "fromJson" || inner === null)
          return true;
        pending.push({ at: inner, projected });
        break;
      }
      default:
        return true;
    }
  }
  return false;
}

/**
 * What an expression may select through parentheses and projections of literals: an object literal's literal property,
 * or any element of a list literal, whatever the index reads (`[0][load("i", default: 0)]` and `[0][({i: 0}).i]` are
 * elements of `[0]`); a selected part that is itself a projection is followed (`({p: ({n: 0}).n}).p`); an empty list's
 * none. `undefined` where a step leaves the literal's syntax: another receiver, a missing property. Recursive over the
 * syntax alone.
 */
function projectedLiteral(expression: Expression): readonly Expression[] | undefined {
  const at = unwrap(expression);
  if (at.kind !== "propertyAccessExpression" && at.kind !== "indexExpression") return [at];
  const holders = projectedLiteral(at.object);
  if (holders === undefined) return undefined;
  const selected: Expression[] = [];
  for (const holder of holders) {
    let values: readonly (Expression | undefined)[];
    if (at.kind === "propertyAccessExpression")
      values =
        holder.kind === "objectLiteral"
          ? [holder.properties.find((property) => property.name.name === at.property.name)?.value]
          : [undefined];
    // (an element of a list literal at any index, a literal or computed one alike: its elements are of one type)
    else values = holder.kind === "listLiteral" ? holder.elements : [undefined];
    for (const value of values) {
      const parts = value === undefined ? undefined : projectedLiteral(value);
      if (parts === undefined) return undefined;
      selected.push(...parts);
    }
  }
  return selected;
}

/**
 * Whether a stop before admission settled left the value side unproven: a work or depth allowance (the stores admission
 * rejects are not settled, #1767). A stop after admission settled leaves every finished answer standing, and a decision
 * stopped at its demand allowance leaves its own answers `unknown`, which `stoppedItem` finds.
 */
function stoppedAnalysis(answers: Answers): boolean {
  const { budget } = answers;
  return budget.exhausted !== null && budget.exhausted !== "nesting" && !budget.settled;
}

/** Whether an item is a stop's unknown, what the analysis left unread (#1767). */
function stoppedItem(item: Item): boolean {
  return item.tag === "unknown" && (item.reasons & REASON.budget) !== 0;
}

/**
 * The steps a value adds below its parent where it lands where the parent does (`Contracts.#landing`): none through
 * parentheses, `otherwise` and a `default:`, an element, a property; `null` where it lands nowhere.
 */
function landingStep(
  parent: Expression,
  node: Expression,
  index: SliceIndex,
): readonly string[] | null {
  switch (parent.kind) {
    case "parenthesizedExpression":
      return [];
    case "binaryExpression":
      return parent.operator === "otherwise" ? [] : null;
    case "listLiteral":
    case "setLiteral":
      return ["element"];
    case "objectLiteral": {
      const name = index.propertyOf(node);
      return name === undefined ? null : [propertyStep(name)];
    }
    case "callExpression":
      return lazyDefaultArgument(parent)?.argument.value === node ? [] : null;
    case "loadExpression":
      return parent.defaultValue === node ? [] : null;
    default:
      return null;
  }
}

/**
 * The paths below a value that a plan describes: the value itself, a collection's elements and an object's properties,
 * each structural member of a union's.
 */
function levelsOf(plan: TypePlan): string[][] {
  const levels = new Map<string, string[]>();
  const pending: [TypePlan, string[]][] = [[plan, []]];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const [at, path] = next;
    if (at.kind === "union") {
      for (const member of at.members) pending.push([member, path]);
      continue;
    }
    levels.set(path.join("\u0000"), path);
    if ((at.kind === "list" || at.kind === "set" || at.kind === "dict") && at.element !== null)
      pending.push([at.element, [...path, "element"]]);
    else if (at.kind === "object")
      for (const property of at.properties)
        pending.push([property.type, [...path, propertyStep(property.name)]]);
  }
  return [...levels.values()];
}

/** A value's contract at a path, and whether each level below it (by its steps) is a written domain. */
interface Provenance {
  readonly contract: TypePlan | null;
  readonly written: (levels: readonly string[]) => boolean;
}

/** Whether a value the core answers may be a collection: one of its kinds is, or it may hold an unknown. */
function bringsCollection(value: ValueAnswer): boolean {
  return value.items.some((item) => item.tag === "unknown" || isCollection(item.tag));
}

/** Whether two plans are one type: the same members, in any order, at every level. */
function samePlan(a: TypePlan, b: TypePlan): boolean {
  const key = (plan: TypePlan): string =>
    plan.kind === "union"
      ? plan.members.map(key).sort().join("|")
      : plan.kind === "list" || plan.kind === "set" || plan.kind === "dict"
        ? `${plan.kind}<${plan.element === null ? "" : key(plan.element)}>`
        : plan.kind === "object"
          ? `{${plan.properties.map((property) => `${property.name}: ${key(property.type)}`).join(", ")}}`
          : plan.kind;
  return key(a) === key(b);
}

/** Whether the core answers a domain as written: its own written type, or one a copy inherits (ADR 0021 1.3). */
function writtenDomain(admitted: AdmittedType): boolean {
  return admitted.by === "written" || (admitted.by === "decided" && admitted.inherited);
}

/**
 * A plan with each whole number a number too (the fallback rule's family, ADR 0021 1.2) at each level `widens` says (by
 * its steps below the plan: `element`, a property's step), the levels it does not as they are.
 */
function numberFamily(
  plan: TypePlan,
  widens: (steps: readonly string[]) => boolean,
  steps: readonly string[] = [],
): TypePlan {
  switch (plan.kind) {
    case "integer":
      return widens(steps) ? { kind: "union", members: [plan, { kind: "number" }] } : plan;
    case "union": {
      const members = plan.members.flatMap((member) =>
        membersOf(numberFamily(member, widens, steps)),
      );
      // (one member per kind but the collections and objects, which differ by what is below them)
      const kept = members.filter(
        (member, at) =>
          isCollection(member.kind) ||
          member.kind === "object" ||
          members.findIndex((other) => other.kind === member.kind) === at,
      );
      return unionOf(kept);
    }
    case "list":
    case "set":
    case "dict":
      return plan.element === null
        ? plan
        : {
            kind: plan.kind,
            element: numberFamily(plan.element, widens, joinSteps(steps, ["element"])),
          };
    case "object":
      return {
        ...plan,
        properties: plan.properties.map((property) => ({
          ...property,
          type: numberFamily(
            property.type,
            widens,
            joinSteps(steps, [propertyStep(property.name)]),
          ),
        })),
      };
    default:
      return plan;
  }
}

/** A `get` call's receiver, else `null`. */
function getReceiver(expression: Expression): Expression | null {
  return expression.kind === "callExpression" &&
    expression.callee.kind === "propertyAccessExpression" &&
    expression.callee.property.name === "get"
    ? expression.callee.object
    : null;
}

/** A plan's members: a union's, else the plan itself. */
export function membersOf(plan: TypePlan): readonly TypePlan[] {
  return plan.kind === "union" ? plan.members : [plan];
}

/** A plan without its `null`, `null` where nothing else is left. */
function withoutNull(plan: TypePlan): TypePlan | null {
  const members = membersOf(plan).filter((member) => member.kind !== "null");
  return members.length === 0 ? null : unionOf(members);
}

/** Whether a kind is a collection's. */
export function isCollection(kind: string): boolean {
  return kind === "list" || kind === "set" || kind === "dict";
}

/** One plan of several: the plan itself, or the union of their members. */
export function unionOf(plans: readonly TypePlan[]): TypePlan {
  const members = plans.flatMap((plan) => (plan.kind === "union" ? plan.members : [plan]));
  return members.length === 1 ? members[0]! : { kind: "union", members };
}

/**
 * A written type's term as the type a check takes (V30 §13: an unwritten part and a written `object`'s properties take
 * every value), level by level as written; a compile task, as an annotation's conversion is.
 */
function* termTask(term: TypeTerm): CompileTask<StaticType> {
  switch (term.kind) {
    case "atom":
      return closedType(term.name) ?? UNKNOWN_TYPE;
    case "list":
    case "set":
    case "dict":
      return { kind: term.kind, element: yield* compileChild(termTask(term.element)) };
    case "union": {
      const types: StaticType[] = [];
      for (const member of term.members) types.push(yield* compileChild(termTask(member)));
      return union(types);
    }
    case "object":
    default:
      // (a written `object` is any object; a written term holds no other part, and an open one restricts nothing)
      return term.kind === "object" ? { kind: "object", properties: null } : UNKNOWN_TYPE;
  }
}
