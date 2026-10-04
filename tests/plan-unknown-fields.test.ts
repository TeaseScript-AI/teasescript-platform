import assert from "node:assert/strict";
import test from "node:test";

import {
  CheckpointError,
  compileSource,
  createCheckpoint,
  createFreshRuntimeSnapshot,
  deserializeCheckpoint,
  restoreCheckpoint,
  validateInstructionPlan,
} from "../src/index.js";
import { compileValidPlan } from "./helpers/compile-valid-plan.js";

// Ordinary source whose compiled plan contains every instruction and expression shape the compiler emits for it,
// plus function definitions, parameters, speaker and object properties, template parts, positional and named builtin
// arguments, static and prepared interaction payloads, and runtime type checks of host values at each kind of place.
const REPRESENTATIVE_SOURCE = [
  "function helper(value = 1) { return value }",
  "function typed(count: integer = capture(1)) { return count }",
  "function ranked(first: boolean): integer {",
  "  if first { return 1 }",
  "  return capture(2)",
  "}",
  'speaker vera { title: "Mistress" }',
  "speaker mira { title: helper() }",
  "speaker vera",
  "let values = [1, 2]",
  'let tags = set["a"]',
  'let record = { name: "x", nested: [0] }',
  "values.add(helper(2))",
  "record.nested[0] = helper()",
  "let maybe: integer? = capture(3)",
  "record = capture(4)",
  "tags.add(capture(5))",
  "let rank = typed(capture(6)) + ranked(false)",
  "let flag = values.length > 0 and not false",
  "let interval = 1..=3",
  "let product = (1 + 2) * -3",
  "let named = capture(label: 1) + capture(2)",
  "let nested = helper(helper())",
  'if flag { say "yes" } else { say "no" }',
  "for item in values {",
  "  if item == 1 { continue }",
  "  break",
  "}",
  'repeat 2 { say "again" }',
  'while false { say "never" }',
  'say "Hello ${helper()}"',
  "helper()",
  "wait 1 s",
  'showButton "Continue"',
  'let answer = askText "Name ${values.length}"',
  'let choice = choose first: "One", second: "Two"',
  "exit",
].join("\n");

const UNKNOWN_FIELD = "unknownField";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Every plain object in a JSON plan with its validator path, visited without recursion. */
function planObjects(root: unknown): Array<{ path: string; value: Record<string, unknown> }> {
  const objects: Array<{ path: string; value: Record<string, unknown> }> = [];
  const pending: Array<{ path: string; value: unknown }> = [{ path: "$", value: root }];
  while (pending.length > 0) {
    const { path, value } = pending.pop()!;
    if (Array.isArray(value)) {
      value.forEach((item: unknown, index) =>
        pending.push({ path: `${path}[${index}]`, value: item }),
      );
    } else if (isRecord(value)) {
      objects.push({ path, value });
      for (const [key, nested] of Object.entries(value)) {
        pending.push({ path: `${path}.${key}`, value: nested });
      }
    }
  }
  return objects;
}

