import assert from "node:assert/strict";
import test from "node:test";
import type { BinaryExpression } from "../src/ast.js";
import { compileProject } from "../src/compiler.js";
import { createFreshRuntimeSession } from "../src/index.js";
import { parse } from "../src/parser.js";
import { someNode } from "../src/project-globals.js";
import { compareProjectPaths } from "../src/project-paths.js";
import { analyseCore } from "../src/type-inference/core/answers.js";
import { checkedResult, reportedDiagnostics } from "../src/type-inference/core/consumer.js";
import {
  coreMessage,
  messageSource,
  type MessageSource,
} from "../src/type-inference/core/messages.js";
import type { CheckedDiagnostic } from "../src/type-inference/core/result.js";
import { VALUE_KINDS } from "../src/value-kinds.js";
import { coreRequest, type SourceFile } from "./helpers/type-core-analysis.js";
import { pasteCases, pastedForms, pasteFailure, type Pasted } from "./helpers/type-core-paste.js";
import { heldBack, readFixture, type FixtureRecord } from "./helpers/type-core-fixture.js";
import { sentences } from "./helpers/type-core-oracles.js";

/** A diagnostic a rule found: a stop's own warning and marks (`budget`) name no fix and are never compared. */
type Compared = Exclude<CheckedDiagnostic, { readonly kind: "budget" }>;

/*
 * The new checker keeps every fix the current checker gives (#1195): on every record of the expectation set, the two
 * checkers' TSV diagnostics pair by file, line and code, and each fix sentence of the current checker's message is in
 * the new checker's, in the new form (`PORTS`), or the pair is one of the intended differences (`INTENDED`); and the
 * code the fixes suggest compiles where it stands. Severity is not compared: where the current checker errs and the
 * new one warns for a possible null or a union value, the narrowing step (#1073) brings the error. When the current
 * checker is removed (#1076), this compares with its messages captured before.
 */

/**
 * What the new checker's diagnostic names: its subject as the source writes it, a member, an operation's operands, the
 * statement a check would hold, and the declaration a fix rewrites.
 */
