# Editor, simulator, and debugger

The future browser editor should use parser diagnostics and source spans for syntax highlighting, errors, navigation, autocomplete, simulation, stepping, deterministic replay, state inspection, and breakpoint-like debugging.

The standalone fixed-example playground is implemented as a development proof. It exposes source, diagnostics, instruction plan, runtime state, events, stepping, reset, and checkpoint save/restore for the implemented examples. It is not yet a full source editor, Monaco integration, cross-origin production player, or package authoring environment.

A production editor should build on the versioned parser/runtime interfaces after the host/player boundary is specified. Debugger history may snapshot selected boundaries; it should not imply that production execution persists every internal instruction.

The current library-infrastructure POC can deterministically derive JSON-safe public metadata from a narrow set of named TypeScript exports. It records export names, kinds, ordered parameters, available type-display text, documentation, deprecation, and an exact owning-library token. Editor transport, `.tease` linkage, and the permanent metadata format remain open.

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
