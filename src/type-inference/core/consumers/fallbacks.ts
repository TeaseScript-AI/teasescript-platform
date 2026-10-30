import type { PlaceId, SourceSite } from "../../graph.js";
import { concrete, fits, isExternal, isOpaque, requiredKind } from "../admission.js";
import { joinParts, joinSteps, keepText, keptText } from "../budget.js";
import type { Consumers } from "../consumers.js";
import { typeTags } from "../contract.js";
import { keyPath, keyPlace, type Key } from "../definitions.js";
import { withoutEmpty } from "../exact-path.js";
import type { FlowNode } from "../flow-graph.js";
import { STOPPED, type Item, type ItemTag } from "../items.js";
import type { ValueConstraint } from "../program.js";
import { elementStep, offendingKinds, type DiagnosticRule } from "../result.js";
import { error } from "./diagnostics.js";
import { heldHostData } from "./finishing.js";
import { unsettledItem } from "./kinds.js";
import { keyLabel, ownSpan, quietKinds } from "./names.js";
import { obligation, storeRoot, storeWarning } from "./warnings.js";

// C10: a fallback's or a default's kinds against the direct value's, and an unwritten parameter's default (ADR 1.5).

/**
 * C10: a fallback or a default is `null`, or has the direct value's family without its `null` (whole numbers with
 * numbers; a conversion's result; nested list, set and dict literals by their elements), or a load's or `fromJson`'s
 * written expected type's kinds at every depth (ADR 1.2, 7: a whole number fits a written number, a fraction never a
 * written integer, the owner's F3), or the value lands directly in a written place whose union holds both; a direct
 * value that is only `null` or unsettled imposes none. Both definite and incompatible: an error at the fallback, below
 * it at the innermost offending element (r4.35); possible: a warning with its `copy-type`; an unknown the fallback may
 * hold: a warning against those kinds, its host data meeting its boundary.
 */
export function fallbackFits(
  walk: Consumers,
  c: ValueConstraint,
  node: FlowNode,
  directAt: (rest: readonly string[]) => readonly Item[],
  value: PlaceId,
  written = false,
): void {
  // nested list, set and dict literals by their elements, one depth after another; the target: the fallback's own
  // key path at the depth, a dict's value its `entry` (§10.5)
  const { contract, program } = walk.pass;
  // the label by its steps: the fallback's own, then one per depth below it
  const label = [keyLabel(walk, value)];
  for (
    let rest: readonly string[] = [];
    fallbackFitsAt(walk, c, node, directAt, value, rest, written, labelAt(walk, label));
    rest = joinSteps(rest, ["element"])
  ) {
    program.work.charge("checks");
    label.push(
      elementStep(
        withoutEmpty(walk.run(contract.contractOfValueAt(value, rest))).map((item) => item.tag),
      ),
    );
  }
}

/**
 * The fallback's label at the depth its steps reach, made and charged once where a check or warning there first names
 * it: a label stepped at every depth made the labels of k nested `otherwise` k² code units, uncharged (#1433).
 */
function labelAt(walk: Consumers, label: readonly string[]): () => string {
  let made: string | undefined;
  return () => (made ??= label.length === 1 ? label[0]! : keptText(walk.pass.program.work, label));
}

