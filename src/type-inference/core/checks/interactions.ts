import { VALUE_KIND_NAMES, VALUE_KINDS, type ValueKind } from "../../../value-kinds.js";
import type { ChoiceObjectEvidence, PlaceId } from "../../graph.js";
import { isExternal, isOpaque, requiredKind } from "../admission.js";
import { joinSteps } from "../budget.js";
import type { Consumers } from "../consumers.js";
import { error } from "../consumers/diagnostics.js";
import { domainItems, ownSpan, quietKinds } from "../consumers/names.js";
import { obligation, warning } from "../consumers/warnings.js";
import { SELECTED_TEXT, SELECTED_VALUE } from "../definitions.js";
import { withoutEmpty } from "../exact-path.js";
import type { FlowNode } from "../flow-graph.js";
import { REASON, type Item, type ItemTag } from "../items.js";
import type { ValueConstraint } from "../program.js";
import { offendingKinds, type DiagnosticRule } from "../result.js";

// The checks of interactions (S3 §2, groups K and K′): here what a choice's buttons return (TSV029).

/** V30 §19: the kinds a button returns, a choice value, as the runtime's check of a choice takes them (TSR052). */
const CHOICE_VALUES: readonly ValueKind[] = VALUE_KIND_NAMES.filter(
  (kind) => VALUE_KINDS[kind].choice,
);

/** An option: a choice value, a choice object, or a list or set whose elements give the buttons. */
const OPTIONS: readonly ItemTag[] = [...CHOICE_VALUES, "object", "list", "set"];

/** An element of a list or set option: a choice value or a choice object. */
const ELEMENTS: readonly ItemTag[] = [...CHOICE_VALUES, "object"];

/** A property read that found no such property (a record without the key). */
const isMissing = (item: Item): boolean =>
  item.tag === "unknown" && (item.reasons & REASON.missing) !== 0;

/**
 * TSV029 (V30 §19, TABLE r4.93): what every button of an `askChoice` returns is a choice value: a written choice
 * object's `value`, or its `text` without one; a value option or element itself; a choice object the options hold
 * without writing it, its `value` or its `text` as the answer reads it (`choiceItems`). The C13 rule decides each over
 * its known kinds: every one a choice value, quiet; none and all definite, an error; else a warning whose check is the
 * runtime's own check of the buttons (TSR052) when the choice opens, a value the script cannot know among them (C13, as
 * an argument's), the known misfit alone beside one. A labelled option's buttons return the label. The answer's value
 * side takes only choice values (`choiceItems`), so no record of a button is composed.
 */
export function choiceValues(
  walk: Consumers,
  c: Extract<ValueConstraint, { readonly kind: "operation" }>,
  node: FlowNode,
): void {
  const options = c.evidence?.kind === "choice" ? c.evidence.options : [];
  const { program } = walk.pass;
  // the C13 rule over the value's kinds, a button's value the script cannot know a possible misfit
  const check = (
    value: PlaceId | null,
    need: readonly ItemTag[],
    part: Extract<DiagnosticRule, { rule: "choice" }>["part"],
    rest: readonly string[] = [],
    possible = false,
    member: { readonly member: "value" | "text"; readonly within: boolean } | null = null,
  ): void => {
    if (value === null) return;
    const quiet = quietKinds(walk, value, rest);
    if (quiet !== null && quiet.every((tag) => need.includes(tag))) {
      walk.skip(value);
      return;
    }
    program.work.charge("checks");
    const items = domainItems(walk, value, node, rest);
    // (C13: a value a button returns that the script cannot know warns, as an argument's does; beside a known misfit,
    // the known one alone, one warning a site; an option or an element the runtime checks as it opens the choice)
    const misfits = items.filter((item) =>
      item.tag === "unknown"
        ? part === "value" && (isOpaque(item) || isExternal(item))
        : !need.includes(item.tag),
    );
    const bad = misfits.some((item) => item.tag !== "unknown")
      ? misfits.filter((item) => item.tag !== "unknown")
      : misfits;
    if (bad.length === 0) return;
    const at = ownSpan(walk, value, c.site);
    const rule: DiagnosticRule = { rule: "choice", part, ...(member ?? {}) };
    if (
      !possible &&
      bad.length === items.length &&
      items.every((item) => item.cert === "def" && item.tag !== "unknown")
    ) {
      error(
        walk,
        "operator",
        at,
        rule,
        items.map((item) => item.tag),
      );
      return;
    }
    const text = program.textAt(at);
    for (const { item } of offendingKinds(bad))
      warning(
        walk,
        "operator",
        at,
        item,
        obligation(
          "operand",
          at,
          text,
          need.map(requiredKind),
          `check that ${text} is a choice ${part} when the choice opens`,
        ),
        rule,
        items.filter((found) => need.includes(found.tag)),
      );
  };
  // (a written choice object's button returns its `value`, else its `text`)
  const selected = (object: ChoiceObjectEvidence): void =>
    check(object.value ?? object.text, CHOICE_VALUES, "value");
  // a choice object the options hold without writing it, below `at`, as `choiceItems` reads its buttons: per record
  // alternative its `value`, else its `text`; a key with a store below it by its key, the `text` where some record
  // lacks the `value`, possible where some has one
  const held = (value: PlaceId, at: readonly string[]): void => {
    const stored = walk.pass.contract.choiceKeysStored();
    const within = at.length > 0;
    check(
      value,
      CHOICE_VALUES,
      "value",
      joinSteps(at, [stored.value ? "value" : SELECTED_VALUE]),
      false,
      { member: "value", within },
    );
    if (!stored.text) {
      check(value, CHOICE_VALUES, "value", joinSteps(at, [SELECTED_TEXT]), false, {
        member: "text",
        within,
      });
      return;
    }
    const values = withoutEmpty(walk.valueItems(value, node, joinSteps(at, ["value"])));
    if (values.some(isMissing))
      check(
        value,
        CHOICE_VALUES,
        "value",
        joinSteps(at, ["text"]),
        values.some((item) => !isMissing(item)),
        { member: "text", within },
      );
  };
  c.arguments.forEach((argument, index) => {
    const option = options[index];
    if (option?.label !== undefined && option.label !== null) return;
    const content = option?.content;
    if (content?.kind === "object") {
      selected(content.object);
      return;
    }
    if (content?.kind === "list" || content?.kind === "set") {
      for (const element of content.elements)
        if (element.object !== null) selected(element.object);
        else {
          check(element.place, ELEMENTS, "element");
          if (domainItems(walk, element.place, node, []).some((item) => item.tag === "object"))
            held(element.place, []);
        }
      return;
    }
    // a computed option: a value, a choice object, or a list or set of them (an unknown one owes its option's check,
    // which the runtime makes of its buttons too)
    check(argument, OPTIONS, "option");
    // (its kinds, or what its type admits where they are unknown, `domainItems`)
    const kinds = domainItems(walk, argument, node, []);
    if (kinds.some((item) => item.tag === "object")) held(argument, []);
    if (kinds.some((item) => item.tag === "list" || item.tag === "set")) {
      check(argument, ELEMENTS, "element", ["element"]);
      const elements = domainItems(walk, argument, node, ["element"]);
      if (elements.some((item) => item.tag === "object")) held(argument, ["element"]);
    }
  });
}
