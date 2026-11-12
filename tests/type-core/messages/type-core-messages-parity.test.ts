import assert from "node:assert/strict";
import test from "node:test";
import { compileProject } from "../../../src/compiler.js";
import { compareProjectPaths } from "../../../src/project-paths.js";
import { analyseCore } from "../../../src/type-inference/core/answers.js";
import {
  checkedResult,
  reportedDiagnostics,
} from "../../../src/type-inference/core/check-result/check-result.js";
import {
  coreMessage,
  messageSource,
  type MessageSource,
} from "../../../src/type-inference/core/messages.js";
import type { CheckedDiagnostic } from "../../../src/type-inference/core/result.js";
import { kindsInOrder } from "../../../src/type-inference/core/items.js";
import { parsedExpression, typeText } from "../../../src/type-inference/core/messages/words.js";
import { VALUE_KINDS } from "../../../src/value-kinds.js";
import { coreRequest, type SourceFile } from "../../helpers/type-core-analysis.js";
import {
  heldBack,
  readFixture,
  type FixtureRecord,
} from "../../helpers/type-core/type-core-fixture.js";
import { sentences } from "../../helpers/type-core-oracles.js";
import {
  type Compared,
  type Named,
  escaped,
  exact,
  code,
  stablePath,
  SAME_TYPE,
  checkForm,
  PORTS,
} from "../../helpers/type-core/type-core-message-ports.js";

/*
 * The new checker keeps every fix the current checker gives (#1195): on every record of the expectation set, the two
 * checkers' TSV diagnostics pair by file, line and code, and each fix sentence of the current checker's message is in
 * the new checker's, in the new form (`PORTS`), or the pair is one of the intended differences (`INTENDED`); and the
 * code the fixes suggest compiles where it stands. Severity is not compared: where the current checker errs and the
 * new one warns for a possible null or a union value, the narrowing step (#1073) brings the error. When the current
 * checker is removed (#1076), this compares with its messages captured before.
 */

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
      keeps: null,
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
    keeps: choiceUnion(diagnostic, subject),
  };
}

/**
 * V30 §19: the union a variable keeping a warned `askChoice` declares, of every known kind of its value (the warning's,
 * those that fit and those the site's other warnings report), where they are more than one type (whole numbers and
 * numbers are one); else `null`.
 */
function choiceUnion(diagnostic: Compared, subject: string): string | null {
  if (diagnostic.class !== "warning-runtime-check") return null;
  let expression = parsedExpression(subject)?.expression;
  while (expression?.kind === "parenthesizedExpression") expression = expression.expression;
  if (expression?.kind !== "interactionExpression" || expression.interactionKind !== "choice")
    return null;
  const kinds = kindsInOrder(
    new Set(
      [...diagnostic.kinds, ...diagnostic.fits, ...diagnostic.besides].filter(
        (kind) => kind !== "unknown" && kind !== "empty",
      ),
    ),
  );
  const values = kinds.filter((kind) => kind !== "null");
  return values.length > 1 && !values.every((kind) => kind === "integer" || kind === "number")
    ? typeText(kinds)
    : null;
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

/** The type test of a subject (ADR 0021 rule 3.5), as `checkForm` writes it: in code, or in words. */
const typeTest = ({ subject, statement, keeps }: Named, type: string): RegExp =>
  code(
    `(?:${escaped(`${checkForm(subject, `is ${type}`, statement, keeps)}.`)}|` +
      `${escaped(`${checkForm(subject, `is ${type}`, null, keeps)}.`)})`,
  );

/**
 * Each fix of a pair as the new checker words it where its code is not proved: its port's form with no
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

/** The union tests a record's N10 payloads name (`if x is T`), by record. */
const ROUTE_TESTS: ReadonlyMap<string, readonly string[]> = new Map(
  readFixture().map((record) => [
    record.name,
    record.expected.diagnostics.flatMap((d) =>
      d.requiredCheck === undefined
        ? []
        : d.requiredCheck.missingTests.filter((t) => / is /.test(t)),
    ),
  ]),
);
const routeTests = (record: string): readonly string[] => ROUTE_TESTS.get(record) ?? [];

const INTENDED: readonly Intended[] = [
  {
    rule:
      "AD-1 (#1073 PR 4): a written union's member the use does not take, brought by a route " +
      "without a check, is the route rule's error, whose fix is the test the route lacks (`if x is T`, its record's " +
      "N10 payload), not the current checker's conversion of a value it took as definite",
    matches: (pair) =>
      routeTests(pair.record).length > 0 &&
      /^'[^']+' can be [^.]+ here because of line \d+\./.test(pair.message),
    // (the test its record's payload names: as code, or in words of its type where its code is not proved, #1449)
    replacement: (pair) => {
      const tests = routeTests(pair.record);
      const kind = /^if .+ is (\w+)$/.exec(tests[0] ?? "")?.[1] ?? "(?!)";
      return new RegExp(
        tests.map((test) => `as in '${escaped(test)} \\{`).join("|") +
          `|Check that '[^']+' is [^.']*\\(${kind}\\) first\\.`,
      );
    },
    count: 10,
  },
  {
    rule:
      "the new checker's code stands only where it is proved where it is pasted (no other diagnostic in " +
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
    // (5 more since #1073 PR 4: the route rule's errors beside a union, whose fallback for null alone is not proved)
    count: 22,
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
      "N2 (#1073, S10 part 2b): the null check the current checker asks for is written and holds at a read in a " +
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
    // (1 since #1073 PR 4: its 10 written-union pairs are the route rule's errors, the AD-1 entry's)
    count: 1,
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
    // (0 since #1073 PR 4: these null fixes are the route rule's errors', in words where their code is not proved, the
    // #1449 entry's)
    count: 0,
  },
  {
    rule:
      "#1072 (V30 §18): the new checker decides a chain of 'otherwise' from its answer at each left read; where the " +
      "inner chain's value may be null there (a branch stores null into it), the parenthesized chain is the first " +
      "value never null, so the warning names the outer fallback",
    matches: ({ current, message }) =>
      / is never null here, so the fallback/.test(current) &&
      /^'\(.* otherwise .*\)' is never null here/.test(message),
    replacement: () => exact("Remove 'otherwise null'."),
    count: 1,
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
  // Codex r1, r4, r5, Astra r2: a code form where its predicate holds at the site, the same fix in words
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
