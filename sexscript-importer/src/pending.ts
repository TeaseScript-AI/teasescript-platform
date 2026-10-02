import type { IrExpression, IrStatement, IrSwitchCase, MigrationProgram } from "./ir.ts";

/**
 * Accepted TeaseScript the importer emits although the current compiler does not implement it yet. The
 * feasibility report compiles a shimmed copy in which these become placeholder host calls, so a remaining
 * compiler error points at importer output rather than at a known TeaseScript implementation gap. Generated
 * packages never contain the shims.
 */
const PENDING_CALLS = new Map<string, string>([
  ["askBoolean", "askBoolean()"],
  ["askBooleans", "askBooleans()"],
  ["askInteger", "askInteger()"],
  ["ceil", "ceil()"],
  ["floor", "floor()"],
  ["getDate", "getDate()"],
  ["getDateTime", "getDateTime()"],
  ["getSeconds", "getSeconds()"],
  ["openUrl", "openUrl()"],
  ["round", "round()"],
  ["showButton", "showButton timeout"],
  ["toBoolean", "toBoolean()"],
  ["toInteger", "toInteger()"],
  ["toNumber", "toNumber()"],
  ["toString", "toString()"],
]);

const SHIM_PREFIX = "sxPending";

export interface PendingShim {
  program: MigrationProgram;
  /** Placeholder names to register as host builtins when compiling the shimmed program. */
  builtins: string[];
  /** Accepted-but-unimplemented capabilities the program uses, by display name. */
  capabilities: Set<string>;
}

