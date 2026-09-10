import { compileChild, runCompileTask, type CompileTask } from "../src/compiler/continuation.js";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { assertRuntimeResumeEquivalent } from "./helpers/runtime-equivalence.js";

test("downstream expression frames traverse each public stage and resume on a constrained stack", () => {
  const api = new URL("../src/index.js", import.meta.url).href;
  const compiler = new URL("../src/compiler/compile-program.js", import.meta.url).href;
  const script = `
    import assert from 'node:assert/strict';
    import {parse,validateSemantics,compileSource,validateInstructionPlan,createFreshRuntimeSnapshot,executeInstruction,run,createCheckpoint,serializeCheckpoint,deserializeCheckpoint} from ${JSON.stringify(api)};
    import {compileStableProgram} from ${JSON.stringify(compiler)};
    for(const depth of [256,1024]) {
      const families = [
        ['binary', 'let result='+Array(depth).fill('1').join('+')+'\\nexit', depth],
        ['property', 'let x='+'{a:'.repeat(depth)+'1'+'}'.repeat(depth)+'\\nlet result=x'+'.a'.repeat(depth)+'\\nexit',1],
        ['index', 'let x='+'['.repeat(depth)+'1'+']'.repeat(depth)+'\\nlet result=x'+'[0]'.repeat(depth)+'\\nexit',1],
        ['property assignment', 'let x='+'{a:'.repeat(depth)+'1'+'}'.repeat(depth)+'\\nx'+'.a'.repeat(depth)+'=9\\nlet result=x'+'.a'.repeat(depth)+'\\nexit',9],
        ['index assignment', 'let x='+'['.repeat(depth)+'1'+']'.repeat(depth)+'\\nx'+'[0]'.repeat(depth)+'=9\\nlet result=x'+'[0]'.repeat(depth)+'\\nexit',9],
        ['builtin call', 'let result='+'escapeMarkup('.repeat(depth)+'"yes"'+')'.repeat(depth)+'\\nexit','yes'],
        ['user call', 'function f(x) {return x}\\nlet result='+'f('.repeat(depth)+'1'+')'.repeat(depth)+'\\nexit',1],
        ['template', 'let result='+'"a\u0024{'.repeat(depth)+'1'+'}"'.repeat(depth)+'\\nexit','a'.repeat(depth)+'1'],
        ['nested index', 'let x=[0]\\nlet result='+'x['.repeat(depth)+'0'+']'.repeat(depth)+'\\nexit',0],
        ['groups and range', 'let result=randomInteger('+'('.repeat(depth)+'1'+')'.repeat(depth)+'..2)\\nexit',1],
        ['mixed', 'let result='+'[escapeMarkup('.repeat(depth)+'"x"'+')][0]'.repeat(depth)+'\\nexit','x'],
      ];
      for(const [name,source,expected] of families) {
        let stage='parse';
        try {
          const parsed=parse(source);assert.deepEqual(parsed.diagnostics,[]);
          stage='semantics';assert.deepEqual(validateSemantics(parsed.program,{builtins:['escapeMarkup','randomInteger']}).diagnostics,[]);
          stage='lowering';const plan=compileStableProgram(parsed.program);
          stage='external plan validation';assert.equal(validateInstructionPlan(plan).valid,true);
          stage='fresh snapshot';const initial=createFreshRuntimeSnapshot(plan,{seed:42});
          stage='runtime';const whole=run(plan,initial,{}, {instructionBudget:20000});assert.equal(whole.snapshot.status,'halted');
          assert.equal(whole.snapshot.frames[0].bindings.find(binding=>binding.name==='result').value,expected);
          stage='partial execution';const partial={snapshot:initial,events:[]};for(let step=0;step<Math.max(1,Math.min(5,Math.floor(plan.rootEndInstruction/2)));step++){const next=executeInstruction(plan,partial.snapshot);partial.snapshot=next.snapshot;partial.events.push(...next.events);}
          stage='checkpoint JSON capture/restore';const restored=deserializeCheckpoint(serializeCheckpoint(createCheckpoint(plan,partial.snapshot)));
          stage='resume';const resumed=run(restored.plan,restored.snapshot,{}, {instructionBudget:20000});
          assert.equal(resumed.snapshot.status,'halted');
          assert.equal(serializeCheckpoint(createCheckpoint(restored.plan,resumed.snapshot)),serializeCheckpoint(createCheckpoint(plan,whole.snapshot)));
          assert.equal(JSON.stringify([...partial.events,...resumed.events]),JSON.stringify(whole.events));
        } catch(error) {throw Error(name+':'+depth+' first failed '+stage,{cause:error});}
      }
      // Malformed external plans retain child-before-parent diagnostics through
      // deep group continuations, and valid groups also reach runtime evaluation.
      const base=compileSource('let result=1\\nexit').plan;
      const span=base.instructions[0].span;
      let invalid={kind:'unsupported',span};
      let valid={kind:'literal',value:1,span};
      for(let level=0;level<depth;level++) {invalid={kind:'group',expression:invalid,span};valid={kind:'group',expression:valid,span};}
      const external=value=>({...base,instructions:[{...base.instructions[0],value},...base.instructions.slice(1)]});
      const rejected=validateInstructionPlan(external({kind:'property',object:invalid,name:7,span}));
      assert.equal(rejected.valid,false);assert.equal(rejected.errors.length,2);
      assert.equal(rejected.errors[0].message,"Unknown expression kind 'unsupported'.");
      assert.ok(rejected.errors[0].path.endsWith('.kind'));
      assert.ok(rejected.errors[1].path.endsWith('.name'));
      const grouped=external(valid);assert.equal(validateInstructionPlan(grouped).valid,true);
      assert.equal(run(grouped,createFreshRuntimeSnapshot(grouped)).snapshot.status,'halted');
      // Static choice analysis consumes the same accepted arithmetic trees.
      const choice=compileSource('let selected=choose '+Array(depth).fill('1').join('+')+', 2\\nexit');
      assert.deepEqual(choice.diagnostics,[]);
      const waiting=run(choice.plan,createFreshRuntimeSnapshot(choice.plan));assert.equal(waiting.snapshot.status,'waiting');
      deserializeCheckpoint(serializeCheckpoint(createCheckpoint(choice.plan,waiting.snapshot)));
    }
    console.log('all downstream stages and resume passed');
  `;
  const child = spawnSync(
    process.execPath,
    ["--stack-size=256", "--input-type=module", "--eval", script],
    { encoding: "utf8", timeout: 60_000, maxBuffer: 256 * 1024 },
  );
  assert.equal(child.error, undefined);
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout.trim(), "all downstream stages and resume passed");
});

