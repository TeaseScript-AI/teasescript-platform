import type { PlaceId, SourceSite } from "../../graph.js";
import { isExternal, isOpaque, requiredKind } from "../admission.js";
import type { Consumers } from "../consumers.js";
import { withoutEmpty } from "../exact-path.js";
import type { FlowNode } from "../flow-graph.js";
import type { Item, ItemTag } from "../items.js";
import {
  offendingKinds,
  type CountUse,
  type DiagnosticKind,
  type DiagnosticRule,
  type ObligationKind,
} from "../result.js";
import { error } from "./diagnostics.js";
import { TEXT } from "./kinds.js";
import { keyLabel, kindsOf, ownSpan, quietKinds } from "./names.js";
import { obligation, warning } from "./warnings.js";

// C2, C3, C11, C12, C13: an operand's items against the kinds that fit, a whole number, an index by its receiver.

const INTEGER: ReadonlySet<ItemTag> = new Set(["integer"]);

/**
 * C2, C3, C11, C12, C13: an operand's items against the kinds that fit: all definite and none fits is an error; an
 * item that does not fit, or an unmodelled unknown, a warning with its obligation; the quiet path first. §4 (r4.6):
 * one obligation per offending kind: a possible null owes its null-check, any other offending item the operand's own
 * obligation. `soft`: never an error (true), or the possible receiver's item whose key obligation is owed whether or
 * not the key fits (C2 r4.33).
 */
export function consume(
  walk: Consumers,
  value: PlaceId | undefined,
  node: FlowNode,
  site: SourceSite,
  need: ReadonlySet<ItemTag>,
  what: string,
  rule: DiagnosticRule,
  against: readonly ItemTag[],
  kind: DiagnosticKind = "operator",
  obligationKind: ObligationKind = "operand",
  rest: readonly string[] = [],
  soft: Item | boolean = false,
): void {
  if (value === undefined) return;
  const { program } = walk.pass;
  const owedBy = typeof soft === "object" ? soft : null;
  const quiet = quietKinds(walk, value, rest);
  if (owedBy === null && quiet !== null && quiet.every((tag) => need.has(tag))) {
    walk.skip(value);
    return;
  }
  program.work.charge("checks");
  const items = withoutEmpty(walk.valueItems(value, node, rest));
  const bad = items.filter((item) =>
    item.tag === "unknown" ? isOpaque(item) || isExternal(item) : !need.has(item.tag),
  );
  // §4: an unknown warns
  if (bad.length === 0 && owedBy === null) return;
  const at = ownSpan(walk, value, site);
  if (
    soft === false &&
    bad.length === items.length &&
    items.every((item) => item.cert === "def" && item.tag !== "unknown")
  ) {
    error(
      walk,
      kind,
      at,
      rule,
      items.map((item) => item.tag),
    );
    return;
  }
  const label = keyLabel(walk, value);
  const on = (obliged: ObligationKind): string =>
    obliged === "null-check"
      ? `check that ${label} is not null at ${what}`
      : obliged === "integer-check"
        ? `check that ${label} is a whole number at ${what}`
        : `check the operand ${label} at ${what} when it runs`;
  const required = against.map((tag) => requiredKind(tag));
  const owe = (item: Item, obliged: ObligationKind): boolean =>
    warning(
      walk,
      kind,
      at,
      item,
      obligation(
        obliged,
        at,
        obliged === "operand" ? program.textAt(at) : label,
        required,
        on(obliged),
      ),
      rule,
      items.filter((item) => need.has(item.tag)),
    );
  const nullItem = bad.find((item) => item.tag === "null");
  if (nullItem !== undefined) owe(nullItem, "null-check");
  if (owedBy !== null) owe(owedBy, obligationKind);
  else
    for (const { item } of offendingKinds(bad.filter((item) => item.tag !== "null")))
      owe(item, obligationKind);
  // C9: the operand's external data brings its boundary checks
  walk.admission.boundariesAt(
    items,
    obligation(obligationKind, at, label, required, on(obligationKind)),
  );
}

