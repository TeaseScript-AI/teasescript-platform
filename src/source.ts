declare const sourcePositionBrand: unique symbol;
declare const sourceSpanBrand: unique symbol;

export interface SourcePosition {
  readonly offset: number;
  readonly line: number;
  readonly column: number;
  readonly [sourcePositionBrand]: true;
}

export interface SourceSpan {
  readonly start: SourcePosition;
  readonly end: SourcePosition;
  readonly [sourceSpanBrand]: true;
}

/**
 * Creates a zero-based source position. Offsets count UTF-16 code units.
 */
export function createSourcePosition(
  offset: number,
  line: number,
  column: number,
): SourcePosition {
  assertNonNegativeInteger(offset, "offset");
  assertNonNegativeInteger(line, "line");
  assertNonNegativeInteger(column, "column");

  return Object.freeze({ offset, line, column }) as SourcePosition;
}

/** Creates a half-open source span from start inclusive to end exclusive. */
export function createSourceSpan(
  start: SourcePosition,
  end: SourcePosition,
): SourceSpan {
  if (end.offset < start.offset) {
    throw new RangeError("A source span cannot end before it starts.");
  }

  return Object.freeze({
    start: copySourcePosition(start),
    end: copySourcePosition(end),
  }) as SourceSpan;
}

/** Creates the smallest source span containing every supplied span. */
export function combineSourceSpans(
  first: SourceSpan,
  ...rest: readonly SourceSpan[]
): SourceSpan {
  const validatedFirst = createSourceSpan(first.start, first.end);
  let start = validatedFirst.start;
  let end = validatedFirst.end;

  for (const span of rest) {
    const validatedSpan = createSourceSpan(span.start, span.end);

    if (validatedSpan.start.offset < start.offset) {
      start = validatedSpan.start;
    }

    if (validatedSpan.end.offset > end.offset) {
      end = validatedSpan.end;
    }
  }

  return createSourceSpan(start, end);
}

function copySourcePosition(position: SourcePosition): SourcePosition {
  return createSourcePosition(position.offset, position.line, position.column);
}

function assertNonNegativeInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative integer.`);
  }
}
