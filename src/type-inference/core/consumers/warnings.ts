import type { PlaceId, SourceSite, TypeTerm } from "../../graph.js";
import { concrete, isExternal, requiredKind } from "../admission.js";
import type { Consumers } from "../consumers.js";
import { REFERENCE, termAt, typeTags } from "../contract.js";
import { keyOf, type Key } from "../definitions.js";
import { withoutEmpty } from "../exact-path.js";
import type { FlowNode } from "../flow-graph.js";
import type { ContextWord, Item, ItemTag } from "../items.js";
import { codeOf, pathPhrase } from "../messages.js";
import { measuresLength } from "../method-categories.js";
import { propertyName, siteKey, stepName } from "../program.js";
import { propertyNames, type PropertyNamesTask } from "../property-names.js";
import {
  contextOf,
  provenanceOf,
  type ContextDetail,
  type CoreDiagnostic,
  type DiagnosticKind,
  type DiagnosticRule,
  type Obligation,
  type ObligationKind,
  type RequiredKind,
  type StoreRoot,
  type StoreStep,
} from "../result.js";
import { siteOf } from "./diagnostics.js";
import { SHOWN } from "./kinds.js";
import { leftOutWarning } from "./left-out.js";
import { kindsOf } from "./names.js";

// The consumers' warnings and their sentences (D1, D2): a context word's detail, a store's root and steps.

/**
 * A warning of `rule` explained by `item`; `fits`, the value's items that the rule takes (its fixes' types);
 * `receiver`, a member's receiver as its context sentence names it, `read` the value whose read the word is (a
 * member's receiver; else the value at `site`). Whether it was made: a mark a test leaves out (`withoutRecords`) is
 * not.
 */
export function warning(
  walk: Consumers,
  kind: DiagnosticKind,
  site: SourceSite,
  item: Item,
  obligation: Obligation,
  rule: DiagnosticRule,
  fits: readonly Item[],
  receiver: ContextDetail["receiver"] = null,
  read?: PlaceId,
): boolean {
  const diagnostic: Extract<CoreDiagnostic, { obligation: unknown }> = {
    class: "warning-runtime-check",
    kind,
    code: codeOf(rule),
    site: siteOf(site),
    rule,
    kinds: [item.tag],
    provenance: provenanceOf(item, detail(walk, item, site, rule, receiver, read)),
    obligation,
    fits: [...new Set(fits.filter(concrete).map((found) => found.tag))],
    // (the published answers give it, from the site's other diagnostics, `withBesides`)
    besides: [],
  };
  if (walk.finishing && leftOutWarning(diagnostic)) return false;
  (walk.finishing ? walk.deferred : walk.diagnostics).push(diagnostic);
  walk.rules.set(diagnostic, walk.rule);
  return true;
}

/**
 * What a warning's context word's sentence names (D1, `ContextDetail`), where the word is the warned read's own
 * (`direct`, `directWord`), from that read's node: the function it is in where the value comes from outside it
 * (`call`) or is a parameter of it (`deferred-parameter`), the label its line is entered at (`label`), the block it
 * is in (`handler`), the receiver it reads a member of (`member`, `missing`, `unmodelled`); and the place a later
 * store decides (`later`, A7's, at the store). Only the warning's word asks.
 */
