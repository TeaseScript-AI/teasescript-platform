import type { Program } from "../ast.js";
import { someNode } from "../project-globals.js";
import type { SourceSpan } from "../source.js";
import type { Declaration } from "../static-types.js";
import { typeKey, type StorageKeyType } from "../storage-types.js";
import type { TypeChecker } from "../type-checker.js";
import type { FactSite, SolvedTypeFacts } from "./backend.js";

/** A node of a parser-owned AST as the facts read it: its kind and its span. */
interface FactNode {
  readonly kind?: unknown;
  readonly span?: SourceSpan;
}

/**
 * The facts of the last check of the legacy inference (see `legacy-rounds.ts`), read from the checker that made it
 * and the storage key types it ended with. The programs are walked once each, so every fact gets the file it is in;
 * the facts are sorted by site, so two snapshots compare as data.
 */
export function legacyFacts(
  programs: readonly Program[],
  checker: TypeChecker,
  storage: ReadonlyMap<string, StorageKeyType>,
  unchecked: ReadonlySet<string>,
): SolvedTypeFacts {
  const bindings: SolvedTypeFacts["bindings"][number][] = [];
  const values: SolvedTypeFacts["values"][number][] = [];
  const functions: SolvedTypeFacts["functions"][number][] = [];
  const spanFiles = new Map<SourceSpan, number>();
  programs.forEach((program, file) => {
    someNode(program, (found) => {
      // EVIDENCE: invariant: `someNode` visits the nodes of a parser-owned AST, each with a kind and a span.
      const node = found as FactNode;
      if (typeof node.kind !== "string" || node.span === undefined) return false;
      spanFiles.set(node.span, file);
      const site = factSite(file, node.span);
      // EVIDENCE: invariant: the maps are keyed by nodes of these programs; a node of another kind is not in them.
      const variable = checker.bindings.get(node as Declaration);
      if (variable !== undefined)
        bindings.push({
          site,
          kind: node.kind,
          name: variable.name,
          type: typeKey(variable.type, true, true),
        });
      // EVIDENCE: invariant: as above, for the expressions the check typed.
      const type = checker.checkedType(node as Parameters<TypeChecker["checkedType"]>[0]);
      if (type !== undefined)
        values.push({ site, kind: node.kind, type: typeKey(type, true, true) });
      // EVIDENCE: invariant: as above, for the function declarations the check declared.
      const fn = checker.functionTypes.get(
        node as Parameters<TypeChecker["functionTypes"]["get"]>[0],
      );
      if (fn !== undefined)
        functions.push({
          site,
          name: fn.declaration.name.name,
          parameters:
            fn.parameters?.map((parameter) => typeKey(parameter.type, true, true)) ?? null,
          accepted: fn.accepted?.map((parameter) => typeKey(parameter.type, true, true)) ?? null,
          result: fn.result === null ? null : typeKey(fn.result, true, true),
        });
      return false;
    });
  });
  const speakers = [...checker.speakerProperties]
    .map(([name, table]) => ({
      name,
      properties: [...table]
        .map(([property, type]) => ({ name: property, type: typeKey(type, true, true) }))
        .sort((left, right) => compareText(left.name, right.name)),
    }))
    .sort((left, right) => compareText(left.name, right.name));
  // Each load belongs to one key: group them once, not once per key.
  const loadsByKey = new Map<string, SolvedTypeFacts["storage"][number]["loads"][number][]>();
  for (const load of checker.storageLoads) {
    const loads = loadsByKey.get(load.key) ?? [];
    loads.push({
      site: factSite(spanFiles.get(load.at) ?? -1, load.at),
      type: typeKey(load.type, true, true),
      declared: load.declared,
    });
    loadsByKey.set(load.key, loads);
  }
  const storageFacts = [...storage]
    .map(([key, kept]) => ({
      key,
      type: typeKey(kept.type, true, true),
      declared: kept.declared,
      loads: (loadsByKey.get(key) ?? []).sort((left, right) => compareSites(left.site, right.site)),
    }))
    .sort((left, right) => compareText(left.key, right.key));
  return {
    bindings: bindings.sort((left, right) => compareSites(left.site, right.site)),
    values: values.sort(
      (left, right) => compareSites(left.site, right.site) || compareText(left.kind, right.kind),
    ),
    functions: functions.sort((left, right) => compareSites(left.site, right.site)),
    speakers,
    uncheckedProperties: [...unchecked].sort(compareText),
    storage: storageFacts,
  };
}

function factSite(file: number, span: SourceSpan): FactSite {
  return { file, start: span.start.offset, end: span.end.offset };
}

function compareSites(left: FactSite, right: FactSite): number {
  return left.file - right.file || left.start - right.start || left.end - right.end;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
