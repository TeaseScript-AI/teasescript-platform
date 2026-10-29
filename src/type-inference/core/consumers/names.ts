import type { Expression } from "../../../ast.js";
import type { PlaceId, SourceSite } from "../../graph.js";
import { joinSteps, stepText } from "../budget.js";
import type { Consumers } from "../consumers.js";
import { heldReference, REFERENCE } from "../contract.js";
import { keptKey, keptKeyBelow, keyPath, keyPlace, type Key } from "../definitions.js";
import { withoutEmpty } from "../exact-path.js";
import type { FlowNode } from "../flow-graph.js";
import { makeItem, type Item, type ItemTag } from "../items.js";
import { dictList } from "../method-categories.js";
import { propertyName, siteKey, stepName } from "../program.js";
import { elementStep } from "../result.js";

// The names obligations use: an operand's span, a key's label, a chain's derived or anonymous start, quiet kinds.

/**
 * A read's key: its binding's root and path, then a step per projection, each value's kept once and made from its
 * owner's by its step (`writtenRead`'s walk); `null` where a loop's element or no binding is read.
 */
export function readKey(walk: Consumers, value: PlaceId): Key | null {
  const { program } = walk.pass;
  const chain: PlaceId[] = [];
  let at = value;
  for (
    let projection = program.projOf.get(at);
    projection !== undefined && !walk.readKeys.has(at);
    projection = program.projOf.get(at)
  ) {
    chain.push(at);
    at = projection.owner;
  }
  let key = walk.readKeys.get(at);
  if (key === undefined) {
    program.work.charge("checks");
    const binding = program.occurrenceOf.get(at);
    const target = binding === undefined ? null : program.targetRoot(binding);
    key = target === null ? null : keptKey(program.work, target.root, target.path);
    walk.readKeys.set(at, key);
  }
  for (const next of chain.reverse()) {
    program.work.charge("checks");
    const step = program.projOf.get(next)!.step;
    key =
      key === null || step === "iteration"
        ? null
        : keptKeyBelow(program.work, key, [stepName(step)]);
    walk.readKeys.set(next, key);
  }
  return key;
}

/** An operand's own span, the site of its diagnostic. */
export function ownSpan(walk: Consumers, value: PlaceId, fallback: SourceSite): SourceSite {
  return walk.pass.program.places[value]?.site ?? fallback;
}

/**
 * An obligation's target (§10.5 r4.10): the key path a value reads in the contract's vocabulary (`box.n`, every
 * selection or index `xs.element`, a dict's `d.entry`, a parameter `use.data`, a result `f.result`), else its text.
 */
export function keyLabel(walk: Consumers, value: PlaceId, depth = 0): string {
  const { program } = walk.pass;
  const binding = program.occurrenceOf.get(value);
  if (binding !== undefined) return program.place(binding).label;
  const projection =
    program.projOf.get(value) ??
    (walk.getOf.has(value) ? { owner: walk.getOf.get(value)!, step: "index" } : undefined);
  // §10.5: an anonymous target, a read below a value no place holds (a literal's, an operation's) or through a dict's
  // `values` or `keys` (a new list each read, r4.46 (2)), is named by its own text
  if (projection !== undefined && (derived(walk, value) || anonymous(walk, value))) {
    const site = program.places[value]?.site ?? null;
    if (site !== null) return program.textAt(site);
  }
  if (projection !== undefined && depth < 256) {
    // a selection, index or `get` is `element` (an object's own `first` too, F11), a dict's value `entry`
    const step =
      stepName(projection.step) === "element" && projection.step !== "element"
        ? elementStepOf(walk, projection.owner)
        : propertyName(projection.step);
    return stepText(keyLabel(walk, projection.owner, depth + 1), step);
  }
  const result = walk.resultOfCall.get(value);
  if (result !== undefined) return program.place(result).label;
  const site = program.places[value]?.site ?? null;
  return site === null ? "the value" : program.textAt(site);
}

/** A label's step below an owner an index or a selection reads: an element, or a dict's value; once per owner. */
function elementStepOf(walk: Consumers, owner: PlaceId): string {
  let step = walk.elementSteps.get(owner);
  if (step === undefined) {
    step = elementStep(
      withoutEmpty(walk.run(walk.pass.contract.contractOfValue(owner))).map((item) => item.tag),
    );
    walk.elementSteps.set(owner, step);
  }
  return step;
}

/** Whether a projection chain passes a dict's `values` or `keys`: a derived list, which no place holds (once each). */
function derived(walk: Consumers, value: PlaceId): boolean {
  let derived = walk.derivedChains.get(value);
  if (derived === undefined) walk.derivedChains.set(value, (derived = derivedChain(walk, value)));
  return derived;
}

