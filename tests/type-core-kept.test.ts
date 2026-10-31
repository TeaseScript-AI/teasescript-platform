import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";

/*
 * The core makes every path and key through the helpers of `budget.ts` and `definitions.ts`: a kept one (`keptText`,
 * `keptKey`, `keptSteps`, …) where a structure keeps what it makes, which charges its size to the literal work first
 * (TABLE r4.58), and its plain twin (`pathText`, `keyOf`, `joinSteps`, …) where a step only looks it up or passes it on.
 * A literal's depth, breadth and names make these long and many, and each one kept uncharged let a deep or long-named
 * literal reach the heap before the allowance (the deep-literal reviews' B1 and R2-B1), so a path or key made past the
 * helpers is a choice no one made. This scan is a tripwire for the usual spellings, not a proof: it finds a path's text
 * (`.join(".")`), its steps (`.split(".")`), a composite key (`a|b`), a text one step longer (`a.b`), an array joined to
 * another (`.concat(`), and an array spread of a path, known by the core's names for one (`at`, `path`, `rest`, …, also
 * as a member: `holder.path.slice(1)`). It misses a spread of a path under another name, a copy by `slice`, `map` or
 * `Array.from`, a path grown by `push`, and a path kept through a plain helper. Each found must be one listed below
 * with the reason it needs no helper; a new one fails until it goes through the helpers or is listed.
 */

const CORE = new URL("../../src/type-inference/core/", import.meta.url);

/** The core's names for a path, its steps or its text, by which the scan knows a spread of one. */
const PATH_NAMES = new Set([
  ...["at", "path", "paths", "rest", "below", "before", "after", "strip", "steps", "prefix", "key"],
  ...[
    "projection",
    "shift",
    "along",
    "collection",
    "within",
    "base",
    "full",
    "source",
    "label",
    "stand",
  ],
]);

