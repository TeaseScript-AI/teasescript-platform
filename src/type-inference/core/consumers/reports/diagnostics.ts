import type { Expression } from "../../../../ast.js";
import { expressionParts } from "../../../../expression-children.js";
import type { SourceSite } from "../../../graph.js";
import type { Consumers } from "../../consumers.js";
import { REASON, type ItemTag } from "../../items.js";
import { codeOf } from "../../messages.js";
import { selectsElement } from "../../method-categories.js";
import { siteKey } from "../../program.js";
import type { CoreDiagnostic, DiagnosticKind, DiagnosticRule, Presence } from "../../result.js";
import { expected } from "./expected.js";
import { anyRecorded, keptTypes } from "../kinds.js";

// The consumers' diagnostics: an error at its site, and the facts a fix's code forms read.

/**
 * The expression kinds whose presence the core proves (`present`): each reads nothing that may be absent itself, and
 * `expressionParts` gives every operand it evaluates; a property's read is proved by its own facts. An index or a key
 * read, a call, and every kind not listed are unproved, so a fix there gives words
 * (docs/specifications/type-inference-accepted-record/contract.md#r4-162).
 */
const PRESENT_KINDS: ReadonlySet<Expression["kind"]> = new Set<Expression["kind"]>([
  "booleanLiteral",
  "nullLiteral",
  "numberLiteral",
  "durationLiteral",
  "regexLiteral",
  "stringLiteral",
  "identifier",
  "parenthesizedExpression",
  "listLiteral",
  "setLiteral",
  "objectLiteral",
  "dictLiteral",
  "propertyAccessExpression",
  "unaryExpression",
  "unitExpression",
  "angleExpression",
  "binaryExpression",
  "rangeExpression",
  "typeTestExpression",
  "interactionExpression",
  "sayExpression",
  "showButtonExpression",
]);

export function siteOf(site: SourceSite): SourceSite {
  return { file: site.file, start: site.start, end: site.end };
}

/**
 * An error of `rule` at `site`, the offending value's kinds `kinds` (D1, D3: its sentence and code); a member's read or
 * call and an operation, whose fixes write code in place of the value at `site`, with what that value's place takes.
 */
export function error(
  walk: Consumers,
  kind: DiagnosticKind,
  site: SourceSite,
  rule: DiagnosticRule,
  kinds: readonly ItemTag[],
): void {
  // (in the finishing path only what is settled errs: a literal's own kind, a settled read)
  const diagnostic: CoreDiagnostic = {
    class: "compile-error",
    kind,
    code: codeOf(rule),
    site: siteOf(site),
    rule,
    kinds: [...new Set(kinds)],
  };
  walk.diagnostics.push(diagnostic);
  walk.rules.set(diagnostic, walk.rule);
}

/**
 * A published diagnostic with the facts its fix's code forms read: what the place its value
 * lands in takes (`expects`: a member's read or call and an operation's error, a null value's warning) and whether the
 * values it names are there (`present`). Asked once the analysis ran to its end, its work counted apart from the
 * allowance (`WorkLedger.apart`), so the walk's charges and its stops are the analysis's own; after a stop no fact is
 * asked, which reads as unproved and gives words.
 */
