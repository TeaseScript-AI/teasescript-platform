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
 * value's in its root object, never in an element of a collection, which it keeps as it is when it fits. Each source is
 * read and stored, with the script's storage or the JSON holding an element or an object without the property, in the
 * four modes, planned by the candidate and run.
 */
const READERS: readonly (readonly [
  name: string,
  declare: string,
  receiver: string,
  absent: "possible" | "never",
  read: { readonly stored: SerializableRuntimeValue } | { readonly json: string },
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
];

test("a load's or parse's default proves a property only where its reader fills it from the default (#1436, #1458)", () => {
  const wrong: string[] = [];
  const globals = ["hostValue", "hostText"];
  for (const [name, declare, receiver, absent, read] of READERS)
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
      const { plan } = publishedRoute([{ path: "main.tease", source }], globals);
      assert.ok(plan !== null && plan !== "outside", `${c.name}: the candidate plans it`);
      const result = runGlobals(
        plan,
        { hostValue: 0, hostText: "json" in read ? read.json : "{}" },
        "stored" in read ? [{ key: "seed", value: structuredClone(read.stored) }] : undefined,
      );
      const said = result.said.map(({ text }) => text);
      const expected =
        absent === "possible"
          ? { failure: `TSR017@${c.start}:${c.end}`, said: ["BEFORE"] }
          : { failure: null, said: ["BEFORE", use === "read" ? "1" : "STORED", "AFTER"] };
      if (!isDeepStrictEqual({ failure: result.failure, said }, expected))
        wrong.push(`${c.name}, run: ${result.failure} ${JSON.stringify(said)}`);
    }
  assert.deepEqual(wrong, []);
});
