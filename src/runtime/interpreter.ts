import type { Program } from "../ast.js";
import { EXTERNAL_DATA_WORK_MESSAGE, MAX_EXTERNAL_RUNTIME_DATA_WORK } from "../external-data-limits.js";
import { findNonFiniteNumericLiteralDiagnostics } from "../ast-validation.js";
import {
  createDiagnostic,
  DiagnosticSeverity,
  type Diagnostic,
} from "../diagnostics.js";
import { compileProgram } from "../instructions.js";
import { validateSemantics } from "../semantic.js";
import { createSourceSpan, type SourceSpan } from "../source.js";
import {
  run,
  type RuntimeBuiltinFunction,
  type RuntimeCapabilityCall,
} from "./engine.js";
import type { RuntimeErrorInfo } from "./errors.js";
import type { InterpreterEvent } from "./events.js";
import type { RandomSource } from "./random.js";
import {
  fromHostRuntimeValue,
  toHostRuntimeValue,
} from "./serializable-values.js";
import { createFreshRuntimeSnapshot } from "./state.js";
import {
  createRuntimeList,
  createRuntimeObject,
  type RuntimeValue,
} from "./values.js";
import {
  createRuntimeWarning,
  type RuntimeWarningInfo,
} from "./warnings.js";

export type { RandomSource } from "./random.js";

export interface BuiltinCall {
  readonly positional: readonly RuntimeValue[];
  readonly named: Readonly<Record<string, RuntimeValue>>;
  readonly span: SourceSpan;
}

export type BuiltinFunction = (call: BuiltinCall) => RuntimeValue;

export interface InterpreterOptions {
  readonly random: RandomSource;
  readonly builtins?: Readonly<Record<string, BuiltinFunction>>;
  readonly globals?: Readonly<Record<string, RuntimeValue>>;
}

export interface ExecutionResult {
  readonly events: readonly InterpreterEvent[];
  readonly errors: readonly RuntimeErrorInfo[];
  readonly warnings: readonly RuntimeWarningInfo[];
  readonly exited: boolean;
}

const compatibilityDiagnosticCode = {
  blockingWait: "TSC004",
} as const;

const BLOCKING_WAIT_COMPATIBILITY_MESSAGE =
  "Blocking `wait` requires the canonical resumable runtime API.";

/** Structured semantic failure from the direct AST compatibility boundary. */
export class InterpreterCompilationError extends Error {
  readonly diagnostics: readonly Diagnostic[];

  public constructor(diagnostics: readonly Diagnostic[]) {
    super(diagnostics[0]?.message ?? "Program failed semantic validation.");
    this.name = "InterpreterCompilationError";
    this.diagnostics = Object.freeze([...diagnostics]);
  }
}

/** Compatibility wrapper: AST -> serializable plan -> explicit runtime state. */
export function execute(
  program: Program,
  options: InterpreterOptions,
): ExecutionResult {
  return new Interpreter(options).execute(program);
}

export class Interpreter {
  readonly #options: InterpreterOptions;

