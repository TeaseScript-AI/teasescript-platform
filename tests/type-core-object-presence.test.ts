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
 * #1436 (ADR 0021 1.4, 1.8, 1.10): an object's type, written or tested, says nothing of its properties. A read or store of
 * a property the object may lack owes its member warning and check at the access, an object literal's own property
 * proves itself, and a property no source has is an error. The family crosses where the receiver comes from, how it
 * reaches the access and the property's name (a plain one, and names a collection's steps also use), for a read and a
 * store. Each source's decision is judged in the four modes. The candidate's plan of each source it takes runs with an
 * empty host object, where the access stops with TSR017 after the first `say` and before the next, and with each present
 * value, which the read says unchanged (`null` included). The host input stays unchanged.
 */

interface Origin {
  /** Whether the object the access reaches may lack the property, always lacks it, or never does. */
  readonly absent: "possible" | "always" | "never";
  readonly declare: (name: string) => string;
  /** Where the source runs: the candidate takes no type test, so those sources are judged by their decision alone. */
  readonly guarded?: true;
  /** What a read of a literal's property says, where the host's object does not decide it. */
  readonly says?: string;
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
  "a written object a load gives": {
    absent: "possible",
    declare: () => 'let seed: object = load("seed", default: {})\n',
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
function decision(c: Case) {
  const request = coreRequest([{ path: "main.tease", source: c.source }]);
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
    const loads = c.source.includes("load(");
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
      // (the literal's property, and the load's default `{}`, whatever the host gives)
      const lacks = c.origin.absent === "possible" && (value === undefined || loads);
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
