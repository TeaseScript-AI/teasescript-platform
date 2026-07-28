import type { Program } from "./ast.js";
import {
  createDiagnostic,
  DiagnosticSeverity,
  type Diagnostic,
} from "./diagnostics.js";
import {
  createCapturedArray,
  EXTERNAL_DATA_DEPTH_MESSAGE,
  EXTERNAL_DATA_WORK_MESSAGE,
  MAX_EXTERNAL_RUNTIME_DATA_DEPTH,
  MAX_EXTERNAL_RUNTIME_DATA_WORK,
} from "./external-data-limits.js";
import {
  createSourcePosition,
  createSourceSpan,
  type SourceSpan,
} from "./source.js";

export const AST_VALIDATION_CODES = {
  nonFiniteNumericLiteral: "TSC001",
  invalidExternalAst: "TSC005",
} as const;

export interface CapturedProgramAstResult {
  readonly program: Program | null;
  readonly diagnostic: Diagnostic | null;
}

interface AssignmentTarget {
  readonly container: unknown[] | Record<string, unknown>;
  readonly key: string;
}

type WorkItem =
  | {
      readonly kind: "visit";
      readonly value: unknown;
      readonly depth: number;
      readonly target: AssignmentTarget | null;
    }
  | {
      readonly kind: "leave";
      readonly source: object;
      readonly captured: object;
    };

const FALLBACK_SPAN = createSourceSpan(
  createSourcePosition(0, 0, 0),
  createSourcePosition(0, 0, 0),
);

/**
 * Captures direct caller-supplied AST data before any recursive AST,
 * semantic, or lowering traversal. Numeric values remain numbers even
 * when non-finite so the established TSC001 literal diagnostic retains
 * priority after stable capture.
 */
export function captureProgramAst(value: unknown): CapturedProgramAstResult {
  const active = new Set<object>();
  const work = createCapturedArray(0) as WorkItem[];
  work.push({ kind: "visit", value, depth: 0, target: null });
  let visited = 0;
  let capturedRoot: unknown;

  while (work.length > 0) {
    const item = work.pop()!;
    if (item.kind === "leave") {
      active.delete(item.source);
      Object.freeze(item.captured);
      continue;
    }

    visited += 1;
    if (visited > MAX_EXTERNAL_RUNTIME_DATA_WORK) {
      return captureFailure(EXTERNAL_DATA_WORK_MESSAGE);
    }
    if (item.depth > MAX_EXTERNAL_RUNTIME_DATA_DEPTH) {
      return captureFailure(EXTERNAL_DATA_DEPTH_MESSAGE);
    }

    const current = item.value;
    if (
      current === null ||
      typeof current === "string" ||
      typeof current === "boolean" ||
      typeof current === "number"
    ) {
      assignCaptured(item.target, current, (root) => {
        capturedRoot = root;
      });
      continue;
    }
    if (typeof current !== "object") {
      return captureFailure("Direct AST input must contain only stable data values.");
    }
    if (active.has(current)) {
      return captureFailure("Direct AST input contains a cycle.");
    }

    let array: boolean;
    try {
      array = Array.isArray(current);
    } catch {
      return captureFailure("Direct AST input contains an unstable object.");
    }

    if (array) {
      const captured = captureArrayHeader(current);
      if (captured === null) {
        return captureFailure("Direct AST arrays must be dense stable data arrays.");
      }
      assignCaptured(item.target, captured.output, (root) => {
        capturedRoot = root;
      });
      active.add(current);
      work.push({ kind: "leave", source: current, captured: captured.output });
      for (let index = captured.values.length - 1; index >= 0; index -= 1) {
        work.push({
          kind: "visit",
          value: captured.values[index],
          depth: item.depth + 1,
          target: { container: captured.output, key: String(index) },
        });
      }
      continue;
    }

    let prototype: object | null;
    let keys: readonly (string | symbol)[];
    try {
      prototype = Reflect.getPrototypeOf(current);
      keys = Reflect.ownKeys(current);
    } catch {
      return captureFailure("Direct AST input contains an unstable object.");
    }
    if (prototype !== Object.prototype && prototype !== null) {
      return captureFailure("Direct AST input must contain only plain objects and arrays.");
    }
    if (keys.length > MAX_EXTERNAL_RUNTIME_DATA_WORK) {
      return captureFailure(EXTERNAL_DATA_WORK_MESSAGE);
    }

    const captured = Object.create(null) as Record<string, unknown>;
    const values = createCapturedArray(0) as Array<readonly [string, unknown]>;
    for (const key of keys) {
      if (typeof key === "symbol") {
        return captureFailure("Direct AST input may not contain symbol properties.");
      }
      let descriptor: PropertyDescriptor | undefined;
      try {
        descriptor = Reflect.getOwnPropertyDescriptor(current, key);
      } catch {
        return captureFailure("Direct AST input contains an unstable object.");
      }
      if (
        descriptor === undefined ||
        !descriptor.enumerable ||
        !("value" in descriptor)
      ) {
        return captureFailure("Direct AST input may contain only enumerable data properties.");
      }
      values.push([key, descriptor.value]);
    }

    assignCaptured(item.target, captured, (root) => {
      capturedRoot = root;
    });
    active.add(current);
    work.push({ kind: "leave", source: current, captured });
    for (let index = values.length - 1; index >= 0; index -= 1) {
      const [key, nested] = values[index]!;
      work.push({
        kind: "visit",
        value: nested,
        depth: item.depth + 1,
        target: { container: captured, key },
      });
    }
  }

  if (!isProgramRoot(capturedRoot)) {
    return captureFailure("Direct AST input must be a valid program-shaped object.");
  }
  return Object.freeze({
    program: capturedRoot as Program,
    diagnostic: null,
  });
}

