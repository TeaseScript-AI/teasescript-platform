// A fix's site: the property it names, its landing and owner, and the work of the walk that finds them.

import assert from "node:assert/strict";
import test from "node:test";
import { compileProject } from "../../../src/compiler.js";
import { analyseCore } from "../../../src/type-inference/core/answers.js";
import { coreCheckResult } from "../../../src/type-inference/core/check-result/check-result.js";
import { SliceIndex } from "../../../src/type-inference/core/check-result/slice-index.js";
import { coreMessage, messageSource } from "../../../src/type-inference/core/messages.js";
import {
  type Given,
  givenBy,
  landingOf,
  ownerOf,
} from "../../../src/type-inference/core/messages/site.js";
import { parse } from "../../../src/parser.js";
import type { SourceSite } from "../../../src/type-inference/graph.js";
import { coreRequest } from "../../helpers/type-core-analysis.js";
import { reported, main, STOPS } from "../../helpers/type-core/type-core-messages-setup.js";

/**
 * #1468 (ADR 0021 rule 1.4, `docs/DIAGNOSTICS.md` "Messages"): where a store types a property below the warned value,
 * the fix names that property, in words with no value of its own (the lead's ruling after Codex r2), and following it
 * removes the warning (Astra r1's A1). Where the checker's definitions prove the value a load with a default, the load
 * as its variable's declaration's value or a copy of a variable whose key holds only that declaration and the keys below
 * it on the way none, the load's default is given the property; else, a write in any spelling, another binding of the
 * name, a selection or a join around the read (Codex r4's N1 to N3, r5's), no property check removes the warning
 * (#1496), so the words say where the type must come from and offer no check. A type with null takes no default that removes it yet (#1470). A value that is the place
 * keeps its own check. Each followed source compiles under both checkers and no longer owes the warning.
 */
