import assert from "node:assert/strict";
import test from "node:test";

import { compileSource } from "../src/compiler.js";
import {
  MAX_INTERACTION_AGGREGATE_UTF8_BYTES,
  MAX_INTERACTION_OPTION_ENTRIES,
} from "../src/interaction-limits.js";
import { parse } from "../src/parser.js";
import { validateInstructionPlan } from "../src/plan/validation.js";
import {
  createCheckpoint,
  deserializeCheckpoint,
  serializeCheckpoint,
} from "../src/runtime/checkpoint.js";
import { executeInstruction, run } from "../src/runtime/engine.js";
import { completeAction } from "../src/runtime/operations/complete-action.js";
import {
  createSerializableList,
  createSerializableObject,
} from "../src/runtime/serializable-values.js";
import { createFreshRuntimeSnapshot, validateRuntimeSnapshot } from "../src/runtime/state.js";
import { compileValidPlan } from "./helpers/compile-valid-plan.js";
import { runUntilExit } from "./helpers/run-until-exit.js";

function compiled(source: string, options: Parameters<typeof compileSource>[1] = {}) {
  const plan = compileValidPlan(source, options);
  assert.equal(validateInstructionPlan(plan).valid, true);
  return plan;
}

function completePending(
  plan: ReturnType<typeof compiled>,
  snapshot: ReturnType<typeof createFreshRuntimeSnapshot>,
  interactionKind: "button" | "text" | "number" | "choice",
  payload: unknown,
) {
  const action = snapshot.foregroundAction;
  assert.ok(action !== null && action.kind === "interaction");
  return completeAction(plan, snapshot, {
    actionId: action.actionId,
    actionKind: "interaction",
    interactionKind,
    payload,
  });
}

function snapshotImmediatelyBeforeInteraction(
  plan: ReturnType<typeof compiled>,
  snapshot: ReturnType<typeof createFreshRuntimeSnapshot>,
  capabilities: Parameters<typeof executeInstruction>[2] = {},
) {
  let current = snapshot;
  while (plan.instructions[current.nextInstruction]?.kind !== "interaction") {
    const step = executeInstruction(plan, current, capabilities);
    assert.notEqual(step.snapshot.status, "failed");
    current = step.snapshot;
  }
  return current;
}

function rootBinding(snapshot: ReturnType<typeof createFreshRuntimeSnapshot>, name: string) {
  return snapshot.frames[0]?.bindings.find((binding) => binding.name === name)?.value;
}

test("compact interaction forms preserve immutable command, speaker, button label, choice value, separator, option, and construct spans", () => {
  const source =
    'showButton as mistress "Ready"\nlet result = choose as mistress first: "Mystery",  second: "Again"';
  const parsed = parse(source);
  assert.deepEqual(parsed.diagnostics, []);
  const button = parsed.program.statements[0]!;
  assert.equal(button.kind, "showButtonStatement");
  assert.deepEqual(button.commandSpan, {
    start: { offset: 0, line: 0, column: 0 },
    end: { offset: 10, line: 0, column: 10 },
  });
  assert.deepEqual(button.asSpan, {
    start: { offset: 11, line: 0, column: 11 },
    end: { offset: 13, line: 0, column: 13 },
  });
  assert.deepEqual(button.speaker?.span, {
    start: { offset: 14, line: 0, column: 14 },
    end: { offset: 22, line: 0, column: 22 },
  });
  assert.deepEqual(button.label.span, {
    start: { offset: 23, line: 0, column: 23 },
    end: { offset: 30, line: 0, column: 30 },
  });
  assert.deepEqual(button.span, {
    start: { offset: 0, line: 0, column: 0 },
    end: { offset: 30, line: 0, column: 30 },
  });

  const declaration = parsed.program.statements[1]!;
  assert.equal(declaration.kind, "letStatement");
  assert.equal(declaration.initializer.kind, "interactionExpression");
  const choice = declaration.initializer;
  assert.deepEqual(choice.commandSpan, {
    start: { offset: 44, line: 1, column: 13 },
    end: { offset: 50, line: 1, column: 19 },
  });
  assert.deepEqual(choice.asSpan, {
    start: { offset: 51, line: 1, column: 20 },
    end: { offset: 53, line: 1, column: 22 },
  });
  assert.equal(choice.options.length, 2);
  assert.deepEqual(choice.options[0]!.value?.span, {
    start: { offset: 63, line: 1, column: 32 },
    end: { offset: 68, line: 1, column: 37 },
  });
  assert.deepEqual(choice.options[0]!.colonSpan, {
    start: { offset: 68, line: 1, column: 37 },
    end: { offset: 69, line: 1, column: 38 },
  });
  assert.deepEqual(choice.options[0]!.separatorSpan, {
    start: { offset: 79, line: 1, column: 48 },
    end: { offset: 80, line: 1, column: 49 },
  });
  assert.equal(choice.span.end.offset, source.length);
  assert.equal(Object.isFrozen(choice), true);
  assert.equal(Object.isFrozen(choice.options), true);
  assert.equal(Object.isFrozen(choice.options[0]), true);
});

// Accepted compact forms are enumerated with their spans by the variant matrix below.
test("malformed compact interaction forms recover at the next statement", () => {
  for (const source of [
    "showButton",
    "let x = choose",
    'let x = choose "A",',
    "let x = askText as",
  ]) {
    const result = parse(`${source}\nsay "recovered"`);
    assert.ok(result.diagnostics.length > 0, source);
    assert.equal(result.program.statements.at(-1)?.kind, "sayStatement", source);
  }
});

test("compact choose follows V30 continuation and enclosing-terminator boundaries", () => {
  const commaNewline = parse('let result = choose "A",\n    "B"');
  assert.deepEqual(commaNewline.diagnostics, []);
  const newlineChoice = commaNewline.program.statements[0];
  assert.equal(newlineChoice?.kind, "letStatement");
  assert.equal(newlineChoice?.initializer.kind, "interactionExpression");
  assert.deepEqual(
    newlineChoice?.initializer.options.map((option) => option.expression.kind),
    ["stringLiteral", "stringLiteral"],
  );

  const block = parse('function pick { return choose "A", "B" }\nlet result = pick()');
  assert.deepEqual(block.diagnostics, []);
  assert.deepEqual(
    block.program.statements.map((statement) => statement.kind),
    ["functionDeclaration", "letStatement"],
  );

  const grouped = parse('let result = (choose "A", "B")');
  assert.deepEqual(grouped.diagnostics, []);
  const groupedInitializer = grouped.program.statements[0];
  assert.equal(groupedInitializer?.kind, "letStatement");
  assert.equal(groupedInitializer?.initializer.kind, "parenthesizedExpression");
  assert.equal(groupedInitializer?.initializer.expression.kind, "interactionExpression");

  const list = parse('let choices = [choose "A", "B"]');
  assert.deepEqual(list.diagnostics, []);
  const listInitializer = list.program.statements[0];
  assert.equal(listInitializer?.kind, "letStatement");
  assert.equal(listInitializer?.initializer.kind, "listLiteral");
  assert.equal(listInitializer?.initializer.elements[0]?.kind, "interactionExpression");

  const interpolation = parse(`let message = "Selected: \${choose "A", "B"}"`);
  assert.deepEqual(interpolation.diagnostics, []);
  const messageInitializer = interpolation.program.statements[0];
  assert.equal(messageInitializer?.kind, "letStatement");
  assert.equal(messageInitializer?.initializer.kind, "stringLiteral");
  assert.equal(messageInitializer?.initializer.parts[1]?.kind, "stringInterpolation");
  assert.equal(messageInitializer?.initializer.parts[1]?.expression.kind, "interactionExpression");
});

test("compact choose reports a missing continued option and recovers at the following statement", () => {
  const parsed = parse('let result = choose "A",\n\nsay "recovered"');
  assert.deepEqual(
    parsed.diagnostics.map((diagnostic) => diagnostic.code),
    ["TSP030"],
  );
  assert.deepEqual(
    parsed.program.statements.map((statement) => statement.kind),
    ["letStatement", "sayStatement"],
  );
});