export function withFacts(walk: Consumers, diagnostic: CoreDiagnostic): CoreDiagnostic {
  if (diagnostic.class === "compile-error" && diagnostic.kind !== "written-type") {
    const { rule, site } = diagnostic;
    // (the route rule's error reads the facts of the warning it stands in for, whose fix it gives)
    const required = diagnostic.requiredCheck !== undefined;
    const expects =
      (rule.rule === "member" && rule.use !== "store") ||
      rule.rule === "operator" ||
      (required && diagnostic.kinds.includes("null"))
        ? expected(walk, site)
        : undefined;
    const keeps = required ? keptChoice(walk, site, rule) : [];
    return {
      ...diagnostic,
      ...(expects === undefined ? {} : { expects }),
      present: present(walk, site, rule),
      ...(keeps === null ? { keeps: "unproved" as const } : keeps.length === 0 ? {} : { keeps }),
    };
  }
  if (diagnostic.class === "warning-runtime-check" && diagnostic.kind !== "budget") {
    const { rule, site } = diagnostic;
    // (a null value's fallback stands where its rule takes the value: whether it divides there; an operation's join
    // or date and time form, what its place takes)
    const expects =
      diagnostic.kinds.includes("null") || rule.rule === "operator"
        ? expected(walk, site)
        : undefined;
    const keeps = keptChoice(walk, site, rule);
    return {
      ...diagnostic,
      ...(expects === undefined ? {} : { expects }),
      present: present(walk, site, rule),
      // (a plain kept `let` proved adds nothing to the record: main's records stand)
      ...(keeps === null ? { keeps: "unproved" as const } : keeps.length === 0 ? {} : { keeps }),
    };
  }
  return diagnostic;
}

/**
 * What a new variable keeping a warning's subject declares (`keeps`, `keptTypes`): its subject, a member's receiver, a
 * selection's collection or the value at `site`; `null` where the subject's value is not found while a mixed answer
 * reaches some value of the pass, which proves no plain
 * `let` and gives the kept-value fix in words (#1352).
 */
function keptChoice(
  walk: Consumers,
  site: SourceSite,
  rule: DiagnosticRule,
): readonly ItemTag[] | null {
  const { program } = walk.pass;
  const expression = program.exprAt(site)?.expression;
  const receiver = rule.rule === "member" || rule.rule === "selection";
  // (a value not found: words, never a plain `let`, where the stage recorded an answer (a mixed or a stopped one may
  // reach it); where it recorded none, every choice's read settled as one type or there is none, so the plain `let` is
  // proved, the lead's ruling on Codex r12 on #1660)
  const unfound = (): readonly ItemTag[] | null => (anyRecorded(walk) ? null : []);
  // (a site with no expression of its own, a default's or a `get` call's: its value where the core places one; a
  // receiver there the `get`'s own, by its place, never by text, Codex r12 on #1660; else unfound)
  if (expression === undefined) {
    const place = program.placeBySite.get(siteKey(site));
    const c = place === undefined ? undefined : program.opOf.get(place);
    const value = !receiver ? place : c?.kind === "get" ? c.receiver : undefined;
    return value === undefined ? unfound() : keptTypes(walk, value);
  }
  let subject = !receiver
    ? expression
    : expression.kind === "callExpression" && expression.callee.kind === "propertyAccessExpression"
      ? expression.callee.object
      : expression.kind === "propertyAccessExpression" || expression.kind === "indexExpression"
        ? expression.object
        : expression;
  while (subject.kind === "parenthesizedExpression") subject = subject.expression;
  const span = { file: site.file, start: subject.span.start.offset, end: subject.span.end.offset };
  const place = program.placeBySite.get(siteKey(span));
  return place === undefined ? unfound() : keptTypes(walk, place);
}

/**
 * Whether every value a fix's form reads where the diagnostic at `site` sits is there when the script runs (`Presence`,
 * docs/specifications/type-inference-accepted-record/contract.md#r4-162): its subject's, a member's receiver's, an
 * operation's operands', by a walk of their whole syntax, an ask's, a `say`'s and a button's operands too
 * (`expressionParts`, Codex r12, r13), one part at a time on its own stack, however wide: proved only through the kinds
 * `PRESENT_KINDS` lists, so not where any of them reads an element by its index or a dict's value by its key, calls a
 * function or a method (whose own reads are not followed), is of a kind not listed, or reads a property or a selection
 * the core finds may be absent; and every value it evaluates, at every depth, a subject, a receiver or an operand,
 * proved non-null (Astra r2, r3 on #1296); unproved where a site has no expression.
 */
