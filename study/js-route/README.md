# JavaScript-route study: prototype emitter (research, never merged)

Research code of the feasibility study of the JavaScript route (orchestrator 2, 2026-11-13). Nothing in `src/` imports
it, and the branch `study/js-route` is never merged. Its numbers and its rows are judged by their checks: every run is
compared with today's engine on what a player sees.

- `emit.mjs`: an instruction plan to a JavaScript program; structure rebuilt from the plan's jumps, a shape it does not
  know refused (`Unsupported`).
- `runtime.mjs`: the library the program calls: today's helpers through `EvaluationContext`, on #2684's values.
- `driver.mjs`: a session of an emitted program; continuing after a wait by running again from the start with the
  recorded observations (part C, way 1).
- `compare.mjs`: today's engine against the emitted program, operation by operation.

Run after `npm run build`: `node study/js-route/compare.mjs FILE.tease...`. Only invented sources live here; generated
output of creators' Teases does not.
