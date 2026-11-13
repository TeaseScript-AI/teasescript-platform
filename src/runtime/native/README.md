# Native engine

The engine that is to replace today's executor (`../engine.ts`, `../evaluator.ts`) for the same plans (#1694): faster
values, and an executor over prepared plans. No production path runs it; every session a host creates runs today's
executor on canonical values (`../values/`). Tests and benchmarks run this one beside it (`session.ts`). At the cutover
(#1695) today's executor leaves, so one engine, one state model and one checkpoint format remain.

What exists twice until the cutover (#1695 lists each pair in its comment "What leaves or is looked at at the
cutover"):

| Here | Today's |
| --- | --- |
| `values/`: native values (arrays, `Map`s, sets with an index), with their copy, `==` and keys | canonical values as the live state (`../values/serializable-values.ts`) |
| `values/value-key.ts` and `values/native-set.ts`: the assembly of composite keys, the cyrb53 hash and the exact-key length | the same in `../values/serializable-values.ts`, which their tests compare against |
| `prepare/`, `execute/`: an executor over prepared closures with resolved slots | `../engine.ts` and `../evaluator.ts` over the snapshot |

What is not twice: the canonical form, and the language's rules and messages. Snapshots, checkpoints and hosts keep the
canonical form; native values convert to and from it at those edges (`values/codec.ts`). Operations and instructions
call today's helpers (`../evaluation/`, `../values/`, `../instructions/`) through `EvaluationContext`
(`../evaluator.ts`), which the native machine gives as today's evaluator does.

- `values/`: the values, their canonical form, copies, `==`, keys and sets.
- `prepare/`: a plan's scopes and slots, resolved once per plan, and its instructions as closures.
- `execute/`: the machine that runs a prepared plan, and its run loop.
- `operations/`: operators, methods and builtins on native values.
- `session.ts`: the session tests and benchmarks drive.
