import assert from "node:assert/strict";
import test from "node:test";
import { isDeepStrictEqual } from "node:util";

import type { SerializableRuntimeValue } from "../src/runtime/values/serializable-values.js";
import { analyseCore } from "../src/type-inference/core/answers.js";
import { checkedResult } from "../src/type-inference/core/consumer.js";
import { coreRequest } from "./helpers/type-core-analysis.js";
import { inMode, MODES, type Mode, publishedRoute } from "./helpers/type-core-oracles.js";
import { runGlobals } from "./helpers/type-core-route.js";

/*
 * #1436 (ADR 0021 1.4, 1.8, 1.10): an object's type, written or tested, says nothing of its properties. A read or store
 * of a property the object may lack owes its member warning and check at the access. An object literal's own property
 * proves itself, and so does one a typed load's or parse's default names below a written `object` (V30 §13). A property
 * no source has is an error. The family crosses where the receiver comes from, how it reaches the access and the
 * property's name (a plain one, and names a collection's steps also use), for a read and a store. Each source's
 * decision is judged in the four modes. The candidate's plan of each source it takes runs with an empty host object,
 * where the access stops with TSR017 after the first `say` and before the next, and with each present value, which the
 * read says unchanged (`null` included). The host input stays unchanged.
 */

interface Origin {
  /** Whether the object the access reaches may lack the property, always lacks it, or never does. */
  readonly absent: "possible" | "always" | "never";
  readonly declare: (name: string) => string;
  /** Where the source runs: the candidate takes no type test, so those sources are judged by their decision alone. */
  readonly guarded?: true;
  /** What a read of a literal's or a default's property says, where the host's object does not decide it. */
  readonly says?: string;
  /** Whether a run reads the property of a default that lacks it, whatever the host gives. */
  readonly defaulted?: true;
}

const ORIGINS: Readonly<Record<string, Origin>> = {
  "a written object of host data": {
    absent: "possible",
    declare: () => "let seed: object = hostValue\n",
  },
  "a written object replaced by host data": {
    absent: "possible",
    declare: (name) => `let seed: object = {${name}: 1}\nseed = hostValue\n`,
  },
  "a tested object of host data": {
    absent: "possible",
    guarded: true,
    declare: () => "let seed = hostValue\n",
  },
  "host data": { absent: "possible", declare: () => "let seed = hostValue\n" },
  // (no value is stored and the JSON is `{}`, so each run takes the default, V30 §13: it names the property or not)
  "a written object a load gives, its default without the property": {
    absent: "possible",
    declare: () => 'let seed: object = load("seed", default: {other: 1})\n',
    defaulted: true,
  },
  "a written object a load gives, its default with the property": {
    absent: "never",
    declare: (name) => `let seed: object = load("seed", default: {${name}: "kept"})\n`,
    says: "kept",
  },
  "a written object a parse gives, its default without the property": {
    absent: "possible",
    declare: () => 'let seed: object = fromJson("{}", default: {other: 1})\n',
    defaulted: true,
  },
  "a written object a parse gives, its default with the property": {
    absent: "never",
    declare: (name) => `let seed: object = fromJson("{}", default: {${name}: "kept"})\n`,
    says: "kept",
  },
  "a literal with the property, null": {
    absent: "never",
    declare: (name) => `let seed: object = {${name}: null}\n`,
    says: "null",
  },
  // (its property's value is host data, so the property's answer is as unknown as an object's the analysis cannot list)
  "a literal with the property, host data": {
    absent: "never",
    declare: (name) => `let seed: object = {${name}: hostValue}\n`,
  },
  "a literal without the property": {
    absent: "always",
    declare: () => "let seed: object = {other: 1}\n",
  },
};

interface Carrier {
  readonly declare: string;
  readonly receiver: string;
}

/** How the receiver reaches the access: itself, a copy, a property of an object, an element of a list. */
const CARRIERS: Readonly<Record<string, Carrier>> = {
  direct: { declare: "", receiver: "seed" },
  copy: { declare: "let copy = seed\n", receiver: "copy" },
  "an enclosing object": { declare: "let box = {inner: seed}\n", receiver: "box.inner" },
  "a list's element": { declare: "let items = [seed]\n", receiver: "items[0]" },
};

