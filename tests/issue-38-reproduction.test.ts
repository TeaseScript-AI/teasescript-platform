import assert from "node:assert/strict";
import test from "node:test";

import { compileSource } from "../src/compiler.js";
import {
  run,
  type RuntimeCapabilities,
} from "../src/runtime/engine.js";
import { createFreshRuntimeSnapshot } from "../src/runtime/state.js";

test("records failing-before evidence for bare builtin identifiers", () => {
  const cases: readonly {
    readonly name: string;
    readonly source: string;
    readonly builtins?: readonly string[];
    readonly capabilities?: RuntimeCapabilities;
  }[] = [
    {
      name: "core",
      source: "let fn = random",
    },
    {
      name: "injected",
      source: "let fn = customBuiltin",
      builtins: ["customBuiltin"],
      capabilities: { builtins: { customBuiltin: () => null } },
    },
  ];
  const evidence: Array<Readonly<Record<string, unknown>>> = [];

  for (const item of cases) {
    const compilation = compileSource(item.source, {
      ...(item.builtins === undefined ? {} : { builtins: item.builtins }),
    });
    assert.deepEqual(compilation.semanticDiagnostics, []);
    assert.notEqual(compilation.plan, null);
    const execution = run(
      compilation.plan!,
      createFreshRuntimeSnapshot(compilation.plan!),
      item.capabilities,
    );
    assert.equal(execution.snapshot.failure?.code, "TSR006");
    evidence.push({
      name: item.name,
      semanticDiagnostics: compilation.semanticDiagnostics.map((diagnostic) => diagnostic.code),
      planReturned: compilation.plan !== null,
      runtimeFailure: execution.snapshot.failure?.code ?? null,
    });
  }

  assert.fail(`Failing-before evidence: ${JSON.stringify(evidence)}`);
});
