import assert from "node:assert/strict";
import test from "node:test";
import { compileProject } from "../src/compiler.js";
import { createFreshRuntimeSession } from "../src/index.js";
import { compareProjectPaths } from "../src/project-paths.js";
import { analyseCore } from "../src/type-inference/core/answers.js";
import { reportedDiagnostics } from "../src/type-inference/core/consumer.js";
import {
  coreMessage,
  messageSource,
  type MessageSource,
} from "../src/type-inference/core/messages.js";
import type { CoreDiagnostic } from "../src/type-inference/core/result.js";
import { VALUE_KINDS } from "../src/value-kinds.js";
import { coreRequest } from "./helpers/type-core-analysis.js";
import { readFixture } from "./helpers/type-core-fixture.js";

/*
 * The new checker keeps every fix the current checker gives (#1195): on every record of the expectation set, the two
 * checkers' TSV diagnostics pair by file, line and code, and each fix sentence of the current checker's message is in
 * the new checker's, in the new form (`PORTS`), or the pair is one of the intended differences (`INTENDED`); and the
 * code the fixes suggest compiles where it stands. Severity is not compared: where the current checker errs and the
 * new one warns for a possible null or a union value, the narrowing step (#1073) brings the error. When the current
 * checker is removed (#1076), this compares with its messages captured before.
 */

/** What the new checker's diagnostic names: its subject as the source writes it, a member, an operation's operands. */
interface Named {
  readonly subject: string;
  /** A member as its code writes it: `.length`, `.get(...)`; empty for any other rule. */
  readonly member: string;
  readonly operands: readonly string[];
}

/** A fix sentence of the current checker, and the sentence the new checker writes for it (#1195 rule 1). */
interface Port {
  readonly from: RegExp;
  /** The new form: the current checker's code, with the subject and the operands the new checker names. */
  readonly to: (found: RegExpExecArray, named: Named) => RegExp;
}

const escaped = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A sentence as written. */
const exact = (text: string): RegExp => new RegExp(escaped(text));

/** Code as a fix may write it: as it stands, or in parentheses. */
const grouped = (code: string): string => `(?:${escaped(code)}|\\(${escaped(code)}\\))`;

/** A sentence with `parts`, each code as written (a text) or a pattern (a regex). */
const form = (...parts: readonly (string | RegExp)[]): RegExp =>
  new RegExp(
    parts.map((part) => (typeof part === "string" ? escaped(part) : part.source)).join(""),
  );

const code = (pattern: string): RegExp => new RegExp(pattern);

/**
 * Whether a subject is a variable or a property path as written, the only subject a fix's example names (Astra r1); and
 * whether its own text may stand in code: on one line, without a comment.
 */
const path = (text: string): boolean => /^[A-Za-z_]\w*(\.[A-Za-z_]\w*)*$/.test(text);
const ownText = (text: string): boolean => !/[\n\r]|\/\/|\/\*/.test(text);
/** A literal beside a named value in a date and time example: a number or a quantity, `true` or `false`. */
const quantity = (text: string): boolean => /^(\d[\w. ]*|true|false)$/.test(text);

