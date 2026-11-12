// The type core's stop oracles: the identity of a diagnostic a stop keeps, and which decisions stop and when.
import { keyIdPath } from "../../src/type-inference/core/contract/key-ids.js";
import { stepsOf } from "../../src/type-inference/core/contract/literal-index.js";
import type { Diagnostic } from "../../src/diagnostics.js";
import { Admission } from "../../src/type-inference/core/admission.js";
import {
  analyseCore,
  type Answers,
  type CorePass,
  coreResult,
} from "../../src/type-inference/core/answers.js";
import { withTestDemandAllowance } from "../../src/type-inference/core/budget.js";
import { Consumers } from "../../src/type-inference/core/consumers.js";
import { coreMessage, messageSource } from "../../src/type-inference/core/messages.js";
import {
  type CheckedDiagnostic,
  type CoreDiagnostic,
  coreRecord,
} from "../../src/type-inference/core/result.js";
import { coreRequest, type SourceFile } from "./type-core-analysis.js";
import { inMode, type Mode } from "./type-core-oracles-modes.js";

/**
 * A diagnostic as a stop must keep it, its identity: without the facts its fix's code forms read (`expects`,
 * `present`), which a stop never proves, so a fix there may be words. The stop tests compare these.
 */
export function stopIdentity(
  diagnostic: CoreDiagnostic | CheckedDiagnostic,
): Readonly<Record<string, unknown>> {
  return Object.fromEntries(
    Object.entries(diagnostic).filter(([key]) => key !== "expects" && key !== "present"),
  );
}

