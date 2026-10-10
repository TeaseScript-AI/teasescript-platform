import { compileChild, runCompileTask, type CompileTask } from "../src/compiler/continuation.js";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { run } from "../src/runtime/engine.js";
import { createFreshRuntimeSnapshot } from "../src/runtime/state.js";
import { compileValidPlan } from "./helpers/compile-valid-plan.js";
import { assertRuntimeResumeEquivalent } from "./helpers/runtime-equivalence.js";

test("downstream expression frames traverse each public stage and resume on a constrained stack", () => {
  const api = new URL("../src/index.js", import.meta.url).href;
  const compiler = new URL("../src/compiler/compile-program.js", import.meta.url).href;
  const script = `
    import assert from 'node:assert/strict';
    import {parse,validateSemantics,compileSource,validateInstructionPlan,createFreshRuntimeSnapshot,executeInstruction,run,createCheckpoint,serializeCheckpoint,deserializeCheckpoint} from ${JSON.stringify(api)};
    import {compileStableProgram} from ${JSON.stringify(compiler)};
    const depth=1024;
    const families = [
      ['binary', 'let result='+Array(depth).fill('1').join('+')+'\\nexit', depth],
      // A prepared say makes plan validation index every later payload.
      ['binary after prepared say', 'function value {return 1}\\nsay value(), instant\\nlet result='+Array(depth).fill('1').join('+')+'\\nexit', depth],
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
      // Whether 'bubble' is a mode or a call is decided by parsing ahead, which must not parse nested values again.
      ['say values in calls', 'function bubble(value) {return "x"}\\nlet result=('+'say bubble('.repeat(depth)+'1'+'), instant'.repeat(depth)+').text\\nexit','x'],
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
        stage='partial execution';const partial={snapshot:initial,events:[]};for(let step=0;step<Math.max(1,Math.min(5,Math.floor(plan.files[0].rootEndInstruction/2)));step++){const next=executeInstruction(plan,partial.snapshot);partial.snapshot=next.snapshot;partial.events.push(...next.events);}
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
    assert.equal(rejected.valid,false);
    assert.deepEqual(rejected.errors.map(error=>[error.code,error.path]),[
      ['TSC002','$.instructions[0].value.object'+'.expression'.repeat(depth)+'.kind'],
      ['TSC002','$.instructions[0].value.name'],
    ]);
    const grouped=external(valid);assert.equal(validateInstructionPlan(grouped).valid,true);
    const groupedRun=run(grouped,createFreshRuntimeSnapshot(grouped));
    assert.equal(groupedRun.snapshot.status,'halted');
    assert.equal(groupedRun.snapshot.frames[0].bindings.find(binding=>binding.name==='result').value,1);
    // Static choice analysis consumes the same accepted arithmetic trees.
    const choice=compileSource('let selected=choose '+Array(depth).fill('1').join('+')+', 2\\nexit');
    assert.deepEqual(choice.diagnostics,[]);
    const waiting=run(choice.plan,createFreshRuntimeSnapshot(choice.plan));assert.equal(waiting.snapshot.status,'waiting');
    assert.deepEqual(waiting.snapshot.foregroundAction.ui.options.map(option=>option.text),[String(depth),'2']);
    deserializeCheckpoint(serializeCheckpoint(createCheckpoint(choice.plan,waiting.snapshot)));
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
      'let output = [mark(1), {nested: mark(2) + mark(3)}, {text: "x${mark(4)}"}]',
      "for item in order { say item }",
      "say output[1].nested",
      "say output[2].text",
      "say values[0].value[0]",
      "say values[1].value[0]",
      "exit",
    ].join("\n"),
    { scenarioName: "expression frames and prepared references", seed: 42 },
  );
  const texts = result.events.filter((event) => event.kind === "say").map((event) => event.text);
  assert.deepEqual(texts.slice(0, 7), ["7", "1", "2", "3", "4", "5", "x4"]);
  // `values.random` selects one object; the assignment changes exactly that object.
  assert.ok(
    [
      ["7", "2"],
      ["1", "7"],
    ].some((selected) => selected.join() === texts.slice(7).join()),
    texts.join(),
  );
  // The random target is drawn exactly once, whatever value the seeded generator produces.
  const oneDraw = compileValidPlan("random()\nexit");
  assert.deepEqual(
    result.finalSnapshot.rng,
    run(oneDraw, createFreshRuntimeSnapshot(oneDraw, { seed: 42 })).snapshot.rng,
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
