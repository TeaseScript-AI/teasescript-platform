import { isStoredCalendarDurationRecord, isStoredDurationRecord } from "../../duration.js";
import { PERSON_FIELDS } from "../../speaker-terms.js";
import { LOCK_CALLS } from "../../capture-call.js";
import { conversionWaitsForFiles, isConversion } from "../../conversions.js";
import { ANGLE_UNITS, CALENDAR_DURATION_UNITS, DURATION_UNITS } from "../../language-facts.js";
import { dictMethod } from "../../dict-operations.js";
import { listMethod } from "../../list-methods.js";
import { compileRegex, isCanonicalRegexFlags } from "../../regex.js";
import { isPathGlob, packageGlobProblem, packagePathProblem } from "../../project-paths.js";
import { normalizeTagName } from "../../tags.js";
import {
  type PlanValidationError,
  hasExactKeys,
  isRecord,
  isOneOf,
  planError,
  rejectUnknownFields,
  requireString,
  validateSpan,
  fieldsByKind,
  validateTemporaryId,
} from "../validation-support.js";
import { validateOptionalTypeCheck, validateTypePlan } from "./type-plans.js";
import { lazyDefaultArgumentIndex } from "../expression-children.js";

// Expression shapes: each node of an expression tree, object properties, and tag query steps.

export const PROPERTY_FIELDS = ["name", "value", "span"];

/** Fields of expression kinds whose case in validateExpressionNode does not already require exact keys. */
const EXPRESSION_FIELDS = fieldsByKind([
  ["literal", "value"],
  ["regex", "source", "flags"],
  ["identifier", "name"],
  ["debugMode"],
  ["playerProfileField", "name"],
  ["temporary", "temporaryId"],
  ["preparedReference", "temporaryId"],
  ["list", "elements"],
  ["set", "elements"],
  ["object", "properties"],
  ["dict", "entries"],
  ["group", "expression"],
  ["template", "parts"],
  ["property", "object", "name"],
  ["index", "object", "index"],
  ["call", "callee", "arguments", "typeCheck", "indexCheck", "fallbackCheck", "expected"],
  ["unary", "operator", "operand"],
  ["unit", "operand", "calendar", "unit"],
  ["angleUnit", "operand", "unit"],
  ["typeTest", "value", "type", "negated"],
  ["binary", "operator", "left", "right", "fallbackCheck"],
  ["range", "start", "end", "inclusive"],
  ["tagQuery", "catalog", "from", "select", "operands", "steps"],
]);

type ExpressionValidationWork =
  | { value: unknown; path: string; assignmentTarget: boolean }
  | { kind: "property" | "entry"; value: unknown; path: string }
  | {
      kind: "span" | "string" | "inclusive" | "parts" | "arguments" | "part" | "argument";
      value: unknown;
      path: string;
    };