interface Case {
  readonly name: string;
  readonly origin: Origin;
  readonly property: string;
  readonly use: "read" | "store";
  readonly source: string;
  /** The access's span: `seed.n`, `box.inner.n`, … */
  readonly start: number;
  readonly end: number;
}

function sourceOf(origin: Origin, carrier: string, property: string, use: Case["use"]) {
  const { declare, receiver } = CARRIERS[carrier]!;
  const access = `${receiver}.${property}`;
  const body =
    `say "BEFORE"\n${declare}` +
    (use === "read"
      ? `let observed = ${access}\nsay observed\n`
      : `${access} = "stored"\nsay "STORED"\n`) +
    'say "AFTER"\n';
  const source = origin.guarded
    ? `${origin.declare(property)}if seed is object {\n${body.replace(/^/gm, "    ").trimEnd()}\n}\nexit\n`
    : `${origin.declare(property)}${body}exit\n`;
  const start = source.indexOf(access);
  return { source, start, end: start + access.length };
}

/**
 * Every origin at every carrier, a read and a store of `n`; and the names a collection's steps also use (`element`,
 * `entry`, `length`) at every carrier, for an origin of each answer (host data in a written object, a literal with the
 * property).
 */
const FAMILY: readonly Case[] = (() => {
  const out: Case[] = [];
  const add = (origin: string, carrier: string, property: string, use: Case["use"]) =>
    out.push({
      name: `${origin}, ${carrier}, .${property}, a ${use}`,
      origin: ORIGINS[origin]!,
      property,
      use,
      ...sourceOf(ORIGINS[origin]!, carrier, property, use),
    });
  for (const use of ["read", "store"] as const)
    for (const carrier of Object.keys(CARRIERS)) {
      for (const origin of Object.keys(ORIGINS)) add(origin, carrier, "n", use);
      for (const property of ["element", "entry", "length"])
        for (const origin of ["a written object of host data", "a literal with the property, null"])
          add(origin, carrier, property, use);
    }
  return out;
})();

/** The decision at the access: the diagnostics there as (class, kind, obligation kind), the checks there by kind. */
function decision(c: Omit<Case, "origin" | "property" | "use">, globals = ["hostValue"]) {
  const request = coreRequest([{ path: "main.tease", source: c.source }], globals);
  assert.ok(request !== null, `${c.name}: parses and resolves`);
  const answers = analyseCore(request);
  const checked = checkedResult(answers, request);
  const here = (site: { readonly start: number; readonly end: number }) =>
    site.start === c.start && site.end === c.end;
  return {
    outcome: checked.outcome,
    diagnostics: checked.diagnostics.flatMap((d) =>
      "site" in d && d.site !== undefined && here(d.site)
        ? [[d.class, d.kind, "obligation" in d ? d.obligation.kind : null]]
        : [],
    ),
    checks: answers.checks.filter((check) => here(check.site)).map((check) => check.kind),
    // (every mode publishes the whole record alike, not only the access's part)
    record: JSON.stringify([checked.outcome, checked.diagnostics, answers.checks]),
  };
}

test("a property an object may lack owes its member warning and check at the access, whatever object type the receiver has (#1436)", () => {
  const wrong: string[] = [];
  for (const c of FAMILY) {
    const [first, ...others] = MODES.map((mode: Mode) => inMode(mode, () => decision(c)));
    if (others.some((other) => other.record !== first!.record))
      wrong.push(`${c.name}: the modes differ`);
    const { outcome, diagnostics, checks } = first!;
    const verdict =
      c.origin.absent === "possible"
        ? isDeepStrictEqual(diagnostics, [
            ["warning-runtime-check", "member-read", "null-check"],
          ]) && isDeepStrictEqual(checks, ["null-check"])
        : c.origin.absent === "never"
          ? diagnostics.length === 0 && checks.length === 0
          : outcome === "compile-error" &&
            (c.use === "store" ||
              isDeepStrictEqual(diagnostics, [["compile-error", "member-read", null]]));
    if (!verdict) wrong.push(`${c.name}: ${outcome} ${JSON.stringify({ diagnostics, checks })}`);
  }
  assert.deepEqual(wrong, []);
});

