import type { Expression, FunctionParameter, Statement, SwitchCase } from "../../src/ast.js";
import { compileProject, compileProjectWithBackend } from "../../src/compiler.js";
import { handlerBlocks, nestedStatements, unwrap } from "../../src/expression-children.js";
import {
  createFreshRuntimeSession,
  type InstructionPlan,
  type RuntimeSessionView,
} from "../../src/index.js";
import { lazyDefaultArgument } from "../../src/lazy-defaults.js";
import { parse } from "../../src/parser.js";
import type { SourceSpan } from "../../src/source.js";
import type { TypeAnalysisBackend } from "../../src/type-inference/backend.js";
import { analyseCore } from "../../src/type-inference/core/answers.js";
import { coreMessage, messageSource } from "../../src/type-inference/core/messages.js";
import { LEGACY_BACKEND } from "../../src/type-inference/legacy-rounds.js";
import { coreRequest } from "./type-core-analysis.js";

/*
 * The paste family of TABLE r4.151 (#1241): every code form a fix offers, pasted at its own position in the source it
 * was offered for, compiles and runs. Each case is an offer's erroneous expression (`OFFERS`, with the setup its
 * receiver or list needs, the element and value kinds varied) at one site (`SITES`: a declaration, typed or not, a
 * store, an operand per operator class, an argument, a condition, an interpolation, an element, a receiver, a count, a
 * loop's iterable, a range's bound, a side of `otherwise`, a default, a variable or a parameter without a type, as its
 * reads take it, also in a compound assignment). A pasted form compiles with both checkers and runs to its end through
 * the pasted code, answered where it asks (#1586); a declaration
 * form under the new core alone where the current checker's recorded difference from the accepted text is its only
 * rejection (#1412: a list join whose written destination admits every operand), as the checker whose message offers it
 * decides (the lead's ruling on #1310): the joins whose value the declaration's written type receives, and no other
 * (Codex r12 and r13 on #1310). The parity test runs a sample of it; the whole family is the step's evidence, run
 * outside CI.
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

/** An object that may be null, as a variable, a list's element, a dict's value or a property holds it; one that is there. */
const RECEIVERS: readonly (readonly [string, string, string])[] = [
  [
    "object or null",
    'let boxes = [{n: 2, text: "hello", items: [1]}, null]\nlet maybe = boxes[1]',
    "maybe",
  ],
  ["null element", 'let boxes = [{n: 2, text: "hello", items: [1]}, null]', "boxes[1]"],
  [
    "null dict value",
    'let maybe = dict{a: {n: 2, text: "hello", items: [1]}, b: null}.values.random',
    "maybe",
  ],
  [
    "null property",
    'let boxes = [{n: 2, text: "hello", items: [1]}, null]\nlet outer = {inner: boxes[1]}',
    "outer.inner",
  ],
  ["object", 'let fine = {n: 2, text: "hello", items: [1]}', "fine"],
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
  // (a list a fix reads by a dict's key or a list's index, there or not: TABLE r4.162, Astra on #1296)
  ...[
    ["dict{found: [1]}", 'd["absent"]'],
    ["dict{found: [1]}", 'd["found"]'],
    ["[[1]]", "d[5]"],
    ["[[1]]", "d[0]"],
  ].flatMap(([value, list]): Offer[] => [
    { name: `${list} + element`, setup: `let d = ${value}`, expression: `${list} + 2` },
    { name: `element + ${list}`, setup: `let d = ${value}`, expression: `2 + ${list}` },
  ]),
  // (a receiver that may be null: an object-or-null variable, a list element, a dict value, a nested property, and one
  // that is there; a member's and a list's form over it, Astra r2 on #1296)
  ...RECEIVERS.flatMap(([kind, setup, receiver]): Offer[] => [
    { name: `${kind}'s text size`, setup, expression: `${receiver}.text.size` },
    { name: `${kind}'s items + element`, setup, expression: `${receiver}.items + 2` },
  ]),
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

/**
 * The sites that read the value as text (`trim`, `+= "x"`), where a list errs whatever its type: the compound on the
 * current checker, and on the new core once #1413 is repaired.
 */
const TEXT_READS = ["untyped variable's trim", "untyped compound"];

/**
 * A list join that mixes element types, both orders, on lists of each element kind (#1272): its fix declares the
 * variable whose start value the join is, as the source writes it with the type (#1268). At every site but
 * `TEXT_READS`.
 */
const JOINS: readonly Offer[] = ELEMENTS.flatMap(([kind, value]): Offer[] => {
  const other = kind === "text" ? "1" : '"x"';
  return [
    {
      name: `list of ${kind} + [${other}]`,
      setup: `let xs = [${value}]`,
      expression: `xs + [${other}]`,
    },
    {
      name: `[${other}] + list of ${kind}`,
      setup: `let xs = [${value}]`,
      expression: `[${other}] + xs`,
    },
  ];
});

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
  { name: "default", before: 'let ys = ["x"]', line: "say ys.get(9, default: @)" },
  {
    name: "untyped returned argument",
    before: "function id(p) {\n  return p\n}",
    line: "let w: string = id(@)\nsay w",
  },
  // (a divisor, also through a literal's contents and an interpolation's text: Codex r10)
  { name: "divisor", before: "", line: "say 1 / @", operand: true },
  { name: "literal divisor", before: "", line: "say 1 / [@][0]" },
  { name: "property divisor", before: "", line: "say 1 / ({n: @}).n" },
  { name: "interpolation divisor", before: "", line: 'say 1 / toInteger("${@}", default: 1)' },
  // (an operand nested in arithmetic, a negation, a multiplication, an object's contents, an interpolation: Astra r3)
  { name: "minus", before: "", line: "say -@", operand: true },
  { name: "nested product", before: "", line: "say 2 * (3 * @)", operand: true },
  { name: "object contents", before: "", line: "say ({v: @ + 1}).v", operand: true },
  { name: "interpolated sum", before: "", line: 'say "${@ + 1}"', operand: true },
  // (an operand of a `say`, an ask and a button, which the presence walk enumerates: Codex r13, the lead)
  { name: "say operand", before: "", line: 'let shown = say("${@ + 1}", instant)' },
  { name: "ask prompt", before: "", line: 'let asked = askInteger("${@ + 1}")' },
  { name: "button label", before: "", line: 'let pressed = showButton "${@ + 1}"' },
];

