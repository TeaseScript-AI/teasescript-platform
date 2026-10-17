import type { Identifier, Program } from "../ast.js";
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
  const reads: {
    readonly site: FactSite;
    readonly name: string;
    readonly declaration: Declaration | undefined;
  }[] = [];
  const declarationSites = new Map<Declaration, FactSite>();
  const spanFiles = new Map<SourceSpan, number>();
  programs.forEach((program, file) => {
    eachNode(program, (found) => {
      // EVIDENCE: invariant: `someNode` visits the nodes of a parser-owned AST, each with a kind and a span.
      const node = found as FactNode;
      if (typeof node.kind !== "string" || node.span === undefined) return false;
      spanFiles.set(node.span, file);
      const site = factSite(file, node.span);
      // EVIDENCE: invariant: the maps are keyed by nodes of these programs; a node of another kind is not in them.
      const declaration = node as Declaration;
      const variable = checker.bindings.get(declaration);
      if (variable !== undefined) declarationSites.set(declaration, site);
      if (node.kind === "identifier") {
        // EVIDENCE: invariant: the reads are keyed by the identifier nodes of these programs.
        const identifier = node as Identifier;
        const read = checker.readDeclaration(identifier);
        if (read !== undefined)
          reads.push({ site, name: read.name, declaration: read.declaration });
      }
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
  // A read may stand before the declaration it resolved to, in another file or in a function body checked later, so
  // the declarations' sites are looked up once every program is walked.
  const resolvedReads = reads.map(({ site, name, declaration }) => ({
    site,
    name,
    binding: declaration === undefined ? null : (declarationSites.get(declaration) ?? null),
  }));
  return {
    bindings: bindings.sort((left, right) => compareSites(left.site, right.site)),
    reads: resolvedReads.sort((left, right) => compareSites(left.site, right.site)),
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

/**
 * Calls `visit` for every node of a parser-owned AST: every object with a kind, also inside objects without one, such
 * as the named arguments of a form, which hold expressions of their own. Spans hold no nodes.
 */
function eachNode(root: Program, visit: (node: FactNode) => void): void {
  const work: unknown[] = [root];
  while (work.length > 0) {
    const value = work.pop();
    if (value === null || typeof value !== "object") continue;
    if (Array.isArray(value)) {
      for (const item of value) work.push(item);
      continue;
    }
    // EVIDENCE: invariant: an object of a parser-owned AST is a node, a span, a position, or a holder of nodes.
    const node = value as FactNode & Record<string, unknown>;
    if (typeof node.kind === "string") visit(node);
    for (const [key, nested] of Object.entries(node)) if (key !== "span") work.push(nested);
  }
}