const PORTS: readonly Port[] = [
  // ADR 0021 rules 1.9 and 3.5: the check, of a variable, or of the subject kept in a variable first, its `let` shown
  // where its own text may stand in code (the owner's review)
  {
    from: /^Check it first: if (\S+) != null \{ \.\.\. \}, or give a fallback: \1 otherwise (.+)$/,
    to: ([, name, value]) =>
      form(
        `Check '${name}' first, as in 'if ${name} != null { ... }', or give a fallback, as in '`,
        code(grouped(`${name} otherwise ${value}`)),
        "'.",
      ),
  },
  {
    from: /^Check it first: if (\S+) (!= null|is .+) \{ \.\.\. \}$/,
    to: ([, name, test]) => exact(`Check '${name}' first, as in 'if ${name} ${test} { ... }'.`),
  },
  {
    from: /^Keep it in a variable and check it first, as in: if value != null \{ \.\.\. \}, or give a fallback: value otherwise (.+)$/,
    to: ([, value], { subject }) =>
      ownText(subject)
        ? form(
            `Keep '${subject}' in a variable, as in 'let value = ${subject}', and check it, as in 'if value != null ` +
              "{ ... }', or give a fallback, as in '",
            code(`\\(?${grouped(subject)} otherwise ${escaped(value!)}\\)?`),
            "'.",
          )
        : exact(
            `Keep '${subject}' in a variable and check the variable first, as in 'if value != null { ... }'.`,
          ),
  },
  {
    from: /^Keep it in a variable and check it first, as in: if value (!= null|is .+) \{ \.\.\. \}$/,
    to: ([, test], { subject }) =>
      exact(
        ownText(subject)
          ? `Keep '${subject}' in a variable, as in 'let value = ${subject}', and check it, as in 'if value ${test} ` +
              "{ ... }'."
          : `Keep '${subject}' in a variable and check the variable first, as in 'if value ${test} { ... }'.`,
      ),
  },
  // #1195's decided texts
  {
    from: /^Compare it instead, such as '(.+)'\.$/,
    to: ([, fix]) => exact(`Compare it instead, as in '${fix}'.`),
  },
  {
    from: /^Check its length instead, such as '(.+)'\.$/,
    to: ([, fix]) => exact(`Check its length instead, as in '${fix}'.`),
  },
  {
    from: /^Show one of its properties instead\.$/,
    to: (_, { subject }) =>
      path(subject)
        ? form(
            "Show one of its properties instead, as in '${",
            subject,
            code("\\.[A-Za-z_]\\w*"),
            "}'.",
          )
        : exact("Show one of its properties instead."),
  },
  {
    from: /^Show its elements with 'toList\(\)\.join\(\)' instead\.$/,
    to: (_, { subject }) =>
      exact(
        path(subject)
          ? `Show all its elements with '\${${subject}.toList().join()}'.`
          : "Show its elements with 'toList().join()' instead.",
      ),
  },
  // (the operand that is not text, as the source writes it, never the chain rebuilt: the owner's review)
  {
    from: /^Put the value in the text instead, as in "(.+)"\.$/,
    to: (_, { operands }) =>
      operands.some(ownText)
        ? form(
            "Put the value in the text as '${",
            code(`(?:${operands.filter(ownText).map(escaped).join("|")})`),
            "}' instead.",
          )
        : exact("Put the value in the text instead."),
  },
  // the current checker's fixes, code in single quotes, the value named where it is a variable or a path
  {
    from: /^Select one value with '(.+)', or show every value with '(.+)'\.$/,
    to: ([text], { subject }) =>
      exact(
        path(subject)
          ? text
          : "Select one value with a key, or show every value with 'values.join()'.",
      ),
  },
  {
    from: /^To allow (both|null), declare (it|the parameter) as '(.+)'\.$/,
    // (a default's or fallback's place named, ADR 0021 rule 7.3)
    to: ([, allow, it, fix]) =>
      form(code(`[Tt]o allow ${allow}, declare (?:${it}|'[^']*') as '`), fix!, "'."),
  },
  {
    from: /^To keep both, declare a union type, as in '(.+)'\.$/,
    // (TSV044: on the literal's variable, else the type alone, the owner's review)
    to: ([, fix]) =>
      exact(
        fix!.startsWith("let values: ")
          ? `To allow both, declare it as '${fix!.slice("let values: ".length, -" = ...".length)}'.`
          : `To allow both, declare it as '${fix}'.`,
      ),
  },
  {
    from: /^To allow both, give '(.+)' a first value of type (.+), such as a variable declared with that type\.$/,
    to: ([, place, type]) =>
      exact(
        `To allow both, give '${place}' a first value of type '${type}', such as a variable declared with that type.`,
      ),
  },
  {
    from: /^To show it as text, write "(.+)"\.$/,
    to: (_, { subject }) =>
      exact(
        path(subject)
          ? `To show it as text, write '"\${${subject}}"'.`
          : "To show it as text, put it in a text with '${...}'.",
      ),
  },
  { from: /^Use a separate property for a value of another type\.$/, to: ([text]) => exact(text) },
  { from: /^Its (only property is|properties are) (.+)\.$/, to: ([text]) => exact(text) },
  { from: /^Did you mean '(.+)'\?$/, to: ([text]) => exact(text) },
  {
    from: /^Write a number key as text, as in "(.+)"\.$/,
    to: (_, { subject }) =>
      exact(
        path(subject)
          ? `Write a number key as text, as in '"\${${subject}}"'.`
          : "Write a number key as text.",
      ),
  },
  {
    from: /^Check '(.+)\.length' first\.$/,
    to: ([text, collection]) =>
      exact(
        ownText(collection!)
          ? `Check '${collection}.length' first, as in 'if ${collection}.length > 0 { ... }'.`
          : text,
      ),
  },
  { from: /^Give '(.+)' one type in every element\.$/, to: ([text]) => exact(text) },
  // members of a type without them
  {
    from: /^Convert it to text first with toString\(\.\.\.\)\.$/,
    to: (_, { subject, member }) =>
      exact(
        path(subject)
          ? `Convert '${subject}' to text first, as in 'toString(${subject})${member}'.`
          : `Convert '${subject}' to text first with 'toString(...)'.`,
      ),
  },
  {
    from: /^Divide it by a unit, as in '.+ \/ 1 (\w+)'\.$/,
    to: ([, unit], { subject }) =>
      exact(
        path(subject)
          ? `Divide '${subject}' by a unit, as in '${subject} / 1 ${unit}'.`
          : `Divide '${subject}' by a unit, such as '1 ${unit}'.`,
      ),
  },
  { from: /^Use 'contains\(\.\.\.\)' instead\.$/, to: ([text]) => exact(text) },
  {
    from: /^Use length, first, last, or random\.$/,
    to: () => exact("Use 'length', 'first', 'last', or 'random'."),
  },
  {
    from: /^Assign a new text to the variable instead\.$/,
    to: (_, { subject }) => exact(`Assign a new text to '${subject}' instead.`),
  },
  // a speaker's property: the receiver as the source writes it (S9b's speaker flow names the speaker, below)
  {
    from: /^Assign it before this line, as in '(.+)'\.$/,
    to: ([, fix]) => exact(`Assign the property before this line, as in '${fix}'.`),
  },
  {
    from: /^Copy the player profile before this line, as in '(.+)' at the start of the script, or assign '(.+)' first\.$/,
    to: ([text]) => exact(text),
  },
  {
    from: /^Use one of its properties instead, such as '(.+)'\.$/,
    to: (_, { subject }) =>
      exact(
        `Use one of its properties instead, such as '${path(subject) ? `${subject}.` : ""}title'.`,
      ),
  },
  // date and time operators and fields: an example where the value it converts is a variable or a path, the other
  // operand one or a quantity, else the sentence alone
  {
    from: /^Convert it first, as in '(.+)', or use calendar units to keep the clock time\.$/,
    to: (_, { operands: [left = "", right = ""] }) =>
      path(left) && (path(right) || quantity(right))
        ? form(
            `Convert it first, as in '(${left}.toAbsoluteDateTime() `,
            code("[-+]"),
            ` ${right}).toDateTime()', or use calendar units to keep the clock time.`,
          )
        : exact(
            "Convert it with 'toAbsoluteDateTime()' first, or use calendar units to keep the clock time.",
          ),
  },
  {
    from: /^Convert it first, as in '\(.+\)\.toAbsoluteDateTime\(\)'\.$/,
    to: (_, { operands: [left = "", right = ""] }) =>
      path(left) && (path(right) || quantity(right))
        ? form(
            `Convert it first, as in '(${left}.toDateTime() `,
            code("[-+]"),
            ` ${right}).toAbsoluteDateTime()'.`,
          )
        : exact("Convert it with 'toDateTime()' first."),
  },
  {
    from: /^Convert it first, as in '.+\.toDateTime\(\)\.(\w+)'\.$/,
    to: ([, field], { subject }) =>
      exact(
        path(subject)
          ? `Convert '${subject}' first, as in '${subject}.toDateTime().${field}'.`
          : `Convert '${subject}' with 'toDateTime()' first.`,
      ),
  },
  { from: /^Write '(.+)'\.$/, to: ([text]) => exact(text) },
  {
    from: /^(Compare|Divide) two calendar durations, or two durations\.$/,
    to: ([text]) => exact(text),
  },
  {
    from: /^Compare its date, as in 'toDate\((.+)\)'\.$/,
    to: (_, { operands: [, right = ""] }) =>
      exact(
        path(right)
          ? `Compare its date, as in 'toDate(${right})'.`
          : "Compare its date, with 'toDate(...)'.",
      ),
  },
  {
    from: /^Combine it with a date first, as in '(.+)'\.$/,
    to: () => exact("Combine it with a date first, with 'toDateTime(...)'."),
  },
  {
    from: /^Subtract their dates with '(.+)', or convert both with toAbsoluteDateTime\(\) for the elapsed time\.$/,
    to: (_, { operands: [left = "", right = ""] }) =>
      exact(
        `Subtract their dates with ${path(left) && path(right) ? `'toDate(${left}) - toDate(${right})'` : "'toDate(...)'"}, ` +
          "or convert both with 'toAbsoluteDateTime()' for the elapsed time.",
      ),
  },
  // ADR 0021 rule 2.2's rounding, as the count's sentence words it (S8c's, #1173)
  {
    from: /^Round it with floor\(\.\.\.\), round\(\.\.\.\), or ceil\(\.\.\.\) first\.$/,
    to: ([text]) => exact(text),
  },
];

