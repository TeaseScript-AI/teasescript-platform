import type { SourceSite } from "../../graph.js";
import type { DiagnosticRule } from "../result.js";

/** The load with a default a store warning's value is, as the checker's definitions prove it (#1468, `loadOrigin`). */
export interface StoreOrigin {
  readonly load: SourceSite;
  /** The variable holding it. */
  readonly holder: string;
  /** The way from it to the place's property, as its key's steps (`element`, `entry`, a property's step). */
  readonly path: readonly string[];
}

/**
 * Each proved store rule's origin, by the rule object the consumers made for its one warning: beside the published
 * diagnostic, never in it, so a record holds nothing its message does not show (the lead's ruling after Codex r6), and
 * read only where `messages.ts` makes that warning's fix. A rule copied or rebuilt has none, and its fix is the words.
 */
const origins = new WeakMap<DiagnosticRule, StoreOrigin>();

/** Records `origin` for `rule`, a rule made for one warning. */
export function proveOrigin(rule: DiagnosticRule, origin: StoreOrigin): void {
  origins.set(rule, origin);
}

/** The origin proved for `rule`, else `undefined`. */
export function originOf(rule: DiagnosticRule): StoreOrigin | undefined {
  return origins.get(rule);
}