test("compact choice keys continue across a newline after ':'", () => {
  const options = (source: string) => {
    const parsed = parse(source);
    assert.deepEqual(parsed.diagnostics, []);
    const statement = parsed.program.statements[0];
    assert.equal(statement?.kind, "letStatement");
    assert.equal(statement?.initializer.kind, "interactionExpression");
    return statement?.initializer.options.map((option) => [
      option.value?.kind === "identifier" ? option.value.name : null,
      option.expression.kind === "stringLiteral" &&
      option.expression.parts[0]?.kind === "stringText"
        ? option.expression.parts[0].value
        : null,
    ]);
  };
  const singleLine = options('let r = choose coast: "Stay", b: "B"');
  assert.deepEqual(singleLine, [
    ["coast", "Stay"],
    ["b", "B"],
  ]);
  assert.deepEqual(options('let r = choose coast:\n    "Stay", b: "B"'), singleLine);
  assert.deepEqual(
    options('let r = choose coast:\n\n    // why\n    "Stay", b:\n    "B"'),
    singleLine,
  );
});

test("nested compact choices report missing options once per affected invocation", () => {
  const insertionDiagnostics = (source: string) =>
    parse(source).diagnostics.map((diagnostic) => [
      diagnostic.code,
      diagnostic.span.start.offset,
      diagnostic.span.end.offset,
    ]);

  // The inner invocation reports its missing option at the token that ends it.
  const nestedOnly = "let result = choose [choose]";
  const closing = nestedOnly.indexOf("]");
  assert.deepEqual(insertionDiagnostics(nestedOnly), [["TSP030", closing, closing]]);

  // The inner invocation ends at the separator; the outer one then misses its next option at the end.
  const nestedAndOuter = "let result = choose choose,";
  const separator = nestedAndOuter.indexOf(",");
  assert.deepEqual(insertionDiagnostics(nestedAndOuter), [
    ["TSP030", separator, separator],
    ["TSP030", nestedAndOuter.length, nestedAndOuter.length],
  ]);

  const continued = parse('let result = choose first: choose "A",\nsay "recovered"');
  assert.deepEqual(
    continued.diagnostics.map((diagnostic) => diagnostic.code),
    ["TSP030"],
  );
  assert.deepEqual(
    continued.program.statements.map((statement) => statement.kind),
    ["letStatement", "sayStatement"],
  );
});

// V30 accepts parenthesized `showButton` and `choose` forms (accepted-syntaxes-v30.md sections 20-21), and ADR 0018
// leaves their mapping to later work. The spelling must not be parsed as a compact form whose payload is the
// parenthesized text, grouped or unwrapped, which would silently decide that mapping. The basic asks have their own
// parenthesized form (tests/parenthesized-asks.test.ts).
test("a parenthesized button or choice spelling is never silently given compact semantics", () => {
  // The statement and expression commands each have one parenthesis check before and after `as speaker`.
  for (const source of [
    'showButton("Continue")',
    'showButton as mistress ("Continue")',
    'let answer = choose("Yes", "No")',
    'let answer = choose as mistress ("Yes", "No")',
  ]) {
    const parsed = parse(`${source}\nsay "recovered"`);
    const opening = source.indexOf("(");
    const payloadEnd = source.lastIndexOf(")") + 1;
    const compactPayloads = parsed.program.statements.flatMap((statement) => {
      if (statement.kind === "showButtonStatement") return [statement.label];
      if (
        statement.kind === "letStatement" &&
        statement.initializer.kind === "interactionExpression"
      )
        return statement.initializer.options.map((option) => option.expression);
      return [];
    });
    assert.equal(
      compactPayloads.some(
        (payload) =>
          payload !== undefined &&
          payload !== null &&
          payload.span.start.offset >= opening &&
          payload.span.end.offset <= payloadEnd,
      ),
      false,
      source,
    );
    assert.equal(parsed.program.statements.at(-1)?.kind, "sayStatement", source);
  }

  // The comma after the button text is reserved for `background:`; another trailing argument is
  // diagnosed at the separator rather than dropped.
  const extra = 'showButton "Continue", "Extra"';
  const parsed = parse(`${extra}\nsay "recovered"`);
  const comma = extra.indexOf(",");
  const diagnostic = parsed.diagnostics[0];
  assert.deepEqual(
    diagnostic === undefined
      ? null
      : [diagnostic.code, diagnostic.span.start.offset, diagnostic.span.end.offset],
    ["TSP032", comma, comma + 1],
  );
  assert.equal(parsed.program.statements.at(-1)?.kind, "sayStatement");
});

test("misplaced interaction speaker clauses receive the focused compact-form diagnostic", () => {
  for (const source of [
    'showButton "Continue" as mistress',
    'let answer = askText "Type here" as mistress',
    'let amount = askNumber "Enter a number" as mistress',
    'let result = choose "A" as mistress, "B"',
  ]) {
    const parsed = parse(`${source}\nsay "recovered"`);
    const diagnostic = parsed.diagnostics[0];
    const asOffset = source.indexOf(" as ") + 1;
    assert.equal(diagnostic?.code, "TSP032", source);
    assert.deepEqual(
      diagnostic === undefined ? null : [diagnostic.span.start.offset, diagnostic.span.end.offset],
      [asOffset, asOffset + 2],
      source,
    );
    assert.equal(parsed.program.statements.at(-1)?.kind, "sayStatement", source);
  }
});

test("every accepted compact interaction variant carries exact command and construct spans", () => {
  const expressions = [
    "askText",
    'askText "Type here"',
    "askText as mistress",
    'askText as mistress "Type here"',
    "askNumber",
    'askNumber "Enter a number"',
    "askNumber as mistress",
    'askNumber as mistress "Enter a number"',
    'choose "Bratty", "Very submissive"',
    'choose as mistress "Bratty", "Very submissive"',
    'choose bratty: "Bratty", submissive: "Very submissive"',
    'choose as mistress first: "Mystery", second: "Mystery"',
    'choose 1: "Open the door", 2: "Walk away"',
  ];
  for (const expressionSource of expressions) {
    const source = `let result = ${expressionSource}`;
    const parsed = parse(source);
    assert.deepEqual(parsed.diagnostics, [], expressionSource);
    const declaration = parsed.program.statements[0]!;
    assert.equal(declaration.kind, "letStatement");
    assert.equal(declaration.initializer.kind, "interactionExpression");
    const interaction = declaration.initializer;
    const command = expressionSource.startsWith("askText")
      ? "askText"
      : expressionSource.startsWith("askNumber")
        ? "askNumber"
        : "choose";
    const commandStart = source.indexOf(command);
    assert.deepEqual(interaction.commandSpan, {
      start: { offset: commandStart, line: 0, column: commandStart },
      end: {
        offset: commandStart + command.length,
        line: 0,
        column: commandStart + command.length,
      },
    });
    assert.equal(interaction.span.start.offset, commandStart);
    assert.equal(interaction.span.end.offset, source.length);
    const asStart = source.indexOf(" as ");
    assert.equal(interaction.asSpan?.start.offset ?? -1, asStart < 0 ? -1 : asStart + 1);
    assert.equal(interaction.speaker?.span.start.offset ?? -1, asStart < 0 ? -1 : asStart + 4);
    for (const option of interaction.options) {
      assert.ok(option.span.start.offset >= interaction.commandSpan.end.offset);
      assert.ok(option.span.end.offset <= interaction.span.end.offset);
      if (option.value === null) assert.equal(option.colonSpan, null);
      else assert.notEqual(option.colonSpan, null);
    }
  }

  for (const source of ['showButton "Continue"', 'showButton as mistress "Ready"']) {
    const parsed = parse(source);
    assert.deepEqual(parsed.diagnostics, []);
    const button = parsed.program.statements[0]!;
    assert.equal(button.kind, "showButtonStatement");
    assert.deepEqual(button.commandSpan, {
      start: { offset: 0, line: 0, column: 0 },
      end: { offset: 10, line: 0, column: 10 },
    });
    assert.equal(button.span.start.offset, 0);
    assert.equal(button.span.end.offset, source.length);
  }
});