/** The review's test for a sentence that names a fix (`message-review-2026-10-27/compare.mjs`): every one is ported. */
const FIX =
  /^(Round|Use|Put|Compare|Check|Declare|Write|Add|Select|Its |Remove|Call|Store|Give|Copy|Index|To |Convert|Move|Pass|Show|Turn|Test|Assign|Make|Keep|Start|Set|Load|Save|Wrap|Split|Read|Divide|Combine|Subtract|Did you mean)|\bas in\b|\bsuch as\b|\bdeclare it\b/;

const sentences = (text: string): string[] => text.split(/(?<=[.?])\s+(?=[A-Z'"])/);

/** A message's fix sentences: each after its first sentence that names a fix, as the review found them. */
function fixes(message: string): string[] {
  return sentences(message)
    .slice(1)
    .filter((sentence) => FIX.test(sentence) && !sentence.startsWith("If it"));
}

/** What a diagnostic names, in the source's own text. */
function namedBy(diagnostic: CoreDiagnostic, source: MessageSource): Named {
  if (diagnostic.kind === "written-type")
    return { subject: source.text(diagnostic.site), member: "", operands: [] };
  const { rule } = diagnostic;
  return {
    subject:
      rule.rule === "member"
        ? rule.receiver
        : rule.rule === "selection"
          ? rule.collection
          : source.text(diagnostic.site),
    member:
      rule.rule !== "member"
        ? ""
        : rule.member.endsWith("()")
          ? `${rule.member.slice(0, -2)}(...)`
          : rule.member,
    operands: rule.rule === "operator" ? rule.operands.map((site) => source.text(site)) : [],
  };
}

interface Pair {
  readonly record: string;
  readonly current: string;
  readonly diagnostic: CoreDiagnostic;
  readonly message: string;
  readonly named: Named;
  /** The current checker's fixes and their new forms; `null` where no port takes the fix. */
  readonly forms: readonly { readonly fix: string; readonly form: RegExp | null }[];
}

const kept = (pair: Pair): boolean =>
  pair.forms.every(({ form }) => form !== null && form.test(pair.message));

/**
 * How well a new diagnostic answers a current one on its line and code: whether the current message names its subject,
 * and whether it names every kind of its value.
 */
function correspondence(message: string, diagnostic: CoreDiagnostic, named: Named): number {
  const subject =
    message.includes(`'${named.subject}'`) ||
    message.includes(`if ${named.subject} `) ||
    message.includes(`${named.subject} otherwise`);
  const kinds =
    diagnostic.kind !== "written-type" &&
    diagnostic.kinds.length > 0 &&
    diagnostic.kinds.every(
      (kind) =>
        kind !== "unknown" &&
        kind !== "empty" &&
        [VALUE_KINDS[kind].description, VALUE_KINDS[kind].plural].some((words) =>
          message.toLowerCase().includes(words.toLowerCase()),
        ),
    );
  // (a null the current message never names answers another of its diagnostics)
  const unnamedNull =
    diagnostic.kind !== "written-type" &&
    diagnostic.kinds.includes("null") &&
    !/\bnull\b/.test(message);
  return (subject ? 2 : 0) + (kinds ? 1 : 0) - (unnamedNull ? 1 : 0);
}

function pairs(): Pair[] {
  const found: Pair[] = [];
  for (const record of readFixture()) {
    const files = [...record.files].sort((a, b) => compareProjectPaths(a.path, b.path));
    const request = coreRequest(files);
    if (request === null) continue;
    const source = messageSource(files.map((file) => file.source));
    const core = new Map<string, { diagnostic: CoreDiagnostic; message: string; named: Named }[]>();
    for (const diagnostic of reportedDiagnostics(analyseCore(request))) {
      const key = `${files[diagnostic.site.file]!.path}:${source.line(diagnostic.site)}:${diagnostic.code}`;
      const list = core.get(key) ?? [];
      list.push({
        diagnostic,
        message: coreMessage(diagnostic, source),
        named: namedBy(diagnostic, source),
      });
      core.set(key, list);
    }
    if (core.size === 0) continue;
    for (const current of compileProject(files).diagnostics) {
      if (!current.code.startsWith("TSV")) continue;
      const candidates = core.get(`${current.path}:${current.span.start.line + 1}:${current.code}`);
      if (candidates === undefined) continue;
      // (several diagnostics on one line and code: the one the current message names best, else the last, as the
      // review paired)
      let best = candidates.at(-1)!;
      let score = correspondence(current.message, best.diagnostic, best.named);
      for (const candidate of candidates) {
        const found = correspondence(current.message, candidate.diagnostic, candidate.named);
        if (found > score) [best, score] = [candidate, found];
      }
      const forms = fixes(current.message).map((fix) => {
        for (const port of PORTS) {
          const match = port.from.exec(fix);
          if (match !== null) return { fix, form: port.to(match, best.named) };
        }
        return { fix, form: null };
      });
      found.push({ record: record.name, current: current.message, ...best, forms });
    }
  }
  return found;
}

/** The pairs, made once for the tests below. */
let made: Pair[] | null = null;
const allPairs = (): Pair[] => (made ??= pairs());

const ROUND = "Round it with floor(...), round(...), or ceil(...) first.";

/**
 * The type test of a subject (ADR 0021 rule 3.5): of a variable directly, of any other value kept in one first, its
 * `let` shown where its own text may stand in code.
 */
const typeTest = (subject: string, type: string): RegExp =>
  exact(
    /^[A-Za-z_]\w*$/.test(subject)
      ? `Check '${subject}' first, as in 'if ${subject} is ${type} { ... }'.`
      : ownText(subject)
        ? `Keep '${subject}' in a variable, as in 'let value = ${subject}', and check it, as in 'if value is ${type} { ... }'.`
        : `Keep '${subject}' in a variable and check the variable first, as in 'if value is ${type} { ... }'.`,
  );

/**
 * Pairs whose fixes differ on purpose: the rule that makes them differ, which pairs, the exact fix the new checker gives
 * instead (compared, so a wrong replacement fails), and how many.
 */
interface Intended {
  readonly rule: string;
  readonly matches: (pair: Pair) => boolean;
  readonly replacement: (pair: Pair) => RegExp;
  readonly count: number;
}

/** The type each rule 3.5 pair's test names: the type its use takes, which the value's written union holds. */
const UNION_TESTS: ReadonlyMap<string, string> = new Map([
  ["cp9-cells/r46/obligations/condition/null-and-kind", "boolean"],
  ["cp9-cells/r46/obligations/not/null-and-kind", "boolean"],
  ["cp9-cells/r46/obligations/and/null-and-kind", "boolean"],
  ["cp9-cells/r46/obligations/or/null-and-kind", "boolean"],
  ["cp9-cells/r46/m3/astra-m3/null-kind/condition/null", "boolean"],
  ["cp9-cells/r46/m3/astra-m3/null-kind/not/null", "boolean"],
  ["cp9-cells/r46/m3/astra-m3/null-kind/and/null", "boolean"],
  ["cp9-cells/r46/m3/astra-m3/null-kind/key/null", "string"],
  ["cp9-cells/r46/m3/astra-m3/null-kind/plus/null", "integer"],
  ["cp9-cells/r46/m3/astra-m3/routes/read-null-kind", "string"],
  ["cp9-cells/s4/followup/temporal/year-string-fallback", "string"],
]);

/** The type each rule 1.7 pair's test names: the written whole number its value is stored into. */
const UNKNOWN_TESTS: ReadonlyMap<string, string> = new Map([
  ["cp9-cells/review/timer-method", "integer"],
  ["cp9-cells/provenance/external-opaque-merge", "integer"],
  ["cp9-cells/r44/own-selector/own-random-typed-copy", "integer"],
]);

/** The fix each rule 3.4 pair gives instead of the current checker's forbidden union. */
const UNION_RULE_FIXES: ReadonlyMap<string, string> = new Map([
  ["cp9-cells/s4/s6/owner/bound/list-kind/literal", "Use values of one type in it."],
  [
    "cp9-cells/s4/s6/owner/bound/list-kind/insert",
    "Use a separate list for values of another type.",
  ],
]);

const INTENDED: readonly Intended[] = [
  {
    rule: "S8c's (#1173): a number where a whole number is required, the count's and the written integer's sentences",
    matches: ({ diagnostic }) =>
      diagnostic.kind !== "written-type" &&
      (diagnostic.rule.rule === "count" ||
        ((diagnostic.rule.rule === "store" || diagnostic.rule.rule === "fallback") &&
          diagnostic.rule.type.includes("integer") &&
          diagnostic.kinds.includes("number"))),
    // (its sentences as they stand until S8c: rounding, a whole number, a fallback of the type, an unknown's test)
    replacement: ({ diagnostic, named }) =>
      diagnostic.kind !== "written-type" && diagnostic.rule.rule === "fallback"
        ? exact("Use null or a value of that type instead.")
        : diagnostic.kind !== "written-type" && diagnostic.kinds.includes("number")
          ? exact(ROUND)
          : diagnostic.kind !== "written-type" && diagnostic.kinds.includes("unknown")
            ? typeTest(named.subject, "integer")
            : exact("Use a whole number here."),
    count: 177,
  },
  {
    rule:
      "ADR 0021 rule 3.5: the value may also be of the type the use takes (its written union, a fallback), so the " +
      "new checker names the type test where the current checker's flow sees one type and gives that type's fix; " +
      "the flow comes with narrowing (#1073)",
    matches: ({ record, diagnostic }) =>
      UNION_TESTS.has(record) &&
      diagnostic.class === "warning-runtime-check" &&
      diagnostic.fits.length > 0,
    replacement: ({ record, named }) => typeTest(named.subject, UNION_TESTS.get(record)!),
    count: 11,
  },
  {
    rule:
      "ADR 0021 rule 1.7: a value the new checker does not know (from outside the script, or an operation it does " +
      "not follow) is checked with a type test, where the current checker knows its type",
    matches: ({ record, diagnostic }) =>
      UNKNOWN_TESTS.has(record) &&
      diagnostic.class === "warning-runtime-check" &&
      diagnostic.kinds.includes("unknown"),
    replacement: ({ record, named }) => typeTest(named.subject, UNKNOWN_TESTS.get(record)!),
    count: 4,
  },
  {
    rule: "ADR 0021 rule 3.4: the current checker's union holds a whole list beside another type",
    matches: ({ record, forms }) =>
      UNION_RULE_FIXES.has(record) && forms.some(({ fix }) => /'[^']*\[\] \|/.test(fix)),
    replacement: ({ record }) => exact(UNION_RULE_FIXES.get(record)!),
    count: 2,
  },
  {
    rule:
      "S9b's speaker flow (#1072, unit 6): the fix names the receiver as the source writes it ('people.random.n = " +
      "...'), the current checker the speaker it holds ('player.n = ...')",
    matches: ({ current, named }) =>
      /^Speaker '[^']+' has no /.test(current) && !current.startsWith(`Speaker '${named.subject}'`),
    // (a receiver that is no variable or path gets the sentence alone, #1195 after Astra r1)
    replacement: ({ named }) =>
      exact(
        /^[A-Za-z_]\w*(\.[A-Za-z_]\w*)*$/.test(named.subject)
          ? `Assign the property before this line, as in '${named.subject}${named.member} = ...'.`
          : "Assign the property before this line.",
      ),
    count: 5,
  },
];

/** The rule that explains a pair that differs, with its replacement, or `undefined`. */
const intendedOf = (pair: Pair): Intended | undefined =>
  INTENDED.find((intended) => intended.matches(pair));

test("the new checker keeps every fix the current checker gives, in the new form (#1195)", (t) => {
  const all = allPairs();
  const compared = all.filter((pair) => pair.forms.length > 0);
  const differing = compared.filter((pair) => !kept(pair));
  const counts = INTENDED.map(() => 0);
  const unexplained: string[] = [];
  let lost = 0;
  for (const pair of differing) {
    if (fixes(pair.message).length === 0) lost += 1;
    const intended = intendedOf(pair);
    // (an intended difference with the exact fix it names)
    if (intended === undefined || !intended.replacement(pair).test(pair.message))
      unexplained.push(`${pair.record}\n  current: ${pair.current}\n  new:     ${pair.message}\n`);
    else counts[INTENDED.indexOf(intended)]! += 1;
  }
  t.diagnostic(
    `${all.length} pairs, ${compared.length} with a fix, ${compared.length - differing.length} kept, ` +
      `${differing.length - unexplained.length} intended, ${lost} lost`,
  );
  assert.equal(lost, 0, "no fix is lost");
  assert.equal(unexplained.join("\n"), "", `${unexplained.length} pairs differ`);
  assert.deepEqual(
    INTENDED.map(({ rule }, index) => `${rule}: ${counts[index]}`),
    INTENDED.map(({ rule, count }) => `${rule}: ${count}`),
  );
});

test("the comparison rejects a fix changed in a kept or an intended pair (negative control, Astra r1)", () => {
  // each pattern that explains a pair, then its fix changed: a type test's type swapped (Astra's mutant of the rule
  // 1.7 fixes, which recommended 'string'), any other sentence replaced
  let checked = 0;
  for (const pair of allPairs().filter((found) => found.forms.length > 0)) {
    const intended = kept(pair) ? undefined : intendedOf(pair);
    const patterns = kept(pair)
      ? pair.forms.map(({ form }) => form!)
      : intended === undefined
        ? []
        : [intended.replacement(pair)];
    for (const pattern of patterns) {
      const found = pattern.exec(pair.message);
      if (found === null) continue;
      const tested = / is (\w+) \{/.exec(found[0]);
      const changed =
        tested === null
          ? "Do something else."
          : found[0].replace(tested[0], ` is ${tested[1] === "string" ? "integer" : "string"} {`);
      assert.ok(
        !pattern.test(pair.message.replace(found[0], changed)),
        `${pair.record}: ${changed}`,
      );
      checked += 1;
    }
  }
  assert.ok(checked > 700, `${checked} fixes changed`);
});

/**
 * Sources whose diagnostic suggests code, `⟦…⟧` around the code the fix replaces: atomic and composed operands, scalar
 * and structured values, each fix's family once, and for an example of a property shown the lines the repaired source
 * says. A declaration's `= ...` keeps the source's own start value.
 */
const REPAIRS: readonly (readonly [string, RegExp, (readonly string[])?])[] = [
  // date and time operators, composed operands grouped, also as a warning
  [
    'let t = toAbsoluteDateTime("2026-01-01T00:00:00Z")\nlet u = t + 1 s\nsay ⟦u + 1 calendar day⟧\nexit\n',
    /as in '([^']*)'/,
  ],
  ['let t = toDateTime("2026-01-01T00:00:00")\nsay ⟦t + 1 s⟧\nexit\n', /as in '([^']*)'/],
  ['say toDate("2026-10-23") + ⟦1 day⟧\nexit\n', /Write '([^']*)'/],
  [
    'let d = toDateTime("2026-10-23T12:00:00")\nsay toDate("2026-10-23") < ⟦d⟧\nexit\n',
    /as in '([^']*)'/,
  ],
  [
    'let a = toDateTime("2026-10-23T12:00:00")\nlet b = toDateTime("2026-10-22T12:00:00")\nsay ⟦a - b⟧\nexit\n',
    /dates with '([^']*)'/,
  ],
  // members of a kind without them, on a composed receiver
  [
    'let t = toAbsoluteDateTime("2026-01-01T00:00:00Z")\nlet u = t + 1 s\nsay ⟦u.year⟧\nexit\n',
    /as in '([^']*)'/,
  ],
  ["let d = 1 s+2 s\nsay ⟦d.seconds⟧\nexit\n", /as in '([^']*)'/, ["3"]],
  ["let n = 1\nsay ⟦n.length⟧\nexit\n", /as in '([^']*)'/],
  [
    // (the current checker's example property, of a speaker that has it)
    'speaker sage { title: "Sage" }\nlet value = sage\nsay ⟦value.get(0, default: 3)⟧\nexit\n',
    /such as '([^']*)'/,
  ],
  // `${...}`: an object's first property it shows, a set
  // (the first plain property: a list's emptiness is known only when the script runs)
  ['let slave = {nested: {name: "A"}, age: 1}\nsay "⟦${slave}⟧"\nexit\n', /as in '([^']*)'/, ["1"]],
  ['let slave = {names: ["A"], age: 1}\nsay "⟦${slave}⟧"\nexit\n', /as in '([^']*)'/, ["1"]],
  [
    'let box = {first: ["A"], second: 2}\nbox.first.clear()\nsay "⟦${box}⟧"\nexit\n',
    /as in '([^']*)'/,
    ["2"],
  ],
  ['let s = set[1]\nsay "⟦${s}⟧"\nexit\n', /with '([^']*)'/, ["1"]],
  // (Astra r1's control: a named set, the name its own)
  ['let value = set[99]\nlet s = set[4, 7]\nsay "⟦${s}⟧"\nexit\n', /with '([^']*)'/, ["4, 7"]],
  // a condition, a key, text
  ['let count = 2\nif ⟦count⟧ { say "x" }\nexit\n', /as in '([^']*)'/],
  ['let toys = [1]\nif ⟦toys⟧ { say "x" }\nexit\n', /as in '([^']*)'/],
  ['let d = dict{"1": 5}\nlet k = 1\nsay d[⟦k⟧]\nexit\n', /as in '([^']*)'/, ["5"]],
  ["let n = 1\nlet caption: string = ⟦n⟧\nsay caption\nexit\n", /write '([^']*)'/, ["1"]],
  // the null check's fallback, of a kept value and of a composed one
  ["let xs = [7, null]\nsay ⟦xs[0]⟧ + 1\nexit\n", /fallback, as in '([^']*)'/],
  [
    'let x: integer? = null\nlet y: integer? = null\nif askBoolean "x" { x = 1 }\nrepeat (⟦x otherwise y⟧) {}\nexit\n',
    /fallback, as in '([^']*)'/,
  ],
  // the declarations a union or null widens (ADR 0021 rules 1.1, 1.2, 1.7, 7.3)
  ['⟦let mood⟧ = 1\nmood = "happy"\nexit\n', /as '([^']*)'/],
  ['⟦let d⟧ = dict{a: 1}\nd["b"] = "x"\nexit\n', /as '([^']*)'/],
  ['function use(⟦n: integer⟧) { say n }\nuse("x")\nexit\n', /as '([^']*)'/],
  ["let n = null\n⟦let whole: integer⟧ = n\nexit\n", /as '([^']*)'/],
  ['let source = ["s"]\n⟦let copy⟧ = source.removeAt(0)\ncopy = 2\nexit\n', /as '([^']*)'/],
  [
    '⟦let result: integer⟧ = load("count", default: ["bad"].last)\nsay result\nexit\n',
    /as '([^']*)'/,
  ],
];