/** C10 at one path of the fallback, its label there made by `label`: whether its elements are checked too. */
function fallbackFitsAt(
  walk: Consumers,
  c: ValueConstraint,
  node: FlowNode,
  directAt: (rest: readonly string[]) => readonly Item[],
  value: PlaceId,
  rest: readonly string[],
  written: boolean,
  label: () => string,
): boolean {
  const { program, contract, definitions } = walk.pass;
  const site = program.places[value]?.site;
  if (site === null || site === undefined || !("result" in c)) return false;
  const direct = directAt(rest);
  const into = contract.landsIn(c.result, rest);
  // (the declaration the value lands in directly, where a written type is)
  const root =
    into === null || rest.length > 0
      ? null
      : ((landing) => (landing === undefined ? null : storeRoot(walk, landing.place)))(
          (definitions.byValue.get(c.result) ?? []).find(
            (d) => d.kind === "whole" && d.path.length === 0,
          ),
        );
  const family = (tag: ItemTag): ItemTag => (tag === "integer" ? "number" : tag);
  const directTags = [...new Set(direct.filter(concrete).map((item) => item.tag))];
  if (directTags.length === 0) {
    // a stop left the type it is checked against undecided: the check is owed against that key's contract,
    // `unknown` with the reason `budget`, never dropped (TABLE r4.100); a `null` fallback alone owes nothing; its
    // host data meets its boundary as unstopped (r4.109 (1)); its value read only then
    if (!direct.some(unsettledItem)) return false;
    const own = withoutEmpty(walk.valueItems(value, node, rest));
    if (
      !own.every((item) => item.tag === "null") &&
      // (what the mark carries forms only with it: its content, TABLE r4.110 (a))
      storeWarning(
        walk,
        site,
        label(),
        STOPPED[0]!,
        ["unknown"],
        { rule: "fallback", fallback: c.kind === "fallback", type: ["unknown"], root },
        [],
      ) &&
      (into === null || !typeTags(into).includes("unknown"))
    )
      walk.admission.boundariesAt(
        [...own, ...heldHostData(walk, value)].filter((item) => isOpaque(item) || isExternal(item)),
        obligation(
          "copy-type",
          site,
          label(),
          ["unknown"],
          `check ${c.kind === "fallback" ? "the fallback" : "the default"} ${label()}`,
        ),
      );
    return false;
  }
  const directFamilies = new Set(directTags.map(family));
  // one domain for the quiet path, the error, the warning and the check: a written type's own kinds, else the family
  const admits = (tag: ItemTag, refs: readonly ItemTag[]): boolean =>
    refs.some((ref) =>
      written ? tag !== "unknown" && fits(tag, ref, true) : family(tag) === family(ref),
    );
  // the written union the value lands in directly, where it holds the direct kinds: a fallback of its kinds fits too
  const intoTags = into === null ? [] : typeTags(into);
  const union = into === null ? null : new Set(intoTags.map(family));
  const unionHolds = union !== null && directTags.every((tag) => admits(tag, intoTags));
  const fitsKind = (tag: ItemTag): boolean =>
    tag === "null"
      ? !(rest.length > 0 && into !== null && !intoTags.includes("null"))
      : admits(tag, directTags) || (unionHolds && admits(tag, intoTags));
  // the family the fallback is checked against: the direct value's (whole numbers with numbers), a load's or
  // `fromJson`'s written type itself (its `null` C10's exception, never listed), and the receiving union's kinds
  const against: ItemTag[] = [
    ...new Set([
      ...(written
        ? direct.filter(concrete).map((item) => item.tag)
        : [...directFamilies].flatMap((found): ItemTag[] =>
            found === "number" ? ["integer", "number"] : [found],
          )),
      ...(unionHolds ? typeTags(into!).filter((tag) => tag !== "null" && tag !== "unknown") : []),
    ]),
  ];
  // §3.3: a fallback whose contract every kind of fits asks nothing more at this path
  const quiet = quietKinds(walk, value, rest);
  const fallback =
    quiet !== null && quiet.every(fitsKind) ? [] : withoutEmpty(walk.valueItems(value, node, rest));
  const off = fallback.filter((item) => item.tag !== "unknown" && !fitsKind(item.tag));
  const what = c.kind === "fallback" ? "the fallback" : "the default";
  const rule: DiagnosticRule = {
    rule: "fallback",
    fallback: c.kind === "fallback",
    type: against,
    root,
  };
  const fitting = fallback.filter((item) => concrete(item) && fitsKind(item.tag));
  // an unknown the fallback may hold is possible: `copy-type` on the fallback against that family, unless a written
  // destination admits `unknown`; its host data meets its boundary
  const unknowns = fallback.filter((item) => isOpaque(item) || isExternal(item));
  if (unknowns.length > 0 && !(union !== null && union.has("unknown"))) {
    for (const { item } of offendingKinds(unknowns))
      storeWarning(walk, site, label(), item, against, rule, fitting);
    walk.admission.boundariesAt(
      fallback,
      obligation("copy-type", site, label(), against.map(requiredKind), `check ${what} ${label()}`),
    );
  }
  if (off.length === 0) {
    // nested literals by their elements
    const kinds = quiet ?? fallback.map((item) => item.tag);
    return (["list", "set", "dict"] as const).some(
      (kind) => directFamilies.has(kind) && kinds.includes(kind),
    );
  }
  if (union !== null && union.has("unknown")) return false;
  // below the fallback, a definite element of its literals none of whose kinds fits: an error at that element (A8,
  // r4.35); else both definite and incompatible, no kind of the fallback fitting (r4.46): an error at the fallback;
  // possible: one warning and check per offending kind
  const element = offendingElement(walk, value, node, rest, fitsKind);
  if (element !== null) error(walk, "written-target", element.site, rule, element.kinds);
  else if (
    direct.filter(concrete).every((item) => item.cert === "def") &&
    off.every((item) => item.cert === "def") &&
    !fallback.some((item) => concrete(item) && fitsKind(item.tag))
  )
    error(
      walk,
      "written-target",
      site,
      rule,
      off.map((item) => item.tag),
    );
  else
    for (const { item } of offendingKinds(off))
      storeWarning(walk, site, label(), item, against, rule, fitting);
  return false;
}

/**
 * A8, r4.35: the innermost element of a fallback's literals at `rest` whose kinds are definite and none fits, in source
 * order, with its kinds; `null` at the fallback itself or where no literal holds one.
 */