test("the access stops an object without the property before the next effect and gives a present value unchanged (#1436)", () => {
  const present: readonly (readonly [string, SerializableRuntimeValue])[] = [
    ["null", null],
    ["false", false],
    ["0", 0],
    ["text", "text"],
  ];
  const wrong: string[] = [];
  let ran = 0;
  for (const c of FAMILY) {
    if (c.origin.guarded) continue;
    const { plan } = publishedRoute([{ path: "main.tease", source: c.source }], ["hostValue"]);
    if (c.origin.absent === "always") {
      if (plan !== null) wrong.push(`${c.name}: planned`);
      continue;
    }
    assert.ok(plan !== null && plan !== "outside", `${c.name}: the candidate plans it`);
    for (const [shown, value] of [["(absent)", undefined] as const, ...present]) {
      const host: SerializableRuntimeValue = {
        kind: "object",
        properties: value === undefined ? [] : [{ name: c.property, value }],
      };
      const input = structuredClone(host);
      const result = runGlobals(plan, { hostValue: host });
      ran += 1;
      const said = result.said.map(({ text }) => text);
      if (!isDeepStrictEqual(host, input))
        wrong.push(`${c.name}, ${shown}: the host input changed`);
      const lacks =
        c.origin.absent === "possible" && (value === undefined || c.origin.defaulted === true);
      const expected = lacks
        ? { failure: `TSR017@${c.start}:${c.end}`, said: ["BEFORE"] }
        : {
            failure: null,
            said: [
              "BEFORE",
              c.use === "store"
                ? "STORED"
                : c.origin.absent === "never"
                  ? (c.origin.says ?? said[1])
                  : shown,
              "AFTER",
            ],
          };
      if (!isDeepStrictEqual({ failure: result.failure, said }, expected))
        wrong.push(`${c.name}, ${shown}: ${result.failure} ${JSON.stringify(said)}`);
    }
  }
  assert.deepEqual(wrong, []);
  assert.ok(ran > 0);
});

/**
 * The lead's rulings on Codex r2's B1 (#1436) and r3's N2 (#1458): a load's or parse's default, written or not, proves a
 * property only where its reader takes a missing key from the default. JSON's reader does at every level; a stored
 * value's in its root object, never in an element of a collection, which it keeps as it is when it fits. A `null` the
 * default names is filled the same way (#1470). Each source is read and stored, with the script's storage or the JSON
 * holding an element or an object without the property, in the four modes, each mode's plan run.
 */
const READERS: readonly (readonly [
  name: string,
  declare: string,
  receiver: string,
  absent: "possible" | "never",
  read: { readonly stored: SerializableRuntimeValue } | { readonly json: string },
  says?: string,
])[] = [
  [
    "a stored list's element",
    'let seed: object[] = load("seed", default: [{n: 1}])',
    "seed[0]",
    "possible",
    { stored: { kind: "list", items: [{ kind: "object", properties: [] }] } },
  ],
  [
    "an element of a stored object's list",
    'let seed: object = load("seed", default: {items: [{n: 1}]})',
    "seed.items[0]",
    "possible",
    {
      stored: {
        kind: "object",
        properties: [
          { name: "items", value: { kind: "list", items: [{ kind: "object", properties: [] }] } },
        ],
      },
    },
  ],
  [
    "a stored root object",
    'let seed: object = load("seed", default: {n: 1})',
    "seed",
    "never",
    { stored: { kind: "object", properties: [] } },
  ],
  // (#1458: a load without a written type reads its stored value by its default's type the same way)
  [
    "an untyped stored list's element",
    'let seed = load("seed", default: [{n: 1}])',
    "seed[0]",
    "possible",
    { stored: { kind: "list", items: [{ kind: "object", properties: [] }] } },
  ],
  [
    "an element of an untyped stored object's list",
    'let seed = load("seed", default: {items: [{n: 1}]})',
    "seed.items[0]",
    "possible",
    {
      stored: {
        kind: "object",
        properties: [
          { name: "items", value: { kind: "list", items: [{ kind: "object", properties: [] }] } },
        ],
      },
    },
  ],
  [
    "an element of an untyped stored list whose default's records differ",
    'let seed = load("seed", default: [{n: 1}, {m: 2}])',
    "seed[0]",
    "possible",
    { stored: { kind: "list", items: [{ kind: "object", properties: [] }] } },
  ],
  [
    "an untyped stored root object",
    'let seed = load("seed", default: {n: 1})',
    "seed",
    "never",
    { stored: { kind: "object", properties: [] } },
  ],
  [
    "a JSON list's element",
    "let seed: object[] = fromJson(hostText, default: [{n: 1}])",
    "seed[0]",
    "never",
    { json: "[{}]" },
  ],
  [
    "an element of a JSON object's list",
    "let seed: object = fromJson(hostText, default: {items: [{n: 1}]})",
    "seed.items[0]",
    "never",
    { json: '{"items": [{}]}' },
  ],
  [
    "a stored root object, its default's property null",
    'let seed: object = load("seed", default: {n: null})',
    "seed",
    "never",
    { stored: { kind: "object", properties: [] } },
    "null",
  ],
  [
    "an object nested in a stored object, its default's property null",
    'let seed: object = load("seed", default: {inner: {n: null}})',
    "seed.inner",
    "never",
    {
      stored: {
        kind: "object",
        properties: [{ name: "inner", value: { kind: "object", properties: [] } }],
      },
    },
    "null",
  ],
  [
    "a stored list's element, its default's property null",
    'let seed: object[] = load("seed", default: [{n: null}])',
    "seed[0]",
    "possible",
    { stored: { kind: "list", items: [{ kind: "object", properties: [] }] } },
  ],
  [
    "an element of a JSON object's list, its default's property null",
    "let seed: object = fromJson(hostText, default: {items: [{n: null}]})",
    "seed.items[0]",
    "never",
    { json: '{"items": [{}]}' },
    "null",
  ],
];

