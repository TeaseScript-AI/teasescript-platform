import type { Program } from "../ast.js";
import { compileProgram } from "../instructions.js";
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
import type { RuntimeValue } from "./values.js";
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
    if (typeof options.random?.next !== "function") {
      throw new TypeError("A deterministic random source is required.");
    }
    this.#options = options;
  }

  public execute(program: Program): ExecutionResult {
    const plan = compileProgram(program);
    const globals = Object.fromEntries(
      Object.entries(this.#options.globals ?? {}).map(([name, value]) => [
        name,
        fromHostRuntimeValue(value),
      ]),
    );
    const builtins = Object.fromEntries(
      Object.entries(this.#options.builtins ?? {}).map(([name, builtin]) => [
        name,
        adaptBuiltin(builtin),
      ]),
    );
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
