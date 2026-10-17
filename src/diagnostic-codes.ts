import type { DiagnosticSeverity } from "./diagnostics.js";

/**
 * The passes and components that report diagnostics, runtime failures, and checkpoint errors, as
 * `docs/DIAGNOSTICS.md#owners` describes them.
 */
export type DiagnosticOwner =
  | "lexer"
  | "parser"
  | "name pass"
  | "type checker"
  | "compiler"
  | "lowering"
  | "plan analysis"
  | "plan validation"
  | "runtime"
  | "checkpoint";

/**
 * A code that more than one owner reports: one problem found in more than one place, when the owners report the same
 * rule, which is allowed only when they report it with the same text, or two problems, when they report different
 * mistakes under one code, which each need a code of their own (`IMPLEMENTATION-AND-REVIEW.md`, "One home for each
 * language rule").
 */
export type SharedDiagnosticCode =
  | {
      readonly problems: "one";
      readonly texts: "same" | "different";
      /** What each owner reports, in the order of the owners. */
      readonly parts: readonly string[];
    }
  | { readonly problems: "two"; readonly parts: readonly string[] };

/** What the registry records for one code. */
export interface DiagnosticCodeInfo {
  /** The passes or components that report the code: one, or several with {@link shared}. */
  readonly owners: readonly [DiagnosticOwner, ...DiagnosticOwner[]];
  readonly severity: DiagnosticSeverity;
  /** A short title, as the code's row in its document shows it. */
  readonly title: string;
  /** The document and section that explain the code, from the repository root. */
  readonly docs: string;
  readonly shared?: SharedDiagnosticCode;
  /** No longer reported. The code stays registered so that it is never given to another problem. */
  readonly retired?: true;
}

const DOCS = {
  lexer: "docs/DIAGNOSTICS.md#lexer-tsl",
  parser: "docs/DIAGNOSTICS.md#parser-tsp",
  header: "docs/DIAGNOSTICS.md#file-header-tsh",
  values: "docs/DIAGNOSTICS.md#names-types-and-values-tsv",
  tags: "docs/DIAGNOSTICS.md#tags-tst",
  compiler: "docs/DIAGNOSTICS.md#compiler-tsc",
  runtime: "docs/RUNTIME.md#runtime-errors",
  checkpoint: "docs/RUNTIME.md#checkpoint-boundary",
} as const;

/** One code's entry: its owners, severity, title, and documentation. */
function entry<const O extends DiagnosticCodeInfo["owners"], const S extends DiagnosticSeverity>(
  owners: O,
  severity: S,
  title: string,
  docs: string,
): { readonly owners: O; readonly severity: S; readonly title: string; readonly docs: string } {
  return { owners, severity, title, docs };
}

/**
 * Every diagnostic code: each code that a compiler diagnostic, runtime failure, developer warning, or checkpoint error
 * carries, once, with its owner, severity, title, and documentation. Emission sites take the code types below, so an
 * unregistered code does not compile, and `tests/diagnostic-codes.test.ts` checks the rest against the source and the
 * documents.
 */
