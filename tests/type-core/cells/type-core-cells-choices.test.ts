// A choice's options in the cells: C1's site, projections, TSV029's element error, a list of options, the earliest
// ingress.

import assert from "node:assert/strict";
import test from "node:test";
import { withConsumerOrder } from "../../../src/type-inference/core/consumers.js";
import { withSolverSeam } from "../../../src/type-inference/core/solver.js";
import { compactAnalysis, coreRequest } from "../../helpers/type-core-analysis.js";
import { recordDifferences, type CompactRecord } from "../../helpers/type-core-records.js";

/** C1's warning and check for external data stored into a written place, by site (C9). */
test("external data in a choice's options or in a literal is warned at its own expression", () => {
  const sited = (source: string): readonly string[] => {
    const request = coreRequest([{ path: "main.tease", source }]);
    assert.ok(request !== null, source);
    const record = compactAnalysis(request);
    return [
      record.outcome,
      ...record.diagnostics.map((diagnostic) => `${diagnostic.kind}@${diagnostic.site.offset}`),
      // C1's checks; C9's boundary checks are asserted with their cell
      ...record.checks
        .filter((check) => !check.boundary)
        .map((check) => `${check.kind}@${check.site.offset}`),
    ];
  };
  // an external option of a choice, as an external element of a literal
  assert.deepEqual(sited("let chosen: integer = askChoice [hostValue, 2]\nexit"), [
    "warning-runtime-check",
    "written-target@33",
    "copy-type@33",
  ]);
  assert.deepEqual(sited("let chosen: integer = askChoice [2, hostValue]\nexit"), [
    "warning-runtime-check",
    "written-target@36",
    "copy-type@36",
  ]);
  assert.deepEqual(sited("let pool: integer?[] = [hostValue, null, 7]\nexit"), [
    "warning-runtime-check",
    "written-target@24",
    "copy-type@24",
  ]);
  // V30 §19: a choice object gives its `value` (or its `text` without one), so its external value is the site
  assert.deepEqual(
    sited(
      'let chosen: integer = askChoice [{text: "A", value: hostValue}, {text: "B", value: 2}]\nexit',
    ),
    ["warning-runtime-check", "written-target@52", "operator@52", "copy-type@52", "operand@52"],
  );
  assert.deepEqual(sited('let chosen: integer = askChoice {text: "A", value: hostValue}\nexit'), [
    "warning-runtime-check",
    "written-target@51",
    "operator@51",
    "copy-type@51",
    "operand@51",
  ]);
  assert.deepEqual(sited("let chosen: integer = askChoice [{text: hostValue}]\nexit"), [
    "warning-runtime-check",
    "written-target@40",
    "operator@40",
    "copy-type@40",
    "operand@40",
  ]);
  // an external option read through a projection sits at its own expression (Astra B6-r2), in a choice and a literal
  assert.deepEqual(sited("let chosen: integer = askChoice [hostValue.field, 2]\nexit"), [
    "warning-runtime-check",
    "written-target@33",
    "member-read@33",
    "copy-type@33",
    "null-check@33",
  ]);
  assert.deepEqual(sited("let chosen: integer = [hostValue.field, 2][0]\nexit"), [
    "warning-runtime-check",
    "written-target@23",
    "member-read@23",
    "copy-type@23",
    "null-check@23",
  ]);
  // the selected value's site, not the first external expression in the option: a choice object's `value` beside an
  // external `text`, read whole or through a projection, alone or in a list; its `text` without a value
  assert.deepEqual(
    sited("let chosen: integer = askChoice {text: hostValue.label, value: hostValue.field}\nexit"),
    [
      "warning-runtime-check",
      "member-read@39",
      "written-target@63",
      "member-read@63",
      "operator@63",
      "null-check@39",
      "copy-type@63",
      "null-check@63",
      "operand@63",
    ],
  );
  // (an object as a button's value is TSV029's error at the value, and the answer holds no object to read)
  assert.deepEqual(
    sited(
      "let chosen: integer = (askChoice {text: hostValue.label, value: {text: hostValue.field}}).text\nexit",
    ),
    [
      "compile-error",
      "member-read@40",
      "operator@64",
      "member-read@71",
      "null-check@40",
      "null-check@71",
    ],
  );
  assert.deepEqual(
    sited(
      "let chosen: integer = (askChoice [{text: hostValue.label, value: {text: hostValue.field}}]).text\nexit",
    ),
    [
      "compile-error",
      "member-read@41",
      "operator@65",
      "member-read@72",
      "null-check@41",
      "null-check@72",
    ],
  );
  assert.deepEqual(sited("let chosen: integer = askChoice {text: hostValue.label}\nexit"), [
    "warning-runtime-check",
    "written-target@39",
    "member-read@39",
    "operator@39",
    "copy-type@39",
    "null-check@39",
    "operand@39",
  ]);
  // options held in a variable follow the copy reading: the store into the written place; the literal's
  // host element is checked against its whole numbers where it is stored (the owner's F1)
  assert.deepEqual(sited("let opts = [hostValue, 1]\nlet answer: integer = askChoice opts\nexit"), [
    "warning-runtime-check",
    "written-target@12",
    "written-target@48",
    "copy-type@12",
    "copy-type@48",
  ]);
  assert.deepEqual(
    sited("let opts = [hostValue.field, 1]\nlet answer: integer = askChoice opts\nexit"),
    [
      "warning-runtime-check",
      "written-target@12",
      "member-read@12",
      "written-target@54",
      "copy-type@12",
      "null-check@12",
      "copy-type@54",
    ],
  );
});