test("compact choices diagnose a missing separator at the next option and recover", () => {
  const cases = [
    { source: 'let result = choose "One" "Two"', span: [26, 27] },
    { source: 'let result = choose first: "One" second: "Two"', span: [33, 39] },
  ];
  for (const scenario of cases) {
    const parsed = parse(`${scenario.source}\nsay "recovered"`);
    assert.deepEqual(
      parsed.diagnostics.map((diagnostic) => diagnostic.code),
      ["TSP031"],
    );
    assert.deepEqual(
      [parsed.diagnostics[0]!.span.start.offset, parsed.diagnostics[0]!.span.end.offset],
      scenario.span,
    );
    assert.equal(parsed.program.statements.at(-1)?.kind, "sayStatement");
  }
});

test("selected prelude names are protected in declarations and host configuration", () => {
  for (const name of ["showButton", "askText", "askNumber", "choose"]) {
    const sources = [
      `let ${name} = 1`,
      `speaker ${name} {}`,
      `function ${name} { return }`,
      `function sample(${name}) { return }`,
      `function sample { let ${name} = 1\nreturn }`,
    ];
    for (const source of sources) {
      assert.ok(
        compileSource(source).diagnostics.some((diagnostic) => diagnostic.code === "TSV001"),
        `${name}: ${source}`,
      );
    }
    assert.ok(
      compileSource('say "ok"', { globals: [name] }).diagnostics.some(
        (diagnostic) => diagnostic.code === "TSV001",
      ),
      `${name}: global`,
    );
    assert.ok(
      compileSource('say "ok"', { builtins: [name] }).diagnostics.some(
        (diagnostic) => diagnostic.code === "TSV001",
      ),
      `${name}: builtin`,
    );
  }
});

test("interaction speaker references use the existing precise unknown-speaker diagnostic", () => {
  for (const source of [
    'showButton as missing "Continue"',
    "let answer = askText as missing",
    "let amount = askNumber as missing",
    'let result = choose as missing "A", "B"',
  ]) {
    const result = compileSource(source);
    assert.equal(result.plan, null);
    const missing = source.indexOf("missing");
    assert.deepEqual(
      result.semanticDiagnostics.map((diagnostic) => [
        diagnostic.code,
        diagnostic.span.start.offset,
        diagnostic.span.end.offset,
      ]),
      [["TSV005", missing, missing + "missing".length]],
      source,
    );
  }
});

test("mixed written-value kinds need a union-typed place, while values and text may repeat", () => {
  // `at` is the last source occurrence the diagnostic must span: the whole choice for mixed value kinds and the
  // literal for a non-finite value. Text and number values together are kept only by a declared union (#511 C2).
  const rejected = [
    {
      source: 'let x = choose first: "A", 2: "B"\nexit',
      code: "TSV044",
      at: 'choose first: "A", 2: "B"',
    },
    { source: 'let x = choose 1e999: "A"', code: "TSC001", at: "1e999" },
  ];
  for (const { source, code, at } of rejected) {
    const result = compileSource(source);
    assert.equal(result.plan, null, source);
    const start = source.lastIndexOf(at);
    assert.deepEqual(
      result.diagnostics.map((diagnostic) => [
        diagnostic.code,
        diagnostic.span.start.offset,
        diagnostic.span.end.offset,
      ]),
      [[code, start, start + at.length]],
      source,
    );
  }
  for (const accepted of [
    'let x: string | integer = choose first: "A", 2: "B"\nexit',
    'let x = choose first: "Same", second: "Same"\nexit',
    'let x = choose back: "Back", "Spanking", [{ text: "Lines" }, { text: "Corner", value: "corner" }]\nexit',
    'let x = choose first: "A", first: "B"\nexit',
    'let x = choose 1: "A", 1.0: "B"\nexit',
    'let x = choose "Same", "Same"\nexit',
    'let x = choose back: "Return", "back"\nexit',
    'let x = choose "A", ["B", "A"]\nexit',
    "let x = choose 1 min, 60 s\nexit",
  ])
    assert.deepEqual(compileSource(accepted).diagnostics, [], accepted);
});

test("static choice text aligns with direct and prepared interaction UI", () => {
  const staticPlan = compiled(
    'let result = choose "sum ${1 + 2}", "${-0}", "${true}", "${null}"\nexit',
  );
  const staticPending = run(staticPlan, createFreshRuntimeSnapshot(staticPlan));
  assert.deepEqual(
    staticPending.snapshot.foregroundAction?.kind === "interaction"
      ? staticPending.snapshot.foregroundAction.ui
      : null,
    {
      kind: "choice",
      options: [
        { text: "sum 3", value: "sum 3" },
        { text: "0", value: "0" },
        { text: "true", value: "true" },
        { text: "null", value: "null" },
      ],
      accessibleName: { kind: "localizedDefault", key: "chooseOption" },
    },
  );

  const dynamicPlan = compiled('let value = 3\nlet result = choose "sum ${value}", "other"\nexit');
  const dynamicPending = run(dynamicPlan, createFreshRuntimeSnapshot(dynamicPlan));
  assert.deepEqual(
    dynamicPending.snapshot.foregroundAction?.kind === "interaction"
      ? dynamicPending.snapshot.foregroundAction.ui
      : null,
    {
      kind: "choice",
      options: [
        { text: "sum 3", value: "sum 3" },
        { text: "other", value: "other" },
      ],
      accessibleName: { kind: "localizedDefault", key: "chooseOption" },
    },
  );
});

test("interaction result domains participate in existing numeric semantic checks", () => {
  assert.notEqual(compileSource("let values = askNumber..3\nexit").plan, null);

  const textRange = compileSource("let values = askText..3");
  assert.equal(textRange.plan, null);
  assert.ok(textRange.semanticDiagnostics.some((diagnostic) => diagnostic.code === "TSV010"));

  // A choice returns each button's value; an option without a written value returns itself.
  assert.notEqual(compileSource("let values = (choose 1, 2)..3\nexit").plan, null);
  assert.notEqual(compileSource("let values = (choose [1, 2])..3\nexit").plan, null);
  assert.notEqual(compileSource("let values = (choose { text: 1 })..3\nexit").plan, null);
  for (const source of [
    'let values = (choose "a", b: "B")..3\nexit',
    'let values = (choose { text: "A" })..3\nexit',
    'let values = (choose [{ text: "A" }, { text: 1, value: "b" }])..3\nexit',
  ]) {
    // The type check knows what a choice returns, so it reports the text range bound.
    const textChoice = compileSource(source);
    assert.equal(textChoice.plan, null, source);
    assert.ok(
      textChoice.semanticDiagnostics.some((diagnostic) => diagnostic.code === "TSV043"),
      source,
    );
  }
});

test("prepared-plan validation rejects malformed prepared interaction shapes", () => {
  const plan = structuredClone(compiled("showButton payload\nexit", { globals: ["payload"] }));
  const interaction = plan.instructions.find((instruction) => instruction.kind === "interaction");
  assert.ok(
    interaction?.kind === "interaction" &&
      "preparedUi" in interaction &&
      interaction.preparedUi.kind === "button",
  );
  // EVIDENCE: fixture mutates only the prepared button-label temporary to an out-of-range ID.
  (interaction.preparedUi as { buttonLabelTemporary: number }).buttonLabelTemporary =
    plan.temporaryCount + 1;
  assert.equal(validateInstructionPlan(plan).valid, false);

  const aliased = structuredClone(
    compiled("let answer = askText hint\nexit", { globals: ["hint"] }),
  );
  const aliasedInteraction = aliased.instructions.find(
    (instruction) => instruction.kind === "interaction",
  );
  assert.ok(
    aliasedInteraction?.kind === "interaction" &&
      "preparedUi" in aliasedInteraction &&
      aliasedInteraction.preparedUi.kind === "text",
  );
  // EVIDENCE: fixture aliases the prepared text hint and speaker temporaries for plan rejection.
  (aliasedInteraction.preparedUi as { hintTemporary: number | null }).hintTemporary =
    aliasedInteraction.speakerTemporary;
  assert.equal(validateInstructionPlan(aliased).valid, false);
});

