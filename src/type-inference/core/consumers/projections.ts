import type { Constraint, PlaceId, SourceSite } from "../../graph.js";
import { isExternal, isOpaque, requiredKind } from "../admission.js";
import type { Consumers } from "../consumers.js";
import { OWN_SELECTION, REFERENCE } from "../contract.js";
import { withoutEmpty } from "../exact-path.js";
import type { FlowNode } from "../flow-graph.js";
import { makeItem, REASON, type ItemTag } from "../items.js";
import { selectsElement } from "../method-categories.js";
import { propertyName } from "../program.js";
import { explainingItem, type DiagnosticRule } from "../result.js";
import { error } from "./diagnostics.js";
import { defaultNull } from "./fallbacks.js";
import { literalSyntax } from "./finishing.js";
import { hasProperty, unsettledItem } from "./kinds.js";
import type { Offending } from "./model.js";
import { keyLabel, kindsOf, ownSpan, quietKinds, receiverKinds } from "./names.js";
import { consume } from "./operands.js";
import { memberChecks } from "./receivers.js";
import { obligation, propertiesOf, warning } from "./warnings.js";

// A projection's consumers: a `for` loop's iterable (C13), an element selection (C6), a member access.

/** What a `for` loop goes through (C13, TABLE r4.81 (2)): a list, set, dict or range; a dict with a key and a value. */
const ITERABLE = ["list", "set", "dict", "range"] as const;

const DICT = ["dict"] as const;

/** A projection: a `for` loop's iterable (C13), an element selection (C6), a member read (C5a–c, F11, F19a). */
export function projection(
  walk: Consumers,
  c: Extract<Constraint, { kind: "project" }>,
  node: FlowNode,
): void {
  const { contract } = walk.pass;
  if (c.step === "iteration" || c.step === "entry") {
    // C13 (TABLE r4.81 (2)): an operand of the loop, at the iterable, against the domain it tests, which the runtime's
    // own check of the loop's source applies
    const domain = c.step === "entry" ? DICT : ITERABLE;
    consume(
      walk,
      c.owner,
      node,
      c.site,
      new Set(domain),
      "the iterable of for",
      { rule: "iterable", entries: c.step === "entry" },
      domain,
    );
    return;
  }
  const property = typeof c.step === "object" ? c.step.property : c.step;
  // an index step (`xs[i]`) is no object's member; a property named `index` is (Astra B1)
  const indexStep = c.step === "index";
  if (!indexStep && typeof c.step !== "object") return;
  const receiverText = walk.pass.program.textAt(ownSpan(walk, c.owner, c.site));
  const member = indexStep ? "[i]" : `.${propertyName(property)}`;
  if (typeof c.step === "object") defaultNull(walk, c.owner, node, c.site, member, "read");
  // §3.3: every receiver kind has the member, and every source the property
  {
    const quiet = quietKinds(walk, c.owner);
    const own = typeof c.step === "object" ? walk.run(contract.contractOfValueAt(c.into, [])) : [];
    if (
      quiet !== null &&
      quiet.every(
        (tag) =>
          tag !== "null" &&
          !REFERENCE.has(tag) &&
          (tag === "object" ? !indexStep : hasProperty(tag, property)),
      ) &&
      !own.some((item) => item.tag === "unknown" && (item.reasons & REASON.missing) !== 0) &&
      // (a member contract a stop left unsettled is no proof of the property)
      !own.some(unsettledItem) &&
      !(
        selectsElement(property) &&
        quiet.some((tag) => tag === "list" || tag === "set" || tag === "object")
      )
    ) {
      walk.skip(c.owner);
      return;
    }
  }
  const owners = receiverKinds(walk, c.owner, node);
  const label = keyLabel(walk, c.owner);
  // C6: a selection on a collection, or on an unknown receiver that may be one
  if (
    selectsElement(property) &&
    owners.some(
      (item) => item.tag === "list" || item.tag === "set" || isOpaque(item) || isExternal(item),
    )
  )
    selection(walk, c.owner, node, c.site, `.${property}`);
  // C9: the receiver's external data brings its boundary checks, whichever member check follows
  walk.admission.boundariesAt(
    owners,
    obligation(
      "null-check",
      ownSpan(walk, c.owner, c.site),
      label,
      ["non-null"],
      `check that ${label} is not null and has .${property}`,
    ),
  );
  // C5a, C5b, F19a, F15; C5c: a property some source lacks, its own obligation (an error where no known source has it)
  const objects = owners.some((item) => item.tag === "object");
  const extra: Offending[] = [];
  if (objects && selectsElement(property))
    // F11 (r4.4): an object's own `first`, `last` or `random`: opaque, the member obligation, never an error
    extra.push([OWN_SELECTION, `has its own .${property}`]);
  else if (objects && typeof c.step === "object") {
    const value = walk.valueItems(c.into, node, []);
    const missing = value.filter(
      (item) => item.tag === "unknown" && (item.reasons & REASON.missing) !== 0,
    );
    const sources = withoutEmpty(walk.run(contract.contractOfValueAt(c.into, [])));
    const quietOwner = quietKinds(walk, c.owner) ?? [];
    // C5c: no source has the property, an error; never under a guard of the receiver (§3.2)
    if (
      missing.length > 0 &&
      sources.length > 0 &&
      sources.every((item) => item.tag === "unknown" && item.reasons === REASON.missing) &&
      quietOwner.length > 0 &&
      quietOwner.every((tag) => tag === "object") &&
      !owners.some((item) => item.guarded === true)
    ) {
      error(
        walk,
        "member-read",
        c.site,
        {
          rule: "absent",
          receiver: receiverText,
          property: propertyName(property),
          store: null,
          properties: [...propertiesOf(walk, { value: c.owner })],
        },
        [],
      );
      return;
    }
    // (a member read a stop left unsettled is no proof of the property either: its check stands, as C6's)
    const open = missing.length > 0 ? missing[0] : value.find(unsettledItem);
    if (open !== undefined) extra.push([open, `has .${property} before the read`]);
  }
  const takes = (tag: ItemTag): boolean =>
    tag === "object" ? !indexStep : hasProperty(tag, property);
  // (a list's `join` read: its elements' type, every value they may take, at its `element` step, which decides whether
  // the fix's call is valid; its current contents may be empty, Codex r4)
  const elements =
    property === "join" && owners.some((item) => item.tag === "list")
      ? withoutEmpty(walk.run(contract.contractOfValueAt(c.owner, ["element"]))).map(
          (item) => item.tag,
        )
      : undefined;
  memberChecks(
    walk,
    c.site,
    label,
    owners,
    takes,
    `.${property}`,
    "read",
    receiverText,
    member,
    extra,
    c.owner,
    elements,
  );
}