test("a load's or parse's default proves a property only where its reader fills it from the default (#1436, #1458, #1470)", () => {
  const wrong: string[] = [];
  const globals = ["hostValue", "hostText"];
  for (const [name, declare, receiver, absent, read, says = "1"] of READERS)
    for (const use of ["read", "store"] as const) {
      const access = `${receiver}.n`;
      const source =
        `${declare}\nsay "BEFORE"\n` +
        (use === "read"
          ? `let observed = ${access}\nsay observed\n`
          : `${access} = 2\nsay "STORED"\n`) +
        'say "AFTER"\nexit\n';
      const start = source.indexOf(access);
      const c = { name: `${name}, a ${use}`, source, start, end: start + access.length };
      const [first, ...others] = MODES.map((mode: Mode) =>
        inMode(mode, () => decision(c, globals)),
      );
      if (others.some((other) => other.record !== first!.record))
        wrong.push(`${c.name}: the modes differ`);
      const { diagnostics, checks } = first!;
      const owed = isDeepStrictEqual(checks, ["null-check"]);
      if (
        absent === "possible"
          ? !owed || diagnostics.length !== 1
          : diagnostics.length > 0 || checks.length > 0
      )
        wrong.push(`${c.name}: ${JSON.stringify({ diagnostics, checks })}`);
      const expected =
        absent === "possible"
          ? { failure: `TSR017@${c.start}:${c.end}`, said: ["BEFORE"] }
          : { failure: null, said: ["BEFORE", use === "read" ? says : "STORED", "AFTER"] };
      // (each mode's own plan, as each mode's own decision)
      for (const mode of MODES) {
        const { plan } = inMode(mode, () =>
          publishedRoute([{ path: "main.tease", source }], globals),
        );
        // (each case reports, so a tree that plans none of them shows every verdict)
        if (plan === null || plan === "outside") {
          wrong.push(`${c.name}, ${JSON.stringify(mode)}: not planned`);
          continue;
        }
        const result = runGlobals(
          plan,
          { hostValue: 0, hostText: "json" in read ? read.json : "{}" },
          "stored" in read ? [{ key: "seed", value: structuredClone(read.stored) }] : undefined,
        );
        const said = result.said.map(({ text }) => text);
        if (!isDeepStrictEqual({ failure: result.failure, said }, expected))
          wrong.push(
            `${c.name}, ${JSON.stringify(mode)}: ${result.failure} ${JSON.stringify(said)}`,
          );
      }
    }
  assert.deepEqual(wrong, []);
});

const object = (properties: Readonly<Record<string, SerializableRuntimeValue>>) => ({
  kind: "object" as const,
  properties: Object.entries(properties).map(([name, value]) => ({ name, value })),
});

