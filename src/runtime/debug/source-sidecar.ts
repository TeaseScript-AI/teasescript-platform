import { captureOrReuseInstructionPlan } from "../../plan/capture.js";
import type { InstructionPlan } from "../../plan/model.js";
import { LANGUAGE_TOKEN_CLASSES, type LanguageTokenClass } from "../../token-classes.js";
import { serializeValidatedRuntimeJson } from "../snapshot/checkpoint.js";
import { textSha256 } from "../values/sha256.js";

/**
 * The source debug sidecar: what source views of a debugger show of a plan's files, made when the plan is compiled
 * (`createSourceDebugSidecar`), so that playback shows source without the parser or compiler. Its JSON:
 * `{format, version, planSha256, files}`, where `planSha256` is the SHA-256 of the plan's JSON and each file, in plan
 * order, is `{path, source, tokens, enclosing}`: `tokens` are flat `[class, start, end]` triples, the index of the
 * class in `LANGUAGE_TOKEN_CLASSES` and the offsets of the token or comment; `enclosing` is `{functions, blocks}`, flat
 * `[startLine, startColumn, endLine, endColumn]` quadruples of the parser's zero-based positions.
 */
export const SOURCE_DEBUG_SIDECAR_FORMAT = "teasescript-source-debug";
export const SOURCE_DEBUG_SIDECAR_VERSION = 1;

export interface SourceDebugToken {
  readonly kind: LanguageTokenClass;
  readonly start: number;
  readonly end: number;
}

/** A span in the parser's zero-based lines and columns. */
export interface SourceDebugSpan {
  readonly startLine: number;
  readonly startColumn: number;
  readonly endLine: number;
  readonly endColumn: number;
}

export interface SourceDebugFile {
  readonly path: string;
  readonly source: string;
  /** Its tokens and comments, in order and apart, with the class `classifyTokens` gives them. */
  readonly tokens: readonly SourceDebugToken[];
  /** Every function's span, and every statement's and statement block's, in the parser's walk order: they nest. */
  readonly enclosing: {
    readonly functions: readonly SourceDebugSpan[];
    readonly blocks: readonly SourceDebugSpan[];
  };
}

export interface SourceDebugSidecar {
  readonly files: readonly SourceDebugFile[];
}

/** A loaded sidecar, one that is not one, or one made for another plan. */
export type SourceDebugSidecarLoad =
  | { readonly kind: "valid"; readonly sidecar: SourceDebugSidecar }
  | { readonly kind: "invalid"; readonly message: string }
  | { readonly kind: "stale"; readonly message: string };

const planDigests = new WeakMap<InstructionPlan, string>();

/** The SHA-256 of the JSON of a validated plan, once per plan: only a source view needs it. */
export function validatedPlanSha256(plan: InstructionPlan): string {
  let digest = planDigests.get(plan);
  if (digest === undefined) {
    digest = textSha256(serializeValidatedRuntimeJson(plan));
    planDigests.set(plan, digest);
  }
  return digest;
}

/** Loads sidecar JSON text for `plan`: completely checked, and only if it was made for exactly this plan. */
export function loadSourceDebugSidecar(
  text: unknown,
  plan: InstructionPlan,
): SourceDebugSidecarLoad {
  const captured = captureOrReuseInstructionPlan(plan);
  if (!captured.validation.valid || captured.plan === null) {
    throw new TypeError(captured.validation.errors[0]?.message ?? "Malformed instruction plan.");
  }
  const validPlan = captured.plan;
  if (typeof text !== "string") return invalid("Source debug sidecar text must be a string.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return invalid(`Source debug sidecar JSON is invalid: ${message}`);
  }
  if (!isObject(parsed, ["format", "version", "planSha256", "files"])) {
    return invalid("A source debug sidecar has exactly a format, version, planSha256 and files.");
  }
  if (
    parsed.format !== SOURCE_DEBUG_SIDECAR_FORMAT ||
    parsed.version !== SOURCE_DEBUG_SIDECAR_VERSION
  ) {
    return invalid("Unsupported source debug sidecar format or revision.");
  }
  if (typeof parsed.planSha256 !== "string" || !/^[0-9a-f]{64}$/.test(parsed.planSha256)) {
    return invalid("A source debug sidecar's planSha256 is 64 lowercase hexadecimal digits.");
  }
  if (!Array.isArray(parsed.files)) return invalid("A source debug sidecar's files are an array.");
  const files: SourceDebugFile[] = [];
  for (let index = 0; index < parsed.files.length; index += 1) {
    const file = sidecarFile(parsed.files[index]);
    if (typeof file === "string") return invalid(`Source debug sidecar file ${index}: ${file}`);
    files.push(file);
  }
  if (
    files.length !== validPlan.files.length ||
    files.some((file, index) => file.path !== validPlan.files[index]!.path)
  ) {
    return stale("The source debug sidecar lists other files than the plan.");
  }
  if (parsed.planSha256 !== validatedPlanSha256(validPlan)) {
    return stale("The source debug sidecar was made for another plan.");
  }
  return Object.freeze({ kind: "valid", sidecar: Object.freeze({ files: Object.freeze(files) }) });
}

