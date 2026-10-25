import type {
  Expression,
  TagQueryExpression,
  TypeTestExpression,
  UnitExpression,
} from "../../ast.js";
import type { SourceSpan } from "../../source.js";
import type {
  ExpressionPlan,
  TemplatePartPlan,
  TypeCheckPlan,
  PlanSourceLocation,
  TagQueryExpressionPlan,
  UnitPlan,
} from "../../plan/model.js";
import { canonicalRegexFlags } from "../../regex.js";
import { sourceSpanToPlanLocation } from "../../plan/source-location.js";
import {
  isAskImageCall,
  isFileStoreCall,
  isLockCall,
  isTakePhotoCall,
} from "../../capture-call.js";
import { durationLiteralValue } from "../../duration.js";
import type { RuntimeCheckSite } from "../../type-inference/backend.js";
import { typeFromAnnotation } from "../../static-types/annotations.js";
import { typePlan } from "../../type-plans.js";
import {
  expressionChildren as instructionEmissionChildren,
  tagQueryOperands,
} from "../../expression-children.js";

// Expression plans: one plan for an expression that runs no instructions, and the plan parts the lowering modules use.

/** Whether `expression` is the protected `playerProfile`, which no binding can have as its name. */
export function isPlayerProfile(expression: Expression): boolean {
  const node = unwrapParentheses(expression);
  return node.kind === "identifier" && node.name === "playerProfile";
}

export function unwrapParentheses(expression: Expression): Expression {
  let current = expression;
  while (current.kind === "parenthesizedExpression") current = current.expression;
  return current;
}

export function normalizeUnaryExpression(
  expression: Extract<Expression, { kind: "unaryExpression" }>,
): {
  readonly operand: Expression;
  readonly operators: readonly Extract<Expression, { kind: "unaryExpression" }>["operator"][];
} {
  let current: Expression = expression;
  if (expression.operator === "not") {
    let count = 0;
    while (true) {
      current = unwrapParentheses(current);
      if (current.kind !== "unaryExpression" || current.operator !== "not") break;
      count += 1;
      current = current.operand;
    }
    return { operand: current, operators: count % 2 === 0 ? ["not", "not"] : ["not"] };
  }

  let negate = false;
  while (true) {
    current = unwrapParentheses(current);
    if (
      current.kind !== "unaryExpression" ||
      (current.operator !== "+" && current.operator !== "-")
    )
      break;
    if (current.operator === "-") negate = !negate;
    current = current.operand;
  }
  return { operand: current, operators: [negate ? "-" : "+"] };
}

export function compileExpression(
  expression: Expression,
  typeChecks: ReadonlyMap<RuntimeCheckSite, TypeCheckPlan>,
): ExpressionPlan {
  const plans = new WeakMap<Expression, ExpressionPlan>();
  const work: { expression: Expression; expanded: boolean }[] = [{ expression, expanded: false }];
  while (work.length) {
    const frame = work.pop()!;
    const current = unwrapParentheses(frame.expression);
    if (frame.expanded) {
      plans.set(current, assembleExpression(current, child, typeChecks));
      continue;
    }
    if (plans.has(current)) continue;
    work.push({ expression: current, expanded: true });
    const children =
      current.kind === "unaryExpression"
        ? [normalizeUnaryExpression(current).operand]
        : instructionEmissionChildren(current);
    for (let i = children.length - 1; i >= 0; i--)
      work.push({ expression: children[i]!, expanded: false });
  }
  return child(expression);
  function child(expression: Expression): ExpressionPlan {
    return plans.get(unwrapParentheses(expression))!;
  }
}

/** The optional `typeCheck` field of a receiving instruction or plan, present only when the value is checked. */
export function withTypeCheck(typeCheck: TypeCheckPlan | undefined): { typeCheck?: TypeCheckPlan } {
  return typeCheck === undefined ? {} : { typeCheck };
}

