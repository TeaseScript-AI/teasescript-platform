import { editDistance } from "./form-fields.js";
import { PLAYER } from "./speaker-terms.js";

/**
 * The message for a name that a literal gives twice (TSV007): a property of a speaker declaration or an object
 * literal, or a key of a dict literal, also a computed key whose text the compiler knows.
 */
export function duplicateEntryMessage(
  literal: "speaker" | "object" | "dict",
  name: string,
): string {
  const entry =
    literal === "dict" ? `dict key ${JSON.stringify(name)}` : `${literal} property '${name}'`;
  return `Duplicate ${entry}. Each ${literal === "dict" ? "key" : "property"} may appear only once. Remove one of the entries.`;
}

/**
 * The message for a read of a property that an object does not have, naming the properties it has: at runtime
 * (TSR017) those of the object read, at compile time all that its objects can have (#845). `label` is how the source
 * spells the object, or `null`.
 */
export function missingPropertyMessage(
  label: string | null,
  name: string,
  properties: readonly string[],
): string {
  const subject = label === null ? "This object" : `'${label}'`;
  if (properties.length === 0) return `${subject} has no properties, so it has no '${name}'.`;
  const listed =
    properties.length === 1
      ? `Its only property is ${nameList(properties)}`
      : `Its properties are ${nameList(properties)}`;
  return `${subject} has no property '${name}'. ${listed}.`;
}

/**
 * A read of a property of a speaker (V30 §37): of `speaker`, or of any declared speaker for `null`. `sources` are the
 * built-in fields of which the speaker needs one for a field, term, or name list, the field first, and none for a
 * custom property; `example` is a speaker to declare the property in.
 */
export interface SpeakerPropertyRead {
  readonly speaker: string | null;
  readonly name: string;
  readonly sources: readonly string[];
  readonly example: string;
}

/** Why a read of a speaker's property may find none. */
export type SpeakerPropertyGap =
  /**
   * No declaration or assignment gives it, as the type checker finds: `properties` are the custom properties the
   * speaker can have, and `names` every property a misspelled name may be meant as.
   */
  | {
      readonly kind: "never";
      readonly properties: readonly string[];
      readonly names: readonly string[];
    }
  /** No way to the read gives it first, as the speaker flow finds; `late` names a store that does not, or is empty. */
  | { readonly kind: "notYet"; readonly late: string }
  /** A way to the read gives it nothing, as the speaker flow finds: `missing` says which, `assign` where to assign it. */
  | { readonly kind: "someWays"; readonly missing: string; readonly assign: string };

/**
 * The message for a read of a speaker's property that it may not have (TSV043): the type checker's when no
 * declaration or assignment gives it, and the speaker flow's when a way to the read misses it.
 */
export function missingSpeakerPropertyMessage(
  read: SpeakerPropertyRead,
  gap: SpeakerPropertyGap,
): string {
  const { speaker, name, sources } = read;
  const player = speaker === PLAYER;
  if (gap.kind === "someWays")
    return `Speaker '${speaker}' may have no '${name}' here: ${gap.missing}. Assign it ${gap.assign}${player ? "" : `, or give it a start value, as in 'speaker ${speaker} { ${name}: ... }'`}.`;
  const fix = ` ${speakerPropertyFix(read)}`;
  const quoted = alternatives(sources);
  if (gap.kind === "notYet") {
    const missing =
      sources.length === 0
        ? "nothing assigns it"
        : player
          ? `nothing copies the account or assigns ${quoted}`
          : `nothing assigns ${quoted}`;
    return `Speaker '${speaker}' has no '${name}' yet here: ${missing} before this line runs.${gap.late}${fix}`;
  }
  if (sources.length > 0) {
    const subject =
      speaker === null ? `No speaker has '${name}'` : `Speaker '${speaker}' has no '${name}'`;
    const gives = player ? "no assignment or copy of the account" : "no declaration or assignment";
    const needed = sources.length === 1 ? "one" : alternatives(sources);
    return `${subject}: ${gives} gives ${speaker === null ? "a speaker" : "it"} ${needed}.${fix}`;
  }
  const { properties, names } = gap;
  const one = properties.length === 1;
  let found: string;
  if (speaker === null)
    found =
      properties.length === 0
        ? `Speakers have no custom properties, so none has '${name}'.`
        : `No speaker has a property '${name}'. The custom ${one ? "property of speakers is" : "properties of speakers are"} ${nameList(properties)}.`;
  else
    found =
      properties.length === 0
        ? `Speaker '${speaker}' has no custom properties, so it has no '${name}'.`
        : `Speaker '${speaker}' has no property '${name}'. Its ${one ? "only custom property is" : "custom properties are"} ${nameList(properties)}.`;
  return found + (misspelledPropertyHint(name, names) || fix);
}

/** How to give the speaker of `read` the property before the read. */
function speakerPropertyFix({ speaker, name, sources, example }: SpeakerPropertyRead): string {
  if (speaker === PLAYER)
    return sources.length === 0
      ? `Assign it before this line, as in 'player.${name} = ...'.`
      : `Copy the account before this line, as in 'player.copyFrom(account)' at the start of the script, or assign ${sources.includes("gender") ? `'player.gender' or 'player.${name}'` : `'player.${name}'`} first.`;
  const whom = speaker === null ? "a speaker" : "it";
  return sources.includes("gender")
    ? `Give ${whom} a gender, as in 'speaker ${example} { gender: "female" }', or assign '${speaker === null ? "" : `${speaker}.`}${name}' before this line.`
    : `Give it a start value, as in 'speaker ${example} { ${name}: ... }', or assign it before this line.`;
}

/** Names in quotes as alternatives, as in `'a' or 'b'` and `'a', 'b', or 'c'`. */
function alternatives(names: readonly string[]): string {
  const quoted = names.map((name) => `'${name}'`);
  return quoted.length <= 2
    ? quoted.join(" or ")
    : `${quoted.slice(0, -1).join(", ")}, or ${quoted.at(-1)}`;
}

/** Up to ten names in quotes, joined as in `'a', 'b', and 'c'`, with how many more there are. */
function nameList(names: readonly string[]): string {
  const quoted = names.slice(0, 10).map((name) => `'${name}'`);
  const more = names.length - quoted.length;
  if (more > 0) return `${quoted.join(", ")}, and ${more} more`;
  return quoted.length <= 2
    ? quoted.join(" and ")
    : `${quoted.slice(0, -1).join(", ")}, and ${quoted.at(-1)}`;
}

/** The property or method of several that `name` likely misspells, as `name` for `nmae`, as a hint after the message. */
export function misspelledPropertyHint(name: string, properties: readonly string[]): string {
  if (properties.length < 2) return "";
  let nearest: string | undefined;
  let best = Math.min(3, name.length);
  for (const property of properties) {
    const distance = editDistance(name, property);
    if (distance < best) {
      nearest = property;
      best = distance;
    }
  }
  return nearest === undefined ? "" : ` Did you mean '${nearest}'?`;
}
