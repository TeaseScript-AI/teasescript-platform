# Native engine

The engine that is to replace today's executor (`../engine.ts`, `../evaluator.ts`) for the same plans (#1694): faster
values, and later an executor over prepared plans. No production path runs it; every session a host creates runs
today's executor on canonical values (`../values/`). Tests run this one beside it. At the cutover (#1695) today's
executor leaves, so one engine, one state model and one checkpoint format remain.

What exists twice until the cutover (#1695 lists each pair in its comment "What leaves or is looked at at the
cutover"):

| Here | Today's |
| --- | --- |
| `values/`: native values (arrays, `Map`s, sets with an index), with their copy, `==` and keys | canonical values as the live state (`../values/serializable-values.ts`) |
| `values/value-key.ts` and `values/native-set.ts`: the assembly of composite keys, the cyrb53 hash and the exact-key length | the same in `../values/serializable-values.ts`, which their tests compare against |

What is not twice: the canonical form. Snapshots, checkpoints and hosts keep it; native values convert to and from it
at those edges (`values/codec.ts`).

- `values/`: the values, their canonical form, copies, `==`, keys and sets.
