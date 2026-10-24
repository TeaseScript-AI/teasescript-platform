import type { PlaceId } from "../graph.js";
import type { CorePass } from "./answers.js";
import {
  carried,
  choiceLabels,
  conversionKind,
  defaultOf,
  emptyAt,
  ingressNull,
  isMissing,
  ONLY_NULL,
  OPAQUE_MEMBER,
  operatorOf,
  plusElements,
  REFERENCE,
  typedDefault,
  unknownItem,
  withOwnSelection,
} from "./contract.js";
import { keyOf, keyPath, keyPlace, type ForLoopFacts, type Key } from "./definitions.js";
import { withoutEmpty } from "./exact-path.js";
import type { FlowNode } from "./flow-graph.js";
import { marked } from "./guards.js";
import {
  builtinResult,
  conversionCategory,
  declaredResult,
  interactionCategory,
  measuresLength,
  memberResult,
  methodCategory,
  selectsElement,
} from "./method-categories.js";
import { alternatives, EMPTY, makeItem, mergeItems, REASON, weaken, type Item } from "./items.js";
import { operationItems } from "./operator-table.js";
import { stepName, type ValueConstraint } from "./program.js";
import type { Work } from "./solver.js";

/*
 * The value side of the coarse core (checkpoint 9, TABLE §3): a read of a key at a node takes, in this order, the host
 * or reference answer (§3 step 1), the exact path's value at D (§3.1), or the contract (§3.2), and under a guard of
 * its key its kinds are possible and marked (§3.2). The value of an expression at its node follows the read through
 * projections, call results (F20), operations (F7, F10, F16–F19, F25, F26b) and literals (F12). Literals and
 * operations are demands, once per value and path.
 */

const COLLECTIONS = new Set(["list", "set", "dict", "object"]);

export class Values {
  public constructor(readonly pass: CorePass) {}

  /** A read of `key` at `node` (§3); `before`: a definition at `node` itself does not count. */
  public *keyItems(key: Key, node: FlowNode | null, before = false): Work<readonly Item[]> {
    const { program, exact, contract, lists, guards } = this.pass;
    if (program.isHost(keyPlace(key))) return [unknownItem(REASON.external)];
    if (yield* contract.refReceiver(key)) return [OPAQUE_MEMBER];
    if (node === null) return yield* contract.contractOf(key);
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
          );
    // §3.2: under a test of its variable a read's kinds are possible and marked, and no consumer errs on them
    return guards.narrowed(key, node) ? marked(items) : items;
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