test("a choice's option reached through index and property projections is selected before its path (Astra B6-r3)", () => {
  // C1's site in both orders: each form follows `let chosen: integer = `, sites zero-based
  const sites = (form: string): string[] => {
    const request = coreRequest([
      { path: "main.tease", source: `let chosen: integer = ${form}\nexit` },
    ]);
    assert.ok(request !== null, form);
    const both = [false, true].map((reversed) => {
      const run = (): CompactRecord =>
        withSolverSeam({ reverseWorklist: reversed }, () => compactAnalysis(request));
      const record = reversed ? withConsumerOrder((list) => [...list].reverse(), run) : run();
      return [
        record.outcome,
        // (C1's, and TSV029's at a button's value that is no choice value)
        ...record.diagnostics
          .filter(
            (diagnostic) => diagnostic.kind === "written-target" || diagnostic.kind === "operator",
          )
          .map((diagnostic) => `${diagnostic.kind}@${diagnostic.site.offset}`),
        ...record.checks
          .filter((check) => check.kind === "copy-type" && !check.boundary)
          .map((check) => `${check.kind}@${check.site.offset}`),
      ];
    });
    assert.deepEqual(both[1], both[0], `${form}: both orders`);
    return both[0]!;
  };
  const at = (offset: number): string[] => [
    "warning-runtime-check",
    `written-target@${offset}`,
    `copy-type@${offset}`,
  ];
  // an option inside an index or a property projection, with and without a projection of the result; an object as the
  // button's value is TSV029's error at the option, and the answer holds no object to read
  const rejected = (offset: number): string[] => ["compile-error", `operator@${offset}`];
  assert.deepEqual(
    sites("(askChoice [{text: hostValue.label, value: {text: hostValue.field}}][0]).text"),
    rejected(33),
  );
  assert.deepEqual(
    sites(
      "(askChoice {option: {text: hostValue.label, value: {text: hostValue.field}}}.option).text",
    ),
    rejected(33),
  );
  assert.deepEqual(
    sites('(askChoice [{text: "A", value: {text: hostValue.field}}][0]).text'),
    rejected(33),
  );
  // (a held choice object's value from outside the script: C13's warning at the option, the sentence review of #1437)
  const held = (offset: number): string[] => [
    "warning-runtime-check",
    "operator@32",
    `written-target@${offset}`,
    `copy-type@${offset}`,
  ];
  assert.deepEqual(sites('askChoice [{text: "A", value: hostValue.field}][0]'), held(52));
  assert.deepEqual(
    sites('askChoice {option: {text: "A", value: hostValue.field}}.option'),
    held(60),
  );
  // a choice as another choice's option (Astra B6-r4), beside its literal analogue; a returned choice object as the
  // outer choice's button itself, never selected again, so a text-only one has no length
  assert.deepEqual(sites("askChoice [(askChoice [hostValue.field, 1]), 2]"), at(45));
  assert.deepEqual(sites("[(askChoice [hostValue.field, 1]), 2][0]"), at(35));
  assert.deepEqual(
    sites(
      '(askChoice [(askChoice {text: "inner", value: {text: hostValue.label, value: {text: hostValue.field}}})]).text',
    ),
    rejected(68),
  );
  assert.deepEqual(
    sites('(askChoice [(askChoice {text: "inner", value: {text: hostValue.label}})]).length'),
    rejected(68),
  );
  // the controls: the literal analogues and the direct choice object
  assert.deepEqual(
    sites("[{text: hostValue.label, value: {text: hostValue.field}}][0].value.text"),
    at(61),
  );
  assert.deepEqual(
    sites("{option: {text: hostValue.label, value: {text: hostValue.field}}}.option.value.text"),
    at(69),
  );
  assert.deepEqual(
    sites("(askChoice {text: hostValue.label, value: {text: hostValue.field}}).text"),
    rejected(64),
  );
});

