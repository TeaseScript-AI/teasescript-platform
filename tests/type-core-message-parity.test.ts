import assert from "node:assert/strict";
import test from "node:test";
import { compileProject } from "../src/compiler.js";
import { compareProjectPaths } from "../src/project-paths.js";
import { analyseCore } from "../src/type-inference/core/answers.js";
import { coreMessage, messageSource, reported } from "../src/type-inference/core/messages.js";
import type { CoreDiagnostic } from "../src/type-inference/core/result.js";
import { VALUE_KINDS } from "../src/value-kinds.js";
import { coreRequest } from "./helpers/type-core-analysis.js";
import { readFixture } from "./helpers/type-core-fixture.js";

/*
 * The new checker keeps every fix the current checker gives (#1195): on every record of the expectation set, the two
 * checkers' TSV diagnostics pair by file, line and code, and each fix sentence of the current checker's message is in
 * the new checker's, in the new form (`PORTS`), or the pair is one of the intended differences (`INTENDED`). Severity is
 * not compared: where the current checker errs and the new one warns for a possible null or a union value, the
 * narrowing step (#1073) brings the error. When the current checker is removed (#1076), this compares with its messages
 * captured before.
 */

/** A fix sentence of the current checker, and the sentence the new checker writes for it (#1195 rule 1). */
interface Port {
  readonly from: RegExp;
  /** The new form: `…` stands for code the current checker spells with a placeholder (`value`, `this`). */
  readonly to: (found: RegExpExecArray) => string | RegExp;
}