  public constructor(options: InterpreterOptions) {
    if (options === null || typeof options !== "object") {
      throw new TypeError("Interpreter options are required.");
    }
    const entries = new Map(captureOwnDataEntries(options, "Interpreter options"));
    const random = entries.get("random");
    if (
      random === null ||
      typeof random !== "object" ||
      typeof (random as RandomSource).next !== "function"
    ) {
      throw new TypeError("A deterministic random source is required.");
    }
    const globals = entries.get("globals");
    const builtins = entries.get("builtins");
    this.#options = Object.freeze({
      random: random as RandomSource,
      ...(globals === undefined
        ? {}
        : { globals: globals as Readonly<Record<string, RuntimeValue>> }),
      ...(builtins === undefined
        ? {}
        : { builtins: builtins as Readonly<Record<string, BuiltinFunction>> }),
    });
  }

  public execute(program: Program): ExecutionResult {
    const globals = captureCompatibilityGlobals(this.#options.globals ?? {});
    const builtins = captureCompatibilityBuiltins(this.#options.builtins ?? {});
    const astDiagnostics = findNonFiniteNumericLiteralDiagnostics(program);
    const semantic = validateSemantics(program, {
      globals: Object.keys(globals),
      builtins: Object.keys(builtins),
    });
    const diagnostics = Object.freeze([...astDiagnostics, ...semantic.diagnostics]);
    if (
      diagnostics.some(
        (diagnostic) => diagnostic.severity === DiagnosticSeverity.Error,
      )
    ) {
      throw new InterpreterCompilationError(diagnostics);
    }

    const plan = compileProgram(program);
    const blockingWait = plan.instructions.find(
      (instruction) => instruction.kind === "wait",
    );
    if (blockingWait !== undefined) {
      throw new InterpreterCompilationError([
        createDiagnostic(
          DiagnosticSeverity.Error,
          compatibilityDiagnosticCode.blockingWait,
          BLOCKING_WAIT_COMPATIBILITY_MESSAGE,
          blockingWait.span,
        ),
      ]);
    }
    const initial = createFreshRuntimeSnapshot(plan, { globals });
    const execution = run(
      plan,
      initial,
      { builtins, random: this.#options.random },
      { instructionBudget: 100_000 },
    );
    const errors: RuntimeErrorInfo[] = execution.snapshot.failure === null
      ? []
      : [
          Object.freeze({
            code: execution.snapshot.failure.code,
            message: execution.snapshot.failure.message,
            span: createSourceSpan(
              execution.snapshot.failure.span.start,
              execution.snapshot.failure.span.end,
            ),
          }),
        ];
    const warnings = execution.events
      .filter((event) => event.kind === "developerWarning")
      .map((event) =>
        createRuntimeWarning(event.code, event.message, event.span),
      );
    const compatibilityEvents = execution.events.filter(
      (event) => event.kind === "say" || event.kind === "exit",
    );
    return Object.freeze({
      events: Object.freeze(compatibilityEvents),
      errors: Object.freeze(errors),
      warnings: Object.freeze(warnings),
      exited: compatibilityEvents.some((event) => event.kind === "exit"),
    });
  }
}

function captureCompatibilityGlobals(
  globals: Readonly<Record<string, RuntimeValue>>,
): Record<string, ReturnType<typeof fromHostRuntimeValue>> {
  const entries = captureOwnDataEntries(globals, "Interpreter globals");
  const keyWork = createRuntimeList(entries.map(() => null));
  const values = createRuntimeObject(
    new Map<string, RuntimeValue>(
      entries.map(
        ([name, value]) => [name, value as RuntimeValue] as const,
      ),
    ),
  );
  const aggregate = fromHostRuntimeValue(
    createRuntimeObject(
      new Map<string, RuntimeValue>([
        ["keyWork", keyWork],
        ["values", values],
      ]),
    ),
  );
  if (
    aggregate === null ||
    typeof aggregate !== "object" ||
    aggregate.kind !== "object"
  ) {
    throw new TypeError("Interpreter globals are malformed.");
  }
  const valuesProperty = aggregate.properties.find(
    (property) => property.name === "values",
  )?.value;
  if (
    valuesProperty === null ||
    typeof valuesProperty !== "object" ||
    valuesProperty.kind !== "object"
  ) {
    throw new TypeError("Interpreter globals are malformed.");
  }
  const captured: Record<string, ReturnType<typeof fromHostRuntimeValue>> =
    Object.create(null) as Record<
      string,
      ReturnType<typeof fromHostRuntimeValue>
    >;
  for (const property of valuesProperty.properties) {
    captured[property.name] = property.value;
  }
  return captured;
}

function captureCompatibilityBuiltins(
  builtins: Readonly<Record<string, BuiltinFunction>>,
): Record<string, RuntimeBuiltinFunction> {
  const captured: Record<string, RuntimeBuiltinFunction> = Object.create(null) as Record<
    string,
    RuntimeBuiltinFunction
  >;
  for (const [name, value] of captureOwnDataEntries(builtins, "Interpreter builtins")) {
    if (typeof value !== "function") {
      throw new TypeError(`Interpreter builtin '${name}' must be a function.`);
    }
    captured[name] = adaptBuiltin(value as BuiltinFunction);
  }
  return captured;
}

function captureOwnDataEntries(
  value: object,
  label: string,
): readonly (readonly [string, unknown])[] {
  let prototype: object | null;
  let keys: readonly (string | symbol)[];
  try {
    prototype = Reflect.getPrototypeOf(value);
    keys = Reflect.ownKeys(value);
  } catch {
    throw new TypeError(`${label} must be stable plain data.`);
  }
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${label} must be a plain object.`);
  }
  if (keys.length > MAX_EXTERNAL_RUNTIME_DATA_WORK) {
    throw new TypeError(EXTERNAL_DATA_WORK_MESSAGE);
  }
  const entries: Array<readonly [string, unknown]> = [];
  for (const key of keys) {
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Reflect.getOwnPropertyDescriptor(value, key);
    } catch {
      throw new TypeError(`${label} must be stable plain data.`);
    }
    if (descriptor === undefined) {
      throw new TypeError(`${label} must be stable plain data.`);
    }
    if (!descriptor.enumerable) continue;
    if (typeof key === "symbol" || !("value" in descriptor)) {
      throw new TypeError(`${label} must be stable plain data.`);
    }
    entries.push(Object.freeze([key, descriptor.value] as const));
  }
  return Object.freeze(entries);
}

function adaptBuiltin(builtin: BuiltinFunction): RuntimeBuiltinFunction {
  return (call: RuntimeCapabilityCall) =>
    fromHostRuntimeValue(
      builtin(
        Object.freeze({
          positional: Object.freeze(call.positional.map(toHostRuntimeValue)),
          named: Object.freeze(
            Object.fromEntries(
              Object.entries(call.named).map(([name, value]) => [
                name,
                toHostRuntimeValue(value),
              ]),
            ),
          ),
          span: createSourceSpan(call.span.start, call.span.end),
        }),
      ),
    );
}