/** A message's sentences, split where a sentence ends and the next starts with a capital or a quote. */
export function sentences(text: string): string[] {
  return text.split(/(?<=[.?])\s+(?=[A-Z'"])/);
}

/**
 * The errors of `source`'s analysis as a stop keeps them: each error's identity and its message's first sentence. A
 * stop proves nothing of a fix's code, so the fix after that sentence may be words.
 */
export function keptErrors(
  answers: Answers,
  source: string,
): readonly Readonly<Record<string, unknown>>[] {
  const text = messageSource([source], answers.diagnostics);
  return answers.diagnostics
    .filter((d) => d.class === "compile-error")
    .map((d) => ({ ...stopIdentity(d), message: sentences(coreMessage(d, text))[0] }));
}

/**
 * The record with the route as the merged stops pin it: each diagnostic by its identity
 * (`stopIdentity`) without the other facts only its fix reads, the kinds its site's other diagnostics report
 * (`besides`) and its store root's declaration, and each of the route's (`publishedRoute`'s text) by its severity, code
 * and span, without its message.
 */
export function mergedIdentity(answers: Answers, route: string): string {
  const identity = (diagnostic: CoreDiagnostic): Readonly<Record<string, unknown>> => {
    const { besides: _, ...kept } = stopIdentity(diagnostic);
    return "rule" in diagnostic && diagnostic.rule.rule === "store" && diagnostic.rule.root !== null
      ? {
          ...kept,
          rule: {
            ...diagnostic.rule,
            root: { kind: diagnostic.rule.root.kind, name: diagnostic.rule.root.name },
          },
        }
      : kept;
  };
  // EVIDENCE: invariant: `publishedRoute` writes a plan with the compiler's diagnostics, or the construct it rejects.
  const routed = JSON.parse(route) as { readonly diagnostics?: readonly Diagnostic[] };
  return JSON.stringify({
    outcome: answers.outcome,
    diagnostics: answers.diagnostics.map(identity),
    checks: answers.checks,
    serialized: coreRecord(coreResult(answers), ["main.tease"]),
    route:
      routed.diagnostics === undefined
        ? routed
        : {
            ...routed,
            diagnostics: routed.diagnostics.map(({ severity, code, span }) => ({
              severity,
              code,
              span,
            })),
          },
  });
}

/** Which admission decisions an analysis stops, and when; its restarts and how it ended. */
export interface StopSet {
  /** Each decision stop: the pass (from 1), the place's label, the key's path and the decision's ordinal in its pass. */
  readonly stops: readonly (readonly [number, string, string, number])[];
  readonly passes: number;
  readonly restarts: number;
  readonly outcome: Answers["outcome"];
  readonly exhausted: Answers["budget"]["exhausted"];
  /** What it publishes at that allowance (`stoppedRecord`). */
  readonly record: string;
}

/**
 * What an analysis publishes at a stop, as the stop-set comparison compares it at every allowance: each diagnostic by
 * its identity (`stopIdentity`: its code, site, rule and offending kinds, without the fix facts a stop never proves),
 * the checks, and both serialized.
 */
export function stoppedRecord(answers: Answers, paths: readonly string[]): string {
  return JSON.stringify({
    diagnostics: answers.diagnostics.map(stopIdentity),
    checks: answers.checks,
    serialized: coreRecord(coreResult(answers), paths),
  });
}

/**
 * Which decisions stop and when, per source and mode (#1405's stop-set comparison): `files` analysed in `mode` at the
 * test demand `allowance`, or at the natural one (`null`), with each pass's start, decision and decision stop traced,
 * and what it publishes there (`stoppedRecord`); `null` when the files do not parse or resolve. The trace keeps each
 * analysis's events apart by its program and reports this analysis's own, so an analysis run inside one of its
 * callbacks changes nothing.
 *
 * @public (the generator corpus's runner reads it from a built tree, not by an import)
 */
export function stopSet(
  files: readonly SourceFile[],
  mode: Mode,
  globals: readonly string[],
  allowance: number | null,
): StopSet | null {
  const request = coreRequest(files, globals);
  if (request === null) return null;
  type Trace = { pass: number; decided: number; stops: [number, string, string, number][] };
  const traces = new Map<CorePass["program"]["flow"], Trace>();
  const traceOf = (pass: CorePass): Trace => {
    let trace = traces.get(pass.program.flow);
    if (trace === undefined)
      traces.set(pass.program.flow, (trace = { pass: 0, decided: 0, stops: [] }));
    return trace;
  };
  const [check, decide, stopDecision] = [
    Consumers.prototype.check,
    Admission.prototype.decide,
    Admission.prototype.stopDecision,
  ];
  Consumers.prototype.check = function (this: Consumers) {
    const trace = traceOf(this.pass);
    trace.pass += 1;
    trace.decided = 0;
    check.call(this);
  };
  Admission.prototype.decide = function (
    this: Admission,
    ...args: Parameters<Admission["decide"]>
  ) {
    traceOf(this.pass).decided += 1;
    return decide.apply(this, args);
  };
  Admission.prototype.stopDecision = function (this: Admission, at) {
    const trace = traceOf(this.pass);
    // (a cursor's steps read from the arena uncharged: the observer changes nothing it observes)
    const path = at.key === undefined ? at.path : stepsOf(this.pass.contract, keyIdPath(at.key));
    trace.stops.push([
      trace.pass,
      this.pass.program.places[at.root]!.label,
      path.join("."),
      trace.decided,
    ]);
    stopDecision.call(this, at);
  };
  try {
    const once = (): Answers => analyseCore(request);
    const answers = inMode(mode, () =>
      allowance === null ? once() : withTestDemandAllowance(allowance, once),
    );
    const trace = traces.get(answers.graph) ?? { pass: 0, decided: 0, stops: [] };
    return {
      stops: trace.stops,
      passes: trace.pass,
      restarts: answers.budget.counts.get("stopPasses") ?? 0,
      outcome: answers.outcome,
      exhausted: answers.budget.exhausted,
      record: stoppedRecord(
        answers,
        request.files.map((file) => file.path),
      ),
    };
  } finally {
    Consumers.prototype.check = check;
    Admission.prototype.decide = decide;
    Admission.prototype.stopDecision = stopDecision;
  }
}
