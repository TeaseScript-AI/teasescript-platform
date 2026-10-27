import type { OwnedDiagnosticCode } from "../diagnostic-codes.js";
import { DiagnosticSeverity, type Diagnostic } from "../diagnostics.js";
import { FOREIGN_FORM_CODE } from "../language-facts.js";

// The name pass's diagnostic codes, and which of its errors leave the type check its basis.

export const semanticCode = {
  duplicateDeclaration: "TSV001",
  unknownVariable: "TSV002",
  unknownAssignment: "TSV003",
  invalidAssignment: "TSV004",
  unknownSpeaker: "TSV005",
  duplicateProperty: "TSV007",
  invalidLoopControl: "TSV008",
  chainedRange: "TSV009",
  duplicateFunction: "TSV013",
  duplicateParameter: "TSV014",
  requiredAfterDefault: "TSV015",
  nestedFunction: "TSV016",
  returnOutsideFunction: "TSV017",
  unknownFunction: "TSV018",
  nonCallable: "TSV019",
  argumentCount: "TSV020",
  unknownNamedArgument: "TSV022",
  duplicateNamedArgument: "TSV023",
  missingNamedArgument: "TSV024",
  laterParameterDefault: "TSV025",
  functionAssignment: "TSV026",
  functionValue: "TSV028",
  unsupportedBlockingContext: "TSV032",
  invalidTimer: "TSV033",
  invalidLabel: "TSV051",
  skippedInitialization: "TSV054",
  invalidStartValue: "TSV055",
  fileName: "TSV056",
  invalidFileTarget: "TSV057",
  noSpeaker: "TSV063",
  invalidRegex: "TSV064",
  invalidMediaForm: "TSV069",
  foreignForm: FOREIGN_FORM_CODE,
} as const satisfies Record<string, NamePassCode>;

export type NamePassCode = OwnedDiagnosticCode<"name pass", "error">;

/**
 * The name-pass errors that leave the type check its basis: every name resolves, and every construct it walks is whole.
 * They are a start value's placement (TSV055) and a `load` without `default:`, so the type check still reports the
 * problems of the values in them, such as a load's key that is a comparison.
 */
export const LEAVES_TYPES_CHECKABLE = new WeakSet<Diagnostic>();

/** Whether a name-pass error leaves the type check without a basis (see `LEAVES_TYPES_CHECKABLE`). */
export function stopsTypeCheck(diagnostic: Diagnostic): boolean {
  return (
    diagnostic.severity === DiagnosticSeverity.Error && !LEAVES_TYPES_CHECKABLE.has(diagnostic)
  );
}