/**
 * Values that may be null, whose warning's fix offers a fallback (ADR 0021 rule 1.9), at the sites that take their
 * other type: where they divide, also through a literal or an interpolation, and at a call, which reads it later.
 */
const NUMBER_SITES = [
  "integer declaration",
  "sum",
  "product",
  "comparison",
  "divisor",
  "integer argument",
  "count",
  "say operand",
  "ask prompt",
  "button label",
  "minus",
  "nested product",
  "object contents",
  "interpolated sum",
];
const NULLABLE: readonly (readonly [Offer, readonly string[]])[] = [
  // (read by an index, which may be absent: a warning's own read, which its program already performs, wrapped in
  // place, TABLE r4.168; or a variable's)
  [{ name: "null element", setup: "let xs = [4, null]", expression: "xs[1]" }, NUMBER_SITES],
  [{ name: "null value", setup: "let x = [4, null].random", expression: "x" }, NUMBER_SITES],
  ...[
    { name: "null element's length", setup: 'let xs = ["ab", null]', expression: "xs[1].length" },
    { name: "null value's length", setup: 'let x = ["ab", null].random', expression: "x.length" },
    {
      name: "null property's length",
      setup: 'let holder = {t: ["ab", null].random}',
      expression: "holder.t.length",
    },
    {
      name: "null dict value's length",
      setup: 'let x = dict{a: "ab", b: null}.values.random',
      expression: "x.length",
    },
    // (a subject whose own text holds an ellipsis, which is no placeholder, Codex r15)
    {
      name: "null ellipsis key's length",
      setup: 'let d = dict{"...": "alpha", b: null}',
      expression: 'd["..."].length',
    },
  ].map(
    (offer) =>
      [
        offer,
        [
          "say",
          "integer declaration",
          "sum",
          "divisor",
          "literal divisor",
          "property divisor",
          "interpolation divisor",
          "integer argument",
          "untyped argument",
          "count",
        ],
      ] as const,
  ),
];