  /** The value of a place at a node, read at the path `rest` below it. */
  public *valueItems(
    value: PlaceId,
    node: FlowNode | null,
    rest: readonly string[],
  ): Work<readonly Item[]> {
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
      const elements = yield* this.valueItems(projection.owner, at, [
        stepName(projection.step),
        ...rest,
      ]);
      if (!selectsElement(projection.step)) return elements;
      const owners = withoutEmpty(yield* this.valueItems(projection.owner, at, []));
      return withOwnSelection(elements, owners, this.pass);
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
        const elements = withoutEmpty(yield* this.valueItems(owner, node, ["element", ...rest]));
        out.push(...(item.cert === "def" ? elements : weaken(elements)));
      } else if ((item.tag === "dict" || item.tag === "range") && rest.length === 0)
        out.push(
          carried(
            {
              ...makeItem(item.tag === "dict" ? "string" : "integer", item.writer, {
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
   * V30 §19: the value a choice object's button gives at `rest`: its `value`, and its `text` where it may have none.
   */
  *#choiceValue(
    option: PlaceId,
    node: FlowNode | null,
    at: readonly string[],
    rest: readonly string[],
  ): Work<readonly Item[]> {
    const value = withoutEmpty(yield* this.valueItems(option, node, [...at, "value"]));
    const out: Item[] = [];
    if (value.some((item) => !isMissing(item)))
      out.push(
        ...(rest.length === 0
          ? value.filter((item) => !isMissing(item))
          : yield* this.valueItems(option, node, [...at, "value", ...rest])),
      );
    if (value.length === 0 || value.some(isMissing))
      out.push(...(yield* this.valueItems(option, node, [...at, "text", ...rest])));
    return out;
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
      } else if (item.tag === "object") {
        const own = yield* this.valueItems(owner, node, [step, ...rest]);
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
      key: `lit|${literal}|${rest.join(".")}|${node?.id ?? "-"}`,
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
      key: `op|${c.result}|${rest.join(".")}`,
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
      const kept = left.filter((item) => rest.length > 0 || item.tag !== "null");
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
    } else if (c.kind === "get") {
      const receiver = withoutEmpty(yield* this.valueItems(c.receiver, at, ["element", ...rest]));
      const fallbackAt = program.exprAt(program.places[c.fallback]?.site ?? c.site);
      // P7, F17b: only the graph's literal proof (a `get` on a list literal with a literal index: the default is dead)
      // makes the element certain; else the element may be absent and its kinds are possible
      const reached = fallbackAt !== null && !fallbackAt.dead;
      // (and the proof that the literal has no element there makes the default the only value, F17b)
      const only = reached && at?.kind === "default-accepted" && at.predecessors.length === 1;
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
      key: `vdk|${fallback}|${rest.join(".")}|${at?.id ?? "-"}`,
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
      key: `vdn|${fallback}|${at?.id ?? "-"}`,
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
    if (family === "method" && c.receiver !== null) {
      // F19a: a reference's method is opaque
      const receiver = yield* this.valueItems(c.receiver, at, []);
      if (receiver.some((item) => REFERENCE.has(item.tag))) return [OPAQUE_MEMBER];
    }
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
          const kinds = declaredResult(name, gives.kinds, item.tag === "string");
          if (rest.length === 0)
            out.push(
              ...kinds.map((tag) =>
                carried(
                  { ...makeItem(tag), cert: kinds.length === 1 ? item.cert : ("pos" as const) },
                  [item],
                ),
              ),
            );
        } else if (gives.fromList === "null" && item.tag !== "dict") {
          if (rest.length === 0)
            out.push(carried(makeItem("null", null, { cert: item.cert }), [item]));
        } else if (COLLECTIONS.has(item.tag))
          out.push(
            ...weaken(withoutEmpty(yield* this.valueItems(c.receiver, at, ["element", ...rest]))),
          );
        else if (item.tag === "unknown") out.push(item);
      }
      return out;
    }
    // F10: a copy of the elements, which may hold none where it takes a count
    if (method !== undefined && c.receiver !== null && method.gives.kind === "copy") {
      const copy = method.gives;
      const held = yield* this.valueItems(
        c.receiver,
        at,
        rest.length === 0 ? [] : ["element", ...rest.slice(1)],
      );
      return [
        ...(rest.length === 0 ? [carried(makeItem(copy.into), held)] : []),
        ...held.filter((item) => rest.length > 0 || (item.tag !== "list" && item.tag !== "set")),
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
    // V30 §19: askChoice's answer, per option its label, or each of its buttons' values
    if (interaction?.kind === "options") {
      const labels = choiceLabels(c);
      for (const [index, argument] of c.arguments.entries()) {
        const label = labels[index];
        if (label !== undefined) {
          if (label !== null && rest.length === 0) out.push(makeItem(label));
          continue;
        }
        const option = withoutEmpty(yield* this.valueItems(argument, at, []));
        if (option.some((item) => item.tag === "list" || item.tag === "set"))
          for (const item of withoutEmpty(yield* this.valueItems(argument, at, ["element"])))
            if (item.tag === "object")
              out.push(...(yield* this.#choiceValue(argument, at, ["element"], rest)));
            else if (rest.length === 0 || item.tag === "unknown") out.push(item);
        if (option.some((item) => item.tag === "object"))
          out.push(...(yield* this.#choiceValue(argument, at, [], rest)));
        for (const item of option)
          if (item.tag === "list" || item.tag === "set" || item.tag === "object") continue;
          else if (rest.length === 0 || item.tag === "unknown") out.push(item);
      }
      return out;
    }
    const member = family === "member" ? memberResult(name) : undefined;
    if (member !== undefined) return member.map((kind) => makeItem(kind));
    // F19a: a handle's members are the runtime's
    if (family === "timer" || family === "media")
      return rest.length === 0 ? [makeItem(family)] : [OPAQUE_MEMBER];
    if (family === "range") return [makeItem("range")];
    return [unknownItem(REASON.external)];
  }

  /** A key's path, for the demands that read one. */
  public static pathOf(key: Key): readonly string[] {
    return keyPath(key);
  }
}