export function validateExpression(
  value: unknown,
  path: string,
  errors: PlanValidationError[],
  assignmentTarget = false,
  temporaryCount = -1,
): void {
  const pending: ExpressionValidationWork[] = [{ value, path, assignmentTarget }];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) return;
    if ("kind" in current) {
      if (current.kind === "span") validateSpan(current.value, current.path, errors);
      else if (current.kind === "string") requireString(current.value, current.path, errors);
      else if (current.kind === "inclusive") {
        if (typeof current.value !== "boolean")
          errors.push(planError("TSC002", "Range inclusivity must be boolean.", current.path));
      } else if (current.kind === "parts" || current.kind === "arguments") {
        if (!Array.isArray(current.value))
          errors.push(
            planError(
              "TSC002",
              current.kind === "parts"
                ? "Template parts must be an array."
                : "Arguments must be an array.",
              current.path,
            ),
          );
        else
          for (let i = current.value.length - 1; i >= 0; i--)
            pending.push({
              kind: current.kind === "parts" ? "part" : "argument",
              value: current.value[i],
              path: `${current.path}[${i}]`,
            });
      } else if (!isRecord(current.value)) {
        errors.push(
          planError(
            "TSC002",
            current.kind === "part"
              ? "Template part must be an object."
              : current.kind === "argument"
                ? "Argument must be an object."
                : current.kind === "entry"
                  ? "Dict entry must be an object."
                  : "Property must be an object.",
            current.path,
          ),
        );
      } else if (current.kind === "part") {
        validateSpan(current.value.span, `${current.path}.span`, errors);
        if (current.value.kind === "text") {
          rejectUnknownFields(current.value, ["kind", "value", "span"], current.path, errors);
          requireString(current.value.value, `${current.path}.value`, errors);
        } else if (current.value.kind === "expression") {
          rejectUnknownFields(current.value, ["kind", "expression", "span"], current.path, errors);
          pending.push({
            value: current.value.expression,
            path: `${current.path}.expression`,
            assignmentTarget: false,
          });
        } else
          errors.push(planError("TSC002", "Unknown template part kind.", `${current.path}.kind`));
      } else if (current.kind === "argument") {
        validateSpan(current.value.span, `${current.path}.span`, errors);
        if (current.value.kind === "named") {
          rejectUnknownFields(
            current.value,
            ["kind", "name", "value", "span"],
            current.path,
            errors,
          );
          requireString(current.value.name, `${current.path}.name`, errors);
        } else if (current.value.kind === "positional")
          rejectUnknownFields(current.value, ["kind", "value", "span"], current.path, errors);
        else errors.push(planError("TSC002", "Unknown argument kind.", `${current.path}.kind`));
        pending.push({
          value: current.value.value,
          path: `${current.path}.value`,
          assignmentTarget: false,
        });
      } else if (current.kind === "entry") {
        rejectUnknownFields(current.value, ["key", "value", "span"], current.path, errors);
        pending.push({ kind: "span", value: current.value.span, path: `${current.path}.span` });
        pending.push({
          value: current.value.value,
          path: `${current.path}.value`,
          assignmentTarget: false,
        });
        pending.push({
          value: current.value.key,
          path: `${current.path}.key`,
          assignmentTarget: false,
        });
      } else {
        rejectUnknownFields(current.value, PROPERTY_FIELDS, current.path, errors);
        requireString(current.value.name, `${current.path}.name`, errors);
        pending.push({ kind: "span", value: current.value.span, path: `${current.path}.span` });
        pending.push({
          value: current.value.value,
          path: `${current.path}.value`,
          assignmentTarget: false,
        });
      }
      continue;
    }
    validateExpressionNode(
      current.value,
      current.path,
      errors,
      current.assignmentTarget,
      temporaryCount,
      pending,
    );
  }
}

