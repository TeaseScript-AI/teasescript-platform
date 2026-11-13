// Whether an obligation's check is lost at its store (#1526 decision 2): `keeps`, which the lost-check gate
// (`lostCheck`, `runtime-plan.ts`) asks.
import type { Expression } from "../../../ast.js";
import { type PartCheckPlan, type TypeCheckPlan, type TypePlan } from "../../../plan/model.js";
import type { RuntimeCheckSite, CoreRuntimeChecks } from "../../backend.js";
import { type Answers } from "../answers.js";
import { type ContractResult } from "../contract-descriptors.js";
import { propertyName } from "../program.js";
import type { ReceivingObligation, ReceivingResult } from "../admission/receiving.js";
import { SliceIndex, type Store, nodeOf, unwrap } from "./slice-index.js";

/**
 * Whether an obligation's check is not lost at its store (`lostCheck` declines the program where it is): the published
 * plan carries it there, or the obligation owes none. A shape its value's structure proves (its result not lost), or
 * one a complete store check carries; a contract proved open; a complete store check (settled or received, its whole
 * type); or a contract the completion completed that a published check carries at the obligation's path: a typed
 * parse's or load's reader of the value stored at least as strict as the contract there, the stored literal's own
 * structure, its typed calls' readers and its scalar leaves, at least as strict (`elementsCarry`), or, where the
 * natural plan does not check the store whole, its part checks there equal to it (#1682). With no result, a completion
 * past its allowance or a stop of the analysis, only a complete store check carries it, else it is lost (#1832). A
 * stricter reader is never a lost check: it accepts no more values than the natural reader. A check against bare
 * `unknown` where the contract owes a domain carries nothing. A stopped decision's own mark owes no check
 * (`docs/RESOURCE-LIMITS.md`'s NoCheck) where the completion owes nothing at its store (#2080): its result complete,
 * this pass's completion ran its own destination-type check at the obligation's path, no completed check at the stored
 * value and no destination-type warning of the completion at the store (`warned`).
 */
export function keeps(
  answers: Answers,
  index: SliceIndex,
  store: Store,
  obligation: ReceivingObligation,
  result: ReceivingResult | null,
  published: ReadonlyMap<Store, ContractResult>,
  checks: ReadonlyMap<RuntimeCheckSite, TypeCheckPlan>,
  core: CoreRuntimeChecks,
  warned: ReadonlySet<Store>,
): boolean {
  // (a stopped mark the completion covered owes no check, #2080. Declared, not checked here (#2184): that this
  // completion pass, on the settled pass's inputs, admission's rejected stores among them, covers what the natural final
  // pass checks there, and the decider's own level, which the destination-type check passes over)
  if (
    obligation.slot.role === "stopped" &&
    result?.state === "complete" &&
    answers.completionRan(obligation.place, obligation.path, obligation.epoch) &&
    !warned.has(store) &&
    !answers.completedCheck(
      index.site(unwrap(store.kind === "letStatement" ? store.initializer : store.value)),
    )
  )
    return true;
  const own = published.get(store);
  const whole = own?.state === "complete" && checks.has(store);
  // (no result, a completion past its allowance or a stop of the analysis: the plan is the settled pass's, and only its
  // complete store check carries what the obligation requires; a reader, even of a `let` of its own, may be weaker than a
  // later store makes the natural check, and a partial store check than the natural plan's, which nothing tells (#1832))
  if (result === null) return whole;
  // (a shape is the suitability the value's own structure proves where it is not lost; a complete result there is the
  // requirement's, which a shape owes no more of)
  if (obligation.extent === "shape" || "shape" in result) return result.state !== "lost" || whole;
  if (result.state === "open" || whole) return true;
  const value = unwrap(store.kind === "letStatement" ? store.initializer : store.value);
  // (a contract the completion completed is kept only by a published check that carries it at the obligation's path: a
  // typed parse's or load's reader of the value stored, or the store's part checks there; where the natural plan checks
  // the store whole, `completedCheck`, and publication did not, its parts stand for nothing, #1645's whole object)
  const contract = answers.received(obligation.place, obligation.path);
  const destination = answers.storedPlace(nodeOf(answers, index, store));
  if (
    result.state !== "complete" ||
    contract?.state !== "complete" ||
    destination === null ||
    destination.id !== obligation.place ||
    destination.path.some((step, at) => obligation.path[at] !== step)
  )
    return false;
  const below = obligation.path
    .slice(destination.path.length)
    .map((step) =>
      step === "element" || step === "entry" || step === "index" ? "[]" : propertyName(step),
    );
  // (a reader at least as strict as the contract there: one that checks more, as a typed parse's of an object whose
  // field the contract leaves open, still checks all the contract does)
  const carries = (type: TypePlan | null | undefined): boolean => {
    const at = type === null || type === undefined ? null : typeAt(type, below);
    return at !== null && narrower(at, contract.ref);
  };
  if (
    carries(readerOf(value, checks, core)) ||
    elementsCarry(value, below, contract.ref, checks, core)
  )
    return true;
  if (answers.completedCheck(index.site(value))) return false;
  // (the part checks at or below the obligation's path, at least one, each the contract's type there where it has one:
  // a weaker one stands for nothing, #1645's whole object; and each level a part check passes over where it holds no
  // object or collection is one the stored value itself builds as one, #2231: a part check skips a value that is not)
  const parts = (core.partChecks.get(store) ?? []).filter((part) => {
    const steps = part.path.map((step) => ("element" in step ? "[]" : step.property));
    return steps.length >= below.length && below.every((step, at) => steps[at] === step);
  });
  return (
    parts.length > 0 &&
    parts.every((part) => {
      const steps = part.path.map((step) => ("element" in step ? "[]" : step.property));
      const at = typeAt(contract.ref, steps.slice(below.length));
      return (
        (at === null || JSON.stringify(part.type) === JSON.stringify(at)) &&
        builtContainers(value, part.path)
      );
    })
  );
}

