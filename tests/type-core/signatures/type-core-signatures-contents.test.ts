// Content checks: the written element type of a value from outside the script, and toJson's one proof per unchanged
// value.

import assert from "node:assert/strict";
import test from "node:test";
import { analyseCore } from "../../../src/type-inference/core/answers.js";
import { checkedResult } from "../../../src/type-inference/core/check-result/check-result.js";
import { coreRequest } from "../../helpers/type-core-analysis.js";
import { inMode, MODES } from "../../helpers/type-core-oracles.js";
import { coreRecord, type DiagnosticRule } from "../../../src/type-inference/core/result.js";
import { analysed } from "../../helpers/type-core/type-core-signatures-setup.js";

/** A list literal of each written type the content family uses, which decides that type unwritten. */
const LITERALS: Readonly<Record<string, string>> = {
  "object[]": "[{n: 1}]",
  "string[]": '["a"]',
  "boolean[]": "[true]",
  "integer[]": "[1]",
  "regex[]": "[/a/]",
  "integer[][]": "[[1]]",
};

/**
 * A content check over the contents a written type admits (the owner's review F2; ADR 0021 1.8, 1.10): where a value
 * comes from outside the script (host data, a load, a parse) into a written collection type, directly or through a copy,
 * an object holding it, an element of an outer list, a replacement of an empty one, or into a decided one (Sol r2 N3), the elements `join` shows, `sort`
 * orders, `toJson` writes and a choice's list gives are its written element type's: one that does not fit owes the check
 * at the use, a warning (a list may be empty, so never an error), and one that fits is quiet; the incoming check is no
 * substitute. A known empty list is quiet. (A narrowing `is` test's element type narrows an element read, `v[0]`, not
 * the element path these checks read: `narrowing/narrowings.ts`'s, outside this family.)
 */
test("a content check reads the written element type of a value from outside the script: a misfit owes the use's check", (t) => {
  const consumers: readonly {
    readonly name: string;
    readonly rule: DiagnosticRule["rule"];
    readonly use: (receiver: string) => string;
    readonly site: (source: string, receiver: string) => readonly [number, number];
    readonly misfit: string;
    readonly fit: string;
  }[] = [
    {
      name: "join",
      rule: "elements",
      use: (r) => `let out = ${r}.join("|")`,
      site: (source, r) => {
        const start = source.lastIndexOf(`${r}.join(`);
        return [start, start + `${r}.join("|")`.length];
      },
      misfit: "object[]",
      fit: "string[]",
    },
    {
      name: "sort",
      rule: "elements",
      use: (r) => `${r}.sort()`,
      site: (source, r) => {
        const start = source.lastIndexOf(`${r}.sort()`);
        return [start, start + `${r}.sort()`.length];
      },
      misfit: "boolean[]",
      fit: "integer[]",
    },
    {
      name: "toJson",
      rule: "json",
      use: (r) => `say toJson(${r})`,
      site: (source, r) => {
        const start = source.lastIndexOf(`toJson(${r})`) + "toJson(".length;
        return [start, start + r.length];
      },
      misfit: "regex[]",
      fit: "integer[]",
    },
    {
      name: "a choice's list",
      rule: "choice",
      use: (r) => `let c = askChoice ${r}`,
      site: (source, r) => {
        const start = source.lastIndexOf(`askChoice ${r}`) + "askChoice ".length;
        return [start, start + r.length];
      },
      misfit: "integer[][]",
      fit: "integer[]",
    },
  ];
  const origins: readonly {
    readonly name: string;
    readonly source: (type: string, use: (receiver: string) => string) => readonly [string, string];
  }[] = [
    {
      name: "host data",
      source: (type, use) => [`let xs: ${type} = hostValue\n${use("xs")}\n`, "xs"],
    },
    {
      name: "a copy of host data",
      source: (type, use) => [`let xs: ${type} = hostValue\nlet ys = xs\n${use("ys")}\n`, "ys"],
    },
    {
      name: "an object's property",
      source: (type, use) => [
        `let h: ${type} = hostValue\nlet o = {xs: h}\n${use("o.xs")}\n`,
        "o.xs",
      ],
    },
    {
      name: "an element of an outer list",
      source: (type, use) => [`let w: ${type}[] = hostValue\n${use("w[0]")}\n`, "w[0]"],
    },
    {
      name: "a replaced empty list",
      source: (type, use) => [`let xs: ${type} = []\nxs = hostValue\n${use("xs")}\n`, "xs"],
    },
    {
      name: "a decided list replaced by host data",
      source: (type, use) => [`let xs = ${LITERALS[type]}\nxs = hostValue\n${use("xs")}\n`, "xs"],
    },
    {
      name: "a load",
      source: (type, use) => [`let xs: ${type} = load("k", default: [])\n${use("xs")}\n`, "xs"],
    },
    {
      name: "a parse",
      source: (type, use) => [
        `let xs: ${type} = fromJson(hostValue, default: [])\n${use("xs")}\n`,
        "xs",
      ],
    },
  ];
  const differing: string[] = [];
  let programs = 0;
  for (const consumer of consumers) {
    for (const origin of origins)
      for (const [type, expected] of [
        [consumer.misfit, "warning"],
        [consumer.fit, "quiet"],
      ] as const) {
        const [body, receiver] = origin.source(type, consumer.use);
        const source = `${body}exit\n`;
        const site = consumer.site(source, receiver);
        const own = analysed(source).filter((d) => "rule" in d && d.rule.rule === consumer.rule);
        const got =
          own.length === 0
            ? "quiet"
            : own.every(
                  (d) =>
                    d.class === "warning-runtime-check" &&
                    d.kind !== "budget" &&
                    d.site.start === site[0] &&
                    d.site.end === site[1] &&
                    d.obligation.kind === "operand",
                )
              ? "warning"
              : own.map((d) => `${d.class} @${d.site.start}-${d.site.end}`).join(", ");
        programs += 1;
        if (got !== expected) differing.push(`${consumer.name}, ${origin.name}, ${type}: ${got}`);
      }
    // (a known empty list holds no element to misfit)
    const empty = `let xs: ${consumer.misfit} = []\n${consumer.use("xs")}\nexit\n`;
    programs += 1;
    if (analysed(empty).some((d) => "rule" in d && d.rule.rule === consumer.rule))
      differing.push(`${consumer.name}, a known empty list: not quiet`);
  }
  t.diagnostic(`${programs} programs, each in both orders`);
  assert.deepEqual(differing, []);
});