test("a store's property below the warned value is the property its fix names, and following it removes the warning (#1468)", () => {
  const load = 'load("prefs", default: {volume: 5})';
  const given = 'load("prefs", default: {volume: 5, caption: 7})';
  // (a test of another property, which says nothing of the stored one: a test of `original.entry` itself proves it a
  // whole number through the copy, so no warning is owed, #1073 PR 2)
  const guarded = (body: string) =>
    `if original.marker is integer {\n${body.replace(/^/gm, "    ").trimEnd()}\n}\nexit\n`;
  const cases: readonly (readonly [
    source: string,
    value: string,
    fix: string,
    followed: string | null,
  ])[] = [
    [
      `let prefs = ${load}\nprefs.caption = 2\nexit\n`,
      load,
      `Give 'caption' a whole number (integer) in the default of '${load}'.`,
      `let prefs = ${given}\nprefs.caption = 2\nexit\n`,
    ],
    [
      'let prefs = load("prefs", default: {inner: {volume: 5}})\nprefs.inner.caption = "on"\nexit\n',
      'load("prefs", default: {inner: {volume: 5}})',
      `Give 'inner.caption' text (string) in the default of 'load("prefs", default: {inner: {volume: 5}})'.`,
      'let prefs = load("prefs", default: {inner: {volume: 5, caption: "off"}})\nprefs.inner.caption = "on"\nexit\n',
    ],
    [
      'let loaded = load("prefs", default: [{volume: 5}])\nloaded[0].caption = 2\nexit\n',
      'load("prefs", default: [{volume: 5}])',
      `Give 'caption' of an element of 'loaded' a whole number (integer) in the default of 'load("prefs", default: [{volume: 5}])'.`,
      'let loaded = load("prefs", default: [{volume: 5, caption: 7}])\nloaded[0].caption = 2\nexit\n',
    ],
    // (Astra r1's copy, its property already checked)
    [
      `let original = load("cfg", default: {marker: 8})\n${guarded('let box = original\nbox.entry = 4\nsay "done"')}`,
      "original",
      `Give 'entry' a whole number (integer) in the default of 'load("cfg", default: {marker: 8})'.`,
      `let original = load("cfg", default: {marker: 8, entry: 7})\n${guarded('let box = original\nbox.entry = 4\nsay "done"')}`,
    ],
    [
      'let loaded = load("prefs", default: [{volume: 5}])\nlet prefs = loaded[0]\nprefs.caption = 2\nexit\n',
      "loaded[0]",
      `Give 'caption' of an element of 'loaded' a whole number (integer) in the default of 'load("prefs", default: [{volume: 5}])'.`,
      'let loaded = load("prefs", default: [{volume: 5, caption: 7}])\nlet prefs = loaded[0]\nprefs.caption = 2\nexit\n',
    ],
    // (a load the checker's definitions do not prove: a list literal, a selection around the read; Codex r4's N1 and
    // r5's, a write by an index, a mutator through a parenthesized receiver and callee; N2, two ways from one load; N3,
    // an object's property named like a selection; another binding of the name, a parameter; a second load of the
    // variable; a load that is not its variable's declaration's value)
    [
      `let prefs = ${load}\nlet items = [{volume: 5}, prefs]\nitems[1].caption = 2\nexit\n`,
      "[{volume: 5}, prefs]",
      "Give 'caption' of an element of 'items' a whole number (integer) where '[{volume: 5}, prefs]' gets its value.",
      null,
    ],
    [
      `let saved = ${load}\nlet prefs = [saved, saved].random\nprefs.caption = 2\nexit\n`,
      "[saved, saved].random",
      "Give 'prefs.caption' a whole number (integer) where '[saved, saved].random' gets its value.",
      null,
    ],
    ...["loaded[0] = hostValue", "(loaded).add(hostValue)", "(loaded.add)(hostValue)"].map(
      (write) =>
        [
          `let loaded = load("prefs", default: [{volume: 5}])\n${write}\nlet items = loaded\nitems[0].caption = 2\nexit\n`,
          "loaded",
          "Give 'caption' of an element of 'items' a whole number (integer) where 'loaded' gets its value.",
          null,
        ] as const,
    ),
    [
      'let loaded = load("prefs", default: {left: {volume: 5}, right: {volume: 5}})\nlet prefs = [loaded.left, loaded.right].random\nprefs.caption = 2\nexit\n',
      "[loaded.left, loaded.right].random",
      "Give 'prefs.caption' a whole number (integer) where '[loaded.left, loaded.right].random' gets its value.",
      null,
    ],
    [
      'let loaded = load("prefs", default: {first: {volume: 5}})\nlet prefs = loaded.first\nprefs.caption = 2\nexit\n',
      "loaded.first",
      "Give 'prefs.caption' a whole number (integer) where 'loaded.first' gets its value.",
      null,
    ],
    [
      `function keep {\n    let prefs = ${load}\n    say "kept"\n}\nkeep()\nfunction use(prefs) {\n    let copy = prefs\n    copy.caption = 2\n}\nuse(hostValue)\nuse({volume: 1})\nexit\n`,
      "prefs",
      "Give 'copy.caption' a whole number (integer) where 'prefs' gets its value.",
      null,
    ],
    [
      `let prefs = ${load}\nprefs = load("other", default: {volume: 5})\nlet copy = prefs\ncopy.caption = 2\nexit\n`,
      "prefs",
      "Give 'copy.caption' a whole number (integer) where 'prefs' gets its value.",
      null,
    ],
    [
      `let prefs = load("saved", default: {volume: 5})\nprefs = ${load}\nprefs.caption = 2\nexit\n`,
      load,
      `Give 'prefs.caption' a whole number (integer) where '${load}' gets its value.`,
      null,
    ],
    // (host data: no property check removes the warning, Astra r1's host and kept lists)
    [
      "let items = [{volume: 5}, hostValue]\nitems[1].caption = 2\nexit\n",
      "hostValue",
      "Give 'caption' of an element of 'items' a whole number (integer) where 'hostValue' gets its value.",
      null,
    ],
    [
      'if hostValue is object and hostValue.entry is integer {\n    let boxes = [{marker: 8}, hostValue]\n    boxes[1].entry = 4\n    say "done"\n}\nexit\n',
      "hostValue",
      "Give 'entry' of an element of 'boxes' a whole number (integer) where 'hostValue' gets its value.",
      null,
    ],
    [
      'let kept = [hostValue]\nif kept[0].entry is integer {\n    let box = kept\n    box[0].entry = 4\n    say "done"\n}\nexit\n',
      "kept",
      "Give 'entry' of an element of 'box' a whole number (integer) where 'kept' gets its value.",
      null,
    ],
    [
      `let prefs = ${load}\nprefs.caption = [null, 2].random\nexit\n`,
      load,
      `Give 'prefs.caption' a whole number (integer) or null where '${load}' gets its value.`,
      null,
    ],
    [
      "let prefs = hostValue otherwise {volume: 5}\nprefs.caption = 2\nexit\n",
      "hostValue",
      "Give 'prefs.caption' a whole number (integer) where 'hostValue' gets its value.",
      null,
    ],
    [
      "let o = {caption: hostValue}\no.caption = 2\nexit\n",
      "hostValue",
      "Check that 'hostValue' is a whole number (integer) first.",
      "if hostValue is integer {\n    let o = {caption: hostValue}\n    o.caption = 2\n}\nexit\n",
    ],
  ];
  const errors = (source: string) =>
    compileProject([{ path: "main.tease", source }], { globals: ["hostValue"] }).diagnostics.filter(
      (diagnostic) => diagnostic.severity === "error",
    );
  for (const [source, value, fix, followed] of cases) {
    const warned = reported(main(source)).filter(
      ({ code, site, message }) =>
        code === "TSV041" && site === value && !/holds (objects|an object)/.test(message),
    );
    assert.equal(warned.length, 1, `${source}: ${JSON.stringify(warned)}`);
    const { message } = warned[0]!;
    assert.ok(message.endsWith(` ${STOPS} ${fix}`), `${source}: ${message}`);
    const place = message.slice(0, message.indexOf(" holds "));
    if (followed === null) {
      assert.ok(!/check/i.test(fix), `${source}: no check is offered`);
      continue;
    }
    assert.deepEqual(errors(followed), [], followed);
    assert.deepEqual(
      reported(main(followed)).filter(
        ({ code, message: other }) => code === "TSV041" && other.startsWith(`${place} holds `),
      ),
      [],
      followed,
    );
  }
});

