import type { CallExpression, Expression, NamedArgument, Program } from "./ast.js";
import type { SourceSpan } from "./source.js";
import { isKnownTimeZone } from "./temporal-capture.js";

/** The methods whose `zone:` names the time zone they count in (V30 §35). */
const ZONE_METHODS: ReadonlySet<string> = new Set([
  "toAbsoluteDateTime",
  "toDateTime",
  "add",
  "toDuration",
]);

/**
 * Why the `zone:` of a method call cannot be used, or `null`. The zone is the name of a known zone written as text,
 * because the Player records the rules of each zone a script names when the session starts or continues.
 */
export function zoneArgumentProblem(
  call: CallExpression,
): { readonly message: string; readonly span: SourceSpan } | null {
  const argument = zoneArgument(call);
  if (argument === undefined) return null;
  const name = writtenText(argument.value);
  if (name === undefined)
    return {
      message:
        "'zone:' takes the name of a time zone written as text, such as 'zone: \"Europe/Amsterdam\"' or 'zone: \"UTC\"'. The Player records the rules of each zone a script names when the session starts, so the name cannot be computed while the script runs.",
      span: argument.value.span,
    };
  if (!isKnownTimeZone(name))
    return {
      message: `"${name}" is not a time zone that this compiler knows. Write an IANA zone name such as "Europe/Amsterdam" or "America/New_York", or "UTC".`,
      span: argument.value.span,
    };
  return null;
}

/**
 * The zones the programs name with `zone:`, other than `UTC`, which needs no rules, unique and sorted: the zones whose
 * rules the Player records for the session.
 */
export function namedTimeZones(programs: readonly Program[]): readonly string[] {
  const names = new Set<string>();
  const work: unknown[] = [...programs];
  while (work.length > 0) {
    const value = work.pop();
    if (value === null || typeof value !== "object") continue;
    if (Array.isArray(value)) {
      for (const item of value) work.push(item);
      continue;
    }
    // Spans and positions, the only AST objects without a kind, hold no calls.
    if (!("kind" in value)) continue;
    if (value.kind === "callExpression") {
      // EVIDENCE: invariant: an AST node of kind callExpression is a CallExpression.
      const argument = zoneArgument(value as CallExpression);
      const name = argument === undefined ? undefined : writtenText(argument.value);
      if (name !== undefined && name !== "UTC") names.add(name);
    }
    for (const nested of Object.values(value)) work.push(nested);
  }
  return [...names].sort();
}

function zoneArgument(call: CallExpression): NamedArgument | undefined {
  let callee = call.callee;
  while (callee.kind === "parenthesizedExpression") callee = callee.expression;
  if (callee.kind !== "propertyAccessExpression" || !ZONE_METHODS.has(callee.property.name))
    return undefined;
  return call.arguments.find(
    (argument): argument is NamedArgument =>
      argument.kind === "namedArgument" && argument.name.name === "zone",
  );
}

/** The text of a string literal without interpolation, also in parentheses, or `undefined`. */
function writtenText(expression: Expression): string | undefined {
  let literal = expression;
  while (literal.kind === "parenthesizedExpression") literal = literal.expression;
  if (literal.kind !== "stringLiteral" || literal.parts.some((part) => part.kind !== "stringText"))
    return undefined;
  return literal.parts.map((part) => (part.kind === "stringText" ? part.value : "")).join("");
}