test("the code each fix suggests compiles where it stands and runs, saying what it should (#1195)", () => {
  for (const [marked, pick, says] of REPAIRS) {
    const source = marked.replace(/[⟦⟧]/g, "");
    const files = [{ path: "main.tease", source }];
    const request = coreRequest(files);
    assert.ok(request !== null, source);
    const text = messageSource([source]);
    const suggested = analyseCore(request)
      .diagnostics.map((diagnostic) => pick.exec(coreMessage(diagnostic, text))?.[1])
      .find((found) => found !== undefined);
    assert.ok(suggested !== undefined, `a fix: ${source}`);
    // (a declaration keeps its start value)
    const fixed = marked.replace(/⟦[^⟧]*⟧/, suggested.replace(/ = \.\.\.$/, ""));
    const errors = compileProject([{ path: "main.tease", source: fixed }]).diagnostics.filter(
      (diagnostic) => diagnostic.severity === "error",
    );
    assert.deepEqual(
      errors.map((diagnostic) => `${diagnostic.code}: ${diagnostic.message}`),
      [],
      fixed,
    );
    // (until it exits, fails, or waits for the player)
    const { plan } = compileProject([{ path: "main.tease", source: fixed }]);
    assert.ok(plan !== null, fixed);
    const session = createFreshRuntimeSession(plan, {
      baseDelayMs: 0,
      delayPerWordMs: 0,
      delayPerCharacterMs: 0,
    });
    const events = session.run().events;
    assert.deepEqual(
      events.filter((event) => event.kind === "runtimeFailure"),
      [],
      fixed,
    );
    if (says !== undefined)
      assert.deepEqual(
        events.flatMap((event) => (event.kind === "say" ? [event.text] : [])),
        says,
        fixed,
      );
  }
});

