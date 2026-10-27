import type { FunctionDeclaration, Statement } from "../../../ast.js";
import { compileChild, type CompileTask } from "../../../compiler/continuation.js";
import {
  expressionChildren,
  handlerBlocks,
  statementExpressions,
  unwrap,
} from "../../../expression-children.js";
import { createSourceSpan } from "../../../source.js";
import { caseValueKey } from "../../../switch-cases.js";
import type { BuildNode, FlowGraphBuilder, WalkContext } from "../flow-graph.js";
import { expressionTask } from "./expressions.js";
import { siteKey } from "./keys.js";
import { literalCollectionRounds, literalRounds, literalTruth } from "./literals.js";
import type { CallSite, FlowNode, FunctionRegion } from "./model.js";

// The statement walk: blocks, each statement's node after its expressions, and the regions of functions.

/**
 * The statements of a block after `current`; returns where the code after them goes on, or `null` when no way leads
 * past them. Statements that no way reaches are built all the same, joined to the code before them by dead edges.
 */
export function* blockTask(
  builder: FlowGraphBuilder,
  statements: readonly Statement[],
  context: WalkContext,
  current: FlowNode | null,
): CompileTask<FlowNode | null> {
  let lastLive = current;
  let deadCursor: FlowNode | null = null;
  for (const statement of statements) {
    if (current === null) {
      if (statement.kind === "labelStatement") {
        // A label after code that does not go on is reached only by a `goto`; until then it is dead code.
        const label = yield* compileChild(statementTask(builder, statement, context, null));
        builder.link(lastLive, label, true);
        current = label;
        deadCursor = null;
        continue;
      }
      const first = builder.nodes.length;
      const next: FlowNode | null = yield* compileChild(
        statementTask(builder, statement, context, deadCursor),
      );
      if (deadCursor === null) builder.joinDead(first, lastLive);
      deadCursor = next;
      continue;
    }
    lastLive = current;
    current = yield* compileChild(statementTask(builder, statement, context, current));
  }
  return current;
}

/** A statement's own node after its expressions. */
export function statementNode(
  builder: FlowGraphBuilder,
  statement: Statement,
  context: WalkContext,
  current: FlowNode | null,
  extra: Partial<Pick<BuildNode, "prepared" | "fallthrough">> = {},
  lookup: Map<string, BuildNode> = builder.statementNodes,
): BuildNode {
  const node = builder.node(
    "statement",
    context.region,
    context.file,
    statement.span,
    context.loops,
    { statement, ...extra },
  );
  lookup.set(siteKey(context.file, statement.span.start.offset, statement.span.end.offset), node);
  builder.link(current, node);
  for (const own of context.own) own.enclosing ??= node;
  return node;
}

function* expressionsThenStatement(
  builder: FlowGraphBuilder,
  statement: Statement,
  context: WalkContext,
  current: FlowNode | null,
): CompileTask<FlowNode> {
  let cursor = current;
  for (const expression of statementExpressions(statement))
    cursor = yield* compileChild(expressionTask(builder, expression, context, cursor));
  return statementNode(builder, statement, context, cursor);
}

