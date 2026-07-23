import type {
  AssignmentTarget,
  BinaryExpression,
  Block,
  CallExpression,
  Expression,
  Program,
  Statement,
} from "../ast.js";
import { createSourceSpan, type SourceSpan } from "../source.js";
import {
  assertListIndex,
  callCollectionMethod,
  getCollectionProperty,
} from "./collections.js";
import { resolveOutputSpeaker, toVisibleText } from "./display.js";
import { Environment } from "./environment.js";
import { RuntimeFault, type RuntimeErrorInfo } from "./errors.js";
import type {
  InterpreterEvent,
  SayEvent,
} from "./events.js";
import type { RandomSource } from "./random.js";
import {
  isRuntimeList,
  isRuntimeObject,
  isRuntimeSet,
  isRuntimeSpeaker,
} from "./value-guards.js";
import {
  cloneRuntimeValue,
  createRuntimeList,
  createRuntimeObject,
  createRuntimeSet,
  createRuntimeSpeaker,
  isRuntimeValue,
  runtimeEquals,
  RuntimeEqualityError,
  type RuntimeSpeaker,
  type RuntimeValue,
} from "./values.js";

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
  readonly exited: boolean;
}

export function execute(
  program: Program,
  options: InterpreterOptions,
): ExecutionResult {
  return new Interpreter(options).execute(program);
}

export class Interpreter {
  readonly #events: InterpreterEvent[] = [];
  readonly #errors: RuntimeErrorInfo[] = [];
  readonly #globals = new Environment();
  readonly #builtins: Readonly<Record<string, BuiltinFunction>>;
  readonly #random: RandomSource;
  #defaultSpeaker: RuntimeSpeaker | null = null;
  #exited = false;

  public constructor(options: InterpreterOptions) {
    if (options === null || typeof options !== "object") {
      throw new TypeError("Interpreter options are required.");
    }
    if (typeof options.random?.next !== "function") {
      throw new TypeError("A deterministic random source is required.");
    }
    this.#random = options.random;
    this.#builtins = Object.freeze({ ...(options.builtins ?? {}) });

    for (const [name, value] of Object.entries(options.globals ?? {})) {
      if (!isRuntimeValue(value)) {
        throw new TypeError(`Global ${JSON.stringify(name)} is not a runtime value.`);
      }
      if (!this.#globals.declare(name, cloneRuntimeValue(value))) {
        throw new TypeError(`Duplicate global ${JSON.stringify(name)}.`);
      }
    }
  }

