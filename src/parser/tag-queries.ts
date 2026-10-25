import { parseChild, runParse, type ParseTask } from "../parse-continuation.js";
import type { CallExpression, Expression, TagQueryExpression, TagQueryStep } from "../ast.js";
import { isTagListOption, tagPredicateSteps } from "../tag-query.js";
import type { SourceSpan } from "../source.js";
import { TokenKind, type Token } from "../token.js";
import type { Parser } from "../parser.js";
import { parserDiagnosticCode } from "./diagnostic-codes.js";
import { copySpan, isPropertyName, spanFrom } from "./tokens.js";

// Tag queries (ADR 0023): `tagged` after `showImage` or `goto`, and `findImages` and `findScripts`.

/**
 * `showImage tagged "bedroom", "punishment" > 3, none: ["outdoor"]` or `goto tagged "punishment", from: "rooms/*.tease"`:
 * comma-separated tag predicates, then `all:`, `none:`, or `any:` options, and for scripts `from:`. A candidate
 * needs all of them (ADR 0023).
 */
export function parseTaggedQuery(
  parser: Parser,
  catalog: TagQueryExpression["catalog"],
): TagQueryExpression | null {
  const tagged = parser.advance();
  const example = catalog === "images" ? 'showImage tagged "bedroom"' : 'goto tagged "punishment"';
  if (parser.check(TokenKind.Newline) || parser.check(TokenKind.EndOfFile)) {
    parser.reportInsertion(
      parserDiagnosticCode.invalidTagQuery,
      `Expected a tag after 'tagged', such as ${example}.`,
    );
    return null;
  }
  const filters: TagQueryStep[][] = [];
  const options = new Set<string>();
  let from: TagQueryExpression["from"] = null;
  let end = tagged.span;
  do {
    parser.skipNewlines();
    // A statement on the line after a trailing comma is not a tag; the caller keeps it.
    if (parser.previous().kind === TokenKind.Newline && parser.atStatementStart()) {
      parser.reportInsertion(parserDiagnosticCode.invalidTagQuery, "Expected a tag after ','.");
      return null;
    }
    if (isPropertyName(parser.peek()) && parser.peek(1).kind === TokenKind.Colon) {
      const name = parser.advance();
      parser.advance();
      const value = runParse(parser.parseColonValueTask(true));
      if (value === null) return null;
      end = value.span;
      if (catalog === "scripts" && name.lexeme === "from") {
        from = tagQueryFrom(parser, value, name.span, options);
        if (from === null) return null;
        continue;
      }
      const filter = tagListFilter(
        parser,
        name.lexeme,
        name.span,
        value,
        options,
        `tagged takes all:, none:, ${catalog === "scripts" ? "any:, and from:" : "and any:"}.`,
      );
      if (filter === null) return null;
      filters.push([filter]);
      continue;
    }
    if (options.size > 0) {
      parser.reportToken(
        parserDiagnosticCode.invalidTagQuery,
        `Write the tags before all:, none:, ${catalog === "scripts" ? "any:, or from:" : "or any:"}.`,
        parser.peek(),
      );
      return null;
    }
    const predicate = runParse(parser.parseRequiredExpressionTask());
    if (predicate === null) return null;
    const steps = tagPredicate(parser, predicate);
    if (steps === null) return null;
    filters.push(steps);
    end = predicate.span;
  } while (parser.match(TokenKind.Comma));
  return tagQuery(catalog, "random", filters, from, spanFrom(tagged.span, end));
}

/**
 * `findImages(where: …, all: …, none: …, any: …)` or `findScripts(…, from: …)` after its `(`: the list of matches
 * (ADR 0023). After a reported error it is the plain call, so the surrounding expression still parses.
 */