function detail(
  walk: Consumers,
  item: Item,
  site: SourceSite,
  rule: DiagnosticRule,
  receiver: ContextDetail["receiver"],
  read: PlaceId | undefined,
): ContextDetail {
  const { program } = walk.pass;
  const word = contextOf(item);
  const node = program.exprAt(site);
  const value = read ?? program.placeBySite.get(siteKey(site));
  // (`later` is the store's own; `budget` the whole analysis's stop)
  const direct =
    word === "later" ||
    word === "budget" ||
    // a reference's member the check itself names (F19a: a speaker's field by its name has no receiver place)
    (word === "unmodelled" && receiver?.kinds.some((kind) => REFERENCE.has(kind)) === true) ||
    (value !== undefined && directWord(walk, word, item, value, node, read !== undefined));
  const detail = {
    direct,
    outside: false,
    callable: null,
    label: null,
    handler: null,
    later: null,
    receiver: null,
  } satisfies ContextDetail;
  if (!direct && word !== "unknown") return detail;
  switch (word) {
    case "unknown":
      return { ...detail, outside: isExternal(item) };
    case "later":
      return rule.rule === "store" && rule.decider !== null
        ? { ...detail, later: { place: rule.into, kinds: rule.type, decider: rule.decider } }
        : detail;
    case "label": {
      const boundary = node === null ? null : program.dom.edom(node);
      return boundary?.statement?.kind === "labelStatement"
        ? { ...detail, label: boundary.statement.name.name }
        : detail;
    }
    case "handler":
      return {
        ...detail,
        handler: node === null ? null : (program.handlerOf(node)?.handler ?? null),
      };
    case "call":
    case "deferred-parameter": {
      const callable = node === null ? null : program.callableAt(node);
      if (callable?.kind !== "function") return detail;
      // `call`: a value set outside the function the read is in; a variable of the function changed by a call
      // between its store and the read has no function to name
      const root =
        value === undefined
          ? null
          : program.targetRoot(program.occurrenceOf.get(value) ?? value).root;
      const declared = root === null ? null : program.place(root).site;
      const inside =
        declared !== null &&
        declared.file === site.file &&
        declared.start >= callable.declaration.span.start.offset &&
        declared.end <= callable.declaration.span.end.offset;
      return word === "call" && inside
        ? detail
        : { ...detail, callable: callable.declaration.name.name };
    }
    case "member":
    case "missing":
    case "unmodelled": {
      if (receiver !== null) return { ...detail, receiver };
      // a speaker's field read by its name (F19a)
      const speaker = value === undefined ? undefined : program.places[value]?.kind;
      if (speaker?.kind === "speakerProperty")
        return {
          ...detail,
          receiver: { text: speaker.speaker, kinds: ["speaker"], member: speaker.name },
        };
      const projection = value === undefined ? undefined : program.projOf.get(value);
      const owner = projection === undefined ? undefined : program.places[projection.owner]?.site;
      if (projection === undefined || owner === null || owner === undefined || node === null)
        return detail;
      return {
        ...detail,
        receiver: {
          text: program.textAt(owner),
          kinds: kindsOf(walk, projection.owner, node).map((found) => found.tag),
          member: propertyName(projection.step),
        },
      };
    }
    default:
      return detail;
  }
}

/**
 * Whether `item`'s word arose at the read of `value` at `node` itself (D1: a sentence names only what its word
 * establishes), not in a value the read copies, projects, or takes from a call or an operation: an event word where
 * the read's own exact path fails with it (§3.4's X1–X7), `member` there or at an element read, `deferred-parameter`
 * at a parameter of the function the read is in, `missing` where a store of the receiver itself is the object that
 * lacks the property, `unmodelled` where the receiver holds a reference or at a speaker's field. The receiver:
 * `value` itself where `receiver` says it is a member access's receiver, else the owner the read projects.
 */