test("C1's site follows a choice's selection as its value does, over options, wrappers, nesting and paths (Astra B6-r4)", () => {
  // the C1 sites of `let chosen: integer = <expression>`, in both orders: the n-th `hostValue`, the store, or none
  const sites = (expression: string): string[] => {
    const source = `let chosen: integer = ${expression}\nexit`;
    const request = coreRequest([{ path: "main.tease", source }]);
    assert.ok(request !== null, expression);
    const both = [false, true].map((reversed) => {
      const run = (): CompactRecord =>
        withSolverSeam({ reverseWorklist: reversed }, () => compactAnalysis(request));
      const record = reversed ? withConsumerOrder((list) => [...list].reverse(), run) : run();
      // (a record is a multiset: each list in a canonical order)
      const offsets = [
        ...record.diagnostics
          .filter((d) => d.kind === "written-target")
          .map((d) => d.site.offset)
          .sort((a, b) => a - b),
        // (C1's checks: C9's boundary checks are not C1's and stand where external data enters or is read)
        ...record.checks
          .filter((check) => check.kind === "copy-type" && !check.boundary)
          .map((check) => check.site.offset)
          .sort((a, b) => a - b),
      ];
      return offsets.map((offset) =>
        source.startsWith("hostValue", offset)
          ? `hostValue #${source.slice(0, offset).split("hostValue").length - 1}`
          : offset === 22
            ? "the store"
            : `@${offset}`,
      );
    });
    assert.deepEqual(both[1], both[0], `${expression}: both orders`);
    return both[0]!;
  };
  // option kinds, with the step that selects their value (V30 §19)
  const kinds: readonly (readonly [string, string, boolean])[] = [
    ["hostValue", "", true],
    ["hostValue.field", "", true],
    ['{text: "A", value: hostValue.field}', ".value", true],
    ["{text: hostValue.label}", ".text", true],
    ['{text: "A", value: 3}', ".value", false],
  ];
  const wrappers: readonly ((option: string) => string)[] = [
    (option) => option,
    (option) => `[${option}][0]`,
    (option) => `{option: ${option}}.option`,
    (option) => `{option: [${option}]}.option[0]`,
  ];
  // a choice over the wrapped option, and its literal analogue: the same selection written as projections
  const nestings: readonly (readonly [
    (w: string) => string,
    (w: string, select: string) => string,
  ])[] = [
    [(w) => `askChoice [${w}]`, (w, select) => `[${w}][0]${select}`],
    [(w) => `askChoice [(askChoice [${w}])]`, (w, select) => `[[${w}][0]${select}][0]`],
    // (the inner choice's answer is the outer's button itself, never selected again)
    [
      (w) => `askChoice [(askChoice {text: "inner", value: ${w}})]`,
      (w) => `[{text: "inner", value: ${w}}.value][0]`,
    ],
  ];
  const differing: string[] = [];
  let external = 0;
  let rejected = 0;
  for (const [option, select, isExternal] of kinds)
    for (const wrap of wrappers)
      for (const [choice, analogue] of nestings)
        for (const path of ["", ".text", ".length"]) {
          const chosen = `(${choice(wrap(option))})${path}`;
          const literal = `(${analogue(wrap(option), select)})${path}`;
          const expected = sites(literal);
          if (
            isExternal &&
            expected.every((site) => site === "hostValue #0") &&
            expected.length > 0
          )
            external += 1;
          // (a choice object as the inner choice's value is no choice value: TSV029's error, where its analogue's
          // object is read; the answer holds no object)
          if (choice === nestings[2]![0] && option.startsWith("{")) {
            const request = coreRequest([
              { path: "main.tease", source: `let chosen: integer = ${chosen}\nexit` },
            ]);
            const record = compactAnalysis(request!);
            if (
              record.outcome !== "compile-error" ||
              !record.diagnostics.some(
                (diagnostic) =>
                  diagnostic.kind === "operator" && diagnostic.class === "compile-error",
              )
            )
              differing.push(`${chosen}: no TSV029 error`);
            rejected += 1;
            continue;
          }
          const got = sites(chosen);
          if (JSON.stringify(got) !== JSON.stringify(expected))
            differing.push(
              `${chosen}: ${got.join(", ")} (its literal analogue: ${expected.join(", ")})`,
            );
        }
  assert.deepEqual(differing, []);
  assert.equal(rejected, 36);
  // every external option's analogue sites C1 at its own external expression: 4 kinds × 4 wrappers × 3 × 3, less the 20
  // where the third nesting returns a choice object whole: `{text: "A", value: hostValue.field}` at each
  // path and `{text: hostValue.label}` whole and at its length, in each wrapper
  assert.equal(external, 124);
});

