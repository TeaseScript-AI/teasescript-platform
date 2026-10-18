# Values

Runtime values and the operations on them.

- `serializable-values.ts`: the serializable value model, its copies, and equality.
- `plain-data.ts`: JSON-safe engine data, and `isPlainRecord`.
- `value-predicates.ts`: narrowing a value to its kind.
- `value-types.ts`: checking a value against the type of the place that receives it.
- `value-text.ts`: the visible text of a value.
- `text-length.ts`: the longest text, and how messages quote text.
- `collection-size.ts`: the most elements a list, set, or dict can hold.
- `string-operations.ts`: text methods.
- `collection-operations.ts`: sorting and reading lists, sets, and dicts.
- `list-statistics.ts`: list statistics.
- `exact-numbers.ts`: the exact arithmetic of the list statistics.
- `pure-operations.ts`: operations that only read their values, such as `+` and the numeric functions.
- `temporal-operations.ts`: dates, times, and durations.
- `json-base64.ts`: `toJson`, `fromJson`, `toBase64`, and `fromBase64`.
- `sha256.ts`: SHA-256 for `hashText`.