  public execute(program: Program): ExecutionResult {
    try {
      this.#executeStatements(program.statements, this.#globals);
    } catch (error) {
      if (error instanceof RuntimeFault) {
        this.#errors.push(error.toInfo());
      } else {
        throw error;
      }
    }
    return Object.freeze({
      events: Object.freeze([...this.#events]),
      errors: Object.freeze([...this.#errors]),
      exited: this.#exited,
    });
  }

  #executeStatements(
    statements: readonly Statement[],
    environment: Environment,
  ): void {
    for (const statement of statements) {
      if (this.#exited) return;
      this.#executeStatement(statement, environment);
    }
  }

  #executeStatement(statement: Statement, environment: Environment): void {
    switch (statement.kind) {
      case "letStatement": {
        const value = this.#evaluate(statement.initializer, environment, null);
        if (!environment.declare(statement.name.name, cloneRuntimeValue(value))) {
          throw this.#fault(
            "TSR001",
            `Variable '${statement.name.name}' is already visible in this scope.`,
            statement.name.span,
          );
        }
        return;
      }
      case "assignmentStatement": {
        const value = this.#evaluate(statement.value, environment, null);
        this.#assign(statement.target, value, environment);
        return;
      }
      case "expressionStatement":
        this.#evaluate(statement.expression, environment, null);
        return;
      case "ifStatement": {
        const condition = this.#evaluate(statement.condition, environment, null);
        this.#expectBoolean(condition, statement.condition.span);
        if (condition) this.#executeBlock(statement.thenBlock, environment);
        else if (statement.elseBlock !== null) {
          this.#executeBlock(statement.elseBlock, environment);
        }
        return;
      }
      case "speakerDeclaration": {
        const speaker = createRuntimeSpeaker(statement.name.name);
        if (!environment.declare(statement.name.name, speaker)) {
          throw this.#fault(
            "TSR001",
            `Speaker '${statement.name.name}' is already visible in this scope.`,
            statement.name.span,
          );
        }
        for (const property of statement.properties) {
          speaker.properties.set(
            property.name.name,
            cloneRuntimeValue(
              this.#evaluate(property.value, environment, speaker),
            ),
          );
        }
        return;
      }
      case "speakerSetterStatement":
        this.#defaultSpeaker = this.#getSpeaker(
          statement.speaker.name,
          environment,
          statement.speaker.span,
        );
        return;
      case "sayStatement": {
        const speaker =
          statement.speaker === null
            ? this.#defaultSpeaker
            : this.#getSpeaker(
                statement.speaker.name,
                environment,
                statement.speaker.span,
              );
        const value = this.#evaluate(statement.value, environment, speaker);
        const text = toVisibleText(value, statement.value.span, this.#random);
        const event: SayEvent = Object.freeze({
          kind: "say",
          speaker:
            speaker === null
              ? null
              : resolveOutputSpeaker(speaker, statement.span),
          text,
          span: createSourceSpan(statement.span.start, statement.span.end),
        });
        this.#events.push(event);
        return;
      }
      case "exitStatement":
        this.#defaultSpeaker = null;
        this.#exited = true;
        this.#events.push(
          Object.freeze({
            kind: "exit",
            span: createSourceSpan(statement.span.start, statement.span.end),
          }),
        );
        return;
    }
  }

  #executeBlock(block: Block, parent: Environment): void {
    this.#executeStatements(block.statements, new Environment(parent));
  }

  #assign(
    target: AssignmentTarget,
    value: RuntimeValue,
    environment: Environment,
  ): void {
    const copied = cloneRuntimeValue(value);
    if (target.kind === "identifier") {
      if (!environment.assign(target.name, copied)) {
        throw this.#fault(
          "TSR002",
          `Cannot assign to unknown variable '${target.name}'.`,
          target.span,
        );
      }
      return;
    }
    if (target.kind === "propertyAccessExpression") {
      const object = this.#evaluate(target.object, environment, null);
      if (isRuntimeObject(object) || isRuntimeSpeaker(object)) {
        object.properties.set(target.property.name, copied);
        return;
      }
      throw this.#fault(
        "TSR003",
        "Only objects and speakers have assignable properties.",
        target.span,
      );
    }

    const object = this.#evaluate(target.object, environment, null);
    if (isRuntimeSet(object)) {
      throw this.#fault(
        "TSR004",
        "Sets are not indexable.",
        target.span,
      );
    }
    if (!isRuntimeList(object)) {
      throw this.#fault(
        "TSR005",
        "Only lists have assignable numeric indexes.",
        target.span,
      );
    }
    const index = this.#evaluateIndex(target.index, environment);
    assertListIndex(object, index, target.index.span);
    object.items[index] = copied;
  }

  #evaluate(
    expression: Expression,
    environment: Environment,
    contextualSpeaker: RuntimeSpeaker | null,
  ): RuntimeValue {
    switch (expression.kind) {
      case "booleanLiteral":
      case "numberLiteral":
      case "stringLiteral":
      case "nullLiteral":
        return expression.value;
      case "identifier": {
        if (expression.name === "speaker" && contextualSpeaker !== null) {
          return contextualSpeaker;
        }
        const value = environment.get(expression.name);
        if (value === undefined) {
          throw this.#fault(
            "TSR006",
            `Unknown identifier '${expression.name}'.`,
            expression.span,
          );
        }
        return value;
      }
      case "listLiteral":
        return createRuntimeList(
          expression.elements.map((element) =>
            cloneRuntimeValue(
              this.#evaluate(element, environment, contextualSpeaker),
            ),
          ),
        );
      case "setLiteral":
        try {
          return createRuntimeSet(
            expression.elements.map((element) =>
              this.#evaluate(element, environment, contextualSpeaker),
            ),
          );
        } catch (error) {
          this.#translateEqualityError(error, expression.span);
        }
      case "objectLiteral": {
        const entries = new Map<string, RuntimeValue>();
        for (const property of expression.properties) {
          if (entries.has(property.name.name)) {
            throw this.#fault(
              "TSR007",
              `Duplicate object property '${property.name.name}'.`,
              property.name.span,
            );
          }
          entries.set(
            property.name.name,
            cloneRuntimeValue(
              this.#evaluate(
                property.value,
                environment,
                contextualSpeaker,
              ),
            ),
          );
        }
        return createRuntimeObject(entries);
      }
      case "parenthesizedExpression":
        return this.#evaluate(
          expression.expression,
          environment,
          contextualSpeaker,
        );
      case "templateLiteral": {
        let text = "";
        for (const part of expression.parts) {
          if (part.kind === "templateText") text += part.value;
          else {
            text += toVisibleText(
              this.#evaluate(
                part.expression,
                environment,
                contextualSpeaker,
              ),
              part.expression.span,
              this.#random,
            );
          }
        }
        return text;
      }
      case "propertyAccessExpression": {
        const object = this.#evaluate(
          expression.object,
          environment,
          contextualSpeaker,
        );
        return this.#getProperty(object, expression.property.name, expression.span);
      }
      case "indexExpression": {
        const object = this.#evaluate(
          expression.object,
          environment,
          contextualSpeaker,
        );
        if (isRuntimeSet(object)) {
          throw this.#fault("TSR004", "Sets are not indexable.", expression.span);
        }
        if (!isRuntimeList(object)) {
          throw this.#fault(
            "TSR008",
            "Only lists support numeric indexing.",
            expression.span,
          );
        }
        const index = this.#evaluateIndex(expression.index, environment);
        assertListIndex(object, index, expression.index.span);
        return object.items[index]!;
      }
      case "callExpression":
        return this.#evaluateCall(expression, environment, contextualSpeaker);
      case "unaryExpression": {
        const operand = this.#evaluate(
          expression.operand,
          environment,
          contextualSpeaker,
        );
        if (expression.operator === "not") {
          this.#expectBoolean(operand, expression.operand.span);
          return !operand;
        }
        this.#expectNumber(operand, expression.operand.span);
        return expression.operator === "+" ? operand : -operand;
      }
      case "binaryExpression":
        return this.#evaluateBinary(
          expression,
          environment,
          contextualSpeaker,
        );
    }
  }

  #evaluateBinary(
    expression: BinaryExpression,
    environment: Environment,
    contextualSpeaker: RuntimeSpeaker | null,
  ): RuntimeValue {
    const left = this.#evaluate(
      expression.left,
      environment,
      contextualSpeaker,
    );
    if (expression.operator === "and") {
      this.#expectBoolean(left, expression.left.span);
      return left
        ? this.#booleanExpression(
            expression.right,
            environment,
            contextualSpeaker,
          )
        : false;
    }
    if (expression.operator === "or") {
      this.#expectBoolean(left, expression.left.span);
      return left
        ? true
        : this.#booleanExpression(
            expression.right,
            environment,
            contextualSpeaker,
          );
    }
    const right = this.#evaluate(
      expression.right,
      environment,
      contextualSpeaker,
    );

    if (expression.operator === "==" || expression.operator === "!=") {
      try {
        const equal = runtimeEquals(left, right);
        return expression.operator === "==" ? equal : !equal;
      } catch (error) {
        this.#translateEqualityError(error, expression.span);
      }
    }

    if (
      expression.operator === "<" ||
      expression.operator === "<=" ||
      expression.operator === ">" ||
      expression.operator === ">="
    ) {
      if (
        (typeof left !== "number" || typeof right !== "number") &&
        (typeof left !== "string" || typeof right !== "string")
      ) {
        throw this.#fault(
          "TSR009",
          "Comparison operands must both be numbers or both be strings.",
          expression.span,
        );
      }
      switch (expression.operator) {
        case "<":
          return left < right;
        case "<=":
          return left <= right;
        case ">":
          return left > right;
        case ">=":
          return left >= right;
      }
    }

    this.#expectNumber(left, expression.left.span);
    this.#expectNumber(right, expression.right.span);
    switch (expression.operator) {
      case "+":
        return left + right;
      case "-":
        return left - right;
      case "*":
        return left * right;
      case "/":
        return left / right;
      case "%":
        return left % right;
      default:
        throw new Error(`Unhandled binary operator ${expression.operator}.`);
    }
  }

  #booleanExpression(
    expression: Expression,
    environment: Environment,
    contextualSpeaker: RuntimeSpeaker | null,
  ): boolean {
    const value = this.#evaluate(expression, environment, contextualSpeaker);
    this.#expectBoolean(value, expression.span);
    return value;
  }

  #evaluateCall(
    expression: CallExpression,
    environment: Environment,
    contextualSpeaker: RuntimeSpeaker | null,
  ): RuntimeValue {
    const positional: RuntimeValue[] = [];
    const named: Record<string, RuntimeValue> = {};
    for (const argument of expression.arguments) {
      const value = cloneRuntimeValue(
        this.#evaluate(argument.value, environment, contextualSpeaker),
      );
      if (argument.kind === "positionalArgument") positional.push(value);
      else {
        if (Object.hasOwn(named, argument.name.name)) {
          throw this.#fault(
            "TSR010",
            `Duplicate named argument '${argument.name.name}'.`,
            argument.name.span,
          );
        }
        named[argument.name.name] = value;
      }
    }

    if (expression.callee.kind === "identifier") {
      const builtin = this.#builtins[expression.callee.name];
      if (builtin === undefined) {
        throw this.#fault(
          "TSR011",
          `Unknown built-in function '${expression.callee.name}'.`,
          expression.callee.span,
        );
      }
      let result: unknown;
      try {
        result = builtin(
          Object.freeze({
            positional: Object.freeze(positional),
            named: Object.freeze(named),
            span: createSourceSpan(expression.span.start, expression.span.end),
          }),
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw this.#fault(
          "TSR012",
          `Built-in '${expression.callee.name}' failed: ${message}`,
          expression.span,
        );
      }
      if (!isRuntimeValue(result)) {
        throw this.#fault(
          "TSR013",
          `Built-in '${expression.callee.name}' returned an invalid value.`,
          expression.span,
        );
      }
      return cloneRuntimeValue(result);
    }

    if (expression.callee.kind === "propertyAccessExpression") {
      const receiver = this.#evaluate(
        expression.callee.object,
        environment,
        contextualSpeaker,
      );
      return this.#callMethod(
        receiver,
        expression.callee.property.name,
        positional,
        named,
        expression.span,
      );
    }

    throw this.#fault(
      "TSR014",
      "Only injected built-ins and supported collection methods are callable.",
      expression.callee.span,
    );
  }

  #callMethod(
    receiver: RuntimeValue,
    name: string,
    positional: readonly RuntimeValue[],
    named: Readonly<Record<string, RuntimeValue>>,
    span: SourceSpan,
  ): RuntimeValue {
    const result = callCollectionMethod(
      receiver,
      name,
      positional,
      named,
      span,
    );
    if (result.handled) return result.value;
    throw this.#fault(
      "TSR016",
      `Unsupported method '${name}'.`,
      span,
    );
  }

  #getProperty(
    value: RuntimeValue,
    name: string,
    span: SourceSpan,
  ): RuntimeValue {
    if (isRuntimeObject(value) || isRuntimeSpeaker(value)) {
      let property = value.properties.get(name);
      if (isRuntimeSpeaker(value) && property === undefined) {
        if (name === "title") property = value.properties.get("shortTitle");
        else if (name === "shortTitle") property = value.properties.get("title");
      }
      if (property === undefined) {
        throw this.#fault("TSR017", `Unknown property '${name}'.`, span);
      }
      return property;
    }
    return getCollectionProperty(value, name, span, this.#random);
  }

  #getSpeaker(
    name: string,
    environment: Environment,
    span: SourceSpan,
  ): RuntimeSpeaker {
    const value = environment.get(name);
    if (!isRuntimeSpeaker(value)) {
      throw this.#fault("TSR023", `'${name}' is not a declared speaker.`, span);
    }
    return value;
  }

  #evaluateIndex(expression: Expression, environment: Environment): number {
    const value = this.#evaluate(expression, environment, null);
    if (typeof value !== "number" || !Number.isInteger(value)) {
      throw this.#fault(
        "TSR024",
        "A list index must be an integer.",
        expression.span,
      );
    }
    return value;
  }

  #expectBoolean(value: RuntimeValue, span: SourceSpan): asserts value is boolean {
    if (typeof value !== "boolean") {
      throw this.#fault("TSR026", "Expected a boolean value.", span);
    }
  }

  #expectNumber(value: RuntimeValue, span: SourceSpan): asserts value is number {
    if (typeof value !== "number") {
      throw this.#fault("TSR027", "Expected a numeric value.", span);
    }
  }

  #translateEqualityError(error: unknown, span: SourceSpan): never {
    if (error instanceof RuntimeEqualityError) {
      throw this.#fault("TSR029", error.message, span);
    }
    throw error;
  }

  #fault(code: string, message: string, span: SourceSpan): RuntimeFault {
    return new RuntimeFault(code, message, span);
  }
}
