import { compilePlayerProject } from "../../player/runtime/compile-project.js";
import { serializeValidatedRuntimeJson } from "../../src/runtime/snapshot/checkpoint-json.js";

/** Two files, a draw in each, the second inside a function: the project of Debug's source-op tests. */
export const PROJECT = markedProject("");

/**
 * `PROJECT` with `marker` on every line, in its names, texts and comments, and in a file's path: what a retention
 * witness looks for after a teardown (`retention-witness.ts`). Built by a case from its own marker, never kept.
 */
export function markedProject(marker: string) {
  const tag = (text: string) => (marker === "" ? text : `${text} // ${marker}`);
  const name = (word: string) => (marker === "" ? word : `${word}_${marker}`);
  return {
    files: [
      {
        path: marker === "" ? "rooms/dice.tease" : `rooms/dice_${marker}.tease`,
        source: [
          marker === "" ? "// Dice." : `// Dice ${marker}`,
          tag(`global function ${name("rollTwice")} {`),
          tag(`    let ${name("first")} = randomInteger(1..=6)`),
          tag(`    say "First${marker === "" ? "" : ` ${marker}`}: \${${name("first")}}", instant`),
          tag("}"),
        ].join("\n"),
      },
      {
        path: "main.tease",
        source: [
          tag(`let ${name("hit")} = chance(50)`),
          tag(`${name("rollTwice")}()`),
          tag(`showButton "Done${marker === "" ? "" : ` ${marker}`}"`),
          tag("exit"),
        ].join("\n"),
      },
    ],
  };
}

/** A project's plan as a published plan's text: a plan the Worker did not compile, as a restored session's is. */
export function planText(project: ReturnType<typeof markedProject>): string {
  return serializeValidatedRuntimeJson(compilePlayerProject(project).plan!);
}