test("authored payloads evaluate once in source order before pending state", () => {
  const plan = compiled("let result = choose nextText(), nextText()\nexit", {
    builtins: ["nextText"],
  });
  const calls: string[] = [];
  const pending = run(plan, createFreshRuntimeSnapshot(plan), {
    builtins: {
      nextText: () => {
        const value = calls.length === 0 ? "First" : "Second";
        calls.push(value);
        return value;
      },
    },
  });
  assert.deepEqual(calls, ["First", "Second"]);
  assert.equal(pending.snapshot.status, "waiting");
  assert.deepEqual(
    pending.snapshot.foregroundAction?.kind === "interaction"
      ? pending.snapshot.foregroundAction.ui
      : null,
    {
      kind: "choice",
      options: [
        { text: "First", value: "First" },
        { text: "Second", value: "Second" },
      ],
      accessibleName: { kind: "localizedDefault", key: "chooseOption" },
    },
  );
  const completed = completePending(plan, pending.snapshot, "choice", {
    kind: "selectedOption",
    optionIndex: 1,
  });
  assert.equal(completed.outcome.kind, "completed");
  assert.deepEqual(calls, ["First", "Second"]);
});

test("a list in a text field is a compile error when the compiler can see it", () => {
  // `at` is the last source occurrence the diagnostic must span.
  const cases = [
    ['let labels = ["Go"]\nshowButton labels\nexit', "a button label", "labels"],
    ['let hints = ["Name?"]\nlet answer = askText hints\nexit', "an input hint", "hints"],
    ['showButton ["Go", "Run"]\nexit', "a button label", '["Go", "Run"]'],
    ['let answer = askText ["Name?"]\nexit', "an input hint", '["Name?"]'],
    ['let answer = askNumber ["Count?"]\nexit', "an input hint", '["Count?"]'],
    ['let answer = choose first: { text: ["A"] }\nexit', "the text of a choice option", '["A"]'],
    ['timer(duration: 1, label: ["Beat"])\nexit', "a timer label", '["Beat"]'],
    ['speaker coach { title: ["Coach"] }\nexit', "the speaker's title", '["Coach"]'],
    [
      'speaker coach {}\ncoach.displayName = ["Coach"]\nexit',
      "the speaker's displayName",
      '["Coach"]',
    ],
  ] as const;
  for (const [source, field, at] of cases) {
    const result = compileSource(source);
    const start = source.lastIndexOf(at);
    assert.equal(result.plan, null, source);
    assert.deepEqual(
      result.diagnostics.map((diagnostic) => [
        diagnostic.code,
        diagnostic.message,
        diagnostic.span.start.offset,
        diagnostic.span.end.offset,
      ]),
      [
        [
          "TSV040",
          `A list cannot be ${field}. Select one element with "\${list}" or list.random.`,
          start,
          start + at.length,
        ],
      ],
      source,
    );
  }
});

test("a text field rejects other values it cannot show when the compiler can see them", () => {
  const cases = [
    ["showButton { bad: 1 }\nexit", "A button label cannot be an object.", "{ bad: 1 }"],
    ["showButton 1..2\nexit", "A button label cannot be a range.", "1..2"],
    ["let answer = askText set[1]\nexit", "An input hint cannot be a set (integer set).", "set[1]"],
  ] as const;
  for (const [source, message, at] of cases) {
    const result = compileSource(source);
    assert.equal(result.plan, null, source);
    const start = source.lastIndexOf(at);
    assert.deepEqual(
      result.diagnostics.map((diagnostic) => [
        diagnostic.code,
        diagnostic.message,
        diagnostic.span.start.offset,
        diagnostic.span.end.offset,
      ]),
      [["TSV042", message, start, start + at.length]],
      source,
    );
  }
});

test("dynamic interaction UI converts scalars once and selects from a list only through interpolation", () => {
  const numberPlan = compiled("showButton 12.5\nexit");
  const numberPending = run(numberPlan, createFreshRuntimeSnapshot(numberPlan));
  assert.equal(
    numberPending.snapshot.foregroundAction?.kind === "interaction" &&
      numberPending.snapshot.foregroundAction.ui.kind === "button"
      ? numberPending.snapshot.foregroundAction.ui.buttonLabel
      : null,
    "12.5",
  );

  const listPlan = compiled(
    'function dynamic(value) {\n  return value\n}\nlet left = [dynamic("left"), 2]\nlet right = [dynamic("right"), 3]\nlet result = choose "${left}", "${right}"\nexit',
  );
  const randomValues = [0.75, 0.75];
  let randomCalls = 0;
  const listPending = run(listPlan, createFreshRuntimeSnapshot(listPlan), {
    random: {
      next: () => {
        const value = randomValues[randomCalls]!;
        randomCalls += 1;
        return value;
      },
    },
  });
  assert.equal(randomCalls, 2);
  assert.deepEqual(
    listPending.snapshot.foregroundAction?.kind === "interaction"
      ? listPending.snapshot.foregroundAction.ui
      : null,
    {
      kind: "choice",
      options: [
        { text: "2", value: "2" },
        { text: "3", value: "3" },
      ],
      accessibleName: { kind: "localizedDefault", key: "chooseOption" },
    },
  );
  assert.equal(validateRuntimeSnapshot(listPending.snapshot, listPlan).valid, true);

  const seededFirst = run(listPlan, createFreshRuntimeSnapshot(listPlan, { seed: 1591436852 }));
  const seededSecond = run(listPlan, createFreshRuntimeSnapshot(listPlan, { seed: 1591436852 }));
  assert.deepEqual(seededFirst.snapshot.foregroundAction, seededSecond.snapshot.foregroundAction);
  assert.deepEqual(seededFirst.snapshot.rng, seededSecond.snapshot.rng);

  // Lists the compiler cannot see fail before the action opens and without drawing from the RNG.
  for (const source of [
    "showButton labels\nexit",
    "let answer = askText labels\nexit",
    "let answer = choose { text: labels }\nexit",
  ]) {
    const plan = compiled(source, { globals: ["labels"] });
    const fresh = createFreshRuntimeSnapshot(plan, {
      globals: { labels: createSerializableList(["a", "b"]) },
    });
    let calls = 0;
    const rejected = run(plan, fresh, {
      random: {
        next: () => {
          calls += 1;
          return 0;
        },
      },
    });
    assert.equal(calls, 0, source);
    assert.equal(rejected.snapshot.failure?.code, "TSR021", source);
    assert.equal(rejected.snapshot.foregroundAction, null, source);
    assert.equal(rejected.snapshot.nextActionId, fresh.nextActionId, source);
  }
});

test("static compact interactions compile long mixed unary numeric labels without native recursion", () => {
  const source = `showButton ${"-+".repeat(12_000)}-1\nexit`;
  const result = compileSource(source);
  assert.deepEqual(result.diagnostics, []);
  assert.ok(result.plan !== null);
  assert.equal(validateInstructionPlan(result.plan).valid, true);
  const pending = run(result.plan, createFreshRuntimeSnapshot(result.plan));
  const action = pending.snapshot.foregroundAction;
  assert.ok(action?.kind === "interaction" && action.ui.kind === "button");
  assert.equal(action.ui.buttonLabel, "-1");
});

