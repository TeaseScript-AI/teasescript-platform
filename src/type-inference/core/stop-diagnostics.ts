// The analysis's stop diagnostics: the warning at the heaviest place and the "not checked (budget)" marks.
import type { SourceSite } from "../graph.js";
import { type BudgetLimit } from "./budget.js";
import type { FileRegion, FunctionRegion } from "./flow-graph.js";
import { CoreProgram } from "./program.js";
import { type WorkPlace, type CoreDiagnostic, type BudgetStop, type NotChecked } from "./result.js";

/**
 * The places work is counted to and the stop names: each file's top level and each function, by its region,
 * and the one a site stands in (functions stand at a file's top level, never nested: V30 §11).
 */
function workPlaces(program: CoreProgram): {
  readonly of: (site: SourceSite) => FileRegion | FunctionRegion;
  readonly place: (region: FileRegion | FunctionRegion) => WorkPlace;
  readonly site: (region: FileRegion | FunctionRegion) => SourceSite;
} {
  const files = new Map<number, FileRegion>();
  const functions = new Map<number, FunctionRegion[]>();
  for (const region of program.flow.regions)
    if (region.kind === "file") files.set(region.file, region);
    else if (region.kind === "function") {
      const list = functions.get(region.file);
      if (list === undefined) functions.set(region.file, [region]);
      else list.push(region);
    }
  for (const list of functions.values())
    list.sort((a, b) => a.declaration.span.start.offset - b.declaration.span.start.offset);
  const spanSite = (file: number, span: FunctionRegion["declaration"]["span"]): SourceSite => ({
    file,
    start: span.start.offset,
    end: span.end.offset,
  });
  return {
    of: (site) => {
      const list = functions.get(site.file) ?? [];
      let low = 0;
      let high = list.length;
      while (low < high) {
        const middle = (low + high) >> 1;
        if (list[middle]!.declaration.span.start.offset <= site.start) low = middle + 1;
        else high = middle;
      }
      const found = list[low - 1];
      return found !== undefined && site.end <= found.declaration.span.end.offset
        ? found
        : files.get(site.file)!;
    },
    place: (region) =>
      region.kind === "function"
        ? {
            name: region.declaration.name.name,
            path: files.get(region.file)?.path ?? "",
            lines: spanSite(region.file, region.declaration.span),
          }
        : { name: null, path: region.path, lines: program.fileSite(region.file) },
    site: (region) =>
      region.kind === "function"
        ? spanSite(region.file, region.declaration.name.span)
        : { file: region.file, start: 0, end: 0 },
  };
}

/**
 * The stop's diagnostics: one warning at the heaviest place, the function or top level whose work
 * was the most before the stop (the deepest nesting's for `nesting`), with the number of warnings it deferred; and
 * "not checked (budget)", once per function or top level one of those checks stands in, at its name or at its first.
 */
export function stopDiagnostics(
  program: CoreProgram,
  limit: BudgetLimit,
  deferred: readonly Extract<CoreDiagnostic, { obligation: unknown }>[],
): (BudgetStop | NotChecked)[] {
  const places = workPlaces(program);
  const unchecked = new Map<FileRegion | FunctionRegion, SourceSite>();
  for (const diagnostic of [...deferred].sort(
    // (in source order, the whole site: one order for every order of the walk)
    (a, b) => a.site.file - b.site.file || a.site.start - b.site.start || a.site.end - b.site.end,
  )) {
    const region = places.of(diagnostic.site);
    if (!unchecked.has(region))
      unchecked.set(region, region.kind === "function" ? places.site(region) : diagnostic.site);
  }
  let heaviest: FileRegion | FunctionRegion;
  if (limit === "nesting") heaviest = places.of(program.deep[0]!);
  else {
    // the most work counted to one place, the earliest region on a tie; setup's work (0) is never compared (#2701)
    const spent = program.work.spent();
    let best = 0;
    for (let spender = 1; spender < spent.length; spender += 1)
      if ((spent[spender] ?? 0) > (best === 0 ? 0 : (spent[best] ?? 0))) best = spender;
    const region = best === 0 ? undefined : program.flow.regions[best - 1];
    heaviest =
      region?.kind === "function" || region?.kind === "file"
        ? region
        : places.of({ file: 0, start: 0, end: 0 });
  }
  const stop: BudgetStop = {
    class: "warning-runtime-check",
    kind: "budget",
    code: "TSV076",
    site: unchecked.get(heaviest) ?? places.site(heaviest),
    limit,
    place: places.place(heaviest),
    deferred: deferred.length,
  };
  return [
    stop,
    ...[...unchecked].map(([region, site]): NotChecked => ({
      class: "not-checked-budget",
      kind: "budget",
      code: "TSV076",
      site,
      place: places.place(region),
    })),
  ];
}
