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

const PORTS: readonly Port[] = [
  // ADR 0021 rules 1.9 and 3.5: the check, of a variable, or of the subject kept in a variable first
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
      form(
        `Keep '${subject}' in a variable and check the variable first, as in 'if value != null { ... }', or give a ` +
          "fallback, as in '",
        code(`\\(?${grouped(subject)} otherwise ${escaped(value!)}\\)?`),
        "'.",
      ),
  },
  {
    from: /^Keep it in a variable and check it first, as in: if value (!= null|is .+) \{ \.\.\. \}$/,
    to: ([, test], { subject }) =>
      exact(
        `Keep '${subject}' in a variable and check the variable first, as in 'if value ${test} { ... }'.`,
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
      form(
        "Show one of its properties instead, as in '${",
        subject,
        code("\\.[A-Za-z_]\\w*"),
        "}'.",
      ),
  },
  {
    from: /^Show its elements with 'toList\(\)\.join\(\)' instead\.$/,
    to: (_, { subject }) => exact(`Show all its elements with '\${${subject}.toList().join()}'.`),
  },
  // (the text of the whole chain of `+`, which the compile check below proves)
  {
    from: /^Put the value in the text instead, as in "(.+)"\.$/,
    to: () => /Put the value in the text instead, as in '"[^']*"'\./,
  },
  // the current checker's fixes, code in single quotes, the value named
  {
    from: /^Select one value with '(.+)', or show every value with '(.+)'\.$/,
    to: ([text]) => exact(text),
  },
  {
    from: /^To allow (both|null), declare (it|the parameter) as '(.+)'\.$/,
    // (a default's or fallback's place named, ADR 0021 rule 7.3)
    to: ([, allow, it, fix]) =>
      form(code(`[Tt]o allow ${allow}, declare (?:${it}|'[^']*') as '`), fix!, "'."),
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
    to: ([, fix], { subject }) =>
      exact(`To show it as text, write '"${fix === "${value}" ? `\${${subject}}` : fix}"'.`),
  },
  { from: /^Use a separate property for a value of another type\.$/, to: ([text]) => exact(text) },
  { from: /^Its (only property is|properties are) (.+)\.$/, to: ([text]) => exact(text) },
  { from: /^Did you mean '(.+)'\?$/, to: ([text]) => exact(text) },
  {
    from: /^Write a number key as text, as in "(.+)"\.$/,
    to: (_, { subject }) =>
      exact(
        `Write a number key as text, as in '"${/^\d+$/.test(subject) ? subject : `\${${subject}}`}"'.`,
      ),
  },
  { from: /^Check '(.+)' first\.$/, to: ([text]) => exact(text) },
  { from: /^Give '(.+)' one type in every element\.$/, to: ([text]) => exact(text) },
  // members of a kind without them
  {
    from: /^Convert it to text first with toString\(\.\.\.\)\.$/,
    to: (_, { subject, member }) =>
      exact(`Convert '${subject}' to text first, as in 'toString(${subject})${member}'.`),
  },
  {
    from: /^Divide it by a unit, as in '.+ \/ 1 (\w+)'\.$/,
    to: ([, unit], { subject }) =>
      form(`Divide '${subject}' by a unit, as in '`, code(grouped(subject)), ` / 1 ${unit}'.`),
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
    to: (_, { subject }) => exact(`Use one of its properties instead, such as '${subject}.title'.`),
  },
  // date and time operators and fields, the operands named where the current checker writes `value`
  {
    from: /^Convert it first, as in '(.+)', or use calendar units to keep the clock time\.$/,
    to: (_, { operands: [left = "", right = ""] }) =>
      form(
        "Convert it first, as in '(",
        code(grouped(left)),
        ".toAbsoluteDateTime() ",
        code("[-+]"),
        " ",
        code(grouped(right)),
        ").toDateTime()', or use calendar units to keep the clock time.",
      ),
  },
  {
    from: /^Convert it first, as in '\(.+\)\.toAbsoluteDateTime\(\)'\.$/,
    to: (_, { operands: [left = "", right = ""] }) =>
      form(
        "Convert it first, as in '(",
        code(grouped(left)),
        ".toDateTime() ",
        code("[-+]"),
        " ",
        code(grouped(right)),
        ").toAbsoluteDateTime()'.",
      ),
  },
  {
    from: /^Convert it first, as in '.+\.toDateTime\(\)\.(\w+)'\.$/,
    to: ([, field], { subject }) =>
      form(
        `Convert '${subject}' first, as in '`,
        code(grouped(subject)),
        `.toDateTime().${field}'.`,
      ),
  },
  { from: /^Write '(.+)'\.$/, to: ([text]) => exact(text) },
  {
    from: /^(Compare|Divide) two calendar durations, or two durations\.$/,
    to: ([text]) => exact(text),
  },
  {
    from: /^Compare its date, as in 'toDate\((.+)\)'\.$/,
    to: (_, { operands: [, right = ""] }) => exact(`Compare its date, as in 'toDate(${right})'.`),
  },
  {
    from: /^Combine it with a date first, as in '(.+)'\.$/,
    to: (_, { subject }) =>
      exact(`Combine it with a date first, as in 'toDateTime(date, ${subject})'.`),
  },
  {
    from: /^Subtract their dates with '(.+)', or convert both with toAbsoluteDateTime\(\) for the elapsed time\.$/,
    to: (_, { operands: [left = "", right = ""] }) =>
      exact(
        `Subtract their dates with 'toDate(${left}) - toDate(${right})', or convert both with ` +
          "'toAbsoluteDateTime()' for the elapsed time.",
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
  return (subject ? 2 : 0) + (kinds ? 1 : 0);
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

/** Pairs whose fixes differ on purpose, by the rule that makes them differ, and how many. */
interface Intended {
  readonly rule: string;
  readonly matches: (pair: Pair) => boolean;
  readonly count: number;
}

const INTENDED: readonly Intended[] = [
  {
    rule: "S8c's (#1173): a number where a whole number is required, the count's and the written integer's sentences",
    matches: ({ diagnostic }) =>
      diagnostic.kind !== "written-type" &&
      (diagnostic.rule.rule === "count" ||
        ((diagnostic.rule.rule === "store" || diagnostic.rule.rule === "fallback") &&
          diagnostic.rule.type.includes("integer") &&
          diagnostic.kinds.includes("number"))),
    count: 177,
  },
  {
    rule:
      "ADR 0021 rule 3.5: the value may also be of the type the use takes (its written union, a fallback), so the " +
      "new checker names the type test where the current checker's flow sees one type and gives that type's fix; " +
      "the flow comes with narrowing (#1073)",
    matches: ({ diagnostic, message }) =>
      diagnostic.class === "warning-runtime-check" &&
      diagnostic.fits.length > 0 &&
      !diagnostic.kinds.includes("null") &&
      /'if [^']* is [^']*'/.test(message),
    count: 11,
  },
  {
    rule:
      "ADR 0021 rule 1.7: a value the new checker does not know (from outside the script, or an operation it does " +
      "not follow) is checked with a type test, where the current checker knows its type",
    matches: ({ diagnostic, current }) =>
      diagnostic.class === "warning-runtime-check" &&
      diagnostic.kinds.includes("unknown") &&
      !/^Speaker /.test(current),
    count: 4,
  },
  {
    rule: "ADR 0021 rule 3.4: the current checker's union holds a whole list beside another type",
    matches: ({ forms }) => forms.some(({ fix }) => /'[^']*\[\] \|/.test(fix)),
    count: 2,
  },
  {
    rule:
      "S9b's speaker flow (#1072, unit 6): the fix names the receiver as the source writes it ('people.random.n = " +
      "...'), the current checker the speaker it holds ('player.n = ...')",
    matches: ({ current, message, named }) =>
      /^Speaker '[^']+' has no /.test(current) &&
      !current.startsWith(`Speaker '${named.subject}'`) &&
      message.includes(`as in '${named.subject}.`),
    count: 5,
  },
];

