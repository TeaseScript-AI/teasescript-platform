import { compileProject } from "../../src/compiler.js";
import { createFreshRuntimeSession } from "../../src/index.js";
import { analyseCore } from "../../src/type-inference/core/answers.js";
import { coreMessage, messageSource } from "../../src/type-inference/core/messages.js";
import { coreRequest } from "./type-core-analysis.js";

/*
 * The paste family of TABLE r4.151 (#1241): every code form a fix offers, pasted at its own position in the source it
 * was offered for, compiles and runs. Each case is an offer's erroneous expression (`OFFERS`, with the setup its
 * receiver or list needs, the element and value kinds varied) at one site (`SITES`: a declaration, typed or not, a
 * store, an operand per operator class, an argument, a condition, an interpolation, an element, a receiver, a count, a
 * loop's iterable, a range's bound, a side of `otherwise`, a variable or a parameter without a type, as its reads
 * take it, also in a compound assignment).
 * The parity test runs a sample of it; the whole family is the step's evidence, run outside CI.
 */

/** An erroneous expression a fix offers code for, with the lines before it that make it so. */
export interface Offer {
  readonly name: string;
  readonly setup: string;
  readonly expression: string;
}

/**
 * A site an expression stands at: the lines around it, `@` where it stands, and the lines before it; an operand or a
 * receiver takes an operation in parentheses, so it stays the site's own expression.
 */
export interface Site {
  readonly name: string;
  readonly before: string;
  readonly line: string;
  readonly operand?: true;
}

/** The element and value kinds a list's or a dict's offers vary, as literals of each. */
const ELEMENTS: readonly (readonly [string, string])[] = [
  ["text", '"a"'],
  ["integer", "1"],
  ["number", "1.5"],
  ["boolean", "true"],
  ["duration", "1 s"],
  ["object", "{n: 1}"],
  ["list", "[1]"],
  ["set", "set[1]"],
];

/** The offers: each fix's code form, on receivers and lists of each element kind. */
const OFFERS: readonly Offer[] = [
  { name: "text size", setup: 'let t = "hello"', expression: "t.size" },
  { name: "nested text size", setup: 'let box = {label: "hello"}', expression: "box.label.size" },
  { name: "element text size", setup: 'let items = ["hello"]', expression: "items[0].size" },
  { name: "text toUpperCase", setup: 'let t = "hello"', expression: "t.toUpperCase()" },
  { name: "text length call", setup: 'let t = "hello"', expression: "t.length()" },
  { name: "text trim", setup: 'let t = " hello "', expression: "t.trim" },
  { name: "dict value trim", setup: 'let d = dict{a: " hello "}', expression: 'd["a"].trim' },
  { name: "angle degrees", setup: "let a = 90 deg", expression: "a.degrees" },
  { name: "dict missing key", setup: "let d = dict{k: 1}", expression: "d.missing" },
  {
    name: "missing key's trim",
    setup: 'let d = dict{a: " hello "}',
    expression: 'd["missing"].trim',
  },
  { name: "absent property's size", setup: 'let door = {a: "hello"}', expression: "door.b.size" },
  ...ELEMENTS.flatMap(([kind, value]): Offer[] => [
    { name: `join of ${kind}`, setup: `let items = [${value}]`, expression: "items.join" },
    {
      name: `nested join of ${kind}`,
      setup: `let box = {items: [${value}]}`,
      expression: "box.items.join",
    },
    { name: `dict of ${kind}`, setup: `let d = dict{k: ${value}}`, expression: "d.k" },
  ]),
  ...ELEMENTS.flatMap(([kind, value]): Offer[] =>
    [...ELEMENTS.slice(0, 3), ["object", '{n: "x"}'] as const].flatMap(
      ([joined, element]): Offer[] => [
        {
          name: `list of ${kind} + ${joined}`,
          setup: `let xs = [${value}]`,
          expression: `xs + ${element}`,
        },
        {
          name: `${joined} + list of ${kind}`,
          setup: `let xs = [${value}]`,
          expression: `${element} + xs`,
        },
      ],
    ),
  ),
  { name: "list + range", setup: "let xs = [1]", expression: "xs + (1..3)" },
  { name: "range + list", setup: "let xs = [1]", expression: "(1..3) + xs" },
];

