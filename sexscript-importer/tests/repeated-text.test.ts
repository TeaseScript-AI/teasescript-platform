import assert from "node:assert/strict";
import test from "node:test";
import type { IrStatement } from "../src/ir.ts";
import { withoutRepeatedChainText } from "../src/repeated-text.ts";

// A script that starts with a message kept in a handle, as an animation (withMessageHandles), starts with no repeat of
// the text the script before it said last, so that text stays before the transfer.
test("a transfer keeps its last text where the next script first shows an updatable message", () => {
  const span = null;
  const caller: IrStatement[] = [
    { kind: "say", value: { kind: "literal", value: "Ready" }, span },
    { kind: "goto", target: { kind: "file", path: "next.tease" }, span },
  ];
  const target: IrStatement[] = [
    {
      kind: "let",
      name: "line",
      value: { kind: "message", value: { kind: "literal", value: "Loading." }, instant: true },
      span,
    },
    { kind: "say", value: { kind: "literal", value: "Ready" }, span },
    { kind: "exit", span },
  ];
  const [first] = withoutRepeatedChainText(
    [
      { statements: caller, diagnostics: [] },
      { statements: target, diagnostics: [] },
    ],
    ["start.tease", "next.tease"],
  );
  assert.deepEqual(first!.statements, caller);
});
