# ADR 0013 — Set collection

**Status:** Accepted

TeaseScript has an insertion-ordered unique collection with the literal and type
syntax:

```tease
let values = set[1, 2, 2, 3]
let names: string set = set[]
```

`set[...]` is a collection literal. A set contains each value at most once,
removes duplicate literal values, preserves insertion order, and uses the
language's normal `==` equality for uniqueness. Sets use copy semantics like
V30 lists and are not indexable.

The supported set methods are `add(value)`, `remove(value)`, `clear()`,
`contains(value)`, `toList()`, and, by owner decision on #542, `intersection(other)`,
`union(other)`, and `difference(other)`, which return a new set and are defined
with the list versions in V30 §16. Lists support `toSet()`.

The supported set properties are `length`, `first`, `last`, and `random`.
Iteration follows insertion order.

This decision does not restore `set` as an assignment keyword. The following
remains invalid:

```tease
set score = 20
```

Direct assignment remains:

```tease
score = 20
```

No other set literal syntax, type syntax, methods, or properties are accepted.
