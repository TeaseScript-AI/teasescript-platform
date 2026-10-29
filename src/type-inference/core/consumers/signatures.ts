import { dictMethod } from "../../../dict-operations.js";
import { listMethod, type ListParameterKind } from "../../../list-methods.js";
import { isTextMethod, TEXT_METHODS, type TextParameterKind } from "../../../text-operations.js";
import {
  orderedFamily,
  VALUE_KIND_NAMES,
  VALUE_KINDS,
  type ValueKind,
} from "../../../value-kinds.js";
import type { PlaceId } from "../../graph.js";
import { isExternal, isOpaque, requiredKind } from "../admission.js";
import type { Consumers } from "../consumers.js";
import { REFERENCE } from "../contract.js";
import { withoutEmpty } from "../exact-path.js";
import type { FlowNode } from "../flow-graph.js";
import type { Item, ItemTag } from "../items.js";
import type { ValueConstraint } from "../program.js";
import { offendingKinds, type DiagnosticRule } from "../result.js";
import { error } from "./diagnostics.js";
import { hasMethod } from "./kinds.js";
import { keyLabel, ownSpan, quietKinds, receiverKinds } from "./names.js";
import { consume } from "./operands.js";
import { obligation, warning } from "./warnings.js";

// C13 (TABLE C13, S3 §1): a built-in method's arguments and the elements it reads, against what its contract takes.

type Takes = Extract<DiagnosticRule, { rule: "argument" }>["takes"];

/** What a text method's parameter takes, by its kind (`TextParameter`); a position or a count is a whole number's. */
const TEXT_TAKES: Readonly<Record<TextParameterKind, Takes | null>> = {
  text: "text",
  regex: "regex",
  textOrRegex: "textOrRegex",
  position: null,
  count: null,
};

/**
 * What a list's or set's method's parameter takes, by its kind (`ListParameter`): any value (`value`), and an index or
 * a count, whose whole number C2 checks (`integerOnly`), are no argument check's.
 */
const LIST_TAKES: Readonly<Record<ListParameterKind, Takes | null>> = {
  value: null,
  list: "list",
  collection: "collection",
  index: null,
  count: null,
  text: "text",
};

/** The kinds each `Takes` is. */
const KINDS: Readonly<Record<Takes, readonly ValueKind[]>> = {
  text: ["string"],
  regex: ["regex"],
  textOrRegex: ["string", "regex"],
  list: ["list"],
  collection: ["list", "set"],
};

/** The kinds whose methods' contracts type their arguments: text, lists, sets and dicts. */
const RECEIVERS: readonly ValueKind[] = ["string", "list", "set", "dict"];

/**
 * What argument `position` of the method `name` takes on a receiver of `kind`, from the method's contract: a `Takes`,
 * `null` for any value (or one another check owns: a whole number, a dict key), or `undefined` where a receiver of the
 * kind has no such method or parameter.
 */
function takes(kind: ValueKind, name: string, position: number): Takes | null | undefined {
  if (kind === "string") {
    if (!isTextMethod(name)) return undefined;
    const parameter = TEXT_METHODS[name].parameters[position];
    return parameter === undefined ? undefined : TEXT_TAKES[parameter.kind];
  }
  if (kind === "list" || kind === "set") {
    const method = listMethod(name);
    if (method === undefined || !method.receivers.includes(kind)) return undefined;
    const parameter = method.parameters[position];
    return parameter === undefined ? undefined : LIST_TAKES[parameter.kind];
  }
  // (a dict's key is C12's, `operations.ts`)
  if (kind === "dict")
    return dictMethod(name)?.parameters[position] === undefined ? undefined : null;
  return undefined;
}

/** The name of argument `position` of `name` on a receiver of `kind`, as its contract calls it. */
function parameterName(kind: ValueKind, name: string, position: number): string {
  if (kind === "string" && isTextMethod(name))
    return TEXT_METHODS[name].parameters[position]?.name ?? "";
  return listMethod(name)?.parameters[position]?.name ?? "";
}

/**
 * C13: each argument of a method against what its contract takes on every kind its receiver may be, an unknown receiver
 * any kind that has the method (only text has `startsWith`): an argument is checked where every such kind takes only
 * some kinds; one that a kind takes whatever it is, or that a reference's runtime members take, is quiet. The ordered
 * predicate is `consume`'s: all fit, quiet; none fits and all definite, an error at the argument; else a warning whose
 * check is the method's own check of its argument when it runs.
 */