/**
 * Text joins, `⟦…⟧` around the operand that is not text: the example puts it in `${...}` as the source writes it, and
 * the source with the operand so written says these lines (the owner's review; r3's and r4's shapes among them).
 */
const JOINS: readonly (readonly [string, readonly string[]])[] = [
  ['let score = 3\nsay "You have " + ⟦score⟧ + " points"\nexit\n', ["You have 3 points"]],
  [
    'function f(n) {\nsay "You have " + ⟦n⟧ + " points"\n}\nf(1)\nf(2)\nexit\n',
    ["You have 1 points", "You have 2 points"],
  ],
  [
    'let prefix = "You have "\nlet n = 1\nsay prefix + ⟦n⟧ + " points"\nexit\n',
    ["You have 1 points"],
  ],
  ['say ⟦1 + 2⟧ + " points"\nexit\n', ["3 points"]],
  ['let n = 1\nsay "Sum: " + (⟦n + 2⟧)\nexit\n', ["Sum: 3"]],
  ['let who = "Alice"\nlet n = 1\nsay "$" + "{who}" + ⟦n⟧\nexit\n', ["${who}1"]],
  ['let box = {n: 2}\nsay "n is " + ⟦box.n⟧\nexit\n', ["n is 2"]],
  ['let xs = [5]\nsay "First: " + ⟦xs[0]⟧\nexit\n', ["First: 5"]],
  // (a chain over two lines, its operand on one)
  ['let n = 1\nsay "Sum: " +\n  ⟦n⟧\nexit\n', ["Sum: 1"]],
  ['function two { return 2 }\nsay "Two: " + ⟦two()⟧\nexit\n', ["Two: 2"]],
  ['let d = dict{"a": 1}\nsay "A: " + ⟦d["a"]⟧\nexit\n', ["A: 1"]],
  ['say "A: " + ⟦dict{"a": 1}["a"]⟧\nexit\n', ["A: 1"]],
];