function offendingElement(
  walk: Consumers,
  value: PlaceId,
  node: FlowNode,
  rest: readonly string[],
  fitsKind: (tag: ItemTag) => boolean,
): { readonly site: SourceSite; readonly kinds: readonly ItemTag[] } | null {
  const { program } = walk.pass;
  const pending: [PlaceId, FlowNode, number][] = rest.length === 0 ? [] : [[value, node, 0]];
  while (pending.length > 0) {
    const [current, at, index] = pending.pop()!;
    const children = walk.admission.literalChildren(current, rest[index]!);
    for (let position = children.length - 1; position >= 0; position -= 1) {
      program.work.charge("checks");
      const child = children[position]!;
      if (index + 1 < rest.length) pending.push([child.value!, child.node ?? at, index + 1]);
    }
    if (index + 1 < rest.length) continue;
    for (const child of children) {
      program.work.charge("checks");
      const items = withoutEmpty(walk.valueItems(child.value!, child.node ?? at, []));
      if (
        items.length > 0 &&
        items.every((item) => item.cert === "def" && concrete(item)) &&
        !items.some((item) => fitsKind(item.tag))
      ) {
        const site = program.place(child.value!).site;
        return site === null ? null : { site, kinds: items.map((item) => item.tag) };
      }
    }
  }
  return null;
}

/**
 * ADR 1.5: an unwritten parameter's default must suit the body: its null reaching a member access with no store
 * between is an error, once in the function, also through copies of the parameter that reach the access unchanged and
 * unguarded.
 */
function defaultSource(
  walk: Consumers,
  key: Key,
  at: FlowNode,
): { readonly key: Key; readonly at: FlowNode } | null {
  const { program, lists, guards } = walk.pass;
  // a loop along the copies, each step memoised with the chain's answer
  const visited: string[] = [];
  let found: { readonly key: Key; readonly at: FlowNode } | null = null;
  let next: { readonly key: Key; readonly at: FlowNode } | null = { key, at };
  try {
    while (next !== null) {
      const step: { readonly key: Key; readonly at: FlowNode } = next;
      next = null;
      const memoKey = joinParts(step.key, step.at.id);
      if (walk.defaults.has(memoKey)) {
        found = walk.defaults.get(memoKey)!;
        break;
      }
      // a copy cycle leads to no parameter
      keepText(program.work, memoKey.length);
      walk.defaults.set(memoKey, null);
      visited.push(memoKey);
      program.work.charge("checks");
      const place = program.place(keyPlace(step.key)).kind;
      if (guards.narrowed(step.key, step.at)) found = null;
      else if (place.kind === "parameter" && keyPath(step.key).length === 0)
        found = place.written === null ? step : null;
      else {
        const reaching = lists.reachingDef(step.key, step.at);
        const copy =
          reaching !== null &&
          reaching.def.kind === "whole" &&
          reaching.def.value !== undefined &&
          reaching.def.how !== "argument" &&
          reaching.def.how !== "parameter default" &&
          lists.eventBetween(step.key, reaching.def.node, step.at) === null;
        // the copy's value at the rest of the path, through its literal's fields
        let value: PlaceId | undefined = copy ? reaching.def.value : undefined;
        for (const part of copy ? reaching.rest : []) {
          const children = value === undefined ? [] : walk.admission.storesAt(value, part);
          value = children.length === 1 ? children[0]!.value : undefined;
          if (value === undefined) break;
        }
        const copied = value === undefined ? null : walk.pass.contract.copiedKey(value);
        found = null;
        if (copied !== null && reaching !== null) next = { key: copied, at: reaching.def.node };
      }
    }
  } catch (error) {
    // a stop inside leaves no step's provisional answer for the finishing path to read
    for (const memoKey of visited) walk.defaults.delete(memoKey);
    throw error;
  }
  for (const memoKey of visited) walk.defaults.set(memoKey, found);
  return found;
}

export function defaultNull(
  walk: Consumers,
  owner: PlaceId,
  node: FlowNode,
  site: SourceSite,
  member: string,
  use: "read" | "call",
): void {
  // (a fresh finishing pass settled no default to find: `run` answers `STOPPED`, so its walk could find nothing)
  if (walk.finishing && !walk.settled) return;
  const { program, definitions, lists, contract } = walk.pass;
  const key = contract.copiedKey(owner);
  const source = key === null ? null : defaultSource(walk, key, program.occNode.get(owner) ?? node);
  if (source === null) return;
  const reaching = lists.reachingDef(source.key, source.at);
  const fallback = definitions.defaultOf(keyPlace(source.key));
  if (
    fallback !== undefined &&
    reaching !== null &&
    reaching.rest.length === 0 &&
    (reaching.def.how === "argument" || reaching.def.how === "parameter default") &&
    lists.eventBetween(source.key, reaching.def.node, source.at) === null
  ) {
    const items = walk.valueRun(fallback.value!, fallback.node, []);
    if (items.length > 0 && items.every((item) => item.tag === "null"))
      error(
        walk,
        "member-read",
        site,
        { rule: "member", receiver: program.textAt(ownSpan(walk, owner, site)), member, use },
        ["null"],
      );
  }
}