/**
 * A choice reads a written list's element as its literal analogue does (the lead's ruling on #1027):
 * a copied record below the list's element step takes its contract (F12), with the read's word and the copy
 * check, in both orders.
 */
/**
 * F12: a written list element's choice object whose value is an object is TSV029's error at the
 * value, and the answer holds no object to read below; its literal analogue reads below the list's element step.
 */
test("a choice's written list element whose value is an object is TSV029's error, and its literal analogue reads below the element step", () => {
  const recordOf = (source: string): CompactRecord => {
    const request = coreRequest([{ path: "main.tease", source }]);
    assert.ok(request !== null, source);
    const [forward, reversed] = [false, true].map((reverse) => {
      const run = (): CompactRecord =>
        withSolverSeam({ reverseWorklist: reverse }, () => compactAnalysis(request));
      return reverse ? withConsumerOrder((list) => [...list].reverse(), run) : run();
    });
    assert.deepEqual(reversed, forward, `${source}: both orders`);
    return forward!;
  };
  for (const store of ["rec.f = 2.5", 'showPermanentButton "b" { rec.f = 2.5 }']) {
    const head = `let rec = {f: 1}\n${store}\nlet n: integer = `;
    const source = `${head}(askChoice [{text: "A", value: rec}]).f\nexit`;
    const choice = recordOf(source);
    assert.deepEqual(
      [
        choice.outcome,
        ...choice.diagnostics.map((d) => `${d.kind} ${d.class} @${d.site.offset}`),
        ...choice.checks.filter((check) => !check.boundary).map((check) => check.kind),
      ],
      ["compile-error", `operator compile-error @${source.indexOf("rec", head.length)}`],
    );
    const analogue = recordOf(`${head}[{text: "A", value: rec}][0].value.f\nexit`);
    assert.deepEqual(
      [
        analogue.outcome,
        ...analogue.diagnostics.map((d) => `${d.kind} ${d.context} @${d.site.offset}`),
      ],
      ["warning-runtime-check", `written-target member @${head.length}`],
    );
  }
});

/**
 * X3 (the lead's ruling on #1026's follow-up): a choice's button value, selected by key past the element step over
 * its options, carries the word `member` as its literal analogue does, written or held, and with options of both keys;
 * a whole option object, no element step, is the control. Kinds, warnings and checks are the analogue's; both orders.
 */
