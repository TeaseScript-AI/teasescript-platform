// The marks a debug export or a kept session carries when the player edited or rewound while debugging, and the strict
// reading they share with the rest of a debug export (`debug-export.ts`), without its replay, which needs the engine.

export interface DebugEditedWhileDebugging {
  readonly firstEditSceneTimeMs: number;
  readonly editCount: number;
}

export interface DebugRewoundWhileDebugging {
  readonly restoredSceneTimeMs: number;
  readonly rewindCount: number;
}

/** The marks a session carries for a debug export, which travel with each state Debug restores. */
export interface HistoryMarks {
  readonly editedWhileDebugging: DebugEditedWhileDebugging | null;
  readonly rewoundWhileDebugging: DebugRewoundWhileDebugging | null;
}

/** No marks: a session Debug neither edited nor rewound. */
export const NO_MARKS: HistoryMarks = Object.freeze({
  editedWhileDebugging: null,
  rewoundWhileDebugging: null,
});

/**
 * `value` as a session's marks, validated as checkpoint data is (a kept session's or a restore's marks reach the host
 * from the page); throws `DebugExportError` for a malformed value.
 */
export function parseHistoryMarks(value: unknown): HistoryMarks {
  const marks = record(value, "$.marks");
  exactly(marks, "$.marks", ["editedWhileDebugging", "rewoundWhileDebugging"]);
  return Object.freeze({
    editedWhileDebugging: parseEditedWhileDebugging(marks["editedWhileDebugging"]),
    rewoundWhileDebugging: parseRewoundWhileDebugging(marks["rewoundWhileDebugging"]),
  });
}

/** Whether `value` is a session's marks (`parseHistoryMarks`). */
export function isHistoryMarks(value: unknown): boolean {
  try {
    parseHistoryMarks(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * The marks after an applied storage edit at scene time `atMs`: the first edit's time stays, and the count rises. The
 * one rule a session's marks change by between its construction and a restore.
 */
export function marksAfterEdit(marks: HistoryMarks, atMs: number): HistoryMarks {
  return Object.freeze({
    editedWhileDebugging: Object.freeze({
      firstEditSceneTimeMs: marks.editedWhileDebugging?.firstEditSceneTimeMs ?? atMs,
      editCount: (marks.editedWhileDebugging?.editCount ?? 0) + 1,
    }),
    rewoundWhileDebugging: marks.rewoundWhileDebugging,
  });
}

/** Why a file is not a debug export this tool can read; `unsupported` is a valid export of another version. */
export class DebugExportError extends Error {
  override readonly name = "DebugExportError";
  constructor(
    readonly kind: "invalid" | "unsupported",
    message: string,
  ) {
    super(message);
  }
}

export function parseEditedWhileDebugging(value: unknown): DebugEditedWhileDebugging | null {
  if (value === null) return null;
  const edited = record(value, "$.editedWhileDebugging");
  exactly(edited, "$.editedWhileDebugging", ["firstEditSceneTimeMs", "editCount"]);
  return {
    firstEditSceneTimeMs: sceneTime(
      edited["firstEditSceneTimeMs"],
      "$.editedWhileDebugging.firstEditSceneTimeMs",
    ),
    editCount: count(edited["editCount"], "$.editedWhileDebugging.editCount"),
  };
}

export function parseRewoundWhileDebugging(value: unknown): DebugRewoundWhileDebugging | null {
  if (value === null) return null;
  const rewound = record(value, "$.rewoundWhileDebugging");
  exactly(rewound, "$.rewoundWhileDebugging", ["restoredSceneTimeMs", "rewindCount"]);
  return {
    restoredSceneTimeMs: sceneTime(
      rewound["restoredSceneTimeMs"],
      "$.rewoundWhileDebugging.restoredSceneTimeMs",
    ),
    rewindCount: count(rewound["rewindCount"], "$.rewoundWhileDebugging.rewindCount"),
  };
}

export function fail(path: string, message: string): never {
  throw new DebugExportError("invalid", `${path} ${message}.`);
}

export function record(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    fail(path, "must be an object");
  // EVIDENCE: validation: the guard above proved a non-array object parsed from JSON.
  return value as Record<string, unknown>;
}

export function exactly(
  value: Record<string, unknown>,
  path: string,
  fields: readonly string[],
): void {
  const keys = Object.keys(value);
  const unknown = keys.find((key) => !fields.includes(key));
  if (unknown !== undefined) fail(path, `has an unknown field ${JSON.stringify(unknown)}`);
  const missing = fields.find((field) => !Object.hasOwn(value, field));
  if (missing !== undefined) fail(path, `is missing ${JSON.stringify(missing)}`);
}

/** A scene time in milliseconds: finite and not negative, fractions included, as the Player's clock observes it. */
function sceneTime(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
    fail(path, "must be a finite, non-negative number of milliseconds");
  return value;
}

export function count(value: unknown, path: string, allowZero = false): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < (allowZero ? 0 : 1))
    fail(path, allowZero ? "must be a whole number" : "must be a positive whole number");
  return value;
}