export const DIAGNOSTIC_CODES = {
  TSL001: entry(["lexer"], "error", "Invalid character", DOCS.lexer),
  TSL002: entry(["lexer"], "error", "Unknown escape sequence", DOCS.lexer),
  TSL003: entry(["lexer"], "error", "Unterminated string", DOCS.lexer),
  TSL004: entry(["lexer"], "error", "Unterminated block string", DOCS.lexer),
  TSL005: entry(["lexer"], "error", "Unterminated interpolation", DOCS.lexer),
  TSL006: entry(["lexer"], "error", "Invalid number", DOCS.lexer),
  TSL007: entry(["lexer"], "error", "Unterminated block comment", DOCS.lexer),
  TSL008: entry(["lexer"], "error", "Newline inside a single-line string", DOCS.lexer),
  TSL009: entry(["lexer"], "error", "Unterminated regex", DOCS.lexer),

  TSP001: entry(["parser"], "error", "Expected a statement", DOCS.parser),
  TSP002: entry(["parser"], "error", "Expected the end of the statement", DOCS.parser),
  TSP003: entry(["parser"], "error", "Expected a speaker name", DOCS.parser),
  TSP004: entry(["parser"], "error", "Expected a property, option, or key name", DOCS.parser),
  TSP005: entry(["parser"], "error", "Expected `:`", DOCS.parser),
  TSP006: entry(["parser"], "error", "Expected a string", DOCS.parser),
  TSP007: entry(["parser"], "error", "Expected `}`", DOCS.parser),
  TSP008: entry(["parser"], "error", "Expected an expression in `${...}`", DOCS.parser),
  TSP009: entry(["parser"], "error", "Unsupported string or interpolation content", DOCS.parser),
  TSP010: entry(["parser"], "error", "Expected a property name after `.`", DOCS.parser),
  TSP011: entry(["parser"], "error", "Expected the end of a speaker property", DOCS.parser),
  TSP012: entry(["parser"], "error", "Expected an expression", DOCS.parser),
  TSP013: entry(["parser"], "error", "Expected a name", DOCS.parser),
  TSP014: entry(["parser"], "error", "Expected `=`", DOCS.parser),
  TSP015: entry(["parser"], "error", "Invalid assignment target", DOCS.parser),
  TSP016: entry(["parser"], "error", "Expression that is not a statement", DOCS.parser),
  TSP017: entry(["parser"], "error", "Expected a bracket, parenthesis, or separator", DOCS.parser),
  TSP018: entry(["parser"], "error", "Expected a block", DOCS.parser),
  TSP019: entry(["parser"], "error", "Positional argument after a named one", DOCS.parser),
  TSP020: entry(["parser"], "error", "Chained comparison", DOCS.parser),
  TSP021: entry(["parser"], "error", "Invalid type", DOCS.parser),
  TSP022: entry(["parser"], "error", "Chained range", DOCS.parser),
  TSP023: entry(["parser"], "error", "Expected `in`", DOCS.parser),
  TSP024: entry(["parser"], "error", "Expected a function name", DOCS.parser),
  TSP025: entry(["parser"], "error", "Expected a parameter", DOCS.parser),
  TSP026: entry(["parser"], "error", "Empty parameter parentheses", DOCS.parser),
  TSP028: entry(["parser"], "error", "Expected interaction text or an option value", DOCS.parser),
  TSP029: entry(["parser"], "error", "Expected a speaker after `as`", DOCS.parser),
  TSP030: entry(["parser"], "error", "Expected a choice option", DOCS.parser),
  TSP031: entry(["parser"], "error", "Expected `,` after a choice option", DOCS.parser),
  TSP032: entry(["parser"], "error", "Unsupported interaction form", DOCS.parser),
  TSP033: entry(["parser"], "error", "Misplaced or invalid unit", DOCS.parser),
  TSP034: entry(["parser"], "error", "Invalid timer form", DOCS.parser),
  TSP035: entry(["parser"], "error", "Invalid media or permanent button form", DOCS.parser),
  TSP036: entry(["parser"], "error", "Expected a storage key", DOCS.parser),
  TSP037: entry(["parser"], "error", "Symbol where TeaseScript writes a word", DOCS.parser),
  TSP038: entry(["parser"], "error", "Invalid switch form", DOCS.parser),
  TSP039: entry(["parser"], "error", "Expected a label name or file path", DOCS.parser),
  TSP040: entry(["parser"], "error", "Invalid load form", DOCS.parser),
  TSP041: entry(["parser"], "error", "Unclear `otherwise` without parentheses", DOCS.parser),

  TSH001: entry(["parser"], "error", "Header without a closing line", DOCS.header),
  TSH002: entry(["parser"], "error", "Misplaced header", DOCS.header),
  TSH003: entry(["parser"], "error", "Expected a header field", DOCS.header),
  TSH004: entry(["parser"], "error", "Unknown header field", DOCS.header),
  TSH005: entry(["parser"], "error", "Repeated header field", DOCS.header),
  TSH006: entry(["parser"], "error", "Expected text", DOCS.header),
  TSH007: entry(["parser"], "error", "Interpolation in a header", DOCS.header),
  TSH008: entry(["parser"], "error", "Expected a tag", DOCS.header),
  TSH009: entry(["parser"], "error", "Invalid tag name", DOCS.header),
  TSH010: entry(["parser"], "error", "Invalid tag value", DOCS.header),
  TSH011: entry(["parser"], "warning", "Repeated tag", DOCS.header),
  TSH012: entry(["parser"], "error", "Tag with two different numbers", DOCS.header),
  TSH013: entry(["parser"], "error", "Empty keyword", DOCS.header),
  TSH014: entry(["parser"], "warning", "Repeated keyword", DOCS.header),
  TSH015: entry(["parser"], "error", "Expected the end of the line", DOCS.header),
  TSH016: entry(["parser"], "error", "Expected a value", DOCS.header),

  TSV001: {
    ...entry(
      ["parser", "name pass"],
      "error",
      "Protected name, or name already in use",
      DOCS.values,
    ),
    shared: {
      problems: "one",
      texts: "same",
      parts: [
        "a declaration whose name is a keyword or another protected name, where it reads the name",
        "the same rule with the same text (`protectedNameMessage`) where it finds such a declaration, " +
          "and a name that is already in use",
      ],
    },
  },
  TSV002: entry(["name pass"], "error", "Unknown variable", DOCS.values),
  TSV003: entry(["name pass"], "error", "Assignment to an unknown variable", DOCS.values),
  TSV004: {
    ...entry(["name pass", "type checker"], "error", "Invalid assignment", DOCS.values),
    shared: {
      problems: "two",
      parts: [
        "an assignment to `debugMode`, `account`, a speaker, or a global that the host gives, " +
          "and a change of the account",
        "a change of a copy that no variable holds, such as a property of a call's result, " +
          "which is lost",
      ],
    },
  },
  TSV005: entry(["name pass"], "error", "Unknown speaker", DOCS.values),
  TSV007: {
    ...entry(["name pass", "type checker"], "error", "Duplicate property or key", DOCS.values),
    shared: {
      problems: "one",
      texts: "different",
      parts: [
        "a property name that a speaker declaration or an object literal gives twice",
        "a key that a dict literal gives twice, also through a computed key whose text is known",
      ],
    },
  },
  TSV008: entry(["name pass"], "error", "`break` or `continue` outside a loop", DOCS.values),
  TSV009: entry(["name pass"], "error", "Chained range", DOCS.values),
  TSV010: entry(["type checker"], "error", "Invalid range bound or empty range", DOCS.values),
  TSV011: entry(
    ["type checker"],
    "error",
    "Invalid wait, timer, repeat count, or pacing",
    DOCS.values,
  ),
  TSV012: entry(["type checker"], "error", "Invalid `for` loop source", DOCS.values),
  TSV013: entry(["name pass"], "error", "Duplicate function", DOCS.values),
  TSV014: entry(["name pass"], "error", "Duplicate parameter", DOCS.values),
  TSV015: entry(["name pass"], "error", "Required parameter after a default", DOCS.values),
  TSV016: entry(["name pass"], "error", "Nested function", DOCS.values),
  TSV017: entry(["name pass"], "error", "`return` outside a function", DOCS.values),
  TSV018: entry(["name pass"], "error", "Unknown function", DOCS.values),
  TSV019: entry(["name pass"], "error", "Call of a value that is not a function", DOCS.values),
  TSV020: {
    ...entry(
      ["name pass", "type checker"],
      "error",
      "Wrong number or form of arguments",
      DOCS.values,
    ),
    shared: {
      problems: "one",
      texts: "different",
      parts: [
        "calls of the script's functions and of built-ins by name, such as `load` without " +
          "`default:`, `askImage`, `showPopup`, `openUrl`, `exportText`, and `takePhoto`",
        "method calls, `script(...)`, and the functions of the current date and time",
      ],
    },
  },
  TSV022: {
    ...entry(["name pass", "type checker"], "error", "Unknown named argument", DOCS.values),
    shared: {
      problems: "one",
      texts: "different",
      parts: [
        "calls of the script's functions and of built-ins by name",
        "method calls and `script(...)`",
      ],
    },
  },
  TSV023: entry(["name pass"], "error", "Argument given twice", DOCS.values),
  TSV024: entry(["name pass"], "error", "Missing argument", DOCS.values),
  TSV025: entry(["name pass"], "error", "Default that uses a later parameter", DOCS.values),
  TSV026: entry(["name pass"], "error", "Assignment to a function", DOCS.values),
  TSV028: entry(["name pass"], "error", "Function or built-in used as a value", DOCS.values),
  TSV029: {
    ...entry(["name pass", "type checker"], "error", "Invalid choice", DOCS.values),
    shared: {
      problems: "one",
      texts: "different",
      parts: [
        "a choice without options, which the parser already rejects with `TSP030`, so no " +
          "source reaches it",
        "option lists that are known to be empty, and the values, objects, number, and " +
          "backgrounds of the options",
      ],
    },
  },
  TSV032: entry(["name pass"], "error", "Blocking command in a parameter default", DOCS.values),
  TSV033: {
    ...entry(
      ["name pass", "type checker"],
      "error",
      "Invalid timer or handler return",
      DOCS.values,
    ),
    shared: {
      problems: "two",
      parts: [
        "a blocking timer with a block, `repeat`, `persist`, or a handle, and `return` with a " +
          "value in a timer, media, or button block",
        "a timer's `display:` value",
      ],
    },
  },
  TSV034: entry(["type checker"], "error", "Invalid timer handle member", DOCS.values),
  TSV035: entry(["type checker"], "error", "Duration combined with a number", DOCS.values),
  TSV036: {
    ...entry(["name pass", "type checker"], "error", "Invalid media", DOCS.values),
    shared: {
      problems: "two",
      parts: [
        "blocking media with a handle, and `finish` twice in a media block",
        "a play command's or `showImage`'s file, `volume:`, `repeat:`, `startAt:`, `endAt:`, " +
          "and cue positions, and `finish` with a repeat that never ends",
      ],
    },
  },
  TSV037: entry(["type checker"], "error", "Invalid media handle member", DOCS.values),
  TSV038: entry(["type checker"], "error", "Invalid storage key", DOCS.values),
  TSV039: entry(["type checker"], "error", "Invalid prefill", DOCS.values),
  TSV040: entry(["type checker"], "error", "List where text is shown", DOCS.values),
  TSV041: entry(["type checker"], "error", "Type mismatch", DOCS.values),
  TSV042: entry(["type checker"], "error", "Value that cannot be shown", DOCS.values),
  TSV043: {
    ...entry(
      ["type checker", "plan analysis"],
      "error",
      "Unsupported operand, method, or property",
      DOCS.values,
    ),
    shared: {
      problems: "one",
      texts: "different",
      parts: [
        "every operation that its operands do not support, among them a speaker property that " +
          "no declaration or assignment gives a speaker the read may reach",
        "a speaker property that a way to the read misses (V30 §37)",
      ],
    },
  },
  TSV044: entry(["type checker"], "error", "Mixed types", DOCS.values),
  TSV045: entry(["type checker"], "error", "Negative list index", DOCS.values),
  TSV046: entry(["type checker"], "warning", "Test with a constant result", DOCS.values),
  TSV047: entry(["name pass"], "error", "Invalid `case` value", DOCS.values),
  TSV048: entry(["name pass"], "error", "Repeated or overlapping `case`", DOCS.values),
  TSV049: entry(["type checker"], "error", "`case` that can never match", DOCS.values),
  TSV050: entry(["type checker"], "error", "Known values without a finite result", DOCS.values),
  TSV051: entry(["name pass"], "error", "Invalid label", DOCS.values),
  TSV052: entry(["plan analysis"], "error", "File end without `exit` or `end`", DOCS.values),
  TSV053: entry(["plan analysis"], "error", "Script that never reaches `exit`", DOCS.values),
  TSV054: entry(
    ["name pass"],
    "error",
    "Variable that a `goto` may leave without a value",
    DOCS.values,
  ),
  TSV055: {
    ...entry(["name pass", "type checker"], "error", "Invalid start value", DOCS.values),
    shared: {
      problems: "one",
      texts: "different",
      parts: [
        "a start value that says, asks, waits, plays media, calls a function, or uses a local " +
          "or a later global",
        "a start value that selects at random, with `.random` or a list in `${...}`, which " +
          "needs the value's type",
      ],
    },
  },
  TSV056: entry(["name pass"], "error", "Global function that uses names of its file", DOCS.values),
  TSV057: entry(["name pass"], "error", "Invalid file target", DOCS.values),
  TSV058: entry(["plan analysis"], "warning", "Loop with no way out", DOCS.values),
  TSV059: entry(["type checker"], "error", "Invalid camera view member", DOCS.values),
  TSV061: entry(["compiler"], "warning", "Wait or timer written in days or weeks", DOCS.values),
  TSV062: entry(["type checker"], "warning", "Fallback that is never used", DOCS.values),
  TSV063: entry(["name pass"], "error", "`speaker` without a speaker", DOCS.values),
  TSV064: entry(["name pass"], "error", "Invalid regex", DOCS.values),
  TSV065: entry(["plan analysis"], "warning", "Code that never runs", DOCS.values),
  TSV066: entry(["plan analysis"], "warning", "`exit` that never runs", DOCS.values),

  TST001: entry(["parser"], "error", "Invalid tag query", DOCS.tags),
  TST002: entry(["type checker"], "error", "Tag query that matches nothing", DOCS.tags),
  TST003: entry(["compiler"], "warning", "Image keywords that are not tags", DOCS.tags),
  TST004: entry(["compiler"], "error", "Image tag with two different numbers", DOCS.tags),
  TST005: entry(["type checker"], "error", "Invalid tag", DOCS.tags),
  TST006: entry(["type checker"], "error", "Invalid `from:` of a tag query", DOCS.tags),

  TSC001: {
    ...entry(
      ["parser", "plan validation"],
      "error",
      "Literal that is not finite, or unsupported plan format",
      DOCS.compiler,
    ),
    shared: {
      problems: "two",
      parts: [
        "a number or duration literal that is not finite",
        "an instruction plan of an unsupported format or version",
      ],
    },
  },
  TSC002: entry(["plan validation"], "error", "Malformed instruction plan", DOCS.compiler),
  TSC003: entry(["lowering"], "error", "Lowering failure", DOCS.compiler),
  TSC006: entry(["compiler"], "error", "Compiled plan rejected by plan validation", DOCS.compiler),
  TSC007: entry(["compiler"], "error", "Host call stack exhausted", DOCS.compiler),
  TSC008: entry(
    ["type checker"],
    "error",
    "Invalid presentation option or markup colour",
    DOCS.compiler,
  ),
  TSC009: entry(["compiler"], "error", "Invalid or repeated package path", DOCS.compiler),

  TSR001: entry(["runtime"], "error", "Declaration set up twice (defect)", DOCS.runtime),
  TSR002: entry(["runtime"], "error", "Assignment without a variable (defect)", DOCS.runtime),
  TSR003: entry(["runtime"], "error", "Property that cannot be assigned", DOCS.runtime),
  TSR004: entry(["runtime"], "error", "Index on a set", DOCS.runtime),
  TSR005: entry(
    ["runtime"],
    "error",
    "Index assignment on a value that is not a list or dict",
    DOCS.runtime,
  ),
  TSR006: entry(["runtime"], "error", "Unknown name (defect)", DOCS.runtime),
  TSR007: entry(["runtime"], "error", "Property set up twice (defect)", DOCS.runtime),
  TSR008: entry(["runtime"], "error", "Index on a value that is not a list or dict", DOCS.runtime),
  TSR009: entry(["runtime"], "error", "Operator that cannot combine its operands", DOCS.runtime),
  TSR010: entry(["runtime"], "error", "Named argument given twice (defect)", DOCS.runtime),
  TSR011: entry(
    ["runtime"],
    "error",
    "Built-in function that the host does not provide",
    DOCS.runtime,
  ),
  TSR012: entry(["runtime"], "error", "Host built-in failed", DOCS.runtime),
  TSR013: entry(["runtime"], "error", "Host built-in returned an invalid value", DOCS.runtime),
  TSR014: entry(["runtime"], "error", "Call of a value that is not a function", DOCS.runtime),
  TSR015: entry(["runtime"], "error", "Named arguments where a call takes none", DOCS.runtime),
  TSR016: entry(["runtime"], "error", "Unknown method", DOCS.runtime),
  TSR017: entry(["runtime"], "error", "Unknown property", DOCS.runtime),
  TSR018: entry(["runtime"], "error", "Too few elements", DOCS.runtime),
  TSR019: entry(["runtime"], "error", "Random selection from an empty list or set", DOCS.runtime),
  TSR020: entry(["runtime"], "error", "Host random number out of range", DOCS.runtime),
  TSR021: entry(["runtime"], "error", "Value that cannot be shown as text", DOCS.runtime),
  TSR022: entry(["runtime"], "error", "Empty speaker display name", DOCS.runtime),
  TSR023: entry(["runtime"], "error", "Speaker the session does not have (defect)", DOCS.runtime),
  TSR024: entry(["runtime"], "error", "Index or position that is not a whole number", DOCS.runtime),
  TSR025: entry(["runtime"], "error", "Index or position out of range", DOCS.runtime),
  TSR026: entry(["runtime"], "error", "Condition that is not true or false", DOCS.runtime),
  TSR027: entry(["runtime"], "error", "Operand that is not a number", DOCS.runtime),
  TSR028: entry(["runtime"], "error", "Wrong number or form of arguments", DOCS.runtime),
  TSR029: {
    ...entry(
      ["runtime"],
      "error",
      "Equality of composite values",
      "docs/RUNTIME.md#instruction-plan-history",
    ),
    retired: true,
  },
  TSR030: entry(["runtime"], "error", "Speaker property shown that is not text", DOCS.runtime),
  TSR031: entry(
    ["runtime"],
    "error",
    "Host value of a shape a script value cannot have",
    DOCS.runtime,
  ),
  TSR032: {
    ...entry(
      ["runtime"],
      "error",
      "Set member of an unsupported kind",
      "docs/RUNTIME.md#instruction-plan-history",
    ),
    retired: true,
  },
  TSR033: entry(["runtime"], "error", "Leaving the root scope (defect)", DOCS.runtime),
  TSR034: entry(["runtime"], "error", "Assignment to a speaker's name (defect)", DOCS.runtime),
  TSR035: entry(["runtime"], "error", "Unsupported operation (defect)", DOCS.runtime),
  TSR036: entry(["runtime"], "error", "Arithmetic without a finite result", DOCS.runtime),
  TSR037: entry(["runtime"], "error", "Instruction budget used up", DOCS.runtime),
  TSR039: entry(["runtime"], "error", "Numeric argument out of range", DOCS.runtime),
  TSR040: entry(["runtime"], "error", "`randomInteger` without a range", DOCS.runtime),
  TSR041: entry(["runtime"], "error", "Random selection from an empty range", DOCS.runtime),
  TSR042: entry(
    ["runtime"],
    "error",
    "Loop state that does not match the plan (defect)",
    DOCS.runtime,
  ),
  TSR043: entry(["runtime"], "error", "Invalid `repeat` count", DOCS.runtime),
  TSR044: entry(["runtime"], "error", "`for` loop over a value it cannot go through", DOCS.runtime),
  TSR045: entry(["runtime"], "error", "Range bounds that are not safe whole numbers", DOCS.runtime),
  TSR046: entry(["runtime"], "error", "Missing temporary value (defect)", DOCS.runtime),
  TSR047: entry(["runtime"], "error", "Call depth limit exceeded", DOCS.runtime),
  TSR048: entry(["runtime"], "error", "Inconsistent parameter state (defect)", DOCS.runtime),
  TSR049: entry(["runtime"], "error", "Required parameter without a value (defect)", DOCS.runtime),
  TSR050: entry(["runtime"], "error", "Command or handle value that cannot be used", DOCS.runtime),
  TSR051: entry(["runtime"], "error", "Runtime counter used up", DOCS.runtime),
  TSR052: entry(["runtime"], "error", "Interaction that cannot open", DOCS.runtime),
  TSR053: entry(
    ["runtime"],
    "error",
    "Removed dict entry, or malformed handle state",
    DOCS.runtime,
  ),
  TSR054: entry(["runtime"], "error", "Storage key that is not text", DOCS.runtime),
  TSR055: entry(
    ["runtime"],
    "error",
    "Save of a value that exists only in the session",
    DOCS.runtime,
  ),
  TSR057: entry(["runtime"], "error", "Count or text argument that cannot be used", DOCS.runtime),
  TSR058: entry(["runtime"], "error", "Value that does not fit its type", DOCS.runtime),
  TSR059: entry(["runtime"], "error", "Built-in argument of the wrong kind", DOCS.runtime),
  TSR060: entry(["runtime"], "error", "Collection elements of the wrong kind", DOCS.runtime),
  TSR061: entry(["runtime"], "error", "Missing dict key", DOCS.runtime),
  TSR062: entry(["runtime"], "error", "Dict key that is not text", DOCS.runtime),
  TSR063: entry(["runtime"], "error", "Date or time out of range", DOCS.runtime),
  TSR064: entry(["runtime"], "error", "Current time without a clock", DOCS.runtime),
  TSR065: entry(["runtime"], "error", "Calendar duration where a duration is needed", DOCS.runtime),
  TSR066: entry(["runtime"], "error", "File end without a calling file", DOCS.runtime),
  TSR067: entry(["runtime"], "error", "Start value that selects at random", DOCS.runtime),
  TSR069: entry(["runtime"], "error", "Missing `goto`, `call`, or `fallback` target", DOCS.runtime),
  TSR070: entry(["runtime"], "error", "Variable read before its `let` ran", DOCS.runtime),
  TSR071: entry(["runtime"], "error", "`speaker` without a speaker", DOCS.runtime),
  TSR080: entry(["runtime"], "error", "Tag number compared with something else", DOCS.runtime),
  TSR081: entry(["runtime"], "error", "Tag query option that is not tag names", DOCS.runtime),
  TSR082: entry(["runtime"], "error", "Tag query that matches nothing", DOCS.runtime),
  TSR083: entry(["runtime"], "error", "Invalid `takePhoto` tags", DOCS.runtime),
  TSR084: entry(["runtime"], "error", "Text too long", DOCS.runtime),
  TSR085: entry(["runtime"], "error", "Stored file that could not be read", DOCS.runtime),
  TSR086: entry(["runtime"], "error", "Lock that could not be made or opened", DOCS.runtime),
  TSR087: entry(["runtime"], "error", "Regex work limit exceeded", DOCS.runtime),
  TSR088: entry(["runtime"], "error", "Collection too large", DOCS.runtime),
  TSR100: entry(["runtime"], "error", "Invalid instruction plan", DOCS.runtime),
  TSR101: entry(["runtime"], "error", "Invalid runtime snapshot", DOCS.runtime),

  TSW001: entry(
    ["runtime"],
    "warning",
    "Speaker shown by its identifier",
    "docs/RUNTIME.md#globals-global-functions-and-speakers",
  ),
  TSW002: entry(["runtime"], "warning", "`remove(...)` found no matching value", DOCS.runtime),
  TSW010: entry(
    ["runtime"],
    "warning",
    "Handle operation without effect",
    "docs/specifications/accepted-syntaxes-v30.md#handles",
  ),
  TSW011: entry(
    ["runtime"],
    "warning",
    "`null` image or media file",
    "docs/specifications/accepted-syntaxes-v30.md#34-runtime-warnings-and-recoverable-values",
  ),
  TSW012: entry(
    ["runtime"],
    "warning",
    "Media cue outside the playback range",
    "docs/specifications/accepted-syntaxes-v30.md#cues",
  ),
  TSW013: entry(
    ["runtime"],
    "warning",
    "Media that could not be played",
    "docs/RUNTIME.md#stage-image-and-media-playback",
  ),
  TSW014: entry(
    ["runtime"],
    "warning",
    "Storage write that could not persist",
    "docs/RUNTIME.md#script-storage",
  ),
  TSW015: entry(["runtime"], "warning", "Camera unavailable", "docs/RUNTIME.md#camera-capture"),
  TSW016: entry(
    ["runtime"],
    "warning",
    "Stored value that does not fit the load's type",
    "docs/RUNTIME.md#script-storage",
  ),
  TSW017: entry(
    ["runtime"],
    "warning",
    "Prefill that no button has",
    "docs/RUNTIME.md#generic-foreground-interactions",
  ),
  TSW018: entry(
    ["runtime"],
    "warning",
    "Timer round that started before its block finished",
    "docs/RUNTIME.md#timers-and-scene-time",
  ),
  TSW019: entry(
    ["runtime"],
    "warning",
    "File that the Player could not keep",
    "docs/RUNTIME.md#stored-files",
  ),

  TSK001: entry(
    ["checkpoint"],
    "error",
    "Unsupported checkpoint format or version",
    DOCS.checkpoint,
  ),
  TSK002: entry(["checkpoint"], "error", "Malformed checkpoint", DOCS.checkpoint),
  TSK003: entry(["checkpoint"], "error", "Checkpoint that is not JSON", DOCS.checkpoint),
  TSK004: entry(["checkpoint"], "error", "State too large to save", DOCS.checkpoint),
} as const satisfies Record<string, DiagnosticCodeInfo>;

type Registry = typeof DIAGNOSTIC_CODES;

/** A code that may be reported: every registered code but the retired ones. */
export type DiagnosticCode = {
  [C in keyof Registry]: Registry[C] extends { readonly retired: true } ? never : C;
}[keyof Registry];

/** The severity that `code` is reported with. */
export type DiagnosticCodeSeverity<C extends DiagnosticCode> = Registry[C]["severity"];

/** The codes that `owner` reports, with `severity` when it is given. */
export type OwnedDiagnosticCode<
  O extends DiagnosticOwner,
  S extends DiagnosticSeverity = DiagnosticSeverity,
> = {
  [C in DiagnosticCode]: O extends Registry[C]["owners"][number]
    ? Registry[C]["severity"] extends S
      ? C
      : never
    : never;
}[DiagnosticCode];

/** The code of a runtime failure. */
export type RuntimeErrorCode = OwnedDiagnosticCode<"runtime", "error">;

/** The code of a developer warning. */
export type DeveloperWarningCode = OwnedDiagnosticCode<"runtime", "warning">;
