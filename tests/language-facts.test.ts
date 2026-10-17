import assert from "node:assert/strict";
import test from "node:test";

import { compileSource } from "../src/compiler.js";
import {
  ANGLE_UNIT_NAMES,
  ANGLE_UNITS,
  CALENDAR_DURATION_UNIT_NAMES,
  CALENDAR_DURATION_UNITS,
  COMMANDS,
  commandFacts,
  DURATION_UNIT_NAMES,
  DURATION_UNITS,
  KEYWORD_TOKENS,
  TEASESCRIPT_GRAMMAR_KEYWORDS,
  TEASESCRIPT_PROTECTED_NAMES,
} from "../src/language-facts.js";
import { lex } from "../src/lexer.js";
import { validateInstructionPlan } from "../src/plan/validation.js";
import { TokenKind } from "../src/token.js";
import { compileValidPlan } from "./helpers/compile-valid-plan.js";

test("every word that the lexer or the parser reads by name is protected, so no declaration can take it", () => {
  const protectedNames: ReadonlySet<string> = new Set(TEASESCRIPT_PROTECTED_NAMES);
  for (const word of [...KEYWORD_TOKENS.keys(), ...Object.keys(COMMANDS)])
    assert.ok(protectedNames.has(word), word);
  // An earlier name is read as an ask that has its current name, with the same kind of answer.
  for (const [name, facts] of Object.entries(COMMANDS)) {
    const renamed = commandFacts(name)?.renamed;
    if (renamed === undefined) continue;
    assert.equal(commandFacts(renamed)?.interaction, commandFacts(name)?.interaction, name);
    assert.equal(commandFacts(renamed)?.renamed, undefined, name);
    assert.ok("value" in facts, name);
  }
});

test("each unit has its names, and every name gives a unit of its list", () => {
  for (const [units, names] of [
    [DURATION_UNITS, DURATION_UNIT_NAMES],
    [CALENDAR_DURATION_UNITS, CALENDAR_DURATION_UNIT_NAMES],
    [ANGLE_UNITS, ANGLE_UNIT_NAMES],
  ] as const) {
    assert.deepEqual(new Set(names.values()), new Set(units));
    for (const unit of units) assert.equal(names.get(unit), unit);
  }
});

test("a string may follow every command that gives a value, also inside an interpolation", () => {
  for (const [name, facts] of Object.entries(COMMANDS)) {
    if (!("value" in facts)) continue;
    const source = `say "\${${name} "x"}"`;
    const { tokens, diagnostics } = lex(source);
    assert.deepEqual(diagnostics, [], source);
    assert.equal(tokens.filter((token) => token.kind === TokenKind.StringStart).length, 2, source);
  }
});

test("a play command's file may follow its words, also inside an interpolation", () => {
  // The reported source, and each word of each play command alone and all together.
  const sources = ['say "${playAudio async "a.mp3"}"'];
  for (const [name, facts] of Object.entries(COMMANDS))
    if ("fileModifiers" in facts)
      for (const words of [...facts.fileModifiers.map((word) => [word]), facts.fileModifiers])
        sources.push(`say "\${${name} ${words.join(" ")} "x"}"`);
  for (const source of sources) {
    const { tokens, diagnostics } = lex(source);
    assert.deepEqual(diagnostics, [], source);
    assert.equal(tokens.filter((token) => token.kind === TokenKind.StringStart).length, 2, source);
    // The parser reads the words, so what remains is that "${...}" cannot show the handle the command gives.
    assert.deepEqual(
      compileSource(`${source}\nexit`).diagnostics.map(({ code }) => code),
      [source.includes(" async ") ? "TSV042" : "TSV069"],
      source,
    );
  }
});

test("a host cannot configure a keyword, a command, an ask, or another name the language reads itself", () => {
  for (const name of new Set([
    ...TEASESCRIPT_GRAMMAR_KEYWORDS,
    ...KEYWORD_TOKENS.keys(),
    ...Object.keys(COMMANDS),
    "takePhoto",
    "askImage",
    "pi",
    "debugMode",
  ]))
    for (const options of [{ globals: [name] }, { builtins: [name] }])
      assert.deepEqual(
        compileSource("exit", options).diagnostics.map(({ code, message }) => [code, message]),
        [["TSV001", `Configured name '${name}' conflicts with a protected TeaseScript name.`]],
        `${name}: ${JSON.stringify(options)}`,
      );
});

test("plan validation accepts every unit of the language and refuses another", () => {
  const cases = [
    ...DURATION_UNITS.map((unit) => ["unit", `n ${unit}`, "Duration unit is invalid."] as const),
    ...CALENDAR_DURATION_UNITS.map(
      (unit) => ["unit", `n calendar ${unit}`, "Duration unit is invalid."] as const,
    ),
    ...ANGLE_UNITS.map((unit) => ["angleUnit", `n ${unit}`, "Angle unit is invalid."] as const),
  ];
  for (const [kind, value, message] of cases) {
    const plan = compileValidPlan(`let n = 2\nlet v = ${value}\nsay "\${v}"\nexit`);
    assert.equal(validateInstructionPlan(plan).valid, true, value);
    const changed = structuredClone(plan);
    const node = findNode(changed, kind);
    assert.ok(node !== null, value);
    node.unit = "fortnight";
    assert.deepEqual(
      validateInstructionPlan(changed).errors.map((error) => error.message),
      [message],
      value,
    );
  }
});

/** The first object of `kind` in a plan, found without recursion. */
function findNode(value: unknown, kind: string): { unit: unknown } | null {
  const pending = [value];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    if (typeof next !== "object" || next === null) continue;
    if (!Array.isArray(next) && "kind" in next && next.kind === kind && "unit" in next) return next;
    pending.push(...Object.values(next));
  }
  return null;
}
