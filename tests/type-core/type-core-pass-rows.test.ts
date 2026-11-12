import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { compileProject, compileProjectWithBackend } from "../../src/compiler.js";
import { CORE_BACKEND } from "../../src/type-inference/core/backend.js";
import { DefinitionIndex } from "../../src/type-inference/core/definitions.js";
import { SliceIndex } from "../../src/type-inference/core/check-result/slice-index.js";
import { CoreProgram } from "../../src/type-inference/core/program.js";
import { DISPOSITIONS, type SyntaxKind } from "../../src/type-inference/core/slice-syntax.js";
import { coreRequest } from "../helpers/type-core-analysis.js";
import { runGlobals } from "../helpers/type-core-route.js";
import {
  NESTED_OPERANDS,
  OPERAND_TEMPLATES,
  ROW_TEMPLATES,
} from "../helpers/type-core/row-templates.js";

/*
 * The `pass` rows of the candidate route's syntax table (#2488's design, the `pass` rule, with the lead's R13): a
 * `pass` command has no effect of its own the analysis would need beyond its operands', and each of its operands is
 * checked by its instruction where the row cites it. Also B1 of the design round: every operand of a `say` is indexed,
 * with what it holds.
 */

// EVIDENCE: invariant: the table's keys are exactly the AST kinds (its mapped type).
const PASS = (Object.keys(DISPOSITIONS) as SyntaxKind[]).filter(
  (kind) => DISPOSITIONS[kind].row === "pass",
);

/** The text of a top-level function of a file, from its `function` line to the first line that is `}`. */
function functionText(file: string, name: string): string | null {
  const lines = readFileSync(file, "utf8").split("\n");
  const start = lines.findIndex((line) =>
    new RegExp(`^(export )?function ${name}[(<]`, "u").test(line),
  );
  if (start < 0) return null;
  const end = lines.findIndex((line, at) => at > start && line === "}");
  return lines.slice(start, end + 1).join("\n");
}

