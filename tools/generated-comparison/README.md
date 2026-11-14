# Generated-code comparison

Decides, for one program and one play, whether code generated from a Tease gives a player what today's engine gives.
The comparison itself is `tests/helpers/generated-comparison/` (`compareGenerated` in `compare.ts`, which the compiler
stage's tests await); this command runs it over files and package directories, with the compiler stage's code
(`generateJavaScript`).

```sh
node tools/generated-comparison/run.mjs [--play first|last|seed:N] [--timeout-ms N] PATH...
```

From a built checkout. Each program runs in a worker of its own, so memory is bounded by the largest program. One JSON
line per program, then the counts per verdict.

## Verdicts

- `matched`: equal records after every host operation, up to how the play `ended`: `halted`, `failed` (both alike),
  `bound` (2,000 answers or 6 hours of scene time by default), or `unanswered: <kind>` (an action the play does not
  answer; everything before it was compared, and it is never a whole-session match).
- `refused`: the generator does not admit a form of the plan yet (`GenerationRefused`). Until S1 every plan is refused.
- `differs`: the first operation whose records differ, with the mismatches.
- `outside`: today's engine ran out of its instruction budget (`TSR037`, `runtime.instruction-budget-default` in
  [the resource-limit registry](../../docs/RESOURCE-LIMITS.md)), which counts its own instructions. The registry's other
  limits measure values both sides compute alike, so reaching one is compared like any failure.
- From the command only: `notCompiled`, `timeout`, `error`.

## What is compared

After every operation: its semantic outcome and events, and the state in today's snapshot shape without the fields
`record.ts` lists as the interpreter's own place; a field nobody listed is compared. The play answers every action the
same way on both sides (`play.ts`); converted Teases are given by path and stay outside the repository.

**Known hole: `globals`.** Global variables are not compared until S5, when generated code keeps them in today's form;
that slice removes the exclusion from `record.ts`.

Not covered: controlled randomness (`randomControl` stays off), restoring at a cut point (from S5) and Debug's form (from
S8). Blocking media cannot repeat endlessly, so no play waits on an endless medium.