const escaped = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const PORTS: readonly Port[] = [
  // ADR 0021 rules 1.9 and 3.5: the check, of a variable, or of a value kept in a variable first
  {
    from: /^Check it first: if (\S+) != null \{ \.\.\. \}, or give a fallback: \1 otherwise (.+)$/,
    to: ([, name, value]) =>
      `Check '${name}' first, as in 'if ${name} != null { ... }', or give a fallback, as in '${name} otherwise ${value}'.`,
  },
  {
    from: /^Check it first: if (\S+) (!= null|is .+) \{ \.\.\. \}$/,
    to: ([, name, test]) => `Check '${name}' first, as in 'if ${name} ${test} { ... }'.`,
  },
  {
    from: /^Keep it in a variable and check it first, as in: if value != null \{ \.\.\. \}, or give a fallback: value otherwise (.+)$/,
    to: ([, value]) =>
      "Keep '…' in a variable and check the variable first, as in 'if value != null { ... }', or give a fallback, " +
      `as in '… otherwise ${value}'.`,
  },
  {
    from: /^Keep it in a variable and check it first, as in: if value (!= null|is .+) \{ \.\.\. \}$/,
    to: ([, test]) =>
      `Keep '…' in a variable and check the variable first, as in 'if value ${test} { ... }'.`,
  },
  // #1195's decided texts
  {
    from: /^Compare it instead, such as '(.+)'\.$/,
    to: ([, code]) => `Compare it instead, as in '${code}'.`,
  },
  {
    from: /^Check its length instead, such as '(.+)'\.$/,
    to: ([, code]) => `Check its length instead, as in '${code}'.`,
  },
  {
    from: /^Show one of its properties instead\.$/,
    to: () => "Show one of its properties instead, as in '${…}'.",
  },
  {
    from: /^Show its elements with 'toList\(\)\.join\(\)' instead\.$/,
    to: () => "Show all its elements with '${….toList().join()}'.",
  },
  {
    from: /^Put the value in the text instead, as in "(.+)"\.$/,
    to: () => `Put the value in the text instead, as in '"…"'.`,
  },
  // the current checker's fixes, code in single quotes, the value named
  {
    from: /^Select one value with '(.+)', or show every value with '(.+)'\.$/,
    to: ([text]) => text,
  },
  {
    from: /^To allow (both|null), declare (it|the parameter) as '(.+)'\.$/,
    // (a default's or fallback's place named, ADR 0021 rule 7.3)
    to: ([, allow, it, code]) =>
      new RegExp(`[Tt]o allow ${allow}, declare (${it}|'[^']*') as '${escaped(code!)}'\\.`),
  },
  {
    from: /^To allow both, give '(.+)' a first value of type (.+), such as a variable declared with that type\.$/,
    to: ([, place, type]) =>
      `To allow both, give '${place}' a first value of type '${type}', such as a variable declared with that type.`,
  },
  // (the value named where the current checker writes `value`)
  {
    from: /^To show it as text, write "(.+)"\.$/,
    to: ([, code]) => `To show it as text, write '"${code === "${value}" ? "${…}" : code}"'.`,
  },
  { from: /^Use a separate property for a value of another type\.$/, to: ([text]) => text },
  { from: /^Its (only property is|properties are) (.+)\.$/, to: ([text]) => text },
  { from: /^Did you mean '(.+)'\?$/, to: ([text]) => text },
  {
    from: /^Write a number key as text, as in "(.+)"\.$/,
    to: () => `Write a number key as text, as in '"…"'.`,
  },
  { from: /^Check '(.+)' first\.$/, to: ([text]) => text },
  { from: /^Give '(.+)' one type in every element\.$/, to: ([text]) => text },
  // members of a kind without them
  {
    from: /^Convert it to text first with toString\(\.\.\.\)\.$/,
    to: () => "Convert '…' to text first, as in 'toString(…)…'.",
  },
  {
    from: /^Divide it by a unit, as in '(.+)'\.$/,
    to: ([, code]) => `Divide '…' by a unit, as in '${code}'.`,
  },
  { from: /^Use 'contains\(\.\.\.\)' instead\.$/, to: ([text]) => text },
  {
    from: /^Use length, first, last, or random\.$/,
    to: () => "Use 'length', 'first', 'last', or 'random'.",
  },
  {
    from: /^Assign a new text to the variable instead\.$/,
    to: () => "Assign a new text to '…' instead.",
  },
  // a speaker's property, named by the new checker as the source reads it (`people.random`), not by the speaker it holds
  {
    from: /^Assign it before this line, as in '(.+)'\.$/,
    to: () => "Assign the property before this line, as in '… = ...'.",
  },
  {
    from: /^Copy the player profile before this line, as in '(.+)' at the start of the script, or assign '(.+)' first\.$/,
    to: ([text]) => text,
  },
  {
    from: /^Use one of its properties instead, such as '(.+)'\.$/,
    to: () => "Use one of its properties instead, such as '….title'.",
  },
  // date and time operators, the operand named where the current checker writes `value`
  {
    from: /^Convert it first, as in '(.+)', or use calendar units to keep the clock time\.$/,
    to: () =>
      "Convert it first, as in '(….toAbsoluteDateTime() …).toDateTime()', or use calendar units to keep the clock time.",
  },
  {
    from: /^Convert it first, as in '(.+)'\.$/,
    to: () => /Convert (it|'[^']*') first, as in '[^']*'\./,
  },
  { from: /^Write '(.+)'\.$/, to: ([text]) => text },
  { from: /^(Compare|Divide) two calendar durations, or two durations\.$/, to: ([text]) => text },
  {
    from: /^Compare its date, as in 'toDate\((.+)\)'\.$/,
    to: () => "Compare its date, as in 'toDate(…)'.",
  },
  {
    from: /^Combine it with a date first, as in '(.+)'\.$/,
    to: () => "Combine it with a date first, as in 'toDateTime(date, …)'.",
  },
  {
    from: /^Subtract their dates with '(.+)', or convert both with toAbsoluteDateTime\(\) for the elapsed time\.$/,
    to: () =>
      "Subtract their dates with 'toDate(…) - toDate(…)', or convert both with 'toAbsoluteDateTime()' for the elapsed time.",
  },
  // ADR 0021 rule 2.2's rounding, as the count's sentence words it (S8c's, #1173)
  {
    from: /^Round it with floor\(\.\.\.\), round\(\.\.\.\), or ceil\(\.\.\.\) first\.$/,
    to: ([text]) => text,
  },
];

/** The review's test for a sentence that names a fix (`message-review-2026-10-27/compare.mjs`): every one is ported. */
const FIX =
  /^(Round|Use|Put|Compare|Check|Declare|Write|Add|Select|Its |Remove|Call|Store|Give|Copy|Index|To |Convert|Move|Pass|Show|Turn|Test|Assign|Make|Keep|Start|Set|Load|Save|Wrap|Split|Read|Divide|Combine|Subtract|Did you mean)|\bas in\b|\bsuch as\b|\bdeclare it\b/;

const sentences = (text: string): string[] => text.split(/(?<=\.)\s+(?=[A-Z'"])/);

/** A message's fix sentences: each after its first sentence that names a fix, as the review found them. */
function fixes(message: string): string[] {
  return sentences(message)
    .slice(1)
    .filter((sentence) => FIX.test(sentence) && !sentence.startsWith("If it"));
}

/** A port's new form as a pattern: `…` any code within one pair of single quotes. */
function pattern(form: string | RegExp): RegExp {
  return form instanceof RegExp ? form : new RegExp(form.split("…").map(escaped).join("[^']*"));
}

interface Pair {
  readonly record: string;
  readonly current: string;
  readonly diagnostic: CoreDiagnostic;
  readonly message: string;
  /** The current checker's fixes and their new forms; `null` where no port takes the fix. */
  readonly forms: readonly { readonly fix: string; readonly form: RegExp | null }[];
}

const kept = (pair: Pair): boolean =>
  pair.forms.every(({ form }) => form !== null && form.test(pair.message));

/** Whether a message names every kind of a diagnostic's value. */
function namedIn(message: string, diagnostic: CoreDiagnostic): boolean {
  return (
    diagnostic.kind !== "written-type" &&
    diagnostic.kinds.length > 0 &&
    diagnostic.kinds.every(
      (kind) =>
        kind !== "unknown" &&
        kind !== "empty" &&
        message.toLowerCase().includes(VALUE_KINDS[kind].description.toLowerCase()),
    )
  );
}

function pairs(): Pair[] {
  const found: Pair[] = [];
  for (const record of readFixture()) {
    const files = [...record.files].sort((a, b) => compareProjectPaths(a.path, b.path));
    const request = coreRequest(files);
    if (request === null) continue;
    const source = messageSource(files.map((file) => file.source));
    const core = new Map<string, { diagnostic: CoreDiagnostic; message: string }[]>();
    for (const diagnostic of analyseCore(request).diagnostics.filter(reported)) {
      const key = `${files[diagnostic.site.file]!.path}:${source.line(diagnostic.site)}:${diagnostic.code}`;
      const list = core.get(key) ?? [];
      list.push({ diagnostic, message: coreMessage(diagnostic, source) });
      core.set(key, list);
    }
    if (core.size === 0) continue;
    for (const current of compileProject(files).diagnostics) {
      if (!current.code.startsWith("TSV")) continue;
      const candidates = core.get(`${current.path}:${current.span.start.line + 1}:${current.code}`);
      if (candidates === undefined) continue;
      const forms = fixes(current.message).map((fix) => {
        for (const port of PORTS) {
          const match = port.from.exec(fix);
          if (match !== null) return { fix, form: pattern(port.to(match)) };
        }
        return { fix, form: null };
      });
      // (several diagnostics on one line and code: the one that keeps the fixes, else one whose kinds the current
      // message names, else the last, as the review paired)
      const options = candidates.map(({ diagnostic, message }): Pair => ({
        record: record.name,
        current: current.message,
        diagnostic,
        message,
        forms,
      }));
      found.push(
        options.find(kept) ??
          options.find(({ diagnostic }) => namedIn(current.message, diagnostic)) ??
          options.at(-1)!,
      );
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
    matches: ({ diagnostic }) =>
      diagnostic.class === "warning-runtime-check" && diagnostic.kinds.includes("unknown"),
    count: 4,
  },
  {
    rule: "ADR 0021 rule 3.4: the current checker's union holds a whole list beside another type",
    matches: ({ forms }) => forms.some(({ fix }) => /'[^']*\[\] \|/.test(fix)),
    count: 2,
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