export function* finishFindQuery(
  parser: Parser,
  callee: Expression,
  left: Token,
  catalog: TagQueryExpression["catalog"],
): ParseTask<TagQueryExpression | CallExpression> {
  const call = yield* parseChild(parser.finishCall(callee, left));
  const name = catalog === "images" ? "findImages" : "findScripts";
  const takes = `${name} takes where:, all:, none:, ${catalog === "scripts" ? "any:, and from:" : "and any:"}.`;
  const filters: TagQueryStep[][] = [];
  const options = new Set<string>();
  let from: TagQueryExpression["from"] = null;
  for (const argument of call.arguments) {
    if (argument.kind === "positionalArgument") {
      parser.reportSpan(
        parserDiagnosticCode.invalidTagQuery,
        `${name} takes named arguments: ${takes.slice(name.length + " takes ".length)}`,
        argument.span,
      );
      return call;
    }
    const option = argument.name.name;
    if (option === "where") {
      if (options.has(option)) {
        parser.reportSpan(
          parserDiagnosticCode.invalidTagQuery,
          "The option 'where' appears more than once. Combine the tags with 'and'.",
          argument.name.span,
        );
        return call;
      }
      options.add(option);
      const steps = tagPredicate(parser, argument.value);
      if (steps === null) return call;
      filters.push(steps);
      continue;
    }
    if (catalog === "scripts" && option === "from") {
      from = tagQueryFrom(parser, argument.value, argument.name.span, options);
      if (from === null) return call;
      continue;
    }
    const filter = tagListFilter(
      parser,
      option,
      argument.name.span,
      argument.value,
      options,
      takes,
    );
    if (filter === null) return call;
    filters.push([filter]);
  }
  return tagQuery(catalog, "list", filters, from, call.span);
}

/** A script query's `from:`: a path or glob written out in quotes, as for `goto` (ADR 0022). */
function tagQueryFrom(
  parser: Parser,
  value: Expression,
  nameSpan: SourceSpan,
  options: Set<string>,
): TagQueryExpression["from"] {
  if (options.has("from")) {
    parser.reportSpan(
      parserDiagnosticCode.invalidTagQuery,
      "The option 'from' appears more than once.",
      nameSpan,
    );
    return null;
  }
  options.add("from");
  if (value.kind === "stringLiteral" && parser.shared.recoveredStrings.has(value)) return null;
  if (
    value.kind !== "stringLiteral" ||
    value.form !== "singleLine" ||
    value.parts.some((part) => part.kind !== "stringText")
  ) {
    parser.reportSpan(
      parserDiagnosticCode.invalidTagQuery,
      'from: takes a file path or glob written out in quotes, such as from: "modules/*.tease".',
      value.span,
    );
    return null;
  }
  return Object.freeze({
    pattern: value.parts.map((part) => (part.kind === "stringText" ? part.value : "")).join(""),
    span: copySpan(value.span),
  });
}

function tagPredicate(parser: Parser, predicate: Expression): TagQueryStep[] | null {
  return tagPredicateSteps(
    predicate,
    (message, span) => parser.reportSpan(parserDiagnosticCode.invalidTagQuery, message, span),
    (literal) => parser.shared.recoveredStrings.has(literal),
  );
}

/** An `all:`, `none:`, or `any:` option; each may appear once. */
function tagListFilter(
  parser: Parser,
  name: string,
  nameSpan: SourceSpan,
  value: Expression,
  options: Set<string>,
  takes: string,
): TagQueryStep | null {
  if (!isTagListOption(name)) {
    parser.reportSpan(
      parserDiagnosticCode.invalidTagQuery,
      `Unknown option '${name}'. ${takes}`,
      nameSpan,
    );
    return null;
  }
  if (options.has(name)) {
    parser.reportSpan(
      parserDiagnosticCode.invalidTagQuery,
      `The option '${name}' appears more than once.`,
      nameSpan,
    );
    return null;
  }
  options.add(name);
  return Object.freeze({
    kind: "tagList",
    option: name,
    value,
    span: spanFrom(nameSpan, value.span),
  });
}

/** A query whose candidates must pass every filter, each a complete postfix predicate. */
function tagQuery(
  catalog: TagQueryExpression["catalog"],
  select: TagQueryExpression["select"],
  filters: readonly (readonly TagQueryStep[])[],
  from: TagQueryExpression["from"],
  span: SourceSpan,
): TagQueryExpression {
  const steps: TagQueryStep[] = [];
  filters.forEach((filter, index) => {
    for (const step of filter) steps.push(step);
    if (index > 0) steps.push({ kind: "and" });
  });
  return Object.freeze({
    kind: "tagQueryExpression",
    catalog,
    select,
    steps: Object.freeze(steps),
    from,
    span: copySpan(span),
  });
}