test("a choice over a list of options takes its literal analogue's word", () => {
  const pairs: readonly (readonly [string, string, string])[] = [
    [
      "a written list",
      'let result: integer = askChoice [{text: "A", value: 2}, {text: "B", value: 2.5}]\nexit',
      'let result: integer = [{text: "A", value: 2}, {text: "B", value: 2.5}][0].value\nexit',
    ],
    [
      "a held list",
      'let opts = [{text: "A", value: 2}, {text: "B", value: 2.5}]\nlet result: integer = askChoice opts\nexit',
      'let opts = [{text: "A", value: 2}, {text: "B", value: 2.5}]\nlet result: integer = opts[0].value\nexit',
    ],
    [
      "a whole option object",
      'let result: integer = askChoice {text: "A", value: 2.5}\nexit',
      'let result: integer = {text: "A", value: 2.5}.value\nexit',
    ],
  ];
  // its outcome, then its diagnostics with their words and its checks
  const record = (source: string, reversed: boolean): string[] => {
    const request = coreRequest([{ path: "main.tease", source }]);
    assert.ok(request !== null, source);
    const run = (): CompactRecord =>
      withSolverSeam({ reverseWorklist: reversed }, () => compactAnalysis(request));
    const got = reversed ? withConsumerOrder((list) => [...list].reverse(), run) : run();
    return [
      got.outcome,
      ...got.diagnostics.map((d) => `${d.kind} ${d.class} ${d.context ?? "-"} @${d.site.offset}`),
      ...got.checks.map(
        (check) =>
          `${check.kind} ${check.target} [${check.against.join(", ")}] @${check.site.offset}`,
      ),
    ];
  };
  const differing: string[] = [];
  for (const reversed of [false, true]) {
    for (const [name, choice, analogue] of pairs)
      if (JSON.stringify(record(choice, reversed)) !== JSON.stringify(record(analogue, reversed)))
        differing.push(
          `${name}${reversed ? " reversed" : ""}: ${record(choice, reversed).join("; ")}`,
        );
    // options of both keys have no single analogue: the same word, by the same element step (their texts of one
    // family, ADR 0021 1.4)
    const mixed = record(
      "let result: integer = askChoice [{text: 1, value: 2}, {text: 2.5}]\nexit",
      reversed,
    );
    if (!mixed.includes("written-target warning-runtime-check member @22"))
      differing.push(`options of both keys${reversed ? " reversed" : ""}: ${mixed.join("; ")}`);
  }
  assert.deepEqual(differing, []);
  assert.ok(
    record(pairs[0]![1], false).includes("written-target warning-runtime-check member @22"),
    "the written list's word is member",
  );
});

/**
 * S6-CARRIERS (the design review's D1): stops are ordered by evaluation key, not by the walk's traversal, so in a
 * list of choice objects the first element's selected text precedes the second element's selected value, whichever
 * row reaches each, in both element orders. Each program's whole record, in both orders.
 */
test("a choice list's earliest evaluated ingress names C1's site, in both element orders (S6-CARRIERS, D1)", () => {
  for (const [source, start] of [
    [
      'let out = askChoice [{text: hostValue}, {text: "two", value: hostValue}]\nout = "x"\nexit\n',
      28,
    ],
    [
      'let out = askChoice [{text: "two", value: hostValue}, {text: hostValue}]\nout = "x"\nexit\n',
      42,
    ],
  ] as const) {
    const request = coreRequest([{ path: "main.tease", source }]);
    assert.ok(request !== null, source);
    const site = { file: "main.tease", offset: start, end: start + "hostValue".length };
    // (each button's value from outside the script: C13's warning and its check at it, the sentence review of #1437)
    const buttons = [source.indexOf("hostValue"), source.lastIndexOf("hostValue")].map(
      (offset) => ({ file: "main.tease", offset, end: offset + "hostValue".length }),
    );
    const values = [
      "integer",
      "number",
      "string",
      "boolean",
      "duration",
      "calendarDuration",
      "angle",
      "date",
      "time",
      "datetime",
      "absoluteDateTime",
      "null",
    ];
    const expected: CompactRecord = {
      outcome: "warning-runtime-check",
      diagnostics: [
        { kind: "written-target", class: "warning-runtime-check", site, context: null },
        ...buttons.map((at) => ({
          kind: "operator" as const,
          class: "warning-runtime-check" as const,
          site: at,
          context: null,
        })),
      ],
      checks: [
        { kind: "copy-type", target: "out", against: ["string"], boundary: false, site },
        { kind: "copy-type", target: "out", against: ["string"], boundary: true, site },
        ...buttons.map((at) => ({
          kind: "operand" as const,
          target: "hostValue",
          against: values,
          boundary: false,
          site: at,
        })),
      ],
    };
    const forward = compactAnalysis(request);
    const reversed = withSolverSeam({ reverseWorklist: true }, () =>
      withConsumerOrder(
        (list) => [...list].reverse(),
        () => compactAnalysis(request),
      ),
    );
    assert.deepEqual(recordDifferences(expected, forward), [], source);
    assert.deepEqual(recordDifferences(expected, reversed), [], `${source} reversed`);
  }
});