/**
 * Whether the stored expression itself builds every level a part check at `path` passes over (#2231): from the stored
 * value to the part's parent, an object literal at each property step, holding the property where the path goes on
 * below it, and a list literal at each element step, the next level being each of its elements. A part check passes a
 * value that is no object or collection at such a level, so a keep by part checks rests on the value's own source
 * there, never on a kind the analysis reports for it; a part the literal leaves out passes, as the whole check lets it.
 */
export function builtContainers(value: Expression, path: PartCheckPlan["path"]): boolean {
  let nodes: readonly Expression[] = [value];
  for (const [at, step] of path.entries()) {
    const next: Expression[] = [];
    for (const node of nodes.map(unwrap)) {
      if ("element" in step) {
        if (node.kind !== "listLiteral") return false;
        next.push(...node.elements);
      } else {
        if (node.kind !== "objectLiteral") return false;
        const property = node.properties.find((each) => each.name.name === step.property);
        if (property !== undefined) next.push(property.value);
        else if (at < path.length - 1) return false;
      }
    }
    nodes = next;
  }
  return true;
}

/** The type a typed parse or load reads its value as, `undefined` for any other value. */
function readerOf(
  value: Expression,
  checks: ReadonlyMap<RuntimeCheckSite, TypeCheckPlan>,
  core: CoreRuntimeChecks,
): TypePlan | undefined {
  return value.kind === "loadExpression"
    ? checks.get(value)?.type
    : value.kind === "callExpression"
      ? core.expected.get(value)
      : undefined;
}

/**
 * Whether a stored literal carries a contract at `below` (property names and `[]` for an element) by its own structure:
 * followed through its properties and elements to the contract's level, a list or set whose every element carries the
 * contract's element, an object whose property carries each property the contract lists, a typed parse's or load's whole
 * value whose reader is at least as strict as the contract there, or a scalar literal of a kind at least as strict. The
 * value itself is a literal holding them, never the call alone (`readerOf`'s).
 */
