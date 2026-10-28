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
import { coreRequest, type SourceFile } from "./helpers/type-core-analysis.js";
import { pasteCases, pastedForms, pasteFailure } from "./helpers/type-core-paste.js";
import { readFixture } from "./helpers/type-core-fixture.js";

/** A diagnostic a rule found: a stop's own warning and marks (`budget`) name no fix and are never compared. */
type Compared = Exclude<CoreDiagnostic, { readonly kind: "budget" }>;

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

/** One of several forms: a fix's code where its predicate holds at the site, else its words (TABLE r4.151). */
const oneOf = (...forms: readonly RegExp[]): RegExp =>
  new RegExp(forms.map((found) => `(?:${found.source})`).join("|"));

/**
 * Whether a subject is a stable path as written (TABLE §13 N1), the only subject a fix's example names (Astra r1, r2):
 * a variable, then properties other than `random`, fixed indexes or keys, or indexes held in plain variables; a literal
 * word such as `true` is none. And whether its own text may stand in code: on one line, without a comment.
 */
const NAME = "(?!(?:true|false|null)\\b)[A-Za-z_]\\w*";
/** A key written as text without `${...}`: with escapes, and a `$` only before no `{`. */
const KEY = '"(?:[^"\\\\$]|\\\\.|\\$(?!\\{))*"';
const STABLE = new RegExp(
  `^${NAME}(?:\\.(?!random\\b)[A-Za-z_]\\w*|\\[\\s*(?:-?\\d+|${NAME}|${KEY})\\s*\\])*$`,
);
const stablePath = (text: string): boolean => STABLE.test(text);
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
            `Keep '${subject}' in a new variable, as in 'let value = ${subject}', and check it, as in 'if value != null ` +
              "{ ... }', or give a fallback, as in '",
            code(`\\(?${grouped(subject)} otherwise ${escaped(value!)}\\)?`),
            "'.",
          )
        : exact(
            `Keep '${subject}' in a new variable and check the variable first, as in 'if value != null { ... }'.`,
          ),
  },
  {
    from: /^Keep it in a variable and check it first, as in: if value (!= null|is .+) \{ \.\.\. \}$/,
    to: ([, test], { subject }) =>
      exact(
        ownText(subject)
          ? `Keep '${subject}' in a new variable, as in 'let value = ${subject}', and check it, as in 'if value ${test} ` +
              "{ ... }'."
          : `Keep '${subject}' in a new variable and check the variable first, as in 'if value ${test} { ... }'.`,
      ),
  },
  // #1195's decided texts; a condition's advice always, its example only of a stable path (Astra r3)
  {
    from: /^Compare it instead, such as '(.+)'\.$/,
    to: ([, fix], { subject }) =>
      exact(stablePath(subject) ? `Compare it instead, as in '${fix}'.` : "Compare it instead."),
  },
  {
    from: /^Check its length instead, such as '(.+)'\.$/,
    to: ([, fix], { subject }) =>
      exact(
        stablePath(subject)
          ? `Check its length instead, as in '${fix}'.`
          : "Check its length instead.",
      ),
  },
  {
    from: /^Show one of its properties instead\.$/,
    to: (_, { subject }) =>
      stablePath(subject)
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
        stablePath(subject)
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
        stablePath(subject)
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
        stablePath(subject)
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
        stablePath(subject)
          ? `Write a number key as text, as in '"\${${subject}}"'.`
          : "Write a number key as text.",
      ),
  },
  {
    from: /^Check '(.+)\.length' first\.$/,
    to: (_, { subject }) =>
      exact(
        stablePath(subject)
          ? `Check '${subject}.length' first, as in 'if ${subject}.length > 0 { ... }'.`
          : ownText(subject)
            ? `Keep '${subject}' in a new variable, as in 'let value = ${subject}', and check its length, as in ` +
              "'if value.length > 0 { ... }'."
            : `Keep '${subject}' in a new variable and check its length first.`,
      ),
  },
  { from: /^Give '(.+)' one type in every element\.$/, to: ([text]) => exact(text) },
  // members of a type without them
  {
    from: /^Convert it to text first with toString\(\.\.\.\)\.$/,
    to: (_, { subject, member }) =>
      exact(
        stablePath(subject)
          ? `Convert '${subject}' to text first, as in 'toString(${subject})${member}'.`
          : `Convert '${subject}' to text first with 'toString(...)'.`,
      ),
  },
  {
    from: /^Divide it by a unit, as in '.+ \/ 1 (\w+)'\.$/,
    to: ([, unit], { subject }) =>
      exact(
        stablePath(subject)
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
        `Use one of its properties instead, such as '${stablePath(subject) ? `${subject}.` : ""}title'.`,
      ),
  },
  // date and time operators and fields: an example where the value it converts is a variable or a path, the other
  // operand one or a quantity, else the sentence alone
  {
    from: /^Convert it first, as in '(.+)', or use calendar units to keep the clock time\.$/,
    to: (_, { operands: [left = "", right = ""] }) =>
      stablePath(left) && (stablePath(right) || quantity(right))
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
      stablePath(left) && (stablePath(right) || quantity(right))
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
        stablePath(subject)
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
        stablePath(right)
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
        `Subtract their dates with ${stablePath(left) && stablePath(right) ? `'toDate(${left}) - toDate(${right})'` : "'toDate(...)'"}, ` +
          "or convert both with 'toAbsoluteDateTime()' for the elapsed time.",
      ),
  },
  // ADR 0021 rule 2.2's rounding, as the count's sentence words it (S8c's, #1173)
  {
    from: /^Round the number with the floor, round or ceil function first\.$/,
    to: ([text]) => exact(text),
  },
  // #1241 under TABLE r4.151: each code form where its predicate holds at the diagnosed site (`codeAt`, which the paste
  // test below proves), the same fix in words where it does not; so a kept fix is one of the two, with the actual
  // operand and the receiver as the source writes it (the current checker writes '5 s' into an element and a result)
  {
    from: /^Give the number a unit, such as '.+ (s|deg)'\.$/,
    to: ([, unit], { subject }) =>
      oneOf(
        form("Give the number a unit, such as '", code(grouped(subject)), ` ${unit}'.`),
        exact("Give the number a unit."),
      ),
  },
  {
    from: /^Convert the text with (\w+)\(\.\.\.\)\.$/,
    to: ([, conversion = ""], { subject }) =>
      oneOf(
        exact(`Convert the text with '${conversion}(${subject})'.`),
        exact(`Convert the text with the ${conversion} function.`),
      ),
  },
  {
    from: /^Use '(toDeg|toRad)\(.+\)' for its size in (degrees|radians)\.$/,
    to: ([, conversion, unit], { subject }) =>
      oneOf(
        exact(`Use '${conversion}(${subject})' for its size in ${unit}.`),
        exact(`Use the ${conversion} function for its size in ${unit}.`),
      ),
  },
  { from: /^Use a dict to look up by name\.$/, to: ([text]) => exact(text) },
  // (an object's property is in words: no fact proves the object has it, Codex r1)
  {
    from: /^Read a fixed property as '.+\.(\w+)'\.$/,
    to: ([, key], { subject }) =>
      exact(
        `If ${stablePath(subject) ? `'${subject}'` : "the object"} has a property '${key}', use a dot instead of ` +
          "brackets.",
      ),
  },
  // (an add's key is the script's to choose, and a store's value is not proved a dict value: both in words)
  {
    from: /^Store a value by its key, as in dict\[(.+)\] = value\.$/,
    to: ([, key]) =>
      exact(
        key === "key"
          ? "Assign the value to a key of the dict instead."
          : "To store a value by its key, write the key in brackets.",
      ),
  },
  // (a key's value is there only where the dict has the key, which no fact proves: in words, Codex r6)
  {
    from: /^To read a value by its key, write '.+(\[.+\])'\.$/,
    to: (_, { subject }) =>
      exact(
        `To read a value by its key, write the key in brackets, where '${subject}' has that key.`,
      ),
  },
  {
    from: /^Use (length, keys, or values|contains, remove, clear, or get)\.$/,
    to: ([, names]) =>
      exact(
        `Use one of the dict's ${names!.startsWith("length") ? "properties" : "methods"} instead: ` +
          `${names!.replace(/(\w+)/g, "'$1'").replace("'or' ", "or ")}.`,
      ),
  },
  {
    from: /^Use (\w+(?:, \w+)*), or (\w+)\.$/,
    to: ([, names, last]) => {
      const quoted = [...names!.split(", "), last!].map((name) => `'${name}'`);
      return exact(`Use ${quoted.slice(0, -1).join(", ")}, or ${quoted.at(-1)!}.`);
    },
  },
  {
    from: /^Use (\w+)(\(\.\.\.\)|\(\))?\.$/,
    to: ([, member, call], { subject }) =>
      call === "(...)"
        ? exact(`Use the ${member} method.`)
        : oneOf(
            exact(`Use '${subject}.${member}${call ?? ""}'.`),
            exact(`Use the ${member} ${call === undefined ? "property" : "method"}.`),
          ),
  },
  // (a join's words also say what its elements must be, Astra r2, Codex r4)
  {
    from: /^Write \.?(\w+)(\(\.\.\.\)|\(\))? (with|without) parentheses\.$/,
    to: ([, member, call], { subject }) =>
      call === "(...)"
        ? exact(`Call the ${member} method with its arguments in parentheses.`)
        : call === undefined
          ? oneOf(
              exact(`Write '${subject}.${member}' without parentheses.`),
              exact(`Read the ${member} property without parentheses.`),
            )
          : oneOf(
              exact(`Write '${subject}.${member}()' with parentheses.`),
              exact(`Call the ${member} method with parentheses.`),
              exact(
                `Call the ${member} method with parentheses, on elements that can be shown as text.`,
              ),
              exact(
                `The ${member} method joins only elements that can be shown as text, so select an element or a ` +
                  "property first.",
              ),
            ),
  },
  // #1241: '+' of a list and a value that is not one: a new list at the diagnosed site, the operation or the operand
  // it names (`subject`), and an add only on a line of its own (it gives no list, Astra r1 B2), each in words where
  // its predicate does not hold
  {
    from: /^To add one element, use '.+', or write '.+' for a new list\.$/,
    to: (_, { subject, operands: [list = "", value = ""] }) =>
      form(
        code(
          `(?:Write '${grouped(subject === value ? `[${value}]` : `${list} + [${value}]`)}' for a new list|` +
            "To add one element, put the element in brackets for a new list)",
        ),
        code(
          `, or (?:add the element to '${escaped(list)}' itself with '${escaped(`${list}.add(${value})`)}'|` +
            "call the add method) on a line of its own\\.",
        ),
      ),
  },
  {
    from: /^Write '\[.+\] \+ .+' for a new list\.$/,
    to: (_, { subject, operands: [value = "", list = ""] }) =>
      oneOf(
        form(
          "Write '",
          code(grouped(subject === value ? `[${value}]` : `[${value}] + ${list}`)),
          "' for a new list.",
        ),
        exact("Put the element in brackets for a new list."),
      ),
  },
  // (the range as a list, the current checker's code for it beside the list operand, at the operand or the operation
  // the diagnostic sits on)
  {
    from: /^To add the numbers of a range, write '(.+)'\.$/,
    to: ([, both = ""], { subject, operands: [first = "", second = ""] }) => {
      const listFirst = both.startsWith(`${first} + `);
      const range = listFirst ? second : first;
      const numbers = listFirst
        ? both.slice(first.length + 3)
        : both.slice(0, both.length - second.length - 3);
      return oneOf(
        form(
          "Write '",
          code(grouped(subject === range ? numbers : both)),
          "' to add the numbers of the range.",
        ),
        exact("To add the numbers of a range, convert the range with the toList method first."),
      );
    },
  },
  {
    from: /^Join sets with union\(\), or copy a set into a list with toList\(\) first\.$/,
    to: () =>
      exact(
        "Join sets with the union method, or copy a set into a list with the toList method first.",
      ),
  },
];