/** A value the player answers, which its store receives only after the answer (#1586); the sample takes it too. */
const ANSWERED = 'askInteger("How many?")';

/** A store's place of one written type, its start value, and values of other kinds stored into it. */
const PLACES: readonly (readonly [string, string, readonly string[]])[] = [
  [
    "duration",
    "1 s",
    [
      "3",
      "n + 1",
      "-3",
      "1.5",
      'd["found"]',
      'd["absent"]',
      "ns[0]",
      "ns[5]",
      // (Codex r12: such reads inside a literal and an interpolation; a literal's own property, which is there)
      '({n: d["absent"]}).n',
      "[ns[5]].length",
      'toInteger("${d["absent"]}${1}", default: 1)',
      "({n: n}).n",
      // (Astra r3 on #1296: an operand that may be null nested in arithmetic, a negation, a multiplication, an object's
      // contents, an interpolation; and one that is there)
      "maybeN + 1",
      "-maybeN",
      "2 * (maybeN * 3)",
      "({v: maybeN + 1}).v",
      '"${maybeN}".length',
      "2 * (n * 3)",
      "({v: n + 1}).v",
      '"${n}".length',
      // (Astra r2 on #1296: a property of a receiver that may be null, and of one that is there)
      "maybe.n",
      "boxes[1].n",
      "held.n",
      "outer.inner.n",
      "fine.n",
      // (Codex r13: an ask's, a `say`'s and a button's operand, read by a key or there)
      'askInteger("${d["absent"]}")',
      ANSWERED,
      '[say("${d["absent"]}", instant)].length',
      '[say("Strokes: 0", instant)].length',
      '[(showButton "${d["absent"]}")].length',
      '[(showButton "Continue")].length',
    ],
  ],
  ["angle", "1 deg", ["90", "n", 'd["absent"]', "ns[5]"]],
  ["date", 'toDate("2026-01-01")', ['"2026-10-28"', '"bad"', '"2026-02-30"', "s"]],
  ["time", 'toTime("10:00")', ['"10:30"', '"25:00"']],
  ["string", '"x"', ["5", "n", "true", "n + 1", 'd["absent"]', "ns[5]"]],
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

/**
 * The family's cases: every offer at every site, or with `sample`, every offer once, the sites in turn (each once), and
 * a store's first value and `ANSWERED`.
 */
export function pasteCases(sample = false): PasteCase[] {
  const cases: PasteCase[] = [];
  const offers = [
    ...OFFERS.map(
      (offer, index) => [offer, sample ? [SITES[index % SITES.length]!] : SITES] as const,
    ),
    ...NULLABLE.map(([offer, names], index) => {
      const sites = SITES.filter((site) => names.includes(site.name));
      return [offer, sample ? [sites[index % sites.length]!] : sites] as const;
    }),
    // (the sample at the declaration its fix declares)
    ...JOINS.map(
      (offer) =>
        [
          offer,
          SITES.filter((site) =>
            sample ? site.name === "declaration" : !TEXT_READS.includes(site.name),
          ),
        ] as const,
    ),
  ];
  for (const [offer, sites] of offers) {
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
  }
  // (a store's value at each place of each written type: a declaration, an assignment, a property, an element, an
  // argument)
  PLACES.forEach(([type, start, values], index) => {
    const stores = sample ? [STORES[index % STORES.length]!] : STORES;
    for (const store of stores)
      for (const value of sample
        ? values.filter((candidate, position) => position === 0 || candidate === ANSWERED)
        : values) {
        const site = store(type, start);
        const head =
          [
            "let n = 2",
            'let s = "2026-10-28"',
            "let d = dict{found: 2}",
            "let ns = [2]",
            "let boxes = [{n: 2}, null]",
            "let maybe = boxes[1]",
            "let held = dict{a: {n: 2}, b: null}.values.random",
            "let outer = {inner: boxes[1]}",
            "let fine = {n: 2}",
            "let maybeN = [2, null].random",
            site.before,
          ]
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

/**
 * A pasted form: the code a fix offered, the source with it pasted at its position, and its span there (`at`; for a
 * declaration whose own text is not there, the diagnosed expression's); a declaration's span there.
 */
export interface Pasted {
  readonly code: string;
  readonly source: string;
  readonly at: { readonly start: number; readonly end: number };
  readonly declared?: { readonly start: number; readonly end: number };
}

/** A code form in a fix sentence, by the words that offer it; a statement's `on a line of its own`. */
const CODE = /(?:such as|with|Use|Write|write) '([^']+)'( on a line of its own)?/g;

/** A warning's fallback (ADR 0021 rule 1.9), which stands in place of its subject. */
const FALLBACK = /give a fallback, as in '([^']+)'/;

/**
 * The declaration a list join's fix offers whole (#1268, TABLE r4.146): its head, the name it declares, and its text
 * from the `=` on, which stand in the source's own declaration, with any type it writes.
 */
const DECLARATION =
  /declare (?:the list|the parameter) as '(((?:let |global )?[A-Za-z_]\w*): [^=']+?( = [^']*)?)'/;

/** Text matched as itself in a regular expression. */
const literally = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The code forms the core's errors in `source` offer at or inside `[start, end)`, each pasted at its position: in place
 * of the diagnosed expression, or as a line of its own before the case's line, the list it changes in place of the
 * expression; a declaration in place of the source's own; a warning's fallback in place of its subject; whether the
 * expression gets any diagnostic.
 */
export function pastedForms(
  source: string,
  start: number,
  end: number,
): { readonly diagnosed: boolean; readonly forms: readonly Pasted[] } {
  const request = coreRequest([{ path: "main.tease", source }]);
  if (request === null) return { diagnosed: false, forms: [] };
  const forms: Pasted[] = [];
  let diagnosed = false;
  const { diagnostics } = analyseCore(request);
  const text = messageSource([source], diagnostics);
  // (a warning's fallback is pasted into a program that otherwise compiles: beside an error it fixes nothing of that
  // error, whose own fix is pasted on its own)
  const erring = diagnostics.some((diagnostic) => diagnostic.class === "compile-error");
  for (const diagnostic of diagnostics) {
    if (diagnostic.site.start < start || diagnostic.site.end > end) continue;
    diagnosed = true;
    const message = coreMessage(diagnostic, text);
    if (diagnostic.class === "warning-runtime-check" && diagnostic.kind !== "budget") {
      if (erring) continue;
      // (a member's subject is its receiver, written at the start of the warned access)
      const fallback = FALLBACK.exec(message)?.[1];
      const { rule } = diagnostic;
      const subject =
        rule.rule === "member"
          ? rule.receiver
          : source.slice(diagnostic.site.start, diagnostic.site.end);
      if (fallback !== undefined)
        forms.push({
          code: fallback,
          source:
            source.slice(0, diagnostic.site.start) +
            fallback +
            source.slice(diagnostic.site.start + subject.length),
          at: { start: diagnostic.site.start, end: diagnostic.site.start + fallback.length },
        });
      continue;
    }
    const fixes = message.slice(message.indexOf(". ") + 2);
    // (a declaration in place of the source's own: unchanged, and failing, where its own text is not there)
    const declared = DECLARATION.exec(fixes);
    if (declared !== null) {
      const [, code, head, start = ""] = declared;
      // (its written type up to its `=`, or a parameter's up to the list's next `,` or `)`)
      const typed = start === "" ? "(?:: [^=,)\\n]+)?" : "(?:: [^=\\n]+?)?";
      const own = new RegExp(`(?<![\\w.])${literally(head!)}${typed}${literally(start)}(?![\\w])`);
      const found = own.exec(source);
      if (found === null)
        forms.push({
          code: code!,
          source,
          at: { start: diagnostic.site.start, end: diagnostic.site.end },
        });
      else {
        const span = { start: found.index, end: found.index + code!.length };
        forms.push({
          code: code!,
          source: source.slice(0, found.index) + code + source.slice(found.index + found[0].length),
          at: span,
          declared: span,
        });
      }
    }
    for (const [, code, statement] of fixes.matchAll(CODE)) {
      if (statement === undefined) {
        forms.push({
          code: code!,
          source: source.slice(0, diagnostic.site.start) + code + source.slice(diagnostic.site.end),
          at: { start: diagnostic.site.start, end: diagnostic.site.start + code!.length },
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
        at: { start: lineStart, end: lineStart + code!.length },
      });
    }
  }
  return { diagnosed, forms };
}

/**
 * The joins whose value a pasted declaration's written type receives, by their offsets: its start value's `+`, and each
 * such join's operands that are joins, parentheses aside. A join anywhere else in its text (an element, an argument, a
 * member's receiver) lands elsewhere (Codex r13 on #1310).
 */
function landingJoins(source: string, declared: { readonly start: number }): Set<string> {
  const joins = new Set<string>();
  const spine = (expression: Expression | null): void => {
    if (expression === null) return;
    const join = unwrap(expression);
    if (join.kind !== "binaryExpression" || join.operator !== "+") return;
    joins.add(`${join.span.start.offset},${join.span.end.offset}`);
    spine(join.left);
    spine(join.right);
  };
  const at = (node: { readonly span: SourceSpan }): boolean =>
    node.span.start.offset === declared.start;
  // (a `let`'s start value; a global's, and its `= value` beside a `default:`; a parameter's default)
  const visit = (statements: readonly Statement[]): void => {
    for (const statement of statements) {
      if (statement.kind === "letStatement" && at(statement)) spine(statement.initializer);
      if (statement.kind === "globalStatement" && at(statement)) {
        spine(statement.initial);
        spine(statement.assignment?.value ?? null);
      }
      if (statement.kind === "functionDeclaration") {
        for (const parameter of statement.parameters)
          if (at(parameter)) spine(parameter.defaultValue);
        visit(statement.body.statements);
      }
      visit(nestedStatements(statement));
      for (const block of handlerBlocks(statement)) visit(block.statements);
    }
  };
  visit(parse(source).program.statements);
  return joins;
}

/**
 * The current checker without its recorded difference from the accepted text (#1412): a list join's error where a
 * pasted declaration's written type receives the join's value (`landingJoins`) and so admits every operand, as the new
 * core proves where it is quiet. A join error anywhere else stands, inside the declaration's text or not (Codex r12 and
 * r13 on #1310: #1383's missing core check).
 */
function recorded(landing: ReadonlySet<string>): TypeAnalysisBackend {
  return {
    name: "legacy",
    analyze(request) {
      const outcome = LEGACY_BACKEND.analyze(request);
      const diagnostics = outcome.checked.diagnostics.map((file) =>
        file.filter(
          ({ code, message, span }) =>
            code !== "TSV044" ||
            !/^'\+=?' would mix /.test(message) ||
            !landing.has(`${span.start.offset},${span.end.offset}`),
        ),
      );
      return { checked: { ...outcome.checked, diagnostics }, facts: () => outcome.facts() };
    },
  };
}

/** How many answers a pasted program's run gets before it counts as incomplete; the family's runs need one (#1586). */
const COMPLETIONS = 4;

/**
 * The scripted answer to what a run waits for: a valid number to a number request, the button's activation to a button;
 * `undefined` for anything else, whose run stays incomplete.
 */
function answer(view: RuntimeSessionView): object | undefined {
  const action = view.foregroundAction;
  if (action?.kind !== "interaction") return undefined;
  const payload =
    action.interactionKind === "number"
      ? { kind: "submittedText", submittedText: "2" }
      : action.interactionKind === "button"
        ? { kind: "activate" }
        : undefined;
  return payload === undefined
    ? undefined
    : {
        actionId: action.actionId,
        actionKind: "interaction",
        interactionKind: action.interactionKind,
        payload,
      };
}

/** A node of a source's syntax tree: anything with a span. */
interface Node {
  readonly kind?: string;
  readonly span: SourceSpan;
}

/** The nodes directly inside a node: each property that holds one, or a list of them. */
function inside(node: Node): readonly Node[] {
  return Object.entries(node).flatMap(([key, value]: [string, unknown]) =>
    key === "span"
      ? []
      : (Array.isArray(value) ? value : [value]).filter(
          (child): child is Node => typeof child === "object" && child !== null && "span" in child,
        ),
  );
}

/**
 * The positions a run may skip while it evaluates their parent, by the runtime's rules: the right side of `and`, `or`
 * and `otherwise` (`src/runtime/evaluator.ts`, its `binary`), the `default:` of a call that runs it only when needed
 * (`lazyDefaultArgument`, the evaluator's `call`), a `load`'s default (its `storageLoad`), a case's values after its
 * first, which a switch tests as an `or` (`caseCondition`), and a parameter's default, bound only for an omitted argument
 * (`bindDefaultParameter`). `child`'s position in `parent` and the expression the lowering evaluates there, or `null`
 * where it runs whenever `parent` does.
 */
function lazyPosition(
  parent: Node,
  child: Node,
): { readonly position: string; readonly evaluated: Node } | null {
  // EVIDENCE: invariant: the parser builds each node as the AST interface its `kind` names; other kinds fall through.
  const node = parent as Expression | SwitchCase | FunctionParameter;
  switch (node.kind) {
    case "binaryExpression":
      return child === node.right &&
        (node.operator === "and" || node.operator === "or" || node.operator === "otherwise")
        ? { position: `the right side of '${node.operator}'`, evaluated: child }
        : null;
    case "callExpression": {
      const lazy = lazyDefaultArgument(node);
      return lazy !== null && child === lazy.argument
        ? { position: `the default of '${lazy.operation}'`, evaluated: lazy.argument.value }
        : null;
    }
    case "loadExpression":
      return child === node.defaultValue
        ? { position: "the default of 'load'", evaluated: child }
        : null;
    case "switchCase":
      return node.values.some((value, index) => index > 0 && value === child)
        ? { position: "a case's value after its first", evaluated: child }
        : null;
    case "functionParameter":
      return child === node.defaultValue
        ? { position: "a parameter's default", evaluated: child }
        : null;
    default:
      return null;
  }
}

/** A statement's kind, as the parser names the `Statement` kinds (`src/ast.ts`). */
const STATEMENT = /(?:Statement|Declaration)$/;

/**
 * The statement kinds whose last instruction of their own span the lowering emits before their operands' evaluation:
 * a function's `beginFunctionDefaults`, before each parameter's `prepareParameterDefault` and default
 * (`src/compiler/lowering/compiler.ts`, its function lowering). Nothing of theirs shows their code was evaluated.
 */
const OWN_FIRST: ReadonlySet<string> = new Set(["functionDeclaration"]);

/**
 * Why a run does not show it evaluated the pasted code at `at`, or `null` (#1586; Codex r1 and r2 on #1589). Only the
 * instruction that consumes the evaluated operands shows it, which the lowering emits after their evaluation: of the
 * instructions with the span of the innermost statement around the code, the one emitted last; and for each position on
 * the way down that a run may skip (`lazyPosition`), the last one with that position's span. A setup instruction that
 * shares a span runs before the operands, and a pure position has no instruction of its own, so neither shows anything.
 */
function unevaluated(
  source: string,
  plan: InstructionPlan,
  executed: ReadonlySet<number>,
  at: Pasted["at"],
): string | null {
  const last = ({ start, end }: SourceSpan): number =>
    plan.instructions.findLastIndex(
      ({ span }) => span.so === start.offset && span.eo === end.offset,
    );
  const path: Node[] = [];
  for (let node: Node | undefined = parse(source).program; node !== undefined;) {
    path.push(node);
    node = inside(node).find(
      ({ span }) => span.start.offset <= at.start && at.end <= span.end.offset,
    );
  }
  const code = source.slice(at.start, at.end);
  const depth = path.findLastIndex((node) => STATEMENT.test(node.kind ?? ""));
  if (depth === -1) return `unproved evaluation: no statement holds '${code}'`;
  const own = last(path[depth]!.span);
  if (own === -1)
    return `unproved evaluation: no instruction has the span of its '${path[depth]!.kind}'`;
  if (OWN_FIRST.has(path[depth]!.kind!))
    return `unproved evaluation: its '${path[depth]!.kind}' emits its own instruction before its operands`;
  if (!executed.has(own)) return `unreached: the run ended without executing '${code}'`;
  for (let below = depth + 1; below < path.length; below += 1) {
    const lazy = lazyPosition(path[below - 1]!, path[below]!);
    if (lazy === null) continue;
    const entered = last(lazy.evaluated.span);
    if (entered === -1 || !executed.has(entered)) return `unproved evaluation: ${lazy.position}`;
  }
  return null;
}

/**
 * Why a pasted form fails: its compile errors, the new core's among them (Codex r9), its run's failure, or a run that
 * does not show it runs (#1586): one still waiting after `COMPLETIONS` scripted answers (`answer`) or for what none
 * answers, or one that ended without showing it evaluated the pasted code (`unevaluated`). `null` where it compiles,
 * runs to its end and evaluated the code. A pasted declaration's (`declared`) compile errors leave out the current checker's recorded
 * difference at its own join (#1412), which the new core decides.
 */
export function pasteFailure({ source, at, declared }: Omit<Pasted, "code">): string | null {
  const files = [{ path: "main.tease", source }];
  const compiled =
    declared === undefined
      ? compileProject(files)
      : compileProjectWithBackend(files, {}, recorded(landingJoins(source, declared)));
  const errors = compiled.diagnostics.filter((diagnostic) => diagnostic.severity === "error");
  if (errors.length > 0)
    return errors.map((error) => `${error.code}: ${error.message}`).join(" | ");
  const request = coreRequest([{ path: "main.tease", source }]);
  const all = request === null ? [] : analyseCore(request).diagnostics;
  const text = messageSource([source], all);
  const core = all.filter((diagnostic) => diagnostic.class === "compile-error");
  if (core.length > 0)
    return core
      .map((diagnostic) => `core ${diagnostic.code}: ${coreMessage(diagnostic, text)}`)
      .join(" | ");
  if (compiled.plan === null) return "no plan";
  const session = createFreshRuntimeSession(compiled.plan, {
    baseDelayMs: 0,
    delayPerWordMs: 0,
    delayPerCharacterMs: 0,
  });
  const executed = new Set<number>();
  for (let completions = 0; ; completions += 1) {
    const { events, instructionTrace } = session.run({ instructionTrace: true });
    for (const index of instructionTrace?.instructions ?? []) executed.add(index);
    const failure = events.find((event) => event.kind === "runtimeFailure");
    if (failure !== undefined) return JSON.stringify(failure);
    const view = session.view();
    if (view.status === "halted") return unevaluated(source, compiled.plan, executed, at);
    const request = answer(view);
    const action = view.foregroundAction;
    const awaited = action?.kind === "interaction" ? action.interactionKind : action?.kind;
    if (request === undefined || completions === COMPLETIONS)
      return `incomplete execution: ${view.status} for ${awaited ?? "nothing"} after ${completions} completions`;
    const { outcome } = session.completeAction(request);
    if (outcome.kind !== "completed")
      return `incomplete execution: the scripted answer to ${awaited} was not taken (${outcome.kind})`;
  }
}
