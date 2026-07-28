import { MAX_LIBRARY_SOURCE_LENGTH } from "../src/library-tooling/public.js";

/** Local, non-authoritative development fixtures; none define a library contract. */
export const validLibraryFixtures = Object.freeze([
  Object.freeze({
    name: "canonical signatures",
    identityToken: "fixtures.alpha@exact-1",
    source: `
/** Calculates a neutral result. */
export function calculateValue(required: string, optional?: number, defaulted: boolean = false): SampleResult { return { value: required } }
/** Formats a neutral input.\n * @deprecated Prefer calculateValue. */
export function formatValue(input: SampleInput): string { return input.value }
export interface SampleResult { value: string }
export type SampleInput = { value: string }
`,
    exportNames: ["SampleInput", "SampleResult", "calculateValue", "formatValue"],
  }),
  Object.freeze({
    name: "empty public export set",
    identityToken: "fixtures.empty@exact-1",
    source: "const localOnly = 1; void localOnly;",
    exportNames: [],
  }),
  Object.freeze({
    name: "largest ordinary bounded source",
    identityToken: "fixtures.large@exact-1",
    source: `export function alpha(): void {}${" ".repeat(MAX_LIBRARY_SOURCE_LENGTH - 33)}`,
    exportNames: ["alpha"],
  }),
] as const);

export const invalidLibraryFixtures = Object.freeze([
  Object.freeze({ name: "invalid syntax", source: "export function broken( {", code: "invalidSource" }),
  Object.freeze({ name: "default export", source: "export default function alpha(): void {}", code: "unsupportedExport" }),
  Object.freeze({ name: "generic function", source: "export function alpha<T>(value: T): T { return value }", code: "unsupportedExport" }),
  Object.freeze({ name: "generic type alias", source: "export type SampleInput<T> = T", code: "unsupportedExport" }),
  Object.freeze({ name: "rest parameter", source: "export function alpha(...values: string[]): void {}", code: "unsupportedExport" }),
  Object.freeze({ name: "this parameter", source: "export function alpha(this: object): void {}", code: "unsupportedExport" }),
  Object.freeze({ name: "destructured parameter", source: "export function alpha({ value }: { value: string }): void {}", code: "unsupportedExport" }),
  Object.freeze({ name: "unsupported declaration", source: "export const alpha = 1", code: "unsupportedExport" }),
  Object.freeze({ name: "duplicate public names", source: "export function alpha(): void {}\nexport interface alpha {}", code: "duplicateExport" }),
  Object.freeze({ name: "oversized source", source: " ".repeat(MAX_LIBRARY_SOURCE_LENGTH + 1), code: "invalidSource" }),
] as const);