/**
 * #1495 (#1468's rule for a place an object literal types): where a store's place is a property below the warned value,
 * TSV041's advice names that property in words and where its type must come from, the narrowest expression that owns it
 * (`MessageSource.owner`), never the whole literal; also where a part of the value already fits, and for a value an
 * element selection of a list literal gives (`[a, b].random`) or either operand of `otherwise` (a value the set's
 * collision family gives, where the check named a whole number for an element that holds an object). A value whose
 * place is its own keeps its own check, also where its landing is unknown (`boxes[0].x`, Codex r1 N1 on #1730), and a
 * declared place with no test of what fits keeps its own advice, a separate property, beside the same place's type
 * inferred from a value (the lead's ruling on #1730).
 */
test("TSV041's advice names the property an object literal types and its narrowest owner (#1495)", () => {
  const other = 'let other = fromJson("{\\"volume\\": \\"loud\\"}", default: null)';
  const cases: readonly (readonly [string, string, string, string])[] = [
    [
      `${other}\nlet wrap = {inner: [{volume: 5}, other].random}\nsay "\${wrap.inner.volume}"\nexit\n`,
      "{inner: [{volume: 5}, other].random}",
      "Give 'wrap.inner.volume' a whole number (integer) where '[{volume: 5}, other].random' gets its value.",
      "Check that 'other' is an object first.",
    ],
    [
      'let wrap = {inner: [{volume: 5}, hostValue].random}\nsay "${wrap.inner.volume}"\nexit\n',
      "hostValue",
      "Give 'wrap.inner.volume' a whole number (integer) where 'hostValue' gets its value.",
      "",
    ],
    [
      `${other}\nlet wrap = ({inner: {deep: ([{volume: 5}, other][0])}})\nsay "\${wrap.inner.deep.volume}"\nexit\n`,
      "({inner: {deep: ([{volume: 5}, other][0])}})",
      "Give 'wrap.inner.deep.volume' a whole number (integer) where '[{volume: 5}, other][0]' gets its value.",
      "Check that 'other' is an object first.",
    ],
    [
      "let t: integer = 7\nlet peer = {x: t}\nlet first = [hostValue otherwise {x: 1}, peer]\nexit\n",
      "hostValue",
      "Give 'x' of an element of 'first' a whole number (integer) where 'hostValue' gets its value.",
      "Check that 'hostValue' is an object first.",
    ],
    [
      "let t: integer = 7\nlet peer = {x: t}\nlet first = [{y: hostValue otherwise peer}, {y: peer}]\nexit\n",
      "hostValue",
      "Give 'y.x' of an element of 'first' a whole number (integer) where 'hostValue' gets its value.",
      "Check that 'hostValue' is an object first.",
    ],
    [
      "let t: integer = 7\nlet peer = {x: t}\nlet first = [peer, {x: hostValue otherwise 1}]\nexit\n",
      "hostValue",
      "Check that 'hostValue' is a whole number (integer) first.",
      "",
    ],
    [
      "let t: integer = 1\nlet box = {x: t}\nlet boxes = [box]\nboxes[0].x = hostValue otherwise 1\nexit\n",
      "hostValue",
      "Check 'hostValue' first, as in 'if hostValue is integer { boxes[0].x = hostValue otherwise 1 }'.",
      "",
    ],
    [
      "let typed: list = [1]\nlet root = {f: typed}\nlet holder = [root, hostValue]\nexit\n",
      "hostValue",
      "Use a separate property for a value of another type.",
      "Check that 'hostValue' is an object first.",
    ],
    [
      `${other}\nlet holder = [{f: [1]}, other]\nsay "\${holder[0].f}"\nexit\n`,
      "[{f: [1]}, other]",
      "Give 'f' of an element of 'holder' a list where '[{f: [1]}, other]' gets its value.",
      "",
    ],
  ];
  for (const [source, at, advice, own] of cases) {
    const request = coreRequest([{ path: "main.tease", source }]);
    assert.ok(request !== null, source);
    const { diagnostics } = analyseCore(request);
    const text = messageSource([source], diagnostics);
    const message = (site: string): string =>
      diagnostics
        .filter((d) => d.code === "TSV041" && text.text(d.site) === site)
        .map((d) => coreMessage(d, text))
        .join(" | ");
    assert.ok(message(at).includes(advice), `${at}: ${message(at)}`);
    // (the value whose place is its own keeps its own check)
    const all = diagnostics
      .filter((d) => d.code === "TSV041")
      .map((d) => coreMessage(d, text))
      .join(" | ");
    if (own !== "") assert.ok(all.includes(own), all);
  }
});

