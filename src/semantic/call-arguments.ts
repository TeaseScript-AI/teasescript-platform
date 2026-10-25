import {
  argumentCountMessage,
  argumentsTaken,
  leadingArgumentMessage,
  leadingArgumentTwiceMessage,
  missingArgumentMessage,
  unknownNamedArgumentMessage,
} from "../argument-rules.js";
import type {
  ExportTextStatement,
  Expression,
  FunctionDeclaration,
  OpenUrlStatement,
  ShowPopupParts,
} from "../ast.js";
import { IMAGE_REQUEST_OPTIONS } from "../image-input.js";
import {
  EXPORT_TEXT_OPTIONS,
  OPEN_URL_OPTIONS,
  SHOW_POPUP_OPTIONS,
} from "../parser/buttons-and-popups.js";
import type { SemanticValidator } from "../semantic.js";
import { semanticCode } from "./diagnostics.js";

// The arguments of calls: a function's by its parameters, and those of `askImage`, popups, web addresses, and exports.

/**
 * Positional arguments fill parameters from left to right; named arguments that follow them fill parameters by name.
 * Each parameter receives at most one value, and every parameter without a default needs one.
 */
export function validateFunctionCall(
  validator: SemanticValidator,
  expression: Extract<Expression, { kind: "callExpression" }>,
  declaration: FunctionDeclaration,
): void {
  const positional = expression.arguments.filter(
    (argument) => argument.kind === "positionalArgument",
  );
  const named = expression.arguments.filter((argument) => argument.kind === "namedArgument");
  const functionName = declaration.name.name;
  const parameterNames = declaration.parameters.map((parameter) => parameter.name.name);
  const required = declaration.parameters.filter(
    (parameter) => parameter.defaultValue === null,
  ).length;
  if (positional.length > parameterNames.length) {
    validator.report(
      semanticCode.argumentCount,
      argumentCountMessage(
        functionName,
        argumentsTaken(parameterNames, required),
        positional.length,
      ),
      expression.span,
    );
    return;
  }
  if (named.length === 0) {
    if (positional.length < required)
      validator.report(
        semanticCode.argumentCount,
        argumentCountMessage(
          functionName,
          argumentsTaken(parameterNames, required),
          positional.length,
        ),
        expression.span,
      );
    return;
  }
  const indexes = new Map(parameterNames.map((name, index) => [name, index]));
  const supplied = new Set(parameterNames.slice(0, positional.length));
  for (const argument of named) {
    const name = argument.name.name;
    const index = indexes.get(name);
    if (index === undefined) {
      validator.report(
        semanticCode.unknownNamedArgument,
        unknownNamedArgumentMessage(functionName, name, parameterNames, false),
        argument.name.span,
      );
    } else if (index < positional.length) {
      validator.report(
        semanticCode.duplicateNamedArgument,
        `Parameter '${name}' already receives positional argument ${index + 1}. Remove one of the two.`,
        argument.name.span,
      );
    } else if (supplied.has(name)) {
      validator.report(
        semanticCode.duplicateNamedArgument,
        `Argument '${name}' is given twice. Remove one of them.`,
        argument.name.span,
      );
    }
    supplied.add(name);
  }
  for (const parameter of declaration.parameters) {
    if (parameter.defaultValue === null && !supplied.has(parameter.name.name)) {
      validator.report(
        semanticCode.missingNamedArgument,
        missingArgumentMessage(
          functionName,
          `a value for '${parameter.name.name}'`,
          `Add it by position or as '${parameter.name.name}: ...'.`,
        ),
        expression.span,
      );
    }
  }
}

/** Reports a parameter name given twice in a call whose parameters only the callee knows. */
/**
 * `askImage(...)` takes its message first, positionally or as `message:`, and the named options of V30 §20. The
 * invalid-input options are not supported yet.
 */
export function validateAskImageArguments(
  validator: SemanticValidator,
  expression: Extract<Expression, { kind: "callExpression" }>,
): void {
  let message = false;
  for (const [index, argument] of expression.arguments.entries()) {
    if (argument.kind === "positionalArgument") {
      if (index > 0 || message)
        validator.report(
          semanticCode.argumentCount,
          leadingArgumentMessage(
            "askImage",
            "its message",
            'askImage("Add an image", allowCamera: false)',
          ),
          argument.span,
        );
      message = true;
      continue;
    }
    const name = argument.name.name;
    if (name === "message") {
      if (message)
        validator.report(
          semanticCode.argumentCount,
          leadingArgumentTwiceMessage("askImage", "message"),
          argument.name.span,
        );
      message = true;
    } else if (name === "invalidMessage" || name === "invalidLlmInstruction") {
      validator.report(
        semanticCode.unknownNamedArgument,
        `askImage(${name}:) is not supported yet.`,
        argument.name.span,
      );
    } else if (!IMAGE_REQUEST_OPTIONS.has(name)) {
      validator.report(
        semanticCode.unknownNamedArgument,
        unknownNamedArgumentMessage("askImage", name, ["message", ...IMAGE_REQUEST_OPTIONS]),
        argument.name.span,
      );
    }
  }
}

