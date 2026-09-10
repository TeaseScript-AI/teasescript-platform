import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { parse, validateSemantics } from "../src/index.js";
import { assertRuntimeResumeEquivalent } from "./helpers/runtime-equivalence.js";

test("nested statements traverse each stage and resume active scopes on a constrained stack", () => {
  const api = new URL("../src/index.js", import.meta.url).href;
  const compiler = new URL("../src/compiler/compile-program.js", import.meta.url).href;
  const script = String.raw`
    import assert from 'node:assert/strict';
    import * as m from ${JSON.stringify(api)};
    import {compileStableProgram} from ${JSON.stringify(compiler)};
    for (const depth of [256,1024]) {
      for (const family of ['if','else','else if','repeat','for','while','function','mixed']) {
        let prefix='',suffix='',loops=0,scopes=0;
        for (let level=0;level<depth;level++) {
          const kind=(family==='mixed'||family==='function')?['if','repeat','for','while'][level%4]:family;
          let open,close='}\n';
          switch(kind) {
            case 'if': open='if true {\n';scopes++;break;
            case 'else': open='if false {} else {\n';scopes++;break;
            case 'else if': open='if false {} else ';close='';break;
            case 'repeat': open='repeat 1 {\n';loops++;scopes++;break;
            case 'for': open='for item'+level+' in [1] {\n';loops++;scopes++;break;
            case 'while': open='while true {\n';close='break\n}\n';loops++;scopes++;break;
          }
          prefix+=open;suffix=close+suffix;
        }
        let body='result=randomInteger(1..9)\nwait 1\nsay result, instant\n';
        if(family==='else if') body='if true {\n'+body+'}\n';
        let source='let result=0\n'+prefix+body+suffix+'say "done", instant\nexit';
        if(family==='function') source='let result=0\nfunction work {\n'+prefix+body+suffix+'return result\n}\nlet answer=work()\nsay answer, instant\nexit';
        let stage='parse';
        try {
          const parsed=m.parse(source);assert.deepEqual(parsed.diagnostics,[]);
          stage='semantics';assert.deepEqual(m.validateSemantics(parsed.program).diagnostics,[]);
          stage='lowering';const plan=compileStableProgram(parsed.program);
          stage='external plan validation';assert.equal(m.validateInstructionPlan(plan).valid,true);
          stage='public compilation';assert.deepEqual(m.compileSource(source).diagnostics,[]);
          stage='fresh snapshot';const initial=m.createFreshRuntimeSnapshot(plan,{seed:42});
          stage='runtime to innermost wait';const waiting=m.run(plan,initial,{}, {instructionBudget:20000});
          assert.equal(waiting.snapshot.status,'waiting');
          assert.equal(waiting.snapshot.loopFrames.length,loops);
          assert.equal(waiting.snapshot.callFrames.length,family==='function'?1:0);
          assert.ok(waiting.snapshot.frames.length>=scopes+1);
          stage='active checkpoint JSON';const json=m.serializeCheckpoint(m.createCheckpoint(plan,waiting.snapshot));
          const restored=m.deserializeCheckpoint(json);assert.equal(m.serializeCheckpoint(restored),json);
          stage='time observation';const directTime=m.observeTime(plan,waiting.snapshot,1000);
          const resumedTime=m.observeTime(restored.plan,restored.snapshot,1000);
          assert.deepEqual(resumedTime.events,directTime.events);
          stage='resumed runtime';const direct=m.run(plan,directTime.snapshot,{}, {instructionBudget:20000});
          const resumed=m.run(restored.plan,resumedTime.snapshot,{}, {instructionBudget:20000});
          assert.equal(direct.snapshot.status,'halted');assert.equal(resumed.snapshot.status,'halted');
          assert.deepEqual(resumed.events,direct.events);
          assert.equal(m.serializeCheckpoint(m.createCheckpoint(plan,direct.snapshot)),m.serializeCheckpoint(m.createCheckpoint(restored.plan,resumed.snapshot)));
          assert.equal(direct.snapshot.frames[0].bindings.find(binding=>binding.name==='result').value,1);
          assert.deepEqual(direct.events.filter(event=>event.kind==='say').map(event=>event.text),['1',family==='function'?'1':'done']);
        } catch(error) {throw Error(family+':'+depth+' first failed '+stage,{cause:error});}
      }
      // Deep parser recovery and rejected scope paths also finish without native failure.
      const malformed=m.parse('if true {\n'.repeat(depth)+'let value=1');
      assert.equal(malformed.diagnostics.length,depth);
      assert.ok(malformed.diagnostics.every(diagnostic=>diagnostic.code==='TSP007'));
      const badScope=m.parse('let outer=1\n'+'if true {\n'.repeat(depth)+'let outer=2\nmissing=outer\n'+'}\n'.repeat(depth));
      assert.deepEqual(m.validateSemantics(badScope.program).diagnostics.map(diagnostic=>diagnostic.code),['TSV001','TSV003']);
      const nestedFunctions=m.parse('function nested {\n'.repeat(depth)+'return 1\n'+'}\n'.repeat(depth));
      assert.deepEqual(nestedFunctions.diagnostics,[]);
      assert.deepEqual(m.validateSemantics(nestedFunctions.program).diagnostics.map(diagnostic=>diagnostic.code),['TSV016']);
    }
    console.log('all statement stages and active checkpoint resumes passed');
  `;
  const child = spawnSync(
    process.execPath,
    ["--stack-size=256", "--input-type=module", "--eval", script],
    { encoding: "utf8", timeout: 60_000, maxBuffer: 256 * 1024 },
  );
  assert.equal(child.error, undefined);
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout.trim(), "all statement stages and active checkpoint resumes passed");
});

test("statement continuations preserve branches, bindings, loop control, returns, and RNG order", () => {
  const result = assertRuntimeResumeEquivalent(
    [
      "let order=[]",
      "function mark(x) {order.add(x)\nreturn x}",
      "function work(n=mark(2)) {",
      "repeat n {",
      "for item in [1,2,3] {",
      "if item==2 {continue} else if item==3 {break} else {let local=mark(item)}",
      "}",
      "}",
      "let remaining=2",
      "while mark(remaining)>0 {remaining=remaining-1\nif remaining==0 {return randomInteger(1..9)}}",
      "return 99",
      "}",
      "let value=work()",
      "if false {mark(99)} else {let sibling=mark(7)}",
      "if true {let sibling=mark(8)}",
      "say order.length",
      "for entry in order {say entry}",
      "say value",
      "exit",
    ].join("\n"),
    { scenarioName: "statement continuations", seed: 42 },
  );
  assert.deepEqual(
    result.events.filter((event) => event.kind === "say").map((event) => event.text),
    ["7", "2", "1", "1", "2", "1", "7", "8", "1"],
  );
});

test("block diagnostics retain lexical scope and loop/function context", () => {
  const source =
    "let outer=1\nif true {let outer=2\nlet local=1}\nlocal=2\nbreak\nfunction work {while true {break}\ncontinue\nreturn outer}";
  const parsed = parse(source);
  assert.deepEqual(parsed.diagnostics, []);
  const diagnostics = validateSemantics(parsed.program).diagnostics;
  assert.deepEqual(
    diagnostics.map((diagnostic) => diagnostic.code),
    ["TSV001", "TSV003", "TSV008", "TSV008"],
  );
  assert.deepEqual(
    diagnostics.map((diagnostic) =>
      source.slice(diagnostic.span.start.offset, diagnostic.span.end.offset),
    ),
    ["outer", "local", "break", "continue"],
  );
});