function* statementTask(
  builder: FlowGraphBuilder,
  statement: Statement,
  outer: WalkContext,
  current: FlowNode | null,
): CompileTask<FlowNode | null> {
  const context = builder.withOwn(outer);
  const { file, region, loops } = context;
  switch (statement.kind) {
    case "functionDeclaration":
      yield* compileChild(functionRegion(builder, statement, context));
      return current;
    case "globalStatement":
      // The session-start value is in the startup region; with `default:`, the declaration assigns where it stands.
      return statement.assignment === null
        ? current
        : yield* compileChild(statementTask(builder, statement.assignment, context, current));
    case "speakerDeclaration":
      // A speaker is set up at the start of the session (the startup region).
      return current;
    case "assignmentStatement": {
      let cursor = current;
      let prepared: BuildNode | null = null;
      if (statement.target.kind === "identifier") {
        if (statement.operator !== "=") {
          // A compound assignment reads its variable first.
          cursor = yield* compileChild(expressionTask(builder, statement.target, context, cursor));
        }
      } else {
        if (statement.target.kind === "indexExpression")
          builder.indexUses.push({
            file,
            span: statement.target.span,
            operand: unwrap(statement.target.index),
          });
        for (const part of expressionChildren(statement.target))
          cursor = yield* compileChild(expressionTask(builder, part, context, cursor));
        prepared = builder.own("target-prepared", context, statement.target.span);
        builder.link(cursor, prepared);
        cursor = prepared;
      }
      cursor = yield* compileChild(expressionTask(builder, statement.value, context, cursor));
      return statementNode(
        builder,
        statement,
        context,
        cursor,
        prepared === null ? {} : { prepared },
      );
    }
    case "ifStatement": {
      const condition = yield* compileChild(
        expressionTask(builder, statement.condition, context, current),
      );
      const branches: BuildNode[] = [];
      builder.conditionUses.push({
        file,
        span: statement.condition.span,
        operand: unwrap(statement.condition),
        branches,
      });
      const value = literalTruth(statement.condition, builder.truths);
      const join = builder.node("join", region, file, null, loops);
      const thenStart = builder.node("branch", region, file, null, loops);
      branches.push(thenStart);
      builder.link(condition, thenStart, value === false);
      const thenEnd = yield* compileChild(
        blockTask(builder, statement.thenBlock.statements, context, thenStart),
      );
      builder.link(thenEnd, join, value === false);
      if (statement.elseBlock !== null) {
        const elseStart = builder.node("branch", region, file, null, loops);
        branches.push(elseStart);
        builder.link(condition, elseStart, value === true);
        const elseEnd =
          statement.elseBlock.kind === "ifStatement"
            ? yield* compileChild(statementTask(builder, statement.elseBlock, context, elseStart))
            : yield* compileChild(
                blockTask(builder, statement.elseBlock.statements, context, elseStart),
              );
        builder.link(elseEnd, join, value === true);
      } else {
        // §3.2: the way past an `if` without `else` is a branch of its test too, so the code after a branch that always
        // leaves is under the test's negation (the way past dominates it).
        const skip = builder.node("branch", region, file, null, loops);
        branches.push(skip);
        builder.link(condition, skip, value === true);
        builder.link(skip, join, value === true);
      }
      return join;
    }
    case "whileStatement": {
      const head = builder.node("loop-head", region, file, statement.span, loops);
      builder.link(current, head);
      const exit = builder.node("loop-exit", region, file, null, loops);
      const inner = { ...context, loops: [...loops, head], loop: { head, exit } };
      const condition = yield* compileChild(
        expressionTask(builder, statement.condition, inner, head),
      );
      const branches: BuildNode[] = [];
      builder.conditionUses.push({
        file,
        span: statement.condition.span,
        operand: unwrap(statement.condition),
        branches,
      });
      const value = literalTruth(statement.condition, builder.truths);
      const body = builder.node("loop-body", region, file, null, inner.loops);
      branches.push(body);
      builder.link(condition, body, value === false);
      builder.link(condition, exit, value === true);
      builder.loops.push({ statement, head, body, exit });
      const bodyEnd = yield* compileChild(
        blockTask(builder, statement.body.statements, inner, body),
      );
      builder.link(bodyEnd, head);
      return exit;
    }
    case "repeatStatement":
    case "forStatement": {
      const isRepeat = statement.kind === "repeatStatement";
      const counted = yield* compileChild(
        expressionTask(builder, isRepeat ? statement.count : statement.iterable, context, current),
      );
      if (isRepeat)
        builder.countUses.push({ file, span: statement.span, operand: unwrap(statement.count) });
      const rounds = isRepeat
        ? literalRounds(statement.count)
        : literalCollectionRounds(statement.iterable);
      const head = builder.node("loop-head", region, file, statement.span, loops);
      const exit = builder.node("loop-exit", region, file, null, loops);
      const inner = { ...context, loops: [...loops, head], loop: { head, exit } };
      const body = builder.node("loop-body", region, file, null, inner.loops);
      builder.loops.push({ statement, head, body, exit });
      if (statement.kind === "forStatement") {
        builder.loopBindings.set(
          siteKey(file, statement.span.start.offset, statement.span.end.offset),
          body,
        );
        builder.loopBindings.set(
          siteKey(file, statement.iterable.span.start.offset, statement.iterable.span.end.offset),
          body,
        );
      }
      // The head is where a round ends: the body runs again from it, or the loop is left.
      if (rounds === "none") {
        // P7: the body never runs.
        builder.link(counted, exit);
        builder.link(counted, head, true);
        builder.link(head, body);
        const bodyEnd = yield* compileChild(
          blockTask(builder, statement.body.statements, inner, body),
        );
        builder.link(bodyEnd, head);
        return exit;
      }
      if (rounds === "one") {
        // P7: the body runs once; a `continue` ends that round, and with it the loop.
        builder.link(counted, body);
        const bodyEnd = yield* compileChild(
          blockTask(builder, statement.body.statements, inner, body),
        );
        builder.link(bodyEnd, exit);
        builder.link(counted, head, true);
        builder.link(head, exit);
        return exit;
      }
      // P7: a literal count of one or more, or a non-empty literal collection, runs the body before the loop can be left.
      builder.link(counted, rounds === "some" ? body : head);
      builder.link(head, exit);
      builder.link(head, body);
      const bodyEnd = yield* compileChild(
        blockTask(builder, statement.body.statements, inner, body),
      );
      builder.link(bodyEnd, head);
      return exit;
    }
    case "switchStatement": {
      let cursor = current;
      for (const expression of statementExpressions(statement))
        cursor = yield* compileChild(expressionTask(builder, expression, context, cursor));
      const branches: BuildNode[] = [];
      builder.switchUses.push({
        file,
        span: statement.subject.span,
        operand: unwrap(statement.subject),
        branches,
      });
      const join = builder.node("join", region, file, null, loops);
      // P7: a literal subject with literal case values decides the case that runs.
      const subject = caseValueKey(statement.subject);
      let decided = false;
      let allKnown = subject !== undefined;
      for (const switchCase of statement.cases) {
        const values = switchCase.values.map(caseValueKey);
        const known =
          subject !== undefined &&
          switchCase.typeTest === null &&
          values.every((value) => value !== undefined);
        if (!known) allKnown = false;
        const dead = known && (decided || !values.includes(subject));
        if (known && !decided && values.includes(subject)) decided = true;
        const start = builder.node("branch", region, file, null, loops);
        branches.push(start);
        builder.link(cursor, start, dead);
        const end = yield* compileChild(
          blockTask(builder, switchCase.body.statements, context, start),
        );
        builder.link(end, join, dead);
      }
      const noCase = allKnown && decided;
      const start = builder.node("branch", region, file, null, loops);
      branches.push(start);
      builder.link(cursor, start, noCase);
      const end =
        statement.defaultBlock === null
          ? start
          : yield* compileChild(
              blockTask(builder, statement.defaultBlock.statements, context, start),
            );
      builder.link(end, join, noCase);
      return join;
    }
    case "returnStatement": {
      const node = yield* compileChild(
        expressionsThenStatement(builder, statement, context, current),
      );
      if (context.function !== null)
        builder.link(
          node,
          statement.value !== null ? context.function.exit : context.function.void,
        );
      else if (context.handler !== null) builder.link(node, context.handler.exit);
      return null;
    }
    case "breakStatement": {
      const node = statementNode(builder, statement, context, current);
      if (context.loop !== null) {
        builder.link(node, context.loop.exit);
        builder.leftBy.add(context.loop.head);
      }
      return null;
    }
    case "continueStatement": {
      const node = statementNode(builder, statement, context, current);
      if (context.loop !== null) builder.link(node, context.loop.head);
      return null;
    }
    case "exitStatement": {
      const node = statementNode(builder, statement, context, current);
      builder.link(node, builder.program.end);
      return null;
    }
    case "endStatement": {
      // `end` ends the running file: at a file's top level that file; in a function or block whichever file runs it,
      // which the returns of calls take into account (see `decideReturns`).
      const node = statementNode(builder, statement, context, current);
      if (context.function === null && context.handler === null)
        builder.link(node, context.fileRegion?.exit ?? null);
      else builder.ends.push(node);
      return null;
    }
    case "labelStatement": {
      const node = statementNode(builder, statement, context, current, { fallthrough: current });
      builder.labels.set(`${file}:${statement.name.name}`, node);
      if (context.fileRegion !== null) builder.labelled.add(context.fileRegion);
      return node;
    }
    case "gotoStatement":
    case "callFileStatement": {
      if (statement.kind === "gotoStatement") for (const loop of loops) builder.leftBy.add(loop);
      const node = yield* compileChild(
        expressionsThenStatement(builder, statement, context, current),
      );
      const callOut =
        statement.kind === "callFileStatement"
          ? builder.node("call-out", region, file, statement.span, loops)
          : null;
      builder.link(node, callOut);
      builder.pendingTransfers.push({
        node,
        callOut,
        file,
        caller: region,
        target: statement.target,
      });
      return callOut;
    }
    case "letStatement":
    case "expressionStatement":
    case "waitStatement":
    case "sayStatement":
    case "speakerSetterStatement":
    case "showButtonStatement":
    case "timerStatement":
    case "showImageStatement":
    case "hideImageStatement":
    case "showCameraStatement":
    case "hideCameraStatement":
    case "showPopupStatement":
    case "openUrlStatement":
    case "exportTextStatement":
    case "showPermanentButtonStatement":
    case "playMediaStatement":
    case "stopAudioStatement":
    case "saveStatement":
    case "deleteStatement": {
      const node = yield* compileChild(
        expressionsThenStatement(builder, statement, context, current),
      );
      for (const block of handlerBlocks(statement))
        yield* compileChild(builder.handlerRegion(block, node, context, statement.kind));
      return node;
    }
  }
  statement satisfies never;
  return current;
}