/** The sites: where the expression's value lands. */
const SITES: readonly Site[] = [
  { name: "say", before: "", line: "say @" },
  { name: "declaration", before: "", line: "let v = @\nsay v" },
  ...["string", "integer", "number", "boolean", "string[]", "integer[]"].map((type): Site => ({
    name: `${type} declaration`,
    before: "",
    line: `let v: ${type} = @`,
  })),
  { name: "text store", before: 'let v = "x"', line: "v = @" },
  { name: "sum", before: "", line: "say @ + 1", operand: true },
  { name: "product", before: "", line: "say 2 * @", operand: true },
  { name: "comparison", before: "", line: "say @ > 2", operand: true },
  { name: "text join", before: "", line: 'say "a" + @', operand: true },
  { name: "negation", before: "", line: "say not @", operand: true },
  { name: "logic", before: "", line: "say @ and true", operand: true },
  { name: "text argument", before: "function show(p: string) {\n  say p\n}", line: "show(@)" },
  {
    name: "integer argument",
    before: "function count(p: integer) {\n  say p\n}",
    line: "count(@)",
  },
  { name: "condition", before: "", line: 'if @ {\n  say "yes"\n}' },
  { name: "interpolation", before: "", line: 'say "${@}"' },
  { name: "element", before: "", line: "let ws = [@]\nsay ws.length" },
  { name: "receiver", before: "", line: "say @.length", operand: true },
  { name: "count", before: "", line: 'repeat @ {\n  say "x"\n}' },
  { name: "wait", before: "", line: "wait @" },
  { name: "iteration", before: "", line: "for v in @ {\n  say v\n}" },
  { name: "range bound", before: "", line: "for i in 1..@ {\n  say i\n}", operand: true },
  { name: "object store", before: 'let o = {n: "x"}', line: "o = @" },
  { name: "untyped variable's trim", before: "", line: "let v = @\nsay v.trim()" },
  { name: "untyped argument", before: "function show(p) {\n  say p\n}", line: "show(@)" },
  { name: "untyped trim argument", before: "function use(p) {\n  say p.trim()\n}", line: "use(@)" },
  {
    name: "untyped sum argument",
    before: "function count(p) {\n  return p + 1\n}",
    line: "say count(@)",
  },
  { name: "untyped compound", before: "", line: 'let v = @\nv += "x"\nsay v' },
  {
    name: "untyped compound argument",
    before: 'function f(p) {\n  p += "x"\n  say p\n}',
    line: "f(@)",
  },
  { name: "fallback", before: "let n: integer? = null", line: "say n otherwise @", operand: true },
  {
    name: "untyped returned argument",
    before: "function id(p) {\n  return p\n}",
    line: "let w: string = id(@)\nsay w",
  },
];

/** A store's place of one written type, its start value, and values of other kinds stored into it. */
const PLACES: readonly (readonly [string, string, readonly string[]])[] = [
  ["duration", "1 s", ["3", "n + 1", "-3", "1.5"]],
  ["angle", "1 deg", ["90", "n"]],
  ["date", 'toDate("2026-01-01")', ['"2026-10-28"', '"bad"', '"2026-02-30"', "s"]],
  ["time", 'toTime("10:00")', ['"10:30"', '"25:00"']],
  ["string", '"x"', ["5", "n", "true", "n + 1"]],
];

/** The places a value is stored into: a declaration, an assignment, a property, an element, an argument. */
const STORES: readonly ((type: string, start: string) => Site)[] = [
  (type) => ({ name: `${type} declaration`, before: "", line: `let p: ${type} = @` }),
  (type, start) => ({
    name: `${type} assignment`,
    before: `let p: ${type} = ${start}`,
    line: "p = @",
  }),
  (_, start) => ({ name: "property", before: `let box = {p: ${start}}`, line: "box.p = @" }),
  (type, start) => ({
    name: `${type} element`,
    before: `let ps: ${type}[] = [${start}]`,
    line: "ps.add(@)",
  }),
  (type) => ({
    name: `${type} argument`,
    before: `function use(p: ${type}) {\n  say p\n}`,
    line: "use(@)",
  }),
];

/** A site's line before and after its `@`. */
function around(line: string): readonly [string, string] {
  const at = line.indexOf("@");
  return [line.slice(0, at), line.slice(at + 1)];
}

/** A case: an offer at a site, its source, and the span its expression stands at. */
export interface PasteCase {
  readonly name: string;
  readonly source: string;
  readonly start: number;
  readonly end: number;
}

