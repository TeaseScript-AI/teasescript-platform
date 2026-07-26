# Libraries and Standard Library

## Accepted direction

- Regular executable content uses `.tease`.
- Advanced reusable programming logic uses real TypeScript in `.ts`.
- `.ts` libraries are not randomly selected content modules.
- Normal TypeScript named exports are the accepted public-library direction; tooling may generate signatures and editor metadata.
- Package libraries execute inside the player sandbox and have no unrestricted external network access.

The exact `.tease` import/linkage syntax, generated metadata format, versioning rules, and complete Standard Library API remain open. Historical examples using the rejected procedure concept, explicit ordinary-function invocation keywords, or procedure-based scheduling are not authoritative.

## Proposed dependency model

Proposed ADR 0017 adds this dependency direction:

```text
engine primitives
    -> platform Standard Library
    -> package libraries
    -> TeaseScript scripts
```

A package library may import and reuse Standard Library exports. It should not need to rebuild common behavior directly from engine primitives when a supported Standard Library function already provides it.

A package library may also depend on another package library through an explicit package dependency. Exact dependency declarations, version selection, cycle rejection, lock data, and resolution order remain open.

The Standard Library is platform-owned TypeScript distributed and versioned with the compatible engine/player. It may compose typed engine capabilities but may not bypass runtime validation, checkpointing, the player sandbox, or security boundaries.

## Candidate responsibility split

### Engine primitives

The engine retains behavior that must be canonical and security-relevant:

- instruction and runtime-state validation;
- pending-action identity and lifecycle;
- deterministic time and settlement;
- opaque engine-managed references;
- typed sequenced events;
- checkpoint, restore, cleanup, and resume equivalence;
- typed and bounded host/player data boundaries;
- stable speaker/output provenance required by runtime history.

### Standard Library

Candidate Standard Library behavior includes:

- author-friendly `say` policy and presentation defaults;
- standard text-output targets;
- common choice and input wrappers;
- visible and mystery timer presentation;
- friendly background-timer lifecycle wrappers;
- retries, validation helpers, formatting, and utility functions;
- reusable Standard UI workflows built from typed core capabilities.

The exact exports remain separate API decisions. Listing a candidate here does not make it implemented or accepted syntax.

### Package libraries

Package libraries may:

- call Standard Library functions;
- wrap or combine them into domain-specific APIs;
- use permitted custom UI inside the player iframe;
- expose normal TypeScript exports to TeaseScript tooling;
- exchange only supported serializable values and engine-managed references across the runtime boundary.

Package libraries may not extend TeaseScript grammar, inject parser hooks, access the parent DOM or account cookies, or place callbacks, promises, DOM objects, streams, or browser handles into canonical runtime state.

## Generated declarations and editor metadata

Ordinary library exports must receive the same practical authoring support expected from built-ins. Tooling should derive or generate metadata containing at least:

- exported function and type names;
- parameter names, order, defaults, and types;
- return types;
- documentation and deprecation information;
- library/package identity and compatible version information.

The editor and compiler may use that information for:

- autocomplete;
- signature and parameter hints;
- hover documentation;
- navigation;
- type-aware diagnostics;
- import suggestions when imports are required;
- formatting through the normal TeaseScript function-call grammar.

A library export does not automatically create new command or block syntax. Special syntax remains defined by the official TeaseScript grammar and compiler, although that syntax may lower to a Standard Library export.

## POC boundary

The first Standard Library POC slice may intentionally expose only a small selected API. Current engine behavior such as implemented `say` output remains in place until library linkage, generated metadata, compatibility behavior, and tests are available.

Standard Library implementation and tests may be scheduled after the current engine-focused slice, but implemented Standard Library behavior ultimately requires unit, integration, editor-metadata, and checkpoint/resume coverage appropriate to the capabilities it composes.
