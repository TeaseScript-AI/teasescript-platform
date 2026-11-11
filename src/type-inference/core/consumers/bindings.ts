import type { SourceSite } from "../../graph.js";
import type { DeclaredBinding, DiagnosticRule } from "../result.js";

/** The variable or parameter with its own written type a read at a site reads, else `null` (#2289). */
export type BindingRead = (read: SourceSite) => DeclaredBinding | null;

/**
 * Each copy-decided store rule's reader of the declared variables its reads read, by the rule object the consumers
 * made: beside the published diagnostic, never in it (as `origins.ts`), so a diagnostic's identity holds data alone, and
 * asked only where a store error's sentence names a copy's source. A rule copied or rebuilt has none, and its sentence
 * is today's.
 */
const bindings = new WeakMap<DiagnosticRule, BindingRead>();

/** Records `read` for `rule`, a store rule a copy decided. */
export function readsBindings(rule: DiagnosticRule, read: BindingRead): void {
  bindings.set(rule, read);
}

/** The reader recorded for `rule`, else `undefined`. */
export function bindingsOf(rule: DiagnosticRule): BindingRead | undefined {
  return bindings.get(rule);
}
