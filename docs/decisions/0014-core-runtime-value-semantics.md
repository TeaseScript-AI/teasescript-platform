# ADR 0014 — Core runtime value semantics

**Status:** Accepted

Ordinary TeaseScript data uses deep value-copy semantics for variable
declarations, direct assignments, list elements, and object fields. Scalars copy
as values. Lists, sets, and ordinary script objects become independent recursive
copies, including nested lists, sets, and objects. Set copies preserve insertion
order. Mutating a copy must not mutate the original. A composite value captured
as a list element or object field is copied at the evaluation step that produces
it, so later evaluation in the same literal cannot change it.

Cyclic script values are not supported. An attempted copy of a cyclic value
produces a structured runtime error instead of recursing indefinitely. Future
opaque engine references are outside this decision. An implementation may use
copy-on-write later only if observable deep-copy behavior remains unchanged.

Sets contain only these values in the current language version:

- `string`;
- `boolean`;
- `integer`;
- `number`;
- `null`;
- `duration`, `date`, `time`, `datetime`, and `timestamp` (#532).

Lists, objects, sets, ranges, speakers, and opaque engine references are not
valid set elements. Other set elements produce a deterministic structured
runtime error associated with the relevant source span. Set uniqueness uses
`==` equality, which compares kind and value, and retains the first insertion
order.

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