/**
 * #1459 (V30 §25, ADR 0021 1.8): a stored object keeps every property it holds, also one its default lacks, so a read or
 * store of such a property owes its member warning and check, never an error, wherever the object is. Each source runs
 * in each mode's plan with the script's storage holding the property, which the read gives unchanged, and without it.
 */
const STORED_EXTRA: readonly (readonly [
  name: string,
  declare: string,
  receiver: string,
  wrap: (stored: SerializableRuntimeValue) => SerializableRuntimeValue,
])[] = [
  ["a stored root object", 'let seed = load("seed", default: {n: 1})', "seed", (stored) => stored],
  [
    "an object nested in a stored object",
    'let seed = load("seed", default: {inner: {n: 1}})',
    "seed.inner",
    (stored) => object({ inner: stored }),
  ],
  [
    "a stored list's element",
    'let seed = load("seed", default: [{n: 1}])',
    "seed[0]",
    (stored) => ({ kind: "list", items: [stored] }),
  ],
  [
    "an element of a stored object's list",
    'let seed = load("seed", default: {items: [{n: 1}]})',
    "seed.items[0]",
    (stored) => object({ items: { kind: "list", items: [stored] } }),
  ],
];

test("a stored object's property its default lacks owes its member warning and check, never an error (#1459)", () => {
  const wrong: string[] = [];
  for (const [name, declare, receiver, wrap] of STORED_EXTRA)
    for (const use of ["read", "store"] as const) {
      const access = `${receiver}.m`;
      const source =
        `${declare}\nsay "BEFORE"\n` +
        (use === "read"
          ? `let observed = ${access}\nsay observed\n`
          : `${access} = 2\nsay "STORED"\n`) +
        'say "AFTER"\nexit\n';
      const start = source.indexOf(access);
      const c = { name: `${name}, a ${use}`, source, start, end: start + access.length };
      const [first, ...others] = MODES.map((mode: Mode) => inMode(mode, () => decision(c)));
      if (others.some((other) => other.record !== first!.record))
        wrong.push(`${c.name}: the modes differ`);
      const { outcome, diagnostics, checks } = first!;
      if (
        outcome === "compile-error" ||
        !isDeepStrictEqual(diagnostics, [["warning-runtime-check", "member-read", "null-check"]]) ||
        !isDeepStrictEqual(checks, ["null-check"])
      )
        wrong.push(`${c.name}: ${outcome} ${JSON.stringify({ diagnostics, checks })}`);
      // (the read names stored data as the cause; the store says, as for any object that may lack it, what it may hold)
      const sentence =
        use === "read"
          ? `'${receiver}' may not have property 'm' here. If it does not, the Tease stops with an error at this ` +
            `line. '${receiver}' comes from outside the script, so its type is known only when the script runs.`
          : `'${receiver}' may hold an object without property 'm' here. If it does, the Tease stops with an error ` +
            "at this line.";
      for (const mode of MODES) {
        const { plan, text } = inMode(mode, () =>
          publishedRoute([{ path: "main.tease", source }], ["hostValue"]),
        );
        if (plan === null || plan === "outside") {
          wrong.push(`${c.name}, ${JSON.stringify(mode)}: not planned`);
          continue;
        }
        // EVIDENCE: invariant: the text `publishedRoute` gives is the JSON of the compiler's plan and diagnostics.
        const route = JSON.parse(text) as {
          diagnostics: { code: string; message: string; span: { start: { offset: number } } }[];
        };
        const messages = route.diagnostics.flatMap((d) =>
          d.code === "TSV043" && d.span.start.offset === c.start ? [d.message] : [],
        );
        if (!isDeepStrictEqual(messages, [sentence]))
          wrong.push(`${c.name}, ${JSON.stringify(mode)}: ${JSON.stringify(messages)}`);
        for (const [stored, expected] of [
          [
            object({ n: 1, m: 9 }),
            { failure: null, said: ["BEFORE", use === "read" ? "9" : "STORED", "AFTER"] },
          ],
          [object({ n: 1 }), { failure: `TSR017@${c.start}:${c.end}`, said: ["BEFORE"] }],
        ] as const) {
          const result = runGlobals(plan, { hostValue: 0 }, [
            { key: "seed", value: wrap(structuredClone(stored)) },
          ]);
          const said = result.said.map(({ text: shown }) => shown);
          if (!isDeepStrictEqual({ failure: result.failure, said }, expected))
            wrong.push(
              `${c.name}, ${JSON.stringify(mode)}: ${result.failure} ${JSON.stringify(said)}`,
            );
        }
      }
    }
  // JSON's reader leaves a key its default lacks out (no written `object` keeps it), so no parsed object has it
  const json = "let seed = fromJson(hostText, default: {n: 1})\nsay seed.m\nexit\n";
  const at = json.indexOf("seed.m");
  const parsed = decision({ name: "JSON", source: json, start: at, end: at + 6 }, ["hostText"]);
  if (!isDeepStrictEqual(parsed.diagnostics, [["compile-error", "member-read", null]]))
    wrong.push(`a parsed object's property its default lacks: ${JSON.stringify(parsed)}`);
  // the reader fills a property the default lists, its `null` too: no presence check where the object lacks it
  const listed = 'let seed = load("seed", default: {n: null})\nsay seed.n\nexit\n';
  const read = listed.indexOf("seed.n");
  const filled = decision({ name: "listed", source: listed, start: read, end: read + 6 });
  if (filled.diagnostics.length > 0 || filled.checks.length > 0)
    wrong.push(`a listed property with a null default: ${JSON.stringify(filled)}`);
  assert.deepEqual(wrong, []);
});

