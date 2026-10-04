# ADR 0014 — Core runtime value semantics

**Status:** Accepted

Ordinary TeaseScript data uses deep value-copy semantics for variable
declarations, direct assignments, list elements, dict values, and object fields.
Scalars copy as values. Lists, sets, dicts, and ordinary script objects become
independent recursive copies, including nested lists, sets, dicts, and objects.
Set and dict copies preserve insertion order. Mutating a copy must not mutate the
original. A composite value captured as a list element, dict value, or object
field is copied at the evaluation step that produces it, so later evaluation in
the same literal cannot change it.

Cyclic script values are not supported. An attempted copy of a cyclic value
produces a structured runtime error instead of recursing indefinitely. Future
opaque engine references are outside this decision. An implementation may use
copy-on-write later only if observable deep-copy behavior remains unchanged.

A set may contain any value a list may contain (owner decision on #568,
2026-10-04), and collections nest in every direction: sets of lists, objects,
dicts, or sets, sets in dicts and lists, lists in lists, and so on. Set
uniqueness uses `==` equality, which compares kind and value structurally, and
retains the first insertion order. A member is copied when it is added, and
`.first`, `.last`, `.random`, and iteration give copies, so changing a read
member never changes the set or its uniqueness. Speakers and timer and media
handles are members by identity, as they are list elements, and stay
session-only.

A dict (#536) maps text keys to values in insertion order; storing to an
existing key keeps its position, and its `keys` and `values` are new lists. Two
dicts are equal when they have the same keys with equal values, in any order,
and a dict never equals an object. Storage and checkpoints keep a dict as its
ordered entries, each key once.

For empty lists and sets, `.first`, `.last`, and `.random` produce structured
runtime errors and never return `null`. Empty `.random` does not consume the
deterministic RNG state.

Speaker display names resolve in this order:

1. an explicit `displayName`;
2. the non-empty `title`, `firstName`, and `lastName` components joined in that
   order;
3. the speaker identifier when `displayName` is absent and all derived name
   components are empty.

When the identifier fallback is first used for a speaker, the runtime emits one
structured developer warning with a source span. Later messages using the same
fallback speaker do not repeat that warning.

This decision adds no syntax and does not define function parameter semantics,
opaque engine-reference copying, or other deferred runtime features.