/** Returns compiler diagnostics for numeric literals that cannot enter JSON-safe plans. */
export function findNonFiniteNumericLiteralDiagnostics(
  program: Program,
): readonly Diagnostic[] {
  const capture = captureProgramAst(program);
  if (capture.program === null) {
    return Object.freeze([capture.diagnostic!]);
  }

  return findNonFiniteNumericLiteralDiagnosticsInCapturedProgram(capture.program);
}

/** Internal traversal for parser-owned or already captured AST data. */
export function findNonFiniteNumericLiteralDiagnosticsInCapturedProgram(
  program: Program,
): readonly Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const work = createCapturedArray(0) as unknown[];
  work.push(program);
  while (work.length > 0) {
    const value = work.pop();
    if (value === null || typeof value !== "object") continue;
    if (Array.isArray(value)) {
      for (let index = value.length - 1; index >= 0; index -= 1) {
        work.push(value[index]);
      }
      continue;
    }
    const node = value as {
      readonly kind?: unknown;
      readonly value?: unknown;
      readonly span?: unknown;
    };
    if (
      node.kind === "numberLiteral" &&
      typeof node.value === "number" &&
      !Number.isFinite(node.value)
    ) {
      diagnostics.push(
        createDiagnostic(
          DiagnosticSeverity.Error,
          AST_VALIDATION_CODES.nonFiniteNumericLiteral,
          "Numeric literal must evaluate to a finite number.",
          isSourceSpan(node.span) ? node.span : FALLBACK_SPAN,
        ),
      );
      continue;
    }
    for (const nested of Object.values(value)) work.push(nested);
  }
  return Object.freeze(diagnostics);
}

function captureArrayHeader(
  value: object,
): { readonly output: unknown[]; readonly values: readonly unknown[] } | null {
  let lengthDescriptor: PropertyDescriptor | undefined;
  let keys: readonly (string | symbol)[];
  try {
    lengthDescriptor = Reflect.getOwnPropertyDescriptor(value, "length");
    keys = Reflect.ownKeys(value);
  } catch {
    return null;
  }
  if (
    lengthDescriptor === undefined ||
    !("value" in lengthDescriptor) ||
    typeof lengthDescriptor.value !== "number" ||
    !Number.isSafeInteger(lengthDescriptor.value) ||
    lengthDescriptor.value < 0 ||
    lengthDescriptor.value > MAX_EXTERNAL_RUNTIME_DATA_WORK ||
    keys.length !== lengthDescriptor.value + 1
  ) {
    return null;
  }

  const length = lengthDescriptor.value;
  const values = createCapturedArray(length);
  const seen = new Set<number>();
  for (const key of keys) {
    if (key === "length") continue;
    if (typeof key !== "string" || !/^(0|[1-9]\d*)$/.test(key)) return null;
    const index = Number(key);
    if (!Number.isSafeInteger(index) || index < 0 || index >= length || seen.has(index)) {
      return null;
    }
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Reflect.getOwnPropertyDescriptor(value, key);
    } catch {
      return null;
    }
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      !("value" in descriptor)
    ) {
      return null;
    }
    seen.add(index);
    Reflect.defineProperty(values, key, {
      value: descriptor.value,
      writable: true,
      enumerable: true,
      configurable: true,
    });
  }
  if (seen.size !== length) return null;
  return { output: createCapturedArray(length), values };
}