interface Named {
  readonly subject: string;
  /** A member as its code writes it: `.length`, `.get(...)`; empty for any other rule. */
  readonly member: string;
  readonly operands: readonly string[];
  /** The text of the use's statement a check may hold (`MessageSource.statement`), or `null`. */
  readonly statement: string | null;
  /** The text of the declaration of the place a store's or a literal's fix declares, or `null`. */
  readonly declared: string | null;
  /**
   * Whether the fix's code is taken as proved where it stands (TABLE r4.162): so in a pair, and not in the words that an
   * unproved fact gives (`INTENDED`, `unproved`).
   */
  readonly proved: boolean;
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

/** A fallback in words (TABLE r4.162): after 'otherwise', also one that does not divide by zero. */
const FALLBACK_WORDS = " after 'otherwise'(?: that does not lead to a division by zero)?\\.";

/** A fallback the current checker writes as `...`, in words (#1268: no code that does not compile). */
const SAME_TYPE = "or give a fallback of the same type with 'otherwise'.";

/** A written type in words, as a sentence names a value of it: `integer | string` as `a whole number (integer) or …`. */
const typeWords = (type: string): string => {
  const names = type.endsWith("?") ? [type.slice(0, -1), "null"] : type.split(" | ");
  // (a whole number among numbers is one of them, V30 §2)
  const words = names
    .filter((name) => name !== "integer" || !names.includes("number"))
    .map((name) => Object.entries(VALUE_KINDS).find(([kind]) => kind === name)![1].description);
  return words.length < 3
    ? words.join(" or ")
    : `${words.slice(0, -1).join(", ")}, or ${words.at(-1)!}`;
};

/**
 * The check of a subject (ADR 0021 rules 1.9 and 3.5): of a variable directly, of any other value kept in a new variable
 * first, its `let` shown where its own text may stand in code; around the use's statement where it is code on one line
 * and reads a kept value once, else the test in words (#1268, TABLE r4.146). Without the closing period.
 */
const checkForm = (subject: string, test: string, statement: string | null): string => {
  const words = test === "!= null" ? "is not null" : `is ${typeWords(test.slice("is ".length))}`;
  const held = statement !== null && ownText(statement) ? statement : null;
  if (/^[A-Za-z_]\w*$/.test(subject))
    return held === null
      ? `Check that '${subject}' ${words} first`
      : `Check '${subject}' first, as in 'if ${subject} ${test} { ${held} }'`;
  // (the kept value's `let` only with the check that holds the statement: it moves the read)
  const kept =
    held !== null && ownText(subject) && held.split(subject).length === 2
      ? held.replace(subject, "value")
      : null;
  return kept === null
    ? `Keep '${subject}' in a new variable and check that it ${words} first`
    : `Keep '${subject}' in a new variable, as in 'let value = ${subject}', and check it, as in ` +
        `'if value ${test} { ${kept} }'`;
};

/**
 * A fallback's alternative: its code where `codeAt` holds, else after 'otherwise' in words (where the value may divide or
 * reads what may be absent); where unproved also of the same type in words (TABLE r4.162).
 */
const fallbackForm = (fallback: string, proved: boolean): RegExp =>
  code(
    proved
      ? `or give a fallback(?:, as in '${fallback}'\\.|${FALLBACK_WORDS})`
      : `(?:or give a fallback(?:, as in '${fallback}'\\.|${FALLBACK_WORDS})|${escaped(SAME_TYPE)})`,
  );

/**
 * A declaration as the new checker writes it (#1268, TABLE r4.146), from the current checker's `let n: T = ...` or
 * `n: T`: the source's own declaration with that type, its start value from its `=`, where it is code on one line;
 * else the type in words. `subject`: the place as the sentence names it.
 */
const declarationForm = (fix: string, declared: string | null, subject: string): string => {
  const [, head = "", type = ""] =
    /^((?:let |global )?[A-Za-z_]\w*): (.+?)(?: = .*)?$/.exec(fix) ?? [];
  if (declared === null || !ownText(declared))
    return `declare ${subject === "the parameter" ? `the parameter '${head}'` : subject} with the type '${type}'`;
  const start = declared.indexOf("=");
  return `declare ${subject} as '${head}: ${type}${start === -1 ? "" : ` ${declared.slice(start)}`}'`;
};

const PORTS: readonly Port[] = [
  // ADR 0021 rules 1.9 and 3.5: the check, of a variable, or of the subject kept in a variable first, its `let` shown
  // where its own text may stand in code (the owner's review)
  // (a fallback's code where its predicate holds, else in words: where the value may divide, or reads what may be
  // absent, TABLE r4.162)
  {
    from: /^Check it first: if (\S+) != null \{ \.\.\. \}, or give a fallback: \1 otherwise (.+)$/,
    to: ([, name, value], { statement, proved }) =>
      value === "..."
        ? exact(`${checkForm(name!, "!= null", statement)}, ${SAME_TYPE}`)
        : form(
            `${checkForm(name!, "!= null", statement)}, `,
            fallbackForm(grouped(`${name} otherwise ${value}`), proved),
          ),
  },
  {
    from: /^Check it first: if (\S+) (!= null|is .+) \{ \.\.\. \}$/,
    to: ([, name, test], { statement }) => exact(`${checkForm(name!, test!, statement)}.`),
  },
  {
    from: /^Keep it in a variable and check it first, as in: if value != null \{ \.\.\. \}, or give a fallback: value otherwise (.+)$/,
    to: ([, value], { subject, statement, proved }) =>
      ownText(subject) && value === "..."
        ? exact(`${checkForm(subject, "!= null", statement)}, ${SAME_TYPE}`)
        : ownText(subject)
          ? form(
              `${checkForm(subject, "!= null", statement)}, `,
              fallbackForm(`\\(?${grouped(subject)} otherwise ${escaped(value!)}\\)?`, proved),
            )
          : exact(`${checkForm(subject, "!= null", statement)}.`),
  },
  {
    from: /^Keep it in a variable and check it first, as in: if value (!= null|is .+) \{ \.\.\. \}$/,
    to: ([, test], { subject, statement }) => exact(`${checkForm(subject, test!, statement)}.`),
  },
  // C13 (S9b): a method argument's conversion, in the words of its contract's own fix (`argumentFix`)
  {
    from: /^Convert the (value|number|text) with the (toString|toInteger) function(, which drops the fraction)?\.$/,
    to: (found) => exact(found[0]),
  },
  // #1195's decided texts; a condition's advice always, its example only of a stable path (Astra r3)
  {
    from: /^Compare it instead, such as '(.+)'\.$/,
    to: ([, fix], { subject, proved }) =>
      exact(
        proved && stablePath(subject)
          ? `Compare it instead, as in '${fix}'.`
          : "Compare it instead.",
      ),
  },
  {
    from: /^Check its length instead, such as '(.+)'\.$/,
    to: ([, fix], { subject, proved }) =>
      exact(
        proved && stablePath(subject)
          ? `Check its length instead, as in '${fix}'.`
          : "Check its length instead.",
      ),
  },
  {
    from: /^Show one of its properties instead\.$/,
    // (the value in place wherever its own text may stand in code, #1268)
    to: (_, { subject, proved }) =>
      proved && ownText(subject)
        ? form(
            "Show one of its properties instead, as in '${",
            code(grouped(subject)),
            code("\\.[A-Za-z_]\\w*"),
            "}'.",
          )
        : exact("Show one of its properties instead."),
  },
  {
    from: /^Show its elements with 'toList\(\)\.join\(\)' instead\.$/,
    to: (_, { subject, proved }) =>
      proved && ownText(subject)
        ? form("Show all its elements with '${", code(grouped(subject)), ".toList().join()}'.")
        : exact("Show its elements with the toList and join methods instead."),
  },
  // (the operand that is not text, as the source writes it, never the chain rebuilt: the owner's review)
  {
    from: /^Put the value in the text instead, as in "(.+)"\.$/,
    to: (_, { operands, proved }) =>
      proved && operands.some(ownText)
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
    // (no key the script does not name; every value in place, #1268)
    to: (_, { subject, proved }) =>
      proved && ownText(subject)
        ? form(
            "Select one value with a key, or show every value with '${",
            code(grouped(subject)),
            ".values.join()}'.",
          )
        : exact(
            "Select one value with a key, or show every value with the values and join methods.",
          ),
  },
  {
    from: /^To allow (both|null), declare (it|the parameter) as '(.+)'\.$/,
    // (a default's or fallback's place named, ADR 0021 rule 7.3)
    to: ([, allow, it, fix], { declared }) => {
      // (the place as the sentence names it: `it`, the parameter, or a fallback's place by its name)
      const name = /[A-Za-z_]\w*(?=:)/.exec(fix!)?.[0] ?? "";
      const subjects = [it!, `'${name}'`].map((subject) =>
        escaped(declarationForm(fix!, declared, subject)),
      );
      return form(code(`[Tt]o allow ${allow}, (?:${subjects.join("|")})`), ".");
    },
  },
  {
    from: /^To keep both, declare a union type, as in '(.+)'\.$/,
    // (TSV044: on the literal's variable, else the type alone, the owner's review; a list join's, of which the fixture
    // holds none: the current checker's placeholder on an operand's variable, the new checker's the declaration the join
    // starts, else the type in words, #1268, #1272; pasted, the current checker rejects that declaration, #1412)
    to: ([, fix], { declared }) =>
      exact(
        fix!.startsWith("let values: ")
          ? `To allow both, declare it as '${fix!.slice("let values: ".length, -" = ...".length)}'.`
          : `To allow both, ${declarationForm(fix!, declared, "it")}.`,
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
    // (the value in place wherever its own text may stand in code, #1268)
    to: (_, { subject, proved }) =>
      exact(
        proved && ownText(subject)
          ? `To show '${subject}' as text, write '"\${${subject}}"'.`
          : "To show the value as text, put it in a text.",
      ),
  },
  { from: /^Use a separate property for a value of another type\.$/, to: ([text]) => exact(text) },
  { from: /^Its (only property is|properties are) (.+)\.$/, to: ([text]) => exact(text) },
  { from: /^Did you mean '(.+)'\?$/, to: ([text]) => exact(text) },
  {
    from: /^Write a number key as text, as in "(.+)"\.$/,
    to: (_, { subject, proved }) =>
      exact(
        proved && stablePath(subject)
          ? `Write a number key as text, as in '"\${${subject}}"'.`
          : "Write a number key as text.",
      ),
  },
  {
    from: /^Check '(.+)\.length' first\.$/,
    // (around the read's statement where it is code on one line, and reads a kept value once, #1268)
    to: (_, { subject, statement }) => {
      const held = statement !== null && ownText(statement) ? statement : null;
      const kept =
        held !== null && held.split(subject).length === 2 ? held.replace(subject, "value") : null;
      return exact(
        stablePath(subject)
          ? held === null
            ? `Check the length of '${subject}' first.`
            : `Check '${subject}.length' first, as in 'if ${subject}.length > 0 { ${held} }'.`
          : ownText(subject) && kept !== null
            ? `Keep '${subject}' in a new variable, as in 'let value = ${subject}', and check its length, as ` +
              `in 'if value.length > 0 { ${kept} }'.`
            : `Keep '${subject}' in a new variable and check its length first.`,
      );
    },
  },
  { from: /^Give '(.+)' one type in every element\.$/, to: ([text]) => exact(text) },
  // members of a type without them
  {
    from: /^Convert it to text first with toString\(\.\.\.\)\.$/,
    // (a property read of a stable path whole; else the receiver's conversion in its place, #1268)
    to: (_, { subject, member, proved }) =>
      exact(
        proved && stablePath(subject) && !member.endsWith("(...)")
          ? `Convert '${subject}' to text first, as in 'toString(${subject})${member}'.`
          : proved && ownText(subject)
            ? `Convert '${subject}' to text first with 'toString(${subject})'.`
            : "Convert the value to text first with the toString function.",
      ),
  },
  {
    from: /^Divide it by a unit, as in '.+ \/ 1 (\w+)'\.$/,
    to: ([, unit], { subject, proved }) =>
      proved && stablePath(subject)
        ? // (in parentheses where it stands for the member, #1268)
          form(
            `Divide '${subject}' by a unit, as in '`,
            code(grouped(`${subject} / 1 ${unit}`)),
            "'.",
          )
        : exact(
            proved
              ? `Divide '${subject}' by a unit, such as '1 ${unit}'.`
              : "Divide the duration by a unit of time instead.",
          ),
  },
  {
    from: /^Use 'contains\(\.\.\.\)' instead\.$/,
    to: () => exact("Use the contains method instead."),
  },
  {
    from: /^Use length, first, last, or random\.$/,
    // (in words: each has its own type, which the read's use may not take, Codex r4)
    to: () => exact("Use one of its properties instead: length, first, last, or random."),
  },
  {
    from: /^Assign a new text to the variable instead\.$/,
    to: (_, { subject }) => exact(`Assign a new text to '${subject}' instead.`),
  },
  // a speaker's property: the receiver as the source writes it (S9b's speaker flow names the speaker, below), without a
  // value to write (#1268)
  {
    from: /^Assign it before this line, as in '(.+) = \.\.\.'\.$/,
    to: ([, property]) => exact(`Assign '${property}' before this line.`),
  },
  {
    from: /^Copy the player profile before this line, as in '(.+)' at the start of the script, or assign '(.+)' first\.$/,
    to: ([text]) => exact(text),
  },
  {
    from: /^Use one of its properties instead, such as '(.+)'\.$/,
    // (no property named: a speaker has those its script gives it, Codex r4)
    to: () => exact("Use one of its properties instead."),
  },
  // date and time operators and fields: an example where the value it converts is a variable or a path, the other
  // operand one or a quantity, else the sentence alone
  {
    from: /^Write '\d+ calendar (?:day|week)s?'\.$/,
    to: ([text], { proved }) =>
      exact(proved ? text! : "A date moves only by calendar units, such as calendar days."),
  },
  {
    from: /^Convert it first, as in '(.+)', or use calendar units to keep the clock time\.$/,
    to: (_, { operands: [left = "", right = ""], proved }) =>
      proved && stablePath(left) && (stablePath(right) || quantity(right))
        ? form(
            `Convert it first, as in '(${left}.toAbsoluteDateTime() `,
            code("[-+]"),
            ` ${right}).toDateTime()', or use calendar units to keep the clock time.`,
          )
        : exact(
            "Convert it with the toAbsoluteDateTime method first, or use calendar units to keep the clock time.",
          ),
  },
  {
    from: /^Convert it first, as in '\(.+\)\.toAbsoluteDateTime\(\)'\.$/,
    to: (_, { operands: [left = "", right = ""], proved }) =>
      proved && stablePath(left) && (stablePath(right) || quantity(right))
        ? form(
            `Convert it first, as in '(${left}.toDateTime() `,
            code("[-+]"),
            ` ${right}).toAbsoluteDateTime()'.`,
          )
        : exact("Convert it with the toDateTime method first."),
  },
  {
    from: /^Convert it first, as in '.+\.toDateTime\(\)\.(\w+)'\.$/,
    to: ([, field], { subject, proved }) =>
      exact(
        proved && stablePath(subject)
          ? `Convert '${subject}' first, as in '${subject}.toDateTime().${field}'.`
          : `Convert '${subject}' with the toDateTime method first.`,
      ),
  },
  { from: /^Write '(.+)'\.$/, to: ([text]) => exact(text) },
  {
    from: /^(Compare|Divide) two calendar durations, or two durations\.$/,
    to: ([text]) => exact(text),
  },
  {
    from: /^Compare its date, as in 'toDate\((.+)\)'\.$/,
    to: (_, { operands: [, right = ""], proved }) =>
      exact(
        proved && stablePath(right)
          ? `Compare its date, as in 'toDate(${right})'.`
          : "Compare its date with the toDate function.",
      ),
  },
  {
    from: /^Combine it with a date first, as in '(.+)'\.$/,
    to: () => exact("Combine it with a date first, with the toDateTime function."),
  },
  {
    from: /^Subtract their dates with '(.+)', or convert both with toAbsoluteDateTime\(\) for the elapsed time\.$/,
    to: (_, { operands: [left = "", right = ""], proved }) =>
      exact(
        `Subtract their dates with ${proved && stablePath(left) && stablePath(right) ? `'toDate(${left}) - toDate(${right})'` : "the toDate function"}, ` +
          "or convert both with the toAbsoluteDateTime method for the elapsed time.",
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
    // (each with its own type, which the read's use may not take: in words, Codex r4 on #1268)
    to: ([, names]) =>
      exact(
        `Use one of the dict's ${names!.startsWith("length") ? "properties" : "methods"} instead: ${names!}.`,
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

/** A message's fix sentences: each after its first sentence that names a fix, as the review found them. */
function fixes(message: string): string[] {
  return sentences(message)
    .slice(1)
    .filter((sentence) => FIX.test(sentence) && !sentence.startsWith("If it"));
}

/** What a diagnostic names, in the source's own text. */
function namedBy(diagnostic: Compared, source: MessageSource): Named {
  if (diagnostic.kind === "written-type" || diagnostic.kind === "static")
    return {
      subject: source.text(diagnostic.site),
      member: "",
      operands: [],
      statement: null,
      declared: null,
      proved: true,
    };
  const { rule } = diagnostic;
  const subject =
    rule.rule === "member"
      ? rule.receiver
      : rule.rule === "selection"
        ? rule.collection
        : source.text(diagnostic.site);
  // (the subject the use reads: its first text inside the use's own)
  const read = source.text(diagnostic.site).indexOf(subject);
  const statement =
    read === -1
      ? null
      : source.statement(diagnostic.site, {
          file: diagnostic.site.file,
          start: diagnostic.site.start + read,
          end: diagnostic.site.start + read + subject.length,
        });
  const root =
    rule.rule === "store" || rule.rule === "fallback" || rule.rule === "mixed" ? rule.root : null;
  return {
    subject,
    member:
      rule.rule !== "member"
        ? ""
        : rule.member.endsWith("()")
          ? `${rule.member.slice(0, -2)}(...)`
          : rule.member,
    operands: rule.rule === "operator" ? rule.operands.map((site) => source.text(site)) : [],
    statement: statement === null ? null : source.text(statement),
    declared: root === null || root.site === null ? null : source.text(root.site),
    proved: true,
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
    diagnostic.kind !== "static" &&
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
    diagnostic.kind !== "static" &&
    diagnostic.kinds.includes("null") &&
    !/\bnull\b/.test(message);
  return (subject ? 2 : 0) + (kinds ? 1 : 0) - (unnamedNull ? 1 : 0);
}

/**
 * The pairs of the records' diagnostics: the expectation set's, or others of the same shape. `each` sees the analysis
 * of each record that parses and resolves: every diagnostic, before the consumer reports some, and their source.
 */
function pairs<Analysed extends { readonly name: string; readonly files: readonly SourceFile[] }>(
  records: readonly Analysed[],
  each?: (
    record: Analysed,
    diagnostics: readonly CheckedDiagnostic[],
    source: MessageSource,
  ) => void,
): Pair[] {
  const found: Pair[] = [];
  for (const record of records) {
    const files = [...record.files].sort((a, b) => compareProjectPaths(a.path, b.path));
    const request = coreRequest(files);
    if (request === null) continue;
    const answers = analyseCore(request);
    // (with the checks that owe the runtime nothing, as the compiler reports them: decision 3 on #1072)
    const { diagnostics } = checkedResult(answers, request);
    const source = messageSource(
      files.map((file) => file.source),
      diagnostics,
    );
    each?.(record, diagnostics, source);
    const core = new Map<string, { diagnostic: Compared; message: string; named: Named }[]>();
    for (const diagnostic of reportedDiagnostics(answers, diagnostics)) {
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
        // (a check that owes the runtime nothing keeps the current checker's sentence, the one its shared rule gives
        // the runtime too: each fix as it is written, decision 3 on #1072)
        if (best.diagnostic.kind === "static") return { fix, form: exact(fix) };
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

/** The expectation set's records, their pairs, and the sentences of the records on the positive list. */
interface Analysis {
  readonly records: readonly FixtureRecord[];
  readonly pairs: Pair[];
  /** Each record `heldBack` keeps that parses and resolves: every diagnostic's sentence. */
  readonly sentences: ReadonlyMap<FixtureRecord, readonly string[]>;
}

function analysis(): Analysis {
  const records = readFixture();
  const sentences = new Map<FixtureRecord, string[]>();
  const found = pairs(records, (record, diagnostics, source) => {
    // (the sentences the core composes: a check that owes the runtime nothing gives its shared rule's, the runtime's
    // own, which shows a text value as the runtime does)
    if (heldBack(record) === null)
      sentences.set(
        record,
        diagnostics
          .filter((diagnostic) => diagnostic.kind !== "static")
          .map((diagnostic) => coreMessage(diagnostic, source)),
      );
  });
  return { records, pairs: found, sentences };
}

/** The expectation set's analysis, made once for the tests below. */
let made: Analysis | null = null;
const analysed = (): Analysis => (made ??= analysis());
const allPairs = (): Pair[] => analysed().pairs;

const ROUND = "Round the number with the floor, round or ceil function first.";

/** The type test of a subject (ADR 0021 rule 3.5), as `checkForm` writes it: in code, or in words (TABLE r4.162). */
const typeTest = ({ subject, statement }: Named, type: string): RegExp =>
  code(
    `(?:${escaped(`${checkForm(subject, `is ${type}`, statement)}.`)}|` +
      `${escaped(`${checkForm(subject, `is ${type}`, null)}.`)})`,
  );

/**
 * Each fix of a pair as the new checker words it where its code is not proved (TABLE r4.162): its port's form with no
 * statement a check holds, no declaration and no proof; `null` where no port takes it.
 */
const unproved = (pair: Pair): (RegExp | null)[] =>
  pair.forms.map(({ fix }) => {
    const port = PORTS.find((found) => found.from.test(fix));
    return port === undefined
      ? null
      : port.to(port.from.exec(fix)!, {
          ...pair.named,
          statement: null,
          declared: null,
          proved: false,
        });
  });

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
      "TABLE r4.162: the new checker's code stands only where it is proved where it is pasted (no other diagnostic in " +
      "the author's text it holds, a check that holds at its use), else its words: under-offers, a note (N)",
    matches: (pair) => {
      const words = unproved(pair);
      return pair.forms.every(
        ({ form }, index) =>
          form?.test(pair.message) === true || words[index]?.test(pair.message) === true,
      );
    },
    // (the fix in words where its code is not)
    replacement: (pair) =>
      unproved(pair)[pair.forms.findIndex(({ form }) => form?.test(pair.message) !== true)] ??
      /(?!)/,
    count: 17,
  },
  {
    rule:
      "S9b's G2 (the sentence review of #1437): a compound assignment's target that is no variable is checked where " +
      "it stands, in words, never kept in a new variable, which would take the change instead",
    matches: ({ message, named }) =>
      !/^[A-Za-z_]\w*$/.test(named.subject) &&
      new RegExp(`Check that '${escaped(named.subject)}' is [^.']+ first\\.`).test(message),
    replacement: ({ named }) =>
      new RegExp(`Check that '${escaped(named.subject)}' is [^.']+ first\\.`),
    count: 1,
  },
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
      diagnostic.kind !== "static" &&
      (diagnostic.rule.rule === "count" ||
        ((diagnostic.rule.rule === "store" || diagnostic.rule.rule === "fallback") &&
          diagnostic.rule.type.includes("integer") &&
          diagnostic.kinds.includes("number"))),
    // (its sentences as they stand until S8c: rounding, a whole number, a fallback of the type, an unknown's test)
    replacement: ({ diagnostic, named }) =>
      diagnostic.kind === "written-type" || diagnostic.kind === "static"
        ? exact("Use a whole number here.")
        : diagnostic.rule.rule === "fallback"
          ? exact("Use null or a value of that type instead.")
          : diagnostic.kinds.includes("number")
            ? exact(ROUND)
            : diagnostic.kinds.includes("unknown")
              ? typeTest(named, "integer")
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
    replacement: ({ record, named }) => typeTest(named, UNION_TESTS.get(record)!),
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
    replacement: ({ record, named }) => typeTest(named, UNKNOWN_TESTS.get(record)!),
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
          ? `Assign '${named.subject}${named.member}' before this line.`
          : "Assign the property before this line.",
      ),
    count: 5,
  },
  {
    rule:
      "#1268: beside another type of the value that the use does not take (a union), a fallback for null alone leaves " +
      "the use invalid, so the new checker names none in code",
    matches: ({ current, diagnostic }) =>
      diagnostic.class === "warning-runtime-check" &&
      diagnostic.besides.length > 0 &&
      / otherwise (?!\.\.\.$)\S/.test(current),
    replacement: () => exact(SAME_TYPE),
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

test("every sentence of the set's records keeps the form: code in single quotes, no semicolon, the word never shown (D1)", (t) => {
  const { records, sentences } = analysed();
  let count = 0;
  for (const record of records) {
    if (heldBack(record) !== null) continue;
    const texts = sentences.get(record);
    assert.ok(texts !== undefined, `${record.name}: the files parse and resolve`);
    for (const text of texts) {
      count += 1;
      // (code is quoted whole, so outside the quotes no semicolon, backquote or double quote stands)
      assert.ok(!/[;`"]/.test(text.replace(/'[^']*'/g, "")), `${record.name}: ${text}`);
      assert.ok(!/dead-code|deferred-parameter|unmodelled/.test(text), `${record.name}: ${text}`);
      // (#1195 rule 2: no implementation terms, "type" never "kind")
      assert.ok(
        !/\b(compiler|follows?|kinds?)\b/.test(text.replace(/'[^']*'/g, "")),
        `${record.name}: ${text}`,
      );
      assert.ok(text.endsWith("."), `${record.name}: ${text}`);
    }
  }
  t.diagnostic(`${count} sentences of the positive list`);
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
    const { diagnostics } = analyseCore(request);
    const text = messageSource([source], diagnostics);
    return diagnostics.map((diagnostic) => coreMessage(diagnostic, text));
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
 * says. A declaration is whole, with its start value (#1268, TABLE r4.146).
 */
const REPAIRS: readonly (readonly [string, RegExp, (readonly string[])?])[] = [
  // date and time operators, composed operands grouped, also as a warning
  [
    'let t = toAbsoluteDateTime("2026-01-01T00:00:00Z")\nlet u = t + 1 s\nsay ⟦u + 1 calendar day⟧\nexit\n',
    /as in '([^']*)'/,
  ],
  ['let t = toDateTime("2026-01-01T00:00:00")\nsay ⟦t + 1 s⟧\nexit\n', /as in '([^']*)'/],
  ['let day = toDate("2026-10-23")\nsay day + ⟦1 day⟧\nexit\n', /Write '([^']*)'/],
  [
    'let day = toDate("2026-10-23")\nlet d = toDateTime("2026-10-23T12:00:00")\nsay day < ⟦d⟧\nexit\n',
    /as in '([^']*)'/,
  ],
  // members of a kind without them, on a composed receiver
  [
    'let t = toAbsoluteDateTime("2026-01-01T00:00:00Z")\nlet u = t + 1 s\nsay ⟦u.year⟧\nexit\n',
    /as in '([^']*)'/,
  ],
  ["let d = 1 s+2 s\nsay ⟦d.seconds⟧\nexit\n", /as in '([^']*)'/, ["3"]],
  // (a divisor's place takes the number, Codex r4's words where no fact proved it before `codeAt`'s site, #1268)
  ["let d = 2 s\nsay 4 / ⟦d.seconds⟧\nexit\n", /as in '([^']*)'/, ["2"]],
  // (#1268: the value in place, read once, where its own text may stand in code: a receiver that is no stable path, a
  // literal or an expression shown or stored as text)
  ["let ns = [12, 13]\nsay ⟦ns.random⟧.length\nexit\n", /with '([^']*)'/],
  ["let caption: string = ⟦1⟧\nsay caption\nexit\n", /write '([^']*)'/, ["1"]],
  ["let caption: string = ⟦true⟧\nsay caption\nexit\n", /write '([^']*)'/, ["true"]],
  ["let n = 1\nlet caption: string = ⟦n + 1⟧\nsay caption\nexit\n", /write '([^']*)'/, ["2"]],
  ['say "⟦${set[4, 7]}⟧"\nexit\n', /with '([^']*)'/, ["4, 7"]],
  ['say "⟦${dict{a: 1}}⟧"\nexit\n', /with '([^']*)'/, ["1"]],
  ['let d = dict{a: 1}\nsay "⟦${d}⟧"\nexit\n', /with '([^']*)'/, ["1"]],
  ['let s = "a"\nif ⟦s⟧ { say "x" }\nexit\n', /as in '([^']*)'/, ["x"]],
  ["let n = 1\nsay ⟦n.length⟧\nexit\n", /as in '([^']*)'/],
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
  // a stable path through an index variable (TABLE §13 N1, Astra r2), in a fix the predicate does not test
  // the null check's fallback, of a kept value and of a composed one; a warning's read by an index, which its program
  // already performs there, wrapped in place (TABLE r4.168)
  ["let xs = [7, null]\nsay ⟦xs[0]⟧ + 1\nexit\n", /fallback, as in '([^']*)'/, ["8"]],
  [
    "let xs = [4, null]\nlet v: integer = ⟦xs[1]⟧\nsay v\nexit\n",
    /fallback, as in '([^']*)'/,
    ["0"],
  ],
  [
    'let x: integer? = null\nlet y: integer? = null\nif askBoolean "x" { x = 1 }\nrepeat (⟦x otherwise y⟧) {}\nexit\n',
    /fallback, as in '([^']*)'/,
  ],
  // the declarations a union or null widens (ADR 0021 rules 1.1, 1.2, 1.3, 1.7, 7.3), each start value as written, the
  // author's own, which the declaration adds no read of (TABLE r4.160, r4.168): a literal (Astra on #1273), a call, a
  // global's `default:`, a parameter's default, a list literal, a fallback
  ['⟦let mood = 1⟧\nmood = "happy"\nsay mood\nexit\n', /as '([^']*)'/, ["happy"]],
  [
    'function make { return 1 }\n⟦let mood = make()⟧\nmood = "happy"\nsay mood\nexit\n',
    /as '([^']*)'/,
    ["happy"],
  ],
  ['⟦global g = 1, default: 2⟧\ng = "x"\nsay g\nexit\n', /as '([^']*)'/, ["x"]],
  ['⟦let d = dict{a: 1}⟧\nd["b"] = "x"\nsay d["b"]\nexit\n', /as '([^']*)'/, ["x"]],
  ['⟦let a = [1, "x"]⟧\nsay a.length\nexit\n', /as '([^']*)'/, ["2"]],
  ['function use(⟦n: integer⟧) { say n }\nuse("x")\nexit\n', /as '([^']*)'/, ["x"]],
  ['function use(⟦n: integer = [1][0]⟧) { say n }\nuse("x")\nexit\n', /as '([^']*)'/, ["x"]],
  ["let n = null\n⟦let whole: integer = n⟧\nexit\n", /as '([^']*)'/],
  ['let source = ["s"]\n⟦let copy = source.removeAt(0)⟧\ncopy = 2\nexit\n', /as '([^']*)'/],
  [
    '⟦let result: integer = load("count", default: ["bad"].last)⟧\nsay result\nexit\n',
    /as '([^']*)'/,
  ],
  [
    'let y: integer? = null\n⟦let x: integer = y otherwise "a"⟧\nsay x\nexit\n',
    /as '([^']*)'/,
    ["a"],
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
  [
    'let t = "hello"\nfor i in 1..⟦t.size⟧ {\n  say i\n}\nexit\n',
    /Use '([^']*)'/,
    ["1", "2", "3", "4"],
  ],
  ['let t = "hello"\nsay ⟦t.toUpperCase()⟧\nexit\n', /Use '([^']*)'/, ["HELLO"]],
  ['let t = "hello"\nsay ⟦t.length()⟧\nexit\n', /Write '([^']*)'/, ["5"]],
  ['let t = " hello "\nsay ⟦t.trim⟧\nexit\n', /Write '([^']*)'/, ["hello"]],
  ['let items = ["a", "b"]\nsay ⟦items.join⟧\nexit\n', /Write '([^']*)'/],
  ['let box = {items: ["a", "b"]}\nsay ⟦box.items.join⟧\nexit\n', /Write '([^']*)'/],
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
  // an argument of a parameter without a type, as its body takes it, also through its result (Codex r7, TABLE r4.160)
  [
    'let t = "hello"\nfunction show(p) {\n  say p\n}\nshow(⟦t.size⟧)\nexit\n',
    /Use '([^']*)'/,
    ["5"],
  ],
  [
    'let t = "hello"\nfunction count(p) {\n  return p + 1\n}\nsay count(⟦t.size⟧)\nexit\n',
    /Use '([^']*)'/,
    ["6"],
  ],
  // a fallback the fix writes (ADR 0021 rule 1.9) where the value does not divide, and a receiver's in parentheses
  // (Astra on #1273)
  [
    "function half(x: integer?) {\n  say ⟦x⟧ / 2\n}\nhalf(4)\nhalf(null)\nexit\n",
    /fallback, as in '([^']*)'/,
    ["2", "0"],
  ],
  [
    'function size(t: string?) {\n  say ⟦t⟧.length\n}\nsize("ab")\nsize(null)\nexit\n',
    /fallback, as in '([^']*)'/,
    ["2", "0"],
  ],
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
    const { diagnostics } = analyseCore(request);
    const text = messageSource([source], diagnostics);
    const found = diagnostics
      .map((diagnostic) =>
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
 * code form its fix offers pasted at its own position compiles and runs to its end through it, a store that receives an
 * answer among them (#1586). The whole family, every offer at every site, is the step's evidence outside CI.
 */
test("every code form a fix offers compiles and runs where pasted, on the paste family's sample (TABLE r4.151)", () => {
  const failures: string[] = [];
  let pasted = 0;
  for (const { name, source, start, end } of pasteCases(true)) {
    const { diagnosed, forms } = pastedForms(source, start, end);
    if (!diagnosed) failures.push(`${name}: no error at the expression`);
    for (const form of forms) {
      pasted += 1;
      const failure = pasteFailure(form);
      if (failure !== null) failures.push(`${name}: '${form.code}': ${failure}`);
    }
  }
  assert.deepEqual(failures, []);
  assert.ok(pasted > 0, `${pasted} forms pasted`);
});

test("a pasted form counts as run only where its run ends through it, answered where it asks (#1586)", () => {
  const pasted = (source: string, code: string): Pasted => {
    const start = source.indexOf(code);
    return { code, source, at: { start, end: start + code.length } };
  };
  // (a failure after a valid answer)
  const canary = 'let answer = askInteger("Number?")\nsay 1 / (answer - answer)\nexit\n';
  assert.match(pasteFailure(pasted(canary, "1 / (answer - answer)")) ?? "", /"code":"TSR036"/);
  // (a prompt's code, which runs before the answer and counts once the run has ended, Codex r1 on #1589)
  const prompt = 'let t = "hello"\nlet answer = askInteger("${t.length}")\nexit\n';
  assert.equal(pasteFailure(pasted(prompt, "t.length")), null);
  // (a button's label, whose statement ends where it waits, in a run before the last)
  const button = 'let t = "hello"\nshowButton "${t.length}"\nexit\n';
  assert.equal(pasteFailure(pasted(button, "t.length")), null);
  // (a list's addition that receives the answer, as the family's duration stores do)
  const added =
    'let ps: duration[] = [1 s]\nps.add((askInteger("How many?")) s)\nsay ps.length\nexit\n';
  assert.equal(pasteFailure(pasted(added, '(askInteger("How many?")) s')), null);
  // (code in a branch the answer does not take)
  const skipped = 'let n = askInteger("How many?")\nif n > 5 {\n  say n * 1 s\n}\nexit\n';
  assert.equal(
    pasteFailure(pasted(skipped, "n * 1 s")),
    "unreached: the run ended without executing 'n * 1 s'",
  );
  // (a run that still asks once its answers run out)
  const asking = 'repeat 5 {\n  say askInteger("Again?")\n}\nexit\n';
  assert.equal(
    pasteFailure(pasted(asking, 'askInteger("Again?")')),
    "incomplete execution: waiting for number after 4 completions",
  );
});

/**
 * Codex r1 and r2 on #1589: only the instruction that consumes a pasted form's evaluated operands shows the form ran,
 * the last the lowering emits for its statement and for each position on the way down that a run may skip
 * (`unevaluated` in `type-core-paste.ts`). A setup instruction with the same span runs before the operands, and one
 * around a skipped position runs too: at each position, taken through an answer's prompt, skipped, or pure, unproved.
 */
test("a pasted form counts as evaluated only where the instruction that consumes it ran (Codex r1 and r2 on #1589)", () => {
  const ask = 'askInteger("${t.length}")';
  const at = (source: string, code: string, from = 0): Pasted => {
    const start = source.indexOf(code, from);
    return { code, source, at: { start, end: start + code.length } };
  };
  const unproved = (position: string): string => `unproved evaluation: ${position}`;
  for (const [lines, outcome] of [
    [`say true and ${ask} > 0`, null],
    ["say false and t.length > 0", unproved("the right side of 'and'")],
    [`say false or ${ask} > 0`, null],
    ["say true or t.length > 0", unproved("the right side of 'or'")],
    [`let n: integer? = null\nsay n otherwise ${ask}`, null],
    ["let n: integer? = 2\nsay n otherwise t.length", unproved("the right side of 'otherwise'")],
    [`let ys = [1]\nsay ys.get(9, default: ${ask})`, null],
    ["let ys = [1]\nsay ys.get(0, default: t.length)", unproved("the default of 'get'")],
    [`let v = load "k", default: ${ask}\nsay v`, null],
    [
      'save 1 as "k"\nlet v = load "k", default: t.length\nsay v',
      unproved("the default of 'load'"),
    ],
    // (a parameter's default, which no answer can stand in, TSV032, in a function, whose own instruction comes before
    // its parameters)
    ...["f()", "f(3)"].map(
      (call) =>
        [
          `function f(p = t.length) {\n  say p\n}\n${call}`,
          unproved("its 'functionDeclaration' emits its own instruction before its operands"),
        ] as const,
    ),
  ] as const)
    assert.equal(pasteFailure(at(`let t = "hello"\n${lines}\nexit\n`, "t.length")), outcome, lines);
  // (a statement with no instruction of its own span, whose condition, subject or cases nothing shows evaluated: an
  // `if`; a switch, also at a case's later value, which only a literal can be, TSV047, tested and not)
  assert.equal(
    pasteFailure(at('let t = "hello"\nif t.length > 2 {\n  say "yes"\n}\nexit\n', "t.length")),
    unproved("no instruction has the span of its 'ifStatement'"),
  );
  for (const subject of ["5", "1"]) {
    const source = `switch ${subject} {\n  case 1, 5 {\n    say "case"\n  }\n}\nexit\n`;
    assert.equal(
      pasteFailure(at(source, "5", source.indexOf("case"))),
      unproved("no instruction has the span of its 'switchStatement'"),
    );
  }
  // (the reviews' witnesses, through the fix the core offers: a skipped right side, Codex r1; an exit in an earlier
  // operand, plain and at each position a run may skip, and the call returning, Codex r2)
  const offered = (source: string): readonly (readonly [string, string | null])[] => {
    const start = source.indexOf("t.size");
    return pastedForms(source, start, start + "t.size".length).forms.map(
      (form) => [form.code, pasteFailure(form)] as const,
    );
  };
  assert.deepEqual(offered('let t = "hello"\nsay false and t.size > 0\nexit\n'), [
    ["t.length", unproved("the right side of 'and'")],
  ]);
  const stop =
    "function stop(p: integer): integer {\n  if p == 0 {\n    exit\n  }\n  return 1\n}\n";
  for (const body of [
    'say "${stop(@)}${t.size}"',
    'let h: messageHandle? = null\nlet chosen = h otherwise (say "${stop(@)}${t.size}")',
    'let chosen = true and ((say "${stop(@)}${t.size}") is messageHandle)',
    'let chosen = false or ((say "${stop(@)}${t.size}") is messageHandle)',
    'let ys: messageHandle[] = []\nlet chosen = ys.get(0, default: (say "${stop(@)}${t.size}"))',
  ])
    for (const [argument, outcome] of [
      ["0", "unreached: the run ended without executing 't.length'"],
      ["1", null],
    ] as const) {
      const source = `let t = "hello"\n${stop}${body.replace("@", argument)}\nexit\n`;
      assert.deepEqual(offered(source), [["t.length", outcome]], source);
    }
});

test("a join's pasted declaration is checked under the core alone at the joins its type receives, and the current checker's other join errors stand (#1412, Codex r12 and r13 on #1310)", () => {
  const pasted = (source: string, line: string): string | null => {
    const start = source.indexOf(line);
    const forms = pastedForms(source, start, start + line.length).forms.filter(
      (form) => form.declared !== undefined,
    );
    assert.equal(forms.length, 1, source);
    return pasteFailure(forms[0]!);
  };
  const objects = 'let a = [{n: 1}]\nlet b = [{n: "x"}]\n';
  assert.equal(pasted('let xs = [1]\nlet both = xs + ["x"]\nexit\n', 'xs + ["x"]'), null);
  // (a join of objects whose property differs, which the core misses, #1383: beside the declaration, and inside its
  // text where the declared type does not receive it)
  for (const [source, line] of [
    [`let xs = [1]\nlet both = xs + ["x"]\n${objects}say (a + b).length\nexit\n`, 'xs + ["x"]'],
    [
      `let xs = [1]\n${objects}let both = xs + ["x"] + [(a + b).length]\nexit\n`,
      'let both = xs + ["x"] + [(a + b).length]',
    ],
  ] as const)
    assert.match(pasted(source, line) ?? "", /^TSV044: '\+' would mix objects/, source);
});

test("what a site takes is read through a long chain of untyped copies or calls, and a wide literal (#1241, Codex r8, r13)", () => {
  const lines = (count: number, line: (index: number) => string): string =>
    Array.from({ length: count }, (_, index) => line(index)).join("\n");
  const call = (index: number): string => (index === 1023 ? "p" : `f${index + 1}(p)`);
  for (const source of [
    `let t = "x"\nlet v0 = t.size\n${lines(2048, (i) => `let v${i + 1} = v${i}`)}\nsay v2048.trim()\nexit\n`,
    `let t = "x"\n${lines(1024, (i) => `function f${i}(p) {\n  return ${call(i)}\n}`)}\nlet v: string = f0(t.size)\nsay v\nexit\n`,
  ]) {
    const request = coreRequest([{ path: "main.tease", source }]);
    assert.ok(request !== null);
    const { diagnostics } = analyseCore(request);
    const text = messageSource([source], diagnostics);
    assert.ok(
      diagnostics.some((diagnostic) =>
        coreMessage(diagnostic, text).endsWith(" Use the length property."),
      ),
    );
  }
  // (Codex r13: a literal wide enough that one native call per element would exhaust the stack, where its presence is
  // walked)
  const wide = `let d: duration = [${"1, ".repeat(131071)}2].length\nexit\n`;
  const request = coreRequest([{ path: "main.tease", source: wide }]);
  assert.ok(request !== null);
  assert.deepEqual(
    analyseCore(request).diagnostics.map((diagnostic) => diagnostic.code),
    ["TSV041"],
  );
});

test("the code each fix suggests compiles where it stands and runs, saying what it should (#1195)", () => {
  for (const [marked, pick, says] of REPAIRS) {
    const source = marked.replace(/[⟦⟧]/g, "");
    const files = [{ path: "main.tease", source }];
    const request = coreRequest(files);
    assert.ok(request !== null, source);
    const { diagnostics } = analyseCore(request);
    const text = messageSource([source], diagnostics);
    const suggested = diagnostics
      .map((diagnostic) => pick.exec(coreMessage(diagnostic, text))?.[1])
      .find((found) => found !== undefined);
    assert.ok(suggested !== undefined, `a fix: ${source}`);
    const fixed = marked.replace(/⟦[^⟧]*⟧/, suggested);
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
 * #1268: null checks' fallbacks, `⟦…⟧` around the value they stand in for, whether the fallback stands in parentheses
 * there (an operand or a receiver: TSP041 asks for them next to every operator, #1243) and what the source then says: a
 * plain value,
 * an operand of each operator class (a comparison, arithmetic, a sign, `and`, `or`, `not`; `is` takes null, so the case
 * under it is the arithmetic's operand), a condition, a count, an index, a key, an argument, text, an element of a list.
 */
const FALLBACKS: readonly (readonly [string, boolean, readonly string[]])[] = [
  ["let xs = [7, null]\nlet n: integer = ⟦xs[1]⟧\nsay n\nexit\n", false, ["0"]],
  ['let xs = [7, null]\nif ⟦xs[1]⟧ < 1 { say "low" }\nexit\n', true, ["low"]],
  ["let xs = [7, null]\nsay ⟦xs[1]⟧ + 1\nexit\n", true, ["1"]],
  ["let xs = [7, null]\nsay -⟦xs[1]⟧\nexit\n", true, ["0"]],
  ['let xs = [7, null]\nif ⟦xs[1]⟧ + 1 is integer { say "whole" }\nexit\n', true, ["whole"]],
  [
    'let bs = [true, null]\nif ⟦bs[1]⟧ and true { say "yes" } else { say "no" }\nexit\n',
    true,
    ["no"],
  ],
  [
    'let bs = [true, null]\nif false or ⟦bs[1]⟧ { say "yes" } else { say "no" }\nexit\n',
    true,
    ["no"],
  ],
  ['let bs = [true, null]\nif not ⟦bs[1]⟧ { say "yes" }\nexit\n', true, ["yes"]],
  ['let bs = [true, null]\nif ⟦bs[1]⟧ { say "yes" } else { say "no" }\nexit\n', false, ["no"]],
  ['let xs = [7, null]\nrepeat ⟦xs[1]⟧ { say "x" }\nsay "done"\nexit\n', false, ["done"]],
  ["let xs = [7, null]\nsay [5][⟦xs[1]⟧]\nexit\n", false, ["5"]],
  [
    'let ks = ["a", null]\nlet d = dict{a: 1}\nsay d.get(⟦ks[1]⟧, default: 0)\nexit\n',
    false,
    ["0"],
  ],
  [
    "function use(v: integer) {\n  say v\n}\nlet xs = [7, null]\nuse(⟦xs[1]⟧)\nexit\n",
    false,
    ["0"],
  ],
  ['let names = ["a", null]\nsay ⟦names[1]⟧.length\nexit\n', true, ["0"]],
  ['let names = ["a", null]\nsay "a" + ⟦names[1]⟧\nexit\n', true, ["a"]],
  ['let names = ["a", null]\nif ⟦names[1]⟧ < "b" { say "before" }\nexit\n', true, ["before"]],
  ['let xs = [7, null]\nsay "${⟦xs[1]⟧ + 1}"\nexit\n', true, ["1"]],
];

test("a null check's fallback compiles where it is pasted, grouped as written, and runs (#1268)", () => {
  for (const [marked, grouped, says] of FALLBACKS) {
    const source = marked.replace(/[⟦⟧]/g, "");
    const request = coreRequest([{ path: "main.tease", source }]);
    assert.ok(request !== null, source);
    const analysed = analyseCore(request).diagnostics;
    const text = messageSource([source], analysed);
    const suggested = analysed
      .map((diagnostic) => /fallback, as in '([^']*)'/.exec(coreMessage(diagnostic, text))?.[1])
      .find((found) => found !== undefined);
    assert.ok(suggested !== undefined, `a fallback: ${source}`);
    assert.equal(suggested.startsWith("("), grouped, suggested);
    const at = marked.indexOf("⟦");
    const fixed = marked.replace(/⟦[^⟧]*⟧/, suggested);
    // (its `otherwise` holds exactly the pasted code, inside the parentheses it brings: the grouping TSP041 asks for)
    const inner = suggested.startsWith("(") ? 1 : 0;
    assert.ok(
      someNode(parse(fixed).program, (node) => {
        if (node.kind !== "binaryExpression") return false;
        // EVIDENCE: invariant: a parser-owned node whose kind is `binaryExpression` is a binary expression.
        const binary = node as BinaryExpression;
        return (
          binary.operator === "otherwise" &&
          binary.span.start.offset === at + inner &&
          binary.span.end.offset === at + suggested.length - inner
        );
      }),
      fixed,
    );
    const { diagnostics, plan } = compileProject([{ path: "main.tease", source: fixed }]);
    assert.deepEqual(
      diagnostics.filter((found) => found.severity === "error").map((found) => found.message),
      [],
      fixed,
    );
    // (the fallback leaves no possible null for the new checker either)
    const repaired = coreRequest([{ path: "main.tease", source: fixed }]);
    assert.ok(repaired !== null, fixed);
    assert.deepEqual(
      analyseCore(repaired).diagnostics.filter(
        (found) =>
          found.kind !== "budget" &&
          (found.kind === "written-type" || found.kinds.includes("null")),
      ),
      [],
      fixed,
    );
    assert.ok(plan !== null, fixed);
    const events = createFreshRuntimeSession(plan, {
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
  // none in code where none of the value's type can be written: a list, and a union beside the type the use takes
  for (const source of [
    "let rows = [[1], null]\nsay rows[1].length\nexit\n",
    'let us: (integer | string | null)[] = [1, "a", null]\nsay us[2] + 1\nexit\n',
  ]) {
    const request = coreRequest([{ path: "main.tease", source }]);
    assert.ok(request !== null, source);
    const { diagnostics } = analyseCore(request);
    const text = messageSource([source], diagnostics);
    const fixes = diagnostics
      .filter(
        (found) =>
          found.kind !== "written-type" && found.kind !== "budget" && found.kinds.includes("null"),
      )
      .map((found) => coreMessage(found, text));
    assert.equal(fixes.length, 1, source);
    assert.match(fixes[0]!, new RegExp(`, ${escaped(SAME_TYPE)}`), source);
    assert.doesNotMatch(fixes[0]!, / otherwise /, source);
  }
  // no join of values `join()` does not show, and no receiver form for an element `${...}` selects from a list, whose
  // text names the list (Codex r2): the steps in words
  for (const [source, words] of [
    ['say "${[set[1]]}"\nexit\n', "Show its elements with the toList and join methods instead."],
    ['say "${set[{a: 1}]}"\nexit\n', "Show its elements with the toList and join methods instead."],
    [
      'say "${dict{a: {p: 1}}}"\nexit\n',
      "Select one value with a key, or show every value with the values and join methods.",
    ],
    [
      'let d = dict{a: [1]}\nsay "${d}"\nexit\n',
      "Select one value with a key, or show every value with the values and join methods.",
    ],
    ['let xs = [{a: 1}]\nsay "${xs}"\nexit\n', "Show one of its properties instead."],
  ] as const) {
    const request = coreRequest([{ path: "main.tease", source }]);
    assert.ok(request !== null, source);
    const { diagnostics } = analyseCore(request);
    const text = messageSource([source], diagnostics);
    const found = diagnostics.map((diagnostic) => coreMessage(diagnostic, text));
    assert.ok(
      found.some((message) => message.endsWith(` ${words}`)),
      `${source}: ${found.join(" | ")}`,
    );
    assert.ok(
      found.every((message) => !/as in '|with '/.test(message)),
      source,
    );
  }
  // a property stored on a type without it: no read's repair, which is no place to store into (Codex r1)
  for (const source of ["let d = 2 s\nd.seconds = 3\nexit\n", "let n = 12\nn.length = 3\nexit\n"]) {
    const request = coreRequest([{ path: "main.tease", source }]);
    assert.ok(request !== null, source);
    const { diagnostics } = analyseCore(request);
    const text = messageSource([source], diagnostics);
    const found = diagnostics.map((diagnostic) => coreMessage(diagnostic, text));
    assert.equal(found.length, 1, source);
    assert.doesNotMatch(found[0]!, /as in '|with '/, source);
  }
});

/**
 * #1268, TABLE r4.146: checks, `⟦…⟧` around the use's statement, which the check's example holds as the source writes
 * it (a kept value's read as `value`, its `let` on a line before), and what the source then says: a null check of a
 * variable and of a kept value, on a line of its own and in a block (Astra on #1273); around a condition, a count, an
 * iterable, a store, an interpolation, a receiver; a type test, a length check, a timer's block.
 */
const CHECKS: readonly (readonly [string, readonly string[]])[] = [
  ["let ns = [1, null]\nlet n = ns[1]\n⟦say n + 1⟧\nexit\n", []],
  ["let ns = [1, null]\nlet n = ns[0]\nif true {\n  ⟦say n + 1⟧\n}\nexit\n", ["2"]],
  ["let ns = [1, null]\nlet n = ns[0]\nif true { ⟦say n + 1⟧ }\nexit\n", ["2"]],
  ["let ns = [1, null]\n⟦say ns[0] + 1⟧\nexit\n", ["2"]],
  ["let ns = [1, null]\nif true { ⟦say ns[0] + 1⟧ }\nexit\n", ["2"]],
  [
    'let ns = [1, null]\nlet n = ns[0]\n⟦if n < 1 { say "low" } else { say "high" }⟧\nexit\n',
    ["high"],
  ],
  ['let ns = [1, null]\nlet n = ns[0]\n⟦repeat n { say "x" }⟧\nexit\n', ["x"]],
  ["let lists = [[4], null]\nlet xs = lists[0]\n⟦for x in xs { say x }⟧\nexit\n", ["4"]],
  ["let ns = [1, null]\nlet n = ns[0]\nlet m = 0\n⟦m = n + 1⟧\nsay m\nexit\n", ["2"]],
  ['let ns = [1, null]\nlet n = ns[0]\n⟦say "${n + 1}"⟧\nexit\n', ["2"]],
  ['let names = ["ab", null]\n⟦say names[0].length⟧\nexit\n', ["2"]],
  ['let us: (integer | string)[] = [1, "a"]\nlet u = us[0]\n⟦say u + 1⟧\nexit\n', ["2"]],
  ['let us: (integer | string)[] = [1, "a"]\n⟦say us[0] + 1⟧\nexit\n', ["2"]],
  ["let groups: integer[][] = [[], [21]]\n⟦say groups[1].last⟧\nexit\n", ["21"]],
  ["let ns = [1, null]\nlet n = ns[0]\nlet t = timer async 1 s { ⟦say n + 1⟧ }\nexit\n", []],
  // (beside text, the null check's alternative is the type test too, Codex r4)
  [
    'let us: (integer | string | null)[] = [1, "a", null]\nlet u = us[0]\n⟦say u + 1⟧\nexit\n',
    ["2"],
  ],
  ['let us: (integer | string | null)[] = [1, "a", null]\n⟦say us[0] + 1⟧\nexit\n', ["2"]],
  // (a call after the read, a method of the value itself, a kept call read first: nothing changes before the use)
  ["let ns = [1, null]\nfunction f { return 2 }\n⟦say ns[0] + f()⟧\nexit\n", ["3"]],
  ["let lists = [[1], null]\nlet xs = lists[0]\n⟦xs.add(2)⟧\nsay xs\nexit\n", ["[1, 2]"]],
  ["let ns = [1, null]\nfunction f { return ns[0] }\n⟦say f() + 1⟧\nexit\n", ["2"]],
];

test("a check's example holds the use's statement, compiles in its place, and runs (#1268)", () => {
  for (const [marked, says] of CHECKS) {
    const source = marked.replace(/[⟦⟧]/g, "");
    const request = coreRequest([{ path: "main.tease", source }]);
    assert.ok(request !== null, source);
    const { diagnostics } = analyseCore(request);
    const text = messageSource([source], diagnostics);
    // (every check its messages offer: a type test beside a null check's, Codex r4)
    const offers = new Set(
      diagnostics.flatMap((diagnostic) => {
        const message = coreMessage(diagnostic, text);
        const check = / as in '(if [^']*)'/.exec(message)?.[1];
        const kept = /as in '(let value = [^']*)', and check/.exec(message)?.[1];
        return check === undefined ? [] : [kept === undefined ? check : `${kept}\n${check}`];
      }),
    );
    assert.ok(offers.size > 0, `a check: ${source}`);
    const statement = /⟦([^⟧]*)⟧/.exec(marked)![1]!;
    for (const offer of offers) {
      const [check, kept] = offer.includes("\n") ? offer.split("\n").reverse() : [offer];
      // (it holds the statement it replaces: as written, a kept value's read as `value`)
      const held = /^if .+? \{ (.*) \}$/.exec(check!)?.[1];
      assert.equal(
        kept === undefined ? held : held?.replace("value", kept.slice("let value = ".length)),
        statement,
        offer,
      );
      const fixed = marked.replace(/⟦[^⟧]*⟧/, offer);
      const { diagnostics, plan } = compileProject([{ path: "main.tease", source: fixed }]);
      assert.deepEqual(
        diagnostics.filter((found) => found.severity === "error").map((found) => found.message),
        [],
        fixed,
      );
      assert.ok(plan !== null, fixed);
      const events = createFreshRuntimeSession(plan, {
        baseDelayMs: 0,
        delayPerWordMs: 0,
        delayPerCharacterMs: 0,
      }).run().events;
      assert.deepEqual(
        events.filter((event) => event.kind === "runtimeFailure"),
        [],
        fixed,
      );
      assert.deepEqual(
        events.flatMap((event) => (event.kind === "say" ? [event.text] : [])),
        says,
        fixed,
      );
    }
  }
});

/**
 * #1268, TABLE r4.146 and r4.162: uses whose statement no check may hold as written, and declarations not on one line:
 * the step in words, with no block and no placeholder; where the words still offer code, a fallback or a type, `⟦…⟧`
 * marks where it goes.
 */
const WORDED: readonly (readonly [string, string])[] = [
  // a declaration, whose name would end with the check's block; a statement over two lines; an `else if`'s condition;
  // a `while`'s, tested again after each pass; a return; a comment
  [
    "let ns = [1, null]\nlet n = ns[0]\nlet m = ⟦n⟧ + 1\nsay m\nexit\n",
    "Check that 'n' is not null first, or give a fallback, as in '(n otherwise 0)'.",
  ],
  [
    "let ns = [1, null]\nlet n = ns[0]\nsay ⟦n⟧ +\n  1\nexit\n",
    "Check that 'n' is not null first, or give a fallback, as in '(n otherwise 0)'.",
  ],
  [
    "let ns = [1, null]\nlet n = ns[0]\nif false { say 0 } else if ⟦n⟧ < 1 { say 1 }\nexit\n",
    "Check that 'n' is not null first, or give a fallback, as in '(n otherwise 0)'.",
  ],
  [
    "let ns = [1, null]\nlet n = ns[0]\nwhile ⟦n⟧ < 3 { n = 3 }\nexit\n",
    "Check that 'n' is not null first, or give a fallback, as in '(n otherwise 0)'.",
  ],
  [
    "let ns = [1, null]\nfunction f(k) {\n  let n = ns[k]\n  return ⟦n⟧ + 1\n}\nsay f(0)\nexit\n",
    "Check that 'n' is not null first, or give a fallback, as in '(n otherwise 0)'.",
  ],
  [
    "let ns = [1, null]\nlet n = ns[0]\nsay ⟦n⟧ /* one */ + 1\nexit\n",
    "Check that 'n' is not null first, or give a fallback, as in '(n otherwise 0)'.",
  ],
  // something evaluated before the use that may change or draw, the kept read's own effect, or a use a run may skip
  // (Codex r4, r5): a check before the statement would not hold there, and a kept value would be read too early
  [
    "let ns = [1, null]\nfunction change {\n  ns[0] = 9\n  return 1\n}\nsay change() + ⟦ns[0]⟧\nexit\n",
    "Keep 'ns[0]' in a new variable and check that it is not null first, or give a fallback, as in " +
      "'(ns[0] otherwise 0)'.",
  ],
  [
    "let ns = [1, null]\nlet n = ns[0]\nfunction change {\n  n = 9\n  return 1\n}\nsay change() + ⟦n⟧\nexit\n",
    "Check that 'n' is not null first, or give a fallback, as in '(n otherwise 0)'.",
  ],
  [
    "let xs = [7]\nfunction change {\n  xs.clear()\n  return 1\n}\nsay change() + xs.last\nexit\n",
    "Check the length of 'xs' first.",
  ],
  [
    'let ns = [1, null]\nlet n = ns[0]\nif askBoolean "go" or ⟦n⟧ > 0 { say 1 }\nexit\n',
    "Check that 'n' is not null first, or give a fallback, as in '(n otherwise 0)'.",
  ],
  [
    "let n = 1\nlet ns = [1, null]\nfunction read {\n  n = 9\n  return ns[0]\n}\nsay n + ⟦read()⟧\nexit\n",
    "Keep 'read()' in a new variable and check that it is not null first, or give a fallback, as in " +
      "'(read() otherwise 0)'.",
  ],
  [
    'let ns = [1, 2, null, 3]\nsay "${[10, 20]} ${⟦ns.random⟧ + 1}"\nexit\n',
    "Keep 'ns.random' in a new variable and check that it is not null first, or give a fallback, as in " +
      "'(ns.random otherwise 0)'.",
  ],
  // a kept value the statement reads twice: a check of one read leaves the other
  [
    "let ns = [1, null]\nsay ⟦ns[0]⟧ + ns[0]\nexit\n",
    "Keep 'ns[0]' in a new variable and check that it is not null first, or give a fallback, as in " +
      "'(ns[0] otherwise 0)'.",
  ],
  // another problem where the code would stand (TABLE r4.162, Codex r5): a whole number joined with text, a duration or
  // a number that may also be null, a mixed key or condition
  [
    'let ns = [1, null]\nlet n = ns[0]\nsay "x" + n\nexit\n',
    "Check that 'n' is not null first, or give a fallback of the same type with 'otherwise'.",
  ],
  [
    "let vs: duration?[] = [1 s, null]\nlet v = vs[0]\nsay v.seconds\nexit\n",
    "Divide the duration by a unit of time instead.",
  ],
  ["let vs: integer?[] = [1, null]\nlet v = vs[0]\nif v { say 1 }\nexit\n", "Compare it instead."],
  // a type test and a length check in a declaration
  [
    'let us: (integer | string)[] = [1, "a"]\nlet m = us[0] + 1\nexit\n',
    "Keep 'us[0]' in a new variable and check that it is a whole number (integer) first.",
  ],
  [
    "let groups: integer[][] = [[], [21]]\nlet x = groups[1].last\nexit\n",
    "Check the length of 'groups[1]' first.",
  ],
  [
    "let groups: integer[][] = [[], [21]]\nlet x = groups.random.last\nexit\n",
    "Keep 'groups.random' in a new variable and check its length first.",
  ],
  // after an error, a form that reads a call's or an index read's result into another operation (TABLE r4.168): a
  // shown object's property, a date and time conversion
  [
    'function make { return {a: 1, b: 2} }\nsay "${make()}"\nexit\n',
    "Show one of its properties instead.",
  ],
  [
    'let ts = [toAbsoluteDateTime("2026-01-01T00:00:00Z")]\nlet i = 0\nsay ts[i].year\nexit\n',
    "Convert 'ts[i]' with the toDateTime method first.",
  ],
  // a start value over lines (Astra on #1273's sibling)
  [
    'let mood⟦⟧ = [\n  1\n][0]\nmood = "happy"\nexit\n',
    "To allow both, declare it with the type 'integer | string'.",
  ],
  [
    'function use(n⟦: integer⟧ = [\n  1\n][0]) { say n }\nuse("x")\nexit\n',
    "To allow both, declare the parameter 'n' with the type 'integer | string'.",
  ],
];

test("a use no check may hold as written gets the check in words, with no block or placeholder (#1268)", () => {
  for (const [marked, words] of WORDED) {
    const source = marked.replace(/[⟦⟧]/g, "");
    const request = coreRequest([{ path: "main.tease", source }]);
    assert.ok(request !== null, source);
    const { diagnostics } = analyseCore(request);
    const text = messageSource([source], diagnostics);
    const found = diagnostics.map((diagnostic) => coreMessage(diagnostic, text));
    assert.ok(
      found.some((message) => message.includes(words)),
      `${source}: ${found.join(" | ")}`,
    );
    assert.ok(
      found.every((message) => !/'if [^']*\{|\{ \.\.\. \}| = \.\.\.'|'let value = /.test(message)),
      source,
    );
    // (the code the words still offer, in its place, adds no error: a use it does not mend keeps its own)
    const fallback = /fallback, as in '([^']*)'/.exec(words)?.[1];
    const type = /with the type '([^']*)'/.exec(words)?.[1];
    const offered = fallback ?? (type === undefined ? undefined : `: ${type}`);
    assert.equal(marked.includes("⟦"), offered !== undefined, marked);
    if (offered === undefined) continue;
    const fixed = marked.replace(/⟦[^⟧]*⟧/, offered);
    const errors = (code: string): string[] =>
      compileProject([{ path: "main.tease", source: code }])
        .diagnostics.filter((diagnostic) => diagnostic.severity === "error")
        .map((diagnostic) => `${diagnostic.code}: ${diagnostic.message}`);
    const before = errors(source);
    assert.deepEqual(
      errors(fixed).filter((error) => !before.includes(error)),
      [],
      fixed,
    );
  }
});

/**
 * Text joins, `⟦…⟧` around the operand that is not text: the example puts it in `${...}` as the source writes it, and
 * the source with the operand so written says these lines (the owner's review; r3's and r4's shapes among them).
 */
const JOINS: readonly (readonly [string, readonly string[] | null])[] = [
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
  // (a chain over two lines, its operand on one)
  ['let n = 1\nsay "Sum: " +\n  ⟦n⟧\nexit\n', ["Sum: 1"]],
  // (after an error, a read by an index or a key, or a call, is not proved there: words, TABLE r4.168)
  ['let xs = [5]\nsay "First: " + ⟦xs[0]⟧\nexit\n', null],
  ['function two { return 2 }\nsay "Two: " + ⟦two()⟧\nexit\n', null],
  ['let d = dict{"a": 1}\nsay "A: " + ⟦d["a"]⟧\nexit\n', null],
  ['say "A: " + ⟦dict{"a": 1}["a"]⟧\nexit\n', null],
];

test("a text join's example puts the operand that is not text in '${...}', and the result says what the join meant (#1195)", () => {
  for (const [marked, says] of JOINS) {
    const source = marked.replace(/[⟦⟧]/g, "");
    const request = coreRequest([{ path: "main.tease", source }]);
    assert.ok(request !== null, source);
    const { diagnostics } = analyseCore(request);
    const text = messageSource([source], diagnostics);
    const suggested = diagnostics
      .map(
        (diagnostic) =>
          /in the text as '(\$\{[^']*\})' instead/.exec(coreMessage(diagnostic, text))?.[1],
      )
      .find((found) => found !== undefined);
    if (says === null) {
      assert.equal(suggested, undefined, source);
      continue;
    }
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
    const { diagnostics } = analyseCore(request);
    const text = messageSource([source], diagnostics);
    const message = diagnostics
      .map((diagnostic) => coreMessage(diagnostic, text))
      .find((found) => found.startsWith(`'${collection}' may be empty here.`));
    assert.ok(message !== undefined, source);
    // (the fix as its message writes it, in place of the read's statement, its `let` on a line before; #1268)
    const read = source.split("\n").find((line) => line.includes(collection))!;
    const checked = /Check '[^']*' first, as in '(if [^']*)'\./.exec(message);
    const kept =
      /Keep '[^']*' in a new variable, as in '(let value = [^']*)', and check its length, as in '(if [^']*)'\./.exec(
        message,
      );
    assert.equal(checked !== null, stable, message);
    assert.equal(kept !== null, !stable, message);
    const fixed = source.replace(
      read,
      checked !== null ? checked[1]! : `${kept![1]!}\n${kept![2]!}`,
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
    // a member of a type without it, a speaker's member (#1268: words for the function, never a template)
    [
      "let ns = [1, 2]\nsay (ns /* any */ .random).length\nexit\n",
      "Convert the value to text first with the toString function.",
    ],
    [
      'let ts = [toAbsoluteDateTime("2026-01-01T00:00:00Z")]\nsay ts.random.year\nexit\n',
      "Convert 'ts.random' with the toDateTime method first.",
    ],
    [
      "let ss = [set[1]]\nsay ss.random.indexOf(1)\nexit\n",
      "Copy 'ss.random' into a list with the toList method first.",
    ],
    ["let rack = [player]\nsay rack.random.rank\nexit\n", "Assign the property before this line."],
    [
      'speaker sage { title: "Sage" }\nlet value = sage\nsay value.get(0, default: 3)\nexit\n',
      "A speaker has no methods. Use one of its properties instead.",
    ],
    // (members named in words, each of its own type, Codex r4)
    [
      'let xs = ["a"]\nsay xs.foo + 1\nexit\n',
      "Use one of its properties instead: length, first, last, or random.",
    ],
    [
      "let d = 1 calendar day\nsay d.seconds + 1\nexit\n",
      "Use one of its properties instead: months, days, or exactOffset.",
    ],
    // (a conversion only where the receiver has no other type, Codex r4)
    [
      "let vs: (integer | duration)[] = [1, 1 s]\nlet v = vs[0]\nsay v.seconds\nexit\n",
      "Divide the duration by a unit of time instead.",
    ],
    // (a conversion, a date and time form or a join whose result no use was checked for, where its use is not what a
    // `say` shows, a `${...}` holds or a condition takes: words, TABLE r4.162, Codex r6)
    [
      "let n = 12\nif n.length { say 1 }\nexit\n",
      "Convert the value to text first with the toString function.",
    ],
    [
      'let n = 12\nsay n.replace("1", "a")\nexit\n',
      "Convert the value to text first with the toString function.",
    ],
    [
      "let d = 2 s\nrepeat d.seconds { say 1 }\nexit\n",
      "Divide the duration by a unit of time instead.",
    ],
    // (after an error, a call's reads are not proved, TABLE r4.168)
    [
      'say toDate("2026-10-23") + 1 day\nexit\n',
      "A date moves only by calendar units, such as calendar days.",
    ],
    // (an operand's diagnostic proves neither the other operand's kinds nor the operation's place, #1268: a duration
    // on the left would take no toDate)
    [
      'let a = toDateTime("2026-10-23T12:00:00")\nlet b = toDateTime("2026-10-22T12:00:00")\nsay a - b\nexit\n',
      "Subtract their dates with the toDate function, or convert both with the toAbsoluteDateTime method for the elapsed time.",
    ],
    [
      'let t = toDateTime("2026-10-23T12:00:00")\nif t + 1 s { say 1 }\nexit\n',
      "Convert it with the toAbsoluteDateTime method first, or use calendar units to keep the clock time.",
    ],
    ['let n = 1\nif "x" + n { say 1 }\nexit\n', "Put the value in the text instead."],
    // (no list copy for a method that changes it, whose change the copy would lose, Codex r4)
    [
      "let s = set[3, 1]\nsay s.sort() + 1\nexit\n",
      "Copy 's' into a list with the toList method first.",
    ],
    // a null check of a value not on one line
    [
      "let xs = [7, null]\nsay (xs /* c */ [0]) + 1\nexit\n",
      "Keep 'xs /* c */ [0]' in a new variable and check that it is not null first.",
    ],
    // the text join where the operand that is not text spans lines or holds a comment (the owner's review)
    ['let n = 1\nsay "Sum: " + (n\n+2)\nexit\n', "Put the value in the text instead."],
    ['let n = 1\nsay "Sum: " + (n /* two */ + 2)\nexit\n', "Put the value in the text instead."],
    // a value not on one line (Astra r1: never a name of another declaration; #1268: a literal or an expression on
    // one line is shown in place, `REPAIRS`)
    [
      'let value = set[99]\nsay "${set[4, /* s */ 7]}"\nexit\n',
      "Show its elements with the toList and join methods instead.",
    ],
    [
      'say "${dict{a: /* d */ 1}}"\nexit\n',
      "Select one value with a key, or show every value with the values and join methods.",
    ],
    ['let rec = {names: ["A"]}\nsay "${rec}"\nexit\n', "Show one of its properties instead."],
    ['let d = dict{"1": 5}\nsay d[1]\nexit\n', "Write a number key as text."],
    ["let caption: string = (1 /* one */)\nexit\n", "To show the value as text, put it in a text."],
    // (a selection that is no stable path, its text not code on one line: kept first, without the example)
    [
      "let groups: integer[][] = [[], [21]]\nsay (groups /* any */ .random).last\nexit\n",
      "Keep 'groups /* any */ .random' in a new variable and check its length first.",
    ],
    ["say (1 s + 2 s).seconds\nexit\n", "Divide '1 s + 2 s' by a unit, such as '1 second'."],
    [
      'let t = toAbsoluteDateTime("2026-01-01T00:00:00Z")\nsay (t + 1 s) + 1 calendar day\nexit\n',
      "Convert it with the toDateTime method first.",
    ],
    [
      'say toDate("2026-10-23") < toDateTime("2026-10-23T12:00:00")\nexit\n',
      "Compare its date with the toDate function.",
    ],
    [
      'let ds = [toDateTime("2026-01-01T00:00:00")]\nsay ds.random + 1 s\nexit\n',
      "Convert it with the toAbsoluteDateTime method first, or use calendar units to keep the clock time.",
    ],
    [
      'let ds = [toDateTime("2026-01-01T00:00:00")]\nsay ds.random - ds[0]\nexit\n',
      "Subtract their dates with the toDate function, or convert both with the toAbsoluteDateTime method for the " +
        "elapsed time.",
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
    // (Codex r7, TABLE r4.160: an argument of a parameter without a type that its body or its result's use does not
    // take, a variable's value its reads do not take; a receiver read through a dict's key, which may be absent)
    [
      'let t = "hello"\nfunction use(p) {\n  say p.trim()\n}\nuse(t.size)\nexit\n',
      "Use the length property.",
    ],
    [
      'let t = "hello"\nfunction id(p) {\n  return p\n}\nlet q: string[] = id(t.size)\nexit\n',
      "Use the length property.",
    ],
    ['let t = "hello"\nlet v = t.size\nsay v.trim()\nexit\n', "Use the length property."],
    // (Astra on #1296, TABLE r4.162, r4.168: an error's value read by an index or a dict's key, which may be absent,
    // the list or the operand a list or a conversion fix reads, either way; an element as a receiver)
    [
      'let d = dict{found: [1]}\nsay d["absent"] + 2\nexit\n',
      "To add one element, put the element in brackets for a new list, or call the add method on a line of its own.",
    ],
    [
      "let ls = [[1]]\nsay ls[0] + 2\nexit\n",
      "To add one element, put the element in brackets for a new list, or call the add method on a line of its own.",
    ],
    [
      'let d = dict{found: 2}\nlet v: duration = d["absent"]\nsay v\nexit\n',
      "Give the number a unit.",
    ],
    ["let ns = [2]\nlet v: duration = ns[0]\nsay v\nexit\n", "Give the number a unit."],
    // (Codex r12: such a read inside a literal or an interpolation, also before another part)
    [
      'let d = dict{found: 2}\nlet v: duration = ({n: d["absent"]}).n\nsay v\nexit\n',
      "Give the number a unit.",
    ],
    [
      'let d = dict{found: 2}\nlet v: duration = toInteger("${d["absent"]}${1}", default: 1)\nsay v\nexit\n',
      "Give the number a unit.",
    ],
    // (Astra r2 on #1296: a property of a receiver that may be null, as a variable or a property holds it)
    [
      "let boxes = [{n: 2}, null]\nlet box = boxes[1]\nlet converted: duration = box.n\nsay converted\nexit\n",
      "Give the number a unit.",
    ],
    [
      'let boxes = [{text: "hi", items: [1]}, null]\nlet outer = {inner: boxes[1]}\nsay outer.inner.text.size\nexit\n',
      "Use the length property.",
    ],
    [
      'let boxes = [{text: "hi", items: [1]}, null]\nlet box = boxes[1]\nsay box.items + 2\nexit\n',
      "To add one element, put the element in brackets for a new list, or call the add method on a line of its own.",
    ],
    // (Astra r3 on #1296: an operand that may be null, nested in arithmetic)
    [
      "let ns = [2, null]\nlet n = ns[1]\nlet converted: duration = n + 1\nsay converted\nexit\n",
      "Give the number a unit.",
    ],
    [
      "let ns = [2, null]\nlet n = ns[1]\nlet converted: duration = -n\nsay converted\nexit\n",
      "Give the number a unit.",
    ],
    // (Codex r13: such a read in an ask's operand)
    [
      'let d = dict{found: "Q"}\nlet v: duration = askInteger(d["absent"])\nsay v\nexit\n',
      "Give the number a unit.",
    ],
    ['let items = ["hello"]\nsay items[0].size\nexit\n', "Use the length property."],
    ['let lists = [["a"]]\nsay lists[0].join\nexit\n', "Call the join method with parentheses."],
    [
      "let xs = [1]\nlet caption: string = xs[0]\nsay caption\nexit\n",
      "To show the value as text, put it in a text.",
    ],
    [
      'let d = dict{"a": 2}\nlet caption: string = d["a"]\nsay caption\nexit\n',
      "To show the value as text, put it in a text.",
    ],
    // (Codex r9: a default's or a fallback's type must also fit the value it stands beside, C10)
    [
      'let t = "hello"\nlet ys = ["x"]\nsay ys.get(9, default: t.size)\nexit\n',
      "Use the length property.",
    ],
    ['let t = "hello"\nsay t.size otherwise "x"\nexit\n', "Use the length property."],
    // (Codex r8: a compound assignment's operands, which have no flow point here)
    ['let t = "hello"\nlet v = t.size\nv += "x"\nsay v\nexit\n', "Use the length property."],
    [
      'let t = "hello"\nfunction f(p) {\n  p += "x"\n  say p\n}\nf(t.size)\nexit\n',
      "Use the length property.",
    ],
    [
      'let d = dict{a: " hello "}\nsay d["missing"].trim\nexit\n',
      "Call the trim method with parentheses.",
    ],
    [
      'let d = dict{a: " hello "}\nsay d["a"].trim\nexit\n',
      "Call the trim method with parentheses.",
    ],
    // (Astra on #1273: a fallback the fix would write where the value divides, as a divisor, through a calculation or a
    // member, where a written zero stops the run)
    ...[
      "let xs = [4, null]\nsay 1 / xs[1]\nexit\n",
      "let xs = [4, null]\nsay 7 % xs[1]\nexit\n",
      "let xs = [4, null]\nsay 1 / (xs[1] * 2)\nexit\n",
      'let xs = ["ab", null]\nsay 4 / xs[1].length\nexit\n',
      // (Codex r8, r9: through a side of 'otherwise', a default)
      'let xs = ["ab", null]\nsay 1 / (xs[1].length otherwise 1)\nexit\n',
      'let xs = ["ab", null]\nsay 1 / load("missing", default: xs[1].length)\nexit\n',
      // (Codex r10: through a literal's contents, an interpolation's text)
      'let xs = ["ab", null]\nsay 1 / [xs[1].length][0]\nexit\n',
      'let xs = ["ab", null]\nsay 1 / ({n: xs[1].length}).n\nexit\n',
      'let xs = ["ab", null]\nsay 1 / toInteger("${xs[1].length}", default: 1)\nexit\n',
      'function f(s: string, xs: string?[]) {\n  say 1 / toInteger(s, default: xs[1].length)\n}\nf("bad", ["ab", null])\nexit\n',
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
    const { diagnostics } = analyseCore(request);
    const text = messageSource([source], diagnostics);
    const messages = diagnostics.map((diagnostic) => coreMessage(diagnostic, text));
    assert.ok(
      messages.some((message) => message.includes(fix)),
      `${source}: ${messages.join(" | ")}`,
    );
  }
});
