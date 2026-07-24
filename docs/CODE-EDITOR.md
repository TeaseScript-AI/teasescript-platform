# Editor, simulator, and debugger

The future browser editor should use parser diagnostics and source spans for syntax highlighting, errors, navigation, autocomplete, simulation, stepping, deterministic replay, state inspection, and breakpoint-like debugging.

The standalone fixed-example playground is implemented as a development proof. It exposes source, diagnostics, instruction plan, runtime state, events, stepping, reset, and checkpoint save/restore for the implemented examples. It is not yet a full source editor, Monaco integration, cross-origin production player, or package authoring environment.

A production editor should build on the versioned parser/runtime interfaces after the host/player boundary is specified. Debugger history may snapshot selected boundaries; it should not imply that production execution persists every internal instruction.