/**
 * #1730 Codex r1 B1: a warning's landing and owner (`landingOf`, `ownerOf`) find the value a statement gives and a
 * literal's part by their start, so k warnings, each in its own statement or each an element of one list, read the
 * statements' values and the list's elements O(k log k) times, not once per earlier one (k = 64 to 256, at most ×2.5
 * per doubling; a scan per warning grows by ×4).
 */
test("a warning's landing and owner read the program's values by their start (#1495)", () => {
  // (an array whose every element is read through a counting getter, as the lookups' indexed reads and searches do)
  const counted = <T extends object>(items: readonly T[], count: { reads: number }): T[] => {
    const array: T[] = [...items];
    items.forEach((item, at) =>
      Object.defineProperty(array, at, {
        get: () => {
          count.reads += 1;
          return item;
        },
      }),
    );
    return array;
  };
  const reads = (k: number, list: boolean): number => {
    const source = list
      ? `let holder = [${Array.from({ length: k }, () => "{inner: hostValue}").join(", ")}]\nexit\n`
      : `${Array.from({ length: k }, (_, at) => `let w${at} = {inner: {volume: 5}}\nw${at}.inner = hostValue\n`).join("")}exit\n`;
    const count = { reads: 0 };
    const statements = parse(source).program.statements;
    let given: Given[] = statements.flatMap((statement) => givenBy(statement) ?? []);
    const sites = source
      .split("hostValue")
      .slice(0, -1)
      .map((_, at, parts) => {
        const start = parts.slice(0, at + 1).join("hostValue").length;
        return { file: 0, start, end: start + "hostValue".length };
      });
    assert.equal(sites.length, k);
    if (list) {
      const [holder] = given;
      assert.ok(holder !== undefined && holder.value.kind === "listLiteral");
      given = [
        { ...holder, value: { ...holder.value, elements: counted(holder.value.elements, count) } },
      ];
    } else given = counted(given, count);
    for (const site of sites) {
      assert.notEqual(landingOf(given, site), null);
      ownerOf(given, site, [{ property: "volume" }]);
    }
    return count.reads;
  };
  for (const list of [false, true]) {
    const measured = [64, 128, 256].map((k) => reads(k, list));
    for (let at = 1; at < measured.length; at += 1)
      assert.ok(
        measured[at]! <= 2.5 * measured[at - 1]!,
        `${list ? "elements" : "values"}: ${measured.join(", ")}`,
      );
  }
});

