# Editor, simulator, and debugger

The future browser editor should use parser diagnostics and source spans for syntax highlighting, errors, navigation, autocomplete, simulation, stepping, deterministic replay, state inspection, and breakpoint-like debugging.

The standalone playground is a local technical workspace, not the production editor. It uses an accessible native textarea for ordinary `.tease` source, diagnostics, instruction-plan/runtime/event inspection, stepping, reset, and validated checkpoint save/restore. It deliberately has no Monaco integration, package authoring, library-aware completion, or cross-origin production-player UI.

The current technical workspace/controller implementation is canonically at
`playground/workspace/controller.ts`. `playground/workspace.ts` remains a
temporary compatibility facade; browser and server entrypoints use the
canonical controller directly. This refactor does not create Player modules
or claim editor functionality that is not implemented.

The browser stores authoring text under the versioned `teasescript-playground-draft-v1` localStorage key. Drafts are separate from version-8 runtime checkpoints. Storage failures are bounded technical messages; explicit example reload discards the draft and never overwrites repository examples. A local `.tease` file may be imported or exported without repository or server writes.

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

## Accepted first Standard Library POC tooling

ADR 0018 accepts parser-owned compact forms for `showButton`, `askText`, `askNumber`, `choose`, and `say` pacing in addition to ordinary library metadata. The editor must combine generated Standard Library information with grammar-aware support for those official forms.

The first implementation should provide:

- completion and hover documentation for the automatically available Standard Library names;
- signature guidance for optional `as speaker`, input hints, labelled and unlabelled choices, identifier and numeric labels, `skippable`, `unskippable`, exact seconds, `0`, and `instant`;
- diagnostics for attempts to shadow selected Standard Library names;
- diagnostics for mixed labelled and unlabelled choices, mixed label types, duplicate labels, and duplicate unlabelled visible text;
- diagnostics for negative, non-finite, unsupported-magnitude, or overflowing explicit pacing values;
- documentation that input text is a Standard UI hint rather than an automatic speaker transcript message;
- documentation of exact text/number normalization, simple return types, and permanent non-cancellation;
- formatting that preserves the accepted compact order and keeps compact `choose` options in one statement;
- source-span preservation from compact syntax through fully lowered plan instructions;
- simulator inspection of pending interaction kind, requesting speaker, normalized completion, prepared output, pacing deadline, action location, and skip policy;
- diagnostics for concrete versioned technical limits selected by the implementation;
- earlier non-blocking usability warnings for unusually long control text or unusually large choice sets without presenting those warnings as language limits.

The editor may preview the Player application's dynamic choice presentation, but button rows versus dropdown are not canonical runtime state. Buttons may use one or two rows; exact layout measurements and breakpoints remain Player UI work.

Editor metadata must not imply that issue #74's opaque catalog token is a final package version or that the first POC supports imports, package manifests, Standard Library replacement, or checkpoint migration.

The advanced detailed-result option, `showButton` timeout/elapsed return, typing-indicator options, accessibility override field, concrete limit values, LLM interpretation options, and exact choice-layout thresholds remain deferred and must not appear as accepted completion suggestions before their contracts are approved.
