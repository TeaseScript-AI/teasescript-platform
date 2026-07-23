# ADR 0012 — Custom-view capability

**Status:** Accepted capability; author syntax open

The engine must support:

- a blocking custom view that returns a serializable result;
- a background custom view that returns a runtime handle;
- update and close operations;
- deterministic ownership, cleanup, and save/resume behavior.

The old syntax using `set result = show custom view ...` and `open ... as handle` is superseded because it conflicts with V30 language decisions. The V30-to-V31 gap review proposes a camelCase function API, but Peter has not yet confirmed the final syntax.