test("current-version plans reject an added field on each object shape of a compiled plan", () => {
  const compiled = compileSource(REPRESENTATIVE_SOURCE, { builtins: ["capture"] });
  assert.deepEqual(compiled.diagnostics, []);
  const external: unknown = JSON.parse(JSON.stringify(compiled.plan));
  assert.deepEqual(validateInstructionPlan(external), { valid: true, errors: [] });

  const objects = planObjects(external);
  const instructionKinds = new Set(
    objects.flatMap(({ path, value }) =>
      /^\$\.instructions\[\d+\]$/u.test(path) ? [value.kind] : [],
    ),
  );
  // The source must keep reaching the shapes whose unknown-field rejection this test protects.
  for (const kind of [
    "declareSpeaker",
    "setDeclaredSpeakerProperty",
    "setDefaultSpeaker",
    "enterScope",
    "leaveScope",
    "declareBinding",
    "prepareReference",
    "validateAssignmentTarget",
    "assign",
    "validateCallReceiver",
    "evaluate",
    "jumpIfFalse",
    "jump",
    "loopStart",
    "loopControl",
    "storeTemporary",
    "clearTemporary",
    "clearTemporaries",
    "callFunction",
    "bindSuppliedParameter",
    "beginFunctionDefaults",
    "prepareParameterDefault",
    "bindDefaultParameter",
    "enterFunctionBody",
    "returnValue",
    "returnVoid",
    "say",
    "wait",
    "interaction",
    "exit",
  ]) {
    assert.ok(instructionKinds.has(kind), `representative plan lacks instruction ${kind}`);
  }
  const nestedKinds = new Set(
    objects.flatMap(({ path, value }) =>
      !/^\$\.instructions\[\d+\]$/u.test(path) && "span" in value ? [value.kind] : [],
    ),
  );
  for (const kind of [
    "literal",
    "identifier",
    "temporary",
    "preparedReference",
    "list",
    "set",
    "object",
    "template",
    "property",
    "index",
    "call",
    "unary",
    "binary",
    "range",
  ]) {
    assert.ok(nestedKinds.has(kind), `representative plan lacks expression ${kind}`);
  }

  // One object per shape (kind plus its last two path fields) keeps the matrix small; source locations already
  // required exact keys before this rule.
  const shapes = new Map<string, { path: string; value: Record<string, unknown> }>();
  for (const object of objects) {
    if (/(span|Span)$/u.test(object.path)) continue;
    const fields = object.path
      .replace(/\[\d+\]/gu, "[]")
      .split(".")
      .slice(-2)
      .join(".");
    const shape = `${fields}:${String(object.value.kind)}`;
    if (!shapes.has(shape)) shapes.set(shape, object);
  }
  for (const { path, value } of shapes.values()) {
    // Validation captures its input, so the field is added and removed in place.
    value[UNKNOWN_FIELD] = 0;
    const errors = validateInstructionPlan(external).errors;
    delete value[UNKNOWN_FIELD];
    // Shapes whose validator already required exact keys report the object; the others name the field.
    assert.ok(
      errors.length === 1 &&
        errors[0]!.code === "TSC002" &&
        (errors[0]!.path === `${path}.${UNKNOWN_FIELD}` || errors[0]!.path === path),
      `${path}: ${JSON.stringify(errors)}`,
    );
  }

  // Allowed fields are per kind: a field that another kind defines is still unknown here.
  for (const [kind, field, value] of [
    [
      "declareBinding",
      "condition",
      { kind: "literal", value: true, span: compiled.plan!.sourceSpan },
    ],
    ["literal", "name", "value"],
  ] as const) {
    const target = objects.find((object) => object.value.kind === kind);
    assert.ok(target !== undefined, kind);
    target.value[field] = value;
    const errors = validateInstructionPlan(external).errors;
    delete target.value[field];
    assert.deepEqual(
      errors.map((error) => [error.code, error.path]),
      [["TSC002", `${target.path}.${field}`]],
      kind,
    );
  }
});

test("checkpoint restore and deserialization reject unknown plan fields at their plan path", () => {
  const plan = compileValidPlan('let value = "x"\nexit');
  const json = JSON.stringify(createCheckpoint(plan, createFreshRuntimeSnapshot(plan)));
  for (const { field, mutate, code, path } of [
    {
      field: "top-level field",
      mutate: (text: string) => text.replace('"plan":{', `"plan":{"${UNKNOWN_FIELD}":0,`),
      code: "TSK002",
      path: `$.plan.${UNKNOWN_FIELD}`,
    },
    {
      // JSON.parse creates an own `__proto__` field rather than changing the prototype.
      field: "prototype-named expression field",
      mutate: (text: string) =>
        text.replace('{"kind":"literal",', '{"__proto__":0,"kind":"literal",'),
      code: "TSK002",
      path: "$.plan.instructions[0].value.__proto__",
    },
    {
      // Fields are defined per plan version, so a newer revision is unsupported rather than malformed.
      field: "newer revision with a new top-level field",
      mutate: (text: string) =>
        text.replace(
          `"plan":{"format":"${plan.format}","version":${plan.version},`,
          `"plan":{"${UNKNOWN_FIELD}":0,"format":"${plan.format}","version":${plan.version + 1},`,
        ),
      code: "TSK001",
      path: "$.plan.version",
    },
  ]) {
    const malformed = mutate(json);
    assert.notEqual(malformed, json, field);
    const isExpected = (error: unknown): boolean => {
      assert.ok(error instanceof CheckpointError, field);
      assert.deepEqual({ code: error.info.code, path: error.info.path }, { code, path }, field);
      return true;
    };
    assert.throws(() => deserializeCheckpoint(malformed), isExpected);
    assert.throws(() => restoreCheckpoint(JSON.parse(malformed)), isExpected);
  }
});