function validateExpressionNode(
  value: unknown,
  path: string,
  errors: PlanValidationError[],
  assignmentTarget: boolean,
  temporaryCount: number,
  pending: ExpressionValidationWork[],
): void {
  if (!isRecord(value) || typeof value.kind !== "string") {
    errors.push(planError("TSC002", "Expression must be an object with a kind.", path));
    return;
  }
  validateSpan(value.span, `${path}.span`, errors);
  const fields = EXPRESSION_FIELDS.get(value.kind);
  if (fields !== undefined) rejectUnknownFields(value, fields, path, errors);
  if (assignmentTarget && !["identifier", "property", "index"].includes(value.kind)) {
    errors.push(planError("TSC002", "Invalid assignment target plan.", path));
  }
  switch (value.kind) {
    case "literal":
      if (!isScalar(value.value)) {
        errors.push(
          planError("TSC002", "Literal value must be a finite JSON scalar.", `${path}.value`),
        );
      }
      return;
    case "regex": {
      if (
        typeof value.source !== "string" ||
        typeof value.flags !== "string" ||
        !isCanonicalRegexFlags(value.flags)
      ) {
        errors.push(planError("TSC002", "Regex literal plan is invalid.", path));
        return;
      }
      const compiled = compileRegex(value.source, value.flags);
      if (!compiled.ok)
        errors.push(
          planError("TSC002", `Regex literal plan cannot be used: ${compiled.problem}`, path),
        );
      return;
    }
    case "duration":
      if (!isStoredDurationRecord(value, ["span"])) {
        errors.push(planError("TSC002", "Duration literal plan is invalid.", path));
      }
      return;
    case "calendarDuration":
      if (!isStoredCalendarDurationRecord(value, ["span"])) {
        errors.push(planError("TSC002", "Calendar duration literal plan is invalid.", path));
      }
      return;
    case "identifier":
      requireString(value.name, `${path}.name`, errors);
      return;
    case "debugMode":
      return;
    case "playerProfileField":
      if (typeof value.name !== "string" || !PERSON_FIELDS.has(value.name))
        errors.push(
          planError("TSC002", "Player profile field is not a person field.", `${path}.name`),
        );
      return;
    case "temporary":
    case "preparedReference":
      validateTemporaryId(value.temporaryId, `${path}.temporaryId`, temporaryCount, errors);
      return;
    case "list":
    case "set": {
      const elementsPath = `${path}.elements`;
      if (!Array.isArray(value.elements)) {
        errors.push(planError("TSC002", "Expression list must be an array.", elementsPath));
        return;
      }
      for (let index = value.elements.length - 1; index >= 0; index -= 1) {
        pending.push({
          value: value.elements[index],
          path: `${elementsPath}[${index}]`,
          assignmentTarget: false,
        });
      }
      return;
    }
    case "object":
      if (!Array.isArray(value.properties))
        errors.push(planError("TSC002", "Properties must be an array.", `${path}.properties`));
      else
        for (let index = value.properties.length - 1; index >= 0; index -= 1)
          pending.push({
            kind: "property",
            value: value.properties[index],
            path: `${path}.properties[${index}]`,
          });
      return;
    case "dict":
      if (!Array.isArray(value.entries))
        errors.push(planError("TSC002", "Dict entries must be an array.", `${path}.entries`));
      else
        for (let index = value.entries.length - 1; index >= 0; index -= 1)
          pending.push({
            kind: "entry",
            value: value.entries[index],
            path: `${path}.entries[${index}]`,
          });
      return;
    case "group":
      pending.push({
        value: value.expression,
        path: `${path}.expression`,
        assignmentTarget: false,
      });
      return;
    case "template":
      pending.push({ kind: "parts", value: value.parts, path: `${path}.parts` });
      return;
    case "property":
      pending.push({ kind: "string", value: value.name, path: `${path}.name` });
      pending.push({ value: value.object, path: `${path}.object`, assignmentTarget: false });

      return;
    case "index":
      pending.push({ value: value.index, path: `${path}.index`, assignmentTarget: false });
      pending.push({ value: value.object, path: `${path}.object`, assignmentTarget: false });
      return;
    case "call":
      // `takePhoto()` waits for the Player; it lowers to a capture instruction and is never an ordinary call.
      if (
        isRecord(value.callee) &&
        value.callee.kind === "identifier" &&
        value.callee.name === "takePhoto"
      ) {
        errors.push(
          planError("TSC002", "takePhoto() must be lowered to a capture instruction.", path),
        );
      }
      // The file functions, and a conversion that takes `files:` unless a literal `files: false` keeps files out, may
      // wait for the Player's file store; they lower to a file store instruction.
      if (
        isRecord(value.callee) &&
        value.callee.kind === "identifier" &&
        (value.callee.name === "fileFromBase64" ||
          value.callee.name === "fileToBase64" ||
          value.callee.name === "hashFile" ||
          (typeof value.callee.name === "string" &&
            isConversion(value.callee.name) &&
            conversionWaitsForFiles(value.callee.name, keepsFilesOut(value.arguments))))
      ) {
        errors.push(
          planError(
            "TSC002",
            `${value.callee.name}() must be lowered to a file store instruction.`,
            path,
          ),
        );
      }
      // The encrypt and decrypt calls wait for the Player; they lower to a lock instruction.
      if (
        isRecord(value.callee) &&
        value.callee.kind === "identifier" &&
        typeof value.callee.name === "string" &&
        LOCK_CALLS.has(value.callee.name)
      ) {
        errors.push(
          planError(
            "TSC002",
            `${value.callee.name}() must be lowered to a lock instruction.`,
            path,
          ),
        );
      }
      // `askImage(...)` and `askBooleans(...)` wait for the player; they lower to an interaction.
      if (
        isRecord(value.callee) &&
        value.callee.kind === "identifier" &&
        (value.callee.name === "askImage" || value.callee.name === "askBooleans")
      ) {
        errors.push(
          planError(
            "TSC002",
            `${value.callee.name}() must be lowered to an interaction instruction.`,
            path,
          ),
        );
      }
      validateOptionalTypeCheck(value, path, errors);
      // A call that may decide a list's element type or a dict's value type checks what it adds, or its default, as the
      // compiler gave it (see `ListMethod.decides` and `DictMethod.decides`).
      const decides =
        isRecord(value.callee) && value.callee.kind === "property"
          ? (listMethod(String(value.callee.name))?.decides ??
            dictMethod(String(value.callee.name))?.decides)
          : undefined;
      if (
        "typeCheck" in value &&
        !(
          decides !== undefined &&
          Array.isArray(value.arguments) &&
          (decides === "default"
            ? value.arguments.length === 2 &&
              isRecord(value.arguments[1]) &&
              value.arguments[1].kind === "named" &&
              value.arguments[1].name === "default"
            : value.arguments.length === 1)
        )
      )
        errors.push(
          planError(
            "TSC002",
            "Only a list or set 'add' or list 'addAll' call with one argument, or a list or dict 'get' call with a 'default:', checks a type.",
            `${path}.typeCheck`,
          ),
        );
      if (
        "indexCheck" in value &&
        (value.indexCheck !== true ||
          !isRecord(value.callee) ||
          value.callee.kind !== "property" ||
          value.callee.name !== "get" ||
          !Array.isArray(value.arguments) ||
          !value.arguments.some((argument) => isRecord(argument) && argument.kind === "positional"))
      )
        errors.push(
          planError(
            "TSC002",
            "Only a 'get' call with its index checks its index.",
            `${path}.indexCheck`,
          ),
        );
      validateOptionalTypeCheck(value, path, errors, "fallbackCheck");
      if (
        "fallbackCheck" in value &&
        !(
          isRecord(value.callee) &&
          Array.isArray(value.arguments) &&
          value.arguments.every(isRecord) &&
          lazyDefaultArgumentIndex({ callee: value.callee, arguments: value.arguments }) !== -1
        )
      )
        errors.push(
          planError(
            "TSC002",
            "Only a call with its 'default:' checks the default.",
            `${path}.fallbackCheck`,
          ),
        );
      if ("expected" in value) {
        if (
          !isRecord(value.callee) ||
          value.callee.kind !== "identifier" ||
          value.callee.name !== "fromJson"
        )
          errors.push(
            planError(
              "TSC002",
              "Only a 'fromJson' call reads an expected type.",
              `${path}.expected`,
            ),
          );
        validateTypePlan(value.expected, `${path}.expected`, errors);
      }
      pending.push({ kind: "arguments", value: value.arguments, path: `${path}.arguments` });
      pending.push({ value: value.callee, path: `${path}.callee`, assignmentTarget: false });
      return;
    case "typeTest":
      if (typeof value.negated !== "boolean")
        errors.push(
          planError("TSC002", "A type test needs a boolean 'negated'.", `${path}.negated`),
        );
      validateTypePlan(value.type, `${path}.type`, errors);
      pending.push({ value: value.value, path: `${path}.value`, assignmentTarget: false });
      return;
    case "unary":
      if (!isOneOf(value.operator, ["+", "-", "not"])) {
        errors.push(planError("TSC002", "Invalid unary operator.", `${path}.operator`));
      }
      pending.push({ value: value.operand, path: `${path}.operand`, assignmentTarget: false });
      return;
    case "unit":
      if (
        value.calendar === true
          ? !isOneOf(value.unit, CALENDAR_DURATION_UNITS)
          : value.calendar !== false || !isOneOf(value.unit, DURATION_UNITS)
      )
        errors.push(planError("TSC002", "Duration unit is invalid.", `${path}.unit`));
      pending.push({ value: value.operand, path: `${path}.operand`, assignmentTarget: false });
      return;
    case "angleUnit":
      if (!isOneOf(value.unit, ANGLE_UNITS))
        errors.push(planError("TSC002", "Angle unit is invalid.", `${path}.unit`));
      pending.push({ value: value.operand, path: `${path}.operand`, assignmentTarget: false });
      return;
    case "binary":
      if (!(typeof value.operator === "string" && binaryOperators.has(value.operator))) {
        errors.push(planError("TSC002", "Invalid binary operator.", `${path}.operator`));
      }
      validateOptionalTypeCheck(value, path, errors, "fallbackCheck");
      if ("fallbackCheck" in value && value.operator !== "otherwise")
        errors.push(
          planError("TSC002", "Only 'otherwise' checks a fallback.", `${path}.fallbackCheck`),
        );
      pending.push(
        { value: value.right, path: `${path}.right`, assignmentTarget: false },
        { value: value.left, path: `${path}.left`, assignmentTarget: false },
      );
      return;
    case "range":
      pending.push({ kind: "inclusive", value: value.inclusive, path: `${path}.inclusive` });
      pending.push({ value: value.end, path: `${path}.end`, assignmentTarget: false });
      pending.push({ value: value.start, path: `${path}.start`, assignmentTarget: false });
      return;
    case "tagQuery": {
      if (
        !isOneOf(value.catalog, ["images", "scripts"]) ||
        !isOneOf(value.select, ["random", "list"])
      ) {
        errors.push(
          planError("TSC002", "A tag query searches images or scripts for one or a list.", path),
        );
      }
      // Only a script query limits its files, by a path or glob of the package.
      if (
        value.from !== null &&
        (value.catalog !== "scripts" ||
          typeof value.from !== "string" ||
          (isPathGlob(value.from)
            ? packageGlobProblem(value.from)
            : packagePathProblem(value.from)) !== null)
      ) {
        errors.push(
          planError("TSC002", "A tag query's from is a package path or glob.", `${path}.from`),
        );
      }
      const operandCount = validateTagQuerySteps(value.steps, `${path}.steps`, errors);
      if (!Array.isArray(value.operands) || value.operands.length !== operandCount) {
        errors.push(
          planError(
            "TSC002",
            "A tag query has one operand for each comparison and tag list.",
            `${path}.operands`,
          ),
        );
        return;
      }
      for (let index = value.operands.length - 1; index >= 0; index -= 1) {
        pending.push({
          value: value.operands[index],
          path: `${path}.operands[${index}]`,
          assignmentTarget: false,
        });
      }
      return;
    }
    case "storageLoad":
      if (
        !hasExactKeys(
          value,
          "repair" in value
            ? ["kind", "key", "default", "type", "repair", "span"]
            : ["kind", "key", "default", "type", "span"],
        )
      ) {
        errors.push(planError("TSC002", "Storage-load expression has an invalid shape.", path));
      } else if (value.type !== null) {
        validateTypePlan(value.type, `${path}.type`, errors);
      }
      if (
        "repair" in value &&
        (value.repair !== true || !isRecord(value.type) || value.type.kind !== "object")
      )
        errors.push(
          planError("TSC002", "Only a load of an object type repairs it.", `${path}.repair`),
        );
      if (value.default !== null) {
        pending.push({ value: value.default, path: `${path}.default`, assignmentTarget: false });
      }
      pending.push({ value: value.key, path: `${path}.key`, assignmentTarget: false });
      return;
    default:
      errors.push(planError("TSC002", `Unknown expression kind '${value.kind}'.`, `${path}.kind`));
  }
}