/**
 * #1469 (§4: one warning and check per offending kind, every unknown one kind): where the receiver may hold a value the
 * script cannot know, itself absent included, and an object it may hold may lack the property, the access owes one check,
 * explained by the property's own answer. The receiver's own access keeps its warning, and a run stops there where the
 * receiver is absent, at the access where the property is. A read names stored or host data as its cause (`outside`),
 * a store what the object may lack (#1465 r1's F2). Each source is read and stored, in the four modes, each mode's plan
 * run on the stored or host values given (`said` the value a read says, else the access the run stops at with TSR017).
 */
const RECEIVER_AND_PROPERTY: readonly {
  readonly name: string;
  readonly declare: string;
  readonly access: string;
  /** The receiver's own member access, which keeps its own warning, where it is one. */
  readonly receiver: string | null;
  readonly outside: boolean;
  readonly runs: readonly (readonly [
    input:
      { readonly host: SerializableRuntimeValue } | { readonly stored: SerializableRuntimeValue },
    outcome: { readonly said: string } | "receiver" | "access",
  ])[];
}[] = (() => {
  const seed = 'let seed = load("seed", default: [{inner: {n: 1}}])';
  const stored = (inner: Readonly<Record<string, SerializableRuntimeValue>> | null) => ({
    stored: {
      kind: "list" as const,
      items: [object(inner === null ? {} : { inner: object(inner) })],
    },
  });
  const runs = (property: string) =>
    [
      [stored({ n: 1, [property]: 9 }), { said: "9" }],
      [stored(property === "n" ? {} : { n: 1 }), "access"],
      [stored(null), "receiver"],
    ] as const;
  const literal = {
    declare: "let items = [{inner: {n: 1}}, {other: 2}]",
    receiver: "items[0].inner",
  };
  const host = "let items = [{other: 1}, hostValue]";
  return [
    {
      name: "a stored list element's property its default lacks",
      declare: seed,
      access: "seed[0].inner.m",
      receiver: "seed[0].inner",
      outside: true,
      runs: runs("m"),
    },
    {
      name: "a stored list element's property its default lists",
      declare: seed,
      access: "seed[0].inner.n",
      receiver: "seed[0].inner",
      outside: false,
      runs: runs("n"),
    },
    {
      name: "a copy of a stored list element's object",
      declare: `${seed}\nlet x = seed[0].inner`,
      access: "x.m",
      receiver: "seed[0].inner",
      outside: true,
      runs: runs("m"),
    },
    {
      name: "a literal list with an element without the object",
      ...literal,
      access: "items[0].inner.n",
      outside: false,
      runs: [[{ host: 0 }, { said: "1" }]],
    },
    {
      name: "host data beside a literal without the property",
      declare: host,
      access: "items[1].n",
      receiver: null,
      outside: true,
      runs: [
        [{ host: object({ n: 9 }) }, { said: "9" }],
        [{ host: object({}) }, "access"],
      ],
    },
  ];
})();

