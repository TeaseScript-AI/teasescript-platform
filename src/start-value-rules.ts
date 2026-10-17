import type { GlobalStatement, SpeakerDeclaration } from "./ast.js";

/**
 * What a start value uses that it may not, with one message whichever pass finds it (TSV055): the name pass finds
 * effects, calls, and names without a value yet, the type checker random selection, which needs the value's type. A
 * start value is set up at the start of the session, before the story runs (ADR 0022 §6).
 */
export type StartValueUse =
  /** A command that says, asks, waits, or plays media. */
  | { readonly kind: "effect" }
  | { readonly kind: "call" }
  /** A local variable `name`; `assigned` is how the global's value is written, for the fix. */
  | { readonly kind: "local"; readonly name: string; readonly assigned: string }
  /** A global or speaker `name` that is set up after this one. */
  | { readonly kind: "later"; readonly name: string }
  /** The global itself. */
  | { readonly kind: "itself" }
  /** `.random` on a list or set. */
  | { readonly kind: "random" }
  /** A list shown in `${...}`, which shows a random element. */
  | { readonly kind: "shownList" };

/** The message for a start value of `owner`, a global or the properties of a speaker, that uses `use` (TSV055). */
export function startValueMessage(
  owner: GlobalStatement | SpeakerDeclaration,
  use: StartValueUse,
): string {
  const name = owner.name.name;
  const speaker = owner.kind === "speakerDeclaration";
  const subject = speaker
    ? `The properties of speaker '${name}'`
    : `The start value of global '${name}'`;
  const before = `${speaker ? "a speaker is set up" : "it is set"} at the start of the session, before the story runs`;
  const plain = "Use literals, globals declared before it, operators, and 'load ..., default:'.";
  switch (use.kind) {
    case "effect":
      return `${subject} cannot say, ask the player, wait, or play media: ${before}.${speaker ? "" : ` Give it a plain start value, and assign the answer later, as in '${name} = ...'.`}`;
    case "call":
      return `${subject} cannot call a function: ${before}. ${plain}`;
    case "random":
      return `${subject} cannot select a random element with '.random': ${before}. Pick the element in the story instead.`;
    case "shownList":
      return `${subject} cannot show a list in '\${...}', which selects a random element: ${before}. Show one element, as in '\${items[0]}'.`;
    case "itself":
      return `${subject} cannot use '${name}' itself, which has no value yet.`;
    case "later":
      return `${subject} cannot use '${use.name}', which gets its value later: globals and speakers are set up in order, main.tease first, then the other files by path, each from top to bottom. Declare '${use.name}' before '${name}'.`;
    case "local":
      if (speaker)
        return `${subject} cannot use '${use.name}': a speaker is set up at the start of the session, before '${use.name}' has a value. ${plain}`;
      if (owner.assignment !== null)
        return `The default of global '${name}' cannot use '${use.name}': it is the value '${name}' has from the start of the session, before '${use.name}' has one. Use a literal or a global declared before it.`;
      return `Global '${name}' needs a value from the start of the session, before the story runs, so it cannot start with '${use.name}'. Add a start value, as in 'global ${name} = ${use.assigned}, default: 0', or write 'global ${name} = 0' and later '${name} = ${use.assigned}'.`;
  }
}