/** C6: an element selection needs an element: M held by the contract, or by the exact value. */
export function selection(
  walk: Consumers,
  value: PlaceId,
  node: FlowNode,
  site: SourceSite,
  what: string,
): void {
  const { contract } = walk.pass;
  const elements = walk.run(contract.contractOfValueAt(value, ["element"]));
  if (
    elements.length > 0 &&
    !elements.some((item) => item.tag === "empty") &&
    // (an element contract a stop left unsettled says nothing of emptiness)
    !elements.some(unsettledItem) &&
    !walk.run(contract.contractOfValue(value)).some((item) => item.tag === "unknown")
  ) {
    walk.skip(value);
    return;
  }
  const read = walk.valueItems(value, node, ["element"]);
  const kinds = kindsOf(walk, value, node);
  if (
    withoutEmpty(read).length > 0 &&
    !read.some((item) => item.tag === "empty") &&
    // (an element read a stop left unsettled is no proof of an element, a literal's own element is: Codex r24 N1)
    (!read.some(unsettledItem) ||
      (literalSyntax(walk, value) &&
        walk.admission.literalChildren(value, "element").length > 0)) &&
    !kinds.some((item) => item.tag === "unknown")
  )
    return;
  // the obligation answers for every collection and every unknown that may be one
  const collections = kinds.filter(
    (item) =>
      item.tag === "list" || item.tag === "set" || item.tag === "dict" || item.tag === "object",
  );
  const item =
    explainingItem(
      kinds.filter((candidate) => collections.includes(candidate) || candidate.tag === "unknown"),
    ) ?? makeItem("list");
  const target = keyLabel(walk, value);
  const against = [...new Set(collections.map((found) => found.tag))];
  const rule: DiagnosticRule = {
    rule: "selection",
    collection: walk.pass.program.textAt(ownSpan(walk, value, site)),
    member: what,
  };
  warning(
    walk,
    "member-read",
    site,
    item,
    obligation(
      "empty-check",
      site,
      target,
      (against.length > 0 ? against : ["list" as const]).map((tag) => requiredKind(tag)),
      `check that ${target} is not empty before ${what}`,
    ),
    rule,
    [],
  );
}