function assignCaptured(
  target: AssignmentTarget | null,
  value: unknown,
  setRoot: (value: unknown) => void,
): void {
  if (target === null) {
    setRoot(value);
    return;
  }
  Reflect.defineProperty(target.container, target.key, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  });
}

function captureFailure(message: string): CapturedProgramAstResult {
  return Object.freeze({
    program: null,
    diagnostic: createDiagnostic(
      DiagnosticSeverity.Error,
      AST_VALIDATION_CODES.invalidExternalAst,
      message,
      FALLBACK_SPAN,
    ),
  });
}

function isProgramRoot(value: unknown): value is Program {
  return isPlainRecord(value) &&
    value.kind === "program" &&
    Array.isArray(value.statements) &&
    isSourceSpan(value.span) &&
    validInteractionAstShapes(value);
}

function validInteractionAstShapes(root: Record<string, unknown>): boolean {
  const work = createCapturedArray(1);
  Reflect.defineProperty(work, "0", { value: root, writable: true, enumerable: true, configurable: true });
  while (work.length > 0) {
    const value = work.pop();
    if (value === null || typeof value !== "object") continue;
    if (Array.isArray(value)) {
      for (const item of value) work.push(item);
      continue;
    }
    if (!isPlainRecord(value)) return false;
    if (value.kind === "showButtonStatement") {
      if (
        !isSourceSpan(value.commandSpan) ||
        !(value.asSpan === null || isSourceSpan(value.asSpan)) ||
        !(value.speaker === null || isIdentifierNode(value.speaker)) ||
        !isAstNode(value.label) ||
        !isSourceSpan(value.span)
      ) return false;
    } else if (value.kind === "interactionExpression") {
      if (
        !["text", "number", "choice"].includes(String(value.interactionKind)) ||
        !isSourceSpan(value.commandSpan) ||
        !(value.asSpan === null || isSourceSpan(value.asSpan)) ||
        !(value.speaker === null || isIdentifierNode(value.speaker)) ||
        !(value.hint === null || isAstNode(value.hint)) ||
        !Array.isArray(value.options) ||
        !value.options.every(isInteractionChoiceOptionNode) ||
        !isSourceSpan(value.span) ||
        (value.interactionKind === "choice" ? value.hint !== null : value.options.length !== 0)
      ) return false;
    } else if (value.kind === "interactionChoiceOption" && !isInteractionChoiceOptionNode(value)) {
      return false;
    }
    for (const nested of Object.values(value)) work.push(nested);
  }
  return true;
}

function isInteractionChoiceOptionNode(value: unknown): boolean {
  return isPlainRecord(value) &&
    value.kind === "interactionChoiceOption" &&
    (value.label === null || isIdentifierNode(value.label) || isNumberLiteralNode(value.label)) &&
    (value.colonSpan === null || isSourceSpan(value.colonSpan)) &&
    isAstNode(value.value) &&
    (value.separatorSpan === null || isSourceSpan(value.separatorSpan)) &&
    isSourceSpan(value.span);
}

function isIdentifierNode(value: unknown): boolean {
  return isPlainRecord(value) && value.kind === "identifier" && typeof value.name === "string" && isSourceSpan(value.span);
}

function isNumberLiteralNode(value: unknown): boolean {
  return isPlainRecord(value) && value.kind === "numberLiteral" && typeof value.raw === "string" && typeof value.value === "number" && (value.numericType === "integer" || value.numericType === "number") && isSourceSpan(value.span);
}

function isAstNode(value: unknown): boolean {
  return isPlainRecord(value) && typeof value.kind === "string" && isSourceSpan(value.span);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isSourceSpan(value: unknown): value is SourceSpan {
  if (!isPlainRecord(value)) return false;
  return isSourcePosition(value.start) && isSourcePosition(value.end);
}

function isSourcePosition(value: unknown): boolean {
  return isPlainRecord(value) &&
    Number.isSafeInteger(value.offset) &&
    typeof value.offset === "number" &&
    value.offset >= 0 &&
    Number.isSafeInteger(value.line) &&
    typeof value.line === "number" &&
    value.line >= 0 &&
    Number.isSafeInteger(value.column) &&
    typeof value.column === "number" &&
    value.column >= 0;
}