/** The family's cases: every offer at every site, or with `sample`, every offer once, the sites in turn (each once). */
export function pasteCases(sample = false): PasteCase[] {
  const cases: PasteCase[] = [];
  OFFERS.forEach((offer, index) => {
    const sites = sample ? [SITES[index % SITES.length]!] : SITES;
    for (const site of sites) {
      const head = [offer.setup, site.before].filter((line) => line !== "").join("\n") + "\n";
      const [left, right] = around(site.line);
      const grouped = site.operand === true && offer.expression.includes(" + ");
      const start = head.length + left.length + (grouped ? 1 : 0);
      const expression = grouped ? `(${offer.expression})` : offer.expression;
      cases.push({
        name: `${offer.name} at ${site.name}`,
        source: `${head}${left}${expression}${right}\nexit\n`,
        start,
        end: start + offer.expression.length,
      });
    }
  });
  // (a store's value at each place of each written type: a declaration, an assignment, a property, an element, an
  // argument)
  PLACES.forEach(([type, start, values], index) => {
    const stores = sample ? [STORES[index % STORES.length]!] : STORES;
    for (const store of stores)
      for (const value of sample ? values.slice(0, 1) : values) {
        const site = store(type, start);
        const head =
          ["let n = 2", 'let s = "2026-10-28"', site.before]
            .filter((line) => line !== "")
            .join("\n") + "\n";
        const [left, right] = around(site.line);
        const begin = head.length + left.length;
        cases.push({
          name: `${value} into ${site.name}`,
          source: `${head}${left}${value}${right}\nexit\n`,
          start: begin,
          end: begin + value.length,
        });
      }
  });
  return cases;
}

/** A pasted form: the code a fix offered, and the source with it pasted at its position. */
export interface Pasted {
  readonly code: string;
  readonly source: string;
}

/** A code form in a fix sentence, by the words that offer it; a statement's `on a line of its own`. */
const CODE = /(?:such as|with|Use|Write|write) '([^']+)'( on a line of its own)?/g;

/**
 * The code forms the core's errors in `source` offer at or inside `[start, end)`, each pasted at its position: in place
 * of the diagnosed expression, or as a line of its own before the case's line, the list it changes in place of the
 * expression; with the diagnostics, for a case whose expression gets none.
 */
export function pastedForms(
  source: string,
  start: number,
  end: number,
): { readonly diagnosed: boolean; readonly forms: readonly Pasted[] } {
  const request = coreRequest([{ path: "main.tease", source }]);
  if (request === null) return { diagnosed: false, forms: [] };
  const text = messageSource([source]);
  const forms: Pasted[] = [];
  let diagnosed = false;
  for (const diagnostic of analyseCore(request).diagnostics) {
    if (
      diagnostic.class !== "compile-error" ||
      diagnostic.site.start < start ||
      diagnostic.site.end > end
    )
      continue;
    diagnosed = true;
    const message = coreMessage(diagnostic, text);
    const fixes = message.slice(message.indexOf(". ") + 2);
    for (const [, code, statement] of fixes.matchAll(CODE)) {
      // (#1213's decided sentence for a value shown as text, 'put it in a text with '${...}'', which the rulings keep)
      if (code === "${...}") continue;
      if (statement === undefined) {
        forms.push({
          code: code!,
          source: source.slice(0, diagnostic.site.start) + code + source.slice(diagnostic.site.end),
        });
        continue;
      }
      // (an add on a line of its own, before the case's line; the list itself where the join stood)
      const list = /to '([^']+)' itself/.exec(fixes)?.[1] ?? "";
      const lineStart = source.lastIndexOf("\n", start) + 1;
      forms.push({
        code: code!,
        source:
          source.slice(0, lineStart) +
          `${code}\n` +
          source.slice(lineStart, start) +
          list +
          source.slice(end),
      });
    }
  }
  return { diagnosed, forms };
}

/** Why a pasted source fails: its compile errors, or its run's failure; `null` where it compiles and runs. */
export function pasteFailure(source: string): string | null {
  const compiled = compileProject([{ path: "main.tease", source }]);
  const errors = compiled.diagnostics.filter((diagnostic) => diagnostic.severity === "error");
  if (errors.length > 0)
    return errors.map((error) => `${error.code}: ${error.message}`).join(" | ");
  if (compiled.plan === null) return "no plan";
  const failure = createFreshRuntimeSession(compiled.plan, {
    baseDelayMs: 0,
    delayPerWordMs: 0,
    delayPerCharacterMs: 0,
  })
    .run()
    .events.find((event) => event.kind === "runtimeFailure");
  return failure === undefined ? null : JSON.stringify(failure);
}