test("dynamic interaction UI commits prepared text and serialized RNG only after full validation", () => {
  const cases = [
    {
      name: "a nested list in a list option",
      plan: compiled('let result = choose "first", options\nexit', { globals: ["options"] }),
      globals: { options: createSerializableList(["a", createSerializableList(["b"])]) },
      code: "TSR052",
    },
    {
      name: "an aggregate overflow across options",
      plan: compiled("let result = choose first, second\nexit", { globals: ["first", "second"] }),
      globals: {
        first: "a".repeat(MAX_INTERACTION_AGGREGATE_UTF8_BYTES / 2),
        second: "b".repeat(MAX_INTERACTION_AGGREGATE_UTF8_BYTES / 2 + 1),
      },
      code: "TSR052",
    },
    {
      name: "only empty option lists",
      plan: compiled("let result = choose first, second\nexit", { globals: ["first", "second"] }),
      globals: { first: createSerializableList([]), second: createSerializableList([]) },
      code: "TSR052",
    },
    {
      name: "an oversized scalar button label",
      plan: compiled("showButton payload\nexit", { globals: ["payload"] }),
      globals: { payload: "x".repeat(MAX_INTERACTION_AGGREGATE_UTF8_BYTES + 1) },
      code: "TSR052",
    },
    {
      name: "a list element with its own value under a written value",
      plan: compiled('let result = choose "first", key: second\nexit', { globals: ["second"] }),
      globals: {
        second: createSerializableList([
          createSerializableObject([
            { name: "text", value: "second" },
            { name: "value", value: "own" },
          ]),
        ]),
      },
      code: "TSR052",
    },
    {
      name: "a list as the text of a choice object",
      plan: compiled('let result = choose "first", second\nexit', { globals: ["second"] }),
      globals: {
        second: createSerializableObject([
          { name: "text", value: createSerializableList(["second"]) },
        ]),
      },
      code: "TSR021",
    },
  ] as const;
  for (const scenario of cases) {
    const before = snapshotImmediatelyBeforeInteraction(
      scenario.plan,
      createFreshRuntimeSnapshot(scenario.plan, { globals: scenario.globals, seed: 1591436852 }),
    );
    const temporaries = structuredClone(before.temporaries);
    const rng = structuredClone(before.rng);
    const nextActionId = before.nextActionId;
    const nextEventSequence = before.nextEventSequence;
    const failed = executeInstruction(scenario.plan, before);
    assert.equal(failed.snapshot.failure?.code, scenario.code, scenario.name);
    assert.equal(failed.snapshot.foregroundAction, null, scenario.name);
    assert.equal(failed.snapshot.nextActionId, nextActionId, scenario.name);
    // The existing structured failure event consumes its one sequence; no
    // interaction request or transcript sequence is allocated.
    assert.equal(failed.snapshot.nextEventSequence, nextEventSequence + 1, scenario.name);
    assert.deepEqual(failed.snapshot.temporaries, temporaries, scenario.name);
    assert.deepEqual(failed.snapshot.rng, rng, scenario.name);
    assert.equal(failed.snapshot.lastSettlement, null, scenario.name);
    assert.equal(failed.snapshot.nextInstruction, before.nextInstruction, scenario.name);
    assert.deepEqual(
      failed.events.map((event) => event.kind),
      ["runtimeFailure"],
      scenario.name,
    );
  }
});

test("an interpolated list selection is fixed before checkpoint restore and is never reevaluated", () => {
  const plan = compiled('showButton "${values()}"\nexit', { builtins: ["values"] });
  let calls = 0;
  const pending = run(plan, createFreshRuntimeSnapshot(plan, { seed: 1364229357 }), {
    builtins: {
      values: () => {
        calls += 1;
        return createSerializableList(["left", 2]);
      },
    },
  });
  assert.equal(calls, 1);
  const label =
    pending.snapshot.foregroundAction?.kind === "interaction" &&
    pending.snapshot.foregroundAction.ui.kind === "button"
      ? pending.snapshot.foregroundAction.ui.buttonLabel
      : null;
  const savedRng = pending.snapshot.rng;
  const restored = deserializeCheckpoint(
    serializeCheckpoint(createCheckpoint(plan, pending.snapshot)),
  );
  const resumed = run(restored.plan, restored.snapshot, {
    builtins: {
      values: () => {
        calls += 1;
        return createSerializableList(["wrong"]);
      },
    },
  });
  assert.equal(calls, 1);
  assert.equal(
    resumed.snapshot.foregroundAction?.kind === "interaction" &&
      resumed.snapshot.foregroundAction.ui.kind === "button"
      ? resumed.snapshot.foregroundAction.ui.buttonLabel
      : null,
    label,
  );
  assert.deepEqual(resumed.snapshot.rng, savedRng);

  const uninterrupted = run(
    plan,
    completePending(plan, pending.snapshot, "button", { kind: "activate" }).snapshot,
  );
  const restoredCompleted = run(
    restored.plan,
    completePending(restored.plan, restored.snapshot, "button", { kind: "activate" }).snapshot,
  );
  assert.deepEqual(restoredCompleted.snapshot, uninterrupted.snapshot);
  assert.deepEqual(restoredCompleted.events, uninterrupted.events);
});

test("static compact interactions use the default speaker at the instruction boundary", () => {
  const plan = compiled(
    [
      "speaker first {}",
      "speaker second {}",
      "speaker first",
      'say as second "Context"',
      'showButton "Continue"',
      "exit",
    ].join("\n"),
  );
  const pending = run(plan, createFreshRuntimeSnapshot(plan));
  assert.equal(pending.snapshot.status, "waiting");
  const first = pending.snapshot.speakers.find((speaker) => speaker.identifier === "first");
  assert.equal(pending.snapshot.defaultSpeaker, first?.id);
  assert.equal(pending.snapshot.contextualSpeaker, null);
  assert.equal(
    pending.snapshot.foregroundAction?.kind === "interaction"
      ? pending.snapshot.foregroundAction.speakerId
      : null,
    first?.id,
  );
});

test("compact interactions use narrator provenance when no speaker is available", () => {
  const plan = compiled('let answer = askText "Type here"\nexit');
  const pending = run(plan, createFreshRuntimeSnapshot(plan));
  const action = pending.snapshot.foregroundAction;
  assert.ok(action !== null && action.kind === "interaction");
  assert.equal(action.speakerId, null);

  const completed = completePending(plan, pending.snapshot, "text", {
    kind: "submittedText",
    submittedText: "answer",
  });
  assert.equal(completed.events[0]?.kind, "playerTranscript");
  assert.equal(
    completed.events[0]?.kind === "playerTranscript"
      ? completed.events[0].requestingSpeakerId
      : undefined,
    null,
  );
});

test("requesting speaker is captured before payload side effects change the default speaker", () => {
  const plan = compiled(
    [
      "speaker first {}",
      "speaker second {}",
      "speaker first",
      "function changeDefault {",
      "speaker second",
      'return "Hint"',
      "}",
      "let answer = askText changeDefault()",
      "exit",
    ].join("\n"),
  );
  const pending = run(plan, createFreshRuntimeSnapshot(plan));
  const action = pending.snapshot.foregroundAction;
  assert.ok(action !== null && action.kind === "interaction");
  const first = pending.snapshot.speakers.find((speaker) => speaker.identifier === "first");
  const second = pending.snapshot.speakers.find((speaker) => speaker.identifier === "second");
  assert.equal(action.speakerId, first?.id);
  assert.equal(pending.snapshot.defaultSpeaker, second?.id);
});

test("fixed-seed payload RNG is prepared once and restore does not reevaluate it", () => {
  const plan = compiled('let result = choose "A ${random()}", "B ${random()}"\nexit');
  const fresh = createFreshRuntimeSnapshot(plan, { seed: 1364229357 });
  const freshRng = structuredClone(fresh.rng);
  const pending = run(plan, fresh);
  const savedRng = pending.snapshot.rng;
  assert.notDeepEqual(savedRng, freshRng);
  const restored = deserializeCheckpoint(
    serializeCheckpoint(createCheckpoint(plan, pending.snapshot)),
  );
  assert.deepEqual(restored.snapshot.rng, savedRng);
  const rerun = run(restored.plan, restored.snapshot);
  assert.equal(rerun.snapshot.status, "waiting");
  assert.deepEqual(rerun.snapshot.foregroundAction, pending.snapshot.foregroundAction);
  assert.deepEqual(rerun.snapshot.rng, savedRng);
  const action = rerun.snapshot.foregroundAction;
  assert.ok(action !== null && action.kind === "interaction" && action.ui.kind === "choice");
  const selected = action.ui.options[1]!.text;
  const completed = completePending(restored.plan, rerun.snapshot, "choice", {
    kind: "selectedOption",
    optionIndex: 1,
  });
  assert.deepEqual(completed.snapshot.rng, savedRng);
  const done = run(restored.plan, completed.snapshot);
  assert.equal(done.snapshot.status, "halted");
  assert.equal(rootBinding(done.snapshot, "result"), selected);
  assert.deepEqual(done.snapshot.rng, savedRng);
});