/**
 * `toJson` proves one value's content once per snapshot (the owner's review P1): each call has its own diagnostic at
 * its own argument; a store between calls, a copy, a guard and another value are proved again, so what changed between
 * them is seen.
 */
test("toJson proves an unchanged value once and sees what changed between calls", () => {
  const sites = (source: string): string[] =>
    analysed(source)
      .filter((d) => "rule" in d && d.rule.rule === "json")
      .map((d) => `${d.class} ${source.slice(0, d.site.start).split("\n").length}`);
  const regex = "[1].get(hostValue, default: /a/)";
  // (each call its own warning; the value unchanged between them)
  assert.deepEqual(
    sites(`let root = {f0: ${regex}}\nlet a = toJson(root)\nlet b = toJson(root)\nexit\n`),
    ["warning-runtime-check 2", "warning-runtime-check 3"],
  );
  // (a field stored between them, which decides its type: the earlier call owes the check, the later is the error)
  assert.deepEqual(
    sites(
      `let root = {f0: hostValue}\nlet a = toJson(root)\nroot.f0 = 1..2\nlet b = toJson(root)\nexit\n`,
    ),
    ["warning-runtime-check 2", "compile-error 4"],
  );
  // (a guard below the value around one call, the other plain, in either source order: each call its own class, so
  // its own verdict: the plain call the error, the guarded one the same whichever comes first, alike in all four modes,
  // Codex r4 B1)
  for (const [name, guard] of [
    ["a null test", (body: string) => `if root.f0 != null { ${body} }`],
    ["a type test", (body: string) => `if root.f0 is regex { ${body} }`],
    ["a short-circuit", (body: string) => `if root.f0 != null and true { ${body} }`],
  ] as const) {
    const verdicts = [true, false].map((guardedFirst) => {
      const inside = guard("let a = toJson(root)");
      const plain = "let b = toJson(root)";
      const source = `let root = {f0: /a/}\n${guardedFirst ? `${inside}\n${plain}` : `${plain}\n${inside}`}\nexit\n`;
      const request = coreRequest([{ path: "main.tease", source }]);
      assert.ok(request !== null, source);
      const once = (): string =>
        JSON.stringify(
          checkedResult(analyseCore(request), request)
            .diagnostics.filter((d) => "rule" in d && d.rule.rule === "json")
            .map((d) => `${d.class} ${source.slice(0, d.site.start).split("\n").length}`),
        );
      const modes = MODES.map((mode) => inMode(mode, once));
      assert.equal(new Set(modes).size, 1, `${name}: ${modes.join(" | ")}`);
      const found: string[] = JSON.parse(modes[0]!);
      const [inLine, plainLine] = guardedFirst ? [2, 3] : [3, 2];
      const at = (line: number): string[] =>
        found.filter((entry) => entry.endsWith(` ${line}`)).map((entry) => entry.split(" ")[0]!);
      assert.deepEqual(at(plainLine), ["compile-error"], `${name}: the plain call`);
      return at(inLine);
    });
    assert.deepEqual(verdicts[0], verdicts[1], `${name}: the guarded call in either source order`);
  }
  // (a copy written with a type of its own: its own proof, from its own domain, in either call order and all four modes,
  // Codex r5 B1; a copy of that copy keeps it)
  const fourModes = (source: string): string => {
    const request = coreRequest([{ path: "main.tease", source }]);
    assert.ok(request !== null, source);
    const once = (): string =>
      JSON.stringify(
        checkedResult(analyseCore(request), request)
          .diagnostics.filter((d) => "rule" in d && d.rule.rule === "json")
          .map((d) => `${d.class} ${source.slice(0, d.site.start).split("\n").length}`),
      );
    const modes = MODES.map((mode) => inMode(mode, once));
    assert.equal(new Set(modes).size, 1, `${source}: ${modes.join(" | ")}`);
    return modes[0]!;
  };
  // (the source a read of a binding that copies host data, so a read class of its own, which an alias would share)
  for (const type of ["regex[]", "regex dict", "regex | integer"]) {
    const typed = `let host = hostValue\nlet root = host\nlet copy: ${type} = root\nlet again = copy\n`;
    assert.equal(
      fourModes(`${typed}say toJson(root)\nsay toJson(copy)\nsay toJson(again)\nexit\n`),
      JSON.stringify(["warning-runtime-check 6", "warning-runtime-check 7"]),
      `${type}, the source first`,
    );
    assert.equal(
      fourModes(`${typed}say toJson(again)\nsay toJson(copy)\nsay toJson(root)\nexit\n`),
      JSON.stringify(["warning-runtime-check 5", "warning-runtime-check 6"]),
      `${type}, the copies first`,
    );
  }
  // (a class shared by two aliases, each warning's writers its own read's: the proof is the class's, the items each
  // read's own, in all four modes, Codex r6)
  {
    const source =
      "let root = {f: hostValue otherwise /a/}\nlet a = root\nlet b = a\nsay toJson(a)\nsay toJson(b)\nexit\n";
    const request = coreRequest([{ path: "main.tease", source }]);
    assert.ok(request !== null, source);
    const line = (offset: number): number => source.slice(0, offset).split("\n").length;
    const once = (): string =>
      JSON.stringify(
        coreRecord(checkedResult(analyseCore(request), request), ["main.tease"])
          .diagnostics.filter(
            (d) => d.class === "warning-runtime-check" && line(d.site.offset) >= 4,
          )
          .map((d) => [
            line(d.site.offset),
            (d.provenance?.writers ?? []).map((writer) => line(Number(writer.split(":").at(-1)))),
          ]),
      );
    const modes = MODES.map((mode) => inMode(mode, once));
    assert.deepEqual(
      modes,
      Array(4).fill(
        JSON.stringify([
          [4, [2]],
          [5, [3]],
        ]),
      ),
      "the aliases' writers",
    );
  }
  // (copies of it, unchanged: each call its own warning)
  assert.deepEqual(
    sites(
      `let root = {f0: ${regex}}\nlet c = root\nlet d = c\nlet a = toJson(c)\nlet b = toJson(d)\nexit\n`,
    ),
    ["warning-runtime-check 4", "warning-runtime-check 5"],
  );
  // (a copy changed after it is made, and the original: each its own)
  assert.deepEqual(
    sites(
      `let root = {f0: hostValue}\nlet copy = root\ncopy.f0 = 1..2\nlet a = toJson(root)\nlet b = toJson(copy)\nexit\n`,
    ),
    ["compile-error 5"],
  );
  // (the whole value replaced between them)
  assert.deepEqual(
    sites(
      `let root = {f0: hostValue}\nlet a = toJson(root)\nroot = {f0: 1..2}\nlet b = toJson(root)\nexit\n`,
    ),
    ["warning-runtime-check 2", "compile-error 4"],
  );
});
