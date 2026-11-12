// #1072 R21: the suite run again on production's code, without the retained-state instrument
// (`tests/helpers/retained-instrument-preload.ts` installs it in `tests/type-core/` alone).
import "../type-core/type-core-solver.test.js";