/**
 * #1730, Astra r1 B1: a message's walk to a warned value and an owner's index charge their work, one unit per item a
 * search compares, per expression walked, per property an owner's index holds (made once per literal) and per step it
 * takes; through `coreCheckResult` the units count to the analysis's total as a shared build (`Answers.messageWork`),
 * to no demand, and grow linearly with the warnings (k = 64 to 256, at most ×2.5 per doubling).
 */
test("a message's walk and owner index charge their work, to the analysis and no demand (#1495)", () => {
  const n = 64;
  const properties = Array.from({ length: n }, (_, at) => `p${at}: 1`).join(", ");
  const source = `let wrap = {${properties}, inner: {volume: 5}}\nexit\n`;
  const [given] = parse(source).program.statements.flatMap((statement) => givenBy(statement) ?? []);
  assert.ok(given !== undefined && given.value.kind === "objectLiteral");
  const literal = given.value;
  const whole = { file: 0, start: literal.span.start.offset, end: literal.span.end.offset };
  let units = 0;
  const charge = (more: number): void => {
    units += more;
  };
  const steps = [{ property: "inner" }, { property: "volume" }];
  ownerOf([given], whole, steps, charge);
  // (one value compared, one expression walked, the outer index's n + 1 entries and the inner's one, two steps taken)
  assert.equal(units, 1 + 1 + (n + 1) + 1 + 2);
  units = 0;
  ownerOf([given], whole, steps, charge);
  // (each index made once)
  assert.equal(units, 1 + 1 + 2);
  // (the landing at `5`: one value compared, three expressions walked, the properties each literal's search compares)
  const count = { reads: 0 };
  const read = <T extends object>(items: readonly T[]): T[] => {
    const array: T[] = [...items];
    items.forEach((item, at) =>
      Object.defineProperty(array, at, {
        get: () => {
          count.reads += 1;
          return item;
        },
      }),
    );
    return array;
  };
  const inner = literal.properties.at(-1)!.value;
  assert.ok(inner.kind === "objectLiteral");
  const counted: Given = {
    ...given,
    value: {
      ...literal,
      properties: read([
        ...literal.properties.slice(0, -1),
        { ...literal.properties.at(-1)!, value: { ...inner, properties: read(inner.properties) } },
      ]),
    },
  };
  const five = source.indexOf("volume: 5") + "volume: ".length;
  units = 0;
  assert.notEqual(landingOf([counted], { file: 0, start: five, end: five + 1 }, charge), null);
  assert.equal(units, 1 + 3 + count.reads);
  // (each parenthesis unwrapped is a unit more: d around an owner's two literals, 2d; d around a selection's list, d)
  const charged = (code: string, at: (code: string) => SourceSite, owned: boolean): number => {
    const [entry] = parse(code).program.statements.flatMap((statement) => givenBy(statement) ?? []);
    assert.ok(entry !== undefined, code);
    let spent = 0;
    const add = (more: number): void => {
      spent += more;
    };
    if (owned) ownerOf([entry], at(code), steps, add);
    else assert.notEqual(landingOf([entry], at(code), add), null, code);
    return spent;
  };
  const wrapped = (d: number, text: string): string => `${"(".repeat(d)}${text}${")".repeat(d)}`;
  const value = (code: string): SourceSite => ({
    file: 0,
    start: code.indexOf("= ") + 2,
    end: code.indexOf("\nexit"),
  });
  const element = (code: string): SourceSite => {
    const start = code.indexOf("{volume: 5}");
    return { file: 0, start, end: start + "{volume: 5}".length };
  };
  for (const d of [1, 4, 16]) {
    const owner = (depth: number): string =>
      `let wrap = ${wrapped(depth, `{a: 1, inner: ${wrapped(depth, "{volume: 5}")}}`)}\nexit\n`;
    assert.equal(
      charged(owner(d), value, true) - charged(owner(0), value, true),
      2 * d,
      `owner, ${d}`,
    );
    const selection = (depth: number): string =>
      `let wrap = {inner: ${wrapped(depth, "[{volume: 5}, hostValue]")}[0]}\nexit\n`;
    assert.equal(
      charged(selection(d), element, false) - charged(selection(0), element, false),
      d,
      `selection, ${d}`,
    );
  }
  // (through the compile's consumer: what the messages charge is the analysis's, beside the same compile whose messages
  // charge nothing; a demand's records as they were)
  const compiled = (k: number, charging: boolean) => {
    const program = `${Array.from({ length: k }, (_, at) => `let w${at} = {inner: [{volume: 5}, hostValue].random}\n`).join("")}exit\n`;
    const request = coreRequest([{ path: "main.tease", source: program }])!;
    const answers = analyseCore(request);
    const before = answers.budget;
    // (the records as the analysis left them, copied: the budget's lists are the answers' own, Codex r4 T1 on #1730)
    const [demands, decisions] = [
      structuredClone(before.demands),
      structuredClone(before.decisions),
    ];
    let charged = 0;
    const counts = answers.messageWork.bind(answers);
    answers.messageWork = (more) => {
      charged += more;
      counts(charging ? more : 0);
    };
    const checked = coreCheckResult(
      answers,
      new SliceIndex(request.files.map((file) => file.program)),
      request,
    );
    const owned = checked.diagnostics
      .flat()
      .filter((diagnostic) => diagnostic.message.includes("where 'hostValue' gets its value"));
    assert.equal(owned.length, k, `k = ${k}`);
    assert.deepEqual(answers.budget.demands, demands, `k = ${k}`);
    assert.deepEqual(answers.budget.decisions, decisions, `k = ${k}`);
    return {
      charged,
      total: answers.budget.total,
      indexSteps: answers.budget.counts.get("indexSteps") ?? 0,
    };
  };
  const work = [64, 128, 256].map((k) => {
    const [charging, free] = [compiled(k, true), compiled(k, false)];
    assert.ok(charging.charged >= 2 * k, `k = ${k}: ${charging.charged}`);
    assert.equal(charging.charged, free.charged, `k = ${k}`);
    assert.equal(charging.total - free.total, charging.charged, `k = ${k}`);
    assert.equal(charging.indexSteps - free.indexSteps, charging.charged, `k = ${k}`);
    return charging.charged;
  });
  for (let at = 1; at < work.length; at += 1)
    assert.ok(work[at]! <= 2.5 * work[at - 1]!, work.join(", "));
});

/**
 * #1827: the walk into a dict literal's value and a set literal's element is charged as a list's and an object's is
 * (#1730): one unit per value compared, per entry or element compared and per expression walked.
 */
test("a message's walk into a dict or set literal charges its work (#1827)", () => {
  const units = (source: string): number => {
    const given = parse(source).program.statements.flatMap((statement) => givenBy(statement) ?? []);
    const start = source.lastIndexOf("hostValue");
    let charged = 0;
    const landing = landingOf(
      given,
      { file: 0, start, end: start + "hostValue".length },
      (more) => {
        charged += more;
      },
    );
    assert.ok(landing !== null && landing.steps.length === 1, source);
    return charged;
  };
  // (one of the two values compared, the literal walked, two of its four parts compared, the value walked)
  assert.equal(
    units(
      'let d:integer?[] dict=dict {}\nd=dict {"a":[1], "b":[2], "c":[3], "k":hostValue}\nexit\n',
    ),
    1 + 1 + 2 + 1,
  );
  assert.equal(
    units("let s:integer?[] set=set []\ns=set [[1], [2], [3], hostValue]\nexit\n"),
    1 + 1 + 2 + 1,
  );
});
