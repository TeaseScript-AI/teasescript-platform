import { CHECKPOINT_VERSION } from "../src/runtime/checkpoint.js";

export const PLAYGROUND_EXAMPLES = Object.freeze({
  main: Object.freeze({ label: "Runtime introduction", file: "main.tease" }),
  "control-flow": Object.freeze({
    label: "Control flow and deterministic random",
    file: "control-flow.tease",
  }),
  "checkpoint-loop": Object.freeze({
    label: "Checkpoint inside a loop",
    file: "checkpoint-loop.tease",
  }),
  functions: Object.freeze({
    label: "Functions and serializable call frames",
    file: "functions.tease",
  }),
});

export type PlaygroundExampleName = keyof typeof PLAYGROUND_EXAMPLES;

export function isPlaygroundExampleName(
  value: string,
): value is PlaygroundExampleName {
  return Object.hasOwn(PLAYGROUND_EXAMPLES, value);
}

export function exampleUrl(name: PlaygroundExampleName): string {
  return `/examples/playground/${PLAYGROUND_EXAMPLES[name].file}`;
}

export function checkpointStorageKey(name: PlaygroundExampleName): string {
  return `teasescript-playground-checkpoint-v${CHECKPOINT_VERSION}:${name}`;
}