/** The review's test for a sentence that names a fix (`message-review-2026-10-27/compare.mjs`): every one is ported. */
const FIX =
  /^(Round|Use|Put|Compare|Check|Declare|Write|Add|Select|Its |Remove|Call|Store|Give|Copy|Index|To |Convert|Move|Pass|Show|Turn|Test|Assign|Make|Keep|Start|Set|Load|Save|Wrap|Split|Read|Divide|Combine|Subtract|Join|Did you mean)|\bas in\b|\bsuch as\b|\bdeclare it\b/;

const sentences = (text: string): string[] => text.split(/(?<=[.?])\s+(?=[A-Z'"])/);

/** A message's fix sentences: each after its first sentence that names a fix, as the review found them. */
function fixes(message: string): string[] {
  return sentences(message)
    .slice(1)
    .filter((sentence) => FIX.test(sentence) && !sentence.startsWith("If it"));
}

/** What a diagnostic names, in the source's own text. */
function namedBy(diagnostic: Compared, source: MessageSource): Named {
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
  readonly diagnostic: Compared;
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
function correspondence(message: string, diagnostic: Compared, named: Named): number {
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

/** The pairs of the records' diagnostics: the expectation set's, or others of the same shape. */
function pairs(
  records: readonly {
    readonly name: string;
    readonly files: readonly SourceFile[];
  }[] = readFixture(),
): Pair[] {
  const found: Pair[] = [];
  for (const record of records) {
    const files = [...record.files].sort((a, b) => compareProjectPaths(a.path, b.path));
    const request = coreRequest(files);
    if (request === null) continue;
    const source = messageSource(files.map((file) => file.source));
    const core = new Map<string, { diagnostic: Compared; message: string; named: Named }[]>();
    for (const diagnostic of reportedDiagnostics(analyseCore(request))) {
      if (diagnostic.kind === "budget") continue;
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

const ROUND = "Round the number with the floor, round or ceil function first.";

/**
 * The type test of a subject (ADR 0021 rule 3.5): of a variable directly, of any other value kept in one first, its
 * `let` shown where its own text may stand in code.
 */
const typeTest = (subject: string, type: string): RegExp =>
  exact(
    /^[A-Za-z_]\w*$/.test(subject)
      ? `Check '${subject}' first, as in 'if ${subject} is ${type} { ... }'.`
      : ownText(subject)
        ? `Keep '${subject}' in a new variable, as in 'let value = ${subject}', and check it, as in 'if value is ${type} { ... }'.`
        : `Keep '${subject}' in a new variable and check the variable first, as in 'if value is ${type} { ... }'.`,
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
  /** The new checker's diagnostic is another one, which has no fix to keep. */
  readonly fixless?: true;
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
    rule:
      "§13 N2 (#1073, S10 part 2b): the null check the current checker asks for is written and holds at a read in a " +
      "stored value, so the new checker asks for none; its warning there is the external value's own property, which " +
      "only the run decides",
    matches: ({ record }) => record === "cp9-cells/witness/astra-stored-length",
    replacement: () => /^'[^']+' may not have property '[^']+' here\./,
    count: 1,
    fixless: true,
  },
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
    // (four fewer since S10 part 2b: those records' stored values take `is integer`'s narrowing, a whole number)
    count: 173,
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
      "S9b's speaker flow (#1072, unit 6): the fix names the receiver where the source writes it as a stable path, " +
      "the current checker the speaker it holds ('player.n = ...')",
    matches: ({ current, named }) =>
      /^Speaker '[^']+' has no /.test(current) && !current.startsWith(`Speaker '${named.subject}'`),
    // (a receiver that is no stable path gets the sentence alone, #1195 after Astra r1 and r2: a store into
    // `people.random.n` sets another speaker's than the read takes)
    replacement: ({ named }) =>
      exact(
        stablePath(named.subject)
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
    const intended = intendedOf(pair);
    if (fixes(pair.message).length === 0 && intended?.fixless !== true) lost += 1;
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
 * #1241: member, conversion and list errors the expectation set does not hold, from the classified pairs (Sol's
 * #1241 comment) and one sibling per repair the current checker gives: a number given a unit at a declaration, a
 * property, an operation's value, an element and an argument, an angle; text converted; a number shown as text in a
 * property; the members of an angle, an object, a dict and text, a list's method read as a property; `+` of a list
 * and an element, a range or a set.
 */
const CLASSIFIED: readonly string[] = [
  "let pause: duration = 3\nwait pause\nexit\n",
  "let box = {pause: 1 s}\nbox.pause = 3\nwait box.pause\nexit\n",
  "let n = 2\nlet p: duration = n + 1\nexit\n",
  "let xs: duration[] = [1 s]\nxs.add(3)\nexit\n",
  "function f(p: duration) { wait p }\nf(3)\nexit\n",
  "let p: angle = 90\nexit\n",
  'let day: date = "2026-10-28"\nexit\n',
  'let record = {label: "old"}\nrecord.label = 5\nexit\n',
  "let a = 90 deg\nsay a.degrees\nexit\n",
  'let door = {name: "hall"}\nsay door["name"]\nexit\n',
  "let toys = dict{collar: 1}\ntoys.add(2)\nexit\n",
  "let toys = dict{collar: 1}\nsay toys.collar\nexit\n",
  "let d = dict{a: 1}\nd.x = 2\nexit\n",
  "let d = dict{a: 1}\nsay d.keys()\nexit\n",
  'let t = "hello"\nsay t.size\nexit\n',
  'let t = "hello"\nsay t.toUpperCase()\nexit\n',
  'let t = "hello"\nsay t.length()\nexit\n',
  'let t = "hello"\nsay t.trim\nexit\n',
  'let t = "hello"\nsay t.substring\nexit\n',
  'let items = ["a", "b"]\nsay items.join\nexit\n',
  'let names = ["Ann"]\nsay names + "Bo"\nexit\n',
  "let xs = [1]\nsay 2 + xs\nexit\n",
  "let xs = [1]\nsay xs + (1..3)\nexit\n",
  "let xs = [1]\nlet s = set[2]\nsay xs + s\nexit\n",
  // (Codex r3: a text the conversion does not read; operands and ranges with arithmetic, at an operand or a list that
  // is no stable path)
  'let value: date = "bad"\nexit\n',
  "let xs = [{n: 1}]\nsay (xs + {n: 2}).length\nexit\n",
  "let xs: integer?[] = [1]\nsay (xs + null).length\nexit\n",
  "let xs = [1]\nlet n = 1\nsay (xs + (n..(n + 2))).length\nexit\n",
  "let xs = [1]\nlet n = 1\nsay (((n + 1)..4) + xs).length\nexit\n",
  "let lists = [[1]]\nsay (1..3) + lists.random\nexit\n",
];

test("each member, conversion and list fix of the current checker is kept on the classified pairs (#1241)", () => {
  const found = pairs(
    CLASSIFIED.map((source) => ({ name: source, files: [{ path: "main.tease", source }] })),
  );
  assert.deepEqual(
    found
      .filter((pair) => pair.forms.length === 0 || !kept(pair))
      .map((pair) => `${pair.record}\n  current: ${pair.current}\n  new:     ${pair.message}`),
    [],
  );
  // (each source pairs a diagnostic with a fix)
  assert.equal(new Set(found.map((pair) => pair.record)).size, CLASSIFIED.length);
  // TABLE r4.151 (Codex r1, r4, r5, Astra r2): a code form where its predicate holds at the site, the same fix in words
  // where it does not: what the site takes (a typed declaration, an operand), the elements' type, a store's target,
  // an object's property no fact proves; a property stored on a type without it gets no read's repair
  const messages = (source: string): string[] => {
    const request = coreRequest([{ path: "main.tease", source }]);
    assert.ok(request !== null, source);
    const text = messageSource([source]);
    return analyseCore(request).diagnostics.map((diagnostic) => coreMessage(diagnostic, text));
  };
  assert.deepEqual(messages("let xs = [1]\nxs.join = 2\nexit\n"), [
    "A list has no property 'join', so 'xs.join' cannot be used.",
  ]);
  assert.deepEqual(messages("let a = 90 deg\na.degrees = 2\nexit\n"), [
    "An angle has no property 'degrees', so 'a.degrees' cannot be used.",
  ]);
  const T = 'let t = "hello"\n';
  for (const [source, fix] of [
    [`${T}let size: string = t.size\nsay size\nexit\n`, "Use the length property."],
    [`${T}let n: integer = t.size\nsay n\nexit\n`, "Use 't.length'."],
    [`${T}if t.size > 2 {\n  say "long"\n}\nexit\n`, "Use 't.length'."],
    [
      'let items = ["a"]\nlet value: integer = items.join\nexit\n',
      "Call the join method with parentheses.",
    ],
    // (Codex r6: no fact proves the dict has the key, so a key's read is in words at any site)
    [
      "let d = dict{k: 1}\nlet v: integer = d.k\nexit\n",
      "To read a value by its key, write the key in brackets, where 'd' has that key.",
    ],
    [
      "let a = 90 deg\nlet n: string = a.degrees\nexit\n",
      "Use the toDeg function for its size in degrees.",
    ],
    [
      "let xs = [1]\nlet s: string = xs + 2\nexit\n",
      "To add one element, put the element in brackets for a new list, or call the add method on a line of its own.",
    ],
    [
      "let xs = [1]\nsay xs + 2\nexit\n",
      "Write 'xs + [2]' for a new list, or add the element to 'xs' itself with 'xs.add(2)' on a line of its own.",
    ],
    // (a value no constraint consumes: what `say` shows, but nothing proved where a command the core does not model
    // takes it)
    [`${T}wait t.size\nexit\n`, "Use the length property."],
    [
      'let xs = [1]\nsay xs + "x"\nexit\n',
      "To add one element, put the element in brackets for a new list, or call the add method on a line of its own.",
    ],
    [
      'let a = {n: 1}\nsay a["missing"]\nexit\n',
      "If 'a' has a property 'missing', use a dot instead of brackets.",
    ],
    [
      'let d = dict{a: 1}\nd.b = "x"\nexit\n',
      "To store a value by its key, write the key in brackets.",
    ],
  ] as const) {
    const found = messages(source);
    assert.ok(
      found.some((message) => message.endsWith(` ${fix}`)),
      `${source}: ${found.join(" | ")}`,
    );
  }
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
  // a stable path through a fixed index, a key, an index variable (TABLE §13 N1, Astra r2)
  ["let xs = [1]\nlet caption: string = ⟦xs[0]⟧\nsay caption\nexit\n", /write '([^']*)'/, ["1"]],
  [
    'let d = dict{"a": 2}\nlet caption: string = ⟦d["a"]⟧\nsay caption\nexit\n',
    /write '([^']*)'/,
    ["2"],
  ],
  [
    'let ts = [toAbsoluteDateTime("2026-01-01T00:00:00Z")]\nlet i = 0\nsay ⟦ts[i].year⟧\nexit\n',
    /as in '([^']*)'/,
    ["2026"],
  ],
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
  // #1241 (TABLE r4.151): each code form a fix offers, pasted whole at the site its diagnostic sits on, where its
  // predicate holds: a number given a unit, also an operation's value; text converted; a member the type has, on a
  // receiver written plainly, nested, as an element and as a dict value, also as a range's bound; a join's elements
  // ones it shows; a new list where the site takes one (an untyped or a written list, an operand, a receiver)
  ["let pause: duration = ⟦3⟧\nsay pause\nexit\n", /such as '([^']*)'/],
  ["let n = 2\nlet p: duration = ⟦n + 1⟧\nsay p\nexit\n", /such as '([^']*)'/],
  ['let day: date = ⟦"2026-10-28"⟧\nsay day.year\nexit\n', /with '([^']*)'\./, ["2026"]],
  ['let at: time = ⟦"10:30"⟧\nsay at.hour\nexit\n', /with '([^']*)'\./, ["10"]],
  ['let dt: datetime = ⟦"2026-10-28T10:00:00"⟧\nsay dt.year\nexit\n', /with '([^']*)'\./, ["2026"]],
  [
    'let ad: absoluteDateTime = ⟦"2026-10-28T10:00:00Z"⟧\nsay ad.toDateTime().year\nexit\n',
    /with '([^']*)'\./,
  ],
  ["let a = 90 deg\nsay ⟦a.degrees⟧\nexit\n", /Use '([^']*)' for its size/, ["90"]],
  [
    "let a = 90 deg\nlet n: number = ⟦a.degrees⟧\nsay n\nexit\n",
    /Use '([^']*)' for its size/,
    ["90"],
  ],
  ['let t = "hello"\nsay ⟦t.size⟧\nexit\n', /Use '([^']*)'/, ["5"]],
  ['let t = "hello"\nlet n: integer = ⟦t.size⟧\nsay n\nexit\n', /Use '([^']*)'/, ["5"]],
  ['let t = "hello"\nif ⟦t.size⟧ > 2 {\n  say "long"\n}\nexit\n', /Use '([^']*)'/, ["long"]],
  ['let box = {label: "hello"}\nsay ⟦box.label.size⟧\nexit\n', /Use '([^']*)'/, ["5"]],
  ['let items = ["hello"]\nsay ⟦items[0].size⟧\nexit\n', /Use '([^']*)'/, ["5"]],
  [
    'let t = "hello"\nfor i in 1..⟦t.size⟧ {\n  say i\n}\nexit\n',
    /Use '([^']*)'/,
    ["1", "2", "3", "4"],
  ],
  ['let t = "hello"\nsay ⟦t.toUpperCase()⟧\nexit\n', /Use '([^']*)'/, ["HELLO"]],
  ['let t = "hello"\nsay ⟦t.length()⟧\nexit\n', /Write '([^']*)'/, ["5"]],
  ['let t = " hello "\nsay ⟦t.trim⟧\nexit\n', /Write '([^']*)'/, ["hello"]],
  ['let d = dict{a: " hello "}\nsay ⟦d["a"].trim⟧\nexit\n', /Write '([^']*)'/, ["hello"]],
  ['let items = ["a", "b"]\nsay ⟦items.join⟧\nexit\n', /Write '([^']*)'/],
  ['let box = {items: ["a", "b"]}\nsay ⟦box.items.join⟧\nexit\n', /Write '([^']*)'/],
  ['let lists = [["a"]]\nsay ⟦lists[0].join⟧\nexit\n', /Write '([^']*)'/],
  ["let items: integer[] = []\nsay ⟦items.join⟧\nexit\n", /Write '([^']*)'/],
  [
    'let names = ["Ann"]\nlet more = ⟦names + "Bo"⟧\nsay more.length\nexit\n',
    /Write '([^']*)' for a new list/,
    ["2"],
  ],
  [
    "let xs = [1]\nlet ys: integer[] = ⟦xs + 2⟧\nsay ys.length\nexit\n",
    /Write '([^']*)' for a new list/,
    ["2"],
  ],
  [
    "let xs = [1]\nlet ys = ⟦2 + xs⟧\nsay ys.length\nexit\n",
    /Write '([^']*)' for a new list/,
    ["2"],
  ],
  [
    'let names = ["Ann"]\nsay (⟦names + "Bo"⟧).length\nexit\n',
    /Write '([^']*)' for a new list/,
    ["2"],
  ],
  ["let xs = [1]\nsay (xs + (⟦1..3⟧)).length\nexit\n", /Write '([^']*)' to add the numbers/, ["3"]],
  // a fallback the fix writes (ADR 0021 rule 1.9) where the value does not divide, and a receiver's in parentheses
  // (Astra on #1273)
  ["let xs = [4, null]\nsay ⟦xs[1]⟧ / 2\nexit\n", /fallback, as in '([^']*)'/, ["0"]],
  ['let xs = ["ab", null]\nsay ⟦xs[1]⟧.length\nexit\n', /fallback, as in '([^']*)'/, ["0"]],
];

