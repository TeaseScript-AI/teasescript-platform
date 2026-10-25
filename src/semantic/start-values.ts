import type { Expression, GlobalStatement, SpeakerDeclaration } from "../ast.js";
import { expressionChildren } from "../expression-children.js";
import type { SemanticValidator } from "../semantic.js";
import { startValueMessage, startValueOwner } from "../start-value-rules.js";
import { semanticCode } from "./diagnostics.js";
import { unwrapParentheses } from "./expressions.js";
import type { SemanticScope } from "./scope.js";

/**
 * Validates a start value: a global's value at session start, or a speaker property. It runs before the story, so
 * it may use literals, the globals and speakers set up before it, host globals, operators, and `load` (ADR 0022 §6).
 * `contextualSpeaker` is a speaker's own name, which its properties may use.
 */
export function validateStartValue(
  validator: SemanticValidator,
  value: Expression,
  scope: SemanticScope,
  owner: GlobalStatement | SpeakerDeclaration,
  contextualSpeaker: string | null,
): void {
  validator.validateExpression(value, scope, contextualSpeaker);
  const speaker = owner.kind === "speakerDeclaration";
  const subject = startValueOwner(owner);
  const order = validator.project.order(owner);
  const work = [value];
  while (work.length > 0) {
    const expression = work.pop()!;
    switch (expression.kind) {
      case "interactionExpression":
      case "sayExpression":
      case "showButtonExpression":
      case "showPopupExpression":
      case "timerExpression":
      case "playMediaExpression":
      case "showCameraExpression":
      case "showPermanentButtonExpression":
        validator.report(
          semanticCode.invalidStartValue,
          startValueMessage(subject, { kind: "effect" }),
          expression.span,
          true,
        );
        continue;
      case "callExpression":
      case "tagQueryExpression":
        // A script reference is made without effects, like a literal; its arguments follow the same rules.
        if (
          expression.kind === "callExpression" &&
          expression.callee.kind === "identifier" &&
          expression.callee.name === "script"
        ) {
          for (const argument of expression.arguments) work.push(argument.value);
          continue;
        }
        validator.report(
          semanticCode.invalidStartValue,
          startValueMessage(subject, { kind: "call" }),
          expression.span,
          true,
        );
        continue;
      case "identifier": {
        if (expression.name === "speaker" && contextualSpeaker !== null) continue;
        const binding = scope.resolve(expression.name);
        if (binding === undefined || binding.kind === "global" || binding.kind === "function")
          continue;
        const used = binding.project;
        if (used === undefined) {
          const value = owner.kind === "globalStatement" ? unwrapParentheses(owner.initial) : null;
          validator.report(
            semanticCode.invalidStartValue,
            startValueMessage(subject, {
              kind: "local",
              name: expression.name,
              assigned: value?.kind === "identifier" ? value.name : "...",
              defaulted: owner.kind === "globalStatement" && owner.assignment !== null,
            }),
            expression.span,
            true,
          );
        } else if (
          used.order !== null &&
          (used.order > order || (used.order === order && !speaker))
        ) {
          validator.report(
            semanticCode.invalidStartValue,
            startValueMessage(
              subject,
              used.order === order ? { kind: "itself" } : { kind: "later", name: expression.name },
            ),
            expression.span,
            true,
          );
        }
        continue;
      }
      default:
        for (const child of expressionChildren(expression)) work.push(child);
    }
  }
}