/**
 * `showPopup` takes its message first, without a name or as `message:`, and an optional `buttonText:` (V30 §31). A
 * repeated name is reported with the other arguments.
 */
export function validateShowPopupArguments(
  validator: SemanticValidator,
  parts: ShowPopupParts,
): void {
  validateDistinctNamedArguments(validator, parts);
  let message = false;
  for (const [index, argument] of parts.arguments.entries()) {
    if (argument.kind === "positionalArgument") {
      if (index > 0 || message)
        validator.report(
          semanticCode.argumentCount,
          leadingArgumentMessage(
            "showPopup",
            "its message",
            'showPopup("Task completed", buttonText: "Continue")',
          ),
          argument.span,
        );
      message = true;
      continue;
    }
    const name = argument.name.name;
    if (name === "message") {
      if (message)
        validator.report(
          semanticCode.argumentCount,
          leadingArgumentTwiceMessage("showPopup", "message"),
          argument.name.span,
        );
      message = true;
    } else if (!SHOW_POPUP_OPTIONS.includes(name)) {
      validator.report(
        semanticCode.unknownNamedArgument,
        unknownNamedArgumentMessage("showPopup", name, ["message", ...SHOW_POPUP_OPTIONS]),
        argument.name.span,
      );
    }
  }
  if (!message)
    validator.report(
      semanticCode.missingNamedArgument,
      missingArgumentMessage(
        "showPopup",
        "a message",
        `Give it first, as in 'showPopup "Task completed"'.`,
      ),
      parts.span,
    );
}

/**
 * `openUrl` takes one web address without a name, first, and the optional `buttonText:` and `alwaysButton:` (V30
 * §33). A repeated name is reported with the other arguments.
 */
export function validateOpenUrlArguments(
  validator: SemanticValidator,
  statement: OpenUrlStatement,
): void {
  validateDistinctNamedArguments(validator, statement);
  const addresses = statement.arguments.filter(
    (argument) => argument.kind === "positionalArgument",
  );
  const addressed = addresses.length === 1 && statement.arguments[0]?.kind === "positionalArgument";
  if (!addressed)
    validator.report(
      semanticCode.argumentCount,
      leadingArgumentMessage(
        "openUrl",
        "one web address",
        'openUrl("https://example.com", buttonText: "Open the page")',
      ),
      statement.span,
    );
  for (const argument of statement.arguments)
    if (
      argument.kind === "namedArgument" &&
      !OPEN_URL_OPTIONS.includes(argument.name.name) &&
      // A named address without a positional one is the error above.
      (addressed || argument.name.name !== "url")
    )
      validator.report(
        semanticCode.unknownNamedArgument,
        unknownNamedArgumentMessage("openUrl", argument.name.name, OPEN_URL_OPTIONS),
        argument.name.span,
      );
}

/**
 * `exportText` takes one text without a name, first, and the optional `title:` and `fileName:` (V30 §31). A repeated
 * name is reported with the other arguments.
 */
export function validateExportTextArguments(
  validator: SemanticValidator,
  statement: ExportTextStatement,
): void {
  validateDistinctNamedArguments(validator, statement);
  const texts = statement.arguments.filter((argument) => argument.kind === "positionalArgument");
  const given = texts.length === 1 && statement.arguments[0]?.kind === "positionalArgument";
  if (!given)
    validator.report(
      semanticCode.argumentCount,
      leadingArgumentMessage("exportText", "one text", 'exportText(report, title: "Your report")'),
      statement.span,
    );
  for (const argument of statement.arguments)
    if (
      argument.kind === "namedArgument" &&
      !EXPORT_TEXT_OPTIONS.includes(argument.name.name) &&
      // A named text without a positional one is the error above.
      (given || argument.name.name !== "text")
    )
      validator.report(
        semanticCode.unknownNamedArgument,
        unknownNamedArgumentMessage("exportText", argument.name.name, EXPORT_TEXT_OPTIONS),
        argument.name.span,
      );
}

export function validateDistinctNamedArguments(
  validator: SemanticValidator,
  expression: Pick<Extract<Expression, { kind: "callExpression" }>, "arguments">,
): void {
  const names = new Set<string>();
  for (const argument of expression.arguments) {
    if (argument.kind !== "namedArgument") continue;
    if (names.has(argument.name.name))
      validator.report(
        semanticCode.duplicateNamedArgument,
        `Argument '${argument.name.name}' is given twice. Remove one of them.`,
        argument.name.span,
      );
    names.add(argument.name.name);
  }
}