test("each operand of a `pass` row cites a runtime function that raises a fault on a value it does not take", () => {
  assert.ok(PASS.length > 0);
  for (const row of PASS) {
    const disposition = DISPOSITIONS[row];
    assert.equal(disposition.row, "pass");
    if (disposition.row !== "pass") continue;
    for (const [operand, check] of Object.entries(disposition.operands)) {
      const text = functionText(check.file, check.function);
      assert.ok(
        text !== null,
        `${row} ${operand}: ${check.file} has no function ${check.function}`,
      );
      assert.match(text, /throw fault\(/u, `${row} ${operand}: ${check.function} raises no fault`);
    }
  }
});

/** What the analysis builds for a project: its flow graph's regions, jumps and call sites, and its definitions. */
function effects(source: string): {
  readonly regions: string[];
  readonly jumps: number;
  readonly sites: number;
  readonly definitions: number;
  readonly program: CoreProgram;
} {
  const request = coreRequest([{ path: "main.tease", source }]);
  assert.ok(request !== null, source);
  const program = new CoreProgram(request);
  program.index();
  const index = new DefinitionIndex(program);
  const definitions = new Set(
    [...index.byKey.values(), ...index.cellDefs.values(), ...index.loopAdds.values()]
      .flat()
      .map((definition) => definition.uid),
  );
  return {
    regions: program.flow.regions.map((region) => region.kind),
    jumps: program.flow.jumps.length,
    sites: program.flow.sites.length,
    definitions: definitions.size,
    program,
  };
}

/**
 * Each `pass` command with an operand holding an expression with effects of its own (a load, a `get`, a call), beside the
 * same operand stored by a `let`: the command's own effects are what it adds to its operands', and they are none.
 */
function pairs(row: SyntaxKind): { readonly command: string; readonly operand: string | null }[] {
  const operands = OPERAND_TEMPLATES[row];
  if (operands === undefined)
    return (ROW_TEMPLATES[row] ?? []).map((command) => ({ command, operand: null }));
  return Object.values(operands)
    .flat()
    .flatMap((template) =>
      NESTED_OPERANDS.map((nested) => ({
        command: template.replace("hostValue", nested),
        operand: nested,
      })),
    );
}

test("a `pass` row's own effects, apart from its operands', are none: no definition, region, jump or call site", () => {
  for (const row of PASS) {
    const found = pairs(row);
    assert.ok(found.length > 0, row);
    for (const { command, operand } of found) {
      const own = effects(`${command}\nexit\n`);
      // the operand alone, stored: its own effects and the `let`'s one definition
      const alone = effects(`let o = ${operand ?? "0"}\nexit\n`);
      const at = `${row}: ${command}`;
      assert.deepEqual(own.regions, alone.regions, `${at}: regions`);
      assert.equal(own.jumps, alone.jumps, `${at}: jumps`);
      assert.equal(own.sites, alone.sites, `${at}: call sites`);
      assert.equal(own.definitions, alone.definitions - 1, `${at}: definitions`);
      // and it leaves only to the next statement: its statement node has one successor, in its own region
      const node = own.program.flow.nodes.find(
        (candidate) =>
          candidate.kind === "statement" &&
          candidate.file === 0 &&
          candidate.span?.start.offset === 0,
      );
      assert.ok(node !== undefined, `${at}: its statement node`);
      assert.deepEqual(
        node.successors.map((next) => next.region),
        [node.region],
        `${at}: fall-through`,
      );
    }
  }
});

const route = (source: string) =>
  compileProjectWithBackend(
    [{ path: "main.tease", source }],
    { globals: ["hostValue"] },
    CORE_BACKEND,
  );
const today = (source: string) =>
  compileProject([{ path: "main.tease", source }], { globals: ["hostValue"] });
const diagnosed = (result: ReturnType<typeof route>): string[] =>
  result.diagnostics.map(
    (diagnostic) =>
      `${diagnostic.severity} ${diagnostic.code} ${diagnostic.span.start.offset}:${diagnostic.span.end.offset}`,
  );

test("every operand of a `say` is indexed with what it holds (B1): a name, a load, a `get` and a call", () => {
  const sources = [
    'let color = "blue"\nsay bubble(color: color) "Text", instant\nexit\n',
    'say "Hi", load "p", default: hostValue\nexit\n',
    'let xs = [hostValue]\nsay "Hi", xs.get(0, default: hostValue)\nexit\n',
    'say bubble(color: fromJson(hostValue, default: "red")) "Text"\nexit\n',
    'say prose(color: hostValue) "Text", hostValue\nexit\n',
  ];
  for (const source of sources) {
    const [own, current] = [route(source), today(source)];
    assert.deepEqual(diagnosed(own), diagnosed(current), source);
    assert.equal(own.plan === null, current.plan === null, source);
    if (own.plan === null || current.plan === null) continue;
    for (const hostValue of [2, "red", null])
      assert.deepEqual(
        runGlobals(own.plan, { hostValue }),
        runGlobals(current.plan, { hostValue }),
        `${source} with ${JSON.stringify(hostValue)}`,
      );
  }
});

test("a known colour that is no colour is TSC008 at the same span on the route and today (B1)", () => {
  const source = 'let color = "wrong-color"\nsay bubble(color: color) "Text", instant\nexit\n';
  const [own, current] = [route(source), today(source)];
  assert.equal(own.plan, null);
  assert.deepEqual(diagnosed(own), diagnosed(current));
  assert.ok(diagnosed(own).some((diagnostic) => diagnostic.startsWith("error TSC008")));
});

test("a presentation's option names are no written property names: the program's field order is its records'", () => {
  // `align` is written first as an option, then `zeta` before `align` as a record's fields
  const source = 'say prose(align: "center") "a"\nlet r = {zeta: 1, align: 2}\nexit\n';
  const request = coreRequest([{ path: "main.tease", source }]);
  assert.ok(request !== null);
  const index = new SliceIndex(request.files.map((file) => file.program));
  assert.deepEqual(index.inWrittenOrder(["align", "zeta"]), ["zeta", "align"]);
});
