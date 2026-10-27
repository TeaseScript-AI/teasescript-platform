import type { PlaceId } from "../graph.js";
import type { CorePass } from "./answers.js";
import {
  carried,
  choiceItems,
  conversionKind,
  defaultOf,
  emptyAt,
  heldReference,
  ingressNull,
  ONLY_NULL,
  OPAQUE_MEMBER,
  operatorOf,
  plusElements,
  REFERENCE,
  typedDefault,
  unknownItem,
  withOwnSelection,
} from "./contract.js";
import { joinParts, joinSteps, keepText, keptParts } from "./budget.js";
import { keyOf, keyPlace, type ForLoopFacts, type Key } from "./definitions.js";
import { belowSelected, withoutEmpty } from "./exact-path.js";
import type { FlowNode } from "./flow-graph.js";
import { marked } from "./guards.js";
import {
  builtinResult,
  clockResult,
  conversionCategory,
  declaredResult,
  declaredMethod,
  declaredProperty,
  dictList,
  interactionCategory,
  kindElement,
  memberStep,
  measuresLength,
  memberResult,
  methodCategory,
  selectsElement,
  shownResult,
} from "./method-categories.js";
import {
  alternatives,
  EMPTY,
  makeItem,
  mergeItems,
  REASON,
  weaken,
  type Item,
  type ItemTag,
} from "./items.js";
import { operationItems } from "./operator-table.js";
import { stepName, type CoreProgram, type ValueConstraint } from "./program.js";
import type { Work } from "./solver.js";

/*
 * The value side of the coarse core (checkpoint 9, TABLE §3): a read of a key at a node takes, in this order, the host
 * or reference answer (§3 step 1), the exact path's value at D (§3.1), or the contract (§3.2), and under a guard of
 * its key its kinds are possible and marked (§3.2). The value of an expression at its node follows the read through
 * projections, call results (F20), operations (F7, F10, F16–F19, F25, F26b) and literals (F12). Literals and
 * operations are demands, once per value and path.
 */

const COLLECTIONS = new Set(["list", "set", "dict", "object"]);

/** The receiver kinds a copy of their elements (F10) is not. */
const COPIED: ReadonlySet<ItemTag> = new Set(["list", "set", "range"]);

/** Which path answered a read (S3 §1's route): the exact path's definition, or the contract (§3 step 1 included). */
export type ReadRoute = "exact" | "contract";

export class Values {
  /** The route each read took, by key, node and `before`, recorded as the read is answered. */
  readonly #routes = new Map<string, ReadRoute>();
  /** Per computed value, its value class (`valueClass`). */
  readonly #classes = new Map<PlaceId, string | null>();

  public constructor(readonly pass: CorePass) {}