function derivedChain(walk: Consumers, value: PlaceId): boolean {
  const { program, contract } = walk.pass;
  let at: PlaceId = value;
  for (let depth = 0; depth < 256; depth += 1) {
    const projection =
      program.projOf.get(at) ??
      (walk.getOf.has(at) ? { owner: walk.getOf.get(at)!, step: "index" } : undefined);
    if (projection === undefined) return false;
    if (
      dictList(propertyName(projection.step)) !== undefined &&
      walk.run(contract.contractOfValue(projection.owner)).some((item) => item.tag === "dict")
    )
      return true;
    at = projection.owner;
  }
  return false;
}

/** Whether a projection chain starts at a value no place holds: no variable's read, no call's result (once each). */
function anonymous(walk: Consumers, value: PlaceId): boolean {
  let anonymous = walk.anonymousChains.get(value);
  if (anonymous === undefined)
    walk.anonymousChains.set(value, (anonymous = anonymousChain(walk, value)));
  return anonymous;
}

function anonymousChain(walk: Consumers, value: PlaceId): boolean {
  const { program } = walk.pass;
  let at: PlaceId = value;
  for (let depth = 0; depth < 256; depth += 1) {
    const projection =
      program.projOf.get(at) ??
      (walk.getOf.has(at) ? { owner: walk.getOf.get(at)!, step: "index" } : undefined);
    if (projection === undefined)
      return !program.occurrenceOf.has(at) && !walk.resultOfCall.has(at);
    at = projection.owner;
  }
  return false;
}

/**
 * What a content-specific check reads of `value` at `rest` (Sol r1 B2, the owner's review F2; ADR 0021 1.8, 1.10): its
 * answer's items, and where they hold what the core cannot know, the kinds its contract admits there instead, else the
 * admitted type of the place it reads (a written host collection, a copy of one, a typed load or parse), each possible: a domain constrains what the value may hold
 * and proves nothing of it, a collection it admits may be empty, so a misfit there owes the use's check, never an error.
 */
export function domainItems(
  walk: Consumers,
  value: PlaceId,
  node: FlowNode | null,
  rest: readonly string[],
): Item[] {
  const items = withoutEmpty(walk.valueItems(value, node, rest));
  if (!items.some((item) => item.tag === "unknown")) return items;
  const domain = quietKinds(walk, value, rest) ?? admittedKinds(walk, value, rest);
  return domain === null
    ? items
    : [
        ...items.filter((item) => item.tag !== "unknown"),
        ...domain.map((tag) => makeItem(tag, null, { cert: "pos" })),
      ];
}

/** The admitted type at `rest` of the place a read reads (a copy's of a written type, A4), `null` with an unknown. */
function admittedKinds(walk: Consumers, value: PlaceId, rest: readonly string[]): ItemTag[] | null {
  const key = readKey(walk, value);
  if (key === null) return null;
  const tags = walk.admission
    .admitted(keyPlace(key), joinSteps(keyPath(key), rest))
    .filter((tag) => tag !== "empty");
  return tags.length === 0 || tags.includes("unknown") ? null : tags;
}

/** §3.3, the quiet path: a value's contract kinds, asked before any read is evaluated; `null` with an unknown. */
export function quietKinds(
  walk: Consumers,
  value: PlaceId | undefined,
  rest: readonly string[] = [],
): ItemTag[] | null {
  if (value === undefined) return null;
  const items = withoutEmpty(walk.run(walk.pass.contract.contractOfValueAt(value, rest)));
  return items.length === 0 || items.some((item) => item.tag === "unknown")
    ? null
    : items.map((item) => item.tag);
}

export function kindsOf(walk: Consumers, value: PlaceId, node: FlowNode | null): Item[] {
  return withoutEmpty(walk.valueItems(value, node, []));
}

/**
 * A member's or a method's receiver: its kinds at the node, and F19a before them (r4.44): where the shared decision
 * on the receiver's contract holds a reference the exact value lacks, its reference kinds too, whose members the
 * consumer's member obligations cover.
 */
export function receiverKinds(walk: Consumers, value: PlaceId, node: FlowNode | null): Item[] {
  const kinds = kindsOf(walk, value, node);
  if (kinds.some((item) => REFERENCE.has(item.tag))) return kinds;
  const contract = walk.run(walk.pass.contract.valueReceiver(value));
  return heldReference(contract)
    ? [...kinds, ...contract.filter((item) => REFERENCE.has(item.tag))]
    : kinds;
}

/** The owner of the index projection at a span. */
export function indexProjection(
  walk: Consumers,
  span: Expression["span"],
  file: number,
): PlaceId | undefined {
  return indexOwner(walk, { file, start: span.start.offset, end: span.end.offset });
}

/** The owner of the index projection at a site. */
export function indexOwner(walk: Consumers, site: SourceSite): PlaceId | undefined {
  if (walk.indexProjections === null) {
    walk.indexProjections = new Map();
    for (const c of walk.pass.program.constraints)
      if (c.kind === "project") walk.indexProjections.set(siteKey(c.site), c.owner);
  }
  return walk.indexProjections.get(siteKey(site));
}