test("an access whose receiver may be absent or unknown and whose object may lack the property gets one warning and one check (#1469)", () => {
  const wrong: string[] = [];
  for (const { name, declare, access, receiver, outside, runs } of RECEIVER_AND_PROPERTY)
    for (const use of ["read", "store"] as const) {
      const source =
        `${declare}\nsay "BEFORE"\n` +
        (use === "read"
          ? `let observed = ${access}\nsay observed\n`
          : `${access} = 9\nsay "STORED"\n`) +
        'say "AFTER"\nexit\n';
      const start = source.indexOf(access, source.indexOf("BEFORE"));
      const c = { name: `${name}, a ${use}`, source, start, end: start + access.length };
      const own =
        receiver === null
          ? null
          : { start: source.indexOf(receiver), end: source.indexOf(receiver) + receiver.length };
      const subject = access.slice(0, access.lastIndexOf("."));
      const property = access.slice(access.lastIndexOf(".") + 1);
      const sentence =
        use === "read" && outside
          ? `'${subject}' may not have property '${property}' here. If it does not, the Tease stops with an error at ` +
            `this line. '${subject}' comes from outside the script, so its type is known only when the script runs.`
          : `'${subject}' may hold an object without property '${property}' here. If it does, the Tease stops with ` +
            "an error at this line.";
      const [first, ...others] = MODES.map((mode: Mode) => inMode(mode, () => decision(c)));
      if (others.some((other) => other.record !== first!.record))
        wrong.push(`${c.name}: the modes differ`);
      const { diagnostics, checks } = first!;
      if (
        !isDeepStrictEqual(diagnostics, [["warning-runtime-check", "member-read", "null-check"]]) ||
        !isDeepStrictEqual(checks, ["null-check"])
      )
        wrong.push(`${c.name}: ${JSON.stringify({ diagnostics, checks })}`);
      for (const mode of MODES) {
        const { plan, text } = inMode(mode, () =>
          publishedRoute([{ path: "main.tease", source }], ["hostValue"]),
        );
        if (plan === null || plan === "outside") {
          wrong.push(`${c.name}, ${JSON.stringify(mode)}: not planned`);
          continue;
        }
        // EVIDENCE: invariant: the text `publishedRoute` gives is the JSON of the compiler's plan and diagnostics.
        const route = JSON.parse(text) as {
          diagnostics: {
            code: string;
            message: string;
            span: { start: { offset: number }; end: { offset: number } };
          }[];
        };
        const here = (site: { readonly start: number; readonly end: number }) =>
          route.diagnostics.flatMap((d) =>
            d.code === "TSV043" &&
            d.span.start.offset === site.start &&
            d.span.end.offset === site.end
              ? [d.message]
              : [],
          );
        if (!isDeepStrictEqual(here(c), [sentence]))
          wrong.push(`${c.name}, ${JSON.stringify(mode)}: ${JSON.stringify(here(c))}`);
        if (own !== null && here(own).length !== 1)
          wrong.push(
            `${c.name}, ${JSON.stringify(mode)}: the receiver's own access ${JSON.stringify(here(own))}`,
          );
        for (const [input, outcome] of runs) {
          const result =
            "stored" in input
              ? runGlobals(plan, { hostValue: 0 }, [
                  { key: "seed", value: structuredClone(input.stored) },
                ])
              : runGlobals(plan, { hostValue: structuredClone(input.host) });
          // (a copy's receiver is read before the first `say`)
          const expected =
            outcome === "access"
              ? { failure: `TSR017@${c.start}:${c.end}`, said: ["BEFORE"] }
              : outcome === "receiver"
                ? {
                    failure: `TSR017@${own!.start}:${own!.end}`,
                    said: own!.start < source.indexOf("BEFORE") ? [] : ["BEFORE"],
                  }
                : {
                    failure: null,
                    said: ["BEFORE", use === "read" ? outcome.said : "STORED", "AFTER"],
                  };
          const got = {
            failure: result.failure,
            said: result.said.map(({ text: shown }) => shown),
          };
          if (!isDeepStrictEqual(got, expected))
            wrong.push(
              `${c.name}, ${JSON.stringify(mode)}, ${JSON.stringify(input)}: ${JSON.stringify(got)}`,
            );
        }
      }
    }
  assert.deepEqual(wrong, []);
});