  /** A read of `key` at `node` (§3); `before`: a definition at `node` itself does not count. */
  public *keyItems(key: Key, node: FlowNode | null, before = false): Work<readonly Item[]> {
    const { program, exact, contract, lists, guards } = this.pass;
    const route = (taken: ReadRoute): void => {
      const at = joinParts(key, node?.id ?? "-", before ? 1 : 0);
      // (a route's text charged where it is kept first, TABLE r4.58)
      if (!this.#routes.has(at)) keepText(program.work, at.length);
      this.#routes.set(at, taken);
    };
    if (program.isHost(keyPlace(key))) {
      route("contract");
      return [unknownItem(REASON.external)];
    }
    if (yield* contract.refReceiver(key)) {
      route("contract");
      return [OPAQUE_MEMBER];
    }
    if (node === null) {
      route("contract");
      return yield* contract.contractOf(key);
    }
    const answer = exact.exactPath(key, node, before);
    // F5a: the loop ran only over a held iterable, and nothing between the add and the body's end may change the
    // collection: X6's events, a call into a callable that stores it included
    let loop = false;
    if ("def" in answer && answer.def.loop !== undefined) {
      const facts = answer.def.loop;
      loop =
        !(yield* this.#iterableHeld(facts)) ||
        facts.backs.some((back) => lists.eventBetween(key, answer.def.orig!.node, back) !== null);
    }
    const items =
      "def" in answer && !loop
        ? yield* exact.defVal(answer.def, answer.rest)
        : yield* contract.contractRead(
            key,
            node,
            loop ? "loop" : "fail" in answer ? answer.fail : "loop",
            loop || ("fail" in answer && answer.later === true),
          );
    route("def" in answer && !loop ? exact.defRoute(answer.def, answer.rest) : "contract");
    // §3.2: under a test of its variable a read's kinds are possible and marked, and no consumer errs on them
    return guards.narrowed(key, node) ? marked(items) : items;
  }

  /**
   * The route the value of a place at a node took at a path, read from the routes recorded as it was answered (its
   * items are asked first): a read's own, through projections, a call's result read, a literal's (F12); a length's,
   * its owner's own field's where the owner is an object (F14; a computed length is `exact`); an operation's value is
   * computed, `exact`.
   */
  public valueRoute(value: PlaceId, node: FlowNode | null, rest: readonly string[]): ReadRoute {
    const { program, contract } = this.pass;
    const recorded = (key: Key, at: FlowNode | null): ReadRoute =>
      this.#routes.get(joinParts(key, at?.id ?? "-", 0)) ?? "exact";
    let path = rest;
    let at = node;
    for (let projection = program.projOf.get(value); projection !== undefined;) {
      if (projection.step === "iteration") return "exact";
      path = joinSteps(
        [measuresLength(projection.step) ? projection.step : stepName(projection.step)],
        path,
      );
      at = projection.node ?? at;
      value = projection.owner;
      projection = program.projOf.get(value);
    }
    if (program.speakerPlaces.has(value) || program.isHost(value)) return "contract";
    const binding = program.occurrenceOf.get(value);
    if (binding !== undefined)
      return recorded(keyOf(binding, path), program.occNode.get(value) ?? at);
    const call = program.callOutOf.has(value) ? program.opOf.get(value) : undefined;
    if (call?.kind === "call")
      return recorded(
        keyOf(program.functionOf(call.fn).result, path),
        program.callOutOf.get(value) ?? at,
      );
    if (program.opOf.has(value)) return "exact";
    if (program.hasOf.has(value) || program.cellOwner.has(value))
      return contract.literalRoute(value, path, at);
    return recorded(keyOf(value, path), at);
  }

  /** F5a: the loop's iterable holds an element at the loop's entry, by the contract or by the exact value (C6's test). */
  *#iterableHeld(facts: ForLoopFacts): Work<boolean> {
    const { contract } = this.pass;
    const elements = yield* contract.contractOfValueAt(facts.value, ["element"]);
    if (
      elements.length > 0 &&
      !elements.some((item) => item.tag === "empty") &&
      !(yield* contract.contractOfValue(facts.value)).some((item) => item.tag === "unknown")
    )
      return true;
    const read = yield* this.valueItems(facts.value, facts.node, ["element"]);
    return (
      withoutEmpty(read).length > 0 &&
      !read.some((item) => item.tag === "empty") &&
      !(yield* this.valueItems(facts.value, facts.node, [])).some((item) => item.tag === "unknown")
    );
  }

  /**
   * S6c: what a computed value's exact answer at every path rests on, as one text (`Contract.readClass` for a read): a
   * `get` by its receiver's and its default's reads and whether its default runs, and alone (`getProof`), an
   * `otherwise` by its operands' reads and whether its fallback runs only where the left is null; each at the
   * operation's own node, so where it has none, `null`, as for any other value or an operand that is no read. Once per
   * value.
   */
  public valueClass(value: PlaceId): string | null {
    const known = this.#classes.get(value);
    if (known !== undefined) return known;
    const { program, contract } = this.pass;
    const c = program.opOf.get(value);
    const at = c === undefined ? null : program.exprAt(c.site);
    let cls: string | null = null;
    if (c === undefined) cls = contract.readClass(value, true);
    else if (at !== null && (c.kind === "get" || c.kind === "fallback")) {
      const [first, second] = c.kind === "get" ? [c.receiver, c.fallback] : [c.left, c.right];
      const [a, b] = [contract.readClass(first, true), contract.readClass(second, true)];
      let proof: string;
      if (c.kind === "get") {
        const { reached, only } = getProof(program, c, at);
        proof = `${reached ? "r" : ""}${only ? "o" : ""}`;
      } else {
        const rightAt = program.exprAt(program.places[c.right]?.site ?? c.site);
        proof =
          rightAt === null
            ? "-"
            : at.predecessors.length === 1 && at.predecessors[0] === rightAt
              ? "d"
              : "";
      }
      if (a !== null && b !== null) cls = keptParts(program.work, c.kind, a, b, proof);
    }
    this.#classes.set(value, cls);
    return cls;
  }

  /** The value of a place at a node, read at the path `rest` below it. */
  public valueItems(
    value: PlaceId,
    node: FlowNode | null,
    rest: readonly string[],
  ): Work<readonly Item[]> {
    return this.#through(value, node, rest, 0);
  }

  /**
   * A value read along a path through a member a built-in value answers by itself, from the step `from` on, where the
   * path ends: at a literal or an operation (a projection passes its step to its owner, and a variable or a call its key
   * to the key's reads, which the contract answers the same way). A dict's `values` is a new list of its values and its
   * `keys` one of text (TABLE r4.46 (2)), as certain as the dict, either may hold none (no count proof, no `null`); a
   * temporal field or a calendar duration's part gives its declared result (V30 §35); an object's own property of the
   * name is read as any property (F11), and a receiver that may be a reference has the runtime's members (F19a).
   */
  #through(
    value: PlaceId,
    node: FlowNode | null,
    rest: readonly string[],
    from: number,
  ): Work<readonly Item[]> {
    const { program } = this.pass;
    const at = memberStep(rest, from);
    if (
      at < 0 ||
      program.occurrenceOf.has(value) ||
      program.projOf.has(value) ||
      program.speakerPlaces.has(value) ||
      (program.callOutOf.has(value) && program.opOf.get(value)?.kind === "call")
    )
      return this.#valueAt(value, node, rest);
    return this.#members(value, node, rest, at, from);
  }

