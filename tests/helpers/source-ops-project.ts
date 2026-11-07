import { compilePlayerProject } from "../../player/compile-project.js";
import { serializeValidatedRuntimeJson } from "../../src/runtime/snapshot/checkpoint-json.js";

/** Two files, a draw in each, the second inside a function: the project of Debug's source-op tests. */
export const PROJECT = {
  files: [
    {
      path: "rooms/dice.tease",
      source: [
        "// Dice.",
        "global function rollTwice {",
        "    let first = randomInteger(1..=6)",
        '    say "First: ${first}", instant',
        "}",
      ].join("\n"),
    },
    { path: "main.tease", source: 'let hit = chance(50)\nrollTwice()\nshowButton "Done"\nexit' },
  ],
};

/** `PROJECT`'s plan as a published plan's text: a plan the Worker did not compile, as a restored session's is. */
export const PROJECT_PLAN = serializeValidatedRuntimeJson(compilePlayerProject(PROJECT).plan!);