/** C2: a whole number; a null here is never silent (`soft` as for `consume`). */
export function integerOnly(
  walk: Consumers,
  value: PlaceId,
  node: FlowNode,
  site: SourceSite,
  what: string,
  use: CountUse,
  soft: Item | boolean = false,
): void {
  const { program } = walk.pass;
  const rule: DiagnosticRule = { rule: "count", use };
  const owedBy = typeof soft === "object" ? soft : null;
  // §3.3: a whole number on every run
  if (owedBy === null) {
    const quiet = quietKinds(walk, value);
    if (quiet !== null && quiet.every((tag) => INTEGER.has(tag))) {
      walk.skip(value);
      return;
    }
  }
  program.work.charge("checks");
  const items = withoutEmpty(walk.valueItems(value, node, []));
  // a number, a null, text, a truth value...
  const offending = items.filter((item) =>
    item.tag === "unknown" ? isOpaque(item) || isExternal(item) : item.tag !== "integer",
  );
  if (offending.length === 0 && owedBy === null) return;
  // the count or index expression's node, inside its parentheses (§3.4 r4.10)
  const at = ownSpan(walk, value, site);
  const target = keyLabel(walk, value);
  if (
    soft === false &&
    offending.length === items.length &&
    items.every((item) => item.cert === "def" && item.tag !== "unknown")
  ) {
    error(
      walk,
      "integer-use",
      at,
      rule,
      items.map((item) => item.tag),
    );
    return;
  }
  // S4, §4: the null owes its null-check, every other offending kind its integer check
  const owe = (item: Item, obliged: ObligationKind, on: string): boolean =>
    warning(
      walk,
      "integer-use",
      at,
      item,
      obligation(obliged, at, target, ["integer"], `check that the ${what} is ${on} when it runs`),
      rule,
      items.filter((item) => item.tag === "integer"),
    );
  const nullItem = offending.find((item) => item.tag === "null");
  if (nullItem !== undefined) owe(nullItem, "null-check", "not null");
  if (owedBy !== null) owe(owedBy, "integer-check", "a whole number");
  else
    for (const { item } of offendingKinds(offending.filter((found) => found.tag !== "null")))
      owe(item, "integer-check", "a whole number");
  // C9: the count's or index's external data brings its boundary checks
  walk.admission.boundariesAt(
    items,
    obligation(
      "integer-check",
      at,
      target,
      ["integer"],
      `check that the ${what} is a whole number when it runs`,
    ),
  );
}

/**
 * C2 and C12 by the receiver's kind: a list's index is a whole number, a dict's key text, and a receiver of any other
 * kind owes neither, its own check reporting it (C5b: an object is not indexed, V30 §15); a receiver whose kinds hold
 * `unknown`, or a dict beside another kind, dispatches to neither as an error (C2 r4.33): a `get`'s key owes each
 * possible receiver's obligation as a warning whether or not the key fits it; an index expression keeps the
 * receiver's dispatch, its misfits warnings.
 */
export function indexUse(
  walk: Consumers,
  receiver: PlaceId,
  index: PlaceId,
  node: FlowNode,
  site: SourceSite,
  what: string,
  get = false,
): void {
  const kinds = kindsOf(walk, receiver, node);
  const unknown = kinds.find((item) => item.tag === "unknown");
  const dict = kinds.find((item) => item.tag === "dict");
  const list = kinds.find((item) => item.tag === "list") ?? unknown;
  // (a null receiver is the member read's)
  const other = kinds.find((item) => item.tag !== "dict" && item.tag !== "null");
  const soft = unknown !== undefined || (dict !== undefined && other !== undefined);
  if (dict !== undefined || (get && unknown !== undefined)) {
    const owed: Item | boolean = soft ? (get ? (unknown ?? dict ?? true) : true) : false;
    consume(
      walk,
      index,
      node,
      site,
      TEXT,
      `a dict key at ${what}`,
      { rule: "key" },
      ["string"],
      "operator",
      "operand",
      [],
      owed,
    );
  }
  if (list !== undefined)
    integerOnly(
      walk,
      index,
      node,
      site,
      what,
      get ? "get" : "index",
      soft ? (get ? (unknown ?? list) : true) : false,
    );
}