  /** `#through` at the step `at`, the first of `rest` from `from` on that a built-in value answers by itself. */
  *#members(
    value: PlaceId,
    node: FlowNode | null,
    rest: readonly string[],
    at: number,
    from: number,
  ): Work<readonly Item[]> {
    const { program } = this.pass;
    const before = rest.slice(0, at);
    const after = rest.slice(at + 1);
    // F19a, r4.44: a receiver that may be a reference, by its completed contract, has the runtime's members
    const contract = this.pass.contract;
    const decided =
      before.length === 0
        ? yield* contract.valueReceiver(value)
        : yield* contract.contractOfValueAt(value, before);
    if (heldReference(decided) || decided.some((item) => REFERENCE.has(item.tag)))
      return yield* this.#through(value, node, rest, at + 1);
    const receiver = withoutEmpty(yield* this.#through(value, node, before, from));
    const out: Item[] = [];
    let own = false;
    const step = rest[at]!;
    for (const item of receiver) {
      const of = (tag: ItemTag): Item =>
        carried({ ...makeItem(tag, item.writer, { context: item.context }), cert: item.cert }, [
          item,
        ]);
      const declared = declaredProperty(item.tag, step);
      if (item.tag === "dict" && dictList(step) !== undefined) {
        if (after.length === 0) out.push(of("list"));
        else if (after[0] === "element") {
          // a key is text from the list's contract, possible: no literal holds a derived list's element (r4.47, P3)
          const below =
            dictList(step) === "keys"
              ? after.length === 1
                ? weaken([of("string")])
                : []
              : yield* this.#through(value, node, joinSteps(before, after), at);
          // the list's own selection takes its own emptiness (open); a deeper selection's marker is that selection's
          const elements = after.length === 1 ? withoutEmpty(below) : below;
          out.push(...(item.cert === "def" ? elements : weaken(elements)));
          if (after.length === 1) out.push(EMPTY);
        }
      } else if (declared !== undefined) {
        // a temporal field or a calendar duration's part: its declared result, as certain as its receiver
        if (after.length === 0) out.push(of(declared));
      } else if (item.tag === "object") own = true;
      else if (item.tag === "unknown") out.push(item);
    }
    if (own) out.push(...(yield* this.#through(value, node, rest, at + 1)));
    return mergeItems(out, program.scope);
  }

  /** A written element of a list or set at a path, read as the list's literal reads it, below its element step (F12). */
  *#belowElement(
    literal: PlaceId,
    node: FlowNode | null,
    rest: readonly string[],
  ): Work<readonly Item[]> {
    const { program, contract } = this.pass;
    if (!program.hasOf.has(literal)) return yield* this.valueItems(literal, node, rest);
    return alternatives(yield* contract.indexItems(literal, rest, node, true, true), program.scope);
  }

  /** The value of a place at a node at a path, by the place's kind. */
  *#valueAt(value: PlaceId, node: FlowNode | null, rest: readonly string[]): Work<readonly Item[]> {
    this.pass.solver.enterRead();
    try {
      const { program, contract } = this.pass;
      if (program.speakerPlaces.has(value))
        return [makeItem("unknown", null, { reasons: REASON.opaque, context: "unmodelled" })];
      const binding = program.occurrenceOf.get(value);
      if (binding !== undefined)
        return contract.entered(
          value,
          yield* this.keyItems(keyOf(binding, rest), program.occNode.get(value) ?? node),
        );
      const projection = program.projOf.get(value);
      if (projection !== undefined) {
        const at = projection.node ?? node;
        if (projection.step === "iteration")
          return yield* this.#iteration(projection.owner, at, rest);
        if (measuresLength(projection.step))
          return yield* this.#length(projection.owner, at, projection.step, rest);
        if (!selectsElement(projection.step))
          return yield* this.valueItems(
            projection.owner,
            at,
            joinSteps([stepName(projection.step)], rest),
          );
        // S6c: a selection reads its owner twice, at its step and whole, so its whole value once per value and node,
        // whatever asks: a chain of k `.first` reads each link once whole, never each link 2^k times
        if (rest.length > 0)
          return yield* this.#selection(projection.owner, projection.step, at, rest);
        const site = program.places[value]?.site ?? null;
        return yield {
          key: joinParts("vpj", value, projection.node === null ? (node?.id ?? "-") : ""),
          kind: "value",
          file: site?.file ?? -1,
          offset: site?.start ?? -1,
          make: () => this.#selection(projection.owner, projection.step, at, []),
        };
      }
      if (program.callOutOf.has(value)) {
        const call = program.opOf.get(value);
        if (call?.kind === "call")
          return yield* this.keyItems(
            keyOf(program.functionOf(call.fn).result, rest),
            program.callOutOf.get(value) ?? node,
          );
      }
      const operation = program.opOf.get(value);
      if (operation !== undefined)
        return contract.entered(value, yield* this.#operationItems(operation, node, rest));
      if (program.hasOf.has(value) || program.cellOwner.has(value))
        return yield* this.#literalItems(value, rest, node);
      if (program.isHost(value)) return [unknownItem(REASON.external)];
      return yield* this.keyItems(keyOf(value, rest), node);
    } finally {
      this.pass.solver.leaveRead();
    }
  }

  /** An element selection's value at a path (`#valueAt`): its owner's at the step, with the owner's own selection. */
  *#selection(
    owner: PlaceId,
    step: string,
    node: FlowNode | null,
    rest: readonly string[],
  ): Work<readonly Item[]> {
    const elements = yield* this.valueItems(owner, node, joinSteps([stepName(step)], rest));
    const owners = withoutEmpty(yield* this.valueItems(owner, node, []));
    return withOwnSelection(elements, owners, this.pass);
  }

  /** F27: the loop variable is the element of the iterable's value at loop entry; a dict's key is text, a range's a whole number. */
  *#iteration(
    owner: PlaceId,
    node: FlowNode | null,
    rest: readonly string[],
  ): Work<readonly Item[]> {
    const out: Item[] = [];
    for (const item of withoutEmpty(yield* this.valueItems(owner, node, []))) {
      if (item.tag === "list" || item.tag === "set") {
        const elements = belowSelected(
          yield* this.valueItems(owner, node, joinSteps(["element"], rest)),
          rest,
        );
        out.push(...(item.cert === "def" ? elements : weaken(elements)));
      } else if ((item.tag === "dict" || kindElement(item.tag) !== undefined) && rest.length === 0)
        out.push(
          carried(
            {
              ...makeItem(item.tag === "dict" ? "string" : kindElement(item.tag)!, item.writer, {
                context: item.context,
              }),
              cert: item.cert,
            },
            [item],
          ),
        );
      else if (item.tag === "unknown") out.push(item);
    }
    return mergeItems(out, this.pass.program.scope);
  }

  /**
   * F14: a text's or a collection's length is a whole number, as certain as the receiver; an object's own `length` is
   * its property (F11); a kind without it gives nothing (C5b reports it).
   */
  *#length(
    owner: PlaceId,
    node: FlowNode | null,
    step: string,
    rest: readonly string[],
  ): Work<readonly Item[]> {
    // F19a before F14 and the exact value: a receiver that may be a reference has the runtime's members, its `length`
    // among them, read as a member so its route is the member's
    if (heldReference(yield* this.pass.contract.valueReceiver(owner)))
      return yield* this.valueItems(owner, node, joinSteps([step], rest));
    const out: Item[] = [];
    for (const item of withoutEmpty(yield* this.valueItems(owner, node, []))) {
      if (
        item.tag === "string" ||
        item.tag === "list" ||
        item.tag === "set" ||
        item.tag === "dict"
      ) {
        if (rest.length === 0)
          out.push(
            carried(
              { ...makeItem("integer", item.writer, { context: item.context }), cert: item.cert },
              [item],
            ),
          );
      } else if (item.tag === "object" || REFERENCE.has(item.tag)) {
        // an object's own `length` (F11), a reference's member (F19a)
        const own = yield* this.valueItems(owner, node, joinSteps([step], rest));
        out.push(...(item.cert === "def" ? own : weaken(own)));
      } else if (item.tag === "unknown") out.push(item);
    }
    return mergeItems(out, this.pass.program.scope);
  }

  /** A literal's value at a path (F12): a demand per literal, path and node. */
  *#literalItems(
    literal: PlaceId,
    rest: readonly string[],
    node: FlowNode | null,
  ): Work<readonly Item[]> {
    const site = this.pass.program.places[literal]?.site ?? null;
    return yield {
      key: joinParts("lit", literal, rest, node?.id ?? "-"),
      kind: "value",
      file: site?.file ?? -1,
      offset: site?.start ?? -1,
      make: () => this.literalValue(literal, rest, node),
    };
  }

  /** The demand of `#literalItems`. */
  public *literalValue(
    literal: PlaceId,
    rest: readonly string[],
    node: FlowNode | null,
  ): Work<readonly Item[]> {
    const { program, definitions, contract } = this.pass;
    // the element cell of an empty literal holds no element
    if (!program.hasOf.has(literal) && (definitions.cellDefs.get(literal) ?? []).length === 0)
      return rest.length === 0 && program.cellOwner.get(literal)?.kind === "cell" ? [EMPTY] : [];
    return alternatives(yield* contract.indexItems(literal, rest, node, true), program.scope);
  }

  /** An operation's value at a path: a demand per result and path. */
  *#operationItems(
    c: ValueConstraint,
    node: FlowNode | null,
    rest: readonly string[],
  ): Work<readonly Item[]> {
    const site = this.pass.program.places[c.result]?.site ?? c.site;
    return yield {
      key: joinParts("op", c.result, rest),
      kind: "value",
      file: site.file,
      offset: site.start,
      make: () => this.operationValue(c, node, rest),
    };
  }

  /** The demand of `#operationItems`. */
  public *operationValue(
    c: ValueConstraint,
    node: FlowNode | null,
    rest: readonly string[],
  ): Work<readonly Item[]> {
    const { program, contract } = this.pass;
    const scope = program.scope;
    const at = program.exprAt(c.site) ?? node;
    const external = (): Item[] => [unknownItem(REASON.external)];
    let out: Item[] = [];
    if (c.kind === "fallback") {
      const left = yield* this.valueItems(c.left, at, rest);
      // (a left operand that is only null gives nothing, at its path or below it: the fallback is the value)
      const value = rest.length === 0 ? left : yield* this.valueItems(c.left, at, []);
      const kept = value.some((item) => item.tag !== "null")
        ? left.filter((item) => rest.length > 0 || item.tag !== "null")
        : [];
      // F17a: K = (K(a) \ {null}) ∪ K(b), the fallback's kinds kept even where the graph never evaluates it; the
      // fallback runs where a is null, so its own known items without a word take that null's (§3.4)
      const rightSite = program.places[c.right]?.site ?? c.site;
      const rightAt = program.exprAt(rightSite);
      const rightDefinite =
        rightAt !== null &&
        at !== null &&
        at.predecessors.length === 1 &&
        at.predecessors[0] === rightAt;
      const why =
        rest.length === 0 ? (left.find((item) => item.tag === "null")?.context ?? null) : null;
      out = [
        ...kept,
        ...(yield* this.valueItems(c.right, rightAt ?? at, rest)).map((item) => {
          const possible =
            rightDefinite || kept.length === 0 ? item : { ...item, cert: "pos" as const };
          return why !== null && possible.context === null && possible.tag !== "unknown"
            ? { ...possible, context: why }
            : possible;
        }),
      ];
    } else if (c.kind === "get" && heldReference(yield* contract.valueReceiver(c.receiver))) {
      // F19a before F17b: a receiver that may be a reference has the runtime's `get`, no default merged beside it
      out = [OPAQUE_MEMBER];
    } else if (c.kind === "get") {
      const receiver = belowSelected(
        yield* this.valueItems(c.receiver, at, joinSteps(["element"], rest)),
        rest,
      );
      const { fallbackAt, reached, only } = getProof(program, c, at);
      out = [
        ...(reached && only ? [] : reached ? weaken(receiver, "member") : receiver),
        ...(reached
          ? (yield* this.valueItems(c.fallback, fallbackAt, rest)).map((item) =>
              only ? item : { ...item, cert: "pos" as const },
            )
          : []),
      ];
    } else if (c.kind === "load" && c.key === null) {
      // F19: a computed key is host data
      if (rest.length > 0) out = external();
      else {
        const nullDefault =
          c.fallback !== null && (yield* this.onlyNull(c.fallback, at)).length > 0;
        out = [...external(), ...(nullDefault ? [ingressNull()] : [])];
      }
    } else if (c.kind === "load") {
      // F18: the expected type (the load checks the value)
      const expected = yield* contract.expectedOf(c, rest);
      if (expected !== null) out = [...expected];
      else if (c.fallback !== null)
        out = [...(yield* this.defaultKinds(c.fallback, at, rest)), ...emptyAt(rest)];
      else out = external();
    } else if (c.kind === "operation") out = yield* this.#operation(c, at, rest);
    else out = external();
    return alternatives(out, scope);
  }

  /**
   * F18 (r4.5): the kinds a `load` or `fromJson` takes from its default's value at `at` (`typedDefault`): definite,
   * the runtime checks the value against the default's type.
   */
  public *defaultKinds(
    fallback: PlaceId,
    at: FlowNode | null,
    rest: readonly string[],
  ): Work<readonly Item[]> {
    const site = this.pass.program.places[fallback]?.site ?? null;
    return yield {
      key: joinParts("vdk", fallback, rest, at?.id ?? "-"),
      kind: "value",
      file: site?.file ?? -1,
      offset: site?.start ?? -1,
      make: () => this.valueItems(fallback, at, rest),
      decision: typedDefault(rest, true),
    };
  }

  /** F19 (r4.1): whether a default's value at `at` holds only `null` (or nothing) (`ONLY_NULL`). */
  public *onlyNull(fallback: PlaceId, at: FlowNode | null): Work<readonly Item[]> {
    const site = this.pass.program.places[fallback]?.site ?? null;
    return yield {
      key: joinParts("vdn", fallback, at?.id ?? "-"),
      kind: "value",
      file: site?.file ?? -1,
      offset: site?.start ?? -1,
      make: () => this.valueItems(fallback, at, []),
      decision: ONLY_NULL,
    };
  }

  *#operation(
    c: Extract<ValueConstraint, { readonly kind: "operation" }>,
    at: FlowNode | null,
    rest: readonly string[],
  ): Work<Item[]> {
    const { program, contract } = this.pass;
    const { family, name } = c.contract;
    const out: Item[] = [];
    // F19a: a reference's method is opaque, by the receiver's contract before its exact value (r4.44)
    if (
      family === "method" &&
      c.receiver !== null &&
      heldReference(yield* contract.valueReceiver(c.receiver))
    )
      return [OPAQUE_MEMBER];
    // F26b (r5): `"${v}"` is always text
    if (family === "interpolation") return rest.length === 0 ? [makeItem("string")] : [];
    // a message's handle (F19a)
    if (family === "say") return rest.length > 0 ? [OPAQUE_MEMBER] : [makeItem("messageHandle")];
    // `2 s`, `1 calendar day`, `20 deg`
    if (family === "unit" || family === "angle")
      return rest.length > 0
        ? []
        : [
            makeItem(
              family === "angle"
                ? "angle"
                : name.startsWith("calendar ")
                  ? "calendarDuration"
                  : "duration",
            ),
          ];
    // the builtins' declared results (`script(...)`, the text functions)
    if (family === "builtin") {
      if (rest.length > 0) return [];
      const fallback = defaultOf(c);
      return [
        makeItem(builtinResult(name)),
        ...(fallback === undefined ? [] : yield* this.valueItems(fallback, at, [])),
      ];
    }
    const method = family === "method" && c.receiver !== null ? methodCategory(name) : undefined;
    // F7a–c, F25: a declared result, or what a removal gives
    if (method !== undefined && c.receiver !== null && method.gives.kind !== "copy") {
      const gives = method.gives;
      for (const item of withoutEmpty(yield* this.valueItems(c.receiver, at, []))) {
        if (gives.kind === "declared") {
          const kinds = declaredResult(name, gives.kinds, item.tag);
          if (rest.length === 0)
            out.push(
              ...kinds.map((tag) =>
                carried(
                  { ...makeItem(tag), cert: kinds.length === 1 ? item.cert : ("pos" as const) },
                  [item],
                ),
              ),
            );
        } else if (item.tag === "unknown") {
          // a dict's removed value, or a list's or a set's `null` where it gives that
          out.push(item);
          if (gives.fromList === "null" && rest.length === 0)
            out.push(carried(makeItem("null", null, { cert: "pos" }), [item]));
        } else if (gives.fromList === "null" && item.tag !== "dict") {
          if (rest.length === 0)
            out.push(carried(makeItem("null", null, { cert: item.cert }), [item]));
        } else if (COLLECTIONS.has(item.tag))
          out.push(
            ...weaken(
              belowSelected(
                yield* this.valueItems(c.receiver, at, joinSteps(["element"], rest)),
                rest,
              ),
            ),
          );
      }
      return out;
    }
    // F10: a copy of the elements, which may hold none where it takes a count: a receiver's own elements, or those its
    // kind declares (a range's whole numbers)
    if (method !== undefined && c.receiver !== null && method.gives.kind === "copy") {
      const copy = method.gives;
      const receiver = yield* this.valueItems(c.receiver, at, []);
      // the receiver's own collection is not the copy's kind (a range's `toList` gives a list)
      if (rest.length === 0)
        return [
          carried(makeItem(copy.into), receiver),
          ...receiver.filter((item) => !COPIED.has(item.tag)),
        ];
      const kinds = withoutEmpty(receiver);
      const declared = kinds.some((item) => kindElement(item.tag) !== undefined);
      return [
        // a kind's declared elements may be none (a range's bounds decide): the copy's element step keeps that mark
        ...(declared && rest.length === 1 ? [EMPTY] : []),
        ...(rest.length === 1
          ? kinds.flatMap((item) => {
              const element = kindElement(item.tag);
              return element === undefined
                ? []
                : [
                    carried(
                      {
                        ...makeItem(element, item.writer, { context: item.context }),
                        cert: item.cert,
                      },
                      [item],
                    ),
                  ];
            })
          : []),
        ...(kinds.some((item) => kindElement(item.tag) === undefined)
          ? yield* this.valueItems(c.receiver, at, joinSteps(["element"], rest.slice(1)))
          : []),
        ...(copy.mayHoldNone && rest.length === 1 ? [EMPTY] : []),
      ];
    }
    if (family === "operator" && name === "+" && rest.length > 0) {
      const operands: (readonly Item[])[] = [];
      for (const argument of c.arguments) operands.push(yield* this.valueItems(argument, at, rest));
      return [...plusElements(operands, rest, this.pass)];
    }
    // F16
    const operator = operatorOf(c);
    if (operator !== null) {
      if (rest.length > 0) return [];
      const operands: (readonly Item[])[] = [];
      for (const argument of c.arguments)
        operands.push(withoutEmpty(yield* this.valueItems(argument, at, [])));
      return operationItems(operator, operands, program.scope, c.site);
    }
    // `and`, `or`, `not`, `==`, `!=`, `is`: a truth value (C3, C13 check the operands)
    if (family === "logic" || family === "comparison" || family === "typeTest")
      return rest.length > 0 ? [] : [makeItem("boolean")];
    // F25: the result or the default
    const conversion = family === "conversion" ? conversionCategory(name) : undefined;
    if (conversion?.kind === "converts") {
      if (rest.length > 0) return [];
      const kind = conversionKind(conversion.result);
      const fallback = defaultOf(c);
      if (fallback !== undefined)
        return [makeItem(kind), ...(yield* this.valueItems(fallback, at, []))];
      return conversion.optional
        ? [makeItem(kind, null, { cert: "pos" }), makeItem("null", null, { cert: "pos" })]
        : [makeItem(kind)];
    }
    if (conversion?.kind === "parses") {
      const expected = yield* contract.expectedOf(c, rest);
      if (expected !== null) return [...expected];
      const fallback = defaultOf(c);
      return fallback === undefined
        ? [unknownItem(REASON.external)]
        : [...(yield* this.defaultKinds(fallback, at, rest)), ...emptyAt(rest)];
    }
    // F25: the built-in's declared result
    const interaction = family === "interaction" ? interactionCategory(name) : undefined;
    if (interaction?.kind === "asks")
      return rest.length === 0 ? [makeItem(interaction.result)] : [];
    // r4.47 (5): a clock read gives its declared kind, as an ask does
    const clock = family === "clock" ? clockResult(name) : undefined;
    if (clock !== undefined) return rest.length === 0 ? [makeItem(clock)] : [];
    // V30 §19: askChoice's answer, per option its label, or each of its buttons' values
    if (interaction?.kind === "options")
      return yield* choiceItems(
        c,
        rest,
        (value, path, element) =>
          element === true ? this.#belowElement(value, at, path) : this.valueItems(value, at, path),
        contract.choiceKeysStored(),
        contract.choiceOptions(c, true),
      );
    const member = family === "member" ? memberResult(name) : undefined;
    if (member !== undefined) return member.map((kind) => makeItem(kind));
    // F19a: a handle's members are the runtime's
    if (family === "timer" || family === "media")
      return rest.length === 0 ? [makeItem(family)] : [OPAQUE_MEMBER];
    // F25: a button's, a popup's or a camera's fixed result; a handle's members are the runtime's (F19a)
    const shown = shownResult(name);
    if (shown !== undefined)
      return rest.length === 0 ? [makeItem(shown)] : shown === "duration" ? [] : [OPAQUE_MEMBER];
    // a range: its elements are its kind's (`kindElement`), nothing stands below it by path
    if (family === "range") return rest.length === 0 ? [makeItem("range")] : [];
    // a method without a category, per receiver alternative: its declared result per receiver kind (F25), else the
    // runtime's opaque answer on a known kind (C2: its consumers keep their checks, r4.47 (1)); what the core cannot know
    // keeps its own reasons. A receiver without items yet is a provisional bottom, no answer: the method's result stays
    // the bottom, which the solver completes (S3 §1, r4.44), never an `unknown` with a reason of its own
    if (family === "method" && c.receiver !== null) {
      const receiver = withoutEmpty(yield* this.valueItems(c.receiver, at, []));
      return receiver.flatMap((item) => {
        if (item.tag === "unknown") return [item];
        const declared = declaredMethod(item.tag, name);
        if (declared === undefined) return [OPAQUE_MEMBER];
        return rest.length > 0
          ? []
          : [
              carried(
                { ...makeItem(declared, item.writer, { context: item.context }), cert: item.cert },
                [item],
              ),
            ];
      });
    }
    return [unknownItem(REASON.external)];
  }
}

/**
 * P7, F17b: what the graph's literal proof says of a `get` at its node `at`: its default is reached where its node is
 * live (`reached`), and only a `get` on a list literal with a literal index is certain: the default dead, the element
 * the value; the literal with no element there, the default the only value (`only`), its receiver's element given
 * nowhere. Elsewhere the element may be absent and both are possible.
 */
export function getProof(
  program: CoreProgram,
  c: Extract<ValueConstraint, { readonly kind: "get" }>,
  at: FlowNode | null,
): { readonly fallbackAt: FlowNode | null; readonly reached: boolean; readonly only: boolean } {
  const fallbackAt = program.exprAt(program.places[c.fallback]?.site ?? c.site);
  const reached = fallbackAt !== null && !fallbackAt.dead;
  const only = reached && at?.kind === "default-accepted" && at.predecessors.length === 1;
  return { fallbackAt, reached, only };
}