const TAG_COMPARISON_OPERATORS = ["==", "!=", "<", "<=", ">", ">="];

/**
 * Checks that tag query steps form one complete postfix expression, or none. Returns the number of operands the steps
 * read, or -1 when the steps are invalid.
 */
function validateTagQuerySteps(
  value: unknown,
  path: string,
  errors: PlanValidationError[],
): number {
  if (!Array.isArray(value)) {
    errors.push(planError("TSC002", "Tag query steps must be an array.", path));
    return -1;
  }
  let depth = 0;
  let operands = 0;
  for (let index = 0; index < value.length; index += 1) {
    const step: unknown = value[index];
    const stepPath = `${path}[${index}]`;
    let valid = isRecord(step);
    if (isRecord(step)) {
      switch (step.kind) {
        case "tag":
          valid = hasExactKeys(step, ["kind", "name"]) && isCanonicalTagName(step.name);
          depth += 1;
          break;
        case "tagCompare":
          valid =
            hasExactKeys(step, ["kind", "name", "operator"]) &&
            isCanonicalTagName(step.name) &&
            isOneOf(step.operator, TAG_COMPARISON_OPERATORS);
          depth += 1;
          operands += 1;
          break;
        case "tagList":
          valid =
            hasExactKeys(step, ["kind", "option"]) && isOneOf(step.option, ["all", "none", "any"]);
          depth += 1;
          operands += 1;
          break;
        case "not":
          valid = hasExactKeys(step, ["kind"]) && depth >= 1;
          break;
        case "and":
        case "or":
          valid = hasExactKeys(step, ["kind"]) && depth >= 2;
          depth -= 1;
          break;
        default:
          valid = false;
      }
    }
    if (!valid) {
      errors.push(planError("TSC002", "Invalid tag query step.", stepPath));
      return -1;
    }
  }
  if (value.length > 0 && depth !== 1) {
    errors.push(planError("TSC002", "Tag query steps must form one predicate.", path));
    return -1;
  }
  return operands;
}

function isCanonicalTagName(value: unknown): boolean {
  return typeof value === "string" && normalizeTagName(value) === value;
}

function isScalar(value: unknown): boolean {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  );
}

const binaryOperators = new Set([
  "*",
  "/",
  "%",
  "+",
  "-",
  "==",
  "!=",
  "<",
  "<=",
  ">",
  ">=",
  "and",
  "or",
  "in",
  "otherwise",
]);

/** Whether the arguments of a call of a conversion that takes `files:` hold a literal `files: false`. */
function keepsFilesOut(callArguments: unknown): boolean {
  return (
    Array.isArray(callArguments) &&
    callArguments.some(
      (argument) =>
        isRecord(argument) &&
        argument.kind === "named" &&
        argument.name === "files" &&
        isRecord(argument.value) &&
        argument.value.kind === "literal" &&
        argument.value.value === false,
    )
  );
}