test("blocking interactions resume through ordinary expression contexts and parameter defaults never fail internally", () => {
  // Rejecting a blocking interaction in a parameter default (currently TSV032) is a provisional implementation
  // restriction, not TeaseScript semantics. The default must yield a valid plan or diagnostics located inside the
  // default, never an internal failure: the compiled-plan validation backstop (TSC006) or native stack exhaustion
  // (TSC007).
  const defaultSource = "function prompt(value = askText) { return value }\nlet result = prompt()";
  const defaultResult = compileSource(defaultSource);
  if (defaultResult.plan === null) {
    assert.notEqual(defaultResult.diagnostics.length, 0);
    const defaultStart = defaultSource.indexOf("askText");
    for (const diagnostic of defaultResult.diagnostics) {
      assert.ok(!["TSC006", "TSC007"].includes(diagnostic.code), diagnostic.code);
      assert.ok(diagnostic.span.start.offset >= defaultStart, diagnostic.code);
      assert.ok(diagnostic.span.end.offset <= defaultStart + "askText".length, diagnostic.code);
    }
  } else {
    assert.equal(validateInstructionPlan(defaultResult.plan).valid, true);
  }

  const pairPlan = compiled("let pair: (string | number)[] = [askText, askNumber]\nexit");
  const firstPending = run(pairPlan, createFreshRuntimeSnapshot(pairPlan));
  assert.equal(firstPending.snapshot.status, "waiting");
  assert.equal(
    firstPending.snapshot.foregroundAction?.kind === "interaction"
      ? firstPending.snapshot.foregroundAction.interactionKind
      : null,
    "text",
  );
  const firstCompleted = completePending(pairPlan, firstPending.snapshot, "text", {
    kind: "submittedText",
    submittedText: "alpha",
  });
  assert.equal(firstCompleted.outcome.kind, "completed");
  const secondPending = run(pairPlan, firstCompleted.snapshot);
  assert.equal(secondPending.snapshot.status, "waiting");
  assert.equal(
    secondPending.snapshot.foregroundAction?.kind === "interaction"
      ? secondPending.snapshot.foregroundAction.interactionKind
      : null,
    "number",
  );
  const secondCompleted = completePending(pairPlan, secondPending.snapshot, "number", {
    kind: "submittedText",
    submittedText: "2.5",
  });
  const pairDone = run(pairPlan, secondCompleted.snapshot);
  assert.equal(pairDone.snapshot.status, "halted");
  assert.deepEqual(rootBinding(pairDone.snapshot, "pair"), createSerializableList(["alpha", 2.5]));

  const shortCircuit = compiled('let value = false and askText == "yes"\nexit');
  const shortCircuitDone = run(shortCircuit, createFreshRuntimeSnapshot(shortCircuit));
  assert.equal(shortCircuitDone.snapshot.status, "halted");
  assert.equal(shortCircuitDone.snapshot.foregroundAction, null);
});

test("interaction results resume through assignment and loop-owned source contexts", () => {
  const assignmentPlan = compiled('let answer = "before"\nanswer = askText\nsay answer\nexit');
  const assignmentPending = run(assignmentPlan, createFreshRuntimeSnapshot(assignmentPlan));
  const assignmentCompleted = completePending(assignmentPlan, assignmentPending.snapshot, "text", {
    kind: "submittedText",
    submittedText: "after",
  });
  const assignmentDone = run(assignmentPlan, assignmentCompleted.snapshot);
  assert.equal(assignmentDone.snapshot.status, "halted");
  assert.equal(assignmentDone.events.find((event) => event.kind === "say")?.text, "after");

  const loopPlan = compiled(
    [
      "let count = 0",
      "repeat 1 {",
      "  let answer = askText",
      "  say answer, instant",
      "  count = count + 1",
      "}",
      "say count",
      "exit",
    ].join("\n"),
  );
  const loopPending = run(loopPlan, createFreshRuntimeSnapshot(loopPlan));
  assert.equal(loopPending.snapshot.status, "waiting");
  assert.equal(loopPending.snapshot.loopFrames.length, 1);
  const loopCompleted = completePending(loopPlan, loopPending.snapshot, "text", {
    kind: "submittedText",
    submittedText: "ok",
  });
  const loopDone = run(loopPlan, loopCompleted.snapshot);
  assert.equal(loopDone.snapshot.status, "halted");
  assert.deepEqual(
    loopDone.events.flatMap((event) => (event.kind === "say" ? [event.text] : [])),
    ["ok", "1"],
  );
});

test("interaction expressions preserve function-argument source order across suspension", () => {
  const plan = compiled(
    [
      "function middle(first, second, third) { return second }",
      'let answer = middle(mark("before"), "received ${askText}", mark("after"))',
      "say answer",
      "exit",
    ].join("\n"),
    { builtins: ["mark"] },
  );
  const marks: string[] = [];
  const capabilities: Parameters<typeof run>[2] = {
    builtins: {
      mark: (call) => {
        const value = call.positional[0];
        assert.equal(typeof value, "string");
        // EVIDENCE: the immediately preceding assertion narrows this recorded positional value to string.
        marks.push(value as string);
        return value!;
      },
    },
  };
  const pending = run(plan, createFreshRuntimeSnapshot(plan), capabilities);
  assert.deepEqual(marks, ["before"]);
  assert.equal(pending.snapshot.status, "waiting");
  const completed = completePending(plan, pending.snapshot, "text", {
    kind: "submittedText",
    submittedText: "answer",
  });
  assert.equal(completed.outcome.kind, "completed");
  const done = run(plan, completed.snapshot, capabilities);
  assert.deepEqual(marks, ["before", "after"]);
  assert.equal(done.snapshot.status, "halted");
  assert.equal(done.events.find((event) => event.kind === "say")?.text, "received answer");

  // User-defined calls on both sides of a direct interaction argument keep the same order.
  const userPlan = compiled(
    [
      'function foo { say "foo", instant\nreturn "first" }',
      'function bar { say "bar", instant\nreturn "third" }',
      'function send(first, answer, third) { say "${first}:${answer}:${third}", instant\nreturn }',
      "send(foo(), askText, bar())",
      "exit",
    ].join("\n"),
  );
  const saidTexts = (events: readonly { readonly kind: string; readonly text?: string }[]) =>
    events.flatMap((event) => (event.kind === "say" ? [event.text] : []));
  const userPending = run(userPlan, createFreshRuntimeSnapshot(userPlan));
  assert.equal(userPending.snapshot.status, "waiting");
  assert.deepEqual(saidTexts(userPending.events), ["foo"]);
  const userCompleted = completePending(userPlan, userPending.snapshot, "text", {
    kind: "submittedText",
    submittedText: "middle",
  });
  assert.equal(userCompleted.outcome.kind, "completed");
  assert.deepEqual(saidTexts(userCompleted.events), []);
  const userDone = run(userPlan, userCompleted.snapshot);
  assert.equal(userDone.snapshot.status, "halted");
  assert.deepEqual(saidTexts(userDone.events), ["bar", "first:middle:third"]);
});

test("real source completes, retries invalid input, records provenance, and resumes at top level", () => {
  const plan = compiled(
    'speaker mistress { name: "Mistress" }\nlet answer = askText as mistress "Type here"\nsay answer\nexit',
  );
  const pending = run(plan, createFreshRuntimeSnapshot(plan));
  const action = pending.snapshot.foregroundAction;
  assert.ok(action !== null && action.kind === "interaction");
  assert.notEqual(action.speakerId, null);
  const invalid = completePending(plan, pending.snapshot, "text", {
    kind: "submittedText",
    submittedText: " \t",
  });
  assert.equal(invalid.outcome.kind, "invalidPayload");
  assert.deepEqual(invalid.snapshot, pending.snapshot);
  const completed = completePending(plan, invalid.snapshot, "text", {
    kind: "submittedText",
    submittedText: "ok\r\nnow",
  });
  assert.deepEqual(
    completed.events.map((event) => event.kind),
    ["playerTranscript", "actionCompleted"],
  );
  assert.equal(
    completed.events[0]?.kind === "playerTranscript"
      ? completed.events[0].requestingSpeakerId
      : null,
    action.speakerId,
  );
  const done = run(plan, completed.snapshot);
  assert.equal(done.snapshot.status, "halted");
  assert.equal(done.events.find((event) => event.kind === "say")?.text, "ok\nnow");
});