test("a text join's example puts the operand that is not text in '${...}', and the result says what the join meant (#1195)", () => {
  for (const [marked, says] of JOINS) {
    const source = marked.replace(/[⟦⟧]/g, "");
    const request = coreRequest([{ path: "main.tease", source }]);
    assert.ok(request !== null, source);
    const text = messageSource([source]);
    const suggested = analyseCore(request)
      .diagnostics.map(
        (diagnostic) =>
          /in the text as '(\$\{[^']*\})' instead/.exec(coreMessage(diagnostic, text))?.[1],
      )
      .find((found) => found !== undefined);
    assert.ok(suggested !== undefined, `an example: ${source}`);
    const fixed = marked.replace(/⟦[^⟧]*⟧/, `"${suggested}"`);
    const compiled = compileProject([{ path: "main.tease", source: fixed }]);
    assert.deepEqual(
      compiled.diagnostics.filter((diagnostic) => diagnostic.severity === "error"),
      [],
      fixed,
    );
    assert.ok(compiled.plan !== null, fixed);
    const events = createFreshRuntimeSession(compiled.plan, {
      baseDelayMs: 0,
      delayPerWordMs: 0,
      delayPerCharacterMs: 0,
    }).run().events;
    assert.deepEqual(
      events.flatMap((event) => (event.kind === "say" ? [event.text] : [])),
      says,
      fixed,
    );
  }
});

