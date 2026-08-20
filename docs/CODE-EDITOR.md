# Code editor

The future browser editor owns source authoring: syntax highlighting, diagnostics, navigation, autocomplete, formatting,
and integration with compiler/runtime tooling. Runtime inspection and diagnostic execution belong to
[`DEBUGGER.md`](DEBUGGER.md); the editor may embed those controls without owning debugger semantics.

## Browser editor direction

The production editor is a new editor-owned surface, not an evolution of the standalone playground UI. The current
native-textarea playground remains a working technical workspace for low-level runtime/debug use while the real editor is
built; shared non-UI compiler/runtime/controller code may be reused without making the playground interface the editor
foundation.

Monaco Editor is the selected first browser-editor POC. TeaseScript diagnostics, completion/help, hover/signature
information, and formatting should live behind a small editor-neutral tooling boundary, with Monaco-specific providers as
thin adapters. Monaco provider APIs are not the project's permanent editor protocol. A later CLI or LSP adapter may reuse
the same tooling, but neither is part of the current POC.

The product editor is intended to remain approachable for authors with no programming background. Default presentation
should therefore expose useful editing help without surfacing unrelated Monaco complexity merely because it exists;
advanced capabilities may use progressive disclosure later. Exact beginner/advanced feature sets, custom syntax/snippet
menus, mobile-authoring requirements, Monaco feature pruning, bundle/loading strategy, and whether a future fork/private
patch ever becomes justified remain open decisions. The first POC starts from the normal upstream Monaco package.

The standalone playground is a local technical workspace, not the production editor. It currently combines an accessible
native `.tease` textarea with diagnostics and runtime/debug controls such as Run, Step, reset, checkpoint/restore, and
plan/runtime/event inspection. It has no Monaco integration, package authoring, library-aware completion, or cross-origin
production-Player UI.

A separate production-oriented Player presentation POC lives under `player/` and is served by the same local development
server at `/player/`. It remains distinct from the editor/playground workspace and does not define the runtime/Player or
cross-origin host protocol.

The technical workspace/controller implementation lives at `playground/workspace/controller.ts`; browser and server
entrypoints use that controller directly.

The browser stores authoring text under the versioned `teasescript-playground-draft-v1` localStorage key. Drafts are
separate from runtime checkpoints. Storage failures are bounded technical messages; explicit example reload discards the
draft and never overwrites repository examples. A local `.tease` file may be imported or exported without repository or
server writes.

Every edit increments a source revision and invalidates the plan, snapshot, transcript, events, counters, and checkpoint
controls. Run, Step, checkpoint save/restore, and reset require a successfully compiled runtime at the current revision.
Reset recompiles the current source; restore accepts only a validated self-contained checkpoint whose plan matches the
current runtime. Source text is not checkpoint identity.

The production editor should build on the versioned parser/compiler/runtime interfaces while keeping editor presentation
and runtime/debug ownership separate. The temporary TypeScript-export metadata POC has been removed; `.tease` linkage,
metadata format and validation, automatic export discovery, and library-aware completion remain future consumer-driven
work.

## Accepted library-aware tooling boundary

Under accepted ADR 0017, Standard Library and package-library functions use
ordinary TeaseScript call syntax when linkage is implemented. Future editor
support must not require parser extensions from libraries.

A future metadata pipeline should support at least:

- completion items for exported functions and types;
- parameter names, defaults, types, and signature help;
- hover documentation and deprecation notices;
- navigation to generated declarations or library source when permitted;
- compatible library/package version information;
- type-aware diagnostics and import suggestions;
- formatter support through the normal function-call grammar.

Special command, block, keyword, and token syntax remains parser-owned. A library export does not register new grammar or
a formatter rewrite. The exact metadata format, caching, trust boundary, incremental updates, and reusable transport
remain open.

## Accepted first Standard Library POC tooling

ADR 0018 accepts parser-owned compact forms for `showButton`, `askText`,
`askNumber`, `choose`, and `say` pacing. Grammar-aware support for those
official forms is parser/compiler-owned.

The first implementation should provide:

- completion and hover documentation for the automatically available Standard Library names;
- signature guidance for optional `as speaker`, input hints, labelled and unlabelled choices, identifier and numeric
  labels, `skippable`, `unskippable`, exact seconds, `0`, and `instant`;
- diagnostics for attempts to shadow selected Standard Library names;
- diagnostics for mixed labelled and unlabelled choices, mixed label types, duplicate labels, and duplicate unlabelled
  visible text;
- diagnostics for negative, non-finite, unsupported-magnitude, or overflowing explicit pacing values;
- documentation that input text is a Standard UI hint rather than an automatic speaker transcript message;
- documentation of exact text/number normalization, simple return types, and permanent non-cancellation;
- formatting that preserves the accepted compact order and keeps compact `choose` options in one statement;
- source-span preservation from compact syntax through fully lowered plan instructions;
- debugger/simulator inspection of pending interaction kind, requesting speaker, normalized completion, prepared output,
  pacing deadline, action location, and skip policy;
- diagnostics for concrete versioned technical limits selected by the implementation.

The editor may preview the Player application's dynamic choice presentation, but button rows versus dropdown are not
canonical runtime state. Buttons may use one or two rows; exact layout measurements and breakpoints remain Player UI work.

Editor metadata must not imply that the first POC supports imports, package manifests, Standard Library replacement, or
checkpoint migration. Non-blocking usability warnings for unusually long interaction content are not part of this POC;
the release roadmap retains their later evidence-based evaluation.

The advanced detailed-result option, `showButton` timeout/elapsed return, typing-indicator options, accessibility override
field, concrete limit values, LLM interpretation options, and exact choice-layout thresholds remain deferred and must not
appear as accepted completion suggestions before their contracts are approved.