test("every compact interaction survives pending checkpoint restore and source-to-runtime completion", () => {
  const scenarios = [
    {
      source: 'showButton "Continue"\nexit',
      interactionKind: "button" as const,
      payload: { kind: "activate" as const },
      result: undefined,
    },
    {
      source: 'let result = askText "Type here"\nexit',
      interactionKind: "text" as const,
      payload: { kind: "submittedText" as const, submittedText: "answer" },
      result: "answer",
    },
    {
      source: 'let result = askNumber "Number"\nexit',
      interactionKind: "number" as const,
      payload: { kind: "submittedText" as const, submittedText: "2.5" },
      result: 2.5,
    },
    {
      source: 'let result = choose first: "One", second: "Two"\nexit',
      interactionKind: "choice" as const,
      payload: { kind: "selectedOption" as const, optionIndex: 1 },
      result: "second",
    },
  ];

  for (const scenario of scenarios) {
    const plan = compiled(scenario.source);
    const pending = run(plan, createFreshRuntimeSnapshot(plan));
    assert.equal(pending.snapshot.status, "waiting", scenario.source);
    assert.equal(validateRuntimeSnapshot(pending.snapshot, plan).valid, true, scenario.source);

    const restored = deserializeCheckpoint(
      serializeCheckpoint(createCheckpoint(plan, pending.snapshot)),
    );
    assert.deepEqual(restored.snapshot, pending.snapshot, scenario.source);

    const action = pending.snapshot.foregroundAction;
    assert.ok(action !== null && action.kind === "interaction", scenario.source);
    const request = {
      actionId: action.actionId,
      actionKind: "interaction" as const,
      interactionKind: scenario.interactionKind,
      payload: scenario.payload,
    };
    const uninterruptedCompletion = completeAction(plan, pending.snapshot, request);
    const restoredCompletion = completeAction(restored.plan, restored.snapshot, request);
    assert.equal(uninterruptedCompletion.outcome.kind, "completed", scenario.source);
    assert.deepEqual(restoredCompletion, uninterruptedCompletion, scenario.source);

    const uninterrupted = run(plan, uninterruptedCompletion.snapshot);
    const resumed = run(restored.plan, restoredCompletion.snapshot);
    for (const done of [uninterrupted, resumed]) {
      assert.equal(done.snapshot.status, "halted", scenario.source);
      assert.equal(rootBinding(done.snapshot, "result"), scenario.result, scenario.source);
    }
    assert.deepEqual(resumed.snapshot, uninterrupted.snapshot, scenario.source);
    assert.deepEqual(resumed.events, uninterrupted.events, scenario.source);
  }
});

test("an authored empty hint remains distinct from an omitted hint", () => {
  const emptyPlan = compiled('let answer = askText ""\nexit');
  const emptyPending = run(emptyPlan, createFreshRuntimeSnapshot(emptyPlan));
  const emptyAction = emptyPending.snapshot.foregroundAction;
  assert.ok(
    emptyAction !== null && emptyAction.kind === "interaction" && emptyAction.ui.kind === "text",
  );
  assert.equal(emptyAction.ui.hint, "");
  assert.deepEqual(emptyAction.ui.accessibleName, { kind: "localizedDefault", key: "answer" });

  const omittedPlan = compiled("let answer = askText\nexit");
  const omittedPending = run(omittedPlan, createFreshRuntimeSnapshot(omittedPlan));
  const omittedAction = omittedPending.snapshot.foregroundAction;
  assert.ok(
    omittedAction !== null &&
      omittedAction.kind === "interaction" &&
      omittedAction.ui.kind === "text",
  );
  assert.equal(omittedAction.ui.hint, null);
});

test("real source preserves button transcript and all choice result domains", () => {
  const cases = [
    { source: 'let result = choose "A", "B"\nexit', result: "B", text: "B" },
    {
      source: 'let result = choose first: "Same", second: "Same"\nexit',
      result: "second",
      text: "Same",
    },
    {
      source:
        'let result = choose first:\n    "Same", second:\n\n    // continued\n    "Same"\nexit',
      result: "second",
      text: "Same",
    },
    { source: 'let result = choose 1: "One", 2: "Two"\nexit', result: 2, text: "Two" },
    // An option without a written value returns itself, with its own type.
    { source: "let result = choose 5, 10\nexit", result: 10, text: "10" },
  ] as const;
  for (const scenario of cases) {
    const plan = compiled(scenario.source);
    const pending = run(plan, createFreshRuntimeSnapshot(plan));
    const completed = completePending(plan, pending.snapshot, "choice", {
      kind: "selectedOption",
      optionIndex: 1,
    });
    assert.equal(completed.outcome.kind, "completed");
    assert.equal(
      completed.outcome.kind === "completed" &&
        completed.outcome.settlement.actionKind === "interaction"
        ? completed.outcome.settlement.result
        : null,
      scenario.result,
    );
    assert.equal(
      completed.events[0]?.kind === "playerTranscript" ? completed.events[0].text : null,
      scenario.text,
    );
  }

  const buttonPlan = compiled('showButton "Continue"\nexit');
  const buttonPending = run(buttonPlan, createFreshRuntimeSnapshot(buttonPlan));
  const buttonDone = completePending(buttonPlan, buttonPending.snapshot, "button", {
    kind: "activate",
  });
  assert.equal(
    buttonDone.events[0]?.kind === "playerTranscript" ? buttonDone.events[0].text : null,
    "Continue",
  );
});

test("interaction expressions resume through a direct function return", () => {
  const plan = compiled(
    [
      "function prompt {",
      "return askText",
      "}",
      "let result = prompt()",
      "say result",
      "exit",
    ].join("\n"),
  );
  const pending = run(plan, createFreshRuntimeSnapshot(plan));
  assert.equal(pending.snapshot.status, "waiting");
  const completed = completePending(plan, pending.snapshot, "text", {
    kind: "submittedText",
    submittedText: "returned",
  });
  assert.equal(completed.outcome.kind, "completed");
  const done = run(plan, completed.snapshot);
  assert.equal(done.snapshot.status, "halted");
  assert.equal(done.events.find((event) => event.kind === "say")?.text, "returned");
});

test("function-owned interaction result survives checkpoint completion and explicit call-frame resume", () => {
  const plan = compiled(
    "function prompt {\nlet value = askNumber\nreturn value\n}\nlet result = prompt()\nsay result\nexit",
  );
  const pending = run(plan, createFreshRuntimeSnapshot(plan));
  const action = pending.snapshot.foregroundAction;
  assert.ok(action !== null && action.kind === "interaction");
  assert.notEqual(action.ownerCallFrameId, null);
  const restored = deserializeCheckpoint(
    serializeCheckpoint(createCheckpoint(plan, pending.snapshot)),
  );
  const completed = completePending(restored.plan, restored.snapshot, "number", {
    kind: "submittedText",
    submittedText: " 1.5e2 ",
  });
  assert.equal(validateRuntimeSnapshot(completed.snapshot, restored.plan).valid, true);
  // Exit clears frames and temporaries, so the state the call leaves behind is observed before it.
  const beforeExit = runUntilExit(restored.plan, completed.snapshot);
  assert.equal(beforeExit.events.find((event) => event.kind === "say")?.text, "150");
  assert.deepEqual(beforeExit.snapshot.temporaries, []);
  assert.deepEqual(beforeExit.snapshot.callFrames, []);
  assert.equal(run(restored.plan, beforeExit.snapshot).snapshot.status, "halted");
});