function present(walk: Consumers, site: SourceSite, rule: DiagnosticRule): Presence {
  const { program } = walk.pass;
  const work: Expression[] = [];
  for (const at of rule.rule === "operator" ? rule.operands : [site]) {
    const expression = program.exprAt(at)?.expression;
    if (expression === undefined) return "unproved";
    // (a member's form reads its receiver, not the member it replaces)
    const subject =
      rule.rule !== "member"
        ? expression
        : expression.kind === "callExpression" &&
            expression.callee.kind === "propertyAccessExpression"
          ? expression.callee.object
          : expression.kind === "propertyAccessExpression" || expression.kind === "indexExpression"
            ? expression.object
            : expression;
    work.push(subject);
  }
  return work.some((subject) => readsAbsent(walk, subject, site)) ? "unproved" : true;
}

/**
 * Whether the value of `expression` (in the file of `site`) may be null: a null, or a value the core does not model,
 * among its items where it stands; also where the core places no value there.
 */
function mayBeNull(walk: Consumers, expression: Expression, site: SourceSite): boolean {
  const { program } = walk.pass;
  let inner = expression;
  while (inner.kind === "parenthesizedExpression") inner = inner.expression;
  const at: SourceSite = {
    file: site.file,
    start: inner.span.start.offset,
    end: inner.span.end.offset,
  };
  const place = program.placeBySite.get(siteKey(at));
  return (
    place === undefined ||
    walk
      .valueItems(place, program.exprAt(at), [])
      .some((item) => item.tag === "null" || item.tag === "unknown")
  );
}

/**
 * Whether `root` may read something absent (`present`), each expression once, its parts before it on an explicit
 * stack.
 */
function readsAbsent(walk: Consumers, root: Expression, site: SourceSite): boolean {
  const { program } = walk.pass;
  const known = walk.absentReads;
  const stack: [Expression, boolean][] = [[root, false]];
  for (let top = stack.pop(); top !== undefined; top = stack.pop()) {
    const [expression, partsDone] = top;
    if (known.has(expression)) continue;
    if (partsDone) {
      known.set(
        expression,
        expressionParts(expression).some((part) => known.get(part) === true),
      );
      continue;
    }
    program.work.charge("checks");
    // (only a kind whose every operand `expressionParts` gives, and which reads nothing absent itself, proves presence;
    // any other kind, a new one too, is unproved:
    // docs/specifications/type-inference-accepted-record/contract.md#r4-162, the lead after Codex r13; and every value
    // the walk evaluates, at every depth, proved non-null, the lead after Astra r2 and r3)
    if (
      !PRESENT_KINDS.has(expression.kind) ||
      mayBeNull(walk, expression, site) ||
      (expression.kind === "propertyAccessExpression" && mayBeAbsent(walk, expression, site))
    ) {
      known.set(expression, true);
      continue;
    }
    stack.push([expression, true]);
    for (const part of expressionParts(expression)) if (!known.has(part)) stack.push([part, false]);
  }
  return known.get(root) === true;
}

/**
 * Whether a property's read may find nothing: a property an object may lack, an element a selection may not have (its
 * receiver's null the walk asks of every value it evaluates).
 */
function mayBeAbsent(
  walk: Consumers,
  access: Extract<Expression, { kind: "propertyAccessExpression" }>,
  site: SourceSite,
): boolean {
  const { program } = walk.pass;
  const at = (expression: Expression): SourceSite => ({
    file: site.file,
    start: expression.span.start.offset,
    end: expression.span.end.offset,
  });
  // (a grouped receiver's value is its inner expression's, which the core places)
  let object = access.object;
  while (object.kind === "parenthesizedExpression") object = object.expression;
  const place = program.placeBySite.get(siteKey(at(access)));
  const owner = program.placeBySite.get(siteKey(at(object)));
  if (place === undefined || owner === undefined) return true;
  const node = program.exprAt(at(access));
  const missing = walk
    .valueItems(place, node, [])
    .some((item) => item.tag === "unknown" && (item.reasons & REASON.missing) !== 0);
  return (
    missing ||
    (selectsElement(access.property.name) &&
      walk.valueItems(owner, node, ["element"]).some((item) => item.tag === "empty"))
  );
}