function directWord(
  walk: Consumers,
  word: ContextWord,
  item: Item,
  value: PlaceId,
  node: FlowNode | null,
  receiver: boolean,
): boolean {
  const { program, exact, definitions } = walk.pass;
  // the read's own key, as `Values.valueRoute` walks it: a projection passes its step to its owner (its steps
  // gathered from the read outwards, then reversed once)
  const steps: string[] = [];
  let at = node;
  let element = false;
  let owner: PlaceId | undefined;
  let place = value;
  for (let projection = program.projOf.get(place); projection !== undefined;) {
    if (projection.step === "iteration") return false;
    const step = measuresLength(projection.step) ? projection.step : stepName(projection.step);
    element ||= step === "element";
    owner ??= projection.owner;
    steps.push(step);
    at = projection.node ?? at;
    place = projection.owner;
    projection = program.projOf.get(place);
  }
  const path = steps.reverse();
  const binding = program.occurrenceOf.get(place);
  const call = program.callOutOf.has(place) ? program.opOf.get(place) : undefined;
  const key =
    binding !== undefined
      ? keyOf(binding, path)
      : call?.kind === "call"
        ? keyOf(program.functionOf(call.fn).result, path)
        : null;
  const reached =
    key === null || at === null ? null : exact.exactPath(key, program.occNode.get(place) ?? at);
  const own = reached !== null && "fail" in reached ? reached.fail : null;
  switch (word) {
    case "deferred-parameter": {
      if (own === null || binding === undefined || node === null) return false;
      const root = program.targetRoot(binding).root;
      const callable = program.callableAt(node);
      const declared = program.place(root).site;
      return (
        program.places[root]?.kind.kind === "parameter" &&
        callable?.kind === "function" &&
        declared !== null &&
        declared.start >= callable.declaration.span.start.offset &&
        declared.end <= callable.declaration.span.end.offset
      );
    }
    case "missing": {
      // the object lacking the property is one the receiver's own stores hold (not one a copy brings)
      const lacking = item.writer;
      if (binding === undefined || lacking === null) return false;
      return definitions.hasWriter(keyOf(binding, receiver ? path : path.slice(0, -1)), lacking);
    }
    case "unmodelled": {
      const holder = receiver ? value : owner;
      return (
        REFERENCE.has(item.tag) ||
        program.speakerPlaces.has(value) ||
        (holder !== undefined &&
          node !== null &&
          kindsOf(walk, holder, node).some((found) => REFERENCE.has(found.tag)))
      );
    }
    case "member":
      return own === "member" || element;
    default:
      return own === word;
  }
}

export function obligation(
  kind: ObligationKind,
  site: SourceSite,
  target: string,
  against: readonly RequiredKind[],
  on: string,
): Obligation {
  return { kind, target, against, on, site: siteOf(site), boundary: false };
}

/** A store's `copy-type` warning against the destination's kinds (C1, C10's `rule`); `fits` as `warning`'s. */
export function storeWarning(
  walk: Consumers,
  site: SourceSite,
  label: string,
  item: Item,
  against: readonly ItemTag[],
  rule: DiagnosticRule,
  fits: readonly Item[],
): boolean {
  return warning(
    walk,
    "written-target",
    site,
    item,
    obligation(
      "copy-type",
      site,
      label,
      against.map((tag) => requiredKind(tag)),
      `validate the stored value of ${label} against ${against.join("|")}`,
    ),
    rule,
    fits,
  );
}

/** S4: a possible null owes a null-check at every consumer, against what the place needs; `fits` as `warning`'s. */
export function nullWarning(
  walk: Consumers,
  kind: DiagnosticKind,
  site: SourceSite,
  item: Item,
  on: string,
  target: string,
  rule: DiagnosticRule,
  fits: readonly Item[],
  against: readonly RequiredKind[] = ["non-null"],
  receiver: ContextDetail["receiver"] = null,
  read?: PlaceId,
): void {
  warning(
    walk,
    kind,
    site,
    item,
    obligation("null-check", site, target, against, on),
    rule,
    fits,
    receiver,
    read,
  );
}

/**
 * A store's destination as its sentence names it (D2): the source's own text for its variable, a parameter's name, a
 * function's result as `f()`, and its properties; an element or a dict value in words (`'n' of an element of 'xs'`),
 * never as code the source does not hold.
 */
export function placeText(walk: Consumers, root: PlaceId, path: readonly string[]): string {
  const { program } = walk.pass;
  const kind = program.place(root).kind;
  const name =
    kind.kind === "binding" || kind.kind === "parameter"
      ? kind.name
      : kind.kind === "result"
        ? `${program.functionOf(kind.fn).name}()`
        : program.place(root).label;
  return pathPhrase({ code: name }, path);
}

/**
 * A store's root as a fix declares it (ADR 0021 rule 1.1): a variable by its `let` or `global`, a parameter, a
 * function's result; `null` for any other place.
 */