test("a retained dynamic settlement validates against the UI it recorded, before and after cleanup", () => {
  const buttonPlan = compiled("showButton label\nexit", { globals: ["label"] });
  const buttonPending = run(
    buttonPlan,
    createFreshRuntimeSnapshot(buttonPlan, { globals: { label: "Continue" } }),
  );
  const buttonCompleted = completePending(buttonPlan, buttonPending.snapshot, "button", {
    kind: "activate",
  });
  assert.equal(validateRuntimeSnapshot(buttonCompleted.snapshot, buttonPlan).valid, true);
  const wrongButton = structuredClone(buttonCompleted.snapshot);
  assert.ok(wrongButton.lastSettlement?.actionKind === "interaction");
  // EVIDENCE: fixture mutates only retained interaction transcript text to contradict prepared button UI provenance.
  (wrongButton.lastSettlement as { transcriptText: string | null }).transcriptText = "Wrong";
  assert.equal(validateRuntimeSnapshot(wrongButton, buttonPlan).valid, false);
  const buttonAfterCleanup = run(buttonPlan, buttonCompleted.snapshot).snapshot;
  assert.equal(validateRuntimeSnapshot(buttonAfterCleanup, buttonPlan).valid, true);
  assert.doesNotThrow(() =>
    deserializeCheckpoint(serializeCheckpoint(createCheckpoint(buttonPlan, buttonAfterCleanup))),
  );

  const choicePlan = compiled("let result = choose first, second\nexit", {
    globals: ["first", "second"],
  });
  const choicePending = run(
    choicePlan,
    createFreshRuntimeSnapshot(choicePlan, { globals: { first: "One", second: "Two" } }),
  );
  const choiceCompleted = completePending(choicePlan, choicePending.snapshot, "choice", {
    kind: "selectedOption",
    optionIndex: 0,
  });
  const choiceAfterCleanup = run(choicePlan, choiceCompleted.snapshot).snapshot;
  assert.equal(validateRuntimeSnapshot(choiceAfterCleanup, choicePlan).valid, true);
  const valuedPlan = compiled("let result = choose first: firstText, second: secondText\nexit", {
    globals: ["firstText", "secondText"],
  });
  const valuedPending = run(
    valuedPlan,
    createFreshRuntimeSnapshot(valuedPlan, { globals: { firstText: "Alpha", secondText: "Beta" } }),
  );
  const valuedCompleted = completePending(valuedPlan, valuedPending.snapshot, "choice", {
    kind: "selectedOption",
    optionIndex: 0,
  });
  assert.equal(validateRuntimeSnapshot(valuedCompleted.snapshot, valuedPlan).valid, true);
  // Result, destination and handoff stay the valid value `first`; only the retained transcript
  // names the other prepared option, so the prepared value/text association must reject it.
  const wrongTranscript = structuredClone(valuedCompleted.snapshot);
  assert.ok(wrongTranscript.lastSettlement?.actionKind === "interaction");
  assert.equal(wrongTranscript.interactionResultHandoff?.result, "first");
  // EVIDENCE: fixture mutates only the retained transcript text to another prepared option text.
  (wrongTranscript.lastSettlement as { transcriptText: string | null }).transcriptText = "Beta";
  assert.equal(validateRuntimeSnapshot(wrongTranscript, valuedPlan).valid, false);
  const wrongTranscriptCheckpoint = structuredClone(
    createCheckpoint(valuedPlan, valuedCompleted.snapshot),
  );
  assert.ok(wrongTranscriptCheckpoint.snapshot.lastSettlement?.actionKind === "interaction");
  // EVIDENCE: fixture mutates only the checkpoint transcript text to another prepared option text.
  (
    wrongTranscriptCheckpoint.snapshot.lastSettlement as { transcriptText: string | null }
  ).transcriptText = "Beta";
  assert.throws(() => deserializeCheckpoint(JSON.stringify(wrongTranscriptCheckpoint)));
  const valuedAfterCleanup = run(valuedPlan, valuedCompleted.snapshot).snapshot;
  const differentPossibleHistory = structuredClone(valuedAfterCleanup);
  assert.ok(differentPossibleHistory.lastSettlement?.actionKind === "interaction");
  // EVIDENCE: fixture changes only the transcript to the text the recorded UI shows for the other value.
  (differentPossibleHistory.lastSettlement as { transcriptText: string | null }).transcriptText =
    "Beta";
  // The settlement records the presented options, so the contradiction stays detectable after cleanup.
  assert.equal(validateRuntimeSnapshot(differentPossibleHistory, valuedPlan).valid, false);
  const mismatchedValue = structuredClone(valuedAfterCleanup);
  assert.ok(mismatchedValue.lastSettlement?.actionKind === "interaction");
  // EVIDENCE: fixture mutates only the retained result to a value absent from the interaction domain.
  (mismatchedValue.lastSettlement as { result: unknown }).result = "third";
  assert.equal(validateRuntimeSnapshot(mismatchedValue, valuedPlan).valid, false);
  const mismatchedValueCheckpoint = structuredClone(
    createCheckpoint(valuedPlan, valuedAfterCleanup),
  );
  assert.ok(mismatchedValueCheckpoint.snapshot.lastSettlement?.actionKind === "interaction");
  // EVIDENCE: fixture mutates only the checkpoint settlement result to an absent choice value.
  (mismatchedValueCheckpoint.snapshot.lastSettlement as { result: unknown }).result = "third";
  assert.throws(() => deserializeCheckpoint(JSON.stringify(mismatchedValueCheckpoint)));
});

test("oversized static compact interactions return no plan and a diagnostic at the interaction span", () => {
  // The button label is the only authored definition string, so it alone exceeds the aggregate.
  const oversizedButton = `showButton "${"x".repeat(MAX_INTERACTION_AGGREGATE_UTF8_BYTES + 1)}"`;
  const options = Array.from(
    { length: MAX_INTERACTION_OPTION_ENTRIES + 1 },
    (_, index) => `"option-${index}"`,
  ).join(", ");
  const oversizedChoice = `let result = choose ${options}`;
  // The compiler sees that the choice has too many buttons before plan validation would.
  for (const [statement, start, code] of [
    [oversizedButton, 0, "TSC006"],
    [oversizedChoice, oversizedChoice.indexOf("choose"), "TSV029"],
  ] as const) {
    const result = compileSource(`${statement}\nexit`);
    assert.equal(result.plan, null);
    const diagnostic = result.diagnostics.find((candidate) => candidate.code === code);
    assert.deepEqual(diagnostic?.span, {
      start: { offset: start, line: 0, column: start },
      end: { offset: statement.length, line: 0, column: statement.length },
    });
  }
});

test("representative static and dynamic root/function choices complete through checkpoint restore", () => {
  const cases = [
    {
      name: "static-root",
      source: 'let result = choose first: "One", second: "Two", third: "Three"\nexit',
      payload: { kind: "selectedOption" as const, optionIndex: 1 },
      binding: "result",
      expected: "second",
    },
    {
      name: "static-function",
      source: [
        "function prompt {",
        'let result = choose first: "One", second: "Two", third: "Three"',
        "return result",
        "}",
        "let output = prompt()",
        "exit",
      ].join("\n"),
      payload: { kind: "selectedOption" as const, optionIndex: 1 },
      binding: "output",
      expected: "second",
    },
    {
      name: "dynamic-root",
      source: [
        'let prefix = "Option"',
        'let result = choose "${prefix} A", "${prefix} B", "${prefix} C"',
        "exit",
      ].join("\n"),
      payload: { kind: "selectedOption" as const, optionIndex: 1 },
      binding: "result",
      expected: "Option B",
    },
    {
      name: "dynamic-function",
      source: [
        "function prompt(prefix) {",
        'let result = choose "${prefix} A", "${prefix} B", "${prefix} C"',
        "return result",
        "}",
        'let output = prompt("Option")',
        "exit",
      ].join("\n"),
      payload: { kind: "selectedOption" as const, optionIndex: 1 },
      binding: "output",
      expected: "Option B",
    },
  ];

  for (const scenario of cases) {
    const plan = compiled(scenario.source);
    const pending = run(plan, createFreshRuntimeSnapshot(plan));
    assert.equal(pending.snapshot.status, "waiting", `${scenario.name}: pending`);
    const action = pending.snapshot.foregroundAction;
    assert.ok(
      action !== null &&
        action.kind === "interaction" &&
        action.interactionKind === "choice" &&
        action.ui.kind === "choice",
      `${scenario.name}: pending choice`,
    );

    const checkpoint = deserializeCheckpoint(
      serializeCheckpoint(createCheckpoint(plan, pending.snapshot)),
    );
    const request = {
      actionId: action.actionId,
      actionKind: "interaction" as const,
      interactionKind: "choice" as const,
      payload: scenario.payload,
    };
    const completed = completeAction(checkpoint.plan, checkpoint.snapshot, request);
    assert.equal(completed.outcome.kind, "completed", `${scenario.name}: completion`);
    const handoff = deserializeCheckpoint(
      serializeCheckpoint(createCheckpoint(plan, completed.snapshot)),
    );
    const uninterrupted = run(plan, completed.snapshot);
    const resumed = run(handoff.plan, handoff.snapshot);
    for (const done of [uninterrupted, resumed]) {
      assert.equal(done.snapshot.status, "halted", `${scenario.name}: halted`);
      assert.equal(
        rootBinding(done.snapshot, scenario.binding),
        scenario.expected,
        `${scenario.name}: ${scenario.binding}`,
      );
    }
    assert.deepEqual(resumed.events, uninterrupted.events, `${scenario.name}: events`);
    assert.deepEqual(resumed.snapshot, uninterrupted.snapshot, `${scenario.name}: snapshot`);
  }
});