/** A function's region: its parameters' bindings, each after its default, then its body. */
function* functionRegion(
  builder: FlowGraphBuilder,
  declaration: FunctionDeclaration,
  context: WalkContext,
): CompileTask<void> {
  const id = builder.regions.length;
  const file = context.file;
  const sites: CallSite[] = [];
  const entry = builder.node("function-entry", id, file, null, []);
  const exit = builder.node(
    "function-exit",
    id,
    file,
    createSourceSpan(declaration.span.end, declaration.span.end),
    [],
  );
  const end = builder.node("function-void", id, file, null, []);
  const parameters = new Map<string, BuildNode>();
  const region: FunctionRegion = {
    kind: "function",
    id,
    file,
    declaration,
    entry,
    exit,
    void: end,
    parameters,
    parent: context.region,
    sites,
  };
  builder.addRegion(region, sites);
  builder.link(end, exit);
  const name = declaration.name.name;
  builder.functions.set(`${file}:${name}`, region);
  if (declaration.global && !builder.globalFunctions.has(name))
    builder.globalFunctions.set(name, region);
  const inner = builder.context(id, file, context.fileRegion, null, region, null, []);
  let cursor: FlowNode = entry;
  for (const parameter of declaration.parameters) {
    const binding = builder.node("parameter", id, file, parameter.span, []);
    parameters.set(parameter.name.name, binding);
    if (parameter.defaultValue !== null) {
      // F21: an omitted argument takes the default, evaluated in the callee; a supplied one skips it.
      const own = builder.withOwn(inner);
      const value = yield* compileChild(
        expressionTask(builder, parameter.defaultValue, own, cursor),
      );
      builder.link(value, binding);
      builder.defaultChoices.push({
        function: region,
        name: parameter.name.name,
        before: cursor,
        binding,
      });
    }
    builder.link(cursor, binding);
    cursor = binding;
  }
  const last = yield* compileChild(blockTask(builder, declaration.body.statements, inner, cursor));
  builder.link(last, end);
}