/** The forms of a construction found per line, by name. */
const FORMS: readonly (readonly [string, RegExp])[] = [
  ["join", /\.join\("\."\)/g],
  ["split", /\.split\("\."\)/g],
  ["composite", /\$\{[^`]*?\}\||\|\$\{/g],
  ["step", /\}\.\$\{/g],
  ["concat", /\.concat\(/g],
];

/** The constructions outside the helpers, by file, member and form: how many, and why they need no charge. */
const LISTED: Readonly<Record<string, readonly [number, string]>> = {
  "admission/structure.ts listOf spread": [
    1,
    "the list of the paths collected, each made by a kept helper",
  ],
  "admission/literals.ts literalElements spread": [
    1,
    "a list of paths, each made by a kept helper",
  ],
  // the candidate's lowering, after the analysis (no ledger): what it keeps is the analysis's own paths again, or cut
  "backend.ts outsideAnswers spread": [
    2,
    "a lookup of a variable's element levels, its path then at most SLICE_DEPTH",
  ],
  "consumer.ts #answerTask spread": [
    4,
    "paths below a parse's call, cut at SLICE_DEPTH; lookups of its landing below",
  ],
  "consumer.ts #contractTask composite": [
    1,
    "a memo key: a store target's path (a charged definition key), cut below",
  ],
  "consumer.ts #contractTask join": [
    1,
    "a memo key: a store target's path (a charged definition key), cut below",
  ],
  "consumer.ts #fillTask spread": [
    2,
    "a store target's path one step deeper, descents cut at SLICE_DEPTH in total",
  ],
  "consumer.ts #landing spread": [
    1,
    "a node's path in the literal it is in, one per cell, as admission keeps (charged)",
  ],
  "consumer.ts admittedType spread": [
    2,
    "a lookup of a place's element levels, not kept, cut at SLICE_DEPTH in total",
  ],
  "consumer.ts coreFacts spread": [1, "a lookup of a place's element levels, not kept"],
  "consumer.ts placeType spread": [
    2,
    "a lookup of a place's element levels, not kept, cut at SLICE_DEPTH in total",
  ],
  "consumer.ts expected spread": [1, "a lookup of a landing's level, not kept"],
  "consumer.ts fallbackSteps split": [
    1,
    "a C10 target's element steps read from its text, not kept",
  ],
  "consumer.ts fieldOrder spread": [1, "field names, no path"],
  "consumer.ts levelsOf spread": [
    2,
    "a type plan's levels: a written type's, or a plan cut at SLICE_DEPTH",
  ],
  "consumer.ts stored join": [1, "a store's target name in a message"],
  "consumer.ts takesNull spread": [2, "lookups of a landing's levels, not kept"],
  "contract/identity.ts carriedBy step": [1, "a method's name, two identifiers"],
  "contract/levels.ts groupsAt composite": [
    3,
    "an entry's text, charged by `kept` before it is kept",
  ],
  "contract/key-contract.ts keyContract spread": [2, "items, no path"],
  "contract/levels.ts levelsOf spread": [2, "a copy of a set of path ids, charged by `keep`"],
  "definitions.ts keyBelow join": [2, "a helper itself"],
  "definitions.ts keyBelow step": [1, "a helper itself"],
  "definitions.ts keyBelowText step": [1, "a helper itself"],
  "definitions.ts keyOf composite": [1, "a helper itself"],
  "definitions.ts keyOf join": [1, "a helper itself"],
  "definitions.ts keyOfText composite": [1, "a helper itself"],
  "definitions.ts keyPath split": [1, "a helper itself"],
  "exact-path.ts #defVal spread": [1, "items, no path"],
  "exact-path.ts #stopAt spread": [2, "the spans per prefix of a path, no path"],
  "items.ts union composite": [2, "two item ids"],
  // a diagnostic's sentences (#1195), made for the author after the analysis, never kept by it
  "messages/words.ts choiceSubject step": [
    1,
    "a choice object and the property its button returns, named in a sentence",
  ],
  "messages.ts coreMessage step": [
    1,
    "a choice object and the property its button returns, named in a sentence",
  ],
  "messages/stores.ts elementOf join": [
    1,
    "a collection's code in a sentence, its property names joined",
  ],
  "messages/errors.ts errorSentence step": [8, "a sentence's period before its fix, no path"],
  "messages/site.ts landingOf spread": [
    1,
    "the way from a variable to a warned value, made once for a fix after the analysis and dropped",
  ],
  "messages/errors.ts mixedSentence join": [1, "an object's property names in a sentence, joined"],
  "messages/errors.ts memberFix step": [2, "a receiver and its member as the fix's code"],
  "messages/warnings.ts memberWarningFix step": [
    1,
    "a receiver and its property as the fix's code",
  ],
  "messages/errors.ts shownFix step": [
    1,
    "an object's code and its first property as the fix's code",
  ],
  "operator-table.ts DURATIONS composite": [2, "the operator table's constant text"],
  "result.ts targetName join": [1, "a target's name, made by the tests alone"],
  "result.ts targetName spread": [1, "a target's name, made by the tests alone"],
};

/**
 * `text` without its comments, each character of one a space (its lines kept): strings are skipped whole, and a
 * template's text is kept as text (a `//` there is no comment) while its interpolations are read as code.
 */
function withoutComments(text: string): string {
  let out = "";
  // per open interpolation, the braces open inside it; in a template's text while `template` holds
  const braces: number[] = [];
  let template = false;
  for (let index = 0; index < text.length;) {
    const char = text[index]!;
    const end = (from: number): number => (from < 0 ? text.length : from);
    if (template) {
      const length = char === "\\" || text.startsWith("${", index) ? 2 : 1;
      if (char === "`") template = false;
      else if (length === 2 && char === "$") {
        template = false;
        braces.push(0);
      }
      out += text.slice(index, index + length);
      index += length;
    } else if (text.startsWith("//", index)) {
      const stop = end(text.indexOf("\n", index));
      out += " ".repeat(stop - index);
      index = stop;
    } else if (text.startsWith("/*", index)) {
      const stop = end(text.indexOf("*/", index)) + 2;
      out += text.slice(index, stop).replace(/[^\n]/g, " ");
      index = stop;
    } else if (char === '"' || char === "'") {
      let stop = index + 1;
      while (stop < text.length && text[stop] !== char) stop += text[stop] === "\\" ? 2 : 1;
      out += text.slice(index, stop + 1);
      index = stop + 1;
    } else {
      if (char === "`") template = true;
      else if (char === "{" && braces.length > 0) braces[braces.length - 1] = braces.at(-1)! + 1;
      else if (char === "}" && braces.length > 0) {
        if (braces.at(-1) === 0) {
          braces.pop();
          template = true;
        } else braces[braces.length - 1] = braces.at(-1)! - 1;
      }
      out += char;
      index += 1;
    }
  }
  return out;
}

/** The offsets of the spreads of a path inside an array literal (`[...at, "element"]`, `[step, ...rest]`). */
function pathSpreads(text: string): number[] {
  const out: number[] = [];
  for (const match of text.matchAll(
    /\.\.\.\(?\s*((?:this\.)?#?[A-Za-z_]\w*(?:\??\.#?[A-Za-z_]\w*)*)/g,
  )) {
    const parts = match[1]!.split(".").map((part) => part.replace(/[?#]/g, ""));
    // a call: what it is called on (`path.slice(…)`, `holder.path.slice(…)`); else the value read (`e.at`, `rest`)
    const names =
      text[match.index + match[0].length] === "(" ? parts.slice(0, -1) : parts.slice(-1);
    if (!names.some((name) => PATH_NAMES.has(name))) continue;
    let depth = 0;
    for (let at = match.index - 1; at >= 0; at -= 1) {
      const char = text[at]!;
      if (")]}".includes(char)) depth += 1;
      else if ("([{".includes(char) && depth-- === 0) {
        if (char === "[") out.push(match.index);
        break;
      }
    }
  }
  return out;
}

/** A line that declares a function or a class member, and its name. */
const DECLARATION =
  /^(?:export )?(?:function\*? (\w+)|(?:const|let) (\w+) =)|^ {2}(?:public |private |protected |static |readonly |get |set |async )*\*?(#?\w+)\s*(?:<[^>]*>)?\(/;

/** The constructions of one file, by member and form, with the lines they are on. */
function constructions(file: string, source: string): Map<string, string[]> {
  const lines = withoutComments(source).split("\n");
  const members: string[] = [];
  let member = "(top)";
  for (const line of lines) {
    const declared = DECLARATION.exec(line);
    // (an indented call statement is no member: `  keep(work, units);`)
    if (
      declared?.[3] === undefined ||
      !/^\s+(if|for|while|return|switch|catch)\b|[;,]\s*$/.test(line)
    )
      member = declared?.[1] ?? declared?.[2] ?? declared?.[3] ?? member;
    members.push(member);
  }
  const found = new Map<string, string[]>();
  const add = (index: number, form: string): void => {
    const key = `${file} ${members[index]} ${form}`;
    found.set(key, [...(found.get(key) ?? []), `${file}:${index + 1}: ${lines[index]!.trim()}`]);
  };
  for (const [index, line] of lines.entries())
    for (const [form, pattern] of FORMS) for (const _ of line.matchAll(pattern)) add(index, form);
  const text = lines.join("\n");
  for (const offset of pathSpreads(text))
    add(text.slice(0, offset).split("\n").length - 1, "spread");
  return found;
}

/**
 * A text or an array a plain twin makes (`joinParts`, `pathText`, `keyOf`, `joinSteps`, `keyPath`, …), or a template of
 * a path or key (`` `k${key}` ``), is
 * for a lookup or to pass on; one a structure keeps is charged first: made by a kept helper, or charged where it is
 * inserted (`keepText(work, memoKey.length)` before a memo stores it). A read's snapshot made by `joinParts` and kept in
 * a memo, and a stop's kept in a set of distinct ones, passed the scan above, which reads how a text is made, not what
 * keeps it (the deep-literal review's R3-B1). A path's copy by `slice` of one of the core's names for a path is kept
 * the same way (a task's strip below a literal's step, a split's rest in a memo: R5-B1, R6-B1). This scan is a tripwire
 * for these constructions in a member, each counted only outside a kept helper's own arguments (judged by the brackets
 * around it, so a kept call beside it or in another branch charges nothing of it) and outside strings and comments.
 * For locals, it follows a plain twin, a template of a path, a path's slice, or a call of a member whose return value
 * holds a path's slice as its own value (to a fixed point across the core's files; a kept helper and a yield's value
 * never), made as the local's own value (declared or assigned), into a `.set`, `.add` or `.push` that stores it
 * (as an argument, or inside an array or an object there) with no charge naming it before the store (a kept helper,
 * `keepText`, or the ledger's `charge` by its length). For constructions stored as they are made, it checks a path's
 * slice anywhere in the stored argument, and a plain twin or a template of a path as the argument's own value (inside
 * an array or an object there too). It misses a text or a copy kept under another name, returned by a call it does not
 * follow (`aliasKey`, `frame(root)`, an array built by `push`), handed to a member that keeps it (`#add`), or kept in
 * an object after it was made. It follows a call's result only through a local it is bound to: a call stored as it is
 * made (`memo.set(1, this.produce(path))`, `pending.push(makeAnswer(path))`) is not followed, and a member returning a
 * plain twin's array (`return joinSteps(path, ["x"])`) is no returning member. Conservatively, a member returning
 * something of a slice (`path.slice(1).length`, stored as a number) or a slice it charged before returning it counts as
 * returning a slice, and a charge naming a returned object covers all of it, though only one of its fields was charged;
 * a quoted string holding `${path}`-like text counts as a template too.
 * A tripwire, not a proof: the account of the walks' kept arrays (the pull request) is the evidence of what the core
 * keeps.
 */
const PLAIN_TWIN =
  /\b(?:joinParts|pathText|keyOf|keyBelow|keyBelowText|keyPathText|keyOfText|stepText|stepsText|stepsPrefixText|joinSteps|splitPath|keyPath|prefixesOf|keyAt|keyBelowIn|keyParentIn|keyStepsIn|keyAtRef|keyBelowRef)\(/;

/** A charge or a kept helper: its call before a store, naming the text, charges it (`keepText(work, key.length)`). */
const CHARGE = /(?:\b(?:kept\w*|keepText|keep|charge)|#kept|#keepText)\(/;

/** The name of a kept helper, whose call charges what it makes of its arguments. */
const KEPT_CALLEE = /^(?:kept\w*|#kept)$/;

/** The plain-made texts stored uncharged, by file, member and name: how many stores, and why they need no charge. */
const STORED: Readonly<Record<string, readonly [number, string]>> = {
  "admission/decision.ts decide at": [
    1,
    "a candidate's path, its decision read once by the consumer and then dropped",
  ],
  "admission/scan.ts inputsOf slice": [
    1,
    "a decision's prefixes, returned and read once by the decision, not kept",
  ],
  "admission/ingress.ts ownLeaves memoKey": [1, "a definition's id and a flag"],
  "contract/labels.ts labelPlainText text": [
    1,
    "a plain label's text in a test's record (`withLabelRecords`), never kept by an analysis",
  ],
  "consumer.ts #contractTask key": [
    1,
    "the candidate's lowering after the analysis (no ledger): a memo key of a store target's path, cut below",
  ],
  "consumers/stores.ts admittedStores side": [1, "a definition's id and two positions"],
  "consumers/operations.ts operatorUse key": [1, "an operand's index and a kind"],
  "consumers/finishing.ts recordRead read": [
    1,
    "a read's value and path in a test's record (`withFrontierBound`), never kept by an analysis",
  ],
  "contract/prefix-index.ts prefixWork root": [1, "a place's root key, `place|`"],
  "contract/marks.ts readGroups groupKey": [
    1,
    "its base made by `keptKey`, which charges its size, with two numbers",
  ],
  "contract/identity.ts structureWork inline": [
    1,
    "a carried value's structure parts, joined into its interned shape, which `keepText` charges whole",
  ],
  "definitions.ts prefixesOf inline": [1, "a helper itself, the plain twin of `keptPrefixes`"],
  "definitions.ts prefixesOf slice": [1, "a helper itself, the plain twin of `keptPrefixes`"],
  "exact-path.ts #forest id": [1, "a place, a callable and two positions"],
};

/** The offset just past the string or template that opens at `at`, a template's interpolations read as code. */
function pastLiteral(text: string, at: number): number {
  const quote = text[at]!;
  for (let index = at + 1; index < text.length; index += 1) {
    const char = text[index]!;
    if (char === "\\") index += 1;
    else if (char === quote) return index + 1;
    else if (quote === "`" && text.startsWith("${", index)) index = pastCode(text, index + 2) - 1;
  }
  return text.length;
}

/** The offset just past the `}` that ends an interpolation's code at `at`, its own strings and templates read whole. */
function pastCode(text: string, at: number): number {
  let depth = 0;
  for (let index = at; index < text.length; index += 1) {
    const char = text[index]!;
    if (char === '"' || char === "'" || char === "`") index = pastLiteral(text, index) - 1;
    else if (char === "{") depth += 1;
    else if (char === "}") {
      if (depth === 0) return index + 1;
      depth -= 1;
    }
  }
  return text.length;
}

/**
 * The arguments of the call whose `(` is at `open`, each its start and end, split at their top-level commas; a delimiter
 * inside a string or a template is text (`.set(")", text)`).
 */
function callArguments(text: string, open: number): (readonly [number, number])[] {
  const out: (readonly [number, number])[] = [];
  let depth = 0;
  let from = open + 1;
  for (let at = open + 1; at < text.length; at += 1) {
    const char = text[at]!;
    if (char === '"' || char === "'" || char === "`") at = pastLiteral(text, at) - 1;
    else if ("([{".includes(char)) depth += 1;
    else if (")]}".includes(char)) {
      if (depth === 0) {
        out.push([from, at]);
        return out;
      }
      depth -= 1;
    } else if (char === "," && depth === 0) {
      out.push([from, at]);
      from = at + 1;
    }
  }
  return out;
}

/**
 * Whether `offset` in `text` is outside every kept helper's own arguments, judged by the brackets around it (strings and
 * templates read whole, an interpolation's code with them), and outside strings and templates unless `literal` (a
 * template's interpolation is found inside one).
 */
function plainAt(text: string, offset: number, literal = false): boolean {
  const kept: boolean[] = [];
  for (let at = 0; at < offset; at += 1) {
    const char = text[at]!;
    if (char === '"' || char === "'" || char === "`") {
      at = pastLiteral(text, at) - 1;
      if (at >= offset) return literal && !kept.includes(true);
    } else if (char === "(")
      kept.push(KEPT_CALLEE.test(/(#?[\w$]+)\s*$/.exec(text.slice(0, at))?.[1] ?? ""));
    else if (char === "[" || char === "{") kept.push(false);
    else if (char === ")" || char === "]" || char === "}") kept.pop();
  }
  return !kept.includes(true);
}

/**
 * Whether the construction at `offset` is the value that starts at `from` itself (or a branch or an element of it), not
 * an argument of a call inside it (`map.get(pathText(at))` makes no value of the text): no call's bracket open around it.
 */
function ownAt(text: string, from: number, offset: number): boolean {
  const calls: boolean[] = [];
  for (let at = from; at < offset; at += 1) {
    const char = text[at]!;
    if (char === '"' || char === "'" || char === "`") at = pastLiteral(text, at) - 1;
    else if (char === "(") calls.push(/[\w$#)\]!]\s*$/.test(text.slice(from, at)));
    else if (char === "[" || char === "{") calls.push(false);
    else if (char === ")" || char === "]" || char === "}") calls.pop();
  }
  return !calls.includes(true);
}

/** The offset of the `;` that ends the statement going on at `from`, at its own bracket depth. */
function statementEnd(text: string, from: number): number {
  let depth = 0;
  for (let at = from; at < text.length; at += 1) {
    const char = text[at]!;
    if (char === '"' || char === "'" || char === "`") at = pastLiteral(text, at) - 1;
    else if ("([{".includes(char)) depth += 1;
    else if (")]}".includes(char)) depth -= 1;
    else if (char === ";" && depth <= 0) return at;
  }
  return text.length;
}

/** Each member's lines of a source without its comments, as `constructions` reads them: its name, first and end line. */
function memberRuns(lines: readonly string[]): (readonly [string, number, number])[] {
  const runs: [string, number, number][] = [];
  let member = "(top)";
  for (const [index, line] of lines.entries()) {
    const declared = DECLARATION.exec(line);
    if (
      declared?.[3] === undefined ||
      !/^\s+(if|for|while|return|switch|catch)\b|[;,]\s*$/.test(line)
    )
      member = declared?.[1] ?? declared?.[2] ?? declared?.[3] ?? member;
    if (runs.at(-1)?.[0] === member) runs.at(-1)![2] = index + 1;
    else runs.push([member, index, index + 1]);
  }
  return runs;
}

const PATH_NAMES_PATTERN = [...PATH_NAMES].join("|");

/** A template of a path or key (`` `k${key}` ``), found inside the template. */
const TEMPLATE = new RegExp(`\\$\\{(?:[\\w#?.]*\\.)?(?:${PATH_NAMES_PATTERN})\\b`);

/** A path's copy by `slice` (`strip.slice(1)`, `task.path.slice(depth)`). */
const SLICE = new RegExp(`\\b(?:[\\w#]+[?!]?\\.)*(?:${PATH_NAMES_PATTERN})[?!]?\\.slice\\(`);

/**
 * In one member's text: where in [from, to) a plain twin, a template of a path or a path's slice, or a call of a member
 * in `returning`, is made as that range's own value outside a kept helper's call.
 */
function plainValueAt(
  text: string,
  from: number,
  to: number,
  returning: ReadonlySet<string>,
  forms: readonly RegExp[] = [PLAIN_TWIN, TEMPLATE, SLICE],
): boolean {
  const calls =
    returning.size === 0
      ? null
      : new RegExp(
          `(?<![\\w$])(?:${[...returning].map((name) => name.replace("#", "\\#")).join("|")})\\s*\\(`,
        );
  return [...forms, ...(calls === null ? [] : [calls])].some((form) =>
    [...text.slice(from, to).matchAll(new RegExp(form.source, "g"))].some(
      (match) =>
        plainAt(text, from + match.index, form === TEMPLATE) &&
        ownAt(text, from, from + match.index),
    ),
  );
}

/** The locals one member makes plain, each its name and where its value ends: declared or assigned so. */
function plainLocals(
  text: string,
  returning: ReadonlySet<string>,
  forms?: readonly RegExp[],
): { readonly local: string; readonly at: number; readonly end: number }[] {
  const out: { local: string; at: number; end: number }[] = [];
  // (a declaration or an assignment that starts a statement, `for (let …` none; its value up to the statement's end)
  for (const made of text.matchAll(
    /(?:^|[;{}])\s*(?:(?:const|let) )?(\w+)(?::[^=\n;]*)? =(?![=>])/gm,
  )) {
    const valueAt = made.index + made[0].length;
    const end = statementEnd(text, valueAt);
    const plain =
      plainValueAt(text, valueAt, end, returning, forms) ||
      // (a plain local made earlier, as the whole value)
      out.some(({ local }) => text.slice(valueAt, end).trim() === local);
    if (plain) out.push({ local: made[1]!, at: made.index, end });
  }
  return out;
}

/**
 * The members of a source whose return value holds a path's copy by `slice` made as its own value (`return { def, rest:
 * path.slice(length) }`, a local made so, a call of a member already in `returning`), so a store of what a call of one
 * returns is found too (`exactPath`'s memo of `reachingDef`'s rest through `#exactPath`); a yield's value is none.
 */
function plainReturns(source: string, returning: ReadonlySet<string>): Set<string> {
  const lines = withoutComments(source).split("\n");
  const out = new Set<string>();
  for (const [name, start, end] of memberRuns(lines)) {
    const text = lines.slice(start, end).join("\n");
    const locals = plainLocals(text, returning, [SLICE]);
    for (const back of text.matchAll(/\breturn\b/g)) {
      const from = back.index + back[0].length;
      const to = statementEnd(text, from);
      const value = text.slice(from, to).trim();
      if (/^yield\b/.test(value)) continue;
      // (a kept helper charges what it returns)
      if (
        !KEPT_CALLEE.test(name) &&
        (plainValueAt(text, from, to, returning, [SLICE]) ||
          locals.some(({ local, at }) => at < back.index && value === local))
      )
        out.add(name);
    }
  }
  return out;
}

/** The stores of a plain-made text in one file, by member and name, with the lines they are on. */
function plainStores(
  file: string,
  source: string,
  returning: ReadonlySet<string> = new Set(),
): Map<string, string[]> {
  const lines = withoutComments(source).split("\n");
  const runs = memberRuns(lines);
  const template = TEMPLATE;
  const slice = SLICE;
  const found = new Map<string, string[]>();
  for (const [name, start, end] of runs) {
    const text = lines.slice(start, end).join("\n");
    const lineOf = (offset: number): number => start + text.slice(0, offset).split("\n").length - 1;
    const record = (key: string, offset: number): void => {
      const at = lineOf(offset);
      found.set(key, [...(found.get(key) ?? []), `${file}:${at + 1}: ${lines[at]!.trim()}`]);
    };
    // where in [from, to) a plain twin, a template of a path or a path's slice is made outside a kept helper's call
    const plainMade = (from: number, to: number, forms: readonly RegExp[]): number[] =>
      forms.flatMap((form) =>
        [...text.slice(from, to).matchAll(new RegExp(form.source, "g"))]
          .map((match) => from + match.index)
          .filter((offset) => plainAt(text, offset, form === template)),
      );
    const stores = [...text.matchAll(/\.(?:set|add|push)\(/g)].map((store) => ({
      at: store.index,
      ranges: callArguments(text, store.index + store[0].length - 1),
    }));
    for (const { local, at: madeAt, end: valueEnd } of plainLocals(text, returning)) {
      const made = { index: madeAt };
      // (the local as a value, not read through: `rest.length`, `stores[0]`, `frame(…)` keep none of it)
      const reference = new RegExp(`(?<![\\w$#.])${local}(?![\\w$]|\\s*[.[(])`, "g");
      // (up to the next declaration of the name: a later one is another variable)
      const next = new RegExp(`\\b(?:const|let) ${local}\\b`, "g");
      next.lastIndex = valueEnd;
      const until = next.exec(text)?.index ?? text.length;
      for (const { at, ranges } of stores) {
        if (at < made.index || at > until) continue;
        // (the local itself in a stored argument, in a tuple or an object there too, outside a kept helper's call; an
        // argument of another call makes that call's value, not the local)
        const kept = ranges.some(([from, to]) =>
          [...text.slice(from, to).matchAll(reference)].some(
            (use) =>
              plainAt(text, from + use.index) &&
              ownAt(text, from, from + use.index) &&
              // (an object's key of that name is no use of it)
              !(
                /[{,]\s*$/.test(text.slice(from, from + use.index)) &&
                /^\s*:/.test(text.slice(from + use.index + local.length))
              ),
          ),
        );
        if (!kept) continue;
        const before = text.slice(valueEnd, at);
        if (new RegExp(`${CHARGE.source}[^;]*\\b${local}\\b`).test(before)) continue;
        record(`${file} ${name} ${local}`, at);
      }
    }
    // a construction stored as it is made, outside a kept helper's call: a path's slice anywhere in the stored argument;
    // a plain twin or a template of a path as the argument's own value (inside an array or an object there too)
    for (const { at, ranges } of stores)
      for (const [from, to] of ranges) {
        for (const _ of plainMade(from, to, [slice])) record(`${file} ${name} slice`, at);
        for (const offset of plainMade(from, to, [PLAIN_TWIN, template]))
          if (ownAt(text, from, offset)) record(`${file} ${name} inline`, at);
      }
  }
  return found;
}

test("the core keeps no text a plain twin made uncharged but the listed ones", () => {
  const sources = readdirSync(CORE, { encoding: "utf8", recursive: true })
    .filter((name) => name.endsWith(".ts") && name !== "budget.ts")
    .sort()
    .map((file) => [file, readFileSync(new URL(file, CORE), "utf8")] as const);
  // the members whose return value is made plain, through the calls between them, to a fixed point
  let returning = new Set<string>();
  for (let size = -1; returning.size !== size;) {
    size = returning.size;
    returning = new Set(sources.flatMap(([, source]) => [...plainReturns(source, returning)]));
  }
  const found = new Map<string, string[]>();
  for (const [file, source] of sources)
    for (const [key, lines] of plainStores(file, source, returning)) found.set(key, lines);
  const differences = [...new Set([...found.keys(), ...Object.keys(STORED)])]
    .sort()
    .filter((key) => (found.get(key)?.length ?? 0) !== (STORED[key]?.[0] ?? 0))
    .map(
      (key) =>
        `${key}: ${found.get(key)?.length ?? 0} found, ${STORED[key]?.[0] ?? 0} listed\n  ${(found.get(key) ?? []).join("\n  ")}`,
    );
  assert.deepEqual(
    differences,
    [],
    "a text kept as a plain twin made it: make it with a kept helper, charge it where it is inserted, or list it",
  );
});

test("the core makes no path or key past its helpers but the listed ones", () => {
  const found = new Map<string, string[]>();
  for (const file of readdirSync(CORE, { encoding: "utf8", recursive: true })
    .filter((name) => name.endsWith(".ts") && name !== "budget.ts")
    .sort())
    for (const [key, lines] of constructions(file, readFileSync(new URL(file, CORE), "utf8")))
      found.set(key, lines);
  const differences = [...new Set([...found.keys(), ...Object.keys(LISTED)])]
    .sort()
    .filter((key) => (found.get(key)?.length ?? 0) !== (LISTED[key]?.[0] ?? 0))
    .map(
      (key) =>
        `${key}: ${found.get(key)?.length ?? 0} found, ${LISTED[key]?.[0] ?? 0} listed\n  ${(found.get(key) ?? []).join("\n  ")}`,
    );
  assert.deepEqual(
    differences,
    [],
    "a path or key made past the helpers: make it with a kept one or its plain twin, or list it with the reason",
  );
});

test("the scan finds each form of construction", () => {
  const source = [
    "export function walk(path: string[], rest: string[]) {",
    '  const text = path.join(".");',
    '  const steps = text.split(".");',
    "  const key = keyOf(1, steps);",
    "  const memo = `${key}|${text}`;",
    "  const below = `${text}.${rest[0]}`;",
    '  return [...path, "element", ...(rest ?? [])];',
    "}",
    "export function hidden(holder: { path: string[] }, path: string[]) {",
    '  const text = `prefix//${path.join(".")}`;',
    '  return [[...holder.path.slice(1)], path.concat(["x"]), text];',
    "}",
  ].join("\n");
  assert.deepEqual(
    [...constructions("probe.ts", source)].map(([key, lines]) => `${key} ${lines.length}`),
    [
      "probe.ts walk join 1",
      "probe.ts walk split 1",
      "probe.ts walk composite 1",
      "probe.ts walk step 1",
      "probe.ts hidden join 1",
      "probe.ts hidden concat 1",
      "probe.ts walk spread 2",
      "probe.ts hidden spread 1",
    ],
  );
});

test("the scan judges a slice charged only inside a kept helper's own brackets", () => {
  // (each line's `strip.slice(1)`, its last one where there are two, and whether it is made outside a kept call)
  const cases: readonly (readonly [string, boolean])[] = [
    ["pending.push([keptSteps(work, path, []), strip.slice(1)]);", true],
    ["memo.set(key, { path: keptSteps(work, path, []), strip: strip.slice(1) });", true],
    ["pending.push([1, flag ? keptSlice(this.#work, strip, 1) : strip.slice(1)]);", true],
    ["pending.push(keptSteps(work, strip.slice(1), []));", false],
    ["pending.push([keptSteps(work, [...path], strip.slice(1))]);", false],
    ["pending.push(keptSteps(work, path, []), [strip.slice(1)]);", true],
    ['pending.push(keptText(work, "strip.slice(1)"), strip.slice(1));', true],
  ];
  assert.deepEqual(
    cases.map(([line]) => plainAt(line, line.lastIndexOf("strip.slice(1)"))),
    cases.map(([, plain]) => plain),
  );
});

test("the scan finds a plain-made text kept uncharged", () => {
  const source = [
    "export class Probe {",
    "  #snapshot(value: number, read: string) {",
    '    const snapshot = joinParts(read, "-");',
    "    this.#snapshots.set(value, snapshot);",
    "  }",
    "  #distinct(stops: string[]) {",
    "    const seen = new Set<string>();",
    "    for (const stop of stops) {",
    "      const text =",
    "        joinParts(stop, 1);",
    "      if (seen.has(text)) continue;",
    "      seen.add(text);",
    "    }",
    "  }",
    "  #structure(key: string) {",
    "    const id = `k${key}`;",
    "    this.#structures.push(id);",
    "  }",
    "  #quoted(key: string) {",
    "    const text = joinParts(key, 1);",
    '    this.memo.set(")", text);',
    "  }",
    "  #nested(key: string) {",
    "    const text = joinParts(key, 1);",
    '    this.memo.set(`${"{"}`, text);',
    "    const other = joinParts(key, 2);",
    "    this.memo.set(`${`{`}`, other);",
    "  }",
    "  #tail(strip: string[]) {",
    "    pending.push([1, 2, strip.slice(1)]);",
    "    pending.push([1, 2, keptSlice(this.#work, strip, 1)]);",
    "  }",
    "  #prefix(path: string[], n: number) {",
    "    this.#below.set(k, path.slice(0, n));",
    "    const rest = path.slice(n);",
    "    list.push(rest);",
    "    const kept = keptSlice(this.#work, path, n);",
    "    list.push(kept);",
    "  }",
    "  #beside(path: string[], strip: string[]) {",
    "    pending.push([keptSteps(work, path, []), strip.slice(1)]);",
    "    memo.set(key, { path: keptSteps(work, path, []), strip: strip.slice(1) });",
    "    pending.push([1, flag ? keptSlice(this.#work, strip, 1) : strip.slice(1)]);",
    "    pending.push([keptSteps(work, path, []), keptSlice(this.#work, strip, 1)]);",
    "    pending.push(keptSteps(work, strip.slice(1), []));",
    "  }",
    "  #within(strip: string[]) {",
    "    const tail = strip.slice(1);",
    "    pending.push([1, 2, tail]);",
    "    memo.set(key, { strip: tail });",
    "    const paid = strip.slice(1);",
    "    work.charge('eventSteps', 1 + paid.length);",
    "    pending.push([1, paid]);",
    "    const copied = strip.slice(1);",
    "    pending.push([1, keptSteps(work, copied, [])]);",
    "  }",
    "  #rest(path: string[], n: number) {",
    "    let best = null;",
    "    best = { def: 1, rest: path.slice(n) };",
    "    return best;",
    "  }",
    "  #answer(path: string[]) {",
    "    const reaching = this.#rest(path, 1);",
    "    return reaching;",
    "  }",
    "  #yielded(path: string[]) {",
    "    const yielded = path.slice(1);",
    "    return yielded;",
    "  }",
    "  #given(path: string[]) {",
    "    return yield this.#ask(path);",
    "  }",
    "  produced(path: string[]) {",
    "    const answer = this.#yielded(path);",
    "    this.#memo.set(3, answer);",
    "    const asked = this.#given(path);",
    "    this.#memo.set(4, asked);",
    "  }",
    "  remember(path: string[]) {",
    "    let answer = this.#memo.get(1);",
    "    answer = this.#answer(path);",
    "    this.#memo.set(1, answer);",
    "    const charged = this.#answer(path);",
    "    keptArray(this.#work, charged.rest);",
    "    this.#memo.set(2, charged);",
    "  }",
    "  #inline(path: string[]) {",
    '    pending.push({ path: joinSteps(path, ["x"]) });',
    '    pending.push([{ path: joinSteps(path, ["y"]) }]);',
    '    pending.push({ path: keptSteps(work, path, ["x"]) });',
    "  }",
    "  #quotedSlice(path: string[]) {",
    '    pending.push("path.slice(1)");',
    "    pending.push('strip.slice(1)');",
    "    pending.push(`path.slice(1)`);",
    "    // pending.push(path.slice(1));",
    "    /* memo.set(k, path.slice(0, 2)); */",
    '    const label = "rest.slice(1)";',
    "    list.push(label);",
    "  }",
    "  #joined(key: number[]) {",
    "    const longer = joinSteps(key, [1]);",
    "    pending.push({ key: longer });",
    "    const named = joinSteps(key, [2]);",
    "    pending.push({ named: 1, path: [] });",
    "  }",
    "  #charged(key: string) {",
    "    const memoKey = joinParts(key, 2);",
    "    keepText(this.#work, memoKey.length);",
    "    this.#memo.set(memoKey, 1);",
    "    const kept = keptParts(this.#work, key, 3);",
    "    this.#memo.add(kept);",
    "  }",
    "}",
  ].join("\n");
  let returning = new Set<string>();
  for (let size = -1; returning.size !== size;) {
    size = returning.size;
    returning = plainReturns(source, returning);
  }
  assert.deepEqual([...returning].sort(), ["#answer", "#rest", "#yielded"]);
  assert.deepEqual(
    [...plainStores("probe.ts", source, returning)].map(([key, lines]) => `${key} ${lines.length}`),
    [
      "probe.ts #snapshot snapshot 1",
      "probe.ts #distinct text 1",
      "probe.ts #structure id 1",
      "probe.ts #quoted text 1",
      "probe.ts #nested text 1",
      "probe.ts #nested other 1",
      "probe.ts #tail slice 1",
      "probe.ts #prefix rest 1",
      "probe.ts #prefix slice 1",
      "probe.ts #beside slice 3",
      "probe.ts #within tail 2",
      "probe.ts produced answer 1",
      "probe.ts remember answer 1",
      "probe.ts #inline inline 2",
      "probe.ts #joined longer 1",
    ],
  );
});