test("a fix whose subject is no variable or path, or not on one line, gives its sentence without an example (#1195)", () => {
  const cases: readonly (readonly [string, string])[] = [
    // the text join where the operand that is not text spans lines or holds a comment (the owner's review)
    ['let n = 1\nsay "Sum: " + (n\n+2)\nexit\n', "Put the value in the text instead."],
    ['let n = 1\nsay "Sum: " + (n /* two */ + 2)\nexit\n', "Put the value in the text instead."],
    // a value written as a literal or another expression (Astra r1: never a name of another declaration)
    [
      'let value = set[99]\nsay "${set[4, 7]}"\nexit\n',
      "Show its elements with 'toList().join()' instead.",
    ],
    [
      'say "${dict{a: 1}}"\nexit\n',
      "Select one value with a key, or show every value with 'values.join()'.",
    ],
    ['let rec = {names: ["A"]}\nsay "${rec}"\nexit\n', "Show one of its properties instead."],
    ['let d = dict{"1": 5}\nsay d[1]\nexit\n', "Write a number key as text."],
    ["let caption: string = 1\nexit\n", "To show it as text, put it in a text with '${...}'."],
    ["say (1 s + 2 s).seconds\nexit\n", "Divide '1 s + 2 s' by a unit, such as '1 second'."],
    [
      'let t = toAbsoluteDateTime("2026-01-01T00:00:00Z")\nsay (t + 1 s) + 1 calendar day\nexit\n',
      "Convert it with 'toDateTime()' first.",
    ],
    [
      'say toDate("2026-10-23") < toDateTime("2026-10-23T12:00:00")\nexit\n',
      "Compare its date, with 'toDate(...)'.",
    ],
  ];
  for (const [source, fix] of cases) {
    const request = coreRequest([{ path: "main.tease", source }]);
    assert.ok(request !== null, source);
    const text = messageSource([source]);
    const messages = analyseCore(request).diagnostics.map((diagnostic) =>
      coreMessage(diagnostic, text),
    );
    assert.ok(
      messages.some((message) => message.includes(fix)),
      `${source}: ${messages.join(" | ")}`,
    );
  }
});