/** One file of a sidecar, or what is wrong with it. */
function sidecarFile(value: unknown): SourceDebugFile | string {
  if (!isObject(value, ["path", "source", "tokens", "enclosing"])) {
    return "a file has exactly a path, source, tokens and enclosing.";
  }
  const { path, source } = value;
  if (typeof path !== "string" || typeof source !== "string") {
    return "a file's path and source are strings.";
  }
  const tokens = sidecarTokens(value.tokens, source.length);
  if (tokens === null) {
    return "tokens are [class, start, end] triples, in order and apart, within the source.";
  }
  if (!isObject(value.enclosing, ["functions", "blocks"])) {
    return "enclosing has exactly functions and blocks.";
  }
  const lines = lineLengths(source);
  const functions = sidecarSpans(value.enclosing.functions, lines);
  const blocks = sidecarSpans(value.enclosing.blocks, lines);
  if (functions === null || blocks === null) {
    return "enclosing spans are [startLine, startColumn, endLine, endColumn] quadruples within the source.";
  }
  return Object.freeze({ path, source, tokens, enclosing: Object.freeze({ functions, blocks }) });
}

function sidecarTokens(value: unknown, sourceLength: number): readonly SourceDebugToken[] | null {
  if (!Array.isArray(value) || value.length % 3 !== 0) return null;
  const tokens: SourceDebugToken[] = [];
  let previousEnd = 0;
  for (let index = 0; index < value.length; index += 3) {
    const [kind, start, end] = [value[index], value[index + 1], value[index + 2]];
    if (
      !isIndex(kind) ||
      kind >= LANGUAGE_TOKEN_CLASSES.length ||
      !isIndex(start) ||
      !isIndex(end) ||
      start < previousEnd ||
      end <= start ||
      end > sourceLength
    ) {
      return null;
    }
    tokens.push(Object.freeze({ kind: LANGUAGE_TOKEN_CLASSES[kind]!, start, end }));
    previousEnd = end;
  }
  return Object.freeze(tokens);
}

function sidecarSpans(value: unknown, lines: readonly number[]): readonly SourceDebugSpan[] | null {
  if (!Array.isArray(value) || value.length % 4 !== 0 || !value.every(isIndex)) return null;
  // EVIDENCE: validation: every element passed isIndex above.
  const numbers = value as readonly number[];
  const spans: SourceDebugSpan[] = [];
  for (let index = 0; index < numbers.length; index += 4) {
    const [startLine, startColumn, endLine, endColumn] = [
      numbers[index]!,
      numbers[index + 1]!,
      numbers[index + 2]!,
      numbers[index + 3]!,
    ];
    if (
      startLine >= lines.length ||
      endLine >= lines.length ||
      startColumn > lines[startLine]! ||
      endColumn > lines[endLine]! ||
      endLine < startLine ||
      (endLine === startLine && endColumn < startColumn)
    ) {
      return null;
    }
    spans.push(Object.freeze({ startLine, startColumn, endLine, endColumn }));
  }
  return Object.freeze(spans);
}

/** The length of each line of `source`, split at line feeds. */
function lineLengths(source: string): number[] {
  const lengths: number[] = [];
  let start = 0;
  for (let index = source.indexOf("\n"); index >= 0; index = source.indexOf("\n", index + 1)) {
    lengths.push(index - start);
    start = index + 1;
  }
  lengths.push(source.length - start);
  return lengths;
}

function isIndex(value: unknown): value is number {
  // EVIDENCE: validation: Number.isSafeInteger establishes the numeric value before comparison.
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isObject<const K extends string>(
  value: unknown,
  keys: readonly K[],
): value is { readonly [key in K]: unknown } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function invalid(message: string): SourceDebugSidecarLoad {
  return Object.freeze({ kind: "invalid", message });
}

function stale(message: string): SourceDebugSidecarLoad {
  return Object.freeze({ kind: "stale", message });
}