export function storeRoot(walk: Consumers, root: PlaceId): StoreRoot | null {
  const { program } = walk.pass;
  const { kind, site } = program.place(root);
  if (kind.kind === "binding")
    return kind.declared === "let" || kind.declared === "global"
      ? { kind: kind.declared, name: kind.name, site }
      : null;
  if (kind.kind === "result")
    return { kind: "result", name: program.functionOf(kind.fn).name, site: null };
  return kind.kind === "parameter" ? { kind: "parameter", name: kind.name, site } : null;
}

/**
 * The names of the properties a value's or a key's objects have (S3 §1), in the order the search finds them: once per
 * place a value copies, so every read of one place asks once.
 */
export function propertiesOf(
  walk: Consumers,
  of: { readonly key: Key } | { readonly value: PlaceId },
): readonly string[] {
  const place = "key" in of ? of.key : (walk.pass.contract.copiedKey(of.value) ?? of.value);
  let found = walk.names.get(place);
  if (found === undefined) {
    const start: PropertyNamesTask = "key" in of ? of : { value: of.value, path: [] };
    // (a finishing walk that asks nothing knows no property: `run`'s rule)
    found = walk.asksNothing()
      ? []
      : [...propertyNames(walk.pass, (work) => walk.solve(work), start)];
    walk.names.set(place, found);
  }
  return found;
}

/**
 * The property `${...}` shows of an object instead (#1195's decided text): the first, in its literal's order, whose
 * value it shows, of the earliest literal in source order the value may hold; `null` without one. Once per place.
 */
export function shownProperty(walk: Consumers, value: PlaceId): string | null {
  const { program, contract } = walk.pass;
  const place = contract.copiedKey(value) ?? value;
  const known = walk.shown.get(place);
  if (known !== undefined) return known;
  const first: { site: SourceSite | null; names: Iterable<string> } = { site: null, names: [] };
  // (a finishing walk that asks nothing knows no property: `run`'s rule)
  if (!walk.asksNothing())
    propertyNames(
      walk.pass,
      (work) => walk.solve(work),
      { value, path: [] },
      (literal, names) => {
        const site = program.place(literal).site;
        if (
          site !== null &&
          (first.site === null ||
            site.file < first.site.file ||
            (site.file === first.site.file && site.start < first.site.start))
        ) {
          first.site = site;
          first.names = names;
        }
      },
    );
  let found: string | null = null;
  for (const step of first.names) {
    program.work.charge("checks");
    const kinds = withoutEmpty(walk.run(contract.contractOfValueAt(value, [step])));
    // (a plain value: a list's emptiness is known only when the script runs, so none is suggested)
    if (kinds.length > 0 && kinds.every((item) => SHOWN.some((kind) => kind === item.tag))) {
      found = propertyName(step);
      break;
    }
  }
  walk.shown.set(place, found);
  return found;
}

/**
 * The steps of a store's path (`StoreStep`): an element step by the collection the contract holds above it, or, where
 * the root's written type reaches it (the finishing path's descent, TABLE r4.120), the collection written there,
 * final at every stop and asking no solver.
 */
export function storeSteps(
  walk: Consumers,
  root: PlaceId,
  path: readonly string[],
  written: TypeTerm | null = null,
): StoreStep[] {
  // (the written type at each prefix one step below the one before, never walked again from its root, #1194)
  let below = written;
  return path.map((step, index): StoreStep => {
    const term = below;
    if (below !== null) below = termAt(below, [step]);
    if (step === "entry") return { collection: "dict" };
    if (step !== "element") return { property: propertyName(step) };
    const above =
      term !== null
        ? typeTags(term)
        : withoutEmpty(
            walk.run(walk.pass.contract.contractOf(keyOf(root, path.slice(0, index)))),
          ).map((item) => item.tag);
    return { collection: above.includes("dict") ? "dict" : above.includes("set") ? "set" : "list" };
  });
}