test("expression continuations preserve short circuit, references, RNG, and user-call order", () => {
  const result = assertRuntimeResumeEquivalent(
    [
      "let order=[]",
      "function mark(x) {order.add(x)\nreturn x}",
      "let values=[{value:[1]},{value:[2]}]",
      "values.random.value[0] = mark(7)",
      "let skipped = false and mark(true)",
      "let kept = true or mark(false)",
      'let output = [mark(1), {nested: mark(2) + mark(3)}, "x${mark(4)}"]',
      "say order.length",
      "say order[0]",
      "say output[1].nested",
      "say output[2]",
      "exit",
    ].join("\n"),
    { scenarioName: "expression frames and prepared references", seed: 42 },
  );
  assert.deepEqual(
    result.events.filter((event) => event.kind === "say").map((event) => event.text),
    ["5", "7", "5", "x4"],
  );
});

test("compiler continuations unwind suspended parent cleanup on a child failure", () => {
  const expected = new Error("child failed");
  const order: string[] = [];
  function* child(): CompileTask<void> {
    throw expected;
  }
  function* parent(): CompileTask<void> {
    try {
      yield* compileChild(child());
    } finally {
      order.push("parent cleanup");
    }
  }
  function* root(): CompileTask<void> {
    try {
      yield* compileChild(parent());
    } finally {
      order.push("root cleanup");
    }
  }
  assert.throws(
    () => runCompileTask(root()),
    (error) => error === expected,
  );
  assert.deepEqual(order, ["parent cleanup", "root cleanup"]);
});
