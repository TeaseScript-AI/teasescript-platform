import type { Diagnostic } from "../diagnostics.js";

/** The diagnostics of a log from index `from` up to `to`, as they stood at its `version` (see `DiagnosticLog`). */
export interface DiagnosticSegment {
  readonly log: DiagnosticLog;
  readonly from: number;
  readonly to: number;
  readonly version: number;
}

/** A replacement of the diagnostic at an index, made at a version of its log (see `DiagnosticLog.set`). */
interface Replacement {
  readonly version: number;
  readonly diagnostic: Diagnostic;
}

/**
 * The diagnostics of one parser, in order. A part that a speculation read and this parser takes over joins as one
 * segment of the speculation's log rather than as a copy, so a part nested in others is not copied into each of them
 * (see `Parser.parseOnce`). A diagnostic replaced later, for a proved fix or a duration's advice, is replaced in this log
 * only, and a segment reads its log as it stood when the segment was taken.
 */
export class DiagnosticLog {
  /** The parser's own diagnostics and the segments it took over, in order, with the index at which each starts. */
  readonly #entries: (Diagnostic | DiagnosticSegment)[] = [];
  readonly #starts: number[] = [];
  #length = 0;
  /** Each index replaced, in order, with its replacements, latest last. */
  readonly #replaced = new Map<number, Replacement[]>();
  readonly #replacedIndices: number[] = [];
  #version = 0;
  /** Where each diagnostic this log pushed or set stands (see `lastIndexOf`). */
  readonly #positions = new Map<Diagnostic, number>();

  public get length(): number {
    return this.#length;
  }

  public push(diagnostic: Diagnostic): void {
    this.#entries.push(diagnostic);
    this.#starts.push(this.#length);
    this.#positions.set(diagnostic, this.#length);
    this.#length += 1;
  }

  /** The diagnostics from index `from` to the end, as they stand now. */
  public segment(from: number): DiagnosticSegment {
    return { log: this, from, to: this.#length, version: this.#version };
  }

  /** Adds the diagnostics of `segment`, a segment of another log. */
  public pushSegment(segment: DiagnosticSegment): void {
    if (segment.to === segment.from) return;
    this.#entries.push(segment);
    this.#starts.push(this.#length);
    this.#length += segment.to - segment.from;
  }

  public get(index: number): Diagnostic {
    return DiagnosticLog.#read(this, index, this.#version);
  }

  public at(index: number): Diagnostic | undefined {
    const at = index < 0 ? this.#length + index : index;
    return at >= 0 && at < this.#length ? this.get(at) : undefined;
  }

  /** Replaces the diagnostic at `index` in this log; the segments taken of it before keep the earlier one. */
  public set(index: number, diagnostic: Diagnostic): void {
    this.#version += 1;
    const replacements = this.#replaced.get(index);
    if (replacements === undefined) {
      this.#replaced.set(index, [{ version: this.#version, diagnostic }]);
      this.#replacedIndices.splice(lowerBound(this.#replacedIndices, index), 0, index);
    } else replacements.push({ version: this.#version, diagnostic });
    this.#positions.set(diagnostic, index);
  }

  /**
   * Where `diagnostic` stands, which this log pushed or set, or -1. A diagnostic of a segment is another parser's, whose
   * own reports, such as a duration's advice, find it in its own log.
   */
  public lastIndexOf(diagnostic: Diagnostic): number {
    const index = this.#positions.get(diagnostic);
    return index !== undefined && this.get(index) === diagnostic ? index : -1;
  }

  /** The diagnostics in order, read once without recursion, each segment's replacements applied after its own. */
  public toArray(): Diagnostic[] {
    const diagnostics: Diagnostic[] = [];
    interface Frame {
      readonly log: DiagnosticLog;
      readonly from: number;
      readonly to: number;
      readonly version: number;
      readonly base: number;
      next: number;
    }
    const frames: Frame[] = [];
    const open = (log: DiagnosticLog, from: number, to: number, version: number) =>
      frames.push({
        log,
        from,
        to,
        version,
        base: diagnostics.length,
        next: DiagnosticLog.#entryAt(log, from),
      });
    open(this, 0, this.#length, this.#version);
    for (let frame = frames.at(-1); frame !== undefined; frame = frames.at(-1)) {
      const { log } = frame;
      if (frame.next < log.#entries.length && log.#starts[frame.next]! < frame.to) {
        const entry = log.#entries[frame.next]!;
        const start = log.#starts[frame.next]!;
        frame.next += 1;
        if (!isSegment(entry)) {
          if (start >= frame.from) diagnostics.push(entry);
          continue;
        }
        const from = Math.max(frame.from, start);
        const to = Math.min(frame.to, start + entry.to - entry.from);
        if (to > from)
          open(entry.log, entry.from + from - start, entry.from + to - start, entry.version);
        continue;
      }
      // A replacement in this log, made by the time the segment was taken, outranks those of the segments inside it.
      for (
        let at = lowerBound(log.#replacedIndices, frame.from);
        at < log.#replacedIndices.length && log.#replacedIndices[at]! < frame.to;
        at += 1
      ) {
        const index = log.#replacedIndices[at]!;
        const replacement = latest(log.#replaced.get(index)!, frame.version);
        if (replacement !== undefined)
          diagnostics[frame.base + index - frame.from] = replacement.diagnostic;
      }
      frames.pop();
    }
    return diagnostics;
  }

  /** The diagnostic at `index` in `log` as it stood at `version`, read through its segments without recursion. */
  static #read(log: DiagnosticLog, index: number, version: number): Diagnostic {
    for (;;) {
      const replacements = log.#replaced.get(index);
      const replacement = replacements === undefined ? undefined : latest(replacements, version);
      if (replacement !== undefined) return replacement.diagnostic;
      const at = DiagnosticLog.#entryAt(log, index);
      const entry = log.#entries[at]!;
      if (!isSegment(entry)) return entry;
      index = entry.from + index - log.#starts[at]!;
      version = entry.version;
      log = entry.log;
    }
  }

  /** The index of the entry of `log` that holds diagnostic `index`. */
  static #entryAt(log: DiagnosticLog, index: number): number {
    return Math.max(0, lowerBound(log.#starts, index + 1) - 1);
  }
}

function isSegment(entry: Diagnostic | DiagnosticSegment): entry is DiagnosticSegment {
  return "log" in entry;
}

/** The latest replacement made by `version`. */
function latest(replacements: readonly Replacement[], version: number): Replacement | undefined {
  for (let at = replacements.length - 1; at >= 0; at -= 1)
    if (replacements[at]!.version <= version) return replacements[at];
  return undefined;
}

/** The first position in the ascending `values` whose value is at least `value`. */
function lowerBound(values: readonly number[], value: number): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (values[middle]! < value) low = middle + 1;
    else high = middle;
  }
  return low;
}
