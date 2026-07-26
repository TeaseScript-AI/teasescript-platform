# Editor, simulator, and debugger

The future browser editor should use parser diagnostics and source spans for syntax highlighting, errors, navigation, autocomplete, simulation, stepping, deterministic replay, state inspection, and breakpoint-like debugging.

The standalone playground is a local technical workspace, not the production editor. It uses an accessible native textarea for ordinary `.tease` source, diagnostics, instruction-plan/runtime/event inspection, stepping, reset, and validated checkpoint save/restore. It deliberately has no Monaco integration, package authoring, library-aware completion, or cross-origin production-player UI.

The browser stores authoring text under the versioned `teasescript-playground-draft-v1` localStorage key. Drafts are separate from version-4 runtime checkpoints. Storage failures are bounded technical messages; explicit example reload discards the draft and never overwrites repository examples. A local `.tease` file may be imported or exported without repository or server writes.

Every edit increments a source revision and invalidates the plan, snapshot, transcript, events, counters, and checkpoint controls. Run, step, checkpoint save, and checkpoint restore require a successfully compiled runtime at the current revision. Reset recompiles the textarea contents; no plan migration occurs. Restore accepts only a validated self-contained checkpoint whose plan exactly matches the current runtime, so source text is never checkpoint identity.

A production editor should build on the versioned parser/runtime interfaces after the host/player boundary is specified. Debugger history may snapshot selected boundaries; it should not imply that production execution persists every internal instruction.

The current library-infrastructure POC can deterministically derive JSON-safe public metadata from a narrow set of ordinary named TypeScript exports. It records export names, kinds, ordered parameters, available type-display text, documentation, deprecation, and an exact owning-library token. The separate tooling module captures external input and rejects source text over 100,000 characters before parsing; it is not part of the runtime root entry point. Editor transport, `.tease` linkage, and the permanent metadata format remain open.

## Accepted library-aware tooling boundary

Under accepted ADR 0017, Standard Library and package-library functions use ordinary TeaseScript call syntax and receive editor support from generated declarations and metadata rather than parser extensions.

The metadata pipeline should support at least:

- completion items for exported functions and types;
- parameter names, defaults, types, and signature help;
- hover documentation and deprecation notices;
- navigation to generated declarations or library source when permitted;
- compatible library/package version information;
- type-aware diagnostics and import suggestions;
- formatter support through the normal function-call grammar.

Special command, block, keyword, and token syntax remains parser-owned. A library export does not register new grammar or a formatter rewrite. The exact metadata format, caching, trust boundary, incremental updates, and Monaco integration remain open.