export function shimPendingCapabilities(program: MigrationProgram): PendingShim {
  const builtins = new Set<string>();
  const capabilities = new Set<string>();
  let switchCount = 0;
  const call = (
    capability: string,
    name: string,
    positional: IrExpression[],
    named: Record<string, IrExpression> = {},
  ): IrExpression => {
    capabilities.add(capability);
    const shim = `${SHIM_PREFIX}${name[0]!.toUpperCase()}${name.slice(1)}`;
    builtins.add(shim);
    return { kind: "call", name: shim, positional, named };
  };

  const expression = (value: IrExpression): IrExpression => {
    switch (value.kind) {
      case "load":
        return call(
          "storage",
          "load",
          value.defaultValue === undefined
            ? [expression(value.key)]
            : [expression(value.key), expression(value.defaultValue)],
        );
      case "call": {
        const capability = PENDING_CALLS.get(value.name);
        const positional = value.positional.map(expression);
        const named = Object.fromEntries(
          Object.entries(value.named).map(([name, child]) => [name, expression(child)]),
        );
        return capability === undefined
          ? { ...value, positional, named }
          : call(capability, value.name, positional, named);
      }
      case "list":
        return { ...value, items: value.items.map(expression) };
      case "object":
        return {
          ...value,
          properties: value.properties.map((property) => ({
            ...property,
            value: expression(property.value),
          })),
        };
      case "index":
        return { ...value, target: expression(value.target), index: expression(value.index) };
      case "property":
        return { ...value, target: expression(value.target) };
      case "methodCall":
        return {
          ...value,
          target: expression(value.target),
          arguments: value.arguments.map(expression),
        };
      case "choice":
        return { ...value, options: value.options.map(expression) };
      case "range":
        return { ...value, from: expression(value.from), to: expression(value.to) };
      case "unary":
        return { ...value, value: expression(value.value) };
      case "binary":
        return { ...value, left: expression(value.left), right: expression(value.right) };
      case "template":
        return {
          ...value,
          parts: value.parts.map((part) =>
            "text" in part ? part : { value: expression(part.value) },
          ),
        };
      case "literal":
      case "variable":
      case "input":
        return value;
    }
  };

  const statements = (items: IrStatement[]): IrStatement[] => items.flatMap(statement);
  const callStatement = (value: IrExpression, span: IrStatement["span"]): IrStatement => ({
    kind: "expression",
    expression: value,
    span,
  });

  const statement = (item: IrStatement): IrStatement[] => {
    switch (item.kind) {
      case "save":
        return [
          callStatement(
            call("storage", "save", [expression(item.key), expression(item.value)]),
            item.span,
          ),
        ];
      case "delete":
        return [callStatement(call("storage", "delete", [expression(item.key)]), item.span)];
      case "run":
        return [callStatement(call("run/end", "run", [expression(item.script)]), item.span)];
      case "end":
        return [callStatement(call("run/end", "end", []), item.span)];
      case "showPopup":
        return [
          callStatement(call("showPopup", "showPopup", [expression(item.message)]), item.span),
        ];
      case "showButton":
        if (item.timeout === null) return [item];
        return [
          callStatement(
            call("showButton timeout", "showButton", [
              expression(item.label),
              expression(item.timeout),
            ]),
            item.span,
          ),
        ];
      case "switch": {
        capabilities.add("switch");
        switchCount += 1;
        return switchAsIfChain(
          item,
          `${SHIM_PREFIX}SwitchValue${switchCount}`,
          expression,
          statements,
        );
      }
      case "function":
        return [{ ...item, body: statements(item.body) }];
      case "let":
        return [{ ...item, value: expression(item.value) }];
      case "assign":
        return [{ ...item, target: expression(item.target), value: expression(item.value) }];
      case "expression":
        return [{ ...item, expression: expression(item.expression) }];
      case "say":
        return [{ ...item, value: expression(item.value) }];
      case "wait":
        return [{ ...item, duration: expression(item.duration) }];
      case "showImage":
        return [{ ...item, file: expression(item.file) }];
      case "playAudio":
        return [
          {
            ...item,
            file: expression(item.file),
            repeatCount: item.repeatCount === null ? null : expression(item.repeatCount),
          },
        ];
      case "return":
        return [{ ...item, value: item.value === null ? null : expression(item.value) }];
      case "if":
        return [
          {
            ...item,
            condition: expression(item.condition),
            then: statements(item.then),
            else: statements(item.else),
          },
        ];
      case "while":
        return [{ ...item, condition: expression(item.condition), body: statements(item.body) }];
      case "for":
        return [{ ...item, collection: expression(item.collection), body: statements(item.body) }];
      case "hideImage":
      case "break":
      case "continue":
      case "exit":
      case "unsupported":
      case "comment":
      case "blank":
        return [item];
    }
  };

  return {
    program: { ...program, statements: statements(program.statements) },
    builtins: [...builtins].sort(),
    capabilities,
  };
}

/** Accepted switch semantics (literal or range cases, no fallthrough) expressed as an equivalent if chain. */
function switchAsIfChain(
  item: Extract<IrStatement, { kind: "switch" }>,
  valueName: string,
  expression: (value: IrExpression) => IrExpression,
  statements: (items: IrStatement[]) => IrStatement[],
): IrStatement[] {
  const value: IrExpression = { kind: "variable", name: valueName };
  const matches = (switchCase: IrSwitchCase): IrExpression => {
    const match = switchCase.match;
    if (match.kind !== "range")
      return { kind: "binary", operator: "==", left: value, right: expression(match) };
    return {
      kind: "binary",
      operator: "and",
      left: { kind: "binary", operator: ">=", left: value, right: expression(match.from) },
      right: {
        kind: "binary",
        operator: match.inclusive ? "<=" : "<",
        left: value,
        right: expression(match.to),
      },
    };
  };
  let chain: IrStatement[] = statements(item.default);
  for (const switchCase of [...item.cases].reverse()) {
    chain = [
      {
        kind: "if",
        condition: matches(switchCase),
        then: statements(switchCase.body),
        else: chain,
        span: switchCase.span,
      },
    ];
  }
  return [
    { kind: "let", name: valueName, value: expression(item.value), span: item.span },
    ...chain,
  ];
}