/** The unit of a unit expression, which the plan keeps as written, with or without `calendar`. */
export function unitOf(expression: UnitExpression): UnitPlan {
  return expression.calendar
    ? { calendar: true, unit: expression.unit }
    : { calendar: false, unit: expression.unit };
}

/** The plan location of a source span, as the plan keeps every span. */
export function planSpan(span: SourceSpan): PlanSourceLocation {
  return sourceSpanToPlanLocation(span);
}

function assembleExpression(
  expression: Expression,
  child: (expression: Expression) => ExpressionPlan,
  typeChecks: ReadonlyMap<RuntimeCheckSite, TypeCheckPlan>,
): ExpressionPlan {
  switch (expression.kind) {
    case "booleanLiteral":
    case "nullLiteral":
    case "numberLiteral":
      return { kind: "literal", value: expression.value, span: planSpan(expression.span) };
    case "regexLiteral":
      return {
        kind: "regex",
        source: expression.source,
        flags: canonicalRegexFlags(expression.flags),
        span: planSpan(expression.span),
      };
    case "durationLiteral": {
      const value = durationLiteralValue(expression);
      // The type checker rejects a calendar amount that is not whole before lowering.
      if (typeof value === "string") throw new Error(`Invalid duration literal: ${value}.`);
      return { ...value, span: planSpan(expression.span) };
    }
    case "stringLiteral":
      return expression.parts.some((part) => part.kind === "stringInterpolation")
        ? {
            kind: "template",
            parts: expression.parts.flatMap((part): TemplatePartPlan[] =>
              part.kind === "stringText"
                ? part.value.length === 0
                  ? []
                  : [{ kind: "text", value: part.value, span: planSpan(part.span) }]
                : [
                    {
                      kind: "expression",
                      expression: child(part.expression),
                      span: planSpan(part.span),
                    },
                  ],
            ),
            span: planSpan(expression.span),
          }
        : {
            kind: "literal",
            value: expression.parts
              .map((part) => (part.kind === "stringText" ? part.value : ""))
              .join(""),
            span: planSpan(expression.span),
          };
    case "identifier":
      // `debugMode` is protected, so no binding can have its name.
      if (expression.name === "debugMode")
        return { kind: "debugMode", span: planSpan(expression.span) };
      return { kind: "identifier", name: expression.name, span: planSpan(expression.span) };
    case "parenthesizedExpression":
      return child(expression.expression);
    case "listLiteral":
    case "setLiteral":
      return {
        kind: expression.kind === "setLiteral" ? "set" : "list",
        elements: expression.elements.map(child),
        span: planSpan(expression.span),
      };
    case "objectLiteral":
      return {
        kind: "object",
        properties: expression.properties.map((property) => ({
          name: property.name.name,
          value: child(property.value),
          span: planSpan(property.span),
        })),
        span: planSpan(expression.span),
      };
    case "dictLiteral":
      return {
        kind: "dict",
        entries: expression.entries.map((entry) => ({
          key: child(entry.key),
          value: child(entry.value),
          span: planSpan(entry.span),
        })),
        span: planSpan(expression.span),
      };
    case "propertyAccessExpression":
      if (isPlayerProfile(expression.object))
        return {
          kind: "playerProfileField",
          name: expression.property.name,
          span: planSpan(expression.span),
        };
      return {
        kind: "property",
        object: child(expression.object),
        name: expression.property.name,
        span: planSpan(expression.span),
      };
    case "indexExpression":
      return {
        kind: "index",
        object: child(expression.object),
        index: child(expression.index),
        span: planSpan(expression.span),
      };
    case "callExpression":
      if (isTakePhotoCall(expression))
        throw new TypeError("takePhoto() reached pure expression assembly.");
      if (isAskImageCall(expression))
        throw new TypeError("askImage() reached pure expression assembly.");
      if (isFileStoreCall(expression))
        throw new TypeError("A file store call reached pure expression assembly.");
      if (isLockCall(expression))
        throw new TypeError("A lock call reached pure expression assembly.");
      return {
        kind: "call",
        callee: child(expression.callee),
        arguments: expression.arguments.map((argument) =>
          argument.kind === "positionalArgument"
            ? { kind: "positional", value: child(argument.value), span: planSpan(argument.span) }
            : {
                kind: "named",
                name: argument.name.name,
                value: child(argument.value),
                span: planSpan(argument.span),
              },
        ),
        ...withTypeCheck(typeChecks.get(expression)),
        span: planSpan(expression.span),
      };
    case "unaryExpression": {
      const normalized = normalizeUnaryExpression(expression);
      let plan = child(normalized.operand);
      for (let index = normalized.operators.length - 1; index >= 0; index -= 1) {
        plan = {
          kind: "unary",
          operator: normalized.operators[index]!,
          operand: plan,
          span: planSpan(expression.span),
        };
      }
      return plan;
    }
    case "unitExpression":
      return {
        kind: "unit",
        operand: child(expression.operand),
        ...unitOf(expression),
        span: planSpan(expression.span),
      };
    case "angleExpression":
      return {
        kind: "angleUnit",
        operand: child(expression.operand),
        unit: expression.unit,
        span: planSpan(expression.span),
      };
    case "binaryExpression":
      return {
        kind: "binary",
        operator: expression.operator,
        left: child(expression.left),
        right: child(expression.right),
        span: planSpan(expression.span),
      };
    case "rangeExpression":
      return {
        kind: "range",
        start: child(expression.start),
        end: child(expression.end),
        inclusive: expression.inclusive,
        span: planSpan(expression.span),
      };
    case "loadExpression":
      return {
        kind: "storageLoad",
        key: child(expression.key),
        default: expression.defaultValue === null ? null : child(expression.defaultValue),
        type: typeChecks.get(expression)?.type ?? null,
        span: planSpan(expression.span),
      };
    case "tagQueryExpression":
      return tagQueryPlan(expression, tagQueryOperands(expression).map(child));
    case "interactionExpression":
    case "sayExpression":
    case "showButtonExpression":
    case "showPopupExpression":
    case "timerExpression":
    case "playMediaExpression":
    case "showCameraExpression":
    case "showPermanentButtonExpression":
      throw new TypeError(
        "Messages, interactions, timers, media, camera views, and permanent buttons must be lowered before expression-plan compilation.",
      );
    case "typeTestExpression":
      return typeTestPlan(expression, child(expression.value));
  }
}