/**
 * #1241 (Astra r1 B2): an `add` a list fix offers on a line of its own, which gives no list: pasted as a line before the
 * join's line, the list itself where the join stood, `⟦…⟧` around the join; the run says the lines given.
 */
const ADDS: readonly (readonly [string, readonly string[]])[] = [
  ['let names = ["Ann"]\nsay (⟦names + "Bo"⟧).length\nexit\n', ["2"]],
  ["let xs = [1]\nlet ys: integer[] = ⟦xs + 2⟧\nsay ys.length\nexit\n", ["2"]],
];

test("a list fix's add, on a line of its own, compiles and runs where the fix offers it (#1241)", () => {
  for (const [marked, says] of ADDS) {
    const source = marked.replace(/[⟦⟧]/g, "");
    const request = coreRequest([{ path: "main.tease", source }]);
    assert.ok(request !== null, source);
    const text = messageSource([source]);
    const found = analyseCore(request)
      .diagnostics.map((diagnostic) =>
        /add the element to '([^']*)' itself with '([^']*)' on a line of its own/.exec(
          coreMessage(diagnostic, text),
        ),
      )
      .find((match) => match !== null);
    assert.ok(found !== undefined && found !== null, `an add: ${source}`);
    const [, list, statement] = found;
    const line = marked.split("\n").find((candidate) => candidate.includes("⟦"))!;
    const fixed = marked.replace(line, `${statement!}\n${line.replace(/⟦[^⟧]*⟧/, list!)}`);
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

/**
 * TABLE r4.151 (#1241): the paste family's sample (`type-core-paste.ts`): every offer once, the sites in turn, every
 * code form its fix offers pasted at its own position compiles and runs. The whole family, every offer at every site,
 * is the step's evidence outside CI.
 */
test("every code form a fix offers compiles and runs where pasted, on the paste family's sample (TABLE r4.151)", () => {
  const failures: string[] = [];
  let pasted = 0;
  for (const { name, source, start, end } of pasteCases(true)) {
    const { diagnosed, forms } = pastedForms(source, start, end);
    if (!diagnosed) failures.push(`${name}: no error at the expression`);
    for (const form of forms) {
      pasted += 1;
      const failure = pasteFailure(form.source);
      if (failure !== null) failures.push(`${name}: '${form.code}': ${failure}`);
    }
  }
  assert.deepEqual(failures, []);
  assert.ok(pasted > 0, `${pasted} forms pasted`);
});

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

/**
 * Length checks, `⟦…⟧` around the collection a read selects from, and whether it is a stable path (TABLE §13 N1): the
 * fix checks a stable path itself, and keeps any other in a new variable first, so the check and the read see one
 * selection (Astra r2: `if groups.random.length > 0 { say groups.random.last }` checks one and reads another).
 */
const GROUPS = "let groups: integer[][] = [[], [21]]\n";
const SELECTIONS: readonly (readonly [string, boolean])[] = [
  [`${GROUPS}say ⟦groups.random⟧.last\nexit\n`, false],
  ["let catalog = {groups: [[], [21]]}\nsay ⟦catalog.groups.random⟧.last\nexit\n", false],
  [`${GROUPS}function pick { return groups.random }\nsay ⟦pick()⟧.last\nexit\n`, false],
  [`${GROUPS}let i = 0\nsay ⟦groups[i + 1]⟧.last\nexit\n`, false],
  [
    `${GROUPS}let xs: integer[]? = null\nlet ys = groups.random\nsay (⟦xs otherwise ys⟧).last\nexit\n`,
    false,
  ],
  [`${GROUPS}say ⟦groups[1]⟧.last\nexit\n`, true],
  [`${GROUPS}let i = 1\nsay ⟦groups[i]⟧.last\nexit\n`, true],
  ['let d = dict{"a": [21], "b": []}\nsay ⟦d["a"]⟧.last\nexit\n', true],
  // (keys as the parser reads them: an escape, a `$` before no `{`, spaces; Sol r6)
  ['let d = dict{"a\\"b": [21], "c": []}\nsay ⟦d["a\\"b"]⟧.last\nexit\n', true],
  ['let d = dict{"a$b": [21], "c": []}\nsay ⟦d["a$b"]⟧.last\nexit\n', true],
  ['let d = dict{"a": [21], "b": []}\nsay ⟦d[ "a" ]⟧.last\nexit\n', true],
];

/** Seeds under which `groups.random` picks, in turn, the same and different selections. */
const SEEDS = [2026, 31337, 123456, 424242, 654321, 987654, 999999];

test("a length check's fix checks the selection the read takes, under every seed (Astra r2)", () => {
  const run = (source: string, seed: number): { failed: boolean; says: string[] } => {
    const compiled = compileProject([{ path: "main.tease", source }]);
    assert.deepEqual(
      compiled.diagnostics.filter((diagnostic) => diagnostic.severity === "error"),
      [],
      source,
    );
    assert.ok(compiled.plan !== null, source);
    const { events } = createFreshRuntimeSession(compiled.plan, {
      seed,
      baseDelayMs: 0,
      delayPerWordMs: 0,
      delayPerCharacterMs: 0,
    }).run();
    return {
      failed: events.some((event) => event.kind === "runtimeFailure"),
      says: events.flatMap((event) => (event.kind === "say" ? [event.text] : [])),
    };
  };
  // (the control: a check of `groups.random` itself and its read pick different selections under one of the seeds)
  const unstable = `${GROUPS}if groups.random.length > 0 { say groups.random.last }\nexit\n`;
  assert.ok(SEEDS.some((seed) => run(unstable, seed).failed));
  for (const [marked, stable] of SELECTIONS) {
    const collection = /⟦([^⟧]*)⟧/.exec(marked)![1]!;
    const source = marked.replace(/[⟦⟧]/g, "");
    // (the parity's own oracle agrees with each case)
    assert.equal(stablePath(collection), stable, collection);
    const request = coreRequest([{ path: "main.tease", source }]);
    assert.ok(request !== null, source);
    const text = messageSource([source]);
    const message = analyseCore(request)
      .diagnostics.map((diagnostic) => coreMessage(diagnostic, text))
      .find((found) => found.startsWith(`'${collection}' may be empty here.`));
    assert.ok(message !== undefined, source);
    // (the fix as its message writes it, applied around the read)
    const read = source.split("\n").find((line) => line.includes(collection))!;
    const checked = /Check '[^']*' first, as in 'if ([^']*) \{ \.\.\. \}'\./.exec(message);
    const kept =
      /Keep '[^']*' in a new variable, as in '(let value = [^']*)', and check its length, as in 'if ([^']*) \{ \.\.\. \}'\./.exec(
        message,
      );
    assert.equal(checked !== null, stable, message);
    assert.equal(kept !== null, !stable, message);
    const fixed = source.replace(
      read,
      checked !== null
        ? `if ${checked[1]!} { ${read} }`
        : `${kept![1]!}\nif ${kept![2]!} { ${read.replace(collection, "value")} }`,
    );
    const runs = SEEDS.map((seed) => run(fixed, seed));
    assert.deepEqual(
      runs.filter(({ failed, says }) => failed || !(says.length === 0 || says.join() === "21")),
      [],
      fixed,
    );
    assert.ok(
      runs.some(({ says }) => says.join() === "21"),
      fixed,
    );
  }
});

/**
 * A fix whose subject is no stable path or not on one line loses its example, never its advice (#1195 rule 1, the lead
 * after Astra r3): each such outcome of every fix with an example, as a whole sentence of its message.
 */
test("a fix whose subject is no stable path, or not on one line, keeps its advice without an example (#1195)", () => {
  const cases: readonly (readonly [string, string])[] = [
    // a condition (Astra r3: a selection, its text and list variants, a call)
    [
      'let readings = [0, 73]\nif readings.random { say "selected" }\nexit\n',
      "Compare it instead.",
    ],
    [
      'let readings = ["", "Harbor"]\nif readings.random { say "selected" }\nexit\n',
      "Compare it instead.",
    ],
    [
      'let readings = [[], [73]]\nif readings.random { say "selected" }\nexit\n',
      "Check its length instead.",
    ],
    ['function f { return 1 }\nif f() { say "x" }\nexit\n', "Compare it instead."],
    // a member of a type without it, a speaker's member
    [
      "let ns = [1, 2]\nsay ns.random.length\nexit\n",
      "Convert 'ns.random' to text first with 'toString(...)'.",
    ],
    [
      'let ts = [toAbsoluteDateTime("2026-01-01T00:00:00Z")]\nsay ts.random.year\nexit\n',
      "Convert 'ts.random' with 'toDateTime()' first.",
    ],
    [
      "let ss = [set[1]]\nsay ss.random.indexOf(1)\nexit\n",
      "Copy 'ss.random' into a list with 'toList()' first.",
    ],
    ["let rack = [player]\nsay rack.random.rank\nexit\n", "Assign the property before this line."],
    [
      "let rack = [player]\nsay rack.random.get(0)\nexit\n",
      "A speaker has no methods. Use one of its properties instead, such as 'title'.",
    ],
    // a null check of a value not on one line
    [
      "let xs = [7, null]\nsay (xs /* c */ [0]) + 1\nexit\n",
      "Keep 'xs /* c */ [0]' in a new variable and check the variable first, as in 'if value != null { ... }'.",
    ],
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
    // (a literal is classified by the parser: `true` is no name, Sol r5)
    ["let caption: string = true\nexit\n", "To show it as text, put it in a text with '${...}'."],
    // (a selection that is no stable path, its text not code on one line: kept first, without the example)
    [
      "let groups: integer[][] = [[], [21]]\nsay (groups /* any */ .random).last\nexit\n",
      "Keep 'groups /* any */ .random' in a new variable and check its length first.",
    ],
    ["say (1 s + 2 s).seconds\nexit\n", "Divide '1 s + 2 s' by a unit, such as '1 second'."],
    [
      'let t = toAbsoluteDateTime("2026-01-01T00:00:00Z")\nsay (t + 1 s) + 1 calendar day\nexit\n',
      "Convert it with 'toDateTime()' first.",
    ],
    [
      'say toDate("2026-10-23") < toDateTime("2026-10-23T12:00:00")\nexit\n',
      "Compare its date, with 'toDate(...)'.",
    ],
    [
      'let ds = [toDateTime("2026-01-01T00:00:00")]\nsay ds.random + 1 s\nexit\n',
      "Convert it with 'toAbsoluteDateTime()' first, or use calendar units to keep the clock time.",
    ],
    [
      'let ds = [toDateTime("2026-01-01T00:00:00")]\nsay ds.random - ds[0]\nexit\n',
      "Subtract their dates with 'toDate(...)', or convert both with 'toAbsoluteDateTime()' for the elapsed time.",
    ],
    // #1241 (TABLE r4.146): where no complete code form stands at the site, the function or the step in words: a unit,
    // a conversion of text not on one line; members of a receiver that is no stable path; a method's arguments; an
    // add's key; a list joined of a receiver that is no stable path
    [
      "let n = 1\nlet p: duration = n /* c */ + 1\nexit\n",
      "Put the expression in parentheses with a unit after them.",
    ],
    ['let day: date = ("2026-" +\n"10-28")\nexit\n', "Convert the text with the toDate function."],
    // (Codex r3: a text the conversion does not read, or another value, which may be one)
    ['let day: date = "bad"\nexit\n', "Convert the text with the toDate function."],
    ['let day: date = "2026-02-30"\nexit\n', "Convert the text with the toDate function."],
    ['let at: time = "25:00"\nexit\n', "Convert the text with the toTime function."],
    [
      'let text = "bad"\nlet day: date = text\nexit\n',
      "Convert the text with the toDate function.",
    ],
    [
      "let angles = [90 deg]\nsay angles.random.degrees\nexit\n",
      "Use the toDeg function for its size in degrees.",
    ],
    ['let ts = ["a"]\nsay ts.random.trim\nexit\n', "Call the trim method with parentheses."],
    [
      'let ts = ["a"]\nsay ts.random.length()\nexit\n',
      "Read the length property without parentheses.",
    ],
    ['let ts = ["a"]\nsay ts.random.size\nexit\n', "Use the length property."],
    [
      'let t = "hello"\nsay t.substring\nexit\n',
      "Call the substring method with its arguments in parentheses.",
    ],
    ['let t = "hello"\nsay t.includes("l")\nexit\n', "Use the contains method."],
    [
      'let os = [{n: 1}]\nsay os.random["n"]\nexit\n',
      "If the object has a property 'n', use a dot instead of brackets.",
    ],
    [
      "let ds = [dict{a: 1}]\nsay ds.random.collar\nexit\n",
      "To read a value by its key, write the key in brackets, where 'ds.random' has that key.",
    ],
    // (Codex r6: a key the dict may not have, also a value of objects; a loop's iterable, whose variable the body reads;
    // a list of objects, whose element's properties the fix cannot prove)
    [
      "let d = dict{k: 1}\nsay d.missing\nexit\n",
      "To read a value by its key, write the key in brackets, where 'd' has that key.",
    ],
    [
      'let d = dict{k: {n: 1}}\nlet v = {n: "x"}\nv = d.k\nexit\n',
      "To read a value by its key, write the key in brackets, where 'd' has that key.",
    ],
    [
      "let xs = [1]\nfor v in xs + 2 {\n  say v\n}\nexit\n",
      "To add one element, put the element in brackets for a new list, or call the add method on a line of its own.",
    ],
    [
      'let xs = [{n: 1}]\nsay xs + {n: "x"}\nexit\n',
      "To add one element, put the element in brackets for a new list, or call the add method on a line of its own.",
    ],
    [
      "let ds = [dict{a: 1}]\nds.random.b = 2\nexit\n",
      "To store a value by its key, write the key in brackets.",
    ],
    [
      "let toys = dict{collar: 1}\ntoys.add(2)\nexit\n",
      "Assign the value to a key of the dict instead.",
    ],
    [
      'let ls = [["A"]]\nsay ls.random + "B"\nexit\n',
      "To add one element, put the element in brackets for a new list, or call the add method on a line of its own.",
    ],
    ["let ls = [[1]]\nsay 2 + ls.random\nexit\n", "Put the element in brackets for a new list."],
    // (Astra r2, Codex r4: a join of elements whose type it cannot show, also of a list cleared or filled later, of
    // lists, of a dict's objects, nested; of elements whose type is not known; a warning's receiver, which may be of
    // another type or null, so its fix is in words)
    ...[
      "let items = [{n: 1}]\nsay items.join\nexit\n",
      "let items = [{n: 1}]\nitems.clear()\nsay items.join\nexit\n",
      "let items = []\nitems.add({n: 1})\nsay items.join\nexit\n",
      "let items = [[1]]\nsay items.join\nexit\n",
      "let ds = dict{a: {n: 1}}\nsay ds.values.join\nexit\n",
      "let box = {items: [{n: 1}]}\nsay box.items.join\nexit\n",
    ].map(
      (source) =>
        [
          source,
          "The join method joins only elements that can be shown as text, so select an element or a property first.",
        ] as const,
    ),
    [
      "let items = [hostValue]\nsay items.join\nexit\n",
      "Call the join method with parentheses, on elements that can be shown as text.",
    ],
    [
      'function show(x: string | integer) {\n  say x.trim\n}\nshow("a")\nshow(1)\nexit\n',
      "Call the trim method with parentheses.",
    ],
    ['function show(x) {\n  say x.size\n}\nshow("a")\nshow(1)\nexit\n', "Use the length property."],
    [
      'function show(x: string?) {\n  say x.trim\n}\nshow("a")\nshow(null)\nexit\n',
      "Call the trim method with parentheses.",
    ],
    // (Astra on #1273: a fallback the fix would write where the value divides, as a divisor, through a calculation or a
    // member, where a written zero stops the run)
    ...[
      "let xs = [4, null]\nsay 1 / xs[1]\nexit\n",
      "let xs = [4, null]\nsay 7 % xs[1]\nexit\n",
      "let xs = [4, null]\nsay 1 / (xs[1] * 2)\nexit\n",
      'let xs = ["ab", null]\nsay 4 / xs[1].length\nexit\n',
    ].map(
      (source) =>
        [
          source,
          "or give a fallback after 'otherwise' that does not lead to a division by zero.",
        ] as const,
    ),
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