export function methodArguments(
  walk: Consumers,
  c: Extract<ValueConstraint, { kind: "operation" }>,
  node: FlowNode,
): void {
  if (c.receiver === null || c.arguments.length === 0) return;
  const { name } = c.contract;
  const items = receiverKinds(walk, c.receiver, node);
  if (items.some((item) => REFERENCE.has(item.tag))) return;
  const kinds = new Set<ValueKind>();
  for (const item of items)
    if (item.tag === "unknown") for (const kind of RECEIVERS) kinds.add(kind);
    else if (item.tag !== "null" && item.tag !== "empty") kinds.add(item.tag);
  const having = [...kinds].filter((kind) => hasMethod(kind, name));
  c.arguments.forEach((argument, position) => {
    const taking = having.flatMap((kind) => {
      const taken = takes(kind, name, position);
      return taken === undefined ? [] : [[kind, taken] as const];
    });
    if (taking.length === 0 || taking.some(([, taken]) => taken === null)) return;
    const domain = [...new Set(taking.flatMap(([, taken]) => KINDS[taken!]))];
    // (the first contract's word for what it takes, which a fix converts to)
    const [kind, taken] = taking[0]!;
    const parameter = parameterName(kind, name, position);
    consume(
      walk,
      argument,
      node,
      c.site,
      new Set(domain),
      `the ${parameter} of ${name}`,
      { rule: "argument", callee: name, parameter, domain, takes: taken! },
      domain,
    );
  });
}

/** Whether `join` shows an element of this kind (V30 §16): one `${...}` shows on its own. */
function shows(tag: ItemTag): boolean {
  return tag !== "empty" && tag !== "unknown" && VALUE_KINDS[tag].shown !== null;
}

/** Whether `sort` orders an element of this kind: one of an ordered type (`orderedFamily`). */
function orders(tag: ItemTag): boolean {
  return tag !== "empty" && tag !== "unknown" && orderedFamily(tag) !== undefined;
}

/** The ordered types of these kinds, each kind's family (a whole number is a number), each once. */
function families(tags: readonly ItemTag[]): ItemTag[] {
  const found = new Set<ItemTag>();
  for (const tag of tags) {
    const family = tag === "empty" || tag === "unknown" ? undefined : orderedFamily(tag);
    if (family !== undefined) found.add(family);
  }
  return [...found];
}

/**
 * C13, Astra's G1: the elements a list's `join` or `sort` reads, at the call: `join` shows each (TSV042), `sort` orders
 * them, all of one ordered type. The ordered predicate over the elements the receiver's lists may hold: all fit, quiet;
 * none fits, or two ordered types, and all definite, an error; else a warning whose check is the method's own check of
 * its elements when it runs. A receiver that may be no list is the member check's (`methodReceiver`), and one the core
 * cannot know reads no elements here.
 */
export function methodElements(
  walk: Consumers,
  c: Extract<ValueConstraint, { kind: "operation" }>,
  node: FlowNode,
): void {
  const { name } = c.contract;
  if (c.receiver === null || (name !== "join" && name !== "sort")) return;
  const receiver: PlaceId = c.receiver;
  // (the elements of a receiver the core cannot know are the runtime's: its member check owns the call)
  const kinds = receiverKinds(walk, receiver, node);
  if (!kinds.some((item) => item.tag === "list")) return;
  const fits = name === "join" ? shows : orders;
  const quiet = quietKinds(walk, receiver, ["element"]);
  if (quiet !== null && quiet.every(fits) && (name === "join" || families(quiet).length <= 1)) {
    walk.skip(receiver);
    return;
  }
  walk.pass.program.work.charge("checks");
  const items = withoutEmpty(walk.valueItems(receiver, node, ["element"]));
  const unfit = items.filter((item) =>
    item.tag === "unknown" ? isOpaque(item) || isExternal(item) : !fits(item.tag),
  );
  // (`sort`: elements of two ordered types, which no run compares)
  const mixed =
    name === "sort" && unfit.length === 0 ? families(items.map((item) => item.tag)) : [];
  if (unfit.length === 0 && mixed.length <= 1) return;
  const text = walk.pass.program.textAt(ownSpan(walk, receiver, c.site));
  const rule: DiagnosticRule = {
    rule: "elements",
    callee: name,
    receiver: text,
    families: mixed.length > 1 ? mixed : [],
  };
  if (
    (mixed.length > 1 || unfit.length === items.length) &&
    items.every((item) => item.cert === "def" && item.tag !== "unknown")
  ) {
    error(
      walk,
      "member-read",
      c.site,
      rule,
      items.map((item) => item.tag),
    );
    return;
  }
  const label = `${keyLabel(walk, receiver)}.element`;
  const against = VALUE_KIND_NAMES.filter(fits).map(requiredKind);
  // (beside the elements of another type, each that may be of a second ordered type)
  const offending: readonly Item[] =
    unfit.length > 0 ? unfit : items.filter((item) => item.cert === "pos");
  for (const { item } of offendingKinds(offending.length > 0 ? offending : items))
    warning(
      walk,
      "member-read",
      c.site,
      item,
      obligation(
        "operand",
        c.site,
        label,
        against,
        `check the elements of ${text} at .${name}() when it runs`,
      ),
      rule,
      items.filter((found) => fits(found.tag)),
    );
}