export function tagQueryPlan(
  expression: TagQueryExpression,
  operands: readonly ExpressionPlan[],
): TagQueryExpressionPlan {
  return {
    kind: "tagQuery",
    catalog: expression.catalog,
    from: expression.from?.pattern ?? null,
    select: expression.select,
    operands: [...operands],
    steps: expression.steps.map((step) =>
      step.kind === "tag"
        ? { kind: "tag", name: step.name }
        : step.kind === "tagCompare"
          ? { kind: "tagCompare", name: step.name, operator: step.operator }
          : step.kind === "tagList"
            ? { kind: "tagList", option: step.option }
            : { kind: step.kind },
    ),
    span: planSpan(expression.span),
  };
}

/**
 * `value is T` or `value is not T`, from a type test expression or a `case is T`. A type the runtime cannot narrow down,
 * which no written type is, makes the test constant.
 */
export function typeTestPlan(
  expression: Pick<TypeTestExpression, "type" | "negated" | "span">,
  value: ExpressionPlan,
): ExpressionPlan {
  const type = typePlan(typeFromAnnotation(expression.type));
  return type === null
    ? { kind: "literal", value: !expression.negated, span: planSpan(expression.span) }
    : {
        kind: "typeTest",
        value,
        type,
        negated: expression.negated,
        span: planSpan(expression.span),
      };
}
