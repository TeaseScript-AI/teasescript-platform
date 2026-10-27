import { isPathGlob } from "../../../project-paths.js";
import type { FlowGraphBuilder } from "../flow-graph.js";
import type { CallSite, FileRegion, FlowNode } from "./model.js";

// Calls and jumps, resolved once every file is walked: the call sites, the targets of `goto` and `call`, their edges.

function addSite(builder: FlowGraphBuilder, site: Omit<CallSite, "id">): CallSite {
  const added: CallSite = { id: builder.sites.length, ...site };
  builder.sites.push(added);
  for (const callee of site.callees) {
    builder.regionSites[callee.id]!.push(added);
    builder.link(builder.built(site.callIn), builder.built(callee.entry));
  }
  return added;
}

/** A call names a function of its own file, or else a global function of the project. */
export function resolveCalls(builder: FlowGraphBuilder): void {
  for (const call of builder.pendingCalls) {
    const callee =
      builder.functions.get(`${call.file}:${call.name}`) ?? builder.globalFunctions.get(call.name);
    if (callee === undefined) continue;
    addSite(builder, {
      kind: "function",
      callIn: call.callIn,
      callOut: call.callOut,
      callees: [callee],
      caller: call.caller,
      call: call.call,
      uncertain: false,
    });
  }
}

/**
 * A `goto` continues at a label of its file or starts a file at its top; a `call` starts a file and is one call site.
 * A glob may pick the files the name pass picked for it (G1(f): no second scan); a computed target may name any file
 * (L11). A file target's label is an error of the name pass, so the file starts at its top.
 */
export function resolveTransfers(builder: FlowGraphBuilder): void {
  const byPath = new Map(builder.fileRegions.map((region) => [region.path, region]));
  // Computed targets share one list of every file and its entries.
  const everyFile: readonly FileRegion[] = builder.fileRegions;
  const entriesOf = new Map<readonly FileRegion[], readonly FlowNode[]>();
  for (const transfer of builder.pendingTransfers) {
    const target = transfer.target;
    let files: readonly FileRegion[];
    let entries: readonly FlowNode[];
    let uncertain = false;
    if (target.kind === "labelTarget") {
      const label = builder.labels.get(`${transfer.file}:${target.label.name}`);
      const own = builder.fileRegions[transfer.file];
      files = own === undefined ? [] : [own];
      entries = label === undefined ? [] : [label];
    } else {
      if (target.kind === "scriptTarget") {
        files = everyFile;
        uncertain = true;
      } else if (isPathGlob(target.path)) {
        // The name pass matched the glob once; a target it rejected picks nothing.
        files = (builder.files[transfer.file]!.picks.get(target) ?? []).flatMap((path) => {
          const file = byPath.get(path);
          return file === undefined ? [] : [file];
        });
        uncertain = true;
      } else {
        const file = byPath.get(target.path);
        files = file === undefined ? [] : [file];
      }
      let shared = entriesOf.get(files);
      if (shared === undefined) {
        shared = files.map((file) => file.entry);
        entriesOf.set(files, shared);
      }
      entries = shared;
    }
    if (transfer.callOut === null) {
      for (const entry of entries) builder.link(transfer.node, entry);
      builder.jumps.push({
        kind: target.kind === "labelTarget" ? "label" : "file",
        node: transfer.node,
        targets: entries,
        files,
      });
    } else if (files.length > 0)
      addSite(builder, {
        kind: "file",
        callIn: transfer.node,
        callOut: transfer.callOut,
        callees: files,
        caller: transfer.caller,
        call: null,
        uncertain,
      });
  }
}
