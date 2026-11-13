// The message parity's port table (tests/type-core/messages/type-core-messages-parity.test.ts): each fix sentence of
// the current checker and the form the new checker writes for it (#1195), with the forms' helpers.

import type { CheckedDiagnostic } from "../../../src/type-inference/core/result.js";
import { VALUE_KINDS } from "../../../src/value-kinds.js";

/** A diagnostic a rule found: a stop's own warning and marks (`budget`) name no fix and are never compared. */
export type Compared = Exclude<CheckedDiagnostic, { readonly kind: "budget" }>;
/**
 * What the new checker's diagnostic names: its subject as the source writes it, a member, an operation's operands, the
 * statement a check would hold, and the declaration a fix rewrites.
 */
export interface Named {
  readonly subject: string;
  /** A member as its code writes it: `.length`, `.get(...)`; empty for any other rule. */
  readonly member: string;
  readonly operands: readonly string[];
  /** The text of the use's statement a check may hold (`MessageSource.statement`), or `null`. */
  readonly statement: string | null;
  /** The text of the declaration of the place a store's or a literal's fix declares, or `null`. */
  readonly declared: string | null;
  /**
   * Whether the fix's code is taken as proved where it stands: so in a pair, and not in the words that an
   * unproved fact gives (`INTENDED`, `unproved`).
   */
  readonly proved: boolean;
  /**
   * The written union a new variable keeping the subject declares: an `askChoice` whose value has kinds of more than one
   * type (V30 §19, #1352); else `null`.
   */
  readonly keeps: string | null;
}

/** A fix sentence of the current checker, and the sentence the new checker writes for it (#1195 rule 1). */
interface Port {
  readonly from: RegExp;
  /** The new form: the current checker's code, with the subject and the operands the new checker names. */
  readonly to: (found: RegExpExecArray, named: Named) => RegExp;
}

export const escaped = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A sentence as written. */
export const exact = (text: string): RegExp => new RegExp(escaped(text));

/** Code as a fix may write it: as it stands, or in parentheses. */
const grouped = (code: string): string => `(?:${escaped(code)}|\\(${escaped(code)}\\))`;

/** A sentence with `parts`, each code as written (a text) or a pattern (a regex). */
const form = (...parts: readonly (string | RegExp)[]): RegExp =>
  new RegExp(
    parts.map((part) => (typeof part === "string" ? escaped(part) : part.source)).join(""),
  );

export const code = (pattern: string): RegExp => new RegExp(pattern);

/** One of several forms: a fix's code where its predicate holds at the site, else its words. */
const oneOf = (...forms: readonly RegExp[]): RegExp =>
  new RegExp(forms.map((found) => `(?:${found.source})`).join("|"));

/**
 * Whether a subject is a stable path as written, the only subject a fix's example names (Astra r1, r2):
 * a variable, then properties other than `random`, fixed indexes or keys, or indexes held in plain variables; a literal
 * word such as `true` is none. And whether its own text may stand in code: on one line, without a comment.
 */
const NAME = "(?!(?:true|false|null)\\b)[A-Za-z_]\\w*";
/** A key written as text without `${...}`: with escapes, and a `$` only before no `{`. */
const KEY = '"(?:[^"\\\\$]|\\\\.|\\$(?!\\{))*"';
const STABLE = new RegExp(
  `^${NAME}(?:\\.(?!random\\b)[A-Za-z_]\\w*|\\[\\s*(?:-?\\d+|${NAME}|${KEY})\\s*\\])*$`,
);
export const stablePath = (text: string): boolean => STABLE.test(text);
const ownText = (text: string): boolean => !/[\n\r]|\/\/|\/\*/.test(text);
/** A literal beside a named value in a date and time example: a number or a quantity, `true` or `false`. */
const quantity = (text: string): boolean => /^(\d[\w. ]*|true|false)$/.test(text);

/** A fallback in words: after 'otherwise', also one that does not divide by zero. */
const FALLBACK_WORDS = " after 'otherwise'(?: that does not lead to a division by zero)?\\.";

/** A fallback the current checker writes as `...`, in words (#1268: no code that does not compile). */
export const SAME_TYPE = "or give a fallback of the same type with 'otherwise'.";

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
 * and reads a kept value once, else the test in words (#1268). Without the closing period.
 */
export const checkForm = (
  subject: string,
  test: string,
  statement: string | null,
  keeps: string | null = null,
): string => {
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
  // (an askChoice whose buttons return more than one type: the variable declared with their union, V30 §19, #1352)
  return kept === null
    ? `Keep '${subject}' in a new variable${keeps === null ? "" : ` declared with the type '${keeps}'`} and check that it ${words} first`
    : `Keep '${subject}' in a new variable, as in 'let value${keeps === null ? "" : `: ${keeps}`} = ${subject}', ` +
        `and check it, as in 'if value ${test} { ${kept} }'`;
};

/**
 * A fallback's alternative: its code where `codeAt` holds, else after 'otherwise' in words (where the value may divide or
 * reads what may be absent); where unproved also of the same type in words.
 */
const fallbackForm = (fallback: string, proved: boolean): RegExp =>
  code(
    proved
      ? `or give a fallback(?:, as in '${fallback}'\\.|${FALLBACK_WORDS})`
      : `(?:or give a fallback(?:, as in '${fallback}'\\.|${FALLBACK_WORDS})|${escaped(SAME_TYPE)})`,
  );

/**
 * A declaration as the new checker writes it (#1268), from the current checker's `let n: T = ...` or
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

export const PORTS: readonly Port[] = [
  // ADR 0021 rules 1.9 and 3.5: the check, of a variable, or of the subject kept in a variable first, its `let` shown
  // where its own text may stand in code (the owner's review)
  // (a fallback's code where its predicate holds, else in words: where the value may divide, or reads what may be
  // absent)
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
    to: ([, value], { subject, statement, proved, keeps }) =>
      ownText(subject) && value === "..."
        ? exact(`${checkForm(subject, "!= null", statement, keeps)}, ${SAME_TYPE}`)
        : ownText(subject)
          ? form(
              `${checkForm(subject, "!= null", statement, keeps)}, `,
              fallbackForm(`\\(?${grouped(subject)} otherwise ${escaped(value!)}\\)?`, proved),
            )
          : exact(`${checkForm(subject, "!= null", statement, keeps)}.`),
  },
  {
    from: /^Keep it in a variable and check it first, as in: if value (!= null|is .+) \{ \.\.\. \}$/,
    to: ([, test], { subject, statement, keeps }) =>
      exact(`${checkForm(subject, test!, statement, keeps)}.`),
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
  // a speaker's property: the receiver as the source writes it (S9b's speaker flow names the speaker: `INTENDED` in
  // `type-core-messages-parity.test.ts`), without a value to write (#1268)
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
  // ADR 0021 rule 2.2's rounding, as the count's sentence words it (#1173)
  {
    from: /^Round the number with the floor, round or ceil function first\.$/,
    to: ([text]) => exact(text),
  },
  // #1241: each code form where its predicate holds at the diagnosed site (`codeAt`, which
  // `type-core-messages-paste.test.ts` proves), the same fix in words where it does not; so a kept fix is one of the
  // two, with the actual operand and the receiver as the source writes it (the current checker writes '5 s' into an
  // element and a result)
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
