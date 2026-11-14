# Native values

Values that live on the JavaScript side with today's meaning (#1694): arrays, `Map`s and sets with an index, with their
copy, `==` and keys, for code generated from a Tease to run on. No production path uses them; every session a host
creates runs today's executor on canonical values (`../values/`). Tests compare these values with today's canonical
value functions. At the cutover (#1695) today's executor leaves, so one engine, one state model and one checkpoint
format remain.

What exists twice until the cutover (#1695 lists each pair in its comment "What leaves or is looked at at the
cutover"):

| Here | Today's |
| --- | --- |
| `values/`: native values (arrays, `Map`s, sets with an index), with their copy, `==` and keys | canonical values as the live state (`../values/serializable-values.ts`) |
| `values/value-key.ts` and `values/native-set.ts`: the assembly of composite keys, the cyrb53 hash and the exact-key length | the same in `../values/serializable-values.ts`, which their tests compare against |

What is not twice: the canonical form. Snapshots, checkpoints and hosts keep it; native values convert to and from it
at those edges (`values/codec.ts`).

- `values/`: the values, their canonical form, copies, `==`, keys and sets.
