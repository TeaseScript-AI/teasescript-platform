import type { PlaceId, SourceSite } from "../../../graph.js";
import { isExternal, isOpaque, requiredKind } from "../../admission.js";
import type { Consumers } from "../../consumers.js";
import { withoutEmpty } from "../../exact-path.js";
import type { FlowNode } from "../../flow-graph.js";
import type { Item, ItemTag } from "../../items.js";
import {
  type CountUse,
  type DiagnosticKind,
  type DiagnosticRule,
  type ObligationKind,
} from "../../result.js";
import { error } from "../reports/diagnostics.js";
import { TEXT } from "../kinds.js";
import { keyLabel, kindsOf, ownSpan, quietKinds, shownLabel, writtenNumber } from "../names.js";
import { obligation, warnGroups, warning } from "../reports/warnings.js";

// An operand's items against the kinds its use takes (`consume`: conditions and logical operands, shown values, dict
// keys, built-in arguments, a `for`'s iterable), a whole-number use (`integerOnly`, `writtenNumberUse`), an index or a
// key by its receiver (`indexUse`).

const INTEGER: ReadonlySet<ItemTag> = new Set(["integer"]);

/**
 * An operand's items against the kinds that fit: all definite and none fits is an error; an item that does not fit,
 * or an unmodelled unknown, a warning with its obligation; the quiet path first. One obligation per offending kind: a
 * possible null owes its null-check, any other offending item the operand's own obligation. `soft`: never an error
 * (true), or the possible receiver's item whose key obligation is owed whether or not the key fits (`indexUse`).
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
  const label = shownLabel(walk, keyLabel(walk, value));
  const on = (obliged: ObligationKind, text: string): string =>
    obliged === "null-check"
      ? `check that ${text} is not null at ${what}`
      : obliged === "integer-check"
        ? `check that ${text} is a whole number at ${what}`
        : `check the operand ${text} at ${what} when it runs`;
  const required = against.map((tag) => requiredKind(tag));
  const owe = (item: Item, obliged: ObligationKind): boolean => {
    const text = label();
    return warning(
      walk,
      kind,
      at,
      item,
      obligation(
        obliged,
        at,
        obliged === "operand" ? program.textAt(at) : text,
        required,
        on(obliged, text),
      ),
      rule,
      items.filter((item) => need.has(item.tag)),
    );
  };
  const nullItem = bad.find((item) => item.tag === "null");
  if (nullItem !== undefined) owe(nullItem, "null-check");
  // (built-in arguments, keys and iterables: beside a known misfit, an unknown owes no second warning at the site, its
  // check the same one)
  const offending = bad.filter((item) => item.tag !== "null");
  const knownMisfits = offending.filter((item) => item.tag !== "unknown");
  const warned =
    knownMisfits.length > 0 &&
    (rule.rule === "argument" || rule.rule === "key" || rule.rule === "iterable")
      ? knownMisfits
      : offending;
  // the operand's external data brings its boundary checks, a domain's those its group's warning owns (a soft owner's
  // one warning, every offending item's)
  walk.boundariesAt(
    items,
    () => {
      const text = label();
      return obligation(obligationKind, at, text, required, on(obligationKind, text));
    },
    warnGroups(
      walk,
      owedBy === null ? warned : offending,
      (item) => owe(item, obligationKind),
      owedBy,
    ),
  );
}

/**
 * #1173, every whole-number use's one rule: a read of a place written `number` is no whole number by its type,
 * whatever value it holds now, an error under `rule`; a read under a test of its key is left to its items, which that
 * test narrows (`if p is integer`); a read of a written union whose value is known to be only its other members
 * (`number?` holding `null`) is the error its items give, naming that value and its fix, from the items asked here
 * once. Whether it erred.
 */
export function writtenNumberUse(
  walk: Consumers,
  value: PlaceId,
  node: FlowNode,
  site: SourceSite,
  kind: DiagnosticKind,
  rule: DiagnosticRule,
): boolean {
  const term = writtenNumber(walk, value);
  if (term === null || walk.pass.guards.guardedRead(value)) return false;
  walk.pass.program.work.charge("checks");
  let kinds: readonly ItemTag[] = ["number"];
  if (term.kind === "union") {
    const items = withoutEmpty(walk.valueItems(value, node, []));
    if (
      items.length > 0 &&
      items.every(
        (item) =>
          item.cert === "def" &&
          item.tag !== "unknown" &&
          item.tag !== "integer" &&
          item.tag !== "number",
      )
    )
      kinds = items.map((item) => item.tag);
  }
  error(walk, kind, ownSpan(walk, value, site), rule, kinds);
  return true;
}

/**
 * A whole-number use (a count, a position, an index): its value must be an integer; a null here is never silent
 * (`soft` as for `consume`).
 */
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
  if (soft === false && writtenNumberUse(walk, value, node, site, "integer-use", rule)) return;
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
  const at = ownSpan(walk, value, site);
  const target = shownLabel(walk, keyLabel(walk, value));
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
  const owe = (item: Item, obliged: ObligationKind, on: string): boolean =>
    warning(
      walk,
      "integer-use",
      at,
      item,
      obligation(
        obliged,
        at,
        target(),
        ["integer"],
        `check that the ${what} is ${on} when it runs`,
      ),
      rule,
      items.filter((item) => item.tag === "integer"),
    );
  const nullItem = offending.find((item) => item.tag === "null");
  if (nullItem !== undefined) owe(nullItem, "null-check", "not null");
  // the count's or index's external data brings its boundary checks, a domain's those its group's warning owns (a soft
  // owner's one warning, every offending item's)
  walk.boundariesAt(
    items,
    () =>
      obligation(
        "integer-check",
        at,
        target(),
        ["integer"],
        `check that the ${what} is a whole number when it runs`,
      ),
    warnGroups(
      walk,
      offending.filter((found) => found.tag !== "null"),
      (item) => owe(item, "integer-check", "a whole number"),
      owedBy,
    ),
  );
}

/**
 * An index or a key by the receiver's kind: a list's index is a whole number, a dict's key text, and a receiver of any
 * other kind owes neither, its own member check reporting it (an object is not indexed, V30 §15); a receiver whose
 * kinds hold `unknown`, or a dict beside another kind, dispatches to neither as an error: a `get`'s key owes each
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
