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
  "admission.ts #collect spread": [
    1,
    "the list of the paths collected, each made by a kept helper",
  ],
  "admission.ts literalElements spread": [1, "a list of paths, each made by a kept helper"],
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
  "contract.ts #carried step": [1, "a method's name, two identifiers"],
  "contract.ts #groupsAt composite": [3, "an entry's text, charged by `#kept` before it is kept"],
  "contract.ts #indexWork composite": [5, "an entry's text, charged by `#kept` before it is kept"],
  "contract.ts #keyContract spread": [2, "items, no path"],
  "contract.ts #levelsOf spread": [2, "a copy of a set of path ids, charged by `#keep`"],
  "contract.ts #pathAt step": [1, "the interner's text, charged by `#keepText` before it is made"],
  "contract.ts typeAtPath spread": [
    1,
    "the steps below one level of a written type, one copy per level",
  ],
  "definitions.ts keyBelow join": [2, "a helper itself"],
  "definitions.ts keyBelow step": [1, "a helper itself"],
  "definitions.ts keyOf composite": [1, "a helper itself"],
  "definitions.ts keyOf join": [1, "a helper itself"],
  "definitions.ts keyOfText composite": [1, "a helper itself"],
  "definitions.ts keyPath split": [1, "a helper itself"],
  "exact-path.ts #defVal spread": [1, "items, no path"],
  "exact-path.ts #stopAt spread": [2, "the spans per prefix of a path, no path"],
  "items.ts union composite": [2, "two item ids"],
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
 * A text a plain twin makes (`joinParts`, `pathText`, `keyOf`, …), or a template of a path or key (`` `k${key}` ``), is
 * for a lookup or to pass on; one a structure keeps is charged first: made by a kept helper, or charged where it is
 * inserted (`keepText(work, memoKey.length)` before a memo stores it). A read's snapshot made by `joinParts` and kept in
 * a memo, and a stop's kept in a set of distinct ones, passed the scan above, which reads how a text is made, not what
 * keeps it (the deep-literal review's R3-B1). This scan finds, per member, a local text made so and then stored by
 * `.set`, `.add` or `.push` with no charge naming it before the store. A tripwire too: it misses a text kept under
 * another name, returned by a call (`#aliasKey`), or kept in an object.
 */
const PLAIN_TWIN = /\b(?:joinParts|pathText|keyOf|keyBelow|keyPathText|keyOfText|stepText)\(/;

/** A charge or a kept helper: its call before a store, naming the text, charges it (`keepText(work, key.length)`). */
const CHARGE = /(?:\b(?:kept\w*|keepText|keep)|#kept|#keepText)\(/;

/** The plain-made texts stored uncharged, by file, member and name: how many stores, and why they need no charge. */
const STORED: Readonly<Record<string, readonly [number, string]>> = {
  "admission.ts #ownLeaves memoKey": [1, "a definition's id and a flag"],
  "answers.ts #propertyNames id": [
    1,
    "a properties query's walk, its texts ending with the query (S9b's, TABLE r4.78 (3))",
  ],
  "consumer.ts #contractTask key": [
    1,
    "the candidate's lowering after the analysis (no ledger): a memo key of a store target's path, cut below",
  ],
  "consumers.ts #admittedStores side": [1, "a definition's id and two positions"],
  "contract.ts #prefixWork root": [1, "a place's root key, `place|`"],
  "contract.ts #readGroups groupKey": [
    1,
    "its base made by `keptKey`, which charges its size, with two numbers",
  ],
  "exact-path.ts #forest id": [1, "a place, a callable and two positions"],
};

/** The offset just past the string or template that opens at `at` (a template's interpolations read whole). */
function pastLiteral(text: string, at: number): number {
  const quote = text[at]!;
  let braces = 0;
  for (let index = at + 1; index < text.length; index += 1) {
    const char = text[index]!;
    if (char === "\\") index += 1;
    else if (quote === "`" && braces === 0 && text.startsWith("${", index)) {
      braces = 1;
      index += 1;
    } else if (braces > 0) braces += char === "{" ? 1 : char === "}" ? -1 : 0;
    else if (char === quote) return index + 1;
  }
  return text.length;
}

/**
 * The arguments of the call whose `(` is at `open`, split at their top-level commas; a delimiter inside a string or a
 * template is text (`.set(")", text)`).
 */
function callArguments(text: string, open: number): string[] {
  const out: string[] = [];
  let depth = 0;
  let from = open + 1;
  for (let at = open + 1; at < text.length; at += 1) {
    const char = text[at]!;
    if (char === '"' || char === "'" || char === "`") at = pastLiteral(text, at) - 1;
    else if ("([{".includes(char)) depth += 1;
    else if (")]}".includes(char)) {
      if (depth === 0) {
        out.push(text.slice(from, at).trim());
        return out;
      }
      depth -= 1;
    } else if (char === "," && depth === 0) {
      out.push(text.slice(from, at).trim());
      from = at + 1;
    }
  }
  return out;
}

/** The stores of a plain-made text in one file, by member and name, with the lines they are on. */
function plainStores(file: string, source: string): Map<string, string[]> {
  const lines = withoutComments(source).split("\n");
  // each member's lines, as `constructions` reads them
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
  const names = [...PATH_NAMES].join("|");
  const template = new RegExp(`\\$\\{(?:[\\w#?.]*\\.)?(?:${names})\\b`);
  const found = new Map<string, string[]>();
  for (const [name, start, end] of runs) {
    const text = lines.slice(start, end).join("\n");
    const lineOf = (offset: number): number => start + text.slice(0, offset).split("\n").length - 1;
    for (const made of text.matchAll(/\b(?:const|let) (\w+)(?::[^=]*)? =\s*([^]*?);\s*\n/g)) {
      const local = made[1]!;
      const value = made[2]!;
      if (CHARGE.test(value) || !(PLAIN_TWIN.test(value) || template.test(value))) continue;
      for (const store of text.matchAll(/\.(?:set|add|push)\(/g)) {
        const open = store.index + store[0].length - 1;
        if (store.index < made.index || !callArguments(text, open).includes(local)) continue;
        const before = text.slice(made.index + made[0].length, store.index);
        if (new RegExp(`${CHARGE.source}[^;]*\\b${local}\\b`).test(before)) continue;
        const key = `${file} ${name} ${local}`;
        const at = lineOf(store.index);
        found.set(key, [...(found.get(key) ?? []), `${file}:${at + 1}: ${lines[at]!.trim()}`]);
      }
    }
  }
  return found;
}

test("the core keeps no text a plain twin made uncharged but the listed ones", () => {
  const found = new Map<string, string[]>();
  for (const file of readdirSync(CORE)
    .filter((name) => name.endsWith(".ts") && name !== "budget.ts")
    .sort())
    for (const [key, lines] of plainStores(file, readFileSync(new URL(file, CORE), "utf8")))
      found.set(key, lines);
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
  for (const file of readdirSync(CORE)
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
    "  #charged(key: string) {",
    "    const memoKey = joinParts(key, 2);",
    "    keepText(this.#work, memoKey.length);",
    "    this.#memo.set(memoKey, 1);",
    "    const kept = keptParts(this.#work, key, 3);",
    "    this.#memo.add(kept);",
    "  }",
    "}",
  ].join("\n");
  assert.deepEqual(
    [...plainStores("probe.ts", source)].map(([key, lines]) => `${key} ${lines.length}`),
    [
      "probe.ts #snapshot snapshot 1",
      "probe.ts #distinct text 1",
      "probe.ts #structure id 1",
      "probe.ts #quoted text 1",
    ],
  );
});