function elementsCarry(
  value: Expression,
  below: readonly string[],
  contract: TypePlan,
  checks: ReadonlyMap<RuntimeCheckSite, TypeCheckPlan>,
  core: CoreRuntimeChecks,
): boolean {
  const carried = (at: Expression, steps: readonly string[], type: TypePlan): boolean => {
    const node = unwrap(at);
    if (node.kind === "listLiteral" || node.kind === "setLiteral") {
      if (steps.length > 0)
        return (
          steps[0] === "[]" &&
          node.elements.length > 0 &&
          node.elements.every((one) => carried(one, steps.slice(1), type))
        );
      const element =
        node.kind === "listLiteral"
          ? type.kind === "list"
            ? type.element
            : undefined
          : type.kind === "set"
            ? type.element
            : undefined;
      if (element === undefined) return false;
      return element === null || node.elements.every((one) => carried(one, [], element));
    }
    if (node.kind === "objectLiteral") {
      if (steps.length > 0) {
        const property = node.properties.find((one) => one.name.name === steps[0]);
        return property !== undefined && carried(property.value, steps.slice(1), type);
      }
      if (type.kind !== "object") return false;
      // (the literal's properties indexed once: the walk visits each property at most once, as the store's own check of
      // the value does, so its work is that check's, charged where publication made it)
      const own = new Map(node.properties.map((one) => [one.name.name, one.value]));
      return type.properties.every((wanted) => {
        const value = own.get(wanted.name);
        return value !== undefined && carried(value, [], wanted.type);
      });
    }
    const leaf = leafKind(node);
    if (leaf !== null) return steps.length === 0 && narrower(leaf, type);
    const reader = readerOf(node, checks, core);
    const there = reader === undefined ? null : typeAt(reader, steps);
    return there !== null && narrower(there, type);
  };
  const root = unwrap(value);
  return (
    (root.kind === "listLiteral" || root.kind === "setLiteral" || root.kind === "objectLiteral") &&
    carried(root, below, contract)
  );
}

/** The type a scalar literal proves by its own syntax, `null` for any other expression. */
function leafKind(node: Expression): TypePlan | null {
  switch (node.kind) {
    case "numberLiteral":
      return { kind: node.numericType };
    case "stringLiteral":
      return { kind: "string" };
    case "booleanLiteral":
      return { kind: "boolean" };
    case "nullLiteral":
      return { kind: "null" };
    default:
      return null;
  }
}

/**
 * Whether every value a check against `narrow` passes also passes one against `wide` (a check checks only the listed
 * properties an object has, and every element of a collection whose element type is not `null`): a reader that carries
 * a contract (`keeps`).
 */
export function narrower(narrow: TypePlan, wide: TypePlan): boolean {
  if (narrow.kind === "union") return narrow.members.every((member) => narrower(member, wide));
  if (wide.kind === "union") return wide.members.some((member) => narrower(narrow, member));
  if (wide.kind === "object") {
    if (narrow.kind !== "object") return false;
    const own = new Map(narrow.properties.map((each) => [each.name, each.type]));
    return wide.properties.every((property) => {
      const type = own.get(property.name);
      return type !== undefined && narrower(type, property.type);
    });
  }
  if (wide.kind === "list" || wide.kind === "set" || wide.kind === "dict") {
    if (narrow.kind !== "list" && narrow.kind !== "set" && narrow.kind !== "dict") return false;
    return (
      narrow.kind === wide.kind &&
      (wide.element === null || (narrow.element !== null && narrower(narrow.element, wide.element)))
    );
  }
  // (a whole number is a number)
  return narrow.kind === wide.kind || (narrow.kind === "integer" && wide.kind === "number");
}

/** A type plan's part at a path of property names and `[]` (an element, entry or value), `null` where it has none. */
function typeAt(type: TypePlan, steps: readonly string[]): TypePlan | null {
  let at: TypePlan | null = type;
  for (const step of steps)
    at =
      at === null
        ? null
        : step === "[]"
          ? at.kind === "list" || at.kind === "set" || at.kind === "dict"
            ? at.element
            : null
          : at.kind === "object"
            ? (at.properties.find((property) => property.name === step)?.type ?? null)
            : null;
  return at;
}
