import type { Expression } from "../../../ast.js";
import { compileChild, type CompileTask } from "../../../compiler/continuation.js";
import { expressionParts, handlerBlocks, unwrap } from "../../../expression-children.js";
import { lazyDefaultArgument } from "../../../lazy-defaults.js";
import { listHasPosition } from "../../../runtime/values/collection-operations.js";
import type { BuildNode, FlowGraphBuilder, WalkContext } from "../flow-graph.js";
import { siteKey } from "./keys.js";
import { literalCount, literalTruth, NON_NULL_LITERALS } from "./literals.js";
import type { FlowNode } from "./model.js";

/** The nodes of `expression` after `current`, in evaluation order; returns the node of its value. */
export function* expressionTask(
  builder: FlowGraphBuilder,
  expression: Expression,
  context: WalkContext,
  current: FlowNode | null,
): CompileTask<FlowNode> {
  const file = context.file;
  const remember = (node: BuildNode): BuildNode => {
    builder.expressionNodes.set(
      siteKey(file, expression.span.start.offset, expression.span.end.offset),
      node,
    );
    return node;
  };
  if (expression.kind === "callExpression") {
    const lazy = lazyDefaultArgument(expression)?.argument;
    let cursor = yield* compileChild(expressionTask(builder, expression.callee, context, current));
    if (expression.presentation !== undefined)
      cursor = yield* compileChild(
        expressionTask(builder, expression.presentation, context, cursor),
      );
    for (const argument of expression.arguments)
      if (argument !== lazy)
        cursor = yield* compileChild(expressionTask(builder, argument.value, context, cursor));
    const callee = unwrap(expression.callee);
    const callIn = builder.own("call-in", context, expression.span);
    builder.link(cursor, callIn);
    const out = remember(builder.own("expression", context, expression.span, { expression }));
    builder.link(callIn, out);
    if (callee.kind === "identifier")
      builder.pendingCalls.push({
        callIn,
        callOut: out,
        name: callee.name,
        file,
        caller: context.region,
        call: expression,
      });
    if (lazy === undefined) return out;
    // P7: a `get` on a list literal with a literal index uses its default exactly when the list has no such position
    // (`listHasPosition`, the runtime's rule: a negative or fractional index takes the default too).
    let runs: "never" | "always" | "maybe" = "maybe";
    if (callee.kind === "propertyAccessExpression" && callee.property.name === "get") {
      const receiver = unwrap(callee.object);
      const index = expression.arguments[0];
      const position = index === undefined ? null : literalCount(index.value);
      if (receiver.kind === "listLiteral" && position !== null)
        runs = listHasPosition(receiver.elements.length, position) ? "never" : "always";
    }
    const accepted = remember(builder.own("default-accepted", context, expression.span));
    if (runs !== "never") {
      const last = yield* compileChild(expressionTask(builder, lazy.value, context, out));
      builder.link(last, accepted);
    } else {
      const first = builder.nodes.length;
      yield* compileChild(expressionTask(builder, lazy.value, context, null));
      builder.joinDead(first, out);
    }
    if (runs !== "always") builder.link(out, accepted);
    return accepted;
  }
  if (
    expression.kind === "binaryExpression" &&
    (expression.operator === "and" ||
      expression.operator === "or" ||
      expression.operator === "otherwise")
  ) {
    if (expression.operator !== "otherwise") builder.logicals.push({ file, expression });
    const left = yield* compileChild(expressionTask(builder, expression.left, context, current));
    // P7: a literal left operand decides whether the right one runs.
    let runs: "never" | "always" | "maybe" = "maybe";
    if (expression.operator === "otherwise") {
      const leftValue = unwrap(expression.left);
      if (leftValue.kind === "nullLiteral") runs = "always";
      else if (NON_NULL_LITERALS.has(leftValue.kind)) runs = "never";
    } else {
      const value = literalTruth(expression.left, builder.truths);
      if (value !== null) runs = value === (expression.operator === "and") ? "always" : "never";
    }
    const node = remember(builder.own("expression", context, expression.span, { expression }));
    if (runs !== "never") {
      const right = yield* compileChild(expressionTask(builder, expression.right, context, left));
      builder.link(right, node);
    } else {
      const first = builder.nodes.length;
      yield* compileChild(expressionTask(builder, expression.right, context, null));
      builder.joinDead(first, left);
    }
    if (runs !== "always") builder.link(left, node);
    return node;
  }
  if (expression.kind === "loadExpression" && expression.defaultValue !== null) {
    const key = yield* compileChild(expressionTask(builder, expression.key, context, current));
    const probe = builder.own("default-probe", context, expression.span);
    builder.link(key, probe);
    const value = yield* compileChild(
      expressionTask(builder, expression.defaultValue, context, probe),
    );
    const node = remember(builder.own("expression", context, expression.span, { expression }));
    builder.link(value, node);
    builder.link(probe, node);
    return node;
  }
  if (expression.kind === "indexExpression")
    builder.indexUses.push({ file, span: expression.span, operand: unwrap(expression.index) });
  if (expression.kind === "dictLiteral")
    for (const entry of expression.entries)
      builder.keyUses.push({ file, span: entry.key.span, operand: unwrap(entry.key) });
  let cursor = current;
  for (const part of expressionParts(expression))
    cursor = yield* compileChild(expressionTask(builder, part, context, cursor));
  const node = remember(builder.own("expression", context, expression.span, { expression }));
  builder.link(cursor, node);
  for (const block of handlerBlocks(expression))
    yield* compileChild(builder.handlerRegion(block, node, context, expression.kind));
  return node;
}
