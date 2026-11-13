import type { ProjectSourceFile } from "./compiler.js";
import { classifyTokens } from "./language-tooling.js";
import { parse, type ParseResult } from "./parser.js";
import type { InstructionPlan } from "./plan/model.js";
import {
  SOURCE_DEBUG_SIDECAR_FORMAT,
  SOURCE_DEBUG_SIDECAR_VERSION,
  validatedPlanSha256,
} from "./runtime/debug/source-sidecar.js";
import { captureOrReuseInstructionPlan } from "./plan/capture.js";
import type { SourceSpan } from "./source.js";
import { LANGUAGE_TOKEN_CLASSES } from "./token-classes.js";

/** Every function's span and every statement's and statement block's, in the parser's zero-based lines and columns. */
export interface SourceEnclosingSpans {
  readonly functions: readonly SourceSpan[];
  readonly blocks: readonly SourceSpan[];
}

/** The spans a source view fits "Show whole …" to, or `null` when the file does not parse. */
export function sourceEnclosingSpans(parsed: ParseResult): SourceEnclosingSpans | null {
  if (parsed.diagnostics.some((diagnostic) => diagnostic.severity === "error")) return null;
  // The tree is walked with a list rather than by recursion, as valid source may nest deeper than the call stack
  // reaches.
  const functions: SourceSpan[] = [];
  const blocks: SourceSpan[] = [];
  const pending: unknown[] = [parsed.program.statements];
  while (pending.length > 0) {
    const node = pending.pop();
    if (typeof node !== "object" || node === null) continue;
    if (Array.isArray(node)) {
      for (const item of node) pending.push(item);
      continue;
    }
    // EVIDENCE: the parser's syntax tree holds plain nodes, arrays, and values, and a node's `span` is its SourceSpan.
    const record = node as {
      readonly [key: string]: unknown;
      readonly kind?: unknown;
      readonly span?: SourceSpan;
    };
    if (record.span !== undefined && typeof record.kind === "string") {
      if (record.kind === "functionDeclaration") functions.push(record.span);
      else if (record.kind === "block" || record.kind.endsWith("Statement"))
        blocks.push(record.span);
    }
    for (const key in record) if (key !== "span") pending.push(record[key]);
  }
  return { functions, blocks };
}

/**
 * The source debug sidecar JSON (`src/runtime/debug/source-sidecar.ts`) of `plan`, compiled from `files`: each plan
 * file's source with its `classifyTokens` classes and `sourceEnclosingSpans`.
 */
export function createSourceDebugSidecar(
  files: readonly ProjectSourceFile[],
  plan: InstructionPlan,
): string {
  const captured = captureOrReuseInstructionPlan(plan);
  if (!captured.validation.valid || captured.plan === null) {
    throw new TypeError(captured.validation.errors[0]?.message ?? "Malformed instruction plan.");
  }
  const validPlan = captured.plan;
  const sources = new Map(files.map((file) => [file.path, file.source]));
  return JSON.stringify({
    format: SOURCE_DEBUG_SIDECAR_FORMAT,
    version: SOURCE_DEBUG_SIDECAR_VERSION,
    planSha256: validatedPlanSha256(validPlan),
    files: validPlan.files.map(({ path }) => {
      const source = sources.get(path);
      if (source === undefined) throw new RangeError(`The plan's file '${path}' has no source.`);
      const parsed = parse(source);
      const spans = sourceEnclosingSpans(parsed);
      if (spans === null)
        throw new RangeError(`The source of the plan's file '${path}' does not parse.`);
      return {
        path,
        source,
        tokens: classifyTokens(source, parsed).flatMap((token) => [
          LANGUAGE_TOKEN_CLASSES.indexOf(token.kind),
          token.span.start.offset,
          token.span.end.offset,
        ]),
        enclosing: {
          functions: spans.functions.flatMap(lineSpan),
          blocks: spans.blocks.flatMap(lineSpan),
        },
      };
    }),
  });
}

function lineSpan(span: SourceSpan): number[] {
  return [span.start.line, span.start.column, span.end.line, span.end.column];
}