test("the new checker keeps every fix the current checker gives, in the new form (#1195)", (t) => {
  const all = pairs();
  const compared = all.filter((pair) => pair.forms.length > 0);
  const differing = compared.filter((pair) => !kept(pair));
  const counts = INTENDED.map(() => 0);
  const unexplained: string[] = [];
  let lost = 0;
  for (const pair of differing) {
    if (fixes(pair.message).length === 0) lost += 1;
    const index = INTENDED.findIndex((intended) => intended.matches(pair));
    if (index < 0)
      unexplained.push(`${pair.record}\n  current: ${pair.current}\n  new:     ${pair.message}\n`);
    else counts[index]! += 1;
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

/**
 * Sources whose diagnostic suggests code, `⟦…⟧` around the code the fix replaces: atomic and composed operands, scalar
 * and structured values, each fix's family once. A declaration's `= ...` keeps the source's own start value.
 */
const REPAIRS: readonly (readonly [string, RegExp])[] = [
  // the text join, a chain of `+`, also as a warning
  ['let score = 3\nsay ⟦"You have " + score + " points"⟧\nexit\n', /as in '([^']*)'/],
  ['function f(n) {\nsay ⟦"You have " + n + " points"⟧\n}\nf(1)\nf(2)\nexit\n', /as in '([^']*)'/],
  // text in a variable, a sum of numbers kept whole
  ['let prefix = "You have "\nlet n = 1\nsay ⟦prefix + n + " points"⟧\nexit\n', /as in '([^']*)'/],
  [
    'function f(n) {\nlet prefix = "You have "\nsay ⟦prefix + n + " points"⟧\n}\nf(1)\nf(2)\nexit\n',
    /as in '([^']*)'/,
  ],
  ['let n = 1\nsay ⟦"Sum: " + (n + 2)⟧\nexit\n', /as in '([^']*)'/],
  // date and time operators, composed operands grouped, also as a warning
  [
    'let t = toAbsoluteDateTime("2026-01-01T00:00:00Z")\nsay ⟦(t + 1 s) + 1 calendar day⟧\nexit\n',
    /as in '([^']*)'/,
  ],
  [
    'let t = toDateTime("2026-01-01T00:00:00")\nsay ⟦(t + 1 calendar day) + 1 s⟧\nexit\n',
    /as in '([^']*)'/,
  ],
  ['say toDate("2026-10-23") + ⟦1 day⟧\nexit\n', /Write '([^']*)'/],
  ['say toDate("2026-10-23") < ⟦toDateTime("2026-10-23T12:00:00")⟧\nexit\n', /as in '([^']*)'/],
  [
    'say ⟦toDateTime("2026-10-23T12:00:00") - toDateTime("2026-10-22T12:00:00")⟧\nexit\n',
    /dates with '([^']*)'/,
  ],
  // members of a kind without them, on a composed receiver
  [
    'let t = toAbsoluteDateTime("2026-01-01T00:00:00Z")\nsay ⟦(t + 1 s).year⟧\nexit\n',
    /as in '([^']*)'/,
  ],
  ["say ⟦(1 s + 2 s).seconds⟧\nexit\n", /as in '([^']*)'/],
  ["say ⟦(1 s+2 s*3).seconds⟧\nexit\n", /as in '([^']*)'/],
  ["let n = 1\nsay ⟦n.length⟧\nexit\n", /as in '([^']*)'/],
  [
    // (the current checker's example property, of a speaker that has it)
    'speaker sage { title: "Sage" }\nlet value = sage\nsay ⟦value.get(0, default: 3)⟧\nexit\n',
    /such as '([^']*)'/,
  ],
  // `${...}`: an object's first property it shows, a set
  ['let slave = {nested: {name: "A"}, age: 1}\nsay "⟦${slave}⟧"\nexit\n', /as in '([^']*)'/],
  ['let slave = {names: ["A"], age: 1}\nsay "⟦${slave}⟧"\nexit\n', /as in '([^']*)'/],
  ['let s = set[1]\nsay "⟦${s}⟧"\nexit\n', /with '([^']*)'/],
  // a condition, a key, text
  ['let count = 2\nif ⟦count⟧ { say "x" }\nexit\n', /as in '([^']*)'/],
  ['let toys = [1]\nif ⟦toys⟧ { say "x" }\nexit\n', /as in '([^']*)'/],
  ['let d = dict{"1": 5}\nsay d[⟦1⟧]\nexit\n', /as in '([^']*)'/],
  ["let caption: string = ⟦1⟧\nexit\n", /write '([^']*)'/],
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

test("the code each fix suggests compiles where it stands and runs (#1195)", () => {
  for (const [marked, pick] of REPAIRS) {
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
    const failures = session.run().events.filter((event) => event.kind === "runtimeFailure");
    assert.deepEqual(failures, [], fixed);
  }
});
